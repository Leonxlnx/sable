/**
 * The phone endpoint after review wave 4 (scratch/reviews/out-wave4.md), the desktop's side: pairing
 * links an older app cannot read and codes that came in the clear used up (3); the handshake's signed
 * outcome (18); a removed phone's requests never acted on (8); a phone's mode change that answers only
 * what the phone could allow (9); a queued message reserved while the phone takes it (17); the queue
 * and what waits in pages (21); files only over the sealed connection, in chunks, only the bytes the
 * share recorded, never an APK over a plain pairing (4, 5, 6, 10). Demo agent and local sockets only.
 */
import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PhoneTail, QueuedMessage, ToolItem } from '@shared/protocol';
import { canonicalName, isCanonicalName, isPackageName } from '@shared/file-name';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { pairLink, phoneEvent, QUEUE_PAGE, registerPhone, type PhoneService } from '../server/services/phone';
import { FILE_CHUNK } from '../server/services/phone-files';
import { answerHello, loadIdentity, readSecHello, transcript } from '../server/services/phone-secure';
import { pskOfKey, startHandshake } from '../mobile/src/lib/secure';
import { fetchSecure, fingerprintIn, handshake, helloPlain, keyOf, legacyPairing, pairSecure, wireClient, type WireClient } from './phone-wire';
import { CONTAIN } from '../server/core/contain';

// These tests are about the endpoint after review wave 4, not containment. Where no handle names its file (Windows), the
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

async function setup(opts: { legacy?: number } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w4-'));
  homes.push(home);
  const old = opts.legacy ? legacyPairing(home, Array.from({ length: opts.legacy }, () => ({}))) : [];
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, phone, home, port: status.port, old };
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The desktop's own socket of its one connected phone (the endpoint's, to slow it down on purpose). */
function deskSocket(phone: PhoneService) {
  const clients = [...((phone as unknown as { wss: { clients: Set<import('ws').WebSocket> } }).wss.clients)];
  expect(clients).toHaveLength(1);
  return clients[0];
}

async function chatOf(app: App, c: WireClient, home: string) {
  const created = (await c.call('session.create', { provider: 'demo', cwd: home })) as { result: PhoneTail };
  return app.sessions.get(created.result.session.id)!;
}

describe('pairing links and codes (3)', () => {
  it('a link is version 2: the parsers of the apps before the secure channel cannot read it', () => {
    const link = pairLink(['192.168.1.5'], 47820, 'k'.repeat(22), 'F'.repeat(43), 'Desk');
    expect(link.startsWith('sable://pair/2?')).toBe(true);
    expect(link).toContain('&s=');
    expect(link).not.toMatch(/[?&]k=/);
    // App 2.0 (c8de53b) and 2.1 (3ed5f98) both read only `sable://pair?…` with `k`.
    expect(/sable:\/\/pair\?([^\s]+)/i.exec(link)).toBeNull();
  });

  it('a code that came in the clear (an app too old for the channel) no longer pairs; a wrong one changes nothing', async () => {
    const { app, port } = await setup();
    const offer = await app.call('phone.pair', {});
    const wrong = wireClient(port);
    await wrong.open;
    wrong.send({ pair: { key: 'not-the-code-0123456789', name: 'Old app' } });
    expect((await wrong.next((f) => 'denied' in f)).denied).toBe('Update Sable on this phone to pair with this computer.');
    expect((await app.call('phone.status', {})).pairing).toBeDefined();
    const plain = wireClient(port);
    await plain.open;
    plain.send({ pair: { key: keyOf(offer), name: 'Old app' } });
    expect((await plain.next((f) => 'denied' in f)).denied).toBe('Update Sable on this phone to pair with this computer.');
    // Someone who read that frame on the way cannot pair with the code now.
    expect((await app.call('phone.status', {})).pairing).toBeUndefined();
    const c = wireClient(port);
    expect((await handshake(c, 'pair', fingerprintIn(offer), pskOfKey(keyOf(offer)))).denied).toMatch(/Pairing is not open/);
  });
});

