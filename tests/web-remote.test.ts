import './web-acl-fixture';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { connect } from 'node:net';
import https from 'node:https';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import ts from 'typescript';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { WEB_METHODS, type WebState } from '../shared/protocol';
import { pskOfKey, pskOfToken, startHandshake } from '../mobile/src/lib/secure';
import { beside, fingerprintIn, handshake, keyOf, pairSecure, wireClient } from './phone-wire';

const clearance = vi.hoisted(() => ({ ships: true }));
vi.mock('../shared/protocol', async original => ({ ...await original<typeof import('../shared/protocol')>(), get WEB_SHIPS() { return clearance.ships; } }));
const homes: string[] = [], apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  clearance.ships = true;
  vi.restoreAllMocks();
});
function fixture(ports: { port?: number; caPort?: number } = {}) {
  const home = mkdtempSync(path.join(process.env.TEMP!, 'web-test-'));
  homes.push(home);
  let release!: () => void;
  const barrier = new Promise<void>(r => release = r);
  const delay = { on: false }, sent: string[] = [];
  const app = new App({ home, quiet: true, providers: [ctx => {
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
  mkdirSync(assets);
  writeFileSync(path.join(assets, 'index.html'), 'Sable web fixture');
  registerPhone(app, { port: 0, host: '127.0.0.1', web: { assets, loopback: true, port: 0, caPort: 0, ...ports, addresses: () => ['10.0.0.7'] } });
  return { app, home, assets, delay, sent, release };
}
async function setup() {
  const f = fixture();
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
  const reserved = await Promise.all([reserve(), reserve()]);
  const [port, caPort] = reserved.map(s => (s.address() as { port: number }).port);
  await Promise.all(reserved.map(s => new Promise<void>(r => s.close(() => r()))));
  const absent = async () => {
    for (const p of [port, caPort]) await expect(new Promise<void>((resolve, reject) => {
      const socket = connect(p, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  };
  const { app, home } = fixture({ port, caPort });
  await absent();
  await expect(app.call('web.offer', {})).rejects.toThrow(/off/);
  await expect(app.call('web.state', {})).rejects.toThrow(/off/);
  clearance.ships = false;
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await expect(app.call('web.offer', {})).rejects.toThrow(/off/);
  expect(existsSync(path.join(home, 'web'))).toBe(false);
  await absent();
  clearance.ships = true;
  await app.call('app.setSettings', { patch: { webRemote: true } });
  await app.call('app.setSettings', { patch: { webRemote: false } });
  await expect(app.call('web.state', {})).rejects.toThrow(/off/);
  await absent();
});

it('chooses a free HTTPS port, keeps bootstrap separate, and releases both on dispose', async () => {
  const busy = http.createServer();
  await new Promise<void>(r => busy.listen(0, '127.0.0.1', r));
  try {
    const base = (busy.address() as { port: number }).port;
    const h = fixture({ port: base });
    await h.app.call('app.setSettings', { patch: { webRemote: true } });
    const state = await h.app.call('web.state', {});
    expect(state.port).toBeGreaterThan(base);
    expect(state.port).toBeLessThanOrEqual(base + 10);
    expect(state.caPort).not.toBe(state.port);
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    for (const port of [state.caPort, state.port]) {
      await expect(new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port }, resolve).on('error', reject)))
        .rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  } finally { await new Promise<void>(r => busy.close(() => r())); }
});

it('serves only contained assets and the public CA, requires the exact Host, GET, upgrade route and Origin', async () => {
  const { ws, host, ca, s, home, assets } = await setup();
  const get = (route: string, plain = false, authority?: string, method = 'GET') => new Promise<{ status?: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const port = plain ? s.caPort : s.port;
    (plain ? http : https).request({ host: '127.0.0.1', port, servername: s.hostname, ca: ca.toString(), method, path: route,
      agent: false, headers: { Host: authority ?? s.hostname + ':' + port } }, res => {
      const bytes: Buffer[] = []; res.on('data', b => bytes.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bytes) }));
    }).on('error', reject).end();
  });
  const index = await get('/');
  expect(index.body.toString()).toBe('Sable web fixture');
  const caResponse = await get('/ca.cer', true);
  expect(caResponse.body).toEqual(ca.raw);
  expect((await get('/ca.cer')).body).toEqual(ca.raw);
  expect((await get('/', true)).status).toBe(404);
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
    'permission.respond', 'question.respond', 'provider.limits', 'usage.limits', 'phone.tail', 'phone.item',
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
  for (const m of ['session.send', 'phone.steerNow', 'permission.respond', 'question.respond', 'phone.answer']) {
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

