/**
 * Claude's plan windows are kept until a newer read says otherwise: the per-model weekly window
 * (Fable) vanished for an account when a usage answer came without `model_scoped` (served from
 * cached data, or before the CLI's model allowlist loaded) or when a turn's rate-limit event,
 * which names only the windows of the reply's headers, replaced what was known.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BridgeEvent, type RateLimit } from '@shared/protocol';
import { ClaudeProvider, usageWindows } from '../server/providers/claude';
import { LimitsBook, mergeWindows } from '../server/services/limits';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const RESET = '2026-11-21T14:00:00Z';
const WEEK = Date.parse(RESET);

const win = (utilization: number | null, resets_at: string | null = RESET) => ({ utilization, resets_at });
const row = (id: string, label: string, percent: number, windowMins = 10_080, resetsAt = WEEK): RateLimit => ({ id, label, percent, resetsAt, windowMins });
const fable = (percent: number) => row('model_Fable', 'Weekly · Fable', percent);
const ids = (rows: RateLimit[]) => rows.map((l) => l.id);

describe('Claude usage answer', () => {
  const full = { five_hour: win(12), seven_day: win(55), seven_day_opus: null, seven_day_sonnet: null };

  it('reads every window, the per-model ones by their model', () => {
    const { rows, partial } = usageWindows({ ...full, model_scoped: [{ display_name: 'Fable', ...win(71) }] }, [], NOW);
    expect(rows.map((l) => [l.id, l.label, l.percent])).toEqual([
      ['five_hour', '5-hour limit', 12],
      ['seven_day', 'Weekly · all models', 55],
      ['model_Fable', 'Weekly · Fable', 71],
    ]);
    expect(partial).toBe(false);
  });

  it('keeps the known per-model window when the answer leaves model_scoped out', () => {
    const { rows, partial } = usageWindows(full, [fable(40)], NOW);
    expect(ids(rows)).toEqual(['five_hour', 'seven_day', 'model_Fable']);
    expect(rows[2].percent).toBe(40);
    expect(partial).toBe(true);
  });

  it('drops per-model windows when model_scoped says there are none', () => {
    const { rows, partial } = usageWindows({ ...full, model_scoped: [] }, [fable(40)], NOW);
    expect(ids(rows)).toEqual(['five_hour', 'seven_day']);
    expect(partial).toBe(false);
  });

  it('keeps a fixed window whose key is missing, and drops one the answer gives as null', () => {
    const known = [row('five_hour', '5-hour limit', 30, 300, NOW + 3_600_000), row('seven_day_opus', 'Weekly · Opus', 20)];
    const { rows, partial } = usageWindows({ seven_day: win(55), seven_day_opus: null, model_scoped: [] }, known, NOW);
    expect(ids(rows)).toEqual(['five_hour', 'seven_day']);
    expect(rows[0].percent).toBe(30);
    expect(partial).toBe(true);
  });

  it('keeps a known window whose reset passed as rolled over', () => {
    const { rows } = usageWindows(full, [{ ...fable(90), resetsAt: NOW - 1000 }], NOW);
    expect(rows.find((l) => l.id === 'model_Fable')).toMatchObject({ percent: 0, resetsAt: undefined });
  });
});

describe('Claude limits read through a live process', () => {
  const ctx = (events: BridgeEvent[]) => ({ emit: (e: BridgeEvent) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
  const answer = (rate_limits: object) => ({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ subscription_type: 'max', rate_limits_available: true, rate_limits }) });

  it('a later answer without model_scoped keeps Fable, and says the read was partial', async () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    const read = (rl: object) => (p as unknown as { readLimitsNow: (q: unknown) => Promise<RateLimit[]> }).readLimitsNow(answer(rl));
    // On the real clock: the windows reset a few days from now (a fixed date would roll over one day).
    const ahead = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await read({ five_hour: win(10, ahead), seven_day: win(50, ahead), model_scoped: [{ display_name: 'Fable', ...win(60, ahead) }] });
    const rows = await read({ five_hour: win(11, ahead), seven_day: win(51, ahead) });
    expect(rows.map((l) => [l.id, l.percent])).toEqual([
      ['five_hour', 11],
      ['seven_day', 51],
      ['model_Fable', 60],
    ]);
    const last = events.at(-1) as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(last.meta?.partial).toBe(true);
  });
});

describe('Claude rate-limit events', () => {
  const ctx = (events: BridgeEvent[]) => ({ emit: (e: BridgeEvent) => events.push(e), log: () => {}, settings: () => DEFAULT_SETTINGS });
  // On the real clock: a reset a few days from now (a fixed date would roll over one day).
  const reset = Math.floor((Date.now() + 3 * 86_400_000) / 1000);
  const event = (oi: number) => ({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: reset, unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: reset }, seven_day_overage_included: { utilization: oi, resetsAt: reset } } });

  it('reads the overage-included window as the Fable window', () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    p.onRateLimit(event(0.7));
    const up = events.at(-1) as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(up.limits.map((l) => [l.id, l.label, l.percent])).toEqual([
      ['seven_day', 'Weekly · all models', 50],
      ['model_Fable', 'Weekly · Fable', 70],
    ]);
    expect(up.meta?.partial).toBe(true);
  });

  it('updates the per-model row the usage answer named, whatever its model is called', () => {
    const events: BridgeEvent[] = [];
    const p = new ClaudeProvider(ctx(events));
    (p as unknown as { limitsCache: RateLimit[] }).limitsCache = [row('seven_day', 'Weekly · all models', 40), row('model_Fable 5', 'Weekly · Fable 5', 20)];
    p.onRateLimit(event(0.33));
    const up = events.at(-1) as Extract<BridgeEvent, { type: 'limits.updated' }>;
    expect(up.limits.map((l) => [l.id, l.label, l.percent])).toEqual([
      ['seven_day', 'Weekly · all models', 50],
      ['model_Fable 5', 'Weekly · Fable 5', 33],
    ]);
  });
});

describe('limits book: partial reads', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const book = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sable-limits-'));
    dirs.push(d);
    return new LimitsBook(path.join(d, 'limits.json'));
  };
  const five = (p: number) => row('five_hour', '5-hour limit', p, 300, NOW + 3_600_000);
  const week = (p: number) => row('seven_day', 'Weekly · all models', p);

  it('keeps the windows a partial read does not name, in their place', () => {
    const b = book();
    b.record('claude', 'u1', [five(10), week(50), fable(60)], { planLimits: true }, NOW - 60_000);
    // After a restart the first thing to arrive is a turn's event with the weekly window only.
    const r = b.record('claude', 'u1', [week(52)], { planLimits: true, partial: true }, NOW);
    expect(r.limits.map((l) => [l.id, l.percent])).toEqual([
      ['five_hour', 10],
      ['seven_day', 52],
      ['model_Fable', 60],
    ]);
    expect(r.readAt).toBe(NOW);
  });

  it('a full read replaces them', () => {
    const b = book();
    b.record('claude', 'u1', [five(10), week(50), fable(60)], { planLimits: true }, NOW - 60_000);
    expect(ids(b.record('claude', 'u1', [five(12), week(51)], { planLimits: true }, NOW).limits)).toEqual(['five_hour', 'seven_day']);
  });

  it('adds windows new to the account at the end, and lets go of retired ids', () => {
    const old = row('seven_day_overage_included', 'Weekly · Overage Included', 30);
    expect(ids(mergeWindows([five(1), old, week(2)], [fable(40)]))).toEqual(['five_hour', 'seven_day', 'model_Fable']);
  });
});
