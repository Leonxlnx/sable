import { quarterTiles, resolve } from '@/art/veil';
import { reducedMotion, uiZoom } from './motion';

/**
 * How a thing leaves. Nothing here draws per frame: a dead copy of the element (`ghostOf`) stands
 * where the element stood and is taken apart by animations of opacity and transform alone, so the
 * whole exit runs on the compositor. That is the point: a removal makes the page busy (the bridge
 * answers, a list renders again), and an effect drawn on the main thread shows as three frames.
 * The element itself can be hidden or removed at once, and its neighbours can close the gap on the
 * same clock (`features/sidebar/leave.ts`).
 */

/** Attributes a copy must not carry: it would be found as the row, counted by a list, or take the keys. */
const LIVE = ['id', 'data-flip', 'data-row', 'data-nav', 'data-id', 'data-enter', 'data-folder', 'data-req', 'data-qrow', 'data-qid', 'data-toast', 'tabindex', 'aria-current', 'aria-live', 'aria-label'];
/** What a copy keeps of the look the element had under the pointer (a copy is never hovered). */
const LOOK = ['color', 'opacity', 'background-color', 'visibility'] as const;

/**
 * A dead copy of `el`, laid over the place it stands in now and put right before it in its parent,
 * so what follows `el` paints over the copy and it scrolls and clips with the list. The copy takes
 * no room and no input. The caller animates it and removes it. Null when there is nothing to show.
 * `anchor: 'bottom'` holds it by its lower edge, for a place whose ground grows upward (the dock:
 * when the element goes, the dock's top comes down and a copy held by its top would go with it).
 * `before` puts the copy before that element instead (an ancestor of `el` that is about to be
 * hidden with everything in it: a folder whose header dissolves); `into` puts it at the end of that
 * element, for a place where a stray sibling would change the layout (the sidebar's sections are
 * spaced by `.sgroup + .sgroup`: a copy standing between two of them took the lower one's margin
 * away for as long as it stood there, and the list jumped 12 px when it went).
 */
export interface GhostPlace {
  anchor?: 'top' | 'bottom';
  before?: HTMLElement;
  into?: HTMLElement;
}

export function ghostOf(el: HTMLElement | null | undefined, opts: GhostPlace = {}): HTMLElement | null {
  const at = opts.before ?? el;
  const parent = opts.into ?? at?.parentElement;
  if (!el || !at || !parent || typeof el.animate !== 'function') return null;
  // Every read comes first: after the copy is in the page a read would make the page work out its
  // styles again right here, in the click (a DOM insertion costs this app a whole style pass).
  const box = el.getBoundingClientRect();
  if (box.width < 4 || box.height < 4 || box.bottom < 0 || box.top > window.innerHeight) return null;
  // The positioned ancestor the copy will be placed in is that of the element it is put before.
  const host = (opts.into ? (getComputedStyle(opts.into).position !== 'static' ? opts.into : (opts.into.offsetParent as HTMLElement | null)) : (at.offsetParent as HTMLElement | null)) ?? document.body;
  const hb = host.getBoundingClientRect();
  const z = uiZoom();
  const left = (box.left - hb.left) / z - host.clientLeft + host.scrollLeft;
  const top = (box.top - hb.top) / z - host.clientTop + host.scrollTop;
  const bottom = (hb.bottom - box.bottom) / z - (host.offsetHeight - host.clientHeight - host.clientTop);
  // The look as drawn (a lit row, its brighter title).
  const from: Element[] = [el, ...el.querySelectorAll('*')];
  const looks = from.length <= 60 ? from.map((n) => LOOK.map((k) => getComputedStyle(n).getPropertyValue(k))) : [];

  const copy = el.cloneNode(true) as HTMLElement;
  const to: Element[] = [copy, ...copy.querySelectorAll('*')];
  looks.forEach((look, i) => {
    const n = to[i] as HTMLElement | SVGElement | undefined;
    if (!n?.style) return;
    LOOK.forEach((k, j) => n.style.setProperty(k, look[j]));
    // Nothing in a copy eases to its look: it is already there.
    n.style.setProperty('transition', 'none');
  });
  for (const n of to) for (const a of LIVE) n.removeAttribute(a);
  const wrap = document.createElement('div');
  wrap.className = 'ghost';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.inert = true;
  // Seen even where the element's own parent is hidden meanwhile (visibility is inherited).
  wrap.style.cssText = `position:absolute;left:${left}px;${opts.anchor === 'bottom' ? `bottom:${bottom}px` : `top:${top}px`};width:${box.width / z}px;height:${box.height / z}px;margin:0;visibility:visible;pointer-events:none;overflow:hidden;contain:layout paint style;`;
  copy.style.setProperty('position', 'absolute');
  copy.style.setProperty('inset', '0');
  copy.style.setProperty('margin', '0');
  copy.style.setProperty('animation', 'none');
  wrap.appendChild(copy);
  if (opts.into) parent.appendChild(wrap);
  else parent.insertBefore(wrap, at);
  return wrap;
}

