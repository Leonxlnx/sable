import { PAIR_LINK_PREFIX, PHONE_PATH, type BridgeEvent, type PhoneFrame, type PhoneMethods, type PhoneRetryReply, type RpcMethods, type RpcResponse } from '@shared/protocol';

/** Everything the phone may ask: the allowlisted bridge methods and the phone endpoint's own. */
type Methods = RpcMethods & PhoneMethods;
import { eraseNative, loadMark, loadPairing, removePairing, saveMark, savePairing, type EraseMark } from './native';
import { mergeHosts, sameHosts } from './hosts';
import { busyError, isTransport, transportError } from './errors';
import { eraseAll, pageStorage } from './erase';
import { FORGET_FAILED } from './credential';
import { IdentityError, pskOfKey, pskOfToken, startHandshake, type Channel } from './secure';
import { onScreen } from './screen';

/** What the phone keeps after pairing: where the desktop is and the token it gave this phone. */
export interface Pairing {
  hosts: string[];
  port: number;
  token: string;
  deviceId: string;
  desktop: string;
  /** The address that answered last (tried first next time). */
  lastHost?: string;
  /**
   * The desktop's identity (its key's fingerprint, from the pairing link): present, every connection
   * is the secure channel and nothing else is accepted. Absent: paired before it (plain frames).
   */
  fp?: string;
}

/** A pairing link (version 2): `sable://pair/2?h=<ips>&p=<port>&s=<secret>&f=<fingerprint>&n=<desktop>`. */
export interface PairOffer {
  hosts: string[];
  port: number;
  key: string;
  name?: string;
  /** The desktop's identity fingerprint: every pairing pins one. */
  fp: string;
}

export type ConnState = 'unpaired' | 'connecting' | 'open' | 'offline' | 'denied';

/**
 * A pairing link as this app takes it: version 2 only, with a valid fingerprint (a new pairing is
 * never plain). Null for anything else; `isOldPairLink` tells an older desktop's link apart.
 */
export function parsePairLink(text: string): PairOffer | null {
  const t = text.trim();
  const at = t.toLowerCase().indexOf(PAIR_LINK_PREFIX);
  if (at < 0) return null;
  const m = /^[^\s]+/.exec(t.slice(at + PAIR_LINK_PREFIX.length));
  if (!m) return null;
  const q = new URLSearchParams(m[0]);
  const hosts = (q.get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => /^[\w.:-]+$/.test(h));
  const port = Number(q.get('p'));
  const key = q.get('s') ?? '';
  const fp = q.get('f') ?? '';
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || port > 65535 || key.length < 16 || key.length > 200) return null;
  if (!/^[\w-]{43}$/.test(fp)) return null;
  return { hosts, port, key, name: q.get('n') ?? undefined, fp };
}

/** A link from a desktop older than this app's pairing (`sable://pair?…`): it cannot pair securely. */
export const isOldPairLink = (text: string) => /sable:\/\/pair\?/i.test(text);

/**
 * What the camera takes as a pairing code (Scanner.tsx): a link this app pairs from, or an older
 * desktop's (pairing then says it is too old). Anything else keeps the camera looking.
 */
export const isPairCode = (text: string) => !!parsePairLink(text) || isOldPairLink(text);

/** A link again from an offer (Try again). */
export const offerLink = (o: PairOffer) => `${PAIR_LINK_PREFIX}h=${o.hosts.join(',')}&p=${o.port}&s=${o.key}&f=${o.fp}${o.name ? `&n=${encodeURIComponent(o.name)}` : ''}`;

/** A call waiting for its answer, on the one wire it went out on (an answer on another is not its answer). */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number; wire: Wire };

/** Calls over one authenticated secure wire to the desktop this phone is paired with (`conn.sealed`). */
export interface Sealed {
  /** The desktop's identity that wire proved. */
  readonly fp: string;
  call<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs?: number): Promise<Methods[M]['result']>;
}

/** The storage could not be read: pairing waits (a link would otherwise replace a pairing unseen). */
export const READ_FAILED = 'Sable could not read what this phone keeps. Close Sable and open it again.';
/** A pairing that could not be kept on the phone: nothing of it counts. */
export const KEEP_FAILED = 'This phone could not keep the pairing. Try again.';
/** A plain pairing that was to be replaced but is still on the desktop. */
export const OLD_STAYS = 'The earlier pairing is still listed on the computer. Remove it there in Settings › Phone.';
/** An erasure that did not finish: it goes on by itself (and at the next start); the pairing in use waits for it. */
export const ERASE_LEFT = 'Some of what this phone kept could not be removed yet. Sable tries again when it opens.';
/** What this phone kept as its pairing is there but cannot be read: nothing pairs until it is replaced (and erased). */
export const UNREADABLE = 'What this phone kept for its computer cannot be read. Scan a code to replace it.';

/**
 * The person has not confirmed that `offer` replaces the pairing this phone has (Pair.tsx shows
 * "Replace…?" and pairs again with the confirmation's token).
 */
export class ConfirmError extends Error {
  constructor(readonly was: Pairing) {
    super('Confirm first');
  }
}

/**
 * A pairing from before the secure channel that the new one cannot end: its desktop gave no
 * migration ticket (`unreached`: it did not answer over the old pairing, or is too old to; `other`:
 * it is another computer than the code's). Pairing goes on only when the person chooses so
 * (`separateFor`): the old entry then stays on that computer, to remove there.
 */
export class SeparateError extends Error {
  constructor(
    readonly was: Pairing,
    readonly why: 'unreached' | 'other',
  ) {
    super('The earlier pairing cannot be ended from here');
  }
}

/** How a pairing ended the one it replaced: `removed` (the desktop said it removed exactly that device), `stays` (still listed there). */
export interface PairResult {
  old?: 'removed' | 'stays';
}

/** What `pair` shows in place of the pairing it would replace while the kept one cannot be read. */
const UNREAD_PAIRING: Pairing = { hosts: [], port: 0, token: '', deviceId: '', desktop: '' };

const url = (host: string, port: number) => import.meta.env.SABLE_WEB ? `wss://${location.host}/sable-web` : `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}${PHONE_PATH}`;

