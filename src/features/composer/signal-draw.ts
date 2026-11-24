import { BAYER4, between, cornerRadii, EDGE_CELLS, EDGE_STEPS, fillAt, footAt, headAt, LINE, radiusAt, rimAt, shiftAt, type Box, type Point, type SignalPlan } from './signal-shape';

/**
 * Draws sent messages as signal (signal-shape.ts) on a 2D canvas: in the worker
 * (signal.worker.ts) or, where there is none, on the page (signal.ts). No blur, no glow:
 * - the line, one continuous ivory hairline (1.5 device px at 1.25) from its foot to its head, the
 *   head a touch brighter;
 * - the card opening out of the point of arrival: its well and its hot hairline drawn whole into a
 *   scratch canvas, then cut to a disc whose growing edge alone is stepped in the 4x4 ordered
 *   dither (¾, ½, ¼ of the cells, two cells each). Under load (`lite`) the dithered edge goes
 *   before frames do: the disc's edge is then plain.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = { canvas: OffscreenCanvas | HTMLCanvasElement; g: Ctx };

export interface SignalFrame {
  plan: SignalPlan;
  t: number;
  /** A cancelled message fades (1: whole). */
  alpha: number;
}

const IVORY = '242, 241, 238';

/** Whether the message has anything left to draw at `t`. */
export const drawing = (plan: SignalPlan, t: number) => t >= plan.born && t <= plan.end;

function surface(w: number, h: number): Surface | null {
  const canvas: OffscreenCanvas | HTMLCanvasElement | null =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null;
  const g = canvas?.getContext('2d') as Ctx | null | undefined;
  return canvas && g ? { canvas, g } : null;
}

/** Two scratch canvases (the card, its mask), grown as needed and kept; and the dither's patterns per cell size. */
let card: Surface | null = null;
let mask: Surface | null = null;
const patterns = new Map<number, CanvasPattern[]>();

function ensure(s: Surface | null, w: number, h: number): Surface | null {
  if (s && s.canvas.width >= w && s.canvas.height >= h) return s;
  return surface(Math.max(w, s?.canvas.width ?? 0), Math.max(h, s?.canvas.height ?? 0));
}

/** The 4x4 ordered dither at ¾, ½ and ¼ of its cells, as patterns of `cell` device px (for the mask's context). */
function patternsFor(g: Ctx, cell: number): CanvasPattern[] {
  const had = patterns.get(cell);
  if (had) return had;
  const out: CanvasPattern[] = [];
  for (let k = 1; k <= EDGE_STEPS; k++) {
    const keep = (16 * (EDGE_STEPS + 1 - k)) / (EDGE_STEPS + 1);
    const tile = surface(cell * 4, cell * 4);
    if (!tile) return [];
    tile.g.fillStyle = '#fff';
    for (let i = 0; i < 16; i++) if (BAYER4[i] < keep) tile.g.fillRect((i & 3) * cell, (i >> 2) * cell, cell, cell);
    const p = g.createPattern(tile.canvas as CanvasImageSource, 'repeat');
    if (!p) return [];
    out.push(p);
  }
  patterns.set(cell, out);
  return out;
}

function roundRect(g: Ctx, x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  const [tl, tr, br, bl] = r;
  g.beginPath();
  g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y);
  g.arcTo(x + w, y, x + w, y + tr, tr);
  g.lineTo(x + w, y + h - br);
  g.arcTo(x + w, y + h, x + w - br, y + h, br);
  g.lineTo(x + bl, y + h);
  g.arcTo(x, y + h, x, y + h - bl, bl);
  g.lineTo(x, y + tl);
  g.arcTo(x, y, x + tl, y, tl);
  g.closePath();
}

/** The line from its foot to its head along `path` (page px), on whole device rows or columns. */
function drawLine(g: Ctx, path: Point[], d0: number, d1: number, alpha: number, X: (x: number) => number, Y: (y: number) => number, scale: number) {
  const pts = between(path, d0, d1);
  if (pts.length < 2) return;
  const w = LINE.width * scale;
  const seg = (a: Point, b: Point, o: number, wide: number) => {
    g.fillStyle = `rgba(${IVORY}, ${(o * alpha).toFixed(3)})`;
    if (Math.abs(b.x - a.x) < 0.01) {
      // Upright: centred on the column it rises in.
      const x = Math.round(X(a.x) - wide / 2);
      const y0 = Math.round(Math.min(Y(a.y), Y(b.y)));
      g.fillRect(x, y0, wide, Math.max(wide, Math.round(Math.abs(Y(b.y) - Y(a.y)))));
    } else {
      const y = Math.round(Y(a.y) - wide / 2);
      const x0 = Math.round(Math.min(X(a.x), X(b.x)));
      g.fillRect(x0, y, Math.max(wide, Math.round(Math.abs(X(b.x) - X(a.x)))), wide);
    }
  };
  for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i], LINE.body, w);
  // The head: its last few px at full strength, a hair wider.
  const head = between(path, Math.max(d0, d1 - LINE.headLength), d1);
  for (let i = 1; i < head.length; i++) seg(head[i - 1], head[i], LINE.head, w + 0.5);
}

