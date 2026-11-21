/**
 * What the phone kept for its desktop goes together when the desktop is forgotten or replaced by
 * another computer (conn.ts, lib/erase.ts): each module that keeps something in memory for it
 * (drafts, review comments, downloads under way, the store) says here how it lets go, including
 * writes it still has due. Run in the order registered, each on its own (one that throws does not
 * keep the others from forgetting). These hooks are only for what a module holds while it is loaded:
 * what is on the phone's storage is erased by lib/erase.ts whether or not the module ever loaded.
 */
const hooks = new Set<() => void | Promise<void>>();

/** Registers how a module forgets what it kept for the desktop; returns the way to stop. */
export function onForget(fn: () => void | Promise<void>): () => void {
  hooks.add(fn);
  return () => void hooks.delete(fn);
}

/** Runs every hook (awaited); the number of those that failed. */
export async function runForget(): Promise<number> {
  let failed = 0;
  for (const fn of [...hooks]) {
    try {
      await fn();
    } catch {
      failed++;
    }
  }
  return failed;
}
