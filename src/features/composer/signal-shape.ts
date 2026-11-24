/**
 * A sent message as signal: the timing and the geometry, pure. The worker that draws it
 * (signal.worker.ts with signal-draw.ts), the page that steps the words and the card with it
 * (flight.ts) and the tests read the same numbers, so the line and the card agree in every frame
 * without talking. Made of the app's own ordered dither (art/veil.ts), not of liquid.
 *
 * One clock, ms after time zero (one frame before the first frame the send shows in):
 * - dissolve (`dissolve`, 12 to 78): the words in the field go in place, in dither order, a
 *   quarter of the 4x4 Bayer cells at a time (the densest ranks first: sparse, checker, gone).
 * - trace (`born` on): a hairline leaves the key's top and runs up to where the card will stand
 *   (straight, or bent once along the card's lower edge when the key is not under it). Its head is
 *   bright, its tail falls off in dither steps.
 * - outline (`land` on): where the line meets the card's lower edge it parts in two and runs both
 *   ways round the card's outline, closing at the top (`close`). One path and one speed curve for
 *   the whole line, so the speed never steps where the trace becomes the outline.
 * - resolve: the card's well comes in by quarters (`well`), then its words (`words`), then the
 *   whole card in one layer (`hand`): readable about 300 ms after the key at most.
 * - `end`: the outline has cooled into the card's own hairline; the real row takes over.
 *
 * A queue row is the same with a short trace and no well. Geometry is in the page's CSS px
 * (viewport, already divided by the interface zoom).
 */

export type Radii = [number, number, number, number];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Top-left, top-right, bottom-right, bottom-left. */
  radii: Radii;
}

export interface SignalSpec {
  /** Where the line leaves: the top of the send key (`edge`, a disc of radius `r` under it), or a free point (a queue row's end). */
  from: { x: number; y: number; edge: boolean; r?: number };
  /** The shape it ends as. */
  to: Box;
  /** A bubble becomes the message card; a row becomes a queue row. */
  kind: 'bubble' | 'row';
  /** The bar it leaves glides away (home/handoff.ts): recorded, the line is free of the key by then. */
  bar?: { dx: number; dy: number };
}

/** A late correction of the landing: what is still to come moves by (dx, dy), eased in from `at` over `dur` ms. */
export interface Shift {
  at: number;
  dx: number;
  dy: number;
  dur: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SignalPlan {
  spec: SignalSpec;
  /** The field's words: when each quarter goes (ranks 12-15 first, then 8-11, 4-7, 0-3). */
  dissolve: [number, number, number, number];
  /** The line leaves the key (also the send beat). */
  born: number;
  /** Kept for the flight's seams: the landing is certain enough to bend to from here (the line meets the card). */
  launch: number;
  /** The send beat. */
  snap: number;
  /** The head reaches the card. */
  land: number;
  /** The outline has closed. */
  close: number;
  /** Each quarter of the well (none for a row) and of the words comes in. */
  well: number[];
  words: number[];
  /** The whole card in one layer. */
  hand: number;
  /** Nothing left to draw. */
  end: number;
  /** The trace: from the key's top to where it meets the card's edge (page px), and its length. */
  path: Point[];
  reach: number;
  /** Half the card's outline (px): each head runs this far. */
  half: number;
  /** The line's whole run (trace and outline) and how long it takes. */
  total: number;
  run: number;
  /** Way along the line per ms since `born` (0..1, one entry per ms). */
  way: Float32Array;
  shifts: Shift[];
}

/** The field's words go in four steps: the first before the first frame (16 ms), so that frame already differs. */
export const DISSOLVE: [number, number, number, number] = [12, 34, 56, 78];
/** The line leaves the key's top: the key has given and its arrow is on its way out (launch.ts). */
export const BORN = 76;
/** The words leave and the field closes: kept for the field's height and the home bar (home/handoff.ts). */
export const COLLAPSE = 160;
/** Under a first message the bar leaves for the dock at this time: the line is clear of it. */
export const BAR_LEAVES = BORN + 54;
/** The tail behind the head, px: its first part solid, then falling off in dither steps. */
export const TAIL = 90;
export const TAIL_SOLID = 0.3;
/** The outline cools into the card's hairline over this long after it closes. */
export const COOL = 130;
/** The hairline the outline is drawn at while it runs (ivory, its head brighter). */
export const LINE = { head: 1, body: 0.8, near: 0.95, far: 0.28, falloff: 36 };

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** cubic-bezier(x1, y1, x2, y2) as a function of x. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const bx = (m: number) => 3 * (1 - m) * (1 - m) * m * x1 + 3 * (1 - m) * m * m * x2 + m * m * m;
  const by = (m: number) => 3 * (1 - m) * (1 - m) * m * y1 + 3 * (1 - m) * m * m * y2 + m * m * m;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 28; i++) {
      const m = (lo + hi) / 2;
      if (bx(m) < x) lo = m;
      else hi = m;
    }
    return by((lo + hi) / 2);
  };
}

