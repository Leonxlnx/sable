/**
 * The phone after review wave 10 (findings 10, 12, 13, 17, 18):
 * - 10: what a command printed (`<local-command-stdout>` / `-stderr>`) is command output: in view in
 *   its place, never folded with the work; a compaction's summary keeps its own path (a notice);
 * - 12: the conversation goes to its end only for a message this phone sent or steered just now;
 * - 13: a search hit whose words are not in the cut text the phone got fetches the item whole;
 * - 17: a step's own disclosure is remembered per chat and item, its fetched detail kept (bounded);
 * - 18: an item of a type the phone does not know has a shape of its own and stays in its place,
 *   also inside a turn.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

import * as rules from '../mobile/src/lib/chat-rules';

// Loaded by a path the root type check does not follow (the phone has its own config).
const at = (name: string) => `../mobile/src/lib/${name}`;
type Chunk = { kind: 'text' | 'show'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number };
interface Seg {
  flow: Chunk[];
  work: string[];
  notes: string[];
  answer: string | null;
}
type Group = { kind: 'turn'; key: string; segments: Seg[]; ids: string[] } | { kind: 'item'; key: string; id: string };
const turns = (await import(/* @vite-ignore */ at('turns'))) as {
  shapeOf: (it: TimelineItem | undefined) => string;
  shapeString: (roots: string[], items: Record<string, TimelineItem>) => string;
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => { groups: Group[]; queued: string[] };
};
const follow = (await import(/* @vite-ignore */ at('follow'))) as {
  SENT_HERE_MS: number;
  sentHere: (sid: string, now?: number) => void;
  notSentHere: (sid: string) => void;
  takeSentHere: (sid: string, now?: number) => boolean;
};
const folds = (await import(/* @vite-ignore */ at('folds'))) as {
  DETAILS_MAX: number;
  stepKey: (sid: string, id: string) => string;
  foldKey: (sid: string, turn: string, piece?: string) => string;
  wasOpen: (k: string) => boolean;
  keepOpen: (k: string, on: boolean) => void;
  keptDetail: <T>(sid: string, id: string) => T | undefined;
  keepDetail: (sid: string, id: string, item: unknown) => void;
};
const forget = (await import(/* @vite-ignore */ at('forget'))) as { runForget: () => Promise<number> };

let n = 0;
const user = (text: string) => ({ id: `u${++n}`, ts: n, type: 'user', text }) as TimelineItem;
const tool = () => ({ id: `w${++n}`, ts: n, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {} }) as unknown as TimelineItem;
const text = (t: string) => ({ id: `t${++n}`, ts: n, type: 'text', text: t, streaming: false }) as TimelineItem;
const end = () => ({ id: `e${++n}`, ts: n, type: 'turn', durationMs: 10 }) as unknown as TimelineItem;

function layout(list: TimelineItem[], busy = false) {
  const items = Object.fromEntries(list.map((i) => [i.id, i]));
  const roots = list.map((i) => i.id);
  return turns.groupTurns(roots, turns.shapeString(roots, items), busy);
}
const shown = (s: Seg) => s.flow.filter((c) => c.kind === 'show').map((c) => (c as { id: string }).id);

describe('#10 a command printed is command output', () => {
  it('takes the command output shape, and stays in view beside a step', () => {
    const out = user('<local-command-stderr>Migration failed</local-command-stderr>');
    expect(turns.shapeOf(out)).toBe('c');
    expect(turns.shapeOf(user('<local-command-stdout>Set model to Opus</local-command-stdout>'))).toBe('c');
    const msg = user('Run the migration');
    const step = tool();
    const { groups } = layout([msg, step, out, text('I will look into the failure next time.'), end()]);
    const t = groups[0] as Extract<Group, { kind: 'turn' }>;
    expect(t.kind).toBe('turn');
    const seg = t.segments[0];
    expect(shown(seg)).toContain(out.id);
    expect(seg.work).not.toContain(out.id);
    expect(seg.notes).not.toContain(out.id);
  });

  it('keeps a compaction summary on its own path', () => {
    const summary = user('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.');
    expect(turns.shapeOf(summary)).not.toBe('c');
  });
});

