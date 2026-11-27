import { reduced } from './motion';

/**
 * The dither veil, as on the desktop: four quarter-tiles of the 4x4 ordered dither in the surface
 * colour, stepped by opacity only, so content dissolves into the ground (`cover`: sparse, checker,
 * solid) and resolves out of it (`reveal`: the reverse). With `bands`, a crest runs across the
 * screen: each band steps a little after the one before it (`from` says where it starts).
 * Compositor only (opacity on a few small layers); the overlay removes itself after a reveal.
 */

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * One quarter of the 4x4 dither as a canvas of one pixel per cell (2.22), drawn up to the cell size by
 * the compositor (`image-rendering: pixelated`): a texture of a few thousand pixels where a background
 * pattern was rastered at the screen's full size four times at the start of every veil (13 MB each on
 * a 1220 x 2712 phone, and the raster on the first frame of the cover).
 */
function quarter(q: number, color: string, cols: number, rows: number, row0: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  // The quarter's four cells of a 4x4 tile, laid over the whole canvas as a pattern (one fill).
  const t = document.createElement('canvas');
  t.width = 4;
  t.height = 4;
  const tc = t.getContext('2d');
  if (!tc) return c;
  tc.fillStyle = color;
  for (let i = 0; i < 16; i++) if (BAYER[i] >> 2 === q) tc.fillRect(i & 3, i >> 2, 1, 1);
  const p = ctx.createPattern(t, 'repeat');
  if (!p) return c;
  ctx.translate(0, -(row0 & 3));
  ctx.fillStyle = p;
  ctx.fillRect(0, 0, cols, rows + 4);
  return c;
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
  const w = host.clientWidth || window.innerWidth;
  const cols = Math.ceil(w / cell);
  const bands = Math.max(1, o.bands ?? 1);
  const bandH = Math.ceil(h / bands / tile) * tile;
  const dur = o.duration ?? 260;
  const slot = dur / (4 + (bands - 1) * 0.9);
  const anims: Animation[] = [];
  for (let b = 0; b < bands; b++) {
    const band = document.createElement('div');
    const top = b * bandH;
    const height = b === bands - 1 ? Math.max(bandH, h - top) : bandH;
    const rows = Math.ceil(height / cell);
    band.style.cssText = `position:absolute;left:0;right:0;top:${top}px;height:${height}px;overflow:hidden`;
    const order = o.from === 'bottom' ? bands - 1 - b : b;
    for (let q = 0; q < 4; q++) {
      // Each band starts on a whole tile, so its rows continue the dither of the band above.
      const i = quarter(q, o.color, cols, rows, Math.round(top / cell));
      i.style.cssText = `position:absolute;left:0;top:0;width:${cols * cell}px;height:${rows * cell}px;image-rendering:pixelated;will-change:opacity`;
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
