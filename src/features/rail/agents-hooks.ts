import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTick } from '@/features/timeline/util';
import { useStore } from '@/state/store';
import { agentIndex, commandIndex, jobIndex, noteIndex, progressIndex, userIndex } from './agents-model';

type Store = ReturnType<typeof useStore.getState>;

/**
 * Whether the Agents pane is on screen. A closed panel and another tab keep the pane mounted
 * (Rail.tsx): while hidden every value it reads holds still, so streamed steps cost it nothing.
 */
export const ShownCtx = createContext(true);

/**
 * A store value that holds still while the pane is hidden: the selector is not run and nothing
 * renders until it shows again (the context change then renders each reader once, fresh).
 * Selectors must return stable values (strings, numbers, items, cached arrays).
 */
export function useShown<T>(select: (s: Store) => T): T {
  const shown = useContext(ShownCtx);
  const memo = useRef<{ has: boolean; v: T }>({ has: false, v: undefined as T });
  return useStore((s) => {
    const m = memo.current;
    if (shown || !m.has) {
      m.v = select(s);
      m.has = true;
    }
    return m.v;
  });
}

/** One clock for every live time in the pane, stopped while it is hidden. */
export function usePaneTick(): number {
  return useTick(useContext(ShownCtx));
}

interface Indexes {
  agents: ReturnType<typeof agentIndex>;
  users: ReturnType<typeof userIndex>;
  notes: ReturnType<typeof noteIndex>;
  commands: ReturnType<typeof commandIndex>;
  jobs: ReturnType<typeof jobIndex>;
}

/** Per session, shared by the tab's count and the list: the second reader of a state pays nothing. */
const indexes = new Map<string, Indexes>();

export function indexFor(sessionId: string): Indexes {
  let x = indexes.get(sessionId);
  if (!x) {
    x = { agents: agentIndex(), users: userIndex(), notes: noteIndex(), commands: commandIndex(), jobs: jobIndex() };
    indexes.set(sessionId, x);
    if (indexes.size > 12) indexes.delete(indexes.keys().next().value as string);
  }
  return x;
}

/** When the person last looked at each chat's Agents tab (while the app is open). */
const looked = new Map<string, number>();

/**
 * When the person last looked at this chat's Agents tab: when its pane last left the screen, else
 * when it first came on it. A failure after that is news (red); one before it is history. Read as
 * the pane comes on screen and held while it shows, so what fails in view stays news until the
 * person has looked away and back.
 */
export function useLooked(sessionId: string): number {
  const shown = useContext(ShownCtx);
  const held = useRef<{ id: string; shown: boolean; at: number } | null>(null);
  if (!held.current || held.current.id !== sessionId || (shown && !held.current.shown)) held.current = { id: sessionId, shown, at: looked.get(sessionId) ?? Date.now() };
  else held.current.shown = shown;
  useEffect(() => {
    if (!shown) return;
    return () => {
      looked.set(sessionId, Date.now());
      if (looked.size > 64) looked.delete(looked.keys().next().value as string);
    };
  }, [shown, sessionId]);
  return held.current.at;
}

/** How often a working agent's line may change: a burst of steps reads as a few calm updates. */
const SAMPLE_MS = 250;

/**
 * How far one working sub-agent is (see `progressIndex`), counted incrementally and read at most
 * every 250 ms: a store change only arms a timer, the count runs when it fires, and the card
 * renders only when the result differs. Nothing runs while the pane is hidden.
 */
export function useProgress(sessionId: string, id: string): string {
  const shown = useContext(ShownCtx);
  const read = useMemo(() => {
    const index = progressIndex();
    return () => {
      const d = useStore.getState().data[sessionId];
      return index(d?.items, d?.children[id]);
    };
  }, [sessionId, id]);
  const [value, setValue] = useState(read);
  useEffect(() => {
    if (!shown) return;
    let last = 0;
    let timer = 0;
    const check = () => {
      timer = 0;
      last = performance.now();
      setValue(read());
    };
    check();
    const off = useStore.subscribe(() => {
      if (timer) return;
      const wait = last + SAMPLE_MS - performance.now();
      if (wait <= 0) check();
      else timer = window.setTimeout(check, wait);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [shown, read]);
  return value;
}
