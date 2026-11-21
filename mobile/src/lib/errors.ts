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

/** A wait or a call given up because whoever asked stopped it (a download's Stop). */
export const stoppedError = () => Object.assign(new Error('Stopped'), { stopped: true as const });

export const isStopped = (err: unknown) => !!(err as { stopped?: boolean } | undefined)?.stopped;

/** The clock deadlines are on: monotonic (a change of the phone's time never stretches or cuts a wait). */
export const monotonic = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** `p`, or a rejection (`stoppedError`) as soon as `signal` aborts; `p` itself goes on (its answer is not waited for). */
export function untilStopped<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(stoppedError());
  return new Promise<T>((resolve, reject) => {
    const off = () => reject(stoppedError());
    signal.addEventListener('abort', off, { once: true });
    p.then(
      (v) => (signal.removeEventListener('abort', off), resolve(v)),
      (e) => (signal.removeEventListener('abort', off), reject(e)),
    );
  });
}

/** Waits `ms`; a `signal` that aborts ends the wait at once (`stoppedError`). */
export const nap = (ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>) =>
  untilStopped(sleep ? sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)), signal);

export interface BusyOpts {
  /** One deadline on `monotonic` time for every layer that waits (a caller's own loop passes its own on). */
  deadline?: number;
  /** Without a deadline: how long from now (90 s). */
  budgetMs?: number;
  /** Stops it: no call is made after it aborts, and a wait ends at once. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `call` again while the desktop says it is busy, after the wait it names (kept within 50 ms to 5 s),
 * until the deadline; any other answer or error is the result. Each call is given the time left
 * (`leftMs`: its own timeout is never longer), a wait that would end past the deadline is not begun,
 * and once `signal` aborts nothing more is asked (`stoppedError`). The older form `(call, budgetMs,
 * sleep)` is the same with a budget from now.
 */
export async function whileBusy<T>(call: (leftMs: number) => Promise<T>, opts: BusyOpts | number = {}, sleepArg?: (ms: number) => Promise<void>): Promise<T> {
  const o: BusyOpts = typeof opts === 'number' ? { budgetMs: opts, sleep: sleepArg } : opts;
  const now = o.now ?? monotonic;
  const until = o.deadline ?? now() + (o.budgetMs ?? 90_000);
  for (;;) {
    if (o.signal?.aborted) throw stoppedError();
    const left = until - now();
    if (left <= 0) throw transportError('The desktop did not answer in time', 'timeout');
    try {
      return await call(left);
    } catch (err) {
      if (o.signal?.aborted) throw stoppedError();
      if (!isBusy(err)) throw err;
      const wait = Math.min(5000, Math.max(50, err.retryAfterMs));
      if (now() + wait > until) throw err;
      await nap(wait, o.signal, o.sleep);
    }
  }
}
