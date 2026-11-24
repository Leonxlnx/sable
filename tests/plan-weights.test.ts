import { describe, expect, it } from 'vitest';
import type { AuthState, ProviderId, RateLimit } from '@shared/protocol';
import { planSize, poolTotals, poolUsedPercent, poolWeeksText, poolWindow, units, type PoolInput } from '../src/features/usage/plans';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const WEEK_RESET = NOW + 3 * 86_400_000;
const claude = (plan: string, planId?: string): AuthState => ({ loggedIn: true, method: 'claude.ai', plan, planId });
const codex = (plan: string, planId?: string): AuthState => ({ loggedIn: true, method: 'chatgpt', plan, planId });
const weight = (provider: ProviderId, auth: AuthState) => planSize(provider, auth)?.weight;

const five = (percent: number, id = 'five_hour'): RateLimit => ({ id, label: '5-hour limit', percent, resetsAt: NOW + 3_600_000, windowMins: 300 });
const week = (percent: number, id = 'seven_day'): RateLimit => ({ id, label: 'Weekly · all models', percent, resetsAt: WEEK_RESET, windowMins: 10_080 });
const fable = (percent: number): RateLimit => ({ id: 'model_Fable', label: 'Weekly · Fable', percent, resetsAt: WEEK_RESET, windowMins: 10_080 });
const acct = (provider: ProviderId, auth: AuthState, limits: RateLimit[]): PoolInput => ({ provider, auth, limits, usable: true });

describe('plan sizes', () => {
  it('weighs Claude plans in units of Pro', () => {
    // An Ultra account reports subscription "max" and is named Ultra by the CLI.
    expect(weight('claude', claude('Ultra', 'max'))).toBe(10);
    expect(weight('claude', claude('Team', 'team'))).toBe(6.25);
    expect(weight('claude', claude('Pro', 'pro'))).toBe(1);
    expect(weight('claude', claude('Max', 'max'))).toBe(5);
    expect(weight('claude', claude('Max 20x'))).toBe(20);
    expect(weight('claude', claude('Max', 'max_20x'))).toBe(20);
    expect(weight('claude', claude('Max', 'default_claude_max_5x'))).toBe(5);
    expect(weight('claude', claude('Team Standard', 'team'))).toBe(1.25);
  });

  it('knows nothing of plans without plan limits or of unknown size', () => {
    expect(planSize('claude', claude('Enterprise', 'enterprise'))).toBeUndefined();
    expect(planSize('claude', claude('Free', 'free'))).toBeUndefined();
    expect(planSize('claude', { loggedIn: true, method: 'apiKey' })).toBeUndefined();
    expect(planSize('claude', { loggedIn: false, plan: 'Ultra' })).toBeUndefined();
    expect(planSize('codex', codex('Plus', 'plus'))).toBeUndefined();
  });

  it('reads Codex Pro, and the Demo like Claude', () => {
    expect(planSize('codex', codex('Pro', 'pro'))).toEqual({ weight: 1, name: 'Pro' });
    expect(planSize('codex', codex('Pro Lite', 'prolite'))).toBeUndefined();
    expect(weight('demo', { loggedIn: true, method: 'local', plan: 'Max' })).toBe(5);
  });
});

describe('the whole plan window of an account', () => {
  it('is the 5-hour and the all-models week, never a per-model one', () => {
    const limits = [five(10), fable(90), week(40)];
    expect(poolWindow(limits, 'short')?.id).toBe('five_hour');
    expect(poolWindow(limits, 'week')?.id).toBe('seven_day');
    expect(poolWindow([fable(90)], 'week')).toBeUndefined();
    const cx = [five(5, 'codex:primary'), week(20, 'codex:secondary'), { ...week(70, 'codex_bengalfox:secondary'), label: 'GPT-5.3 · Weekly limit' }];
    expect(poolWindow(cx, 'week')?.id).toBe('codex:secondary');
  });
});

