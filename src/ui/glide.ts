/**
 * One highlight per menu that glides between rows.
 *
 * Radix highlights a menu row by focusing it (pointer and keyboard alike). Instead of each row
 * lighting up on its own, every `.pop` gets one `.menu-glide` element under its rows; on each
 * focus it moves to the focused row with a short transform transition (ui.css), for the keys and
 * the pointer alike. The row's own words answer in the same frame (their colour steps, it does not
 * fade in), so the highlight never reads as late; the fill is two thirds of the way in its first
 * frame and retargets when the pointer moves on, so a fast pointer drags one pill behind it and
 * never leaves a trail of rows fading out.
 *
 * - The first row of a visit (or one reached after the pointer rested outside the rows) gets the
 *   pill in place, faded in; it never flies in from a row it left a while ago.
 * - Crossing a label or a separator, the pill stays where it was for a moment and travels on.
 * - A pick: the pill steps up one fill while the row is held, keeps that light when the row is
 *   picked, and the menu leaves a moment later (`data-picked`, `--d-pick` in ui.css). A row that
 *   keeps its menu open gives the light back.
 *
 * - The pill only ever rests on the focused row: focus on anything else in the menu (its search
 *   field) lets it go, and when the rows change under it (a filter) it follows its row or, with
 *   the row gone, lets go at once.
 * - A pick is taken once: the menu that leaves takes no input (`inert`, focus let go), so a second
 *   Enter or a click into it does nothing, and what is typed meanwhile goes to the field that takes
 *   focus once the menu is gone. What the eye sees (the hold, the fold) does not change.
 *
 * Positions are read (two rects, converted to the pop's CSS pixels) before anything is written,
 * inside the menu only: a move restyles one element and repaints nothing outside the menu.
 * Nothing here knows about a specific menu; a popover without menu rows never gets a glide.
 */

/** Which input moved the focus last. */
let byKeys = false;

/** Whether the latest move came from the keyboard (lists outside menus use it to glide their own pill). */
export const movedByKeys = () => byKeys;

const ROW = '.menu-item[role^="menuitem"], .menu-item[role="option"]';

/** How long after the pill let go of a row it may still travel to the next one (it is still fading). */
const LINGER = 140;

interface Glide {
  row: HTMLElement | null;
  /** Where the pill was put last (the pop's own pixels), to tell when its row moved. */
  box: string;
  /** The frame in which the pill lets go, when the pointer left the rows. */
  hide: number;
  /** When it let go. */
  hidAt: number;
}

const state = new WeakMap<HTMLElement, Glide>();
const stateOf = (pop: HTMLElement): Glide => {
  let s = state.get(pop);
  if (!s) state.set(pop, (s = { row: null, box: '', hide: 0, hidAt: -1e9 }));
  return s;
};

/** What focus landing inside a menu does to the pill: a row takes it, anything else (the menu itself, a search field) lets it go. */
export const onFocusIn = (isRow: boolean): 'place' | 'hide' => (isRow ? 'place' : 'hide');

/**
 * The rows changed under the pill (a filter took rows away or moved them): with its row gone it
 * lets go at once (never left over another row, which Enter would not pick); with its row moved
 * it follows without a glide; otherwise nothing.
 */
export function reconcile(row: { inMenu: boolean; box: string } | null, was: string): 'drop' | 'follow' | 'keep' {
  if (!row) return 'keep';
  if (!row.inMenu) return 'drop';
  return row.box === was ? 'keep' : 'follow';
}

function glideOf(pop: HTMLElement): HTMLElement {
  let g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  if (!g) {
    g = document.createElement('span');
    g.className = 'menu-glide';
    g.setAttribute('aria-hidden', 'true');
    pop.prepend(g);
    pop.dataset.glide = '';
    // The rows can change while the menu is open (a filter): the pill keeps to its row.
    if (typeof MutationObserver === 'function')
      new MutationObserver(() => {
        const s = state.get(pop);
        const row = s?.row;
        if (!s || !row || s.hide || pop.dataset.state === 'closed') return;
        const inMenu = row.isConnected && pop.contains(row);
        const step = reconcile({ inMenu, box: inMenu ? boxKey(boxIn(row, pop)) : '' }, s.box);
        if (step === 'drop') drop(pop);
        else if (step === 'follow') place(pop, row, false);
      }).observe(pop, { childList: true, subtree: true });
  }
  return g;
}

