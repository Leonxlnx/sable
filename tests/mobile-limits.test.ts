/**
 * Phone 2.22: the Limits screen lists an agent's accounts in the desktop's order (shared/use-first.ts,
 * through mobile/src/lib/account-order.ts): the account whose unused week ends soonest first, a held or
 * spent one after, signed-out ones last; the person's own order when they keep one; and how many have
 * room, in the desktop overview's words.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AccountInfo, LimitsReport, RateLimit } from '@shared/protocol';

vi.mock('@desk/features/connect/plan', async () => await import('../src/features/connect/plan'));
vi.mock('@desk/features/usage/plans', async () => await import('../src/features/usage/plans'));

const { accountOrder, roomWords } = await import('../mobile/src/lib/account-order');

const NOW = 1_800_000_000_000;
const H = 3600_000;
const acct = (id: string, loggedIn = true, isDefault = false): AccountInfo => ({ id, provider: 'claude', label: id, isDefault, auth: { loggedIn, method: 'claude.ai', plan: 'max' } }) as AccountInfo;
const week = (percent: number, endsIn: number): RateLimit => ({ id: 'seven_day', label: 'Weekly · all models', percent, windowMins: 10_080, resetsAt: NOW + endsIn }) as RateLimit;
const five = (percent: number): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, windowMins: 300, resetsAt: NOW + 2 * H }) as RateLimit;
const report = (limits: RateLimit[]): LimitsReport => ({ provider: 'claude', accountId: '', limits, readAt: NOW }) as unknown as LimitsReport;

describe('accountOrder', () => {
  const accounts = [acct('late', true, true), acct('soon'), acct('full'), acct('spent')];
  const limits = {
    'claude:late': report([five(10), week(20, 5 * 24 * H)]),
    'claude:soon': report([five(10), week(40, 20 * H)]),
    'claude:full': report([five(99), week(30, 2 * 24 * H)]),
    'claude:spent': report([five(0), week(100, 30 * H)]),
  };

  it('puts the week that ends soonest first, then the held, then the spent', () => {
    const { list, rank } = accountOrder('claude', accounts, limits, undefined, NOW);
    expect(list.map((a) => a.id)).toEqual(['soon', 'late', 'full', 'spent']);
    expect(rank.get('full')?.state).toBe('held');
    expect(rank.get('spent')?.state).toBe('spent');
  });

  it("keeps the person's own order when they keep one", () => {
    const { list } = accountOrder('claude', accounts, limits, { accountsBy: 'manual' }, NOW);
    expect(list.map((a) => a.id)).toEqual(['late', 'soon', 'full', 'spent']);
  });

  it('says how many have room, for several accounts with a plan only', () => {
    const { rank } = accountOrder('claude', accounts, limits, undefined, NOW);
    expect(roomWords([...rank.values()])).toBe('2 of 4 with room');
    const one = accountOrder('claude', [acct('late')], limits, undefined, NOW);
    expect(roomWords([...one.rank.values()])).toBe('');
    const none = accountOrder('claude', [acct('full'), acct('spent')], limits, undefined, NOW);
    expect(roomWords([...none.rank.values()])).toBe('None with room');
  });

  it('an account signed out or never read stands after those it can rank', () => {
    const { list } = accountOrder('claude', [acct('unread'), acct('off', false), acct('soon')], limits, undefined, NOW);
    expect(list.map((a) => a.id)).toEqual(['soon', 'unread', 'off']);
  });
});
