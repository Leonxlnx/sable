import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runOff } from './web-run';
import type { WebTailscale } from '../../shared/protocol';

/**
 * Web access over Tailscale (the owner's iPad away from home), without a certificate of Sable's: the
 * desktop serves the web client on a loopback port as plain HTTP and asks the Tailscale client to publish
 * it inside the tailnet with `tailscale serve` (never `funnel`), so the tablet opens
 * `https://<machine>.<tailnet>.ts.net/` under Tailscale's own valid certificate, and nobody outside the
 * tailnet reaches it. Every call to the CLI goes through this module (`TailscaleCli`; tests put a fake in
 * its place, and no test calls the real CLI with a command that changes anything).
 *
 * The publication is a FOREGROUND serve (`serve --yes --https=<port> <target>`, never `--bg`): Tailscale
 * keeps what a foreground serve publishes under that CLI process's own session (`Foreground` by session
 * in `serve status --json`) and drops it the moment the process ends. Sable holds that process as its
 * child, so the publication lives exactly as long as Sable holds it:
 *
 * - Nothing is ever left behind. A lasting (`--bg`) entry outlived a crash, a quit whose withdrawal was
 *   slow, and a restart of the computer, and went on sending the tablet to a loopback port Sable no longer
 *   held: any program on this computer could take that port and answer under Sable's address, with script
 *   that reads the tablet's stored pairing. On Windows every child of the process is in a job that ends
 *   with it (libuv's), so even a killed Sable takes its serve with it. Elsewhere a killed parent leaves
 *   its children running, so this mode is offered on Windows only (`tailscalePath`).
 * - Sable never removes or changes an entry. It starts its own serve only on a port 443 nothing uses and
 *   ends only its own process; an entry that merely looks like Sable's is the owner's. No record on disk
 *   says what is Sable's (one could be stale or written by someone else): the process it holds does.
 * - The loopback port is let go only after Tailscale no longer lists the publication (`withdraw` resolves
 *   then; web-remote.ts keeps the listener bound and refusing until it does).
 *
 * The CLI of Tailscale 1.104 (read from its `serve --help` here): `serve status --json` reads the serve
 * configuration (`{}` when there is none; else `TCP` by port, `Web` by `<name>:<port>` with `Handlers` by
 * mount path, `AllowFunnel`, `Foreground` by session, each a configuration of the same shape).
 */

/** The port the tablet opens on the tailnet: `https://<name>/`. */
export const TS_PORT = 443;
/** The loopback listener's first port (up to ten above when taken). */
export const TS_LOCAL_PORT = 47841;

/** A CLI process Sable keeps running (the foreground serve). */
export interface TailscaleHeld {
  /** Resolves once the process has gone, by itself or by `stop`, with the end of what it printed. Never rejects. */
  gone: Promise<string>;
  /** Ends the process; resolves once it has gone. */
  stop(): Promise<void>;
}

export interface TailscaleCli {
  /** The installed CLI's absolute path, or undefined when Tailscale is not installed (looked up at each call). */
  file(): string | undefined;
  /** Its standard output; rejects on a non-zero exit, after 10 s, or past 1 MB of output. */
  run(args: string[]): Promise<string>;
  /** Starts the CLI and keeps it running until `stop` (or its own end). */
  hold(args: string[]): TailscaleHeld;
  /**
   * Which run of Tailscale's own service this is (its process id while it runs, `down` while it does not),
   * or undefined when that cannot be read. Never the CLI: Windows is asked about the service.
   */
  daemon(): Promise<string | undefined>;
}

/**
 * `sc queryex Tailscale` read: the service's process id while it runs. A serve that ended while this stayed
 * the same was removed by someone (the owner's `serve reset`); one that ended because this changed went
 * with a restart of Tailscale (an update of it), and only that one is published again without the person.
 */
export function daemonOf(out: string): string | undefined {
  const state = /^\s*\S+\s*:\s*(\d)\s+[A-Z_]+\s*$/m.exec(out)?.[1];
  if (!state) return undefined;
  const pid = /^\s*PID\s*:\s*(\d+)\s*$/m.exec(out)?.[1];
  if (state !== '4') return 'down';
  return pid && pid !== '0' ? 'pid ' + pid : undefined;
}

const exists = (file: string) => { try { return existsSync(file); } catch { return false; } };

