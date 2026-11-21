/**
 * The phone's connection after review wave 6 (mobile/src/lib/conn.ts under Node's WebSocket and
 * WebCrypto, against real desktop endpoints and made-up ones): a pairing from before the secure
 * channel that the new one cannot end stops for the person's choice, and the old pairing counts as
 * removed only when the desktop names exactly that device (6); a replacement whose erasure did not
 * finish keeps the new pairing from connecting until it has (8); pairing data that is there but
 * cannot be read is a state to recover from, never "unpaired" (22).
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { answerHello, loadIdentity, readSecHello, SealedLink, type Identity } from '../server/services/phone-secure';
import { removeChecked } from '../mobile/src/lib/credential';

// ── the phone's storage, as Capacitor Preferences and Android's commit give it ──

const stored = new Map<string, string>();
const storage = { erased: 0, eraseFails: false };
vi.mock('../mobile/src/lib/native', () => ({
  loadMark: async () => {
    const v = stored.get('erasing');
    return v ? JSON.parse(v) : null;
  },
  saveMark: async (m: { forget?: boolean; to?: string } | null) => {
    if (m && (m.forget || m.to)) stored.set('erasing', JSON.stringify(m));
    else stored.delete('erasing');
  },
  eraseNative: async () => {
    storage.erased++;
    return storage.eraseFails ? ['files'] : [];
  },
  // As native.ts reads it: there but not a pairing is `damaged`, never "none".
  loadPairing: async () => {
    const v = stored.get('pairing');
    if (!v) return null;
    let p: { token?: unknown; hosts?: unknown } | null;
    try {
      p = JSON.parse(v);
    } catch {
      p = null;
    }
    if (!p || typeof p.token !== 'string' || !p.token || !Array.isArray(p.hosts)) throw Object.assign(new Error('damaged'), { damaged: true });
    return p;
  },
  savePairing: async (p: unknown) => void stored.set('pairing', JSON.stringify(p)),
  removePairing: async () =>
    removeChecked(
      {
        remove: async ({ key }) => void stored.delete(key),
        get: async ({ key }) => ({ value: stored.get(key) ?? null }),
      },
      'pairing',
    ),
}));
const g = globalThis as Record<string, unknown>;
g.window ??= { setTimeout, clearTimeout, addEventListener: () => {} };
g.document ??= { hidden: false, visibilityState: 'visible', addEventListener: () => {} };

type ConnModule = typeof import('../mobile/src/lib/conn');
async function phoneApp(): Promise<ConnModule> {
  vi.resetModules();
  return import('../mobile/src/lib/conn');
}

const homes: string[] = [];
const apps: App[] = [];
const servers: WebSocketServer[] = [];
const conns: { forget: () => Promise<void>; cancelPair: () => void }[] = [];
beforeEach(() => {
  stored.clear();
  Object.assign(storage, { erased: 0, eraseFails: false });
});
afterEach(async () => {
  storage.eraseFails = false;
  for (const c of conns.splice(0)) {
    c.cancelPair();
    await c.forget().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(() => r(null)));
  }
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function desktop(opts: { legacy?: { id: string; token: string } } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w6c-'));
  homes.push(home);
  if (opts.legacy) {
    const device = { id: opts.legacy.id, name: 'Phone', tokenHash: createHash('sha256').update(opts.legacy.token).digest('hex'), pairedAt: 1 };
    writeFileSync(path.join(home, 'phone.json'), JSON.stringify({ enabled: true, devices: [device] }));
  }
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const phone = registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  return { app, phone, port: status.port, home };
}
type Desk = Awaited<ReturnType<typeof desktop>>;

async function offerOf(d: Desk, name = 'Desk') {
  const st = await d.app.call('phone.pair', {});
  const q = new URLSearchParams(st.pairing!.link.slice('sable://pair/2?'.length));
  return { hosts: ['127.0.0.1'], port: d.port, key: q.get('s')!, fp: q.get('f')!, name };
}
const requestOf = (d: Desk) => (d.phone as unknown as { request?: { id: string } }).request;
async function approve(d: Desk) {
  await until(() => !!requestOf(d), 6000);
  await d.app.call('phone.approve', { requestId: requestOf(d)!.id, allow: true });
}
const ids = async (d: Desk) => (await d.app.call('phone.status', {})).devices.map((x) => x.id);

async function pairedWith(d: Desk) {
  const m = await phoneApp();
  conns.push(m.conn);
  await m.conn.init();
  const offer = await offerOf(d);
  const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair());
  await approve(d);
  await p;
  expect(m.conn.secure).toBe(true);
  return { m, offer };
}

function identityIn(name: string): Identity {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w6id-'));
  homes.push(home);
  return loadIdentity(path.join(home, `${name}.pem`));
}

/** A made-up desktop on the secure channel: answers the pairing handshake as `identity`, then `frames` for each frame it gets. */
function fakeDesktop(identity: Identity, psk: string, frames: (got: string) => unknown[]) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  wss.on('connection', (ws: WsSocket) => {
    ws.once('message', (raw) => {
      const sec = readSecHello(String(raw));
      if (!sec) return;
      const ans = answerHello(identity, sec, Buffer.from(psk, 'utf8'));
      ws.send(ans.reply);
      if (!ans.keys) return;
      const link = new SealedLink(ws, ans.keys, { z: sec.z });
      link.onMessage((t) => {
        for (const f of frames(t)) link.send(JSON.stringify(f));
      });
    });
  });
  return new Promise<number>((r) => wss.on('listening', () => r((wss.address() as { port: number }).port)));
}

