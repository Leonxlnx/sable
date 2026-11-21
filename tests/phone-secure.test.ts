/**
 * The phone's secure channel (server/services/phone-secure.ts with the phone's mobile/src/lib/secure.ts):
 * the desktop's identity pinned by the pairing link, the signed handshake, sealed frames both ways,
 * and what is refused: another desktop, an altered or replayed frame, a plain frame inside, a wrong
 * pairing key. Phones paired before it keep their plain connection; they cannot pair anew plain, and a
 * securely paired phone never connects plain. Demo agent and local sockets only.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhoneStatus, PhoneTail, ToolItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { pairLink, phonePatch, registerPhone, type PhoneService } from '../server/services/phone';
import { deflateRawSync } from 'node:zlib';
import { answerHello, fingerprintOf, loadIdentity, openFrame, readSecHello, sealFrame } from '../server/services/phone-secure';
import { qrMatrix } from '../server/services/qr';
import { b64u, IdentityError, MalformedError, pskOfKey, pskOfToken, startHandshake } from '../mobile/src/lib/secure';
import { fetchSecure, fingerprintIn, handshake, helloPlain, helloSecure, keyOf, legacyPairing, pairSecure, wireClient, type Frame } from './phone-wire';
import { CONTAIN } from '../server/core/contain';

// These tests are about the secure channel, not containment. Where no handle names its file (Windows), the
// default ('none') counts every file as external, so a share reaches a phone only when the person
// allowed it (review wave 5, #7: tests/contain.test.ts, tests/files-wave5.test.ts). Here the walks
// ('walk') stand in for Linux's proof, so a plain file in the chat folder counts as inside as it does there.
if (CONTAIN.how === 'none') CONTAIN.how = 'walk';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function setup(home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'))) {
  if (!homes.includes(home)) homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, phone, home, port: status.port };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A phone paired before the secure channel: what phone.json held for it, and its token. */
function oldPairing(home: string, token = 'old-phone-token-0123456789abcdef0123456789') {
  const device = { id: 'old-phone', name: 'Old phone', tokenHash: createHash('sha256').update(token).digest('hex'), pairedAt: 1 };
  writeFileSync(path.join(home, 'phone.json'), JSON.stringify({ enabled: true, devices: [device] }));
  return { token, deviceId: device.id };
}

