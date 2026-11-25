/**
 * Motion helpers. Everything here drives the Web Animations API, so transforms, opacity and
 * clips run off the main thread and nothing re-renders while it moves.
 */

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Interface size zooms the root; rects are in screen pixels, styles in zoomed ones. Divide by this. */
export const uiZoom = () => parseFloat(document.documentElement.style.zoom) || 1;

export interface SpringCurve {
  /** A CSS `linear()` easing that traces the spring. */
  easing: string;
  /** Milliseconds until the spring has settled. */
  duration: number;
  /**
   * The spring's value (0 to about 1) at a share `p` of its duration: where a move that is under
   * way stands, worked out and not read from the page (a computed style is as of the page's last
   * frame, and of an animation that has not started yet it is the first keyframe).
   */
  value: (p: number) => number;
}

const springs = new Map<string, SpringCurve>();

/**
 * A spring as an easing for `element.animate` (same stiffness/damping scale as motion/react,
 * mass 1). The curve may overshoot 1; the duration is where it has settled to within 0.2 %.
 */
export function spring(stiffness: number, damping: number): SpringCurve {
  const key = `${stiffness}/${damping}`;
  const hit = springs.get(key);
  if (hit) return hit;
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  let at: (t: number) => number;
  let settle: number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    at = (t) => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    settle = Math.log(500) / (zeta * w0);
  } else {
    // Critically damped (overdamped springs are treated as critical: nothing here wants them slower).
    at = (t) => 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    settle = 8.4 / w0;
  }
  const n = Math.max(14, Math.min(48, Math.round(settle * 90)));
  const stops: string[] = [];
  for (let i = 0; i <= n; i++) stops.push(i === n ? '1' : (Math.round(at((settle * i) / n) * 1000) / 1000).toString());
  const curve = { easing: `linear(${stops.join(', ')})`, duration: Math.round(settle * 1000), value: (p: number) => (p >= 1 ? 1 : p <= 0 ? 0 : at(settle * p)) };
  springs.set(key, curve);
  return curve;
}

/**
 * How far a slide that runs on `curve` from `from` px home to 0 still holds its element at `now`
 * (`performance.now()`, the clock an animation's `startTime` counts on). Worked out from the
 * slide's own start, never read from the page: a computed style is as of the page's last frame.
 * A slide whose start is not known yet has not moved.
 */
export function slideLeft(curve: SpringCurve, from: number, started: number | null, now: number): number {
  return started == null ? from : from * (1 - curve.value((now - started) / curve.duration));
}

/**
 * How much of a thing shows at `now` (0 to 1) when it fades in on a slide's own curve and is whole
 * at the share `full` of the way (keyframes `opacity: 0`, then `opacity: 1` at offset `full`).
 * Worked out, as `slideLeft`: what leaves while it arrives goes on from here, not from whole.
 */
export function fadeShown(curve: SpringCurve, full: number, started: number | null, now: number): number {
  if (started == null) return 0;
  return Math.min(1, Math.max(0, curve.value((now - started) / curve.duration) / full));
}

export const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** The "standard" curve: slow in, fast middle, soft landing. For things that resize in place. */
export const EASE_STD = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** `element.animate` that is skipped under reduced motion (returns null) and never throws. */
export function play(el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions): Animation | null {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return null;
  try {
    return el.animate(frames, opts);
  } catch {
    return null;
  }
}

/** Moves an element from where it was drawn (`from`, screen pixels) to where it is laid out now. */
export function flipFrom(el: HTMLElement | null, from: { left: number; top: number }, opts: KeyframeAnimationOptions): Animation | null {
  if (!el) return null;
  const now = el.getBoundingClientRect();
  const z = uiZoom();
  const dx = (from.left - now.left) / z;
  const dy = (from.top - now.top) / z;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  return play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], opts);
}

/**
 * The backdrop pulse. Fields listen for it and send a soft swell of light outward from the
 * point (viewport coordinates). `strength` is 0..1: 1 for a sent message, less for quieter beats.
 */
export const PULSE_EVENT = 'sable:pulse';
export interface PulseDetail {
  x: number;
  y: number;
  strength: number;
}

export function pulseFrom(el: Element | null | undefined, strength = 1) {
  if (!el || reducedMotion()) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;
  window.dispatchEvent(new CustomEvent<PulseDetail>(PULSE_EVENT, { detail: { x: r.left + r.width / 2, y: r.top + r.height / 2, strength } }));
}

/** The scrollTop adjustment for an anchor's movement in viewport pixels. */
export const anchorCorrection = (delta: number, zoom: number) => delta / (zoom || 1);
