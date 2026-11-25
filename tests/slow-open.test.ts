/**
 * An agent that takes long to start (Codex's thread start can take most of a minute): the new
 * session answers early, the first message shows at once and goes out once the agent is there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@shared/protocol';
import { App } from '../server/app';
import type { SessionRuntime } from '../server/core/runtime';
import { DemoProvider } from '../server/providers/demo';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class SlowDemo extends DemoProvider {
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }) {
    await sleep(2500);
    return super.open(rt, opts);
  }
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe('a slow agent start', () => {
  it('answers session.create early and shows the first message while the agent starts', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    const statuses: string[] = [];
    app.subscribe((e: BridgeEvent) => {
      if (e.type === 'session.updated' && e.patch.status) statuses.push(e.patch.status);
    });
    const t0 = Date.now();
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    expect(Date.now() - t0).toBeLessThan(2300);
    expect(snap.session.status).toBe('starting');

    const sending = app.call('session.send', { sessionId: snap.session.id, text: 'hi' });
    await sleep(50);
    const rt = app.runtime(snap.session.id);
    expect(rt.items.some((i) => i.type === 'user' && i.text === 'hi')).toBe(true);
    expect(rt.meta.status).toBe('starting');

    await sending;
    for (let i = 0; i < 100 && !rt.items.some((x) => x.type === 'turn'); i++) await sleep(50);
    expect(rt.items.some((x) => x.type === 'turn')).toBe(true);
    // Never "idle" between the start and the first turn.
    expect(statuses.indexOf('running')).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(0, statuses.indexOf('running'))).not.toContain('idle');
    expect(rt.items.filter((x) => x.type === 'user')).toHaveLength(1);
    await app.dispose();
  });

  it('shows a message at once in a restored session whose agent starts with it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const first = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    const made = await first.call('session.create', { provider: 'demo', cwd: home });
    await first.dispose();

    // After a restart the session is back without its agent: the next message starts it.
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    let opens = 0;
    const provider = app.provider('demo') as SlowDemo;
    const open = provider.open.bind(provider);
    provider.open = (rt, opts) => (opens++, open(rt, opts));
    const id = made.session.id;
    const sending = app.call('session.send', { sessionId: id, text: 'hi' });
    await sleep(50);
    const rt = app.runtime(id);
    expect(rt.handle).toBeUndefined();
    expect(rt.items.some((i) => i.type === 'user' && i.text === 'hi')).toBe(true);
    expect(rt.meta.status).toBe('starting');
    // A second message while the agent starts waits for the same start.
    const second = app.call('session.send', { sessionId: id, text: 'and this' });
    await Promise.all([sending, second]);
    expect(opens).toBe(1);
    for (let i = 0; i < 100 && !rt.items.some((x) => x.type === 'turn'); i++) await sleep(50);
    expect(rt.items.some((x) => x.type === 'turn')).toBe(true);
    expect(rt.items.filter((x) => x.type === 'user').map((u) => (u as { text: string }).text)).toEqual(['hi', 'and this']);
    await app.dispose();
  });

  it('does not start the agent for a session closed while it was starting', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(snap.session.id);
    const sending = app.call('session.send', { sessionId: snap.session.id, text: 'hi' });
    await app.call('session.close', { sessionId: snap.session.id, remove: true });
    await sending;
    await sleep(1500);
    expect(rt.handle).toBeUndefined();
    expect(rt.items.some((x) => x.type === 'turn')).toBe(false);
    await app.dispose();
  });

  it('stops cleanly when the user stops while the agent is still starting', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-slow-'));
    homes.push(home);
    const app = new App({ home, providers: [(ctx) => new SlowDemo(ctx, { speed: 0 })], quiet: true });
    const statuses: string[] = [];
    app.subscribe((e: BridgeEvent) => {
      if (e.type === 'session.updated' && e.patch.status) statuses.push(e.patch.status);
    });
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(snap.session.id);
    const sending = app.call('session.send', { sessionId: snap.session.id, text: 'hi' });
    await sleep(50);
    await app.call('session.interrupt', { sessionId: snap.session.id });
    // Idle at once, the message where it was sent, stopped like any other turn.
    expect(rt.meta.status).toBe('idle');
    expect(rt.items.map((i) => i.type)).toEqual(['user', 'notice']);
    expect(rt.items[1]).toMatchObject({ variant: 'interrupted' });
    await sending;
    await sleep(300);
    // The agent is there now, and the stopped message never went out.
    expect(rt.handle).toBeDefined();
    expect(rt.meta.status).toBe('idle');
    expect(rt.items.some((x) => x.type === 'turn' || x.type === 'text')).toBe(false);
    expect(statuses.slice(statuses.indexOf('idle'))).not.toContain('running');

    // A message sent after that goes out as usual.
    await app.call('session.send', { sessionId: snap.session.id, text: 'hi again' });
    for (let i = 0; i < 100 && !rt.items.some((x) => x.type === 'turn'); i++) await sleep(50);
    expect(rt.items.some((x) => x.type === 'turn')).toBe(true);
    // The stopped message was never written to the agent, so it is not a sent card: it waits in the queue by
    // hand with the reason (0.2.37: "sent" means the provider wrote it), and nothing of it is lost.
    expect(rt.items.filter((x) => x.type === 'user').map((u) => (u as { text: string }).text)).toEqual(['hi again']);
    expect(rt.queue).toMatchObject([{ text: 'hi', byHand: true, steerWait: { reason: 'Stopped before the provider opened.' } }]);
    await app.dispose();
  });
});
