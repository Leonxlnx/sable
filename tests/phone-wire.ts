/**
 * A phone for the endpoint's tests: a `ws` socket that speaks the secure channel with the phone app's
 * own module (mobile/src/lib/secure.ts, WebCrypto), or plain frames as a phone paired before it did.
 * Frames come in order, opened; `call` seals an RPC and waits for its answer.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import WebSocket from 'ws';
import { PHONE_PATH, type PhoneStatus } from '@shared/protocol';
import type { App } from '../server/app';
import { pskOfKey, pskOfToken, startHandshake, type Channel } from '../mobile/src/lib/secure';

export type Frame = Record<string, unknown>;

const besides: string[] = [];
afterEach(() => {
  for (const d of besides.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * A folder for a phone's chat next to the app's data folder `home` (made, and removed after the test):
 * a phone may not start a chat anywhere inside Sable's data folder (`phoneRefusal` in services/custom.ts).
 */
export function beside(home: string, name = 'work'): string {
  const d = `${home}-${name}`;
  mkdirSync(d, { recursive: true });
  besides.push(d);
  return d;
}

export interface WireClient {
  ws: WebSocket;
  open: Promise<void>;
  frames: Frame[];
  next(pred: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  call(method: string, params?: unknown, ms?: number): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** A frame of the phone's own (sealed once the channel is up). */
  send(frame: unknown): void;
  closed: Promise<number>;
  /** The channel, once a handshake made it. */
  channel?: Channel;
  /** The sealed frames the phone sent, as they went (for a replay). */
  sent: Buffer[];
  /** The desktop's answer to the handshake (its signed refusal or its keys), as text. */
  reply?: string;
}

/** A socket to the endpoint; plain until `handshake` makes it secure. */
export function wireClient(port: number, origin: string | null = 'http://localhost', socket?: WebSocket): WireClient {
  const ws = socket ?? new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}`, origin ? { headers: { origin } } : undefined);
  const frames: Frame[] = [];
  let waiters: ((f: Frame) => void)[] = [];
  const c = {} as WireClient;
  let chain: Promise<unknown> = Promise.resolve();
  let pendingReply: ((t: string) => void) | undefined;
  const push = (f: Frame) => {
    frames.push(f);
    const ws2 = waiters;
    waiters = [];
    for (const w of ws2) w(f);
  };
  ws.on('message', (m, binary) => {
    if (!binary) {
      const text = String(m);
      // The handshake's answer is taken by `handshake`; plain frames otherwise.
      if (c.reply === undefined && pendingReply) return pendingReply(text);
      try {
        push(JSON.parse(text) as Frame);
      } catch {
        /* not JSON */
      }
      return;
    }
    const ch = c.channel;
    if (!ch) return;
    const bytes = new Uint8Array(m as Buffer);
    chain = chain.then(() => ch.open(bytes).then((t) => push(JSON.parse(t) as Frame), () => push({ unreadable: true })));
  });
  c.ws = ws;
  c.frames = frames;
  c.sent = [];
  c.open = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.on('error', reject);
  });
  c.closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  c.next = (pred, ms = 3000) =>
    new Promise<Frame>((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error('no such frame')), ms);
      const check = (f: Frame) => {
        if (pred(f)) {
          clearTimeout(t);
          resolve(f);
        } else waiters.push(check);
      };
      waiters.push(check);
    });
  c.send = (frame) => {
    const text = JSON.stringify(frame);
    const ch = c.channel;
    if (!ch) return void ws.send(text);
    void ch.seal(text).then((b) => {
      const buf = Buffer.from(b);
      c.sent.push(buf);
      ws.send(buf);
    });
  };
  let id = 0;
  c.call = async (method, params = {}, ms) => {
    const i = ++id;
    c.send({ id: i, method, params });
    return (await c.next((f) => f.id === i, ms)) as { ok: boolean; result?: unknown; error?: string };
  };
  (c as unknown as { awaitReply: () => Promise<string> }).awaitReply = () => new Promise<string>((resolve) => (pendingReply = (t) => ((pendingReply = undefined), resolve(t))));
  return c;
}

/**
 * The secure handshake on an open client: the first frame, the desktop's answer checked against
 * `fingerprint`; resolves with the signed refusal, or sets up the channel. Rejects as the phone would
 * (an `IdentityError` for a desktop that is not the pinned one).
 */
export async function handshake(c: WireClient, kind: 'pair' | 'hello', fingerprint: string, psk: Uint8Array, id = ''): Promise<{ denied?: string }> {
  await c.open;
  const hs = await startHandshake(kind, id);
  const replied = (c as unknown as { awaitReply: () => Promise<string> }).awaitReply();
  c.ws.send(hs.first);
  const reply = await replied;
  c.reply = reply;
  const r = await hs.finish(reply, fingerprint, psk);
  if ('denied' in r) return { denied: r.denied };
  c.channel = r.channel;
  return {};
}

export const keyOf = (s: PhoneStatus) => /[?&]s=([^&]+)/.exec(s.pairing!.link)![1];
export const fingerprintIn = (s: PhoneStatus) => /[?&]f=([^&]+)/.exec(s.pairing!.link)![1];

/** Pairs a phone over the secure channel, "Allow" clicked on the desktop. */
export async function pairSecure(app: App, port: number, name = 'Test phone') {
  const offer = await app.call('phone.pair', {});
  const fingerprint = fingerprintIn(offer);
  const c = wireClient(port);
  expect(await handshake(c, 'pair', fingerprint, pskOfKey(keyOf(offer)))).toEqual({});
  c.send({ pair: { key: keyOf(offer), name } });
  await c.next((f) => 'waiting' in f);
  const asking = await app.call('phone.status', {});
  expect(asking.request?.name).toBe(name);
  await app.call('phone.approve', { requestId: asking.request!.id, allow: true });
  const paired = (await c.next((f) => 'paired' in f)) as { paired: { token: string; deviceId: string } };
  await c.next((f) => 'welcome' in f);
  return { c, token: paired.paired.token, deviceId: paired.paired.deviceId, fingerprint };
}

/** A paired phone connecting again: the secure handshake as its device, then its token inside. */
export async function helloSecure(port: number, p: { deviceId: string; token: string; fingerprint: string }) {
  const c = wireClient(port);
  const r = await handshake(c, 'hello', p.fingerprint, await pskOfToken(p.token), p.deviceId);
  if (!r.denied) c.send({ hello: { token: p.token } });
  return { c, ...r };
}

/**
 * A phone paired before the secure channel, as phone.json held it (written before the App starts,
 * phone access on): its device and its token, which it sends plain.
 */
export function legacyPairing(home: string, devices: { id?: string; token?: string; name?: string }[] = [{}]) {
  const out = devices.map((d, i) => ({ deviceId: d.id ?? `old-phone-${i}`, token: d.token ?? `old-phone-token-${i}-0123456789abcdef0123456789`, name: d.name ?? `Old phone ${i}` }));
  const stored = out.map((d) => ({ id: d.deviceId, name: d.name, tokenHash: createHash('sha256').update(d.token).digest('hex'), pairedAt: 1 }));
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'phone.json'), JSON.stringify({ enabled: true, devices: stored }));
  return out;
}

/** A phone paired before the secure channel connecting as it did: its token in the first plain frame. */
export async function helloPlain(port: number, token: string) {
  const c = wireClient(port);
  await c.open;
  c.send({ hello: { token } });
  await c.next((f) => 'welcome' in f);
  return c;
}

/**
 * A shared file over the secure channel, as the phone fetches it: `phone.fileStart`, then each chunk
 * in order (`chunk` bytes at a time, at most the desktop's), then `phone.fileEnd`. The bytes, or the
 * desktop's refusal.
 */
export async function fetchSecure(c: WireClient, params: { sessionId: string; itemId: string; index: number }, chunk?: number): Promise<{ ok: true; start: { transfer: string; name: string; size: number; sha256: string; chunk: number }; bytes: Buffer } | { ok: false; error: string }> {
  const s = (await c.call('phone.fileStart', params, 10_000)) as { ok: boolean; result?: { transfer: string; name: string; size: number; sha256: string; chunk: number }; error?: string };
  if (!s.ok || !s.result) return { ok: false, error: s.error ?? 'refused' };
  const parts: Buffer[] = [];
  let at = 0;
  while (at < s.result.size) {
    const r = (await c.call('phone.fileChunk', { transfer: s.result.transfer, offset: at, ...(chunk ? { length: chunk } : {}) }, 10_000)) as { ok: boolean; result?: { data: string }; error?: string };
    if (!r.ok || !r.result) return { ok: false, error: r.error ?? 'refused' };
    const b = Buffer.from(r.result.data, 'base64');
    if (!b.length) break;
    parts.push(b);
    at += b.length;
  }
  await c.call('phone.fileEnd', { transfer: s.result.transfer });
  return { ok: true, start: s.result, bytes: Buffer.concat(parts) };
}
