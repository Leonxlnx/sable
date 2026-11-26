import { play, reducedMotion } from '@/lib/motion';
import { DOCK_GLIDE_EASE, DOCK_GLIDE_MS } from '@/features/session/dock-glide';
import { bezier } from './signal-shape';

/**
 * The dock's one clock. The composer's stack (the prompt cards, the strips, the queue tray) stands
 * on the pane's top edge and grows upward: when the tray gets a row, loses one, comes or goes, the
 * layout takes its final shape in that frame and everything that moved is drawn where it stood and
 * glides to its place on this timing (a longer time for a longer way, `glideMs`, the same for all
 * that move together), by translate only (on the compositor). The conversation's end
 * follows on the same timing (Timeline.tsx, the dock's taller and shorter branches), so the tray,
 * the strips and the last line of the conversation travel as one.
 */
export const STACK_MS = DOCK_GLIDE_MS;
export const STACK_EASE = DOCK_GLIDE_EASE;
/** The same curve, worked out (for a glide that carries on from where it stands). */
const curve = bezier(0.32, 0.72, 0, 1);

/** Up to this travel (px) the dock keeps its own `STACK_MS`: a queue row, a strip, a short card. */
export const GLIDE_NEAR = 72;
/** The longest the dock's clock gets, whatever the way (ms). */
export const GLIDE_MAX_MS = 700;

/**
 * The dock's clock for a glide of `travel` px: one rule for everything that glides, and whatever moves
 * as one is given the same time: the queue tray, its rows and the strips above by the dock's change of
 * height, the conversation's end by its own way (which is that change wherever the conversation fills
 * the view; a short one comes less and keeps its short clock). Up to `GLIDE_NEAR` it is the dock's own
 * 260 ms; further, the time grows with the square root of the way, so the fastest frame grows only
 * with its root. The curve's steepest stretch (16 % in) runs at 4.2 times its mean speed: a 473 px
 * card leaving took 112 px in one frame in 260 ms (68 px: 16 px), and takes about 50 in 665 ms.
 * Never past `GLIDE_MAX_MS`.
 */
export function glideMs(travel: number): number {
  const a = Math.abs(travel);
  if (!(a > GLIDE_NEAR)) return STACK_MS;
  return Math.min(GLIDE_MAX_MS, Math.round(STACK_MS * Math.sqrt(a / GLIDE_NEAR)));
}

/** How far a glide that started `from` px away still has to go `elapsed` ms after it started. */
export function glideLeft(from: number, elapsed: number, ms = STACK_MS): number {
  if (elapsed <= 0) return from;
  if (elapsed >= ms) return 0;
  return from * (1 - curve(elapsed / ms));
}

/**
 * How long (ms) a row gliding down `travel` px on the dock's clock keeps `ink` px of clear space
 * above the place it comes to: after that its words begin to cover the words that stood there. A
 * removed row's words (its dead copy, QueueTray `glideTray`) must be gone by then, or the two lines
 * read over each other (rows have no fill of their own): with 80 ms they did for two or three frames.
 */
