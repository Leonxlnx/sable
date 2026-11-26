import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT, type AccountInfo, type BridgeEvent, type LimitsReport, type ProviderId, type RateLimit, type SessionMeta } from '@shared/protocol';
import { App } from '../server/app';
import { authGate } from '../server/core/auth-gate';
import { heldForLimits } from '../server/core/limit-refresh';
import { SessionRuntime } from '../server/core/runtime';
import { DemoProvider } from '../server/providers/demo';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { Provider, ProviderContext } from '../server/providers/types';

const minute = 60_000;
let app: App;
let dir: string;
let dispose: (() => Promise<void>) | undefined;
function start(make: (ctx: ProviderContext) => Provider) {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  dir = mkdtempSync(path.join(process.env.TEMP!, 'limits1-'));
  app = new App({ home: dir, userHome: dir, quiet: true, providers: [make] });
  dispose = () => app.dispose();
  const events: BridgeEvent[] = [];
  app.subscribe(e => events.push(e));
  return events;
}
afterEach(async () => {
  vi.useRealTimers();
  try { await dispose?.(); }
  finally {
    dispose = undefined;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    dir = '';
  }
});

const rows = (percent: number): RateLimit[] => [{ id: 'model_Fable', label: 'Weekly Fable', percent, resetsAt: Date.now() + 3 * 24 * 60 * minute }];
function chat(provider: ProviderId, accountId?: string) {
  const meta: SessionMeta = { id: 'chat', provider, accountId, cwd: dir, model: 'Fable', title: 'Chat', titleSource: 'auto', mode: 'default',
    status: 'idle', createdAt: Date.now(), updatedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  app.sessions.set(rt.id, rt);
  return rt;
}

/** The usage book and the sign-ins survived a restart. Only the fake agent knows the new reading. */
function heldDemo() {
  const reads = vi.fn(async (_id: string, _force?: boolean | 'fresh') => rows(0));
  const events = start(ctx => {
    const p = new DemoProvider(ctx, { speed: 0 });
    return Object.assign(p, { id: 'claude' as const, limits: async (force?: boolean | 'fresh') => {
      const limits = await reads(ctx.account?.id ?? DEFAULT_ACCOUNT, force);
      ctx.emit({ type: 'limits.updated', provider: 'claude', limits, meta: { planLimits: true } });
      return limits;
    } });
  });
  const accounts = ['default', 'studio', 'out', 'key', 'unmetered', 'room'].map((id): AccountInfo => ({
    provider: 'claude', id, label: id, isDefault: id === DEFAULT_ACCOUNT, auth: { loggedIn: id !== 'out', method: id === 'key' ? 'api_key' : 'oauth' },
  }));
  app.store.state.accounts.push(...accounts.map(a => ({ ...a, createdAt: Date.now() - 24 * 60 * minute })));
  app.cache.set('info:claude', { id: 'claude', installed: true, auth: accounts[0].auth, accounts });
  app.register('usage.limits', () => accounts.map((a): LimitsReport => ({ provider: 'claude', accountId: a.id, limits: rows(a.id === 'room' ? 0 : 100),
    planLimits: a.id !== 'unmetered', readAt: Date.now() - 20 * 60 * minute, history: {}, pace: {} })));
  return { reads, events };
}

it('the bridge rechecks dormant full accounts serially, stops at room and returns a waiting chat before the old reset', async () => {
  const { reads, events } = heldDemo();
  let finish!: (limits: RateLimit[]) => void;
  reads.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rt = chat('claude', 'studio');
  rt.update({ movedFrom: DEFAULT_ACCOUNT, returnAt: Date.now() + 3 * 24 * 60 * minute, returnModels: ['Fable'] });
  app.store.state.settings.notifyLimitReset = true;
  await vi.advanceTimersByTimeAsync(30 * minute + 10_000);
  expect(reads.mock.calls).toEqual([[DEFAULT_ACCOUNT, true]]);
  finish(rows(0));
  await vi.advanceTimersByTimeAsync(3999);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(rt.meta.accountId ?? DEFAULT_ACCOUNT).toBe(DEFAULT_ACCOUNT);
  expect(rt.meta.movedFrom).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(reads.mock.calls).toEqual([[DEFAULT_ACCOUNT, true], ['studio', true]]);
  expect(events.filter(e => e.type === 'limit.reset')).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(62 * minute);
  expect(reads).toHaveBeenCalledTimes(2);
});

it('a held read waits out an active turn, wake and update, and the timer is cleared at quit', async () => {
  const { reads } = heldDemo();
  const rt = chat('claude');
  rt.beginTurn();
  await vi.advanceTimersByTimeAsync(30 * minute);
  expect(reads).not.toHaveBeenCalled();
  const paused = vi.spyOn(authGate, 'readsPaused').mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(4000);
  expect(reads).not.toHaveBeenCalled();
  rt.endTurn();
  paused.mockRestore();
  app.updates = { installing: true, state: { status: 'ready', current: '0.2.38' }, dispose() {} };
  await vi.advanceTimersByTimeAsync(31 * minute);
  expect(reads).not.toHaveBeenCalled();
  app.updates = undefined;
  await vi.advanceTimersByTimeAsync(29 * minute);
  expect(reads.mock.calls[0]).toEqual([DEFAULT_ACCOUNT, true]);
  const beforeQuit = reads.mock.calls.length;
  await app.dispose();
  dispose = undefined;
  await vi.advanceTimersByTimeAsync(62 * minute);
  expect(reads).toHaveBeenCalledTimes(beforeQuit);
});

it('a window still full gets another check next half hour, including after a refused read', async () => {
  const { reads, events } = heldDemo();
  reads.mockRejectedValueOnce(new Error('probe failed')).mockResolvedValueOnce(rows(0)).mockResolvedValueOnce(rows(100));
  await vi.advanceTimersByTimeAsync(92 * minute);
  expect(reads.mock.calls.map(([account]) => account)).toEqual([DEFAULT_ACCOUNT, 'studio', DEFAULT_ACCOUNT, DEFAULT_ACCOUNT]);
  expect(events.filter(e => e.type === 'toast')).toEqual([]);
  await vi.advanceTimersByTimeAsync(31 * minute);
  expect(reads).toHaveBeenCalledTimes(4);
});

it('shares the use-first thresholds, account caps and model-specific weeks, excluding rolled windows', () => {
  const now = Date.now();
  const full = (id: string, percent: number) => ({ id, label: id, percent });
  expect(heldForLimits([full('five_hour', 97)], undefined, now)).toBe(true);
  expect(heldForLimits([full('five_hour', 80)], { session: 80 }, now)).toBe(true);
  expect(heldForLimits([full('seven_day', 76)], { weekly: 80 }, now)).toBe(true);
  expect(heldForLimits([full('seven_day', 20), full('model_Fable', 96)], undefined, now)).toBe(true);
  expect(heldForLimits([full('seven_day', 95), { ...full('model_Fable', 100), resetsAt: now }], undefined, now)).toBe(false);
});

it('a Claude Refresh during two turns gives one toast and the last turn reads once inside the usual gap', async () => {
  const events = start(ctx => new ClaudeProvider(ctx));
  const p = app.provider('claude') as ClaudeProvider;
  const rt = chat('claude');
  const other = new SessionRuntime({ ...rt.meta, id: 'other' }, () => {}, () => {});
  app.sessions.set(other.id, other);
  vi.spyOn(p, 'caps').mockImplementation(() => new DemoProvider(p.ctx).caps());
  const usage = vi.fn(async () => ({ rate_limits: { seven_day: { utilization: 10 } } }));
  const q = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close() {} };
  const attach = async (r: SessionRuntime) => {
    const s = await p.open(r, {}) as unknown as { q: typeof q; finishTurn(error?: string, interrupted?: boolean): void };
    s.q = q;
    return s;
  };
  const a = await attach(rt), b = await attach(other);
  await app.call('provider.limits', { provider: 'claude', force: true });
  expect(usage).toHaveBeenCalledTimes(1);
  rt.beginTurn();
  other.beginTurn();
  for (let i = 0; i < 2; i++) await app.call('provider.limits', { provider: 'claude', force: true });
  expect(events.filter(e => e.type === 'toast')).toEqual([{ type: 'toast', level: 'info', text: 'Main is working. Its limits are read when the turn ends.' }]);
  a.finishTurn();
  await vi.advanceTimersByTimeAsync(50);
  expect(usage).toHaveBeenCalledTimes(1);
  b.finishTurn();
  await vi.advanceTimersByTimeAsync(1000);
  expect(usage).toHaveBeenCalledTimes(2);
  other.beginTurn();
  b.finishTurn();
  await vi.advanceTimersByTimeAsync(1000);
  expect(usage).toHaveBeenCalledTimes(2);
});

