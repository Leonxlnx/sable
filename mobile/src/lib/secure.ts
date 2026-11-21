import { PHONE_SECURE_VERSION } from '@shared/protocol';

/**
 * The phone's side of the secure channel (the desktop's is server/services/phone-secure.ts), with
 * WebCrypto only: it runs in the app's WebView (a secure context, http://localhost) and in Node.
 *
 * 1. `startHandshake` makes an ephemeral P-256 ECDH key and the first frame (`PhoneSecHello`).
 * 2. `finish` reads the desktop's answer: its identity key must hash to the fingerprint the QR code
 *    gave (`f`), and its signature over the transcript must hold; the transcript names which answer
 *    it is (`outcome`: a channel, or a refusal, which always has words). Only then does a refusal
 *    count (the only kind that stops the phone for good), or are the keys made: HKDF-SHA256 over the ECDH secret and the pairing secret (`psk`: the QR
 *    code's one-time key, or the SHA-256 of this phone's token), salted with the transcript's hash.
 * 3. `Channel` seals and opens every frame after it (AES-256-GCM, a flag byte as AAD, the nonce the
 *    frame's sequence number in its direction): a frame that was replayed, dropped, reordered or
 *    altered does not open, and the connection ends.
 */

const LABEL = 'sable-phone/2';
const KEYS_INFO = 'sable-phone/2 keys';
/** The longest refusal a desktop sends. */
const REFUSAL_MAX = 2000;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

/** A copy backed by its own ArrayBuffer (what WebCrypto takes). */
const own = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export function b64u(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle().digest('SHA-256', own(b)));

/** The fingerprint of a desktop's identity key (SHA-256 of its SPKI, base64url), as the pairing link carries it. */
export const fingerprintOf = async (spki: Uint8Array) => b64u(await sha256(spki));

/** The pairing secret of a first pairing: the QR code's one-time key. */
export const pskOfKey = (key: string) => enc.encode(key);
/** The pairing secret of a phone paired before: the SHA-256 of its token (what the desktop keeps of it). */
export const pskOfToken = (token: string) => sha256(enc.encode(token));

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};

/** What the desktop signs: every field length-prefixed, in the desktop's order (version 2: the outcome before the refusal's words). */
export function transcript(kind: 'pair' | 'hello', id: string, pub: Uint8Array, z: boolean, deskPub: Uint8Array, spki: Uint8Array, outcome: 'ok' | 'denied', denied: string): Uint8Array<ArrayBuffer> {
  const parts = [enc.encode(LABEL), enc.encode(kind), enc.encode(id), pub, Uint8Array.of(z ? 1 : 0), deskPub, spki, enc.encode(outcome), enc.encode(denied)];
  return concat(...parts.flatMap((p) => [u32(p.length), p]));
}

/** Whether this WebView can inflate a compressed frame (Chrome 103 on). */
export function canInflate(): boolean {
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([own(b)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The answer did not come from the desktop this phone was paired with (its key or its signature is not that desktop's). */
export class IdentityError extends Error {
  readonly identity = true;
  constructor() {
    super('This is not the computer this phone was paired with. Pair again if Sable was set up anew there.');
  }
}

/** The 96-bit nonce of frame `seq`: four zero bytes, then the number. */
function nonceOf(seq: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(seq));
  return iv;
}

/**
 * A secure connection's frames, each sealed or opened in the order asked (the sequence number is
 * taken when asked; the work is chained). Once one does not open, every later one fails too.
 */
export class Channel {
  private sendSeq = 0;
  private recvSeq = 0;
  private outChain: Promise<unknown> = Promise.resolve();
  private inChain: Promise<unknown> = Promise.resolve();
  broken = false;

  constructor(
    private tx: CryptoKey,
    private rx: CryptoKey,
  ) {}

  /** The frame for `text` (never compressed: the phone's frames are small, and pictures do not shrink). */
  seal(text: string): Promise<Uint8Array> {
    const seq = this.sendSeq++;
    const p = this.outChain.then(async () => {
      const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonceOf(seq), additionalData: Uint8Array.of(0) }, this.tx, enc.encode(text)));
      return concat(Uint8Array.of(0), sealed);
    });
    this.outChain = p.catch(() => {});
    return p;
  }

  /** The text of the next frame from the desktop; rejects when it does not open (and from then on always). */
  open(frame: Uint8Array): Promise<string> {
    const seq = this.recvSeq++;
    const p = this.inChain.then(async () => {
      if (this.broken) throw new Error('The secure connection ended');
      try {
        const flag = frame[0];
        if (frame.length < 17 || (flag !== 0 && flag !== 1)) throw new Error('bad frame');
        const body = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: nonceOf(seq), additionalData: Uint8Array.of(flag) }, this.rx, own(frame.subarray(1))));
        return dec.decode(flag === 1 ? await inflate(body) : body);
      } catch (err) {
        this.broken = true;
        throw err;
      }
    });
    this.inChain = p.catch(() => {});
    return p;
  }
}

