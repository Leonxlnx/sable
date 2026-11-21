import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ThinkingItem, TimelineItem, ToolItem } from '@shared/protocol';
import { Tiles } from '@/art/Logo';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { showRailTab } from '@/state/actions';
import { useStore, type Store } from '@/state/store';
import { useFresh, useItem, useTimeline } from './ctx';
import { foldKey, setFold, useFold } from './fold';
import { ItemList, ItemRow, estimate } from './items';
import { REVEAL_EVENT, rootOf, type RevealDetail } from './reveal';
import { changesOf } from './changes';
import { Tail } from './Tail';
import { TurnFoot } from './Turn';
import { shapeIndex, turnsIndex, type FlowChunk, type Group, type Segment, type StepsChunk, type TurnGroup, type TurnLayout } from './turns';
import { leadTitle } from './lead-in';
import { groupHeight } from './nav-model';
import { stallAt } from './stall';
import { shortDuration, thinkingHeadline, useHeld, useTick } from './util';

/** Groups built when a transcript opens, and how many more each step up builds. */
const TAIL = 8;
const CHUNK = 8;
/**
 * Older groups built ahead of the reader in idle moments, a few at a time, up to this many beyond
 * the tail: scrolling up finds them built instead of building a chunk under a moving scroll.
 */
const AHEAD = 56;
const IDLE_CHUNK = 2;
/** How long the view must have been still before building ahead (ms). */
const STILL_MS = 400;
/**
 * A message far up that is asked for (a jump from the map, a find, Alt+Up) is built with a few
 * groups before it and more after it (what the view shows under it), as a run of its own, instead
 * of every turn from it down to the newest: a second spacer stands for the groups between, built
 * as the reader scrolls toward them.
 */
const BEFORE = 6;
const AFTER = 6;
/** A message this close to what is built already (groups) joins it instead. */
const REACH = 16;
/** How far beyond the view the spacers start building (px). */
const MARGIN = 1500;

interface BuiltState {
  /** Groups before this one are not built (null: not decided yet, the last `TAIL` are). */
  hidden: number | null;
  /** A run built on its own around a message far up: groups [from, to), short of `hidden`. */
  win: { from: number; to: number } | null;
}

/** A run that has reached the newest turns joins them. */
function settle(b: BuiltState): BuiltState {
  if (b.win && b.hidden !== null && b.win.to >= b.hidden) return { hidden: Math.min(b.hidden, b.win.from), win: null };
  return b;
}

const chunkSig = (c: FlowChunk) => (c.kind === 'steps' ? `${c.key}+${c.ids.length}+${c.count}` : c.id);
const segSig = (s: Segment) => `${s.lead}>${s.flow.map(chunkSig).join(',')}>${s.reply}>${s.answer}>${s.last}>${s.tail.join(',')}>${s.notes.length}>${s.errors.join(',')}`;

/** A turn `turnsIndex` handed back again, the same object (nothing in it changed): its stable object and its cache entries. */
interface Kept {
  turn: TurnGroup;
  entries: [string, unknown][];
}

/**
 * Keeps the objects of turns and segments that did not change, so their memoized views skip
 * rendering: a new step in the running turn re-renders that turn alone. A turn the grouping kept
 * (`kept`) is not read again: its stable object and cache entries carry over as they are.
 */
function stabilize(layout: TurnLayout, cache: Map<string, unknown>, kept: WeakMap<TurnGroup, Kept>): TurnLayout {
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
      const k = `s|${segSig(s)}`;
      const prev = (next.get(k) ?? cache.get(k)) as Segment | undefined;
      const seg = prev ?? { ...s, flow: s.flow.map((c) => keepChunk(c, cache, next, put)) };
      if (prev) for (const c of prev.flow) if (c.kind === 'steps') put(`c|${c.key}`, c);
      put(k, seg);
      return seg;
    });
    const k = `t|${g.state}|${g.end}|${g.ids.length}|${g.checks?.join(',') ?? ''}|${segments.map(segSig).join(';')}`;
    const prev = (next.get(k) ?? cache.get(k)) as TurnGroup | undefined;
    const turn = prev ?? { ...g, segments };
    put(k, turn);
    kept.set(g, { turn, entries });
    return turn;
  });
  cache.clear();
  for (const [k, v] of next) cache.set(k, v);
  return { groups, queued: layout.queued };
}

/** A run of steps keeps its object while nothing joined it (ids only ever append), so its list skips rendering. */
function keepChunk(c: FlowChunk, cache: Map<string, unknown>, next: Map<string, unknown>, put: (k: string, v: unknown) => void): FlowChunk {
  if (c.kind !== 'steps') return c;
  const k = `c|${c.key}`;
  const old = (next.get(k) ?? cache.get(k)) as FlowChunk | undefined;
  const same = old?.kind === 'steps' && old.count === c.count && old.ids.length === c.ids.length && old.ids[old.ids.length - 1] === c.ids[c.ids.length - 1];
  const chunk = same ? old : c;
  put(k, chunk);
  return chunk;
}

/** The estimated height of groups [from, to), as their spacer stands for them. */
function spanHeight(groups: readonly Group[], from: number, to: number, sessionId: string): number {
  if (from >= to) return 0;
  const items = useStore.getState().data[sessionId]?.items ?? {};
  let h = 0;
  for (let i = from; i < to; i++) h += groupHeight(groups[i], items, estimate);
  return h;
}

