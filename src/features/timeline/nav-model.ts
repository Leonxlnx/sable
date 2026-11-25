import type { TimelineItem, UserItem } from '@shared/protocol';
import { shapeOf, type Group, type TurnGroup } from './turns';

/**
 * The conversation's navigator (the rail at its right edge and the index it opens): one mark per
 * message the person sent, the marks gathered into runs (messages sent close together), the rail
 * that draws them (every run a stack, the one being read fanned out into its messages), and where
 * each message stands in the scroller's content. Pure: the view hands in what it measured, so this
 * never reads the page.
 *
 * Positions of messages are content offsets (px from the top of the scroller's content), the same
 * space as `scrollTop`; positions on the rail are px from the top of the stack.
 */

/** A rough height for an item that is not built yet (items.tsx `estimate`), handed in so this stays pure. */
export type Estimate = (item: TimelineItem | undefined) => number;

/** A work line's height: a checkpoint's, the live line's, a finished turn's one line. */
const LINE_H = 34;

/**
 * A group's estimated height, as the spacer for unbuilt groups counts it, and where in it each of
 * its items starts (`at`). A finished turn is its messages, one line for everything folded behind
 * it (every run of steps, every note along the way, a notification taken up mid-turn: all placed
 * at that line) and what never folds; a running turn shows a line per checkpoint with its note,
 * and the live line.
 */
export function groupHeight(g: Group, items: Record<string, TimelineItem | undefined>, est: Estimate, at?: (id: string, y: number) => void): number {
  if (g.kind === 'item') {
    at?.(g.id, 0);
    return est(items[g.id]);
  }
  const running = g.state === 'running';
  let h = 0;
  // The finished turn's line is counted once, where its first folded piece stands.
  let lined = false;
  const fold = () => {
    if (lined) return;
    lined = true;
    h += LINE_H;
  };
  for (const s of g.segments) {
    if (s.lead) {
      at?.(s.lead, h);
      // A notification after the line is one more folded piece; a message never folds.
      if (running || !lined || s.steered) h += est(items[s.lead]);
    }
    for (const c of s.flow) {
      if (c.kind === 'steps') {
        if (running) h += LINE_H;
        else fold();
        if (at) for (const id of c.ids) at(id, h);
      } else if (!running && c.kind === 'text' && s.notes.includes(c.id)) {
        fold();
        at?.(c.id, h);
      } else {
        at?.(c.id, h);
        h += s.errors.includes(c.id) ? 64 : est(items[c.id]);
      }
    }
  }
  if (running) h += LINE_H;
  // The foot under the answer.
  return h + 30 + (g.checks?.length ?? 0) * 80;
}

export interface NavMark {
  /** The message (a user item). */
  id: string;
  /** Its group's index in the layout. */
  group: number;
  /** Sent into a running turn: a later segment of its turn (or a turn it opened). */
  steered: boolean;
  /** When it was sent (ms since epoch). */
  ts: number;
  /** Its turn ended in an error (on the turn's last message only). */
  failed: boolean;
}

type TurnMarks = Omit<NavMark, 'group'>[];

// listFor owns the strong references to kept turns. A remount shares their
// navigator work, and dropping a list also releases its marks and estimates.
const turnCache = new WeakMap<TurnGroup, TurnMarks>();
const shapes = new WeakMap<Group, { h: number; at: Map<string, number> }>();

export function navigatorShape(g: Group, items: Record<string, TimelineItem | undefined>, estimate: Estimate) {
  let shape = shapes.get(g);
  if (!shape) {
    const at = new Map<string, number>();
    const h = groupHeight(g, items, estimate, (id, y) => at.set(id, y));
    shapes.set(g, shape = { h, at });
  }
  return shape;
}

/**
 * A message the person sent (or one steered into a turn), taken by the agent: not one Sable sent
 * for an until check, nor one the agent's harness wrote in their place (its shape is not a message's).
 */
const isMessage = (it: TimelineItem | undefined): it is UserItem => {
  if (it?.type !== 'user' || it.until || it.state === 'queued') return false;
  const ch = shapeOf(it);
  return ch === 'U' || ch === 'S';
};

/**
 * The marks of a layout, in order. A turn's marks are kept per turn object (`cache`): the layout
 * keeps the objects of turns that did not change, so a new step re-reads the running turn alone.
 * Returns `prev` itself when nothing changed, so a view can skip its work.
 */
