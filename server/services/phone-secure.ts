import { createCipheriv, createDecipheriv, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';
import type { RawData, WebSocket } from 'ws';
import { PHONE_SECURE_VERSIONS, type PhoneSecReply } from '../../shared/protocol';

/**
 * The phone's secure channel, the desktop's side (the phone's is mobile/src/lib/secure.ts, WebCrypto).
 *
 * - The desktop has one long-lived identity: a P-256 key pair, the private key in
 *   `<SABLE_HOME>/phone-identity.pem` (written for the user only). The pairing link carries the
 *   SHA-256 of its public key (SPKI DER) as `f`.
 * - Handshake: the phone sends an ephemeral ECDH key (`PhoneSecHello`); the desktop answers with its
 *   own ephemeral key, its identity key and an ECDSA signature over the transcript (both keys, what
 *   the phone came for, its identity key). The phone checks the identity against the fingerprint it
 *   was given by the QR code and the signature against the identity, so nobody else can answer as
 *   this desktop. A refusal is signed the same way; from version 2 on, which of the two the answer
 *   is (`outcome`) is part of what is signed, and a refusal always has words.
 * - Keys: HKDF-SHA256 over the ECDH secret and the pairing secret (the QR code's one-time key, or the
 *   SHA-256 of the device's token, which is what the desktop keeps), salted with the transcript's
 *   hash: one AES-256-GCM key each way. Someone who does not hold the pairing secret cannot open or
 *   make a frame, and the secret never crosses the network in the clear.
 * - Frames: binary, a flag byte (0 plain, 1 deflate-raw; the flag is the AAD) and the sealed JSON
 *   text with its tag. The nonce is the frame's sequence number in its direction, never sent: a
 *   replayed, dropped, reordered or altered frame does not open, and the socket closes.
 * - Inside the channel the phone speaks the protocol it always did (`hello`, `pair`, RPC).
 */

/** The transcript's label and the keys' HKDF info, per version. */
export const SEC_LABEL = 'sable-phone/1';
const LABELS: Record<number, { label: string; info: string }> = { 1: { label: SEC_LABEL, info: 'sable-phone/1 keys' }, 2: { label: 'sable-phone/2', info: 'sable-phone/2 keys' } };
/** A refusal says something (an empty one could be read as no refusal at all). */
const REFUSED = 'The desktop refused this connection';
/** Frames from the desktop at least this long are compressed before they are sealed (as permessage-deflate did). */
const DEFLATE_FROM = 1024;
const TAG = 16;

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();
const deflate = promisify(deflateRaw);

/** The desktop's identity: its private key, the public key as SPKI DER and that key's fingerprint (SHA-256, base64url). */
export interface Identity {
  key: KeyObject;
  spki: Buffer;
  fingerprint: string;
}

export const fingerprintOf = (spki: Uint8Array) => b64u(sha256(spki));

function identityOf(key: KeyObject): Identity {
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return { key, spki, fingerprint: fingerprintOf(spki) };
}

/**
 * Reads the identity, or makes it the first time. A file with damaged contents is kept aside and a
 * new identity made (phones paired with the old one must pair again; they refuse the new one). A file
 * that is there but cannot be read (locked) throws: it is never replaced for a passing error.
 */
export function loadIdentity(file: string, log: (...args: unknown[]) => void = () => {}): Identity {
  let pem: string | undefined;
  try {
    pem = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Sable could not read its phone key.');
  }
  if (pem !== undefined) {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not a P-256 key');
      return identityOf(key);
    } catch (err) {
      const aside = `${file}.damaged-${Date.now()}`;
      if (existsSync(file)) renameSync(file, aside);
      log('phone: the identity key was damaged; kept as', aside, (err as Error).message);
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // Readable by the user only where the system has modes; on Windows the profile folder's own access list keeps it the user's.
  writeFileSync(tmp, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* no modes here */
  }
  return identityOf(privateKey);
}

/** A phone's first frame on a secure connection, checked. */
export interface SecHello {
  /** The channel's version the phone speaks (1: app 2.1; 2: a signed outcome). */
  v: 1 | 2;
  kind: 'pair' | 'hello';
  /** The device id it says it is (`hello`); empty for `pair`. */
  id: string;
  /** Its ephemeral ECDH key, uncompressed (65 bytes). */
  pub: Buffer;
  /** It can inflate compressed frames. */
  z: boolean;
}

/** `PhoneSecHello` as it must be, or null (anything else: not JSON, another version, a key of the wrong shape). Never throws. */
export function readSecHello(text: string): SecHello | null {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  const s = m && typeof m === 'object' && !Array.isArray(m) ? (m as { sec?: unknown }).sec : undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const o = s as Record<string, unknown>;
  if (!(PHONE_SECURE_VERSIONS as readonly unknown[]).includes(o.v) || (o.kind !== 'pair' && o.kind !== 'hello')) return null;
  if (o.id !== undefined && (typeof o.id !== 'string' || o.id.length > 100)) return null;
  const id = typeof o.id === 'string' ? o.id : '';
  if (o.kind === 'hello' && !id) return null;
  if (typeof o.pub !== 'string' || o.pub.length > 100 || !/^[\w-]+$/.test(o.pub)) return null;
  const pub = Buffer.from(o.pub, 'base64url');
  if (pub.length !== 65 || pub[0] !== 4) return null;
  return { v: o.v as 1 | 2, kind: o.kind, id, pub, z: o.z === true };
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * What the desktop signs and both sides derive their keys from: every field length-prefixed, in this
 * order. Version 2 adds the outcome (`ok` or `denied`) before the refusal's words, so an answer that
 * opens a channel can never be read as a refusal, or the other way round.
 */
export function transcript(h: Pick<SecHello, 'kind' | 'id' | 'pub' | 'z'> & { v?: 1 | 2 }, deskPub: Uint8Array, spki: Uint8Array, denied: string, outcome: 'ok' | 'denied' = denied ? 'denied' : 'ok'): Buffer {
  const v = h.v ?? 1;
  const head = [Buffer.from(LABELS[v].label), Buffer.from(h.kind), Buffer.from(h.id, 'utf8'), Buffer.from(h.pub), Buffer.of(h.z ? 1 : 0), Buffer.from(deskPub), Buffer.from(spki)];
  const parts = v >= 2 ? [...head, Buffer.from(outcome), Buffer.from(denied, 'utf8')] : [...head, Buffer.from(denied, 'utf8')];
  return Buffer.concat(parts.flatMap((p) => [u32(p.length), p]));
}

/** The two keys of a channel, as the desktop uses them. */
export interface ChannelKeys {
  /** Phone to desktop. */
  rx: Buffer;
  /** Desktop to phone. */
  tx: Buffer;
}

/** HKDF-SHA256 over the ECDH secret and the pairing secret, salted with the transcript's hash: phone-to-desktop key, then desktop-to-phone. */
export function deriveKeys(shared: Uint8Array, psk: Uint8Array, script: Uint8Array, v: 1 | 2 = 1): ChannelKeys {
  const okm = Buffer.from(hkdfSync('sha256', Buffer.concat([shared, psk]), sha256(script), LABELS[v].info, 64));
  return { rx: okm.subarray(0, 32), tx: okm.subarray(32, 64) };
}

/**
 * The desktop's answer to a phone's first frame: the reply to send, and the channel's keys (none
 * for a refusal, or for a phone key that is not a point on the curve). `psk`: the pairing secret.
 */
export function answerHello(identity: Identity, h: SecHello, psk: Uint8Array | null, denied?: string): { reply: string; keys?: ChannelKeys } {
  const ecdh = createECDH('prime256v1');
  const deskPub = ecdh.generateKeys();
  // A refusal always has words; no pairing secret is a refusal too.
  const refusal = denied !== undefined || !psk ? denied || REFUSED : undefined;
  let shared: Buffer | undefined;
  if (refusal === undefined) {
    try {
      shared = ecdh.computeSecret(h.pub);
    } catch {
      return { reply: '' };
    }
  }
  const v = h.v ?? 1;
  const outcome = refusal === undefined ? 'ok' : 'denied';
  const script = transcript(h, deskPub, identity.spki, refusal ?? '', outcome);
  const sig = sign('sha256', script, { key: identity.key, dsaEncoding: 'ieee-p1363' });
  const reply: PhoneSecReply = { sec: { v, pub: b64u(deskPub), key: b64u(identity.spki), sig: b64u(sig), ...(v >= 2 ? { outcome } : {}), ...(refusal !== undefined ? { denied: refusal } : {}) } };
  return { reply: JSON.stringify(reply), ...(shared && psk ? { keys: deriveKeys(shared, psk, script, v) } : {}) };
}

/** The 96-bit nonce of frame `seq` in one direction: four zero bytes, then the number. */
export function nonceOf(seq: bigint): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(seq, 4);
  return iv;
}

/** Seals one frame: flag byte, then AES-256-GCM of `body` with its tag. */
export function sealFrame(key: Buffer, seq: bigint, flag: number, body: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonceOf(seq));
  c.setAAD(Buffer.of(flag));
  return Buffer.concat([Buffer.of(flag), c.update(body), c.final(), c.getAuthTag()]);
}

/** Opens one frame sealed with `seq`; throws when it does not open (altered, replayed, out of order, another key). */
export function openFrame(key: Buffer, seq: bigint, frame: Buffer): { flag: number; body: Buffer } {
  if (frame.length < 1 + TAG) throw new Error('short frame');
  const flag = frame[0];
  if (flag !== 0 && flag !== 1) throw new Error('bad flag');
  const d = createDecipheriv('aes-256-gcm', key, nonceOf(seq));
  d.setAAD(Buffer.of(flag));
  d.setAuthTag(frame.subarray(frame.length - TAG));
  return { flag, body: Buffer.concat([d.update(frame.subarray(1, frame.length - TAG)), d.final()]) };
}

/** What the phone endpoint needs of a phone's socket, plain or sealed. */
export interface Link {
  /** Frames go sealed (a secure pairing). */
  readonly secure: boolean;
  /** Open, not closing. */
  readonly open: boolean;
  /** Bytes waiting to go out (sealed ones still being packed included). */
  readonly buffered: number;
  send(text: string, cb?: (err?: Error) => void): void;
  /** Closes after what was sent before it. */
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
  /** Each frame's text; returns the way to stop listening. */
  onMessage(l: (text: string) => void): () => void;
  onClose(l: () => void): void;
  onPong(l: () => void): void;
}

const bufferOf = (raw: RawData): Buffer => (Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw));

