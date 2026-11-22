import { barLeaving, HOLD_MS, launchRead, RELEASE } from '@/features/composer/flight';
import { BAR_LEAVES, COLLAPSE, collapseEase, GLIDE, linearEasing } from '@/features/composer/liquid-shape';
import { holdSend } from '@/features/composer/settle';
import { ARROW_OUT, ARROW_OUT_EASE, ARROW_OUT_MS, KEY_GIVE, KEY_GIVE_MS, SQUARE_IN, SQUARE_IN_AT, SQUARE_IN_EASE, SQUARE_IN_MS } from '@/features/composer/launch';
import { reducedMotion, uiZoom } from '@/lib/motion';

/**
 * The home-to-session hand-off: sending the first message from the home screen is one motion.
 *
 * On send, the home composer card is copied into a fixed layer above the stage (the "ghost") and
 * the real card hides. The ghost glides on a spring (about 350 ms) from the centre of the home
 * screen to where the session's docked composer will sit, predicted from the stage's geometry, so
 * it moves without waiting for the session to exist. While the sent words gather into its corner
 * and the drop comes out of its top edge (composer/flight.ts) it holds still, its field closing to
 * one line with the words; it leaves as the drop flies, a thread of liquid still between them
 * (drawn on the card's edge as the glide moves it), so the two push off from each other, the drop
 * up to the top of the column and the bar down to the dock. When the
 * session view mounts, its composer claims the flight: the spring is re-aimed at the real card
 * (keeping its velocity), the real card stays hidden until the ghost lands on it, and then the two
 * swap in one frame.
 * Meanwhile the mark and headline are gone within a few frames and the home view (with its backdrop)
 * fades out while the session's quiet band fades in (App reads `handoffActive()` for those exits).
 *
 * The spring is stepped ahead of time and handed over as animations (like the sent words in
 * `composer/flight.ts`): the glide is one compositor transform, so the session view mounting under
 * it cannot make it stutter; a change of width (only in a window too narrow for the column) rides
 * along as a declarative animation of the ghost alone. The main thread only acts at the send, the
 * claim and the landing.
 *
 * Under reduced motion there is no ghost: the views crossfade.
 */

type Phase = 'idle' | 'flying';

/** A point on the glide: ms since the send, offset from the start and width (px), and their speeds. */
interface Sample {
  t: number;
  x: number;
  y: number;
  w: number;
  vx: number;
  vy: number;
  vw: number;
}

interface Flight {
  ghost: HTMLElement;
  source: HTMLElement;
  start: { left: number; top: number; width: number; height: number };
  dock: HTMLElement | null;
  /** The path the ghost is on and its two animations (transform on the compositor, width beside it). */
  path: Sample[];
  move: Animation | null;
  size: Animation | null;
  /** What cleared the home stage at the send (undone when the send starts no session). */
  clear: Animation[];
  /** Corrections run after the claim (the docked card can still move as the session settles). */
  fixes: number;
  /** Ms after the send the card holds still for the sent message's bead (0: it leaves at once). */
  hold: number;
  timer: number;
  ending: boolean;
  /** Lands the send for `settle.ts`. */
  done: () => void;
}

let flight: Flight | null = null;
let still = false;
let phase: Phase = 'idle';
const subs = new Set<() => void>();

const set = (p: Phase) => {
  if (phase === p) return;
  phase = p;
  subs.forEach((f) => f());
};

export const handoffPhase = () => phase;
export const subscribeHandoff = (fn: () => void) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
/** True from the send until the docked composer has taken over (App picks its view transitions by it). */
export const handoffActive = () => phase === 'flying';

/**
 * Critically damped, near the top of the app's range: the card is docked in about 350 ms. The
 * numbers and the stepping are liquid-shape.ts's `GLIDE`: the sent message's liquid draws the
 * card's edge on the same samples while its thread still holds.
 */
const STIFF = GLIDE.stiff;
const DAMP = GLIDE.damp;
const LINE = 32;
/** No session after this long (the bridge is very slow or the send failed silently): give up quietly. As long as a sent bubble holds for its row. */
const GIVE_UP = HOLD_MS;

/**
 * Where the docked composer will be, from the stage's geometry (see session.css `.dock`): as the
 * sent message's launch read it (`known`), or read here.
 */
