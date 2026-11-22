import { EASE_OUT, play, uiZoom } from '@/lib/motion';
import { ARRIVE, arriving } from './glide';

/**
 * Popovers grow out of where they came from and shrink back into it.
 *
 * Every `.pop` opens with the `pop-grow` keyframes and closes with `pop-shrink` (ui.css): a
 * clip from an origin rectangle to the full box, so the content is never scaled. This module
 * supplies that rectangle. When a popover's open or close animation starts, it finds the
 * trigger (Radix links the two with aria attributes), measures both live, and writes the
 * insets as custom properties on the popover. Nothing here knows about a specific menu.
 *
 * - Default: the popover hangs off its trigger. It grows from the stretch of its own edge that
 *   touches the trigger.
 * - `data-origin="select"`: the popover opens over its trigger like a native select. It is
 *   shifted so its `[data-current]` row lies exactly on the trigger (as far as the window
 *   allows), starts as the trigger's rectangle, and that row takes focus.
 * - A context menu has no trigger: it grows from the corner the pointer asked for it at.
 *
 * The rows arrive just behind the pane: each a few pixels short of its place, on the side the pane
 * grows from, and a beat after the row before it (nearest the origin first). Transform and opacity
 * only, once, and only the rows in view; a popover without rows brings its children in by a fade
 * alone, in the same order. `data-arrive="none"` on a popover keeps its content still, and
 * `data-arrive-row` makes any element inside one a row.
 *
 * A row is drawn short of its place while it arrives, so nothing may be placed by where a row is
 * drawn then: the menu's highlight takes the row's place in the layout and the row's own clock
 * (each arrival carries the id `ARRIVE`; glide.ts).
 */

const PAD = 10;

/** Where the last context menu was asked for (it has no trigger to grow from). */
let ctxAt: { x: number; y: number; t: number } | null = null;
const origins = new WeakMap<HTMLElement, DOMRect>();

function triggerOf(pop: HTMLElement): HTMLElement | null {
  const by = pop.getAttribute('aria-labelledby');
  const el = by ? document.getElementById(by) : null;
  if (el) return el;
  return pop.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(pop.id)}"]`) : null;
}

/** The box the pane grows from, in the window: its trigger, or the point a context menu was asked for at. */
function originOf(pop: HTMLElement, trig: HTMLElement | null, opening: boolean): DOMRect | null {
  if (trig?.isConnected) {
    const T = trig.getBoundingClientRect();
    return T.width || T.height ? T : null;
  }
  if (!opening) return origins.get(pop) ?? null;
  if (pop.getAttribute('role') !== 'menu' || !ctxAt || performance.now() - ctxAt.t > 600) return null;
  const at = new DOMRect(ctxAt.x, ctxAt.y, 0, 0);
  origins.set(pop, at);
  return at;
}

/** Insets along one axis: the trigger's own span where the two overlap, else a strip at the near edge. */
function axis(t0: number, t1: number, c0: number, c1: number): [number, number] {
  const a = Math.max(t0, c0);
  const b = Math.min(t1, c1);
  if (b - a >= 6) return [a - c0, c1 - b];
  const size = c1 - c0;
  const strip = Math.min(size, Math.max(10, size * 0.15));
  return (t0 + t1) / 2 <= (c0 + c1) / 2 ? [0, size - strip] : [size - strip, 0];
}

