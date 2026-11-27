import { restoreWebAcl } from './web-acl-fixture';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { daemonOf, readTailscale, serveHolds, sessionProxies, tailnetPeer, tailscalePath, TailscaleServe, TS_WORDS, type TailscaleCli, type TailscaleHeld, type TailscaleTimes } from '../server/services/web-tailscale';
import { webSection } from '../src/features/web/web-model';
import { WEB_TAILSCALE, type WebState } from '../shared/protocol';
import { pskOfKey } from '../mobile/src/lib/secure';
import { handshake, wireClient } from './phone-wire';

/**
 * Web access over Tailscale (server/services/web-tailscale.ts and its mode in web-remote.ts), against a
 * FAKE Tailscale CLI only: no test here runs the real one (the runner below refuses any tailscale program).
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
vi.mock('../server/services/web-run', async original => {
  const actual = await original<typeof import('../server/services/web-run')>();
  return { ...actual, runOff: (file: string, args: string[], env: NodeJS.ProcessEnv, opts?: { timeout?: number; maxBuffer?: number }) => {
    if (/tailscale/i.test(path.basename(file))) throw Error('a test ran the real Tailscale CLI');
    return actual.runOff(file, args, env, opts);
  } };
});

const NAME = 'desk.example-tail.ts.net';
const LOGIN = 'owner@example.com';
const before = process.env.SABLE_WEB;
beforeAll(() => { process.env.SABLE_WEB = '1'; });
afterAll(() => { if (before === undefined) delete process.env.SABLE_WEB; else process.env.SABLE_WEB = before; });

/**
 * A Tailscale CLI with a serve configuration in memory. The two reading commands answer; the one command
 * Sable may keep running is a foreground serve, whose entry lives under a session of its own for as long
 * as that "process" does (as Tailscale keeps it). Anything else fails the test.
 */
interface FakeTs {
  installed: boolean;
  status: Record<string, unknown>;
  config: Record<string, any>;
  calls: string[][];
  cli: TailscaleCli;
  /** Serves running now. */
  live: Set<{ die(said?: string): void }>;
  /** How long a started serve takes to show in the status. */
  showAfter: number;
  /** A serve's start ends at once with these words (no access, a refusal). */
  refuse?: string;
  /** Tailscale goes on listing a serve whose process has gone (it has not noticed yet). */
  sticky: boolean;
  /** Which run of Tailscale's service this is (what Windows says about it). */
  daemon: string | undefined;
  /** Every running serve's process ends, Tailscale itself running on (a process ended by hand). */
  kill(): void;
  /** Tailscale's service restarts (an update of it): another run of it, and every serve has gone. */
  restart(): void;
  /** The owner's `tailscale serve reset`: the configuration is empty, and Tailscale ends the serves it removed. */
  reset(): void;
  target(): string | undefined;
}
function fakeCli(o: { status?: Record<string, unknown>; config?: Record<string, any>; installed?: boolean } = {}): FakeTs {
  const calls: string[][] = [];
  let sessions = 0;
  const t: FakeTs = {
    installed: o.installed ?? true,
    status: o.status ?? statusOf(),
    config: (o.config ?? {}) as Record<string, any>,
    calls,
    live: new Set(),
    showAfter: 5,
    sticky: false,
    daemon: 'pid 4100',
    kill() { for (const p of [...t.live]) p.die('the serve was ended'); },
    restart() { t.daemon = 'pid ' + (4200 + ++sessions); t.kill(); },
    reset() { t.kill(); t.config = {}; },
    cli: {
      file: () => (t.installed ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : undefined),
      daemon: async () => t.daemon,
      async run(args: string[]) {
        calls.push(args);
        const a = args.join(' ');
        if (a === 'status --json') return JSON.stringify(t.status);
        if (a === 'serve status --json') return JSON.stringify(t.config);
        throw Error('unexpected tailscale command: ' + a);
      },
      hold(args: string[]): TailscaleHeld {
        calls.push(args);
        const a = args.join(' ');
        const m = /^serve --yes --https=443 (http:\/\/127\.0\.0\.1:\d+)$/.exec(a);
        if (!m) throw Error('unexpected tailscale command: ' + a);
        let end!: (said: string) => void, ended = false;
        const gone = new Promise<string>(r => { end = r; });
        if (t.refuse !== undefined) { end(t.refuse); return { gone, stop: async () => {} }; }
        const id = 'session-' + ++sessions;
        const show = setTimeout(() => {
          (t.config.Foreground ??= {})[id] = { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: m[1] } } } } };
        }, t.showAfter);
        const proc = {
          die(said = '') {
            if (ended) return;
            ended = true;
            clearTimeout(show);
            if (!t.sticky && t.config.Foreground) {
              delete t.config.Foreground[id];
              if (!Object.keys(t.config.Foreground).length) delete t.config.Foreground;
            }
            t.live.delete(proc);
            end(said);
          },
        };
        t.live.add(proc);
        return { gone, stop: async () => { proc.die(); } };
      },
    } satisfies TailscaleCli,
    /** The loopback target Sable publishes now, if any. */
    target: () => (Object.values(t.config.Foreground ?? {})[0] as any)?.Web?.[`${NAME}:443`]?.Handlers?.['/']?.Proxy as string | undefined,
  };
  return t;
}
function statusOf(o: { backend?: string; certs?: string[] | null; name?: string; user?: string } = {}) {
  return { BackendState: o.backend ?? 'Running', Self: { DNSName: (o.name ?? NAME) + '.', UserID: 7 }, CertDomains: o.certs === undefined ? [NAME] : o.certs,
    User: { 7: { LoginName: o.user ?? LOGIN } } };
}
/** Short waits for the module's own looks. */
const FAST = { settle: 600, step: 10, confirm: 4, recheck: 40, retry: 150, republish: 150 };
const changing = (calls: string[][]) => calls.filter(c => !(c.join(' ') === 'status --json' || c.join(' ') === 'serve status --json'));
// Never a lasting entry, never a command that removes or changes one, never Funnel.
const forbidden = (calls: string[][]) => calls.flat().filter(a => /funnel|reset|^up$|^set$|logout|clear|^--bg|^off$/.test(a));

