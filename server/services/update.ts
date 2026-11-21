import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from '../app';
import type { UpdateState } from '../../shared/protocol';
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
const EVERY_MS = 6 * 3600_000;

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
  run?: (file: string) => void;
  /** Whether agents are at work anywhere now, and a way to hear when that may have changed. */
  busy?: () => boolean;
  /** No timers (tests call check() themselves). */
  manual?: boolean;
}

export class Updater {
  state: UpdateState;
  private release?: Release;
  private file?: string;
  private busyCheck?: () => void;
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
  }

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const k of Object.keys(this.state) as (keyof UpdateState)[]) if (this.state[k] === undefined) delete this.state[k];
    this.emit({ ...this.state });
  }

  /** Asks for the newest release; a newer one downloads now. `manual`: the person asked, so a failure is shown. */
  check(manual = false): Promise<UpdateState> {
    if (this.state.status === 'unsupported') return Promise.resolve(this.state);
    if (this.state.status === 'downloading' || this.state.status === 'ready') return Promise.resolve(this.state);
    return (this.checking ??= this.doCheck(manual).finally(() => (this.checking = undefined)));
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
    const file = path.join(this.dir, rel.name);
    // Older downloads go.
    for (const f of readdirSync(this.dir)) if (f !== rel.name) rmSync(path.join(this.dir, f), { force: true, recursive: true });
    if (existsSync(file) && statSync(file).size === rel.size && (await this.verified(file, rel))) {
      this.file = file;
      this.set({ status: 'ready', progress: 1 });
      return;
    }
    this.set({ status: 'downloading', progress: 0 });
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
          this.set({ progress: Math.min(0.99, p) });
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
    this.file = file;
    this.set({ status: 'ready', progress: 1 });
  }

  private async verified(file: string, rel: Release): Promise<boolean> {
    if (!rel.sha256) return true;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest('hex') === rel.sha256;
  }

  /** Installs the downloaded release and quits; while agents work, once they are done. */
  install(cancel = false): UpdateState {
    if (cancel) {
      this.busyCheck = undefined;
      this.set({ pending: undefined });
      return this.state;
    }
    if (this.state.status !== 'ready' || !this.file || !this.opts.host) throw new Error('No update is ready to install.');
    if (this.opts.busy?.()) {
      this.busyCheck = () => {
        if (this.opts.busy?.()) return;
        this.busyCheck = undefined;
        this.go();
      };
      this.set({ pending: true });
      return this.state;
    }
    this.go();
    return this.state;
  }

  /** Called when work may have ended somewhere (a pending restart goes once nothing runs). */
  workChanged() {
    this.busyCheck?.();
  }

  private go() {
    const file = this.file!;
    const run =
      this.opts.run ??
      ((f: string) => {
        // A Mac swaps the app bundle with a script that waits for this process to end, then opens the new one.
        if ((this.opts.platform ?? process.platform) === 'darwin') return installMac(f);
        // Silent, then the installer starts Sable again; it outlives this process.
        spawn(f, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      });
    run(file);
    this.set({ pending: undefined });
    setTimeout(() => this.opts.host?.quit(), 400).unref?.();
  }
}

/** Updates through the desktop shell: `update.check`, `update.install`, and the state in `app.hello`. */
export function registerUpdates(app: App, host?: UpdateHost) {
  const updater = new Updater((state) => app.emit({ type: 'update.state', state }), {
    host: process.platform === 'win32' || process.platform === 'darwin' ? host : undefined,
    busy: () => [...app.sessions.values()].some((rt) => rt.turnActive || rt.meta.status === 'running' || rt.meta.status === 'starting'),
  });
  app.updates = updater;
  app.subscribe((e) => {
    if (e.type === 'session.updated' || e.type === 'session.removed' || e.type === 'session.added') updater.workChanged();
  });
  app.register('update.check', () => updater.check(true));
  app.register('update.install', ({ cancel }) => updater.install(cancel === true));
  return updater;
}