describe('the handshake, version 2 (18)', () => {
  it('signs which answer it is; a refusal always has words; a phone that speaks version 1 is still answered', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w4-'));
    homes.push(home);
    const id = loadIdentity(path.join(home, 'id.pem'));
    const hs = await startHandshake('hello', 'dev-1');
    const h = readSecHello(hs.first)!;
    expect(h.v).toBe(2);
    const ok = JSON.parse(answerHello(id, h, Buffer.from('psk')).reply).sec;
    expect(ok).toMatchObject({ v: 2, outcome: 'ok' });
    expect(ok.denied).toBeUndefined();
    const no = JSON.parse(answerHello(id, h, null, '').reply).sec;
    expect(no.outcome).toBe('denied');
    expect(no.denied).toBe('The desktop refused this connection');
    // The outcome is part of what is signed: the same words with the other outcome do not verify.
    const key = createPublicKey({ key: Buffer.from(no.key, 'base64url'), format: 'der', type: 'spki' });
    const sig = Buffer.from(no.sig, 'base64url');
    const deskPub = Buffer.from(no.pub, 'base64url');
    expect(verifySig('sha256', transcript(h, deskPub, id.spki, no.denied, 'denied'), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
    expect(verifySig('sha256', transcript(h, deskPub, id.spki, no.denied, 'ok'), { key, dsaEncoding: 'ieee-p1363' }, sig)).toBe(false);
    // App 2.1 speaks version 1: answered in version 1 (no outcome field), so it keeps its secure pairing until it is updated.
    const v1 = { ...h, v: 1 as const };
    const old = JSON.parse(answerHello(id, v1, Buffer.from('psk')).reply).sec;
    expect(old.v).toBe(1);
    expect(old.outcome).toBeUndefined();
    expect(verifySig('sha256', transcript(v1, Buffer.from(old.pub, 'base64url'), id.spki, ''), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(old.sig, 'base64url'))).toBe(true);
  });
});

describe('a removed phone (8)', () => {
  it('nothing it sends after the removal is acted on, while its socket is still closing', async () => {
    const { app, phone, port, home } = await setup();
    const { c, deviceId } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    expect(rt.meta.pinned).toBeFalsy();
    // Its socket closes behind what is still going out (here: held back on purpose).
    const ws = deskSocket(phone);
    const close = ws.close.bind(ws);
    ws.close = ((code?: number, reason?: string) => void setTimeout(() => close(code, reason), 400)) as typeof ws.close;
    phone.revoke(deviceId);
    c.send({ id: 99, method: 'session.update', params: { sessionId: rt.id, patch: { pinned: true } } });
    await wait(300);
    expect(ws.readyState).toBe(ws.OPEN);
    expect(app.sessions.get(rt.id)!.meta.pinned).toBeFalsy();
    await c.closed;
  });

  it('a request that waits (a take of a queued message) does nothing once its phone is removed meanwhile', async () => {
    const { app, phone, port, home } = await setup();
    const { c, deviceId } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const q = rt.enqueue('keep me');
    // The reply goes out, and its phone is removed before the desktop hears it went.
    const ws = deskSocket(phone);
    const send = ws.send.bind(ws) as (d: unknown, o: unknown, cb?: (e?: Error) => void) => void;
    (ws as unknown as { send: typeof send }).send = (d, o, cb) => send(d, o, (e) => void setTimeout(() => cb?.(e), 150));
    const taken = c.call('queue.take', { sessionId: rt.id, id: q.id });
    await wait(40);
    phone.revoke(deviceId);
    await taken.catch(() => {});
    await wait(250);
    expect(rt.queue.map((m) => m.text)).toEqual(['keep me']);
    expect(rt.isReserved(q.id)).toBe(false);
  });
});

describe("a phone's mode change (9)", () => {
  it('to a mode that never asks answers only what the phone could allow; what only the desktop may answer keeps waiting', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    rt.caps = { ...(rt.caps ?? {}), modes: [{ id: 'default', name: 'Default' }, { id: 'bypassPermissions', name: 'Bypass', tone: 'danger' }] } as never;
    const options = [
      { id: 'allow', label: 'Allow once', tone: 'allow' as const },
      { id: 'deny', label: 'Deny', tone: 'deny' as const },
    ];
    const short = rt.requestPermission({ toolName: 'Bash', kind: 'bash', title: 'Run this command?', detail: { command: 'npm test', cwd: home }, options });
    // A command longer than the phone shows: only the desktop may allow it.
    const long = rt.requestPermission({ toolName: 'Bash', kind: 'bash', title: 'Run this command?', detail: { command: `echo ${'x'.repeat(6000)}`, cwd: home }, options });
    let longAnswer: unknown = 'waiting';
    void long.then((a) => (longAnswer = a));
    expect((await c.call('session.setMode', { sessionId: rt.id, mode: 'bypassPermissions' })).ok).toBe(true);
    expect(await short).toEqual({ optionId: 'allow' });
    await wait(50);
    expect(longAnswer).toBe('waiting');
    expect(rt.prompts().permissions).toHaveLength(1);
    expect(rt.meta.mode).toBe('bypassPermissions');
    // The desktop's own switch answers it, as before.
    await app.call('session.setMode', { sessionId: rt.id, mode: 'bypassPermissions' });
    expect(await long).toEqual({ optionId: 'allow' });
  });
});

