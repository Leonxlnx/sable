/**
 * The effort scale's rules, kept apart from the view so they can be tested.
 *
 * The scale is a row of stops: one per level the model offers, lowest first, and, where the agent
 * has it, one more past the end, a step apart: ultracode. A position is a stop's index; -1 is
 * "nothing set" (a model whose level the agent decides, or ultracode off where there are no
 * levels). Dragging the chip, the arrow keys on it and a row of its menu all end in `land()`,
 * which says what to send.
 */

export interface Scale {
  /** How many levels the model offers. */
  levels: number;
  /** Ultracode can be switched here: one more stop, past the last level. */
  ultra: boolean;
}

/** What is set: the level's index (-1: none) and whether ultracode is on. */
export interface Setting {
  level: number;
  ultra: boolean;
}

/** The last stop's index (-1: the scale has no stop at all). */
export const lastStop = (s: Scale) => s.levels + (s.ultra ? 1 : 0) - 1;

/** The ultracode stop's index, or -1 where it is not offered. */
export const ultraStop = (s: Scale) => (s.ultra ? s.levels : -1);

/** Where a setting stands on the scale: past the end while ultracode is on, else on its level. */
export const positionOf = (v: Setting, s: Scale) => (s.ultra && v.ultra ? s.levels : Math.min(v.level, s.levels - 1));

/** The lowest position: the first level, or "off" on a scale that is ultracode alone. */
const floor = (s: Scale) => (s.levels > 0 ? 0 : -1);

export const clampStop = (pos: number, s: Scale) => Math.max(floor(s), Math.min(lastStop(s), pos));

/** How far the pointer travels per stop while the chip is dragged, and how far before a press is a drag. */
export const SCRUB_PX = 12;
export const SCRUB_SLOP = 4;

/** The stop a drag stands on: every `SCRUB_PX` to the right is one stop up, from where it began. */
export function scrubStop(from: number, dx: number, s: Scale, px = SCRUB_PX): number {
  if (lastStop(s) < 0) return from;
  // Toward zero, so the first stop needs a whole step in either direction.
  const steps = dx >= 0 ? Math.floor(dx / px) : -Math.floor(-dx / px);
  return clampStop(from + steps, s);
}

/** The stop a key on the chip moves to; null when the key is not the scale's or there is nowhere to go. */
export function keyStop(pos: number, key: string, s: Scale): number | null {
  let next: number;
  if (key === 'ArrowRight') next = pos + 1;
  else if (key === 'ArrowLeft') next = pos - 1;
  else if (key === 'Home') next = floor(s);
  else if (key === 'End') next = lastStop(s);
  else return null;
  next = clampStop(next, s);
  return next === pos ? null : next;
}

export const SCALE_KEYS = /^(Arrow(Left|Right)|Home|End)$/;

export interface Landing {
  /** The level to send (its index), when it changes. */
  level?: number;
  /** Ultracode to switch, when it changes. */
  ultra?: boolean;
}

/**
 * What landing on `pos` changes.
 * - The stop past the end turns ultracode on and leaves the level as it is: it is kept under it.
 * - A level turns ultracode off and sets that level. One exception: a single step down from
 *   ultracode by key only leaves it, back to the level that was kept, or to none where the agent
 *   decides the level (the person switched ultracode off; they did not ask for the top level).
 * - -1 on a scale that is ultracode alone turns it off.
 */
export function land(now: Setting, pos: number, s: Scale, via: 'key' | 'drag' | 'pick'): Landing {
  const out: Landing = {};
  const to = clampStop(pos, s);
  if (s.ultra && to === s.levels) {
    if (!now.ultra) out.ultra = true;
    return out;
  }
  if (now.ultra) out.ultra = false;
  if (to < 0) return out;
  const stepDown = via === 'key' && now.ultra && to === s.levels - 1;
  if (!stepDown && to !== now.level) out.level = to;
  return out;
}

/** How many of the level pips are lit at a position: all of them past the end. */
export const litLevels = (pos: number, s: Scale) => (pos >= s.levels ? s.levels : Math.max(0, pos + 1));