describe('#18 an item of a type the phone does not know', () => {
  const odd = (id: string) => ({ id, ts: 0, type: 'hologram', text: 'from a newer desktop' }) as unknown as TimelineItem;

  it('has a shape of its own', () => {
    expect(turns.shapeOf(odd('x1'))).toBe('?');
    expect(turns.shapeOf(undefined)).toBe('.');
  });

  it('stays in its place inside a turn, between the steps, never folded', () => {
    const msg = user('Do it');
    const a = tool();
    const x = odd('x2');
    const b = tool();
    const { groups } = layout([msg, a, x, b, text('Done with the change, all tests pass.'), end()]);
    expect(groups).toHaveLength(1);
    const seg = (groups[0] as Extract<Group, { kind: 'turn' }>).segments[0];
    expect(seg.flow.map((c) => c.kind)).toEqual(['steps', 'show', 'steps', 'text']);
    expect(shown(seg)).toEqual(['x2']);
    expect(seg.work).not.toContain('x2');
  });

  it('is a row of its own between turns', () => {
    const first = [user('One'), text('First answer, all good.'), end()];
    const { groups } = layout([...first, odd('x3'), user('Two'), text('Second answer, fine.'), end()]);
    expect(groups.map((g) => (g.kind === 'item' ? g.id : 'turn'))).toEqual(['turn', 'x3', 'turn']);
  });
});

describe('#12 only a message sent here pulls the view down', () => {
  it('takes a fresh mark once', () => {
    follow.sentHere('s1', 1000);
    expect(follow.takeSentHere('s2', 1001)).toBe(false);
    expect(follow.takeSentHere('s1', 1500)).toBe(true);
    expect(follow.takeSentHere('s1', 1600)).toBe(false);
  });

  it('a queued or refused send takes its mark back; an old mark counts for nothing', () => {
    follow.sentHere('s1', 0);
    follow.notSentHere('s1');
    expect(follow.takeSentHere('s1', 10)).toBe(false);
    follow.sentHere('s1', 0);
    expect(follow.takeSentHere('s1', follow.SENT_HERE_MS + 1)).toBe(false);
  });

  it('a queued message starting (no mark) leaves the reader where they are', () => {
    const prev = { id: 'a', ts: 1 };
    const next = { id: 'b', ts: 2 };
    expect(rules.followSent(prev, next) && follow.takeSentHere('s3')).toBe(false);
    follow.sentHere('s3');
    expect(rules.followSent(prev, next) && follow.takeSentHere('s3')).toBe(true);
  });
});

describe('#13 a search hit past the cut', () => {
  it('fetches the item whole only when the words were not found in a cut item', () => {
    const cut = { ...text('a long report'), cut: true } as unknown as TimelineItem;
    expect(rules.wholeForFind(cut, false)).toBe(true);
    expect(rules.wholeForFind(cut, true)).toBe(false);
    expect(rules.wholeForFind(text('whole'), false)).toBe(false);
    expect(rules.wholeForFind({ ...cut, streaming: true } as unknown as TimelineItem, false)).toBe(false);
    expect(rules.wholeForFind({ ...user('a long message'), cut: true } as unknown as TimelineItem, false)).toBe(true);
    expect(rules.wholeForFind(undefined, false)).toBe(false);
  });
});

describe("#17 a step's own disclosure", () => {
  it('is remembered per chat and item, apart from the checkpoints', () => {
    const k = folds.stepKey('s1', 'w9');
    expect(k).not.toBe(folds.stepKey('s2', 'w9'));
    expect(k).not.toBe(folds.foldKey('s1', 'w9'));
    expect(k).not.toBe(folds.foldKey('s1', '', 'w9'));
    folds.keepOpen(k, true);
    expect(folds.wasOpen(k)).toBe(true);
    folds.keepOpen(k, false);
    expect(folds.wasOpen(k)).toBe(false);
  });

  it('keeps fetched details, the newest few, and lets them go with the desktop', async () => {
    folds.keepDetail('s1', 'first', { id: 'first' });
    for (let i = 0; i < folds.DETAILS_MAX - 1; i++) folds.keepDetail('s1', `d${i}`, { id: i });
    expect(folds.keptDetail('s1', 'first')).toEqual({ id: 'first' });
    folds.keepDetail('s1', 'one more', { id: 'more' });
    expect(folds.keptDetail('s1', 'first')).toBeUndefined();
    expect(folds.keptDetail('s1', 'one more')).toEqual({ id: 'more' });
    expect(folds.keptDetail('s2', 'one more')).toBeUndefined();
    await forget.runForget();
    expect(folds.keptDetail('s1', 'one more')).toBeUndefined();
  });
});
