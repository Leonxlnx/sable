/**
 * Usage is said one way everywhere (night of 23/24 Nov: "nicht einmal left oben und unten wie viel
 * used ... einfach nur wie viel used überall"): a percentage is the share USED of a window, a reset
 * is "resets in 3h" or "resets Tue 14:00", and two figures of one account are one reading and one
 * rounding.
 */
import { describe, expect, it } from 'vitest';
import type { RateLimit } from '../shared/protocol';
import { accountUsed, resetsLine, resetsText, usedPercent, usedText, windowState } from '../src/features/usage/words';
import { poolTotals, poolUsedPercent, poolWeeksText } from '../src/features/usage/plans';
import { limitLine } from '../src/features/usage/scope';

const NOW = new Date(2026, 10, 24, 10, 0).getTime();
const H = 3_600_000;
const win = (id: string, percent: number, resetsAt?: number, windowMins = 300, label = '5-hour limit'): RateLimit => ({ id, label, percent, resetsAt, windowMins });

describe('the share used', () => {
  it('is rounded once and said as used', () => {
    expect(usedPercent(win('five_hour', 61.6, NOW + H), NOW)).toBe(62);
    expect(usedText(62)).toBe('62% used');
    expect(windowState(win('five_hour', 61.6, NOW + H), NOW)).toBe('62% used');
    expect(windowState(win('five_hour', 100, NOW + H), NOW)).toBe('used up');
  });

  it('reads a window whose reset has passed as empty, and never past 0 to 100', () => {
    expect(usedPercent(win('five_hour', 90, NOW - 1), NOW)).toBe(0);
    expect(usedPercent(win('five_hour', 140, NOW + H), NOW)).toBe(100);
    expect(usedPercent(win('five_hour', -3, NOW + H), NOW)).toBe(0);
  });

  it('takes the most used window as the account figure, the same window for the ring and the menu row', () => {
    const limits = [win('five_hour', 12, NOW + 2 * H), win('seven_day', 59.4, NOW + 50 * H, 10_080, 'Weekly · all models'), win('model_Fable', 40, NOW + 30 * H, 10_080, 'Weekly · Fable')];
    const a = accountUsed(limits, NOW)!;
    expect(a.limit.id).toBe('seven_day');
    expect(a.pct).toBe(59);
    // A window that reset no longer decides.
    expect(accountUsed([win('five_hour', 99, NOW - 1), win('seven_day', 30, NOW + 50 * H, 10_080)], NOW)!.limit.id).toBe('seven_day');
    expect(accountUsed(undefined, NOW)).toBeUndefined();
    expect(accountUsed([], NOW)).toBeUndefined();
  });
});

describe('the reset', () => {
  it('says "resets in" within a day and the day and time further out', () => {
    expect(resetsText(NOW + 3 * H + 20 * 60_000, NOW)).toBe('resets in 3h 20m');
    expect(resetsText(NOW + 45 * 60_000, NOW)).toBe('resets in 45m');
    expect(resetsLine(NOW + 3 * H, NOW)).toBe('Resets in 3h');
    const far = new Date(2026, 10, 26, 14, 0).getTime();
    expect(resetsText(far, NOW)).toMatch(/^resets Thu \d{2}:\d{2}|^resets Thu \d{1,2}:\d{2}\s?[AP]M$/i);
  });

  it('says nothing for a reset that is not ahead', () => {
    expect(resetsText(undefined, NOW)).toBeUndefined();
    expect(resetsText(NOW, NOW)).toBeUndefined();
    expect(resetsText(NOW - H, NOW)).toBeUndefined();
  });

  it('a limit in one line says used and the reset', () => {
    expect(limitLine(win('five_hour', 86, NOW + 2 * H + 10 * 60_000), NOW)).toBe('5-hour limit 86% used · resets in 2h 10m');
    expect(limitLine(win('model_Fable', 100, undefined, 10_080, 'Weekly · Fable'), NOW)).toBe('Fable weekly limit used up');
  });
});

describe('across an agent\'s accounts', () => {
  const claude = (plan: string) => ({ loggedIn: true, method: 'claude.ai', plan, planId: 'max' }) as never;
  const acct = (plan: string, used: number) => ({ provider: 'claude' as const, usable: true, auth: claude(plan), limits: [win('seven_day', used, NOW + 50 * H, 10_080, 'Weekly · all models')] });

  it('is the used share and the weeks used, never what is left', () => {
    const [t] = poolTotals([acct('Ultra', 60), acct('Ultra', 20)], NOW);
    expect(poolUsedPercent(t)).toBe(40);
    expect(poolWeeksText(t)).toBe('0.8 of 2 Ultra weeks used');
    expect(poolWeeksText(t)).not.toMatch(/left/);
  });
});
