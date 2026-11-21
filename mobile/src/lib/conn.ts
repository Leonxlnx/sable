import { PHONE_PATH, type BridgeEvent, type PhoneFrame, type PhoneMethods, type RpcMethods, type RpcResponse } from '@shared/protocol';

/** Everything the phone may ask: the allowlisted bridge methods and the phone endpoint's own. */
type Methods = RpcMethods & PhoneMethods;
import { loadPairing, savePairing } from './native';
import { mergeHosts, sameHosts } from './hosts';
import { transportError } from './errors';
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

/** A pairing link: `sable://pair?h=<ips>&p=<port>&k=<key>&f=<fingerprint>&n=<desktop>`. */
export interface PairOffer {
  hosts: string[];
  port: number;
  key: string;
  name?: string;
  /** The desktop's identity fingerprint; absent from an older desktop's link. */
  fp?: string;
}

export type ConnState = 'unpaired' | 'connecting' | 'open' | 'offline' | 'denied';

export function parsePairLink(text: string): PairOffer | null {
  const t = text.trim();
  const m = /sable:\/\/pair\?([^\s]+)/i.exec(t);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const hosts = (q.get('h') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => /^[\w.:-]+$/.test(h));
  const port = Number(q.get('p'));
  const key = q.get('k') ?? '';
  const fp = q.get('f');
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || port > 65535 || key.length < 16) return null;
  // A fingerprint that is there must be one (a damaged link never pairs without it).
  if (fp !== null && !/^[\w-]{43}$/.test(fp)) return null;
  return { hosts, port, key, name: q.get('n') ?? undefined, ...(fp ? { fp } : {}) };
}

/** A link again from an offer (Try again). */
export const offerLink = (o: PairOffer) => `sable://pair?h=${o.hosts.join(',')}&p=${o.port}&k=${o.key}${o.fp ? `&f=${o.fp}` : ''}${o.name ? `&n=${encodeURIComponent(o.name)}` : ''}`;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

const url = (host: string, port: number) => `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}${PHONE_PATH}`;

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

/**
 * The secure handshake on an open socket: the desktop must answer as the one `fp` names. Resolves
 * with the sealed wire; rejects with the desktop's signed refusal (`denied`), an `IdentityError`, or
 * when it closes or says nothing.
 */
function secureWire(ws: WebSocket, kind: 'pair' | 'hello', id: string, fp: string, psk: Promise<Uint8Array> | Uint8Array): Promise<Wire> {
  return new Promise<Wire>((resolve, reject) => {
    const silent = window.setTimeout(() => reject(new Error('The desktop did not answer')), 8000);
    const done = () => {
      clearTimeout(silent);
      ws.onmessage = null;
      ws.onclose = null;
    };
    ws.onclose = (ev) => {
      done();
      // An older desktop does not know the secure hello.
      reject(new Error(ev.code === 4000 ? 'Update Sable on the computer to connect securely' : 'The desktop closed the connection'));
    };
    void startHandshake(kind, id).then((hs) => {
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        ws.onmessage = null;
        void Promise.resolve(psk)
          .then((key) => hs.finish(ev.data as string, fp, key))
          .then(
            (r) => {
              done();
              if ('denied' in r) reject(Object.assign(new Error(r.denied), { denied: true }));
              else resolve(new SealedWire(ws, r.channel));
            },
            (err: Error) => {
              done();
              ws.close();
              reject(err instanceof IdentityError ? Object.assign(err, { denied: true }) : err);
            },
          );
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(hs.first);
    }, reject);
  });
}

/**
 * Opens a socket to the first of `hosts` that answers (the last good one first, the others a
 * moment later), and resolves with it once it is open. Rejects when none answers.
 */
