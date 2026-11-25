import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { TimelineItem } from '@shared/protocol';
import { userItemText } from '@shared/synthetic';
import { parseReview } from '@/features/review/model';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { highlightRuns } from '@/lib/fuzzy';
import { reducedMotion, uiZoom } from '@/lib/motion';
import { useStore } from '@/state/store';
import { Kbd } from '@/ui';
import { useTimeline } from './ctx';
import { estimate } from './items';
import { findMarks, onFindMarks, takeConversation, takeSteps, type NavFeed, type NavLayout } from './nav-bus';
import { firstLine, groupAt, groupBoxes, navigatorShape, indexLines, indexWindow, isBuilt, markAt, marksOf, markY, matchPrompt, placeMarks, railAt, railOf, railShown, RAIL_HIDE, RAIL_SHOW, rowsMoved, runOf, runsOf, stackHeight, stepTarget, type NavMark, type NavRun, type Rail } from './nav-model';
import { revealItem, rootOf } from './reveal';
import type { Group } from './turns';
import { stampParts } from './util';
import './navigator.css';

/** Where a message lands after a jump: its row's top this far below the view's top (its card clears the top fade). */
const LAND = 18;
/** A jump farther than this many views goes most of the way at once and glides the rest. */
const FAR = 1.5;
/** The glide at the end of a far jump (px). */
const GLIDE = 220;
/** The reading line, as a share of the view's height from its top: the message above it is the one being read. */
const READ = 0.42;
/** Keys pressed while a jump is on its way step on from where it goes (ms). */
const IN_FLIGHT = 650;
/** Where the view is, is read once the scroll has been still this long (ms), and during a long scroll every `HERE_MS`. */
const HERE_QUIET = 140;
const HERE_MS = 500;
/** Marks moved by heights changing above them are measured again this long after (ms), once for a burst. */
const SETTLE_MS = 150;
/** The pointer rests on the rail this long before the index opens (ms): crossing it on the way to the scrollbar opens nothing. */
const INTENT = 110;
/** The index stays this long after the pointer left it and the rail (ms): the way from one to the other. */
const LINGER = 220;
/** Above and below its stack the rail still answers the pointer (px). */
const REACH = 14;
/** From this many messages on the index has its field without being asked for. */
const FIELD_FROM = 8;
/** A row of the index and a run's head are this tall, and the list pads by `PAD` (navigator.css). */
const ROW = 28;
const PAD = 4;
/** The index glides this many rows at most: a run further away is gone most of the way to at once. */
const ROWS_GLIDE = 5;

interface Geo {
  /** Content offset of each mark (px from the top of the scroller's content, as `scrollTop`). */
  ys: Float64Array;
  sH: number;
  cH: number;
  /** The rail's track: how tall its stack may be. */
  track: number;
  /** The stack's middle on the track: kept while only the composer grows, so the rail never moves as one types. */
  mid: number;
}

const NO_GEO: Geo = { ys: new Float64Array(0), sH: 0, cH: 0, track: 0, mid: 0 };

const sameYs = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.5);

interface Measure {
  boxes: ReturnType<typeof groupBoxes> | null;
  layout: NavLayout | null;
  /** What the marks were measured for: the built ranges, the number of groups, the marks. */
  sig: string;
  marks: NavMark[] | null;
  /** The newest built group's element and its top: when it has not moved, nothing above it has. */
  anchor: HTMLElement | null;
  anchorTop: number;
  /** The steered messages' rows inside the newest group, and their offsets when measured: a fold opened above one moves it, not the group. */
  inner: { el: HTMLElement; y: number }[];
}

const sigOf = (l: NavLayout) => `${l.built.lead}|${l.built.gapFrom}|${l.built.hidden}|${l.groups.length}`;

/** How long a jump holds its row in place while what is around it settles (ms). */
const PIN_MS = 1500;

/** The scroll position that puts a row at the landing place, within the scroller's range. */
function landing(sc: HTMLElement, el: HTMLElement): number {
  const y = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / uiZoom() + sc.scrollTop;
  return Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, y - LAND));
}

/** A key or click inside another surface (the side panel, a dialog, a menu) is not for the conversation. */
const elsewhere = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('.app-rail, [role="dialog"]:not(.nav-index), [role="menu"]');

/** The rail under the pointer: the run, and the message a click goes to. */
interface Aim {
  run: number;
  mark: number;
}

interface Props {
  sessionId: string;
  feed: NavFeed;
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  /** The reader moves the view: the timeline lets go of the end. */
  hold: () => void;
}

/**
 * The conversation's navigator, at its right edge. At rest a small rail: the messages the person
 * sent, gathered into runs (messages sent close together, a sitting of work), every run one short
 * stack, and the run being read fanned out into a line per message with the one in view lit. So a
 * chat of 300 messages is a dozen marks, and where one is stays plain.
 *
 * The pointer on the rail (or Ctrl+G) opens the index beside it: every message by its first words
 * under the time its run began, the one in view marked; a click or Enter goes there, typing
 * filters. A click on the rail itself goes to the run or the line under the pointer. Alt+Up and
 * Alt+Down step between messages (the find bar hands the keys here).
 *
 * It never makes the timeline render: the turn list hands it its layout after each commit
 * (`feed`), it measures the built turns when the layout or a size changes (one read when only the
 * end grew), and where the view is, is read a few times a second while it scrolls: the lit mark
 * then moves by one transform, and the rail is drawn again only when the view comes into another
 * run. Nothing here runs for a streamed word.
 */