/**
 * The conversation as turns: each message, one quiet line for the work behind it (its checkpoints
 * while the turn runs), and the answer. A long transcript opens with only its last turns built; the ones above wait
 * behind a spacer of about their height and are built a few at a time as the reader scrolls up.
 * A message far up that is asked for is built with a few turns around it, as a run of its own (see
 * `BEFORE`, `AFTER`), so a jump there never builds the whole conversation at once.
 */
export const TurnList = memo(function TurnList({ ids }: { ids: string[] }) {
  const { sessionId, scrolled, nav } = useTimeline();
  // One character per root item (see `turns.ts`), following the items write by write: a streamed
  // word re-reads the item it grew, not every root.
  const [shapes] = useState(shapeIndex);
  const shape = useStore(useMemo(() => (s: Store) => shapes(s.data[sessionId], ids), [shapes, sessionId, ids]));
  const busy = useStore((s) => {
    const st = s.sessions[sessionId]?.status;
    return st === 'running' || st === 'starting' || st === 'awaiting';
  });
  const cache = useRef(new Map<string, unknown>());
  // The grouping, regrouping only from the last message the timeline has not changed before (a new
  // step regroups the running turn, not the conversation), and the turns it kept.
  const [grouping] = useState(turnsIndex);
  const [kept] = useState(() => new WeakMap<TurnGroup, Kept>());
  const layout = useMemo(() => {
    // The turn a check belongs to never changes, so reading it here (once per shape) is enough.
    const items = useStore.getState().data[sessionId]?.items;
    const checkOf = (id: string) => (items?.[id] as ToolItem | undefined)?.check?.turn;
    return stabilize(grouping(ids, shape, busy, checkOf), cache.current, kept);
  }, [grouping, kept, ids, shape, busy, sessionId]);
  const groups = layout.groups;
  const running = busy && groups.some((g) => g.kind === 'turn' && g.state === 'running');

  const [built, setBuilt] = useState<BuiltState>({ hidden: null, win: null });
  const size = useRef(groups.length);
  size.current = groups.length;
  /** A state's first built group of the newest turns: decided, and within the groups there are. */
  const hiddenOf = (b: BuiltState) => Math.min(size.current, b.hidden ?? Math.max(0, size.current - TAIL));
  const hidden = hiddenOf(built);
  const win = built.win && built.win.from < built.win.to ? built.win : null;
  // Groups before `lead` wait behind the first spacer, groups [gapFrom, hidden) behind the second
  // (between a run built around a message far up and the newest turns); the rest are built.
  const lead = win ? Math.min(win.from, hidden) : hidden;
  const gapFrom = win && win.to < hidden ? win.to : hidden;
  useEffect(() => {
    if (built.hidden === null) {
      if (groups.length) setBuilt((b) => (b.hidden === null ? { ...b, hidden } : b));
    }
    // A run that has reached the newest turns joins them.
    else if (built.win && built.win.to >= hidden) setBuilt((b) => (b.win ? { hidden: Math.min(hiddenOf(b), b.win.from), win: null } : b));
  }, [built, groups.length, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // The conversation's map follows what is built (after the commit, so it can measure it).
  useEffect(() => {
    nav?.set({ groups, built: { lead, gapFrom, hidden } });
  }, [nav, groups, lead, gapFrom, hidden]);

  const spacer = useRef<HTMLDivElement>(null);
  const spacerHeight = useMemo(() => spanHeight(groups, 0, lead, sessionId), [lead, groups, sessionId]);
  const gap = useRef<HTMLDivElement>(null);
  const gapHeight = useMemo(() => spanHeight(groups, gapFrom, hidden, sessionId), [gapFrom, hidden, groups, sessionId]);

  useEffect(() => {
    const el = spacer.current;
    if (!el || !lead) return;
    // Interruptible: a chunk built under a moving scroll yields to its frames. Above a run built
    // around a message, the run grows up; otherwise the newest turns do.
    const io = new IntersectionObserver(
      (entries) =>
        entries[0]?.isIntersecting &&
        startTransition(() =>
          setBuilt((b) => {
            const h = hiddenOf(b);
            if (b.win && b.win.to < h) return { hidden: h, win: { ...b.win, from: Math.max(0, b.win.from - CHUNK) } };
            return { hidden: Math.max(0, (b.win ? Math.min(b.win.from, h) : h) - CHUNK), win: null };
          }),
        ),
      { root: el.closest('.tl-scroll'), rootMargin: `${MARGIN}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [lead, hidden]);

  // The second spacer: coming down from the run above it, the run grows down; coming up from the
  // newest turns (or dropped into its middle), the newest turns grow up, as under the first one.
  useEffect(() => {
    const el = gap.current;
    if (!el || gapFrom >= hidden) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (!e?.isIntersecting) return;
        const down = e.rootBounds ? e.boundingClientRect.top > e.rootBounds.top + MARGIN : false;
        startTransition(() =>
          setBuilt((b) => {
            const h = hiddenOf(b);
            if (!b.win || b.win.to >= h) return b;
            // What is left between them is short: all of it.
            if (h - b.win.to <= CHUNK) return { hidden: b.win.from, win: null };
            return down ? { hidden: h, win: { ...b.win, to: b.win.to + CHUNK } } : { hidden: h - CHUNK, win: b.win };
          }),
        );
      },
      { root: el.closest('.tl-scroll'), rootMargin: `${MARGIN}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [gapFrom, hidden]);

  // Ahead of the reader: in idle moments the nearest older groups are built a couple at a time (off
  // screen they skip layout and paint), so reading back up never waits for a chunk to build.
  // Never under a moving scroll (its idle moments between frames are not idle for the reader): the
  // build waits until the view has been still a moment.
  useEffect(() => {
    if (!hidden || groups.length - hidden >= TAIL + AHEAD || typeof requestIdleCallback !== 'function') return;
    let id = 0;
    const build = () => {
      if (performance.now() - (scrolled?.current ?? 0) < STILL_MS) return void (id = requestIdleCallback(build, { timeout: 4000 }));
      startTransition(() => setBuilt((b) => settle({ ...b, hidden: Math.max(0, hiddenOf(b) - IDLE_CHUNK) })));
    };
    id = requestIdleCallback(build, { timeout: 4000 });
    return () => cancelIdleCallback(id);
  }, [hidden, groups.length, scrolled]);

  // Reveal requests (sable:reveal-item): build the target (with every turn from it down when it is
  // near, as a run of its own when it is far up), open the steps that hide it, then bring it into
  // view (unless the caller scrolls itself: `quiet`).
  const [reveal, setReveal] = useState<{ id: string; root: string; at: number; quiet?: boolean } | null>(null);
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent<RevealDetail>).detail;
      if (!d || d.sessionId !== sessionId) return;
      const root = rootOf(useStore.getState().data[sessionId]?.items ?? {}, d.itemId);
      const idx = groups.findIndex((g) => (g.kind === 'item' ? g.id === root : g.ids.includes(root) || !!g.checks?.includes(root)));
      if (idx < 0) return;
      const g = groups[idx];
      // Inside a turn's fold: the turn's line opens, and the run that holds a step.
      if (g.kind === 'turn') {
        for (const seg of g.segments) {
          const run = seg.flow.find((c): c is StepsChunk => c.kind === 'steps' && c.ids.includes(root));
          const lead = seg.lead === root && !seg.steered && seg !== g.segments[0];
          if (!run && !lead && !seg.notes.includes(root)) continue;
          setFold(foldKey(sessionId, g.key), true);
          if (run) setFold(foldKey(sessionId, run.key, 'run'), true);
        }
      }
      setBuilt((b) => {
        const h = hiddenOf(b);
        const w = b.win;
        if (idx >= h || (w && idx >= w.from && idx < w.to)) return b.hidden === h ? b : { hidden: h, win: w };
        // Near the newest turns: build down to it, with a few above.
        if (h - idx <= REACH) return settle({ hidden: Math.max(0, idx - BEFORE), win: w });
        // Near the run built before: the run grows to it.
        if (w && idx >= w.from - REACH && idx < w.to + REACH) return settle({ hidden: h, win: { from: Math.min(w.from, Math.max(0, idx - BEFORE)), to: Math.max(w.to, idx + AFTER) } });
        return settle({ hidden: h, win: { from: Math.max(0, idx - BEFORE), to: Math.min(h, idx + AFTER) } });
      });
      setReveal({ id: d.itemId, root, at: Date.now(), quiet: d.quiet });
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, [sessionId, groups]);

  useLayoutEffect(() => {
    if (!reveal || reveal.quiet) return;
    let raf = 0;
    let tries = 0;
    let fix = 0;
    let clear = 0;
    const find = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)].find((el) => el.closest('.tl-scroll'));
    // Folds mount their content a frame or two after they open: look until it is there.
    const go = () => {
      const el = find(reveal.id) ?? find(reveal.root);
      if (!el) {
        if (++tries < 30) raf = requestAnimationFrame(go);
        return;
      }
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      el.removeAttribute('data-reveal');
      void el.offsetWidth;
      el.setAttribute('data-reveal', '');
      fix = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) el.scrollIntoView({ block: 'center' });
      }, 700);
      clear = window.setTimeout(() => el.removeAttribute('data-reveal'), 1800);
    };
    go();
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fix);
      window.clearTimeout(clear);
    };
  }, [reveal]);

  const rows: ReactNode[] = [];
  for (let i = lead; i < groups.length; i++) {
    if (i === gapFrom && gapFrom < hidden) {
      rows.push(<div key="gap" ref={gap} className="tl-gap" style={{ height: gapHeight }} aria-hidden />);
      i = hidden - 1;
      continue;
    }
    const g = groups[i];
    rows.push(g.kind === 'item' ? <ItemRow key={g.key} id={g.id} /> : <TurnView key={g.key} turn={g} />);
  }

  return (
    <>
      {lead > 0 && <div ref={spacer} className="tl-older" style={{ height: spacerHeight }} aria-hidden />}
      {rows}
      {layout.queued.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
      {!running && <Tail />}
    </>
  );
});

