import { play, reducedMotion } from '@/lib/motion';
import { DOCK_GLIDE_EASE, DOCK_GLIDE_MS } from '@/features/session/dock-glide';
import { bezier } from './signal-shape';

/**
 * The dock's one clock. The composer's stack (the prompt cards, the strips, the queue tray) stands
 * on the pane's top edge and grows upward: when the tray gets a row, loses one, comes or goes, the
 * layout takes its final shape in that frame and everything that moved is drawn where it stood and
 * glides to its place on this timing, by translate only (on the compositor). The conversation's end
 * follows on the same timing (Timeline.tsx, the dock's taller and shorter branches), so the tray,
 * the strips and the last line of the conversation travel as one.
 */
export const STACK_MS = DOCK_GLIDE_MS;
export const STACK_EASE = DOCK_GLIDE_EASE;
/** The same curve, worked out (for a glide that carries on from where it stands). */
const curve = bezier(0.32, 0.72, 0, 1);

/** How far a glide that started `from` px away still has to go `elapsed` ms after it started. */
export function glideLeft(from: number, elapsed: number, ms = STACK_MS): number {
  if (elapsed <= 0) return from;
  if (elapsed >= ms) return 0;
  return from * (1 - curve(elapsed / ms));
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

const runs = new WeakMap<Element, { from: number; t0: number; anim: Animation }>();

/**
 * Draws `el` `d` px lower than its place (negative: higher) and glides it home on the dock's
 * clock. A glide still under way on it carries on from where it stands, worked out from its own
 * start (never read from a computed style).
 */
export function glideY(el: Element | null | undefined, d: number, now = performance.now()): Animation | null {
  if (!el || reducedMotion()) return null;
  const prev = runs.get(el);
  let from = d;
  if (prev && prev.anim.playState === 'running') {
    from += glideLeft(prev.from, now - prev.t0);
    prev.anim.cancel();
  }
  runs.delete(el);
  if (Math.abs(from) < 0.5) return null;
  const anim = play(el, [{ translate: `0 ${from.toFixed(2)}px` }, { translate: '0 0' }], { duration: STACK_MS, easing: STACK_EASE });
  if (anim) runs.set(el, { from, t0: now, anim });
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