export const Navigator = memo(function Navigator({ sessionId, feed, scroller, content, hold }: Props) {
  const layout = useSyncExternalStore(feed.subscribe, feed.get);
  const find = useSyncExternalStore(
    useCallback((l: () => void) => onFindMarks(sessionId, l), [sessionId]),
    useCallback(() => findMarks(sessionId), [sessionId]),
  );
  const waiting = useStore((s) => {
    const d = s.data[sessionId];
    return s.sessions[sessionId]?.status === 'awaiting' || !!d?.permissions.length || !!d?.questions.length;
  });

  // The marks: one per message, kept per turn object, the same array while nothing changed.
  const lastMarks = useRef<NavMark[]>([]);
  const marks = useMemo(() => {
    if (!layout) return lastMarks.current;
    const d = useStore.getState().data[sessionId];
    return (lastMarks.current = marksOf(layout.groups, d?.items ?? {}, undefined, lastMarks.current));
  }, [layout, sessionId]);

  const shape = useCallback((g: Group) => navigatorShape(g, useStore.getState().data[sessionId]?.items ?? {}, estimate), [sessionId]);

  const track = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo>(NO_GEO);
  const geoRef = useRef(geo);
  geoRef.current = geo;
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const last = useRef<Measure>({ boxes: null, layout: null, sig: '', marks: null, anchor: null, anchorTop: 0, inner: [] });
  const settleTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(settleTimer.current), []);
  const [boxesRev, setBoxesRev] = useState(0);

  /** Measures every mark's place: the built groups' boxes, the spacers, the estimates behind them. */
  const measure = useCallback(() => {
    const sc = scroller.current;
    const ct = content.current;
    const L = feed.get();
    if (!sc || !ct || !L) return;
    const base = ct.offsetTop;
    const byKey = new Map<string, HTMLElement>();
    let older: { top: number; height: number } | null = null;
    let gap: { top: number; height: number } | null = null;
    let keyed: HTMLElement | null = null;
    for (let c = ct.firstElementChild as HTMLElement | null; c; c = c.nextElementSibling as HTMLElement | null) {
      if (c.classList.contains('tl-older')) older = { top: c.offsetTop - base, height: c.offsetHeight };
      else if (c.classList.contains('tl-gap')) gap = { top: c.offsetTop - base, height: c.offsetHeight };
      else {
        const key = c.dataset.turn ?? c.dataset.itemId;
        if (key) {
          byKey.set(key, c);
          keyed = c;
        }
      }
    }
    // The newest group (always built): what streams grows below its top, so its top only moves when something above it does.
    const anchor = (L.groups.length ? byKey.get(L.groups[L.groups.length - 1].key) : undefined) ?? keyed;
    const boxes = groupBoxes(
      L.groups,
      L.built,
      {
        older,
        gap,
        box: (i) => {
          const el = byKey.get(L.groups[i].key);
          return el ? { top: el.offsetTop - base, height: el.offsetHeight } : undefined;
        },
      },
      (i) => shape(L.groups[i]).h,
    );
    const ms = marksRef.current;
    // A steered message whose row is built is measured where it stands (a checkpoint opened above it
    // moves it inside its turn); only a row that is not built is placed by the estimate.
    const host = ct.offsetParent;
    const rowY = (el: HTMLElement): number => {
      let y = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
        if (n === host) return y - base;
        y += n.offsetTop;
      }
      return (el.getBoundingClientRect().top - ct.getBoundingClientRect().top) / uiZoom();
    };
    const inner: { el: HTMLElement; y: number }[] = [];
    const newest = L.groups.length - 1;
    const ys = placeMarks(
      ms,
      boxes,
      (gi, id) => {
        const s = shape(L.groups[gi]);
        const at = s.at.get(id);
        return at && s.h > 0 ? at / s.h : undefined;
      },
      (i) => {
        const m = ms[i];
        if (!m.steered || !isBuilt(L.built, m.group)) return undefined;
        const el = byKey.get(L.groups[m.group]?.key ?? '')?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(m.id)}"]`);
        if (!el) return undefined;
        const y = rowY(el);
        // The newest group's own top never moves for what opens inside it: its rows are watched themselves (`check`).
        if (m.group === newest) inner.push({ el, y: el.offsetTop });
        return y;
      },
    );
    last.current = { boxes, layout: L, sig: sigOf(L), marks: ms, anchor, anchorTop: anchor ? anchor.offsetTop : 0, inner };
    if (findMarks(sessionId)) setBoxesRev((r) => r + 1);
    const g = geoRef.current;
    const cH = sc.clientHeight;
    const tr = track.current?.clientHeight ?? 0;
    // The stack's middle follows the view's size, not the composer's: it stays put while a draft grows.
    const next: Geo = { ys, sH: sc.scrollHeight, cH, track: tr, mid: cH !== g.cH || !g.mid ? tr / 2 : g.mid };
    if (next.sH !== g.sH || next.cH !== g.cH || next.track !== g.track || next.mid !== g.mid || !sameYs(next.ys, g.ys)) setGeo((geoRef.current = next));
  }, [feed, scroller, content, shape, sessionId]);

  /**
   * After a commit or a size change: measure again only when the built ranges or the marks
   * changed, something above the newest group moved (its top did), or the view resized. When only
   * the end grew (a streamed answer, a step in the running turn) nothing here changes at all,
   * except once, when the conversation gets long enough for the rail.
   */
  const check = useCallback(() => {
    const sc = scroller.current;
    const L = feed.get();
    if (!sc || !L) return;
    const l = last.current;
    const g = geoRef.current;
    const cH = sc.clientHeight;
    if (l.sig !== sigOf(L) || l.marks !== marksRef.current || (l.anchor && !l.anchor.isConnected) || cH !== g.cH) return measure();
    // Something above the newest group changed height (older turns drawn for the first time as
    // the reader scrolls through them, a fold opened), or a checkpoint opened inside it above one of
    // its steered messages: measured once that settles.
    const inner = l.inner;
    if ((l.anchor && l.anchor.offsetTop !== l.anchorTop) || (inner.length > 0 && rowsMoved(inner.map((r) => r.y), (i) => (inner[i].el.isConnected ? inner[i].el.offsetTop : undefined)))) {
      if (!settleTimer.current)
        settleTimer.current = window.setTimeout(() => {
          settleTimer.current = 0;
          requestAnimationFrame(measure);
        }, SETTLE_MS);
      return;
    }
    // The groups changed objects only (a step joined the running turn): find results keep their groups' places.
    l.layout = L;
    const tr = track.current?.clientHeight ?? 0;
    const sH = sc.scrollHeight;
    // The track alone (the composer grew by a line): the rail keeps its middle and only learns its room.
    const crosses = sH > RAIL_SHOW * cH !== g.sH > RAIL_SHOW * cH || sH > RAIL_HIDE * cH !== g.sH > RAIL_HIDE * cH;
    if (tr !== g.track || crosses) setGeo((geoRef.current = { ...g, track: tr, sH: crosses ? sH : g.sH }));
  }, [feed, scroller, measure]);

  // The turn list committed a new layout: look once the next frame has been laid out (right after
  // it, so the reads find the layout done). Read inside the frame's callbacks they forced a layout
  // of their own before the frame's, every frame of a burst of steps (perf1: the fleet).
  useEffect(() => {
    if (!layout) return;
    let t = 0;
    const raf = requestAnimationFrame(() => (t = window.setTimeout(check, 0)));
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [layout, marks, check]);

  /**
   * The row a jump went to, held in place for a moment: turns around it build and take their real
   * height as they come into view (above it too), which would move it. While the view glides the
   * glide is aimed again; once it rests, the view follows the row in the same frame the layout
   * moved it (before it is painted), so it never visibly moves. Any input of the reader lets go.
   */
  const pin = useRef<{ el: HTMLElement; until: number; gliding: boolean; target: number } | null>(null);
  const { stuck } = useTimeline();
  const follow = useCallback(() => {
    const p = pin.current;
    const sc = scroller.current;
    if (!p || !sc) return;
    // Back to following the end (Jump to latest, a message sent): the jump is over.
    if (!p.el.isConnected || performance.now() > p.until || stuck.current) {
      pin.current = null;
      return;
    }
    const t = landing(sc, p.el);
    if (p.gliding) {
      if (Math.abs(t - p.target) > 1) sc.scrollTo({ top: t, behavior: 'smooth' });
    } else if (Math.abs(t - sc.scrollTop) > 1) sc.scrollTop = t;
    p.target = t;
  }, [scroller, stuck]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    const off = () => {
      pin.current = null;
      aimed.current = -1;
    };
    const opts = { capture: true, passive: true } as const;
    for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) sc.addEventListener(t, off, opts);
    return () => {
      for (const t of ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const) sc.removeEventListener(t, off, opts);
    };
  }, [scroller]);

  // Sizes: the content (it grows as the agent writes, older turns build), the view, the track.
  useEffect(() => {
    const sc = scroller.current;
    const ct = content.current;
    const tr = track.current;
    if (!sc || !ct || !tr) return;
    const ro = new ResizeObserver(() => {
      follow();
      check();
    });
    ro.observe(ct, { box: 'border-box' });
    ro.observe(sc);
    ro.observe(tr);
    return () => ro.disconnect();
  }, [scroller, content, check, follow]);

  // Shown only when the conversation is long enough to need it.
  const [shown, setShown] = useState(false);
  const show = railShown(geo.sH, geo.cH, marks.length, shown);
  useEffect(() => setShown(show), [show]);

  // ── where the view is ──

  /**
   * The message in view (`markAt`); the last one while the view follows the end. Reading it costs
   * the main thread a pass of the page's lifecycle when it changes something, so it is read when a
   * scroll comes to rest (and every `HERE_MS` during a long one), never per frame, and not at all
   * while a turn streams in front of the reader.
   */
  const hereRef = useRef(-1);
  const hereEl = useRef<HTMLElement>(null);
  /** What the rail shows right now (set where it is laid out, below), for handlers and for `moveHere`. */
  const live = useRef<{ rail: Rail; runs: NavRun[]; open: number; offset: number } | null>(null);
  const paneRef = useRef<null | 'peek' | 'open'>(null);
  const [, redraw] = useState(0);
  /**
   * The message in view changed. Inside the run that is fanned out, with the index closed, the lit
   * mark alone moves, by one write of its own (as the band did): scrolling never renders, so it
   * never holds up the turns React is building ahead of the reader. Into another run, the rail is
   * drawn again.
   */
  const moveHere = useCallback((i: number) => {
    if (i === hereRef.current) return;
    hereRef.current = i;
    const l = live.current;
    const el = hereEl.current;
    if (l && el && !paneRef.current && l.open >= 0 && runOf(l.runs, i) === l.open) el.style.transform = `translateY(${l.offset + Math.floor(markY(l.rail, l.runs, i))}px)`;
    else redraw((n) => n + 1);
  }, []);
  /** A jump on its way: where it goes, so keys pressed meanwhile step on from there, and the rail waits for it to land. */
  const flight = useRef<{ index: number; at: number }>({ index: -1, at: 0 });
  /**
   * The message last jumped to, until the reader moves the view: while it stands in the view it is
   * the one in view (near the end of the conversation a message cannot land at the top, and the
   * ones above it would be taken for it).
   */
  const aimed = useRef(-1);
  const jumped = useCallback(() => {
    const sc = scroller.current;
    const ys = geoRef.current.ys;
    const i = aimed.current;
    if (!sc || i < 0 || i >= ys.length) return -1;
    const top = sc.scrollTop;
    return ys[i] >= top - LAND && ys[i] < top + sc.clientHeight - LAND ? i : -1;
  }, [scroller]);
  const locate = useCallback(() => {
    const sc = scroller.current;
    const ys = geoRef.current.ys;
    if (!sc || !ys.length) return;
    let at = jumped();
    if (at < 0) {
      at = ys.length - 1;
      if (!stuck.current) {
        const top = sc.scrollTop;
        at = Math.max(0, markAt(ys, top + sc.clientHeight * READ, top + LAND));
      }
    }
    moveHere(at);
  }, [scroller, stuck, jumped, moveHere]);

  useEffect(() => {
    const sc = scroller.current;
    if (!sc) return;
    let timer = 0;
    let raf = 0;
    let read = performance.now();
    const look = () => {
      timer = 0;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        read = performance.now();
        locate();
      });
    };
    const onScroll = () => {
      // Following the end: the last message, known already.
      if (stuck.current && hereRef.current === geoRef.current.ys.length - 1) return;
      window.clearTimeout(timer);
      // A jump on its way is read when it lands; a long scroll now and then; otherwise once it has been still a moment.
      if (performance.now() - flight.current.at > IN_FLIGHT && performance.now() - read > HERE_MS) look();
      else timer = window.setTimeout(look, HERE_QUIET);
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [scroller, stuck, locate]);
  // The places changed (a message sent, older turns built, the view resized).
  useEffect(() => {
    if (performance.now() - flight.current.at > IN_FLIGHT) locate();
  }, [geo.ys, geo.cH, locate]);

  // ── moving the view ──

  /** Brings a row to the top of the view: straight there when near, most of the way at once and a short glide when far. */
  const land = useCallback(
    (el: HTMLElement) => {
      const sc = scroller.current;
      if (!sc) return;
      const target = landing(sc, el);
      hold();
      const glide = !reducedMotion();
      if (!glide) sc.scrollTop = target;
      else {
        const d = target - sc.scrollTop;
        if (Math.abs(d) > sc.clientHeight * FAR) sc.scrollTop = target - Math.sign(d) * GLIDE;
        sc.scrollTo({ top: target, behavior: 'smooth' });
      }
      const p = { el, until: performance.now() + PIN_MS, gliding: glide, target };
      pin.current = p;
      if (glide)
        sc.addEventListener(
          'scrollend',
          () => {
            if (pin.current !== p) return;
            p.gliding = false;
            follow();
          },
          { once: true },
        );
    },
    [scroller, hold, follow],
  );

  /** Jumps to a message: built already, or built first (with a few turns around it) and then jumped to. */
  const jumpTo = useCallback(
    (index: number) => {
      const m = marksRef.current[index];
      const sc = scroller.current;
      if (!m || !sc) return;
      const rowOf = () =>
        (m.steered ? sc.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(m.id)}"]`) : content.current?.querySelector<HTMLElement>(`:scope > section[data-turn="${CSS.escape(m.id)}"]`)) ?? null;
      const el = rowOf();
      flight.current = { index, at: performance.now() };
      aimed.current = index;
      // The rail says where the view goes at once, not where it happens to pass.
      moveHere(index);
      if (el) return land(el);
      hold();
      pin.current = null;
      revealItem(sessionId, m.id, { quiet: true });
      let tries = 0;
      const look = () => {
        if (flight.current.index !== index) return;
        const row = rowOf();
        if (row) land(row);
        else if (++tries < 40) requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    },
    [scroller, content, sessionId, land, hold, moveHere],
  );

  const toEnd = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    flight.current = { index: marksRef.current.length, at: performance.now() };
    aimed.current = -1;
    pin.current = null;
    sc.scrollTo({ top: sc.scrollHeight, behavior: reducedMotion() ? 'instant' : 'smooth' });
  }, [scroller]);

  // Alt+Up and Alt+Down (the find bar hands them over): the previous or next message from where the view is.
  useEffect(
    () =>
      takeSteps(sessionId, (dir) => {
        const sc = scroller.current;
        const ms = marksRef.current;
        if (!sc || !ms.length) return false;
        let to: number;
        const f = flight.current;
        const from = f.index >= 0 && performance.now() - f.at < IN_FLIGHT ? f.index : jumped();
        if (from >= 0) to = Math.max(0, Math.min(ms.length, from + dir));
        else {
          const top = sc.scrollTop;
          to = stepTarget(geoRef.current.ys, top + sc.clientHeight * READ, top + LAND, dir);
        }
        if (to >= ms.length) toEnd();
        else if (to >= 0) jumpTo(to);
        return true;
      }),
    [sessionId, scroller, jumpTo, toEnd, jumped],
  );

  // ── the rail ──

  const runs = useMemo(() => runsOf(marks.map((m) => m.ts)), [marks]);
  // Read where it is kept (`moveHere`): a render always draws the mark where it stands now.
  const at = Math.min(hereRef.current < 0 ? marks.length - 1 : hereRef.current, marks.length - 1);
  const open = runOf(runs, at);
  const rail = useMemo(
    () =>
      railOf(
        runs.map((r) => r.to - r.from),
        open,
        Math.max(0, geo.track - REACH * 2),
      ),
    [runs, open, geo.track],
  );
  // The stack stands around the track's middle, kept inside the track.
  const offset = Math.round(Math.max(REACH, Math.min(geo.track - REACH - rail.h, geo.mid - rail.h / 2)));
  live.current = { rail, runs, open, offset };

  // Find results: the message each one stands under, as brighter marks on the rail.
  const hits = useMemo(() => {
    const { boxes, layout: lay } = last.current;
    if (!show || !find?.ids.length || !boxes || !lay) return null;
    const items = (useStore.getState().data[sessionId]?.items ?? {}) as Record<string, TimelineItem | undefined>;
    const groupOf = new Map<string, number>();
    lay.groups.forEach((g, i) => {
      if (g.kind === 'item') groupOf.set(g.id, i);
      else {
        for (const id of g.ids) groupOf.set(id, i);
        for (const id of g.checks ?? []) groupOf.set(id, i);
      }
    });
    const ys = geo.ys;
    const markOf = (id: string) => {
      const root = rootOf(items, id);
      const gi = groupOf.get(root);
      if (gi === undefined) return -1;
      const s = shape(lay.groups[gi]);
      const y = boxes.top[gi] + (s.h > 0 ? ((s.at.get(root) ?? 0) / s.h) * boxes.height[gi] : 0);
      // The last message that stands at or above it.
      return Math.max(0, groupAt(ys, y + 0.5));
    };
    const on = new Set<number>();
    for (const id of find.ids) {
      const m = markOf(id);
      if (m >= 0 && m < ys.length) on.add(m);
    }
    return { on, at: find.current ? markOf(find.current) : -1 };
  }, [show, find, boxesRev, geo.ys, sessionId, shape]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── the index ──

  /** Open by the pointer on the rail (`peek`: it leaves with the pointer) or asked for (`open`: by key, by its field). */
  const [pane, setPane] = useState<null | 'peek' | 'open'>(null);
  paneRef.current = pane;
  const [aim, setAim] = useState<Aim | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const intent = useRef(0);
  const linger = useRef(0);
  const trackTop = useRef(0);
  const pointer = useRef('mouse');
  useEffect(
    () => () => {
      window.clearTimeout(intent.current);
      window.clearTimeout(linger.current);
    },
    [],
  );

  const closeIndex = useCallback((refocus = true) => {
    window.clearTimeout(intent.current);
    window.clearTimeout(linger.current);
    if (!paneRef.current) return;
    setPane((paneRef.current = null));
    const el = back.current;
    back.current = null;
    if (refocus && el?.isConnected) el.focus({ preventScroll: true });
  }, []);

  const openIndex = useCallback(() => {
    window.clearTimeout(intent.current);
    window.clearTimeout(linger.current);
    if (!marksRef.current.length) return;
    // Never the body or a closing palette: focus would go back to nothing.
    const was = document.activeElement;
    if (!back.current && was instanceof HTMLElement && was !== document.body && !was.closest('.nav-index, .palette')) back.current = was;
    setPane((paneRef.current = 'open'));
  }, []);

  /** The index's field took the focus (from `from`, which gets it back): it stays until closed. */
  const pinIndex = useCallback((from: Element | null) => {
    window.clearTimeout(linger.current);
    if (!back.current && from instanceof HTMLElement && !from.closest('.nav-index, .nav, .palette')) back.current = from;
    if (paneRef.current === 'peek') setPane((paneRef.current = 'open'));
  }, []);

  const stay = useCallback(() => window.clearTimeout(linger.current), []);
  const leave = useCallback(() => {
    window.clearTimeout(linger.current);
    if (paneRef.current === 'peek') linger.current = window.setTimeout(() => paneRef.current === 'peek' && setPane((paneRef.current = null)), LINGER);
  }, []);

  const pick = useCallback(
    (index: number) => {
      closeIndex();
      jumpTo(index);
    },
    [closeIndex, jumpTo],
  );

  // Ctrl+G opens the index (and closes it); Esc and a press elsewhere close it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'g') {
        if (elsewhere(e.target) || !marksRef.current.length) return;
        // Two conversations side by side (a race): the one the key was pressed in.
        const own = track.current?.closest('.tl');
        if (!own || (document.querySelectorAll('.tl').length > 1 && !own.contains(e.target as Node))) return;
        e.preventDefault();
        if (paneRef.current === 'open') closeIndex();
        else openIndex();
      } else if (e.key === 'Escape' && paneRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeIndex();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openIndex, closeIndex]);

  // The palette's "Go to a message" (nav-bus picks the conversation: in a race the one last focused
  // or pointed at). Focus goes back to where it was before the palette opened, not to the body.
  useEffect(
    () =>
      takeConversation(sessionId, {
        el: () => track.current?.closest('.tl') ?? null,
        marks: () => marksRef.current.length,
        open: (to) => {
          if (!marksRef.current.length) return;
          if (to && !to.closest('.nav-index, .nav')) back.current = to;
          if (paneRef.current !== 'open') openIndex();
        },
      }),
    [sessionId, openIndex],
  );

  useEffect(() => {
    if (pane !== 'open') return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.nav-index, .nav-hot')) closeIndex(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [pane, closeIndex]);

  // ── the pointer on the rail ──

  const aimAt = (clientY: number) => {
    const l = live.current;
    const hit = l ? railAt(l.rail, l.runs, l.open, (clientY - trackTop.current) / uiZoom() - l.offset) : null;
    setAim((was) => (!hit ? null : was && was.run === hit.run && was.mark === hit.mark ? was : hit));
  };

  const onPointerEnter = (e: ReactPointerEvent<HTMLButtonElement>) => {
    trackTop.current = track.current?.getBoundingClientRect().top ?? 0;
    pointer.current = e.pointerType;
    window.clearTimeout(linger.current);
    aimAt(e.clientY);
    if (!paneRef.current && e.pointerType === 'mouse' && e.buttons === 0) {
      window.clearTimeout(intent.current);
      intent.current = window.setTimeout(() => !paneRef.current && setPane((paneRef.current = 'peek')), INTENT);
    }
  };

  const onPointerLeave = () => {
    window.clearTimeout(intent.current);
    setAim(null);
    leave();
  };

  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    // By key (or a touch, which has no hover): the index. By the pointer: the run or the line under it.
    if (e.detail === 0 || pointer.current !== 'mouse') return paneRef.current === 'open' ? closeIndex() : openIndex();
    if (aim) pick(aim.mark);
  };

  // The wheel over the rail scrolls the conversation, as it does beside it.
  const hot = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = hot.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const sc = scroller.current;
      if (!sc || e.ctrlKey) return;
      e.preventDefault();
      // The reader moves the view: a jump lets go of its row.
      pin.current = null;
      aimed.current = -1;
      if (e.deltaY < 0) hold();
      sc.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY, behavior: 'instant' });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scroller, hold, show]);

  // ── drawing ──

  const lastMark = marks.length - 1;
  /** A mark's place on the track, on whole pixels (a line is one pixel tall). */
  const place = (v: number) => `translateY(${offset + Math.floor(v)}px)`;
  // The run the view is in (by its first message) and the one it was in before. Coming into a run
  // from another, its lines fan out of its bar while the other's close up into theirs: one motion.
  // The rail's first appearance and a message that joins the open run later play nothing.
  const openFrom = show && open >= 0 ? runs[open].from : -1;
  const [opened, setOpened] = useState({ now: -1, was: -1 });
  if (opened.now !== openFrom) setOpened({ now: openFrom, was: opened.now });
  const fanned = useRef(-1);
  const fan = opened.was >= 0 && fanned.current !== openFrom;
  useEffect(() => {
    fanned.current = openFrom;
  }, [openFrom]);
  const wasRun = opened.was >= 0 ? runOf(runs, opened.was) : -1;
  const closing = wasRun >= 0 && wasRun !== open && runs[wasRun].from === opened.was ? wasRun : -1;
  // The marks as elements, made again only when the rail changes: a new layout (a step in the
  // running turn) re-renders the navigator without touching them.
  const drawn = useMemo(() => {
    if (!show) return null;
    const out: ReactNode[] = [];
    runs.forEach((r, i) => {
      const n = r.to - r.from;
      // A run of one is its message's line, open or not.
      if (n === 1) return void out.push(<i key={`l${r.from}`} className="nav-line" style={{ transform: place(rail.top[i] + rail.height[i] / 2) }} />);
      // Every other run has its bar, out of sight while the run is open.
      const bar = i === open ? stackHeight(n) : rail.height[i];
      out.push(<i key={`s${r.from}`} className="nav-stack" data-open={i === open || undefined} style={{ height: bar, transform: place(rail.top[i]) }} />);
      if (i === open) {
        // A line per message. `--fan` is how far the bar's middle is from the line's place: where it
        // fans out from (navigator.css); nothing for a line that is simply there.
        for (let j = 0; j < n; j++) {
          const at = Math.floor((j + 0.5) * rail.pitch);
          out.push(<i key={`t${r.from + j}`} className="nav-line" style={{ transform: place(rail.top[i] + at), '--fan': fan ? `${(bar / 2 - at).toFixed(1)}px` : '0px' } as CSSProperties} />);
        }
      } else if (i === closing) {
        // The run the view just left: its lines (the same elements) close up into the bar's middle and stay out of sight.
        const mid = place(rail.top[i] + bar / 2);
        for (let j = 0; j < n; j++) out.push(<i key={`t${r.from + j}`} className="nav-line" data-out style={{ transform: mid }} />);
      }
    });
    return out;
  }, [show, runs, rail, open, closing, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const flags = useMemo(() => {
    if (!show) return null;
    const out: ReactNode[] = [];
    const y = (i: number) => place(markY(rail, runs, i));
    if (hits) {
      const seen = new Set<number>();
      for (const i of hits.on) {
        const row = Math.round(markY(rail, runs, i) / 2);
        if (seen.has(row)) continue;
        seen.add(row);
        out.push(<i key={`h${i}`} className="nav-flag" data-kind="hit" style={{ transform: y(i) }} />);
      }
      if (hits.at >= 0 && hits.at < marks.length) out.push(<i key="at" className="nav-flag" data-kind="at" style={{ transform: y(hits.at) }} />);
    }
    marks.forEach((m, i) => {
      if (m.failed) out.push(<i key={`f${i}`} className="nav-flag" data-kind="fail" style={{ transform: y(i) }} />);
    });
    if (waiting && lastMark >= 0) out.push(<i key="w" className="nav-flag" data-kind="wait" style={{ transform: y(lastMark) }} />);
    return out;
  }, [show, marks, runs, rail, offset, hits, waiting, lastMark]); // eslint-disable-line react-hooks/exhaustive-deps

  // The run or the line under the pointer, lit.
  let lit: ReactNode = null;
  if (show && aim && aim.run < runs.length) {
    const r = runs[aim.run];
    const line = aim.run === open || r.to - r.from === 1;
    lit = line ? (
      <i className="nav-lit" data-line style={{ transform: place(markY(rail, runs, aim.mark)) }} />
    ) : (
      <i className="nav-lit" style={{ height: rail.height[aim.run], transform: place(rail.top[aim.run]) }} />
    );
  }

  return (
    <>
      <div ref={track} className="nav" data-show={show || undefined} data-find={hits ? '' : undefined} data-open={pane ? '' : undefined} data-over={aim ? '' : undefined}>
        {show && (
          <>
            <button
              ref={hot}
              type="button"
              className="nav-hot"
              style={{ top: offset - REACH, height: rail.h + REACH * 2 }}
              aria-label="Your messages"
              aria-haspopup="dialog"
              aria-expanded={!!pane}
              onPointerEnter={onPointerEnter}
              onPointerMove={(e) => aimAt(e.clientY)}
              onPointerLeave={onPointerLeave}
              onClick={onClick}
            />
            <div className="nav-marks" aria-hidden>
              {drawn}
              {at >= 0 && <i ref={hereEl} className="nav-here" style={{ transform: place(markY(rail, runs, at)) }} />}
              {flags}
              {lit}
            </div>
          </>
        )}
      </div>
      <div className="nav-pane">
        <AnimatePresence>
          {pane && marks.length > 0 && (
            <Index
              key="index"
              sessionId={sessionId}
              marks={marks}
              runs={runs}
              here={at}
              waitAt={waiting ? lastMark : -1}
              asked={pane === 'open'}
              aim={aim}
              onPick={pick}
              onClose={closeIndex}
              onPin={pinIndex}
              onEnter={stay}
              onLeave={leave}
            />
          )}
        </AnimatePresence>
      </div>
    </>
  );
});

