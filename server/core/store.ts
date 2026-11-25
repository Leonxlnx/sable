import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeFile, rename } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { isBackdropImageId, migrateBackdrop, migrateQuietDefault, normalizeBackdrop } from '../../shared/backdrop';
import { isLight, LIGHT } from './trim';
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
  const clone = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clone);
    if (!v || typeof v !== 'object') return v;
    if (Object.getPrototypeOf(v) !== Object.prototype) return structuredClone(v);
    return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, clone(value)]));
  };
  return clone(item) as TimelineItem;
}

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

  constructor(dir?: string, runtimeItem?: (session: string, id: string) => TimelineItem | undefined) {
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
    const contents = JSON.stringify(data());
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
    this.savedItems.delete(item);
    for (const key of Object.getOwnPropertyNames(item)) Reflect.deleteProperty(item, key);
    Object.assign(item, view);
    this.bindProviderInputs(id, [item]);
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
    this.sessionTimers.set(
      id,
      setTimeout(() => {
        this.sessionTimers.delete(id);
        this.flushSession(id);
      }, 1500),
    );
  }

  private flushSession(id: string) {
    const data = this.sessionPending.get(id);
    if (!data) return Promise.resolve();
    this.sessionPending.delete(id);
    const save = data();
    const items = save.items.map(item => {
      let copy = this.savedItems.get(item);
      if (!copy || save.dirty === 'all' || save.dirty.has(item.id)) {
        copy = snapshotItem(item);
        this.savedItems.set(item, copy);
      }
      return copy;
    });
    const snapshot = { items, dirty: save.dirty === 'all' ? 'all' as const : new Set(save.dirty), todos: structuredClone(save.todos),
      queue: structuredClone(save.queue), receiptRepair: save.receiptRepair?.slice() };
    this.activeSaves.set(id, snapshot);
    return this.sessionFiles.save(id, () => snapshot, !!this.sealed).finally(() => {
      if (this.activeSaves.get(id) === snapshot && !this.sessionFiles.needsRetry(id)) this.activeSaves.delete(id);
    });
  }

  /** Commit input ownership before the corresponding SDK write or RPC acknowledgement. */
  async persistInput(id: string, requireOpen = false) {
    if (this.sealed) {
      if (requireOpen) throw new Error('The conversation store is closing.');
      return this.sealed;
    }
    await Promise.all([this.flushSession(id), this.sessionFiles.idle(id), this.flushFile(this.statePath), this.writingState]);
    if (this.sessionFiles.saveFailed(id)) throw new Error('Could not save the waiting message.');
  }

  /** SessionFiles retries failed writes on the next save. Only acknowledge a restart notice seen on disk. */
  async savedRestartNotice(id: string, notice: string): Promise<boolean> {
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
