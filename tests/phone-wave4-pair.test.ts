/**
 * The phone's own connection after review wave 4 (mobile/src/lib/conn.ts, run here under Node's
 * WebSocket and WebCrypto against a real desktop endpoint and against made-up desktops): an old
 * plain pairing's token never goes to a new peer, only a ticket its own desktop gave, and only to
 * that desktop (1); every new pairing pins a key and a link without one is not taken (2); a refusal
 * counts only when the pinned desktop signed it, with words, and someone else answering at a saved
 * address never stops the phone for good nor hides the desktop at another address (18); a pairing
 * given up at any step closes every socket it opened, and a silent desktop's socket is closed when
 * the handshake times out (19); Forget fails visibly when the token stays in storage (20).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone, type PhoneService } from '../server/services/phone';
import { answerHello, loadIdentity, readSecHello, SealedLink, type Identity } from '../server/services/phone-secure';
import { FORGET_FAILED, removeChecked } from '../mobile/src/lib/credential';

// ── the phone's storage and the page's globals, as the WebView has them ──

const stored = new Map<string, string>();
const storage = { failRemove: false };
vi.mock('../mobile/src/lib/native', () => ({
  loadPairing: async () => {
    const v = stored.get('pairing');
    return v ? JSON.parse(v) : null;
  },
  savePairing: async (p: unknown) => void stored.set('pairing', JSON.stringify(p)),
  removePairing: async () =>
    removeChecked(
      {
        remove: async ({ key }) => {
          if (!storage.failRemove) stored.delete(key);
        },
        get: async ({ key }) => ({ value: stored.get(key) ?? null }),
      },
      'pairing',
    ),
}));
const g = globalThis as Record<string, unknown>;
g.window ??= { setTimeout, clearTimeout, addEventListener: () => {} };
g.document ??= { hidden: false, visibilityState: 'visible', addEventListener: () => {} };

type ConnModule = typeof import('../mobile/src/lib/conn');
type ForgetModule = typeof import('../mobile/src/lib/forget');
/** A fresh phone (its own connection object and its own forget hooks). */
async function phoneApp(): Promise<ConnModule & ForgetModule> {
  vi.resetModules();
  const c = await import('../mobile/src/lib/conn');
  const f = await import('../mobile/src/lib/forget');
  return { ...c, ...f };
}

