import { createContext, useContext, useEffect, useState } from 'react';
import type { TimelineItem } from '@shared/protocol';
import { loadWholeItem } from '@/state/actions';
import { useStore } from '@/state/store';
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
    if (more && sessionId) void loadWholeItem(sessionId, item.id);
  }, [more, sessionId, item]);
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
