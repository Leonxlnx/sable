import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings, CustomBuild, CustomState, ProviderId, SessionMeta, SessionSnapshot } from '../../shared/protocol';
import { CUSTOM_READY_MS } from '../../shared/protocol';
import type { App } from '../app';
import { VERSION } from '../version';
import { remoteRef } from './css-scan';

/**
 * Customize Sable: the person changes the app they are using, with an agent.
 *
 * Your styles (depth A): `<data>/custom/styles.css`, plain CSS over the app's own classes and tokens,
 * served at `/custom/styles.css` to the app's own origin only and linked after the app's own styles
 * (`src/boot.ts`); the folder is watched, and every change of the file is pushed as `custom.updated`
 * with a new `rev`, so the page swaps the sheet in place. Nothing to build, and an update changes
 * nothing about it. Off with `AppSettings.customStyles: false` (or "Use Sable's own look"), and for one
 * run with `--original` (the shell passes `ignore`). A sheet that asks for anything from the internet,
 * or that cannot be read safely, is not applied at all (`remoteRef`, a CSS tokenizer in `css-scan.ts`).
 * The whole `/custom/` namespace answers the app's own origin only; the desktop's pages cannot be framed
 * (`frame-ancestors 'none'`, `electron/csp.ts`).
 *
 * The Customize chat runs only with an agent that gets its brief (`customAgent`: Claude Code or Codex;
 * the Demo agent when named, for development). A phone cannot reach the sheet through a chat
 * (`phoneRefusal`): no chat of a phone's in the data folder, and the Customize chat (or any
 * chat in `<data>/custom`) is only read and stopped from a phone; `custom.*` is not on its allowlist.
 *
 * Any local process that can reach the bridge (review wave 8, #1: out of scope for now) can call these
 * methods, but none gives it more than the bridge already does: `custom.open` starts a chat in the
 * person's default mode, which `session.create` can do in a mode that never asks; `custom.original` turns a
 * setting off, as `app.setSettings` does; the build's methods answer `BUILD_OFF`.
 *
 * NOT IN THIS VERSION, your build (`BUILD_SHIPS` is false): nothing offers it (no row in Settings, no
 * strip above the composer), its methods answer `BUILD_OFF`, the served root is always the app's own
 * and the brief never mentions it. Its code is kept and tested with `build: true`. Before it is
 * switched on, clear this list (Codex review wave 8):
 *   - #2  Approval covers only `index.html`: a changed asset at an existing path runs after approval,
 *         and the served folder is checked lexically (a link or junction in `dist` escapes it). Publish
 *         an immutable snapshot into a folder of the bridge's own, refuse links and reparse points
 *         while copying, and serve only the files in the approved manifest.
 *   - #8  `vite build` loads the checkout's own config and plugins, which the agent can edit, as the
 *         desktop user with Sable's environment: build with a trusted config and toolchain, a narrowed
 *         environment and file system, and publish only its validated output.
 *   - #9  An old interface can talk to a newer bridge: verify the source base before activation, bind
 *         a bridge connection to the active build and protocol generation, and keep a custom build's
 *         storage and service workers away from the recovery interface (`--original`).
 *   - #15 The start deadline is one absolute timer per bridge (no longer moved on by reloads, never
 *         started by HEAD, `--original` honoured by a second start): tie a deadline and a readiness
 *         token to the main window's own navigation, so another tab cannot acknowledge it.
 *   - #1  The build's methods (`custom.setup`, `custom.build`, `custom.use`, `custom.bring`) change
 *         what every window runs: require a capability bound to the trusted main window for them, and
 *         the canonical origin (no loopback aliases) at the HTTP and WebSocket entry points.
 *   - Run the whole path (set up, build, switch, fall back, bring) in a packaged app.
 * Done already: #14 (setup never deletes a folder Sable did not make, clones beside it and is set up
 * only once installed) and #29 (the static server opens a file before its headers).
 *
 * Your build (depth B), as designed: `<data>/custom/src`, a clone of the public repository at the running version's
 * tag on a branch `mine`; its `vite build` output is served instead of the app's own `dist` while the
 * person has switched it on, it was built for the running version, and its `index.html` is the very one
 * they switched on (an agent that rebuilds cannot swap what is served without their click). A page
 * served from it must call `custom.ready` within `CUSTOM_READY_MS`, or the build is set aside and the
 * shell reloads the window into the app's own interface. After an update, "Bring them to" rebases the
 * person's branch onto the new tag, installs when the lockfile changed, builds and switches; a conflict
 * is aborted and goes to the Customize chat as a message. Every external step (git, pnpm, the network)
 * goes through `CustomRunner`, so tests never run one.
 *
 * The switch state lives in `<data>/custom-build.json`, outside the folder the Customize chat's agent
 * works in. The bridge, the shell and the protocol always stay the installed ones.
 */

