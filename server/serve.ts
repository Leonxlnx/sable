import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { close, createReadStream, existsSync, fstat, open, statSync } from 'node:fs';
import path from 'node:path';
import { BRIDGE_PATH } from '../shared/protocol';
import { attachBridge } from './bridge';
import { customOf, customOptions, type Customizer } from './services/custom';
import { watchAwake, watchPhoneAwake } from './core/awake';
import { setThumbHost, type ThumbHost } from './services/thumbs';
import { registerUpdates, type UpdateHost } from './services/update';
import { stalls } from './util/stalls';
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
  /** `--original` or Shift at start: the person's styles and build are ignored for this run (`services/custom.ts`). */
  original?: boolean;
  /** Where the Customize chat's reference material lies (the app's resources: CLAUDE.md and styles/). */
  reference?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  /** Disposes the bridge (agent child processes exit) and closes the HTTP server. Safe to call twice. */
  close(saved?: () => void): Promise<void>;
  /** Calls `onChange` when agents start working anywhere, and when all have stopped for a minute (`core/awake.ts`). */
  watchBusy(onChange: (busy: boolean) => void): () => void;
  /** Calls `onChange` when a paired phone starts or stops needing the computer awake (`core/awake.ts`). */
  watchPhone(onChange: (on: boolean) => void): () => void;
  /** Calls `onReload` when what windows are served changes: a custom interface set aside, or switched on or off. */
  watchCustom(onReload: (why: 'fallback' | 'switch') => void): () => void;
  /** Shift held at start: the person's styles and build are left out for the rest of this run. True when that changes what is served. */
  ignoreCustom(): boolean;
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

/** What the static server asks of Customize Sable: the person's stylesheet, and which build is served. */
export interface StaticCustom {
  /** Answers `/custom/styles.css`; false for anything else. */
  serveStyles(req: IncomingMessage, res: ServerResponse): boolean;
  /** The folder the app is served from (the person's build, or `own`). */
  root(own: string): string;
  /** A page (`index.html`) went out from `root`. */
  served(root: string): void;
}

/**
 * The static server. `custom()` is read per request (absent until the bridge is attached, which is
 * before any request can arrive): the root is a function of it, so a switched build is served from the
 * next request on, with no restart.
 */
export function createStaticServer(own: string, extra?: (pathname: string) => Record<string, string>, custom?: () => StaticCustom | undefined): Server {
  return createServer((req, res) => {
    bootMark('server:first-request');
    const c = custom?.();
    if (c?.serveStyles(req, res)) return;
    const root = path.resolve(c ? c.root(own) : own);
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
    if (!isFile(file)) {
      // A missing build asset is a 404 (serving index.html would fail as a script with a MIME error);
      // any other path is a client route and gets the app.
      if (pathname.startsWith('/assets/') || path.extname(pathname)) return void notFound(res);
      file = path.join(root, 'index.html');
    }
    // Opened before anything is sent, its size from that handle: a file removed or rebuilt between the
    // look and the read is a 404 (or a cut response), never an error the process does not handle.
    open(file, 'r', (err, fd) => {
      if (err) {
        if (path.basename(file) === 'index.html') res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('Sable is not built yet. Run "pnpm build" first.');
        else notFound(res);
        return;
      }
      fstat(fd, (statErr, st) => {
        if (statErr || !st.isFile()) {
          close(fd, () => {});
          return void notFound(res);
        }
        // Only a real navigation (GET) starts a custom page's clock; HEAD asks for nothing to run.
        if (req.method === 'GET' && path.basename(file) === 'index.html' && path.dirname(file) === root) c?.served(root);
        res.writeHead(200, {
          ...extra?.(pathname),
          'content-type': types[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': st.size,
          'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        if (req.method === 'HEAD') {
          close(fd, () => {});
          return void res.end();
        }
        const stream = createReadStream('', { fd, start: 0, end: Math.max(0, st.size - 1), autoClose: true });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        if (st.size === 0) {
          stream.destroy();
          return void res.end();
        }
        stream.pipe(res);
      });
    });
  });
}

function notFound(res: ServerResponse) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
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
  let custom: Customizer | undefined;
  const server = createStaticServer(root, opts.headers, () => custom);

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
  // The desktop shell's choices for Customize Sable, taken by the bridge's customizer as it is made.
  customOptions({ ignore: !!opts.original, serving: true, ...(opts.reference ? { reference: opts.reference } : {}) });
  const bridge = attachBridge(server);
  custom = customOf(bridge.app);
  registerUpdates(bridge.app, opts.updates);
  // How late the loop runs, kept in memory for `diag.stalls`.
  stalls.start();
  setThumbHost(bridge.app, opts.thumbs);
  bootMark('server:bridge');

  let closing: Promise<void> | undefined;
  const close = (saved?: () => void) =>
    (closing ??= (async () => {
      try {
        await bridge.dispose(saved);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    })());

  const watchBusy = (onChange: (busy: boolean) => void) => watchAwake({ get sessions() { return bridge.app.sessions.values(); }, subscribe: (l) => bridge.app.subscribe(l) }, onChange);
  const watchPhone = (onChange: (on: boolean) => void) =>
    watchPhoneAwake({ subscribe: (l) => bridge.app.subscribe(l), phone: () => bridge.app.call('phone.status', {}), settings: () => bridge.app.store.state.settings }, onChange);

  const watchCustom = (onReload: (why: 'fallback' | 'switch') => void) => custom!.onReload(onReload);

  const ignoreCustom = () => custom!.ignoreForRun();

  return { url: `http://127.0.0.1:${port}`, port, close, watchBusy, watchPhone, watchCustom, ignoreCustom };
}