/**
 * Where the CLI is installed: Tailscale's own install folder under Program Files, and nowhere else. PATH
 * is never searched: an entry of it can lie inside a project (a repository's own `bin` folder holding a
 * `tailscale.exe`), and whatever is found here is started as the person. Windows only: see the header.
 */
export function tailscalePath(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isProgram?: (f: string) => boolean } = {}): string | undefined {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const isProgram = o.isProgram ?? exists;
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Checks of the packaged app off-screen only (with SABLE_WEB_LOOPBACK=1, as the chain mode's): a fake
  // CLI by its absolute path, so no check ever reaches the machine's real Tailscale.
  if (env.SABLE_WEB_LOOPBACK === '1' && env.SABLE_TAILSCALE_CLI !== undefined) return p.isAbsolute(env.SABLE_TAILSCALE_CLI) && isProgram(env.SABLE_TAILSCALE_CLI) ? env.SABLE_TAILSCALE_CLI : undefined;
  if (platform !== 'win32') return undefined;
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter((r): r is string => !!r && p.isAbsolute(r));
  return roots.map(r => p.join(r, 'Tailscale', 'tailscale.exe')).find(isProgram);
}

/** The process itself: no shell, no window, its output read (the end of it kept for the log) so a pipe never fills. */
function holdProcess(file: string, args: string[]): TailscaleHeld {
  let said = '', ended = false, end!: (said: string) => void;
  const gone = new Promise<string>(resolve => { end = resolve; });
  const done = () => { if (!ended) { ended = true; end(said.trim()); } };
  const keep = (b: Buffer) => { said = (said + b.toString('utf8')).slice(-600); };
  try {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', err => { said += String(err.message); done(); });
    child.once('exit', done);
    return { gone, stop: () => { if (!ended) { try { child.kill(); } catch { /* gone already */ } } return gone.then(() => {}); } };
  } catch (err) {
    said = String((err as Error).message);
    done();
    return { gone, stop: () => Promise.resolve() };
  }
}

/** The real CLI: short commands from a worker thread (a process start holds the thread it starts from: web-run.ts). */
export function realCli(find: () => string | undefined = tailscalePath): TailscaleCli {
  return {
    file: find,
    async run(args) {
      const file = find();
      if (!file) throw Error('Tailscale is not installed.');
      return (await runOff(file, args, process.env, { timeout: 10_000, maxBuffer: 1 << 20 })).toString('utf8');
    },
    hold(args) {
      const file = find();
      if (!file) return { gone: Promise.resolve('Tailscale is not installed.'), stop: () => Promise.resolve() };
      return holdProcess(file, args);
    },
    async daemon() {
      // Windows' own service control program by its absolute path (never PATH), read-only.
      const root = process.env.SystemRoot ?? process.env.windir;
      if (process.platform !== 'win32' || !root || !path.win32.isAbsolute(root)) return undefined;
      try {
        return daemonOf((await runOff(path.win32.join(root, 'System32', 'sc.exe'), ['queryex', 'Tailscale'], process.env, { timeout: 5000, maxBuffer: 1 << 16 })).toString('latin1'));
      } catch { return undefined; }
    },
  };
}

/** What `tailscale status --json` says about this computer. */
export type TailscaleLook =
  | { kind: 'stopped'; text: string }
  | { kind: 'https'; name: string }
  | { kind: 'ready'; name: string; login?: string }
  | { kind: 'unreadable'; text: string };

/** A MagicDNS name, the only kind Tailscale issues HTTPS certificates for. */
const TS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

export const TS_WORDS = {
  missing: 'Tailscale is not installed on this computer. Install it from tailscale.com and sign in.',
  platform: 'Web access over Tailscale works on Windows only for now.',
  stopped: 'Tailscale is not running on this computer. Start it and sign in.',
  login: 'Tailscale is not signed in on this computer. Sign in to your tailnet.',
  noName: 'This computer has no Tailscale name. Turn on MagicDNS in the Tailscale admin console (DNS).',
  https: 'HTTPS is off for your tailnet. In the Tailscale admin console, open DNS and enable HTTPS Certificates.',
  taken: 'Port 443 of this computer’s Tailscale name is already used by your own Tailscale Serve setup. Sable leaves it alone.',
  gone: 'Tailscale Serve no longer points at Sable (its setup was changed outside Sable). Turn web access off and on to publish it again.',
  lost: 'Tailscale restarted and stopped publishing Sable. Sable publishes it again within a minute.',
  unreadable: 'Could not read Tailscale’s state. Sable tries again in a minute.',
  failed: 'Tailscale did not publish Sable. Sable tries again in a minute.',
} as const;

/** Why there is no CLI to use: not installed, or a system this mode is not offered on. */
export const missingWords = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? TS_WORDS.missing : TS_WORDS.platform);

