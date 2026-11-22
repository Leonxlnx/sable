/**
 * How the side panel's tab row is laid out for its width. Pure: `Rail.tsx` measures (the row, the
 * names, a figure's digits) and draws what this says, so the rule is tested without a page.
 *
 * Every tab is an icon. The selected one may carry its name, a tab with something to count carries
 * the figure. The row has two forms, every tab or the first five and More, and as it narrows it
 * sheds in one order, so nothing is ever cut or squeezed and nothing that went comes back:
 *   1. tabs past the fifth, into More (only a wide panel holds all eight beside a name);
 *   2. the selected tab's name: it shows only while the longest name would fit, so it never comes
 *      and goes from one tab to the next;
 *   3. the fifth tab, then the fourth;
 *   4. the figures;
 *   5. tabs, down to one.
 * The selected tab always has a seat: one that is in More takes the row's last seat while it is
 * selected (the tab that sat there waits in More), so More is always the three dots and always
 * says what it holds. Which tab is selected changes nothing else: the row is fitted for the tabs
 * that own its seats, and a guest shows its figure only where it fits the seat it was lent
 * (`guestFigure`). The room a figure takes is what it usually shows or what it shows now, whichever
 * is wider, so a count that loads or grows a digit does not move a tab into More.
 */

/** A tab without a name or a figure, and the space between two. */
export const TAB_W = 28;
export const TAB_GAP = 2;
/** The row's short form: this many tabs and More. */
export const SEATS = 5;
/** Tabs the figures outlast: below this many, the figures go first. */
export const KEEP = 3;

export interface RowInput {
  /** The row's own width. */
  width: number;
  /** Per tab, in order: the room its figure takes, 0 for a tab that never counts. */
  counts: readonly number[];
  /** The width of the longest name's box. */
  longest: number;
}

export interface RowFit {
  /** How many tabs stand in the row; the others are in More. */
  shown: number;
  /** The selected tab carries its name. */
  names: boolean;
  /** Tabs carry their figures. */
  counts: boolean;
}

/** What `n` seats (and More, when some tabs are left over) take, with or without their figures. */
export function rowWidth(n: number, input: Pick<RowInput, 'counts'>, counts: boolean): number {
  const total = input.counts.length;
  const seats = Math.max(0, Math.min(n, total));
  let w = 0;
  for (let i = 0; i < seats; i++) w += TAB_W + (counts ? (input.counts[i] ?? 0) : 0);
  w += Math.max(0, seats - 1) * TAB_GAP;
  if (seats < total) w += (seats ? TAB_GAP : 0) + TAB_W;
  return w;
}

export function fitRow(input: RowInput): RowFit {
  const total = input.counts.length;
  const { width, longest } = input;
  const seats = Math.min(SEATS, total);
  if (rowWidth(total, input, true) + longest <= width) return { shown: total, names: true, counts: true };
  if (rowWidth(seats, input, true) + longest <= width) return { shown: seats, names: true, counts: true };
  const keep = Math.min(KEEP, seats);
  for (let n = seats; n >= keep; n--) if (rowWidth(n, input, true) <= width) return { shown: n, names: false, counts: true };
  for (let n = keep; n > 1; n--) if (rowWidth(n, input, false) <= width) return { shown: n, names: false, counts: false };
  return { shown: Math.min(1, total), names: false, counts: false };
}

export const sameFit = (a: RowFit, b: RowFit): boolean => a.shown === b.shown && a.names === b.names && a.counts === b.counts;

/**
 * Which tabs sit in a row of `shown` seats, by their place in the list: the first ones, the last
 * seat lent to the selected tab when it is not among them.
 */
export function rowSeats(total: number, shown: number, selected: number): number[] {
  const n = Math.max(0, Math.min(shown, total));
  const seats = Array.from({ length: n }, (_, i) => i);
  if (n > 0 && selected >= n && selected < total) seats[n - 1] = selected;
  return seats;
}

/**
 * Whether the tab in the last seat may show its figure: always when the seat is its own; a guest
 * only when its figure (`need`, per tab) fits the room the row keeps for that seat (`counts`).
 */
export function guestFigure(counts: readonly number[], need: readonly number[], shown: number, selected: number): boolean {
  const seats = rowSeats(counts.length, shown, selected);
  const last = seats.length - 1;
  if (last < 0 || seats[last] === last) return true;
  return (need[seats[last]] ?? 0) <= (counts[last] ?? 0);
}

/** A count as its tab shows it. */
export const figure = (count: number | undefined): string => (!count ? '' : count > 999 ? '999+' : String(count));
