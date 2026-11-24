import { mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isBackdropImageId, migrateBackdrop, migrateQuietDefault, normalizeBackdrop } from '../../shared/backdrop';
import { SessionFiles, type SessionData, type SessionSave } from './session-file';
import { DEFAULT_SETTINGS, type AppSettings, type FolderGroup, type Project, type ProviderId, type QueuedMessage, type SessionMeta, type TimelineItem, type Todo } from '../../shared/protocol';

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

/** JSON persistence under ~/.sable. Writes are debounced and atomic. */
export class Store {
  readonly dir: string;
  state: StateFile;
  private timers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, () => unknown>();
  /** Session timelines: a base and a small tail, so a long chat is not written whole after every word (session-file.ts). */
  private sessionFiles = new SessionFiles((id) => this.sessionPath(id));
  private sessionTimers = new Map<string, NodeJS.Timeout>();
  private sessionPending = new Map<string, () => SessionSave>();
  /** Sable is going down: nothing more is written (`seal`). */
  private sealed?: Promise<void>;
  private unreadableState = false;
  private writingState: Promise<void> = Promise.resolve();
  /** Frozen item versions shared by concurrent saves until the runtime marks the item dirty. */
  private savedItems = new WeakMap<TimelineItem, TimelineItem>();
  private activeSaves = new Map<string, SessionSave>();

  constructor(dir?: string) {
    this.dir = dir ?? process.env.SABLE_HOME ?? path.join(homedir(), '.sable');
    mkdirSync(path.join(this.dir, 'sessions'), { recursive: true });
    this.state = this.readState() ?? { projects: [], settings: { ...DEFAULT_SETTINGS }, sessions: [], accounts: [] };
    this.normalizeState();
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

  loadSession(id: string): SessionData {
    return this.sessionFiles.load(id);
  }

  /** As `loadSession`, a big file read in a worker thread (the main process keeps running). */
  loadSessionAsync(id: string): Promise<SessionData> {
    return this.sessionFiles.loadAsync(id);
  }

  /** `data` is read when the write happens; its `dirty` names the items changed since the last save. */
  saveSession(id: string, data: () => SessionSave) {
    if (this.sealed) return;
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
      const dirty = save.dirty === 'all' || save.dirty.has(item.id);
      // What the base already holds unchanged is not written by this save, so no copy of it is made:
      // copying every step at the first save after a long chat was read held all its output twice.
      if (!copy && !dirty && this.sessionFiles.holds(id, item.id)) return item;
      if (!copy || dirty) {
        // Keep immutable strings (including large tool output) shared. Freeze nested
        // payloads too: a task or attachment can change while an older base is writing.
        copy = { ...item };
        for (const [key, value] of Object.entries(copy)) {
          if (value && typeof value === 'object') Object.assign(copy, { [key]: structuredClone(value) });
        }
        this.savedItems.set(item, copy);
      }
      return copy;
    });
    const snapshot = { items, dirty: save.dirty === 'all' ? 'all' as const : new Set(save.dirty), todos: structuredClone(save.todos), queue: structuredClone(save.queue) };
    this.activeSaves.set(id, snapshot);
    return this.sessionFiles.save(id, () => snapshot, !!this.sealed).finally(() => {
      if (this.activeSaves.get(id) === snapshot && !this.sessionFiles.needsRetry(id)) this.activeSaves.delete(id);
    });
  }

  /** SessionFiles retries failed writes on the next save. Only acknowledge a restart notice seen on disk. */
  async savedRestartNotice(id: string, notice: string): Promise<boolean> {
    await this.flushSession(id);
    // Never by reading the conversation again: a chat of a gigabyte read a second time ended the app.
    return this.sessionFiles.holdsNotice(id, notice);
  }

  deleteSession(id: string) {
    if (this.sealed) return;
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
    if (!this.unreadableState) this.pending.set(this.statePath, () => this.state);
    const retries = [...this.activeSaves]
      .filter(([id]) => !this.sessionPending.has(id))
      .map(([id, snapshot]) => this.sessionFiles.retryAfterWrite(id, snapshot));
    this.sealed = Promise.allSettled([this.flush(), ...retries]).then(results => {
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
    });
    return this.sealed;
  }
}