const boxKey = (b: { x: number; y: number; w: number; h: number }) => `${b.x},${b.y},${b.w},${b.h}`;

/** The row's box in the pop's own coordinates, scroll offsets of anything between taken off. */
function boxIn(row: HTMLElement, pop: HTMLElement) {
  const P = pop.getBoundingClientRect();
  const R = row.getBoundingClientRect();
  // Client pixels to the pop's own CSS pixels (Interface size zooms floating layers).
  const k = P.width ? pop.offsetWidth / P.width : 1;
  return {
    x: Math.round((R.left - P.left) * k - pop.clientLeft),
    y: Math.round((R.top - P.top) * k - pop.clientTop),
    w: Math.round(R.width * k),
    h: Math.round(R.height * k),
  };
}

function place(pop: HTMLElement, row: HTMLElement, travel: boolean) {
  const s = stateOf(pop);
  if (s.hide) cancelAnimationFrame(s.hide);
  s.hide = 0;
  const b = boxIn(row, pop);
  const g = glideOf(pop);
  // Still on a row, or let go of one a moment ago: travel. Otherwise land in place and fade in.
  const fresh = g.dataset.on !== undefined || performance.now() - s.hidAt < LINGER;
  if (!travel || !fresh) g.dataset.jump = '';
  else delete g.dataset.jump;
  g.style.width = `${b.w}px`;
  g.style.height = `${b.h}px`;
  g.style.transform = `translate(${b.x}px, ${b.y}px)`;
  g.dataset.tone = row.dataset.tone ?? '';
  g.dataset.on = '';
  s.box = boxKey(b);
  // The row under the pill says so: a row with a fill of its own (one whose submenu is open)
  // steps it aside while the pill is there, so the two never add up (ui.css).
  if (s.row !== row) {
    s.row?.removeAttribute('data-glide-on');
    row.setAttribute('data-glide-on', '');
  }
  s.row = row;
}

/**
 * The pointer left the rows (Radix moves focus to the menu itself). Moving from one row to the
 * next is a leave and an enter in the same task: the pill lets go a frame later, and only if no
 * row took it meanwhile.
 */
function hide(pop: HTMLElement) {
  const s = stateOf(pop);
  if (s.hide || !s.row) return;
  s.hide = requestAnimationFrame(() => {
    s.hide = 0;
    s.row?.removeAttribute('data-glide-on');
    s.row = null;
    s.hidAt = performance.now();
    const g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
    if (g) delete g.dataset.on;
  });
}

/** Its row is gone: the pill lets go now, and the next row it lands on gets it in place. */
function drop(pop: HTMLElement) {
  const s = stateOf(pop);
  if (s.hide) cancelAnimationFrame(s.hide);
  s.hide = 0;
  s.row?.removeAttribute('data-glide-on');
  s.row = null;
  s.hidAt = -1e9;
  const g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  if (g) delete g.dataset.on;
}

// ── a pick is taken once ──

/** How long after a pick what is typed is kept for the field that takes focus next. */
const HOLD = 600;
/** Typed since the pick, with focus on nothing; and until when it is kept. */
let held = '';
let holdUntil = 0;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/**
 * A key pressed after a pick while the menu leaves and focus is on nothing: Enter is dropped (the
 * pick was taken already), typing is kept (`text`, Backspace taking back what was kept) for the
 * field that takes focus once the menu is gone, anything else (Escape, Tab, a shortcut) goes on.
 */
export function keyAfterPick(text: string, e: KeyLike): { act: 'drop' | 'hold' | 'pass'; text: string } {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return { act: 'pass', text };
  if (e.key === 'Enter') return { act: 'drop', text };
  if ([...e.key].length === 1) return { act: 'hold', text: text + e.key };
  if (e.key === 'Backspace' && text) return { act: 'hold', text: [...text].slice(0, -1).join('') };
  return { act: 'pass', text };
}

/** Whether a row's menu has been picked from already (it is leaving, or let go of its content). */
export const taken = (pop: { inert: boolean; dataset: { state?: string } }) => pop.inert || pop.dataset.state === 'closed';

/**
 * After a pick's own handlers ran: every menu now leaving (a submenu's parent too) takes no input
 * from here on, and focus still inside one lets go, so no key reaches it. Radix still returns
 * focus where it would (it focuses its target itself, wherever focus is meanwhile); a menu opened
 * again while it was leaving takes input again.
 */