export const CUSTOM_DIR = 'custom';
export const STYLES_FILE = 'styles.css';
export const STYLES_PATH = '/custom/styles.css';
export const BUILD_STATE_FILE = 'custom-build.json';
export const REPO_URL = 'https://github.com/Leonxlnx/sable.git';
/** The longest stylesheet served (bytes); a bigger one is not applied. */
export const MAX_STYLES = 2_000_000;
/**
 * Your build ships in this release: false, so nothing offers it, its methods answer `BUILD_OFF`, the
 * served root is always the app's own and the brief never mentions it (see the list in the header).
 */
export const BUILD_SHIPS = false;
export const BUILD_OFF = 'Your own build of the interface is not available in this version.';

// ─────────────────────────────── the stylesheet ───────────────────────────────

/** What a sheet asks for beyond this computer (`css-scan.ts`): a sheet with any of it is not applied. */
export { remoteRef };

/** Whether a request comes from the app's own page (same origin, a loopback host on this server). */
export function ownOrigin(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────── the runner ───────────────────────────────

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one external program (git, node, pnpm). Injected so tests never touch git, pnpm or the network. */
export type CustomRunner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<RunResult>;

export const defaultRunner: CustomRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    // pnpm is a .cmd on Windows: it needs a shell there; git and node do not.
    const shell = process.platform === 'win32' && cmd === 'pnpm';
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code as number) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code !== 0 ? err.message : '') });
    });
  });

/** One line of what went wrong, from a program's output. */
function lastLine(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => /error|fatal|failed|ERR_/i.test(l));
  return (err ?? lines[0] ?? 'It failed').slice(0, 240);
}

// ─────────────────────────────── the build's switch ───────────────────────────────

interface BuildFile {
  /** The person switched their build on. */
  active?: boolean;
  /** The version the last build was made for, and when. */
  builtFor?: string;
  builtAt?: number;
  /** The SHA-256 of the `dist/index.html` the person switched on: only that one is served. */
  index?: string;
  /** The tag the branch `mine` stands on. */
  base?: string;
  /** Setup finished: the workspace installed (a failed install leaves it unset, and setup installs again). */
  installed?: boolean;
  failed?: { at: number; reason: string };
}

export interface CustomOptions {
  /** Sable's data folder (`<data>/custom` is the person's). */
  home: string;
  version?: string;
  settings: () => Pick<AppSettings, 'customStyles'>;
  emit?: (state: CustomState) => void;
  /** `--original` or Shift at start: nothing of the person's for this run. */
  ignore?: boolean;
  /** The bridge serves the built interface (the desktop app): a custom build can be served. */
  serving?: boolean;
  /** Your build is offered at all (`BUILD_SHIPS`; tests of its code turn it on). */
  build?: boolean;
  runner?: CustomRunner;
  /** Where the reference material lies (packaged: the app's resources); absent: this source tree. */
  reference?: string;
  /** Watch the folder for changes (tests that drive changes by hand turn it off). */
  watch?: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (...args: unknown[]) => void;
  /** Sends a message to the Customize chat (a rebase that conflicts). */
  tell?: (text: string) => Promise<unknown>;
}

const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

export class Customizer {
  readonly dir: string;
  readonly stylesFile: string;
  readonly workspace: string;
  readonly version: string;
  private buildFile: string;
  private rev = 0;
  private stylesHash = '';
  private stylesInfo: { exists: boolean; size: number; changedAt?: number; blocked?: string; body: string } = { exists: false, size: 0, body: '' };
  private file: BuildFile = {};
  private step?: CustomBuild['step'];
  private error?: string;
  private missing?: string;
  private changedAt?: number;
  private watchers: FSWatcher[] = [];
  private stylesTimer?: NodeJS.Timeout;
  private sourceTimer?: NodeJS.Timeout;
  private sourceWatched = false;
  private watchdog?: unknown;
  private reloadListeners = new Set<(why: 'fallback' | 'switch') => void>();
  private busy?: Promise<unknown>;
  private indexCache?: { key: string; hash: string };
  private run: CustomRunner;
  private now: () => number;
  sessionId?: string;

  constructor(private opts: CustomOptions) {
    this.dir = path.join(opts.home, CUSTOM_DIR);
    this.stylesFile = path.join(this.dir, STYLES_FILE);
    this.workspace = path.join(this.dir, 'src');
    this.buildFile = path.join(opts.home, BUILD_STATE_FILE);
    this.version = opts.version ?? VERSION;
    this.run = opts.runner ?? defaultRunner;
    this.now = opts.now ?? Date.now;
    this.file = this.readBuild();
    this.readStyles();
    if (opts.watch !== false) this.startWatch();
  }

  // ── state ──

  private readBuild(): BuildFile {
    try {
      const f = JSON.parse(readFileSync(this.buildFile, 'utf8')) as BuildFile;
      return f && typeof f === 'object' ? f : {};
    } catch {
      return {};
    }
  }

