import { createServer as https } from 'node:https';
import { createServer as http, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { WEB_SHIPS, type WebState } from '../../shared/protocol';
import { openContained, within } from '../core/contain';
import type { App } from '../app';
import type { PhoneService } from './phone';
import { webAddresses, webCertificates, privateIPv4, webHostname } from './web-cert';

/** Before release, verify the installed root's name constraints on the target iPad and its fingerprint
 * during bootstrap. Only the shipped bundle under resources/web is executable on this origin. */
export interface WebOptions {
  assets?: string;
  addresses?: () => string[];
  /** Bind fixtures to loopback while exercising the production Host and TLS checks. */
  loopback?: boolean;
  port?: number;
  caPort?: number;
}
export interface WebChannel {
  active(): boolean;
  changed(): void;
  connected(id: string, at: number): void;
  link(key: string, fingerprint: string): string;
}
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
};
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
type Certificates = ReturnType<typeof webCertificates>;
function rawHeaders() { return Object.entries(HEADERS).map(([key, value]) => key + ': ' + value); }
function refuse(socket: NodeJS.WritableStream) {
  socket.end(['HTTP/1.1 403 Forbidden', ...rawHeaders(), 'Connection: close', 'Content-Length: 0', '', ''].join('\r\n'));
}

async function staticFile(root: string, target: string, res: ServerResponse) {
  const route = decodeURIComponent(target.split('?')[0]);
  const parts = (route === '/' ? '/index.html' : route).slice(1).split('/');
  if (!route.startsWith('/') || parts.some(p => !/^[a-z0-9_-][a-z0-9._-]*$/i.test(p) ||
    /^(?:con|prn|aux|nul|lpt[1-9]|com[1-9])(?:\.|$)/i.test(p) || p.endsWith('.'))) throw Error();
  const file = path.resolve(root, ...parts);
  const mime = types[path.extname(file)];
  if (!mime || !within(root, file) || path.relative(file, await realpath(file)) !== '') throw Error();
  const { fh, inside } = await openContained(file, root, true);
  try {
    if (!inside || res.destroyed) throw Error();
    const bytes = await fh.readFile();
    res.writeHead(200, { 'Content-Type': mime }).end(bytes);
  } finally { await fh.close(); }
}

