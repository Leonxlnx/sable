/**
 * Whether the conversation goes to its newest line for a message: only one this phone itself sent
 * or steered just now. A queued message the desktop starts when a turn ends, or a message another
 * client sent, leaves a reader scrolled up where they are (review wave 10, #12).
 *
 * The composer marks a send before it goes (its message can land before the answer comes back);
 * a send the desktop queued or refused takes its mark back; the conversation takes the mark when the
 * new message shows. A mark is good for a short while only.
 */
import { onForget } from './forget';

/** How long a send keeps its mark (a slow desktop answers within this). */
export const SENT_HERE_MS = 20_000;
const marks = new Map<string, number>();

/** This phone is sending (or steering) a message into `sid` now. */
export function sentHere(sid: string, now = Date.now()) {
  marks.set(sid, now);
}

/** The send did not become a message now (queued, refused, failed): its mark goes. */
export function notSentHere(sid: string) {
  marks.delete(sid);
}

/** A new message showed in `sid`: whether this phone sent it just now (the mark is used up either way). */
export function takeSentHere(sid: string, now = Date.now()): boolean {
  const at = marks.get(sid);
  if (at === undefined) return false;
  marks.delete(sid);
  return now - at <= SENT_HERE_MS;
}

onForget(() => marks.clear());