// ── the index ──

/** A message's words: the line its row shows and the text the field searches. Kept per item object (items never change in place). */
const WORDS = new WeakMap<object, { line: string; text: string }>();
function wordsOf(item: TimelineItem | undefined): { line: string; text: string } {
  if (item?.type !== 'user') return { line: 'Message', text: '' };
  let w = WORDS.get(item);
  if (!w) {
    const review = parseReview(item.text);
    const text = review ? review.lead : userItemText(item);
    w = { line: firstLine(text) || (review ? 'Review' : item.attachments?.length ? plural(item.attachments.length, 'attachment') : 'Message'), text };
    WORDS.set(item, w);
  }
  return w;
}

/** When a run began: the time for today's, the date and the time for earlier ones. */
function whenOf(ts: number): string {
  const { day, time } = stampParts(ts);
  return `${day || 'Today'}, ${time}`;
}

interface IndexProps {
  sessionId: string;
  marks: NavMark[];
  runs: NavRun[];
  /** The message in view. */
  here: number;
  /** The message that waits on the person, or -1. */
  waitAt: number;
  /** Asked for (a key, its field): the field has the focus and the index stays until closed. */
  asked: boolean;
  /** The rail under the pointer: the index brings that run beside it. */
  aim: Aim | null;
  onPick: (index: number) => void;
  onClose: (refocus?: boolean) => void;
  onPin: (from: Element | null) => void;
  onEnter: () => void;
  onLeave: () => void;
}

