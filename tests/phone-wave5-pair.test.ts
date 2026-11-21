/**
 * The phone's connection after review wave 5 (mobile/src/lib/conn.ts under Node's WebSocket and
 * WebCrypto, against real desktop endpoints and made-up ones): every wire and call belongs to one
 * credential generation, a reconnect with the old credential never takes over a new pairing, and
 * file calls go only over the wire that proved the paired desktop (1); a pairing is a separate
 * candidate kept only after `paired` and a matching `welcome` and a write that worked (2); nothing
 * pairs before the saved pairing was read, a read error is not "none", and replacing a pairing needs
 * the person's confirmation bound to that pairing and that offer (3); each address counts once, and a
 * pairing given up reconnects the one kept (17); the scanner takes what the link parser takes (16);
 * Forget and a replacement by another computer are restart-safe (10).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerPhone } from '../server/services/phone';
import { answerHello, loadIdentity, readSecHello, SealedLink, type Identity } from '../server/services/phone-secure';
import { FORGET_FAILED, removeChecked } from '../mobile/src/lib/credential';

// ── the phone's storage, as Capacitor Preferences and Android's commit give it ──

const stored = new Map<string, string>();
const storage = { failRemove: false, failSave: false, failRead: false, erased: 0, eraseFails: false };
vi.mock('../mobile/src/lib/native', () => ({
  loadMark: async () => {
    if (storage.failRead) throw new Error('unreadable');
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
  loadPairing: async () => {
    if (storage.failRead) throw new Error('unreadable');
    const v = stored.get('pairing');
    return v ? JSON.parse(v) : null;
  },
  savePairing: async (p: unknown) => {
    if (storage.failSave) throw new Error('full');
    stored.set('pairing', JSON.stringify(p));
  },
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
type EpochModule = typeof import('../mobile/src/lib/epoch');
/** A fresh phone (its own connection object, its own forget hooks and generation). */
async function phoneApp(): Promise<ConnModule & ForgetModule & EpochModule> {
  vi.resetModules();
  const c = await import('../mobile/src/lib/conn');
  const f = await import('../mobile/src/lib/forget');
  const e = await import('../mobile/src/lib/epoch');
  return { ...c, ...f, ...e };
}

const homes: string[] = [];
const apps: App[] = [];
const servers: WebSocketServer[] = [];
const nets: Server[] = [];
const conns: { forget: () => Promise<void>; cancelPair: () => void }[] = [];
beforeEach(() => {
  stored.clear();
  Object.assign(storage, { failRemove: false, failSave: false, failRead: false, erased: 0, eraseFails: false });
});
afterEach(async () => {
  storage.failRead = false;
  storage.failRemove = false;
  for (const c of conns.splice(0)) {
    c.cancelPair();
    await c.forget().catch(() => {});
  }
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate();
    await new Promise((r) => s.close(() => r(null)));
  }
  for (const n of nets.splice(0)) await new Promise((r) => n.close(() => r(null)));
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
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w5p-'));
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

/** A phone paired securely with `d`, connected. */
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
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-w5id-'));
  homes.push(home);
  return loadIdentity(path.join(home, `${name}.pem`));
}

/** A made-up desktop on the secure channel: answers the pairing handshake as `identity` and then sends `frames` (as it likes). */
function fakeDesktop(identity: Identity, psk: string, frames: (got: string) => unknown[]) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  const seen = { connections: 0 };
  wss.on('connection', (ws: WsSocket) => {
    seen.connections++;
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
  const ready = new Promise<number>((r) => wss.on('listening', () => r((wss.address() as { port: number }).port)));
  return { seen, ready };
}

/** A desktop from before the secure channel (plain JSON frames): answers a hello with a welcome when `release` says so. */
function plainDesktop() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(wss);
  const state = { connections: 0, open: 0, hold: false, held: [] as (() => void)[] };
  wss.on('connection', (ws: WsSocket) => {
    state.connections++;
    state.open++;
    ws.on('close', () => state.open--);
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as { hello?: unknown; id?: number; method?: string };
      if (f.hello) {
        const go = () => ws.send(JSON.stringify({ welcome: { deviceId: 'old-phone', desktop: 'Old', version: '0', hosts: ['127.0.0.1'] } }));
        if (state.hold) state.held.push(go);
        else go();
      } else if (f.id) ws.send(JSON.stringify({ id: f.id, ok: false, error: 'Unknown method' }));
    });
  });
  const ready = new Promise<number>((r) => wss.on('listening', () => r((wss.address() as { port: number }).port)));
  return { state, ready };
}