describe('a queued message the phone takes back (17)', () => {
  /** Holds the desktop's "it went out" for the phone's reply, so what happens meanwhile can be looked at. */
  function holdReplies(phone: PhoneService, ms: number, fail = false) {
    const ws = deskSocket(phone);
    const send = ws.send.bind(ws) as (d: unknown, o: unknown, cb?: (e?: Error) => void) => void;
    (ws as unknown as { send: typeof send }).send = (d, o, cb) => send(d, o, (e) => void setTimeout(() => cb?.(fail ? new Error('cut off') : e), ms));
  }

  it('is reserved while the reply goes: an edit on the desktop is refused (not lost), the queue does not send it, then it is taken', async () => {
    const { app, phone, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const q = rt.enqueue('first words');
    holdReplies(phone, 200);
    const taken = (await c.call('queue.take', { sessionId: rt.id, id: q.id })) as { result: { message: QueuedMessage } };
    expect(taken.result.message.text).toBe('first words');
    // The reply is with the phone, the take not settled yet: the message stays, and stays as it was.
    expect(rt.isReserved(q.id)).toBe(true);
    expect((await app.call('queue.update', { sessionId: rt.id, id: q.id, text: 'edited on the desktop' })).ok).toBe(false);
    // A turn ending now does not send it, nor skip it for the next one.
    rt.enqueue('second');
    (app as unknown as { sendNextQueued: (r: typeof rt) => void }).sendNextQueued(rt);
    expect(rt.queue.map((m) => m.text)).toEqual(['first words', 'second']);
    await until(() => !rt.isReserved(q.id));
    // Taken by the phone: gone from the queue, and never sent.
    expect(rt.queue.some((m) => m.id === q.id)).toBe(false);
    expect(rt.items.some((i) => i.type === 'user' && i.text === 'first words')).toBe(false);
  });

  it('a reply that does not go leaves it where and as it was, and the queue goes on with it first', async () => {
    const { app, phone, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const q = rt.enqueue('first words');
    rt.enqueue('second');
    holdReplies(phone, 100, true);
    void c.call('queue.take', { sessionId: rt.id, id: q.id }).catch(() => {});
    await until(() => rt.isReserved(q.id));
    (app as unknown as { sendNextQueued: (r: typeof rt) => void }).sendNextQueued(rt);
    expect(rt.queue.map((m) => m.text)).toEqual(['first words', 'second']);
    // Rolled back: the queue that waited for it sends it, the first, as it would have.
    await until(() => rt.items.some((i) => i.type === 'user' && i.text === 'first words'), 5000);
    const sent = rt.items.filter((i) => i.type === 'user').map((i) => (i as { text: string }).text);
    expect(sent[0]).toBe('first words');
  });
});

describe('the queue in pages (21)', () => {
  it("a chat's page holds the first page of a long queue and says how many there are; phone.queue reads on", async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    // Enough long messages that the whole queue would be far over the phone's frame (16 MiB).
    rt.queue = Array.from({ length: 2199 }, (_, i) => ({ id: `q${i}`, text: `${i} ${'w'.repeat(9000)}`, createdAt: i }));
    rt.enqueue(`2199 ${'w'.repeat(9000)}`);
    const tail = (await c.call('phone.tail', { sessionId: rt.id }, 10_000)) as { ok: boolean; result: PhoneTail; error?: string };
    expect(tail.ok).toBe(true);
    expect(tail.result.queue).toHaveLength(QUEUE_PAGE);
    expect(tail.result.queueTotal).toBe(2200);
    const page = (await c.call('phone.queue', { sessionId: rt.id, from: 2190 })) as { result: { queue: QueuedMessage[]; total: number; from: number } };
    expect(page.result.queue.map((m) => m.text.split(' ')[0])).toEqual(['2190', '2191', '2192', '2193', '2194', '2195', '2196', '2197', '2198', '2199']);
    expect(page.result.total).toBe(2200);
    // Its live update as a phone gets it: the first page and the count.
    const e = phoneEvent({ type: 'queue.updated', sessionId: rt.id, queue: rt.queue }) as { queue: QueuedMessage[]; total?: number };
    expect(e.queue).toHaveLength(QUEUE_PAGE);
    expect(e.total).toBe(2200);
  });
});

describe('files over the secure channel (4, 6, 10)', () => {
  const shareOf = (id: string, file: string, name = path.basename(file)) => ({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: name, status: 'done', detail: { files: [{ path: file, name, size: statSync(file).size }] } }) as unknown as ToolItem;

  it('come in bounded chunks from any offset, for the phone that opened them only, and end with it', async () => {
    const { app, phone, port, home } = await setup();
    const { c, deviceId } = await pairSecure(app, port);
    const other = await pairSecure(app, port, 'Other phone');
    const rt = await chatOf(app, c, home);
    const body = Buffer.alloc(FILE_CHUNK * 2 + 77);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7) % 256;
    writeFileSync(path.join(home, 'data.bin'), body);
    rt.add(shareOf('s1', path.join(home, 'data.bin')));
    const s = (await c.call('phone.fileStart', { sessionId: rt.id, itemId: 's1', index: 0 })) as { result: { transfer: string; size: number; sha256: string; chunk: number } };
    expect(s.result).toMatchObject({ size: body.length, sha256: createHash('sha256').update(body).digest('hex'), chunk: FILE_CHUNK });
    // Never more than a chunk, whatever is asked; from where the phone asks.
    const big = (await c.call('phone.fileChunk', { transfer: s.result.transfer, offset: 0, length: 50 * 1024 * 1024 })) as { result: { data: string } };
    expect(Buffer.from(big.result.data, 'base64').length).toBe(FILE_CHUNK);
    const tail = (await c.call('phone.fileChunk', { transfer: s.result.transfer, offset: FILE_CHUNK * 2 })) as { result: { data: string } };
    expect(Buffer.from(tail.result.data, 'base64').equals(body.subarray(FILE_CHUNK * 2))).toBe(true);
    expect(((await c.call('phone.fileChunk', { transfer: s.result.transfer, offset: body.length + 1 })) as { ok: boolean }).ok).toBe(false);
    // Another phone cannot read this transfer.
    expect(((await other.c.call('phone.fileChunk', { transfer: s.result.transfer, offset: 0 })) as { ok: boolean }).ok).toBe(false);
    // Removing the phone ends what it had open.
    expect((phone as unknown as { sending: { count(d: string): number } }).sending.count(deviceId)).toBe(1);
    phone.revoke(deviceId);
    expect((phone as unknown as { sending: { count(d: string): number } }).sending.count(deviceId)).toBe(0);
  });

  it('only the bytes the share recorded: a file rewritten in place after it, its size and time put back, is refused', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairSecure(app, port);
    const rt = await chatOf(app, c, home);
    const file = path.join(home, 'app-release.apk');
    writeFileSync(file, 'the real build');
    // Whole seconds, so the time can be put back exactly (the share's record and the link check it).
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    rt.add(shareOf('s1', file));
    writeFileSync(file, 'a swapped one!');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(statSync(file).mtimeMs).toBe(1_700_000_000_000);
    const got = await fetchSecure(c, { sessionId: rt.id, itemId: 's1', index: 0 });
    expect(got.ok).toBe(false);
    expect(!got.ok && got.error).toBe('That file changed after it was shared.');
    // Put back as it was: it goes, named as the share recorded it.
    writeFileSync(file, 'the real build');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    const ok = await fetchSecure(c, { sessionId: rt.id, itemId: 's1', index: 0 });
    expect(ok.ok ? ok.bytes.toString() : ok.error).toBe('the real build');
  });

  it('a phone paired plain never gets an APK, by any spelling of its name, and its links serve no package type', async () => {
    const { app, port, home, old } = await setup({ legacy: 1 });
    const c = await helloPlain(port, old[0].token);
    const rt = await chatOf(app, c, home);
    mkdirSync(path.join(home, 'out'));
    const names = ['app.apk', 'app.apk ', 'app.APK.', 'app.apk​'];
    names.forEach((n, i) => {
      const file = path.join(home, 'out', `f${i}`);
      writeFileSync(file, 'apk bytes');
      rt.add(shareOf(`a${i}`, file, n));
    });
    for (let i = 0; i < names.length; i++) {
      const r = (await c.call('phone.fileLink', { sessionId: rt.id, itemId: `a${i}`, index: 0 })) as { ok: boolean; error?: string };
      expect(r.error, JSON.stringify(names[i])).toBe('Pair again for a secure connection to get this file.');
    }
    // A plain pairing cannot use the secure channel's transfer either.
    expect(((await c.call('phone.fileStart', { sessionId: rt.id, itemId: 'a0', index: 0 })) as { error?: string }).error).toBe('Pair again for a secure connection to get this file.');
    writeFileSync(path.join(home, 'notes.txt'), 'notes');
    rt.add(shareOf('n1', path.join(home, 'notes.txt')));
    const link = (await c.call('phone.fileLink', { sessionId: rt.id, itemId: 'n1', index: 0 })) as { ok: boolean; result: { path: string } };
    expect(link.ok).toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}${link.result.path}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('notes');
  });
});

describe('a file name, made canonical once (5)', () => {
  it('one name for the page, the desktop and the installer gate', () => {
    expect(canonicalName('app.apk ')).toBe('app.apk');
    expect(canonicalName('app.APK.')).toBe('app.APK');
    expect(canonicalName(' .app.apk')).toBe('app.apk');
    expect(canonicalName('app.apk​')).toBe('app.apk');
    expect(canonicalName('‮kpa.txt')).toBe('kpa.txt');
    expect(canonicalName('a/b\\c:d.apk')).toBe('a_b_c_d.apk');
    expect(canonicalName('tab\there.txt')).toBe('tabhere.txt');
    expect(canonicalName('')).toBe('file');
    expect(canonicalName(`${'n'.repeat(300)}.apk`)).toMatch(/^n{116}\.apk$/);
    for (const n of ['app.apk ', 'app.APK.', 'app.apk​']) expect(isPackageName(canonicalName(n)), n).toBe(true);
    expect(isPackageName(canonicalName('app.apk.txt'))).toBe(false);
    // What FilesPlugin.java insists on before it decides anything by a name.
    expect(isCanonicalName('app.apk')).toBe(true);
    expect(isCanonicalName('app.apk ')).toBe(false);
  });
});
