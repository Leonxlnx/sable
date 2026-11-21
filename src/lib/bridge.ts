import { BRIDGE_PATH, type BridgeEvent, type RpcMethods, type RpcName, type ServerFrame } from '@shared/protocol';
import { takeBootSocket } from './boot';

export type ConnStatus = 'connecting' | 'open' | 'closed';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number };

/** WebSocket RPC client for the Sable bridge. Reconnects on its own. */
class Bridge {
  status: ConnStatus = 'connecting';
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private outbox: string[] = [];
  private listeners = new Set<(e: BridgeEvent) => void>();
  private statusListeners = new Set<(s: ConnStatus) => void>();
  private retry = 0;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  private open() {
    this.setStatus('connecting');
    // The first time, the socket the page's first script opened (src/boot.ts), `app.hello` asked on it.
    const early = takeBootSocket();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = early?.ws ?? new WebSocket(`${proto}://${location.host}${BRIDGE_PATH}`);
    this.ws = ws;
    this.bootHello = early ? { id: early.helloId, asked: early.asked } : undefined;
    const opened = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const frame of this.outbox.splice(0)) ws.send(frame);
    };
    const received = (data: string) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if ('event' in frame) {
        for (const l of this.listeners) l(frame.event);
        return;
      }
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error));
    };
    const closed = () => {
      if (this.ws !== ws) return;
      this.bootHello = undefined;
      this.setStatus('closed');
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Connection to the bridge was lost'));
        this.pending.delete(id);
      }
      const delay = Math.min(4000, 300 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
    ws.onopen = opened;
    ws.onmessage = (ev) => received(ev.data as string);
    ws.onclose = closed;
    ws.onerror = () => ws.close();
    if (!early) return;
    // Taken over: the state it is in now, then what it received meanwhile, in order (the status
    // first, so `app.hello` is asked for, and answered by its frame, as on a socket of its own).
    if (ws.readyState === WebSocket.OPEN) opened();
    else if (ws.readyState === WebSocket.CLOSED) return closed();
    for (const data of early.frames.splice(0)) received(data);
  }

  /** `app.hello` on the boot socket: asked with this id (already sent unless `asked` is false). */
  private bootHello?: { id: number; asked: boolean };

  private setStatus(s: ConnStatus) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  call<M extends RpcName>(method: M, params: RpcMethods[M]['params'], timeoutMs = 60_000): Promise<RpcMethods[M]['result']> {
    // The first `app.hello` is the one the boot script asked (its answer may be here already).
    const early = method === 'app.hello' ? this.bootHello : undefined;
    if (early) this.bootHello = undefined;
    const id = early ? early.id : this.nextId++;
    const frame = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (early?.asked) return;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame);
      else this.outbox.push(frame);
    });
  }

  on(listener: (e: BridgeEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onStatus(listener: (s: ConnStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }
}

export const bridge = new Bridge();