/** Measures the origin and writes it. Returns where along its height the pane grows from (its own pixels), or null. */
function setOrigin(pop: HTMLElement, opening: boolean): number | null {
  const trig = triggerOf(pop);
  const T = originOf(pop, trig, opening);
  if (!T) return null;
  const z = uiZoom();
  let C = pop.getBoundingClientRect();
  const select = pop.dataset.origin === 'select' && !!trig;
  // The offset goes on the positioning box, so the shadow behind the pane follows it (ui.css).
  const box = pop.parentElement?.hasAttribute('data-radix-popper-content-wrapper') ? pop.parentElement : pop;

  if (opening && select) {
    const row = pop.querySelector<HTMLElement>('[data-current]');
    if (row) {
      const R = row.getBoundingClientRect();
      const ra = row.querySelector('[data-origin-anchor]');
      const ta = trig!.querySelector('[data-origin-anchor]');
      let dx = ra && ta ? ta.getBoundingClientRect().left - ra.getBoundingClientRect().left : T.left - R.left;
      let dy = T.top + T.height / 2 - (R.top + R.height / 2);
      // Stay inside the window: the row lands on the trigger only where there is room for the rest.
      dx = Math.min(Math.max(dx, PAD - C.left), window.innerWidth - PAD - C.right);
      dy = Math.min(Math.max(dy, PAD - C.top), window.innerHeight - PAD - C.bottom);
      box.style.setProperty('--o-x', `${dx / z}px`);
      box.style.setProperty('--o-y', `${dy / z}px`);
      C = new DOMRect(C.left + dx, C.top + dy, C.width, C.height);
      // Focus lands on the row at the start of the next frame, not inside the task that opens the
      // menu: a focus move forces a style pass, and here the menu's styles were just invalidated.
      // (Focus may still be outside: a select-like menu skips Radix's own focus on open.)
      requestAnimationFrame(() => {
        // Leave focus alone only if something inside the menu (its search field) already took it.
        const at = document.activeElement;
        const taken = !!at && at !== pop && pop.contains(at);
        if (row.isConnected && pop.dataset.state !== 'closed' && !taken) row.focus({ preventScroll: true });
      });
    }
  }

  const [l, r] = axis(T.left, T.right, C.left, C.right);
  const [t, b] = axis(T.top, T.bottom, C.top, C.bottom);
  // On the positioning box: the pane inherits them, and the shadow behind it grows from the same box.
  const s = box.style;
  s.setProperty('--g-l', `${l / z}px`);
  s.setProperty('--g-r', `${r / z}px`);
  s.setProperty('--g-t', `${t / z}px`);
  s.setProperty('--g-b', `${b / z}px`);
  s.setProperty('--g-sx', `${C.width ? Math.max(0.02, (C.width - l - r) / C.width) : 1}`);
  s.setProperty('--g-sy', `${C.height ? Math.max(0.02, (C.height - t - b) / C.height) : 1}`);
  s.setProperty('--g-rad', select ? `${Math.min(14, T.height / 2 / z)}px` : '10px');
  return (t + (C.height - b)) / 2 / z;
}

/** How many rows get a beat of their own (the rest arrive with the last); the beat, the wait before the first and a row's own rise, in ms. */
const BEATS = 7;
const BEAT = 11;
const FIRST = 14;
const RISE = 190;
const TOTAL = FIRST + BEATS * BEAT + RISE;
const ROWS = '.menu-item, .menu-label, .menu-sep, [data-arrive-row]';
const DIM = '[data-disabled], [aria-disabled="true"], :disabled';

/**
 * The rows arrive behind the pane. One pass reads the rows' boxes (the layout is clean here), then
 * each row in view gets one compositor animation; nothing is left on the rows afterwards. Every
 * row's animation covers the same span (its beat is a hold inside it), so the rows become layers
 * together and stop being layers together: the pane is painted once when they start and once when
 * they are done, not once per row as each one lands.
 */
