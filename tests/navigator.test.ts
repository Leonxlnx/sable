import { describe, expect, it } from 'vitest';
import type { TimelineItem, UserItem } from '@shared/protocol';
import {
  firstLine,
  indexLines,
  indexWindow,
  rowsMoved,
  groupAt,
  groupBoxes,
  groupHeight,
  isBuilt,
  markAt,
  marksOf,
  markY,
  matchPrompt,
  placeMarks,
  railAt,
  railOf,
  runOf,
  runsOf,
  stackHeight,
  stepTarget,
  type Built,
  type NavMark,
} from '@/features/timeline/nav-model';
import { groupTurns, type Group, type TurnGroup } from '@/features/timeline/turns';

const T0 = 1_700_000_000_000;

/** Items and a layout from a compact spec ("U1 w2 t3 T4": shape char + id), as turns.test.ts reads it. */
function chat(spec: string, extra: Record<string, Partial<TimelineItem>> = {}) {
  const parts = spec.split(/\s+/).filter(Boolean);
  const ids = parts.map((p) => p.slice(1));
  const shape = parts.map((p) => p[0]).join('');
  const items: Record<string, TimelineItem> = {};
  parts.forEach((p, i) => {
    const id = ids[i];
    const ch = p[0];
    const base = { id, ts: T0 + i * 1000 };
    let it: TimelineItem;
    if (ch === 'U' || ch === 'S') it = { ...base, type: 'user', text: `message ${id}`, ...(ch === 'S' ? { steered: true } : {}) } as UserItem;
    else if (ch === 't') it = { ...base, type: 'text', text: 'An answer of some length.', streaming: false };
    else if (ch === 'w') it = { ...base, type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: {} };
    else if (ch === 'T' || ch === 'F') it = { ...base, type: 'turn', durationMs: 1 };
    else it = { ...base, type: 'notice', variant: 'mode', text: 'n' };
    items[id] = { ...it, ...(extra[id] ?? {}) } as TimelineItem;
  });
  return { ids, shape, items, groups: groupTurns(ids, shape, false).groups };
}

/** A fixed estimate: messages 100, texts 200, the rest 40. */
const est = (it: TimelineItem | undefined) => (!it ? 0 : it.type === 'user' ? 100 : it.type === 'text' ? 200 : 40);

describe('marks', () => {
  it('gives one mark per message, steered ones too, each with the time it was sent', () => {
    const { groups, items } = chat('U1 w2 t3 T4 U5 w6 S7 w8 t9 T10');
    const marks = marksOf(groups, items, new WeakMap());
    expect(marks).toEqual([
      { id: '1', group: 0, steered: false, ts: T0, failed: false },
      { id: '5', group: 1, steered: false, ts: T0 + 4000, failed: false },
      { id: '7', group: 1, steered: true, ts: T0 + 6000, failed: false },
    ]);
  });

  it('marks a turn that ended in an error on its last message', () => {
    const { groups, items } = chat('U1 t2 T3 U4 w5 S6 w7 F8 U9 t10 T11', { 8: { error: 'overloaded' } as Partial<TimelineItem> });
    expect(marksOf(groups, items, new WeakMap()).map((m) => [m.id, m.failed])).toEqual([
      ['1', false],
      ['4', false],
      ['6', true],
      ['9', false],
    ]);
  });

  it('leaves out messages Sable sent for an until check and queued ones', () => {
    const { groups, items } = chat('U1 t2 T3 U4 t5 T6', { 4: { until: {} } as Partial<UserItem> });
    expect(marksOf(groups, items, new WeakMap()).map((m) => m.id)).toEqual(['1']);
  });

  it('keeps the same array while nothing changed, reading only turns it has not seen', () => {
    const { groups, items } = chat('U1 t2 T3 U4 t5 T6');
    const cache = new WeakMap<TurnGroup, Omit<NavMark, 'group'>[]>();
    const a = marksOf(groups, items, cache);
    // The same turn objects in a new array (a step joined a turn elsewhere): the same marks.
    expect(marksOf(groups.slice(), items, cache, a)).toBe(a);
    // A turn object it has not seen is read; the others come from the cache.
    const next = chat('U1 t2 T3 U4 t5 T6 U7 t8 T9');
    const b = marksOf([groups[0], groups[1], next.groups[2]], next.items, cache, a);
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
      { id: 'a', group: 0, steered: false, ts: 0, failed: false },
      { id: 'b', group: 0, steered: true, ts: 0, failed: false },
      { id: 'c', group: 1, steered: false, ts: 0, failed: false },
    ];
    const ys = placeMarks(marks, { top: Float64Array.from([10, 500]), height: Float64Array.from([400, 300]) }, (g, id) => (id === 'b' ? 0.5 : id === 'a' ? 0 : undefined));
    expect(Array.from(ys)).toEqual([10, 210, 500]);
  });

  it('finds the group at an offset', () => {
    const top = [0, 100, 100, 250];
    expect([-5, 0, 99, 100, 249, 900].map((y) => groupAt(top, y))).toEqual([-1, 0, 0, 2, 2, 3]);
  });
});

