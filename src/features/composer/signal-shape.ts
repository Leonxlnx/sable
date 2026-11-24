/**
 * A sent message as signal: the timing and the geometry, pure. The worker that draws it
 * (signal.worker.ts with signal-draw.ts), the page that steps the words and the card with it
 * (flight.ts) and the tests read the same numbers, so the line and the card agree in every frame
 * without talking. Made of the app's own ordered dither (art/veil.ts), not of liquid.
 *
 * One clock, ms after time zero (one frame before the first frame the send shows in):
 * - dissolve (`dissolve`, 12 to 60): the words in the field go in place, in dither order, a
 *   quarter of the 4x4 Bayer cells at a time (the densest ranks first: sparse, checker, gone).
 * - trace (`born` to `land`): one continuous ivory hairline grows out of the key's top, already
 *   out of it in the first frame, and runs up to where the card will stand (straight, or bent once
 *   along the card's lower edge when the key is not under it). Its foot stays on the key until its
 *   head has arrived; then (`release` to `taken`) the tail follows it up and is drawn into the card.
 * - open (`land` to `close`): the card opens out of the point of arrival as one growing shape, its
 *   well and its hairline together, a disc that grows until it holds the whole card. Only its
 *   growing edge is cut by the dither, in three steps; the hairline is hot (the line's own ivory)
 *   while it opens, then cools into the card's own.
 * - words (`words`): the card's words stand whole, in two frames, once the shape holds them.
 * - fill (`fill`): the well drawn on the canvas hands over to the card's own (a cross-fade of
 *   three frames, so a frame's skew between the worker and the compositor never shows), and at
 *   `hand` the whole card in one layer takes the place of its parts.
 * - `end`: the hot hairline has cooled away; the real row takes over.
 *
 * A queue row is the same with no well. Geometry is in the page's CSS px (viewport, already
 * divided by the interface zoom).
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
  /** The bar it leaves glides away at `BAR_LEAVES` (home/handoff.ts): the line lets go of the key by then. */
  bar?: { dx: number; dy: number };
  /** The card's tone (a steer lands at the waiting tone, 0.6); 1 when absent. */
  tone?: number;
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
  /** The line leaves the key. */
  born: number;
  /** Kept for the flight's seams: the landing is certain enough to bend to until here (the head arrives). */
  launch: number;
  /** The send beat. */
  snap: number;
  /** The head reaches the card: the shape starts to open there. */
  land: number;
  /** The foot lets go of the key, and is drawn into the card by `taken`. */
  release: number;
  taken: number;
  /** The shape holds the whole card. */
  close: number;
  /** The words: at half strength, then whole (one frame later). */
  words: [number, number];
  /** The canvas's well hands over to the card's own, from the first to the second. Empty for a row. */
  fill: number[];
  /** The whole card in one layer. */
  hand: number;
  /** Nothing left to draw. */
  end: number;
  /** The trace: from the key's top to where it meets the card's edge (page px), and its length. */
  path: Point[];
  reach: number;
  /** How long the head, the tail and the opening take (ms). */
  trip: number;
  tail: number;
  opening: number;
  /** The disc's largest radius: from the point of arrival to the card's farthest corner, with its dithered edge. */
  rmax: number;
  shifts: Shift[];
}

/** The field's words go in four steps: the first before the first frame (16 ms), so that frame already differs. */
export const DISSOLVE: [number, number, number, number] = [12, 28, 44, 60];
/** The line leaves the key's top: in the first frame (16) it already stands out of it. */
export const BORN = 10;
/** The words leave and the field closes: kept for the field's height and the home bar (home/handoff.ts). */
export const COLLAPSE = 160;
/** Under a first message the bar leaves for the dock at this time: the line has let go of the key by then. */
export const BAR_LEAVES = 120;
/** The hot hairline cools into the card's own over this long after the shape is whole. */
export const COOL = 140;
/** The canvas's well hands over to the card's own over this long (three frames). */
export const FILL_HANDOVER = 48;
/** The line: ivory at near full strength, its head a touch brighter; `width` in page px (1.5 device px at 1.25). */
export const LINE = { head: 1, body: 0.9, width: 1.2, headLength: 5 };
/** The opening shape's hairline while it opens (it then cools to nothing; the card's own takes over). */
export const RIM_HOT = 0.85;
/** The dithered edge of the opening shape: three steps of two cells each, ¾, ½ and ¼ of the cells. */
export const EDGE_STEPS = 3;
export const EDGE_CELLS = 2;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** cubic-bezier(x1, y1, x2, y2) as a function of x. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const bx = (m: number) => 3 * (1 - m) * (1 - m) * m * x1 + 3 * (1 - m) * m * m * x2 + m * m * m;
  const by = (m: number) => 3 * (1 - m) * (1 - m) * m * y1 + 3 * (1 - m) * m * m * y2 + m * m * m;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
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

/** The head: out of the key at speed (it answers in the first frame), easing into the card. */
export const headEase = bezier(0.3, 0.35, 0.3, 1);
/** The tail: lets go gently, then is drawn in quickly. */
export const tailEase = bezier(0.55, 0, 0.75, 0.45);
/** The opening: quick out of the point of arrival, slowing as it reaches the far corner. */
export const openEase = bezier(0.15, 0.65, 0.3, 1);

