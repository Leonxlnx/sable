/**
 * Reset credits (Codex's `account/rateLimitResetCredit/consume`): how Sable learns about them,
 * that spending one goes to the agent only through `useReset`, and the Demo account's pretend ones.
 * Every app-server here is a fake: no reset is ever spent for real.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type RateLimit } from '@shared/protocol';
import { CodexProvider } from '../server/providers/codex';
import { resetsMeta } from '../server/providers/codex-map';
import { DemoProvider } from '../server/providers/demo';
import { LimitsBook } from '../server/services/limits';
import { resetTarget, resetsText, windowPhrase } from '../src/features/usage/LimitReset';

const ctx = (events: BridgeEvent[], extra: object = {}) => ({ emit: (e: BridgeEvent) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS, ...extra });

const snapshot = (used: number) => ({
  limitId: 'codex',
  limitName: null,
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 2_000_000_000 },
  secondary: { usedPercent: used, windowDurationMins: 10_080, resetsAt: 2_000_500_000 },
  credits: null,
});

/** A fake app-server that knows two resets and records every request it gets. */
function fakeCodex(events: BridgeEvent[]) {
  const calls: { method: string; params: unknown }[] = [];
  let available = 2;
  let used = 100;
  const rpc = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'account/rateLimits/read')
        return { rateLimits: snapshot(used), rateLimitsByLimitId: { codex: snapshot(used) }, rateLimitResetCredits: { availableCount: available, credits: null } };
      if (method === 'account/rateLimitResetCredit/consume') {
        if (!available) return { outcome: 'noCredit' };
        available--;
        used = 0;
        return { outcome: 'reset' };
      }
      return {};
    },
  };
  const p = new CodexProvider(ctx(events));
  (p as unknown as { client: () => Promise<unknown> }).client = async () => rpc;
  return { p, calls };
}

