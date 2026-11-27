import { restoreWebAcl } from './web-acl-fixture';
import * as containment from '../server/core/contain';
import { rmdirSync, unlinkSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { connect } from 'node:net';
import https from 'node:https';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import ts from 'typescript';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { runSubAgent } from '../server/core/sub-agent';
import { CodexProvider } from '../server/providers/codex';
import type { ToolItem, PhoneTail } from '../shared/protocol';
import { App, type AppOptions } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { WEB_METHODS, type WebState } from '../shared/protocol';
import type { WebOptions } from '../server/services/web-remote';
import { pskOfKey, pskOfToken, startHandshake } from '../mobile/src/lib/secure';
import { beside, fingerprintIn, handshake, keyOf, pairSecure, wireClient } from './phone-wire';

// The real Windows key checks (PowerShell per key read, see web-cert.test.ts) make each listener start
// take seconds outside the ACL fixture.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const clearance = vi.hoisted(() => ({ ships: true }));
vi.mock('../shared/protocol', async original => ({ ...await original<typeof import('../shared/protocol')>(), get WEB_SHIPS() { return clearance.ships; } }));
const homes: string[] = [], apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) { restoreWebAcl(home); rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  clearance.ships = true;
  vi.restoreAllMocks();
});
function fixture(ports: Pick<WebOptions, 'port' | 'showSave' | 'networks' | 'lookTimes'> = {}, existingHome?: string, extra: AppOptions['providers'] = []) {
  const home = existingHome ?? mkdtempSync(path.join(process.env.TEMP!, 'web-test-'));
  if (!existingHome) homes.push(home);
  let release!: () => void;
  const barrier = new Promise<void>(r => release = r);
  const delay = { on: false }, sent: string[] = [];
  const app = new App({ home, userHome: home, quiet: true, providers: [...extra, ctx => {
    const demo = new DemoProvider(ctx, { speed: 0 });
    const open = demo.open.bind(demo);
    demo.open = async (rt, opts) => {
      if (delay.on) await barrier;
      const handle = await open(rt, opts);
      const send = handle.send.bind(handle);
      handle.send = async m => { sent.push(m.text); return send(m); };
      return handle;
    };
    return demo;
  }] });
  apps.push(app);
  const assets = path.join(home, 'bundle');
  mkdirSync(assets, { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), 'Sable web fixture');
  const networks = [{ id: 'home/adapter/10.0.0.7', name: 'Home', address: '10.0.0.7' }];
  app.store.state.settings.webNetwork = networks[0].id;
  registerPhone(app, { port: 0, host: '127.0.0.1', web: { assets, loopback: true, port: 0, networks: () => networks, ...ports } });
  return { app, home, assets, delay, sent, release, networks };
}
async function setup(f = fixture()) {
  await f.app.call('app.setSettings', { patch: { webRemote: true } });
  const s = await f.app.call('web.state', {});
  expect(s.error).toBeUndefined();
  expect(s.listening).toBe(true);
  const ca = new X509Certificate(readFileSync(path.join(f.home, 'web/ca.cer')));
  const host = s.hostname + ':' + s.port;
  const ws = (origin: string | null = 'https://' + host, authority = host, route = '/sable-web') =>
    new WebSocket('wss://127.0.0.1:' + s.port + route, { ...{ servername: s.hostname }, ca: ca.toString(), headers: { Host: authority, ...(origin && { Origin: origin }) } });
  const wire = () => wireClient(s.port!, null, ws());
  const offer = async () => {
    const link = new URL((await f.app.call('web.offer', {})).pairing!.link);
    expect(link.origin + link.pathname).toBe('https://10.0.0.7:' + s.port + '/');
    expect(link.search).toBe('');
    const q = new URLSearchParams(link.hash.slice(1));
    return { key: q.get('p')!, fp: q.get('f')! };
  };
  const pair = async () => {
    const { key, fp } = await offer();
    const c = wire();
    expect(await handshake(c, 'pair', fp, pskOfKey(key))).toEqual({});
    c.send({ pair: { key, name: 'Test iPad' } });
    await c.next(f => !!f.waiting);
    const request = (await f.app.call('web.state', {})).request!;
    await f.app.call('web.approve', { requestId: request.id, allow: true });
    const { paired } = await c.next(f => !!f.paired);
    await c.next(f => !!f.welcome);
    return { c, fp, key, ...paired as { token: string; deviceId: string } };
  };
  return { ...f, s, ws, host, ca, wire, offer, pair };
}