function seal() {
  let any = false;
  for (const pop of document.querySelectorAll<HTMLElement>('.pop[data-state="closed"]')) {
    if (pop.inert) continue;
    pop.inert = true;
    any = true;
    const mo = new MutationObserver(() => {
      if (pop.dataset.state === 'closed') return;
      pop.inert = false;
      mo.disconnect();
    });
    mo.observe(pop, { attributes: true, attributeFilter: ['data-state'] });
  }
  // (A menu made inert by its own action, a rename, may still hold focus: the browser lets go of
  // it only later.)
  const at = document.activeElement;
  const inside = at instanceof HTMLElement && !!at.closest('.pop[data-state="closed"][inert]');
  if (inside) at.blur();
  if (!any && !inside) return;
  held = '';
  holdUntil = performance.now() + HOLD;
}

/**
 * A pick made from a control that is not a row (Enter in a menu's search field): the same hand-off
 * as a row's pick, once the menu has begun to leave.
 */
export function pickedByKey() {
  window.setTimeout(seal, 0);
}

/** The field that took focus after a pick gets what was typed meanwhile, at its caret. */
function deliver(el: HTMLElement, text: string) {
  const field = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|url|email|tel|password)$/.test(el.type));
  if (!field && !el.isContentEditable) return;
  // After whatever focused it has finished (it may set the field's text itself).
  queueMicrotask(() => {
    if (document.activeElement !== el) return;
    if (document.execCommand('insertText', false, text)) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

/** A row was picked (a click, or Enter and Space, which Radix turns into one). */
function picked(row: HTMLElement) {
  const pop = row.closest<HTMLElement>('.pop');
  if (!pop || row.hasAttribute('data-disabled')) return;
  const g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  // A menu opened under the pointer may be picked from before any row took focus.
  if (!g || stateOf(pop).row !== row) place(pop, row, false);
  pop.dataset.picked = '';
  row.dataset.picked = '';
  // A row that keeps its menu open (a toggle) gives the light back.
  window.setTimeout(() => {
    if (!pop.isConnected || pop.dataset.state === 'closed') return;
    delete pop.dataset.picked;
    delete row.dataset.picked;
  }, 180);
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => (byKeys = true), { capture: true, passive: true });
  document.addEventListener('pointermove', () => (byKeys = false), { capture: true, passive: true });
  document.addEventListener('pointerdown', () => (byKeys = false), { capture: true, passive: true });

  // After a pick, focus is on nothing until the menu's target takes it: keep the typing for it.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!holdUntil) return;
      if (performance.now() > holdUntil) {
        held = '';
        holdUntil = 0;
        return;
      }
      const at = document.activeElement;
      if (at && at !== document.body && !at.closest('.pop[inert]')) return;
      const r = keyAfterPick(held, e);
      if (r.act === 'pass') return;
      e.preventDefault();
      e.stopPropagation();
      held = r.text;
    },
    true,
  );

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      if (holdUntil && !t.closest('.pop[inert]')) {
        const text = held;
        held = '';
        holdUntil = 0;
        if (text) deliver(t, text);
      }
      const pop = t.closest<HTMLElement>('.pop');
      if (!pop || pop.dataset.state === 'closed') return;
      const row = t.closest<HTMLElement>(ROW);
      const isRow = !!row && pop.contains(row) && !row.hasAttribute('data-disabled');
      // Radix moves focus to the menu itself when the pointer leaves the rows; a search field in
      // the menu is not a row either, and Enter there picks what the field says, not the pill.
      if (onFocusIn(isRow) === 'place') place(pop, row!, true);
      else hide(pop);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(ROW) : null;
      const pop = row?.closest<HTMLElement>('.pop');
      if (!row || !pop) return;
      // A second Enter (Radix turns it into a click) or a click into a menu already picked from.
      if (taken(pop)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      picked(row);
      // Should the pick's own handlers stop the click before it bubbles up (below), still in time
      // for the next key.
      window.setTimeout(seal, 0);
    },
    true,
  );

  // The pick's handlers have run and the menu has its new state (React commits in a microtask).
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest(ROW)?.closest('.pop')) queueMicrotask(seal);
  });

  // A row scrolled under a still pointer: follow it without a glide.
  document.addEventListener(
    'scroll',
    (e) => {
      const s = e.target;
      if (!(s instanceof HTMLElement)) return;
      const pop = s.closest<HTMLElement>('.pop');
      const row = pop && state.get(pop)?.row;
      if (pop && row?.isConnected) place(pop, row, false);
    },
    { capture: true, passive: true },
  );
}
