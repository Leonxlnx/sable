/**
 * A phone for the endpoint's tests: a `ws` socket that speaks the secure channel with the phone app's
 * own module (mobile/src/lib/secure.ts, WebCrypto), or plain frames as a phone paired before it did.
 * Frames come in order, opened; `call` seals an RPC and waits for its answer.
 */
import { expect } from 'vitest';
import WebSocket from 'ws';
import { PHONE_PATH, type PhoneStatus } from '@shared/protocol';
import type { App } from '../server/app';
import { pskOfKey, pskOfToken, startHandshake, type Channel } from '../mobile/src/lib/secure';

export type Frame = Record<string, unknown>;

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
export function wireClient(port: number, origin: string | null = 'http://localhost'): WireClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${PHONE_PATH}`, origin ? { headers: { origin } } : undefined);
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

export const keyOf = (s: PhoneStatus) => /[?&]k=([^&]+)/.exec(s.pairing!.link)![1];
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