/** A desktop from before the secure channel (plain frames): welcomes the old token; `migrate` answers `phone.migrate` (or it is unknown). */
function plainDesktop(migrate?: () => unknown) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  wss.on('connection', (ws: WsSocket) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as { hello?: unknown; id?: number; method?: string };
      if (f.hello) ws.send(JSON.stringify({ welcome: { deviceId: 'old-phone', desktop: 'Desk', version: '0', hosts: ['127.0.0.1'] } }));
      else if (f.id) ws.send(JSON.stringify(f.method === 'phone.migrate' && migrate ? { id: f.id, ok: true, result: migrate() } : { id: f.id, ok: false, error: 'Unknown method' }));
    });
  });
  return new Promise<number>((r) => wss.on('listening', () => r((wss.address() as { port: number }).port)));
}

/** A phone with a plain pairing to the desktop at `port`, connected. */
async function plainPhone(port: number, deviceId = 'old-phone', token = 'old-token') {
  stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port, token, deviceId, desktop: 'Desk' }));
  const m = await phoneApp();
  conns.push(m.conn);
  await m.conn.init();
  await until(() => m.conn.state === 'open');
  return m;
}

describe('a pairing from before the secure channel that the new one cannot end (6)', () => {
  it('stops for the person\'s choice before anything goes to the new desktop; chosen, it pairs and says the old one stays', async () => {
    // The old desktop answers, but gives no ticket (too old, or its answer did not come).
    const m = await plainPhone(await plainDesktop());
    const b = await desktop();
    const offer = await offerOf(b);
    const notes: string[] = [];
    m.conn.onNotice((t) => notes.push(t));
    const err = await m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer)).catch((e) => e);
    expect(err).toBeInstanceOf(m.SeparateError);
    expect(err.why).toBe('unreached');
    await wait(200);
    expect(requestOf(b)).toBeUndefined();
    // Nothing changed meanwhile: the old pairing goes on.
    expect(m.conn.pairing?.deviceId).toBe('old-phone');
    await until(() => m.conn.state === 'open');
    // A choice made for another code does not count.
    expect(m.conn.separateFor({ ...offer, key: 'k'.repeat(22) })).not.toBe(m.conn.separateFor(offer));
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer), m.conn.separateFor(offer));
    await approve(b);
    await expect(p).resolves.toEqual({ old: 'stays' });
    expect(notes).toContain(m.OLD_STAYS);
    expect(m.conn.sealed()?.fp).toBe(offer.fp);
  }, 20_000);

  it('the old pairing counts as removed only when the desktop names exactly that device', async () => {
    // The same desktop, with this phone's plain entry: its ticket replaces exactly it.
    const token = 'old-phone-token-0123456789abcdef0123456789';
    const a = await desktop({ legacy: { id: 'old-a', token } });
    const m = await plainPhone(a.port, 'old-a', token);
    const offer = await offerOf(a);
    const notes: string[] = [];
    m.conn.onNotice((t) => notes.push(t));
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    await approve(a);
    await expect(p).resolves.toEqual({ old: 'removed' });
    expect(notes).not.toContain(m.OLD_STAYS);
    expect(await ids(a)).not.toContain('old-a');
    // A desktop that names another device as the one it removed: the old pairing is not said to be gone.
    const id = identityIn('other');
    const key = 'k'.repeat(22);
    const fakePort = await fakeDesktop(id, key, (t) =>
      JSON.parse(t).pair ? [{ paired: { token: 't'.repeat(43), deviceId: 'new-phone', desktop: 'Desk', replaced: 'someone-else' } }, { welcome: { deviceId: 'new-phone', desktop: 'Desk', version: '0', hosts: ['127.0.0.1'] } }] : [],
    );
    const n = await plainPhone(await plainDesktop(() => ({ fingerprint: id.fingerprint, ticket: 'TICKET-0123456789' })));
    const notes2: string[] = [];
    n.conn.onNotice((t) => notes2.push(t));
    const fake = { hosts: ['127.0.0.1'], port: fakePort, key, fp: id.fingerprint, name: 'Desk' };
    await expect(n.conn.pair(fake, 'Phone', () => {}, n.conn.beginPair(), n.conn.confirmFor(fake))).resolves.toEqual({ old: 'stays' });
    expect(notes2).toContain(n.OLD_STAYS);
  }, 30_000);

  it('a desktop over the old pairing that is another computer than the code\'s also asks first', async () => {
    const other = identityIn('elsewhere');
    const m = await plainPhone(await plainDesktop(() => ({ fingerprint: other.fingerprint, ticket: 'TICKET-0123456789' })));
    const b = await desktop();
    const offer = await offerOf(b);
    const err = await m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer)).catch((e) => e);
    expect(err).toBeInstanceOf(m.SeparateError);
    expect(err.why).toBe('other');
    expect(requestOf(b)).toBeUndefined();
  }, 20_000);
});

