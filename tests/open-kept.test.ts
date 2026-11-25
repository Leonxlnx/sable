import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { forgetLists, holdList, listCount, listFor } from '../src/features/timeline/build-window';
import { shapeIndex, shapeOf, shapeOfKept, turnsIndex } from '../src/features/timeline/turns';

const user = (id: string, text = 'Fix the bug'): TimelineItem => ({ id, ts: 1, type: 'user', text });
const text = (id: string, t: string): TimelineItem => ({ id, ts: 1, type: 'text', text: t, streaming: false });
const tool = (id: string): TimelineItem => ({ id, ts: 1, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {} });
const turn = (id: string): TimelineItem => ({ id, ts: 1, type: 'turn', durationMs: 1000 });

function chat(turns: number) {
  const items: Record<string, TimelineItem> = {};
  const roots: string[] = [];
  for (let t = 0; t < turns; t++) {
    for (const it of [user(`u${t}`), text(`l${t}`, 'Let me run the tests.'), tool(`w${t}`), text(`t${t}`, `Done with part ${t}. The tests pass.`), turn(`e${t}`)]) {
      items[it.id] = it;
      roots.push(it.id);
    }
  }
  return { items, roots };
}

describe('a long chat opened again reads nothing it has read', () => {
  it('remembers each item’s character by the item, and gives what shapeOf gives', () => {
    const { items, roots } = chat(20);
    for (const id of roots) expect(shapeOfKept(items[id])).toBe(shapeOf(items[id]));
    expect(shapeOfKept(undefined)).toBe(shapeOf(undefined));
    // A changed item is a new object: its own character, never the old one's.
    const was = items.l3;
    const now = { ...was, text: 'The guard throws on an empty list, so the cache was never filled.' } as TimelineItem;
    expect(shapeOfKept(was)).toBe('l');
    expect(shapeOfKept(now)).toBe('t');
  });

  it('a full read of the shape is the plain join, also on a second index over the same items', () => {
    const { items, roots } = chat(50);
    const want = roots.map((id) => shapeOf(items[id])).join('');
    expect(shapeIndex()({ items, rev: 1 }, roots)).toBe(want);
    // A list mounted again for the same chat (a fresh index): every character from the memo, the same string.
    expect(shapeIndex()({ items, rev: 1 }, roots)).toBe(want);
  });

  it('a kept list is the same entry when its chat opens again, a fresh one while it is in use', () => {
    const make = () => ({ shapes: shapeIndex(), grouping: turnsIndex(), cache: new Map<string, unknown>(), kept: new WeakMap<object, unknown>(), heights: new WeakMap<object, number>() });
    const a = listFor('chat-a', make);
    const release = holdList(a);
    // A second list of the same chat while the first is on screen works on its own entry.
    const b = listFor('chat-a', make);
    expect(b).not.toBe(a);
    release();
    // Opened again: the entry the first list left, with its index and grouping.
    expect(listFor('chat-a', make)).toBe(a);
  });

  it('the grouping a kept list left is the grouping of the same timeline', () => {
    const { items, roots } = chat(30);
    const make = () => ({ shapes: shapeIndex(), grouping: turnsIndex(), cache: new Map<string, unknown>(), kept: new WeakMap<object, unknown>(), heights: new WeakMap<object, number>() });
    const first = listFor('chat-g', make);
    const shape = first.shapes({ items, rev: 7 }, roots);
    const before = first.grouping(roots, shape, false);
    // Opened again with one more turn: the turns before it are the same objects, the new one is grouped.
    const more = chat(31);
    const again = listFor('chat-g', make);
    expect(again).toBe(first);
    const shape2 = again.shapes({ items: more.items, rev: 8 }, more.roots);
    const after = again.grouping(more.roots, shape2, false);
    expect(after.groups.length).toBe(31);
    expect(after.groups.slice(0, 29)).toEqual(before.groups.slice(0, 29));
    expect(after.groups[0]).toBe(before.groups[0]);
  });

  it('drops the lists of chats the window no longer keeps, never one in use', () => {
    const make = () => ({ shapes: shapeIndex(), grouping: turnsIndex(), cache: new Map<string, unknown>(), kept: new WeakMap<object, unknown>(), heights: new WeakMap<object, number>() });
    const kept = listFor('chat-k', make);
    const used = listFor('chat-u', make);
    const release = holdList(used);
    const n = listCount();
    forgetLists((id) => id !== 'chat-k' && id !== 'chat-u');
    expect(listCount()).toBe(n - 1);
    expect(listFor('chat-k', make)).not.toBe(kept);
    release();
  });
});

it('a remounted navigator reuses both the marks and the local heights of kept turns', async () => {
  const { marksOf, navigatorShape } = await import('../src/features/timeline/nav-model');
  const { items, roots } = chat(5);
  const groups = turnsIndex()(roots, shapeIndex()({ items, rev: 1 }, roots), false).groups;
  const marks = marksOf(groups, items);
  const shape = navigatorShape(groups[0], items, () => 100);
  const unread = new Proxy(items, { get() { throw Error('reread a kept item'); } });
  expect(marksOf(groups, unread)).toEqual(marks);
  expect(navigatorShape(groups[0], unread, () => { throw Error('estimated twice'); })).toBe(shape);
});

it('keeps the settled suffix and its waiting steer when an older page starts inside a turn', async () => {
  const { groupTurns } = await import('../src/features/timeline/turns');
  const shape = 'UwtTUxwtTUtTUwws';
  const ids = [...shape].map((_, i) => String(i));
  const checkOf = () => ids[0];
  for (const busy of [false, true]) {
    const index = turnsIndex();
    const end = index(ids.slice(9), shape.slice(9), busy, checkOf);
    const part = index(ids.slice(2), shape.slice(2), busy, checkOf);
    expect(part).toEqual(groupTurns(ids.slice(2), shape.slice(2), busy, checkOf));
    expect(part.groups.at(-1)).toBe(end.groups.at(-1));
    expect(index(ids, shape, busy, checkOf)).toEqual(groupTurns(ids, shape, busy, checkOf));
  }
});

it('replaces only the turn whose thinking root changed off screen', async () => {
  const { stabilize } = await import('../src/features/timeline/stabilize');
  const index = turnsIndex(), cache = new Map(), kept = new WeakMap();
  const ids = ['u0','t0','e0','u1','tool','reason0'];
  const first = stabilize(index(ids, 'UtTUww', true), cache, kept);
  const fresh = index([...ids.slice(0,-1), 'reason1'], 'UtTUww', true);
  const next = stabilize(fresh, cache, kept);
  expect(next).toEqual(fresh);
  expect(next.groups[0]).toBe(first.groups[0]);
  expect(next.groups[1]).not.toBe(first.groups[1]);
});
