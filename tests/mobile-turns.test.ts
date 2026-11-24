/**
 * The phone's copy of the turn grouping (mobile/src/lib/turns.ts) reads a conversation as the
 * desktop does (src/features/timeline/turns.ts): the same cases, run against the phone's module.
 * And a review message (src/features/review/model.ts) reads back on the phone as on the desktop,
 * also when the phone got it cut short (mobile/src/lib/review.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { transcript } from '../server/providers/codex-map';
import { RESUME_LOST, lostTasksNote } from '@shared/synthetic';
import type { TimelineItem } from '@shared/protocol';

// The phone imports the desktop's lead-in rules through its own alias.
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('@desk/features/review/model', async () => await import('../src/features/review/model'));
vi.mock('@desk/lib/word-diff', async () => await import('../src/lib/word-diff'));

// Loaded by a path the root type check does not follow: the phone's module resolves `@desk` through its own config.
type FlowChunk = { kind: 'text' | 'show'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number };
interface Segment {
  lead: string | null;
  steered: boolean;
  flow: FlowChunk[];
  work: string[];
  steps: number;
  answer: string | null;
  reply: string | null;
  last: string | null;
  tail: string[];
  notes: string[];
  errors: string[];
  narr: string[];
}
type TurnGroup = { kind: 'turn'; key: string; state: string; end: string | null; ids: string[]; segments: Segment[] };
type Group = TurnGroup | { kind: 'item'; id: string };
type Layout = { groups: Group[]; queued: string[] };
const TURNS = '../mobile/src/lib/turns';
const { groupTurns, shapeOf, stabilize } = (await import(/* @vite-ignore */ TURNS)) as {
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => Layout;
  shapeOf: (item: TimelineItem) => string;
  stabilize: (next: Layout, prev: Map<string, unknown>) => Layout;
};

function spec(s: string) {
  const parts = s.split(/\s+/).filter(Boolean);
  return { ids: parts.map((p) => p.slice(1)), shape: parts.map((p) => p[0]).join('') };
}
/** A flow in short: texts by id, shown pieces as `*id`, runs of steps as `[ids]`. */
const flowOf = (flow: FlowChunk[]) => flow.map((c) => (c.kind === 'steps' ? `[${c.ids.join(' ')}]` : c.kind === 'show' ? `*${c.id}` : c.id)).join(' ');
const turns = (s: string, busy = false) => {
  const { ids, shape } = spec(s);
  return groupTurns(ids, shape, busy);
};
const onlyTurn = (s: string, busy = false) => {
  const { groups } = turns(s, busy);
  expect(groups).toHaveLength(1);
  expect(groups[0].kind).toBe('turn');
  return groups[0] as TurnGroup;
};