  private saveBuild(patch: Partial<BuildFile>) {
    this.file = { ...this.file, ...patch };
    for (const k of Object.keys(this.file) as (keyof BuildFile)[]) if (this.file[k] === undefined) delete this.file[k];
    mkdirSync(path.dirname(this.buildFile), { recursive: true });
    const tmp = `${this.buildFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    renameSync(tmp, this.buildFile);
  }

  /** Your build is offered in this version. */
  private get buildOn(): boolean {
    return this.opts.build ?? BUILD_SHIPS;
  }

  private offered() {
    if (!this.buildOn) throw new Error(BUILD_OFF);
  }

  stylesOn(): boolean {
    return this.opts.settings().customStyles !== false;
  }

  private hasWorkspace() {
    return existsSync(path.join(this.workspace, '.git'));
  }

  private distIndex() {
    return path.join(this.workspace, 'dist', 'index.html');
  }

  /** The SHA-256 of the built `index.html` now (cached by size and time), or undefined when there is none. */
  private indexHash(): string | undefined {
    try {
      const st = statSync(this.distIndex());
      const key = `${st.size}:${st.mtimeMs}`;
      if (this.indexCache?.key === key) return this.indexCache.hash;
      const hash = sha256(readFileSync(this.distIndex()));
      this.indexCache = { key, hash };
      return hash;
    } catch {
      return undefined;
    }
  }

  /** Shift held at start: nothing of the person's for the rest of this run. True when something was applied. */
  ignoreForRun(): boolean {
    if (this.opts.ignore) return false;
    const was = this.serving() || (this.stylesInfo.exists && this.stylesOn());
    this.opts.ignore = true;
    this.rev++;
    this.changed();
    return was;
  }

  /** The custom interface is what windows get now. */
  serving(): boolean {
    const f = this.file;
    if (!this.buildOn || !this.opts.serving || this.opts.ignore || !f.active || f.failed || f.builtFor !== this.version || !f.index) return false;
    return this.indexHash() === f.index;
  }

  state(): CustomState {
    const f = this.file;
    const s = this.stylesInfo;
    return {
      dir: this.dir,
      version: this.version,
      ignored: !!this.opts.ignore,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      styles: { exists: s.exists, on: this.stylesOn(), rev: this.rev, size: s.size, ...(s.changedAt ? { changedAt: s.changedAt } : {}), ...(s.blocked ? { blocked: s.blocked } : {}) },
      build: {
        supported: !!this.opts.serving && this.buildOn,
        workspace: this.hasWorkspace(),
        active: !!f.active,
        serving: this.serving(),
        ...(f.builtFor ? { builtFor: f.builtFor } : {}),
        ...(f.builtAt ? { builtAt: f.builtAt } : {}),
        ...(f.failed ? { failed: f.failed } : {}),
        ...(this.step ? { step: this.step } : {}),
        ...(this.error ? { error: this.error } : {}),
        ...(this.missing ? { missing: this.missing } : {}),
        ...(this.changedAt ? { changedAt: this.changedAt } : {}),
      },
    };
  }

  private changed() {
    this.opts.emit?.(this.state());
  }

  /** Something of Sable's own settings changed (`customStyles`): windows reload the sheet. */
  settingsChanged() {
    this.rev++;
    this.changed();
  }

  // ── your styles ──

  /** Reads the file again; true when what is served changed. */
  readStyles(): boolean {
    let body = '';
    let exists = false;
    let size = 0;
    let changedAt: number | undefined;
    let blocked: string | undefined;
    try {
      const st = statSync(this.stylesFile);
      if (st.isFile()) {
        exists = true;
        size = st.size;
        changedAt = Math.round(st.mtimeMs);
        if (size > MAX_STYLES) blocked = `It is larger than ${Math.round(MAX_STYLES / 1_000_000)} MB`;
        else {
          body = readFileSync(this.stylesFile, 'utf8');
          const remote = remoteRef(body);
          // An address it asks for, or what keeps it from being read safely ("an unfinished comment").
          if (remote) blocked = /^an? /.test(remote) ? `It has ${remote}` : `It asks for ${remote}`;
        }
      }
    } catch {
      /* none */
    }
    if (blocked) body = '';
    const hash = sha256(`${exists}:${blocked ?? ''}:${body}`);
    const before = this.stylesInfo;
    this.stylesInfo = { exists, size, changedAt, blocked, body };
    if (hash === this.stylesHash) return before.size !== size || before.changedAt !== changedAt;
    this.stylesHash = hash;
    this.rev++;
    return true;
  }

  /** What `/custom/styles.css` serves now: empty when off, ignored for this run, missing or not applied. */
  stylesheet(): string {
    if (this.opts.ignore || !this.stylesOn()) return '';
    return this.stylesInfo.body;
  }

  /** Answers `/custom/styles.css`; false when the request is for something else. */
  serveStyles(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      /* looked at as sent */
    }
    // The whole `/custom/` namespace is reserved, in any case and spelling: only the stylesheet is in it.
    const lower = pathname.toLowerCase();
    if (lower !== '/custom' && !lower.startsWith('/custom/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return true;
    }
    if (!ownOrigin(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return true;
    }
    if (url.pathname !== STYLES_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return true;
    }
    const body = Buffer.from(this.stylesheet(), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
    return true;
  }

  private startWatch() {
    try {
      mkdirSync(this.dir, { recursive: true });
      const w = watch(this.dir, (_ev, name) => {
        if (name && String(name).toLowerCase() !== STYLES_FILE) return;
        this.stylesTouched();
      });
      w.on('error', () => {});
      this.watchers.push(w);
    } catch (err) {
      this.opts.log?.('custom: the folder cannot be watched:', (err as Error).message);
    }
    this.watchSource();
  }

  /**
   * The stylesheet was written. Editors and agents write in bursts (truncate, write, rename): one read
   * after it settles. A timer of its own: a source change at the same moment never cancels this read.
   */
  private stylesTouched() {
    clearTimeout(this.stylesTimer);
    this.stylesTimer = setTimeout(() => {
      this.stylesTimer = undefined;
      if (this.readStyles()) this.changed();
    }, 60);
  }

  /** The workspace's source changed: the state goes out once the burst settles (its own timer). */
  private sourceTouched() {
    this.changedAt = this.now();
    clearTimeout(this.sourceTimer);
    this.sourceTimer = setTimeout(() => {
      this.sourceTimer = undefined;
      this.changed();
    }, 200);
  }

  /** The workspace's own source: a change an agent made means there is something to build. */
  private watchSource() {
    const src = path.join(this.workspace, 'src');
    if (!this.buildOn || this.sourceWatched || !existsSync(src)) return;
    try {
      const w = watch(src, { recursive: true }, () => this.sourceTouched());
      w.on('error', () => {});
      this.watchers.push(w);
      this.sourceWatched = true;
    } catch {
      /* not watched: the build button is always offered */
    }
  }

  /** The source changed (tests, and anything that knows better than the watch). */
  sourceChanged(at = this.now()) {
    this.changedAt = at;
    this.changed();
  }

  // ── the reference the Customize chat's agent reads ──

  /** Where the reference is copied from: the app's resources, or this source tree in development. */
  private referenceSource(): { claude: string; styles: string } | undefined {
    if (this.opts.reference) return { claude: path.join(this.opts.reference, 'CLAUDE.md'), styles: path.join(this.opts.reference, 'styles') };
    try {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      if (existsSync(path.join(root, 'CLAUDE.md')) && existsSync(path.join(root, 'src'))) return { claude: path.join(root, 'CLAUDE.md'), styles: path.join(root, 'src') };
    } catch {
      /* none */
    }
    return undefined;
  }

  /** `<data>/custom/reference`: CLAUDE.md and every stylesheet of the app, as of the running version. */
  referenceDir() {
    return path.join(this.dir, 'reference');
  }

  /** Copies the reference into the person's folder (where the agent reads without asking), when it changed. */
  syncReference(): boolean {
    const src = this.referenceSource();
    if (!src) return false;
    const files = existsSync(src.styles) ? cssFiles(src.styles) : [];
    const stamp = sha256([this.version, ...[src.claude, ...files.map((f) => path.join(src.styles, f))].map((f) => {
      try {
        const st = statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return f;
      }
    })].join('\n'));
    const out = this.referenceDir();
    const stampFile = path.join(out, '.stamp');
    try {
      if (readFileSync(stampFile, 'utf8') === stamp) return false;
    } catch {
      /* first time */
    }
    try {
      rmSync(out, { recursive: true, force: true });
      mkdirSync(path.join(out, 'styles'), { recursive: true });
      if (existsSync(src.claude)) copyFileSync(src.claude, path.join(out, 'CLAUDE.md'));
      for (const f of files) {
        mkdirSync(path.dirname(path.join(out, 'styles', f)), { recursive: true });
        copyFileSync(path.join(src.styles, f), path.join(out, 'styles', f));
      }
      writeFileSync(stampFile, stamp);
      return true;
    } catch (err) {
      this.opts.log?.('custom: the reference could not be copied:', (err as Error).message);
      return false;
    }
  }

  /** The brief appended to the Customize chat's system prompt (only that chat's). */
  brief(): string {
    return customBrief({ dir: this.dir, reference: this.referenceDir(), build: this.buildOn, workspace: this.buildOn && this.hasWorkspace() ? this.workspace : undefined, version: this.version });
  }

  // ── your build: serving it ──

  /** The folder the app is served from: the person's build while it is what windows get, else `own`. */
  root(own: string): string {
    return this.serving() ? path.join(this.workspace, 'dist') : own;
  }

  /** A page was served from `root`: a custom one has `CUSTOM_READY_MS` to call `custom.ready`. */
  served(root: string) {
    if (path.resolve(root) !== path.resolve(this.workspace, 'dist')) return;
    // One absolute deadline: a page that reloads again and again does not move it on.
    if (this.watchdog !== undefined) return;
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
    this.watchdog = set(() => this.fallback('It did not start within 15 seconds'), CUSTOM_READY_MS);
  }

  private clearWatchdog() {
    if (this.watchdog === undefined) return;
    (this.opts.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout)))(this.watchdog);
    this.watchdog = undefined;
  }

  /** The page started (`custom.ready`). */
  ready(): boolean {
    const was = this.watchdog !== undefined;
    this.clearWatchdog();
    return was;
  }

  /** The custom build did not start: it is set aside, and windows reload into the app's own interface. */
  fallback(reason: string) {
    this.watchdog = undefined;
    this.saveBuild({ failed: { at: this.now(), reason } });
    this.opts.log?.('custom: the custom interface was set aside:', reason);
    this.changed();
    for (const l of this.reloadListeners) l('fallback');
  }

  /** The shell: reload the window when what is served changes (a fallback, a switch). */
  onReload(l: (why: 'fallback' | 'switch') => void) {
    this.reloadListeners.add(l);
    return () => this.reloadListeners.delete(l);
  }

  private switched() {
    this.changed();
    for (const l of this.reloadListeners) l('switch');
  }

  // ── your build: the workspace ──

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Sable is already working on your build.');
    const p = fn();
    this.busy = p;
    try {
      return await p;
    } finally {
      this.busy = undefined;
      this.step = undefined;
      this.changed();
    }
  }

  private setStep(step: CustomBuild['step']) {
    this.step = step;
    this.error = undefined;
    this.changed();
  }

  private fail(message: string): never {
    this.error = message;
    throw new Error(message);
  }

  /** Git, Node and pnpm, asked of the machine: what is missing, in one line with the command that installs it. */
  async tools(): Promise<string | undefined> {
    const ask = async (cmd: string) => (await this.run(cmd, ['--version'], { cwd: this.opts.home, timeoutMs: 20_000 }).catch(() => ({ code: 1, stdout: '', stderr: '' }))).code === 0;
    const win = process.platform === 'win32';
    if (!(await ask('git'))) return `Git is missing: ${win ? 'winget install Git.Git' : 'install it from git-scm.com'}`;
    if (!(await ask('node'))) return `Node.js is missing: ${win ? 'winget install OpenJS.NodeJS.LTS' : 'install it from nodejs.org'}`;
    if (!(await ask('pnpm'))) return 'pnpm is missing: npm install -g pnpm';
    return undefined;
  }

  private async git(args: string[], what: string): Promise<RunResult> {
    const r = await this.run('git', args, { cwd: this.workspace });
    if (r.code !== 0) this.fail(`${what}: ${lastLine(r)}`);
    return r;
  }

  private async install() {
    this.setStep('installing');
    const r = await this.run('pnpm', ['install', '--frozen-lockfile'], { cwd: this.workspace, timeoutMs: 900_000 });
    if (r.code !== 0) this.fail(`Installing failed: ${lastLine(r)}`);
  }

  /** Clones the public repository at the running version's tag, on a branch `mine`, and installs. */
  setup(): Promise<CustomState> {
    if (!this.buildOn) return Promise.reject(new Error(BUILD_OFF));
    return this.exclusive(async () => {
      // Set up only once it installed: a workspace whose install failed installs again.
      if (this.hasWorkspace() && this.file.installed) return this.state();
      this.setStep('checking');
      this.missing = await this.tools();
      if (this.missing) this.fail(this.missing);
      if (!this.hasWorkspace()) {
        // Never a folder Sable did not make: files of the person's there stay, and setup stops.
        if (existsSync(this.workspace)) {
          let kept = true;
          try {
            kept = !statSync(this.workspace).isDirectory() || readdirSync(this.workspace).length > 0;
            if (!kept) rmdirSync(this.workspace);
          } catch {
            kept = true;
          }
          if (kept) this.fail(`${this.workspace} already has files in it. Sable leaves them alone: move them out to set up your build.`);
        }
        this.setStep('cloning');
        const tag = `v${this.version}`;
        mkdirSync(this.dir, { recursive: true });
        // Cloned beside it, in a folder of Sable's own, and moved into place only once it is whole.
        const fresh = `${this.workspace}.new-${randomBytes(4).toString('hex')}`;
        const drop = () => rmSync(fresh, { recursive: true, force: true });
        const r = await this.run('git', ['clone', '--filter=blob:none', '--branch', tag, REPO_URL, fresh], { cwd: this.dir, timeoutMs: 900_000 });
        if (r.code !== 0) {
          drop();
          this.fail(`Cloning failed: ${lastLine(r)}`);
        }
        const branch = await this.run('git', ['checkout', '-b', 'mine'], { cwd: fresh });
        if (branch.code !== 0) {
          drop();
          this.fail(`Making the branch failed: ${lastLine(branch)}`);
        }
        try {
          renameSync(fresh, this.workspace);
        } catch (err) {
          drop();
          this.fail(`Setting up failed: ${(err as Error).message}`);
        }
        this.saveBuild({ base: tag, installed: undefined });
      }
      await this.install();
      this.saveBuild({ installed: true });
      this.watchSource();
      return this.state();
    });
  }

  private async buildNow() {
    this.setStep('building');
    const r = await this.run('pnpm', ['exec', 'vite', 'build'], { cwd: this.workspace, timeoutMs: 900_000 });
    if (r.code !== 0 || !existsSync(this.distIndex())) this.fail(`The build failed: ${lastLine(r)}`);
    this.saveBuild({ builtFor: this.version, builtAt: this.now() });
  }

  /** Switches the finished build on: only the `index.html` there now is served (the person's click). */
  private switchOn() {
    const index = this.indexHash();
    if (!index) this.fail('There is no build to use yet.');
    if (this.file.builtFor !== this.version) this.fail(`Your build was made for ${this.file.builtFor ?? 'another version'}. Bring it to ${this.version} first.`);
    this.saveBuild({ active: true, index, failed: undefined });
  }

  /** Builds the workspace; with `use`, switches to it (the window reloads into it). */
  build(use = false): Promise<CustomState> {
    if (!this.buildOn) return Promise.reject(new Error(BUILD_OFF));
    return this.exclusive(async () => {
      if (!this.hasWorkspace()) this.fail('Set up your build first.');
      await this.buildNow();
      if (use) {
        this.switchOn();
        this.switched();
      }
      return this.state();
    });
  }

  /** The person's switch for a finished build. */
  use(on: boolean): CustomState {
    this.offered();
    if (on) this.switchOn();
    else this.saveBuild({ active: false });
    this.switched();
    return this.state();
  }

  /** "Use Sable's own look": the styles and the build both off. */
  original(set: (patch: Partial<AppSettings>) => void): CustomState {
    if (this.stylesOn()) set({ customStyles: false });
    if (this.file.active) {
      this.saveBuild({ active: false });
      this.switched();
    }
    this.rev++;
    this.changed();
    return this.state();
  }

  /**
   * Brings the person's changes to the running version: their uncommitted edits are committed on
   * `mine`, the new tag is fetched, `mine` is rebased onto it (a conflict is aborted, and its files
   * go to the Customize chat), installed again when the lockfile changed, built and switched on.
   */
  bring(): Promise<CustomState & { conflict?: string[] }> {
    if (!this.buildOn) return Promise.reject(new Error(BUILD_OFF));
    return this.exclusive(async () => {
      if (!this.hasWorkspace()) this.fail('Set up your build first.');
      const tag = `v${this.version}`;
      this.setStep('rebasing');
      const status = await this.git(['status', '--porcelain'], 'Reading the workspace failed');
      if (status.stdout.trim()) {
        await this.git(['add', '-A'], 'Keeping your changes failed');
        await this.git(['-c', 'user.name=Sable', '-c', 'user.email=sable@localhost', 'commit', '-m', 'My changes'], 'Keeping your changes failed');
      }
      await this.git(['fetch', '--filter=blob:none', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], `Fetching ${this.version} failed`);
      const lock = async () => (await this.run('git', ['rev-parse', 'HEAD:pnpm-lock.yaml'], { cwd: this.workspace })).stdout.trim();
      const lockBefore = await lock();
      const base = this.file.base ?? `v${this.file.builtFor ?? this.version}`;
      const r = await this.run('git', ['-c', 'user.name=Sable', '-c', 'user.email=sable@localhost', 'rebase', '--onto', tag, base, 'mine'], { cwd: this.workspace, timeoutMs: 300_000 });
      if (r.code !== 0) {
        const files = (await this.run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: this.workspace })).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        await this.run('git', ['rebase', '--abort'], { cwd: this.workspace });
        if (!files.length) this.fail(`Rebasing failed: ${lastLine(r)}`);
        this.error = `Your changes conflict with ${this.version} in ${files.length === 1 ? 'one file' : `${files.length} files`}.`;
        await this.opts.tell?.(conflictMessage(this.version, base.replace(/^v/, ''), files)).catch(() => {});
        return { ...this.state(), conflict: files };
      }
      this.saveBuild({ base: tag });
      if ((await lock()) !== lockBefore) await this.install();
      await this.buildNow();
      this.switchOn();
      this.switched();
      return this.state();
    });
  }

  dispose() {
    clearTimeout(this.stylesTimer);
    clearTimeout(this.sourceTimer);
    this.clearWatchdog();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

/** Every `.css` file under `dir`, as paths relative to it (node_modules and build output left out). */
function cssFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist' && !e.name.startsWith('.')) out.push(...cssFiles(dir, r));
    } else if (e.name.endsWith('.css')) out.push(r);
  }
  return out.sort();
}

/** The message a conflicting rebase leaves for the agent in the Customize chat. */
export function conflictMessage(version: string, from: string, files: string[]): string {
  return `Bring my changes to ${version}: they were made for ${from}, and rebasing them onto v${version} conflicts in ${files.map((f) => `\`${f}\``).join(', ')}. The rebase was aborted, so the workspace is as it was. Rebase the branch mine onto v${version} in src, resolve the conflicts keeping what my changes meant, and tell me when it is ready to build.`;
}

/**
 * The Customize chat's brief, appended to its agent's system prompt (Claude Code's appended prompt,
 * Codex's developer instructions). Short: it is paid for on every turn of that chat.
 */
export function customBrief(p: { dir: string; reference: string; workspace?: string; version: string; build?: boolean }): string {
  const f = (s: string) => s.replace(/\\/g, '/');
  const dir = f(p.dir);
  const ref = f(p.reference);
  const build = p.build ?? BUILD_SHIPS;
  return [
    '<customize_sable>',
    `This is Sable's Customize chat. Sable (version ${p.version}) is the desktop app the person is using to talk to you: an Electron and React interface for Claude Code and Codex. Here they ask you to change how Sable looks.`,
    `Reference: ${ref}/CLAUDE.md (architecture and design language) and ${ref}/styles/ (every stylesheet of the app, by source path; tokens in styles/styles/tokens.css). Read the rules you override before you write; use only classes, data attributes and tokens you found there.`,
    `Write plain CSS to ${dir}/styles.css. Sable loads it after its own styles and applies every save within a moment, with no reload, and it survives updates. Override tokens on :root and the app's classes; raise specificity where a rule does not win.`,
    !build
      ? 'When CSS cannot do it (behaviour, new controls), say so plainly: here Sable changes by its stylesheet only.'
      : p.workspace
        ? `Only when CSS cannot do it (behaviour, new controls), change the interface's source in ${f(p.workspace)} (Sable's repository at its version, branch mine; the interface only: src/, no new dependencies). The person then builds and switches to it themselves; never build, switch or edit anything that would switch it on.`
        : 'When CSS cannot do it (behaviour, new controls), say so: it needs their own build of the interface, which they set up in Settings, Customize.',
    `Rules: write only inside ${dir}; never touch the installed app or Sable's other data; nothing from the internet in the stylesheet (a remote url(), an @import, or an address it cannot tell keeps the whole sheet from loading; images as data: URIs); keep the file readable, one commented section per area, edited in place; after each change say in one sentence what changed.`,
    '</customize_sable>',
  ].join('\n');
}

