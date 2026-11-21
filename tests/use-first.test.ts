/**
 * Which account to use first (shared/use-first.ts): the one whose unused week ends soonest among
 * those that take work now, so the least quota expires unused; and the next account at a limit
 * follows the same order unless the person keeps their own.
 */
import { describe, expect, it } from 'vitest';
import type { RateLimit } from '@shared/protocol';
import { firstToUse, rankAccount, useFirst, type UseFirstAccount } from '../shared/use-first';
import { pickNextAccount } from '../server/accounts/folders';

const NOW = Date.parse('2026-11-21T18:00:00Z');
const H = 3_600_000;
const week = (percent: number, inHours: number): RateLimit => ({ id: 'seven_day', label: 'Weekly · all models', percent, resetsAt: NOW + inHours * H, windowMins: 10_080 });
const five = (percent: number, inHours = 3): RateLimit => ({ id: 'five_hour', label: '5-hour limit', percent, resetsAt: NOW + inHours * H, windowMins: 300 });
const fable = (percent: number, inHours: number): RateLimit => ({ id: 'model_Fable', label: 'Weekly · Fable', percent, resetsAt: NOW + inHours * H, windowMins: 10_080 });
const acct = (id: string, limits: RateLimit[], over: Partial<UseFirstAccount> = {}): UseFirstAccount => ({ id, signedIn: true, limits, ...over });

// The owner's accounts on the evening of 21 Nov 2026.
const real = [
  acct('ultra1', [week(97, 5), fable(100, 5)], { weight: 10 }),
  acct('ultra2', [week(66, 65), fable(47, 65)], { weight: 10 }),
  acct('ultra3', [five(0), week(31, 92), fable(36, 92)], { weight: 10 }),
  acct('max1', [five(0), week(0, 132), fable(0, 132)], { weight: 6.25 }),
  acct('max2', [five(0), week(0, 164), fable(0, 164)], { weight: 6.25 }),
  acct('max3', [five(0), week(17, 30), fable(30, 30)], { weight: 6.25 }),
];

describe('use first', () => {
  it('orders by the end of the week, soonest first, among accounts with room', () => {
    expect(useFirst(real, NOW).map((r) => `${r.id}:${r.state}`)).toEqual(['max3:now', 'ultra2:now', 'ultra3:now', 'max1:now', 'max2:now', 'ultra1:spent']);
    expect(firstToUse(real, NOW)).toBe('max3');
    expect(firstToUse(real, NOW, undefined, 'max3')).toBe('ultra2');
  });

  it('for a model, its own week counts: a full one holds the account until it resets', () => {
    const r = rankAccount(acct('a', [week(40, 50), fable(100, 20)]), NOW, 'claude-fable-5-2');
    expect(r).toMatchObject({ state: 'held', left: 0, until: NOW + 20 * H });
    // Another model is not held by it.
    expect(rankAccount(acct('a', [week(40, 50), fable(100, 20)]), NOW, 'claude-opus-5-5')).toMatchObject({ state: 'now', left: 60 });
    // With no model named, only the week of all models counts.
    expect(rankAccount(acct('a', [week(40, 50), fable(100, 20)]), NOW)).toMatchObject({ state: 'now', left: 60 });
  });

  it('a full 5-hour window holds an account; it comes after those that take work now, by when it is free', () => {
    const list = [acct('soon', [five(100, 1), week(10, 20)]), acct('later', [week(10, 90)]), acct('held2', [five(98, 4), week(10, 10)])];
    expect(useFirst(list, NOW).map((r) => `${r.id}:${r.state}`)).toEqual(['later:now', 'soon:held', 'held2:held']);
  });

  it('respects the cap the person set: what is left is counted up to it', () => {
    expect(rankAccount(acct('a', [week(80, 30)], { cap: { weekly: 95 } }), NOW)).toMatchObject({ state: 'now', left: 15 });
    expect(rankAccount(acct('a', [week(95, 30)], { cap: { weekly: 95 } }), NOW)).toMatchObject({ state: 'spent', left: 0 });
    expect(rankAccount(acct('a', [week(98, 30)]), NOW)).toMatchObject({ state: 'spent', left: 2 });
  });

  it('weeks ending together: the one with more left for its plan size first', () => {
    const list = [acct('small', [week(10, 40)], { weight: 1 }), acct('big', [week(50, 40.1)], { weight: 10 })];
    expect(useFirst(list, NOW).map((r) => r.id)).toEqual(['big', 'small']);
  });

  it('not read, signed out and billed per token come last, in the order given', () => {
    const list = [acct('key', [], { planLimits: false }), acct('out', [week(0, 9)], { signedIn: false }), acct('unread', []), acct('ok', [week(50, 99)])];
    expect(useFirst(list, NOW).map((r) => `${r.id}:${r.state}`)).toEqual(['ok:now', 'unread:unknown', 'key:off', 'out:off']);
  });

  it('a window whose reset has passed no longer counts', () => {
    expect(rankAccount(acct('a', [{ ...week(100, -1) }, five(100, -2)]), NOW)).toMatchObject({ state: 'unknown' });
  });
});

describe('the next account at a limit', () => {
  const cands = real.map((a) => ({ ...a, plan: a.id.startsWith('ultra') ? 'Ultra' : 'Team' }));

  it('by use first: the week that ends soonest, whatever its plan', () => {
    expect(pickNextAccount('ultra1', cands, NOW, { plan: 'Ultra', useFirst: true })).toBe('max3');
    expect(pickNextAccount('max3', cands, NOW, { plan: 'Team', useFirst: true })).toBe('ultra2');
  });

  it("without it: the same plan first, then the most room, as before; a move by a cap keeps the person's order", () => {
    expect(pickNextAccount('ultra1', cands, NOW, { plan: 'Ultra' })).toBe('ultra3');
    expect(pickNextAccount('ultra1', cands, NOW, { plan: 'Ultra', byCap: true, useFirst: true })).toBe('ultra2');
  });

  it('never one at a limit or billed per token, also by use first', () => {
    const list = [{ id: 'cur', signedIn: true, limits: [week(100, 5)] }, { id: 'key', signedIn: true, planLimits: false as const }, { id: 'full', signedIn: true, limits: [week(100, 2)] }, { id: 'ok', signedIn: true, limits: [week(20, 80)] }];
    expect(pickNextAccount('cur', list, NOW, { useFirst: true })).toBe('ok');
  });
});
