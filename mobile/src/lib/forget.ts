/**
 * What the phone kept for its desktop goes together when the desktop is forgotten (conn.ts
 * `forget`, once the token is gone from the phone's storage): each module that keeps something for
 * it (drafts, review comments, downloads and their files, notifications, the cache, the places last
 * open) says here how it forgets, including writes it still has due. Run in the order registered,
 * each on its own (one that throws does not keep the others from forgetting).
 */
const hooks = new Set<() => void>();

/** Registers how a module forgets what it kept for the desktop; returns the way to stop. */
export function onForget(fn: () => void): () => void {
  hooks.add(fn);
  return () => void hooks.delete(fn);
}

export function runForget() {
  for (const fn of [...hooks]) {
    try {
      fn();
    } catch {
      /* the others still forget */
    }
  }
}
