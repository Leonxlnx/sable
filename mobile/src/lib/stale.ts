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