describe('one credential generation per wire and call (1)', () => {
  it('while a new pairing waits for Allow, waking the phone never reconnects with the old credential; once kept, only the new wire carries calls', async () => {
    const old = plainDesktop();
    const port = await old.ready;
    stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port, token: 'old-token', deviceId: 'old-phone', desktop: 'Old' }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    await until(() => m.conn.state === 'open');
    const a = await desktop();
    const offer = await offerOf(a);
    // That old desktop gives no ticket: paired as a separate pairing, as the person chose (review wave 6, #6).
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer), m.conn.separateFor(offer));
    await until(() => !!requestOf(a), 6000);
    const before = old.state.connections;
    // Back to the front, the network back, a retry due: none of them reaches the old desktop now.
    m.conn.sleep();
    m.conn.wake();
    void (m.conn as unknown as { connect: () => Promise<void> }).connect();
    await wait(300);
    expect(old.state.connections).toBe(before);
    await a.app.call('phone.approve', { requestId: requestOf(a)!.id, allow: true });
    await p;
    await wait(300);
    expect(old.state.connections).toBe(before);
    expect(m.conn.sealed()?.fp).toBe(offer.fp);
    expect(JSON.parse(stored.get('pairing')!)).toMatchObject({ fp: offer.fp, port: a.port });
    await expect(m.conn.call('app.hello', {})).resolves.toBeTruthy();
  }, 20_000);

  it('a reconnect of an older generation whose welcome comes late is not taken', async () => {
    const old = plainDesktop();
    old.state.hold = true;
    const port = await old.ready;
    stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port, token: 'old-token', deviceId: 'old-phone', desktop: 'Old' }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    await until(() => old.state.held.length === 1);
    // The credential moves on (as a pairing kept does) while that attempt waits for its welcome.
    (m.conn as unknown as { gen: number }).gen++;
    old.state.held.splice(0).forEach((go) => go());
    await wait(300);
    expect(m.conn.state).not.toBe('open');
    await until(() => old.state.open === 0);
  });

  it('file calls go only over the wire that proved the paired desktop: after another pairing, the old one fails them as lost', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const first = m.conn.sealed()!;
    expect(first.fp).toBeTruthy();
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    await approve(b);
    await p;
    expect(m.conn.sealed()?.fp).toBe(offer.fp);
    await expect(first.call('app.hello', {})).rejects.toMatchObject({ transport: 'lost' });
  }, 20_000);
});

describe('a pairing is a candidate until kept (2)', () => {
  it('a welcome without `paired` (or another device\'s) pairs nothing and adds nothing to the pairing this phone has', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const was = stored.get('pairing');
    const id = identityIn('other');
    const key = randomBytes(16).toString('base64url');
    for (const frames of [
      () => [{ waiting: true }, { welcome: { deviceId: 'x', desktop: 'Other', version: '0', hosts: ['10.9.9.9'] } }],
      () => [{ paired: { token: 't'.repeat(43), deviceId: 'y', desktop: 'Other' } }, { welcome: { deviceId: 'z', desktop: 'Other', version: '0', hosts: ['10.9.9.9'] } }],
    ]) {
      const fake = fakeDesktop(id, key, frames);
      const offer = { hosts: ['127.0.0.1'], port: await fake.ready, key, fp: id.fingerprint, name: 'Other' };
      await expect(m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer))).rejects.toThrow('did not answer as Sable does');
      expect(stored.get('pairing')).toBe(was);
      expect(m.conn.pairing?.hosts).not.toContain('10.9.9.9');
      await until(() => m.conn.state === 'open' && m.conn.secure);
    }
  }, 30_000);

  it('a pairing that could not be written is not kept: the old one goes on', async () => {
    const a = await desktop();
    const { m, offer: first } = await pairedWith(a);
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    storage.failSave = true;
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    p.catch(() => {});
    await approve(b);
    await expect(p).rejects.toThrow(m.KEEP_FAILED);
    storage.failSave = false;
    expect(JSON.parse(stored.get('pairing')!).fp).toBe(first.fp);
    expect(m.conn.pairing?.fp).toBe(first.fp);
    await until(() => m.conn.sealed()?.fp === first.fp);
  }, 20_000);
});