/**
 * The index: every message by its first words, under the time its run began. The message in view
 * is marked; the pointer or the arrows light a row, a click or Enter goes there. Typing into the
 * field keeps the messages that have every word typed, anywhere in them.
 */
const Index = memo(function Index({ sessionId, marks, runs, here, waitAt, asked, aim, onPick, onClose, onPin, onEnter, onLeave }: IndexProps) {
  const uid = useId();
  const rowId = (i: number) => `${uid}r${i}`;
  const rows = useMemo(() => {
    const items = useStore.getState().data[sessionId]?.items ?? {};
    return marks.map((m) => wordsOf(items[m.id]));
  }, [marks, sessionId]);

  const [query, setQuery] = useState('');
  const q = query.trim();
  // With something typed: each message's line and marks, null for one that does not match.
  const found = useMemo(() => (q ? rows.map((r) => matchPrompt(r.text, q)) : null), [rows, q]);
  const order = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) if (!found || found[i]) out.push(i);
    return out;
  }, [rows, found]);

  const [cur, setCur] = useState(() => (asked || !aim ? here : aim.mark));
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  /** The row was lit by a key: it is brought into view. */
  const byKey = useRef(false);

  // The list as lines of the rows' grid (a run's head and every row are `ROW` tall): only the lines
  // near the view are made, so moving the lit row among 300 messages renders a few dozen.
  const lines = useMemo(() => indexLines(runs, order, !!found), [runs, order, found]);
  const [win, setWin] = useState(() => {
    const at = Math.max(0, lines.rowAt.get(asked || !aim ? here : aim.mark) ?? 0);
    const from = Math.max(0, at - WINDOW);
    return { from, to: Math.min(lines.list.length, at + WINDOW) };
  });
  /** The lines in and near the view, read from where the list is scrolled. */
  const sync = useCallback(() => {
    const el = list.current;
    if (!el) return;
    const { from, to } = indexWindow(el.scrollTop, el.clientHeight, lines.list.length, ROW, PAD, OVERSCAN);
    setWin((w) => (w.from === from && w.to === to ? w : { from, to }));
  }, [lines]);
  useLayoutEffect(sync, [sync]);

  /** Where a message's row stands in the list (its offset from the list's top), or -1 when it is not listed. */
  const rowTop = (i: number) => {
    const at = lines.rowAt.get(i);
    return at === undefined ? -1 : PAD + at * ROW;
  };

  /** Moves the list (by a glide when asked for), always onto the rows' grid: no row is cut at its edges. */
  const scrollList = (top: number, smooth = false) => {
    const el = list.current;
    if (!el) return;
    const to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, Math.round(top / ROW) * ROW));
    const d = to - el.scrollTop;
    if (Math.abs(d) < 1) return;
    if (!smooth || reducedMotion()) {
      el.scrollTop = to;
      return sync();
    }
    if (Math.abs(d) > ROWS_GLIDE * ROW) el.scrollTop = to - Math.sign(d) * ROWS_GLIDE * ROW;
    sync();
    el.scrollTo({ top: to, behavior: 'smooth' });
  };

  /** A run from its head at the top of the list: as much of it as fits is in view. */
  const toRun = (r: number, smooth: boolean) => {
    const at = lines.headAt.get(r);
    if (at !== undefined) scrollList(at * ROW, smooth);
  };

  /** A message's row in view, moving the list no further than that takes. */
  const toRow = (i: number, smooth = false) => {
    const el = list.current;
    const row = rowTop(i);
    if (!el || row < 0) return;
    const top = row - PAD;
    if (top < el.scrollTop) scrollList(top, smooth);
    else if (top + ROW + PAD * 2 > el.scrollTop + el.clientHeight) scrollList(top + ROW + PAD * 2 - el.clientHeight, smooth);
  };

  /** A message's row in the middle of the list. */
  const centre = (i: number) => {
    const el = list.current;
    const row = rowTop(i);
    if (el && row >= 0) scrollList(row - PAD - Math.floor((el.clientHeight - PAD * 2) / ROW / 2) * ROW);
  };

  /** What the rail points at: a closed run from its head, a message of the run being read by its row. */
  const follow = (a: Aim, smooth: boolean) => {
    if (a.run === runOf(runs, here)) toRow(a.mark, smooth);
    else toRun(a.run, smooth);
  };

  // Opened: the message in view in the middle, or what the pointer is on.
  const first = useRef(true);
  useLayoutEffect(() => {
    centre(here);
    if (aim && !asked) follow(aim, false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The pointer moves along the rail: the index follows it, one glide per run.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!aim || q) return;
    byKey.current = false;
    setCur(aim.mark);
    follow(aim, true);
  }, [aim]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (asked) input.current?.focus({ preventScroll: true });
  }, [asked]);

  // Something typed: the first match is lit; cleared: the message in view again.
  const typed = useRef(false);
  useLayoutEffect(() => {
    if (!typed.current) return;
    typed.current = false;
    if (q) {
      setCur(order[0] ?? -1);
      if (list.current) list.current.scrollTop = 0;
      sync();
    } else {
      setCur(here);
      centre(here);
    }
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!byKey.current) return;
    byKey.current = false;
    toRow(cur);
  }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (by: number) => {
    if (!order.length) return;
    const at = order.indexOf(cur);
    const to = at < 0 ? (by > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + by));
    byKey.current = true;
    setCur(order[to]);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'PageDown') move(8);
    else if (e.key === 'PageUp') move(-8);
    else if (e.key === 'Enter') {
      if (cur >= 0 && order.includes(cur)) onPick(cur);
    } else if (e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
  };

  const point = useCallback((i: number) => {
    byKey.current = false;
    setCur(i);
  }, []);

  const field = asked || marks.length >= FIELD_FROM;
  const flagOf = (i: number) => (i === waitAt ? 'wait' : marks[i].failed ? 'fail' : undefined);
  // Only the lines near the view (`win`); spacers of the grid's height stand for the rest.
  const sections: ReactNode[] = [];
  const from = Math.min(win.from, lines.list.length);
  const to = Math.min(win.to, lines.list.length);
  if (found) {
    // What was typed: the messages that have it, one list, each with when it was sent.
    for (let k = from; k < to; k++) {
      const line = lines.list[k];
      const hit = line.kind === 'row' ? found[line.i] : null;
      if (line.kind === 'row' && hit) {
        const i = line.i;
        sections.push(<Row key={marks[i].id} i={i} id={rowId(i)} line={hit.line} marked={hit.indices} when={whenOf(marks[i].ts)} here={i === here} cur={i === cur} flag={flagOf(i)} onPick={onPick} onPoint={point} />);
      }
    }
  } else {
    // Each run in view as its group: its head when that is in view, and its rows that are.
    let k = from;
    while (k < to) {
      const first = lines.list[k];
      const r = first.kind === 'head' ? first.run : runOf(runs, first.i);
      const run = runs[r];
      const when = whenOf(marks[run.from].ts);
      const body: ReactNode[] = [];
      for (; k < to; k++) {
        const line = lines.list[k];
        if (line.kind === 'head') {
          if (line.run !== r) break;
          body.push(
            <div key="when" className="nav-when num" data-run={r} data-aim={aim?.run === r || undefined} aria-hidden>
              {when}
            </div>,
          );
          continue;
        }
        const i = line.i;
        body.push(<Row key={marks[i].id} i={i} id={rowId(i)} line={rows[i].line} marked={NONE} here={i === here} cur={i === cur} flag={flagOf(i)} onPick={onPick} onPoint={point} />);
      }
      sections.push(
        <div key={marks[run.from].id} className="nav-run" role="group" aria-label={when}>
          {body}
        </div>,
      );
    }
  }
  const above = from * ROW;
  const below = Math.max(0, lines.list.length - to) * ROW;

  return (
    <motion.div
      className="nav-index glass"
      role="dialog"
      aria-label="Your messages"
      data-field={field || undefined}
      data-spot=""
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // The entrance is a CSS animation (navigator.css): on the compositor from the first frame it is painted in.
      initial={false}
      exit={{ opacity: 0, transition: { duration: 0.09 } }}
    >
      {field && (
        <label className="nav-field">
          <Icon name="search" size={14} />
          <input
            ref={input}
            role="combobox"
            aria-label="Go to a message"
            aria-expanded
            aria-controls={`${uid}list`}
            aria-activedescendant={cur >= 0 ? rowId(cur) : undefined}
            aria-autocomplete="list"
            value={query}
            onChange={(e) => {
              typed.current = true;
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onFocus={(e) => onPin(e.relatedTarget)}
            // The focus went to something else (the palette, the composer): the index is done. A press inside it keeps it.
            onBlur={(e) => e.relatedTarget instanceof Element && !e.relatedTarget.closest('.nav-index') && onClose(false)}
            placeholder="Go to a message"
            spellCheck={false}
            autoComplete="off"
          />
          {!asked && <Kbd combo="mod+g" />}
        </label>
      )}
      <div ref={list} id={`${uid}list`} className="nav-list scroll" role="listbox" aria-label="Your messages" data-found={found ? '' : undefined} onScroll={sync}>
        {above > 0 && <div className="nav-space" style={{ height: above }} aria-hidden />}
        {sections}
        {below > 0 && <div className="nav-space" style={{ height: below }} aria-hidden />}
        {!lines.list.length && <p className="nav-none">No message matches “{q}”.</p>}
      </div>
    </motion.div>
  );
});

