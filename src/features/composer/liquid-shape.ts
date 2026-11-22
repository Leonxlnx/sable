/**
 * A sent message as liquid: the geometry over time, pure. The worker that draws it
 * (liquid.worker.ts, with liquid-gl.ts), the main thread that moves the words with it (flight.ts)
 * and the tests all read the same numbers, so the silhouette and the words agree in every frame
 * without talking.
 *
 * One body of liquid on one path, with one speed that never steps (ms after the key's first frame):
 * - collapse (0 to COLLAPSE): the words run down into the pane's corner over the key as one piece
 *   (their width leading, so they draw into a stream there) and fade, while the field closes to
 *   one line. The pane is empty and at rest for a moment.
 * - swell (BORN on): the liquid that went in comes back out of the key. The drop starts behind
 *   the key's disc, at rest, and is pushed up over its top: first a collar of liquid swells there
 *   (a meniscus: the smooth union of the disc and the drop), then the drop stands out of it.
 * - thread (`launch` to `snap`): the drop is clear of the key and already flying; a thread of
 *   liquid still ties it to the key's top, thinning as it stretches, until surface tension parts
 *   it. What is left recoils both ways: the tail snaps up into the drop (which rings once, a
 *   little shorter then longer along its path), the foot falls back into the key.
 * - flight (to `land`): the push is over; the drop coasts on, slowing, stretched along its speed.
 *   The whole way from under the edge to the landing is one path (a quadratic curve that leaves
 *   the bar straight up) run at one speed curve: a thrust that comes on smoothly, then drag.
 * - spread (`land` to `hand`): it touches down still moving and wets its place: every edge of the
 *   sheet is a spring that starts at the drop's own edge with the drop's own speed, runs out to
 *   the card's and settles a pixel or two past. The words are revealed in place by the sheet.
 * - hand (`hand` to `end`): the conversation's own card takes over (a bubble), or the sheet melts
 *   into the queue row it landed on (a row).
 *
 * A message into the queue row right above the bar is thrown up and falls into it (a hop). A drop
 * with no edge (words leaving a queue row) swells where the words gathered and leaves from there.
 * Under a first message the bar itself leaves for the dock while the thread still holds
 * (`spec.bar`): the key, the meniscus and the thread's foot ride down with it.
 * Geometry is in the page's CSS px (viewport, already divided by the interface zoom).
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

export interface LiquidSpec {
  /**
   * Where the drop comes out: the top of the send key (`edge`: the key is a disc of radius `r`
   * hanging under that point, and the liquid shows only outside it), or a free point. An edge
   * without `r` is a straight one (everything under `y`).
   */
  from: { x: number; y: number; edge: boolean; r?: number };
  /** The shape it ends as. */
  to: Box;
  /** A bubble becomes the message card; a row melts into a queue row. */
  kind: 'bubble' | 'row';
  /** The bar glides away from `BAR_LEAVES` on (home/handoff.ts, the same spring): by this much in all. */
  bar?: { dx: number; dy: number };
}

/** A late correction of the landing: everything still to come bends toward a landing moved by (dx, dy), eased in from `at` over `dur` ms. */
export interface Shift {
  at: number;
  dx: number;
  dy: number;
  dur: number;
}

export interface LiquidPlan {
  spec: LiquidSpec;
  /** The drop's radius. */
  r: number;
  /** The drop starts to move (under the edge, or as a point where the words gathered). */
  born: number;
  /** It stands clear of the edge: from here on it is only tied to it by the thread. */
  launch: number;
  /** The thread parts. */
  snap: number;
  /** The drop touches its place and spreads. */
  land: number;
  /** The card takes over (bubble), or the sheet starts to melt (row). */
  hand: number;
  /** Nothing is left to draw. */
  end: number;
  /** The path: from `start` (the drop's centre at `born`) past the handle `via` to `impact` (its centre at `land`). */
  start: { x: number; y: number };
  via: { x: number; y: number };
  impact: { x: number; y: number };
  /** The way along the path per ms since `born` (0..1, one entry per ms), and the factor that turns the speed curve into way per ms. */
  way: Float32Array;
  rate: number;
  /** The speed curve's drag: what is left of the push at the end, and how fast it gets there (ms). */
  drag: { floor: number; tau: number };
  /** How far the drop is from the edge when the thread parts (px). */
  reach: number;
  /** The thread as it parts: its waist and its two ends' radii, the waist relative to the foot and to the drop. */
  parted: { foot: { x: number; y: number }; tail: { x: number; y: number }; rf: number; rb: number };
  /** The drop's stretch and speed (px/ms) as it lands. */
  arrive: { sx: number; sy: number; vx: number; vy: number };
  /** A hop (into a queue row): how far the path tops out over its higher end, px (0: no hop). */
  arc: number;
  shifts: Shift[];
}

