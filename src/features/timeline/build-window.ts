/**
 * Which turns a conversation builds when it opens: the newest ones, by their estimated height
 * rather than by count. A chat of a few turns with one very long answer far up opened with every
 * turn built (the window counted groups), and building and laying out a 4,000-line answer nobody
 * could see cost more than the veil's whole schedule on every switch to it.
 */

/** Groups built at most and at least when a conversation opens. */
export const TAIL = 8;
export const MIN_TAIL = 2;
/** How many views of estimated height the newest groups should fill when it opens. */
export const VIEWS = 3;

/**
 * Where the reader left each conversation they had scrolled away from the end of, as the distance
 * from the end (the end is always built, older turns wait behind a spacer of estimated height), so
 * switching back lands where they were reading. For the window's life only. The open builds far
 * enough up to cover that place.
 */
export const keptAt = new Map<string, number>();

/**
 * The height each settled turn had when its view last went (`session|turn`), its stand-in the next
 * time the conversation opens, until it is laid out again. For the window's life; the oldest go
 * first past `SIZES_MAX`.
 */
export const turnSizes = new Map<string, number>();
const SIZES_MAX = 20_000;
export function rememberTurnSize(key: string, h: number) {
  if (!(h > 0)) return;
  turnSizes.delete(key);
  turnSizes.set(key, h);
  if (turnSizes.size > SIZES_MAX) turnSizes.delete(turnSizes.keys().next().value as string);
}

/**
 * The first group to build, given each group's estimated height (oldest first): from the end,
 * until the groups built fill `want` px, at least `MIN_TAIL` groups and at most `TAIL`, and always
 * far enough to cover `reach` px from the end (a kept reading place) as long as `TAIL` allows.
 */
export function tailStart(heights: readonly number[], want: number, reach = 0): number {
  const need = Math.max(want, reach);
  let i = heights.length;
  let h = 0;
  while (i > 0) {
    const n = heights.length - i;
    if (n >= TAIL || (n >= MIN_TAIL && h >= need)) break;
    i--;
    h += heights[i];
  }
  return i;
}