describe('phone turns', () => {
  it('reads an agent switch as a line of its own that closes a turn', () => {
    const base = { id: 'x', ts: 0 };
    expect(shapeOf({ ...base, type: 'notice', variant: 'info', text: 'Switched to Codex', agentSwitch: { from: 'claude', to: 'codex' } } as TimelineItem)).toBe('Z');
    const { ids, shape } = spec('U1 w2 Z3 U4 t5 T6');
    const { groups } = groupTurns(ids, shape, false);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item', 'turn']);
  });

  it('answers a settled turn with its lead-in when nothing else was said', () => {
    const s = onlyTurn('U1 l2 w3 T4').segments[0];
    expect(s).toMatchObject({ answer: '2', work: ['3'], steps: 1 });
    expect(flowOf(s.flow)).toBe('2 [3]');
    expect(onlyTurn('U1 l2 w3 l4 w5 T6').segments[0]).toMatchObject({ answer: '4', work: ['2', '3', '5'] });
    expect(onlyTurn('U1 l2 w3', true).segments[0]).toMatchObject({ answer: null, work: ['2', '3'] });
    expect(onlyTurn('U1 t2 l3 w4 T5').segments[0]).toMatchObject({ answer: '2', work: ['3', '4'] });
    expect(onlyTurn('U1 l2 w3 F4').segments[0].answer).toBeNull();
  });

  it('keeps the last words in view under the report when a notice or a task list update follows them', () => {
    const s = onlyTurn('U1 t2 w3 l4 n5 T6').segments[0];
    expect(s).toMatchObject({ answer: '2', tail: ['4'], notes: [] });
    expect(flowOf(s.flow)).toBe('2 [3] 4 [5]');
    expect(onlyTurn('U1 w2 l3 k4 T5').segments[0]).toMatchObject({ answer: '3', work: ['2', '4'] });
    expect(onlyTurn('U1 w2 l3 h4 n5 T6').segments[0].answer).toBe('3');
    expect(onlyTurn('U1 t2 l3 n4 w5 T6').segments[0]).toMatchObject({ answer: '2', work: ['3', '4', '5'] });
    expect(onlyTurn('U1 t2 w3 l4 n5', true).segments[0].work).toEqual(['3', '4', '5']);
  });

  it('answers a settled turn from an earlier segment when the last one said nothing', () => {
    expect(onlyTurn('U1 w2 t3 S4 w5 w6 T7').segments.map((s) => s.answer)).toEqual(['3', null]);
    expect(onlyTurn('U1 w2 t3 S4 w5 w6', true).segments.map((s) => s.answer)).toEqual([null, null]);
    expect(onlyTurn('U1 w2 t3 S4 w5 t6 T7').segments.map((s) => s.answer)).toEqual([null, '6']);
  });

  it('always shows the reply to a steered message, even when it reads as a lead-in', () => {
    const t = onlyTurn('U1 w2 S3 l4 l5 w6 t7 T8');
    expect(t.segments[1]).toMatchObject({ reply: '4', answer: '7', work: ['5', '6'] });
    expect(flowOf(t.segments[1].flow)).toBe('4 [5 6] 7');
  });

  it('reads the low-confidence openers as reports, through the desktop rules', () => {
    const base = { id: 'x', ts: 0, type: 'text' as const, streaming: false };
    expect(shapeOf({ ...base, text: 'I should note the key is read from .env.' } as TimelineItem)).toBe('t');
    expect(shapeOf({ ...base, text: 'Looking at the logs, the guard throws before the handler runs.' } as TimelineItem)).toBe('t');
    expect(shapeOf({ ...base, text: 'Looking good, let me run the tests.' } as TimelineItem)).toBe('l');
  });

  it('reads the bare done-words as nods, through the desktop rules', () => {
    const base = { id: 'x', ts: 0, type: 'text' as const, streaming: false };
    for (const text of ['Committed.', 'Pushed.', 'Fixed.', 'All done.', 'Done.']) expect(shapeOf({ ...base, text } as TimelineItem)).toBe('l');
  });
});