// ─────────────────────────────────── a turn ───────────────────────────────────

/**
 * A turn as a sequence of checkpoints. While it runs, each closed checkpoint reads as two lines
 * (its work, folded: "Worked 45s · 5 steps", and the note that closed it) and the live line stands
 * under the newest: nothing else of the past shows. When it ends everything gathers into one line
 * ("Worked 15m 52s · 36 steps") with what never folds after it, in order: things shown, a message
 * steered into the turn with the reply to it, the answer. That line opens the checkpoints one
 * level in, each opening to its own steps; a turn with a single run opens straight to its steps.
 *
 * Every piece keeps its element through all of it (a text that turns out the answer, a line that
 * turns into the summary): a piece folds by closing a wrapper of its own, so nothing is made again
 * when a checkpoint closes or the turn ends.
 */
const TurnView = memo(function TurnView({ turn }: { turn: TurnGroup }) {
  const { sessionId } = useTimeline();
  const last = turn.segments.length - 1;
  const running = turn.state === 'running';
  const [wanted, setWanted] = useFold(foldKey(sessionId, turn.key), false);
  // The segment that holds the first piece that folds (the turn's line stands there), and how many runs there are in all.
  let headSeg = -1;
  let runs = 0;
  for (let i = 0; i <= last; i++) {
    const s = turn.segments[i];
    if (headSeg < 0 && (s.work.length > 0 || s.notes.length > 0)) headSeg = i;
    for (const c of s.flow) if (c.kind === 'steps') runs++;
  }
  const open = !running && headSeg >= 0 && wanted;
  // Laid out as while the turn ran (every piece at the column's edge): the pieces keep that place
  // while they gather at its end. Opened again, they stand one level in.
  const [flat, setFlat] = useState(running);
  if (flat && open) setFlat(false);
  const toggle = useCallback(() => setWanted(!wanted), [setWanted, wanted]);
  return (
    <section className="tg" data-state={turn.state} data-turn={turn.key}>
      {turn.segments.map((seg, i) => (
        <SegmentView
          key={seg.key}
          seg={seg}
          // The turn itself only where its line stands: a segment a steer cut skips rendering when a step joins the turn.
          turn={i === headSeg ? turn : undefined}
          after={turn.segments[i + 1]?.lead ?? turn.end}
          index={i}
          place={headSeg < 0 || i < headSeg ? -1 : i === headSeg ? 0 : 1}
          running={running}
          live={running && i === last}
          open={open}
          nest={!running && !flat}
          multi={runs > 1}
          onToggle={toggle}
        />
      ))}
      <TurnFoot turn={turn} />
      {turn.checks?.map((id) => (
        <ItemRow key={id} id={id} />
      ))}
    </section>
  );
});

