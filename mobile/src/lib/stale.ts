/**
 * `phone.stale`: the desktop had an event too big for the phone and sent this in its place. The
 * phone fetches what it stood for: the chat's newest page (`phone.tail`) when that chat is open here,
 * the whole list (`app.hello`) otherwise. Many of them in a burst cost one fetch each way: a fetch
 * asked again while one runs runs once more after it, never twice at once. Pure (the store wires it).
 */
export type StaleFetch = { kind: 'tail'; sessionId: string } | { kind: 'hello' };

/** What a `phone.stale` event asks the phone to fetch. */
export function staleFetch(e: { sessionId?: unknown }, isOpen: (id: string) => boolean): StaleFetch {
  return typeof e.sessionId === 'string' && isOpen(e.sessionId) ? { kind: 'tail', sessionId: e.sessionId } : { kind: 'hello' };
}

/** Runs one fetch per key at a time; asks while it runs make one more run after it. */
export function coalesce(run: (key: string) => Promise<unknown>) {
  const running = new Set<string>();
  const again = new Set<string>();
  const go = (key: string): void => {
    if (running.has(key)) return void again.add(key);
    running.add(key);
    void run(key)
      .catch(() => {})
      .finally(() => {
        running.delete(key);
        if (again.delete(key)) go(key);
      });
  };
  return go;
}

/**
 * Fetches like `coalesce` (one run per key at a time), and a fetch that fails is never silent: the
 * first failure for a key is said (`report`: the chat or the list may be out of date) and the fetch
 * is tried again a little later, up to `tries` times; one that goes through clears it.
 */
export function reconciler(run: (key: string) => Promise<unknown>, opts: { report: (key: string, err: unknown) => void; later?: (fn: () => void, ms: number) => void; tries?: number; delay?: number }) {
  const fails = new Map<string, number>();
  const later = opts.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const tries = opts.tries ?? 3;
  const delay = opts.delay ?? 3000;
  const go: (key: string) => void = coalesce(async (key) => {
    try {
      await run(key);
      fails.delete(key);
    } catch (err) {
      const n = (fails.get(key) ?? 0) + 1;
      fails.set(key, n);
      if (n === 1) opts.report(key, err);
      if (n <= tries) later(() => go(key), delay * n);
      throw err;
    }
  });
  return Object.assign(go, { failing: (key: string) => fails.has(key) });
}
