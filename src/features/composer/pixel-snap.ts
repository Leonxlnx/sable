import { useLayoutEffect, type RefObject } from 'react';
import { uiZoom } from '@/lib/motion';

/**
 * Whole device pixels for the pane.
 *
 * The pane's fill, its words and its rim are painted above the pane's own blur, so the compositor
 * holds them in a layer of their own, and it places such a layer where the card's first whole CSS
 * pixel falls on the screen. At a display scale that is no whole number (125%, 150%, 175%) that
 * is seldom a whole device pixel: CSS pixel 643 is device pixel 803.75 at 125%. Such a layer is
 * drawn between device pixels, through the compositor's filter: everything in it a quarter of a
 * pixel or more smeared, the rim's top and bottom edges weaker than its sides and its words a
 * little softer than the page's. Measured in a chat at 125% (a window 760 tall, the docked pane's
 * top at 643): the rim's bottom edge at 89% of the edges' mean and the top at 107%; with the card
 * moved 0.2 px down, every edge, corner and the cove within 96 to 100%.
 *
 * So the card is moved by the part of a device pixel that is missing, at most half of one, and
 * the layer stands on whole pixels again. At 100% and 200% there is nothing to move. (A dock that
 * grows a line moves its top edge by 22 px: the shift is worked out again whenever the card or
 * what places it changes size.)
 */

/**
 * How far to move something that stands at `pos` so that its first whole pixel is a whole device
 * pixel, in the same units as `pos` (CSS px as the window measures them). Within half a device
 * pixel either way; 0 where the scale is a whole number.
 */
export function snapShift(pos: number, dpr: number): number {
  if (!(dpr > 0) || !Number.isFinite(pos)) return 0;
  // The layer starts on the card's first whole CSS pixel (a layout position is a 64th of a pixel exact).
  const first = Math.floor(pos + 1 / 128);
  const shift = Math.round(first * dpr) / dpr - first;
  return Math.abs(shift) < 1e-6 ? 0 : shift;
}

/**
 * How far to move a line that stands at `pos` so that it lies on a whole device pixel, in the
 * units of `pos`: half a device pixel at most, 0 where it lies on one already.
 */
export function toDevicePixel(pos: number, dpr: number): number {
  if (!(dpr > 0) || !Number.isFinite(pos)) return 0;
  const move = Math.round(pos * dpr) / dpr - pos;
  return Math.abs(move) < 1e-6 ? 0 : move;
}

/**
 * Calls `moved` whenever `el` stands somewhere else in the window, whatever moved it (the window,
 * a neighbour that grew, a column that centred itself again): no size of its own need change.
 * An intersection observer whose root is shrunk to the element's own box says so the moment the
 * box is no longer where it was, and is then set up again round the new place. The browser works
 * this out with the frames it draws anyway: nothing runs while nothing moves. (The way Floating
 * UI's `autoUpdate` follows a layout shift.)
 */
export function watchPlace(el: HTMLElement, moved: () => void): () => void {
  if (typeof IntersectionObserver !== 'function') return () => {};
  let io: IntersectionObserver | null = null;
  let timer = 0;
  const stop = () => {
    window.clearTimeout(timer);
    io?.disconnect();
    io = null;
  };
  const watch = (tell: boolean, threshold = 1) => {
    stop();
    if (tell) moved();
    const root = document.documentElement;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const margin = `${-Math.floor(r.top)}px ${-Math.floor(root.clientWidth - r.right)}px ${-Math.floor(root.clientHeight - r.bottom)}px ${-Math.floor(r.left)}px`;
    let first = true;
    try {
      io = new IntersectionObserver(
        (entries) => {
          const ratio = entries[0]?.intersectionRatio ?? 0;
          if (ratio !== threshold) {
            if (!first) return watch(true);
            // Not whole at the start (cut by the window's edge): watch at the share that shows; out of view, look again in a while.
            if (!ratio) timer = window.setTimeout(() => watch(true, 1e-7), 1000);
            else watch(true, ratio);
          }
          first = false;
        },
        { root: null, rootMargin: margin, threshold: Math.max(0, Math.min(1, threshold)) || 1 },
      );
      io.observe(el);
    } catch {
      /* a margin the browser will not take: the other triggers still hold */
    }
  };
  watch(false);
  return stop;
}

/** Keeps `card` on whole device pixels (see above) wherever it comes to stand. */
export function usePixelSnap(card: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = card.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    let tx = 0;
    let ty = 0;
    const apply = () => {
      const dpr = window.devicePixelRatio || 1;
      const z = uiZoom() || 1;
      let nx = 0;
      let ny = 0;
      if (Math.abs(dpr - Math.round(dpr)) > 1e-3) {
        const r = el.getBoundingClientRect();
        // Where the card stands without its shift (the window measures in zoomed pixels, the shift is the card's own).
        nx = snapShift(r.left - tx * z, dpr) / z;
        ny = snapShift(r.top - ty * z, dpr) / z;
      }
      if (Math.abs(nx - tx) < 0.004 && Math.abs(ny - ty) < 0.004) return;
      tx = nx;
      ty = ny;
      el.style.translate = nx || ny ? `${nx.toFixed(3)}px ${ny.toFixed(3)}px` : '';
    };
    // Its own size (a line more moves its top edge in the dock), the window, and any other move.
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    const unwatch = watchPlace(el, apply);
    // A move of less than a pixel is under what the watch sees: looked at again when the person comes to the pane.
    el.addEventListener('pointerenter', apply);
    el.addEventListener('focusin', apply);
    apply();
    return () => {
      ro.disconnect();
      unwatch();
      window.removeEventListener('resize', apply);
      el.removeEventListener('pointerenter', apply);
      el.removeEventListener('focusin', apply);
      el.style.translate = '';
    };
  }, [card]);
}