const homes: string[] = [];
const apps: App[] = [];
const servers: WebSocketServer[] = [];
const conns: { forget: () => Promise<void>; cancelPair: () => void }[] = [];
beforeEach(() => {
  stored.clear();
  storage.failRemove = false;
});
afterEach(async () => {
  for (const c of conns.splice(0)) {
    c.cancelPair();
    storage.failRemove = false;
    await c.forget().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(() => r(null)));
  }
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A desktop: Sable's real endpoint on `host`, with phones paired before the secure channel when asked. */
async function desktop(opts: { host?: string; port?: number; legacy?: { id: string; token: string } } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w4p-'));
  homes.push(home);
  if (opts.legacy) {
    const device = { id: opts.legacy.id, name: 'Phone', tokenHash: createHash('sha256').update(opts.legacy.token).digest('hex'), pairedAt: 1 };
    writeFileSync(path.join(home, 'phone.json'), JSON.stringify({ enabled: true, devices: [device] }));
  }
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  const phone = registerPhone(app, { port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  return { app, phone, port: status.port, home };
}

/** A pairing offer of a real desktop, at this machine's loopback address. */
async function offerOf(app: App, port: number, host = '127.0.0.1') {
  const st = await app.call('phone.pair', {});
  const q = new URLSearchParams(st.pairing!.link.slice('sable://pair/2?'.length));
  return { hosts: [host], port, key: q.get('s')!, fp: q.get('f')!, name: os.hostname() };
}

/**
 * A made-up desktop speaking the secure channel: what it does with a phone's first frame (answers as
 * `identity` and keeps what the phone sends inside, says nothing, or answers as another key), and how
 * many sockets reached it.
 */
function fakeDesktop(opts: { identity: Identity; psk?: string; mode?: 'answer' | 'silent'; host?: string; port?: number }) {
  const wss = new WebSocketServer({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  servers.push(wss);
  const got: string[] = [];
  const seen = { connections: 0, open: 0 };
  wss.on('connection', (ws: WsSocket) => {
    seen.connections++;
    seen.open++;
    ws.on('close', () => seen.open--);
    ws.once('message', (raw) => {
      const sec = readSecHello(String(raw));
      if (!sec || opts.mode === 'silent') return;
      const ans = answerHello(opts.identity, sec, Buffer.from(opts.psk ?? 'x', 'utf8'));
      ws.send(ans.reply);
      if (ans.keys) new SealedLink(ws, ans.keys, { z: sec.z }).onMessage((t) => got.push(t));
    });
  });
  const ready = new Promise<number>((r) => wss.on('listening', () => r((wss.address() as { port: number }).port)));
  return { wss, got, seen, ready };
}

function identityIn(name: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w4id-'));
  homes.push(home);
  return loadIdentity(path.join(home, `${name}.pem`));
}

/** A phone with an old plain pairing to `port`, connected. */
async function legacyPhone(port: number, legacy: { id: string; token: string }) {
  stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port, token: legacy.token, deviceId: legacy.id, desktop: os.hostname() }));
  const m = await phoneApp();
  conns.push(m.conn);
  await m.conn.init();
  await until(() => m.conn.state === 'open');
  expect(m.conn.secure).toBe(false);
  return m;
}

describe('an old plain pairing paired again (1, 2)', () => {
  it('never sends its token to a new peer: a desktop that is not its own gets no replacement at all', async () => {
    const legacy = { id: 'old-phone', token: 'old-token-' + randomBytes(12).toString('hex') };
    const a = await desktop({ legacy });
    const m = await legacyPhone(a.port, legacy);
    // Another computer, under the same name, offers a pairing (a link from anywhere).
    const other = identityIn('other');
    const key = randomBytes(16).toString('base64url');
    const b = fakeDesktop({ identity: other, psk: key });
    const offer = { hosts: ['127.0.0.1'], port: await b.ready, key, fp: other.fingerprint, name: os.hostname() };
    expect(m.conn.replaces(offer)).toBeTruthy();
    const signal = m.conn.beginPair();
    const pairing = m.conn.pair(offer, 'Phone', () => {}, signal);
    pairing.catch(() => {});
    await until(() => b.got.length > 0);
    const frame = JSON.parse(b.got[0]) as { pair: { key: string; replaces?: unknown } };
    expect(frame.pair.key).toBe(key);
    expect(frame.pair.replaces).toBeUndefined();
    expect(b.got.join('')).not.toContain(legacy.token);
    m.conn.cancelPair();
    await expect(pairing).rejects.toThrow();
  });

  it('its own desktop replaces the old entry by the ticket it gave over the old pairing; the token stays home', async () => {
    const legacy = { id: 'old-phone', token: 'old-token-' + randomBytes(12).toString('hex') };
    const a = await desktop({ legacy });
    const m = await legacyPhone(a.port, legacy);
    const offer = await offerOf(a.app, a.port);
    const signal = m.conn.beginPair();
    const pairing = m.conn.pair(offer, 'Phone', () => {}, signal);
    await until(() => !!(a.phone as unknown as { request?: unknown }).request, 6000);
    const req = (a.phone as unknown as { request: { id: string; replaces?: { id: string; ticket: string } } }).request;
    expect(req.replaces?.id).toBe(legacy.id);
    expect(req.replaces?.ticket).toMatch(/^[\w-]{20,}$/);
    expect(JSON.stringify(req.replaces)).not.toContain(legacy.token);
    await a.app.call('phone.approve', { requestId: req.id, allow: true });
    await pairing;
    expect(m.conn.state).toBe('open');
    expect(m.conn.secure).toBe(true);
    const st = await a.app.call('phone.status', {});
    expect(st.devices.map((d) => d.id)).not.toContain(legacy.id);
    expect(st.devices).toHaveLength(1);
    expect(JSON.parse(stored.get('pairing')!).fp).toBe(offer.fp);
  });

  it('a link without a key to pin is not taken, nor is an older desktop\'s link', async () => {
    const m = await phoneApp();
    expect(m.parsePairLink('sable://pair?h=127.0.0.1&p=47820&k=0123456789abcdef0123')).toBeNull();
    expect(m.isOldPairLink('sable://pair?h=127.0.0.1&p=47820&k=0123456789abcdef0123')).toBe(true);
    expect(m.parsePairLink('sable://pair/2?h=127.0.0.1&p=47820&s=0123456789abcdef0123')).toBeNull();
    const ok = m.parsePairLink(`sable://pair/2?h=127.0.0.1&p=47820&s=0123456789abcdef0123&f=${'A'.repeat(43)}&n=Desk`);
    expect(ok).toMatchObject({ hosts: ['127.0.0.1'], port: 47820, fp: 'A'.repeat(43), name: 'Desk' });
    await expect(m.conn.pair({ hosts: ['127.0.0.1'], port: 1, key: 'k'.repeat(20), fp: '' }, 'Phone', () => {})).rejects.toThrow('That is not a Sable pairing link');
  });
});

describe('who may stop the phone (18)', () => {
  it('someone answering as another key at the saved address is said and tried again, never taken as a refusal', async () => {
    const pinned = identityIn('pinned');
    const impostor = identityIn('impostor');
    const fake = fakeDesktop({ identity: impostor });
    const port = await fake.ready;
    stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port, token: 't'.repeat(43), deviceId: 'dev', desktop: 'Desk', fp: pinned.fingerprint }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    await until(() => m.conn.state === 'offline');
    expect(m.conn.error).toMatch(/not the computer this phone was paired with/);
    // Not "denied": it goes on trying (here, at once).
    const before = fake.seen.connections;
    m.conn.wake();
    await until(() => fake.seen.connections > before);
    expect(m.conn.state).not.toBe('denied');
  });

  it('a fast answer from someone else at one address does not hide the desktop at another', async () => {
    // The desktop on 127.0.0.1, someone else on 127.0.0.2 at the same port, tried first.
    const a = await desktop();
    const { c: _c, ...paired } = await (async () => {
      const m = await phoneApp();
      conns.push(m.conn);
      const offer = await offerOf(a.app, a.port);
      const signal = m.conn.beginPair();
      const p = m.conn.pair(offer, 'Phone', () => {}, signal);
      await until(() => !!(a.phone as unknown as { request?: unknown }).request, 6000);
      await a.app.call('phone.approve', { requestId: (a.phone as unknown as { request: { id: string } }).request.id, allow: true });
      await p;
      const pairing = JSON.parse(stored.get('pairing')!);
      m.conn.cancelPair();
      return { c: m, pairing };
    })();
    const fast = fakeDesktop({ identity: identityIn('fast'), host: '127.0.0.2', port: a.port });
    await fast.ready;
    stored.set('pairing', JSON.stringify({ ...paired.pairing, hosts: ['127.0.0.2', '127.0.0.1'], lastHost: '127.0.0.2' }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    await until(() => m.conn.state === 'open', 8000);
    expect(m.conn.secure).toBe(true);
    expect(fast.seen.connections).toBeGreaterThan(0);
    expect(JSON.parse(stored.get('pairing')!).lastHost).toBe('127.0.0.1');
  }, 20_000);
});

describe('a pairing given up (19)', () => {
  it('while the addresses are still being tried: no socket of it reaches the desktop afterwards', async () => {
    const id = identityIn('desk');
    const fake = fakeDesktop({ identity: id, mode: 'silent' });
    const port = await fake.ready;
    const m = await phoneApp();
    conns.push(m.conn);
    // The first address does not answer at all; the desktop is the second (tried a moment later).
    const offer = { hosts: ['10.255.255.1', '127.0.0.1'], port, key: 'k'.repeat(22), fp: id.fingerprint, name: 'Desk' };
    const signal = m.conn.beginPair();
    const p = m.conn.pair(offer, 'Phone', () => {}, signal);
    await wait(50);
    m.conn.cancelPair();
    await expect(p).rejects.toThrow('Cancelled');
    await wait(1200);
    expect(fake.seen.connections).toBe(0);
    expect(stored.get('pairing')).toBeUndefined();
  }, 20_000);

  it('a desktop that never answers the handshake: its socket is closed when the handshake times out', async () => {
    const id = identityIn('desk');
    const fake = fakeDesktop({ identity: id, mode: 'silent' });
    const port = await fake.ready;
    const m = await phoneApp();
    conns.push(m.conn);
    m.TIMING.handshake = 300;
    const p = m.conn.pair({ hosts: ['127.0.0.1'], port, key: 'k'.repeat(22), fp: id.fingerprint, name: 'Desk' }, 'Phone', () => {}, m.conn.beginPair());
    await until(() => fake.seen.connections === 1);
    await expect(p).rejects.toThrow('The desktop did not answer');
    await until(() => fake.seen.open === 0);
    m.TIMING.handshake = 8000;
  });
});

describe('forgetting the computer (20)', () => {
  it('when the token cannot be removed from storage it says so and forgets nothing; otherwise everything goes together', async () => {
    const legacy = { id: 'old-phone', token: 'old-token-' + randomBytes(12).toString('hex') };
    const a = await desktop({ legacy });
    const m = await legacyPhone(a.port, legacy);
    const forgotten: string[] = [];
    m.onForget(() => forgotten.push('drafts'));
    m.onForget(() => forgotten.push('downloads'));
    storage.failRemove = true;
    await expect(m.conn.forget()).rejects.toThrow(FORGET_FAILED);
    expect(m.conn.pairing).not.toBeNull();
    expect(forgotten).toEqual([]);
    storage.failRemove = false;
    await m.conn.forget();
    expect(stored.get('pairing')).toBeUndefined();
    expect(m.conn.state).toBe('unpaired');
    expect(forgotten).toEqual(['drafts', 'downloads']);
  });

  it('a removal is checked by reading it back', async () => {
    const left = { remove: async () => {}, get: async () => ({ value: '{"token":"x"}' }) };
    await expect(removeChecked(left, 'pairing')).rejects.toThrow(FORGET_FAILED);
    const broken = { remove: async () => Promise.reject(new Error('locked')), get: async () => ({ value: null }) };
    await expect(removeChecked(broken, 'pairing')).rejects.toThrow(FORGET_FAILED);
    await expect(removeChecked({ remove: async () => {}, get: async () => ({ value: null }) }, 'pairing')).resolves.toBeUndefined();
  });
});

// The desktop endpoint type is only used through casts above.
export type { PhoneService };