/** A refusal this phone may act on for good: signed by the pinned desktop (or, plain, from a pairing before the secure channel). */
const refusal = (text: string) => Object.assign(new Error(text), { denied: true as const });
const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true as const });
const isRefusal = (e: unknown) => !!(e as { denied?: boolean } | undefined)?.denied;

/** `p`, or a rejection as soon as `signal` aborts. */
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const off = () => reject(cancelled());
    signal.addEventListener('abort', off, { once: true });
    p.then(
      (v) => (signal.removeEventListener('abort', off), resolve(v)),
      (e) => (signal.removeEventListener('abort', off), reject(e)),
    );
  });
}

/**
 * One connection's frames as text, whatever carries them: plain JSON text (a phone paired before the
 * secure channel), or sealed binary frames opened in order (`SealedWire`).
 */
interface Wire {
  readonly secure: boolean;
  /** The desktop identity its handshake proved (a secure wire only). */
  readonly fp?: string;
  readonly socket: WebSocket;
  readonly ready: boolean;
  send(text: string): void;
  close(): void;
  onText: ((text: string) => void) | null;
  onClose: ((code: number) => void) | null;
}

class PlainWire implements Wire {
  readonly secure = false;
  get socket() {
    return this.ws;
  }
  onText: ((text: string) => void) | null = null;
  onClose: ((code: number) => void) | null = null;
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => this.onText?.(typeof ev.data === 'string' ? ev.data : '');
    ws.onclose = (ev) => this.onClose?.(ev.code);
  }
  get ready() {
    return this.ws.readyState === WebSocket.OPEN;
  }
  send(text: string) {
    this.ws.send(text);
  }
  close() {
    this.ws.close();
  }
}

/** The secure channel's frames: each sealed as it goes, each opened in order; one that does not open ends the connection. */
class SealedWire implements Wire {
  readonly secure = true;
  get socket() {
    return this.ws;
  }
  onText: ((text: string) => void) | null = null;
  onClose: ((code: number) => void) | null = null;
  constructor(
    private ws: WebSocket,
    private ch: Channel,
    readonly fp: string,
  ) {
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (this.ch.broken) return;
      if (typeof ev.data === 'string') return this.fail();
      void this.ch.open(new Uint8Array(ev.data as ArrayBuffer)).then(
        (text) => this.onText?.(text),
        () => this.fail(),
      );
    };
    ws.onclose = (ev) => this.onClose?.(ev.code);
  }
  private fail() {
    this.ch.broken = true;
    // Altered or out of order on the way: this connection is not to be trusted any further.
    this.ws.close(4005, 'unreadable frame');
  }
  get ready() {
    return this.ws.readyState === WebSocket.OPEN && !this.ch.broken;
  }
  send(text: string) {
    const ws = this.ws;
    void this.ch.seal(text).then((b) => ws.readyState === WebSocket.OPEN && ws.send(b));
  }
  close() {
    this.ws.close();
  }
}

/** How long a desktop has to answer the handshake (tests shorten it). */
export const TIMING = { handshake: 8000 };

/**
 * The secure handshake on an open socket: the desktop must answer as the one `fp` names. Resolves
 * with the sealed wire; rejects with the desktop's signed refusal (`denied`: verified), an
 * `IdentityError` (someone else answered: never a refusal), or when it closes or says nothing. The
 * socket is closed on every way it fails.
 */
function secureWire(ws: WebSocket, kind: 'pair' | 'hello', id: string, fp: string, psk: Promise<Uint8Array> | Uint8Array): Promise<Wire> {
  return new Promise<Wire>((resolve, reject) => {
    let over = false;
    const fail = (err: Error) => {
      if (over) return;
      over = true;
      clearTimeout(silent);
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
      reject(err);
    };
    const silent = window.setTimeout(() => fail(new Error('The desktop did not answer')), TIMING.handshake);
    ws.onclose = (ev) => {
      // An older desktop does not know this secure hello.
      fail(new Error(ev.code === 4000 ? 'Update Sable on the computer to connect securely' : 'The desktop closed the connection'));
    };
    void startHandshake(kind, id).then((hs) => {
      if (over) return;
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return fail(new Error('The desktop did not answer as Sable does'));
        ws.onmessage = null;
        void Promise.resolve(psk)
          .then((key) => hs.finish(ev.data as string, fp, key))
          .then(
            (r) => {
              if (over) return;
              if ('denied' in r) return fail(refusal(r.denied));
              over = true;
              clearTimeout(silent);
              ws.onclose = null;
              resolve(new SealedWire(ws, r.channel, fp));
            },
            (err: Error) => fail(err),
          );
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(hs.first);
    }, fail);
  });
}

/** Which failure says most about why none of the addresses worked: a verified refusal, then someone else answering, then the rest. */
const rank = (e: unknown) => (isRefusal(e) ? 3 : e instanceof IdentityError ? 2 : (e as Error)?.message === 'The desktop did not answer' ? 0 : 1);

/**
 * Reaches the desktop at the first of `hosts` that gets through `auth` (the secure handshake: the
 * pinned desktop's signed answer), the last good one first and the others a moment later. Something
 * else answering fast at one address never hides the desktop at another: it has to get through the
 * handshake to count. A verified refusal from the desktop ends it at once. Every socket that does not
 * win is closed, as is every socket on a timeout or when `signal` aborts.
 */
