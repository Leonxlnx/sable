import { useSyncExternalStore } from 'react';

/**
 * Screens over home: a chat, settings, and over a chat its changes and one file's diff (`items`: a
 * turn's steps, for that turn's changes; `lead`: the message that opened it). Home stays mounted
 * underneath (its scroll is kept).
 */
export type Route =
  /** `at`: where it opens: a root item (a search hit), or 'turn' for the newest turn's start (a notification). */
  | { name: 'chat'; id: string; at?: string; seq?: number; find?: string }
  | { name: 'settings' }
  /** Every signed-in account's plan windows (2.18: a screen of its own, was a sheet over home). */
  | { name: 'limits' }
  | { name: 'changes'; id: string; items?: string[]; lead?: string }
  | { name: 'diff'; id: string; path: string; items?: string[] };

/** The chat a screen belongs to (a chat, its changes, a diff of it). */
export const chatOf = (r: Route | undefined): string | undefined => (r && r.name !== 'settings' && r.name !== 'limits' ? r.id : undefined);

/** A key that tells screens apart (a layer per screen). */
export const routeKey = (r: Route): string =>
  r.name === 'chat' ? `chat:${r.id}` : r.name === 'changes' ? `changes:${r.id}:${r.items?.[0] ?? ''}` : r.name === 'diff' ? `diff:${r.id}:${r.items?.[0] ?? ''}:${r.path}` : r.name;

const strings = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const valid = (r: Route | null | undefined): r is Route => {
  if (!r || typeof r !== 'object') return false;
  if (r.name === 'settings' || r.name === 'limits') return true;
  if (typeof r.id !== 'string') return false;
  if (r.name === 'chat') return true;
  if (r.name === 'changes') return strings(r.items) && (r.lead === undefined || typeof r.lead === 'string');
  return r.name === 'diff' && typeof r.path === 'string' && strings(r.items);
};

// The open screens survive Android closing the app in the background: the next start opens them again.
const KEY = 'sable.nav';
const load = (): Route[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Route[];
    return Array.isArray(v) ? v.filter(valid).slice(-4) : [];
  } catch {
    return [];
  }
};

let stack: Route[] = [];
/** Tells two openings at the same place apart (the same hit tapped twice scrolls there again). */
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  try {
    // Where a chat was opened at is not kept: opened again later, it opens at its newest. Home alone keeps
    // nothing (after Forget, nothing of the desktop is written back).
    if (!stack.length) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(stack.map((r) => (r.name === 'chat' && r.at ? { name: 'chat', id: r.id } : r))));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
};

export const nav = {
  get stack() {
    return stack;
  },
  push(r: Route) {
    const top = stack[stack.length - 1];
    if (top && routeKey(top) === routeKey(r)) return;
    stack = [...stack.filter((x) => routeKey(x) !== routeKey(r) && (r.name === 'chat' || x.name !== r.name)), r];
    emit();
  },
  /** Opens a chat on top of home (replacing any other open chat, and what was open over it); `at`: where (see Route). */
  chat(id: string, at?: string, find?: string) {
    stack = [...stack.filter((x) => x.name === 'settings'), at ? { name: 'chat', id, at, seq: ++seq, ...(find ? { find } : {}) } : { name: 'chat', id }];
    emit();
  },
  pop(): boolean {
    if (!stack.length) return false;
    stack = stack.slice(0, -1);
    emit();
    return true;
  },
  /** Back to the chat a screen over it belongs to (after a review went out from its changes). */
  toChat(id: string) {
    const at = stack.findIndex((r) => r.name === 'chat' && r.id === id);
    if (at < 0 || at === stack.length - 1) return;
    stack = stack.slice(0, at + 1);
    emit();
  },
  reset() {
    stack = [];
    emit();
  },
  /** Puts back what was open when the app last ran (once, at start). */
  restore() {
    if (stack.length) return;
    const saved = load();
    if (!saved.length) return;
    stack = saved;
    listeners.forEach((l) => l());
  },
  /** Drops chats the desktop no longer has, and what was open over them. */
  prune(exists: (id: string) => boolean) {
    const next = stack.filter((r) => {
      const id = chatOf(r);
      return !id || exists(id);
    });
    if (next.length !== stack.length) {
      stack = next;
      emit();
    }
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const useNav = () => useSyncExternalStore(subscribe, () => stack);