/** The words gather into the corner and the field closes, in this long. */
export const COLLAPSE = 160;
/** The drop starts under the bar's edge as the last of the words go in. */
export const BORN = 116;
/** A drop with no edge (a queue row's words) starts sooner: the row is short. */
const FREE_BORN = 92;
/** Under a first message the bar leaves for the dock at this time: the drop is out, the thread holds. */
export const BAR_LEAVES = BORN + 40;
/** From touching down to the handover (a thin queue row fills sooner), and the handover itself. */
const SPREAD = 170;
const SPREAD_ROW = 140;
export const HAND = 90;
const DROP = 12;
/** The push: how fast it comes on, and until when (ms after `born`); drag takes over then. */
const RISE = 20;
const PUSH = 46;
/** How long the thread holds once the drop is clear of the edge (ms, at the drop's speed then). */
const THREAD_MS = 26;
/** How long the edge keeps showing after the thread has parted (the foot falling back, the bob; a bar that is leaving only the first). */
const EDGE_REST = 100;
const EDGE_REST_LEAVING = 48;
const edgeRest = (spec: LiquidSpec) => (spec.bar ? EDGE_REST_LEAVING : EDGE_REST);
/** The drop is still its own shape this long into the spread (merging into the sheet). */
const MERGE = 56;

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const smooth = (a: number, b: number, v: number) => {
  const u = clamp((v - a) / (b - a || 1), 0, 1);
  return u * u * (3 - 2 * u);
};
/** Out with a small overshoot (about 4 %): a bead that plops out and settles. */
const backOut = (u: number) => {
  const c = 1.25;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
};

/**
 * The collapse's progress (0..1 over COLLAPSE): a critically damped spring, so the words answer the
 * key in its first frame and the bar settles softly. The field's height closes on the same curve
 * (flight.ts, `linearEasing(collapseEase)`), so the words never stand outside the bar.
 */
const COLLAPSE_K = 6.2;
export const collapseEase = (u: number) => {
  const v = clamp(u, 0, 1) * COLLAPSE_K;
  return (1 - (1 + v) * Math.exp(-v)) / (1 - (1 + COLLAPSE_K) * Math.exp(-COLLAPSE_K));
};

/**
 * The words while they gather: scaled toward the corner, their width a little ahead of their
 * height (they draw into a stream that runs up into the point the drop comes out of), and how
 * much of them shows.
 */
export function collapseAt(u: number): { sx: number; sy: number; o: number } {
  return { sx: lerp(1, 0.02, collapseEase(Math.min(1, u * 1.3))), sy: lerp(1, 0.03, collapseEase(u)), o: 1 - smooth(0.16, 0.64, u) };
}

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

// ── the bar's glide (home/handoff.ts flies the bar on it; the edge here rides the same samples) ──

/** The spring the home composer glides to the dock on: semi-implicit Euler in `step` ms, a sample every `every` steps. */
export const GLIDE = { stiff: 440, damp: 40, step: 4, every: 4 };

let glideSamples: Float32Array | null = null;
/**
 * The glide's progress `ms` after it starts (0..1): the unit step of the spring as handoff.ts
 * steps and samples it, read between samples the way its keyframes are (linearly), so the edge
 * drawn here and the bar animated there are the same pixels.
 */