describe('nothing pairs unseen (3)', () => {
  it('a pairing asked for before the saved one was read waits for it, and then asks to replace it', async () => {
    const a = await desktop();
    const { offer: first } = await pairedWith(a);
    const saved = stored.get('pairing')!;
    // A cold start: the link is there before the saved pairing is read.
    const m = await phoneApp();
    conns.push(m.conn);
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    expect(m.conn.replaces(offer)).toBeNull();
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair());
    p.catch(() => {});
    await m.conn.init();
    await expect(p).rejects.toBeInstanceOf(m.ConfirmError);
    expect(requestOf(b)).toBeUndefined();
    expect(stored.get('pairing')).toBe(saved);
    expect(m.conn.pairing?.fp).toBe(first.fp);
  }, 20_000);

  it("a confirmation counts only for the pairing it was given for and the offer it was given about", async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    const token = m.conn.confirmFor(offer)!;
    expect(token).toBeTruthy();
    // Another code from the same desktop (a new secret), or a token made up: asked again.
    const other = { ...offer, key: randomBytes(16).toString('base64url') };
    await expect(m.conn.pair(other, 'Phone', () => {}, m.conn.beginPair(), token)).rejects.toBeInstanceOf(m.ConfirmError);
    await expect(m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), 'x')).rejects.toBeInstanceOf(m.ConfirmError);
    expect(requestOf(b)).toBeUndefined();
  }, 20_000);

  it('a read that fails is not "nothing saved": the phone does not pair', async () => {
    storage.failRead = true;
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    expect(m.conn.lookup).toBe('failed');
    expect(m.conn.state).toBe('unpaired');
    expect(m.conn.error).toBe(m.READ_FAILED);
    const id = identityIn('desk');
    await expect(m.conn.pair({ hosts: ['127.0.0.1'], port: 1, key: 'k'.repeat(22), fp: id.fingerprint, name: 'Desk' }, 'Phone', () => {}, m.conn.beginPair())).rejects.toThrow(m.READ_FAILED);
  });
});

describe('reaching the desktop (17)', () => {
  it('an address whose socket fails (error and close) counts once: the desktop at the next address is still reached', async () => {
    const a = await desktop();
    await pairedWith(a);
    const pairing = JSON.parse(stored.get('pairing')!);
    // Something at 127.0.0.3 on the same port drops every connection at once.
    const drop = createServer((s: Socket) => s.destroy());
    nets.push(drop);
    await new Promise<void>((r) => drop.listen(a.port, '127.0.0.3', () => r()));
    stored.set('pairing', JSON.stringify({ ...pairing, hosts: ['127.0.0.3', '127.0.0.1'], lastHost: '127.0.0.3' }));
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    await until(() => m.conn.state === 'open' || m.conn.state === 'offline', 8000);
    expect(m.conn.state).toBe('open');
    expect(m.conn.secure).toBe(true);
  }, 20_000);

  it('a pairing given up reconnects the one this phone kept, though the state still said open', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const id = identityIn('silent');
    const silent = fakeDesktop(id, 'k'.repeat(22), () => []);
    const offer = { hosts: ['127.0.0.1'], port: await silent.ready, key: 'k'.repeat(22), fp: id.fingerprint, name: 'Other' };
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    p.catch(() => {});
    await until(() => silent.seen.connections > 0);
    expect(m.conn.secure).toBe(false);
    m.conn.cancelPair();
    await expect(p).rejects.toThrow('Cancelled');
    await until(() => m.conn.secure, 8000);
    await expect(m.conn.call('app.hello', {})).resolves.toBeTruthy();
  }, 20_000);
});

describe('the scanner (16)', () => {
  it('takes a version 2 code and an older desktop\'s (to say it is too old), nothing else', async () => {
    const m = await phoneApp();
    expect(m.isPairCode(`sable://pair/2?h=127.0.0.1&p=47820&s=0123456789abcdef0123&f=${'A'.repeat(43)}&n=Desk`)).toBe(true);
    expect(m.isPairCode('sable://pair?h=127.0.0.1&p=47820&k=0123456789abcdef0123')).toBe(true);
    expect(m.isPairCode('https://example.com/sable://pair')).toBe(false);
    expect(m.isPairCode('hello')).toBe(false);
  });
});