export function registerWeb(app: App, makeChannel: (channel: WebChannel) => PhoneService, opts: WebOptions = {}) {
  const enabled = () => WEB_SHIPS && app.store.state.settings.webRemote === true && !disposed;
  const servers = new Set<Server>();
  const sockets = new Set<Socket>();
  const since = new Map<string, number>();
  let disposed = false;
  let epoch = 0;
  let channel: PhoneService | undefined;
  let wss: WebSocketServer | undefined;
  let certs: Certificates | undefined;
  let ports: { port: number; caPort: number } | undefined;
  let error: string | undefined;
  let startup: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let expiry: NodeJS.Timeout | undefined;
  const active = () => enabled() && !!ports;
  const state = (): WebState => {
    if (!enabled()) return { listening: false, addresses: [], clients: [], devices: [] };
    const status = channel?.status();
    const devices = status?.devices ?? [];
    const clients = devices.filter(d => d.online).map(d => ({ id: d.id, label: d.name, since: since.get(d.id)! }));
    for (const id of since.keys()) if (!clients.some(c => c.id === id)) since.delete(id);
    return { listening: active(), addresses: certs?.addresses ?? [], ...ports, devices, clients,
      hostname: certs?.host, caFingerprint: certs?.ca.fingerprint256, pairing: status?.pairing,
      request: status?.request, error: error ?? status?.saveError ?? status?.error };
  };
  const changed = () => { if (!disposed) app.emit({ type: 'web.updated', state: state() }); };
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const root = opts.assets ?? (resources && path.join(resources, 'web'));
  function stop(disable = false) {
    epoch++;
    clearTimeout(expiry);
    clearInterval(timer);
    expiry = timer = undefined;
    ports = certs = undefined;
    for (const server of servers) server.close();
    for (const socket of sockets) socket.destroy();
    servers.clear();
    if (wss) {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      wss = undefined;
    }
    if (channel) {
      if (disable) void channel.setEnabled(false);
      else void channel.stop();
    }
    since.clear();
    startup = undefined;
    error = undefined;
  }

  async function start(generation: number) {
    if (!root) throw Error('Packaged web assets are unavailable.');
    const assets = root;
    const ips = (opts.addresses ?? webAddresses)();
    if (!ips.length) throw Error('No private LAN address is available.');
    const tls = webCertificates(app.store.dir, ips);
    const binds = opts.loopback ? ['127.0.0.1'] : tls.addresses;
    const hub = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    wss = hub;
    hub.on('headers', headers => headers.push(...rawHeaders()));
    hub.on('wsClientError', (_err, socket) => refuse(socket));
    const names = [tls.host, ...tls.addresses];
    function accepts(req: IncomingMessage, bootstrap: boolean) {
      const port = bootstrap ? ports?.caPort : ports?.port;
      const peer = req.socket.remoteAddress;
      return generation === epoch && active() && req.method === 'GET' && req.socket.localPort === port &&
        req.headersDistinct.host?.length === 1 && !!peer &&
        (privateIPv4(peer) || opts.loopback && peer === '127.0.0.1') &&
        names.some(n => req.headers.host === n + ':' + port);
    }
    const listen = async (bootstrap: boolean, base: number) => {
      for (let offset = 0; offset <= 10; offset++) {
        const attempt: Server[] = [];
        let port = base + offset;
        try {
          for (const host of binds) {
            if (!enabled() || generation !== epoch) throw Error('Web access stopped.');
            const handle = (req: IncomingMessage, res: ServerResponse) => {
              for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
              if (!accepts(req, bootstrap)) return void res.writeHead(403).end();
              if (req.url === '/ca.cer') return void res.writeHead(200, { 'Content-Type': 'application/pkix-cert' }).end(tls.ca.raw);
              if (bootstrap) return void res.writeHead(404).end();
              void staticFile(assets, req.url ?? '', res).catch(() => res.writeHead(404).end());
            };
            const server = bootstrap ? http(handle) : https({ key: tls.key, cert: tls.cert.toString(), minVersion: 'TLSv1.2' }, handle);
            attempt.push(server);
            servers.add(server);
            server.headersTimeout = server.requestTimeout = 10_000;
            server.on('connection', socket => {
              sockets.add(socket);
              socket.once('close', () => sockets.delete(socket));
            });
            server.on('clientError', (_err, socket) => refuse(socket));
            server.on('checkContinue', (req, res) => handle(req, res));
            server.on('checkExpectation', (req, res) => handle(req, res));
            server.on('upgrade', (req, socket, head) => {
              if (bootstrap || !accepts(req, false) || req.url !== '/sable-web' ||
                  req.headersDistinct.origin?.length !== 1 || req.headers.origin !== 'https://' + req.headers.host || hub.clients.size >= 12) return refuse(socket);
              hub.handleUpgrade(req, socket, head, ws => channel!.acceptWeb(ws, req));
            });
            await new Promise<void>((resolve, reject) => {
              const closed = () => reject(Error('Web access stopped.'));
              server.once('close', closed);
              server.once('error', reject);
              server.listen(port, host, () => {
                server.removeListener('error', reject);
                server.removeListener('close', closed);
                if (!enabled() || epoch !== generation) {
                  server.close();
                  reject(Error('Web access stopped.'));
                } else resolve();
              });
            });
            port = (server.address() as { port: number }).port;
          }
          return port;
        } catch (err) {
          for (const s of attempt) { s.close(); servers.delete(s); }
          if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || offset === 10) throw err;
        }
      }
      throw Error('No free web port.');
    };
    const caPort = await listen(true, opts.caPort ?? 47831);
    const port = await listen(false, opts.port ?? 47830);
    if (!enabled() || generation !== epoch) return;
    channel ??= makeChannel({ active, changed, connected: (id, at) => { if (!since.has(id)) since.set(id, at); },
      link: (key, fp) => `https://${certs!.addresses[0]}:${ports!.port}/#p=${key}&f=${fp}` });
    certs = tls;
    ports = { port, caPort };
    await channel.setEnabled(true);
    changed();
  }
  function sync() {
    if (!enabled()) {
      if (timer || startup || ports) { stop(true); changed(); }
      return;
    }
    if (startup) return;
    if (certs && certs.host === webHostname() && certs.addresses.join() === (opts.addresses ?? webAddresses)().sort().join() &&
        Date.parse(certs.cert.validTo) - Date.now() >= 30 * 86_400_000) return;
    if (ports) stop();
    timer ??= setInterval(sync, 30_000).unref();
    const generation = ++epoch;
    startup = start(generation).catch(err => {
      if (generation !== epoch) return;
      stop();
      error = (err as Error).message;
      if (enabled()) timer = setInterval(sync, 30_000).unref();
      changed();
    }).finally(() => { if (epoch === generation) startup = undefined; });
  }
  function ready() {
    if (!active() || !channel) throw new Error('Web access is off.');
    return channel;
  }
  app.register('web.state', async () => {
    await startup;
    if (!enabled()) throw Error('Web access is off.');
    return state();
  });
  app.register('web.offer', ({ cancel }) => {
    clearTimeout(expiry);
    ready().pair(cancel);
    const until = channel?.status().pairing?.expiresAt;
    if (until) expiry = setTimeout(() => channel?.pair(true), Math.max(0, until - Date.now())).unref();
    return state();
  });
  app.register('web.approve', ({ requestId, allow }) => { ready().approve(requestId, allow === true); return state(); });
  app.register('web.revoke', ({ deviceId }) => { ready().revoke(deviceId); return state(); });
  const off = app.subscribe(e => { if (e.type === 'settings.updated') sync(); });
  app.onDispose(async () => { disposed = true; off(); stop(); await channel?.dispose(); });
  sync();
}