const NONE: number[] = [];

/** Lines made beyond the view on each side, and around the lit row before the list is first measured. */
const OVERSCAN = 10;
const WINDOW = 24;

interface RowProps {
  i: number;
  id: string;
  line: string;
  /** Characters of the line that match what was typed. */
  marked: number[];
  /** When it was sent: shown in a list of matches, which has no heads. */
  when?: string;
  here: boolean;
  cur: boolean;
  flag?: 'wait' | 'fail';
  onPick: (i: number) => void;
  onPoint: (i: number) => void;
}

const Row = memo(function Row({ i, id, line, marked, when, here, cur, flag, onPick, onPoint }: RowProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={cur}
      aria-current={here || undefined}
      className="nav-row"
      data-i={i}
      data-here={here || undefined}
      data-cur={cur || undefined}
      onPointerMove={() => onPoint(i)}
      // The field keeps the focus (and the keys) when a row is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(i)}
    >
      <span className="nav-words truncate">{marked.length ? highlightRuns(line, marked).map((r, k) => (r.hit ? <mark key={k}>{r.text}</mark> : <span key={k}>{r.text}</span>)) : line}</span>
      {when && <span className="nav-time num">{when}</span>}
      {flag && (
        <i className="nav-dot" data-kind={flag}>
          <span className="sr-only">{flag === 'wait' ? 'Waiting for you' : 'Failed'}</span>
        </i>
      )}
    </div>
  );
});
