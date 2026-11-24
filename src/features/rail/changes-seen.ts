import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { FileDiff, SeenFile, SeenState, TimelineItem } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { useRepo } from './git-state';

/**
 * "Since you last looked" in the Changes tab: what the bridge says the person has seen of each
 * changed file of a chat (`seen.state`, `seen.mark`; server/services/seen.ts holds the rule and the
 * store), read whenever the tab reads the working tree (never otherwise), and the diff of what is
 * new since a file was seen, loaded when its row opens.
 *
 * The window's own rule for "read": a diff that stood open, on screen, for `READ_MS` and is then
 * closed by the person counts as looked at (closing it is the gesture "done with this one"). The
 * explicit action is always there: Mark seen on the row (and the `m` key), Mark all seen for the
 * scope.
 */

/** How long a diff must stand open before closing it marks it seen. */
export const READ_MS = 2000;
/** How long Mark all seen offers its undo in its own place. */
export const UNDO_MS = 6000;

export type SinceEntry = { state: 'loading' } | { state: 'ok'; diff: FileDiff | null; hash: string } | { state: 'error' };

interface SeenView {
  repo: boolean;
  /** By path. */
  files: Record<string, SeenFile>;
  /** Diffs since seen, by path (for the hash they were made for). */
  since: Record<string, SinceEntry>;
  /** Undo ids of recent marks, by path (the row's control takes its own mark back). */
  undo: Record<string, string>;
}

export const useSeen = create<{ chats: Record<string, SeenView> }>(() => ({ chats: {} }));

const EMPTY: SeenView = { repo: false, files: {}, since: {}, undo: {} };

function put(sessionId: string, fn: (v: SeenView) => Partial<SeenView>) {
  useSeen.setState((s) => {
    const cur = s.chats[sessionId] ?? EMPTY;
    return { chats: { ...s.chats, [sessionId]: { ...cur, ...fn(cur) } } };
  });
}

function apply(sessionId: string, st: SeenState) {
  put(sessionId, (v) => {
    const files: Record<string, SeenFile> = {};
    for (const f of st.files) files[f.path] = f;
    // A diff since seen stays only for the content it was made for.
    const since: Record<string, SinceEntry> = {};
    for (const [p, e] of Object.entries(v.since)) if (files[p] && (e.state !== 'ok' || e.hash === files[p].hash)) since[p] = e;
    return { repo: st.repo, files, since };
  });
}

export const useSeenView = (sessionId: string): SeenView | undefined => useSeen((s) => s.chats[sessionId]);

const reading = new Map<string, Promise<void>>();

export function loadSeen(sessionId: string, cwd: string): Promise<void> {
  const running = reading.get(sessionId);
  if (running) return running;
  const p = bridge
    .call('seen.state', { sessionId, cwd }, 30_000)
    .then((st) => apply(sessionId, st))
    // Unknown: the tab shows the whole list without seen marks rather than nothing.
    .catch(() => {
      if (!useSeen.getState().chats[sessionId]) apply(sessionId, { repo: false, files: [] });
    })
    .finally(() => reading.delete(sessionId));
  reading.set(sessionId, p);
  return p;
}

/** The diff of what is new since `path` was seen (only for a file the bridge says has one). */
export function loadSince(sessionId: string, cwd: string, path: string) {
  const f = useSeen.getState().chats[sessionId]?.files[path];
  if (!f?.since) return;
  const cur = useSeen.getState().chats[sessionId]?.since[path];
  if (cur && (cur.state === 'loading' || (cur.state === 'ok' && cur.hash === f.hash))) return;
  put(sessionId, (v) => ({ since: { ...v.since, [path]: { state: 'loading' } } }));
  bridge
    .call('seen.state', { sessionId, cwd, path }, 30_000)
    .then((st) => {
      const now = st.files[0];
      put(sessionId, (v) => ({
        since: { ...v.since, [path]: { state: 'ok', diff: st.diff ?? null, hash: now?.hash ?? f.hash } },
        ...(now ? { files: { ...v.files, [path]: now } } : {}),
      }));
    })
    .catch(() => put(sessionId, (v) => ({ since: { ...v.since, [path]: { state: 'error' } } })));
}

/**
 * Marks files seen as the tab shows them. Answers the undo id (for the whole mark), or null when the
 * bridge refused. The rows change in the frame of the click: the bridge's answer then confirms.
 */
