import { restoreWebAcl } from './web-acl-fixture';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { readTailscale, serveHolds, tailnetPeer, tailscalePath, TailscaleServe, TS_WORDS, type TailscaleCli } from '../server/services/web-tailscale';
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

/** A Tailscale CLI with a serve configuration in memory; anything but the five commands Sable may run fails the test. */
interface FakeTs {
  installed: boolean;
  status: Record<string, unknown>;
  config: Record<string, any>;
  calls: string[][];
  cli: TailscaleCli;
  target(): string | undefined;
}
function fakeCli(o: { status?: Record<string, unknown>; config?: Record<string, any>; installed?: boolean } = {}): FakeTs {
  const calls: string[][] = [];
  const t: FakeTs = {
    installed: o.installed ?? true,
    status: o.status ?? statusOf(),
    config: (o.config ?? {}) as Record<string, any>,
    calls,
    cli: {
      file: () => (t.installed ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : undefined),
      async run(args: string[]) {
        calls.push(args);
        const a = args.join(' ');
        if (a === 'status --json') return JSON.stringify(t.status);
        if (a === 'serve status --json') return JSON.stringify(t.config);
        let m = /^serve --bg --yes --https=443 (http:\/\/127\.0\.0\.1:\d+)$/.exec(a);
        if (m) {
          (t.config.TCP ??= {})['443'] = { HTTPS: true };
          (t.config.Web ??= {})[`${NAME}:443`] = { Handlers: { '/': { Proxy: m[1] } } };
          return '';
        }
        m = /^serve --https=443 off$/.exec(a);
        if (m) {
          const web = t.config.Web?.[`${NAME}:443`];
          delete web?.Handlers?.['/'];
          if (web && !Object.keys(web.Handlers ?? {}).length) { delete t.config.Web[`${NAME}:443`]; delete t.config.TCP?.['443']; }
          return '';
        }
        throw Error('unexpected tailscale command: ' + a);
      },
    } satisfies TailscaleCli,
    /** The loopback target Sable published, if any. */
    target: () => t.config.Web?.[`${NAME}:443`]?.Handlers?.['/']?.Proxy as string | undefined,
  };
  return t;
}
function statusOf(o: { backend?: string; certs?: string[] | null; name?: string; user?: string } = {}) {
  return { BackendState: o.backend ?? 'Running', Self: { DNSName: (o.name ?? NAME) + '.', UserID: 7 }, CertDomains: o.certs === undefined ? [NAME] : o.certs,
    User: { 7: { LoginName: o.user ?? LOGIN } } };
}
const changing = (calls: string[][]) => calls.filter(c => !(c.join(' ') === 'status --json' || c.join(' ') === 'serve status --json'));
const forbidden = (calls: string[][]) => calls.flat().filter(a => /funnel|reset|^up$|^set$|logout|clear/.test(a));

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

it('finds the CLI in its install folder, never by a bare name or in the current folder', () => {
  const env = { ProgramFiles: 'C:\\Program Files', Path: '.;C:\\Tools' };
  expect(tailscalePath({ platform: 'win32', env, isProgram: f => f === 'C:\\Program Files\\Tailscale\\tailscale.exe' })).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
  expect(tailscalePath({ platform: 'win32', env, isProgram: f => f === 'C:\\Tools\\tailscale.exe' })).toBe('C:\\Tools\\tailscale.exe');
  // A relative PATH entry (the current folder) is never searched.
  expect(tailscalePath({ platform: 'win32', env: { Path: '.' }, isProgram: f => /tailscale\.exe$/i.test(f) })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: {}, isProgram: () => false })).toBeUndefined();
  // The packaged app's off-screen checks name a fake by its absolute path, and only with SABLE_WEB_LOOPBACK=1;
  // named but missing, nothing is found (never the installed one).
  const real = (f: string) => /Program Files\\Tailscale/.test(f) || f === 'D:\\fake\\tailscale.exe';
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'D:\\fake\\tailscale.exe' }, isProgram: real })).toBe('D:\\fake\\tailscale.exe');
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'D:\\gone\\tailscale.exe' }, isProgram: real })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_WEB_LOOPBACK: '1', SABLE_TAILSCALE_CLI: 'tailscale.exe' }, isProgram: real })).toBeUndefined();
  expect(tailscalePath({ platform: 'win32', env: { ...env, SABLE_TAILSCALE_CLI: 'D:\\fake\\tailscale.exe' }, isProgram: real })).toBe('C:\\Program Files\\Tailscale\\tailscale.exe');
});