/** How long a finished turn took, in ms; null when there is nothing to measure. */
function turnSpan(items: Record<string, TimelineItem>, turn: TurnGroup): number | null {
  const lead = turn.segments[0]?.lead;
  const start = (lead ? items[lead]?.ts : undefined) ?? items[turn.ids[0]]?.ts;
  if (!start) return null;
  const end = turn.end ? items[turn.end] : undefined;
  if (end?.type === 'turn') {
    // The time the live lines counted (a fresh agent's start-up included, which the agent's own
    // figure leaves out), so the number does not drop when the turn settles. The agent's figure
    // only where the items' times say less (a conversation loaded from history).
    const wall = end.ts - start;
    return end.durationMs > wall ? end.durationMs : wall;
  }
  let last = start;
  for (const id of turn.ids) {
    const it = items[id];
    if (!it) continue;
    last = Math.max(last, it.ts, ('endedAt' in it && it.endedAt) || 0);
  }
  return last - start;
}

/**
 * How long one checkpoint's work took, in ms: from the item whose time opens it (`from`: the
 * segment's message for its first run, else the run's first item) to what closed it (`until`: the
 * note, the next message, the turn's end), or to the last thing in it when nothing did.
 */
function runSpan(items: Record<string, TimelineItem>, run: StepsChunk, from: string, until: string | null): number | null {
  const start = items[from]?.ts ?? items[run.ids[0]]?.ts;
  if (!start) return null;
  const closer = until ? items[until] : undefined;
  if (closer) return closer.ts - start;
  let last = start;
  for (const id of run.ids) {
    const it = items[id];
    if (!it) continue;
    last = Math.max(last, it.ts, ('endedAt' in it && it.endedAt) || 0);
  }
  return last - start;
}

interface SegmentProps {
  seg: Segment;
  /** The turn, for the segment its line stands in. */
  turn?: TurnGroup;
  /** What follows the segment: the next segment's message, else the turn's end (it closes the last run). */
  after: string | null | undefined;
  index: number;
  /** Where the segment stands to the turn's line: before it (-1), holding it (0), after it (1). */
  place: -1 | 0 | 1;
  running: boolean;
  /** The running turn's last segment: the live line stands at its end. */
  live: boolean;
  /** The finished turn's fold is open. */
  open: boolean;
  nest: boolean;
  multi: boolean;
  onToggle: () => void;
}

/**
 * One segment's pieces in the order they happened: its message, then runs of work and what closed
 * each. A steered message and the reply to it stand as a pair and never fold; a notification the
 * agent took up mid-turn is part of the work and folds with it.
 */