describe('Forget and replacement, restart-safe (10)', () => {
  it('a mark goes down before the token goes; a Forget cut off goes on at the next start', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const gen = m.epoch();
    const forgotten: string[] = [];
    m.onForget(() => void forgotten.push('drafts'));
    await m.conn.forget();
    expect(stored.get('pairing')).toBeUndefined();
    expect(stored.get('erasing')).toBeUndefined();
    expect(forgotten).toEqual(['drafts']);
    expect(m.epoch()).toBeGreaterThan(gen);
    // Android stopped the app after the mark, before anything else: the token is still there.
    const pairing = JSON.stringify({ hosts: ['127.0.0.1'], port: a.port, token: 't'.repeat(43), deviceId: 'dev', desktop: 'Desk', fp: 'F'.repeat(43) });
    stored.set('pairing', pairing);
    stored.set('erasing', JSON.stringify({ forget: true }));
    const n = await phoneApp();
    conns.push(n.conn);
    const erased = storage.erased;
    await n.conn.init();
    expect(stored.get('pairing')).toBeUndefined();
    expect(stored.get('erasing')).toBeUndefined();
    expect(storage.erased).toBe(erased + 1);
    expect(n.conn.state).toBe('unpaired');
    expect(n.conn.pairing).toBeNull();
  }, 20_000);

  it('an erasure that leaves something keeps its mark and goes on next time; a token that will not go is never used', async () => {
    stored.set('pairing', JSON.stringify({ hosts: ['127.0.0.1'], port: 1, token: 't'.repeat(43), deviceId: 'dev', desktop: 'Desk', fp: 'F'.repeat(43) }));
    stored.set('erasing', JSON.stringify({ forget: true }));
    storage.failRemove = true;
    const m = await phoneApp();
    conns.push(m.conn);
    await m.conn.init();
    expect(m.conn.pairing).toBeNull();
    expect(m.conn.state).toBe('unpaired');
    expect(stored.get('erasing')).toBeTruthy();
    storage.failRemove = false;
    storage.eraseFails = true;
    const n = await phoneApp();
    conns.push(n.conn);
    const notes: string[] = [];
    n.conn.onNotice((t) => notes.push(t));
    await n.conn.init();
    expect(stored.get('pairing')).toBeUndefined();
    expect(stored.get('erasing')).toBeTruthy();
    storage.eraseFails = false;
  });

  it('a replacement by another computer erases the old one\'s data once the new pairing is the one kept, and not before', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    const forgotten: number[] = [];
    m.onForget(() => void forgotten.push(1));
    const b = await desktop();
    const offer = await offerOf(b, 'Other');
    const p = m.conn.pair(offer, 'Phone', () => {}, m.conn.beginPair(), m.conn.confirmFor(offer));
    await approve(b);
    await p;
    expect(forgotten).toEqual([1]);
    expect(stored.get('erasing')).toBeUndefined();
    // Cut off with the mark naming a pairing that was never kept: nothing erased, the mark goes.
    stored.set('erasing', JSON.stringify({ to: 'never-kept' }));
    const n = await phoneApp();
    conns.push(n.conn);
    const erased = storage.erased;
    await n.conn.init();
    expect(storage.erased).toBe(erased);
    expect(stored.get('erasing')).toBeUndefined();
    expect(n.conn.pairing?.fp).toBe(offer.fp);
    // Cut off after the new pairing was kept: erased at the start, the pairing stays.
    stored.set('erasing', JSON.stringify({ to: n.conn.pairing!.deviceId }));
    const o = await phoneApp();
    conns.push(o.conn);
    await o.conn.init();
    expect(storage.erased).toBe(erased + 1);
    expect(stored.get('erasing')).toBeUndefined();
    expect(o.conn.pairing?.fp).toBe(offer.fp);
  }, 30_000);

  it('a Forget whose token stays in storage changes nothing and leaves no mark', async () => {
    const a = await desktop();
    const { m } = await pairedWith(a);
    storage.failRemove = true;
    await expect(m.conn.forget()).rejects.toThrow(FORGET_FAILED);
    expect(stored.get('erasing')).toBeUndefined();
    expect(m.conn.pairing).not.toBeNull();
    storage.failRemove = false;
  }, 20_000);
});

// Names the hosting service exports for its type only (used through casts above).
export type { Server };
void os;
