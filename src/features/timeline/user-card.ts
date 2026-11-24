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
 * Whether this change of a chat's roots is the bridge's move of `id`: something stood after it, and
 * it now stands behind all of that. Read by order, not by its place at the end: the window applies
 * a frame's events in one write (store.ts `flushEvents`), so the reply's first item is usually
 * behind the moved message already.
 */
export function willMove(id: string, before: readonly string[] | undefined, after: readonly string[] | undefined): boolean {
  if (!before || !after || before === after) return false;
  const was = before.indexOf(id);
  if (was < 0 || was === before.length - 1) return false;
  const now = after.indexOf(id);
  if (now < 0) return false;
  const behind = new Set(before.slice(was + 1));
  for (let i = now + 1; i < after.length; i++) if (behind.has(after[i])) return false;
  for (let i = 0; i < now; i++) if (behind.has(after[i])) return true;
  return false;
}

/**
 * How far the row glides (screen pixels; the start's offset from where it now lies). `was` is where
 * its card stood on screen before the move, `now` where it lies after the new layout, read in a layout
 * effect, before the conversation keeps its end (Timeline.tsx's ResizeObserver runs after the layout
 * effects and before paint). `endShift`: how far that keeping of the end will scroll the view in this
 * frame, in screen pixels (0 when the reader is scrolled away or nothing grew).
 *
 * The glide starts where the eye last saw the card. Measured against the layout alone, the start
 * left out the scroll that the same frame makes: when the take also added content (the reply's first
 * words, a note), the card jumped up with the view and then glided down to its place, so it went too
 * far up and came back (day 7 film: 600 to 498 px in one frame, then down to 525).
 */
export function glideOffset(was: number, now: number, endShift: number): number {
  return was - (now - endShift);
}

/** How far keeping the end will scroll a view that sticks to it (in its own pixels). */
export function endShift(stuck: boolean, scrollHeight: number, clientHeight: number, scrollTop: number): number {
  return stuck ? Math.max(0, scrollHeight - clientHeight - scrollTop) : 0;
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