it('both gates are required, including for offers, CA creation and pending listener startup', async () => {
  const reserve = async () => {
    const server = http.createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return server;
  };
  const reserved = await reserve();
  const port = (reserved.address() as { port: number }).port;
  await new Promise<void>(r => reserved.close(() => r()));
  const absent = async () => {
    await expect(new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  };
  const { app, home } = fixture({ port });
  await absent();
  await expect(app.call('web.offer', {})).rejects.toThrow(/off/);
  expect((await app.call('web.state', {})).listening).toBe(false);
  clearance.ships = false;
  await expect(app.call('web.state', {})).rejects.toThrow(/off/);
  await expect(app.call('web.revoke', { deviceId: 'unknown' })).rejects.toThrow(/off/);
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await expect(app.call('web.offer', {})).rejects.toThrow(/off/);
  expect(existsSync(path.join(home, 'web'))).toBe(false);
  await absent();
  clearance.ships = true;
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await app.call('app.setSettings', { patch: { webRemote: false } });
  expect((await app.call('web.state', {})).listening).toBe(false);
  await absent();
});

it('chooses a free HTTPS port and releases it on dispose', async () => {
  const busy = http.createServer();
  await new Promise<void>(r => busy.listen(0, '127.0.0.1', r));
  try {
    const base = (busy.address() as { port: number }).port;
    const h = fixture({ port: base });
    await h.app.call('app.setSettings', { patch: { webRemote: true } });
    const state = await h.app.call('web.state', {});
    expect(state.error).toBeUndefined();
    expect(state.port).toBeGreaterThan(base);
    expect(state.port).toBeLessThanOrEqual(base + 10);
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const replacement = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => replacement.once('error', reject).listen(state.port, '127.0.0.1', resolve));
    } finally { await new Promise<void>(r => replacement.close(() => r())); }
  } finally { await new Promise<void>(r => busy.close(() => r())); }
});

