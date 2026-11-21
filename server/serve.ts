import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { BRIDGE_PATH } from '../shared/protocol';
import { attachBridge } from './bridge';
import { watchAwake, watchPhoneAwake } from './core/awake';
import { setThumbHost, type ThumbHost } from './services/thumbs';
import { registerUpdates, type UpdateHost } from './services/update';
import { bootMark } from './util/boot';

/**
 * The production server: serves the built UI and hosts the bridge on one port, on 127.0.0.1 only
 * (the bridge rejects WebSocket handshakes from other origins). Used by `server/standalone.ts`
 * (the `pnpm serve` CLI) and by the desktop shell in `electron/main.ts`.
 */
export interface ServerOptions {
  /** Directory with the built UI (index.html, assets/). */
  root: string;
  /** Port to listen on; 0 picks a free one. */
  port?: number;
  /** When `port` is taken, fall back to a free port instead of failing. */
  fallbackToFreePort?: boolean;
  /** The desktop shell: lets Sable install its own updates (`services/update.ts`). */
  updates?: UpdateHost;
  /** The desktop shell: Windows' own thumbnails for the file cards (`services/thumbs.ts`). */
  thumbs?: ThumbHost;
  /**
   * Called once the port is known, right before the bridge is built in the same task: the desktop
   * shell opens its window here, so the window's renderer starts while the bridge is built (no
   * request can reach the server before the bridge is attached).
   */
  onListening?: (url: string) => void;
  /**
   * Headers added to every response (the desktop shell's Content-Security-Policy, by path). Set here,
   * by the server that sends the page, rather than by the shell rewriting each response's headers.
   */
  headers?: (pathname: string) => Record<string, string>;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Disposes the bridge (agent child processes exit) and closes the HTTP server. Safe to call twice. */
  close(): Promise<void>;
  /** Calls `onChange` when agents start working anywhere, and when all have stopped for a minute (`core/awake.ts`). */
  watchBusy(onChange: (busy: boolean) => void): () => void;
  /** Calls `onChange` when a paired phone starts or stops needing the computer awake (`core/awake.ts`). */
  watchPhone(onChange: (on: boolean) => void): () => void;
}

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

function createStaticServer(root: string, extra?: (pathname: string) => Record<string, string>): Server {
  // Build assets carry their content hash in their names: their size is looked up once.
  const sizes = new Map<string, number>();
  return createServer((req, res) => {
    bootMark('server:first-request');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const hashed = file.startsWith(path.join(root, 'assets') + path.sep);
    const known = hashed ? sizes.get(file) : undefined;
    if (known === undefined && !isFile(file)) {
      // A missing build asset is a 404 (serving index.html would fail as a script with a MIME error);
      // any other path is a client route and gets the app.
      if (pathname.startsWith('/assets/') || path.extname(pathname)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      file = path.join(root, 'index.html');
    }
    if (known === undefined && !isFile(file)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('Sable is not built yet. Run "pnpm build" first.');
      return;
    }
    const size = known ?? statSync(file).size;
    if (hashed) sizes.set(file, size);
    res.writeHead(200, {
      ...extra?.(pathname),
      'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const root = path.resolve(opts.root);
  const server = createStaticServer(root, opts.headers);

  // The bridge handles its own path; nothing else upgrades here (no Vite HMR in production),
  // so close other upgrade requests instead of leaving the sockets half open.
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== BRIDGE_PATH) socket.destroy();
  });

  let port: number;
  try {
    port = await listen(server, opts.port ?? 0);
  } catch (err) {
    if (!opts.fallbackToFreePort || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    port = await listen(server, 0);
  }
  bootMark('server:listen');
  opts.onListening?.(`http://127.0.0.1:${port}`);
  const bridge = attachBridge(server);
  registerUpdates(bridge.app, opts.updates);
  setThumbHost(bridge.app, opts.thumbs);
  bootMark('server:bridge');

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await bridge.dispose().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());

  const watchBusy = (onChange: (busy: boolean) => void) => watchAwake({ get sessions() { return bridge.app.sessions.values(); }, subscribe: (l) => bridge.app.subscribe(l) }, onChange);
  const watchPhone = (onChange: (on: boolean) => void) =>
    watchPhoneAwake({ subscribe: (l) => bridge.app.subscribe(l), phone: () => bridge.app.call('phone.status', {}), settings: () => bridge.app.store.state.settings }, onChange);

  return { url: `http://127.0.0.1:${port}`, port, close, watchBusy, watchPhone };
}