describe('the secure channel', () => {
  it('pairs with the pinned desktop, seals every frame, and keeps no token on disk', async () => {
    const { app, port, home } = await setup();
    const offer = await app.call('phone.pair', {});
    // The link carries the identity's fingerprint, and the code still fits.
    const fp = fingerprintIn(offer);
    expect(fp).toBe(loadIdentity(path.join(home, 'phone-identity.pem')).fingerprint);
    expect(offer.pairing!.link).toMatch(/^sable:\/\/pair\/2\?h=.*&p=\d+&s=[\w-]{20,}&f=[\w-]{43}/);
    await app.call('phone.pair', { cancel: true });
    const { c, token, deviceId } = await pairSecure(app, port);
    const st = await app.call('phone.status', {});
    expect(st.devices.find((d) => d.id === deviceId)?.secure).toBe(true);
    expect(readFileSync(path.join(home, 'phone.json'), 'utf8')).not.toContain(token);
    // RPC inside the channel.
    const hello = await c.call('app.hello');
    expect(hello.ok).toBe(true);
    expect((await c.call('term.run', {})).error).toMatch(/Not available from the phone/);
    // Nothing went plain after the handshake: every frame from the desktop was binary.
    const raw: Buffer[] = [];
    c.ws.on('message', (m, binary) => binary && raw.push(m as Buffer));
    const created = (await c.call('session.create', { provider: 'demo', cwd: home })) as { ok: boolean; result: PhoneTail };
    expect(created.ok).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
    for (const b of raw) expect(b.toString('utf8')).not.toContain(created.result.session.id);
    c.ws.close();
  });

  it('a long frame is compressed inside the seal, and opens on the phone', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const flags: number[] = [];
    c.ws.on('message', (m, binary) => binary && flags.push((m as Buffer)[0]));
    const created = (await c.call('session.create', { provider: 'demo', cwd: home })) as { result: PhoneTail };
    const id = created.result.session.id;
    app.sessions.get(id)!.add({ type: 'text', text: 'word '.repeat(4000), streaming: false });
    const tail = (await c.call('phone.tail', { sessionId: id })) as { ok: boolean; result: PhoneTail };
    expect(tail.ok).toBe(true);
    expect(tail.result.items.some((i) => i.type === 'text' && i.text.length > 5000)).toBe(true);
    expect(flags).toContain(1);
    c.ws.close();
  });

  it('reconnects as its device with its token inside, and only that way', async () => {
    const { app, port, phone } = await setup();
    const { c, token, deviceId, fingerprint } = await pairSecure(app, port);
    c.ws.close();
    await (phone as PhoneService).stop();
    await app.call('phone.setEnabled', { on: true });
    const port2 = (await app.call('phone.status', {})).port;
    const again = await helloSecure(port2, { deviceId, token, fingerprint });
    expect(again.denied).toBeUndefined();
    expect(await again.c.next((f) => 'welcome' in f)).toBeTruthy();
    expect((await again.c.call('app.hello')).ok).toBe(true);
    again.c.ws.close();
    // Its token in a plain hello: refused (a securely paired phone never connects plain).
    const plain = wireClient(port2);
    await plain.open;
    plain.send({ hello: { token } });
    expect(await plain.closed).toBe(4001);
    // As another device with its token: refused inside the channel.
    const other = wireClient(port2);
    const r = await handshake(other, 'hello', fingerprint, await pskOfToken(token), 'someone-else');
    expect(r.denied).toBe('This phone is not paired with this computer');
  });

  it('refuses a desktop that is not the pinned one: a wrong fingerprint, a swapped key, a swapped exchange', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const key = keyOf(offer);
    const other = fingerprintOf(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }));
    // The QR code named another desktop: the phone stops before it sends anything secret.
    const c = wireClient(port);
    await expect(handshake(c, 'pair', other, pskOfKey(key))).rejects.toBeInstanceOf(IdentityError);
    expect((await app.call('phone.status', {})).request).toBeUndefined();
    // Someone in the middle answers with the desktop's identity but its own ephemeral key (or another identity): the signature does not hold.
    const c2 = wireClient(port);
    await c2.open;
    const hs = await startHandshake('pair');
    const replied = (c2 as unknown as { awaitReply: () => Promise<string> }).awaitReply();
    c2.ws.send(hs.first);
    const real = JSON.parse(await replied) as { sec: Record<string, string> };
    const mine = await startHandshake('pair');
    const theirPub = (JSON.parse(mine.first) as { sec: { pub: string } }).sec.pub;
    await expect(hs.finish(JSON.stringify({ sec: { ...real.sec, pub: theirPub } }), fingerprintIn(offer), pskOfKey(key))).rejects.toBeInstanceOf(IdentityError);
    const spki = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' });
    await expect(hs.finish(JSON.stringify({ sec: { ...real.sec, key: b64u(spki) } }), fingerprintIn(offer), pskOfKey(key))).rejects.toBeInstanceOf(IdentityError);
    // A refusal that is not signed by the pinned desktop is not believed either: the outcome is signed (a channel's answer
    // relabelled as a refusal does not verify), and an answer that is both a channel and a refusal is no answer.
    await expect(hs.finish(JSON.stringify({ sec: { ...real.sec, outcome: 'denied', denied: 'This phone was removed on the desktop' } }), fingerprintIn(offer), pskOfKey(key))).rejects.toBeInstanceOf(IdentityError);
    await expect(hs.finish(JSON.stringify({ sec: { ...real.sec, denied: 'This phone was removed on the desktop' } }), fingerprintIn(offer), pskOfKey(key))).rejects.toBeInstanceOf(MalformedError);
    c2.ws.close();
  });

  it('refuses a wrong pairing key: the first sealed frame does not open', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const c = wireClient(port);
    expect(await handshake(c, 'pair', fingerprintIn(offer), pskOfKey('not-the-key-0123456789'))).toEqual({});
    c.send({ pair: { key: 'not-the-key-0123456789', name: 'Guess' } });
    expect(await c.closed).toBe(4005);
    expect((await app.call('phone.status', {})).request).toBeUndefined();
  });

  it('opens what the desktop sealed, in order, compressed or not; an altered, replayed or skipped frame does not open', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'));
    homes.push(home);
    const identity = loadIdentity(path.join(home, 'phone-identity.pem'));
    const psk = pskOfKey('the-one-time-key-from-the-qr');
    // One channel per run, the phone's module against the desktop's (no socket in between).
    const channel = async () => {
      const hs = await startHandshake('pair');
      const answer = answerHello(identity, readSecHello(hs.first)!, psk);
      const r = await hs.finish(answer.reply, identity.fingerprint, psk);
      if (!('channel' in r)) throw new Error('refused');
      return { ch: r.channel, keys: answer.keys! };
    };
    const body = (s: string) => Buffer.from(s, 'utf8');
    const a = await channel();
    expect(await a.ch.open(sealFrame(a.keys.tx, 0n, 0, body('{"n":0}')))).toBe('{"n":0}');
    const long = JSON.stringify({ text: 'word '.repeat(2000) });
    expect(await a.ch.open(sealFrame(a.keys.tx, 1n, 1, deflateRawSync(body(long))))).toBe(long);
    const altered = sealFrame(a.keys.tx, 2n, 0, body('{"n":2}'));
    altered[altered.length - 5] ^= 1;
    await expect(a.ch.open(altered)).rejects.toBeTruthy();
    // Broken from then on, also for a good frame.
    await expect(a.ch.open(sealFrame(a.keys.tx, 3n, 0, body('{"n":3}')))).rejects.toBeTruthy();
    // A replay, and a frame out of order.
    const b = await channel();
    const f0 = sealFrame(b.keys.tx, 0n, 0, body('{"n":0}'));
    expect(await b.ch.open(f0)).toBe('{"n":0}');
    await expect(b.ch.open(f0)).rejects.toBeTruthy();
    const c = await channel();
    await expect(c.ch.open(sealFrame(c.keys.tx, 1n, 0, body('{"n":1}')))).rejects.toBeTruthy();
    // The flag is bound to the seal: a frame relabelled as compressed does not open.
    const d = await channel();
    const flipped = sealFrame(d.keys.tx, 0n, 0, body('{"n":0}'));
    flipped[0] = 1;
    await expect(d.ch.open(flipped)).rejects.toBeTruthy();
    // What the phone seals, the desktop opens with its own key, in order.
    const e = await channel();
    const sent = await e.ch.seal('{"hello":1}');
    expect(openFrame(e.keys.rx, 0n, Buffer.from(sent)).body.toString()).toBe('{"hello":1}');
    expect(() => openFrame(e.keys.rx, 1n, Buffer.from(sent))).toThrow();
  });

  it('closes the socket on an altered frame from the phone', async () => {
    const { app, port } = await setup();
    const { c } = await pairSecure(app, port);
    const sealed = Buffer.from(await c.channel!.seal(JSON.stringify({ id: 99, method: 'app.hello', params: {} })));
    sealed[5] ^= 0x40;
    c.ws.send(sealed);
    expect(await c.closed).toBe(4005);
  });

  it('refuses a replayed frame, in the same connection and in a new one', async () => {
    const { app, port } = await setup();
    const { c, fingerprint, token, deviceId } = await pairSecure(app, port);
    expect((await c.call('app.hello')).ok).toBe(true);
    const captured = c.sent[c.sent.length - 1];
    c.ws.send(captured);
    expect(await c.closed).toBe(4005);
    // The same sealed hello on a new connection: new keys, it does not open there.
    const first = await helloSecure(port, { deviceId, token, fingerprint });
    await first.c.next((f) => 'welcome' in f);
    await until(() => first.c.sent.length > 0);
    const hello = first.c.sent[0];
    first.c.ws.close();
    const second = wireClient(port);
    expect(await handshake(second, 'hello', fingerprint, await pskOfToken(token), deviceId)).toEqual({});
    second.ws.send(hello);
    expect(await second.closed).toBe(4005);
  });

  it('closes a secure connection that sends a plain frame', async () => {
    const { app, port } = await setup();
    const { c } = await pairSecure(app, port);
    c.ws.send(JSON.stringify({ id: 1, method: 'app.hello', params: {} }));
    expect(await c.closed).toBe(4005);
  });

  it('signs its refusals: an unknown device, no pairing open', async () => {
    const { app, port } = await setup();
    const fp = loadIdentity(path.join((app as unknown as { store: { dir: string } }).store.dir, 'phone-identity.pem')).fingerprint;
    const c = wireClient(port);
    expect(await handshake(c, 'hello', fp, await pskOfToken('x'), 'nobody')).toEqual({ denied: 'This phone is not paired with this computer' });
    const d = wireClient(port);
    expect((await handshake(d, 'pair', fp, pskOfKey('k'))).denied).toMatch(/Pairing is not open/);
  });

  it('keeps one identity across restarts; a damaged key file is kept aside and replaced', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'));
    homes.push(home);
    const file = path.join(home, 'phone-identity.pem');
    const a = loadIdentity(file);
    expect(loadIdentity(file).fingerprint).toBe(a.fingerprint);
    writeFileSync(file, 'not a key');
    const b = loadIdentity(file);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(readdirSync(home).some((f) => f.startsWith('phone-identity.pem.damaged-'))).toBe(true);
    // A key file that cannot be read is never replaced (a folder in its place stands in for a locked file).
    const locked = path.join(home, 'locked.pem');
    mkdirSync(locked);
    expect(() => loadIdentity(locked)).toThrow(/could not read/);
    expect(existsSync(locked)).toBe(true);
  });

  it('makes pairing links that fit the QR code, long names and four addresses included', () => {
    const fp = 'A'.repeat(43);
    const link = pairLink(['192.168.178.123', '100.101.102.103', '172.16.250.250', '10.255.255.254'], 47820, 'k'.repeat(22), fp, 'Workstation-of-someone-very-long-name');
    expect(() => qrMatrix(link)).not.toThrow();
    expect(link).toContain(`&f=${fp}`);
    expect(link).toContain('&s=');
  });
});

