/**
 * Errors of the connection itself, told apart from the desktop's own answers: a call that never went
 * (`unsent`), one whose socket went away before the answer (`lost`), one the desktop did not answer
 * in time (`timeout`). After `lost` or `timeout` the desktop may have done what was asked: whoever
 * asked looks again rather than taking it as a no. Pure, so it can be tested.
 */
export type TransportKind = 'unsent' | 'lost' | 'timeout';

export type TransportError = Error & { transport: TransportKind };

export const transportError = (text: string, kind: TransportKind): TransportError => Object.assign(new Error(text), { transport: kind });

/** The connection failed this call (not the desktop): it is worth asking again once connected. */
export const isTransport = (err: unknown): err is TransportError => !!err && typeof (err as { transport?: unknown }).transport === 'string';

/** The call may have been done on the desktop (its answer never came). */
export const isUncertain = (err: unknown) => isTransport(err) && err.transport !== 'unsent';

/** The desktop refused for now, not for good (`retry: true` with `retryAfterMs`: busy with other transfers): ask the same again after that. */
export type BusyError = Error & { retryAfterMs: number };

export const busyError = (text: string, retryAfterMs: number): BusyError => Object.assign(new Error(text), { retryAfterMs });

export const isBusy = (err: unknown): err is BusyError => !!err && typeof (err as { retryAfterMs?: unknown }).retryAfterMs === 'number';

/**
 * `call` again while the desktop says it is busy, after the wait it names (kept within 50 ms to 5 s),
 * until `budgetMs` has passed; any other answer or error is the result. `sleep` is injectable for tests.
 */
export async function whileBusy<T>(call: () => Promise<T>, budgetMs = 90_000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<T> {
  const until = Date.now() + budgetMs;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!isBusy(err)) throw err;
      const wait = Math.min(5000, Math.max(50, err.retryAfterMs));
      if (Date.now() + wait > until) throw err;
      await sleep(wait);
    }
  }
}
