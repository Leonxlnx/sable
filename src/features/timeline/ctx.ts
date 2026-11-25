import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { loadWholeItem } from '@/state/actions';
import { useStore } from '@/state/store';
import { requestWhileCut } from './whole-request';
import type { NavFeed } from './nav-bus';

export interface TimelineCtxValue {
  sessionId: string;
  cwd: string;
  home: string;
  /** False while an existing transcript is being laid out; true once new items should animate in. */
  live: { current: boolean };
  /** True while the view follows the newest content; false once the reader has scrolled away. */
  stuck: { current: boolean };
  /** When the reader last scrolled (performance.now()); the conversation's own view keeps it. */
  scrolled?: { current: number };
  /** Where the turn list hands its layout to the conversation's map (Navigator). */
  nav?: NavFeed;
}

export const TimelineCtx = createContext<TimelineCtxValue>({ sessionId: '', cwd: '', home: '', live: { current: false }, stuck: { current: true }, scrolled: { current: 0 } });

export const useTimeline = () => useContext(TimelineCtx);

/** Subscribes to exactly one item, so a streaming delta re-renders one component. */
export function useItem<T extends TimelineItem = TimelineItem>(id: string): T | undefined {
  const { sessionId } = useTimeline();
  return useStore((s) => s.data[sessionId]?.items[id]) as T | undefined;
}

/** Fetch a cut row while its details are open. */
export function useWhole(item: TimelineItem, open = true) {
  const { sessionId } = useTimeline();
  const more = open && 'more' in item && !!item.more;
  useEffect(() => {
    if (more && sessionId) return requestWhileCut(sessionId, item.id);
  }, [more, sessionId, item]);
}

/** How long an opened row that came cut waits for its whole content before it opens on what it has (ms). */
export const WHOLE_WAIT_MS = 400;

/**
 * Whether a row asked open may draw its details: at once when it came whole; when it came cut
 * (`more`: an old turn's step or thinking, CLAUDE.md 0.2.31) once the whole item is here, or after
 * `WHOLE_WAIT_MS` on what it has. Opening on the cut content first showed its short head, then the
 * whole text arriving a moment later grew the details again under the reader (a flash of cut text
 * and a second jump of everything below). The control answers in the frame of the click (its caret,
 * `aria-expanded`); only the details wait, usually one round trip to the bridge.
 */
export function useWholeOpen(item: TimelineItem, open: boolean): boolean {
  useWhole(item, open);
  const more = 'more' in item && !!item.more;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!open || !more) return setLate(false);
    const t = window.setTimeout(() => setLate(true), WHOLE_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [open, more, item.id]);
  return open && (!more || late);
}

/**
 * A press handler for a cut row's control: the whole item is asked on the press, so it is usually
 * here by the click (a press lasts 60 to 120 ms; the round trip in the packaged app about 100) and
 * the details open in the frame of the click instead of a round trip after it.
 */
export function useWholeAhead(item: TimelineItem): (() => void) | undefined {
  const { sessionId } = useTimeline();
  const more = 'more' in item && !!item.more;
  return useMemo(() => (more && sessionId ? () => void loadWholeItem(sessionId, item.id) : undefined), [more, sessionId, item]);
}

/**
 * Whether a component is mounting for something that just happened (as opposed to
 * history being laid out). Decided once at mount, so the entrance animation plays once.
 */
export function useFresh(ts?: number): boolean {
  const { live } = useTimeline();
  const [fresh] = useState(() => live.current && (ts === undefined || Date.now() - ts < 4000));
  return fresh;
}

/** Steps that arrive closer together than this (ms) come in a burst: they appear without an entrance. */
const BURST_MS = 150;
const entered = new Map<string, boolean>();
let lastEntrance = 0;

/**
 * Whether a fresh step row plays its entrance. A step on its own rises in; steps that arrive in a
 * burst (a quick run of reads, a 300-step marathon) simply appear while the view glides after them,
 * so the trail never has a dozen rows rising at once. Decided once per item.
 */
export function stepEntrance(id: string): boolean {
  let v = entered.get(id);
  if (v === undefined) {
    const now = performance.now();
    v = now - lastEntrance >= BURST_MS;
    lastEntrance = now;
    entered.set(id, v);
    if (entered.size > 400) entered.delete(entered.keys().next().value as string);
  }
  return v;
}

export const EMPTY: string[] = [];
