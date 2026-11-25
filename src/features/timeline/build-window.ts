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
 * What a conversation's turn list has worked out, kept per chat while the window keeps the chat:
 * the shape index, the grouping, the stable turn objects and their heights. Opening a kept chat
 * again (a switch back) then reads no root it has read before and groups nothing it has grouped:
 * each piece is a cache that checks its input (the shape index the items' revision, the grouping
 * the ids and shape), so a list that was away while the chat changed catches up as it would
 * have write by write. One list uses an entry at a time (`users`); a second list of the same chat
 * (a race view leaving while the chat opens) works on a fresh one. `forgetLists` drops the entries
 * of chats the window no longer keeps, so nothing here holds a dropped conversation.
 */
export interface ListKeep<S, G, K extends object> {
  shapes: S;
  grouping: G;
  cache: Map<string, unknown>;
  kept: WeakMap<K, unknown>;
  /** Estimated heights by group object (a group whose turn changed is a new object). */
  heights: WeakMap<object, number>;
  users: number;
}
const LISTS_MAX = 12;
const lists = new Map<string, ListKeep<unknown, unknown, object>>();

/** The entry for `sessionId`, made with `make` when there is none or it is in use. Not claimed yet: see `holdList`. */
export function listFor<S, G, K extends object>(sessionId: string, make: () => Omit<ListKeep<S, G, K>, 'users'>): ListKeep<S, G, K> {
  const had = lists.get(sessionId) as ListKeep<S, G, K> | undefined;
  if (had && had.users === 0) {
    // The most recently used last.
    lists.delete(sessionId);
    lists.set(sessionId, had as ListKeep<unknown, unknown, object>);
    return had;
  }
  const fresh: ListKeep<S, G, K> = { ...make(), users: 0 };
  if (!had) {
    lists.set(sessionId, fresh as ListKeep<unknown, unknown, object>);
    for (const [id, e] of lists) {
      if (lists.size <= LISTS_MAX) break;
      if (e.users === 0) lists.delete(id);
    }
  }
  return fresh;
}

/** A mounted list uses its entry until the returned release. */
export function holdList(entry: { users: number }): () => void {
  entry.users++;
  return () => {
    entry.users--;
  };
}

/** Drops the entries of chats `keeps` says no to (the window dropped their conversation). */
export function forgetLists(keeps: (sessionId: string) => boolean) {
  for (const [id, e] of lists) if (e.users === 0 && !keeps(id)) lists.delete(id);
}

/** For tests. */
export function listCount(): number {
  return lists.size;
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