it('tells its own entry from the owner’s: anything else on port 443 is the owner’s and untouched', () => {
  const t = 'http://127.0.0.1:47841';
  const ours = { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: t } } } } };
  expect(serveHolds('{}', NAME, 443, t)).toBe('free');
  expect(serveHolds(JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }), NAME, 443, t)).toBe('free');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, t)).toBe('ours');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, t + '/')).toBe('ours');
  expect(serveHolds(JSON.stringify(ours), NAME, 443, 'http://127.0.0.1:47842')).toBe('taken');
  expect(serveHolds(JSON.stringify({ ...ours, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: t }, '/x': { Proxy: 'http://127.0.0.1:3000' } } } } }), NAME, 443, t)).toBe('taken');
  expect(serveHolds(JSON.stringify({ ...ours, AllowFunnel: { [`${NAME}:443`]: true } }), NAME, 443, t)).toBe('taken');
  expect(serveHolds(JSON.stringify({ TCP: { 443: { TCPForward: '127.0.0.1:22' } } }), NAME, 443, t)).toBe('taken');
  expect(serveHolds(JSON.stringify({ Foreground: { abc: { TCP: { 443: { HTTPS: true } } } } }), NAME, 443, t)).toBe('taken');
  expect(serveHolds(JSON.stringify({ ...ours, Foreground: { abc: { TCP: { 443: { HTTPS: true } } } } }), NAME, 443, t)).toBe('taken');
  expect(serveHolds('garbled', NAME, 443, t)).toBe('taken');
  expect(serveHolds('[]', NAME, 443, t)).toBe('taken');
});