function reach(hosts: string[], port: number, auth: (ws: WebSocket) => Promise<Wire>, opts: { first?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ wire: Wire; host: string }> {
  const order = opts.first && hosts.includes(opts.first) ? [opts.first, ...hosts.filter((h) => h !== opts.first)] : hosts;
  return new Promise((resolve, reject) => {
    const sockets = new Set<WebSocket>();
    const timers: number[] = [];
    let done = false;
    let failed = 0;
    let best: unknown = new Error('The desktop did not answer');
    const finish = (err?: unknown, keep?: WebSocket) => {
      done = true;
      timers.forEach(clearTimeout);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const s of sockets) if (s !== keep) s.close();
      sockets.clear();
      if (err) reject(err);
    };
    const onAbort = () => !done && finish(cancelled());
    if (opts.signal?.aborted) return finish(cancelled());
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const lose = (ws: WebSocket | undefined, err: unknown) => {
      if (done) return;
      if (ws) {
        sockets.delete(ws);
        ws.close();
      }
      if (rank(err) >= rank(best)) best = err;
      if (isRefusal(err)) return finish(err);
      if (++failed === order.length) finish(best);
    };
    timers.push(window.setTimeout(() => !done && finish(best), opts.timeoutMs ?? TIMING.handshake + 4000));
    order.forEach((host, i) => {
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          let ws: WebSocket;
          try {
            ws = new WebSocket(url(host, port));
          } catch (err) {
            return lose(undefined, err);
          }
          sockets.add(ws);
          let opened = false;
          // Each address counts once, however many ways its socket ends (a failed socket says both error and close).
          let settled = false;
          const fail = (err: unknown) => {
            if (settled) return;
            settled = true;
            lose(ws, err);
          };
          ws.onerror = () => !opened && fail(new Error('The desktop did not answer'));
          ws.onclose = () => !opened && fail(new Error('The desktop did not answer'));
          ws.onopen = () => {
            opened = true;
            ws.onerror = null;
            if (done) return ws.close();
            auth(ws).then(
              (wire) => {
                if (done || settled) return wire.close();
                settled = true;
                finish(undefined, ws);
                resolve({ wire, host });
              },
              fail,
            );
          };
        }, i === 0 ? 0 : 450 + i * 150),
      );
    });
  });
}

/**
 * What an attempt that ended (well or not) is now (2.16): `mine` while it is still the attempt in use
 * (the same number, credential generation and pairing): it reports for itself. `superseded` once a
 * newer attempt began: that one reports. `stale` when the credential generation moved on under it
 * with no newer attempt (whoever moved it, a pairing kept or forgotten, decides what connects next):
 * it only lets go of "connecting". `orphaned` when, in the same generation, the pairing object was
 * replaced under it (the saved pairing read a second time): nobody else reports for it, so it lets go
 * and connects again with the pairing now in use. Before, both stayed "connecting", and every later
 * attempt returned at once: the phone said "Connecting" until it was closed.
 */
export function attemptEnd(a: { attempt: number; attemptId: number; sameGen: boolean; samePairing: boolean }): 'mine' | 'superseded' | 'stale' | 'orphaned' {
  if (a.attempt !== a.attemptId) return 'superseded';
  if (!a.sameGen) return 'stale';
  return a.samePairing ? 'mine' : 'orphaned';
}

/** The phone's connection to its desktop: pairing, the token hello, RPC and events, reconnecting on its own. */
class Conn {
  state: ConnState = 'unpaired';
  pairing: Pairing | null = null;
  error?: string;