it('a Codex turn-end advances its existing timer for a deferred Refresh', async () => {
  start(ctx => new CodexProvider(ctx));
  const rt = chat('codex');
  const p = app.provider('codex') as CodexProvider;
  const wire = { request: vi.fn(async () => ({})), close: async () => {} };
  const adapter = p as unknown as { rpc: typeof wire; onNotification(method: string, params: object): void };
  adapter.rpc = wire;
  vi.spyOn(p, 'client').mockResolvedValue(wire as never);
  await app.call('provider.limits', { provider: 'codex', force: true });
  const end = () => adapter.onNotification('turn/completed', {});
  end();
  rt.beginTurn();
  await app.call('provider.limits', { provider: 'codex', force: true });
  rt.endTurn();
  end();
  await vi.advanceTimersByTimeAsync(1500);
  expect(wire.request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(wire.request).toHaveBeenCalledTimes(2);
});

it('a wake, a refused answer and a failed probe keep the last reading and share one quiet toast per minute', async () => {
  const { events } = heldDemo();
  const p = app.provider('claude', 'studio');
  const read = vi.spyOn(p, 'limits').mockResolvedValue(rows(0)); // A fallback without a fresh provider event.
  const click = () => app.call('provider.limits', { provider: 'claude', accountId: 'studio', force: true });
  const pause = vi.spyOn(authGate, 'readsPaused').mockReturnValue(true);
  expect((await click())[0].percent).toBe(100);
  expect(read).not.toHaveBeenCalled();
  pause.mockRestore();
  expect((await click())[0].percent).toBe(100);
  read.mockRejectedValue(new Error('probe failed'));
  await click();
  const toast = { type: 'toast', level: 'info', text: 'Limits for studio could not be read just now.' };
  expect(events.filter(e => e.type === 'toast')).toEqual([toast]);
  await vi.advanceTimersByTimeAsync(minute);
  expect((await click())[0].percent).toBe(100);
  expect(events.filter(e => e.type === 'toast')).toEqual([toast, toast]);
});
