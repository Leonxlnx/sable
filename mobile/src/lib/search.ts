import type { PhoneSearch, PhoneSearchHit } from '@shared/protocol';

/**
 * Message search on the phone (`phone.search`), asked until the desktop says it is whole. Each call
 * is bounded on the desktop (time and bytes read); a partial answer says more is to read, with a
 * cursor. The desktop goes on with the same search for the same phone when it is asked again soon
 * (its scope is the phone), and the cursor is passed back as well, so either way the next answer goes
 * on where the last one stopped and its hits add up. Nothing is said to be missing while more
 * remains: the section shows the search going on, and after `AUTO_ROUNDS` answers in a row (a very
 * large history, or a desktop that does not get on) it waits with a "Search further" row instead of
 * asking on by itself. Pure, so it can be tested; screens/Search.tsx shows it.
 */

export interface Found {
  /** The query these hits answer. */
  q: string;
  hits: PhoneSearchHit[];
  /** Asked now: more may come. */
  busy: boolean;
  /** The desktop has more to read and the phone stopped asking by itself: a tap goes on (`searchMessages` with this as `from`). */
  more?: boolean;
  /** Where the desktop stopped (passed back to go on). */
  cursor?: string;
  /** Chats with a part that could not be read (their messages there were not searched). */
  skipped?: number;
  /** The desktop cannot search messages (an older build), or the first answer failed. */
  off?: boolean;
}

export type SearchCall = (params: { query: string; cursor?: string }) => Promise<PhoneSearch>;

/** Answers asked for in a row before the phone waits for a tap (each one up to about a second of the desktop's reading). */
export const AUTO_ROUNDS = 40;

const keyOf = (h: PhoneSearchHit) => `${h.sessionId}\u0000${h.itemId}`;

/**
 * The hits so far with an answer's: the answer's in its order (they add up within one search), then
 * any earlier one it does not have yet (the desktop started the search over after a long pause and
 * has not reached that chat again).
 */
function merge(prev: readonly PhoneSearchHit[], next: readonly PhoneSearchHit[]): PhoneSearchHit[] {
  if (!prev.length) return next.slice();
  const have = new Set(next.map(keyOf));
  return [...next, ...prev.filter((h) => !have.has(keyOf(h)))];
}

/**
 * Asks for `q` until the desktop says the search is whole, showing each answer as it comes (`busy`
 * while more is coming); or, after `rounds` answers, waits with `more`. `from`: a search that waited
 * (its hits and cursor), to go on with. Stops as soon as `live()` says the answer is no longer wanted.
 * Never throws: a first answer that fails hides the section (`off`), a later one keeps what came with
 * a way on.
 */
export async function searchMessages(call: SearchCall, q: string, live: () => boolean, show: (f: Found) => void, from?: Found, rounds = AUTO_ROUNDS): Promise<void> {
  const on = from?.q === q ? from : undefined;
  let hits = on?.hits ?? [];
  let cursor = on?.cursor;
  let skipped = on?.skipped ?? 0;
  let answered = !!on;
  for (let n = 0; live(); n++) {
    let r: PhoneSearch;
    try {
      r = await call({ query: q, ...(cursor ? { cursor } : {}) });
    } catch {
      if (!live()) return;
      return show(answered ? { q, hits, busy: false, more: true, ...(cursor ? { cursor } : {}), ...(skipped ? { skipped } : {}) } : { q, hits: [], busy: false, off: true });
    }
    if (!live()) return;
    answered = true;
    hits = merge(hits, r.hits ?? []);
    skipped = Math.max(skipped, r.skipped ?? 0);
    const partial = !!r.partial;
    cursor = partial ? r.cursor : undefined;
    const wait = partial && n + 1 >= rounds;
    show({ q, hits, busy: partial && !wait, ...(wait ? { more: true } : {}), ...(cursor ? { cursor } : {}), ...(skipped ? { skipped } : {}) });
    if (!partial || wait) return;
  }
}

/** The search is whole and found no message: only then does the section say so. */
export const nothingFound = (f: Found) => !f.busy && !f.more && !f.off && f.hits.length === 0;

/** The line under the hits for chats the desktop could not read. */
export const skippedLine = (n: number) => `${n} ${n === 1 ? 'chat' : 'chats'} could not be read.`;
