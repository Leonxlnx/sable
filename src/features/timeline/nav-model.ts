import type { TimelineItem, UserItem } from '@shared/protocol';
import { changesOf } from './changes';
import { shapeOf, type Group, type TurnGroup } from './turns';

/**
 * The conversation's map (the navigator along its right edge): one mark per message the person
 * sent, placed where that message stands in the scroller's content. Pure: the view hands in what
 * it measured, so this never reads the page.
 *
 * Positions are content offsets (px from the top of the scroller's content), the same space as
 * `scrollTop`; the view scales them to its track (`k = track / scrollHeight`).
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
  /** Files the turn changed (on the turn's first message only). */
  files: number;
}

type TurnMarks = Omit<NavMark, 'group'>[];

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
export function marksOf(
  groups: readonly Group[],
  items: Record<string, TimelineItem | undefined>,
  children: Record<string, string[] | undefined>,
  cache: WeakMap<TurnGroup, TurnMarks>,
  prev?: NavMark[],
): NavMark[] {
  const out: NavMark[] = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.kind !== 'turn') continue;
    let marks = cache.get(g);
    if (!marks) {
      marks = [];
      const work: string[] = [];
      for (const s of g.segments) for (const id of s.work) work.push(id);
      const files = changesOf(items, children, work).files;
      for (const s of g.segments) {
        if (!s.lead || !isMessage(items[s.lead])) continue;
        marks.push({ id: s.lead, steered: s.steered, files: marks.length ? 0 : files });
      }
      cache.set(g, marks);
    }
    for (const m of marks) out.push({ ...m, group: i });
  }
  if (prev && prev.length === out.length && prev.every((m, i) => m.id === out[i].id && m.group === out[i].group && m.files === out[i].files && m.steered === out[i].steered)) return prev;
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
 * Each mark's content offset: its group's top, or for a later segment's message, its estimated
 * place inside the group scaled to the group's height (`offsetIn`).
 */
export function placeMarks(marks: readonly NavMark[], boxes: { top: Float64Array; height: Float64Array }, offsetIn: (group: number, id: string) => number | undefined): Float64Array {
  const ys = new Float64Array(marks.length);
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const top = boxes.top[m.group] ?? 0;
    const f = offsetIn(m.group, m.id);
    ys[i] = f === undefined ? top : top + f * (boxes.height[m.group] ?? 0);
  }
  return ys;
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

export type TickKind = 'msg' | 'files' | 'wait';

export interface Tick {
  /** Px on the track. */
  y: number;
  kind: TickKind;
  /** Every message in it was steered into a turn (drawn shorter). */
  steered: boolean;
}

const RANK: Record<TickKind, number> = { msg: 0, files: 1, wait: 2 };

/**
 * Ticks to draw: marks closer than `gap` px on the track share one tick, which carries the
 * strongest kind among them (waiting, then files changed).
 */
export function ticksOf(ys: ArrayLike<number>, kindOf: (i: number) => TickKind, steeredOf: (i: number) => boolean, k: number, gap = 3): Tick[] {
  const out: Tick[] = [];
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i] * k;
    const kind = kindOf(i);
    const steered = steeredOf(i);
    const last = out[out.length - 1];
    if (last && y - last.y < gap) {
      if (RANK[kind] > RANK[last.kind]) last.kind = kind;
      last.steered &&= steered;
      continue;
    }
    out.push({ y, kind, steered });
  }
  return out;
}

/** Plain ticks (find results): one per `gap` px. */
export function rowsOf(ys: ArrayLike<number>, k: number, gap = 3): number[] {
  const out: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i] * k;
    if (out.length && y - out[out.length - 1] < gap) continue;
    out.push(y);
  }
  return out;
}

/** The mark nearest to `y` (same units as `ys`, which are in order) within `radius`, or -1. */
export function nearest(ys: ArrayLike<number>, y: number, radius: number): number {
  let lo = 0;
  let hi = ys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] < y) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let d = radius;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= ys.length) continue;
    const e = Math.abs(ys[i] - y);
    if (e <= d) {
      d = e;
      best = i;
    }
  }
  return best;
}

/**
 * The message to go to from the view (Alt+Up, Alt+Down): `line` is the reading line in content
 * offsets, `top` the view's top. Up from the middle of a long turn goes to the message that
 * started it first. Returns a mark index, or `marks.length` for the end of the conversation
 * (down from the last message), or -1 for nothing.
 */
export function stepTarget(ys: ArrayLike<number>, line: number, top: number, dir: 1 | -1): number {
  const n = ys.length;
  if (!n) return dir === 1 ? 0 : -1;
  // The message the view is at: the last one that starts above the reading line.
  let at = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (ys[i] < line) {
      at = i;
      break;
    }
  }
  if (dir === -1) {
    if (at >= 0 && ys[at] < top - 8) return at;
    return Math.max(0, at - 1);
  }
  return at + 1 >= n ? n : at + 1;
}

/** The first line of a message, for its preview. */
export function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const t = line.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
