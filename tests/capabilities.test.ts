/** Start-up cache (provider info, capabilities), session options and prewarm, against fake and demo agents. */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, Capabilities, ProviderInfo } from '@shared/protocol';
import { App } from '../server/app';
import { DiskCache } from '../server/core/cache';
import { DemoProvider } from '../server/providers/demo';
import type { Provider, ProviderContext } from '../server/providers/types';

const homes: string[] = [];
const apps: App[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'sable-caps-'));
  homes.push(d);
  return d;
};

afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A slow "claude" whose answers the test controls (the demo agent is never cached). */
function fakeClaude(state: { infoCalls: number; capsCalls: number; models: string[]; delay: number }) {
  return (ctx: ProviderContext): Provider => {
    const demo = new DemoProvider(ctx, { speed: 0 });
    return {
      id: 'claude',
      name: 'Claude Code',
      async info(): Promise<ProviderInfo> {
        state.infoCalls++;
        await wait(state.delay);
        return { id: 'claude', name: 'Claude Code', installed: true, version: `2.${state.infoCalls}`, auth: { loggedIn: true, email: 'a@example.com' } };
      },
      async caps(): Promise<Capabilities> {
        state.capsCalls++;
        await wait(state.delay);
        const base = await demo.caps();
        return { ...base, models: state.models.map((id) => ({ id, name: id })) };
      },
      login: () => demo.login(),
      cancelLogin: () => demo.cancelLogin(),
      logout: () => demo.logout(),
      limits: () => demo.limits(),
      history: (cwd, limit) => demo.history(cwd, limit),
      open: (rt, opts) => demo.open(rt, opts),
      dispose: () => demo.dispose(),
    };
  };
}

function makeApp(home: string, providers: ((ctx: ProviderContext) => Provider)[]) {
  const app = new App({ home, providers, quiet: true, refreshDelays: { info: 20, caps: 20 } });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(e));
  return { app, events };
}

describe('DiskCache', () => {
  it('round-trips values across instances and reports whether anything changed', async () => {
    const home = tmp();
    const a = new DiskCache(home);
    expect(a.get('caps:claude:default:x')).toBeUndefined();
    expect(a.set('caps:claude:default:x', { n: 1 })).toBe(true);
    expect(a.set('caps:claude:default:x', { n: 1 })).toBe(false);
    await a.flush();
    expect(new DiskCache(home).get('caps:claude:default:x')).toEqual({ n: 1 });
  });

  it('treats an unreadable file as no entry', async () => {
    const home = tmp();
    const a = new DiskCache(home);
    a.set('info:claude', { ok: true });
    await a.flush();
    const [file] = readdirSync(path.join(home, 'cache'));
    writeFileSync(path.join(home, 'cache', file), '{not json');
    expect(new DiskCache(home).get('info:claude')).toBeUndefined();
  });
});