describe('phone turns as checkpoints (the desktop since f79fd71)', () => {
  it('reads a turn as runs of steps, each closed by the note after it; the notes fold once it ends', () => {
    const t = onlyTurn('U1 w2 t3 w4 w5 w6 t7 w8 t9 T10');
    const s = t.segments[0];
    expect(flowOf(s.flow)).toBe('[2] 3 [4 5 6] 7 [8] 9');
    expect(s.flow.filter((c) => c.kind === 'steps').map((c) => (c as { count: number }).count)).toEqual([1, 3, 1]);
    expect(s).toMatchObject({ answer: '9', notes: ['3', '7'], steps: 5 });
    // With no work at all there is nothing to fold behind: the texts simply stand.
    expect(onlyTurn('U1 t2 t3 T4').segments[0]).toMatchObject({ notes: [], answer: '3' });
  });

  it('only ever grows at its end while it runs: a run, then what closed it', () => {
    const steps = ['U1', 'U1 t2', 'U1 t2 h3', 'U1 t2 h3 w4', 'U1 t2 h3 w4 t5', 'U1 t2 h3 w4 t5 w6', 'U1 t2 h3 w4 t5 w6 t7'];
    expect(steps.map((s) => flowOf(onlyTurn(s, true).segments[0].flow))).toEqual(['', '2', '2 [3]', '2 [3 4]', '2 [3 4] 5', '2 [3 4] 5 [6]', '2 [3 4] 5 [6] 7']);
    expect(onlyTurn('U1 t2 h3 w4 t5 w6 t7 T8').segments[0].notes).toEqual(['2', '5']);
  });

  it('stands the reply to a steered message right under it, whatever was still running', () => {
    const t = onlyTurn('U1 w2 S3 w4 t5 w6 t7 t8 T9');
    expect(t.segments[1]).toMatchObject({ reply: '5', answer: '8', work: ['4', '6'], notes: ['7'] });
    expect(flowOf(t.segments[1].flow)).toBe('5 [4 6] 7 8');
    const flows = ['U1 w2 S3', 'U1 w2 S3 w4', 'U1 w2 S3 w4 t5', 'U1 w2 S3 w4 t5 w6'].map((s) => flowOf(onlyTurn(s, true).segments[1].flow));
    expect(flows).toEqual(['', '[4]', '5 [4]', '5 [4 6]']);
  });

  it('puts errors in the flow where they happened, and keeps the last words of a failed turn in view', () => {
    expect(flowOf(onlyTurn('U1 w2 e3').segments[0].flow)).toBe('[2] *3');
    expect(flowOf(onlyTurn('U1 e2 w3 t4 T5').segments[0].flow)).toBe('*2 [3] 4');
    const f = onlyTurn('U1 w2 t3 w4 t5 F6').segments[0];
    expect(f).toMatchObject({ answer: null, last: '5', notes: ['3'] });
    // A warning stands in the flow like an error and is no failure (the desktop's rule, `shared/notice.ts`).
    expect(shapeOf({ id: 'x', ts: 0, type: 'notice', variant: 'error', text: 'A hook was skipped', level: 'warn' })).toBe('a');
    expect(shapeOf({ id: 'x', ts: 0, type: 'notice', variant: 'error', text: 'Boom' })).toBe('e');
    expect(onlyTurn('U1 w2 a3 T4')).toMatchObject({ state: 'done' });
    expect(onlyTurn('U1 w2 e3 T4')).toMatchObject({ state: 'failed' });
    expect(flowOf(onlyTurn('U1 w2 a3 T4').segments[0].flow)).toBe('[2] *3');
    expect(onlyTurn('U1 w2 a3 T4').segments[0].errors).toEqual([]);
    // A notice that is all the turn holds shows, but is not an error (the footer still says a failure).
    expect(onlyTurn('U1 n2 T3').segments[0]).toMatchObject({ errors: [], work: [] });
    expect(onlyTurn('U1 n2 T3').segments[0].flow).toEqual([{ kind: 'show', id: '2' }]);
  });

  it('keeps the report the answer when a nod follows it, with or without steps between', () => {
    expect(onlyTurn('U1 w2 t3 l4 T5').segments[0]).toMatchObject({ answer: '3', tail: ['4'], notes: [] });
    expect(onlyTurn('U1 w2 t3 w4 t5 w6 l7 T8').segments[0]).toMatchObject({ answer: '5', tail: ['7'], notes: ['3'] });
    expect(onlyTurn('U1 w2 p3 l4 T5').segments[0]).toMatchObject({ answer: '3', tail: ['4'] });
    expect(onlyTurn('U1 w2 S3 t4 w5 l6 T7').segments[1]).toMatchObject({ reply: null, answer: '4', tail: ['6'] });
    expect(onlyTurn('U1 w2 t3 w4 l5 i6').segments[0]).toMatchObject({ answer: '3', tail: ['5'] });
    expect(onlyTurn('U1 w2 t3 w4 t5 l6 e7 F8').segments[0]).toMatchObject({ answer: null, last: '5', tail: ['6'], notes: ['3'] });
    // Running, the nod waits in the work for a step.
    expect(onlyTurn('U1 w2 t3 w4 l5', true).segments[0]).toMatchObject({ answer: null, tail: [], work: ['2', '4', '5'] });
  });

  it('opens a turn of its own for work no message opened', () => {
    const { groups } = turns('U1 t2 T3 N4 t5 T6 h7 t8 w9 w10 h11 w12', true);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'turn', 'turn']);
    const own = groups[2] as TurnGroup;
    expect(own).toMatchObject({ key: '7', state: 'running', ids: ['7', '8', '9', '10', '11', '12'] });
    expect(own.segments[0]).toMatchObject({ lead: null, work: ['7', '9', '10', '11', '12'], steps: 3 });
    expect(turns('n0 U1 t2 T3 n4 e5 w6 t7 T8').groups.map((g) => (g.kind === 'item' ? g.id : `turn:${g.key}`))).toEqual(['0', 'turn:1', '4', '5', 'turn:6']);
  });

  it('keeps the objects of checkpoints that did not change when a step joins the live one', () => {
    const kept = new Map<string, unknown>();
    const a = stabilize(turns('U1 w2 t3 w4', true), kept);
    const b = stabilize(turns('U1 w2 t3 w4 w5', true), kept);
    const runs = (l: Layout) => (l.groups[0] as TurnGroup).segments[0].flow.filter((c) => c.kind === 'steps');
    expect(runs(b)[0]).toBe(runs(a)[0]);
    expect(runs(b)[1]).not.toBe(runs(a)[1]);
    // Nothing changed: the same turn.
    expect(stabilize(turns('U1 w2 t3 w4 w5', true), kept).groups[0]).toBe(b.groups[0]);
  });
});