describe('left across accounts', () => {
  it('one Pro and one Ultra hold 1.1 Ultra', () => {
    const [t] = poolTotals([acct('claude', claude('Ultra', 'max'), [week(0)]), acct('claude', claude('Pro', 'pro'), [week(0)])], NOW);
    expect(t.unit).toBe('Ultra');
    expect(t.week.size).toBeCloseTo(1.1);
    expect(t.week.left).toBeCloseTo(1.1);
  });

  it('weighs what is left by plan: three Ultra and three premium seats', () => {
    const inputs = [
      acct('claude', claude('Ultra', 'max'), [five(20), week(55), fable(70)]),
      acct('claude', claude('Ultra', 'max'), [five(0), week(20)]),
      acct('claude', claude('Ultra', 'max'), [five(40), week(100)]),
      acct('claude', claude('Team', 'team'), [five(10), week(10)]),
      acct('claude', claude('Team', 'team'), [five(50), week(50)]),
      acct('claude', claude('Team', 'team'), [five(0), week(0)]),
    ];
    const [t] = poolTotals(inputs, NOW);
    expect(t.plans).toEqual([
      { name: 'Ultra', count: 3 },
      { name: 'Team', count: 3 },
    ]);
    // Size: 3 + 3 * 0.625 = 4.875 Ultra. Left: 0.45 + 0.8 + 0 + 0.625 * (0.9 + 0.5 + 1) = 2.75.
    expect(t.week.size).toBeCloseTo(4.875);
    expect(t.week.left).toBeCloseTo(2.75);
    expect(t.week.used).toBeCloseTo(43.6, 1);
    // The used-up week makes its 5-hour window count as used up too.
    expect(t.short!.left).toBeCloseTo(0.8 + 1 + 0 + 0.625 * (0.9 + 0.5 + 1));
    expect(units(t.week.left)).toBe('2.8');
    expect(units(t.week.size)).toBe('4.9');
    // The sidebar's one figure is the used share the Usage page draws: usage is always said as used.
    expect(poolUsedPercent(t)).toBe(44);
    expect(poolWeeksText(t)).toBe('2.1 of 4.9 Ultra weeks used');
  });

  it('says everything is used once every week is used up, and never more than everything', () => {
    const full = poolTotals([acct('claude', claude('Ultra'), [week(100)]), acct('claude', claude('Pro'), [week(100)])], NOW)[0];
    expect(poolUsedPercent(full)).toBe(100);
    const fresh = poolTotals([acct('claude', claude('Ultra'), [week(0)]), acct('claude', claude('Pro'), [week(0)])], NOW)[0];
    expect(poolUsedPercent(fresh)).toBe(0);
  });

  it('counts a window whose reset passed as empty', () => {
    const past = { ...week(90), resetsAt: NOW - 1000 };
    const [t] = poolTotals([acct('claude', claude('Pro'), [past]), acct('claude', claude('Pro'), [week(50)])], NOW);
    expect(t.week.left).toBeCloseTo(1.5);
  });

  it('keeps agents apart, and counts accounts of one plan equally whatever it is', () => {
    const inputs = [acct('codex', codex('Pro', 'pro'), [week(20, 'codex:secondary')]), acct('codex', codex('Pro', 'pro'), [week(60, 'codex:secondary')]), acct('claude', claude('Ultra'), [week(10)]), acct('claude', claude('Pro'), [week(10)])];
    const totals = poolTotals(inputs, NOW);
    expect(totals.map((t) => [t.provider, t.unit, t.accounts])).toEqual([
      ['codex', 'Pro', 2],
      ['claude', 'Ultra', 2],
    ]);
    expect(totals[0].week.left).toBeCloseTo(1.2);
    const plus = poolTotals([acct('codex', codex('Plus', 'plus'), [week(50, 'codex:secondary')]), acct('codex', codex('Plus', 'plus'), [week(0, 'codex:secondary')])], NOW);
    expect(plus[0]).toMatchObject({ unit: 'Plus', week: { size: 2, left: 1.5 } });
  });

  it('gives no total for one account, or for accounts without a size or a figure', () => {
    expect(poolTotals([acct('claude', claude('Ultra'), [week(10)])], NOW)).toEqual([]);
    expect(poolTotals([acct('claude', claude('Ultra'), [week(10)]), acct('claude', claude('Enterprise'), [week(10)])], NOW)).toEqual([]);
    expect(poolTotals([acct('claude', claude('Ultra'), [week(10)]), acct('claude', claude('Pro'), [])], NOW)).toEqual([]);
    expect(poolTotals([acct('claude', claude('Ultra'), [week(10)]), { ...acct('claude', claude('Pro'), [week(10)]), usable: false }], NOW)).toEqual([]);
  });
});