function predictDock(height: number, known: { stage: { left: number; width: number; bottom: number } | null; column: number } | null): { left: number; top: number; width: number } | null {
  let stage = known?.stage ?? null;
  if (!stage) {
    const sb = document.querySelector('.stage-body');
    if (!sb) return null;
    const z = uiZoom();
    const r = sb.getBoundingClientRect();
    stage = { left: r.left / z, width: r.width / z, bottom: r.bottom / z };
  }
  const col = known?.column ?? (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--column')) || 760);
  const width = Math.min(col, stage.width - 48);
  return { left: stage.left + (stage.width - width) / 2, top: stage.bottom - 18 - height, width };
}

function strip(el: Element) {
  el.removeAttribute('id');
  el.removeAttribute('aria-controls');
  el.removeAttribute('aria-labelledby');
  el.removeAttribute('data-spot');
  el.removeAttribute('data-spot-on');
  if (el.classList.contains('spot-ring')) el.remove();
  for (const c of [...el.children]) strip(c);
}

/**
 * The glide from `from`, held still until `hold` ms after the send (the bead is still joined to the
 * card then), then the spring.
 */
function glideFrom(from: Sample, tx: number, ty: number, tw: number, hold: number): Sample[] {
  const wait = Math.max(0, hold - from.t);
  const path = glide({ ...from, t: from.t + wait }, tx, ty, tw);
  return wait > 0 ? [from, ...path] : path;
}

/** The spring from `from` to (tx, ty, tw), semi-implicit Euler in 4 ms steps, sampled every 16 ms. */
function glide(from: Sample, tx: number, ty: number, tw: number): Sample[] {
  const out = [from];
  let { t, x, y, w, vx, vy, vw } = from;
  const h = GLIDE.step / 1000;
  for (let i = 1; i < 600; i++) {
    t += GLIDE.step;
    vx += (STIFF * (tx - x) - DAMP * vx) * h;
    vy += (STIFF * (ty - y) - DAMP * vy) * h;
    vw += (STIFF * (tw - w) - DAMP * vw) * h;
    x += vx * h;
    y += vy * h;
    w += vw * h;
    const done = Math.abs(tx - x) < 0.4 && Math.abs(ty - y) < 0.4 && Math.abs(tw - w) < 0.4 && Math.abs(vx) + Math.abs(vy) < 8;
    if (done) {
      out.push({ t, x: tx, y: ty, w: tw, vx: 0, vy: 0, vw: 0 });
      break;
    }
    if (i % GLIDE.every === 0) out.push({ t, x, y, w, vx, vy, vw });
  }
  return out;
}

/** Plays a path on the ghost, replacing the one it was on; `then` runs when it has been flown. */
function run(f: Flight, path: Sample[], then: () => void) {
  const t0 = path[0].t;
  const dur = Math.max(1, path[path.length - 1].t - t0);
  const at = (p: Sample) => Math.min(1, (p.t - t0) / dur);
  const moves: Keyframe[] = path.map((p) => ({ offset: at(p), transform: `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0)` }));
  const sizes: Keyframe[] = path.map((p) => ({ offset: at(p), width: `${p.w.toFixed(2)}px` }));
  if (moves.length < 2) {
    moves.push({ ...moves[0] });
    sizes.push({ ...sizes[0] });
  }
  moves[moves.length - 1].offset = 1;
  sizes[sizes.length - 1].offset = 1;
  const opts: KeyframeAnimationOptions = { duration: dur, easing: 'linear', fill: 'forwards' };
  const oldMove = f.move;
  const oldSize = f.size;
  f.path = path;
  const move = (f.move = f.ghost.animate(moves, opts));
  // A width is laid out and painted on the main thread every frame: animated only when it changes
  // (the home card and the dock share the reading column's width, so normally it does not).
  const sized = path.some((p) => Math.abs(p.w - f.start.width) > 0.5);
  f.size = sized ? f.ghost.animate(sizes, opts) : null;
  oldMove?.cancel();
  oldSize?.cancel();
  move.finished.then(() => f.move === move && !f.ending && then(), () => {});
}

/** Where the ghost is right now on its path (read from the animation's own clock). */
function whereNow(f: Flight): Sample {
  const p = f.path;
  const t = p[0].t + (Number(f.move?.currentTime) || 0);
  for (let i = 1; i < p.length; i++) {
    if (p[i].t < t) continue;
    const a = p[i - 1];
    const b = p[i];
    const u = (t - a.t) / Math.max(1, b.t - a.t);
    const mix = (k: keyof Sample) => a[k] + (b[k] - a[k]) * u;
    return { t, x: mix('x'), y: mix('y'), w: mix('w'), vx: mix('vx'), vy: mix('vy'), vw: mix('vw') };
  }
  const e = p[p.length - 1];
  return { ...e, t: Math.max(t, e.t), vx: 0, vy: 0, vw: 0 };
}

/** The docked card's place as an offset from the start. */
function dockTarget(f: Flight): { x: number; y: number; w: number } | null {
  const d = f.dock;
  if (!d?.isConnected) return null;
  const z = uiZoom();
  const r = d.getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left / z - f.start.left, y: r.top / z - f.start.top, w: r.width / z };
}

