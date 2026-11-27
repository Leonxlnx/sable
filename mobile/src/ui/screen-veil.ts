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
 * never move); under reduced motion the change is made at once.
 *
 * Several changes in one gesture (a screen that opens and the one under it stepping back, home
 * hiding) share one veil: a change asked for while it covers waits for the same solid frame; one asked
 * for while it opens again covers again from where it stands.
 */

const INK = '#0a0a0b';
export const COVER_MS = 80;
export const REVEAL_MS = 130;
/** The veil's cells: 4 css px (on whole device pixels: veil.ts `crispCell`). */
const CELL = 4;

let covering: { then: (() => void)[]; remove: () => void } | null = null;
let opening: { remove: () => void } | null = null;

const hostOf = () => document.querySelector<HTMLElement>('.app');

/** Under reduced motion or the battery saver, before the app has a page, or while the launch still plays: at once. */
const atOnce = () => reduced() || saver() || !hostOf() || !!document.querySelector('.launch');

export function veilChange(then: () => void) {
  if (atOnce()) return then();
  if (covering) {
    covering.then.push(then);
    return;
  }
  const host = hostOf()!;
  // A reveal still under way: it goes, and the cover starts over it (the density only rises again).
  const cover = veil(host, 'cover', { color: INK, duration: COVER_MS, cell: CELL, z: 60 });
  const mine = { then: [then], remove: cover.remove };
  covering = mine;
  void cover.done.then(() => {
    if (covering !== mine) return;
    covering = null;
    for (const f of mine.then.splice(0)) {
      try {
        f();
      } catch (err) {
        console.error(err);
      }
    }
    // The new page's first frame is drawn under the solid veil, then it opens.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        opening?.remove();
        const open = veil(host, 'reveal', { color: INK, duration: REVEAL_MS, cell: CELL, z: 60 });
        opening = open;
        mine.remove();
        void open.done.then(() => opening === open && (opening = null));
      }),
    );
  });
}

/** Whether a veil covers or opens now (a test, and the field's frames: it holds while the page is hidden). */
export const veiled = () => !!covering || !!opening;
