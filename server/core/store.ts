import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { isBackdropImageId, migrateBackdrop, migrateQuietDefault, normalizeBackdrop } from '../../shared/backdrop';
import { isLight, LIGHT, rowFacts } from './trim';
import { stallMark } from '../util/stalls';
import { SessionFiles, type SessionData, type SessionSave } from './session-file';
import { DEFAULT_SETTINGS, type AppSettings, type FolderGroup, type Project, type ProviderId, type QueuedMessage, type SessionMeta, type TimelineItem, type Todo, type ToolItem } from '../../shared/protocol';

/** An account in the registry. The built-in `default` account of each provider is stored too (for its label). */
export interface StoredAccount {
  id: string;
  provider: ProviderId;
  label: string;
  createdAt: number;
  /** A folder the user already had ("Use an existing folder"): used in place, forgotten on removal, never deleted. */
  dir?: string;
  /** The label was given by Sable ("Account 2"): the first sign-in names the account instead. */
  autoLabel?: boolean;
}

interface StateFile {
  projects: Project[];
  settings: AppSettings;
  sessions: SessionMeta[];
  accounts: StoredAccount[];
  /** Projects grouping folders (absent in older profiles). */
  groups?: FolderGroup[];
  /** The chats group's place in the sidebar's manual order. */
  chatsOrder?: number;
}

interface SessionFile {
  items: TimelineItem[];
  todos: Todo[];
  /** Messages waiting for the running turn to end (absent in older files). */
  queue?: QueuedMessage[];
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `saved` with what `defaults` has and it lacks filled in, recursively for nested objects. A value
 * that is present (null and false included) always stays as saved: an update only adds.
 */
export function fillMissing<T>(defaults: T, saved: unknown): T {
  if (!plain(defaults) || !plain(saved)) return (saved === undefined ? structuredClone(defaults) : saved) as T;
  const out: Record<string, unknown> = { ...saved };
  for (const [k, d] of Object.entries(defaults)) {
    if (out[k] === undefined) out[k] = d === undefined ? d : structuredClone(d);
    else if (plain(d) && plain(out[k])) out[k] = fillMissing(d, out[k]);
  }
  return out as T;
}

/** Freeze just the fields resident in memory. Immutable strings can be shared even inside a
 * result or attachment. The index and original line bytes have a separate lifetime. */
function snapshotItem(item: TimelineItem): TimelineItem {
  return cloneField(item) as TimelineItem;
}

/** Own enumerable fields in their order, as `Object.entries` gives them, without the arrays in between (a long chat's first save copies every row). */
function cloneField(v: unknown): unknown {
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneField(v[i]);
    return out;
  }
  if (!v || typeof v !== 'object') return v;
  if (Object.getPrototypeOf(v) !== Object.prototype) return structuredClone(v);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const value = cloneField((v as Record<string, unknown>)[k]);
    // A plain assignment to this name would set the copy's prototype.
    if (k === '__proto__') Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
    else out[k] = value;
  }
  return out;
}

/** The longest a debounced save waits for the copies of a chat just read (ms). */
const WARM_WAIT_MS = 6000;

/**
 * What the last save of a chat saw, row by row: the runtime's own row at each place, the copy it was saved
 * as, and the row's bits for the end of the chat. The next save takes a row over by its place when the
 * same object still stands there and nothing named it changed, so a save costs the rows that changed and
 * one comparison per row of the rest. (Asked of a map row by row, a chat of 126,000 rows held the bridge,
 * which is the window's main process, for 150 to 600 ms on every save: every second and a half while it
 * streamed.)
 */
interface SavedRows {
  source: TimelineItem[];
  copies: TimelineItem[];
  /** Each copy's id, beside it: asked for a row's id, nobody reads the row (a row read is a trip through memory, 126,000 of them some 20 ms). */
  ids: string[];
  facts: Uint8Array;
}

/** A slice of the copies made ahead (ms). */
const WARM_SLICE_MS = 6;
/** Up to this many named rows are each looked for by their place; more are met in one walk over all places. */
const PLACES_MAX = 64;