/** A phone paired before the secure channel: JSON text frames as they were. */
export class PlainLink implements Link {
  readonly secure = false;
  constructor(private ws: WebSocket) {}
  get open() {
    return this.ws.readyState === this.ws.OPEN;
  }
  get buffered() {
    return this.ws.bufferedAmount;
  }
  send(text: string, cb?: (err?: Error) => void) {
    this.ws.send(text, cb);
  }
  close(code: number, reason: string) {
    this.ws.close(code, reason);
  }
  terminate() {
    this.ws.terminate();
  }
  ping() {
    this.ws.ping();
  }
  onMessage(l: (text: string) => void) {
    const f = (raw: RawData) => l(bufferOf(raw).toString('utf8'));
    this.ws.on('message', f);
    return () => void this.ws.off('message', f);
  }
  onClose(l: () => void) {
    this.ws.once('close', l);
  }
  onPong(l: () => void) {
    this.ws.on('pong', l);
  }
}

/**
 * A secure connection after its handshake: every frame sealed and opened in order. One that does not
 * open (or a plain text frame) ends it (`onBroken`, then the socket closes with 4005). Frames go out
 * in the order they were sent, a long one compressed first (off the main thread) when the phone can
 * inflate.
 */
export class SealedLink implements Link {
  readonly secure = true;
  private sendSeq = 0n;
  private recvSeq = 0n;
  private chain: Promise<void> = Promise.resolve();
  private packing = 0;
  private closing = false;
  private broken = false;
  private listeners = new Set<(text: string) => void>();