it('saves the public root where the person picks, gives the address as a QR code and says when the client is missing', async () => {
  // Before web access ever started there is no root to save.
  expect(await fixture().app.call('web.saveCa', {})).toEqual({ ok: false, missing: true });
  let offered: string | undefined;
  const picked: { file?: string } = {};
  const h = await setup(fixture({ showSave: async (p) => { offered = p; return picked.file; } }));
  picked.file = path.join(h.home, 'saved.cer');
  expect(await h.app.call('web.saveCa', {})).toEqual({ ok: true, path: picked.file });
  expect(readFileSync(picked.file)).toEqual(h.ca.raw);
  expect(path.basename(offered!)).toBe('Sable certificate.cer');
  picked.file = undefined;
  expect(await h.app.call('web.saveCa', {})).toEqual({ ok: false, canceled: true });
  const s = await h.app.call('web.state', {});
  expect(s.assets).toBe(true);
  expect(s.addressQr).toMatchObject({ link: 'https://10.0.0.7:' + s.port + '/', size: expect.any(Number) });
  expect(s.addressQr!.qr).toMatch(/^M/);
  // No desktop shell (a test runs in plain Node): the window downloads the bytes itself.
  expect(process.versions.electron).toBeUndefined();
  const bare = await setup();
  expect(await bare.app.call('web.saveCa', {})).toEqual({ ok: false, unsupported: true, der: bare.ca.raw.toString('base64') });
  // A build without the web client: web.state says so, and turning web access on starts nothing.
  rmSync(path.join(bare.assets, 'index.html'));
  expect((await bare.app.call('web.state', {})).assets).toBe(false);
  const missing = fixture();
  rmSync(path.join(missing.assets, 'index.html'));
  await missing.app.call('app.setSettings', { patch: { webRemote: true } });
  const off = await missing.app.call('web.state', {});
  expect(off).toMatchObject({ listening: false, assets: false, error: 'Packaged web assets are unavailable.' });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** The page's own GET, as a tablet asks it: its status. */
function page(h: Awaited<ReturnType<typeof setup>>, route = '/') {
  return new Promise<number | undefined>((resolve, reject) => {
    https.get({ host: '127.0.0.1', path: route, servername: h.s.hostname, port: h.s.port, ca: h.ca.toString(), agent: false, headers: { Host: h.host } },
      res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}
/** A socket of the page's own: open, or the refusal's status. */
function upgrade(ws: WebSocket) {
  return new Promise<string>((resolve) => {
    ws.once('open', () => { resolve('open'); ws.close(); });
    ws.once('unexpected-response', (_q, r) => resolve(String(r.statusCode)));
    ws.once('error', () => resolve('error'));
  });
}

// Found by the first end-to-end run in the packaged app: every request and every upgrade waited for a fresh
// PowerShell look at the networks (5 to 17 s under load, failing 5 times in 12, and a failure refused it).
it('answers requests on the kept look at once, keeps its browsers through failing looks while the last good one holds, then stops and says why', async () => {
  const nets = [{ id: 'home/adapter/10.0.0.7', name: 'Home', address: '10.0.0.7' }];
  const inventory = { fail: false, slow: 0, runs: 0, ended: 0 };
  const h = await setup(fixture({ lookTimes: { fresh: 300, idle: 900, hold: 4000 }, networks: async () => {
    inventory.runs++;
    try {
      if (inventory.slow) await sleep(inventory.slow);
      if (inventory.fail) throw Error('Command failed: powershell.exe (timed out)');
      return nets;
    } finally { inventory.ended++; }
  } }));
  const p = await h.pair();
  let closed = false;
  void p.c.closed.then(() => { closed = true; });
  // A look that takes a second holds no request: the kept look answers, the new look runs behind it.
  inventory.slow = 1000;
  await sleep(350);
  const asked = performance.now();
  expect(await page(h)).toBe(200);
  expect(await upgrade(h.ws())).toBe('open');
  expect(performance.now() - asked).toBeLessThan(700);
  await vi.waitFor(() => expect(inventory.ended).toBe(inventory.runs), { timeout: 5000 });
  inventory.slow = 0;
  // Looks fail from now on: nothing changes while the last good look holds (two minutes; 4 s here).
  inventory.fail = true;
  const failing = inventory.runs;
  await sleep(700);
  expect(inventory.runs).toBeGreaterThan(failing);
  const held = await h.app.call('web.state', {});
  expect(held).toMatchObject({ listening: true, port: h.s.port, error: undefined });
  expect(held.clients.map(c => c.id)).toEqual([p.deviceId]);
  expect(closed).toBe(false);
  expect(await page(h)).toBe(200);
  // Then the listener stops, its browsers go, and web.state says why.
  await vi.waitFor(async () => expect((await h.app.call('web.state', {})).listening).toBe(false), { timeout: 8000, interval: 100 });
  expect((await h.app.call('web.state', {})).error).toMatch(/Could not read this computer’s networks for two minutes/);
  await p.c.closed;
  // A look that succeeds again starts it again.
  inventory.fail = false;
  await vi.waitFor(async () => expect((await h.app.call('web.state', {})).listening).toBe(true), { timeout: 8000, interval: 100 });
  expect((await h.app.call('web.state', {})).error).toBeUndefined();
});

it('runs nothing while off, a look at most once per idle period at rest, and one per fresh period while a browser is connected', async () => {
  let runs = 0;
  const nets = [{ id: 'home/adapter/10.0.0.7', name: 'Home', address: '10.0.0.7' }];
  const f = fixture({ lookTimes: { fresh: 100, idle: 1000, hold: 60_000 }, networks: () => { runs++; return nets; } });
  await sleep(1200);
  expect(runs).toBe(0);
  const h = await setup(f);
  // The start's look, and the one Settings' first read asks for when the start took longer than `fresh`.
  await sleep(200);
  const on = runs;
  expect(on).toBeGreaterThanOrEqual(1);
  expect(on).toBeLessThanOrEqual(3);
  // At rest: once per idle period (it would be thirty times at the connected pace).
  await sleep(3000);
  expect(runs - on).toBeGreaterThanOrEqual(2);
  expect(runs - on).toBeLessThanOrEqual(4);
  const p = await h.pair();
  const paired = runs;
  await sleep(1000);
  expect(runs - paired).toBeGreaterThanOrEqual(4);
  expect(runs - paired).toBeLessThanOrEqual(11);
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  await p.c.closed;
  const off = runs;
  await sleep(1500);
  expect(runs).toBe(off);
});

it('serves only contained assets and the public CA, requires the exact Host, GET, upgrade route and Origin', async () => {
  const { ws, host, ca, s, home, assets } = await setup();
  const get = (route: string, plain = false, authority?: string, method = 'GET') => new Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const port = s.port;
    (plain ? http : https).request({ host: '127.0.0.1', port, servername: s.hostname, ca: ca.toString(), method, path: route,
      agent: false, headers: { Host: authority ?? s.hostname + ':' + port } }, res => {
      const bytes: Buffer[] = []; res.on('data', b => bytes.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bytes) }));
    }).on('error', reject).end();
  });
  const index = await get('/');
  expect(index.body.toString()).toBe('Sable web fixture');
  await expect(get('/ca.cer', true)).rejects.toThrow();
  const caResponse = await get('/ca.cer');
  expect((await get('/ca.cer')).body).toEqual(ca.raw);
  const wrong = await get('/ca.cer', false, 'outside.example:' + s.port);
  expect(wrong.status).toBe(403);
  expect((await get('/', false, host, 'POST')).status).toBe(403);
  for (const response of [index, caResponse, wrong]) {
    expect(response.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).not.toMatch(/unsafe-/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toBeTruthy();
  }
  const outside = path.join(home, 'outside');
  mkdirSync(outside); writeFileSync(path.join(outside, 'secret.js'), 'private');
  linkSync(path.join(outside, 'secret.js'), path.join(assets, 'link.js'));
  symlinkSync(outside, path.join(assets, 'linked'), 'junction');
  for (const route of ['/__sable', '/custom/styles.css', '/sable-phone', '/%2e%2e/outside/secret.js', '/linked/secret.js', '/link.js', '/ca-key.pem'])
    expect((await get(route)).status, route).toBe(404);
  async function refused(socket: WebSocket) {
    return new Promise<number | undefined>((resolve, reject) => {
      socket.once('open', () => { socket.close(); reject(Error('Upgrade succeeded')); });
      socket.once('error', reject);
      socket.once('unexpected-response', (req, res) => { res.resume(); req.destroy(); resolve(res.statusCode); });
    });
  }
  for (const socket of [ws(null), ws('null'), ws('http://' + host), ws('https://' + host + '/'), ws('https://outside.example'),
    ws('https://outside.example', 'outside.example'), ws(undefined, host, '/__sable'), ws(undefined, host, '/sable-phone')]) expect(await refused(socket)).toBe(403);
});

it('accepts a web offer once, refuses expired offers, plain frames and sealed replays', async () => {
  const h = await setup();
  const expired = await h.offer();
  const real = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => real + 601_000);
  expect((await handshake(h.wire(), 'pair', expired.fp, pskOfKey(expired.key))).denied).toBeTruthy();
  vi.restoreAllMocks();
  const plain = h.wire();
  await plain.open; plain.send({ hello: { token: 'legacy' } });
  expect(await plain.closed).toBe(4003);
  const downgrade = h.wire();
  await downgrade.open;
  const hello = JSON.parse((await startHandshake('pair')).first);
  hello.sec.v = 1;
  downgrade.send(hello);
  expect(await downgrade.closed).toBe(4003);
  const p = await h.pair();
  expect((await handshake(h.wire(), 'pair', p.fp, pskOfKey(p.key))).denied).toBeTruthy();
  expect((await p.c.call('app.hello')).ok).toBe(true);
  p.c.ws.send(p.c.sent.at(-1)!);
  expect(await p.c.closed).toBe(4005);
});

