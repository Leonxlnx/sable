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
  /** The frame in which the pill lets go, when the pointer left the rows. */
  hide: number;
  /** When it let go. */
  hidAt: number;
}

const state = new WeakMap<HTMLElement, Glide>();
const stateOf = (pop: HTMLElement): Glide => {
  let s = state.get(pop);
  if (!s) state.set(pop, (s = { row: null, hide: 0, hidAt: -1e9 }));
  return s;
};

function glideOf(pop: HTMLElement): HTMLElement {
  let g = pop.querySelector<HTMLElement>(':scope > .menu-glide');
  if (!g) {
    g = document.createElement('span');
    g.className = 'menu-glide';
    g.setAttribute('aria-hidden', 'true');
    pop.prepend(g);
    pop.dataset.glide = '';
  }
  return g;
}

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

  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const pop = t.closest<HTMLElement>('.pop');
      if (!pop || pop.dataset.state === 'closed') return;
      if (t.matches(ROW) && !t.hasAttribute('data-disabled')) place(pop, t, true);
      // Radix moves focus to the menu itself when the pointer leaves the rows.
      else if (t === pop || t.matches('[role="menu"]')) hide(pop);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(ROW) : null;
      if (row) picked(row);
    },
    true,
  );

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