/** The line's speed curve: it gathers speed out of the key (the arrow's own ease out), then slows into the close. */
export const lineEase = bezier(0.45, 0, 0.2, 1);

/** The whole line's time for its length: longer lines are a little slower, never past 240 ms. */
export const runMs = (total: number) => Math.round(clamp(150 + 0.09 * total, 170, 240));

/**
 * The collapse's progress (0..1 over COLLAPSE): a critically damped spring. The field's height
 * closes on it (flight.ts, home/handoff.ts).
 */
const COLLAPSE_K = 6.2;
export const collapseEase = (u: number) => {
  const v = clamp(u, 0, 1) * COLLAPSE_K;
  return (1 - (1 + v) * Math.exp(-v)) / (1 - (1 + COLLAPSE_K) * Math.exp(-COLLAPSE_K));
};

/** The ease a shift comes in with (shared with the words' WAAPI correction through `linearEasing`). */
export const shiftEase = (u: number) => {
  const v = clamp(u, 0, 1);
  return v * v * v * (v * (6 * v - 15) + 10);
};

/** A JS ease as a CSS `linear()` easing, so a compositor animation follows the same curve. */
export function linearEasing(ease: (u: number) => number, n = 24): string {
  const stops: string[] = [];
  for (let i = 0; i <= n; i++) stops.push(String(Math.round(ease(i / n) * 10000) / 10000));
  return `linear(${stops.join(', ')})`;
}

/** The spring the home composer glides to the dock on (home/handoff.ts): semi-implicit Euler in `step` ms, a sample every `every` steps. */
export const GLIDE = { stiff: 440, damp: 40, step: 4, every: 4 };

/** Where the line meets the card's lower edge: under the key, kept clear of the rounded corners. */
export function meetX(to: Box, x: number): number {
  const [, , br, bl] = cornerRadii(to);
  return clamp(x, to.left + bl, to.left + to.width - br);
}

/** The card's corners, each no larger than half its shorter side. */
export function cornerRadii(b: Box): Radii {
  const m = Math.min(b.width, b.height) / 2;
  return b.radii.map((r) => Math.max(0, Math.min(r, m))) as Radii;
}

/** The trace: up from the key, then (when the key is not under the card) along the card's lower edge to the meeting point. */
export function tracePath(from: Point, to: Box): Point[] {
  const y = to.top + to.height;
  const x = meetX(to, from.x);
  const pts: Point[] = [{ x: from.x, y: from.y }, { x: from.x, y }];
  if (Math.abs(x - from.x) > 0.5) pts.push({ x, y });
  return pts;
}

const lengthOf = (pts: Point[]) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
};

/** The point `d` px along a polyline (clamped to its ends), and the direction it runs there. */
export function along(pts: Point[], d: number): { x: number; y: number; dx: number; dy: number } {
  let left = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (!l) continue;
    if (left <= l || i === pts.length - 1) {
      const u = Math.min(1, left / l);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, dx: (b.x - a.x) / l, dy: (b.y - a.y) / l };
    }
    left -= l;
  }
  const p = pts[pts.length - 1] ?? { x: 0, y: 0 };
  return { x: p.x, y: p.y, dx: 0, dy: -1 };
}

/**
 * The card's outline as points 1 px apart on its inner hairline (half a pixel in), starting where
 * the trace meets the lower edge (x) and going right first, all the way round back to there.
 */
export function outline(b: Box, x: number): Point[] {
  const L = b.left + 0.5;
  const T = b.top + 0.5;
  const R = b.left + b.width - 0.5;
  const B = b.top + b.height - 0.5;
  const [tl, tr, br, bl] = cornerRadii(b);
  const px = clamp(x, L + bl, R - br);
  const out: Point[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i < n; i++) out.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n });
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    if (r < 0.5) return;
    const n = Math.max(1, Math.round(Math.abs(a1 - a0) * r));
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  const H = Math.PI / 2;
  line(px, B, R - br, B);
  arc(R - br, B - br, br, H, 0);
  line(R, B - br, R, T + tr);
  arc(R - tr, T + tr, tr, 0, -H);
  line(R - tr, T, L + tl, T);
  arc(L + tl, T + tl, tl, -H, -2 * H);
  line(L, T + tl, L, B - bl);
  arc(L + bl, B - bl, bl, 2 * H, H);
  line(L + bl, B, px, B);
  return out;
}

