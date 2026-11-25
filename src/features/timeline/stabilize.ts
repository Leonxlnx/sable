import type { FlowChunk, Group, Segment, TurnGroup, TurnLayout } from './turns';

const sameIds = <T>(a?: readonly T[], b?: readonly T[]) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]));

function sameSegment(a: Segment, b: Segment, flow: FlowChunk[]) {
  return a.steered === b.steered && a.lead === b.lead && a.reply === b.reply && a.answer === b.answer &&
    a.last === b.last && a.steps === b.steps && sameIds(a.work, b.work) && sameIds(a.notes, b.notes) &&
    sameIds(a.narr, b.narr) && sameIds(a.tail, b.tail) && sameIds(a.errors, b.errors) &&
    a.flow.length === flow.length && a.flow.every((old, i) => {
      const current = flow[i];
      return old === current || (old.kind !== 'steps' && old.kind === current.kind && old.id === current.id);
    });
}

/** A turn `turnsIndex` handed back again, the same object (nothing in it changed): its stable object and its cache entries. */
export interface Kept {
  turn: TurnGroup;
  entries: [string, unknown][];
}

/**
 * Keeps the objects of turns and segments that did not change, so their memoized views skip
 * rendering: a new step in the running turn re-renders that turn alone. A turn the grouping kept
 * (`kept`) is not read again: its stable object and cache entries carry over as they are.
 */
export function stabilize(layout: TurnLayout, cache: Map<string, unknown>, kept: WeakMap<TurnGroup, Kept>): TurnLayout {
  const next = new Map<string, unknown>();
  const groups = layout.groups.map((g): Group => {
    if (g.kind !== 'turn') return g;
    const known = kept.get(g);
    if (known) {
      for (const [k, v] of known.entries) next.set(k, v);
      return known.turn;
    }
    const entries: [string, unknown][] = [];
    const put = (k: string, v: unknown) => {
      next.set(k, v);
      entries.push([k, v]);
    };
    const segments = g.segments.map((s) => {
      const k = 's|' + s.key;
      const prev = cache.get(k) as Segment | undefined;
      const flow = s.flow.map(c => keepChunk(c, cache, next, put));
      const seg = prev && sameSegment(prev, s, flow) ? prev : { ...s, flow };
      put(k, seg);
      return seg;
    });
    const k = 't|' + g.key;
    const prev = cache.get(k) as TurnGroup | undefined;
    const same = prev && prev.state === g.state && prev.end === g.end && prev.early === g.early && prev.next === g.next &&
      prev.liveSegment === g.liveSegment && sameIds(prev.ids, g.ids) && sameIds(prev.checks, g.checks) &&
      sameIds(prev.waiting, g.waiting) && sameIds(prev.segments, segments);
    const turn = same ? prev : { ...g, segments };
    put(k, turn);
    kept.set(g, { turn, entries });
    return turn;
  });
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  return { groups, queued: layout.queued };
}

/** A run of steps keeps its object while nothing joined it (including replacements while off screen), so its list skips rendering. */
function keepChunk(c: FlowChunk, cache: Map<string, unknown>, next: Map<string, unknown>, put: (k: string, v: unknown) => void): FlowChunk {
  if (c.kind !== 'steps') return c;
  const k = `c|${c.key}`;
  const old = (next.get(k) ?? cache.get(k)) as FlowChunk | undefined;
  const same = old?.kind === 'steps' && old.count === c.count && sameIds(old.ids, c.ids);
  const chunk = same ? old : c;
  put(k, chunk);
  return chunk;
}