it('web and phone credentials and pairing offers cannot cross transports', async () => {
  const h = await setup();
  const { port } = await h.app.call('phone.setEnabled', { on: true });
  const w = await h.pair(), p = await pairSecure(h.app, port);
  expect((await h.app.call('web.state', {})).clients).toEqual([{ id: w.deviceId, label: 'Test iPad', since: expect.any(Number) }]);
  expect((await handshake(h.wire(), 'hello', p.fingerprint, await pskOfToken(p.token), p.deviceId)).denied).toBeTruthy();
  expect((await handshake(wireClient(port), 'hello', w.fp, await pskOfToken(w.token), w.deviceId)).denied).toBeTruthy();
  const wo = await h.offer();
  expect((await handshake(wireClient(port), 'pair', wo.fp, pskOfKey(wo.key))).denied).toBeTruthy();
  await h.app.call('web.offer', { cancel: true });
  const po = await h.app.call('phone.pair', {});
  expect((await handshake(h.wire(), 'pair', fingerprintIn(po), pskOfKey(keyOf(po)))).denied).toBeTruthy();
  expect((await p.c.call('web.state')).error).toMatch(/Not available/);
  await w.c.call('app.hello');
  for (const wire of [w.c, p.c]) expect(JSON.stringify(wire.frames)).not.toContain(wo.key);
});

it('dispatches exactly the reviewed browser methods over the entire RPC and phone contract', async () => {
  const { c } = await (await setup()).pair();
  const allowed = ['app.hello', 'session.snapshot', 'session.send', 'session.submission', 'session.interrupt',
    'permission.respond', 'question.respond', 'phone.tail', 'phone.item',
    'phone.queue', 'phone.changes', 'phone.diff', 'phone.search', 'phone.image', 'phone.answer', 'phone.steerNow',
    'phone.sessions', 'phone.prompts'];
  expect([...WEB_METHODS].sort()).toEqual(allowed.sort());
  const file = ts.createSourceFile('protocol.ts', readFileSync('shared/protocol.ts', 'utf8'), ts.ScriptTarget.Latest);
  const names = file.statements.filter(ts.isInterfaceDeclaration).filter(i => ['RpcMethods', 'PhoneMethods'].includes(i.name.text))
    .flatMap(i => i.members.map(m => (m.name as ts.StringLiteral).text));
  expect(names.length).toBeGreaterThan(160);
  for (const method of [...names, '__proto__', 'unlisted.method']) {
    const r = await c.call(method);
    expect(r.error?.startsWith('Not available from the browser:') ?? false, method).toBe(!allowed.includes(method));
  }
}, 20_000);

