import { useMemo, useRef } from 'react';
import type { ToolItem } from '@shared/protocol';
import { changedSince, useStore } from '@/state/store';

export function splitPath(path: string): [dir: string, base: string] {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

const NONE: string[] = [];

/**
 * Ids of this session's tool items (top level and inside sub-agents) that pass `test`,
 * in timeline order. Returns the same array until the matching set changes, so
 * streaming text elsewhere in the session does not re-render the caller.
 */
export function useToolIds(sessionId: string, test: (it: ToolItem) => boolean, observeRows = false): string[] {
  const selector = useMemo(() => toolIdsSelector(sessionId, test, observeRows), [sessionId, observeRows]); // eslint-disable-line react-hooks/exhaustive-deps
  return useStore(selector);
}

/**
 * The selector behind `useToolIds`. A write re-tests only the items it changed (`changedSince`);
 * every item is read again only for a new timeline. Exported for tests.
 * `test` is expected to be a stable predicate; callers pass inline arrows that only read the item.
 */
export function toolIdsSelector(sessionId: string, test: (it: ToolItem) => boolean, observeRows = false) {
  let lastRows: ToolItem[] = [];
  let lastRev = -1;
  let lastKey = '';
  let lastIds: string[] = NONE;
  // Matching ids, and every item's place in the order items joined (equal times keep that order).
  let match = new Set<string>();
  let order = new Map<string, number>();
  let seq = 0;
  return (s: ReturnType<typeof useStore.getState>): string[] => {
    const d = s.data[sessionId];
    if (!d) return NONE;
    if (d.rev === lastRev) return lastIds;
    const changed = changedSince(d, lastRev);
    lastRev = d.rev;
    let moved = false;
    const take = (id: string) => {
      const it = d.items[id];
      if (!it) {
        order.delete(id);
        if (match.delete(id)) moved = true;
        return;
      }
      if (!order.has(id)) order.set(id, seq++);
      const want = it.type === 'tool' && test(it);
      if (want && observeRows) moved = true;
      if (want === match.has(id)) return;
      if (want) match.add(id);
      else match.delete(id);
      moved = true;
    };
    if (changed) changed.forEach(take);
    else {
      match = new Set();
      order = new Map();
      seq = 0;
      for (const id in d.items) take(id);
      moved = true;
    }
    if (!moved) return lastIds;
    const ids = [...match].sort((a, b) => d.items[a].ts - d.items[b].ts || order.get(a)! - order.get(b)!);
    const key = ids.join('\u0000');
    const rows = observeRows ? ids.map(id => d.items[id] as ToolItem) : lastRows;
    if (key !== lastKey || rows.some((row, i) => row !== lastRows[i])) {
      lastRows = rows;
      lastKey = key;
      lastIds = ids.length ? ids : NONE;
    }
    return lastIds;
  };
}

export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p);
}

export function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/]{2}|\/)/.test(p);
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/^[\\/]+/, '').replace(/[\\/]/g, sep);
}

/**
 * Keys that joined a list while it was on screen: those rows arrive with a short rise (`data-new`).
 * The first set is simply there, and so is a whole batch (a tree that just loaded, a new plan).
 */
export function useArrivals(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (!seen.current) seen.current = new Set(keys);
  else {
    const news = keys.filter((k) => !seen.current!.has(k));
    const quiet = seen.current.size === 0 || news.length > 6;
    for (const k of news) {
      seen.current.add(k);
      if (!quiet) fresh.current.add(k);
    }
  }
  return fresh.current;
}