/** JSON persistence under ~/.sable. Writes are debounced and atomic. */
export class Store {
  readonly dir: string;
  state: StateFile;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, () => unknown>();
  /** Session timelines: a base and a small tail, so a long chat is not written whole after every word (session-file.ts). */
  private sessionFiles: SessionFiles;
  private sessionTimers = new Map<string, NodeJS.Timeout>();
  private sessionPending = new Map<string, () => SessionSave>();
  /** Sable is going down: nothing more is written (`seal`). */
  private sealed?: Promise<void>;
  private unreadableState = false;
  private writingState: Promise<void> = Promise.resolve();
  /** Frozen item versions shared by concurrent saves until the runtime marks the item dirty. */
  private savedItems = new WeakMap<TimelineItem, TimelineItem>();
  private savedRows = new Map<string, SavedRows>();
  /** Rows whose saved copy was made again outside a save since the chat's last one (`replaceView`). */
  private recopied = new Map<string, Set<string>>();
  /** The copies being made ahead of a chat's first save (`warmSave`): `done` settles when that work ends, however it ends. */
  private warming = new Map<string, { done: Promise<void> }>();
  /** How the saves found their rows, for tests and for reading a slow save: by place, or by asking about every place. */
  private rowSaves = { byPlace: 0, asked: 0 };
  private activeSaves = new Map<string, SessionSave>();
  private migrations = new Map<string, { after: number; atRest: () => boolean }>();
  private migrationTimer?: NodeJS.Timeout;
  private migrating = false;
  private owner?: string;
  private ownerTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private recovery = new AbortController();
  private verifying?: Promise<void>;
  private recoveryOwed = false;
  private startupBusy = false;

  /** The runtime's own row for an id, when the bridge gave the way to ask (a bare store has none). */
  private runtimeRow?: (session: string, id: string) => TimelineItem | undefined;

  constructor(dir?: string, runtimeItem?: (session: string, id: string) => TimelineItem | undefined) {
    this.runtimeRow = runtimeItem;
    this.sessionFiles = new SessionFiles(id => this.sessionPath(id), runtimeItem && ((id, saved, preview) => {
      const current = runtimeItem(id, saved.id);
      if (current && isDeepStrictEqual(current, saved)) this.replaceView(id, current, preview);
    }), action => {
      const admitted = this.withRecoveryLock(action);
      if (!admitted) this.retryRecovery();
      return admitted;
    }, () => this.startupBusy);
    this.dir = dir ?? process.env.SABLE_HOME ?? path.join(homedir(), '.sable');
    mkdirSync(path.join(this.dir, 'sessions'), { recursive: true });
    this.state = this.readState() ?? { projects: [], settings: { ...DEFAULT_SETTINGS }, sessions: [], accounts: [] };
    this.normalizeState();
    const claim = '.sable-store.' + process.pid + '.' + randomUUID() + '.owner';
    const owner = path.join(this.dir, claim);
    try { writeFileSync(owner, '', { flag: 'wx' }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
      // A temporarily inaccessible profile still opens. Admission retries this claim.
    }
    this.owner = owner;
    this.ownerTimer = setInterval(() => {
      const now = new Date();
      try { utimesSync(owner, now, now); }
      catch { /* A later admission also renews this lease. */ }
    }, 60_000).unref();
    this.recoverSessionFiles();
  }

  private startupLock() {
    let lock;
    try {
      const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
      if (!sqlite) return;
      lock = new sqlite.DatabaseSync(path.join(this.dir, '.sable-store.lock'));
      lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
      this.startupBusy = false;
      return lock;
    } catch (err) {
      try { lock?.close(); } catch { /* An unavailable cleanup database is optional. */ }
      const code = (err as { errcode?: number }).errcode;
      this.startupBusy = code === 5 || code === 6; // SQLITE_BUSY / SQLITE_LOCKED.
    }
  }

  private withRecoveryLock(action: () => void) {
    if (this.sealed || !this.owner) return false;
    const lock = this.startupLock();
    if (!lock) return false;
    try {
      // Renew (or reclaim after system sleep) only under the admission lock.
      writeFileSync(this.owner, '');
      if (!this.alone(true)) return false;
      action();
      return true;
    } catch { return false; }
    finally { try { lock?.close(); } catch { /* Already closed. */ } }
  }

  private alone(sweep: boolean) {
    let alone = true;
    for (const name of readdirSync(this.dir)) {
      const other = /^\.sable-store\.([1-9]\d*)\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.owner$/.exec(name);
      const peer = path.join(this.dir, name);
      if (!other || peer === this.owner) continue;
      let live = true;
      try { process.kill(Number(other[1]), 0); }
      catch (err) { live = (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (live && Date.now() - statSync(peer).mtimeMs < 86_400_000) alone = false;
      else if (sweep) rmSync(peer, { force: true });
    }
    return alone;
  }

  private retryRecovery() {
    if (this.sealed) return;
    this.recoveryOwed = true;
    if (!this.recoveryTimer && !this.verifying) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        this.recoverSessionFiles();
      }, 5000).unref();
    }
  }

