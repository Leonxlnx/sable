import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { STAND_SLACK_MS, standInRows, type StandIn } from '../src/features/timeline/stand-in';

const user = (id: string, text: string, ts: number) => ({ id, type: 'user', text, ts }) as TimelineItem;
const note = (id: string, ts: number) => ({ id, type: 'notice', text: 'Conversation compacted', ts }) as unknown as TimelineItem;

describe('a sent message stands at the end until its row is there (timeline/stand-in.ts)', () => {
  const s: StandIn = { id: 'standin:1', session: 'c1', text: 'okay  lass es mal\naufsetzen', wall: 10_000 };

  it('no row yet: lines added meanwhile (a move, a compaction) do not take its place', () => {
    const items = { a: user('a', 'earlier', 1_000), n1: note('n1', 10_500), n2: note('n2', 11_000) };
    expect(standInRows([s], 'c1', ['a', 'n1', 'n2'], items).size).toBe(0);
  });

  it('its row, seconds late and after those lines, takes it (words compared as written, spaces aside)', () => {
    const items = { a: user('a', 'earlier', 1_000), n1: note('n1', 10_500), u: user('u', 'okay lass es mal aufsetzen', 14_000) };
    expect(standInRows([s], 'c1', ['a', 'n1', 'u'], items).get('standin:1')).toBe('u');
  });

  it('an older message with the same words is history, never its row; another chat never is', () => {
    const old = { o: user('o', 'okay lass es mal aufsetzen', 10_000 - STAND_SLACK_MS - 1) };
    expect(standInRows([s], 'c1', ['o'], old).size).toBe(0);
    const items = { u: user('u', 'okay lass es mal aufsetzen', 12_000) };
    expect(standInRows([s], 'c2', ['u'], items).size).toBe(0);
  });

  it('two sends of the same words: each row takes one stand-in', () => {
    const t: StandIn = { ...s, id: 'standin:2', wall: 10_100 };
    const items = { u1: user('u1', 'okay lass es mal aufsetzen', 12_000) };
    expect(standInRows([s, t], 'c1', ['u1'], items).size).toBe(1);
    const both = { ...items, u2: user('u2', 'okay lass es mal aufsetzen', 12_500) };
    expect(standInRows([s, t], 'c1', ['u1', 'u2'], both).size).toBe(2);
  });
});

describe('a pasted text file goes out after the words', () => {
  it('the row whose words begin with the stand-in\'s takes it', () => {
    const s: StandIn = { id: 'standin:9', session: 'c1', text: 'look at this', wall: 10_000 };
    const items = { u: user('u', 'look at this\n\n<file name="notes.txt">…</file>', 11_000) };
    expect(standInRows([s], 'c1', ['u'], items).get('standin:9')).toBe('u');
  });
});
