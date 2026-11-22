import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import {
  firstLine,
  groupAt,
  groupBoxes,
  groupHeight,
  isBuilt,
  marksOf,
  nearest,
  placeMarks,
  rowsOf,
  stepTarget,
  ticksOf,
  type Built,
  type NavMark,
} from '@/features/timeline/nav-model';
import { groupTurns, type Group, type TurnGroup } from '@/features/timeline/turns';

/** Items and a layout from a compact spec ("U1 w2 t3 T4": shape char + id), as turns.test.ts reads it. */
function chat(spec: string, extra: Record<string, Partial<TimelineItem>> = {}) {
  const parts = spec.split(/\s+/).filter(Boolean);
  const ids = parts.map((p) => p.slice(1));
  const shape = parts.map((p) => p[0]).join('');
  const items: Record<string, TimelineItem> = {};
  parts.forEach((p, i) => {
    const id = ids[i];
    const ch = p[0];
    const base = { id, ts: 1_700_000_000_000 + i * 1000 };
    let it: TimelineItem;
    if (ch === 'U' || ch === 'S') it = { ...base, type: 'user', text: `message ${id}`, ...(ch === 'S' ? { steered: true } : {}) } as UserItem;
    else if (ch === 't') it = { ...base, type: 'text', text: 'An answer of some length.', streaming: false };
    else if (ch === 'w') it = { ...base, type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: {} };
    else if (ch === 'T') it = { ...base, type: 'turn', durationMs: 1 };
    else it = { ...base, type: 'notice', variant: 'mode', text: 'n' };
    items[id] = { ...it, ...(extra[id] ?? {}) } as TimelineItem;
  });
  return { ids, shape, items, groups: groupTurns(ids, shape, false).groups };
}

const edit = (paths: string[]): Partial<ToolItem> => ({ kind: 'edit', name: 'Edit', result: { diff: paths.map((path) => ({ path, status: 'modified' as const, additions: 1, deletions: 0, hunks: [] })) } });

/** A fixed estimate: messages 100, texts 200, the rest 40. */
const est = (it: TimelineItem | undefined) => (!it ? 0 : it.type === 'user' ? 100 : it.type === 'text' ? 200 : 40);

describe('marks', () => {
  it('gives one mark per message, steered ones too, and the files a turn changed to its first', () => {
    const { groups, items } = chat('U1 w2 t3 T4 U5 w6 S7 w8 t9 T10', { 6: edit(['a.ts', 'b.ts']), 8: edit(['a.ts']) });
    const marks = marksOf(groups, items, {}, new WeakMap());
    expect(marks).toEqual([
      { id: '1', group: 0, steered: false, files: 0 },
      { id: '5', group: 1, steered: false, files: 2 },
      { id: '7', group: 1, steered: true, files: 0 },
    ]);
  });

  it('leaves out messages Sable sent for an until check and queued ones', () => {
    const { groups, items } = chat('U1 t2 T3 U4 t5 T6', { 4: { until: {} } as Partial<UserItem> });
    expect(marksOf(groups, items, {}, new WeakMap()).map((m) => m.id)).toEqual(['1']);
  });

  it('keeps the same array while nothing changed, reading only turns it has not seen', () => {
    const { groups, items } = chat('U1 t2 T3 U4 t5 T6');
    const cache = new WeakMap<TurnGroup, Omit<NavMark, 'group'>[]>();
    const a = marksOf(groups, items, {}, cache);
    // The same turn objects in a new array (a step joined a turn elsewhere): the same marks.
    expect(marksOf(groups.slice(), items, {}, cache, a)).toBe(a);
    // A turn object it has not seen is read; the others come from the cache.
    const next = chat('U1 t2 T3 U4 t5 T6 U7 t8 T9');
    const b = marksOf([groups[0], groups[1], next.groups[2]], next.items, {}, cache, a);
    expect(b).not.toBe(a);
    expect(b.map((m) => m.id)).toEqual(['1', '4', '7']);
  });
});

describe('group heights and offsets', () => {
  it('counts what a finished turn shows: its message, one line for everything folded, the answer and its foot', () => {
    const { groups, items } = chat('U1 w2 t3 w4 t5 T6');
    const at: Record<string, number> = {};
    const h = groupHeight(groups[0], items, est, (id, y) => (at[id] = y));
    // message 100, line 34, the answer 200, foot 30: the note along the way is behind the line.
    expect(h).toBe(100 + 34 + 200 + 30);
    expect(at).toMatchObject({ 1: 0, 2: 134, 3: 134, 4: 134, 5: 134 });
  });

  it('counts a running turn by its checkpoints: a line per run, each note, and the live line', () => {
    const { ids, shape, items } = chat('U1 w2 t3 w4 t5 w6');
    const running = groupTurns(ids, shape, true).groups[0];
    // message 100, line 34, note 200, line 34, note 200, line 34 (the run under way), the live line 34, foot 30
    expect(groupHeight(running, items, est)).toBe(100 + 34 + 200 + 34 + 200 + 34 + 34 + 30);
  });

  it('places a steered message inside its turn, after the line, with its reply under it', () => {
    const { groups, items } = chat('U1 w2 t3 S4 t5 w6 t7 T8');
    const at: Record<string, number> = {};
    const h = groupHeight(groups[0], items, est, (id, y) => (at[id] = y));
    expect(at[4]).toBe(100 + 34);
    expect(at[5]).toBe(100 + 34 + 100);
    // message, line, steered message, reply, answer, foot
    expect(h).toBe(100 + 34 + 100 + 200 + 200 + 30);
  });
});