describe('start-up cache', () => {
  it('answers app.hello and provider.caps from the cache, then pushes fresh answers', async () => {
    const home = tmp();
    const state = { infoCalls: 0, capsCalls: 0, models: ['opus', 'haiku'], delay: 150 };
    // First start: nothing cached, the agent is asked and the answers are kept.
    const first = makeApp(home, [fakeClaude(state)]);
    const hello1 = await first.app.call('app.hello', {});
    expect(hello1.providers[0].version).toBe('2.1');
    const caps1 = await first.app.call('provider.caps', { provider: 'claude', cwd: home });
    expect(caps1.models.map((m) => m.id)).toEqual(['opus', 'haiku']);
    await first.app.dispose();

    // Second start: answers from disk without waiting for the agent, which is slow (far slower here
    // than the bound, so a busy machine cannot make an answer from disk look like a wait).
    state.models = ['opus', 'sonnet', 'haiku'];
    state.delay = 1500;
    const second = makeApp(home, [fakeClaude(state)]);
    let t = performance.now();
    const hello2 = await second.app.call('app.hello', {});
    expect(performance.now() - t).toBeLessThan(700);
    expect(hello2.providers[0].version).toBe('2.1');
    expect(hello2.providers[0].accounts?.[0].auth.email).toBe('a@example.com');
    t = performance.now();
    const caps2 = await second.app.call('provider.caps', { provider: 'claude', cwd: home });
    expect(performance.now() - t).toBeLessThan(700);
    expect(caps2.models.map((m) => m.id)).toEqual(['opus', 'haiku']);

    // The background refresh finds the changed model list and the new version, and says so.
    for (let i = 0; i < 100 && !(second.events.some((e) => e.type === 'caps.updated') && second.events.some((e) => e.type === 'provider.updated')); i++) await wait(100);
    const capsEvent = second.events.find((e) => e.type === 'caps.updated');
    expect(capsEvent && capsEvent.type === 'caps.updated' && capsEvent.caps.models.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(capsEvent && capsEvent.type === 'caps.updated' && capsEvent.cwd).toBe(home);
    const infoEvent = second.events.find((e) => e.type === 'provider.updated');
    expect(infoEvent && infoEvent.type === 'provider.updated' && infoEvent.provider.version).not.toBe('2.1');
  });

  it('does not push caps.updated when the fresh answer is the same', async () => {
    const home = tmp();
    const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 0 };
    const first = makeApp(home, [fakeClaude(state)]);
    await first.app.call('provider.caps', { provider: 'claude', cwd: home });
    await first.app.dispose();
    const second = makeApp(home, [fakeClaude(state)]);
    await second.app.call('provider.caps', { provider: 'claude', cwd: home });
    await wait(200);
    expect(state.capsCalls).toBe(2);
    expect(second.events.some((e) => e.type === 'caps.updated')).toBe(false);
  });
});

describe('session options', () => {
  const demo = (ctx: ProviderContext) => new DemoProvider(ctx, { speed: 0 });

  it('starts new sessions with the defaults from settings and persists changes', async () => {
    const home = tmp();
    const { app } = makeApp(home, [demo]);
    await app.call('app.setSettings', { patch: { sessionOptions: { demo: { browser: true } } } });
    const snap = await app.call('session.create', { provider: 'demo', cwd: '/demo/project' });
    expect(snap.session.options).toEqual({ browser: true });
    expect(snap.caps?.features.remoteControl).toBe(true);
    await wait(10);
    expect(app.runtime(snap.session.id).meta.capState?.browser?.status).toMatch(/Chrome/);

    await app.call('session.setOptions', { sessionId: snap.session.id, options: { remoteControl: true } });
    const meta = app.runtime(snap.session.id).meta;
    expect(meta.options).toEqual({ browser: true, remoteControl: true });
    expect(meta.remote?.url).toMatch(/^https:\/\//);
    await app.dispose();

    // A restart keeps the choice; the link belonged to the agent process and is gone.
    const { app: again } = makeApp(home, [demo]);
    const restored = again.runtime(snap.session.id).meta;
    expect(restored.options).toEqual({ browser: true, remoteControl: true });
    expect(restored.remote?.url).toBeUndefined();
    expect(restored.remote?.status).toMatch(/Reconnects/);
    expect(restored.capState).toBeUndefined();

    await again.call('session.setOptions', { sessionId: snap.session.id, options: { remoteControl: false } });
    expect(again.runtime(snap.session.id).meta.remote).toBeUndefined();
  });

  it('never prewarms the demo agent, nor when prewarm is off', async () => {
    const home = tmp();
    const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 0 };
    const { app } = makeApp(home, [demo, fakeClaude(state)]);
    expect(await app.call('provider.prewarm', { provider: 'demo', cwd: home })).toEqual({ ok: false });
    // The fake agent has no prewarm of its own.
    expect(await app.call('provider.prewarm', { provider: 'claude', cwd: home })).toEqual({ ok: false });
    await app.call('app.setSettings', { patch: { prewarm: false } });
    expect(await app.call('provider.prewarm', { provider: 'claude', cwd: home })).toEqual({ ok: false });
  });
});