function race(hosts: string[], port: number, first?: string, timeoutMs = 6000): Promise<{ ws: WebSocket; host: string }> {
  const order = first && hosts.includes(first) ? [first, ...hosts.filter((h) => h !== first)] : hosts;
  return new Promise((resolve, reject) => {
    const sockets: WebSocket[] = [];
    let done = false;
    let failed = 0;
    const timers: number[] = [];
    const finish = () => {
      done = true;
      timers.forEach(clearTimeout);
    };
    const overall = window.setTimeout(() => {
      if (done) return;
      finish();
      sockets.forEach((s) => s.close());
      reject(new Error('The desktop did not answer'));
    }, timeoutMs);
    timers.push(overall);
    order.forEach((host, i) => {
      timers.push(
        window.setTimeout(() => {
          if (done) return;
          let ws: WebSocket;
          try {
            ws = new WebSocket(url(host, port));
          } catch {
            if (++failed === order.length) {
              finish();
              reject(new Error('The desktop did not answer'));
            }
            return;
          }
          sockets.push(ws);
          ws.onopen = () => {
            if (done) return ws.close();
            finish();
            sockets.forEach((s) => s !== ws && s.close());
            resolve({ ws, host });
          };
          ws.onerror = () => {
            if (done) return;
            if (++failed === order.length) {
              finish();
              reject(new Error('The desktop did not answer'));
            }
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

  /** A plain HTTP address on the desktop's phone endpoint, at the host last reached (a shared file's download link). */
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
   * the socket instead.
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
    let sock: WebSocket | undefined;
    let abort!: (e: Error) => void;
    const aborted = new Promise<never>((_, reject) => (abort = reject));
    aborted.catch(() => {});
    this.abortAttempt = () => {
      abort(new Error('Cancelled'));
      sock?.close();
    };
    try {
      const raced = race(p.hosts, p.port, p.lastHost);
      // A socket that opens after this attempt was given up is closed at once.
      raced.then((r) => !current() && r.ws.close(), () => {});
      const { ws, host } = await Promise.race([raced, aborted]);
      sock = ws;
      // Paired securely: the desktop proves who it is first, and the token goes only inside the channel.
      const wire = p.fp ? await Promise.race([secureWire(ws, 'hello', p.deviceId, p.fp, pskOfToken(p.token)), aborted]) : new PlainWire(ws);
      await Promise.race([
        aborted,
        new Promise<void>((resolve, reject) => {
          // Open but silent (the network went away after the handshake): given up, not waited on forever.
          const silent = window.setTimeout(() => reject(new Error('The desktop did not answer')), 8000);
          wire.onText = (text) => {
            let f: PhoneFrame;
            try {
              f = JSON.parse(text);
            } catch {
              return;
            }
            if ('welcome' in f) {
              clearTimeout(silent);
              if (!current()) return reject(new Error('Cancelled'));
              // The desktop's addresses now join the saved ones (Tailscale installed after pairing: reachable there next time).
              const hosts = mergeHosts(p.hosts, f.welcome.hosts, host);
              if (p.lastHost !== host || p.desktop !== f.welcome.desktop || !sameHosts(hosts, p.hosts)) {
                p.lastHost = host;
                p.desktop = f.welcome.desktop;
                p.hosts = hosts;
                void savePairing(p);
              }
              this.adopt(wire);
              resolve();
            } else if ('denied' in f) {
              clearTimeout(silent);
              reject(Object.assign(new Error(f.denied), { denied: true }));
            }
          };
          wire.onClose = (code) => {
            clearTimeout(silent);
            // A plain close code says nothing on a secure connection (anyone on the way can send one): only a sealed refusal counts there.
            reject(code === 4001 && !wire.secure ? Object.assign(new Error('This phone was removed on the desktop'), { denied: true }) : new Error('The desktop closed the connection'));
          };
          wire.send(JSON.stringify({ hello: { token: p.token } }));
        }),
      ]);
    } catch (err) {
      if (sock && !this.owns(sock)) {
        sock.onclose = null;
        sock.close();
      }
      // A newer attempt took over: it reports for itself.
      if (!current()) return;
      const e = err as Error & { denied?: boolean };
      if (e.denied) {
        this.setState('denied', e.message);
      } else {
        // The old socket (kept on screen while this one was tried) is no good either.
        if (this.wire && this.state === 'open') {
          this.wire.close();
          return;
        }
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
        this.setState('denied', f.denied);
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

  /**
   * Pairs with a desktop: presents the one-time key, waits while the desktop asks "Allow?", keeps
   * the token it gives. `onWaiting` runs once the desktop has the request. A link with the desktop's
   * fingerprint pairs over the secure channel (the key never goes in the clear); an older desktop's
   * link pairs as before. A pairing this phone already had is named, so the desktop drops it once the
   * new one is allowed; until then it stays (a pairing given up connects with it again).
   */
  async pair(offer: PairOffer, name: string, onWaiting: () => void): Promise<void> {
    const before = this.pairing;
    this.forgetSocket();
    try {
      await this.pairWith(offer, name, onWaiting, before);
    } catch (err) {
      // Given up or refused: the pairing this phone had goes on as it was.
      if (this.pairing && this.pairing === before) void this.connect();
      throw err;
    }
  }

  private async pairWith(offer: PairOffer, name: string, onWaiting: () => void, before: Pairing | null) {
    const { ws, host } = await race(offer.hosts, offer.port);
    this.pairSocket = ws;
    const wire = offer.fp
      ? await secureWire(ws, 'pair', '', offer.fp, pskOfKey(offer.key)).catch((err: Error) => {
          // Someone else answered at that address: nothing was sent to it but this phone's ephemeral key.
          throw err instanceof IdentityError ? new Error('The computer that answered is not the one that showed this code.') : err;
        })
      : new PlainWire(ws);
    // The pairing to drop: an older one of the same computer (named alike, or at an address it gave), whose token went plain anyway.
    const same = !!before && !before.fp && (before.desktop === offer.name || before.hosts.some((h) => offer.hosts.includes(h)));
    const replaces = wire.secure && before && same ? { id: before.deviceId, token: before.token } : undefined;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        wire.close();
        reject(new Error('Nobody answered on the desktop'));
      }, 150_000);
      wire.onText = (text) => {
        let f: PhoneFrame;
        try {
          f = JSON.parse(text);
        } catch {
          return;
        }
        if ('waiting' in f) onWaiting();
        else if ('paired' in f) {
          this.pairing = { hosts: offer.hosts, port: offer.port, token: f.paired.token, deviceId: f.paired.deviceId, desktop: f.paired.desktop, lastHost: host, ...(wire.secure && offer.fp ? { fp: offer.fp } : {}) };
          void savePairing(this.pairing);
        } else if ('welcome' in f) {
          clearTimeout(timer);
          if (this.pairing) {
            this.pairing.hosts = mergeHosts(this.pairing.hosts, f.welcome.hosts, host);
            void savePairing(this.pairing);
          }
          this.adopt(wire);
          resolve();
        } else if ('denied' in f) {
          clearTimeout(timer);
          reject(new Error(f.denied));
        }
      };
      wire.onClose = (code) => {
        clearTimeout(timer);
        reject(new Error(code === 4005 ? 'This pairing code is not valid. Show a new one on the desktop.' : 'The desktop closed the connection'));
      };
      wire.send(JSON.stringify({ pair: { key: offer.key, name, ...(replaces ? { replaces } : {}) } }));
    });
  }

  private pairSocket?: WebSocket;

  /** Gives up a pairing in progress (the desktop's question goes away with the socket). */
  cancelPair() {
    this.pairSocket?.close();
    this.pairSocket = undefined;
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

  /** Forgets the desktop on this phone (the desktop keeps the entry until removed there). */
  async forget() {
    this.forgetSocket();
    this.pairing = null;
    await savePairing(null);
    this.setState('unpaired');
  }
}

export const conn = new Conn();

// Development: a module swapped in place closes its old socket (two live sockets would double every event).
import.meta.hot?.dispose(() => conn.cancelPair());
import.meta.hot?.dispose(() => (conn as unknown as { forgetSocket: () => void }).forgetSocket());
