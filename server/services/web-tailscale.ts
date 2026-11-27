import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findProgram } from '../util/which';
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
 * The CLI of Tailscale 1.104 (read from its `serve --help` here): `serve status --json` reads the serve
 * configuration (`{}` when there is none; else `TCP` by port, `Web` by `<name>:<port>` with `Handlers` by
 * mount path, `AllowFunnel`, `Foreground` by session), `serve --bg --yes --https=<port> <target>` adds a
 * handler at `/` that proxies to the target and keeps it after the command ends, and
 * `serve --https=<port> off` removes the handler at `/` of that port (and the port once it has none).
 * Sable publishes on port 443 only when nothing is configured on it, records what it published
 * (`<home>/web/tailscale.json`, before the command runs), and withdraws exactly that: only when the port
 * still holds nothing but Sable's own handler with Sable's own target. A port that holds anything else
 * is the owner's: Sable says so and touches nothing.
 */

/** The port the tablet opens on the tailnet: `https://<name>/`. */
export const TS_PORT = 443;
/** The loopback listener's first port (up to ten above when taken). */
export const TS_LOCAL_PORT = 47841;

export interface TailscaleCli {
  /** The installed CLI's absolute path, or undefined when Tailscale is not installed (looked up at each call). */
  file(): string | undefined;
  /** Its standard output; rejects on a non-zero exit, after 10 s, or past 1 MB of output. */
  run(args: string[]): Promise<string>;
}

const exists = (file: string) => { try { return existsSync(file); } catch { return false; } };

/**
 * Where the CLI is installed: Tailscale's own install folders first, then the absolute PATH entries
 * outside the folder Sable was started from (`findProgram`, never a bare name and never the current
 * folder: a project could otherwise put its own `tailscale.exe` in the way).
 */
