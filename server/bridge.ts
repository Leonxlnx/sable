import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { BRIDGE_PATH, type RpcMethods, type RpcRequest, type ServerFrame } from '../shared/protocol';
import { App, type AppOptions } from './app';
import { eventForWindow, isSnapshot, resultForWindow } from './core/trim';
import { registerServices } from './services/index';
import { defaultProviders } from './providers/index';
import { bootMark } from './util/boot';

/**
 * Only same-machine pages may talk to the bridge: it can read files and run commands.
 * Browsers always send Origin on WebSocket handshakes and pages cannot forge it.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (tests, desktop shell)
  try {
    const o = new URL(origin);
    const local = o.hostname === 'localhost' || o.hostname === '127.0.0.1' || o.hostname === '[::1]' || o.hostname.endsWith('.localhost');
    return local && o.host === req.headers.host;
  } catch {
    return false;
  }
}

const trace = process.env.SABLE_BOOT_TRACE === '1';

export function attachBridge(http: Server, opts: Partial<AppOptions> = {}) {
  const app = new App({ providers: defaultProviders(), ...opts });
  bootMark('bridge:app');
  registerServices(app);
  bootMark('bridge:services');

  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== BRIDGE_PATH) return; // leave Vite's HMR socket alone
    if (!originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  http.on('upgrade', onUpgrade);

  const wholeItem = app.store.wholeItem.bind(app.store);
  wss.on('connection', (ws: WebSocket) => {
    bootMark('bridge:connected');
    type PageRequest = RpcMethods['session.snapshot']['params'];
    type PageAttempt = { request: PageRequest; key: string; retry: boolean };
    const pages = new Map<string, PageAttempt>();
    const send = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    // Whole timelines reach a window with finished steps' bulk cut (`session.item` has the rest).
    const unsubscribe = app.subscribe((event) => {
      if (event.type === 'session.removed') pages.delete(event.id);
      send({ event: eventForWindow(event, wholeItem) });
    });
    ws.on('message', async (raw) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(raw.toString());
      } catch {
        return;
      }
      let pageRequest: PageRequest | undefined;
      let attempt: PageAttempt | undefined;
      try {
        const t = trace ? performance.now() : 0;
        if (req.method === 'session.snapshot') {
          pageRequest = req.params as PageRequest;
          const previous = pages.get(pageRequest.sessionId);
          pages.delete(pageRequest.sessionId);
          if (pageRequest.page && app.sessions.has(pageRequest.sessionId)) {
            // Retrying the same cursor can mean the window timed out although
            // the server finished. Its fallback must stay on that cursor too.
            const key = JSON.stringify([pageRequest.page, pageRequest.keepFrom]);
            attempt = { request: pageRequest, key, retry: pageRequest.page !== 'end' && previous?.key === key };
            pages.set(pageRequest.sessionId, attempt);
          } else if (pageRequest.peek && previous?.retry) {
            pageRequest = previous.request;
          }
        }
        const result = await app.call(req.method, (pageRequest ?? req.params) as never);
        let view = resultForWindow(result, wholeItem, !!(pageRequest?.page || pageRequest?.peek));
        // A byte cut must never silently remove an unresolved decision from a
        // provisional end. In that case the first answer comes from restore.
        if (pageRequest && isSnapshot(result) && result.page?.kind === 'provisional' && isSnapshot(view) && result.items.length !== view.items.length) {
          const real = await app.call('session.snapshot', { ...pageRequest, page: 'real', keepFrom: result.items[0]?.id });
          view = resultForWindow(real, wholeItem, true);
        }
        const frame = JSON.stringify({ id: req.id, ok: true, result: view });
        // Measuring runs (SABLE_BOOT_TRACE=1): each call, when it came, how long it took, how big its answer was.
        if (trace) console.log(`[rpc] ${req.method} ${(performance.timeOrigin + t).toFixed(1)} ${(performance.now() - t).toFixed(1)}ms ${frame.length}B`);
        if (ws.readyState === ws.OPEN) ws.send(frame);
      } catch (err) {
        if (attempt) attempt.retry = true;
        send({ id: req.id, ok: false, error: (err as Error).message ?? String(err) });
      }
    });
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });

  return {
    app,
    async dispose(saved?: () => void) {
      http.off('upgrade', onUpgrade);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await app.dispose(saved);
    },
  };
}