const homes: string[] = [], apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) { restoreWebAcl(home); rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
});

// ── the module ──

it('reads every state from status --json, and only a ts.net name with HTTPS certificates is ready', () => {
  expect(readTailscale('not json')).toMatchObject({ kind: 'unreadable' });
  expect(readTailscale(JSON.stringify({ ...statusOf(), BackendState: 'Stopped' }))).toEqual({ kind: 'stopped', text: TS_WORDS.stopped });
  expect(readTailscale(JSON.stringify({ ...statusOf(), BackendState: 'NeedsLogin' }))).toEqual({ kind: 'stopped', text: TS_WORDS.login });
  expect(readTailscale(JSON.stringify(statusOf({ name: 'desk' })))).toEqual({ kind: 'stopped', text: TS_WORDS.noName });
  expect(readTailscale(JSON.stringify(statusOf({ name: 'evil.example.com' })))).toEqual({ kind: 'stopped', text: TS_WORDS.noName });
  expect(readTailscale(JSON.stringify(statusOf({ certs: null })))).toEqual({ kind: 'https', name: NAME });
  expect(readTailscale(JSON.stringify(statusOf({ certs: ['other.example-tail.ts.net'] })))).toEqual({ kind: 'https', name: NAME });
  expect(readTailscale(JSON.stringify(statusOf()))).toEqual({ kind: 'ready', name: NAME, login: LOGIN });
  expect(readTailscale(JSON.stringify(statusOf({ user: 'tagged-devices' })))).toEqual({ kind: 'ready', name: NAME });
});

it('finds the CLI in Tailscale’s own install folder only: never on PATH, never in a project', () => {
  const env = { ProgramFiles: 'C:\\Program Files', Path: '.;C:\\Tools;D:\\repo\\bin' };
  expect(tailscalePath({ platform: 'win32', env, isProgram: f => f === 'C:\\Program Files\\Tailscale\\tailscale.exe' })).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
  // Not installed there: a tailscale.exe anywhere on PATH is not it (an entry can lie inside a repository
  // that brings its own, and what is found is started as the person).
  expect(tailscalePath({ platform: 'win32', env, isProgram: f => f === 'C:\\Tools\\tailscale.exe' })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env, isProgram: f => f === 'D:\\repo\\bin\\tailscale.exe' })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: { Path: '.' }, isProgram: f => /tailscale\.exe$/i.test(f) })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: {}, isProgram: () => false })).toBeUndefined();
  // A Program Files that is no absolute path is not believed.
  expect(tailscalePath({ platform: 'win32', env: { ProgramFiles: 'Program Files' }, isProgram: () => true })).toBeUndefined();
  // Only on Windows a child process ends with Sable, whatever ends Sable: this mode is offered there alone.
  expect(tailscalePath({ platform: 'darwin', env: {}, isProgram: () => true })).toBeUndefined();
  expect(tailscalePath({ platform: 'linux', env: { PATH: '/usr/bin' }, isProgram: () => true })).toBeUndefined();
  // The packaged app's off-screen checks name a fake by its absolute path, and only with SABLE_WEB_LOOPBACK=1;
  // named but missing, nothing is found (never the installed one).
  const real = (f: string) => /Program Files\\Tailscale/.test(f) || f === 'D:\\fake\\tailscale.exe';
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'D:\\fake\\tailscale.exe' }, isProgram: real })).toBe('D:\\fake\\tailscale.exe');
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'D:\\gone\\tailscale.exe' }, isProgram: real })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'tailscale.exe' }, isProgram: real })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_TAILSCALE_CLI: 'D:\\fake\\tailscale.exe' }, isProgram: real })).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
});