export function marksOf(groups: readonly Group[], items: Record<string, TimelineItem | undefined>, cache: WeakMap<TurnGroup, TurnMarks> = turnCache, prev?: NavMark[]): NavMark[] {
  const out: NavMark[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.kind !== 'turn') continue;
    let marks = cache.get(g);
    if (!marks) {
      marks = [];
      for (const s of g.segments) {
        const it = s.lead ? items[s.lead] : undefined;
        if (!isMessage(it)) continue;
        marks.push({ id: it.id, steered: s.steered, ts: it.ts, failed: false });
      }
      if (g.state === 'failed' && marks.length) marks[marks.length - 1].failed = true;
      cache.set(g, marks);
    }
    for (const m of marks) out.push({ ...m, group: i });
  }
  if (prev && prev.length === out.length && prev.every((m, i) => m.id === out[i].id && m.group === out[i].group && m.failed === out[i].failed && m.steered === out[i].steered && m.ts === out[i].ts)) return prev;
  return out;
}

/**
 * Which groups are built: `[0, lead)` wait behind the first spacer, `[gapFrom, hidden)` behind the
 * second (between a run built around a jump and the newest turns), everything else is built.
 */
export interface Built {
  lead: number;
  gapFrom: number;
  hidden: number;
}

export const isBuilt = (b: Built, i: number) => i >= b.hidden || (i >= b.lead && i < b.gapFrom);

/** What the view measured: the spacers and the built groups' boxes, in content offsets. */
export interface Measured {
  older: { top: number; height: number } | null;
  gap: { top: number; height: number } | null;
  /** The box of a built group's element, by group index; undefined when it has none (a row that draws nothing). */
  box: (i: number) => { top: number; height: number } | undefined;
}

/**
 * Where groups start and how tall they are: built ones as measured, the ones behind a spacer by
 * their estimates, scaled so they fill the spacer exactly as drawn.
 */
export function groupBoxes(groups: readonly Group[], built: Built, m: Measured, heightOf: (i: number) => number): { top: Float64Array; height: Float64Array } {
  const n = groups.length;
  const top = new Float64Array(n);
  const height = new Float64Array(n);
  const fill = (from: number, to: number, space: { top: number; height: number } | null) => {
    if (from >= to) return;
    let sum = 0;
    for (let i = from; i < to; i++) {
      height[i] = heightOf(i);
      sum += height[i];
    }
    const at = space?.top ?? 0;
    const k = space && sum > 0 ? space.height / sum : 1;
    let y = at;
    for (let i = from; i < to; i++) {
      top[i] = y;
      height[i] *= k;
      y += height[i];
    }
  };
  fill(0, Math.min(built.lead, n), m.older);
  fill(Math.min(built.gapFrom, n), Math.min(built.hidden, n), m.gap);
  // A built group that draws nothing stands where the previous one ends.
  let end = 0;
  for (let i = 0; i < n; i++) {
    if (!isBuilt(built, i)) {
      end = top[i] + height[i];
      continue;
    }
    const b = m.box(i);
    top[i] = b ? b.top : end;
    height[i] = b ? b.height : 0;
    end = top[i] + height[i];
  }
  return { top, height };
}

/** The group standing at a content offset (the last whose top is at or above it), or -1 above the first. */
export function groupAt(top: ArrayLike<number>, y: number): number {
  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Each mark's content offset: where its row was measured (`exact`: a message's row that is built),
 * else its group's top, or for a later segment's message its estimated place inside the group
 * scaled to the group's height (`offsetIn`). Estimates are only for rows that are not built: a
 * checkpoint opened above a steered message moves its row, and only the row itself says where.
 */
export function placeMarks(
  marks: readonly NavMark[],
  boxes: { top: Float64Array; height: Float64Array },
  offsetIn: (group: number, id: string) => number | undefined,
  exact?: (mark: number) => number | undefined,
): Float64Array {
  const ys = new Float64Array(marks.length);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const y = exact?.(i);
    if (y !== undefined) {
      ys[i] = y;
      continue;
    }
    const top = boxes.top[m.group] ?? 0;
    const f = offsetIn(m.group, m.id);
    ys[i] = f === undefined ? top : top + f * (boxes.height[m.group] ?? 0);
  }
  return ys;
}