it.each(['mode change', 'revocation'])('rechecks a delayed steer at provider delivery after %s', async change => {
  const h = await setup();
  const p = await h.pair();
  h.delay.on = true;
  const snap = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'default' });
  const rt = h.app.runtime(snap.session.id);
  const send = p.c.call('session.send', { sessionId: rt.id, text: 'delayed input', steer: true }).catch(() => undefined);
  await vi.waitFor(() => expect(rt.items.some(i => i.type === 'user')).toBe(true));
  if (change === 'revocation') {
    const other = h.wire();
    await handshake(other, 'hello', p.fp, await pskOfToken(p.token), p.deviceId);
    other.send({ hello: { token: p.token } });
    await other.next(f => !!f.welcome);
    await h.app.call('web.revoke', { deviceId: p.deviceId });
    expect(await Promise.all([p.c.closed, other.closed])).toEqual([4001, 4001]);
  } else rt.update({ mode: 'bypassPermissions' });
  h.release();
  await vi.waitFor(() => expect(rt.handle).toBeDefined());
  if (change === 'mode change') expect((await send)?.error).toMatch(/runs without asking/i);
  await vi.waitFor(() => expect(rt.items.some(i => i.type === 'user')).toBe(false));
  expect(h.sent).toEqual([]);
});

it('keeps a receipted browser queue entry bound to its sender and current chat mode', async () => {
  const h = await setup(), p = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'default' });
  const rt = h.app.runtime(session.id);
  rt.beginTurn();
  expect((await p.c.call('session.send', { sessionId: rt.id, text: 'queued input', submitId: 'web-row' })).result).toMatchObject({ ok: true, queued: true });
  const entry = rt.queue[0];
  expect(entry.phoneSender).toMatchObject({ kind: 'web', deviceId: p.deviceId });
  rt.update({ mode: 'bypassPermissions' });
  rt.endTurn();
  const deliver = () => h.app.call('queue.sendNow', { sessionId: rt.id, id: entry.id });
  await expect(deliver()).rejects.toThrow(/runs without asking/);
  await h.app.call('web.revoke', { deviceId: p.deviceId });
  await h.app.call('app.setSettings', { patch: { webSteerDanger: true } });
  await expect(deliver()).rejects.toThrow(/Web access was removed/);
  expect(h.sent).toEqual([]);
});

it('reads Bypass, refuses messages, steers and prompt answers until the desktop permits steering', async () => {
  const h = await setup(), p = await h.pair();
  const snap = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'bypassPermissions' });
  const sessionId = snap.session.id;
  expect((await p.c.call('phone.tail', { sessionId })).ok).toBe(true);
  for (const m of ['session.send', 'session.interrupt', 'phone.steerNow', 'permission.respond', 'question.respond', 'phone.answer']) {
    expect((await p.c.call(m, { sessionId, text: 'hello', steer: true })).error).toMatch(/runs without asking/);
  }
  await h.app.call('app.setSettings', { patch: { webSteerDanger: true } });
  expect((await p.c.call('session.send', { sessionId, text: 'hello', steer: true })).ok).toBe(true);
  expect(h.sent).toEqual(['hello']);
  const states: WebState[] = [];
  h.app.subscribe(e => { if (e.type === 'web.updated') states.push(e.state); });
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  await p.c.closed;
  expect(states.at(-1)?.listening).toBe(false);
  expect(states.at(-1)?.clients).toEqual([]);
  await expect(h.wire().open).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});


it('holds browser input after the desktop lowers a running native Full access turn to Ask', async () => {
  const calls: string[] = [];
  const f = fixture({}, undefined, [ctx => {
    const provider = new CodexProvider(ctx);
    Object.assign(provider, {
      version: async () => ({ installed: true, version: 'test' }),
      caps: async () => ({ models: [{ id: 'm', name: 'M' }], modes: [
        { id: 'default', name: 'Ask', tone: 'ask' }, { id: 'full-access', name: 'Full access', tone: 'danger' },
      ], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } }),
      client: async () => ({ request: async (method: string) => {
        calls.push(method);
        if (method === 'thread/start') return { thread: { id: 'thread1' }, model: 'm' };
        if (method === 'turn/start') return { turn: { id: 'turn1' } };
        return {};
      } }),
    });
    return provider;
  }]);
  const h = await setup(f), { c } = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'codex', mode: 'full-access', model: 'm', cwd: beside(h.home) });
  const sessionId = session.id;
  await h.app.call('session.send', { sessionId, text: 'desktop input' });
  expect(calls).toContain('turn/start');
  await h.app.call('session.setMode', { sessionId, mode: 'default' });
  expect(h.app.runtime(sessionId).turnActive).toBe(true);
  for (const text of ['next message', '/compact', '/review']) {
    expect((await c.call('session.send', { sessionId, text, steer: true })).error).toMatch(/effective turn policy/);
  }
  expect(calls).not.toContain('turn/steer');
  expect(calls).not.toContain('review/start');
  expect(calls).not.toContain('thread/compact/start');
});