describe('phones paired before the secure channel', () => {
  it('keep working with their token on plain frames', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'));
    const old = oldPairing(home);
    const { app, port } = await setup(home);
    const c = wireClient(port);
    await c.open;
    c.send({ hello: { token: old.token } });
    expect(await c.next((f) => 'welcome' in f)).toBeTruthy();
    expect((await c.call('app.hello')).ok).toBe(true);
    const st = await app.call('phone.status', {});
    expect(st.devices.find((d) => d.id === old.deviceId)?.secure).toBeUndefined();
    c.ws.close();
  });

  it('cannot pair anew on plain frames (the app is too old): it is told to update', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const c = wireClient(port);
    await c.open;
    c.send({ pair: { key: keyOf(offer), name: 'Old app' } });
    const f = await c.next((x) => 'denied' in x);
    expect(f.denied).toBe('Update Sable on this phone to pair with this computer.');
    expect(await c.closed).toBe(4003);
    expect((await app.call('phone.status', {})).request).toBeUndefined();
  });

  it('pairing again securely replaces the old entry only by the ticket this desktop gave it over the old pairing', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'));
    const [a, b] = legacyPairing(home, [{ id: 'old-a' }, { id: 'old-b' }]);
    const { app, port } = await setup(home);
    /** Pairs securely naming `replaces`; returns the device ids then on the desktop (a replacement refused at once: none are added). */
    const pairNaming = async (replaces: unknown) => {
      const offer = await app.call('phone.pair', {});
      const c = wireClient(port);
      expect(await handshake(c, 'pair', fingerprintIn(offer), pskOfKey(keyOf(offer)))).toEqual({});
      c.send({ pair: { key: keyOf(offer), name: 'Old phone', replaces } });
      const first = await c.next((f) => 'waiting' in f || 'denied' in f);
      if ('denied' in first) {
        c.ws.close();
        return (await app.call('phone.status', {})).devices.map((d) => d.id);
      }
      const asking = await app.call('phone.status', {});
      await app.call('phone.approve', { requestId: asking.request!.id, allow: true });
      await c.next((f) => 'welcome' in f);
      c.ws.close();
      return (await app.call('phone.status', {})).devices.map((d) => d.id);
    };
    // Over its own plain pairing: this desktop's fingerprint and a one-time ticket.
    const plainA = await helloPlain(port, a.token);
    const ma = (await plainA.call('phone.migrate')) as { ok: boolean; result: { fingerprint: string; ticket: string } };
    expect(ma.ok).toBe(true);
    expect(ma.result.fingerprint).toBe(loadIdentity(path.join(home, 'phone-identity.pem')).fingerprint);
    // The ticket replaces that entry, and only that one.
    let ids = await pairNaming({ id: a.deviceId, ticket: ma.result.ticket });
    expect(ids).not.toContain(a.deviceId);
    expect(ids).toContain(b.deviceId);
    // The old token (what app 2.1 named) replaces nothing: a token never travels in a pairing.
    ids = await pairNaming({ id: b.deviceId, token: b.token });
    expect(ids).toContain(b.deviceId);
    // Another phone's ticket, a wrong ticket: refused, nothing changes; a wrong try uses up nothing (wave 5, 6), so the real one still replaces it.
    const plainB = await helloPlain(port, b.token);
    const mb = (await plainB.call('phone.migrate')) as { result: { ticket: string } };
    const before = ids.length;
    ids = await pairNaming({ id: b.deviceId, ticket: 'not-the-ticket-0123456789' });
    expect(ids).toContain(b.deviceId);
    expect(ids).toHaveLength(before);
    ids = await pairNaming({ id: a.deviceId, ticket: mb.result.ticket });
    expect(ids).toContain(b.deviceId);
    expect(ids).toHaveLength(before);
    ids = await pairNaming({ id: b.deviceId, ticket: mb.result.ticket });
    expect(ids).not.toContain(b.deviceId);
    // A securely paired phone gets no ticket.
    const { c } = await pairSecure(app, port);
    expect(((await c.call('phone.migrate')) as { error?: string }).error).toBe('This phone is already paired securely.');
    c.ws.close();
  });
});

