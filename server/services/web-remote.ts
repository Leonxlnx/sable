import { createServer as https } from 'node:https';
import { createServer as http, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { servable, webNetworks, type ReadNetwork } from './web-networks';
import { LOOK_MS, NetworkLook, nextLookIn, type LookTimes } from './web-look';
import { realpath } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { WEB_TAILSCALE, type WebNetwork, type WebState } from '../../shared/protocol';
import { webOn } from './web-on';
import { networkInterfaces } from 'node:os';
import { realCli, tailnetPeer, tailscaleView, TailscaleServe, TS_LOCAL_PORT, TS_PORT, TS_WORDS, type TailscaleCli, type TailscaleTimes } from './web-tailscale';
import { openContained, within } from '../core/contain';
import type { App } from '../app';
import type { PhoneService } from './phone';
import { webCertificates, privateIPv4, webHostname } from './web-cert';
import { qrSvgPath } from './qr';

/** The owner transfers ca.cer over an authenticated channel before opening the web client. */
export interface WebOptions {
  assets?: string;
  networks?: () => ReadNetwork[] | Promise<ReadNetwork[]>;
  /** How long a look at the networks is kept and how often one runs by itself (tests shorten them). */
  lookTimes?: Partial<LookTimes>;
  /** Bind fixtures to loopback while exercising the production Host and TLS checks. */
  loopback?: boolean;
  port?: number;
  /** Where "Save certificate" writes (tests); by default the desktop shell's save dialog. */
  showSave?: (defaultPath: string) => Promise<string | undefined>;
  /** The Tailscale CLI (tests: a fake; never the real one with a command that changes anything). */
  tailscale?: TailscaleCli;
  /** The first loopback port in Tailscale mode (tests: 0 for any free one). */
  tailscalePort?: number;
  /** How long a serve may take to show and to go (tests shorten them). */
  tailscaleTimes?: Partial<TailscaleTimes>;
  /** This computer's addresses as the system lists them now (tests); by default `os.networkInterfaces()`. */
  interfaces?: () => string;
  /** How often open connections are checked against the networks (tests shorten it). */
  watchMs?: number;
}

/** While a browser is connected over the home network: how often the addresses and the look's age are checked. */
const WATCH_MS = 5000;

/**
 * This computer's IPv4 addresses as the system lists them now: one system call, no process. A change (a
 * Wi-Fi left or joined, a cable, a VPN) means a kept look at the networks is of another moment. IPv6 is
 * left out: its temporary addresses change by themselves.
 */
function addressesNow(): string {
  const all = networkInterfaces();
  return Object.keys(all).sort().map(name => name + '=' + (all[name] ?? []).filter(a => a.family === 'IPv4')
    .map(a => a.address + '/' + a.netmask + '/' + a.mac).sort().join(',')).join(';');
}

/** The desktop shell's save dialog for the public root, or undefined without a shell (the dev server). */
async function electronSave(): Promise<((defaultPath: string) => Promise<string | undefined>) | undefined> {
  if (!process.versions.electron) return undefined;
  const { BrowserWindow, dialog } = await import('electron');
  return async (defaultPath) => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    const opts = { title: 'Save certificate', defaultPath, buttonLabel: 'Save', filters: [{ name: 'Certificate', extensions: ['cer'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'] as ('createDirectory' | 'showOverwriteConfirmation')[] };
    const r = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? undefined : r.filePath;
  };
}

/** Where the save dialog starts: the Downloads folder. */
async function downloads() {
  try { return (await import('electron')).app.getPath('downloads'); }
  catch { return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Downloads'); }
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
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
type Certificates = Awaited<ReturnType<typeof webCertificates>>;
function rawHeaders() { return Object.entries(HEADERS).map(([key, value]) => key + ': ' + value); }
/** web.state's error once no look at the networks has succeeded for `hold` (two minutes). */
const LOST = 'Could not read this computer’s networks for two minutes, so web access stopped. Sable tries again every minute.';
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
    if (!inside || res.destroyed || (await fh.stat()).size > 8 * 1024 * 1024) throw Error();
    res.writeHead(200, { 'Content-Type': mime });
    await pipeline(fh.createReadStream(), res);
  } finally { await fh.close(); }
}

export function registerWeb(app: App, makeChannel: (channel: WebChannel) => PhoneService, opts: WebOptions = {}) {
  const servers = new Set<Server>(), sockets = new Set<Duplex>();
  const since = new Map<string, number>();
  const enabled = () => webOn() && app.store.state.settings.webRemote === true && !disposed;
  const selection = () => app.store.state.settings.webNetwork;
  let requestedNetwork: string | undefined;
  let disposed = false, epoch = 0, reads = 0;
  let channel: PhoneService | undefined, hub: WebSocketServer | undefined;
  let certs: Certificates | undefined, port: number | undefined, networkId: string | undefined;
  let networks: WebNetwork[] = [], publicNames: string[] = [], error: string | undefined;
  /** The network and address the listener serves on. */
  let servingOn: WebNetwork | undefined;
  let startup: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined, expiry: NodeJS.Timeout | undefined, watch: NodeJS.Timeout | undefined;
  const active = () => enabled() && !!port && networkId === selection();
  // Tailscale as the network (web-tailscale.ts): one look at its state, the name Sable is published
  // under, and the loopback listener the publication points at. `tsHeld`: port 443 is the owner's;
  // `tsGone`: what Sable published was changed outside Sable (not published again until the switch or
  // the network changes).
  const ts = new TailscaleServe(opts.tailscale ?? realCli(), opts.tailscaleTimes);
  const tailscaleMode = () => selection() === WEB_TAILSCALE;
  let tsLook: Awaited<ReturnType<TailscaleServe['look']>> | undefined, tsLookAt = 0;
  let tsName: string | undefined, tsLogin: string | undefined, tsTarget: string | undefined;
  let tsHeld = false, tsGone = false;
  /** This mode's loopback listener, from its bind on. */
  let tsServer: Server | undefined;
  /** Loopback listeners that serve nothing any more and wait for Tailscale to let go of them. */
  const parked = new Set<Server>();
  let withdrawing: Promise<void> | undefined;
  let again: NodeJS.Timeout | undefined, soon: NodeJS.Timeout | undefined;
  const servingTs = () => active() && networkId === WEB_TAILSCALE && !!tsName;
  /** What a browser opens: `https://<name>` over Tailscale, else `https://<address>:<port>`. */
  const origin = () => (servingTs() ? 'https://' + tsName : certs && port ? 'https://' + certs.addresses[0] + ':' + port : undefined);
  /**
   * What this run published on Tailscale goes, and only then the loopback port it pointed at. Until
   * Tailscale no longer lists the publication the listener stays bound and refuses everything (its start
   * is over: `accepts` is false), so no other program on this computer can take the port and answer the
   * tablet under Sable's address. Not known gone (Tailscale's status cannot be read): the port is kept
   * and it is looked at again every 30 s, and by the next start.
   */
  function withdraw() {
    if (tsServer) { parked.add(tsServer); tsServer = undefined; }
    if (!parked.size && !ts.owes()) return;
    clearTimeout(again);
    again = undefined;
    const w: Promise<void> = ts.withdraw().then(() => {
      for (const s of parked) s.close();
      parked.clear();
    }, err => {
      app.log('web: Tailscale still lists Sable, its port is kept', (err as Error).message);
      if (!disposed) again = setTimeout(withdraw, ts.times.retry).unref();
    }).finally(() => { if (withdrawing === w) withdrawing = undefined; });
    withdrawing = w;
  }
  // The serve ended by itself (Tailscale restarted or updated, its process was ended): the listener stops,
  // and Sable publishes again by itself, first after a few seconds and then with the minute's look.
  ts.onLost = target => {
    if (disposed || tsTarget !== target) return;
    stop();
    error = TS_WORDS.lost;
    changed();
    clearTimeout(soon);
    soon = setTimeout(() => { soon = undefined; if (enabled() && tailscaleMode() && !port) sync(); }, ts.times.republish).unref();
  };
  // One look at the networks, kept (web-look.ts): nothing waits for a PowerShell run but the first start
  // and a new connection (below). Off-screen checks of the packaged app (loopback: nothing listens on the
  // LAN) may serve on a network Windows calls public, as a home Wi-Fi often is.
  const addresses = opts.interfaces ?? addressesNow;
  /** The addresses the system listed when the kept look began. */
  let lookAddresses: string | undefined;
  const look = new NetworkLook<ReadNetwork>(async () => {
    const before = addresses();
    const rows = await (opts.networks ?? webNetworks)();
    // The addresses changed while it ran: what it read belongs to neither moment.
    if (addresses() !== before) throw Error('The networks changed during the look.');
    lookAddresses = before;
    return opts.loopback ? rows.map(({ private: _, ...r }) => r) : rows;
  }, { ...LOOK_MS, ...opts.lookTimes });
  const connected = () => (hub?.clients.size ?? 0) > 0 || sockets.size > 0;
  // At most four files are read at once. A page asks for more together (script, styles, fonts on up to six
  // connections): those wait for a free read, sixteen at most and 5 s each, then 503 (a refusal at once
  // left a fresh page without its fonts or a lazy chunk).
  const waiting: (() => void)[] = [];
  const readSlot = () => {
    if (reads < 4) return (reads++, Promise.resolve(true));
    if (waiting.length >= 16) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const go = () => { clearTimeout(late); reads++; resolve(true); };
      const late = setTimeout(() => { waiting.splice(waiting.indexOf(go) >>> 0, 1); resolve(false); }, 5000);
      waiting.push(go);
    });
  };
  const freeSlot = () => { reads--; waiting.shift()?.(); };
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // The packaged client (`resources/web`, scripts/build-electron.mjs), or a checkout's own web build when
  // the bridge runs from source (the dev server has no resources folder). Missing: web access cannot start.
  // A folder named in the options is the only one looked at.
  const assetsRoot = () => (opts.assets !== undefined ? [opts.assets] : [resources && path.join(resources, 'web'), !resources ? path.resolve('mobile/dist-web') : undefined])
    .find((dir): dir is string => !!dir && existsSync(path.join(dir, 'index.html')));
  function manage() {
    if (!webOn() || disposed) throw Error('Web access is off.');
    return channel ??= makeChannel({ active, changed, connected: (id, at) => { if (!since.has(id)) since.set(id, at); },
      link: (key, fp) => origin() + '/#p=' + key + '&f=' + fp });
  }
  let shownQr: WebState['addressQr'];
  function addressQr() {
    const at = active() ? origin() : undefined;
    const link = at && at + '/';
    if (!link) return undefined;
    if (shownQr?.link !== link) { const { path: qr, size } = qrSvgPath(link); shownQr = { link, qr, size }; }
    return shownQr;
  }
  function state(): WebState {
    const status = channel?.status(), devices = status?.devices ?? [];
    const clients = devices.filter(d => d.online).map(d => ({ id: d.id, label: d.name, since: since.get(d.id)! }));
    for (const id of since.keys()) if (!clients.some(c => c.id === id)) since.delete(id);
    const overTs = servingTs();
    // Tailscale's row: its state is read only while it is chosen (else only whether it is installed).
    const tailscale = overTs ? { state: 'published' as const, name: tsName }
      : tsHeld && tailscaleMode() ? { state: 'taken' as const, name: tsName, text: TS_WORDS.taken }
      : tsGone && tailscaleMode() ? { state: 'unknown' as const, text: TS_WORDS.gone }
      : tailscaleView(tailscaleMode() ? tsLook : undefined, ts.installed());
    // No list before the first look at the home networks ends (Settings then says nothing rather than "none").
    const listed = look.at !== undefined || look.failure !== undefined || networks.length > 0;
    return { listening: active(), addresses: overTs ? [tsName!] : certs?.addresses ?? [], port: overTs ? TS_PORT : port, devices, clients, ...(listed ? { networks } : {}),
      ...(publicNames.length ? { publicNetworks: publicNames } : {}), tailscale,
      hostname: overTs ? tsName : certs?.host, caFingerprint: overTs ? undefined : certs?.ca.fingerprint256, caReplacement: overTs ? undefined : certs?.replacement, pairing: status?.pairing,
      request: status?.request, revocationDurable: !status?.saveError, error: error ?? status?.saveError ?? status?.error,
      assets: !!assetsRoot(), addressQr: addressQr() };
  }
  function changed() { if (!disposed) app.emit({ type: 'web.updated', state: state() }); }
  function stop() {
    epoch++;
    clearTimeout(expiry);
    clearTimeout(watch);
    watch = undefined;
    // What this run published on Tailscale goes first; its listener's port only after (withdraw).
    withdraw();
    port = certs = networkId = servingOn = tsName = tsLogin = tsTarget = undefined;
    for (const s of servers) s.close();
    for (const s of sockets) s.destroy();
    servers.clear();
    hub?.clients.forEach(ws => ws.terminate());
    hub?.close();
    hub = undefined;
    if (channel) void channel.setEnabled(false);
    since.clear();
    startup = undefined;
  }
  /** Takes a look's rows: the list Settings shows, and a listener whose network is gone stops. */
  function takeRows(rows: ReadNetwork[]) {
    const next = servable(rows);
    const listChanged = JSON.stringify([networks, publicNames]) !== JSON.stringify([next.networks, next.publicNames]);
    networks = next.networks;
    publicNames = next.publicNames;
    // Over Tailscale the home network's list is only for choosing: its look never stops the listener.
    if (active() && servingOn && servingOn.id !== WEB_TAILSCALE && !networks.some(n => n.id === servingOn!.id && n.address === servingOn!.address)) {
      stop();
      error = 'The selected home network changed. Select an available network on the desktop.';
      changed();
      return;
    }
    if (listChanged) changed();
  }
  /**
   * A look now (shared with one under way). A look that fails changes nothing while the last good one
   * holds (two minutes); after that the listener stops and says why, and the next look that succeeds
   * starts it again.
   */
  function lookNow(): Promise<void> {
    return look.ask().then(takeRows, () => {
      if (look.rows() || !active() || networkId === WEB_TAILSCALE) return;
      stop();
      error = LOST;
      changed();
    });
  }
  /**
   * The system lists other addresses than when the kept look began (the home network's listener only): the
   * look is void, every open connection ends, and nothing is admitted until a new look has read the networks.
   */
  function networkMoved(): boolean {
    if (lookAddresses === undefined || addresses() === lookAddresses) return false;
    lookAddresses = undefined;
    look.forget();
    for (const s of sockets) s.destroy();
    hub?.clients.forEach(ws => ws.terminate());
    void lookNow();
    return true;
  }
  /**
   * While a browser is connected over the home network, every few seconds and whatever a look is doing:
   * the addresses are compared, and a kept look past its hold ends the listener (so no connection outlives
   * the last good look by more than the hold and one tick).
   */
  function watchNetworks() {
    if (watch || !active() || networkId === WEB_TAILSCALE) return;
    watch = setTimeout(() => {
      watch = undefined;
      // Nothing connected: the next connection starts the watch again.
      if (!active() || networkId === WEB_TAILSCALE || !connected()) return;
      if (!networkMoved() && !look.rows() && !(look.at === undefined && look.looking)) {
        // The kept look is past its hold. (Forgotten a moment ago with its new look still running: nothing
        // is admitted meanwhile, and that look's own end decides.)
        stop();
        error = LOST;
        changed();
        return;
      }
      watchNetworks();
    }, opts.watchMs ?? WATCH_MS).unref();
  }
  /** The next look by itself: every 30 s while a browser is connected, every minute while nothing is, never while off. */
  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!enabled()) return;
    // Over Tailscale the look is Tailscale's own (one `status --json`, and `serve status --json` while
    // published); no look at the home networks runs by itself then.
    const overTs = tailscaleMode();
    timer = setTimeout(() => {
      timer = undefined;
      if (!enabled()) return;
      void (overTs ? tsCheck() : lookNow()).finally(() => { sync(); schedule(); });
    }, nextLookIn(overTs ? tsLookAt || undefined : look.startedAt, connected(), look.times, Date.now())).unref();
  }
  /**
   * Tailscale looked at again while published: stopped, signed out, renamed, HTTPS turned off, or Sable's
   * entry changed outside Sable: the listener stops and says why. Not published: the start that follows
   * (sync) looks itself.
   */
  async function tsCheck() {
    if (!servingTs()) return;
    const generation = epoch, name = tsName!, target = tsTarget!;
    const next = tsLook = await ts.look();
    tsLookAt = Date.now();
    // A look that could not be read (the CLI slow under load) changes nothing: the next one decides.
    if (generation !== epoch || !servingTs() || next.kind === 'unreadable') return;
    // Renamed: withdrawn under the old name, published under the new one by the start that follows.
    if (next.kind === 'ready' && next.name !== name) { stop(); changed(); return; }
    if (next.kind !== 'ready') {
      stop();
      error = next.kind === 'https' ? TS_WORDS.https : next.text;
      changed();
      return;
    }
    let holds: 'free' | 'ours' | 'taken';
    try { holds = await ts.holds(name, target); } catch { return; }
    if (generation !== epoch || !servingTs() || holds === 'ours') return;
    // Changed outside Sable: this run's own serve ends with the listener (nothing else is touched), and
    // it is not published again by itself.
    stop();
    tsGone = true;
    error = TS_WORDS.gone;
    changed();
  }
  async function start(generation: number) {
    if (tailscaleMode()) return startTailscale(generation);
    let rows = look.rows();
    const unread = look.at === undefined ? 'Could not read this computer’s networks. Sable tries again in a minute.' : LOST;
    if (!rows) {
      // The timer's own look just failed: its retry is the next tick, not a second run now.
      if (look.failure !== undefined && look.triedAt !== undefined && Date.now() - look.triedAt < 1000) throw Error(unread);
      try { rows = await look.ask(); }
      catch { throw Error(unread); }
    }
    // The list for Settings is taken also when this start was overtaken (another network chosen meanwhile).
    const next = servable(rows);
    const listChanged = JSON.stringify([networks, publicNames]) !== JSON.stringify([next.networks, next.publicNames]);
    networks = next.networks;
    publicNames = next.publicNames;
    if (epoch !== generation || !enabled()) { if (listChanged) changed(); return; }
    const selected = networks.find(n => n.id === selection() && privateIPv4(n.address));
    if (!selected) throw Error(/network changed/.test(error ?? '') ? error : 'Select an available home network and address on the desktop.');
    if (active() && servingOn?.id === selected.id && certs?.host === webHostname() && certs.addresses[0] === selected.address &&
        Date.parse(certs.cert.validTo) - Date.now() >= 30 * 86_400_000 && Date.parse(certs.intermediate.validTo) > Date.now()) {
      if (listChanged) changed();
      return;
    }
    if (port) { stop(); sync(); return; }
    const assets = assetsRoot();
    if (!assets) throw Error('Packaged web assets are unavailable.');
    const tls = await webCertificates(app.store.dir, [selected.address]);
    if (epoch !== generation || !enabled() || selected.id !== selection()) return;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    hub = wss;
    wss.on('headers', headers => headers.push(...rawHeaders()));
    wss.on('wsClientError', (_err, socket) => refuse(socket));
    // A request for the public client is answered on the kept look at once (it never waits for PowerShell),
    // unless the system's addresses changed since that look; a look older than 30 s is asked again behind
    // it, and one that finds the network gone stops the listener (takeRows).
    function accepts(req: IncomingMessage) {
      const peer = req.socket.remoteAddress;
      if (generation !== epoch || !active() || req.method !== 'GET' || req.socket.localPort !== port ||
          req.headersDistinct.host?.length !== 1 || !peer || !(privateIPv4(peer) || opts.loopback && peer === '127.0.0.1') ||
          ![tls.host, selected!.address].some(n => req.headers.host === n + ':' + port)) return false;
      if (networkMoved()) return false;
      if (!look.rows() || !networks.some(n => n.id === selected!.id && n.address === selected!.address)) return false;
      if (look.stale() && !look.looking) void lookNow();
      return true;
    }
    /**
     * A new connection to the chats never rides on a kept look: a look that began after it arrived must say
     * the selected network is still this one (the same address on another network is not), or it is refused.
     * A look under way is shared; one that began earlier is followed by a new one.
     */
    async function verified(arrived: number) {
      for (let i = 0; i < 2 && generation === epoch && active() && look.goodRun <= arrived; i++) await lookNow();
      return generation === epoch && active() && look.goodRun > arrived && !!look.rows() &&
        networks.some(n => n.id === selected!.id && n.address === selected!.address);
    }
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
      if (!accepts(req)) return void res.writeHead(403).end();
      if (req.url === '/ca.cer') return void res.writeHead(200, { 'Content-Type': 'application/pkix-cert' }).end(tls.ca.raw);
      if (!await readSlot()) return void (res.destroyed || res.writeHead(503).end());
      try { await staticFile(assets, req.url ?? '', res); }
      catch { if (!res.destroyed) res.writeHead(404).end(); }
      finally { freeSlot(); }
    };
    const server = https({ key: tls.key, cert: tls.cert.toString() + tls.intermediate.toString(), minVersion: 'TLSv1.2',
      handshakeTimeout: 5000 }, handle);
    servers.add(server);
    server.maxConnections = 24;
    server.maxRequestsPerSocket = 32;
    server.headersTimeout = server.requestTimeout = 10_000;
    server.on('connection', socket => {
      // Something connects: looks run every 30 s from now on (once a minute again when the next look finds nothing connected).
      const first = !sockets.size;
      sockets.add(socket);
      if (first) schedule();
      watchNetworks();
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_err, socket) => refuse(socket));
    server.on('checkContinue', handle);
    server.on('checkExpectation', handle);
    server.on('upgrade', async (req, socket, head) => {
      // The looks begun so far: only a later one counts for this connection (no clock is compared).
      const arrived = look.runs;
      const fits = () => accepts(req) && !socket.destroyed && wss.clients.size < 12;
      if (req.url !== '/sable-web' || req.headersDistinct.origin?.length !== 1 || req.headers.origin !== 'https://' + req.headers.host || !fits()) return refuse(socket);
      if (!await verified(arrived).catch(() => false) || !fits()) return socket.destroyed ? undefined : refuse(socket);
      wss.handleUpgrade(req, socket, head, ws => manage().acceptWeb(ws, req));
    });
    await bind(server, opts.port ?? 47830, opts.loopback ? '127.0.0.1' : selected.address, generation);
    if (!enabled() || generation !== epoch || selected.id !== selection()) { server.close(); return; }
    channel = manage();
    networkId = selected.id;
    servingOn = selected;
    certs = tls;
    port = (server.address() as { port: number }).port;
    error = undefined;
    await channel.setEnabled(true);
    changed();
  }
  /** Listens on the first free port from `first` (up to ten above). */
  async function bind(server: Server, first: number, host: string, generation: number) {
    for (let offset = 0; offset <= 10; offset++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const closed = () => finish(Error('Web access stopped.'));
          const finish = (err?: Error) => {
            server.off('close', closed).off('error', finish).off('listening', listening);
            if (err) reject(err); else resolve();
          };
          const listening = () => finish();
          server.once('close', closed).once('error', finish).once('listening', listening);
          server.listen(first ? first + offset : 0, host);
        });
        return;
      } catch (err) {
        if (generation !== epoch || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || offset === 10 || !first) throw err;
      }
    }
  }
  /**
   * Over Tailscale (web-tailscale.ts): plain HTTP on 127.0.0.1 only, published inside the tailnet by
   * `tailscale serve` at `https://<name>/` (Tailscale's own certificate; no chain of Sable's, no firewall
   * rule: nothing listens on a network). What can be checked here, on every request and upgrade: it came
   * from this computer (127.0.0.1), for exactly the computer's Tailscale name (`Host`, as Tailscale's proxy
   * passes the browser's on; or the proxy's target with `X-Forwarded-Host` naming it), never through
   * Funnel (`Tailscale-Funnel-Request`), with the `Tailscale-User-Login` Tailscale's proxy sets for a
   * person's device in the tailnet (it removes any the browser sent), and when this computer belongs to a
   * person, that person's login; an upgrade's `Origin` is exactly `https://<name>`. What cannot: that the
   * connection came from Tailscale's own process and not from another program on this computer, which can
   * send the same headers. Every local program is therefore untrusted as before: the pairing (a one-time
   * code shown on the desktop, approved there, then the sealed channel with the device's token) decides.
   */
  async function startTailscale(generation: number) {
    if (withdrawing) await withdrawing;
    if (epoch !== generation || !enabled() || !tailscaleMode()) return;
    // Published already: the timer's own look (tsCheck) watches it; nothing is run again here.
    if (servingTs()) return;
    // A port still kept from before (Tailscale's status could not be read then): looked at again first.
    if (parked.size || ts.owes()) {
      withdraw();
      await withdrawing;
      if (parked.size || ts.owes()) throw Error(TS_WORDS.failed);
      if (epoch !== generation || !enabled() || !tailscaleMode()) return;
    }
    if (tsGone) throw Error(TS_WORDS.gone);
    const seen = tsLook = await ts.look();
    tsLookAt = Date.now();
    if (epoch !== generation || !enabled() || !tailscaleMode()) return;
    if (seen.kind !== 'ready') { tsHeld = false; throw Error(seen.kind === 'https' ? TS_WORDS.https : seen.text); }
    if (servingTs() && tsName === seen.name) return;
    if (port) { stop(); sync(); return; }
    const assets = assetsRoot();
    if (!assets) throw Error('Packaged web assets are unavailable.');
    const name = seen.name, login = seen.login;
    let local = 0;
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    hub = wss;
    wss.on('headers', headers => headers.push(...rawHeaders()));
    wss.on('wsClientError', (_err, socket) => refuse(socket));
    const one = (req: IncomingMessage, header: string) => { const v = req.headersDistinct[header]; return v?.length === 1 ? v[0] : undefined; };
    function accepts(req: IncomingMessage) {
      const peer = req.socket.remoteAddress;
      if (generation !== epoch || !servingTs() || tsName !== name || req.method !== 'GET' || req.socket.localPort !== local) return false;
      if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') return false;
      const host = one(req, 'host');
      if (host !== name && !(host === '127.0.0.1:' + local && one(req, 'x-forwarded-host') === name)) return false;
      if (req.headers['tailscale-funnel-request'] !== undefined) return false;
      const who = one(req, 'tailscale-user-login');
      return !!who && (!login || who === login);
    }
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
      if (!accepts(req)) return void res.writeHead(403).end();
      if (!await readSlot()) return void (res.destroyed || res.writeHead(503).end());
      try { await staticFile(assets, req.url ?? '', res); }
      catch { if (!res.destroyed) res.writeHead(404).end(); }
      finally { freeSlot(); }
    };
    // Not among `servers`: stop() never closes this listener itself. From its bind on its port is let go
    // only by withdraw(), after Tailscale no longer lists what points at it.
    const server = http({}, handle);
    server.maxConnections = 24;
    server.maxRequestsPerSocket = 32;
    server.headersTimeout = server.requestTimeout = 10_000;
    server.on('connection', socket => {
      const first = !sockets.size;
      sockets.add(socket);
      if (first) schedule();
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_err, socket) => refuse(socket));
    server.on('checkContinue', handle);
    server.on('checkExpectation', handle);
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/sable-web' || one(req, 'origin') !== 'https://' + name || !accepts(req) || socket.destroyed || wss.clients.size >= 12) return refuse(socket);
      wss.handleUpgrade(req, socket, head, ws => manage().acceptWeb(ws, req, tailnetPeer(req.headers['x-forwarded-for'])));
    });
    await bind(server, opts.tailscalePort ?? TS_LOCAL_PORT, '127.0.0.1', generation);
    local = (server.address() as { port: number }).port;
    tsServer = server;
    if (!enabled() || generation !== epoch || !tailscaleMode()) { withdraw(); return; }
    const target = 'http://127.0.0.1:' + local;
    let published: 'published' | 'taken';
    try { published = await ts.publish(name, target); }
    catch (err) {
      withdraw();
      // The CLI's own words stay in the log (a path, a version): Settings says it in one plain sentence.
      app.log('web: tailscale serve failed', (err as Error).message);
      throw Error(TS_WORDS.failed);
    }
    if (published === 'taken') { withdraw(); tsHeld = true; throw Error(TS_WORDS.taken); }
    tsHeld = false;
    // Switched off or elsewhere while it published: withdrawn at once.
    if (!enabled() || generation !== epoch || !tailscaleMode()) { withdraw(); return; }
    channel = manage();
    networkId = WEB_TAILSCALE;
    servingOn = { id: WEB_TAILSCALE, name: 'Tailscale', address: name };
    tsName = name;
    tsLogin = login;
    tsTarget = target;
    port = local;
    error = undefined;
    await channel.setEnabled(true);
    changed();
  }
  function sync() {
    if (!enabled()) {
      // Off: nothing runs at all (no timer, no look), and nothing is kept for the next time.
      clearTimeout(timer); timer = undefined;
      clearTimeout(soon); soon = undefined;
      look.forget();
      lookAddresses = undefined;
      tsLook = undefined;
      tsHeld = tsGone = false;
      if (startup || port) { stop(); changed(); }
      return;
    }
    if (requestedNetwork !== selection()) {
      stop();
      requestedNetwork = selection();
      tsHeld = tsGone = false;
    }
    if (!timer) schedule();
    if (startup) return;
    const generation = epoch;
    const pending = start(generation).catch(err => {
      if (generation !== epoch) return;
      stop();
      error = (err as Error).message;
      changed();
    }).finally(() => { if (startup === pending) startup = undefined; });
    startup = pending;
  }
  function ready() {
    if (!active() || !channel) throw Error('Web access is off.');
    return channel;
  }
  app.register('web.state', async () => {
    if (!webOn()) throw Error('Web access is off.');
    // Over Tailscale and not published (HTTPS was off, Tailscale stopped): Settings opened is a look now,
    // at most one every 5 s, so a change made in Tailscale shows without waiting for the minute.
    if (enabled() && tailscaleMode() && !port && !startup && Date.now() - tsLookAt > 5000) sync();
    await startup;
    if (existsSync(path.join(app.store.dir, 'web', 'pairings.json.closed'))) manage();
    // Settings opened on a list older than 30 s: it is looked at again behind this answer (web.updated brings it).
    // Over Tailscale the home networks are only looked at here (to choose one), never by the timer.
    if (enabled() && !look.looking && (look.at === undefined ? tailscaleMode() : look.stale())) void lookNow().catch(() => {});
    return state();
  });
  // Off is said before anything of the request is read (parameters that are no object included).
  app.register('web.offer', params => {
    const web = ready();
    clearTimeout(expiry);
    web.pair(params?.cancel);
    const until = channel?.status().pairing?.expiresAt;
    if (until) expiry = setTimeout(() => channel?.pair(true), Math.max(0, until - Date.now())).unref();
    return state();
  });
  app.register('web.approve', params => { ready().approve(params?.requestId, params?.allow === true); return state(); });
  app.register('web.revoke', params => { manage().revoke(params?.deviceId); return state(); });
  // The public root only (what `/ca.cer` serves), checked to be a CA certificate before it is written.
  app.register('web.saveCa', async () => {
    if (!webOn()) throw Error('Web access is off.');
    const file = path.join(app.store.dir, 'web', 'ca.cer');
    let ca = certs?.ca;
    if (!ca && existsSync(file)) { try { ca = new X509Certificate(readFileSync(file)); } catch { ca = undefined; } }
    if (!ca?.ca) return { ok: false, missing: true };
    const show = opts.showSave ?? await electronSave();
    if (!show) return { ok: false, unsupported: true, der: ca.raw.toString('base64') };
    const target = await show(path.join(await downloads(), 'Sable certificate.cer'));
    if (!target) return { ok: false, canceled: true };
    writeFileSync(target, ca.raw);
    return { ok: true, path: target };
  });
  const off = app.subscribe(e => { if (e.type === 'settings.updated') sync(); });
  app.closeWebIngress = () => {
    disposed = true;
    off();
    clearTimeout(timer); clearTimeout(soon); clearTimeout(again);
    timer = soon = again = undefined;
    stop();
  };
  // Quitting: what was published on Tailscale is withdrawn (stop() began it) and seen gone, for 6 s at
  // most and only when there is something to withdraw (no timer otherwise). Past that the serve's process
  // is ended without waiting; it could not outlive Sable in any case (web-tailscale.ts).
  app.onDispose(async () => {
    const w = withdrawing;
    if (w) {
      let late: NodeJS.Timeout | undefined;
      await Promise.race([w, new Promise<void>(r => { late = setTimeout(r, 6000); late.unref(); })]);
      clearTimeout(late);
    }
    ts.drop();
    for (const s of parked) s.close();
    parked.clear();
    await channel?.dispose();
  });
  sync();
}
