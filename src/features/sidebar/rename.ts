/**
 * Names edited in place in the sidebar (a folder, a project, a chat): when the field takes focus,
 * and what ends it. Enter keeps the new name, Escape the old one, a press outside the field's row
 * or focus moved on to another control (Tab, a shortcut that opens something) keeps the new name.
 * Nothing else ends it: not the menu it came from as it shrinks away under a moving pointer, not a
 * press on its own row beside the text, not the window losing focus, not the list moving its row,
 * not the app focusing something of its own (a chat's composer as the chat opens).
 */

// ── the name shown while the bridge is asked ──

/**
 * For the row's "name just given", once the bridge has answered that rename: it takes away the
 * name it gave and no other. A chat renamed twice before the first answer lost the second name to
 * the first answer, and its old title stood until the second.
 */
export const ownName =
  (title: string) =>
  (shown: string | null): string | null =>
    shown === title ? null : shown;

// ── focus, in the same frame the field appears ──

/**
 * A rename picked from a menu: the field takes focus, with its words selected, in the frame it
 * replaces the name, so the switch is one step (waiting for the menu to finish closing showed a
 * dead field for a few frames, then the selection popped in). The menu still closes for a moment,
 * and Radix moves focus inside it: to a row the pointer highlights, to the menu as the pointer
 * leaves a row, and a context menu keeps focus inside until it has closed (the item's action runs
 * before the menu closes). So the closing menu is made inert first: nothing in it can take focus.
 * Its close (`onCloseAutoFocus`) must not hand focus back to its trigger either: it hands it back
 * to the field instead, should anything have taken it meanwhile.
 */
let fromMenu = false;
let pending: (() => void) | null = null;

/** The sidebar's menus (`.side-pop`) about to close for a field: inert while they fade. */
function quietMenus() {
  if (typeof document === 'undefined') return;
  for (const m of document.querySelectorAll<HTMLElement>('.side-pop')) m.inert = true;
}

/** Wraps a menu action that puts focus somewhere of its own (a name field) instead of the trigger. */
export const holdFocus = (fn: () => void) => () => {
  fromMenu = true;
  quietMenus();
  fn();
};

/** For every sidebar menu's `onCloseAutoFocus`. */
export function onCloseAutoFocus(e: { preventDefault(): void }) {
  if (!fromMenu) return;
  e.preventDefault();
  fromMenu = false;
  const keep = pending;
  pending = null;
  keep?.();
}

/**
 * Focuses now. When a menu asked for the field, `keep` runs as that menu closes (it puts focus
 * back on the field if something took it, without touching what was typed). Returns a cancel.
 */
export function focusAfterMenu(focus: () => void, keep: () => void = focus, wait = 600): () => void {
  focus();
  if (!fromMenu) return () => {};
  pending = keep;
  // Should the menu never report its close, the next menu that closes still returns focus as usual.
  const t = setTimeout(() => {
    if (pending !== keep) return;
    pending = null;
    fromMenu = false;
  }, wait);
  return () => {
    clearTimeout(t);
    if (pending === keep) pending = null;
  };
}

// ── what ends an edit ──

/** Where a press landed, seen from the field: on it, on its own row beside it, on the sidebar's resize edge, or anywhere else. */
export type PressAt = 'field' | 'row' | 'edge' | 'outside';
/**
 * Where focus went when the field lost it: nowhere (the window, a moved row), into the closing
 * menu, to another control the person went on to (Tab, a shortcut, a dialog), or taken by the app
 * on its own (a chat opened by a double-click's first click focuses its composer once it mounts).
 */
export type BlurTo = 'nowhere' | 'menu' | 'control' | 'taken';

export type EditEvent = { type: 'key'; key: string } | { type: 'press'; at: PressAt; primary: boolean } | { type: 'blur'; to: BlurTo };

/**
 * What an event does to the edit. `hold: 'press'`: the press must not take focus (the caret moves
 * to the near end instead, as in a field's own empty end); `hold: 'focus'`: focus comes back to the
 * field if nothing else has it. `back`: focus returns to the row, so the keys carry on from there.
 */
export type EditStep = { end: false; hold?: 'press' | 'focus' } | { end: true; save: boolean; back: boolean };

export function editStep(e: EditEvent): EditStep {
  switch (e.type) {
    case 'key':
      if (e.key === 'Enter') return { end: true, save: true, back: true };
      if (e.key === 'Escape') return { end: true, save: false, back: true };
      return { end: false };
    case 'press':
      // A right press on the row asks for the row's menu: that ends the edit too.
      if (e.at === 'outside' || (e.at === 'row' && !e.primary)) return { end: true, save: true, back: false };
      return e.at === 'row' ? { end: false, hold: 'press' } : { end: false };
    case 'blur':
      return e.to === 'control' ? { end: true, save: true, back: false } : { end: false, hold: 'focus' };
  }
}

/** A key that can move focus on purpose: Tab, a shortcut, a function key (typing and editing keys cannot). */
export const movesFocus = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) => e.key === 'Tab' || e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.key);

/** How often the field takes its focus back from the app before it lets go (and keeps the name). */
export const TAKE_BACKS = 3;

/** The name as it is kept: inner runs of spaces as one, no spaces at the ends. */
export const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim();

// ── the DOM's side of it ──

/** The row a field edits in: a folder's or a project's header, a chat's row. */
const ROW = '.sgroup-head, .srow';

export function pressAt(target: EventTarget | null, field: HTMLElement): PressAt {
  if (!(target instanceof Node)) return 'outside';
  if (field.contains(target)) return 'field';
  if (field.closest(ROW)?.contains(target)) return 'row';
  // The resize edge runs along the field's end: resizing the sidebar does not end the edit.
  if (target instanceof Element && target.closest('.side-resize')) return 'edge';
  return 'outside';
}

/** `byKeys`: a key that moves focus on purpose was pressed just now (`movesFocus`). */
export function blurTo(related: EventTarget | null, byKeys: boolean): BlurTo {
  if (!(related instanceof Element)) return 'nowhere';
  if (related.closest('.pop[data-state="closed"]')) return 'menu';
  // A menu that opened or something modal is never fought over; a press inside a frame (a widget, a
  // page) is not seen from here.
  if (byKeys || related.closest('.pop, [role="menu"], [role="dialog"], [role="alertdialog"]') || related.matches('iframe, webview, embed, object')) return 'control';
  return 'taken';
}