describe('downloads over the channel', () => {
  it("sends the file in chunks over the sealed connection, named by the share's SHA-256 and size", async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const created = (await c.call('session.create', { provider: 'demo', cwd: home })) as { result: PhoneTail };
    const id = created.result.session.id;
    const body = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    writeFileSync(path.join(home, 'app-release.apk'), body);
    app.sessions.get(id)!.add({ id: 'share1', type: 'tool', name: 'share', kind: 'share', title: 'Share app-release.apk', status: 'done', detail: { files: [{ path: 'app-release.apk', name: 'app-release.apk', size: body.length }] } } as ToolItem);
    const got = await fetchSecure(c, { sessionId: id, itemId: 'share1', index: 0 }, 1024);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.start.size).toBe(body.length);
    expect(got.start.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(createHash('sha256').update(got.bytes).digest('hex')).toBe(got.start.sha256);
    c.ws.close();
  });
});

describe('what a live patch carries', () => {
  it("never the record of what a share handed over (real paths, file ids, grants)", () => {
    const p = phonePatch({ status: 'done', handed: [{ path: 'C:\\secret\\real.apk', size: 1, mtimeMs: 1, ino: '1', dev: 1, inside: false, granted: true }] } as unknown as Partial<ToolItem>);
    expect(p).toEqual({ status: 'done' });
  });
});

describe('the paired phones on disk', () => {
  it('a removal that cannot be written holds at once, says so, and is written when it can be', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-secure-'));
    const old = oldPairing(home);
    const { app, port } = await setup(home);
    // The temporary file cannot be made (a folder in its place, as a locked file on Windows would).
    const tmp = path.join(home, 'phone.json.tmp');
    mkdirSync(tmp);
    const st: PhoneStatus = await app.call('phone.revoke', { deviceId: old.deviceId });
    expect(st.devices).toHaveLength(0);
    expect(st.saveError).toMatch(/Could not save the paired phones/);
    // Denied at once, though the file still lists it.
    expect(readFileSync(path.join(home, 'phone.json'), 'utf8')).toContain(old.deviceId);
    const c = wireClient(port);
    await c.open;
    c.send({ hello: { token: old.token } });
    expect(await c.closed).toBe(4001);
    rmSync(tmp, { recursive: true, force: true });
    await until(() => !readFileSync(path.join(home, 'phone.json'), 'utf8').includes(old.deviceId), 6000);
    expect((await app.call('phone.status', {})).saveError).toBeUndefined();
  }, 15_000);
});

// Frames a phone got are records; the type is only used by the helpers.
export type { Frame };
