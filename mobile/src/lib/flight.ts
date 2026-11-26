import { drawLiquid, HAND, liquidAt, planLiquid, SNAP, type Ink, type LiquidFrame, type LiquidPlan } from './liquid-shape';
import { haptic } from '@m/lib/native';
import { fieldBeat } from '@m/ui/Field';
import { reduced } from '@m/ui/motion';

/**
 * The send as liquid, at hand size (the desktop's flight.ts in spirit, its geometry shared:
 * src/features/composer/liquid-shape.ts). The words drain into the prompt bar's top-right corner
 * and the field is empty at once; a bead of the bar's ink swells out of its top edge there, lifts
 * on a neck that thins and breaks (one light haptic tick at the break), and the drop rises to the
 * corner of where the message lands, then spreads into the bubble's shape with the words unfolding
 * inside it. The conversation's own bubble takes over in one frame.
 *
 * Who draws what: the ink on one small canvas (main thread, a path per frame), the words as page
 * layers on the compositor (the pour on WAAPI, the unfold as transform and opacity on the real
 * bubble). The bubble is hidden until the sheet sits on it; when it is late, the drop waits above
 * the bar, breathing, and rises when it is there. Reduced motion: the words leave the field and the
 * bubble fades in.
 */

type Dest = 'bubble' | 'row';

interface Flight {
  key: string;
  t0: number;
  from: { x: number; y: number };
  plan: LiquidPlan;
  /** The real plan once the landing is known, and when (ms from t0) the rise may start. */
  real: LiquidPlan | null;
  /** Shift of the clock for a drop that waited for its landing. */
  lag: number;
  target: HTMLElement | null;
  row: HTMLElement | null;
  dest: Dest | null;
  /** The landing's untransformed box as last read, for corrections. */
  box: { left: number; top: number } | null;
  ink: Ink;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  origin: { x: number; y: number };
  dpr: number;
  raf: number;
  ticked: boolean;
  handed: boolean;
  pour: HTMLElement[];
  restore: (() => void) | null;
  calm: boolean;
  fade: number;
}

let current: Flight | null = null;
/** Debug builds only: slows the liquid down for frame strips (`sable.flightRate(0.25)`). */
let rate = 1;
export const setFlightRate = (r: number) => void (rate = r);
const since = (f: Flight) => (performance.now() - f.t0) * rate;

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
const matches = (a: string, b: string) => !!a && (a === b || a.startsWith(b) || b.startsWith(a));

/** Most of a pour: how long one line takes to drain, and the stagger between lines. */
const POUR_MS = 150;
const POUR_SPREAD = 50;
const MAX_BANDS = 5;
/** A drop nobody claims fades after this long. */
const MAX_WAIT = 5000;

function inkFrom(bg: string): Ink {
  const m = /rgba?\(([^)]+)\)/.exec(bg);
  const p = m ? m[1].split(/[ ,/]+/).filter(Boolean).map(Number) : [27, 27, 31, 1];
  const rgb: [number, number, number] = [p[0] || 27, p[1] || 27, p[2] || 31];
  const a = p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1;
  return { base: { rgb, a, rim: 0.07 }, lit: { rgb: [58, 57, 58], a: 0.98, rim: 0.3 } };
}

/**
 * The words leave `field` (call before clearing it) from `bar`'s top-right corner. `dest` says
 * where they will land: a bubble in the conversation, or a row of the queue above the bar.
 */
export function launchFlight(text: string, field: HTMLTextAreaElement, bar: HTMLElement) {
  end(current, true);
  const key = norm(text);
  if (!key) return;
  const b = bar.getBoundingClientRect();
  const from = { x: b.right - 34, y: b.top };
  const calm = reduced();
  const f: Flight = {
    key,
    t0: performance.now(),
    from,
    plan: planLiquid({ from: { ...from, edge: true }, to: { left: b.right - 120, top: b.top - 120, width: 100, height: 46, radii: [22, 22, 7, 22] }, kind: 'bubble' }),
    real: null,
    lag: 0,
    target: null,
    row: null,
    dest: null,
    box: null,
    ink: inkFrom('rgb(27, 27, 31)'),
    canvas: null,
    ctx: null,
    origin: { x: 0, y: 0 },
    dpr: 1,
    raf: 0,
    ticked: false,
    handed: false,
    pour: [],
    restore: null,
    calm,
    fade: 0,
  };
  current = f;
  if (calm) {
    haptic('tap');
    return;
  }
  f.pour = pourWords(field, text, from);
  // The field is empty at once, but its placeholder waits until the words have drained.
  bar.setAttribute('data-pouring', '');
  window.setTimeout(() => bar.removeAttribute('data-pouring'), POUR_MS / rate + 160);
  // The canvas: the band above the bar where the drop can travel (the newest line sits just above it).
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const top = Math.max(0, b.top - 640);
  const h = b.top + 24 - top;
  const w = window.innerWidth;
  const c = document.createElement('canvas');
  c.className = 'liquid';
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.cssText = `top:${top}px;left:0;width:${w}px;height:${h}px;`;
  document.body.appendChild(c);
  f.canvas = c;
  f.ctx = c.getContext('2d');
  f.origin = { x: 0, y: top };
  f.dpr = dpr;
  f.raf = requestAnimationFrame(() => frame(f));
}

