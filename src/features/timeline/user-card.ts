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
 * back where the agent took it (`SessionRuntime.taken`: `item.removed`, then `item.added` with the
 * same id). In the window that is a row unmounting and one mounting. It is the same message
 * moving, not a new one arriving: the row that mounts asks here where the one that just left
 * stood, glides from there and plays no entrance a second time (User.tsx).
 */
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