export function glideUnit(ms: number): number {
  if (ms <= 0) return 0;
  if (!glideSamples) {
    const n = 64;
    const s = new Float32Array(n + 1);
    const h = GLIDE.step / 1000;
    let x = 0;
    let v = 0;
    for (let i = 1; i <= n * GLIDE.every; i++) {
      v += (GLIDE.stiff * (1 - x) - GLIDE.damp * v) * h;
      x += v * h;
      if (i % GLIDE.every === 0) s[i / GLIDE.every] = x;
    }
    glideSamples = s;
  }
  const at = ms / (GLIDE.step * GLIDE.every);
  const i = Math.floor(at);
  if (i >= glideSamples.length - 1) return 1;
  return lerp(glideSamples[i], glideSamples[i + 1], at - i);
}

/** Where the point the drop comes out of is at `t`: fixed, or riding the bar as it leaves. */
export function footAt(spec: LiquidSpec, t: number): { x: number; y: number } {
  const { from, bar } = spec;
  if (!bar) return from;
  const g = glideUnit(t - BAR_LEAVES);
  return { x: from.x + bar.dx * g, y: from.y + bar.dy * g };
}

// ── the drop's speed and path ──

/**
 * A queued message's drop has almost no way to go (the tray's new row sits right over the bar it
 * rises from), so it hops: thrown up, over the top of a small arc, and down into the row, which it
 * hits still falling (the spread takes that fall).
 */
export const HOP = { height: 26, ms: 150 };

/** How long the drop is on its way, from under the edge to touching down, for a trip of `dist` px (as a thrown drop: with the root of the distance). */
export const tripMs = (dist: number) => clamp(64 + 8.2 * Math.sqrt(dist), 110, 236);

/**
 * The speed curve (unitless, peak 1) `ms` after `born`: the push comes on smoothly from rest (no
 * step in speed or in acceleration at the start), holds until PUSH, then drag eats it down toward
 * `floor`. One curve from the first swell under the edge to the landing.
 */
function speedAt(ms: number, floor: number, tau: number): number {
  if (ms <= 0) return 0;
  const on = 1 - Math.exp(-((ms / RISE) * (ms / RISE)));
  return ms < PUSH ? on : on * (floor + (1 - floor) * Math.exp(-(ms - PUSH) / tau));
}

/** How far the drop is stretched along its speed (px/ms): longer and thinner, about the same area. */
function stretch(v: number): { along: number; across: number } {
  const q = clamp(v * 0.2, 0, 0.46);
  return { along: 1 + q, across: 1 / Math.sqrt(1 + q) };
}

const bez = (a: number, c: number, b: number, q: number) => (1 - q) * (1 - q) * a + 2 * q * (1 - q) * c + q * q * b;
const bezD = (a: number, c: number, b: number, q: number) => 2 * (1 - q) * (c - a) + 2 * q * (b - c);

