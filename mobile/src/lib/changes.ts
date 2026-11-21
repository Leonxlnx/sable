import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PhoneChangedFile, PhoneChanges, PhoneDiff } from '@shared/protocol';
import { conn } from './conn';
import { useStore, type State } from './store';

/**
 * What a chat changed, as the desktop answers `phone.changes` and `phone.diff`: kept per chat (and
 * per turn) for this run, so a screen opened again shows at once what it showed last and the
 * desktop's answer replaces it when it comes. Asked again when the chat's work moves on (a turn
 * ends, a step that writes files settles) and when the connection comes back.
 */

/** The chat's own changes, or (with `items`, a turn's steps) that turn's. */
export interface ChangesScope {
  sid: string;
  items?: string[];
}

export interface Entry<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

const EMPTY: Entry<never> = { loading: false };
export const scopeKey = (s: ChangesScope) => (s.items ? `${s.sid}|turn:${s.items.length}:${s.items[0] ?? ''}:${s.items[s.items.length - 1] ?? ''}` : `${s.sid}|all`);

const lists = new Map<string, Entry<PhoneChanges>>();
const diffs = new Map<string, Entry<PhoneDiff>>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function put<T>(map: Map<string, Entry<T>>, key: string, e: Entry<T>, keep = 0) {
  map.delete(key);
  map.set(key, e);
  // The oldest go first (a map keeps its order of insertion).
  while (keep && map.size > keep) map.delete(map.keys().next().value as string);
  emit();
}

/** The same answer as before keeps its object (the rows built from it are not built again). */
const same = (a: unknown, b: unknown) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));

function load<T>(map: Map<string, Entry<T>>, key: string, ask: () => Promise<T>, keep: number) {
  const cur = map.get(key);
  if (cur?.loading || conn.state !== 'open') return;
  put(map, key, { ...cur, loading: true }, keep);
  ask().then(
    (data) => {
      const was = map.get(key)?.data;
      put(map, key, { data: same(was, data) ? was : data, loading: false }, keep);
    },
    (err: Error) => put(map, key, { data: map.get(key)?.data, error: err.message || String(err), loading: false }, keep),
  );
}

export const reloadChanges = (s: ChangesScope) => load(lists, scopeKey(s), () => conn.call('phone.changes', { sessionId: s.sid, ...(s.items ? { items: s.items } : {}) }), 24);
export const reloadDiff = (s: ChangesScope, path: string) =>
  load(diffs, `${scopeKey(s)}|${path}`, () => conn.call('phone.diff', { sessionId: s.sid, path, ...(s.items ? { items: s.items } : {}) }), 30);

/** Moves when the chat's work could have changed files: its state, and how many file-touching steps have settled (the store keeps that count per changed item). */
function workSignature(sid: string) {
  return (s: State) => `${s.sessions[sid]?.status ?? ''}|${s.data[sid]?.fileSteps ?? 0}`;
}

/**
 * The list of changed files, asked for on open, when the chat's work moves on and when the
 * connection is back. `passive`: only asked for when there is none (another screen keeps it fresh).
 */
export function useChanges(scope: ChangesScope, passive = false): Entry<PhoneChanges> {
  const key = scopeKey(scope);
  const entry = useSyncExternalStore(subscribe, () => lists.get(key) ?? EMPTY);
  const online = useStore((s) => s.conn === 'open');
  const sig = useStore(workSignature(scope.sid));
  const asked = useRef('');
  useEffect(() => {
    if (!online || (passive && lists.get(key)?.data)) return;
    // On open and when the connection is back at once; a burst of steps settling asks once.
    const now = asked.current !== key;
    asked.current = key;
    const t = window.setTimeout(() => reloadChanges(scope), now ? 0 : 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online, sig]);
  useEffect(() => {
    if (!online) asked.current = '';
  }, [online]);
  return entry;
}

/** One file's diff: shown from the last answer at once, asked again on open, when the file's counts change and when the connection is back. */
export function useDiff(scope: ChangesScope, path: string, file?: PhoneChangedFile): Entry<PhoneDiff> {
  const key = `${scopeKey(scope)}|${path}`;
  const entry = useSyncExternalStore(subscribe, () => diffs.get(key) ?? EMPTY);
  const online = useStore((s) => s.conn === 'open');
  const sig = file ? `${file.status}|${file.additions}|${file.deletions}` : '';
  useEffect(() => {
    if (online) reloadDiff(scope, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online, sig]);
  return entry;
}

// Forgetting the computer forgets what it showed.
conn.onState(() => {
  if (conn.state !== 'unpaired') return;
  lists.clear();
  diffs.clear();
  emit();
});