const T = 'http://127.0.0.1:47841';
const entryTo = (target: string, port = 443) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${NAME}:${port}`]: { Handlers: { '/': { Proxy: target } } } } });

it('knows the shape of its own serve: one foreground session on port 443, and nothing lasting there', () => {
  const ours = { Foreground: { s1: entryTo(T) } };
  expect(serveHolds('{}', NAME, 443, T)).toBe('free');
  expect(serveHolds('null', NAME, 443, T)).toBe('free');
  expect(serveHolds(JSON.stringify(entryTo('http://127.0.0.1:3000', 8443)), NAME, 443, T)).toBe('free');
  expect(serveHolds(JSON.stringify({ Foreground: { s1: entryTo('http://127.0.0.1:3000', 8443) } }), NAME, 443, T)).toBe('free');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, T)).toBe('ours');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, T + '/')).toBe('ours');
  expect(serveHolds(JSON.stringify({ ...entryTo('http://127.0.0.1:3000', 8443), ...ours }), NAME, 443, T)).toBe('ours');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, 'http://127.0.0.1:47842')).toBe('taken');
  // A lasting entry is never Sable's, also one that points at Sable's own loopback port.
  expect(serveHolds(JSON.stringify(entryTo(T)), NAME, 443, T)).toBe('taken');
  expect(serveHolds(JSON.stringify({ ...entryTo(T), ...ours }), NAME, 443, T)).toBe('taken');
  expect(serveHolds(JSON.stringify({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }), NAME, 443, T)).toBe('taken');
  // A session with anything more or else on the port, or two of them.
  const more = structuredClone(ours);
  (more.Foreground.s1.Web[`${NAME}:443`].Handlers as Record<string, unknown>)['/x'] = { Proxy: 'http://127.0.0.1:3000' };
  expect(serveHolds(JSON.stringify(more), NAME, 443, T)).toBe('taken');
  expect(serveHolds(JSON.stringify({ Foreground: { s1: { ...entryTo(T), AllowFunnel: { [`${NAME}:443`]: true } } } }), NAME, 443, T)).toBe('taken');
  expect(serveHolds(JSON.stringify({ Foreground: { s1: { TCP: { 443: { HTTPS: true } } } } }), NAME, 443, T)).toBe('taken');
  expect(serveHolds(JSON.stringify({ Foreground: { s1: entryTo(T), s2: entryTo(T) } }), NAME, 443, T)).toBe('taken');
  expect(serveHolds('garbled', NAME, 443, T)).toBe('taken');
  expect(serveHolds('[]', NAME, 443, T)).toBe('taken');
  // What a withdrawal waits out: any session that still sends requests to the loopback port.
  expect(sessionProxies('{}', T)).toBe(false);
  expect(sessionProxies(JSON.stringify(ours), T)).toBe(true);
  expect(sessionProxies(JSON.stringify({ Foreground: { s9: entryTo(T + '/', 8443) } }), T)).toBe(true);
  expect(sessionProxies(JSON.stringify({ Foreground: { s1: entryTo('http://127.0.0.1:47842') } }), T)).toBe(false);
  expect(sessionProxies(JSON.stringify(entryTo(T)), T)).toBe(false);
  expect(() => sessionProxies('garbled', T)).toThrow();
});

it('publishes on a free port 443 as a serve it holds, and withdraws by ending it; nothing else is touched', async () => {
  const foreign = entryTo('http://127.0.0.1:3000', 8443);
  const f = fakeCli({ config: structuredClone(foreign) });
  const serve = new TailscaleServe(f.cli, FAST);
  expect(await serve.publish(NAME, T)).toBe('published');
  expect(changing(f.calls)).toEqual([['serve', '--yes', '--https=443', T]]);
  expect(serve.owes()).toBe(T);
  expect(await serve.holds(NAME, T)).toBe('ours');
  // Already there: nothing run again.
  f.calls.length = 0;
  expect(await serve.publish(NAME, T)).toBe('published');
  expect(changing(f.calls)).toEqual([]);
  // Withdrawing runs no command at all: the serve's process ends, and Tailscale is read until it is gone.
  await serve.withdraw();
  expect(changing(f.calls)).toEqual([]);
  expect(f.live.size).toBe(0);
  expect(f.config).toEqual(foreign);
  expect(serve.owes()).toBeUndefined();
  // Another loopback port: the first serve goes before the second starts.
  expect(await serve.publish(NAME, T)).toBe('published');
  f.calls.length = 0;
  expect(await serve.publish(NAME, 'http://127.0.0.1:47843')).toBe('published');
  expect(changing(f.calls)).toEqual([['serve', '--yes', '--https=443', 'http://127.0.0.1:47843']]);
  expect(f.live.size).toBe(1);
  expect(f.target()).toBe('http://127.0.0.1:47843');
  await serve.withdraw();
  expect(f.config).toEqual(foreign);
  expect(forbidden(f.calls)).toEqual([]);
});

it('never takes an entry it did not start for its own, and never removes one', async () => {
  // The owner's own lasting entry on port 443.
  const owners = entryTo('http://127.0.0.1:3000');
  const f = fakeCli({ config: structuredClone(owners) });
  const serve = new TailscaleServe(f.cli, FAST);
  expect(await serve.publish(NAME, T)).toBe('taken');
  expect(changing(f.calls)).toEqual([]);
  expect(serve.owes()).toBeUndefined();
  await serve.withdraw();
  expect(f.config).toEqual(owners);

  // The owner's lasting entry that points at the very port Sable listens on (their own service, stopped
  // for now): not Sable's, nothing started, nothing removed.
  const same = fakeCli({ config: structuredClone(entryTo(T)) });
  const serve2 = new TailscaleServe(same.cli, FAST);
  expect(await serve2.publish(NAME, T)).toBe('taken');
  await serve2.withdraw();
  expect(same.config).toEqual(entryTo(T));
  expect(changing(same.calls)).toEqual([]);

  // A foreground serve of exactly Sable's shape that this run did not start (another program's).
  const other = fakeCli({ config: { Foreground: { theirs: entryTo(T) } } });
  const serve3 = new TailscaleServe(other.cli, FAST);
  expect(await serve3.holds(NAME, T)).toBe('taken');
  expect(await serve3.publish(NAME, T)).toBe('taken');
  await serve3.withdraw();
  expect(other.config).toEqual({ Foreground: { theirs: entryTo(T) } });
  expect(changing(other.calls)).toEqual([]);

  // Published, then the owner puts a lasting entry on the port: Sable ends its own serve and nothing else.
  const g = fakeCli();
  const serve4 = new TailscaleServe(g.cli, FAST);
  expect(await serve4.publish(NAME, T)).toBe('published');
  Object.assign(g.config, entryTo('http://127.0.0.1:3000'));
  expect(await serve4.holds(NAME, T)).toBe('taken');
  g.calls.length = 0;
  await serve4.withdraw();
  expect(changing(g.calls)).toEqual([]);
  expect(g.config).toEqual(entryTo('http://127.0.0.1:3000'));
  expect(forbidden([...f.calls, ...same.calls, ...other.calls, ...g.calls])).toEqual([]);
});

it('a serve that ends, or never shows, is ended and fails with what the CLI said', async () => {
  const f = fakeCli();
  f.refuse = 'Access denied';
  const serve = new TailscaleServe(f.cli, FAST);
  await expect(serve.publish(NAME, T)).rejects.toThrow(/the serve ended: Access denied/);
  expect(serve.owes()).toBeUndefined();
  f.refuse = undefined;
  f.showAfter = 60_000;
  await expect(serve.publish(NAME, T)).rejects.toThrow(/did not show in time/);
  expect(f.live.size).toBe(0);
  expect(serve.owes()).toBeUndefined();
  // Something else shows on the port while it starts (the owner's own, at that moment): ended as well.
  f.showAfter = 5;
  const run = f.cli.run;
  f.cli.run = async (args: string[]) => { if (f.live.size && args[0] === 'serve') Object.assign(f.config, entryTo('http://127.0.0.1:3000')); return run(args); };
  await expect(serve.publish(NAME, T)).rejects.toThrow(/shows something else/);
  expect(f.live.size).toBe(0);
  expect(f.config).toEqual(entryTo('http://127.0.0.1:3000'));
});

it('a withdrawal is done only once Tailscale no longer lists the serve', async () => {
  const f = fakeCli();
  const serve = new TailscaleServe(f.cli, FAST);
  expect(await serve.publish(NAME, T)).toBe('published');
  // The process has gone, Tailscale still lists its session: not done, and still owed.
  f.sticky = true;
  await expect(serve.withdraw()).rejects.toThrow(/still lists/);
  expect(f.live.size).toBe(0);
  expect(serve.owes()).toBe(T);
  // A status that cannot be read is no proof either.
  const run = f.cli.run;
  f.cli.run = async () => { throw Error('timed out'); };
  await expect(serve.withdraw()).rejects.toThrow(/timed out/);
  expect(serve.owes()).toBe(T);
  f.cli.run = run;
  delete f.config.Foreground;
  await serve.withdraw();
  expect(serve.owes()).toBeUndefined();
});

it('tells once when its serve ended by itself, and whether Tailscale restarted; never for its own withdrawal', async () => {
  const f = fakeCli();
  const serve = new TailscaleServe(f.cli, FAST);
  const lost: [string, boolean][] = [];
  serve.onLost = (target, restarted) => lost.push([target, restarted]);
  expect(await serve.publish(NAME, T)).toBe('published');
  await serve.withdraw();
  expect(await serve.publish(NAME, T)).toBe('published');
  expect(lost).toEqual([]);
  // Removed while Tailscale kept running (the owner's reset, the process ended by hand): no restart.
  f.reset();
  await vi.waitFor(() => expect(lost).toEqual([[T, false]]));
  // No longer this run's: `holds` does not say `ours`.
  expect(await serve.holds(NAME, T)).not.toBe('ours');
  await serve.withdraw();
  expect(lost).toHaveLength(1);
  // Tailscale's service restarted: another run of it.
  expect(await serve.publish(NAME, T)).toBe('published');
  f.restart();
  await vi.waitFor(() => expect(lost).toEqual([[T, false], [T, true]]));
  await serve.withdraw();
  // A service on its way down that still answers as before is asked once more a moment later.
  expect(await serve.publish(NAME, T)).toBe('published');
  const was = f.daemon;
  f.kill();
  setTimeout(() => { f.daemon = 'down'; }, 15);
  await vi.waitFor(() => expect(lost).toHaveLength(3));
  expect(lost[2]).toEqual([T, true]);
  expect(was).not.toBe('down');
  await serve.withdraw();
  // What the service is cannot be read: never taken for a restart.
  f.daemon = undefined;
  expect(await serve.publish(NAME, T)).toBe('published');
  f.restart();
  f.daemon = undefined;
  await vi.waitFor(() => expect(lost).toHaveLength(4));
  expect(lost[3]).toEqual([T, false]);
});

it('reads which run of Tailscale’s service this is from Windows’ own answer', () => {
  const answer = (state: string, pid: string) => ['', 'SERVICE_NAME: Tailscale ', '        TYPE               : 10  WIN32_OWN_PROCESS  ', `        STATE              : ${state} `,
    '                                (STOPPABLE, NOT_PAUSABLE, IGNORES_SHUTDOWN)', '        WIN32_EXIT_CODE    : 0  (0x0)', '        SERVICE_EXIT_CODE  : 0  (0x0)',
    '        CHECKPOINT         : 0x0', '        WAIT_HINT          : 0x0', `        PID                : ${pid}`, '        FLAGS              : ', ''].join('\r\n');
  expect(daemonOf(answer('4  RUNNING', '5120'))).toBe('pid 5120');
  expect(daemonOf(answer('4  RUNNING', '6044'))).toBe('pid 6044');
  expect(daemonOf(answer('3  STOP_PENDING', '5120'))).toBe('down');
  expect(daemonOf(answer('1  STOPPED', '0'))).toBe('down');
  expect(daemonOf(answer('2  START_PENDING', '6044'))).toBe('down');
  expect(daemonOf('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:')).toBeUndefined();
  expect(daemonOf('')).toBeUndefined();
});

it('takes the tailnet address of the browser from the proxy, and nothing else', () => {
  expect(tailnetPeer('100.101.102.103')).toBe('100.101.102.103');
  expect(tailnetPeer('100.101.102.103, 10.0.0.1')).toBe('100.101.102.103');
  expect(tailnetPeer('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1');
  expect(tailnetPeer('10.0.0.1')).toBeUndefined();
  expect(tailnetPeer('100.200.1.1')).toBeUndefined();
  expect(tailnetPeer(undefined)).toBeUndefined();
});

it('keeps serving through a look it cannot read, stops and withdraws when Tailscale stops', async () => {
  const f = fakeCli();
  const { app } = fixture(f, undefined, { fresh: 300, idle: 300, hold: 120_000 });
  await app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await app.call('web.state', {})).listening).toBe(true);
  f.status = 'garbled' as unknown as Record<string, unknown>;
  const looks = () => f.calls.filter(c => c.join(' ') === 'status --json').length;
  const before = looks();
  await vi.waitFor(() => expect(looks()).toBeGreaterThan(before + 1), { timeout: 5000 });
  expect((await app.call('web.state', {})).listening).toBe(true);
  f.status = { ...statusOf(), BackendState: 'Stopped' };
  await vi.waitFor(async () => expect((await app.call('web.state', {})).error).toBe(TS_WORDS.stopped), { timeout: 5000 });
  await vi.waitFor(() => expect(f.target()).toBeUndefined(), { timeout: 5000 });
  expect(forbidden(f.calls)).toEqual([]);
});

// ── the listener in this mode ──

function fixture(f = fakeCli(), home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-')), lookTimes?: { fresh: number; idle: number; hold: number }, times: Partial<TailscaleTimes> = {}) {
  homes.push(home);
  const app = new App({ home, userHome: home, quiet: true, providers: [ctx => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const assets = path.join(home, 'bundle');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), 'Sable web fixture');
  app.store.state.settings.webNetwork = WEB_TAILSCALE;
  const networks = [{ id: 'home/adapter/10.0.0.7', name: 'Home', address: '10.0.0.7' }];
  registerPhone(app, { port: 0, host: '127.0.0.1', web: { assets, loopback: true, port: 0, tailscalePort: 0, networks: () => networks, tailscale: f.cli, tailscaleTimes: { ...FAST, ...times }, ...(lookTimes ? { lookTimes } : {}) } });
  return { app, home, f, networks };
}
const local = (f: ReturnType<typeof fakeCli>) => Number(/:(\d+)$/.exec(f.target()!)![1]);
function get(port: number, headers: Record<string, string>, route = '/') {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, headers, agent: false }, res => { res.resume(); resolve(res.statusCode!); });
    req.once('error', reject);
    req.end();
  });
}
const PROXY = { Host: NAME, 'Tailscale-User-Login': LOGIN, 'X-Forwarded-For': '100.101.102.103', 'X-Forwarded-Proto': 'https' };

it('says each state in Settings: not installed, not running, HTTPS off, the port taken, published', async () => {
  const say = async (f: ReturnType<typeof fakeCli>) => {
    const { app } = fixture(f);
    await app.call('app.setSettings', { patch: { webRemote: true } });
    const s = await app.call('web.state', {});
    const settings = app.store.state.settings;
    return { s, v: webSection(s, settings, Date.now()) };
  };
  const missing = await say(fakeCli({ installed: false }));
  expect(missing.s.tailscale).toEqual({ state: 'missing', text: TS_WORDS.missing });
  expect(missing.v.networkHelp).toBe(TS_WORDS.missing);
  expect(missing.v.networks![0]).toMatchObject({ id: WEB_TAILSCALE, name: 'Tailscale', address: 'Not installed', chosen: true });
  expect(missing.v.error).toBeUndefined();
  const stopped = await say(fakeCli({ status: { ...statusOf(), BackendState: 'Stopped' } }));
  expect(stopped.v.networkHelp).toBe(TS_WORDS.stopped);
  expect(stopped.v.networks![0].address).toBe('Not running');
  const https = await say(fakeCli({ status: statusOf({ certs: null }) }));
  expect(https.v.networkHelp).toBe(TS_WORDS.https);
  expect(https.v.networkHelp).toMatch(/admin console.*DNS.*HTTPS Certificates/);
  expect(https.v.networks![0].address).toBe('HTTPS off');
  const taken = fakeCli({ config: { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } } });
  const held = await say(taken);
  expect(held.v.networkHelp).toBe(TS_WORDS.taken);
  expect(held.s.listening).toBe(false);
  expect(changing(taken.calls)).toEqual([]);
  // The CLI refuses (no access to the service, a version that differs): one plain sentence, not its output.
  const broken = fakeCli();
  broken.refuse = 'Access denied: C:\\Users\\someone\\secret';
  const failed = await say(broken);
  expect(failed.s.error).toBe(TS_WORDS.failed);
  expect(failed.v.error).toBe(TS_WORDS.failed);
  expect(failed.s.listening).toBe(false);
  const ok = fakeCli();
  const published = await say(ok);
  expect(published.s).toMatchObject({ listening: true, addresses: [NAME], port: 443, hostname: NAME, tailscale: { state: 'published', name: NAME } });
  expect(published.s.caFingerprint).toBeUndefined();
  expect(published.v.address).toMatchObject({ link: `https://${NAME}/`, shown: `https://${NAME}` });
  expect(published.v.setup?.caUrl).toBeUndefined();
  expect(published.v.networkHelp).toBeUndefined();
  // Over Tailscale the home networks are still listed to choose from (looked at when Settings asks).
  await vi.waitFor(async () => expect((await apps[apps.length - 1].call('web.state', {})).networks?.map(n => n.name)).toEqual(['Home']));
  expect(forbidden([...taken.calls, ...ok.calls])).toEqual([]);
  // Nothing of Sable's certificate chain was made in this mode.
  for (const h of homes) expect(existsSync(path.join(h, 'web', 'ca.cer'))).toBe(false);
});