export function planLiquid(spec: LiquidSpec, shifts: Shift[] = []): LiquidPlan {
  const { from, to } = spec;
  const r = spec.kind === 'row' ? DROP * 0.8 : DROP;
  const born = from.edge ? BORN : FREE_BORN;
  // Under the edge at first (deep enough that its meniscus starts from nothing), or where the words gathered.
  const start = from.edge ? { x: from.x, y: from.y + r * 1.3 } : { x: from.x, y: from.y };
  // It lands in the card's bottom-right (the tail corner: where it came from), as round as the card allows.
  const c = Math.min(to.height, to.width, 42) / 2;
  const impact = { x: to.left + to.width - c, y: to.top + to.height - c };
  const dist = Math.hypot(impact.x - start.x, impact.y - start.y);
  const arc = spec.kind === 'row' && from.edge ? HOP.height : 0;
  // The handle: straight up out of the bar, then over to the landing; a hop tops out `arc` over its higher end.
  const up = Math.max(0, start.y - impact.y);
  const via = arc ? { x: (start.x + impact.x) / 2, y: (4 * (Math.min(from.y, impact.y) - arc) - start.y - impact.y) / 2 } : { x: start.x, y: start.y - Math.max(up * 0.5, r * 2.4) };
  const T = Math.round(arc ? HOP.ms : tripMs(dist));
  const drag = arc ? { floor: 0.9, tau: 40 } : { floor: 0.36, tau: (T - PUSH) * 0.5 };
  const way = new Float32Array(T + 1);
  let sum = 0;
  for (let i = 1; i <= T; i++) {
    sum += (speedAt(i - 1, drag.floor, drag.tau) + speedAt(i, drag.floor, drag.tau)) / 2;
    way[i] = sum;
  }
  for (let i = 1; i <= T; i++) way[i] /= sum;
  const land = born + T;
  const hand = land + (spec.kind === 'row' ? SPREAD_ROW : SPREAD);
  const plan: LiquidPlan = {
    spec,
    r,
    born,
    launch: born,
    snap: born,
    land,
    hand,
    end: hand + (spec.kind === 'row' ? HAND * 1.5 : HAND) + 16,
    start,
    via,
    impact,
    way,
    rate: 1 / sum,
    drag,
    reach: r * 2,
    parted: { foot: { x: 0, y: 0 }, tail: { x: 0, y: 0 }, rf: 0, rb: 0 },
    arrive: { sx: 1, sy: 1, vx: 0, vy: 0 },
    arc,
    shifts,
  };
  if (from.edge) {
    // When it stands clear of the edge, and when the thread has stretched as far as it holds.
    let t = born;
    while (t < land && gapAt(plan, t) < 0) t++;
    plan.launch = t;
    // The thread holds for about as long whatever the drop's speed (surface tension's own time): a
    // fast drop draws a longer one.
    const l = dropAt(plan, t, 0, 0);
    plan.reach = Math.min(clamp(Math.hypot(l.vx, l.vy) * THREAD_MS, r * 1.5, r * 4.6), dist * 0.42);
    while (t < land && gapAt(plan, t) < plan.reach) t++;
    plan.snap = Math.min(t, land - 8);
    const d = dropAt(plan, plan.snap, 0, 0);
    const f = footAt(spec, plan.snap);
    const w = WAIST;
    plan.parted = { foot: { x: (d.x - f.x) * w, y: (d.y - f.y) * w }, tail: { x: (f.x - d.x) * (1 - w), y: (f.y - d.y) * (1 - w) }, rf: threadRadii(r, 1).rf, rb: threadRadii(r, 1).rb };
  }
  const a = dropAt(plan, land, 0, 0);
  const v = Math.hypot(a.vx, a.vy);
  const s = stretch(v);
  const k = v > 0.0001 ? 1 / v : 0;
  // Vertical flights stretch tall; the stretch is kept per axis for the spread's start.
  plan.arrive = { sx: lerp(s.across, s.along, Math.abs(a.vx) * k), sy: lerp(s.across, s.along, Math.abs(a.vy) * k), vx: a.vx, vy: a.vy };
  return plan;
}

/** The drop's centre and speed (px/ms) at `t` (born..land), its landing moved by (sx, sy). */
function dropAt(plan: LiquidPlan, t: number, sx: number, sy: number): { x: number; y: number; vx: number; vy: number } {
  const ms = clamp(t - plan.born, 0, plan.way.length - 1);
  const i = Math.min(plan.way.length - 2, Math.floor(ms));
  const q = lerp(plan.way[i], plan.way[i + 1], ms - i);
  const qd = speedAt(ms, plan.drag.floor, plan.drag.tau) * plan.rate;
  const { start: S, via: C, impact: I } = plan;
  return { x: bez(S.x, C.x, I.x + sx, q), y: bez(S.y, C.y, I.y + sy, q), vx: bezD(S.x, C.x, I.x + sx, q) * qd, vy: bezD(S.y, C.y, I.y + sy, q) * qd };
}

/** How far the drop's underside stands over the edge it came out of (negative: still in it). */
function gapAt(plan: LiquidPlan, t: number): number {
  return footAt(plan.spec, t).y - dropAt(plan, t, 0, 0).y - plan.r;
}