describe('a review message on the phone', async () => {
  const { reviewMessage } = await import('../src/features/review/model');
  const REVIEW = '../mobile/src/lib/review';
  const { readReview, changesHeading } = (await import(/* @vite-ignore */ REVIEW)) as {
    changesHeading: (lead?: TimelineItem) => string;
    readReview: (text: string, cut?: boolean) => { lead: string; comments: { path: string; range?: string; text: string }[]; more?: boolean } | null;
  };
  const comment = (i: number, text = `Comment ${i}`) => ({
    id: `c${i}`,
    scope: 'git:a.ts',
    path: `src/f${i}.ts`,
    at: i,
    text,
    lines: [{ t: '+' as const, text: `line ${i}`, neu: 10 + i }],
  });

  it('shows what was typed and each comment by its file and lines, as the desktop does', () => {
    const r = readReview(reviewMessage([comment(1), comment(2, 'Two\n\nparagraphs')], 'Please fix these'));
    expect(r?.lead).toBe('Please fix these');
    expect(r?.comments.map((c) => [c.path, c.range, c.text])).toEqual([
      ['src/f1.ts', 'line 11', 'Comment 1'],
      ['src/f2.ts', 'line 12', 'Two\n\nparagraphs'],
    ]);
    expect(r?.more).toBeUndefined();
  });

  it('heads a reloaded Codex recovery edit with This turn', () => {
    const items = transcript([{ id: 'turn', status: 'completed', items: [
      { type: 'userMessage', id: 'wake', content: [{ type: 'text', text: RESUME_LOST + lostTasksNote(['fixture']) }] },
      { type: 'fileChange', id: 'edit', status: 'completed', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: 'fixture' }] },
    ] }] as Parameters<typeof transcript>[0]);
    expect(items[1]).toMatchObject({ type: 'tool' });
    expect(changesHeading(items[0])).toBe('This turn');
    expect(changesHeading({ ...items[0], type: 'user', text: 'My own heading' })).toBe('My own heading');
  });

  it('leaves every other message alone', () => {
    expect(readReview('Review of your changes, please')).toBeNull();
    expect(readReview('refactor the session module')).toBeNull();
  });

  it('keeps the whole comments of a review the phone got cut short, and says there is more', () => {
    const text = reviewMessage([comment(1), comment(2), comment(3)]);
    // Cut inside the third comment's quoted lines (its fence never closes).
    const cut = text.slice(0, text.indexOf('+line 3') + 4);
    expect(readReview(cut, false)).toBeNull();
    const r = readReview(cut, true);
    expect(r?.comments.map((c) => c.path)).toEqual(['src/f1.ts', 'src/f2.ts']);
    expect(r?.more).toBe(true);
  });
});

describe("phone turns with what Claude Code writes in the person's place", () => {
  const user = (text: string, extra: Record<string, unknown> = {}) => ({ id: 'x', ts: 0, type: 'user', text, state: 'sent', ...extra }) as TimelineItem;
  const NOTE = '<task-notification>\n<status>completed</status>\n<summary>Agent "Review" completed</summary>\n<result>Two findings';

  it('reads them as the desktop does, a message the phone got cut short too', () => {
    expect(shapeOf(user(NOTE, { cut: true }))).toBe('N');
    expect(shapeOf(user('<command-name>/model</command-name><command-args>opus</command-args>'))).toBe('U');
    // What a command printed is command output (in view in its place); a compaction's summary keeps its own path.
    expect(shapeOf(user('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'))).toBe('c');
    expect(shapeOf(user('<local-command-stderr>Migration failed</local-command-stderr>'))).toBe('c');
    expect(shapeOf(user('This session is being continued from a previous conversation that ran out of context.'))).toBe('n');
    expect(shapeOf(user('<local-command-caveat>Caveat: x</local-command-caveat>'))).toBe('u');
    expect(shapeOf(user('Build it'))).toBe('U');
  });

  it('opens a turn with a notification, the next one after nothing a turn of its own, and gives one taken mid-turn a segment', () => {
    const two = (s: string) => {
      const { ids, shape } = spec(s);
      return groupTurns(ids, shape, false).groups;
    };
    // A notification turn that holds nothing woke no work: the next one begins its own (window-F3, day 7).
    const g = two('U1 t2 T3 N4 N5 t6 T7');
    expect(g).toHaveLength(3);
    expect((g[2] as TurnGroup).segments.map((s) => s.answer)).toEqual(['6']);
    const t = onlyTurn('U1 w2 N3 w4 t5 T6');
    expect(t.segments.map((s) => s.answer)).toEqual([null, '5']);
    expect(two('U1 w2 i3 N4 t5 T6')).toHaveLength(2);
  });

  it('shows a command with its output and nothing for the caveat before it', () => {
    const { ids, shape } = spec('U1 t2 T3 u4 U5 c6 T7');
    const { groups } = groupTurns(ids, shape, false);
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ kind: 'turn', key: '5' });
    // Its output stays in view beside a step, never folded with the work.
    const seg = onlyTurn('U1 w2 c3 w4 t5 T6').segments[0];
    expect(flowOf(seg.flow)).toBe('[2] *3 [4] 5');
    expect(seg.notes).toEqual([]);
    const reminder = spec('U1 t2 T3 u4 w5 t6 T7');
    expect(groupTurns(reminder.ids, reminder.shape, false).groups).toHaveLength(2);
    const alone = spec('U1 t2 T3 u4');
    expect(groupTurns(alone.ids, alone.shape, false).groups).toHaveLength(1);
  });
});

