/**
 * Choosing the next account after review wave 7 (scratch/reviews/out-wave7.md):
 * - 3: an account signed in with an API key now is never chosen, whatever an older report says;
 *   a changed sign-in forgets the old reading.
 * - 9: a limits event that names some windows only lays over what is known, by window.
 * - 10: the chat's effective model ("default" is the model it names) decides which windows count, and
 *   the accounts that already refused the message are left out before ranking.
 * - 11: no fallback to an account the ranking holds or counts spent.
 * - 12: an account whose known models leave out the chat's own is not taken.
 * - 13: a Codex model's own window holds back that model only (shared with the desktop).
 * - 14: a spent account is back when the window that left too little resets.
 * - 15: with the person's own order chosen, a handover follows it.
 * Demo accounts with fixed limits in temporary folders.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type Capabilities, type RateLimit } from '@shared/protocol';
import { windowForModel, windowModel } from '@shared/limit-windows';
import { rankAccount } from '@shared/use-first';
import { App } from '../server/app';
import { atCap, pickNextAccount, type NextCandidate } from '../server/accounts/folders';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext } from '../server/providers/types';
import { registerUsage } from '../server/services/usage';
import { appliesTo } from '../src/features/usage/scope';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

const NOW = Date.parse('2026-11-21T18:00:00Z');
const H = 3_600_000;
const week = (percent: number, inHours: number, now = NOW): RateLimit => ({ id: 'seven_day', label: 'Weekly · all models', percent, resetsAt: now + inHours * H, windowMins: 10_080 });
const five = (percent: number, inHours = 3, now = NOW): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: now + inHours * H, windowMins: 300 });
const opus = (percent: number, inHours: number, now = NOW): RateLimit => ({ id: 'seven_day_opus', label: 'Weekly · Opus', percent, resetsAt: now + inHours * H, windowMins: 10_080 });
const acct = (id: string, limits: RateLimit[], over: Partial<NextCandidate> = {}): NextCandidate => ({ id, signedIn: true, limits, ...over });

// ── pure ──

describe('no fallback to an account held or spent (11)', () => {
  it('a lone alternative at 98% of its 5-hour window, or with 3% of its week, is not taken', () => {
    const cur = acct('cur', [week(100, 10)]);
    expect(pickNextAccount('cur', [cur, acct('b', [five(98), week(20, 50)])], NOW, { useFirst: true })).toBeUndefined();
    expect(pickNextAccount('cur', [cur, acct('b', [five(10), week(97, 50)])], NOW, { useFirst: true })).toBeUndefined();
  });

  it('one whose week was never read may still be, unless its 5-hour window is near full', () => {
    const cur = acct('cur', [week(100, 10)]);
    expect(pickNextAccount('cur', [cur, acct('b', [five(40)])], NOW, { useFirst: true })).toBe('b');
    expect(pickNextAccount('cur', [cur, acct('b', [])], NOW, { useFirst: true })).toBe('b');
    expect(pickNextAccount('cur', [cur, acct('b', [five(98)])], NOW, { useFirst: true })).toBeUndefined();
  });

  it('an account ranked now still wins over one not read', () => {
    const cur = acct('cur', [week(100, 10)]);
    expect(pickNextAccount('cur', [cur, acct('u', []), acct('b', [five(10), week(50, 40)])], NOW, { useFirst: true })).toBe('b');
  });
});

describe('the person\'s order (15)', () => {
  it('in manual order a handover takes the first in the saved list, not the one with most room', () => {
    const list = [acct('a', [week(100, 10)]), acct('b', [five(60), week(70, 30)]), acct('c', [five(0), week(0, 100)])];
    expect(pickNextAccount('a', list, NOW, { manual: true })).toBe('b');
    expect(pickNextAccount('a', list, NOW, {})).toBe('c');
  });
});

describe('accounts that refused already (10)', () => {
  it('are left out before ranking, so a third usable one is found', () => {
    const list = [acct('a', [week(30, 20)]), acct('b', [week(30, 10)]), acct('c', [week(30, 90)])];
    expect(pickNextAccount('a', list, NOW, { useFirst: true })).toBe('b');
    expect(pickNextAccount('a', list, NOW, { useFirst: true, except: ['b'] })).toBe('c');
  });
});

describe("a Codex model's own window (13)", () => {
  const scoped: RateLimit = { id: 'gpt-5.5:primary', label: 'GPT-5.5 · 5-hour limit', percent: 100, resetsAt: NOW + 2 * H, windowMins: 300 };
  const spark: RateLimit = { id: 'codex_bengalfox:primary', label: 'GPT-5.3-Codex-Spark · 5-hour limit', percent: 100, resetsAt: NOW + 2 * H, windowMins: 300 };
  it('belongs to its model, by its name or its id', () => {
    expect(windowModel(scoped)).toBe('gpt-5.5');
    expect(windowModel(spark)).toBe('gpt-5.3-codex-spark');
    expect(windowModel({ id: 'codex:primary', label: '5-hour limit', percent: 0 })).toBeUndefined();
    expect(windowForModel(spark, 'gpt-5.3-codex-spark')).toBe(true);
    expect(windowForModel(spark, 'gpt-5.5')).toBe(false);
    // The desktop asks the same rule.
    expect(appliesTo(spark, { id: 'gpt-5.5' })).toBe(false);
    expect(appliesTo(spark, { id: 'x', name: 'GPT-5.3-Codex-Spark' })).toBe(true);
  });

  it("a full one does not keep another model's turn off the account", () => {
    const shared: RateLimit[] = [
      { id: 'codex:primary', label: '5-hour limit', percent: 20, resetsAt: NOW + 2 * H, windowMins: 300 },
      { id: 'codex:secondary', label: 'Weekly limit', percent: 30, resetsAt: NOW + 50 * H, windowMins: 10_080 },
    ];
    expect(atCap([...shared, spark], NOW, 'gpt-5.5')).toBe(false);
    expect(atCap([...shared, spark], NOW, 'gpt-5.3-codex-spark')).toBe(true);
    expect(pickNextAccount('cur', [acct('cur', []), acct('b', [...shared, spark])], NOW, { useFirst: true, model: 'gpt-5.5' })).toBe('b');
    expect(pickNextAccount('cur', [acct('cur', []), acct('b', [...shared, spark])], NOW, { useFirst: true, model: 'gpt-5.3-codex-spark' })).toBeUndefined();
  });
});

describe('when a spent account is back (14)', () => {
  it("the model's own week that left too little decides, not the shared week's end", () => {
    const r = rankAccount({ id: 'a', signedIn: true, limits: [week(20, 100), opus(97, 4)] }, NOW, 'claude-opus-5-5');
    expect(r).toMatchObject({ state: 'spent', left: 3, expiresAt: NOW + 4 * H });
    // Spent in the shared week: its end.
    expect(rankAccount({ id: 'a', signedIn: true, limits: [week(98, 30), opus(10, 4)] }, NOW, 'claude-opus-5-5')).toMatchObject({ state: 'spent', expiresAt: NOW + 30 * H });
    // Both too low: back when the later of them resets.
    expect(rankAccount({ id: 'a', signedIn: true, limits: [week(98, 30), opus(97, 40)] }, NOW, 'claude-opus-5-5')).toMatchObject({ state: 'spent', expiresAt: NOW + 40 * H });
  });
});

// ── the bridge ──

class FixedDemo extends DemoProvider {
  static fixed = new Map<string, RateLimit[]>();
  constructor(private c: ProviderContext) {
    super(c, { speed: 0 });
  }
  async limits(): Promise<RateLimit[]> {
    const own = FixedDemo.fixed.get(this.c.account?.id ?? DEFAULT_ACCOUNT);
    if (!own) return super.limits();
    this.c.emit({ type: 'limits.updated', provider: 'demo', limits: own, meta: { planLimits: true } });
    return own;
  }
}

function startApp() {
  FixedDemo.fixed.clear();
  const home = temp('sable-acc-w7-');
  const app = new App({ home, providers: [(ctx) => new FixedDemo(ctx)], quiet: true, userHome: temp('sable-acc-w7-user-') });
  registerUsage(app, { sources: () => [] });
  apps.push(app);
  return { app, home };
}

async function signIn(app: App, label: string, limits: RateLimit[], auth: { plan?: string; method?: string } = {}, existing?: { id: string; dir?: string }) {
  const account = existing ?? (await app.call('account.add', { provider: 'demo', label })).account;
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: auth.plan ?? 'Max', ...(auth.method ? { method: auth.method } : {}), limits: 'calm' }));
  FixedDemo.fixed.set(account.id, limits);
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

const internals = (app: App) =>
  app as unknown as {
    fromProvider(accountId: string, e: unknown): void;
    knownLimits(provider: string): Promise<Map<string, { limits?: RateLimit[]; planLimits?: boolean }>>;
    cache: { set(key: string, v: unknown): boolean };
  };

describe('an API key in place of a plan (3)', () => {
  it('is never chosen, whatever the old report says, and its old reading is forgotten', async () => {
    const { app } = startApp();
    const now = Date.now();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [five(10, 3, now), week(100, 20, now)]);
    await app.call('provider.limits', { provider: 'demo' });
    // A plan with an early reset: the first to use.
    const key = await signIn(app, 'Key', [five(0, 3, now), week(10, 5, now)]);
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT)).toBe(key.id);
    // The folder now signs in with an API key (and the agent still says plan limits).
    await signIn(app, 'Key', [five(0, 3, now), week(10, 5, now)], { plan: 'API key', method: 'apiKey' }, key);
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT)).toBeUndefined();
  });

  it('a changed sign-in forgets the old limits', async () => {
    const { app } = startApp();
    const now = Date.now();
    const a = await signIn(app, 'Studio', [five(100, 3, now), week(40, 20, now)]);
    expect((await internals(app).knownLimits('demo')).get(a.id)?.limits).toHaveLength(2);
    // Someone else signs in in that folder; no new read yet.
    FixedDemo.fixed.set(a.id, []);
    writeFileSync(path.join(a.dir!, 'demo-auth.json'), JSON.stringify({ email: 'someone@else.dev', plan: 'Max', limits: 'calm' }));
    await app.call('auth.refresh', { provider: 'demo', accountId: a.id });
    await app.nextAccount('demo', DEFAULT_ACCOUNT);
    const reports = await app.call('usage.limits', {});
    expect(reports.find((r) => r.accountId === a.id)?.limits ?? []).toHaveLength(0);
  });
});

describe('a partial limits event (9)', () => {
  it('lays over the known windows: a full 5-hour window still keeps the account off', async () => {
    const { app } = startApp();
    const now = Date.now();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [five(10, 3, now), week(100, 20, now)]);
    await app.call('provider.limits', { provider: 'demo' });
    const b = await signIn(app, 'Busy', [five(100, 2, now), week(30, 30, now)]);
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT)).toBeUndefined();
    // The agent's turn event names only the week.
    internals(app).fromProvider(b.id, { type: 'limits.updated', provider: 'demo', limits: [week(31, 30, now)], meta: { partial: true } });
    const known = (await internals(app).knownLimits('demo')).get(b.id)?.limits ?? [];
    expect(known.map((l) => `${l.id}:${l.percent}`).sort()).toEqual(['five_hour:100', 'seven_day:31']);
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT)).toBeUndefined();
  });
});

describe("the chat's model at a handover (10, 12)", () => {
  it('"default" counts as the model it names: a full Opus week keeps an account off an Opus chat', async () => {
    const { app, home } = startApp();
    const now = Date.now();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [five(10, 3, now), week(100, 20, now)]);
    await app.call('provider.limits', { provider: 'demo' });
    const early = await signIn(app, 'Early', [five(0, 3, now), week(20, 5, now), opus(100, 5, now)]);
    const later = await signIn(app, 'Later', [five(0, 3, now), week(20, 60, now), opus(10, 60, now)]);
    const snap = await app.call('session.create', { provider: 'demo', cwd: home, model: 'default' });
    const rt = app.runtime(snap.session.id);
    rt.setCaps({ ...(rt.caps as Capabilities), models: [{ id: 'default', name: 'Default', description: 'Opus 5.5 · Most capable for complex work', isDefault: true }, { id: 'sonnet', name: 'Sonnet' }] });
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT, { rt })).toBe(later.id);
    // Without the alias read, the early one would have been chosen.
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT, { model: 'sonnet' })).toBe(early.id);
  });

  it("an account whose known models leave out the chat's own is not taken", async () => {
    const { app, home } = startApp();
    const now = Date.now();
    FixedDemo.fixed.set(DEFAULT_ACCOUNT, [five(10, 3, now), week(100, 20, now)]);
    await app.call('provider.limits', { provider: 'demo' });
    const early = await signIn(app, 'Early', [five(0, 3, now), week(20, 5, now)]);
    const later = await signIn(app, 'Later', [five(0, 3, now), week(20, 60, now)]);
    const snap = await app.call('session.create', { provider: 'demo', cwd: home, model: 'special-model' });
    const rt = app.runtime(snap.session.id);
    rt.setCaps({ ...(rt.caps as Capabilities), models: [{ id: 'special-model', name: 'Special', isDefault: true }] });
    internals(app).cache.set(`caps:demo:${early.id}:`, { ...(rt.caps as Capabilities), models: [{ id: 'other-model', name: 'Other', isDefault: true }] });
    internals(app).cache.set(`caps:demo:${later.id}:`, { ...(rt.caps as Capabilities), models: [{ id: 'special-model', name: 'Special', isDefault: true }] });
    expect(await app.nextAccount('demo', DEFAULT_ACCOUNT, { rt })).toBe(later.id);
  });
});