describe('boxes and places', () => {
  const groups = chat('U1 t2 T3 U4 t5 T6 U7 t8 T9 U10 t11 T12 U13 t14 T15').groups as Group[];
  const heightOf = () => 100;

  it('measures built groups and spreads the rest over their spacers, scaled to fill them', () => {
    // Groups 0-1 behind the first spacer (drawn 300 tall), 2 built, 3 behind the gap (drawn 50), 4 built.
    const built: Built = { lead: 2, gapFrom: 3, hidden: 4 };
    expect([0, 1, 2, 3, 4].map((i) => isBuilt(built, i))).toEqual([false, false, true, false, true]);
    const boxes = groupBoxes(groups, built, { older: { top: 30, height: 300 }, gap: { top: 700, height: 50 }, box: (i) => (i === 2 ? { top: 330, height: 370 } : i === 4 ? { top: 750, height: 400 } : undefined) }, heightOf);
    expect(Array.from(boxes.top)).toEqual([30, 180, 330, 700, 750]);
    expect(Array.from(boxes.height)).toEqual([150, 150, 370, 50, 400]);
  });

  it('puts a built group that draws nothing where the one before it ends', () => {
    const built: Built = { lead: 0, gapFrom: 5, hidden: 5 };
    const boxes = groupBoxes(groups, built, { older: null, gap: null, box: (i) => (i === 1 ? undefined : { top: i * 100 + (i > 1 ? -60 : 0), height: i === 0 ? 40 : 100 }) }, heightOf);
    expect(boxes.top[1]).toBe(40);
    expect(boxes.height[1]).toBe(0);
  });

  it('places a turn first message at its top and a later one by its share of the turn', () => {
    const marks: NavMark[] = [
      { id: 'a', group: 0, steered: false, files: 0 },
      { id: 'b', group: 0, steered: true, files: 0 },
      { id: 'c', group: 1, steered: false, files: 0 },
    ];
    const ys = placeMarks(marks, { top: Float64Array.from([10, 500]), height: Float64Array.from([400, 300]) }, (g, id) => (id === 'b' ? 0.5 : id === 'a' ? 0 : undefined));
    expect(Array.from(ys)).toEqual([10, 210, 500]);
  });

  it('finds the group at an offset', () => {
    const top = [0, 100, 100, 250];
    expect([-5, 0, 99, 100, 249, 900].map((y) => groupAt(top, y))).toEqual([-1, 0, 0, 2, 2, 3]);
  });
});

describe('ticks', () => {
  it('shares one tick between marks closer than the gap, with the strongest kind', () => {
    const ys = [0, 10, 11, 12, 100];
    const kinds = ['msg', 'msg', 'files', 'msg', 'wait'] as const;
    const steered = [false, true, true, true, true];
    expect(ticksOf(ys, (i) => kinds[i], (i) => steered[i], 1)).toEqual([
      { y: 0, kind: 'msg', steered: false },
      { y: 10, kind: 'files', steered: true },
      { y: 100, kind: 'wait', steered: true },
    ]);
    // Scaled to the track.
    expect(ticksOf(ys, () => 'msg', () => false, 0.5, 3).map((t) => t.y)).toEqual([0, 5, 50]);
  });

  it('draws find results one per row', () => {
    expect(rowsOf([0, 1, 2, 9, 30], 1, 3)).toEqual([0, 9, 30]);
  });

  it('answers the pointer with the nearest mark within reach', () => {
    const px = [10, 20, 40];
    expect(nearest(px, 14, 8)).toBe(0);
    expect(nearest(px, 16, 8)).toBe(1);
    expect(nearest(px, 33, 8)).toBe(2);
    expect(nearest(px, 30, 8)).toBe(-1);
    expect(nearest(px, 30, 5)).toBe(-1);
    expect(nearest([], 5, 8)).toBe(-1);
  });
});

describe('stepping between messages', () => {
  // Messages at 0, 1000, 2000; the view's top at `top`, its reading line 300 below.
  const ys = [0, 1000, 2000];
  const step = (top: number, dir: 1 | -1) => stepTarget(ys, top + 300, top + 18, dir);

  it('goes to the next message, and past the last to the end', () => {
    expect(step(-18, 1)).toBe(1);
    expect(step(982, 1)).toBe(2);
    expect(step(1982, 1)).toBe(3);
  });

  it('goes up to the message before, or first to the start of a long turn the view is in', () => {
    expect(step(982, -1)).toBe(0);
    // In the middle of the second turn: its own message first.
    expect(step(1500, -1)).toBe(1);
    expect(step(-18, -1)).toBe(0);
  });

  it('starts from the first message when the view is above all of them', () => {
    expect(stepTarget([500, 900], 100, 20, 1)).toBe(0);
    expect(stepTarget([], 100, 20, 1)).toBe(0);
    expect(stepTarget([], 100, 20, -1)).toBe(-1);
  });
});

describe('previews', () => {
  it('shows the first line with words, cut to length', () => {
    expect(firstLine('\n\n  Fix the auth middleware  \nmore')).toBe('Fix the auth middleware');
    expect(firstLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(firstLine('')).toBe('');
  });
});
