/**
 * The model and effort panel's keys (Phrase.tsx), kept apart from the view so they can be tested.
 *
 * The panel is three columns of rows: the models (with the other agents' rows at its foot), the
 * scale of levels (the highest on top), and the switches (ultracode, the speeds) across the whole
 * width. Radix's own roving focus is one list; the panel answers these keys itself, before it:
 * - Up and Down move within a column and stop at its ends;
 * - Right goes from a model to the scale (the level it shows), Left from the scale back to the
 *   model it belongs to;
 * - Tab goes models, scale, switches and round (Shift+Tab back), landing on the same rows;
 * - Home and End: the first and last model; in the scale the lowest and the highest level.
 * Digits pick a level in the scale: 1 is the lowest.
 */

export type Col = 'models' | 'scale' | 'toggles';

export interface Where {
  col: Col;
  /** The row's index within its column, top to bottom. */
  i: number;
}

export interface Shape {
  models: number;
  scale: number;
  toggles: number;
  /** The model whose levels the scale shows (its row in the models' column). */
  owner: number;
  /** The level the scale shows (its row, top to bottom). */
  level: number;
}

const ORDER: Col[] = ['models', 'scale', 'toggles'];

const count = (c: Col, s: Shape) => (c === 'models' ? s.models : c === 'scale' ? s.scale : s.toggles);

/** The row a column is entered on. */
function entry(c: Col, s: Shape): number {
  const n = count(c, s);
  const i = c === 'models' ? s.owner : c === 'scale' ? s.level : 0;
  return Math.max(0, Math.min(n - 1, i));
}

/** Where a key moves the focus from `at`; null when it does not move (an end, a key not the panel's). */
export function navigate(at: Where, key: string, shift: boolean, s: Shape): Where | null {
  const n = count(at.col, s);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const i = at.i + (key === 'ArrowDown' ? 1 : -1);
    return i >= 0 && i < n ? { col: at.col, i } : null;
  }
  if (key === 'ArrowRight') return at.col === 'models' && s.scale > 0 ? { col: 'scale', i: entry('scale', s) } : null;
  if (key === 'ArrowLeft') return at.col === 'scale' && s.models > 0 ? { col: 'models', i: entry('models', s) } : null;
  if (key === 'Home' || key === 'End') {
    if (!n) return null;
    // The scale reads upward: Home is its lowest level (the last row), End its highest.
    const first = at.col === 'scale' ? n - 1 : 0;
    const i = key === 'Home' ? first : n - 1 - first;
    return i === at.i ? null : { col: at.col, i };
  }
  if (key === 'Tab') {
    const k = ORDER.indexOf(at.col);
    for (let step = 1; step < ORDER.length; step++) {
      const c = ORDER[(k + (shift ? -step : step) + ORDER.length * 2) % ORDER.length];
      if (count(c, s) > 0) return { col: c, i: entry(c, s) };
    }
    return null;
  }
  return null;
}

/**
 * Where the keyboard goes when the panel closes. Opened by the keys on the phrase and left with
 * Escape, it stays where it was: on the phrase. Any other way (a pick, a click outside, opened by
 * a click, by Ctrl+. or a command from the field) it goes on to the field.
 */
export const returnsToTrigger = (openedBy: 'keys' | 'pointer' | 'field', escaped: boolean): boolean => openedBy === 'keys' && escaped;

/** The level a digit picks: 1 the lowest, as many as there are; null for any other key. */
export function digitLevel(key: string, levels: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const i = Number(key) - 1;
  return i < levels ? i : null;
}

/**
 * How many rows the panel's columns have, fixed when it opens so that turning to another agent
 * or resting on another model never moves a row: the longest column of any agent it lists (that
 * agent's models and a row for each other agent) or the longest scale, between a floor and the
 * most that stands before the models' column scrolls.
 */
export function panelRows(agents: { models: number }[], levels: number[], max = 9, min = 3): number {
  const others = Math.max(0, agents.length - 1);
  const col = Math.max(0, ...agents.map((a) => a.models + others));
  return Math.max(min, Math.min(max, Math.max(col, ...levels)));
}
