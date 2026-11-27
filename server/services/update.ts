import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from '../app';
import { workOf, type WorkSession } from '../core/work';
import type { UpdateState, UpdateWait } from '../../shared/protocol';
import { VERSION } from '../version';
import { installMac } from './update-mac';

/**
 * Updates of the desktop app. The newest release on GitHub is asked for a little after start and
 * then every few hours; a newer one's Windows installer (or, on a Mac, the app as a zip) downloads
 * in the background (checked against the size and the SHA-256 GitHub lists for it), and "Restart
 * to update" runs it silently and quits: the installer replaces Sable and starts it again
 * (`--force-run`), on a Mac a small script swaps the app (update-mac.ts). Asked while agents
 * work, it waits until they are done. Only the desktop shell can do this (`UpdateHost`); a dev or
 * standalone bridge reports `unsupported`.
 */

export const RELEASES_URL = 'https://api.github.com/repos/Leonxlnx/sable/releases/latest';
const FIRST_CHECK_MS = 30_000;
/** While a restart waits, it looks again at least this often. */
const RECHECK_MS = 15_000;
/** Sable's own step in flight (a send, a start, a decision) holds a restart this long at most: longer is a stuck entry, not work. */
export const STEP_HOLDS_MS = 3 * 60_000;
/** Also while a downloaded version waits for the restart: a newer release then takes its place (see `supersede`). */
const EVERY_MS = 2 * 3600_000;

export interface UpdateHost {
  /** Ends the app so the installer can replace it. */
  quit(): void;
}

export interface Release {
  version: string;
  url: string;
  name: string;
  size: number;
  sha256?: string;
}