/** The card, its well and its hairline, cut to the opening disc (centre `at`, radius `r`, page px) with a dithered edge. */
function drawCard(g: Ctx, box: Box, at: Point, r: number, rmax: number, fill: number, rim: number, alpha: number, origin: Point, scale: number, lite: boolean) {
  const x0 = Math.floor((box.left - origin.x) * scale) - 2;
  const y0 = Math.floor((box.top - origin.y) * scale) - 2;
  const w = Math.ceil(box.width * scale) + 4;
  const h = Math.ceil(box.height * scale) + 4;
  card = ensure(card, w, h);
  if (!card) return;
  const c = card.g;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, w, h);
  const bx = (box.left - origin.x) * scale - x0;
  const by = (box.top - origin.y) * scale - y0;
  const bw = box.width * scale;
  const bh = box.height * scale;
  const radii = cornerRadii(box).map((v) => v * scale) as [number, number, number, number];
  if (fill > 0) {
    c.fillStyle = `rgba(0, 0, 0, ${(fill * alpha).toFixed(3)})`;
    roundRect(c, bx, by, bw, bh, radii);
    c.fill();
  }
  if (rim > 0) {
    // The hairline inside the edge, as the card's own (an inset 1 page px ring).
    const lw = scale;
    c.strokeStyle = `rgba(${IVORY}, ${(rim * alpha).toFixed(3)})`;
    c.lineWidth = lw;
    roundRect(c, bx + lw / 2, by + lw / 2, bw - lw, bh - lw, radii.map((v) => Math.max(0, v - lw / 2)) as [number, number, number, number]);
    c.stroke();
  }
  if (r < rmax) {
    mask = ensure(mask, w, h);
    if (!mask) return;
    const m = mask.g;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, w, h);
    const cx = (at.x - origin.x) * scale - x0;
    const cy = (at.y - origin.y) * scale - y0;
    const R = r * scale;
    const cell = Math.max(2, Math.round(2 * scale));
    const pats = lite ? [] : patternsFor(m, cell);
    const step = EDGE_CELLS * cell;
    const solid = pats.length ? R - pats.length * step : R;
    m.fillStyle = '#fff';
    if (solid > 0) {
      m.beginPath();
      m.arc(cx, cy, solid, 0, Math.PI * 2);
      m.fill();
    }
    // The growing edge: rings of ¾, ½ and ¼ of the dither's cells, outward.
    pats.forEach((p, k) => {
      const inner = Math.max(0, solid + k * step);
      const outer = solid + (k + 1) * step;
      if (outer <= 0) return;
      m.fillStyle = p;
      m.beginPath();
      m.arc(cx, cy, outer, 0, Math.PI * 2);
      if (inner > 0) m.arc(cx, cy, inner, 0, Math.PI * 2, true);
      m.fill('evenodd');
    });
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mask.canvas as CanvasImageSource, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }
  g.drawImage(card.canvas as CanvasImageSource, 0, 0, w, h, x0, y0, w, h);
}

export function drawSignal(g: Ctx, frames: SignalFrame[], origin: Point, scale: number, lite = false) {
  // Each edge of the line on a whole device px, so a 1.5 px line lands on the same pixels every frame.
  const X = (x: number) => (x - origin.x) * scale;
  const Y = (y: number) => (y - origin.y) * scale;
  for (const { plan, t, alpha } of frames) {
    if (!drawing(plan, t) || alpha <= 0) continue;
    const shift = shiftAt(plan, t);
    // The trace's end moves with the card; its foot stays on the key.
    const path = plan.path.map((p, i) => (i === 0 ? p : { x: p.x + shift.x, y: p.y + shift.y }));
    const box = { ...plan.spec.to, left: plan.spec.to.left + shift.x, top: plan.spec.to.top + shift.y };
    const at = path[path.length - 1];
    // ── the card, under the line's end ──
    if (t >= plan.land) {
      const fill = fillAt(plan, t);
      const rim = rimAt(plan, t);
      if (fill > 0 || rim > 0) drawCard(g, box, at, radiusAt(plan, t), plan.rmax, fill, rim, alpha, origin, scale, lite);
    }
    // ── the line, from its foot to its head ──
    const head = headAt(plan, t);
    const foot = footAt(plan, t);
    if (head - foot > 0.5) drawLine(g, path, foot, head, alpha, X, Y, scale);
  }
}