// ─────────────────────────────── on the app ───────────────────────────────

const customizers = new WeakMap<App, Customizer>();
/** Set by the server before the bridge is built (the desktop shell's choices). */
let nextOptions: Partial<CustomOptions> = {};

/** The options the next app's customizer is made with (the server: `--original`, serving, the reference). */
export function customOptions(opts: Partial<CustomOptions>) {
  nextOptions = opts;
}

/** The app's customizer (one per app). */
export function customOf(app: App): Customizer {
  let c = customizers.get(app);
  if (!c) {
    const extra = nextOptions;
    c = new Customizer({
      home: app.store.dir,
      settings: () => app.store.state.settings,
      emit: (state) => app.emit({ type: 'custom.updated', state }),
      log: app.log,
      tell: (text) => app.call('custom.open', { text }),
      watch: !process.env.VITEST,
      ...extra,
    });
    customizers.set(app, c);
    app.onDispose(() => c!.dispose());
  }
  return c;
}

/** The agents whose Customize chat gets the brief (`customBrief`: Claude Code's appended prompt, Codex's developer instructions). */
const BRIEFED: readonly ProviderId[] = ['claude', 'codex'];
export const CUSTOM_AGENT_ONLY = 'The Customize chat runs with Claude Code or Codex.';

/**
 * Whether the Customize chat may run with `provider`: one that gets its brief. The scripted Demo agent
 * too (development and tests only, and only when named): it writes nothing.
 */