it('leaves a higher-authority child question pending after the parent switches to Ask', async () => {
  const h = await setup(), { c } = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', mode: 'bypassPermissions', cwd: beside(h.home) });
  const rt = h.app.runtime(session.id);
  const row = rt.add<ToolItem>({ type: 'tool', kind: 'agent', name: 'delegate', title: 'Delegate', status: 'running', detail: {} });
  const provider = h.app.provider('demo');
  const open = provider.open.bind(provider);
  const childOpen = vi.spyOn(provider, 'open').mockImplementation(async (child, opts) => {
    const handle = await open(child, opts);
    handle.send = async () => {
      expect(child.workMode).toBe('bypassPermissions');
      child.beginTurn();
      await child.ask([{ question: 'Continue?', options: [{ label: 'Yes' }] }]);
      child.endTurn();
    };
    return handle;
  });
  const running = runSubAgent({ provider: () => provider, accountFor: () => undefined, defaultModel: () => undefined,
    modeFor: (_, parentMode) => parentMode, log() {} }, rt, { agent: 'demo', description: 'Delegate', prompt: 'Ask a question' }, row.id);
  try {
    await vi.waitFor(() => expect(rt.prompts().questions).toHaveLength(1));
    await h.app.call('session.setMode', { sessionId: rt.id, mode: 'default' });
    const requestId = rt.prompts().questions[0].id;
    for (const method of ['question.respond','phone.answer']) {
      expect((await c.call(method, { sessionId: rt.id, requestId, answers: { 'Continue?': ['Yes'] } })).error).toMatch(/delegated/);
    }
    expect(rt.prompts().questions[0].id).toBe(requestId);
  } finally { rt.cancelPrompts(); await running; childOpen.mockRestore(); }
});

it('exposes chat fields only on hello, pages, snapshots and live updates', async () => {
  const h = await setup(), { c } = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'default' });
  const rt = h.app.runtime(session.id);
  const remote = { url: 'https://private.example/control-link', code: 'provider-pairing-secret', status: 'ready' };
  await h.app.call('app.setSettings', { patch: { defaultModels: { demo: 'private-default-model' } } });
  h.app.emit({ type: 'projects.updated', projects: [{ path: 'private-project-path', name: 'private-project-name', lastOpened: 0 }] });
  rt.update({ remote, accountId: 'private-account-dir' });
  h.app.emit({ type: 'toast', text: 'private-desktop-toast', level: 'info' });
  h.app.emit({ type: 'suggestion', sessionId: rt.id, text: 'unopened-suggestion' });
  rt.enqueue('unopened-queue');
  const hello = (await c.call('app.hello')).result;
  expect(hello).toMatchObject({ settings: {}, providers: [], projects: [], sessions: [{ id: rt.id, cwd: '' }] });
  // Exactly the empty maps the client indexes by agent (it crashed on a bare {}), nothing of the desktop's.
  expect((hello as { settings: unknown }).settings).toEqual({ defaultModels: {}, defaultEfforts: {}, defaultModes: {} });
  expect(JSON.stringify(c.frames)).not.toContain('unopened-queue');
  for (const method of ['phone.sessions','session.snapshot','phone.tail']) expect((await c.call(method, { sessionId: rt.id })).ok).toBe(true);
  rt.update({ remote: { ...remote, status: 'connected' } });
  await c.call('app.hello');
  for (const marker of [remote.code, remote.url, 'private-account-dir','private-project-path','private-default-model','private-desktop-toast','unopened-suggestion',h.home])
    expect(JSON.stringify(c.frames)).not.toContain(marker);
  expect((await c.call('phone.prompts')).ok).toBe(false);
});

it('requires this socket’s current permission revision and only a one-time decision', async () => {
  const h = await setup(), p = await h.pair(), other = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'default' });
  const rt = h.app.runtime(session.id);
  const answer = rt.requestPermission({ toolName: 'Edit', kind: 'edit', detail: {}, title: 'One change', options: [
    { id: 'allow', label: 'Allow once', tone: 'allow' }, { id: 'always', label: 'Always', tone: 'always' },
    { id: 'plan-ask', label: 'Change mode', tone: 'allow' }] });
  const view = async () => ((await p.c.call('phone.tail', { sessionId: rt.id })).result as PhoneTail).permissions[0];
  const first = await view();
  expect(first.options.map(o => o.id)).toEqual(['allow']);
  const params = { sessionId: rt.id, requestId: first.id, revision: first.revision, optionId: 'allow' };
  expect((await other.c.call('permission.respond', params)).ok).toBe(false);
  for (const optionId of ['always','plan-ask']) expect((await p.c.call('permission.respond', { ...params, optionId })).ok).toBe(false);
  rt.prompts().permissions[0].title = 'Revised change';
  expect((await p.c.call('permission.respond', params)).ok).toBe(false);
  const revision = (await view()).revision;
  expect(revision).not.toBe(first.revision);
  expect((await p.c.call('permission.respond', { ...params, revision })).ok).toBe(true);
  expect(await answer).toMatchObject({ optionId: 'allow' });
});