export function tailscalePath(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; isProgram?: (f: string) => boolean } = {}): string | undefined {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const isProgram = o.isProgram ?? exists;
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Checks of the packaged app off-screen only (with SABLE_WEB_LOOPBACK=1, as the chain mode's): a fake
  // CLI by its absolute path, so no check ever reaches the machine's real Tailscale.
  if (env.SABLE_WEB_LOOPBACK === '1' && env.SABLE_TAILSCALE_CLI !== undefined) return p.isAbsolute(env.SABLE_TAILSCALE_CLI) && isProgram(env.SABLE_TAILSCALE_CLI) ? env.SABLE_TAILSCALE_CLI : undefined;
  const roots = platform === 'win32' ? [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter((r): r is string => !!r && p.isAbsolute(r)) : [];
  const known = platform === 'win32' ? roots.map(r => p.join(r, 'Tailscale', 'tailscale.exe'))
    : platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
    : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale'];
  const found = known.find(isProgram);
  if (found) return found;
  return findProgram('tailscale', { platform, env, outside: [process.cwd()], ...(o.isProgram ? { isProgram: o.isProgram, real: (f: string) => f } : {}) }) ?? undefined;
}

/** The real CLI, started from a worker thread (a process start holds the thread it starts from: web-run.ts). */
export function realCli(find: () => string | undefined = tailscalePath): TailscaleCli {
  return {
    file: find,
    async run(args) {
      const file = find();
      if (!file) throw Error('Tailscale is not installed.');
      return (await runOff(file, args, process.env, { timeout: 10_000, maxBuffer: 1 << 20 })).toString('utf8');
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
  stopped: 'Tailscale is not running on this computer. Start it and sign in.',
  login: 'Tailscale is not signed in on this computer. Sign in to your tailnet.',
  noName: 'This computer has no Tailscale name. Turn on MagicDNS in the Tailscale admin console (DNS).',
  https: 'HTTPS is off for your tailnet. In the Tailscale admin console, open DNS and enable HTTPS Certificates.',
  taken: 'Port 443 of this computer’s Tailscale name is already used by your own Tailscale Serve setup. Sable leaves it alone.',
  gone: 'Tailscale Serve no longer points at Sable (its setup was changed outside Sable). Turn web access off and on to publish it again.',
  unreadable: 'Could not read Tailscale’s state. Sable tries again in a minute.',
  failed: 'Tailscale did not publish Sable. Sable tries again in a minute.',
} as const;

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

/**
 * Who holds `port` on this computer in the serve configuration `raw`: nobody, Sable (exactly one handler
 * at `/` that proxies to `target`, an HTTPS port, never funnelled, nothing in the foreground), or the
 * owner (anything else, also an answer that cannot be read: then nothing is touched).
 */
export function serveHolds(raw: string, name: string, port: number, target: string): 'free' | 'ours' | 'taken' {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw); } catch { return 'taken'; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'taken';
  const key = String(port), suffix = ':' + key;
  const used = (c: unknown) => {
    const cfg = (c ?? {}) as { TCP?: Record<string, unknown>; Web?: Record<string, unknown>; AllowFunnel?: Record<string, unknown> };
    return !!cfg.TCP?.[key] || Object.keys(cfg.Web ?? {}).some(k => k.endsWith(suffix)) || Object.keys(cfg.AllowFunnel ?? {}).some(k => k.endsWith(suffix));
  };
  const foreground = Object.values((j.Foreground ?? {}) as Record<string, unknown>);
  if (!used(j) && !foreground.some(used)) return 'free';
  if (foreground.some(used)) return 'taken';
  const tcp = (j.TCP as Record<string, Record<string, unknown>> | undefined)?.[key];
  const webKeys = Object.keys((j.Web ?? {}) as object).filter(k => k.endsWith(suffix));
  const handlers = (j.Web as Record<string, { Handlers?: Record<string, Record<string, unknown>> }>)?.[name + suffix]?.Handlers ?? {};
  const mounts = Object.keys(handlers);
  const funnel = Object.entries((j.AllowFunnel ?? {}) as Record<string, unknown>).some(([k, v]) => k.endsWith(suffix) && v);
  const plain = (s: unknown) => typeof s === 'string' ? s.replace(/\/+$/, '') : undefined;
  const ours = !!tcp && tcp.HTTPS === true && !tcp.TCPForward && !tcp.TerminateTLS && webKeys.length === 1 && webKeys[0] === name + suffix &&
    mounts.length === 1 && mounts[0] === '/' && plain(handlers['/'].Proxy) === plain(target) && Object.keys(handlers['/']).length === 1 && !funnel;
  return ours ? 'ours' : 'taken';
}

/** What Sable published (written before the command runs, removed once it is withdrawn). */
interface Published { name: string; port: number; target: string }

function readRecord(file: string): Published | undefined {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return r && typeof r.name === 'string' && typeof r.target === 'string' && r.port === TS_PORT ? { name: r.name, port: r.port, target: r.target } : undefined;
  } catch { return undefined; }
}

/** Publishing and withdrawing, one command at a time. */
export class TailscaleServe {
  private queue: Promise<unknown> = Promise.resolve();
  /** Commands run (tests and the cost at rest). */
  runs: string[][] = [];

  constructor(readonly cli: TailscaleCli, private record: string) {}

  /** Installed at all (no process: a look at the install folders). */
  installed(): boolean { return !!this.cli.file(); }

  private run(args: string[]) {
    this.runs.push(args);
    return this.cli.run(args);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** One look at this computer's Tailscale (`status --json`). */
  async look(): Promise<TailscaleLook | { kind: 'missing'; text: string }> {
    if (!this.installed()) return { kind: 'missing', text: TS_WORDS.missing };
    try { return readTailscale(await this.run(['status', '--json'])); }
    catch { return { kind: 'unreadable', text: TS_WORDS.unreadable }; }
  }

  /** Who holds port 443 now for `target` (one `serve status --json`). */
  async holds(name: string, target: string) {
    return serveHolds(await this.run(['serve', 'status', '--json']), name, TS_PORT, target);
  }

  /**
   * Publishes `target` (the loopback listener) at `https://<name>/`: refused (`taken`) when port 443 holds
   * anything that is not exactly this; nothing run when it already is. Checked again after the command.
   */
  publish(name: string, target: string): Promise<'published' | 'taken'> {
    return this.serial(async () => {
      let raw = await this.run(['serve', 'status', '--json']);
      // Sable's own entry from a run that ended without withdrawing it (another loopback port): replaced.
      const rec = readRecord(this.record);
      if (rec && rec.target !== target && serveHolds(raw, rec.name, rec.port, rec.target) === 'ours') {
        await this.run(['serve', `--https=${rec.port}`, 'off']);
        this.forget();
        raw = await this.run(['serve', 'status', '--json']);
      }
      const before = serveHolds(raw, name, TS_PORT, target);
      if (before === 'taken') return 'taken';
      this.save({ name, port: TS_PORT, target });
      if (before === 'free') await this.run(['serve', '--bg', '--yes', `--https=${TS_PORT}`, target]);
      const after = await this.holds(name, target);
      // What is there now is not exactly Sable's: never withdrawn by Sable (it may be the owner's).
      if (after !== 'ours') { if (after === 'free') this.forget(); throw Error(TS_WORDS.failed); }
      return 'published';
    });
  }

  /**
   * Withdraws what Sable published (in this run or a run that ended without withdrawing it): only while
   * the port still holds exactly Sable's handler. Anything else there is left as it is, and the record
   * goes; a command that fails keeps the record for the next try. `target`: only that publication (a
   * newer one that replaced it in the meantime is left alone); absent, whatever the record names.
   */
  withdraw(target?: string): Promise<void> {
    return this.serial(async () => {
      const rec = readRecord(this.record);
      if (!rec || (target !== undefined && rec.target !== target)) return;
      if (!this.installed()) return;
      const holds = serveHolds(await this.run(['serve', 'status', '--json']), rec.name, rec.port, rec.target);
      if (holds === 'ours') await this.run(['serve', `--https=${rec.port}`, 'off']);
      this.forget();
    });
  }

  /** Something Sable published is recorded (no process). */
  owes(): boolean { return !!readRecord(this.record); }

  private save(rec: Published) {
    mkdirSync(path.dirname(this.record), { recursive: true });
    const tmp = this.record + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, this.record);
  }

  private forget() { rmSync(this.record, { force: true }); }
}

/** Settings' view of a look (`WebState.tailscale`). */
export function tailscaleView(look: Awaited<ReturnType<TailscaleServe['look']>> | undefined, installed: boolean): WebTailscale {
  if (!installed) return { state: 'missing', text: TS_WORDS.missing };
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