const SegmentView = memo(function SegmentView({ seg, turn, after, index, place, running, live, open, nest, multi, onToggle }: SegmentProps) {
  const settled = !running;
  const shown = running || open;
  const flow = seg.flow;
  // Where the turn's line stands, when it stands in this segment: on its first run, or before a note that came first.
  const headAt = place === 0 ? flow.findIndex((c) => c.kind === 'steps' || (c.kind === 'text' && seg.notes.includes(c.id))) : -1;

  const out: ReactNode[] = [];
  if (seg.lead) {
    if (index > 0 && !seg.steered) out.push(<LeadPiece key={seg.lead} id={seg.lead} open={place < 1 || shown} nest={place === 1 && nest} />);
    else out.push(<ItemRow key={seg.lead} id={seg.lead} />);
  }
  let ord = 0;
  for (let i = 0; i < flow.length; i++) {
    const c = flow[i];
    if (i === headAt && c.kind !== 'steps' && turn) out.push(<FoldLine key="line" turn={turn} shown={settled} open={open} onToggle={onToggle} />);
    if (c.kind === 'show') {
      out.push(<ItemRow key={c.id} id={c.id} answer={c.id === seg.answer} />);
      continue;
    }
    if (c.kind === 'text') {
      const note = seg.notes.includes(c.id);
      out.push(<TextPiece key={c.id} id={c.id} open={!note || shown} nest={note && nest} answer={c.id === seg.answer || c.id === seg.reply} tail={seg.tail.includes(c.id)} />);
      continue;
    }
    const head = i === headAt;
    const isLive = live && i === flow.length - 1;
    const next = flow[i + 1];
    out.push(
      <RunPiece
        key={`w${ord++}`}
        run={c}
        from={i === 0 && seg.lead ? seg.lead : c.ids[0]}
        until={(next ? (next.kind === 'steps' ? next.ids[0] : next.id) : after) ?? null}
        head={head}
        live={isLive}
        first={i === 0}
        settled={settled}
        open={open}
        multi={multi}
        nest={nest}
        seg={isLive ? seg : undefined}
        turn={head ? turn : undefined}
        onToggle={onToggle}
      />,
    );
  }
  // Nothing to do yet, or the agent is saying something: the live line waits at the end for its run.
  if (live && (!flow.length || flow[flow.length - 1].kind !== 'steps'))
    out.push(<RunPiece key={`w${ord}`} run={null} from={flow.length ? null : seg.lead} until={null} head={false} live first={!flow.length} settled={false} open={false} multi={multi} nest={false} seg={seg} onToggle={onToggle} />);
  return <>{out}</>;
});

/**
 * Something the agent said, in a wrapper that folds it away with the work: a note along the way is
 * in view while the turn runs and inside the turn's line after; the answer, the reply to a steered
 * message and the words of a turn with no work behind them never fold. One element through all of
 * it, so a note that turns out the answer is not made again. `tail`: a nod said after the answer
 * ("Committed."), in view under it as a quiet last line.
 */
const TextPiece = memo(function TextPiece({ id, open, nest, answer, tail }: { id: string; open: boolean; nest: boolean; answer: boolean; tail: boolean }) {
  return (
    <Collapse open={open} className={`tl-fold fold-text${nest ? ' nest' : ''}${tail ? ' fold-tail' : ''}`}>
      <ItemRow id={id} answer={answer} mid={!answer} />
    </Collapse>
  );
});

/** A notification the agent took up while it worked ("Agent finished"): one more line of the turn's story, folded with it. */
const LeadPiece = memo(function LeadPiece({ id, open, nest }: { id: string; open: boolean; nest: boolean }) {
  return (
    <Collapse open={open} className={`tl-fold fold-lead${nest ? ' nest' : ''}`}>
      <ItemRow id={id} />
    </Collapse>
  );
});

/** A run of steps: nothing while folded (not even mounted), one line each when opened. */
const Steps = memo(function Steps({ ids, open, nest }: { ids: string[]; open: boolean; nest?: boolean }) {
  return (
    <Collapse open={open} className={`tl-steps${nest ? ' nest' : ''}`}>
      <div className="story">
        <ItemList ids={ids} />
      </div>
    </Collapse>
  );
});

interface RunProps {
  /** The run of work, or null for the live line before its first step. */
  run: StepsChunk | null;
  /** The item whose time opens the run; null when nothing is counted yet. */
  from: string | null;
  /** What closed it (see `runSpan`). */
  until: string | null;
  /** The turn's own line stands on this run: once the turn has ended it reads the whole turn and opens the fold. */
  head: boolean;
  live: boolean;
  /** Nothing of the segment stands before it. */
  first: boolean;
  settled: boolean;
  /** The finished turn's fold is open. */
  open: boolean;
  /** The turn has more than one run: opened, each has a line of its own, one level in. */
  multi: boolean;
  nest: boolean;
  /** Given to the live piece only, so a closed checkpoint skips rendering when a step joins the turn. */
  seg?: Segment;
  /** Given to the head only. */
  turn?: TurnGroup;
  onToggle: () => void;
}

/**
 * One checkpoint's work: its line and, opened, its steps. The same element from the live line
 * ("Run the tests · 12s · 2 steps") through the closed checkpoint ("Worked 45s · 5 steps") to its
 * place in the finished turn's fold; on the turn's first run the line then reads the whole turn.
 */