export async function markSeen(sessionId: string, cwd: string, files: readonly SeenFile[]): Promise<string | null> {
  if (!files.length) return null;
  const before = useSeen.getState().chats[sessionId]?.files ?? {};
  put(sessionId, (v) => {
    const next = { ...v.files };
    for (const f of files) next[f.path] = { ...f, state: 'seen', at: Date.now(), base: undefined, since: undefined };
    return { files: next };
  });
  try {
    const r = await bridge.call('seen.mark', { sessionId, cwd, files: files.map((f) => ({ path: f.path, hash: f.hash })) }, 30_000);
    apply(sessionId, r);
    if (!r.ok || !r.undo) return null;
    const undo = r.undo;
    put(sessionId, (v) => {
      const u = { ...v.undo };
      for (const f of files) u[f.path] = undo;
      return { undo: u };
    });
    return undo;
  } catch {
    put(sessionId, (v) => ({ files: { ...v.files, ...Object.fromEntries(files.map((f) => [f.path, before[f.path] ?? f])) } }));
    return null;
  }
}

/** A seen file new again: its own recent mark taken back when there is one, else its seen state dropped. */
export async function unmarkSeen(sessionId: string, cwd: string, path: string): Promise<void> {
  const v = useSeen.getState().chats[sessionId];
  const undo = v?.undo[path];
  put(sessionId, (cur) => {
    const f = cur.files[path];
    const u = { ...cur.undo };
    delete u[path];
    return { undo: u, ...(f ? { files: { ...cur.files, [path]: { ...f, state: 'new' } } } : {}) };
  });
  const sole = undo && !Object.entries(v?.undo ?? {}).some(([p, id]) => id === undo && p !== path);
  try {
    const r = await bridge.call('seen.mark', { sessionId, cwd, ...(sole ? { undo } : { unmark: [path] }) }, 30_000);
    apply(sessionId, r);
  } catch {
    void loadSeen(sessionId, cwd);
  }
}

/** Takes a whole mark back (Mark all seen's undo). */
export async function undoSeen(sessionId: string, cwd: string, undo: string): Promise<void> {
  put(sessionId, (v) => ({ undo: Object.fromEntries(Object.entries(v.undo).filter(([, id]) => id !== undo)) }));
  try {
    apply(sessionId, await bridge.call('seen.mark', { sessionId, cwd, undo }, 30_000));
  } catch {
    void loadSeen(sessionId, cwd);
  }
}

/** Reads the seen states each time the tab has read the working tree (and only then). */
export function useSeenRefresh(sessionId: string, cwd: string) {
  const rev = useRepo(cwd)?.rev ?? 0;
  useEffect(() => {
    if (rev) void loadSeen(sessionId, cwd);
  }, [sessionId, cwd, rev]);
}

// ───────────────────────────── this turn ─────────────────────────────

const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * The files the chat's last turn edited, as the tab names them (relative to the chat's folder): from
 * the last message the person sent to the end, edits of sub-agents included. Walks only that turn.
 */
export function turnPaths(items: Record<string, TimelineItem | undefined>, roots: readonly string[], children: Record<string, string[] | undefined>, cwd: string): Set<string> {
  const out = new Set<string>();
  let from = roots.length;
  while (from > 0) {
    const it = items[roots[from - 1]];
    from--;
    if (it?.type === 'user') break;
  }
  const walk = (ids: readonly string[], depth: number) => {
    for (const id of ids) {
      const it = items[id];
      if (it?.type !== 'tool') continue;
      if ((it.kind === 'edit' || it.kind === 'write') && it.status === 'done') for (const d of it.result?.diff ?? []) out.add(norm(relPath(d.path, cwd)));
      else if (it.kind === 'agent' && depth < 4) walk(children[id] ?? [], depth + 1);
    }
  };
  walk(roots.slice(from), 0);
  return out;
}

/**
 * `turnPaths` of the chat, read again each time the tab reads the working tree (which it does when
 * an edit settles or a turn ends), never per streamed word.
 */
export function useTurnPaths(sessionId: string, cwd: string): ReadonlySet<string> {
  const rev = useRepo(cwd)?.rev ?? 0;
  const last = useRef<{ key: string; paths: Set<string> } | null>(null);
  return useMemo(() => {
    const d = useStore.getState().data[sessionId];
    if (!d) return new Set<string>();
    const paths = turnPaths(d.items, d.roots, d.children, cwd);
    // The same set while it holds the same paths: rows memoised on it draw again only when it changes.
    const key = [...paths].sort().join('\n');
    if (last.current?.key === key) return last.current.paths;
    last.current = { key, paths };
    return paths;
  }, [sessionId, cwd, rev]);
}