describe("a comment on a diff from the phone's Changes view", async () => {
  const model = await import('../src/features/review/model');
  const ROWS = '../mobile/src/lib/diff-rows';
  type Row = { t: ' ' | '+' | '-' | 'sep'; text: string; old?: number; neu?: number; marks?: [number, number][] };
  const { diffRows, hunkIndex, rowNumber } = (await import(/* @vite-ignore */ ROWS)) as {
    diffRows: (d: unknown) => { rows: Row[]; lines: number; digits: number };
    hunkIndex: (rows: Row[], numbered: boolean) => number[];
    rowNumber: (r: Row) => number | undefined;
  };
  // Two hunks of one file: a line changed near the top (one line added), one removed further down.
  const diff = {
    path: 'src/server/session.ts',
    status: 'modified',
    additions: 2,
    deletions: 2,
    hunks: [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' import a;', "-const ttl = 30;", "+const ttl = 60;", '+const grace = 5;', ' '] },
      { oldStart: 20, oldLines: 2, newStart: 21, newLines: 1, lines: [' function close() {', '-  log();'] },
    ],
  };

  it('numbers each line as the gutter shows it, counts the gap in the same numbers and marks the changed words', () => {
    const { rows, lines } = diffRows(diff);
    expect(lines).toBe(7);
    expect(rows.map((r) => (r.t === 'sep' ? r.text : `${r.t}${rowNumber(r)}`))).toEqual([' 1', '-2', '+2', '+3', ' 4', 'Lines 5–20 unchanged', ' 21', '-21']);
    expect(rows[1].marks).toEqual([[12, 14]]);
    expect(rows[2].marks).toEqual([[12, 14]]);
  });

  it('keeps a picked range inside its hunk and makes the desktop’s own review message', () => {
    const { rows } = diffRows(diff);
    const hunks = hunkIndex(rows, true);
    // A first tap on line 2 (removed), a second past the gap: the range stops at the hunk's end.
    expect(model.clampToHunk(hunks, 1, 7)).toBe(4);
    const lines = model.linesOf(rows, 1, 3, true);
    expect(model.rangeLabel(lines)).toBe('lines 2–3');
    const text = model.reviewMessage([{ id: 'c1', scope: 'git:src/server/session.ts', path: 'src/server/session.ts', lines, text: 'Keep 30 for the CLI.', at: 1 }], 'One thing');
    expect(text).toBe('One thing\n\nReview of your changes:\n\n1. src/server/session.ts, lines 2–3\n```diff\n-const ttl = 30;\n+const ttl = 60;\n+const grace = 5;\n```\nKeep 30 for the CLI.');
    expect(model.parseReview(text)?.comments[0]).toMatchObject({ path: 'src/server/session.ts', range: 'lines 2–3', text: 'Keep 30 for the CLI.' });
    // The comment finds its lines again after the diff is read anew.
    expect(model.locate(diffRows(diff).rows, lines)).toEqual([1, 3]);
  });

  it('without the file’s own numbers: no gaps, one hunk, nothing numbered in the message', () => {
    const { rows } = diffRows(diff);
    const flat = hunkIndex(rows, false);
    expect(new Set(flat.filter((h) => h >= 0))).toEqual(new Set([0]));
    const lines = model.linesOf(rows, 6, 7, false);
    expect(lines.every((l) => l.old === undefined && l.neu === undefined)).toBe(true);
    expect(model.reviewMessage([{ id: 'c', scope: 'edits:x', path: 'x.ts', lines, text: 'Why?', at: 1 }])).toContain('1. x.ts\n```diff');
  });

  it('a deleted file counts its gaps in the numbers it had', () => {
    const gone = { path: 'old.ts', status: 'deleted', additions: 0, deletions: 3, hunks: [{ oldStart: 4, oldLines: 3, newStart: 0, newLines: 0, lines: ['-a', '-b', '-c'] }] };
    expect(diffRows(gone).rows.map((r) => (r.t === 'sep' ? r.text : `${r.t}${rowNumber(r)}`))).toEqual(['Lines 1–3 unchanged', '-4', '-5', '-6']);
  });
});