  constructor(
    private ws: WebSocket,
    private keys: ChannelKeys,
    private opts: { z: boolean; onBroken?: (why: string) => void },
  ) {
    ws.on('message', (raw, binary) => {
      if (this.broken) return;
      if (!binary) return this.fail('a plain frame on a secure connection');
      let text: string;
      try {
        const f = openFrame(this.keys.rx, this.recvSeq++, bufferOf(raw));
        // The phone never compresses what it sends.
        if (f.flag !== 0) throw new Error('compressed');
        text = f.body.toString('utf8');
      } catch {
        return this.fail('a frame that does not open');
      }
      for (const l of [...this.listeners]) l(text);
    });
  }

  private fail(why: string) {
    this.broken = true;
    this.opts.onBroken?.(why);
    this.ws.close(4005, 'unreadable frame');
  }

  get open() {
    return this.ws.readyState === this.ws.OPEN && !this.closing && !this.broken;
  }
  get buffered() {
    return this.ws.bufferedAmount + this.packing;
  }

  send(text: string, cb?: (err?: Error) => void) {
    if (!this.open) return void cb?.(new Error('closed'));
    const body = Buffer.from(text, 'utf8');
    const size = body.length;
    this.packing += size;
    const packed =
      this.opts.z && size >= DEFLATE_FROM
        ? deflate(body, { level: 5 }).then(
            (z) => (z.length < size ? { flag: 1, data: z } : { flag: 0, data: body }),
            () => ({ flag: 0, data: body }),
          )
        : Promise.resolve({ flag: 0, data: body });
    this.chain = this.chain
      .then(async () => {
        const p = await packed;
        this.packing -= size;
        if (this.ws.readyState !== this.ws.OPEN || this.broken) return void cb?.(new Error('closed'));
        this.ws.send(sealFrame(this.keys.tx, this.sendSeq++, p.flag, p.data), { binary: true, compress: false }, cb);
      })
      .catch((err) => cb?.(err as Error));
  }

  close(code: number, reason: string) {
    this.closing = true;
    this.chain = this.chain.then(() => this.ws.close(code, reason));
  }
  terminate() {
    this.closing = true;
    this.ws.terminate();
  }
  ping() {
    this.ws.ping();
  }
  onMessage(l: (text: string) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  onClose(l: () => void) {
    this.ws.once('close', l);
  }
  onPong(l: () => void) {
    this.ws.on('pong', l);
  }
}