it('serves only what came through Tailscale’s proxy for this computer’s name and owner', async () => {
  const { app, f } = fixture();
  await app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await app.call('web.state', {})).listening).toBe(true);
  const port = local(f);
  expect(await get(port, PROXY)).toBe(200);
  // Tailscale's proxy may pass its own target as Host and the browser's name as X-Forwarded-Host.
  expect(await get(port, { ...PROXY, Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': NAME })).toBe(200);
  expect(await get(port, { ...PROXY, Host: `127.0.0.1:${port}` })).toBe(403);
  expect(await get(port, { ...PROXY, Host: 'other.example-tail.ts.net' })).toBe(403);
  expect(await get(port, { ...PROXY, Host: `${NAME}:443` })).toBe(403);
  expect(await get(port, { Host: NAME })).toBe(403);
  expect(await get(port, { ...PROXY, 'Tailscale-User-Login': 'someone@else.example' })).toBe(403);
  expect(await get(port, { ...PROXY, 'Tailscale-Funnel-Request': '?1' })).toBe(403);
  // No certificate of Sable's here.
  expect(await get(port, PROXY, '/ca.cer')).toBe(404);
  const upgrade = (headers: Record<string, string>) => new Promise<string>(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sable-web`, { headers });
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
    ws.once('error', () => resolve('error'));
  });
  expect(await upgrade({ ...PROXY, Origin: `https://${NAME}` })).toBe('open');
  expect(await upgrade({ ...PROXY, Origin: `https://${NAME}:443` })).toBe('403');
  expect(await upgrade({ ...PROXY, Origin: 'https://evil.example' })).toBe('403');
  expect(await upgrade({ ...PROXY, Origin: `http://${NAME}` })).toBe('403');
  expect(await upgrade({ Host: NAME, Origin: `https://${NAME}` })).toBe('403');
});

/** A browser pairs through the proxy's headers and the desktop allows it. */
async function pairBrowser(app: App, f: FakeTs) {
  const link = new URL((await app.call('web.offer', {})).pairing!.link);
  expect(link.origin + link.pathname).toBe(`https://${NAME}/`);
  const q = new URLSearchParams(link.hash.slice(1));
  const key = q.get('p')!, fp = q.get('f')!;
  const ws = new WebSocket(`ws://127.0.0.1:${local(f)}/sable-web`, { headers: { ...PROXY, Origin: `https://${NAME}` } });
  const c = wireClient(local(f), null, ws);
  expect(await handshake(c, 'pair', fp, pskOfKey(key))).toEqual({});
  c.send({ pair: { key, name: 'iPad · Safari' } });
  await c.next(fr => !!fr.waiting);
  const s = await app.call('web.state', {});
  expect(s.request).toMatchObject({ name: 'iPad · Safari', address: '100.101.102.103' });
  await app.call('web.approve', { requestId: s.request!.id, allow: true });
  await c.next(fr => !!fr.paired);
  await c.next(fr => !!fr.welcome);
  return ws;
}

it('pairs a browser over Tailscale with the desktop’s Allow, at https://<name>/, and shows its tailnet address', async () => {
  const { app, f } = fixture();
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await app.call('web.state', {});
  const ws = await pairBrowser(app, f);
  expect((await app.call('web.state', {})).devices.map(d => d.name)).toEqual(['iPad · Safari']);
  ws.close();
});

// The second review: at quit the port was closed whether or not Tailscale had let go of the serve.
it.each([false, true])('at quit a paired browser is kept only when Tailscale was seen to let go (still listed: %s)', async sticky => {
  const f = fakeCli();
  const { app, home } = fixture(f);
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await app.call('web.state', {});
  (await pairBrowser(app, f)).close();
  const port = local(f);
  f.sticky = sticky;
  const quit = performance.now();
  await app.dispose();
  apps.splice(apps.indexOf(app), 1);
  // Never the six seconds a withdrawal may take at most: this one answered at once, either way.
  expect(performance.now() - quit).toBeLessThan(4000);
  expect(f.live.size).toBe(0);
  // Still listed: Sable does not close the listener itself (it refuses on, for as long as the process
  // lives), and no checkpoint of the pairings is published.
  expect(await knock(port)).toBe(sticky ? '403' : 'closed');
  expect(existsSync(path.join(home, 'web', 'pairings.json.closed'))).toBe(!sticky);
  // The next run: a browser that could have been answered by another program in between pairs again.
  const g = fakeCli();
  const next = fixture(g, home);
  expect((await next.app.call('web.state', {})).devices.map(d => d.name)).toEqual(sticky ? [] : ['iPad · Safari']);
});

// The second review: two failed withdrawals each left a timer, and the forgotten one later ended a newer serve.
it('a late try of an old withdrawal never ends a newer serve', async () => {
  const f = fakeCli();
  // A serve that shows together with something else on the port, and stays listed after its process ended.
  const run = f.cli.run;
  let spoil = true;
  f.cli.run = async (args: string[]) => { if (spoil && f.live.size && args[0] === 'serve') Object.assign(f.config, entryTo('http://127.0.0.1:3000')); return run(args); };
  f.sticky = true;
  const { app } = fixture(f, undefined, { fresh: 200, idle: 200, hold: 120_000 }, { retry: 900 });
  await app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await app.call('web.state', {})).error).toBe(TS_WORDS.failed);
  await new Promise(r => setTimeout(r, 60));
  // Tailscale lets go and the port is free again: the next start publishes.
  spoil = false;
  f.sticky = false;
  f.config = {};
  await vi.waitFor(async () => expect((await app.call('web.state', {})).listening).toBe(true), { timeout: 5000 });
  const port = local(f);
  // Past every retry of the failed withdrawals: the new serve and its listener are untouched.
  await new Promise(r => setTimeout(r, 1300));
  expect(f.live.size).toBe(1);
  expect(await knock(port)).toBe('200');
  expect((await app.call('web.state', {})).listening).toBe(true);
});