describe('Codex resets', () => {
  it('reads the count from the limits read and names the windows a reset restores', async () => {
    const events: BridgeEvent[] = [];
    const { p, calls } = fakeCodex(events);
    await p.limits();
    const e = events.find((x) => x.type === 'limits.updated');
    expect(e && e.type === 'limits.updated' && e.meta?.resets).toEqual({ available: 2, windows: ['codex:primary', 'codex:secondary'] });
    // A plain read never spends one.
    expect(calls.map((c) => c.method)).toEqual(['account/rateLimits/read']);
  });

  it('spends one only through useReset, with the attempt key, then reads the new state', async () => {
    const events: BridgeEvent[] = [];
    const { p, calls } = fakeCodex(events);
    expect(await p.useReset('k-1')).toBe('reset');
    expect(calls[0]).toEqual({ method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey: 'k-1' } });
    expect(calls[1].method).toBe('account/rateLimits/read');
    const last = events.filter((x) => x.type === 'limits.updated').pop();
    expect(last && last.type === 'limits.updated' && last.limits.every((l) => l.percent === 0)).toBe(true);
    expect(last && last.type === 'limits.updated' && last.meta?.resets?.available).toBe(1);
  });

  it('maps the summary: none, a string count, an older app-server without it', () => {
    const limits: RateLimit[] = [{ id: 'codex:primary', label: '5-hour limit', percent: 1 }];
    expect(resetsMeta(undefined, limits)).toBeUndefined();
    expect(resetsMeta(null, limits)).toBeUndefined();
    expect(resetsMeta({ availableCount: 0, credits: [] }, limits)).toEqual({ available: 0, windows: ['codex:primary'] });
    expect(resetsMeta({ availableCount: '3', credits: null }, limits)?.available).toBe(3);
  });

  it('the limits book keeps the count, drops it at zero', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-resets-'));
    try {
      const book = new LimitsBook(path.join(dir, 'limits.json'));
      const l: RateLimit[] = [{ id: 'codex:secondary', label: 'Weekly limit', percent: 100, windowMins: 10_080 }];
      expect(book.record('codex', 'default', l, { resets: { available: 2, windows: ['codex:secondary'] } }).resets?.available).toBe(2);
      // A read that says nothing about resets (a live update) keeps what was known.
      expect(book.record('codex', 'default', l, {}).resets?.available).toBe(2);
      expect(book.record('codex', 'default', l, { resets: { available: 0, windows: [] } }).resets).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Demo resets', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const account = (limits: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sable-demo-reset-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'demo-auth.json'), JSON.stringify({ email: 'grace@hopper.dev', plan: 'Pro', limits }));
    const events: BridgeEvent[] = [];
    const p = new DemoProvider(ctx(events, { account: { id: 'a1', dir } }) as never, { speed: 0 });
    return { p, events };
  };
  const lastMeta = (events: BridgeEvent[]) => {
    const e = events.filter((x) => x.type === 'limits.updated').pop();
    return e && e.type === 'limits.updated' ? e : undefined;
  };

  it('an account at its cap has two resets; one empties its windows', async () => {
    const { p, events } = account('cap');
    await p.limits();
    expect(lastMeta(events)?.meta?.resets?.available).toBe(2);
    expect(lastMeta(events)?.limits.some((l) => l.percent >= 100)).toBe(true);
    expect(await p.useReset('k')).toBe('reset');
    expect(lastMeta(events)?.limits.every((l) => l.percent === 0)).toBe(true);
    expect(lastMeta(events)?.meta?.resets?.available).toBe(1);
    expect(await p.useReset('k2')).toBe('reset');
    expect(await p.useReset('k3')).toBe('noCredit');
  });

  it('a calm account has none, and the default account never does', async () => {
    const { p, events } = account('calm');
    await p.limits();
    expect(lastMeta(events)?.meta?.resets).toBeUndefined();
    expect(await p.useReset('k')).toBe('noCredit');
    const ev: BridgeEvent[] = [];
    await new DemoProvider(ctx(ev) as never, { speed: 0 }).limits();
    expect(lastMeta(ev)?.meta?.resets).toBeUndefined();
  });
});

describe('Reset wording', () => {
  it('names the count and the window', () => {
    expect(resetsText(1)).toBe('1 reset');
    expect(resetsText(2)).toBe('2 resets');
    const five: RateLimit = { id: 'a', label: '5-hour limit', percent: 100, windowMins: 300 };
    const week: RateLimit = { id: 'b', label: 'Weekly · all models', percent: 90, windowMins: 10_080 };
    expect(windowPhrase(week)).toBe('the weekly limit');
    expect(windowPhrase(five)).toBe('the 5-hour limit');
    // A model's own window says whose: with only its week nearly used, "the weekly limit" would read as the plan's.
    expect(windowPhrase({ id: 'model_Fable', label: 'Weekly · Fable', percent: 99, windowMins: 10_080 })).toBe('the weekly Fable limit');
    expect(windowPhrase({ id: 'seven_day_opus', label: 'Weekly · Opus', percent: 99, windowMins: 10_080 })).toBe('the weekly Opus limit');
    expect(windowPhrase({ id: 'five_hour_opus', label: '5-hour limit · Opus', percent: 99, windowMins: 300 })).toBe('the 5-hour Opus limit');
    expect(windowPhrase({ id: 'spark:primary', label: 'GPT-5.3-Codex-Spark · 5-hour limit', percent: 99, windowMins: 300 })).toBe('the 5-hour GPT-5.3-Codex-Spark limit');
    expect(windowPhrase({ id: 'codex:secondary', label: 'Weekly limit', percent: 99, windowMins: 10_080 })).toBe('the weekly limit');
    expect(windowPhrase(undefined)).toBe('the limits');
    expect(resetTarget([five, week], ['a', 'b'])?.id).toBe('b');
    expect(resetTarget([five, week], ['a'])?.id).toBe('a');
  });
});