const RunPiece = memo(function RunPiece({ run, from, until, head, live, first, settled, open, multi, nest, seg, turn, onToggle }: RunProps) {
  const { sessionId } = useTimeline();
  const [runOpen, setRunOpen] = useFold(foldKey(sessionId, run?.key ?? '', 'run'), false);
  const toggleRun = useCallback(() => setRunOpen(!runOpen), [setRunOpen, runOpen]);
  const total = head && settled;
  // A single run opens straight to its steps: no line of its own inside the fold.
  const bare = settled && !multi;
  const stepsOpen = settled ? open && (bare || runOpen) : runOpen;
  const inside = nest && multi;
  const mode: LineMode = total ? 'total' : live ? 'live' : 'run';
  return (
    <Collapse open={head || !settled || open} className={`tl-fold fold-run${inside && !head ? ' nest' : ''}`}>
      <div className="seg-work">
        {!(bare && nest && !head) && (
          <WorkHead mode={mode} run={run} from={from} until={until} first={first} seg={seg} turn={turn} open={total ? open : stepsOpen} onToggle={total ? onToggle : run ? toggleRun : undefined} />
        )}
        {head && run && (
          <Collapse open={open && multi} className="tl-fold fold-run nest">
            <WorkHead mode="run" run={run} from={from} until={until} first={false} open={stepsOpen} onToggle={toggleRun} />
          </Collapse>
        )}
        {run && <Steps ids={run.ids} open={stepsOpen} nest={inside} />}
      </div>
    </Collapse>
  );
});

/** The finished turn's line where a note came before its first run: it takes the note's place as the pieces fold. */
const FoldLine = memo(function FoldLine({ turn, shown, open, onToggle }: { turn: TurnGroup; shown: boolean; open: boolean; onToggle: () => void }) {
  return (
    <Collapse open={shown} className="tl-fold fold-line">
      <div className="seg-work">
        <WorkHead mode="total" run={null} from={null} until={null} first={false} turn={turn} open={open} onToggle={onToggle} />
      </div>
    </Collapse>
  );
});

/** What a work line reads as: the running checkpoint, a closed one, or the whole finished turn. */
type LineMode = 'live' | 'run' | 'total';

interface HeadProps {
  mode: LineMode;
  run: StepsChunk | null;
  from: string | null;
  until: string | null;
  first: boolean;
  seg?: Segment;
  turn?: TurnGroup;
  open: boolean;
  onToggle?: () => void;
}

/** A work line in its place: live while its checkpoint runs, its summary once closed, the turn's once the turn has ended. */
function WorkHead({ mode, run, from, until, first, seg, turn, open, onToggle }: HeadProps) {
  // A line that starts live in front of the reader: the first of a segment arrives with the sent
  // message, a later one simply fades in under the note before it.
  const fresh = useFresh() && mode === 'live';
  // A checkpoint closing, and the turn ending: the line hands over to its summary, once.
  const [landed, setLanded] = useState(false);
  const was = useRef(mode);
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const before = was.current;
    was.current = mode;
    if (before === mode || mode === 'live') return;
    // Reduced motion: no travel, the summary line simply fades in.
    if (reducedMotion()) {
      el.current?.querySelector('.work-head')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      return;
    }
    setLanded(true);
    const t = window.setTimeout(() => setLanded(false), 700);
    return () => window.clearTimeout(t);
  }, [mode]);
  let line: ReactNode = null;
  if (mode === 'live' && seg) line = <LiveLine seg={seg} run={run} from={from} open={open} onToggle={run ? onToggle : undefined} />;
  else if (mode === 'total' && turn) line = <TotalLine turn={turn} open={open} onToggle={onToggle} landed={landed} />;
  else if (run) line = <RunLine run={run} from={from} until={until} open={open} onToggle={onToggle} landed={landed} />;
  if (!line) return null;
  return (
    <div ref={el} className="tl-item tl-work" data-live={mode === 'live' || undefined} data-enter={(fresh && first) || undefined} data-next={(fresh && !first) || undefined} data-open={open || undefined}>
      {line}
    </div>
  );
}

/** "Worked 45s · 5 steps": one closed checkpoint, opening to its steps. */
function RunLine({ run, from, until, open, onToggle, landed }: { run: StepsChunk; from: string | null; until: string | null; open: boolean; onToggle?: () => void; landed: boolean }) {
  const { sessionId } = useTimeline();
  const { span, thought } = useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? {};
    return {
      span: runSpan(items, run, from ?? run.ids[0], until),
      // Work that was only thinking says so ("Thought for 6s"), with no count of steps.
      thought: !run.count && run.ids.some((id) => items[id]?.type === 'thinking'),
    };
  }, [sessionId, run, from, until]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work-head" data-landed={landed || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-label num">{thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked'}</span>
        {run.count > 0 && <span className="work-time num">{plural(run.count, 'step')}</span>}
        <Icon name="caret-right" size={10} className="row-caret" />
      </button>
    </div>
  );
}