/**
 * Whether rows measured inside a group have moved since (`was`, their offsets then; `now` reads
 * one again, undefined when it is gone): the group's own top stays put when a fold opens inside
 * it, so its steered messages are looked at themselves.
 */
export function rowsMoved(was: readonly number[], now: (i: number) => number | undefined): boolean {
  for (let i = 0; i < was.length; i++) {
    const y = now(i);
    if (y === undefined || Math.abs(y - was[i]) >= 0.5) return true;
  }
  return false;
}

/** Where an item stands inside its group, as a fraction of the group's estimated height (`groupHeight`). */
export function fractionIn(g: Group, id: string, items: Record<string, TimelineItem | undefined>, est: Estimate): number | undefined {
  let y: number | undefined;
  const total = groupHeight(g, items, est, (at, off) => {
    if (at === id && y === undefined) y = off;
  });
  if (y === undefined || total <= 0) return undefined;
  return y / total;
}

/** A message that has been jumped to stands this close under the landing line (px). */
const LANDED = 8;

/**
 * The message the view is at: the first one standing in the upper part of the view, from the
 * landing line (`top`, where a jump puts a message) down to the reading line (`line`); when none
 * does, the last one above (the view is inside its turn). -1 above the first message.
 */
export function markAt(ys: ArrayLike<number>, line: number, top: number): number {
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] < top - LANDED) lo = mid + 1;
    else hi = mid;
  }
  return lo < ys.length && ys[lo] < line ? lo : lo - 1;
}

/**
 * The message to go to from the view (Alt+Up, Alt+Down), counted from the one the view is at
 * (`markAt`), so short turns that share a view are stepped through one by one. Up from the middle
 * of a long turn goes to the message that started it first. Returns a mark index, or
 * `marks.length` for the end of the conversation (down from the last message), or -1 for nothing.
 */
export function stepTarget(ys: ArrayLike<number>, line: number, top: number, dir: 1 | -1): number {
  const n = ys.length;
  if (!n) return dir === 1 ? 0 : -1;
  const at = markAt(ys, line, top);
  if (dir === -1) {
    if (at >= 0 && ys[at] < top - LANDED) return at;
    return Math.max(0, at - 1);
  }
  return at + 1 >= n ? n : at + 1;
}

// ── runs: messages sent close together ──

/** A run of messages: marks `[from, to)`. */
export interface NavRun {
  from: number;
  to: number;
}

/** A pause this long between two messages starts a new run (ms). */
export const PAUSE = 60 * 60_000;
/** The rail holds this many runs at most. */
export const RUNS_MAX = 16;
/** A run longer than one and a half of this is cut into pieces of it. */
export const RUN_SIZE = 24;

/** How many pieces a run of `n` is cut into: whole pieces of `size` from its start, the last up to one and a half. */
const pieces = (n: number, size: number) => (n <= size * 1.5 ? 1 : Math.ceil((n - size * 1.5) / size) + 1);

/**
 * The runs of a conversation, from the times its messages were sent: a new run starts after a
 * pause (a sitting of work is one run), a very long sitting is cut into pieces, and there are
 * never more than `max`: only the longest pauses count then, and the pieces grow. Runs are cut
 * from their start, so a conversation that grows keeps the runs it has.
 */
export function runsOf(ts: ArrayLike<number>, max = RUNS_MAX, size = RUN_SIZE, pause = PAUSE): NavRun[] {
  const n = ts.length;
  if (!n) return [];
  let starts: number[] = [];
  for (let i = 1; i < n; i++) if (ts[i] - ts[i - 1] >= pause) starts.push(i);
  if (starts.length > max - 1) {
    starts = starts
      .sort((a, b) => ts[b] - ts[b - 1] - (ts[a] - ts[a - 1]) || a - b)
      .slice(0, Math.max(0, max - 1))
      .sort((a, b) => a - b);
  }
  const spans: NavRun[] = [];
  let from = 0;
  for (const s of starts) {
    spans.push({ from, to: s });
    from = s;
  }
  spans.push({ from, to: n });
  let cut = Math.max(1, size);
  const count = () => spans.reduce((c, r) => c + pieces(r.to - r.from, cut), 0);
  while (count() > max && cut < n) cut = Math.ceil(cut * 1.25);
  const out: NavRun[] = [];
  for (const r of spans) {
    let at = r.from;
    for (let k = pieces(r.to - r.from, cut); k > 1; k--) {
      out.push({ from: at, to: at + cut });
      at += cut;
    }
    out.push({ from: at, to: r.to });
  }
  return out;
}