describe('runs', () => {
  const MIN = 60_000;
  /** Times from gaps in minutes: the first message at 0. */
  const times = (gaps: number[]) => gaps.reduce<number[]>((ts, g) => [...ts, ts[ts.length - 1] + g * MIN], [0]);
  const sizes = (ts: number[], max?: number, size?: number) => runsOf(ts, max, size).map((r) => r.to - r.from);

  it('starts a run after a pause of an hour, and keeps a sitting together', () => {
    const ts = times([5, 12, 61, 3, 3, 240, 8]);
    expect(runsOf(ts)).toEqual([
      { from: 0, to: 3 },
      { from: 3, to: 6 },
      { from: 6, to: 8 },
    ]);
    expect(runsOf([])).toEqual([]);
    expect(runsOf([5])).toEqual([{ from: 0, to: 1 }]);
  });

  it('cuts a very long sitting into pieces from its start, the last up to one and a half', () => {
    const sitting = (n: number) => times(new Array(n - 1).fill(2));
    expect(sizes(sitting(36))).toEqual([36]);
    expect(sizes(sitting(37))).toEqual([24, 13]);
    expect(sizes(sitting(61))).toEqual([24, 24, 13]);
    // A conversation that grows keeps the runs it has.
    expect(runsOf(sitting(90)).slice(0, 2)).toEqual(runsOf(sitting(61)).slice(0, 2));
  });

  it('never makes more runs than the rail holds: the longest pauses count, the pieces grow', () => {
    // Forty messages a day apart, some pauses longer: the longest fifteen cut.
    const gaps = Array.from({ length: 39 }, (_, i) => 24 * 60 + (i % 3 === 0 ? 600 : i));
    const runs = runsOf(times(gaps));
    expect(runs).toHaveLength(16);
    expect(runs[0].from).toBe(0);
    expect(runs[15].to).toBe(40);
    for (let i = 1; i < runs.length; i++) expect(runs[i].from).toBe(runs[i - 1].to);
    // One sitting of a thousand: sixteen pieces at most.
    const long = sizes(times(new Array(999).fill(1)));
    expect(long.length).toBeLessThanOrEqual(16);
    expect(long.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('finds the run of a message', () => {
    const runs = [
      { from: 0, to: 3 },
      { from: 3, to: 4 },
      { from: 4, to: 9 },
    ];
    expect([0, 2, 3, 4, 8, 9].map((i) => runOf(runs, i))).toEqual([0, 0, 1, 2, 2, -1]);
  });
});

describe('the rail', () => {
  const runs = [
    { from: 0, to: 9 },
    { from: 9, to: 10 },
    { from: 10, to: 14 },
  ];
  const sizes = runs.map((r) => r.to - r.from);

  it('draws closed runs as stacks, a run of one as its line, and fans the open run out', () => {
    expect([1, 2, 4, 9, 16, 25].map(stackHeight)).toEqual([2, 7, 8, 10, 12, 14]);
    const rail = railOf(sizes, 2, 500);
    // A stack of nine, a line, then four lines five apart; six between runs.
    expect(rail.top).toEqual([0, 16, 24]);
    expect(rail.height).toEqual([10, 2, 20]);
    expect(rail.pitch).toBe(5);
    expect(rail.h).toBe(44);
    // With the first run open instead, what follows moves down by what it gained.
    expect(railOf(sizes, 0, 500).top).toEqual([0, 51, 59]);
  });

  it('closes the open run up, then shrinks the stacks, when the track is short', () => {
    const many = [30, 30, 30];
    expect(railOf(many, 1, 400).pitch).toBe(5);
    expect(railOf(many, 1, 140).pitch).toBe(3);
    const tight = railOf(many, 1, 110);
    expect(tight.pitch).toBe(3);
    expect(tight.height[0]).toBeLessThan(stackHeight(30));
    expect(tight.h).toBeLessThanOrEqual(110);
  });

  it('places a message on its line in the open run and by its share of a closed stack', () => {
    const rail = railOf(sizes, 2, 500);
    expect(markY(rail, runs, 10)).toBe(24 + 2.5);
    expect(markY(rail, runs, 13)).toBe(24 + 17.5);
    expect(markY(rail, runs, 9)).toBe(17);
    expect(markY(rail, runs, 0)).toBeCloseTo(10 / 18);
    expect(markY(rail, runs, 8)).toBeCloseTo(10 - 10 / 18);
  });

  it('answers the pointer with the nearest run, and in the open run with the line under it', () => {
    const rail = railOf(sizes, 2, 500);
    expect(railAt(rail, runs, 2, -20)).toEqual({ run: 0, mark: 0 });
    expect(railAt(rail, runs, 2, 8)).toEqual({ run: 0, mark: 0 });
    // Half of the gap belongs to each neighbour.
    expect(railAt(rail, runs, 2, 12.9)).toEqual({ run: 0, mark: 0 });
    expect(railAt(rail, runs, 2, 13.1)).toEqual({ run: 1, mark: 9 });
    expect(railAt(rail, runs, 2, 25)).toEqual({ run: 2, mark: 10 });
    expect(railAt(rail, runs, 2, 36)).toEqual({ run: 2, mark: 12 });
    expect(railAt(rail, runs, 2, 400)).toEqual({ run: 2, mark: 13 });
    expect(railAt(railOf([], -1, 500), [], -1, 5)).toBeNull();
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

  it('steps through short turns that share a view one by one', () => {
    // Four messages in one view, the first landed at the top: the next is the second, not the one after the reading line.
    const near = [0, 100, 200, 3000];
    expect(stepTarget(near, -18 + 300, 0, 1)).toBe(1);
    expect(stepTarget(near, 82 + 300, 100, 1)).toBe(2);
    expect(stepTarget(near, 182 + 300, 200, -1)).toBe(1);
    expect(markAt(near, 82 + 300, 100)).toBe(1);
    // Inside a long turn, its own message; above everything, none.
    expect(markAt(near, 1500, 1218)).toBe(2);
    expect(markAt([500, 900], 100, 20)).toBe(-1);
  });

  it('starts from the first message when the view is above all of them', () => {
    expect(stepTarget([500, 900], 100, 20, 1)).toBe(0);
    expect(stepTarget([], 100, 20, 1)).toBe(0);
    expect(stepTarget([], 100, 20, -1)).toBe(-1);
  });
});

describe('words', () => {
  it('shows the first line with words, cut to length', () => {
    expect(firstLine('\n\n  Fix the auth middleware  \nmore')).toBe('Fix the auth middleware');
    expect(firstLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
    expect(firstLine('')).toBe('');
  });

  it('keeps a message that has every word typed, and marks them in its line', () => {
    const text = 'Fix the auth middleware\n\nAlso keep the public API as it is.';
    expect(matchPrompt(text, '')).toEqual({ line: 'Fix the auth middleware', indices: [] });
    expect(matchPrompt(text, 'AUTH fix')).toEqual({ line: 'Fix the auth middleware', indices: [0, 1, 2, 8, 9, 10, 11] });
    expect(matchPrompt(text, 'auth sidebar')).toBeNull();
    // A word only further down: the line that has it.
    expect(matchPrompt(text, 'public')?.line).toBe('Also keep the public API as it is.');
    // The first line wins when it has one of the words.
    expect(matchPrompt(text, 'public fix')?.line).toBe('Fix the auth middleware');
  });

  it('starts a long line a little before a word that stands far in', () => {
    const text = `${'word '.repeat(60)}needle and more`;
    const m = matchPrompt(text, 'needle', 60);
    expect(m?.line.startsWith('…')).toBe(true);
    expect(m?.line).toContain('needle');
    const at = m!.line.indexOf('needle');
    expect(m!.indices).toEqual([0, 1, 2, 3, 4, 5].map((i) => at + i));
  });
});

describe('the navigator with long sittings and moving rows (review wave 9)', () => {
  it('keeps a 285-message sitting inside its track: the rail never runs past it', () => {
    // Fifteen one-message sittings an hour apart, then one long sitting of 285.
    const ts: number[] = [];
    for (let i = 0; i < 15; i++) ts.push(T0 + i * 2 * 60 * 60_000);
    for (let i = 0; i < 285; i++) ts.push(T0 + 40 * 60 * 60_000 + i * 60_000);
    const runs = runsOf(ts);
    expect(runs.length).toBeLessThanOrEqual(16);
    const sizes = runs.map((r) => r.to - r.from);
    const open = runs.length - 1;
    for (const track of [500, 300, 160]) {
      const rail = railOf(sizes, open, track);
      expect(rail.h, `track ${track}`).toBeLessThanOrEqual(track);
      // The last message's line stands on the track, and a place on it points back at a message of the run.
      const lastY = markY(rail, runs, 299);
      expect(lastY).toBeLessThanOrEqual(track);
      expect(railAt(rail, runs, open, lastY)?.mark).toBeGreaterThanOrEqual(runs[open].from);
    }
    // Room to spare: the lines keep their usual distance.
    expect(railOf([3, 4], 1, 500).pitch).toBe(5);
  });

  it('places a built steered message where its row was measured, the estimate only for one not built', () => {
    const marks: NavMark[] = [
      { id: 'a', group: 0, steered: false, ts: 1, failed: false },
      { id: 'b', group: 0, steered: true, ts: 2, failed: false },
      { id: 'c', group: 1, steered: true, ts: 3, failed: false },
    ];
    const boxes = { top: Float64Array.from([0, 1000]), height: Float64Array.from([600, 400]) };
    const ys = placeMarks(marks, boxes, () => 0.5, (i) => (i === 1 ? 520 : undefined));
    // b: a checkpoint opened above it moved it to 520 (the estimate said 300); c is not built.
    expect(Array.from(ys)).toEqual([300, 520, 1200]);
  });

  it('notices a steered message that moved inside the newest turn', () => {
    expect(rowsMoved([120, 400], (i) => [120, 400][i])).toBe(false);
    expect(rowsMoved([120, 400], (i) => [120, 640][i])).toBe(true);
    expect(rowsMoved([120], () => undefined)).toBe(true);
  });

  it('makes only the index lines near the view, wherever the lit row is among 300', () => {
    const runs = [
      { from: 0, to: 15 },
      { from: 15, to: 300 },
    ];
    const all = Array.from({ length: 300 }, (_, i) => i);
    const lines = indexLines(runs, all, false);
    expect(lines.list).toHaveLength(302);
    expect(lines.headAt.get(1)).toBe(16);
    expect(lines.rowAt.get(15)).toBe(17);
    expect(lines.rowAt.get(299)).toBe(301);
    // A list 392px tall scrolled to row 250: a few dozen lines, around it.
    const w = indexWindow(4 + 250 * 28, 392, lines.list.length, 28, 4, 10);
    expect(w.to - w.from).toBeLessThanOrEqual(40);
    expect(w.from).toBeLessThanOrEqual(250);
    expect(w.to).toBeGreaterThan(250 + 14);
    // With something typed: the matches alone, no heads.
    const flat = indexLines(runs, [3, 200], true);
    expect(flat.list).toEqual([
      { kind: 'row', i: 3 },
      { kind: 'row', i: 200 },
    ]);
  });
});