/** Where along the thread its waist is (from the foot), and its radii for a stretch `u` of 0..1 (1: about to part). */
const WAIST = 0.42;
function threadRadii(r: number, u: number): { rf: number; rm: number; rb: number } {
  const left = 1 - clamp(u, 0, 1);
  const rm = r * 0.4 * Math.pow(left, 0.7);
  return { rf: rm + 1.2 + r * 0.3 * left, rm, rb: rm + 0.8 + r * 0.22 * left };
}

/** The sum of the late corrections at `t`. */
export function shiftAt(plan: LiquidPlan, t: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const s of plan.shifts) {
    const u = shiftEase((t - s.at) / Math.max(1, s.dur));
    x += s.dx * u;
    y += s.dy * u;
  }
  return { x, y };
}

// ── the spread ──

/**
 * A damped spring's position `t` ms after it is let go at `x0` with speed `v0` (px/ms), pulled to
 * `to`: natural frequency `w` (rad/ms), damping ratio `z` (under 1).
 */
export function springFrom(t: number, x0: number, v0: number, to: number, w: number, z: number): number {
  const a = x0 - to;
  const wd = w * Math.sqrt(1 - z * z);
  const b = (v0 + z * w * a) / wd;
  return to + Math.exp(-z * w * t) * (a * Math.cos(wd * t) + b * Math.sin(wd * t));
}

/** The damping ratio that takes a spring `past` px beyond its place after a run of `run` px (at least a hair, at most 5 %). */
export function dampFor(run: number, past: number): number {
  const f = clamp(past / Math.max(1, Math.abs(run)), 0.002, 0.05);
  const l = Math.log(f);
  return -l / Math.sqrt(Math.PI * Math.PI + l * l);
}

/** The sheet's edges: how quick each spring is (rad/ms) and how far it may go past (px). */
const FAR = { w: 0.046, past: 1.8 };
const TOP = { w: 0.052, past: 1.4 };
const NEAR = { w: 0.06, past: 0.4 };

export interface Sheet {
  left: number;
  top: number;
  right: number;
  bottom: number;
  radii: Radii;
}

/** The spreading sheet at `t` (from the landing on), without the late corrections. */
export function sheetAt(plan: LiquidPlan, t: number): Sheet {
  const { to } = plan.spec;
  const { impact: I, arrive: A, r } = plan;
  const span = plan.hand - plan.land;
  const T = clamp(t - plan.land, 0, span);
  const u = T / span;
  const hx = r * A.sx;
  const hy = r * A.sy;
  const right = to.left + to.width;
  const bottom = to.top + to.height;
  // Each edge leaves as the drop's own edge, at the drop's own speed, and is exactly the card's at the handover.
  const go = (from: number, target: number, k: { w: number; past: number }, v0: number) => {
    const z = dampFor(target - from, k.past);
    const at = (ms: number) => springFrom(ms, from, v0, target, k.w, z);
    return at(T) + (target - at(span)) * u * u * u;
  };
  const L = go(I.x - hx, to.left, FAR, A.vx * 0.6);
  const R = Math.min(go(I.x + hx, right, NEAR, A.vx * 0.6), right + 1);
  const Tp = go(I.y - hy, to.top, TOP, A.vy * 0.7);
  const B = Math.min(go(I.y + hy, bottom, NEAR, A.vy * 0.5), bottom + 1);
  const w = Math.max(0.5, R - L);
  const h = Math.max(0.5, B - Tp);
  // Round as the drop at first, the card's corners as it fills its place.
  const w0 = hx * 2;
  const p = smooth(0, 1, (w - w0) / Math.max(1, to.width - w0));
  const round = Math.min(hx, hy);
  const cap = Math.min(w, h) / 2;
  const radii = to.radii.map((rr) => Math.min(cap, lerp(round, rr, u >= 1 ? 1 : p))) as Radii;
  return { left: L, top: Tp, right: L + w, bottom: Tp + h, radii };
}

// ── what to draw ──

/** A tapered piece of the thread: from (ax, ay) with radius `ra` to (bx, by) with radius `rb`. */
export interface Taper {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ra: number;
  rb: number;
}

