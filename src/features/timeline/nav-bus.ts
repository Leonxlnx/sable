import type { Built } from './nav-model';
import type { Group } from './turns';

/**
 * What the conversation's map hears from elsewhere, per session: the find bar's matches (ticks on
 * the map) and the keys that step between messages (Alt+Up, Alt+Down), which the map answers
 * from its own model of where every message stands.
 */

/** The turn layout as the timeline built it, handed to the map after each commit (one per timeline). */
export interface NavLayout {
  groups: readonly Group[];
  built: Built;
}

export interface NavFeed {
  get(): NavLayout | null;
  set(layout: NavLayout): void;
  subscribe(l: () => void): () => void;
}

export function navFeed(): NavFeed {
  let cur: NavLayout | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set(layout) {
      if (cur && cur.groups === layout.groups && cur.built.lead === layout.built.lead && cur.built.gapFrom === layout.built.gapFrom && cur.built.hidden === layout.built.hidden) return;
      cur = layout;
      subs.forEach((l) => l());
    },
    subscribe(l) {
      subs.add(l);
      return () => subs.delete(l);
    },
  };
}

export interface FindMarks {
  /** Matching items, in conversation order. */
  ids: readonly string[];
  /** The match the find bar is on. */
  current?: string;
}

type Listener = () => void;

const finds = new Map<string, FindMarks>();
const listeners = new Map<string, Set<Listener>>();
const steppers = new Map<string, (dir: 1 | -1) => boolean>();

const emit = (sessionId: string) => listeners.get(sessionId)?.forEach((l) => l());

export function setFindMarks(sessionId: string, marks: FindMarks | null) {
  const was = finds.get(sessionId);
  if (!marks || !marks.ids.length) {
    if (!was) return;
    finds.delete(sessionId);
  } else {
    if (was && was.current === marks.current && was.ids === marks.ids) return;
    finds.set(sessionId, marks);
  }
  emit(sessionId);
}

export const findMarks = (sessionId: string) => finds.get(sessionId);

export function onFindMarks(sessionId: string, l: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size) listeners.delete(sessionId);
  };
}

/** The open conversation's map takes the message keys; false when there is none to take them. */
export function stepMessage(sessionId: string, dir: 1 | -1): boolean {
  return steppers.get(sessionId)?.(dir) ?? false;
}

export function takeSteps(sessionId: string, step: (dir: 1 | -1) => boolean): () => void {
  steppers.set(sessionId, step);
  return () => {
    if (steppers.get(sessionId) === step) steppers.delete(sessionId);
  };
}

// ── "Go to a message" (the palette): which conversation answers, and where focus goes back ──

/** A conversation's map, as the palette's "Go to a message" reaches it. */
export interface NavConversation {
  /** The conversation's element (`.tl`), to know which one was last focused or pointed at. */
  el(): Element | null;
  /** How many messages its map holds. */
  marks(): number;
  /** Opens its index; Escape gives focus back to `back`. */
  open(back: HTMLElement | null): void;
}

const conversations = new Map<string, NavConversation>();
/** The conversation last focused or pointed at, while more than one is on screen. */
let lastConversation: string | null = null;
/** The element that last had focus outside the palette, a dialog or an index: where focus goes back. */
let lastFocus: HTMLElement | null = null;

/** Outside these, a focus is where the person was (the palette and dialogs only pass through). */
const PASSING = '.palette, .nav-index, [role="dialog"], [role="alertdialog"]';

function noteTarget(t: EventTarget | null, focus: boolean) {
  if (!(t instanceof Element)) return;
  if (focus && t instanceof HTMLElement && t !== document.body && !t.closest(PASSING)) lastFocus = t;
  if (conversations.size < 2) return;
  for (const [id, c] of conversations) {
    if (c.el()?.contains(t)) {
      lastConversation = id;
      return;
    }
  }
}

let listening = false;
function listen() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  // One pair of listeners for every map; each does a `closest` and at most two `contains`.
  document.addEventListener('focusin', (e) => noteTarget(e.target, true), true);
  document.addEventListener('pointerover', (e) => noteTarget(e.target, false), true);
  // Focus let go to nothing (a click on empty ground): there is no place to go back to.
  document.addEventListener(
    'focusout',
    (e) => {
      if (!e.relatedTarget && e.target === lastFocus && document.hasFocus()) lastFocus = null;
    },
    true,
  );
}

/** A map makes its conversation reachable by "Go to a message" while it is mounted. */
export function takeConversation(sessionId: string, c: NavConversation): () => void {
  listen();
  conversations.set(sessionId, c);
  return () => {
    if (conversations.get(sessionId) !== c) return;
    conversations.delete(sessionId);
    if (lastConversation === sessionId) lastConversation = null;
  };
}

/**
 * Which conversation "Go to a message" goes to: of those on screen (one chat, or a race's two, left
 * first), the one last focused or pointed at, else the first; null when that one has no messages on
 * its map (the action is left out then: it never falls over to the other side).
 */
export function pickConversation(onScreen: readonly string[], last: string | null, marks: (id: string) => number): string | null {
  if (!onScreen.length) return null;
  const id = last && onScreen.includes(last) ? last : onScreen[0];
  return marks(id) > 0 ? id : null;
}

/** `pickConversation` with the maps that are mounted now. */
export function goToMessageTarget(onScreen: readonly string[]): string | null {
  return pickConversation(onScreen, lastConversation, (id) => conversations.get(id)?.marks() ?? 0);
}

/**
 * Opens that conversation's index. Focus goes back to where it was before the palette opened (the
 * composer), not to whatever holds it while the palette closes. False when its map is gone.
 */
export function goToMessage(sessionId: string): boolean {
  const c = conversations.get(sessionId);
  if (!c || !c.marks()) return false;
  c.open(lastFocus?.isConnected ? lastFocus : null);
  return true;
}