it('refuses bridge and native slash commands before interpreting or queueing them', async () => {
  const h = await setup(), { c } = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', cwd: beside(h.home), mode: 'default' });
  const rt = h.app.runtime(session.id), model = rt.meta.model;
  const retry = '87654321-1234-1234-1234-123456789012';
  const row = rt.add<ToolItem>({ type: 'tool', kind: 'agent', title: 'Report', name: 'delegate', detail: {}, status: 'done',
    delegateReport: 'pending', delegateAttempt: { provider: 'demo', session: rt.id }, delegateReceiptState: 'unknown', delegateRetryId: retry });
  rt.stopRequested = true;
  for (const text of [' /MODEL another-agent', '/report-retry '+retry, '/review','/compact','/customize','/until','/race','/spare'])
    expect((await c.call('session.send', { sessionId: rt.id, text, steer: true })).error).toMatch(/slash commands/);
  expect(row.delegateReceiptState).toBe('unknown');
  expect(rt.meta.model).toBe(model);
  expect(rt.stopRequested).toBe(true);
  expect(rt.queue).toEqual([]);
  expect(h.sent).toEqual([]);
});

it.each([true, false])('keeps offline revoke effective across restart with registry write failure %s', async fail => {
  const h = await setup(), p = await h.pair();
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  await p.c.closed;
  expect((await h.app.call('web.state', {})).devices[0].id).toBe(p.deviceId);
  const tmp = path.join(h.home, 'web', 'pairings.json.tmp');
  if (fail) mkdirSync(tmp);
  const state = await h.app.call('web.revoke', { deviceId: p.deviceId });
  expect(state.revocationDurable).toBe(!fail);
  expect(state.devices).toEqual([]);
  await h.app.dispose();
  apps.splice(apps.indexOf(h.app), 1);
  if (fail) rmdirSync(tmp);
  const restarted = await setup(fixture({}, h.home));
  expect((await handshake(restarted.wire(), 'hello', p.fp, await pskOfToken(p.token), p.deviceId)).denied).toBeTruthy();
});

it('requires a selected network, and stops within one fresh period when it changes, also to another network on the same adapter and IP', async () => {
  // Looks every 500 ms while a browser is connected (30 s in the app: web-look.test.ts), every 5 s at rest.
  const f = fixture({ lookTimes: { fresh: 500, idle: 5000, hold: 10_000 } });
  delete f.app.store.state.settings.webNetwork;
  await f.app.call('app.setSettings', { patch: { webRemote: true } });
  const initial = await f.app.call('web.state', {});
  expect(initial.listening).toBe(false);
  expect(initial.networks).toEqual(f.networks);
  f.networks.push({ id: 'vpn', address: '10.1.0.7', name: 'VPN' });
  await f.app.call('app.setSettings', { patch: { webNetwork: f.networks[0].id } });
  const h = await setup(f), p = await h.pair();
  expect(h.s.addresses).toEqual(['10.0.0.7']);
  const changed = performance.now();
  f.networks[0] = { ...f.networks[0], id: 'hotel/adapter/10.0.0.7' };
  await p.c.closed;
  // Seen by the next look while connected (500 ms), not the one at rest (5 s).
  expect(performance.now() - changed).toBeLessThan(2500);
  const s = await f.app.call('web.state', {});
  expect(s.listening).toBe(false);
  expect(s.error).toMatch(/selected home network changed/);
  await expect(h.wire().open).rejects.toThrow();
});

it('notices the change at the first request after a rest, before the next look at rest is due', async () => {
  const f = fixture({ lookTimes: { fresh: 300, idle: 60_000, hold: 120_000 } });
  const h = await setup(f);
  await sleep(400);
  f.networks[0] = { ...f.networks[0], id: 'hotel/adapter/10.0.0.7' };
  // Admitted on the kept look, which is older than 300 ms: a look runs behind it at once and stops the
  // listener (which may cut this very request off).
  await page(h).catch(() => undefined);
  await vi.waitFor(async () => expect((await f.app.call('web.state', {})).listening).toBe(false), { timeout: 3000, interval: 50 });
  await expect(page(h)).rejects.toThrow();
});

it.each([true, false])('invalidates pending desktop approval when an offer is cancelled or replaced (%s)', async cancel => {
  const h = await setup(), { key, fp } = await h.offer(), c = h.wire();
  await handshake(c, 'pair', fp, pskOfKey(key));
  c.send({ pair: { key, name: 'Test tablet' } });
  await c.next(f => !!f.waiting);
  const request = (await h.app.call('web.state', {})).request!;
  await h.app.call('web.offer', { cancel });
  expect((await h.app.call('web.approve', { requestId: request.id, allow: true })).devices).toEqual([]);
  await c.closed;
  expect(c.frames.some(f => !!f.paired)).toBe(false);
});