  private recoverSessionFiles() {
    this.recoveryOwed = false;
    let ids: string[] = [];
    if (!this.withRecoveryLock(() => {
      const pass = this.sessionFiles.recoverMigrations(readdirSync(path.join(this.dir, 'sessions'), { withFileTypes: true }));
      ids = pass.ids;
      this.recoveryOwed = pass.retry;
    })) {
      // A complete abandoned save is an input to the next read even when another
      // owner prevents renaming or deleting anything in the sessions directory.
      try { this.sessionFiles.recoverWriterTemps(readdirSync(path.join(this.dir, 'sessions'), { withFileTypes: true }), this.alone(false)); }
      catch { /* A transient directory error gets another pass. */ }
      this.retryRecovery();
      return;
    }
    if (ids.length) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined;
        this.verifying = this.sessionFiles.verifyMigrations(ids, this.recovery.signal)
          .then(done => { this.recoveryOwed ||= !done; }, () => { this.recoveryOwed = true; })
          .finally(() => {
            this.verifying = undefined;
            if (this.recoveryOwed) this.retryRecovery();
          });
      }, 1000).unref();
    } else if (this.recoveryOwed) this.retryRecovery();
  }

  get registryUnavailable() { return this.unreadableState; }

  reloadRegistry(): boolean {
    if (!this.unreadableState) return true;
    if (this.sealed) return false;
    const restored = this.readState();
    if (!restored) return false;
    this.state = restored;
    this.normalizeState();
    this.unreadableState = false;
    return true;
  }

  private normalizeState() {
    const saved = (this.state.settings && typeof this.state.settings === 'object' ? this.state.settings : {}) as Partial<AppSettings>;
    // A config the user already has is never rebuilt from the old switches below.
    const hadBackdrop = !!saved.backdropConfig && typeof saved.backdropConfig === 'object';
    // What an update adds is filled in; nothing the user saved is replaced (also inside nested choices).
    this.state.settings = fillMissing(DEFAULT_SETTINGS, saved);
    // One-time move to the current default backdrop for profiles saved before it existed
    // (their stored value is the old default, not a choice the user made).
    const versioned = this.state.settings as AppSettings & { rev?: number };
    if (!versioned.rev || versioned.rev < 2) {
      if (!hadBackdrop) versioned.backdrop = DEFAULT_SETTINGS.backdrop;
      versioned.rev = 2;
    }
    // The backdrop config replaces the ambience / backdrop / texture switches (read once, here).
    if (versioned.rev < 3) {
      if (!hadBackdrop) versioned.backdropConfig = migrateBackdrop(versioned);
      versioned.rev = 3;
    }
    // The quieter default backdrop: fields still at the old default move to the new one.
    if (versioned.rev < 4) {
      versioned.backdropConfig = migrateQuietDefault(versioned.backdropConfig);
      versioned.rev = 4;
    }
    versioned.backdropImages = (Array.isArray(versioned.backdropImages) ? versioned.backdropImages : []).filter((i) => isBackdropImageId(i?.id));
    versioned.backdropConfig = normalizeBackdrop(
      versioned.backdropConfig,
      versioned.backdropImages.map((i) => i.id),
    );
    this.state.projects ??= [];
    this.state.sessions ??= [];
    this.state.accounts ??= [];
  }

  private get statePath() {
    return path.join(this.dir, 'state.json');
  }

  private sessionPath(id: string) {
    return path.join(this.dir, 'sessions', `${id}.json`);
  }

  private readState(): StateFile | null {
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (!plain(state)) throw new Error('Invalid session registry');
      return state as unknown as StateFile;
    } catch (err) {
      this.unreadableState ||= (err as NodeJS.ErrnoException).code !== 'ENOENT';
      return null;
    }
  }

  private schedule(file: string, data: () => unknown, delay: number) {
    if (this.sealed) return;
    this.pending.set(file, data);
    if (this.timers.has(file)) return;
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        void this.flushFile(file);
      }, delay),
    );
  }

  private async flushFile(file: string) {
    const data = this.pending.get(file);
    if (!data) return;
    this.pending.delete(file);
    const written = stallMark('state.write');
    const contents = JSON.stringify(data());
    written();
    this.writingState = this.writingState.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, contents, 'utf8');
      await rename(tmp, file);
    });
    if (this.sealed) await this.writingState;
    else await this.writingState.catch(() => {});
  }

  saveState() {
    if (!this.unreadableState) this.schedule(this.statePath, () => this.state, 400);
  }

  readSessionEnd(id: string) {
    return this.sessionFiles.readEnd(id);
  }

  loadSession(id: string): SessionData {
    return this.sessionFiles.load(id);
  }

  /** As `loadSession`, a big file read in a worker thread (the main process keeps running). */
  loadSessionAsync(id: string): Promise<SessionData> {
    return this.sessionFiles.loadAsync(id);
  }

  scheduleMigration(id: string, atRest: () => boolean, matchesRestore?: () => boolean) {
    if (this.sealed || !this.sessionFiles.needsMigration(id)) return;
    if (matchesRestore && !matchesRestore()) { this.sessionFiles.forgetMigration(id); return; }
    this.migrations.set(id, { after: Date.now() + 20_000, atRest });
    this.armMigration();
  }

  private armMigration(pause = 0) {
    if (this.sealed || this.migrating || this.migrationTimer || !this.migrations.size) return;
    const next = Math.min(...Array.from(this.migrations.values(), m => m.after));
    this.migrationTimer = setTimeout(() => {
      this.migrationTimer = undefined;
      void this.runMigration();
    }, Math.max(pause, next - Date.now()));
    this.migrationTimer.unref();
  }

  private async runMigration() {
    this.migrating = true;
    try {
      if (this.startupBusy) return;
      for (const [id, entry] of this.migrations) {
        if (!this.sessionFiles.needsMigration(id)) { this.migrations.delete(id); continue; }
        if (entry.after > Date.now()) continue;
        const ready = () => {
          if (this.sealed || this.migrations.get(id) !== entry || this.sessionPending.has(id)) return false;
          try { return entry.atRest(); }
          catch { this.migrations.delete(id); this.sessionFiles.forgetMigration(id); return false; }
        };
        if (!ready()) continue;
        await this.sessionFiles.migrate(id, ready);
        if (this.migrations.get(id) === entry && !this.sessionFiles.needsMigration(id)) this.migrations.delete(id);
        break;
      }
    } finally {
      this.migrating = false;
      this.armMigration(5_000);
    }
  }

  wholeItem(id: string, item: TimelineItem): TimelineItem {
    return this.sessionFiles.wholeItem(id, item);
  }

  /** Providers read tool.input while interpreting a late result, before they emit a patch.
   * Only an explicit property read does I/O. Row spreads, JSON and the frozen writer view
   * omit this accessor. A provider replacing the input gets an ordinary writable field. */
  bindProviderInputs(id: string, items: TimelineItem[]) {
    const store = this;
    const input: PropertyDescriptor = {
      configurable: true,
      get(this: ToolItem) { return (store.wholeItem(id, this) as ToolItem).input; },
      set(this: ToolItem, value: unknown) {
        Object.defineProperty(this, 'input', { value, enumerable: true, writable: true, configurable: true });
      },
    };
    for (const item of items) {
      if (isLight(item) && item[LIGHT].input && !Object.hasOwn(item, 'input')) Object.defineProperty(item, 'input', input);
    }
  }

  recut(id: string, item: TimelineItem, recent: boolean) {
    const view = this.sessionFiles.recut(id, item, recent);
    if (view !== item) this.replaceView(id, item, view);
    return item;
  }

  private replaceView(id: string, item: TimelineItem, view: TimelineItem) {
    for (const key of Object.getOwnPropertyNames(item)) Reflect.deleteProperty(item, key);
    Object.assign(item, view);
    this.bindProviderInputs(id, [item]);
    // Its saved copy is made here, in the slices this is called in. Left to the next save, every row a
    // base write had slimmed was copied in that save's one task: a second and more for a long chat.
    this.savedItems.set(item, snapshotItem(item));
    let named = this.recopied.get(id);
    if (!named) this.recopied.set(id, named = new Set());
    named.add(item.id);
  }

  /** Keep runtime references valid when a rewind or a late event makes an old step live again. */
  promote(id: string, item: TimelineItem) {
    if (isLight(item)) {
      const whole = this.wholeItem(id, item);
      if (item.type === 'tool') {
        delete item.input;
        delete item.inputText;
      }
      Reflect.deleteProperty(item, LIGHT);
      delete item.more;
      Object.assign(item, whole);
    }
    return item;
  }

  copySession(source: string, destination: string, items: TimelineItem[]) {
    return this.sessionFiles.copyBase(source, destination, items.map(snapshotItem));
  }

  /** `data` is read when the write happens; its `dirty` names the items changed since the last save. */
  saveSession(id: string, data: () => SessionSave) {
    if (this.sealed || !this.sessionPending.has(id) && this.sessionFiles.refuseUnreadSave(id)) return;
    this.sessionFiles.forgetMigration(id);
    this.migrations.delete(id);
    this.sessionPending.set(id, data);
    if (this.sessionTimers.has(id)) return;
    this.armSave(id, 1500, 0);
  }

  /**
   * The debounced save. While the copies of a chat just read are still being made (`warmSave`), it waits
   * for them a little longer, a few seconds at most: a save that came first would make the rest in one task.
   * Whoever needs the save now (`persistInput`, a quit) flushes at once as ever.
   */
  private armSave(id: string, delay: number, waited: number) {
    this.sessionTimers.set(
      id,
      setTimeout(() => {
        this.sessionTimers.delete(id);
        if (this.warming.has(id) && !this.sealed && waited < WARM_WAIT_MS && this.sessionPending.has(id)) return this.armSave(id, 250, waited + 250);
        void this.flushSession(id);
      }, delay),
    );
  }

  private flushSession(id: string) {
    const data = this.sessionPending.get(id);
    if (!data) return Promise.resolve();
    this.sessionPending.delete(id);
    const save = data();
    const copied = stallMark('save.rows');
    const { items, ids, facts, places } = this.copyRows(id, save.items, save.dirty);
    copied();
    const snapshot = { items, facts, rowIds: ids, places, own: true, dirty: save.dirty === 'all' ? 'all' as const : new Set(save.dirty), todos: structuredClone(save.todos),
      queue: structuredClone(save.queue), receiptRepair: save.receiptRepair?.slice() };
    this.activeSaves.set(id, snapshot);
    return this.sessionFiles.save(id, () => snapshot, !!this.sealed).finally(() => {
      if (this.activeSaves.get(id) === snapshot && !this.sessionFiles.needsRetry(id)) this.activeSaves.delete(id);
    });
  }

  /**
   * The rows of a save as copies nothing changes any more, with each row's bits (`SavedRows`). A row keeps
   * its copy while the same object stands at the same place, is not named changed (`dirty`) and was not
   * copied again meanwhile (`recopied`); every other row is looked up as before, and copied when it has no
   * copy or is named.
   */
  private copyRows(id: string, src: TimelineItem[], dirty: Set<string> | 'all') {
    const n = src.length;
    const prev = this.savedRows.get(id);
    const again = this.recopied.get(id);
    this.recopied.delete(id);
    // A save came before the warm-up was through: it is this save's work now.
    this.warming.delete(id);
    const all = dirty === 'all';
    const named = all ? undefined : dirty;
    const keep = prev && !all ? prev : undefined;
    // What the last save saw is taken over whole (arrays copied as blocks); only the places that differ are made again.
    const items: TimelineItem[] = keep ? keep.copies.slice(0, n) : [];
    const ids: string[] = keep ? keep.ids.slice(0, n) : [];
    items.length = n;
    ids.length = n;
    const facts = new Uint8Array(n);
    if (keep) facts.set(keep.facts.length > n ? keep.facts.subarray(0, n) : keep.facts);
    const was = keep?.source;
    // The runtime's rows as this save saw them, for the next one to compare with. Kept from save to save and
    // set right where it differs (it is this store's alone); copied only where there is nothing to keep.
    let source: TimelineItem[] | undefined;
    const places = new Map<string, number>();
    const make = (i: number, changed: boolean) => {
      const item = src[i];
      let copy = changed ? undefined : this.savedItems.get(item);
      if (!copy) {
        copy = snapshotItem(item);
        this.savedItems.set(item, copy);
      }
      items[i] = copy;
      ids[i] = copy.id;
      facts[i] = rowFacts(copy);
    };
    // Where a named row stands: the runtime's own row for the id, looked for among the rows by what it is
    // (a walk over places, no row is read). -1: not among them (taken out since).
    const ask = this.runtimeRow;
    const placeOf = (rid: string) => {
      const item = ask!(id, rid);
      return item ? src.lastIndexOf(item) : -1;
    };
    // Only where the runtime asked is the one these rows are of (it gives the last row back as itself): a save
    // for rows nobody answers for asks about every place, as before. And only for a few rows: each is looked
    // for by a walk over the places, so thousands of them (every row a base write slimmed) are one walk instead.
    if (was && named && ask && n > 0 && named.size + (again?.size ?? 0) <= PLACES_MAX && ask(id, src[n - 1].id) === src[n - 1]) {
      this.rowSaves.byPlace++;
      // Places that hold another row than at the last save (added, put in, taken out before, moved).
      const other: number[] = [];
      for (let i = n - 1; i >= 0; i--) if (was[i] !== src[i]) other.push(i);
      const changed = new Set<number>();
      for (const rid of named) {
        const i = placeOf(rid);
        if (i < 0) continue;
        changed.add(i);
        places.set(rid, i);
      }
      for (const i of other) make(i, changed.delete(i));
      for (const i of changed) make(i, true);
      if (again) for (const rid of again) {
        const i = placeOf(rid);
        // Copied again outside a save: its new copy is the one kept for it.
        if (i >= 0 && !places.has(rid) && was[i] === src[i]) make(i, false);
      }
      // From the lowest place up, so rows added at the end are appended in order.
      for (let k = other.length - 1; k >= 0; k--) was[other[k]] = src[other[k]];
      was.length = n;
      source = was;
    } else {
      // Nothing to take over, or no way to ask for a row: every place is asked about, the named ones first met from the end.
      this.rowSaves.asked++;
      let left = (named?.size ?? 0) + (again?.size ?? 0);
      const met = again && new Set<string>();
      for (let i = n - 1; i >= 0; i--) {
        const item = src[i];
        const same = was !== undefined && was[i] === item;
        let changed = all;
        let copied = false;
        if (left > 0) {
          // A row that stands where it stood is known by the id kept beside it.
          const rid = same ? ids[i] : item.id;
          // Each name counts once, also where two rows carry it: the asking must not stop before the others are met.
          if (named?.has(rid)) {
            changed = true;
            if (!places.has(rid)) {
              left--;
              places.set(rid, i);
            }
          }
          if (again?.has(rid)) {
            copied = true;
            if (!met!.has(rid)) {
              left--;
              met!.add(rid);
            }
          }
        }
        if (same && !changed && !copied) continue;
        make(i, changed);
      }
    }
    this.savedRows.set(id, { source: source ?? src.slice(), copies: items, ids, facts });
    return { items, ids, facts, places };
  }

  /**
   * Makes the copies of a chat just read ahead of its first save, a slice at a time. The first save of a
   * chat copies every row; for one of 126,000 rows that was one task of three seconds in which the window
   * answered nothing. Only copies are made here: the save decides as ever which of them still hold (a row
   * changed after its copy is named changed, and copied again). A save that comes first does what is left.
   */
  warmSave(id: string, live: TimelineItem[]) {
    if (this.sealed || this.savedRows.has(id) || this.warming.has(id) || live.length < 2048) return;
    let finish!: () => void;
    const run = { done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.warming.set(id, run);
    const src = live.slice();
    const n = src.length;
    const copies = new Array<TimelineItem>(n);
    const ids = new Array<string>(n);
    const facts = new Uint8Array(n);
    let i = n - 1;
    const step = () => {
      // Given up (a save came first, the chat went, a quit): whoever waits for it goes on.
      if (this.sealed || this.warming.get(id) !== run) return finish();
      const until = performance.now() + WARM_SLICE_MS;
      for (; i >= 0; i--) {
        if ((i & 31) === 0 && performance.now() >= until) break;
        const item = src[i];
        let copy = this.savedItems.get(item);
        if (!copy) this.savedItems.set(item, copy = snapshotItem(item));
        copies[i] = copy;
        ids[i] = copy.id;
        facts[i] = rowFacts(copy);
      }
      if (i >= 0) return void setImmediate(step);
      this.warming.delete(id);
      // The places too, unless a save took them or a row was copied again meanwhile: the first save then asks about no row it need not.
      if (!this.savedRows.has(id) && !this.recopied.has(id)) this.savedRows.set(id, { source: src, copies, ids, facts });
      finish();
    };
    setImmediate(step);
  }

  /**
   * A save that must happen now (an input to commit, a restart notice to confirm) waits for the copies
   * being made ahead, which is a second at most: flushed at once, it made the rest of them in its own
   * task, the very freeze the copies made ahead are there to prevent. A quit waits for nothing.
   */
  private async warmed(id: string) {
    const warm = this.warming.get(id);
    if (warm && !this.sealed) await warm.done;
  }

  /** Commit input ownership before the corresponding SDK write or RPC acknowledgement. */
  async persistInput(id: string, requireOpen = false) {
    await this.warmed(id);
    if (this.sealed) {
      if (requireOpen) throw new Error('The conversation store is closing.');
      return this.sealed;
    }
    await Promise.all([this.flushSession(id), this.sessionFiles.idle(id), this.flushFile(this.statePath), this.writingState]);
    if (this.sessionFiles.saveFailed(id)) throw new Error('Could not save the waiting message.');
  }

  /** SessionFiles retries failed writes on the next save. Only acknowledge a restart notice seen on disk. */
  async savedRestartNotice(id: string, notice: string): Promise<boolean> {
    await this.warmed(id);
    await this.flushSession(id);
    return this.sessionFiles.savedRestartNotice(id, notice);
  }

  deleteSession(id: string) {
    if (this.sealed) return;
    this.migrations.delete(id);
    const t = this.sessionTimers.get(id);
    if (t) clearTimeout(t);
    this.sessionTimers.delete(id);
    this.sessionPending.delete(id);
    this.activeSaves.delete(id);
    this.savedRows.delete(id);
    this.recopied.delete(id);
    this.warming.delete(id);
    this.sessionFiles.remove(id);
  }

  async flush() {
    for (const [file, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(file);
    }
    for (const [id, t] of this.sessionTimers) {
      clearTimeout(t);
      this.sessionTimers.delete(id);
    }
    const writes = [
      ...[...this.pending.keys()].map(f => this.flushFile(f)),
      ...[...this.sessionPending.keys()].map(id => this.flushSession(id)),
      this.sealed ? this.writingState : this.writingState.catch(() => {}),
      this.sessionFiles.idle(),
    ];
    const failed = (await Promise.allSettled(writes)).find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /**
   * Capture the quit boundary before yielding. Older writes finish first. Their data and the
   * debounced changes get one final snapshot independent of subsequent provider events.
   */
  seal(): Promise<void> {
    if (this.sealed) return this.sealed;
    this.sealed = Promise.resolve(); // Freeze before reading the pending callbacks.
    clearTimeout(this.migrationTimer);
    clearTimeout(this.recoveryTimer);
    this.recovery.abort();
    for (const id of this.migrations.keys()) this.sessionFiles.forgetMigration(id);
    this.migrations.clear();
    if (!this.unreadableState) this.pending.set(this.statePath, () => this.state);
    const retries = [...this.activeSaves]
      .filter(([id]) => !this.sessionPending.has(id))
      .map(([id, snapshot]) => this.sessionFiles.retryAfterWrite(id, snapshot));
    this.sealed = Promise.allSettled([this.flush(), this.verifying, ...retries]).then(results => {
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      if (this.sessionFiles.saveFailed()) throw new Error('Could not save all chat changes.');
    }).finally(() => {
      clearInterval(this.ownerTimer);
      try { if (this.owner) rmSync(this.owner, { force: true }); }
      catch { /* A later startup can release the dead owner's claim. */ }
    });
    return this.sealed;
  }
}