/** What to draw at `t`. All of it is one liquid; `alpha` fades it as the card or row takes over. */
export interface LiquidFrame {
  /**
   * The key the drop is tied to (and a moment after, while what is left on it falls back): its
   * top point and its radius `r` (0: a straight edge under `y`). Only what stands outside it is
   * drawn, and the drop flows into it with a smooth union of radius `k`. `bob`: a straight edge's
   * one small swell after the thread has parted (px; the key gives instead, launch.ts).
   */
  edge?: { x: number; y: number; k: number; bob: number; r: number };
  /** The drop: centre, radius, its stretch along `ang` (`sx`) and across it (`sy`). */
  drop?: { x: number; y: number; r: number; sx: number; sy: number; ang: number };
  /** The thread: its lower piece (out of the edge) and its upper piece (the drop's tail). */
  foot?: Taper;
  tail?: Taper;
  sheet?: Sheet;
  /** How softly the drop runs into the sheet while both are drawn (a smooth union's radius). */
  join: number;
  /** How much it is a drop of glass: 1 in the air (lit, bending what is behind it), the card's own quiet surface at 0. */
  light: number;
  /** How deep the glass is rounded in from its rim, px: the drop's radius in the air, a hairline bevel on the card. */
  lens: number;
  alpha: number;
  done: boolean;
}

export function liquidAt(plan: LiquidPlan, t: number): LiquidFrame {
  const { spec, r } = plan;
  const { from } = spec;
  if (t >= plan.end) return { alpha: 0, light: 0, lens: 1, join: 0, done: true };
  const f: LiquidFrame = { alpha: 1, light: 1, lens: r, join: 0, done: false };
  if (t < plan.born) return f;
  const sh = shiftAt(plan, t);
  const ms = t - plan.born;

  if (from.edge && t < plan.snap + edgeRest(spec)) {
    const F = footAt(spec, t);
    const since = t - plan.snap;
    // The meniscus is wide while the drop comes through the edge and lets go as it leaves; after
    // the thread has parted the edge bobs once, low and wide, and is the bar's alone again.
    const round = from.r ?? 0;
    // On the key the collar stays close to the neck: the key is small and must stay a clean disc.
    const k = r * lerp(0.3, round ? 0.8 : 1.15, smooth(0, 26, ms)) * lerp(1, 0.45, smooth(plan.launch, plan.snap, t)) * (1 - smooth(0, 28, since));
    const u = clamp((since - 16) / 72, 0, 1);
    f.edge = { x: F.x, y: F.y, k, bob: since > 0 && !round ? 2.2 * Math.sin(Math.PI * u) * (1 - u) : 0, r: round };
    if (t >= plan.launch) {
      if (since < 0) {
        // The thread, stretched between the edge and the drop: its waist thins as it lengthens.
        const d = dropAt(plan, t, sh.x, sh.y);
        const tr = threadRadii(r, gapAt(plan, t) / plan.reach);
        const mx = lerp(F.x, d.x, WAIST);
        const my = lerp(F.y, d.y, WAIST);
        f.foot = { ax: F.x, ay: F.y, bx: mx, by: my, ra: tr.rf, rb: tr.rm };
        f.tail = { ax: d.x, ay: d.y, bx: mx, by: my, ra: tr.rb, rb: tr.rm };
      } else if (since < 64) {
        // Parted: the foot falls back into the edge.
        const e = Math.exp(-since / 12);
        f.foot = { ax: F.x, ay: F.y, bx: F.x + plan.parted.foot.x * e, by: F.y + plan.parted.foot.y * e, ra: plan.parted.rf * Math.exp(-since / 18), rb: 0.1 };
      }
    }
  }

  if (t < plan.land) {
    const d = dropAt(plan, t, sh.x, sh.y);
    const v = Math.hypot(d.vx, d.vy);
    const s = stretch(v);
    let along = s.along;
    let size = r;
    if (from.edge) {
      // The bar's own ink while it is part of the bar; it takes the light as it lifts away.
      f.light = smooth(plan.born + 8, plan.launch + 12, t);
      const since = t - plan.snap;
      if (since >= 0) {
        if (since < 56) {
          // The tail snaps up into the drop.
          const e = Math.exp(-since / 10);
          f.tail = { ax: d.x, ay: d.y, bx: d.x + plan.parted.tail.x * e, by: d.y + plan.parted.tail.y * e, ra: plan.parted.rb * Math.exp(-since / 16), rb: 0.1 };
        }
        // And the drop rings once with it: shorter along its path, then a little longer, then itself.
        along *= 1 - 0.13 * Math.exp(-since / 34) * Math.sin((2 * Math.PI * since) / 56);
      }
    } else {
      // Swelling where the words gathered, as it starts to move.
      size = r * lerp(0.12, 1, backOut(clamp(ms / 64, 0, 1)));
      f.light = smooth(0, 44, ms);
    }
    f.lens = size;
    f.drop = { x: d.x, y: d.y, r: size, sx: along, sy: 1 / Math.sqrt(along), ang: v > 0.004 ? Math.atan2(d.vy, d.vx) : -Math.PI / 2 };
    return f;
  }

  const s = sheetAt(plan, t);
  f.sheet = { left: s.left + sh.x, right: s.right + sh.x, top: s.top + sh.y, bottom: s.bottom + sh.y, radii: s.radii };
  const into = t - plan.land;
  if (into < MERGE) {
    // The drop is still there for a moment, running on into the sheet it becomes (one skin around both).
    const A = plan.arrive;
    const go = 7 * (1 - Math.exp(-into / 10));
    const left = 1 - smooth(0, MERGE, into);
    f.drop = { x: plan.impact.x + sh.x + A.vx * go, y: plan.impact.y + sh.y + A.vy * go, r: r * lerp(0.5, 1, left), sx: lerp(1, A.sx, left), sy: lerp(1, A.sy, left), ang: 0 };
    f.join = r * 0.9;
  }
  // The glass flattens as it spreads: a drop's dome at first, the card's bevel, then its hairline.
  const u = smooth(plan.land, plan.hand, t);
  f.light = 1 - u;
  f.lens = lerp(r, 1, smooth(0, 0.8, (t - plan.land) / (plan.hand - plan.land)));
  if (spec.kind === 'row') f.alpha = 1 - smooth(plan.hand, plan.hand + HAND * 1.5, t);
  else if (t > plan.hand) f.alpha = handAlpha((t - plan.hand) / HAND);
  return f;
}