export function customAgent(provider: ProviderId): boolean {
  return BRIEFED.includes(provider) || provider === 'demo';
}

/** The Customize chat: the newest kept one with an agent that gets its brief, if any. */
function customChat(app: App): SessionMeta | undefined {
  let best: SessionMeta | undefined;
  for (const rt of app.sessions.values()) {
    const m = rt.meta;
    if (m.custom && customAgent(m.provider) && !m.archived && (!best || m.createdAt > best.createdAt)) best = m;
  }
  return best;
}

// ─────────────────────────────── what a phone may not do ───────────────────────────────

/** A folder as the file system has it (links and junctions followed as far as it exists), compared case-blind where the disk is. */
function canonical(p: string): string {
  let at = path.resolve(p);
  let rest = '';
  for (;;) {
    try {
      at = path.join(realpathSync.native(at), rest);
      break;
    } catch {
      const up = path.dirname(at);
      if (up === at) break;
      rest = path.join(path.basename(at), rest);
      at = up;
    }
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? at.toLowerCase() : at;
}

/** `p` is `dir` or inside it. */
export function within(p: string, dir: string): boolean {
  const a = canonical(p);
  const b = canonical(dir);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * What a phone may still do with a chat that can write the person's stylesheet (the Customize chat, or
 * any chat in `<data>/custom`): read it and stop it, never send, steer, answer or change how it works.
 * Allowed by name, so a method added later is refused there until it is listed.
 */
const PHONE_CUSTOM_READS = new Set([
  'session.snapshot',
  'session.interrupt',
  'session.update',
  'phone.tail',
  'phone.item',
  'phone.queue',
  'phone.prompts',
  'phone.changes',
  'phone.diff',
  'phone.image',
  'phone.thumb',
  'phone.fileLink',
  'phone.fileStart',
  'phone.fileChunk',
  'phone.fileEnd',
  'turn.checkStop',
]);

export const PHONE_CUSTOM_REFUSED = 'The Customize chat is answered on the computer.';
export const PHONE_DATA_REFUSED = "A chat from the phone cannot start in Sable's own folder.";

/**
 * Why a phone's request is refused because of Customize Sable, or undefined. The phone's allowlist keeps
 * `custom.*` out; this keeps the stylesheet out of reach through a chat: a phone may not start a chat
 * anywhere in Sable's data folder, and may only read and stop a chat that can write
 * `<data>/custom`.
 */
export function phoneRefusal(app: App, method: string, params: Record<string, unknown>): string | undefined {
  const data = app.store.dir;
  if (method === 'session.create') {
    const chat = params.chat !== undefined && params.chat !== null;
    const cwd = chat ? app.chatsRoot() : typeof params.cwd === 'string' ? params.cwd : '';
    if (cwd && within(cwd, data)) return PHONE_DATA_REFUSED;
    return undefined;
  }
  const id = params.sessionId;
  if (typeof id !== 'string' || PHONE_CUSTOM_READS.has(method)) return undefined;
  const meta = app.sessions.get(id)?.meta;
  if (!meta) return undefined;
  if (meta.custom || within(meta.cwd, customOf(app).dir)) return PHONE_CUSTOM_REFUSED;
  return undefined;
}

export function registerCustom(app: App) {
  const c = customOf(app);
  c.sessionId = customChat(app)?.id;
  let styles = app.store.state.settings.customStyles;
  app.subscribe((e) => {
    if (e.type === 'settings.updated' && e.settings.customStyles !== styles) {
      styles = e.settings.customStyles;
      c.settingsChanged();
    } else if (e.type === 'session.removed' && e.id === c.sessionId) {
      c.sessionId = customChat(app)?.id;
      c.settingsChanged();
    }
  });
  app.register('custom.state', () => c.state());
  app.register('custom.ready', () => ({ ok: c.ready() }));
  app.register('custom.original', () => c.original((patch) => void app.call('app.setSettings', { patch })));
  app.register('custom.open', async ({ text, provider }) => {
    c.syncReference();
    let meta = customChat(app);
    let snap: SessionSnapshot;
    if (meta) snap = await app.call('session.snapshot', { sessionId: meta.id });
    else {
      const settings = app.store.state.settings;
      // Only an agent that gets the brief: the one asked for, else the default when it is one, else the first there is.
      if (provider && (!customAgent(provider) || !app.providers.has(provider))) throw new Error(CUSTOM_AGENT_ONLY);
      const pick = provider ?? [settings.defaultProvider, ...BRIEFED].find((p): p is ProviderId => BRIEFED.includes(p) && app.providers.has(p));
      if (!pick) throw new Error(CUSTOM_AGENT_ONLY);
      mkdirSync(c.dir, { recursive: true });
      snap = await app.startSession({ provider: pick, cwd: c.dir, title: 'Customize Sable' }, { custom: true });
      meta = snap.session;
    }
    c.sessionId = meta.id;
    c.settingsChanged();
    if (text?.trim()) await app.call('session.send', { sessionId: meta.id, text: text.trim() });
    return snap;
  });
  app.register('custom.setup', () => c.setup());
  app.register('custom.build', ({ use }) => c.build(!!use));
  app.register('custom.use', ({ on }) => c.use(!!on));
  app.register('custom.bring', () => c.bring());
}