it('withdraws what it published when switched off, when the network changes and when Sable quits; nothing runs while off', async () => {
  const foreign = { TCP: { 8443: { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const f = fakeCli({ config: structuredClone(foreign) });
  const { app, home } = fixture(f);
  const settle = async () => { await app.call('web.state', {}); await new Promise(r => setTimeout(r, 50)); };
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await settle();
  expect(f.target()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // Off: withdrawn, the owner's own entry stays.
  await app.call('app.setSettings', { patch: { webRemote: false } });
  await vi.waitFor(() => expect(f.config).toEqual(foreign));
  f.calls.length = 0;
  await new Promise(r => setTimeout(r, 100));
  expect(f.calls).toEqual([]);
  // On again, then the home network chosen: withdrawn.
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await settle();
  expect(f.target()).toBeDefined();
  // (A network that is not connected: the chain mode does not start, so no certificate is made here.)
  await app.call('app.setSettings', { patch: { webNetwork: 'elsewhere' } });
  await vi.waitFor(() => expect(f.config).toEqual(foreign));
  // Tailscale again, then quit: withdrawn before the app has gone.
  await app.call('app.setSettings', { patch: { webNetwork: WEB_TAILSCALE } });
  await settle();
  expect(f.target()).toBeDefined();
  await app.dispose();
  apps.splice(apps.indexOf(app), 1);
  expect(f.config).toEqual(foreign);
  expect(f.live.size).toBe(0);
  // Nothing on disk says what Sable published: the serve it holds does.
  expect(existsSync(path.join(home, 'web', 'tailscale.json'))).toBe(false);
  expect(forbidden(f.calls)).toEqual([]);
});

/** A connection to the loopback port: its status, or `closed` when nothing listens there. */
const knock = (port: number) => get(port, PROXY).then(String, () => 'closed');

it('keeps the loopback port, refusing everything, until Tailscale no longer lists the publication', async () => {
  const f = fakeCli();
  const { app } = fixture(f);
  await app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await app.call('web.state', {})).listening).toBe(true);
  const port = local(f);
  expect(await knock(port)).toBe('200');
  // Switched off while Tailscale goes on listing the serve (its process has gone): the tablet would still
  // be sent to this port, so nobody else may have it. Sable keeps it and answers nothing.
  f.sticky = true;
  await app.call('app.setSettings', { patch: { webRemote: false } });
  expect((await app.call('web.state', {})).listening).toBe(false);
  expect(f.live.size).toBe(0);
  await new Promise(r => setTimeout(r, 300));
  expect(await knock(port)).toBe('403');
  const taker = http.createServer();
  await expect(new Promise<void>((resolve, reject) => taker.once('error', reject).listen(port, '127.0.0.1', resolve))).rejects.toMatchObject({ code: 'EADDRINUSE' });
  // Tailscale lets go: the next look sees it and the port is free.
  delete f.config.Foreground;
  await vi.waitFor(async () => expect(await knock(port)).toBe('closed'), { timeout: 5000, interval: 50 });
  // On again while a port is still kept: looked at again first, then published anew.
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await vi.waitFor(async () => expect((await app.call('web.state', {})).listening).toBe(true), { timeout: 5000 });
  f.sticky = true;
  const second = local(f);
  await app.call('app.setSettings', { patch: { webRemote: false } });
  await new Promise(r => setTimeout(r, 50));
  f.sticky = false;
  delete f.config.Foreground;
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await vi.waitFor(async () => expect((await app.call('web.state', {})).listening).toBe(true), { timeout: 5000 });
  expect(f.live.size).toBe(1);
  if (local(f) !== second) expect(await knock(second)).toBe('closed');
  expect(forbidden(f.calls)).toEqual([]);
});

it('publishes again by itself after a restart of Tailscale, and never after its serve was removed outside Sable', async () => {
  const f = fakeCli();
  const first = fixture(f, undefined, { fresh: 300, idle: 300, hold: 120_000 });
  await first.app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await first.app.call('web.state', {})).listening).toBe(true);
  // Tailscale restarts (an update): the serve's process ends. The listener stops and says so, then Sable
  // publishes again without the person.
  const stopped = new Promise<WebState>(resolve => { const off = first.app.subscribe(e => { if (e.type === 'web.updated' && !e.state.listening) { off(); resolve(e.state); } }); });
  f.restart();
  expect((await stopped).error).toBe(TS_WORDS.lost);
  await vi.waitFor(async () => expect((await first.app.call('web.state', {})).listening).toBe(true), { timeout: 5000 });
  expect((await first.app.call('web.state', {})).error).toBeUndefined();
  expect(f.live.size).toBe(1);
  expect(changing(f.calls)).toHaveLength(2);

  const g = fakeCli();
  const second = fixture(g, undefined, { fresh: 300, idle: 300, hold: 120_000 });
  await second.app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await second.app.call('web.state', {})).listening).toBe(true);
  // The owner clears the serve setup with Tailscale's own command (which ends the serves it removed) while
  // Tailscale runs on: the listener stops and says so, and Sable does not put back what the owner removed.
  const state = new Promise<WebState>(resolve => { const off = second.app.subscribe(e => { if (e.type === 'web.updated' && !e.state.listening) { off(); resolve(e.state); } }); });
  g.reset();
  const s = await state;
  expect(s.error).toBe(TS_WORDS.gone);
  // Not published again by itself: not after the few seconds, not with the looks that follow.
  await new Promise(r => setTimeout(r, 1200));
  expect((await second.app.call('web.state', {})).error).toBe(TS_WORDS.gone);
  expect(g.target()).toBeUndefined();
  expect(g.live.size).toBe(0);
  expect(changing(g.calls)).toHaveLength(1);
  expect(forbidden([...f.calls, ...g.calls])).toEqual([]);
});