/** How long the head takes for the trace's length: a longer way is a little slower, never past 104 ms. */
export const tripMs = (reach: number) => Math.round(clamp(66 + 0.08 * reach, 76, 104));
/** How long the tail takes to be drawn in. */
export const tailMs = (reach: number) => Math.round(clamp(56 + 0.05 * reach, 60, 90));
/** How long the card takes to open to its farthest corner. */
export const openMs = (rmax: number) => Math.round(clamp(60 + 0.05 * rmax, 66, 90));

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

/** The card's corners, each no larger than half its shorter side. */
export function cornerRadii(b: Box): Radii {
  const m = Math.min(b.width, b.height) / 2;
  return b.radii.map((r) => Math.max(0, Math.min(r, m))) as Radii;
}

/** Where the line meets the card's lower edge: under the key, kept clear of the rounded corners. */
export function meetX(to: Box, x: number): number {
  const [, , br, bl] = cornerRadii(to);
  return clamp(x, to.left + bl, to.left + to.width - br);
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

/** The part of a polyline between `d0` and `d1` px along it, as points (its corners included). */
export function between(pts: Point[], d0: number, d1: number): Point[] {
  if (d1 <= d0) return [];
  const out: Point[] = [along(pts, d0)];
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    at += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (at > d0 && at < d1) out.push(pts[i]);
  }
  out.push(along(pts, d1));
  return out.map((p) => ({ x: p.x, y: p.y }));
}

/** The width of a dithered edge in page px, for a cell of about two device px. */
export const edgeWidth = (scale: number) => (EDGE_STEPS * EDGE_CELLS * Math.max(2, Math.round(2 * scale))) / scale;

/** The farthest corner of the card from the point of arrival (page px). */
export function farthest(to: Box, at: Point): number {
  let r = 0;
  for (const x of [to.left, to.left + to.width]) for (const y of [to.top, to.top + to.height]) r = Math.max(r, Math.hypot(x - at.x, y - at.y));
  return r;
}

/** Room for the dithered edge past the farthest corner, so the last step clears it (at up to 3 device px per page px). */
const EDGE_ROOM = 15;

export function planSignal(spec: SignalSpec, shifts: Shift[] = []): SignalPlan {
  const { from, to } = spec;
  const path = tracePath(from, to);
  const reach = lengthOf(path);
  const row = spec.kind === 'row';
  const trip = tripMs(reach);
  const tail = tailMs(reach);
  const rmax = farthest(to, path[path.length - 1]) + EDGE_ROOM;
  const opening = openMs(rmax - EDGE_ROOM);
  const born = BORN;
  const land = born + trip;
  // A bar that leaves (the first message from home) takes the key with it: the foot lets go by then.
  const release = spec.bar ? Math.min(land, BAR_LEAVES) : land;
  const taken = release + tail;
  const close = land + opening;
  // The words stand once the disc holds them: at seven tenths of its time it is past nine tenths of its way.
  const whole = land + Math.round(opening * 0.72);
  const words: [number, number] = [whole - 16, whole];
  const fill = row ? [] : [close, close + FILL_HANDOVER];
  const hand = row ? whole + 16 : close + FILL_HANDOVER;
  const end = Math.max(close + COOL, hand + 16, taken + 16);
  return { spec, dissolve: DISSOLVE, born, launch: land, snap: born, land, release, taken, close, words, fill, hand, end, path, reach, trip, tail, opening, rmax, shifts };
}

/** How far the head is along the trace at `t`, px (0 before it leaves, the whole trace once arrived). */
export function headAt(plan: SignalPlan, t: number): number {
  return plan.reach * headEase(clamp((t - plan.born) / plan.trip, 0, 1));
}

/** How far the foot is along the trace at `t`, px: on the key until it lets go, at the head once taken in. */
export function footAt(plan: SignalPlan, t: number): number {
  return plan.reach * tailEase(clamp((t - plan.release) / plan.tail, 0, 1));
}

/** The opening shape's radius at `t` (0 until the head arrives, `rmax` once whole). */
export function radiusAt(plan: SignalPlan, t: number): number {
  return plan.rmax * openEase(clamp((t - plan.land) / plan.opening, 0, 1));
}

/** The opening shape's hairline: hot while it opens, cooling to nothing once whole. */
export function rimAt(plan: SignalPlan, t: number): number {
  if (t < plan.land) return 0;
  const tone = plan.spec.tone ?? 1;
  return RIM_HOT * tone * (t <= plan.close ? 1 : clamp(1 - (t - plan.close) / COOL, 0, 1));
}

/** The well the canvas draws (alpha): the card's own ink until the handover, then gone. */
export function fillAt(plan: SignalPlan, t: number): number {
  if (!plan.fill.length || t < plan.land) return 0;
  const tone = plan.spec.tone ?? 1;
  return INK.a * tone * clamp(1 - (t - plan.fill[0]) / (plan.fill[1] - plan.fill[0]), 0, 1);
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

/** The 4x4 ordered dither's ranks (art/veil.ts uses the same matrix). */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The region the line can draw in (page px): the trace, the card, room for corrections. */
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
