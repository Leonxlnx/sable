/**
 * Revisions of a session's items (`SessionData.items`, `rev`, `changed`). Pure, so view helpers
 * and tests can use it without the store.
 */

/** What a reader needs of a session's data to follow its items write by write. */
export interface ItemsRevision {
  items: object;
  rev: number;
  changed?: { since: number; ids: readonly string[] };
}

const NO_IDS: readonly string[] = [];

/**
 * The ids whose items changed (set or removed) since revision `rev` of this session's items, read
 * earlier from `d.rev`: empty when nothing did, null when that is not known (more than one write
 * since, or a new timeline), and then the reader reads every item again. Selectors run on every
 * store write, so a selector that remembers the revision it last saw nearly always gets the ids.
 */
export function changedSince(d: ItemsRevision, rev: number): readonly string[] | null {
  if (d.rev === rev) return NO_IDS;
  return d.changed?.since === rev ? d.changed.ids : null;
}

/** Safe empty index while the chat is unloaded. */
export const emptyIndex: Record<string, never> = Object.freeze(Object.create(null));