// ── the review's phone findings (eleventh pass): picks, downloads, streaming cost ──

type Field = 'model' | 'effort' | 'speed' | 'mode';
interface IntentsLike {
  heard(id: string, from: Record<string, unknown>): void;
  pick(id: string, field: Field, value: unknown, before: unknown): number;
  accepted(id: string, field: Field, value: unknown): void;
  refused(id: string, field: Field, gen: number): { value: unknown } | null;
  sieve<T extends Record<string, unknown>>(id: string, patch: T): T;
  over<T extends Record<string, unknown> & { id: string }>(meta: T): T;
  waiting(id: string, field: Field): unknown;
}
const INTENTS = '../mobile/src/lib/intents';
const { Intents } = (await import(/* @vite-ignore */ INTENTS)) as { Intents: new (ms?: number, now?: () => number) => IntentsLike };

describe("the phone's picks (model, effort, speed, mode)", () => {
  it('a late failure of an older pick never rolls back a newer accepted one', () => {
    const p = new Intents();
    p.heard('c', { mode: 'default' });
    const first = p.pick('c', 'mode', 'acceptEdits', 'default');
    const second = p.pick('c', 'mode', 'bypassPermissions', 'acceptEdits');
    p.accepted('c', 'mode', 'bypassPermissions');
    // The first request times out after the second was accepted: nothing changes.
    expect(p.refused('c', 'mode', first)).toBeNull();
    expect(p.waiting('c', 'mode')).toBe('bypassPermissions');
    // The newest pick refused goes back to what the desktop last said (the accepted pick), not to what was shown before it.
    const third = p.pick('c', 'mode', 'plan', 'bypassPermissions');
    expect(p.refused('c', 'mode', third)).toEqual({ value: 'bypassPermissions' });
    expect(p.refused('c', 'mode', second)).toBeNull();
  });

  it('holds a pick against older updates, lets go when confirmed, and goes back to the latest word of the desktop', () => {
    let t = 0;
    const p = new Intents(6000, () => t);
    const gen = p.pick('c', 'effort', 'high', 'medium');
    // An update from before the pick: the field is held; other fields pass.
    expect(p.sieve('c', { effort: 'low', title: 'x' })).toEqual({ title: 'x' });
    expect(p.over({ id: 'c', effort: 'low', model: 'm' })).toMatchObject({ effort: 'high', model: 'm' });
    // Refused: what the desktop said last (low), not what was shown when the pick was made (medium).
    expect(p.refused('c', 'effort', gen)).toEqual({ value: 'low' });
    // Confirmed by an update: it lets go; an expired pick does too.
    p.pick('c', 'speed', 'fast', undefined);
    expect(p.sieve('c', { speed: 'fast' })).toEqual({ speed: 'fast' });
    expect(p.waiting('c', 'speed')).toBeUndefined();
    p.pick('c', 'model', 'big', 'small');
    t = 7000;
    expect(p.sieve('c', { model: 'small' })).toEqual({ model: 'small' });
  });
});

type DL = { state: string; id?: string; attempt?: number; bytes?: number };
interface Core {
  get(key: string): DL;
  set(key: string, d: DL): void;
  size(): number;
  resume(): void;
  start(key: string, p: { sid: string; itemId: string; index: number; name: string }): Promise<void>;
  cancel(key: string): Promise<void>;
}
const CORE = '../mobile/src/lib/download-core';
const { createDownloads, KEEP, POLL } = (await import(/* @vite-ignore */ CORE)) as {
  createDownloads: (deps: Record<string, unknown>) => Core;
  KEEP: number;
  POLL: { moving: number; paused: number };
};