/** "Worked 4m 12s · 23 steps", and what changed: the whole of a finished turn behind one line. */
function TotalLine({ turn, open, onToggle, landed }: { turn: TurnGroup; open: boolean; onToggle?: () => void; landed: boolean }) {
  const { sessionId } = useTimeline();
  const { span, changes, steps, thought } = useMemo(() => {
    const d = useStore.getState().data[sessionId];
    const items = d?.items ?? {};
    const work = turn.segments.length === 1 ? turn.segments[0].work : turn.segments.flatMap((s) => s.work);
    const count = turn.segments.reduce((n, s) => n + s.steps, 0);
    return {
      span: turnSpan(items, turn),
      changes: changesOf(items, d?.children ?? {}, work),
      steps: count,
      // Work that was only thinking says so ("Thought for 6s"), with no count of steps.
      thought: !count && work.some((id) => items[id]?.type === 'thinking'),
    };
  }, [sessionId, turn]);
  const took = span && span >= 1000 ? shortDuration(span) : '';
  return (
    <div className="work-head" data-landed={landed || undefined}>
      <button type="button" className="work-line" aria-expanded={open} onClick={onToggle}>
        <span className="work-label num">{thought ? (took ? `Thought for ${took}` : 'Thought') : took ? `Worked ${took}` : 'Worked'}</span>
        {steps > 0 && <span className="work-time num">{plural(steps, 'step')}</span>}
        <Icon name="caret-right" size={10} className="row-caret" />
      </button>
      {changes.files > 0 && (
        <button type="button" className="work-changes num" onClick={() => showRailTab('changes')} aria-label={`${plural(changes.files, 'file')} changed. Open Changes`}>
          <Icon name="diff" size={13} />
          <span>{plural(changes.files, 'file')}</span>
          {changes.add > 0 && <span className="t-add">+{changes.add}</span>}
          {changes.del > 0 && <span className="t-del">−{changes.del}</span>}
        </button>
      )}
    </div>
  );
}

/**
 * The shortest time the live line shows one title (ms). Long enough that a burst of quick steps (a
 * fleet of agents launched one after another) reads as titles, not as a line fading in and out.
 */
const TITLE_HOLD_MS = 900;
/** How long a finished step still names what the agent is doing, when nothing newer has started (ms). */
const RECENT_MS = 2000;

const NO_IDS: string[] = [];

/**
 * The lead-in that names what the agent does now, or '' when there is none: the newest one written
 * since the last piece in view, while the steps it announced run. A step started after one of those
 * had ended, or thinking, is the agent's next move: the lead-in has had its say.
 */
function currentLead(items: Record<string, TimelineItem>, seg: Segment, work: string[]): string {
  const id = seg.narr[seg.narr.length - 1];
  const it = id ? items[id] : undefined;
  if (it?.type !== 'text' || it.streaming) return '';
  const at = work.lastIndexOf(id);
  if (at < 0) return '';
  let ended = Infinity;
  for (let i = at + 1; i < work.length; i++) {
    const step = items[work[i]];
    if (!step) continue;
    if (step.type !== 'tool' || step.ts > ended) return '';
    if (step.endedAt) ended = Math.min(ended, step.endedAt);
  }
  return leadTitle(it.text);
}

/**
 * What the running checkpoint is doing right now: `${waiting}|${stall}|${quiet}|${title}`. `held`
 * keeps the title last given. Quiet: the agent is writing something in view (a note, the answer,
 * the reply to a steered message) and no step runs, so the words are the signal and the line steps
 * back until they end: it never rides down under a text line by line.
 */
function liveSelector(sessionId: string, seg: Segment, run: StepsChunk | null, held: { title: string }) {
  const work = run?.ids ?? NO_IDS;
  // The pieces in view (texts, widgets, plans), newest first: a widget being drawn or a text being written.
  const pieces: string[] = [];
  for (let i = seg.flow.length - 1; i >= 0 && pieces.length < 4; i--) {
    const c = seg.flow[i];
    if (c.kind === 'text' || c.kind === 'show') pieces.push(c.id);
  }
  return (s: Store): string => {
    const d = s.data[sessionId];
    const meta = s.sessions[sessionId];
    if (!d || !meta) return '0|0|0|Working';
    let waiting = meta.status === 'awaiting' || d.permissions.length > 0 || d.questions.length > 0;
    let title = '';
    // The earliest moment a running command is past its own limit (it is not answering after that).
    let stall = 0;
    let agents = 0;
    // The newest step, when it finished a moment ago: quick steps in a row read as one calm sequence
    // of their titles instead of flickering back to "Working" between them.
    let recent = '';
    // A lead-in being written: the line keeps what it says until the sentence is whole.
    let writing = false;
    // A step is under way.
    let stepping = false;
    for (let i = work.length - 1, n = 0; i >= 0 && n < 60; i--, n++) {
      const it = d.items[work[i]];
      if (!it) continue;
      if (it.type === 'tool' && (it.status === 'running' || it.status === 'pending' || it.status === 'awaiting')) {
        stepping = true;
        if (it.status === 'awaiting') waiting = true;
        if (it.kind === 'agent') agents++;
        const at = stallAt(it);
        if (at && (!stall || at < stall)) stall = at;
        if (!title) title = it.title;
      } else if (it.type === 'thinking' && it.streaming && !title) title = thinkingHeadline((it as ThinkingItem).text) || 'Thinking';
      else if (n === 0 && it.type === 'text' && it.streaming) writing = true;
      else if (n === 0 && it.type === 'tool' && it.endedAt && Date.now() - it.endedAt < RECENT_MS) recent = it.title;
    }
    // Several sub-agents at once: the line counts them.
    if (agents > 1) title = `Running ${agents} sub-agents`;
    // The agent's own words for what it does now, while the steps it announced run.
    else if (writing && held.title) title = held.title;
    else title = currentLead(d.items, seg, work) || title;
    // Something shown that is still being made (a widget being drawn) names the line. A text being
    // written does not: the line is quiet under it, and says what comes next when the words end.
    let speaking = false;
    for (const id of pieces) {
      const it = d.items[id];
      if (it?.type === 'text' && it.streaming) speaking = true;
      else if (!title && it?.type === 'tool' && (it.status === 'pending' || it.status === 'running')) title = it.title;
    }
    if (!title) title = recent || (meta.status === 'starting' ? 'Starting' : meta.activity || 'Working');
    held.title = title;
    const quiet = speaking && !waiting && !stepping;
    return `${waiting ? 1 : 0}|${stall}|${quiet ? 1 : 0}|${title}`;
  };
}

