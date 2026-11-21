import { PAIR_LINK_PREFIX, PHONE_PATH, type BridgeEvent, type PhoneFrame, type PhoneMethods, type RpcMethods, type RpcResponse } from '@shared/protocol';

/** Everything the phone may ask: the allowlisted bridge methods and the phone endpoint's own. */
type Methods = RpcMethods & PhoneMethods;
import { loadPairing, removePairing, savePairing } from './native';
import { mergeHosts, sameHosts } from './hosts';
import { transportError } from './errors';
import { runForget } from './forget';
import { IdentityError, pskOfKey, pskOfToken, startHandshake, type Channel } from './secure';

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

/** A link again from an offer (Try again). */
export const offerLink = (o: PairOffer) => `${PAIR_LINK_PREFIX}h=${o.hosts.join(',')}&p=${o.port}&s=${o.key}&f=${o.fp}${o.name ? `&n=${encodeURIComponent(o.name)}` : ''}`;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

const url = (host: string, port: number) => `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}${PHONE_PATH}`;

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
              resolve(new SealedWire(ws, r.channel));
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
          ws.onerror = () => !opened && lose(ws, new Error('The desktop did not answer'));
          ws.onclose = () => !opened && lose(ws, new Error('The desktop did not answer'));
          ws.onopen = () => {
            opened = true;
            ws.onerror = null;
            if (done) return ws.close();
            auth(ws).then(
              (wire) => {
                if (done) return wire.close();
                finish(undefined, ws);
                resolve({ wire, host });
              },
              (err) => lose(ws, err),
            );
          };
        }, i === 0 ? 0 : 450 + i * 150),
      );
    });
  });
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

  /** This connection is the secure channel (the desktop proven, every frame sealed). */
  get secure(): boolean {
    return !!this.wire?.secure && this.state === 'open';
  }

  /** Paired over the secure channel (false: an older pairing, to pair again). */
  get pairedSecurely(): boolean {
    return !!this.pairing?.fp;
  }

  private wire?: Wire;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(e: BridgeEvent) => void>();
  private stateListeners = new Set<() => void>();
  private openListeners = new Set<() => void>();
  private retry = 0;
  private retryTimer?: number;
  private connecting = false;

  async init() {
    // A network that comes back (Wi-Fi again after mobile data) reconnects at once.
    window.addEventListener('online', () => this.wake());
    this.pairing = await loadPairing();
    if (this.pairing) void this.connect();
    else this.setState('unpaired');
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
    if (!this.pairing || this.state === 'denied') return;
    const away = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
    this.hiddenAt = 0;
    if (this.state === 'open' && away < 15_000) {
      const w = this.wire;
      void this.call('usage.limits', {}, 3000).catch(() => {
        if (this.wire === w) w?.close();
      });
      return;
    }
    // An attempt begun a moment ago (the same wake heard twice) is left to finish.
    if (this.connecting && performance.now() - this.attemptAt < 2000) return;
    this.cancelAttempt();
    clearTimeout(this.retryTimer);
    this.retry = 0;
    void this.connect();
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
    if (!p || this.connecting) return;
    this.connecting = true;
    const attempt = ++this.attemptId;
    this.attemptAt = performance.now();
    const current = () => attempt === this.attemptId;
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
              // The desktop's addresses now join the saved ones (Tailscale installed after pairing: reachable there next time).
              const hosts = mergeHosts(p.hosts, f.welcome.hosts, host);
              if (p.lastHost !== host || p.desktop !== f.welcome.desktop || !sameHosts(hosts, p.hosts)) {
                p.lastHost = host;
                p.desktop = f.welcome.desktop;
                p.hosts = hosts;
                void savePairing(p).catch(() => {});
              }
              this.adopt(w);
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
      if (current()) {
        this.connecting = false;
        this.abortAttempt = undefined;
      }
    }
  }

  /** The socket under the connection in use (an attempt's own socket is not it). */
  private owns(ws: WebSocket) {
    return this.wire?.socket === ws;
  }

  /**
   * Backoff with a little jitter: 0.6, 1.2, 2.4, 4.8 s, then every 8 s while the app is in front
   * (30 s in the background, where Android throttles timers anyway). Coming back to the front, a
   * network change or a tap on "Try again" reconnects at once (`wake`).
   */
  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const cap = document.hidden ? 30_000 : 8000;
    const delay = Math.min(cap, 600 * 2 ** this.retry++) * (0.85 + Math.random() * 0.3);
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  /** Calls still waiting fail now (their socket is gone); `transport` marks that the desktop may have done them. */
  private failPending(text: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(transportError(text, 'lost'));
      this.pending.delete(id);
    }
  }

  /** An authenticated connection becomes the one in use. */
  private adopt(wire: Wire) {
    // One connection feeds the store, never two: a second one would apply every streamed piece twice.
    const old = this.wire;
    if (old && old !== wire) {
      old.onText = null;
      old.onClose = null;
      old.close();
      // Calls sent on the old connection get no answer: they fail now, not after their timeout.
      this.failPending('The connection to the desktop was lost');
    }
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
      if (!pending) return;
      this.pending.delete(f.id);
      clearTimeout(pending.timer);
      if (f.ok) pending.resolve(f.result);
      else pending.reject(new Error(f.error));
    };
    wire.onClose = (code) => {
      if (this.wire !== wire) return;
      this.wire = undefined;
      this.failPending('The connection to the desktop was lost');
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
  }

  call<M extends keyof Methods>(method: M, params: Methods[M]['params'], timeoutMs = 30_000): Promise<Methods[M]['result']> {
    const wire = this.wire;
    if (!wire || !wire.ready) return Promise.reject(transportError('Not connected to the desktop', 'unsent'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        // The desktop may have done it: whoever asked looks again (lib/errors.ts).
        reject(transportError('The desktop did not answer in time', 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
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
    const p = this.pairing;
    return p && p.fp !== offer.fp ? p : null;
  }

  /**
   * Pairs with a desktop over the secure channel (the link's fingerprint pinned; the one-time secret
   * goes only inside): presents the secret, waits while the desktop asks "Allow?", keeps the token it
   * gives. `onWaiting` runs once the desktop has the request. A pairing from before the secure channel
   * with this same desktop is replaced by the migration ticket that desktop gives over that pairing
   * (`phone.migrate`, only when its fingerprint is the link's); its token never goes to the new peer.
   * Until the new pairing is allowed the old one stays (a pairing given up connects with it again).
   * `signal` (`beginPair`) aborts it at any step.
   */
  async pair(offer: PairOffer, name: string, onWaiting: () => void, signal?: AbortSignal): Promise<void> {
    if (!/^[\w-]{43}$/.test(offer.fp ?? '')) throw new Error('That is not a Sable pairing link');
    const before = this.pairing;
    try {
      const replaces = before && !before.fp ? await this.migrationTicket(before, offer.fp, signal) : undefined;
      if (signal?.aborted) throw cancelled();
      this.forgetSocket();
      await this.pairWith(offer, name, onWaiting, replaces, signal);
    } catch (err) {
      // Given up or refused: the pairing this phone had goes on as it was.
      if (this.pairing && this.pairing === before && this.state !== 'open') void this.connect();
      throw err;
    }
  }

  /**
   * Over the old plain pairing: the desktop's fingerprint and a one-time ticket. Undefined when that
   * desktop is not the link's (another computer: its old entry stays there, to remove on it), when it
   * cannot be reached or is too old to say.
   */
  private async migrationTicket(before: Pairing, fp: string, signal?: AbortSignal): Promise<{ id: string; ticket: string } | undefined> {
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
      if (this.pairing !== before || this.wire?.secure !== false) return undefined;
      const r = await abortable(this.call('phone.migrate', {}, 8000), signal);
      return r && r.fingerprint === fp && typeof r.ticket === 'string' ? { id: before.deviceId, ticket: r.ticket } : undefined;
    } catch (err) {
      if ((err as { cancelled?: boolean }).cancelled) throw err;
      return undefined;
    }
  }

  private async pairWith(offer: PairOffer, name: string, onWaiting: () => void, replaces: { id: string; ticket: string } | undefined, signal?: AbortSignal) {
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
    await new Promise<void>((resolve, reject) => {
      let over = false;
      const end = (err?: Error) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (err) {
          wire.onText = null;
          wire.onClose = null;
          wire.close();
          reject(err);
        } else resolve();
      };
      const onAbort = () => end(cancelled());
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = window.setTimeout(() => end(new Error('Nobody answered on the desktop')), 150_000);
      wire.onText = (text) => {
        if (over) return;
        let f: PhoneFrame;
        try {
          f = JSON.parse(text);
        } catch {
          return;
        }
        if ('waiting' in f) onWaiting();
        else if ('paired' in f) {
          this.pairing = { hosts: offer.hosts, port: offer.port, token: f.paired.token, deviceId: f.paired.deviceId, desktop: f.paired.desktop, lastHost: host, fp: offer.fp };
          void savePairing(this.pairing).catch(() => {});
        } else if ('welcome' in f) {
          if (this.pairing) {
            this.pairing.hosts = mergeHosts(this.pairing.hosts, f.welcome.hosts, host);
            void savePairing(this.pairing).catch(() => {});
          }
          this.adopt(wire);
          end();
        } else if ('denied' in f) {
          end(new Error(typeof f.denied === 'string' && f.denied.trim() ? f.denied : 'The desktop did not allow this phone'));
        }
      };
      wire.onClose = (code) => end(new Error(code === 4005 ? 'This pairing code is not valid. Show a new one on the desktop.' : 'The desktop closed the connection'));
      wire.send(JSON.stringify({ pair: { key: offer.key, name, ...(replaces ? { replaces } : {}) } }));
    });
  }

  private forgetSocket() {
    clearTimeout(this.retryTimer);
    this.cancelAttempt();
    const w = this.wire;
    this.wire = undefined;
    if (w) {
      w.onClose = null;
      w.close();
    }
  }

  /**
   * Forgets the desktop on this phone (the desktop keeps the entry until removed there). The token
   * goes first: when it cannot be removed from the phone's storage, this throws and nothing else
   * changes (a restart would connect with it again). Then everything kept for that desktop goes
   * together (lib/forget.ts: drafts, review comments, downloads, notifications, the cache).
   */
  async forget() {
    await removePairing();
    this.cancelPair();
    this.forgetSocket();
    this.pairing = null;
    runForget();
    this.setState('unpaired');
  }
}

export const conn = new Conn();

// Development: a module swapped in place closes its old socket (two live sockets would double every event).
import.meta.hot?.dispose(() => conn.cancelPair());
import.meta.hot?.dispose(() => (conn as unknown as { forgetSocket: () => void }).forgetSocket());
