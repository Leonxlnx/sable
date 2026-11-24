/**
 * The model and effort panel's keys and measures (Phrase.tsx), kept apart from the view so they
 * can be tested.
 *
 * The panel is one column: nearest the phrase the effort scale (one slider, always there), then the
 * speeds (one row of choices), a hairline and the models (every agent's under its name, the chat's
 * own first). Radix's own roving focus is one list; the panel answers these keys itself,
 * before it:
 * - Up and Down move through the models and on into the block that stands next on screen (the
 *   scale, the speeds), stopping at the panel's ends; from the scale or the speeds they go on the
 *   same way;
 * - the scale keeps Left, Right, Home, End and the page keys (ui/stops.ts `stopKey`); in the speeds
 *   Left and Right move along the row and stop at its ends;
 * - Tab goes scale, speeds, models and round (Shift+Tab back), landing on the speed in use and the
 *   model in use;
 * - Home and End: the first and last model, the first and last speed.
 * Digits pick a level on the scale: 1 is the lowest.
 */

import { altGraph, type KeyLike } from './effort-track';

/** Only these keys go through the trigger's composed (phrase + Radix) handler. */
export const triggerKey = (e: KeyLike) => !altGraph(e) && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
  && ['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(e.key);

/** Native text edits in the search field must bypass the menu's typeahead. */
export const filterTextKey = (e: KeyLike) => !e.ctrlKey && !e.altKey && !e.metaKey && [...e.key].length === 1;

export type Col = 'models' | 'scale' | 'speeds';

export interface Where {
  col: Col;
  /** The row's index within its block, top to bottom (the scale is one row). */
  i: number;
}

export interface Shape {
  /** Above the phrase ('top': the models on top, the scale at the bottom, nearest it) or below it. */
  side: 'top' | 'bottom';
  models: number;
  /** 1 when the model in use has a scale (its slider can take focus), else 0. */
  scale: number;
  speeds: number;
  /** The model in use (its row in the list). */
  current: number;
  /** The speed in use (its place in the row). */
  speed?: number;
}

const ORDER: Col[] = ['scale', 'speeds', 'models'];

const count = (c: Col, s: Shape) => (c === 'models' ? s.models : c === 'scale' ? s.scale : s.speeds);

/** The blocks as they stand on screen, top to bottom, the empty ones left out. */
export function blocks(s: Shape): Col[] {
  const order: Col[] = s.side === 'top' ? ['models', 'speeds', 'scale'] : ['scale', 'speeds', 'models'];
  return order.filter((c) => count(c, s) > 0);
}

/** The row a block is entered on by Tab. */
function entry(c: Col, s: Shape): number {
  const n = count(c, s);
  const i = c === 'models' ? s.current : c === 'scale' ? 0 : (s.speed ?? 0);
  return Math.max(0, Math.min(n - 1, i));
}

/** Where a key moves the focus from `at`; null when it does not move (an end, a key not the panel's). */
export function navigate(at: Where, key: string, shift: boolean, s: Shape): Where | null {
  const n = count(at.col, s);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const down = key === 'ArrowDown';
    if (at.col === 'models') {
      const i = at.i + (down ? 1 : -1);
      if (i >= 0 && i < n) return { col: 'models', i };
    }
    // On into the next block on screen: the models from their near end, the speeds on the one in use.
    const order = blocks(s);
    const next = order[order.indexOf(at.col) + (down ? 1 : -1)];
    if (!next) return null;
    if (next === 'models') return { col: 'models', i: down ? 0 : s.models - 1 };
    return { col: next, i: entry(next, s) };
  }
  if (at.col === 'scale') return key === 'Tab' ? tab(at, shift, s) : null;
  if (at.col === 'speeds' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const i = at.i + (key === 'ArrowRight' ? 1 : -1);
    return i >= 0 && i < n ? { col: at.col, i } : null;
  }
  if (key === 'Home' || key === 'End') {
    if (!n) return null;
    const i = key === 'Home' ? 0 : n - 1;
    return i === at.i ? null : { col: at.col, i };
  }
  if (key === 'Tab') return tab(at, shift, s);
  return null;
}

function tab(at: Where, shift: boolean, s: Shape): Where | null {
  const k = ORDER.indexOf(at.col);
  for (let step = 1; step < ORDER.length; step++) {
    const c = ORDER[(k + (shift ? -step : step) + ORDER.length * 2) % ORDER.length];
    if (count(c, s) > 0) return { col: c, i: entry(c, s) };
  }
  return null;
}

/** The keys the scale answers itself (ui/stops.ts `stopKey`); Up and Down stay the panel's. */
export const scaleKey = (key: string) => ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);

/**
 * Escape returns to a keyboard-opened phrase. A pick goes to the composer. An outside
 * interaction with its own focus destination is handled directly by the panel.
 */
export const returnsToTrigger = (openedBy: 'keys' | 'pointer' | 'field', escaped: boolean): boolean => openedBy === 'keys' && escaped;

/** The level a digit picks: 1 the lowest, as many as there are; null for any other key. */
export function digitLevel(key: string, levels: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const i = Number(key) - 1;
  return i < levels ? i : null;
}

/** The rows a list of models takes: the chat's own, each other agent's, and a header per agent once there are several. */
export function listRows(own: number, others: number[]): number {
  const listed = others.filter((n) => n > 0);
  return own + listed.reduce((a, b) => a + b, 0) + (listed.length ? listed.length + 1 : 0);
}

/** The list's height in rows: as many as it has now, at least one; a longer list scrolls past `max` (twelve). */
export function panelRows(listRows: number, max = 12): number {
  return Math.max(1, Math.min(max, listRows));
}

/** A row of the list, the scale's row (its word over the slider) and the panel's padding with a separator. */
export const ROW_PX = 28;
export const SCALE_PX = 50;
export const PAD_PX = 8;
export const SEP_PX = 8;

/**
 * The most the panel can come to while it is open (in px): what decides, once, whether it opens
 * above or below the phrase, so it never turns over. Its list is as long at every model; the scale
 * comes and goes with the model in use, so it counts when any of the agent's models has one.
 */
export function panelReach(p: { list: number; scale: boolean; speeds: boolean }, max = 12): number {
  const far = (p.scale ? SCALE_PX : 0) + (p.speeds ? ROW_PX + (p.scale ? 4 : 0) : 0);
  return PAD_PX + panelRows(p.list, max) * ROW_PX + (far ? far + SEP_PX : 0);
}

/**
 * A model picked while the chat works runs from the next message (the bridge applies it then,
 * `applyDue`, and names it in the session at once): the bar says so while the turn that started on
 * another model still runs. `known` says whether the model the turn started on was seen at all.
 */
export function modelDue(busy: boolean, known: boolean, ranWith: string | undefined, now: string | undefined): boolean {
  return busy && known && !!now && ranWith !== now;
}