/**
 * The sheet's share while the card's own surface fades in over it (linearly over HAND, flight.ts):
 * together the two always cover as much as the card alone, so nothing behind them dims or shows.
 */
export function handAlpha(u: number): number {
  const v = clamp(u, 0, 1);
  if (v >= 1) return 0;
  return clamp((1 - (1 - INK.a) / (1 - INK.a * v)) / INK.a, 0, 1);
}

/**
 * The window the spreading ink reveals the words through, as a box relative to the card's place
 * (`to`): offset (x, y) and scale (sx, sy) of a clip laid over the card; the words themselves stay
 * where they will be (the clip's child is counter-scaled). `o` is how much of them shows.
 */
export function revealAt(plan: LiquidPlan, t: number): { x: number; y: number; sx: number; sy: number; o: number } {
  const { to } = plan.spec;
  if (t >= plan.hand) return { x: 0, y: 0, sx: 1, sy: 1, o: 1 };
  const s = t < plan.land ? sheetAt(plan, plan.land) : sheetAt(plan, t);
  const sx = clamp((s.right - s.left) / to.width, 0.02, 1.2);
  const sy = clamp((s.bottom - s.top) / to.height, 0.02, 1.2);
  const o = t < plan.land ? 0 : smooth(0.22, 0.8, Math.min(sx, sy));
  return { x: s.left - to.left, y: s.top - to.top, sx, sy, o };
}