/** How long the old title takes to fade before the new one comes in (ms). Short: the line is the
 *  turn's pulse, and a title that is gone for a quarter of a second reads as a line that went out. */
const SWAP_OUT_MS = 80;

/** How long the live line stays back after the agent stopped writing (ms). */
const QUIET_LINGER_MS = 450;

/** True while `on`, and for `ms` after it turns off. */
function useLinger(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) return setHeld(true);
    const t = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on || held;
}

/**
 * A title that changes by fading through: the old one fades out, the new one fades in, and the
 * figures after it move only while neither is visible.
 */
function useSwap(value: string): [string, boolean] {
  const [shown, setShown] = useState(value);
  const [out, setOut] = useState(false);
  useEffect(() => {
    // Back to the title on screen before the old one had gone: it simply stays.
    if (value === shown) return setOut(false);
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    setOut(true);
    const t = window.setTimeout(() => {
      setShown(value);
      setOut(false);
    }, SWAP_OUT_MS);
    return () => window.clearTimeout(t);
  }, [value, shown]);
  return [shown, out];
}

/**
 * The running checkpoint's one line: the working indicator, what it is doing now, the time since
 * the checkpoint began and how many steps it took; a click opens the steps (the stop button and Esc
 * stop the turn, with no hint here). It stays in view (sticky) while its opened steps grow past the
 * top, and steps back while the agent writes a note or the answer (`quiet`).
 */
function LiveLine({ seg, run, from, open, onToggle }: { seg: Segment; run: StepsChunk | null; from: string | null; open: boolean; onToggle?: () => void }) {
  const { sessionId } = useTimeline();
  const [last] = useState(() => ({ title: '' }));
  const info = useStore(useMemo(() => liveSelector(sessionId, seg, run, last), [sessionId, seg, run, last]));
  const lead = useItem(from ?? '');
  const now = useTick();
  const [w, st, q, ...rest] = info.split('|');
  const waiting = w === '1';
  // The words have ended: the line waits a moment before it returns. A turn that ends right after
  // its answer (the usual end) never shows a line under it for a few frames.
  const quiet = useLinger(q === '1', QUIET_LINGER_MS);
  const stall = Number(st) || 0;
  // A command past its own time limit: the line says so, so a hung step never just counts on.
  const stalled = !waiting && stall > 0 && now >= stall;
  // Quick steps in a row: each title holds a moment instead of flickering past (waiting shows at once).
  const held = useHeld(rest.join('|'), TITLE_HOLD_MS);
  const [title, out] = useSwap(held);
  const elapsed = lead ? now - lead.ts : 0;
  const steps = run?.count ?? 0;
  // The working tiles keep their own animation: the line's ticks and title changes leave them alone.
  const tiles = useMemo(() => <Tiles size={12} />, []);
  // A new title of another width: the time and steps after it glide to their new place instead of
  // jumping there. A longer title waits until they have made room, so no words ever cross. The old
  // width is read as the old title fades out, the new one as it arrives: never at mount, where a
  // sent message is still in the air.
  const label = useRef<HTMLSpanElement>(null);
  const width = useRef(-1);
  useLayoutEffect(() => {
    if (out && label.current) width.current = label.current.offsetWidth;
  }, [out]);
  useLayoutEffect(() => {
    const was = width.current;
    width.current = -1;
    const el = label.current;
    if (!el || was < 0) return;
    const wide = el.offsetWidth;
    if (Math.abs(was - wide) < 1) return;
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) n.animate([{ transform: `translateX(${was - wide}px)` }, { transform: 'translateX(0)' }], { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)', composite: 'add' });
    if (wide > was) el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  }, [title, waiting]);
  const body = (
    <>
      {waiting ? (
        <span className="work-ind work-wait-icon">
          <Icon name="hourglass" size={13} />
        </span>
      ) : (
        <span className="work-ind">{tiles}</span>
      )}
      {waiting ? (
        <span ref={label} className="work-label work-waiting">
          Waiting for you
        </span>
      ) : (
        <span ref={label} className="work-label work-live-title shimmer truncate" data-out={out || undefined}>
          {title}
        </span>
      )}
      {elapsed >= 1000 && <span className="work-time num">{shortDuration(elapsed)}</span>}
      {steps > 0 && <span className="work-time num">{plural(steps, 'step')}</span>}
      {stalled && <span className="work-time work-stall">Not answering</span>}
      {onToggle && <Icon name="caret-right" size={10} className="row-caret" />}
    </>
  );
  // One element whether or not there is anything to open yet: the line must not be made again when
  // its first step arrives, or its entrance (the words fading in last) would play a second time.
  return (
    <div className="work-head" data-live data-quiet={quiet || undefined} role="status" aria-live="off">
      <button
        type="button"
        className="work-line work-live"
        aria-expanded={onToggle ? open : undefined}
        data-static={!onToggle || undefined}
        tabIndex={onToggle && !quiet ? undefined : -1}
        onClick={onToggle}
      >
        {body}
      </button>
      <span className="work-band" aria-hidden />
      <span className="work-fade" aria-hidden />
    </div>
  );
}