/** a > b for versions like 0.2.10 (anything after a dash is ignored). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The file a release carries for this system: the Windows installer, or the app as a zip on a Mac (one per chip). */
export function assetName(version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === 'win32') return `Sable-Setup-${version}.exe`;
  if (platform === 'darwin') return `Sable-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  return null;
}

/** The installer of a published release (GitHub's "latest release" answer) for this system, or null. */
export function pickRelease(json: unknown, platform: NodeJS.Platform = process.platform, arch: string = process.arch): Release | null {
  const r = json as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!r || typeof r.tag_name !== 'string' || r.draft || r.prerelease) return null;
  const version = r.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }[]) : [];
  const wanted = assetName(version, platform, arch);
  const a = wanted ? assets.find((x) => x.name === wanted) : undefined;
  if (!a || typeof a.browser_download_url !== 'string' || typeof a.size !== 'number' || a.size <= 0) return null;
  if (!a.browser_download_url.startsWith('https://github.com/')) return null;
  const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined;
  return { version, url: a.browser_download_url, name: a.name as string, size: a.size, sha256: digest };
}

interface UpdaterOptions {
  host?: UpdateHost;
  /** Where downloads go. */
  dir?: string;
  version?: string;
  fetch?: typeof fetch;
  /** Where Sable runs, for choosing the release file (tests set it). */
  platform?: NodeJS.Platform;
  arch?: string;
  /** Starts the installer (tests replace it). */
  run?: (file: string) => void | Promise<void>;
  /** Whether agents are at work anywhere now, and a way to hear when that may have changed. */
  busy?: () => boolean;
  /**
   * While `busy` holds only for a while (a young background command, `updateWaits`): when to look
   * again by itself, as nothing the bridge says changes when that while is over.
   */
  recheckAt?: () => number | undefined;
  /** What the restart waits for, for the person to read (asked only while it waits). */
  waits?: () => UpdateWait[];
  /** No timers (tests call check() themselves). */
  manual?: boolean;
}

export class Updater {
  state: UpdateState;
  private release?: Release;
  private file?: string;
  private busyCheck?: () => void;
  private recheck?: NodeJS.Timeout;
  private timers: NodeJS.Timeout[] = [];
  private checking?: Promise<UpdateState>;
  private readonly dir: string;
  private readonly fetcher: typeof fetch;

  constructor(
    private emit: (state: UpdateState) => void,
    private opts: UpdaterOptions = {},
  ) {
    this.state = { status: opts.host ? 'idle' : 'unsupported', current: opts.version ?? VERSION };
    this.dir = opts.dir ?? path.join(os.tmpdir(), 'sable-update');
    this.fetcher = opts.fetch ?? fetch;
    if (opts.host && !opts.manual) {
      this.timers.push(setTimeout(() => void this.check().catch(() => {}), FIRST_CHECK_MS));
      const every = setInterval(() => void this.check().catch(() => {}), EVERY_MS);
      this.timers.push(every);
      for (const t of this.timers) t.unref?.();
    }
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.busyCheck = undefined;
    this.armRecheck();
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const k of Object.keys(this.state) as (keyof UpdateState)[]) if (this.state[k] === undefined) delete this.state[k];
    this.emit({ ...this.state });
  }

  /** Asks for the newest release; a newer one downloads now. `manual`: the person asked, so a failure is shown. */
  check(manual = false): Promise<UpdateState> {
    if (this.state.status === 'unsupported') return Promise.resolve(this.state);
    if (this.state.status === 'downloading') return Promise.resolve(this.state);
    // A version is downloaded and waits for the restart: it is not the end of looking. (It was:
    // someone who left the app open over three releases was offered the first, and had to restart
    // once per release.)
    if (this.state.status === 'ready') return (this.checking ??= this.supersede().finally(() => (this.checking = undefined)));
    return (this.checking ??= this.doCheck(manual).finally(() => (this.checking = undefined)));
  }

  /**
   * While a downloaded version waits for the restart, a release newer than it is fetched beside it,
   * checked, and only then takes its place: "Restart to update" stays there the whole time and
   * always installs the newest version that is whole on disk. Quiet: a failure changes nothing.
   */
  private async supersede(): Promise<UpdateState> {
    const have = this.release?.version ?? this.state.latest;
    try {
      const res = await this.fetcher(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Sable' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return this.state;
      const rel = pickRelease(await res.json(), this.opts.platform, this.opts.arch);
      if (this.state.status !== 'ready') return this.state;
      if (!rel || !have || !newer(rel.version, have)) {
        this.set({ checkedAt: Date.now() });
        return this.state;
      }
      const file = await this.fetchFile(rel);
      // The app is on its way out, or the state moved on meanwhile: what was ready stays the one.
      if (this.state.status !== 'ready' || this.left) {
        if (file !== this.file) rmSync(file, { force: true });
        return this.state;
      }
      const old = this.file;
      this.release = rel;
      this.file = file;
      this.set({ latest: rel.version, checkedAt: Date.now() });
      if (old && old !== file) rmSync(old, { force: true });
    } catch {
      /* the version that was ready is still ready */
    }
    return this.state;
  }

  private async doCheck(manual: boolean): Promise<UpdateState> {
    const before = this.state.status;
    this.set({ status: 'checking', error: undefined });
    try {
      const res = await this.fetcher(RELEASES_URL, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Sable' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub asked to wait. Try again later.' : `GitHub answered ${res.status}.`);
      const rel = pickRelease(await res.json(), this.opts.platform, this.opts.arch);
      const checkedAt = Date.now();
      if (!rel || !newer(rel.version, this.state.current)) {
        this.set({ status: 'idle', latest: undefined, checkedAt });
        return this.state;
      }
      this.release = rel;
      this.set({ checkedAt, latest: rel.version });
      await this.download(rel);
      return this.state;
    } catch (err) {
      const message = (err as Error)?.name === 'TimeoutError' ? 'GitHub did not answer.' : ((err as Error)?.message ?? String(err));
      // A check of its own that fails stays quiet; one the person asked for says why.
      this.set(manual ? { status: 'error', error: message } : { status: before === 'error' ? 'idle' : before === 'checking' ? 'idle' : before, error: undefined });
      return this.state;
    }
  }

  private async download(rel: Release) {
    mkdirSync(this.dir, { recursive: true });
    // Older downloads go.
    for (const f of readdirSync(this.dir)) if (f !== rel.name) rmSync(path.join(this.dir, f), { force: true, recursive: true });
    this.file = await this.fetchFile(rel, (p) => this.set(p === 0 ? { status: 'downloading', progress: 0 } : { progress: p }));
    this.set({ status: 'ready', progress: 1 });
  }

  /** The release's file in the download folder, whole and checked: taken as it is when it is already there, else fetched. */
  private async fetchFile(rel: Release, progress?: (p: number) => void): Promise<string> {
    mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, rel.name);
    if (existsSync(file) && statSync(file).size === rel.size && (await this.verified(file, rel))) return file;
    progress?.(0);
    const res = await this.fetcher(rel.url, { headers: { 'user-agent': 'Sable' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
    const part = `${file}.part`;
    const out = createWriteStream(part);
    const hash = createHash('sha256');
    let got = 0;
    let shown = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length;
        if (got > rel.size) throw new Error('The download is larger than GitHub said.');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        const p = got / rel.size;
        if (p - shown >= 0.02) {
          shown = p;
          progress?.(Math.min(0.99, p));
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      rmSync(part, { force: true });
      throw err;
    }
    if (got !== rel.size || (rel.sha256 && hash.digest('hex') !== rel.sha256)) {
      rmSync(part, { force: true });
      throw new Error('The download did not match the release.');
    }
    renameSync(part, file);
    return file;
  }

  private async verified(file: string, rel: Release): Promise<boolean> {
    if (!rel.sha256) return true;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex') === rel.sha256;
  }

  /**
   * Installs the downloaded release and quits; while agents work, once they are done, and the state
   * says what it waits for (`waits`). `force`: now, whatever still works: the person read what that ends.
   */
  install(cancel = false, force = false): UpdateState {
    if (cancel) {
      this.busyCheck = undefined;
      this.armRecheck();
      this.set({ pending: undefined, waits: undefined });
      return this.state;
    }
    if (this.state.status !== 'ready' || !this.file || !this.opts.host) throw new Error('No update is ready to install.');
    if (this.left) return this.state;
    if (force) {
      this.busyCheck = undefined;
      this.armRecheck();
      this.go(true);
      return this.state;
    }
    if (this.opts.busy?.() || !this.go()) {
      this.busyCheck = () => {
        try {
          if (!this.go()) {
            this.tellWaits();
            return this.armRecheck();
          }
        } catch (err) {
          this.set({ pending: undefined, waits: undefined, error: (err as Error).message });
        }
        this.busyCheck = undefined;
        this.armRecheck();
      };
      this.set({ pending: true, waits: this.readWaits() });
      this.armRecheck();
    }
    return this.state;
  }

  private readWaits(): UpdateWait[] | undefined {
    let waits: UpdateWait[] | undefined;
    try {
      waits = this.opts.waits?.();
    } catch {
      waits = undefined;
    }
    return waits?.length ? waits : undefined;
  }

  /** What it waits for changed: said once per change, never per look. */
  private tellWaits() {
    const waits = this.readWaits();
    if (JSON.stringify(waits) !== JSON.stringify(this.state.waits)) this.set({ waits });
  }

  /**
   * While a restart waits: a look again when the work that holds it stops holding it by its age alone,
   * and every `RECHECK_MS` whatever holds it: work that ends without a word from its chat (a command
   * the agent stopped, its process's own state) must not keep a restart waiting for the rest of a
   * command's half hour.
   */
  private armRecheck() {
    clearTimeout(this.recheck);
    this.recheck = undefined;
    const at = this.busyCheck ? Math.min(this.opts.recheckAt?.() ?? Date.now() + 3000, Date.now() + RECHECK_MS) : undefined;
    if (at === undefined) return;
    this.recheck = setTimeout(() => this.workChanged(), Math.max(1000, at - Date.now() + 50));
    this.recheck.unref?.();
  }

  /** Called when work may have ended somewhere (a pending restart goes once nothing runs). */
  workChanged() {
    this.busyCheck?.();
  }

  /** The installer was started: nothing replaces its file any more. */
  private left = false;

  get installing() { return this.left; }

  private launch(file: string) {
    const child = (this.opts.platform ?? process.platform) === 'darwin'
      ? installMac(file)
      : spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    return new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }

  private go(force = false) {
    if (this.left) return true;
    if (!force && this.opts.busy?.()) return false;
    const file = this.file!;
    this.left = true;
    const quit = () => {
      this.set({ pending: undefined, waits: undefined });
      this.opts.host?.quit();
    };
    try {
      const started = this.opts.run ? this.opts.run(file) : this.launch(file);
      if (!started) quit();
      else void started.then(quit, (err: Error) => {
        this.left = false;
        this.set({ pending: undefined, waits: undefined, error: err.message });
      });
    } catch (err) {
      this.left = false;
      throw err;
    }
    return true;
  }
}

/**
 * How long a background command holds a restart for an update: a test run the agent waits on does,
 * a dev server that runs all day does not hold the update for ever.
 */
export { COMMAND_HOLDS_MS as COMMAND_UPDATE_WAIT_MS } from '../core/work';

/** A session as the update's wait reads it: `newestCommandAt`, when its youngest background command still running began. */
export type UpdateSession = WorkSession;

/**
 * Whether an update's restart waits for work now: a turn, a session starting, sub-agents still
 * working in the background (an update would end them), a working command younger than
 * `COMMAND_UPDATE_WAIT_MS`. `recheckAt`: when the youngest such command stops holding it, if only
 * commands do.
 */
export function updateWaits(sessions: Iterable<UpdateSession>, now = Date.now()): { busy: boolean; recheckAt?: number } {
  const holds = updateHolds(sessions, now);
  if (!holds.length) return { busy: false };
  if (holds.some((h) => h.until === undefined)) return { busy: true };
  return { busy: true, recheckAt: Math.max(...holds.map((h) => h.until!)) };
}

/**
 * The same rule, said per chat for the person: which chats hold the restart and by what. A chat is
 * named once, by the strongest thing it holds; one with `until` holds by its age alone.
 */
export function updateHolds(sessions: Iterable<UpdateSession>, now = Date.now()): UpdateWait[] {
  const out: UpdateWait[] = [];
  for (const rt of sessions) {
    const work = workOf(rt, true, now, 'update');
    const s = rt.meta.status;
    const of = rt.meta.id ? { sessionId: rt.meta.id } : {};
    const kind: UpdateWait['kind'] | undefined = rt.meta.moving ? 'moving' : s === 'starting' ? 'starting' : s === 'awaiting' ? 'asks'
      : rt.turnActive || s === 'running' ? 'turn' : work.agents ? 'agents' : work.turn ? 'agent' : undefined;
    if (kind) out.push({ ...of, kind, ...(kind === 'agents' && work.agents > 1 ? { count: work.agents } : {}) });
    else if (work.holds !== undefined) {
      out.push({ ...of, kind: work.commands ? 'command' : work.wakeAt !== undefined ? 'wake' : 'agent',
        ...(work.commands > 1 ? { count: work.commands } : {}), until: work.holds });
    }
  }
  return out;
}

/**
 * A reading that holds only for `ms` at a stretch: `read` true for longer is taken as stuck. The
 * stretch starts over when nobody looked for `gap` (the count belongs to one wait, not to an old one).
 */
export function boundedHold(read: () => boolean, ms: number, gap = 10_000): (now?: number) => boolean {
  let since: number | undefined;
  let seen = 0;
  return (now = Date.now()) => {
    if (!read()) {
      since = undefined;
      return false;
    }
    if (since === undefined || now - seen > gap) since = now;
    seen = now;
    return now - since < ms;
  };
}

/** Updates through the desktop shell: `update.check`, `update.install`, and the state in `app.hello`. */
export function registerUpdates(app: App, host?: UpdateHost) {
  // A step of Sable's own in flight is seconds of work; an entry that stays is a leak, and no restart waits on a leak.
  const step = boundedHold(() => app.preparingWork, STEP_HOLDS_MS);
  const updater = new Updater((state) => app.emit({ type: 'update.state', state }), {
    host: process.platform === 'win32' || process.platform === 'darwin' ? host : undefined,
    busy: () => step() || updateWaits(app.sessions.values()).busy,
    recheckAt: () => updateWaits(app.sessions.values()).recheckAt,
    waits: () => [...updateHolds(app.sessions.values()), ...(step() ? [{ kind: 'sable' as const }] : [])],
  });
  app.updates = updater;
  app.subscribe((e) => {
    if (e.type === 'session.updated' || e.type === 'session.removed' || e.type === 'session.added') updater.workChanged();
  });
  app.register('update.check', () => updater.check(true));
  app.register('update.install', ({ cancel, force }) => updater.install(cancel === true, force === true));
  return updater;
}