/** The run a mark is in (runs are in order and cover every mark), or -1. */
export function runOf(runs: readonly NavRun[], mark: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (mark < runs[mid].from) hi = mid - 1;
    else if (mark >= runs[mid].to) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ── the rail ──

/** Between two runs on the rail (px). */
/** The rail shows once the conversation is this many views tall, and hides again below `RAIL_HIDE`. */
export const RAIL_SHOW = 2;
export const RAIL_HIDE = 1.8;
/**
 * The fewest messages the rail is worth showing for. With one or two, one message is always in
 * view or a scroll away, and two short dashes at the stage's edge read as a stray glyph: the rail
 * says nothing until it has something to say.
 */
export const RAIL_MARKS = 3;

/** Whether the rail shows: a conversation long enough to need it (`shown`: it shows now, so it hides only a little lower). */
export function railShown(scrollHeight: number, viewHeight: number, marks: number, shown: boolean): boolean {
  if (viewHeight <= 0 || marks < RAIL_MARKS) return false;
  return scrollHeight > (shown ? RAIL_HIDE : RAIL_SHOW) * viewHeight;
}

export const RAIL_GAP = 6;
/** Between two messages of the open run (px), and the least when the rail runs out of track. */
const PITCH = 5;
const PITCH_MIN = 3;
/** A run of one is the line of its message. */
const LINE = 2;

/** A closed run's height on the rail: a stack that grows slowly with what it holds. */
export const stackHeight = (n: number) => (n < 2 ? LINE : Math.round(4 + 2 * Math.sqrt(n)));

export interface Rail {
  /** The whole stack's height. */
  h: number;
  /** Each run's top and height, from the top of the stack. */
  top: number[];
  height: number[];
  /** The distance between two messages of the open run. */
  pitch: number;
}

/** The least share of their height the closed stacks and the gaps keep when the track runs out. */
const SHRINK_MIN = 0.4;

/**
 * The rail: the runs under each other, each closed one a stack, the open one (`open`, -1 for
 * none) fanned out into a line per message. When the track is too short for it, the open run's
 * lines close up first (to `PITCH_MIN`), then the stacks and the gaps shrink; when even that is not
 * enough (a sitting of hundreds of messages), the lines close up further, so the rail never runs
 * past its track.
 */
export function railOf(sizes: readonly number[], open: number, track: number): Rail {
  const count = sizes.length;
  const n = open >= 0 && open < count ? sizes[open] : 0;
  let rest = Math.max(0, count - 1) * RAIL_GAP;
  for (let i = 0; i < count; i++) if (i !== open) rest += stackHeight(sizes[i]);
  let pitch = PITCH;
  if (n > 1 && rest + n * pitch > track) pitch = Math.max(PITCH_MIN, Math.min(PITCH, Math.floor((track - rest) / n)));
  let openH = n > 1 ? n * pitch : n === 1 ? LINE : 0;
  const k = rest > 0 && rest + openH > track ? Math.max(SHRINK_MIN, (track - openH) / rest) : 1;
  const gap = Math.max(2, Math.round(RAIL_GAP * k));
  // The rest of the rail as drawn (stacks and gaps at their share): what is left of the track is the open run's.
  let others = Math.max(0, count - 1) * gap;
  for (let i = 0; i < count; i++) if (i !== open) others += Math.max(LINE, Math.round(stackHeight(sizes[i]) * k));
  if (n > 1 && track > 0 && others + openH > track) {
    pitch = Math.max(0.25, (track - others) / n);
    openH = n * pitch;
  }
  const top: number[] = [];
  const height: number[] = [];
  let y = 0;
  for (let i = 0; i < count; i++) {
    const h = i === open ? openH : Math.max(LINE, Math.round(stackHeight(sizes[i]) * k));
    top.push(y);
    height.push(h);
    y += h + (i < count - 1 ? gap : 0);
  }
  return { h: y, top, height, pitch };
}

/** Where a message stands on the rail: its line in the open run, its share of a closed stack. */
export function markY(rail: Rail, runs: readonly NavRun[], mark: number): number {
  const r = runOf(runs, mark);
  if (r < 0) return 0;
  const { from, to } = runs[r];
  return rail.top[r] + ((mark - from + 0.5) / (to - from)) * rail.height[r];
}

/**
 * What a place on the rail (px from the top of the stack) points at: the nearest run, and the
 * message there: in the open run the one whose line it is, in a closed run its first.
 */
export function railAt(rail: Rail, runs: readonly NavRun[], open: number, y: number): { run: number; mark: number } | null {
  if (!runs.length) return null;
  let run = 0;
  for (let i = 1; i < runs.length; i++) {
    // Half of the gap above a run belongs to it.
    if (y < (rail.top[i - 1] + rail.height[i - 1] + rail.top[i]) / 2) break;
    run = i;
  }
  const { from, to } = runs[run];
  if (run !== open || to - from < 2) return { run, mark: from };
  const at = Math.floor((y - rail.top[run]) / (rail.pitch || 1));
  return { run, mark: from + Math.max(0, Math.min(to - from - 1, at)) };
}

// ── the index ──

/** A line of the index's grid: a run's head (when it began) or a message's row; every line is one row tall. */
export type IndexLine = { kind: 'head'; run: number } | { kind: 'row'; i: number };

/**
 * The index as lines of its grid: every run's head and its rows, or with something typed (`flat`)
 * the matching rows alone (`order`), and where each row and head stands (the line's number).
 */
export function indexLines(runs: readonly NavRun[], order: readonly number[], flat: boolean): { list: IndexLine[]; rowAt: Map<number, number>; headAt: Map<number, number> } {
  const list: IndexLine[] = [];
  const rowAt = new Map<number, number>();
  const headAt = new Map<number, number>();
  if (flat) {
    for (const i of order) {
      rowAt.set(i, list.length);
      list.push({ kind: 'row', i });
    }
    return { list, rowAt, headAt };
  }
  runs.forEach((r, k) => {
    headAt.set(k, list.length);
    list.push({ kind: 'head', run: k });
    for (let i = r.from; i < r.to; i++) {
      rowAt.set(i, list.length);
      list.push({ kind: 'row', i });
    }
  });
  return { list, rowAt, headAt };
}

/** The lines of a list of `n` (each `row` tall, after `pad`) to make for a view scrolled to `top`, `height` tall: those in it and `over` more on each side. */
export function indexWindow(top: number, height: number, n: number, row: number, pad: number, over: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(n, Math.floor((top - pad) / row) - over));
  return { from, to: Math.min(n, from + Math.ceil(height / row) + over * 2) };
}