function arrive(pop: HTMLElement, originY: number | null) {
  if (pop.dataset.arrive === 'none') return;
  let rows = [...pop.querySelectorAll<HTMLElement>(ROWS)];
  // A popover without rows brings its own children in, by fading only: a part of a popover may
  // sit where it does by a transform of its own, and that is never touched.
  const plain = !rows.length;
  if (plain) rows = [...pop.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.matches('.menu-glide, .spot-ring'));
  if (!rows.length || rows.length > 80) return;
  const P = pop.getBoundingClientRect();
  if (!P.height) return;
  const k = pop.offsetHeight / P.height;
  const from = originY ?? 0;
  const seen: { el: HTMLElement; d: number }[] = [];
  for (const el of rows) {
    const R = el.getBoundingClientRect();
    if (!R.height || R.bottom < P.top || R.top > P.bottom) continue;
    seen.push({ el, d: ((R.top + R.bottom) / 2 - P.top) * k - from });
  }
  seen.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
  // The last row of a list that scrolls only fades when the rows are drawn below their place: its
  // offset would lengthen what the list can scroll while it arrives, and a list scrolled to its end
  // in those frames (to its current row) is pulled back, rows and highlight, when the row lands.
  const lastIn = new Set<HTMLElement>();
  if (!plain)
    for (const scroller of pop.querySelectorAll<HTMLElement>('.scroll')) {
      let last: HTMLElement | undefined;
      for (const el of rows) if (scroller.contains(el)) last = el;
      if (last) lastIn.add(last);
    }
  // A row that is dim by itself (disabled) arrives dim, never lit first: its own opacity is read.
  const own = seen.map(({ el }) => (plain || el.matches(DIM) ? Number(getComputedStyle(el).opacity) || 1 : 1));
  seen.forEach(({ el, d }, i) => {
    const start = (FIRST + Math.min(i, BEATS) * BEAT) / TOTAL;
    const end = Math.min(1, start + RISE / TOTAL);
    // A row on the origin itself (the current row of a select-like menu) only fades.
    const dy = Math.abs(d) < 14 ? 0 : d > 0 ? -5 : lastIn.has(el) ? 0 : 5;
    const at = plain ? {} : { transform: `translateY(${dy}px)` };
    const home = plain ? {} : { transform: 'translateY(0px)' };
    const a = play(
      el,
      [
        { opacity: 0, ...at, offset: 0 },
        { opacity: 0, ...at, offset: start, easing: EASE_OUT },
        { opacity: own[i], ...home, offset: end },
      ],
      { duration: TOTAL },
    );
    if (a) a.id = ARRIVE;
  });
  // A highlight that took a row before the rows set off (the keys opened the menu) arrives with it.
  arriving(pop);
}

const placed = new WeakSet<HTMLElement>();

function open(pop: HTMLElement) {
  arrive(pop, setOrigin(pop, true));
}

/** Radix holds a popover still (`animation: none`) until it is positioned; the moment that lifts is the open. */
function whenPositioned(pop: HTMLElement) {
  const ready = () => pop.style.animationName !== 'none' && pop.style.animation !== 'none';
  const go = () => {
    if (placed.has(pop)) return;
    placed.add(pop);
    open(pop);
  };
  if (ready()) {
    go();
    return;
  }
  const mo = new MutationObserver(() => {
    if (!ready()) return;
    mo.disconnect();
    go();
  });
  mo.observe(pop, { attributes: true, attributeFilter: ['style'] });
}

if (typeof document !== 'undefined' && typeof MutationObserver === 'function') {
  // Opening: measured in the same task that positions the popover, so its first painted frame
  // is already the origin rectangle. Floating layers are portalled to the body, so only the
  // body's own child list is watched.
  const watch = () =>
    new MutationObserver((records) => {
      for (const rec of records)
        for (const node of rec.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.hasAttribute('data-radix-popper-content-wrapper')) continue;
          const pop = node.firstElementChild;
          if (pop instanceof HTMLElement && pop.classList.contains('pop')) whenPositioned(pop);
        }
    }).observe(document.body, { childList: true });
  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch, { once: true });

  document.addEventListener('contextmenu', (e) => (ctxAt = { x: e.clientX, y: e.clientY, t: performance.now() }), true);

  // Closing: shrink into wherever the trigger is now (its label may have changed size).
  document.addEventListener(
    'animationstart',
    (e) => {
      const pop = e.target;
      if (!(pop instanceof HTMLElement) || !pop.classList.contains('pop')) return;
      if (e.animationName === 'pop-shrink') setOrigin(pop, false);
      else if (e.animationName === 'pop-grow' && !placed.has(pop)) {
        placed.add(pop);
        open(pop);
      }
    },
    true,
  );
}
