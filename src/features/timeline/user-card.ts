/**
 * The person's message card, as numbers shared by the card (timeline.css `.user-card`) and the
 * bubble that flies to it from the composer (composer/flight.ts): both must agree to the pixel.
 */

/** The card's type: the answer's size and leading (components/markdown.css `.md`). */
export const CARD_FONT = 14;
export const CARD_LINE = CARD_FONT * 1.62;
/** The card's padding: the words stand this far in from its left and top edges. */
export const CARD_PAD_X = 16;
export const CARD_PAD_TOP = 10;

/** Past this many characters or lines a message is clipped, to ten whole lines (`.user-text[data-clipped]`). */
const LONG_CHARS = 1400;
const LONG_LINES = 18;

export const isLongMessage = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;

/**
 * A steered message moves once: when the agent takes it, the bridge takes its row out and puts it
 * back where the agent took it (`SessionRuntime.taken`: `item.removed` marked `moving`, then
 * `item.added` marked `moved`, with the same id). The window makes that one update (store.ts): the
 * message goes to the end of the roots and its row stays the same element, which reads where its
 * card stood as the store changes (`willMove`) and glides from there (User.tsx).
 *
 * A reader of the two events without the marks sees a row unmounting and one mounting (and so does
 * the window when the layout around the row changes at the same moment). That is the same message
 * moving too, not a new one arriving: the row that mounts asks here where the one that just left
 * stood (`rowLeft`, `rowMoved`), glides from there and plays no entrance a second time.
 */

/** How long the row takes from where it stood to where the agent took it. */
export const MOVE_GLIDE_MS = 320;

/**
 * Whether this change of a chat's roots is the bridge's move of `id`: it stood somewhere in the
 * list and now stands at its end, with the same messages round it (nothing added or removed).
 */
export function willMove(id: string, before: readonly string[] | undefined, after: readonly string[] | undefined): boolean {
  if (!before || !after || before === after || before.length !== after.length) return false;
  return after[after.length - 1] === id && before[before.length - 1] !== id && before.includes(id);
}

export interface LeftRow {
  /** Where its card stood, in the window's pixels. */
  left: number;
  top: number;
  /** It still waited for the agent when it left. */
  queued: boolean;
  at: number;
}

/** How long after a row left a row with the same id is still that message moving. */
export const MOVE_MS = 600;

const gone = new Map<string, LeftRow>();

/** A message's row left the conversation: remembered for a moment (only a few are ever kept). */
export function rowLeft(id: string, row: Omit<LeftRow, 'at'>, now: number) {
  for (const [k, v] of gone) if (now - v.at > MOVE_MS) gone.delete(k);
  gone.set(id, { ...row, at: now });
}

/** A message's row mounts: where the row it replaces stood, when one with its id left a moment ago (taken once). */
export function rowMoved(id: string, now: number): LeftRow | null {
  const was = gone.get(id);
  if (!was) return null;
  gone.delete(id);
  return now - was.at <= MOVE_MS ? was : null;
}