export function clearFor(travel: number, ink: number, ms = STACK_MS): number {
  const reach = travel - ink;
  if (reach <= 0) return 0;
  if (reach >= travel) return ms;
  let lo = 0;
  let hi = ms;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (travel - glideLeft(travel, mid, ms) < reach) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** How deep the tray is tucked behind the pane's top edge (composer.css `.cq-clip`, `.cq`). */
export const TUCK = 20;

/** What the tray adds to the dock's height: nothing when it is not there, else all but its tuck. */
export const trayShare = (clipHeight: number) => (clipHeight > 0.5 ? clipHeight - TUCK : 0);

export interface RowMove {
  /** The tray's own glide: where its top was drawn, relative to where it is now. */
  tray: number;
  /** Each row that stays: its own glide, inside the tray's (so the sum is where it stood). */
  rows: Map<string, number>;
}

/**
 * The glides for a change of the tray's rows (pure). `before` and `after` are each row's distance
 * from the tray's bottom edge (which stands on the pane and never moves), `trayBefore` and
 * `trayAfter` the tray's height (0: not there). The tray is drawn where its top stood (a new tray
 * from behind the pane: its whole height lower) and every row that was there before keeps its
 * place on screen in the first frame: its glide is its own move less the tray's. A row that is new
 * rises with the tray.
 */
export function rowMoves(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>, trayBefore: number, trayAfter: number): RowMove {
  const tray = trayBefore > 0.5 ? trayAfter - trayBefore : trayAfter;
  const rows = new Map<string, number>();
  for (const [id, d] of after) {
    const was = before.get(id);
    if (was === undefined) continue;
    // Higher above the bottom edge is higher on screen: the row moved up by (d - was).
    const own = d - was - tray;
    if (Math.abs(own) > 0.5) rows.set(id, own);
  }
  return { tray, rows };
}

/**
 * Whether frames come on time again (pure; fed the time of every animation frame). A glide on the
 * compositor keeps the wall clock: frames the window cannot present are motion nobody sees, and the
 * dock's curve does most of its way in its first 80 ms. Right after a prompt card is answered the
 * window is busy for about that long (the card's copy is drawn, then the bridge's answer brings the
 * working line, the step and the task strip, each a burst of new tiles for the GPU): measured in the
 * packaged app, two frames came, then none for 75 ms, and the conversation stood 58 px from its end in
 * one frame and 5 px from it in the next. So a glide that follows a card waits, drawn where it stood,
 * until `need` frames in a row came no more than `late` ms after the one before, and never longer
 * than `max` ms.
 */
export function frameGate(need = 2, late = 24, max = 240): (now: number) => boolean {
  let first = -1;
  let last = -1;
  let ok = 0;
  return (now) => {
    if (first < 0) {
      first = last = now;
      return false;
    }
    const gap = now - last;
    last = now;
    ok = gap <= late ? ok + 1 : 0;
    return ok >= need || now - first >= max;
  };
}

/** Calls `go` once frames flow again (`frameGate`), or after `cap` ms whatever happens (a hidden window draws no frame). */
export function whenFlowing(go: () => void, cap = 400): void {
  const flows = frameGate();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    go();
  };
  const timer = window.setTimeout(run, cap);
  const tick = (now: number) => {
    if (done) return;
    if (flows(now)) run();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

interface Run {
  from: number;
  t0: number;
  /** Its clock (`glideMs`). */
  ms: number;
  anim: Animation;
  /** Drawn where it stood and not started yet (it waits for the page, `whenFlowing`). */
  held: boolean;
  /** What is held and let go with it (the live line's hold while the conversation comes down). */
  beside: Animation[];
}

const runs = new WeakMap<Element, Run>();

const alive = (r: Run | undefined): r is Run => !!r && (r.anim.playState === 'running' || r.anim.playState === 'paused');

/**
 * Where a run is drawn at `now`, from its own start: the animation's start time once it has one. A
 * started animation is pending until the frame that first draws it and holds its first keyframe till
 * then: on a busy page that frame came 130 ms after the glide was made, and a reading from the moment
 * it was made said 74 px of it were gone while it was still drawn whole (Timeline.tsx keeps the
 * layout's end by it: the view went 74 px too far and was clamped back frame by frame).
 */
function leftOf(r: Run, now: number): number {
  if (r.held) return r.from;
  const start = r.anim.startTime;
  // Pending: still where it stood. (A stand-in without a timeline of its own, in tests: from when it was made.)
  if (start === null) return r.from;
  return glideLeft(r.from, now - (typeof start === 'number' ? start : r.t0), r.ms);
}

/** How far from its place a glide on `el` is drawn right now (0: none, or it is over). Worked out from its own start. */
export function drawnY(el: Element | null | undefined, now = performance.now()): number {
  const r = el ? runs.get(el) : undefined;
  if (!alive(r)) return 0;
  return leftOf(r, now);
}

export interface GlideOpts {
  /**
   * Its clock (ms). What glides together is given the same, from the dock's change of height
   * (`glideMs(change)`); left out, the glide's own way decides (`glideMs(from)`).
   */
  ms?: number;
  /** Wait, drawn where it stood, until frames flow again (`whenFlowing`): for a glide that follows a prompt card leaving. */
  hold?: boolean;
  /** Animations that share the glide's start: held with it, let go with it, cancelled with it. */
  beside?: () => (Animation | null)[];
}

/**
 * Draws `el` `d` px lower than its place (negative: higher) and glides it home on the dock's
 * clock (`opts.ms`). A glide still under way on it (or one that still waits) carries on from where
 * it stands, worked out from its own start and its own clock (never read from a computed style).
 */
export function glideY(el: Element | null | undefined, d: number, now = performance.now(), opts: GlideOpts = {}): Animation | null {
  if (!el || reducedMotion()) return null;
  const prev = runs.get(el);
  let from = d;
  if (alive(prev)) {
    from += leftOf(prev, now);
    prev.anim.cancel();
    for (const a of prev.beside) a.cancel();
  }
  runs.delete(el);
  if (Math.abs(from) < 0.5) return null;
  const ms = opts.ms ?? glideMs(from);
  const anim = play(el, [{ translate: `0 ${from.toFixed(2)}px` }, { translate: '0 0' }], { duration: ms, easing: STACK_EASE });
  if (!anim) return null;
  const run: Run = { from, t0: now, ms, anim, held: !!opts.hold, beside: (opts.beside?.() ?? []).filter((a): a is Animation => !!a) };
  runs.set(el, run);
  if (run.held) {
    // Paused at its first frame: the thing is drawn where it stood, on its own layer already.
    const all = [anim, ...run.beside];
    for (const a of all) a.pause();
    whenFlowing(() => {
      if (runs.get(el) !== run || !run.held) return;
      run.held = false;
      run.t0 = performance.now();
      for (const a of all) if (a.playState === 'paused') a.play();
    });
  }
  return anim;
}

/**
 * What stands above the tray in the dock and moves with it: the composer's strips before the tray,
 * and the prompt cards before the composer. Laid-out boxes only (a menu that floats is anchored to
 * the pane, which does not move).
 */
export function aboveTray(clip: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const take = (from: Element | null) => {
    for (let n = from?.previousElementSibling ?? null; n; n = n.previousElementSibling) {
      if (!(n instanceof HTMLElement) || n.classList.contains('ghost')) continue;
      const pos = getComputedStyle(n).position;
      if (pos === 'absolute' || pos === 'fixed') continue;
      out.push(n);
    }
  };
  take(clip);
  take(clip.parentElement);
  return out;
}
