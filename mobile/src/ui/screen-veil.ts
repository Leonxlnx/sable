import { saver } from '@m/lib/saver';
import { veil } from './veil';
import { reduced } from './motion';

/**
 * A change of screen through the dither, as on the desktop (src/art/veil.ts, `veilCover` in the
 * frame of the input, the views switched under it, `veilReveal`): four quarter-tiles of the 4x4
 * ordered dither in the ground's ink step in by opacity until the page is solid (about 80 ms), every
 * change asked for meanwhile is made under it (`then`: a screen shown or let go, home hidden or shown),
 * and once that frame is drawn the quarters step out again (about 130 ms). Nothing slides and nothing
 * scales: the screens only change under the veil. Compositor only (opacity on four small layers that
 * never move); under reduced motion or the battery saver the change is made at once.
 *
 * Several changes in one gesture (a screen that opens and the one under it hidden, home hidden) share
 * one veil: a change asked for while it covers waits for the same solid frame, one asked for while it
 * is solid is made at once. `veilFirst` starts the cover in the frame of the input and makes the
 * change (a navigation) under the solid veil, as the desktop does, so the work of building the new
 * screen happens where nobody sees it and the tap answers at once.
 */

/** The ground every screen stands on (base.css `--bg`, the launch's ink): content dissolves into it. */
const INK = '#070708';
export const COVER_MS = 80;
export const REVEAL_MS = 130;
/** The veil's cells: 4 css px (on whole device pixels: veil.ts `crispCell`). */
const CELL = 4;
/** A cover that never reports its end (its page hidden, its animations dropped) lets the change through after this. */
const SAFETY_MS = COVER_MS + 420;

let covering: { then: (() => void)[]; remove: () => void } | null = null;
let opening: { remove: () => void } | null = null;
/** Between the solid frame and the reveal: what is asked for now is made at once, under the veil. */
let solid = false;

const hostOf = () => document.querySelector<HTMLElement>('.app');

/** Under reduced motion or the battery saver, before the app has a page, or while the launch still plays: at once. */
const atOnce = () => reduced() || saver() || !hostOf() || !!document.querySelector('.launch');

const run = (fs: (() => void)[]) => {
  for (const f of fs) {
    try {
      f();
    } catch (err) {
      console.error(err);
    }
  }
};

export function veilChange(then: () => void) {
  if (solid || atOnce()) return then();
  if (covering) {
    covering.then.push(then);
    return;
  }
  const host = hostOf()!;
  // (A film of the steps: `window.__sableVeilSlow = 8` stretches the veil's clock for a recording.)
  const k = Math.max(1, Number((window as unknown as { __sableVeilSlow?: number }).__sableVeilSlow) || 1);
  // A reveal still under way: the cover starts over it (the density only rises again).
  const cover = veil(host, 'cover', { color: INK, duration: COVER_MS * k, cell: CELL, z: 60 });
  const mine = { then: [then], remove: cover.remove };
  covering = mine;
  const finish = () => {
    if (covering !== mine) return;
    covering = null;
    solid = true;
    run(mine.then.splice(0));
    // The new page's first frame is drawn under the solid veil (a navigation made just now renders in
    // a microtask, its effects see `solid`), then it opens.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        solid = false;
        opening?.remove();
        const open = veil(host, 'reveal', { color: INK, duration: REVEAL_MS * k, cell: CELL, z: 60 });
        opening = open;
        mine.remove();
        void open.done.then(() => opening === open && (opening = null));
      }),
    );
  };
  void cover.done.then(finish);
  window.setTimeout(finish, SAFETY_MS * k);
}

/** A navigation through the veil: the cover starts in this frame, `go` runs under it once it is solid. */
export const veilFirst = (go: () => void) => veilChange(go);

/** Whether a veil covers or opens now. */
export const veiled = () => !!covering || !!opening || solid;
