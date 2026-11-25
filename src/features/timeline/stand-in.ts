import { useSyncExternalStore } from 'react';
import type { TimelineItem, QueuedMessage } from '@shared/protocol';

/**
 * A sent message stands in the conversation from the press, in the timeline's own layout, until its
 * real row is there. The bridge may take seconds to add the row (the chat moves to another account
 * and compacts first, the agent's process has to start, a limit decision runs): the arriving copy
 * used to wait where it was aimed when Enter was pressed, fixed in the window, while the
 * conversation scrolled on under it and lines were added after it, so the person's words stood
 * over older text and then jumped to their row (the owner's report, 24 Nov). Now the copy lands on
 * this card at once (`composer/flight.ts`, `landInTimeline`), anything added meanwhile lays out
 * above it, and the real row takes its place in the same commit with no entrance of its own.
 * Refused, it goes and the words go back into the field (Composer, `pending.ts`), as before.
 *
 * Only a message for the conversation that is not a steer (a steer waits inside its turn, a queued
 * one in the tray). The words alone: attachments come with the real row.
 */
export interface StandIn {
  id: string;
  submitId: string;
  /** The chat (null from home until the chat exists). */
  session: string | null;
  text: string;
  /** Time shown on the temporary card. */
  wall: number;
}

/** The bridge took the message but no row came (it is in a view no longer on screen): the card goes after this. */
export const TAKEN_MS = 3000;
/** Nothing at all came: the card goes after this (flight.ts `HOLD_MS` and a little). */
export const LONGEST_MS = 20000;

let list: StandIn[] = [];
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
let n = 0;

export function addStandIn(text: string, session: string | null, submitId: string, wall = Date.now(), represented = false): StandIn | null {
  if (represented || list.some(s => s.submitId === submitId && s.session === session)) return null;
  const s: StandIn = { id: `standin:${++n}`, session, submitId, text, wall };
  list = [...list, s];
  // Rendered once the press's first frame is out (the key's handler only touches the page: the
  // send's own layers must reach the compositor before React renders anything for it).
  requestAnimationFrame(() => window.setTimeout(changed, 0));
  window.setTimeout(() => dropStandIn(s), LONGEST_MS);
  return s;
}

export function scopeStandIn(s: StandIn, session: string) {
  if (!list.includes(s) || s.session === session) return;
  // The object the composer holds stays the one in the list; the list is new, so its readers render.
  s.session = session;
  list = [...list];
  changed();
}

export function dropStandIn(s: StandIn | null | undefined) {
  if (!s || !list.some((x) => x.id === s.id)) return;
  list = list.filter((x) => x.id !== s.id);
  changed();
}

/** The bridge took it: the card waits `TAKEN_MS` more for its row. */
export function standInTaken(s: StandIn | null | undefined) {
  if (s) window.setTimeout(() => dropStandIn(s), TAKEN_MS);
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
const read = () => list;

/** Every stand-in (the timeline filters by its chat). */
export function useStandIns(): readonly StandIn[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** A user row and a queue receipt both retire the card for that exact submission. */
export function standInRows(stand: readonly StandIn[], session: string, _roots: readonly string[], items: Record<string, TimelineItem | undefined>, queue: readonly QueuedMessage[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of stand) {
    if (s.session !== session) continue;
    const user = items[s.submitId];
    if (user?.type === 'user') out.set(s.id, user.id);
    else {
      const row = queue.find(q => q.submitId === s.submitId || q.id === s.submitId);
      if (row) out.set(s.id, row.id);
    }
  }
  return out;
}

export function takesStandIn(session: string, item: TimelineItem | undefined): boolean {
  return item?.type === 'user' && list.some(s => s.session === session && s.submitId === item.id);
}

/** Tests. */
export function resetStandIns() {
  list = [];
  changed();
}
