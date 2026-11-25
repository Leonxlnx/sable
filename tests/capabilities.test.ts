/** Start-up cache (provider info, capabilities), session options and prewarm, against fake and demo agents. */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, Capabilities, ProviderInfo } from '@shared/protocol';
import { App } from '../server/app';
import { DiskCache } from '../server/core/cache';
import { DemoProvider } from '../server/providers/demo';
import { cliPresentSoon } from '../server/util/cli-present';
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
    // First start: nothing cached, the agent is asked and the answers are kept (hello does not wait
    // for it: the answer comes as provider.updated, see 'a first start').
    const first = makeApp(home, [fakeClaude(state)]);
    await first.app.call('app.hello', {});
    for (let i = 0; i < 100 && !first.events.some((e) => e.type === 'provider.updated'); i++) await wait(20);
    const info1 = first.events.find((e) => e.type === 'provider.updated');
    expect(info1 && info1.type === 'provider.updated' && info1.provider.version).toBe('2.1');
    const caps1 = await first.app.call('provider.caps', { provider: 'claude', cwd: home });
    expect(caps1.models.map((m) => m.id)).toEqual(['opus', 'haiku']);
    // A recently used account is eligible for the passive refresh on the next start.
    await first.app.call('session.create', { provider: 'claude', cwd: home });
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

  it('a first start: app.hello never waits for an agent\'s CLI, and its answer follows as provider.updated', async () => {
    const home = tmp();
    // The CLI is there by its override (the desktop shell sets it for the bundled Claude Code).
    const bin = path.join(home, 'claude.exe');
    writeFileSync(bin, '');
    const was = process.env.SABLE_CLAUDE_BIN;
    process.env.SABLE_CLAUDE_BIN = bin;
    try {
      const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 1500 };
      const { app, events } = makeApp(home, [fakeClaude(state), (ctx) => new DemoProvider(ctx, { speed: 0 })]);
      const t = performance.now();
      const hello = await app.call('app.hello', {});
      expect(performance.now() - t).toBeLessThan(700);
      const claude = hello.providers.find((p) => p.id === 'claude')!;
      // Installed, sign-in not known yet: neither in nor out.
      expect(claude.installed).toBe(true);
      expect(claude.auth).toEqual({ loggedIn: false, checking: true });
      expect(claude.accounts?.[0].auth.checking).toBe(true);
      // An agent that answers at once (the Demo) is taken as it is.
      const demo = hello.providers.find((p) => p.id === 'demo')!;
      expect(demo.auth.checking).toBeUndefined();
      expect(demo.auth.loggedIn).toBe(true);
      // Asked once; the answer arrives as an event and is kept for the next start.
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'provider.updated' && e.provider.id === 'claude'); i++) await wait(50);
      const upd = events.find((e) => e.type === 'provider.updated' && e.provider.id === 'claude');
      expect(upd && upd.type === 'provider.updated' && upd.provider.auth).toEqual({ loggedIn: true, email: 'a@example.com' });
      expect(state.infoCalls).toBe(1);
      expect(app.cache.get<ProviderInfo>('info:claude')?.auth.loggedIn).toBe(true);
    } finally {
      if (was === undefined) delete process.env.SABLE_CLAUDE_BIN;
      else process.env.SABLE_CLAUDE_BIN = was;
    }
  });

  it('a phone\'s hello never says "not known yet": it waits for the agent\'s own answer', async () => {
    const home = tmp();
    const bin = path.join(home, 'claude.exe');
    writeFileSync(bin, '');
    const was = process.env.SABLE_CLAUDE_BIN;
    process.env.SABLE_CLAUDE_BIN = bin;
    try {
      const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 400 };
      const { app } = makeApp(home, [fakeClaude(state), (ctx) => new DemoProvider(ctx, { speed: 0 })]);
      // The window's hello, a moment before: answered at once, the sign-in not known.
      const first = await app.call('app.hello', {});
      expect(first.providers.find((p) => p.id === 'claude')!.auth.checking).toBe(true);
      // A phone reads a sign-in as in or out and keeps what it read (`settled`): its hello is the answer.
      const hello = await app.call('app.hello', {}, { settled: true });
      const claude = hello.providers.find((p) => p.id === 'claude')!;
      expect(claude.auth).toEqual({ loggedIn: true, email: 'a@example.com' });
      expect(claude.accounts?.every((a) => !a.auth.checking)).toBe(true);
      // One question to the agent for both.
      expect(state.infoCalls).toBe(1);
      // Once it is known, nothing waits.
      const t = performance.now();
      const again = await app.call('app.hello', {}, { settled: true });
      expect(performance.now() - t).toBeLessThan(300);
      expect(again.providers.find((p) => p.id === 'claude')!.auth.loggedIn).toBe(true);
    } finally {
      if (was === undefined) delete process.env.SABLE_CLAUDE_BIN;
      else process.env.SABLE_CLAUDE_BIN = was;
    }
  });

  it('a phone\'s hello is bounded: an agent that does not answer is told as it is', async () => {
    const home = tmp();
    const bin = path.join(home, 'claude.exe');
    writeFileSync(bin, '');
    const was = process.env.SABLE_CLAUDE_BIN;
    process.env.SABLE_CLAUDE_BIN = bin;
    try {
      const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 1500 };
      const app = new App({ home, providers: [fakeClaude(state)], quiet: true, refreshDelays: { info: 20, caps: 20, settledInfo: 120 } });
      apps.push(app);
      const t = performance.now();
      const hello = await app.call('app.hello', {}, { settled: true });
      expect(performance.now() - t).toBeLessThan(1200);
      expect(hello.providers[0].auth.checking).toBe(true);
    } finally {
      if (was === undefined) delete process.env.SABLE_CLAUDE_BIN;
      else process.env.SABLE_CLAUDE_BIN = was;
    }
  });

  it('looks for a CLI without holding the thread, and says "not known" when a drive does not answer', async () => {
    const env = { PATH: ['C:\\slow', 'C:\\tools'].join(';') };
    const never = new Promise<boolean>(() => {});
    // Found: at once, whatever the other entries do.
    expect(await cliPresentSoon('claude', 500, { env, platform: 'win32', exists: (f) => (f === 'C:\\tools\\claude.cmd' ? Promise.resolve(true) : f.startsWith('C:\\slow') ? never : Promise.resolve(false)) })).toBe(true);
    // Nowhere: known as soon as every entry answered.
    expect(await cliPresentSoon('claude', 500, { env, platform: 'win32', exists: () => Promise.resolve(false) })).toBe(false);
    // A drive that does not answer: not known, within the bound (never a wait for it).
    const t = performance.now();
    expect(await cliPresentSoon('claude', 60, { env, platform: 'win32', exists: (f) => (f.startsWith('C:\\slow') ? never : Promise.resolve(false)) })).toBeUndefined();
    expect(performance.now() - t).toBeLessThan(400);
    // Its override variable counts first; an agent without a CLI of its own is always there.
    expect(await cliPresentSoon('codex', 500, { env: { PATH: '', SABLE_CODEX_BIN: 'D:\\x\\codex.exe' }, platform: 'win32', exists: (f) => Promise.resolve(f === 'D:\\x\\codex.exe') })).toBe(true);
    expect(await cliPresentSoon('codex', 500, { env: { PATH: '' }, platform: 'win32', exists: () => Promise.resolve(true) })).toBe(false);
    expect(await cliPresentSoon('demo', 500)).toBe(true);
  });

  it('decides nothing by an agent\'s sign-in or limits before its first word is in', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync('server/app.ts', 'utf8').replace(/\r\n/g, '\n');
    // Limits (where a chat starts or moves), the race's contenders, the agents a new session may hand work to.
    const limits = app.slice(app.indexOf('private async knownLimits('), app.indexOf('private async knownLimits(') + 600);
    expect(limits.indexOf('await this.firstWord(provider);')).toBeGreaterThan(-1);
    expect(limits.indexOf('await this.firstWord(provider);')).toBeLessThan(limits.indexOf("this.call('usage.limits'"));
    const race = app.slice(app.indexOf('private async raceContenders('), app.indexOf('private async raceContenders(') + 500);
    expect(race.indexOf('await this.firstWord();')).toBeLessThan(race.indexOf('this.otherAgents()'));
    expect(race.indexOf('await this.firstWord();')).toBeGreaterThan(-1);
    const create = app.slice(app.indexOf('private async createSession('), app.indexOf('private async createSession(') + 900);
    expect(create).toContain('await this.firstWord(undefined, FIRST_WORD_WAIT_MS);');
    // A phone's hello waits past every CLI's own limit and inside the phone's own 30 s.
    expect(app).toContain('const SETTLED_INFO_WAIT_MS = 24_000;');
  });

  it('a new chat in the first second of a first start waits for the agents\' first word, within a bound', async () => {
    const home = tmp();
    const bin = path.join(home, 'claude.exe');
    writeFileSync(bin, '');
    const was = process.env.SABLE_CLAUDE_BIN;
    process.env.SABLE_CLAUDE_BIN = bin;
    try {
      const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 300 };
      const { app, events } = makeApp(home, [fakeClaude(state), (ctx) => new DemoProvider(ctx, { speed: 0 })]);
      const hello = await app.call('app.hello', {});
      expect(hello.providers.find((p) => p.id === 'claude')!.auth.checking).toBe(true);
      // A Demo chat started right away: by the time it exists, Claude Code's answer is in and cached.
      const snap = await app.call('session.create', { provider: 'demo', cwd: home });
      expect(snap.session.provider).toBe('demo');
      expect(app.cache.get<ProviderInfo>('info:claude')?.auth.loggedIn).toBe(true);
      expect(events.some((e) => e.type === 'provider.updated' && e.provider.id === 'claude')).toBe(true);
    } finally {
      if (was === undefined) delete process.env.SABLE_CLAUDE_BIN;
      else process.env.SABLE_CLAUDE_BIN = was;
    }
  });

  it('a first start without the CLI: not installed at once, and no sign-in to wait for', async () => {
    const home = tmp();
    // (process.env is case-blind on Windows: PATH and Path are one variable there.)
    const was = { bin: process.env.SABLE_CLAUDE_BIN, path: process.env.PATH };
    delete process.env.SABLE_CLAUDE_BIN;
    process.env.PATH = home;
    try {
      const state = { infoCalls: 0, capsCalls: 0, models: ['opus'], delay: 1500 };
      const { app } = makeApp(home, [fakeClaude(state)]);
      const hello = await app.call('app.hello', {});
      expect(hello.providers[0].installed).toBe(false);
      expect(hello.providers[0].auth.checking).toBeUndefined();
    } finally {
      if (was.bin !== undefined) process.env.SABLE_CLAUDE_BIN = was.bin;
      process.env.PATH = was.path;
    }
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