/** The path has been flown: land on the docked card, or glide on to where it is now. */
function arrived(f: Flight) {
  if (!f.dock) return; // waiting at the predicted place for the session to mount
  const to = dockTarget(f);
  if (!to) return cancelHandoff();
  const end = f.path[f.path.length - 1];
  if (Math.abs(to.x - end.x) < 0.5 && Math.abs(to.y - end.y) < 0.5 && Math.abs(to.w - end.w) < 0.5) return land();
  if (++f.fixes > 4) return land();
  run(f, glideFrom(whereNow(f), to.x, to.y, to.w, f.hold), () => arrived(f));
}

/** Starts the flight from the home composer card. Safe to call when one is already running. */
export function beginHandoff(card: HTMLElement | null) {
  if (!card || flight || phase === 'flying') return;
  if (reducedMotion()) {
    still = true;
    set('flying');
    return;
  }
  // A message leaving this card has just read the page and written to it (composer/flight.ts):
  // its numbers are used, so the page is not laid out a second time in the key's handler.
  const known = launchRead(card);
  let start: { left: number; top: number; width: number; height: number };
  let taH = LINE;
  if (known) {
    start = known.card;
    taH = known.fieldHeight;
  } else {
    const z = uiZoom();
    const b = card.getBoundingClientRect();
    start = { left: b.left / z, top: b.top / z, width: b.width / z, height: b.height / z };
    const ta = card.querySelector<HTMLTextAreaElement>('textarea.cmp-input:not(.cmp-mirror)');
    taH = ta ? ta.offsetHeight : LINE;
  }
  const landH = start.height - Math.max(0, taH - LINE);
  const target = predictDock(landH, known) ?? { left: start.left, top: start.top, width: start.width };

  const ghost = document.createElement('div');
  ghost.className = 'composer handoff-ghost';
  ghost.dataset.variant = 'session';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.cssText = `position:fixed;left:${start.left}px;top:${start.top}px;width:${start.width}px;z-index:30;pointer-events:none;will-change:transform;contain:layout style;`;
  const copy = card.cloneNode(true) as HTMLElement;
  strip(copy);
  copy.removeAttribute('data-rolling');
  ghost.appendChild(copy);
  const field = copy.querySelector<HTMLTextAreaElement>('textarea.cmp-input:not(.cmp-mirror)');
  if (field) {
    field.value = '';
    // Blank on the way down: the message just left, and the docked card brings its own placeholder.
    field.placeholder = '';
    // Closing with the words as they gather (their time and curve, liquid-shape.ts).
    field.style.transition = `height ${COLLAPSE}ms ${linearEasing(collapseEase, 20)}`;
  }
  copy.querySelector('.cmp-roll')?.remove();
  document.body.appendChild(ghost);
  // The send key answers on the way, as it does in a session (composer/launch.ts): the disc gives,
  // the arrow launches up out of it and the stop square grows in its place, so the ghost lands as
  // the docked card of a running turn.
  const key = copy.querySelector<HTMLElement>('.cmp-send');
  const arrow = key?.querySelector('.sk-glyph');
  // The key's part runs on the message's clock, like the glide (below).
  const keyAnims: Animation[] = [];
  if (key && arrow) {
    key.style.overflow = 'hidden';
    key.style.position = 'relative';
    const sq = document.createElement('span');
    sq.className = 'sk-launch-sq';
    key.appendChild(sq);
    keyAnims.push(
      arrow.animate(ARROW_OUT, { duration: ARROW_OUT_MS, delay: RELEASE, easing: ARROW_OUT_EASE, fill: 'forwards' }),
      key.animate(KEY_GIVE, { duration: KEY_GIVE_MS, easing: 'linear' }),
      sq.animate(SQUARE_IN, { duration: SQUARE_IN_MS, delay: SQUARE_IN_AT, easing: SQUARE_IN_EASE, fill: 'both' }),
    );
  }
  // The field settles to one line on the way down (the docked composer's resting height).
  requestAnimationFrame(() => field && (field.style.height = `${LINE}px`));
  // Opacity, not visibility: the field keeps the keyboard, so words typed during the glide are kept
  // (the docked composer takes them over when it claims the flight).
  card.style.opacity = '0';

  // The stage clears at once, on the compositor (the home view's own exit waits for React, which
  // is about to be busy mounting the session): the mark, the headline and the chips are gone
  // before the message has risen past them, so it crosses nothing.
  const clear: Animation[] = [];
  for (const el of card.closest('.home')?.querySelectorAll<HTMLElement>('.home-mark, .home-title, .home-chips-row, .home-center > :last-child:not(.home-composer)') ?? []) {
    clear.push(el.animate([{ opacity: 1, transform: 'translateY(0px)' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: 80, easing: 'linear', fill: 'forwards' }));
  }

  // A message is leaving this card as liquid (composer/flight.ts): the card holds while the drop
  // comes out of its edge and leaves as it flies, the thread between them still holding, so the
  // two push off from each other. The liquid draws the edge where the glide has it, and the glide
  // runs on the message's clock.
  const onClock = barLeaving(card, { dx: target.left - start.left, dy: target.top - start.top });
  const hold = onClock ? BAR_LEAVES : 0;
  const f: Flight = { ghost, source: card, start, dock: null, path: [], move: null, size: null, clear, fixes: 0, hold, timer: 0, ending: false, done: holdSend() };
  flight = f;
  set('flying');
  run(f, glideFrom({ t: 0, x: 0, y: 0, w: start.width, vx: 0, vy: 0, vw: 0 }, target.left - start.left, target.top - start.top, target.width, hold), () => arrived(f));
  if (onClock && f.move) onClock(f.move);
  if (onClock && f.size) onClock(f.size);
  if (onClock) for (const a of keyAnims) onClock(a);
  f.timer = window.setTimeout(() => flight === f && !f.dock && cancelHandoff(), GIVE_UP);
}

/** The docked composer replaces the ghost. */
function land() {
  const f = flight;
  if (!f || f.ending) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  if (f.dock) f.dock.style.opacity = '';
  fadeOut(f, 90);
  flight = null;
  set('idle');
  f.done();
}

function fadeOut(f: Flight, duration: number) {
  const g = f.ghost;
  const fade = g.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration, easing: 'linear', fill: 'forwards' });
  const done = () => g.remove();
  if (fade) fade.finished.then(done, done);
  else done();
}