/** The cell of the dither a small thing breaks into, and the pace of the break (ms). */
const CELL = 3;
const STRIP = 34;
const STAGGER = 13;
const STEP = 22;
const FRAME = 16;

export interface Leaving {
  /** The copy that is leaving (already in the page). */
  ghost: HTMLElement;
  /** Settles when it has gone and the copy is removed. */
  done: Promise<void>;
}

/**
 * The removal: the thing breaks into the ground's ordered dither from its leading edge on, sparse,
 * then a checker, then gone, while what is still seen of it drifts off (about 190 ms). The break is
 * four quarter tiles of the 4x4 dither per strip in the ground's colour, each switched on by opacity
 * within a frame, so every step is a step of the dither and the first frame already shows one.
 * Call it with the element right before it is hidden or removed. `ground` is the surface under it
 * (a colour, or a token defined on the root).
 * Under reduced motion nothing is drawn (the element simply goes); while the governor sheds effects
 * the whole thing breaks at once, in four steps.
 */
export function dissolve(el: HTMLElement | null | undefined, opts: { ground?: string } & GhostPlace = {}): Leaving | null {
  if (reducedMotion() || typeof document === 'undefined') return null;
  const ghost = ghostOf(el, opts);
  if (!ghost) return null;
  const copy = ghost.firstElementChild as HTMLElement;
  const width = parseFloat(ghost.style.width);
  const shed = document.documentElement.hasAttribute('data-quality');
  const strips = shed ? 1 : Math.max(3, Math.min(12, Math.round(width / STRIP)));
  const sw = Math.ceil(width / strips);
  const tiles = quarterTiles(resolve(opts.ground ?? '--sheet'), CELL);
  const total = (strips - 1) * STAGGER + 3 * STEP + FRAME + 12;
  const anims: Animation[] = [];
  for (let s = 0; s < strips; s++) {
    for (let q = 0; q < 4; q++) {
      const layer = document.createElement('i');
      // One pattern across every strip: each takes its part of the same tiling.
      layer.style.cssText = `position:absolute;top:0;bottom:0;left:${s * sw}px;width:${sw}px;background-image:${tiles[q]};background-size:${CELL * 4}px;background-position:${-s * sw}px 0;will-change:opacity;`;
      ghost.appendChild(layer);
      const on = s * STAGGER + q * STEP;
      const frames: Keyframe[] =
        on === 0
          ? [{ opacity: 1 }, { opacity: 1 }]
          : [
              { opacity: 0, offset: 0 },
              { opacity: 0, offset: on / total },
              { opacity: 1, offset: Math.min(1, (on + FRAME) / total) },
              { opacity: 1, offset: 1 },
            ];
      anims.push(layer.animate(frames, { duration: total, easing: 'linear', fill: 'both' }));
    }
  }
  // What is still seen through the closing dither drifts off: the pieces go somewhere.
  anims.push(copy.animate([{ transform: 'translate(0, 0)', opacity: 1 }, { transform: 'translate(9px, -5px)', opacity: 0.5 }], { duration: total, easing: 'cubic-bezier(0.3, 0, 0.5, 1)', fill: 'both' }));
  return { ghost, done: gone(ghost, anims) };
}

/**
 * The quiet exit: the thing is put away, not destroyed. Its copy slides a short way (`dx`, `dy`) and
 * fades, gone before what closes the gap reaches its words (the list waits 45 ms, then springs).
 * For a row that moves elsewhere (archived) rather than ceasing to be.
 */
export function putAway(el: HTMLElement | null | undefined, dx: number, dy: number, ms = 110, opts: GhostPlace = {}): Leaving | null {
  if (reducedMotion() || typeof document === 'undefined') return null;
  const ghost = ghostOf(el, opts);
  if (!ghost) return null;
  const copy = ghost.firstElementChild as HTMLElement;
  // The way out is longer than the row is tall: the copy is not cut at its own box.
  ghost.style.overflow = 'visible';
  ghost.style.contain = 'layout style';
  const a = copy.animate(
    [
      { transform: 'translate(0, 0)', opacity: 1 },
      { opacity: 0.3, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
    ],
    { duration: ms, easing: 'cubic-bezier(0.4, 0, 0.7, 1)', fill: 'both' },
  );
  return { ghost, done: gone(ghost, [a]) };
}

function gone(ghost: HTMLElement, anims: Animation[]): Promise<void> {
  const off = () => ghost.remove();
  // A hidden window finishes nothing: the copy never outlives its motion by long.
  const cap = window.setTimeout(off, 1200);
  return Promise.all(anims.map((a) => a.finished)).then(
    () => {
      window.clearTimeout(cap);
      off();
    },
    () => {
      window.clearTimeout(cap);
      off();
    },
  );
}