export function readTailscale(raw: string): TailscaleLook {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { return { kind: 'unreadable', text: TS_WORDS.unreadable }; }
  if (!j || typeof j !== 'object') return { kind: 'unreadable', text: TS_WORDS.unreadable };
  const backend = j.BackendState;
  if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth') return { kind: 'stopped', text: TS_WORDS.login };
  if (backend !== 'Running') return { kind: 'stopped', text: TS_WORDS.stopped };
  const self = (j.Self ?? {}) as Record<string, unknown>;
  const name = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  if (!TS_NAME.test(name)) return { kind: 'stopped', text: TS_WORDS.noName };
  const certs = Array.isArray(j.CertDomains) ? j.CertDomains.filter((d): d is string => typeof d === 'string').map(d => d.replace(/\.$/, '').toLowerCase()) : [];
  if (!certs.includes(name)) return { kind: 'https', name };
  const users = (j.User ?? {}) as Record<string, { LoginName?: unknown }>;
  const login = users[String(self.UserID)]?.LoginName;
  // A tagged computer has no person's login: then any person's device in the tailnet may open the page
  // (pairing still needs the desktop's Allow).
  return { kind: 'ready', name, ...(typeof login === 'string' && login && login !== 'tagged-devices' ? { login } : {}) };
}

interface ServeShape {
  TCP?: Record<string, Record<string, unknown> | undefined>;
  Web?: Record<string, { Handlers?: Record<string, Record<string, unknown> | undefined> } | undefined>;
  AllowFunnel?: Record<string, unknown>;
  Foreground?: Record<string, unknown>;
}
const plain = (s: unknown) => (typeof s === 'string' ? s.replace(/\/+$/, '') : undefined);
function serveConfig(raw: string): ServeShape | undefined {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return undefined; }
  // No configuration at all prints `{}` (1.104 here); `null` is the same answer from a CLI that prints it so.
  if (j === null) return {};
  return typeof j === 'object' && !Array.isArray(j) ? j as ServeShape : undefined;
}

/**
 * Who holds `port` on this computer in the serve configuration `raw`: nobody; a serve of the shape Sable
 * starts (`ours`: nothing lasting on the port, and exactly one foreground session on it whose one handler
 * at `/` proxies to `target`, an HTTPS port, never funnelled); or the owner (anything else, also an answer
 * that cannot be read: then nothing is done). `ours` says the shape only: whether it is this run's own is
 * known by the process this run holds (`TailscaleServe`).
 */
export function serveHolds(raw: string, name: string, port: number, target: string): 'free' | 'ours' | 'taken' {
  const j = serveConfig(raw);
  if (!j) return 'taken';
  const key = String(port), suffix = ':' + key;
  const used = (c: unknown) => {
    const cfg = (c ?? {}) as ServeShape;
    return !!cfg.TCP?.[key] || Object.keys(cfg.Web ?? {}).some(k => k.endsWith(suffix)) || Object.keys(cfg.AllowFunnel ?? {}).some(k => k.endsWith(suffix));
  };
  const sessions = Object.values(j.Foreground ?? {}).filter(used) as ServeShape[];
  // A lasting entry on the port is never Sable's: Sable makes none.
  if (used(j)) return 'taken';
  if (!sessions.length) return 'free';
  if (sessions.length !== 1) return 'taken';
  const s = sessions[0];
  const tcp = s.TCP?.[key];
  const webKeys = Object.keys(s.Web ?? {}).filter(k => k.endsWith(suffix));
  const handlers = s.Web?.[name + suffix]?.Handlers ?? {};
  const mounts = Object.keys(handlers);
  const at = handlers['/'] ?? {};
  const funnel = Object.entries(s.AllowFunnel ?? {}).some(([k, v]) => k.endsWith(suffix) && v);
  const ours = !!tcp && tcp.HTTPS === true && !tcp.TCPForward && !tcp.TerminateTLS && webKeys.length === 1 && webKeys[0] === name + suffix &&
    mounts.length === 1 && mounts[0] === '/' && plain(at.Proxy) === plain(target) && Object.keys(at).length === 1 && !funnel;
  return ours ? 'ours' : 'taken';
}

