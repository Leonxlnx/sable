import { useSyncExternalStore } from 'react';
import type { TimelineItem } from '@shared/protocol';

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
  /** The chat (null from home until the chat exists). */
  session: string | null;
  text: string;
  /** When it was sent, on the bridge's clock: its row's message is no older than this (less a little skew). */
  wall: number;
}

/** How much older than the send a row's message may be and still be this one (flight.ts `FRESH_SLACK_MS`). */
export const STAND_SLACK_MS = 2000;
/** The bridge took the message but no row came (it is in a view no longer on screen): the card goes after this. */
export const TAKEN_MS = 3000;
/** Nothing at all came: the card goes after this (flight.ts `HOLD_MS` and a little). */
export const LONGEST_MS = 20000;

let list: StandIn[] = [];
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
let n = 0;

export function addStandIn(text: string, session: string | null, wall = Date.now()): StandIn {
  const s: StandIn = { id: `standin:${++n}`, session, text, wall };
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

const norm = (t: string) => t.trim().replace(/\s+/g, ' ').slice(0, 160);
/** The same words: a pasted text file goes out appended to them (Composer `parcel`), so one may begin the other. */
const same = (a: string, b: string) => !!a && !!b && (a === b || a.startsWith(b) || b.startsWith(a));

/**
 * Which stand-ins of `session` have their row now (pure): a message of the person's with the same
 * words, no older than the send, each row taken by one stand-in at most, newest rows first.
 */
export function standInRows(stand: readonly StandIn[], session: string, roots: readonly string[], items: Record<string, TimelineItem | undefined>): Map<string, string> {
  const out = new Map<string, string>();
  const mine = stand.filter((s) => s.session === session);
  if (!mine.length) return out;
  const used = new Set<string>();
  // Only the conversation's end can hold a message sent a moment ago.
  for (let i = roots.length - 1, seen = 0; i >= 0 && seen < 60; i--, seen++) {
    const it = items[roots[i]];
    if (it?.type !== 'user') continue;
    const k = norm(it.text);
    const s = mine.find((x) => !out.has(x.id) && same(norm(x.text), k) && it.ts >= x.wall - STAND_SLACK_MS);
    if (s && !used.has(it.id)) {
      out.set(s.id, it.id);
      used.add(it.id);
    }
  }
  return out;
}

/** Whether the real row `item` of `session` takes the place of a stand-in on screen (it then makes no entrance). */
export function takesStandIn(session: string, item: TimelineItem | undefined): boolean {
  if (item?.type !== 'user') return false;
  const k = norm(item.text);
  return list.some((s) => s.session === session && same(norm(s.text), k) && item.ts >= s.wall - STAND_SLACK_MS);
}

/** Tests. */
export function resetStandIns() {
  list = [];
  changed();
}
