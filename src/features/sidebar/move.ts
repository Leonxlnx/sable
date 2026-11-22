import { play, reducedMotion, spring, uiZoom } from '@/lib/motion';

/**
 * A folder that changes its parent (into a project, out of one) is another element after the
 * change: React takes the old section out and builds a new one inside the other list. It used to
 * vanish in one frame and fade in a step away. Now the click (or the drop) says which folder is
 * about to move (`moveCue`, where it is drawn then), and the new section, as it mounts, slides from
 * that place to its own on the list's spring and plays no entrance (`arrive`). One that would have
 * to cross more than a few rows, or comes from out of view, arrives in place instead: a slide
 * across the list would drag its words over everything between.
 */

/** The list's spring (Flip's, the gap's and the fold's). */
const MOVE = spring(440, 40);
/** How long a cue waits for its section, and how far a section slides at most (px). */
const FRESH = 700;
const NEAR = 280;

interface Cue {
  left: number;
  top: number;
  at: number;
}

const cues = new Map<string, Cue>();

/** Said right before the store is told: the folder `key` is about to stand in another list. */
export function moveCue(key: string) {
  const el = document.querySelector<HTMLElement>(`section.sgroup[data-folder="${CSS.escape(key)}"]`);
  if (!el || reducedMotion()) return;
  const r = el.getBoundingClientRect();
  cues.set(key, { left: r.left, top: r.top, at: performance.now() });
}

/** Whether the section `key` that mounts now is one that was said to move (read while rendering). */
export function cued(key: string): boolean {
  const c = cues.get(key);
  if (c && performance.now() - c.at > FRESH) cues.delete(key);
  return cues.has(key);
}

/** How a section that moved gets to its place, `dx`/`dy` px from where it stood, in a list `height` tall. */
export function arrival(dx: number, dy: number, wasInView: boolean): 'slide' | 'place' {
  return wasInView && Math.hypot(dx, dy) <= NEAR ? 'slide' : 'place';
}

/** The section has mounted in its new list: it comes from where the folder stood. */
export function arrive(el: HTMLElement | null, key: string) {
  const c = cues.get(key);
  cues.delete(key);
  if (!el || !c) return;
  const now = el.getBoundingClientRect();
  const view = el.closest('.side-list')?.getBoundingClientRect();
  const z = uiZoom();
  const dx = (c.left - now.left) / z;
  const dy = (c.top - now.top) / z;
  const how = arrival(dx, dy, !!view && c.top < view.bottom && c.top > view.top - 60);
  if (how === 'slide') {
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) play(el, [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: MOVE.duration, easing: MOVE.easing });
    return;
  }
  // Too far to slide: the entrance every late section has (`.sgroup[data-enter]`), started here.
  play(el, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
}
