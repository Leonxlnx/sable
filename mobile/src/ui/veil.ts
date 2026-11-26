import { reduced } from './motion';

/**
 * The dither veil, as on the desktop: four quarter-tiles of the 4x4 ordered dither in the surface
 * colour, stepped by opacity only, so content dissolves into the ground (`cover`: sparse, checker,
 * solid) and resolves out of it (`reveal`: the reverse). With `bands`, a crest runs across the
 * screen: each band steps a little after the one before it (`from` says where it starts).
 * Compositor only (opacity on a few small layers); the overlay removes itself after a reveal.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const cache = new Map<string, string>();

function pattern(q: number, color: string, cell: number) {
  const key = `${q}|${color}|${cell}`;
  let url = cache.get(key);
  if (url) return url;
  let rects = '';
  for (let i = 0; i < 16; i++) if (BAYER[i] >> 2 === q) rects += `<rect x='${(i & 3) * cell}' y='${(i >> 2) * cell}' width='${cell}' height='${cell}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${4 * cell}' height='${4 * cell}' shape-rendering='crispEdges' fill='${color}'>${rects}</svg>`;
  url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  cache.set(key, url);
  return url;
}

/** A cell that lands on whole device pixels (no seams between cells). */
export const crispCell = (css: number) => {
  const k = window.devicePixelRatio || 1;
  return Math.max(1, Math.round(css * k)) / k;
};

export interface VeilOptions {
  color: string;
  /** Cell size in CSS px. */
  cell?: number;
  /** Whole run in ms. */
  duration?: number;
  /** Horizontal bands that step one after another (a crest), and where the crest starts. */
  bands?: number;
  from?: 'top' | 'bottom';
  delay?: number;
  z?: number;
}

export function veil(host: HTMLElement, mode: 'cover' | 'reveal', o: VeilOptions): { done: Promise<void>; remove: () => void } {
  if (import.meta.env.SABLE_WEB) return { done: Promise.resolve(), remove: () => {} };
  const el = document.createElement('div');
  el.className = 'veil';
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:${o.z ?? 60};contain:strict`;
  const remove = () => el.remove();
  if (reduced()) {
    // No dither steps: a plain fade (a reveal is simply gone).
    if (mode === 'reveal') return { done: Promise.resolve(), remove };
    el.style.background = o.color;
    host.appendChild(el);
    const a = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'both' });
    return { done: a.finished.then(() => {}), remove };
  }
  const cell = crispCell(o.cell ?? 4);
  const tile = cell * 4;
  const h = host.clientHeight || window.innerHeight;
  const bands = Math.max(1, o.bands ?? 1);
  const bandH = Math.ceil(h / bands / tile) * tile;
  const dur = o.duration ?? 260;
  const slot = dur / (4 + (bands - 1) * 0.9);
  const anims: Animation[] = [];
  for (let b = 0; b < bands; b++) {
    const band = document.createElement('div');
    const top = b * bandH;
    band.style.cssText = `position:absolute;left:0;right:0;top:${top}px;height:${b === bands - 1 ? Math.max(bandH, h - top) : bandH}px`;
    const order = o.from === 'bottom' ? bands - 1 - b : b;
    for (let q = 0; q < 4; q++) {
      const i = document.createElement('i');
      i.style.cssText = `position:absolute;inset:0;background-image:${pattern(q, o.color, cell)};background-size:${tile}px ${tile}px;background-position:0 ${-top}px;will-change:opacity`;
      // cover: sparse first; reveal: the last quarter in goes first (solid, checker, sparse, clear).
      const step = mode === 'cover' ? q : 3 - q;
      const at = (o.delay ?? 0) + (order * 0.9 + step) * slot;
      const frames = mode === 'cover' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
      i.style.opacity = mode === 'cover' ? '0' : '1';
      anims.push(i.animate(frames, { duration: slot, delay: at, fill: 'forwards', easing: 'steps(1, end)' }));
      band.appendChild(i);
    }
    el.appendChild(band);
  }
  host.appendChild(el);
  const done = Promise.all(anims.map((a) => a.finished)).then(
    () => {
      if (mode === 'reveal') remove();
    },
    () => {},
  );
  return { done, remove };
}