/** The length of a box's outline (what `outline` samples, to the pixel). */
export const outlineLength = (b: Box) => outline(b, b.left + b.width / 2).length;

export function planSignal(spec: SignalSpec, shifts: Shift[] = []): SignalPlan {
  const { from, to } = spec;
  const path = tracePath(from, to);
  const reach = lengthOf(path);
  const half = outlineLength(to) / 2;
  const total = reach + half;
  const row = spec.kind === 'row';
  // A queue row is a hop away and a thin, wide shape: its line is quicker.
  const run = row ? Math.round(clamp(110 + 0.06 * total, 130, 180)) : runMs(total);
  const way = new Float32Array(run + 1);
  for (let i = 0; i <= run; i++) way[i] = lineEase(i / run);
  const born = BORN;
  // When the head reaches the card: the first ms the way passes the trace's share.
  const share = reach / total;
  let i = 0;
  while (i < run && way[i] < share) i++;
  const land = born + i;
  const close = born + run;
  const well = row ? [] : [0, 1, 2, 3].map((q) => land + 14 + q * 20);
  const words = [0, 1, 2, 3].map((q) => land + (row ? 20 + q * 16 : 44 + q * 20));
  const hand = words[3];
  const end = Math.max(close + (row ? 100 : COOL), hand + (row ? 40 : 60));
  return { spec, dissolve: DISSOLVE, born, launch: land, snap: born, land, close, well, words, hand, end, path, reach, half, total, run, way, shifts };
}

/** How far the head is along the whole line (trace, then outline) at `t`, px. */
export function headAt(plan: SignalPlan, t: number): number {
  const ms = t - plan.born;
  if (ms <= 0) return 0;
  if (ms >= plan.run) return plan.total;
  const i = Math.floor(ms);
  return plan.total * lerp(plan.way[i], plan.way[i + 1], ms - i);
}

/** The sum of the late corrections at `t`. */
export function shiftAt(plan: Pick<SignalPlan, 'shifts'>, t: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const s of plan.shifts) {
    const e = shiftEase((t - s.at) / s.dur);
    x += s.dx * e;
    y += s.dy * e;
  }
  return { x, y };
}

/** Whether cell `i` of a run of cells at strength `f` (0..1) shows: a 1D ordered dither. */
const BAYER8 = [0, 4, 2, 6, 1, 5, 3, 7];
export const ditherOn = (i: number, f: number) => (BAYER8[((i % 8) + 8) % 8] + 0.5) / 8 < f;

/** The tail's strength `d` px behind the head: solid near it, then falling off. */
export const tailAt = (d: number) => (d < TAIL * TAIL_SOLID ? 1 : clamp(1 - (d - TAIL * TAIL_SOLID) / (TAIL * (1 - TAIL_SOLID)), 0, 1));

/** The outline's strength `behind` px back from a running head, before it cools. */
export const outlineAt = (behind: number) => LINE.far + (LINE.near - LINE.far) * Math.exp(-behind / LINE.falloff);

/** How much of the outline is left as it cools after the close (1 to 0 over COOL). */
export const coolAt = (plan: SignalPlan, t: number) => (t <= plan.close ? 1 : clamp(1 - (t - plan.close) / COOL, 0, 1));

/** The region the line can draw in (page px): the trace, the card's outline, room for corrections. */
export function signalBounds(plan: SignalPlan, room = 8): { left: number; top: number; width: number; height: number } {
  const { from, to } = plan.spec;
  const xs = [from.x, ...plan.path.map((p) => p.x), to.left, to.left + to.width];
  const ys = [from.y, ...plan.path.map((p) => p.y), to.top, to.top + to.height];
  const left = Math.min(...xs) - room;
  const top = Math.min(...ys) - room;
  const right = Math.max(...xs) + room;
  const bottom = Math.max(...ys) + room;
  return { left: Math.floor(left), top: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

/**
 * The card's numbers (the person's message well, timeline.css `.user-card::before`; the flying
 * copy repeats them in composer.css): its ink and alpha, and its hairline.
 */
export const INK = { fill: [0, 0, 0] as [number, number, number], a: 0.34, rim: 0.075 };
