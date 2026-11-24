import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';
import { onFlightClock, RELEASE } from './flight';

/**
 * The send key answers the press in the same beat as the words leave (`RELEASE`, flight.ts): the
 * disc gives (it sinks in its cove, the channel round it widens) and holds while the words go;
 * on the release the arrow launches up out of it (accelerating, clipped by the disc) and the
 * message's line leaves over the key's top (flight.ts), and as it runs the key comes back up;
 * the stop square grows where the arrow was. Drawn on a copy of the disc in
 * place of the real key for about 340 ms (the real one is hidden meanwhile: it changes twice
 * under it, to the empty key and to the stop key); the real stop key is the same disc with the
 * same square, so the copy simply goes. If the turn has not started by then (the stop key is not
 * showing), the copy fades instead of cutting to the empty key.
 *
 * With a message in the air the key's part runs on that message's clock (`onFlightClock`), the
 * one the line is drawn by: the arrow is gone over the disc's top in the frames the line leaves
 * there, whatever the main thread is doing.
 */
export function launchKey(card: HTMLElement | null) {
  if (!card || reducedMotion()) return;
  const key = card.querySelector<HTMLElement>('.cmp-send');
  const glyph = key?.querySelector('svg');
  if (!key || !glyph) return;
  const z = uiZoom();
  const r = key.getBoundingClientRect();
  if (!r.width) return;
  const disc = document.createElement('div');
  disc.className = 'sk-launch';
  disc.setAttribute('aria-hidden', 'true');
  disc.style.cssText = `left:${r.left / z}px;top:${r.top / z}px;width:${r.width / z}px;height:${r.height / z}px;`;
  card.setAttribute('data-launching', '');
  const show = () => card.removeAttribute('data-launching');
  const arrow = glyph.cloneNode(true) as SVGElement;
  const sq = document.createElement('span');
  sq.className = 'sk-launch-sq';
  disc.append(arrow, sq);
  document.body.appendChild(disc);

  // The recoil of a send with no message in the air (files alone): the card dips and springs
  // back, the disc copy rides along. With a message in the air, the card holds still for it
  // (flight.ts `data-pouring`) and the key's own give is the recoil.
  if (!card.hasAttribute('data-pouring')) {
    const back = spring(420, 24);
    const recoil: Keyframe[] = [{ translate: '0 2.5px' }, { translate: '0 0' }];
    const kick = { duration: back.duration, delay: RELEASE, easing: back.easing };
    play(card, recoil, kick);
    play(disc, recoil, kick);
  }
  const clock = onFlightClock(card);
  const on = (a: Animation | null) => {
    if (a) clock?.(a);
    return a;
  };
  on(play(disc, KEY_GIVE, { duration: KEY_GIVE_MS, easing: 'linear' }));
  on(play(arrow, ARROW_OUT, { duration: ARROW_OUT_MS, delay: RELEASE, easing: ARROW_OUT_EASE, fill: 'both' }));
  const grow = on(play(sq, SQUARE_IN, { duration: SQUARE_IN_MS, delay: SQUARE_IN_AT, easing: SQUARE_IN_EASE, fill: 'both' }));
  const done = () => {
    show();
    const stop = card.querySelector('.cmp-stop[data-on]');
    if (stop) return disc.remove();
    const out = play(disc, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'linear', fill: 'forwards' });
    if (out) out.finished.then(() => disc.remove(), () => disc.remove());
    else disc.remove();
  };
  if (grow) grow.finished.then(done, done);
  else {
    show();
    disc.remove();
  }
}

// The key's part as keyframes: the home card's copy plays the same on its own key (home/handoff.ts).

/**
 * The give: the key sinks quickly at the press, holds while the words go, and comes back up as
 * the line runs.
 */
export const KEY_GIVE_MS = 320;
export const KEY_GIVE: Keyframe[] = [
  { scale: '1', easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  { scale: '0.9', offset: 0.16, easing: 'linear' },
  { scale: '0.91', offset: 0.44, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' },
  { scale: '1' },
];

/**
 * The arrow's way out, from `RELEASE` on: up through the disc's top, gathering speed, as the line
 * leaves over the key (signal-shape.ts `BORN`), so the one becomes the other.
 */
export const ARROW_OUT: Keyframe[] = [
  { transform: 'translateY(0px)', opacity: 1 },
  { transform: 'translateY(-30px)', opacity: 0.6 },
];
export const ARROW_OUT_MS = 70;
export const ARROW_OUT_EASE = 'cubic-bezier(0.5, 0, 0.85, 0.4)';

/** The stop square grows where the arrow was, once the line has left. */
export const SQUARE_IN: Keyframe[] = [
  { transform: 'scale(0)', opacity: 0 },
  { transform: 'scale(1)', opacity: 1 },
];
export const SQUARE_IN_MS = 190;
export const SQUARE_IN_AT = RELEASE + 80;
export const SQUARE_IN_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