/** A promise and its resolve, to answer when the test says so. */
function later<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const FILE = { sid: 's', itemId: 'i', index: 0, name: 'app.apk' };

describe('downloads on the phone', () => {
  it('a Stop while the desktop prepares the link ends that attempt: nothing starts later', async () => {
    const link = later<{ url: string }>();
    const download = vi.fn(async () => ({ id: 'n1' }));
    const d = createDownloads({ plugin: { download, status: vi.fn(), cancel: vi.fn(async () => {}) }, link: () => link.promise, native: true });
    const started = d.start('k', FILE);
    expect(d.get('k').state).toBe('asking');
    await d.cancel('k');
    link.resolve({ url: 'http://desk/f/t/app.apk' });
    await started;
    expect(download).not.toHaveBeenCalled();
    expect(d.get('k').state).toBe('idle');
  });

  it('a native download made after its attempt was stopped is removed again', async () => {
    const made = later<{ id: string }>();
    const cancel = vi.fn(async () => {});
    const d = createDownloads({ plugin: { download: () => made.promise, status: vi.fn(), cancel }, link: async () => ({ url: 'http://desk/f' }), native: true });
    const started = d.start('k', FILE);
    await tick();
    await d.cancel('k');
    made.resolve({ id: 'late' });
    await started;
    expect(cancel).toHaveBeenCalledWith({ id: 'late' });
    expect(d.get('k').state).toBe('idle');
  });

  it('an older status reply never lands over a newer attempt', async () => {
    const replies: { promise: Promise<{ state: string; bytes?: number }>; resolve: (v: { state: string; bytes?: number }) => void }[] = [];
    const status = vi.fn(() => {
      const r = later<{ state: string; bytes?: number }>();
      replies.push(r);
      return r.promise;
    });
    let n = 0;
    const d = createDownloads({ plugin: { download: async () => ({ id: `n${++n}` }), status, cancel: async () => {} }, link: async () => ({ url: 'http://desk/f' }), native: true, sleep: () => new Promise(() => {}) });
    await d.start('k', FILE);
    await tick();
    expect(status).toHaveBeenCalledTimes(1);
    // Stopped and started again while the first read is out.
    await d.cancel('k');
    await d.start('k', FILE);
    expect(d.get('k')).toMatchObject({ state: 'pending', id: 'n2' });
    replies[0].resolve({ state: 'done', bytes: 9 });
    await tick();
    expect(d.get('k')).toMatchObject({ state: 'pending', id: 'n2' });
  });

  it('one awaited loop: slower while paused, none in the background; storage written only when it changed; at most KEEP entries', async () => {
    const waits: number[] = [];
    let hidden = false;
    const gate: { resolve: (v: void) => void }[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      const g = later<void>();
      gate.push(g);
      return g.promise;
    };
    const states = [
      { state: 'running', bytes: 1, total: 10 },
      { state: 'running', bytes: 5, total: 10 },
      { state: 'paused', bytes: 5, total: 10 },
    ];
    const status = vi.fn(async () => states.shift() ?? { state: 'paused', bytes: 5, total: 10 });
    const writes: string[] = [];
    const d = createDownloads({
      plugin: { download: async () => ({ id: 'n1' }), status, cancel: async () => {} },
      link: async () => ({ url: 'http://desk/f' }),
      native: true,
      sleep,
      hidden: () => hidden,
      storage: { get: () => null, set: (v: string) => writes.push(v) },
    });
    await d.start('k', FILE);
    for (let i = 0; i < 3; i++) {
      await tick();
      gate.shift()?.resolve();
    }
    await tick();
    expect(waits.slice(0, 3)).toEqual([POLL.moving, POLL.moving, POLL.paused]);
    // Bytes moving are not written: only the start (pending), running, and paused.
    expect(writes.map((w) => JSON.parse(w).k.state)).toEqual(['pending', 'running', 'paused']);
    // In the background the loop ends at its next turn: no more reads.
    hidden = true;
    const reads = status.mock.calls.length;
    gate.shift()?.resolve();
    await tick();
    await tick();
    expect(status.mock.calls.length).toBe(reads);
    // The history is capped in memory too (an entry at work is never dropped).
    for (let i = 0; i < KEEP + 15; i++) d.set(`done${i}`, { state: 'done', id: `x${i}` });
    expect(d.size()).toBeLessThanOrEqual(KEEP);
    expect(d.get('k').state).toBe('paused');
  });
});