// ── words ──

/** The first line of a message, as its row in the index reads. */
export function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * A message against what was typed into the index: every word typed must be in it, case aside.
 * Returns the line to show (the first line when a word is in it, otherwise the first line that
 * has one, cut to start a little before the word when it stands far in) and which of its
 * characters to mark; null when the message does not match.
 */
export function matchPrompt(text: string, query: string, max = 140): { line: string; indices: number[] } | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { line: firstLine(text, max), indices: [] };
  const lower = text.toLowerCase();
  if (!words.every((w) => lower.includes(w))) return null;
  const lines = text.split('\n').filter((l) => l.trim());
  const has = (l: string) => {
    const t = l.toLowerCase();
    return words.some((w) => t.includes(w));
  };
  const full = ((lines.length && has(lines[0]) ? lines[0] : lines.find(has)) ?? lines[0] ?? '').trim();
  const low = full.toLowerCase();
  let first = -1;
  for (const w of words) {
    const at = low.indexOf(w);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  // A word far into a long line: the line starts a few words before it.
  let start = 0;
  if (first > max - 24) {
    start = Math.max(0, first - 18);
    const space = full.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  const body = full.slice(start, start + max - 1).trimEnd();
  const line = `${start > 0 ? '…' : ''}${body}${start + body.length < full.length ? '…' : ''}`;
  const shown = line.toLowerCase();
  const marked = new Set<number>();
  for (const w of words) {
    for (let at = shown.indexOf(w); at >= 0; at = shown.indexOf(w, at + w.length)) for (let i = 0; i < w.length; i++) marked.add(at + i);
  }
  return { line, indices: [...marked].sort((a, b) => a - b) };
}