describe('an erasure that did not finish keeps the new pairing from connecting (8)', () => {
  it('after a replacement: kept, not connected while the old computer\'s data is still there, connected once it is gone', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    storage.eraseFails = true;
    const notes: string[] = [];
    m.conn.onNotice((t) => notes.push(t));
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    await approve(b);
    await p;
    expect(notes).toContain(m.ERASE_LEFT);
    expect(JSON.parse(stored.get('pairing')!).fp).toBe(offer.fp);
    expect(JSON.parse(stored.get('erasing')!).to).toBe(m.conn.pairing!.deviceId);
    expect(m.conn.cleaning).toBe(true);
    // Tries again by itself, and stays off the desktop while it fails.
    const tries = storage.erased;
    await until(() => storage.erased > tries + 1, 8000);
    expect(m.conn.state).toBe('offline');
    expect(m.conn.error).toBe(m.ERASE_LEFT);
    expect(m.conn.sealed()).toBeNull();
    await expect(m.conn.call('app.hello', {})).rejects.toMatchObject({ transport: 'unsent' });
    storage.eraseFails = false;
    await until(() => m.conn.sealed()?.fp === offer.fp, 12_000);
    expect(stored.get('erasing')).toBeUndefined();
    expect(m.conn.cleaning).toBe(false);
  }, 40_000);

  it('at a start: an erasure left over goes first, and the pairing waits for it', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const deviceId = m.conn.pairing!.deviceId;
    // Android stopped the app after the new pairing was kept, before the old computer's data was erased.
    stored.set('erasing', JSON.stringify({ to: deviceId }));
    storage.eraseFails = true;
    const n = await phoneApp();
    conns.push(n.conn);
    await n.conn.init();
    await wait(400);
    expect(n.conn.state).not.toBe('open');
    expect(n.conn.sealed()).toBeNull();
    storage.eraseFails = false;
    n.conn.wake();
    await until(() => n.conn.secure, 8000);
    expect(stored.get('erasing')).toBeUndefined();
  }, 30_000);
});

describe('pairing data that is there but cannot be read (22)', () => {
  it('is a state to recover from: nothing pairs without the person\'s confirmation, and it is erased first', async () => {
    stored.set('pairing', '{"token": 12');
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    expect(m.conn.lookup).toBe('damaged');
    expect(m.conn.state).toBe('unpaired');
    expect(m.conn.error).toBe(m.UNREADABLE);
    const a = await desktop();
    const offer = await offerOf(a);
    // A launch link pairs nothing unasked: it would replace what is kept.
    expect(m.conn.replaces(offer)).not.toBeNull();
    await expect(m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair())).rejects.toBeInstanceOf(m.ConfirmError);
    expect(requestOf(a)).toBeUndefined();
    expect(storage.erased).toBe(0);
    // Confirmed: erased first (the unreadable pairing with it), then paired.
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    await approve(a);
    await p;
    expect(storage.erased).toBe(1);
    expect(m.conn.lookup).toBe('ok');
    expect(JSON.parse(stored.get('pairing')!).fp).toBe(offer.fp);
    expect(m.conn.secure).toBe(true);
  }, 20_000);

  it('a stored object that is not a pairing counts the same', async () => {
    stored.set('pairing', JSON.stringify({ hosts: 'nowhere' }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    expect(m.conn.lookup).toBe('damaged');
    // Forget clears it too.
    await m.conn.forget();
    expect(m.conn.cleaning).toBe(false);
    expect(m.conn.lookup).toBe('ok');
    expect(stored.get('pairing')).toBeUndefined();
  });
});