/** The region the liquid can draw in (the edge, the flight, the landing, its overshoot and its shadow), with room for corrections. */
export function liquidBounds(plan: LiquidPlan, room = 90): { left: number; top: number; width: number; height: number } {
  const { from, to } = plan.spec;
  const r = plan.r * 2;
  // The edge is drawn until a moment after the thread has parted: as far as the bar has gone by then.
  const foot = footAt(plan.spec, plan.snap + edgeRest(plan.spec));
  const xs = [from.x, foot.x, plan.start.x, plan.impact.x];
  const left = Math.min(...xs.map((x) => x - r * 2), to.left - 24) - 8;
  const right = Math.max(...xs.map((x) => x + r * 2), to.left + to.width + 12) + 8;
  // Where the path tops out (a hop's arc, or the landing itself).
  const { start: S, via: C, impact: I } = plan;
  const den = S.y - 2 * C.y + I.y;
  const q = Math.abs(den) > 1e-6 ? clamp((S.y - C.y) / den, 0, 1) : 1;
  const apex = Math.min(I.y, bez(S.y, C.y, I.y, q));
  const top = Math.min(to.top - 24, from.y - r * 2, apex - r * 2) - room;
  const under = from.r ? from.r * 0.6 + 2 : 4;
  const bottom = Math.max(from.y + under, foot.y + under, to.top + to.height + SHADOW.reach) + room;
  return { left: Math.floor(left), top: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

/**
 * The look of the liquid: the message card's fill (`.user-card::before`) and its inner hairline;
 * in the air a drop of dark glass (`GLASS`), and one soft shadow under it.
 */
export const INK = {
  fill: [26, 26, 30] as [number, number, number],
  a: 0.72,
  /** The drop's ink is a step lighter than the card's: it reads on the dark stage, and settles. */
  lift: [32, 32, 37] as [number, number, number],
  /** The hairline: the card's, and its top while lit. */
  rim: 0.09,
  lit: 0.34,
};

/**
 * The glass: where its light comes from (the top and slightly left, as on the app's other glass,
 * tokens.css `--rim-light`; toward the reader), how sharp and strong its highlight is, the light
 * on its rim and the glow that comes through to the far side, and how far it bends what is behind
 * it (the backdrop's field), in shares of its depth.
 */
export const GLASS = { light: [-0.32, -0.78, 0.54] as [number, number, number], gloss: 64, spec: 0.82, sheen: 0.1, rim: 0.42, glow: 0.2, bend: 0.85, pass: 0.92 };

export const SHADOW = { y: 7, blur: 16, a: 0.5, reach: 26 };

/** The page px a frame covers, with room for its shadow and smoothing (null: nothing). */
export function frameBounds(f: LiquidFrame): { x0: number; y0: number; x1: number; y1: number } | null {
  if (f.done || f.alpha <= 0.001) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (a: number, b: number, c: number, d: number) => {
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  };
  const d = f.drop;
  if (d) {
    const reach = d.r * Math.max(d.sx, d.sy) + 2;
    add(d.x - reach, d.y - reach, d.x + reach, d.y + reach);
  }
  for (const p of [f.foot, f.tail]) {
    if (!p) continue;
    const m = Math.max(p.ra, p.rb) + 2;
    add(Math.min(p.ax, p.bx) - m, Math.min(p.ay, p.by) - m, Math.max(p.ax, p.bx) + m, Math.max(p.ay, p.by) + m);
  }
  if (f.edge) {
    const e = f.edge;
    const w = (d ? d.r : 0) + e.k * 1.5 + 14;
    add(e.x - w, e.y - 6, e.x + w, e.y);
    if (d) add(d.x - d.r - e.k * 1.5, d.y, d.x + d.r + e.k * 1.5, e.y);
  }
  if (f.sheet) add(f.sheet.left, f.sheet.top, f.sheet.right, f.sheet.bottom);
  if (x0 === Infinity) return null;
  const pad = SHADOW.blur;
  const b = { x0: x0 - pad, y0: y0 - pad * 0.6, x1: x1 + pad, y1: y1 + SHADOW.reach };
  // Nothing under a bar the drop is tied to; round a key only its shoulders (the collar).
  if (f.edge) b.y1 = Math.min(b.y1, f.edge.y + (f.edge.r ? f.edge.r * 0.6 : 2));
  return b;
}