/** The visible words cut into their lines; each narrows into the corner faster than it flattens, fading as it arrives. */
function pourWords(field: HTMLTextAreaElement, text: string, at: { x: number; y: number }): HTMLElement[] {
  const cs = getComputedStyle(field);
  const r = field.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const left = r.left + padL;
  const width = r.width - padL - padR;
  const viewTop = r.top + padT;
  const viewH = Math.max(line, r.height - padT - padB);
  const n = Math.max(1, Math.min(MAX_BANDS, Math.round(viewH / line)));
  const bandH = n === 1 ? viewH : line;
  const font = `font-size:${cs.fontSize};line-height:${cs.lineHeight};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing};color:${cs.color};`;
  const step = n > 1 ? Math.min(18, POUR_SPREAD / (n - 1)) : 0;
  const out: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const top = viewTop + i * bandH;
    const band = document.createElement('div');
    band.className = 'send-pour';
    band.setAttribute('aria-hidden', 'true');
    band.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${bandH}px;transform-origin:${(at.x - left).toFixed(1)}px ${(at.y - top).toFixed(1)}px;`;
    const words = document.createElement('div');
    words.style.cssText = `top:${(viewTop - field.scrollTop - top).toFixed(2)}px;width:${width}px;${font}`;
    words.textContent = text;
    band.appendChild(words);
    document.body.appendChild(band);
    const frames: Keyframe[] = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      const e = u * u * (3 - 2 * u);
      const sx = 1 + (0.012 - 1) * e ** 0.8;
      const sy = 1 + (0.03 - 1) * e ** 1.25;
      frames.push({ offset: u, transform: `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`, opacity: 1 - smoothstep(0.55, 1, u) });
    }
    band.animate(frames, { duration: POUR_MS / rate, delay: (i * step) / rate, easing: 'linear', fill: 'both' });
    out.push(band);
  }
  window.setTimeout(() => out.forEach((el) => el.remove()), (POUR_MS + n * step) / rate + 40);
  return out;
}

const smoothstep = (a: number, b: number, v: number) => {
  const u = Math.min(1, Math.max(0, (v - a) / (b - a || 1)));
  return u * u * (3 - 2 * u);
};

/** The landing's untransformed box: a bubble sits at its row's right edge, a queue row is itself. */
function boxOf(f: Flight) {
  const el = f.target!;
  if (f.dest === 'bubble' && f.row) {
    const r = f.row.getBoundingClientRect();
    return { left: r.right - el.offsetWidth, top: r.top, width: el.offsetWidth, height: el.offsetHeight };
  }
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function radiiOf(el: HTMLElement): [number, number, number, number] {
  const cs = getComputedStyle(el);
  const v = (s: string) => parseFloat(s) || 0;
  return [v(cs.borderTopLeftRadius), v(cs.borderTopRightRadius), v(cs.borderBottomRightRadius), v(cs.borderBottomLeftRadius)];
}

/** Whether words with this text are in the air (a row about to mount skips its own entrance). */
export function inFlight(text: string): boolean {
  const f = current;
  return !!f && !f.target && matches(f.key, norm(text)) && performance.now() - f.t0 < MAX_WAIT;
}

/**
 * A message that arrived in the conversation (or the queue) with this text: when its words are in
 * the air it becomes their landing, hidden until the liquid hands over. Returns whether it did.
 */
export function claimFlight(text: string, el: HTMLElement, dest: Dest = 'bubble'): boolean {
  const f = current;
  if (!f || f.target || !matches(f.key, norm(text)) || performance.now() - f.t0 > MAX_WAIT) return false;
  f.target = el;
  f.dest = dest;
  if (f.calm) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    current = null;
    return true;
  }
  if (dest === 'bubble') {
    f.row = el.parentElement;
    // Land where it will rest: the conversation at its newest line before measuring.
    const sc = el.closest('.thread');
    if (sc) sc.scrollTop = sc.scrollHeight;
  }
  const cs = getComputedStyle(el);
  f.ink = inkFrom(cs.backgroundColor);
  const box = boxOf(f);
  f.box = { left: box.left, top: box.top };
  const t = since(f);
  const plan = planLiquid({ from: { ...f.from, edge: true }, to: { ...box, radii: radiiOf(el) }, kind: dest });
  // A landing known before the break simply is the plan; one known later starts the rise now.
  f.lag = Math.max(0, t - plan.snap);
  f.real = plan;
  // Hidden until the hand: no surface, the words unfold from the sheet.
  const s = el.style;
  const prev = { background: s.background, boxShadow: s.boxShadow, transform: s.transform, transformOrigin: s.transformOrigin, opacity: s.opacity };
  s.background = 'transparent';
  s.boxShadow = 'none';
  s.transformOrigin = '0 0';
  s.opacity = '0';
  f.restore = () => {
    s.background = prev.background;
    s.boxShadow = prev.boxShadow;
    s.transform = prev.transform;
    s.transformOrigin = prev.transformOrigin;
    s.opacity = prev.opacity;
  };
  return true;
}

/** The words inside the sheet at plan time `tp`: one scale that fits it, centred in it. */
function wordsIn(plan: LiquidPlan, fr: LiquidFrame, box: { left: number; top: number }) {
  const to = plan.spec.to;
  const sh = fr.sheet;
  if (!sh) return null;
  const s = Math.min(1, Math.max(0.02, Math.min((sh.right - sh.left) / to.width, (sh.bottom - sh.top) / to.height)));
  const cx = (sh.left + sh.right) / 2;
  const cy = (sh.top + sh.bottom) / 2;
  return { x: cx - (to.width * s) / 2 - box.left, y: cy - (to.height * s) / 2 - box.top, s, o: smoothstep(0.32, 0.8, s) };
}

function frame(f: Flight) {
  if (current !== f) return;
  const t = since(f);
  const ctx = f.ctx;
  const c = f.canvas;
  if (!ctx || !c) return end(f);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(f.dpr, 0, 0, f.dpr, -f.origin.x * f.dpr, -f.origin.y * f.dpr);

  // The break: one light tick, and a wave through the field from where the drop left.
  if (!f.ticked && t >= SNAP) {
    f.ticked = true;
    // 2.21: the send is felt as a send (a firmer tick than a tap), where the drop leaves.
    haptic('send');
    fieldBeat('send', { x: f.from.x, y: f.from.y - 16 });
  }

  const plan = f.real;
  if (!plan || (t >= SNAP && t < SNAP + f.lag)) {
    // No landing yet: the bead forms as planned, and past the break the drop waits above the bar, breathing.
    if (t > MAX_WAIT) return end(f, true);
    if (t < SNAP) drawLiquid(ctx, liquidAt(f.plan, t), f.ink);
    else {
      const p = f.plan;
      const w = t - SNAP;
      const settle = Math.min(1, w / 140);
      const y = p.leave.y - 4 * settle + Math.sin(w / 260) * 1.5 * settle;
      const k = 1 + Math.sin(w / 200) * 0.025 * settle;
      const fr: LiquidFrame = { glow: 1, alpha: f.fade ? Math.max(0, 1 - (t - f.fade) / 160) : 1, done: false, drop: { x: p.leave.x, y, r: p.r * k, sx: 1, sy: 1, tail: 0, tx: 0, ty: 1 } };
      if (w < 110) {
        const u = w / 110;
        fr.stub = { x: f.from.x, y: f.from.y, h: p.r * 0.62 * (1 - (1 - (1 - u) ** 3)), w: p.r * (0.75 + 0.35 * u), round: smoothstep(0, 0.6, u) };
      }
      drawLiquid(ctx, fr, f.ink);
      if (f.fade && t - f.fade > 160) return end(f, true);
    }
    f.raf = requestAnimationFrame(() => frame(f));
    return;
  }

  const tp = t < SNAP ? t : t - f.lag;
  // The landing moved (the conversation settled under it): everything still to come follows.
  if (f.target && f.box && tp < plan.hand) {
    const b = boxOf(f);
    const dx = b.left - f.box.left;
    const dy = b.top - f.box.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      plan.shifts.push({ at: tp, dx, dy, dur: tp >= plan.land ? 1 : 70 });
      f.box = { left: b.left, top: b.top };
    }
  }
  const fr = liquidAt(plan, tp);
  if (tp >= plan.hand && !f.handed) {
    // The bubble takes over in one frame (a row melts under the sheet as it fades).
    f.handed = true;
    const el = f.target;
    f.restore?.();
    f.restore = null;
    if (el && f.dest === 'row') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: HAND, easing: 'ease-out' });
  }
  if (f.dest === 'bubble' && f.handed) return end(f);
  drawLiquid(ctx, fr, f.ink);
  // The words unfold with the sheet, on the bubble itself.
  const el = f.target;
  if (el && !f.handed && f.box) {
    if (tp < plan.land) el.style.opacity = '0';
    else {
      const w = f.dest === 'bubble' ? wordsIn(plan, fr, f.box) : null;
      if (w) {
        el.style.transform = `translate(${w.x.toFixed(2)}px, ${w.y.toFixed(2)}px) scale(${w.s.toFixed(4)})`;
        el.style.opacity = String(w.o);
      }
    }
  }
  if (fr.done) return end(f);
  f.raf = requestAnimationFrame(() => frame(f));
}

function end(f: Flight | null, fade = false) {
  if (!f) return;
  cancelAnimationFrame(f.raf);
  f.restore?.();
  f.restore = null;
  f.pour.forEach((el) => el.remove());
  f.pour = [];
  const c = f.canvas;
  f.canvas = null;
  if (c) {
    if (fade) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.then(() => c.remove(), () => c.remove());
    else c.remove();
  }
  if (current === f) current = null;
}

/** The send failed: the words go back into the field, the drop dissolves. */
export function dropFlight() {
  const f = current;
  if (!f) return;
  if (!f.target) {
    f.fade = since(f);
    if (f.fade < SNAP) end(f, true);
  } else end(f, true);
}