it('closes web ingress before a delayed shutdown checkpoint', async () => {
  const h = await setup(), p = await h.pair();
  let finish!: () => void;
  const held = new Promise<void>(r => finish = r);
  const seal = h.app.store.seal.bind(h.app.store);
  vi.spyOn(h.app.store, 'seal').mockImplementation(async () => { await held; return seal(); });
  const quitting = h.app.dispose();
  h.app.emit({ type: 'session.removed', id: 'shutdown-marker' });
  try {
    await p.c.closed;
    await expect(h.wire().open).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(p.c.frames.some(f => f.event && JSON.stringify(f).includes('shutdown-marker'))).toBe(false);
  } finally { finish(); await quitting; apps.splice(apps.indexOf(h.app), 1); }
});

it('reports root replacement in desktop state after losing the issuer between activations', async () => {
  const h = await setup();
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  unlinkSync(path.join(h.home, 'web', 'issuer.json'));
  await h.app.call('app.setSettings', { patch: { webRemote: true } });
  const state = await h.app.call('web.state', {});
  expect(state.caFingerprint).not.toBe(h.s.caFingerprint);
  expect(state.caReplacement).toMatch(/install the new root/i);
});

it('bounds incomplete TLS connections before pairing', async () => {
  const h = await setup();
  const held = [];
  try {
    for (let i = 0; i < 24; i++) {
      const socket = connect(h.s.port!, '127.0.0.1');
      held.push(socket);
      await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
    }
    const overflow = connect(h.s.port!, '127.0.0.1');
    await new Promise<void>(resolve => overflow.once('close', resolve).once('error', () => {}));
  } finally { for (const socket of held) socket.destroy(); }
});

it('bounds simultaneous static asset reads before pairing', async () => {
  const h = await setup();
  const original = containment.openContained;
  let release!: () => void;
  const barrier = new Promise<void>(r => release = r);
  const pending = vi.spyOn(containment, 'openContained').mockImplementation(async (...args) => {
    await barrier;
    return original(...args);
  });
  const get = () => new Promise<number | undefined>((resolve, reject) => {
    https.get({ host: '127.0.0.1', servername: h.s.hostname, port: h.s.port, ca: h.ca.toString(), agent: false, headers: { Host: h.host } },
      res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
  const inFlight = Promise.allSettled(Array.from({ length: 4 }, get));
  let waited: Promise<PromiseSettledResult<number | undefined>[]>;
  try {
    await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(4));
    // More wait for a free read (a page loads its script, styles and fonts at once), never read beside the four.
    waited = Promise.allSettled(Array.from({ length: 16 }, get));
    await new Promise(r => setTimeout(r, 1500));
    expect(pending).toHaveBeenCalledTimes(4);
    // Past sixteen waiting: refused at once.
    expect(await get()).toBe(503);
  } finally { release(); pending.mockRestore(); }
  expect(await inFlight).toEqual(Array(4).fill({ status: 'fulfilled', value: 200 }));
  expect(await waited!).toEqual(Array(16).fill({ status: 'fulfilled', value: 200 }));
});

it('drops queued authority on restart when disabling could not save its generation', async () => {
  const h = await setup(), p = await h.pair();
  const { session } = await h.app.call('session.create', { provider: 'demo', mode: 'default', cwd: beside(h.home) });
  const rt = h.app.runtime(session.id);
  rt.beginTurn();
  expect((await p.c.call('session.send', { sessionId: rt.id, text: 'held before disable', submitId: 'generation' })).result)
    .toMatchObject({ queued: true });
  const entry = rt.queue[0];
  const tmp = path.join(h.home, 'web', 'pairings.json.tmp');
  mkdirSync(tmp);
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  expect((await h.app.call('web.state', {})).revocationDurable).toBe(false);
  await h.app.dispose();
  apps.splice(apps.indexOf(h.app), 1);
  rmdirSync(tmp);
  const restarted = await setup(fixture({}, h.home));
  expect(restarted.app.webSenderRefusal!(entry.phoneSender!, session.id)).toMatch(/removed/);
  await restarted.app.call('session.snapshot', { sessionId: session.id });
  await expect(restarted.app.call('queue.sendNow', { sessionId: session.id, id: entry.id })).rejects.toThrow(/removed/);
  expect(restarted.sent).toEqual([]);
});

it('lists and revokes a saved device on a clean offline restart', async () => {
  const h = await setup(), p = await h.pair();
  await h.app.call('app.setSettings', { patch: { webRemote: false } });
  await h.app.dispose();
  apps.splice(apps.indexOf(h.app), 1);
  const f = fixture({}, h.home);
  const offline = await f.app.call('web.state', {});
  expect(offline).toMatchObject({ listening: false, devices: [{ id: p.deviceId }] });
  expect((await f.app.call('web.revoke', { deviceId: p.deviceId })).revocationDurable).toBe(true);
  const reopened = await setup(f);
  expect((await handshake(reopened.wire(), 'hello', p.fp, await pskOfToken(p.token), p.deviceId)).denied).toBeTruthy();
});