/**
 * Some foreground session in `raw` still sends requests to `target` (on any port, under any name): what a
 * withdrawal waits out before the loopback port is let go. An answer that cannot be read throws: not known.
 */
export function sessionProxies(raw: string, target: string): boolean {
  const j = serveConfig(raw);
  if (!j) throw Error('Tailscale’s serve status could not be read.');
  const want = plain(target);
  return Object.values(j.Foreground ?? {}).some(s => Object.values((s as ServeShape | null)?.Web ?? {}).some(w =>
    Object.values(w?.Handlers ?? {}).some(h => plain(h?.Proxy) === want)));
}

/**
 * How long a new serve may take to show in the status, the pause between two looks, the looks a withdrawal
 * takes; after a serve ended by itself, how long until Tailscale's service is asked a second time whether
 * it restarted; and for web-remote.ts: how long until a withdrawal that was not seen through is tried
 * again, and until a serve that went with a restart of Tailscale is published again.
 */
export const TS_TIMES = { settle: 8000, step: 250, confirm: 8, recheck: 3000, retry: 30_000, republish: 5000 };
export type TailscaleTimes = typeof TS_TIMES;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The serve this run holds, and which run of Tailscale's service it was started under. */
interface Holding { name: string; target: string; proc: TailscaleHeld; ended: boolean; live: boolean; daemon?: string }

/** Publishing and withdrawing, one command at a time. */
export class TailscaleServe {
  private queue: Promise<unknown> = Promise.resolve();
  private held?: Holding;
  readonly times: TailscaleTimes;
  /** Commands run (tests and the cost at rest). */
  runs: string[][] = [];
  /**
   * The serve this run published ended by itself: told once, with whether Tailscale's own service
   * restarted meanwhile (`restarted`). Without that it was removed while Tailscale kept running (the
   * owner's `serve reset`, its process ended by hand), which Sable never undoes by itself.
   */
  onLost?: (target: string, restarted: boolean) => void;
  /** A serve ended by itself and why is still being looked at (`onLost` follows). */
  deciding = false;

  constructor(readonly cli: TailscaleCli, times: Partial<TailscaleTimes> = {}) {
    this.times = { ...TS_TIMES, ...times };
  }

  /** Installed at all (no process: a look at the install folder). */
  installed(): boolean { return !!this.cli.file(); }

  private run(args: string[]) {
    this.runs.push(args);
    return this.cli.run(args);
  }