describe('streaming cost on the phone', async () => {
  const { reshape, shapeString } = (await import(/* @vite-ignore */ TURNS)) as {
    reshape: (shape: string, roots: string[], items: Record<string, TimelineItem>, ids: Iterable<string>) => string;
    shapeString: (roots: string[], items: Record<string, TimelineItem>) => string;
  };
  it('the shape is read again only for the items that changed', () => {
    const items: Record<string, TimelineItem> = {};
    const roots: string[] = [];
    for (let t = 0; t < 300; t++) {
      for (const it of [
        { id: `u${t}`, ts: 0, type: 'user', text: 'go' },
        { id: `w${t}`, ts: 0, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {} },
        { id: `a${t}`, ts: 0, type: 'text', text: 'Done. Everything passes.', streaming: false },
        { id: `e${t}`, ts: 0, type: 'turn', durationMs: 1 },
      ] as TimelineItem[]) {
        items[it.id] = it;
        roots.push(it.id);
      }
    }
    const shape = shapeString(roots, items);
    // The newest answer streams on: its item is replaced.
    const next: Record<string, TimelineItem> = { ...items, a299: { ...items.a299, text: 'Done. Everything passes, and more words arrive.', streaming: true } as TimelineItem };
    const read = new Set<string>();
    const watched = new Proxy(next, { get: (o, k) => (read.add(String(k)), o[k as string]) });
    expect(reshape(shape, roots, watched, ['a299'])).toBe(shapeString(roots, next));
    expect([...read]).toEqual(['a299']);
    // A step that becomes another kind of row changes its character in place.
    const changed: Record<string, TimelineItem> = { ...next, w5: { ...next.w5, check: { turn: 'u5', agent: 'codex' } } as unknown as TimelineItem };
    const again = reshape(shape, roots, changed, ['w5']);
    expect(again).toBe(shapeString(roots, { ...items, w5: changed.w5 }));
    expect(again).not.toBe(shape);
  });
});

describe('phone turns: nothing the person must read folds away (review wave 9, as the desktop)', () => {
  it('keeps a report as the answer when a steered message is answered by a nod', () => {
    const t = onlyTurn('U1 w2 t3 S4 l5 T6');
    expect(t.segments[0]).toMatchObject({ answer: '3', notes: [] });
    expect(t.segments[1]).toMatchObject({ lead: '4', reply: '5', answer: null, notes: [] });
    const n = onlyTurn('U1 w2 t3 N4 w5 l6 T7');
    expect(n.segments[0].answer).toBe('3');
    expect(n.segments[1]).toMatchObject({ answer: null, tail: ['6'] });
    expect(onlyTurn('U1 w2 t3 S4 w5 t6 T7').segments[1].answer).toBe('6');
  });

  it('keeps the last report in view over a failure that came after a steer', () => {
    const t = onlyTurn('U1 w2 t3 S4 w5 e6 F7');
    expect(t.segments[0]).toMatchObject({ last: '3', notes: [] });
    expect(t.segments[1].errors).toEqual(['6']);
  });

  it('never takes a notice in view for the failure shown', () => {
    expect(onlyTurn('U1 n2 F3').segments.some((s) => s.errors.length)).toBe(false);
    expect(onlyTurn('U1 w2 e3 F4').segments[0].errors).toEqual(['3']);
  });

  it('gives a rewind its own line, out of the turn it cut', () => {
    expect(shapeOf({ id: 'x', ts: 0, type: 'notice', variant: 'rewind', text: 'Rewound the conversation', detail: 'Files could not be restored.' } as TimelineItem)).toBe('Z');
    expect(turns('U1 w2 t3 S4 w5 Z6').groups.map((g) => g.kind)).toEqual(['turn', 'item']);
  });

  it('keeps a checkpoint the same checkpoint when the lead-in that opened it becomes the answer', () => {
    const keyOf = (t: TurnGroup) => t.segments[0].flow.flatMap((c) => (c.kind === 'steps' && c.ids.includes('5') ? [c.key] : []))[0];
    const live = onlyTurn('U1 w2 g3 l4 w5', true);
    const done = onlyTurn('U1 w2 g3 l4 w5 T6');
    expect(done.segments[0].answer).toBe('4');
    expect(keyOf(live)).toBe('5');
    expect(keyOf(done)).toBe('5');
  });
});