  /** A plain HTTP address on the desktop's phone endpoint, at the host last reached (a legacy pairing's download link). */
  httpUrl(path: string): string | null {
    const p = this.pairing;
    const host = p?.lastHost ?? p?.hosts[0];
    if (!p || !host) return null;
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${p.port}${path}`;
  }

  /** This connection is the secure channel to the desktop this phone is paired with (proven, every frame sealed). */
  get secure(): boolean {
    return !!this.sealed();
  }

  /** Paired over the secure channel (false: an older pairing, to pair again). */
  get pairedSecurely(): boolean {
    return !!this.pairing?.fp;
  }

  /**
   * The wire in use, when it is a secure one whose handshake proved the very desktop this phone is
   * paired with: calls through it go over that wire only. A newer wire, a new pairing, or none at all
   * fails them as lost (never sends them elsewhere), so a file's start, its chunks and its digest all
   * come from that one authenticated desktop. Null otherwise.
   */
  sealed(): Sealed | null {
    const w = this.wire;
    const p = this.pairing;
    if (!w || !p?.fp || !w.secure || w.fp !== p.fp || !w.ready || this.state !== 'open') return null;
    const gen = this.gen;
    const fp = p.fp;
    return {
      fp,
      call: (method, params, timeoutMs) =>
        this.wire === w && this.gen === gen && this.pairing?.fp === fp ? this.callOn(w, method, params, timeoutMs) : Promise.reject(transportError('The connection to the desktop was lost', 'lost')),
    };
  }

  /** A live wire carries the pairing in use. */
  private live(): boolean {
    return !!this.wire?.ready;
  }

  private wire?: Wire;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: BridgeEvent) => void>();
  private stateListeners = new Set<() => void>();
  private openListeners = new Set<() => void>();
  private noticeListeners = new Set<(text: string) => void>();
  private retry = 0;
  private retryTimer?: number;
  private connecting = false;

  /**
   * The credential generation: every attempt, wire and call belongs to one. It moves on when a pairing
   * is kept or forgotten, so nothing begun with the old credential (a reconnect that answers late, a
   * call still waiting) can take over or be answered afterwards.
   */
  private gen = 0;
  /** While a new pairing is under way the old credential stays still (no reconnect with it until the pairing ends). */
  private holdOld = false;
  /** The erasure under way, as kept on the phone's storage (native.ts `EraseMark`). */
  private mark: EraseMark | null = null;
  /**
   * What this phone keeps was read (`ok`), could not be (`failed`: nothing pairs), was there but is
   * not a pairing (`damaged`: a code replaces it once the person confirms, erasing first), or not yet.
   */
  lookup: 'pending' | 'ok' | 'failed' | 'damaged' = 'pending';
  /** The erasure under way (one at a time; a reconnect waits for it). */
  private erasing?: Promise<boolean>;

  /** Something of a computer this phone no longer uses is still to be erased: the pairing in use does not connect until it is. */
  get cleaning(): boolean {
    return !!this.mark;
  }
  private lookedUp!: () => void;
  /** Settles once the saved pairing was looked up: pairing waits for it. */
  readonly ready = new Promise<void>((r) => (this.lookedUp = r));
  /** Pairing writes, one at a time in the order made (a late write of an older pairing never lands over a newer one). */
  private writes: Promise<unknown> = Promise.resolve();

  private started?: Promise<void>;

  /** Looks up the saved pairing and connects with it, once (a second call, as React's development double effect makes, waits for the first). */
  init(): Promise<void> {
    return (this.started ??= this.start());
  }

  private async start() {
    // A network that comes back (Wi-Fi again after mobile data) reconnects at once.
    window.addEventListener('online', () => this.wake());
    let got: [EraseMark | null, Pairing | null] | undefined;
    let damaged = false;
    // A read that fails is not "nothing saved": tried again a moment later, then pairing waits.
    for (let i = 0; i < 3 && !got; i++) {
      try {
        const [mark, pairing] = await Promise.all([
          loadMark(),
          // There but not a pairing: not "none" either (it is replaced only once the person confirms).
          loadPairing().catch((err: unknown) => {
            if (!(err as { damaged?: boolean } | undefined)?.damaged) throw err;
            damaged = true;
            return null;
          }),
        ]);
        got = [mark, pairing];
      } catch {
        damaged = false;
        await new Promise((r) => window.setTimeout(r, 150 * (i + 1)));
      }
    }
    if (!got) {
      this.lookup = 'failed';
      this.lookedUp();
      this.setState('unpaired', READ_FAILED);
      return;
    }
    [this.mark, this.pairing] = got;
    this.lookup = 'ok';
    // An erasure that Android cut off (Forget, or a replacement by another computer) goes on before anything else.
    if (this.mark) {
      const kept = !!this.mark.to && this.pairing?.deviceId === this.mark.to;
      let gone = true;
      if (this.mark.forget && !kept) {
        // The old token goes first; when it cannot, it is not used (the mark stays, tried again next time).
        gone = await removePairing().then(
          () => true,
          () => false,
        );
        this.pairing = null;
        if (gone) damaged = false;
      }
      if (this.mark.forget || kept) {
        if (!(await this.eraseData(gone))) this.notice(ERASE_LEFT);
      } else if (!damaged) {
        // A replacement that never got as far as keeping its pairing: nothing to erase (and nothing waits for it).
        await this.setMark(null).catch(() => {});
        this.mark = null;
      }
    }
    if (damaged) this.lookup = 'damaged';
    this.lookedUp();
    if (damaged) this.setState('unpaired', UNREADABLE);
    else if (this.pairing) void this.connect();
    else this.setState('unpaired');
  }

  /** Something the person should know that is not a state (an erasure left for later). */
  onNotice(l: (text: string) => void) {
    this.noticeListeners.add(l);
    return () => void this.noticeListeners.delete(l);
  }

  private notice(text: string) {
    for (const l of this.noticeListeners) l(text);
  }

  private async setMark(m: EraseMark | null) {
    await saveMark(m);
    this.mark = m && (m.forget || m.to) ? m : null;
  }

  /**
   * Erases what was kept for the desktop (lib/erase.ts) and, when nothing is left, the mark: true
   * only once both are done. When something is left (or the mark could not go), the mark stays: the
   * pairing in use does not connect until a later try worked (`connect`), and the next start goes
   * on with it too. One erasure at a time (a second ask waits for the one under way).
   */
  private eraseData(done = true): Promise<boolean> {
    if (this.erasing) return this.erasing.then((ok) => ok && done);
    const run = (async () => {
      const failed = await eraseAll({ storage: pageStorage(), native: eraseNative });
      if (failed.length || !done) return false;
      return this.setMark(null).then(
        () => true,
        () => false,
      );
    })();
    this.erasing = run;
    void run.finally(() => this.erasing === run && (this.erasing = undefined));
    return run;
  }

  /** The pairing written in order; it lands only while it is still the pairing this phone uses (or is about to). */
  private write(p: Pairing, still: () => boolean): Promise<void> {
    const next = this.writes.then(() => (still() ? savePairing(p) : undefined));
    this.writes = next.catch(() => {});
    return next;
  }

  private setState(s: ConnState, error?: string) {
    this.state = s;
    this.error = error;
    for (const l of this.stateListeners) l();
  }

  onState(l: () => void) {
    this.stateListeners.add(l);
    return () => void this.stateListeners.delete(l);
  }

  /** Called each time the connection (re)opens: reload what is shown. */
  onOpen(l: () => void) {
    this.openListeners.add(l);
    return () => void this.openListeners.delete(l);
  }

  on(l: (e: BridgeEvent) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  /** The app went to the background: noted, so coming back after a while starts a fresh connection. */
  sleep() {
    if (!this.hiddenAt) this.hiddenAt = Date.now();
  }

  /**
   * Reconnects now (the app came back to the front, the network changed). Android cuts the network
   * of an app in the background, so after a while away the socket may look open and be dead, and
   * an attempt begun in the background may hang: either way a fresh connection starts at once (the
   * old socket keeps the screen until the new one is in). After a short absence a small call checks
   * the socket instead. Only a verified refusal stops it for good (`denied`).
   */
  wake() {
    if (!this.pairing || this.state === 'denied' || this.holdOld) return;
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    // Said to be open with no live wire under it (one closed for a pairing given up): it reconnects.
    if (this.state === 'open' && this.live() && away < 15_000) {
      this.check(3000);
      return;
    }
    // An attempt begun a moment ago (the same wake heard twice) is left to finish.
    if (this.connecting && performance.now() - this.attemptAt < 2000) return;
    this.cancelAttempt();
    clearTimeout(this.retryTimer);
    this.retry = 0;
    void this.connect();
  }

  /**
   * Asks the desktop a small question on the wire in use; no answer within `timeoutMs` and the wire
   * is let go and a fresh connection starts. A socket that died silently (the desktop slept, the
   * phone changed networks, a frozen page) may never say so: its close waits on a network that is
   * gone, and the desktop's pings are answered by the network stack whatever the page does. Called
   * back on screen after a short absence, and once a minute off screen while a chat works (App.tsx),
   * so a lost connection reads as lost and the live cards never show a stale "Working".
   */
  check(timeoutMs = 10_000) {
    if (this.state !== 'open' || !this.live()) return;
    const w = this.wire;
    void this.call('usage.limits', {}, timeoutMs).catch((err) => {
      // In a browser the desktop answers this with a no (web access's allowlist): the connection is alive
      // then, and only a call the connection lost or never answered says otherwise. The app as before.
      if (this.wire !== w || (import.meta.env.SABLE_WEB && !isTransport(err))) return;
      // It is let go now and a fresh connection starts, not after its close event.
      this.dropWire();
      if (this.state === 'denied' || this.holdOld) return;
      this.setState('offline', 'Reconnecting');
      this.cancelAttempt();
      clearTimeout(this.retryTimer);
      this.retry = 0;
      void this.connect();
    });
  }

  private attemptAt = 0;

  private hiddenAt = 0;
  /** Each attempt has a number; a newer one supersedes it (its socket is closed when it answers late). */
  private attemptId = 0;
  private abortAttempt?: () => void;

  /** Gives up the attempt in progress (it hung while the network was cut). */
  private cancelAttempt() {
    if (!this.connecting) return;
    this.attemptId++;
    this.abortAttempt?.();
    this.abortAttempt = undefined;
    this.connecting = false;
  }

  async connect() {
    const p = this.pairing;
    // While a new pairing is under way, the old credential does not reconnect (pair() goes on with it if that pairing ends).
    if (!p || this.connecting || this.holdOld) return;
    // What was kept for a computer this phone no longer uses goes first: until it is gone (and its
    // mark), this pairing does not connect, so nothing of it lands among what that erasure removes.
    if (this.mark) {
      this.connecting = true;
      let clean = false;
      try {
        clean = await this.eraseData();
      } finally {
        this.connecting = false;
      }
      if (this.pairing !== p || this.holdOld) return;
      if (!clean) {
        if (this.state !== 'offline' || this.error !== ERASE_LEFT) this.setState('offline', ERASE_LEFT);
        this.scheduleRetry();
        return;
      }
    }
    this.connecting = true;
    const attempt = ++this.attemptId;
    const gen = this.gen;
    this.attemptAt = performance.now();
    // This attempt, of this credential: a newer attempt, a pairing kept or Forget make it moot.
    const current = () => attempt === this.attemptId && gen === this.gen && this.pairing === p;
    clearTimeout(this.retryTimer);
    // Retries on their own keep "offline" on screen (it would flicker with every attempt); the first
    // attempt, and one asked for (`wake`: Try again, back to the front, a network change), say "connecting".
    if (this.state !== 'open' && !(this.state === 'offline' && this.retry > 0)) this.setState('connecting');
    const ac = new AbortController();
    let wire: Wire | undefined;
    this.abortAttempt = () => {
      ac.abort();
      wire?.close();
    };
    try {
      // Paired securely: every address races through the handshake (the desktop proves who it is first), and the token goes only inside the channel.
      const auth = p.fp ? (ws: WebSocket) => secureWire(ws, 'hello', p.deviceId, p.fp!, pskOfToken(p.token)) : async (ws: WebSocket) => new PlainWire(ws);
      const reached = await reach(p.hosts, p.port, auth, { first: p.lastHost, signal: ac.signal });
      wire = reached.wire;
      const host = reached.host;
      if (!current()) throw cancelled();
      const w = wire;
      await abortable(
        new Promise<void>((resolve, reject) => {
          // Open but silent (the network went away after the handshake): given up, not waited on forever.
          const silent = window.setTimeout(() => reject(new Error('The desktop did not answer')), 8000);
          w.onText = (text) => {
            let f: PhoneFrame;
            try {
              f = JSON.parse(text);
            } catch {
              return;
            }
            if ('welcome' in f) {
              clearTimeout(silent);
              if (!current()) return reject(cancelled());
              // The welcome of another device is not this pairing's.
              if (typeof f.welcome?.deviceId === 'string' && f.welcome.deviceId !== p.deviceId) return reject(new Error('The desktop did not answer as Sable does'));
              if (!this.adopt(w, gen)) return reject(cancelled());
              // The desktop's addresses now join the saved ones (Tailscale installed after pairing: reachable there next time).
              const hosts = mergeHosts(p.hosts, f.welcome.hosts, host);
              if (p.lastHost !== host || p.desktop !== f.welcome.desktop || !sameHosts(hosts, p.hosts)) {
                p.lastHost = host;
                p.desktop = f.welcome.desktop;
                p.hosts = hosts;
                void this.write({ ...p }, () => this.pairing === p && this.gen === gen).catch(() => {});
              }
              resolve();
            } else if ('denied' in f && typeof f.denied === 'string' && f.denied.trim()) {
              clearTimeout(silent);
              reject(refusal(f.denied));
            }
          };
          w.onClose = (code) => {
            clearTimeout(silent);
            // A plain close code says nothing on a secure connection (anyone on the way can send one): only a sealed refusal counts there.
            reject(code === 4001 && !w.secure ? refusal('This phone was removed on the desktop') : new Error('The desktop closed the connection'));
          };
          w.send(JSON.stringify({ hello: { token: p.token } }));
        }),
        ac.signal,
      );
    } catch (err) {
      if (wire && !this.owns(wire.socket)) {
        wire.onClose = null;
        wire.close();
      }
      // A newer attempt took over: it reports for itself.
      if (!current()) return;
      const e = err as Error;
      if (isRefusal(e)) {
        this.setState('denied', e.message);
      } else {
        // The old socket (kept on screen while this one was tried) is no good either.
        if (this.wire && this.state === 'open') {
          this.wire.close();
          return;
        }
        // Someone else answering as the desktop is said, and tried again later: it never stops this phone for good.
        this.setState('offline', e.message);
        this.scheduleRetry();
      }
    } finally {
      const end = attemptEnd({ attempt, attemptId: this.attemptId, sameGen: gen === this.gen, samePairing: this.pairing === p });
      if (end !== 'superseded') {
        this.connecting = false;
        this.abortAttempt = undefined;
      }
      // Nobody else reports for this attempt: the pairing in use now connects (or waits, when there is none).
      if (end === 'orphaned' && this.pairing && !this.holdOld && this.state !== 'denied' && !this.live()) {
        clearTimeout(this.retryTimer);
        this.retry = 0;
        queueMicrotask(() => void this.connect());
      }
    }
  }

  /** The socket under the connection in use (an attempt's own socket is not it). */
  private owns(ws: WebSocket) {
    return this.wire?.socket === ws;
  }

  /**
   * Backoff with a little jitter: 0.6, 1.2, 2.4, 4.8 s, then every 8 s while the app is on screen
   * (15 s off screen: kept awake there only while a chat works, lib/screen.ts). Coming back to the
   * front, a network change or a tap on "Try again" reconnects at once (`wake`).
   */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const cap = onScreen() ? 8000 : 15_000;
    const delay = Math.min(cap, 600 * 2 ** this.retry++) * (0.85 + Math.random() * 0.3);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  /** Calls still waiting on `wire` fail now (their socket is gone); `transport` marks that the desktop may have done them. */
  private failPending(text: string, wire: Wire) {
    for (const [id, p] of this.pending) {
      if (p.wire !== wire) continue;
      clearTimeout(p.timer);
      p.reject(transportError(text, 'lost'));
      this.pending.delete(id);
    }
  }

  /** The wire in use goes, quietly (a pairing replacing it, Forget): its calls fail as lost. */
  private dropWire() {
    const w = this.wire;
    this.wire = undefined;
    if (!w) return;
    w.onText = null;
    w.onClose = null;
    w.close();
    this.failPending('The connection to the desktop was lost', w);
  }

  /**
   * An authenticated connection becomes the one in use, if it belongs to the credential generation
   * in use (`gen`); false (and closed) when it does not: a reconnect with an older credential that
   * answered after a new pairing was kept never takes over.
   */
  private adopt(wire: Wire, gen: number): boolean {
    if (gen !== this.gen || (wire.secure && wire.fp !== this.pairing?.fp)) {
      wire.onText = null;
      wire.onClose = null;
      wire.close();
      return false;
    }
    // One connection feeds the store, never two: a second one would apply every streamed piece twice.
    // Calls sent on the old connection get no answer: they fail now, not after their timeout.
    if (this.wire !== wire) this.dropWire();
    this.wire = wire;
    this.retry = 0;
    wire.onText = (text) => {
      let f: RpcResponse | { event: BridgeEvent } | PhoneFrame;
      try {
        f = JSON.parse(text);
      } catch {
        return;
      }
      if ('event' in f) {
        for (const l of this.listeners) l(f.event);
        return;
      }
      if ('denied' in f) {
        // Words are what a refusal is: an empty one is not taken as one.
        if (typeof f.denied === 'string' && f.denied.trim()) this.setState('denied', f.denied);
        return;
      }
      if (!('id' in f)) return;
      const pending = this.pending.get(f.id);
      // Only an answer on the wire the call went out on is its answer.
      if (!pending || pending.wire !== wire) return;
      this.pending.delete(f.id);
      clearTimeout(pending.timer);
      if (f.ok) pending.resolve(f.result);
      // Busy, not refused (`PhoneRetryReply`): whoever asked may ask the same again after the wait.
      else if ((f as Partial<PhoneRetryReply>).retry === true && Number.isFinite((f as Partial<PhoneRetryReply>).retryAfterMs)) pending.reject(busyError(String(f.error), (f as PhoneRetryReply).retryAfterMs));
      else pending.reject(new Error(f.error));
    };
    wire.onClose = (code) => {
      if (this.wire !== wire) return;
      this.wire = undefined;
      this.failPending('The connection to the desktop was lost', wire);
      // On a secure connection only a sealed refusal says the phone was removed (it came before the close); a bare code is just a close.
      if (code === 4001 && !wire.secure) {
        this.setState('denied', 'This phone was removed on the desktop');
        return;
      }
      if (this.state !== 'denied') {
        this.setState('offline', 'Reconnecting');
        this.scheduleRetry();
      }
    };
    this.setState('open');
    for (const l of this.openListeners) l();
    return true;
  }

  call<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs = 30_000): Promise<Methods[M]['result']> {
    return this.callOn(this.wire, method, params, timeoutMs);
  }

  /** A call on `wire`, only while it is the wire in use. */
  private callOn<M extends keyof Methods>(wire: Wire | undefined, method: M, params: Methods[M]['params'], timeoutMs = 30_000): Promise<Methods[M]['result']> {
    if (!wire || !wire.ready || wire !== this.wire) return Promise.reject(transportError('Not connected to the desktop', 'unsent'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        // The desktop may have done it: whoever asked looks again (lib/errors.ts).
        reject(transportError('The desktop did not answer in time', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, wire });
      wire.send(JSON.stringify({ id, method, params }));
    });
  }

  // ── pairing ──

  /** The pairing in progress: Back or Cancel aborts it at whatever step it is, with every socket it opened. */
  private pairOp?: AbortController;

  /** Starts a pairing's generation (before its first wait: the device's name, the hosts); a newer one ends an older one. */
  beginPair(): AbortSignal {
    this.pairOp?.abort();
    this.pairOp = new AbortController();
    return this.pairOp.signal;
  }

  /** Gives up a pairing in progress (the desktop's question goes away with the socket). */
  cancelPair() {
    this.pairOp?.abort();
    this.pairOp = undefined;
  }

  /**
   * The pairing this phone has would be replaced by `offer` (another desktop, or this one again from a
   * pairing before the secure channel): the phone asks first (Pair.tsx).
   */
  replaces(offer: PairOffer): Pairing | null {
    // Kept but unreadable: whatever it was, a code replaces it only once the person says so.
    if (this.lookup === 'damaged') return UNREAD_PAIRING;
    const p = this.pairing;
    return p && p.fp !== offer.fp ? p : null;
  }

  /**
   * The person's confirmation that `offer` replaces the pairing this phone has now: a token bound to
   * that pairing (its pin, or its device for one from before the secure channel) and to this offer
   * (its key and its one-time secret). `pair` takes only the token of the pairing it would replace at
   * that moment, so a pairing that became known after the question was asked (a cold start's link
   * read before the saved pairing) asks again. Undefined when nothing would be replaced.
   */
  confirmFor(offer: PairOffer): string | undefined {
    if (this.lookup === 'damaged') return `unreadable|${offer.fp}|${offer.key}`;
    const p = this.replaces(offer);
    return p ? `${p.fp ?? 'plain'}|${p.deviceId}|${offer.fp}|${offer.key}` : undefined;
  }

  /**
   * The person's choice to pair with `offer` although the pairing from before the secure channel it
   * replaces cannot be ended from here (`SeparateError`): bound to that pairing and to this offer, as
   * `confirmFor` is. Undefined when nothing such would be replaced.
   */
  separateFor(offer: PairOffer): string | undefined {
    const p = this.lookup === 'ok' ? this.pairing : null;
    return p && !p.fp ? `separate|${p.deviceId}|${offer.fp}|${offer.key}` : undefined;
  }

  /**
   * Pairs with a desktop over the secure channel (the link's fingerprint pinned; the one-time secret
   * goes only inside): presents the secret, waits while the desktop asks "Allow?", keeps the token it
   * gives. `onWaiting` runs once the desktop has the request. A pairing from before the secure channel
   * with this same desktop is replaced by the migration ticket that desktop gives over that pairing
   * (`phone.migrate`, only when its fingerprint is the link's); its token never goes to the new peer.
   * Until the new pairing is allowed and kept the old one stays (a pairing given up connects with it
   * again). Nothing pairs before the saved pairing was read, and one that would be replaced needs the
   * person's `confirmed` token for it (`confirmFor`; otherwise a `ConfirmError`). A pairing from
   * before the secure channel that this one cannot end (no ticket: its desktop did not answer, or is
   * another computer) stops it with a `SeparateError` until the person chooses to pair anyway
   * (`separate`, the token of `separateFor`). Kept but unreadable data is replaced only with the
   * person's confirmation, and erased before anything else is paired. `signal` (`beginPair`) aborts it
   * at any step until the pairing is being kept. Resolves with whether the old pairing went (`old`).
   */
  async pair(offer: PairOffer, name: string, onWaiting: () => void, signal?: AbortSignal, confirmed?: string, separate?: string): Promise<PairResult> {
    if (!/^[\w-]{43}$/.test(offer.fp ?? '')) throw new Error('That is not a Sable pairing link');
    await abortable(this.ready, signal);
    if (this.lookup === 'damaged') {
      if (confirmed !== this.confirmFor(offer)) throw new ConfirmError(UNREAD_PAIRING);
      // Whatever it was goes first, with everything kept for it; only a clean phone pairs.
      if (!(await this.retire(false))) throw new Error(ERASE_LEFT);
      if (signal?.aborted) throw cancelled();
    }
    if (this.lookup !== 'ok') throw new Error(READ_FAILED);
    const before = this.pairing;
    if (before && this.replaces(offer) && confirmed !== this.confirmFor(offer)) throw new ConfirmError(before);
    try {
      let replaces: { id: string; ticket: string } | undefined;
      if (before && !before.fp && !(separate && separate === this.separateFor(offer))) {
        const got = await this.migrationTicket(before, offer.fp, signal);
        // No ticket: the old pairing would stay valid on its computer. That is the person's choice to make, before anything is sent.
        if (got === 'unreached' || got === 'other') throw new SeparateError(before, got);
        replaces = got;
      }
      if (signal?.aborted) throw cancelled();
      if (this.pairing !== before) throw new Error('The pairing on this phone changed meanwhile. Try again.');
      // From here the old credential stays still: no reconnect with it while the desktop is asked.
      this.holdOld = true;
      this.forgetSocket();
      return await this.pairWith(offer, name, onWaiting, before, replaces, signal);
    } catch (err) {
      this.holdOld = false;
      // Given up, refused or not kept: the pairing this phone had goes on as it was, with a live wire again.
      if (this.pairing && this.pairing === before && !this.live()) {
        this.retry = 0;
        void this.connect();
      }
      throw err;
    } finally {
      this.holdOld = false;
    }
  }

  /**
   * Over the old plain pairing: the desktop's fingerprint and a one-time ticket. `other` when that
   * desktop is not the link's (another computer: its old entry stays there, to remove on it);
   * `unreached` when it cannot be reached, does not answer in time or is too old to say.
   */
  private async migrationTicket(before: Pairing, fp: string, signal?: AbortSignal): Promise<{ id: string; ticket: string } | 'unreached' | 'other'> {
    try {
      if (this.state !== 'open' || this.wire?.secure !== false) {
        this.wake();
        await abortable(
          new Promise<void>((resolve, reject) => {
            const t = window.setTimeout(() => (off(), reject(new Error('The desktop did not answer'))), 8000);
            const off = this.onState(() => {
              if (this.state === 'open') (clearTimeout(t), off(), resolve());
              else if (this.state === 'denied') (clearTimeout(t), off(), reject(new Error('refused')));
            });
          }),
          signal,
        );
      }
      if (this.pairing !== before || this.wire?.secure !== false) return 'unreached';
      const r = await abortable(this.call('phone.migrate', {}, 8000), signal);
      if (r && typeof r.fingerprint === 'string' && r.fingerprint && r.fingerprint !== fp) return 'other';
      return r && r.fingerprint === fp && typeof r.ticket === 'string' && r.ticket ? { id: before.deviceId, ticket: r.ticket } : 'unreached';
    } catch (err) {
      if ((err as { cancelled?: boolean }).cancelled) throw err;
      return 'unreached';
    }
  }

  private async pairWith(offer: PairOffer, name: string, onWaiting: () => void, before: Pairing | null, replaces: { id: string; ticket: string } | undefined, signal?: AbortSignal): Promise<PairResult> {
    const reached = await reach(
      offer.hosts,
      offer.port,
      (ws) =>
        secureWire(ws, 'pair', '', offer.fp, pskOfKey(offer.key)).catch((err: Error) => {
          // Someone else answered at that address: nothing was sent to it but this phone's ephemeral key.
          throw err instanceof IdentityError ? new Error('The computer that answered is not the one that showed this code.') : err;
        }),
      { signal },
    );
    const { wire, host } = reached;
    const odd = () => new Error('The desktop did not answer as Sable does');
    return new Promise<PairResult>((resolve, reject) => {
      let over = false;
      // The welcome came: the pairing is being kept, and nothing (Cancel, a close) undoes that half way.
      let keeping = false;
      /** The new pairing as the desktop gave it (`paired`), apart from the one this phone has until it is kept. */
      let candidate: Pairing | undefined;
      /** The device the desktop says it removed with this pairing (`paired.replaced`): it counts only when it is exactly the one replaced. */
      let replaced: string | undefined;
      const end = (err?: Error, result: PairResult = {}) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) {
          wire.onText = null;
          wire.onClose = null;
          wire.close();
          reject(err);
        } else resolve(result);
      };
      const onAbort = () => !keeping && end(cancelled());
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = window.setTimeout(() => end(new Error('Nobody answered on the desktop')), 150_000);
      wire.onText = (text) => {
        if (over || keeping) return;
        let f: PhoneFrame;
        try {
          f = JSON.parse(text);
        } catch {
          return;
        }
        if ('waiting' in f) onWaiting();
        else if ('paired' in f) {
          const t = f.paired as { token?: unknown; deviceId?: unknown; desktop?: unknown; replaced?: unknown } | undefined;
          // One pairing per exchange, whole.
          if (candidate || typeof t?.token !== 'string' || !t.token || typeof t.deviceId !== 'string' || !t.deviceId) return end(odd());
          candidate = { hosts: offer.hosts, port: offer.port, token: t.token, deviceId: t.deviceId, desktop: typeof t.desktop === 'string' ? t.desktop : (offer.name ?? ''), lastHost: host, fp: offer.fp };
          replaced = typeof t.replaced === 'string' && t.replaced ? t.replaced : undefined;
        } else if ('welcome' in f) {
          // Only the welcome of the device just paired completes it: a welcome first, or another device's, is not a pairing.
          if (!candidate || f.welcome?.deviceId !== candidate.deviceId) return end(odd());
          keeping = true;
          clearTimeout(timer);
          // The desktop's addresses join the new pairing's own (never the old pairing's).
          const kept: Pairing = { ...candidate, hosts: mergeHosts(offer.hosts, f.welcome.hosts, host), desktop: f.welcome.desktop || candidate.desktop };
          this.keep(kept, before, replaces, wire).then(
            () => {
              // A plain pairing replaced: gone only when the desktop said it removed exactly that device;
              // otherwise (no ticket, the person chose to pair anyway, or another device named) it stays listed there.
              if (!before || before.fp) return end();
              const gone = !!replaces && replaced === replaces.id;
              if (!gone) this.notice(OLD_STAYS);
              end(undefined, { old: gone ? 'removed' : 'stays' });
            },
            (err: Error) => end(err),
          );
        } else if ('denied' in f) {
          end(new Error(typeof f.denied === 'string' && f.denied.trim() ? f.denied : 'The desktop did not allow this phone'));
        }
      };
      wire.onClose = (code) => !keeping && end(new Error(code === 4005 ? 'This pairing code is not valid. Show a new one on the desktop.' : 'The desktop closed the connection'));
      wire.send(JSON.stringify({ pair: { key: offer.key, name, ...(replaces ? { replaces } : {}) } }));
    });
  }

  /**
   * Keeps a new pairing in one step. It must still replace exactly the pairing that was confirmed
   * (`before`). Every attempt and call of the old credential ends first (its generation moves on).
   * The new pairing is written to the phone's storage and read only once that worked (a write that
   * fails fails the pairing; the old one goes on). When it replaces another computer (or one not
   * proven to be the same), what was kept for the old one is erased, restart-safe (the mark names
   * the new pairing, so a start after Android closed the app in the middle erases only once the new
   * pairing is the one kept). Then the new wire is the connection.
   */
  private async keep(c: Pairing, before: Pairing | null, replaces: { id: string; ticket: string } | undefined, wire: Wire) {
    if (this.pairing !== before) throw new Error('The pairing on this phone changed meanwhile. Try again.');
    this.gen++;
    this.cancelAttempt();
    clearTimeout(this.retryTimer);
    this.dropWire();
    const other = !!before && (before.fp ? before.fp !== c.fp : !replaces);
    const was = this.mark;
    // An erasure left from before goes on with this one.
    const erase = other || !!was;
    try {
      if (erase) await this.setMark({ ...(was?.forget ? { forget: true } : {}), to: c.deviceId });
      await this.write(c, () => true);
    } catch {
      if (erase) await this.setMark(was).catch(() => {});
      throw new Error(KEEP_FAILED);
    }
    this.pairing = c;
    // Still no other connection while the old one's data is erased: the wire that paired comes next.
    const clean = erase ? await this.eraseData() : true;
    this.holdOld = false;
    const gen = this.gen;
    if (!this.pairing || this.pairing !== c) return;
    if (!clean) {
      // Kept, but not used until what was kept for the old computer is gone (it would be erased with it):
      // tried again by itself (`connect`), and at the next start.
      wire.onText = null;
      wire.onClose = null;
      wire.close();
      this.notice(ERASE_LEFT);
      this.setState('offline', ERASE_LEFT);
      this.retry = 0;
      this.scheduleRetry();
      return;
    }
    // The wire that paired goes on as the connection (or, gone meanwhile, a new one with the new token).
    if (!wire.ready || !this.adopt(wire, gen)) {
      wire.close();
      this.retry = 0;
      void this.connect();
    }
  }

  private forgetSocket() {
    clearTimeout(this.retryTimer);
    this.cancelAttempt();
    this.dropWire();
  }

  /**
   * Forgets the desktop on this phone (the desktop keeps the entry until removed there), restart-safe:
   * a mark goes on the phone's storage first, then the token is removed and read back (when it cannot
   * be, this throws and nothing else changes). Every attempt, wire and call of it ends, and everything
   * kept for that desktop is erased (lib/erase.ts: whatever the screens loaded, the page's storage
   * swept, Android's private files and copies removed); only when nothing is left does the mark go. A
   * Forget that Android cut off goes on at the next start.
   */
  async forget(): Promise<void> {
    await this.retire(true);
  }

  /** Forget's steps; `cancelPairing`: a pairing in progress ends too (not when that pairing is what asked: unreadable data replaced). True when nothing is left. */
  private async retire(cancelPairing: boolean): Promise<boolean> {
    await this.ready;
    const was = this.mark;
    try {
      await this.setMark({ forget: true });
    } catch {
      throw new Error(FORGET_FAILED);
    }
    try {
      await removePairing();
    } catch (err) {
      await this.setMark(was).catch(() => {});
      throw err;
    }
    this.gen++;
    if (cancelPairing) this.cancelPair();
    this.forgetSocket();
    this.holdOld = false;
    this.pairing = null;
    // What could not be read as a pairing is gone with it.
    if (this.lookup === 'damaged') this.lookup = 'ok';
    this.setState('unpaired');
    const clean = await this.eraseData();
    if (!clean) this.notice(ERASE_LEFT);
    return clean;
  }
}

export const conn = new Conn();

// Development: a module swapped in place closes its old socket (two live sockets would double every event).
import.meta.hot?.dispose(() => conn.cancelPair());
import.meta.hot?.dispose(() => (conn as unknown as { forgetSocket: () => void }).forgetSocket());