  private status() { return this.run(['serve', 'status', '--json']); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** One look at this computer's Tailscale (`status --json`). */
  async look(): Promise<TailscaleLook | { kind: 'missing'; text: string }> {
    if (!this.installed()) return { kind: 'missing', text: missingWords() };
    try { return readTailscale(await this.run(['status', '--json'])); }
    catch { return { kind: 'unreadable', text: TS_WORDS.unreadable }; }
  }

  /**
   * Whether port 443 is this run's now for `target` (one `serve status --json`): `ours` only while the
   * process this run started for exactly that still lives.
   */
  async holds(name: string, target: string) {
    const seen = serveHolds(await this.status(), name, TS_PORT, target);
    const mine = !!this.held && !this.held.ended && this.held.name === name && this.held.target === target;
    return seen === 'ours' && !mine ? 'taken' : seen;
  }

  /**
   * Publishes `target` (the loopback listener) at `https://<name>/` for as long as this run holds the
   * serve: refused (`taken`) unless port 443 holds nothing at all; nothing run when this run publishes
   * exactly that already. The entry is looked for until it shows; a serve that ends, shows something else
   * or does not show in time is ended and this throws.
   */
  publish(name: string, target: string): Promise<'published' | 'taken'> {
    return this.serial(async () => {
      const old = this.held;
      if (old && !old.ended && old.name === name && old.target === target && serveHolds(await this.status(), name, TS_PORT, target) === 'ours') return 'published';
      // This run's earlier serve (another loopback port, another name) goes first; not confirmed gone: throws.
      await this.end();
      if (serveHolds(await this.status(), name, TS_PORT, target) !== 'free') return 'taken';
      const daemon = await this.cli.daemon().catch(() => undefined);
      const args = ['serve', '--yes', `--https=${TS_PORT}`, target];
      this.runs.push(args);
      const held: Holding = { name, target, proc: this.cli.hold(args), ended: false, live: false, daemon };
      this.held = held;
      let said = '';
      void held.proc.gone.then(async s => {
        held.ended = true;
        said = s;
        if (!held.live) return;
        held.live = false;
        this.deciding = true;
        let restarted = false;
        try { restarted = await this.restarted(held.daemon); } finally { this.deciding = false; }
        this.onLost?.(held.target, restarted);
      });
      const until = Date.now() + this.times.settle;
      let seen: 'free' | 'ours' | 'taken' = 'free';
      while (!held.ended) {
        await Promise.race([held.proc.gone, sleep(this.times.step)]);
        if (held.ended) break;
        // A status that cannot be run is looked at again until the time is up.
        try { seen = serveHolds(await this.status(), name, TS_PORT, target); } catch { seen = 'free'; }
        if (seen !== 'free' || Date.now() >= until) break;
      }
      if (seen === 'ours' && !held.ended) { held.live = true; return 'published'; }
      const why = held.ended ? 'the serve ended' : seen === 'taken' ? 'port 443 shows something else' : 'the serve did not show in time';
      await this.end().catch(() => {});
      throw Error(why + (said ? ': ' + said.slice(-300) : ''));
    });
  }

  /**
   * Whether Tailscale's service is another run than `was` (or down): asked at once and once more a moment
   * later, since a service on its way down may still answer as before. Not known then or now: no.
   */
  private async restarted(was: string | undefined): Promise<boolean> {
    if (was === undefined) return false;
    for (const wait of [0, this.times.recheck]) {
      if (wait) await sleep(wait);
      const now = await this.cli.daemon().catch(() => undefined);
      if (now !== undefined && now !== was) return true;
    }
    return false;
  }

  /**
   * Ends this run's serve and looks until no session of Tailscale's sends requests to its target. Throws
   * while that is not known (Tailscale's status cannot be read, or still lists it): the serve's process is
   * gone all the same, and the next call looks again.
   */
  private async end() {
    const held = this.held;
    if (!held) return;
    held.live = false;
    await held.proc.stop();
    let last: unknown;
    for (let i = 0; i < this.times.confirm; i++) {
      if (i) await sleep(this.times.step);
      try {
        if (!sessionProxies(await this.status(), held.target)) {
          if (this.held === held) this.held = undefined;
          return;
        }
        last = Error('Tailscale still lists the serve.');
      } catch (err) { last = err; }
    }
    throw last;
  }

  /** Withdraws what this run published; resolves once Tailscale no longer lists it (see `end`). */
  withdraw(): Promise<void> {
    return this.serial(() => this.end());
  }

  /** The loopback target of a serve this run started and has not seen gone (no process). */
  owes(): string | undefined { return this.held?.target; }

  /** Quitting: the serve's process is ended without waiting (what it published goes with it). */
  drop() {
    const held = this.held;
    if (!held) return;
    held.live = false;
    void held.proc.stop();
  }
}

/** Settings' view of a look (`WebState.tailscale`). */
export function tailscaleView(look: Awaited<ReturnType<TailscaleServe['look']>> | undefined, installed: boolean): WebTailscale {
  if (!installed) return { state: 'missing', text: missingWords() };
  if (!look) return { state: 'unknown' };
  switch (look.kind) {
    case 'missing': return { state: 'missing', text: look.text };
    case 'stopped': return { state: 'stopped', text: look.text };
    case 'https': return { state: 'https', name: look.name, text: TS_WORDS.https };
    case 'ready': return { state: 'ready', name: look.name };
    default: return { state: 'unknown', text: look.text };
  }
}

/** The tailnet address a request came from (`X-Forwarded-For`, set by Tailscale's proxy): shown on the Allow card. */
export function tailnetPeer(value: string | string[] | undefined): string | undefined {
  const v = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim() ?? '';
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (m && +m[1] >= 64 && +m[1] <= 127 && +m[2] <= 255 && +m[3] <= 255) return v;
  if (/^fd7a:115c:a1e0:[0-9a-f:]+$/i.test(v)) return v.toLowerCase();
  return undefined;
}