it('publishes on a free port 443 and withdraws exactly that; a foreign entry is never touched', async () => {
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-'));
  homes.push(home);
  const foreign = { TCP: { 8443: { HTTPS: true } }, Web: { [`${NAME}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const f = fakeCli({ config: structuredClone(foreign) });
  const serve = new TailscaleServe(f.cli, path.join(home, 'web', 'tailscale.json'));
  expect(await serve.publish(NAME, 'http://127.0.0.1:47841')).toBe('published');
  expect(changing(f.calls)).toEqual([['serve', '--bg', '--yes', '--https=443', 'http://127.0.0.1:47841']]);
  expect(serve.owes()).toBe(true);
  // Already there: nothing run again.
  f.calls.length = 0;
  expect(await serve.publish(NAME, 'http://127.0.0.1:47841')).toBe('published');
  expect(changing(f.calls)).toEqual([]);
  await serve.withdraw();
  expect(changing(f.calls)).toEqual([['serve', '--https=443', 'off']]);
  expect(f.config).toEqual(foreign);
  expect(serve.owes()).toBe(false);
  expect(forbidden(f.calls)).toEqual([]);
});

it('refuses a port 443 the owner uses, and leaves an entry changed outside Sable alone', async () => {
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-'));
  homes.push(home);
  const owners = { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
  const f = fakeCli({ config: structuredClone(owners) });
  const serve = new TailscaleServe(f.cli, path.join(home, 'web', 'tailscale.json'));
  expect(await serve.publish(NAME, 'http://127.0.0.1:47841')).toBe('taken');
  expect(changing(f.calls)).toEqual([]);
  expect(serve.owes()).toBe(false);
  await serve.withdraw();
  expect(f.config).toEqual(owners);

  // Published, then the owner pointed the same port elsewhere: withdrawing runs no command.
  const g = fakeCli();
  const serve2 = new TailscaleServe(g.cli, path.join(home, 'web', 'tailscale.json'));
  expect(await serve2.publish(NAME, 'http://127.0.0.1:47841')).toBe('published');
  g.config.Web[`${NAME}:443`].Handlers['/x'] = { Proxy: 'http://127.0.0.1:3000' };
  g.calls.length = 0;
  await serve2.withdraw();
  expect(changing(g.calls)).toEqual([]);
  expect(g.config.Web[`${NAME}:443`].Handlers['/x']).toBeDefined();
  // A withdrawal named for an older publication leaves a newer one alone.
  const h = fakeCli();
  const serve3 = new TailscaleServe(h.cli, path.join(home, 'web', 'tailscale.json'));
  expect(await serve3.publish(NAME, 'http://127.0.0.1:47842')).toBe('published');
  h.calls.length = 0;
  await serve3.withdraw('http://127.0.0.1:47841');
  expect(changing(h.calls)).toEqual([]);
  expect(h.target()).toBe('http://127.0.0.1:47842');
});

it('replaces its own entry left by a run that ended without withdrawing it', async () => {
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-'));
  homes.push(home);
  const f = fakeCli();
  const record = path.join(home, 'web', 'tailscale.json');
  expect(await new TailscaleServe(f.cli, record).publish(NAME, 'http://127.0.0.1:47841')).toBe('published');
  f.calls.length = 0;
  expect(await new TailscaleServe(f.cli, record).publish(NAME, 'http://127.0.0.1:47843')).toBe('published');
  expect(changing(f.calls)).toEqual([['serve', '--https=443', 'off'], ['serve', '--bg', '--yes', '--https=443', 'http://127.0.0.1:47843']]);
  expect(f.target()).toBe('http://127.0.0.1:47843');
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

function fixture(f = fakeCli(), home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-')), lookTimes?: { fresh: number; idle: number; hold: number }) {
  homes.push(home);
  const app = new App({ home, userHome: home, quiet: true, providers: [ctx => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const assets = path.join(home, 'bundle');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), 'Sable web fixture');
  app.store.state.settings.webNetwork = WEB_TAILSCALE;
  const networks = [{ id: 'home/adapter/10.0.0.7', name: 'Home', address: '10.0.0.7' }];
  registerPhone(app, { port: 0, host: '127.0.0.1', web: { assets, loopback: true, port: 0, tailscalePort: 0, networks: () => networks, tailscale: f.cli, ...(lookTimes ? { lookTimes } : {}) } });
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
  const run = broken.cli.run;
  broken.cli = { ...broken.cli, run: async (args: string[]) => { if (args.includes('--bg')) throw Error('Access denied: C:\\Users\\someone\\secret'); return run(args); } };
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

it('pairs a browser over Tailscale with the desktop’s Allow, at https://<name>/, and shows its tailnet address', async () => {
  const { app, f } = fixture();
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await app.call('web.state', {});
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
  expect((await app.call('web.state', {})).devices.map(d => d.name)).toEqual(['iPad · Safari']);
  ws.close();
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
  expect(existsSync(path.join(home, 'web', 'tailscale.json'))).toBe(false);
  expect(forbidden(f.calls)).toEqual([]);
});

it('a run that ended without withdrawing is cleaned up at the next start, and an entry removed outside Sable stops it', async () => {
  const f = fakeCli();
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-ts-'));
  // What a crashed run left: its record and its entry.
  await new TailscaleServe(f.cli, path.join(home, 'web', 'tailscale.json')).publish(NAME, 'http://127.0.0.1:47999');
  // Web access is off at this start: the leftover is withdrawn all the same (only because a record names it).
  fixture(f, home);
  await vi.waitFor(() => expect(f.target()).toBeUndefined());
  expect(existsSync(path.join(home, 'web', 'tailscale.json'))).toBe(false);

  const g = fakeCli();
  const second = fixture(g, undefined, { fresh: 300, idle: 300, hold: 120_000 });
  await second.app.call('app.setSettings', { patch: { webRemote: true } });
  expect((await second.app.call('web.state', {})).listening).toBe(true);
  // The owner removes it with Tailscale's own commands: the next look stops the listener and says so.
  g.config = {};
  const state = new Promise<WebState>(resolve => { const off = second.app.subscribe(e => { if (e.type === 'web.updated' && !e.state.listening) { off(); resolve(e.state); } }); });
  const s = await state;
  expect(s.error).toBe(TS_WORDS.gone);
  // Not published again by itself.
  await new Promise(r => setTimeout(r, 1200));
  expect(g.target()).toBeUndefined();
  expect(changing(g.calls).filter(c => c.includes('off'))).toEqual([]);
});