/**
 * Called by the session composer when it mounts. When a flight is on its way, the card hides until
 * the ghost lands on it and the spring is re-aimed at its real place. Returns true when claimed.
 */
export function claimHandoff(card: HTMLElement | null): boolean {
  if (!card) return false;
  if (still) {
    still = false;
    set('idle');
    return false;
  }
  const f = flight;
  if (!f || f.dock || f.ending) return false;
  f.dock = card;
  card.style.opacity = '0';
  // The prediction is normally exact: the glide goes on untouched. Only a dock that sits
  // somewhere else re-aims it (from where the ghost is, at its speed).
  const to = dockTarget(f);
  const end = f.path[f.path.length - 1];
  const off = to && end && (Math.abs(to.x - end.x) > 0.5 || Math.abs(to.y - end.y) > 0.5 || Math.abs(to.w - end.w) > 0.5);
  if (to && off) run(f, glideFrom(whereNow(f), to.x, to.y, to.w, f.hold), () => arrived(f));
  // Already resting at the predicted place: the swap happens now.
  else if (f.move?.playState === 'finished') land();
  return true;
}

/** The send did not start a session: the ghost fades and the home card comes back. */
export function cancelHandoff() {
  if (still) {
    still = false;
    set('idle');
    return;
  }
  const f = flight;
  if (!f) return;
  f.ending = true;
  window.clearTimeout(f.timer);
  f.move?.pause();
  f.size?.pause();
  f.source.style.opacity = '';
  for (const a of f.clear) a.cancel();
  if (f.dock) f.dock.style.opacity = '';
  fadeOut(f, 140);
  flight = null;
  set('idle');
  f.done();
}