/** An answer that is not the shape Sable's answers have (an older desktop, something else at that address): never a refusal. */
export class MalformedError extends Error {
  readonly malformed = true;
  constructor() {
    super('The desktop did not answer as Sable does');
  }
}

export interface Handshake {
  /** The first frame to send (JSON text). */
  first: string;
  /**
   * Reads the desktop's answer: a channel, or its signed refusal (`denied`, verified: signed by the
   * pinned desktop, with words). Throws `IdentityError` for a desktop that is not the pinned one and
   * `MalformedError` for an answer of another shape (an empty refusal, a refusal and a channel both).
   */
  finish(reply: string, fingerprint: string, psk: Uint8Array): Promise<{ channel: Channel } | { denied: string }>;
}

export async function startHandshake(kind: 'pair' | 'hello', id = ''): Promise<Handshake> {
  const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const z = canInflate();
  const first = JSON.stringify({ sec: { v: PHONE_SECURE_VERSION, kind, ...(id ? { id } : {}), pub: b64u(pub), ...(z ? { z: true } : {}) } });
  return {
    first,
    async finish(reply, fingerprint, psk) {
      let r: Record<string, unknown> | undefined;
      try {
        const m = JSON.parse(reply) as { sec?: unknown };
        r = m && typeof m.sec === 'object' && m.sec ? (m.sec as Record<string, unknown>) : undefined;
      } catch {
        r = undefined;
      }
      if (!r || r.v !== PHONE_SECURE_VERSION || typeof r.pub !== 'string' || typeof r.key !== 'string' || typeof r.sig !== 'string') throw new MalformedError();
      // Exactly one of the two answers: a channel (no words), or a refusal with words.
      const outcome = r.outcome === 'ok' || r.outcome === 'denied' ? r.outcome : undefined;
      if (!outcome || (outcome === 'ok' ? r.denied !== undefined : typeof r.denied !== 'string' || !r.denied.trim() || r.denied.length > REFUSAL_MAX)) throw new MalformedError();
      const spki = unb64u(r.key);
      const deskPub = unb64u(r.pub);
      const sig = unb64u(r.sig);
      // The desktop pinned at pairing, and nobody else: its key, then its signature over this exchange.
      if ((await fingerprintOf(spki)) !== fingerprint) throw new IdentityError();
      let verifyKey: CryptoKey;
      try {
        verifyKey = await subtle().importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      } catch {
        throw new IdentityError();
      }
      const denied = outcome === 'denied' ? (r.denied as string) : '';
      const script = transcript(kind, id, pub, z, deskPub, spki, outcome, denied);
      if (sig.length !== 64 || !(await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, script))) throw new IdentityError();
      if (outcome === 'denied') return { denied };
      let peer: CryptoKey;
      try {
        peer = await subtle().importKey('raw', deskPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      } catch {
        throw new MalformedError();
      }
      const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256));
      const base = await subtle().importKey('raw', concat(shared, psk), 'HKDF', false, ['deriveBits']);
      const okm = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: await sha256(script), info: enc.encode(KEYS_INFO) }, base, 512));
      const tx = await subtle().importKey('raw', okm.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt']);
      const rx = await subtle().importKey('raw', okm.slice(32, 64), { name: 'AES-GCM' }, false, ['decrypt']);
      return { channel: new Channel(tx, rx) };
    },
  };
}
