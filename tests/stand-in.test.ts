import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { standInRows, type StandIn } from '../src/features/timeline/stand-in';

const user = (id: string, text: string, ts: number) => ({ id, type: 'user', text, ts }) as TimelineItem;
const note = (id: string, ts: number) => ({ id, type: 'notice', text: 'Conversation compacted', ts }) as unknown as TimelineItem;

describe('a sent message stands at the end until its row is there (timeline/stand-in.ts)', () => {
  const s: StandIn = { id: 'standin:1', submitId: 'u', session: 'c1', text: 'okay  lass es mal\naufsetzen', wall: 10_000 };

  it('no row yet: lines added meanwhile (a move, a compaction) do not take its place', () => {
    const items = { a: user('a', 'earlier', 1_000), n1: note('n1', 10_500), n2: note('n2', 11_000) };
    expect(standInRows([s], 'c1', ['a', 'n1', 'n2'], items).size).toBe(0);
  });

  it('its row, seconds late and after those lines, takes it despite different whitespace', () => {
    const items = { a: user('a', 'earlier', 1_000), n1: note('n1', 10_500), u: user('u', 'okay lass es mal aufsetzen', 14_000) };
    expect(standInRows([s], 'c1', ['a', 'n1', 'u'], items).get('standin:1')).toBe('u');
  });

  it('an older message with the same words is history, never its row; another chat never is', () => {
    const old = { o: user('o', 'okay lass es mal aufsetzen', 7_999) };
    expect(standInRows([s], 'c1', ['o'], old).size).toBe(0);
    const items = { u: user('u', 'okay lass es mal aufsetzen', 12_000) };
    expect(standInRows([s], 'c2', ['u'], items).size).toBe(0);
  });

  it('two sends of the same words: each row takes one stand-in', () => {
    const t: StandIn = { ...s, id: 'standin:2', submitId: 'u2', wall: 10_100 };
    const items = { u1: user('u1', 'okay lass es mal aufsetzen', 12_000) };
    expect(standInRows([{ ...s, submitId: 'u1' }, t], 'c1', ['u1'], items).size).toBe(1);
    const both = { ...items, u2: user('u2', 'okay lass es mal aufsetzen', 12_500) };
    expect(standInRows([{ ...s, submitId: 'u1' }, t], 'c1', ['u1', 'u2'], both).size).toBe(2);
  });
});

describe('a pasted text file goes out after the words', () => {
  it('its submission still matches when the bridge row includes the pasted file', () => {
    const s: StandIn = { id: 'standin:9', submitId: 'u', session: 'c1', text: 'look at this', wall: 10_000 };
    const items = { u: user('u', 'look at this\n\n<file name="notes.txt">…</file>', 11_000) };
    expect(standInRows([s], 'c1', ['u'], items).get('standin:9')).toBe('u');
  });
});

it('another submission with a shared prefix cannot retire the stand-in; its queue receipt can', () => {
  const s = { id: 'stand', submitId: 'new', session: 'a', wall: 200, text: 'go on' };
  const items = { old: user('old','go',190) };
  expect(standInRows([s], 'a', ['old'], items).size).toBe(0);
  expect(standInRows([s], 'a', ['old'], items, [{ id: 'q', submitId: 'new', text: 'go on', createdAt: 200 }]).get('stand')).toBe('q');
});

it('a flight to a stand-in can land only on that submission', async () => {
  const { flightKey, claimable } = await import('../src/features/composer/flight');
  const flight = { ...flightKey('go on', 'timeline', 'c', 500), submitId: 'new' };
  expect(claimable(flight, 'timeline', 'go', { session: 'c', submitId: 'old' })).toBe(false);
  expect(claimable(flight, 'timeline', 'expanded command', { session: 'c', submitId: 'new' })).toBe(true);
});
