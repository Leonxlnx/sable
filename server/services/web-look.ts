/**
 * One look at this computer's networks, kept (web-remote.ts asks it; the look itself is one PowerShell
 * run of 1 to 2.5 s, web-networks.ts). Requests and connections are answered on the kept look and never
 * wait for one; a look older than `fresh` is asked again in the background. A look that fails keeps the
 * last good one usable for `hold` after it was taken; then there is none, and the listener stops and
 * says why. How often a look runs by itself is web-remote's timer: every `fresh` while a browser is
 * connected, every `idle` while nothing is, never while web access is off.
 */
export const LOOK_MS = { fresh: 30_000, idle: 60_000, hold: 120_000 };
export type LookTimes = typeof LOOK_MS;

/**
 * How long until the next look by itself: `fresh` after the last one began (good or not) while a
 * browser is connected, so a change of network is seen by the first look that begins after it, at most
 * `fresh` later; `idle` while nothing is. Never sooner than a second (a failing look is not retried in
 * a loop).
 */
export function nextLookIn(lastStart: number | undefined, connected: boolean, times: LookTimes, now: number): number {
  const every = connected ? times.fresh : times.idle;
  return Math.max(Math.min(1000, every), (lastStart ?? now) + every - now);
}

export class NetworkLook<T> {
  private good?: { rows: T[]; at: number };
  private pending?: Promise<T[]>;
  /** Looks started (for tests and the cost at rest). */
  runs = 0;
  failure?: string;
  /** When the last look began, good or not (the timer counts from it). */
  startedAt?: number;
  /** When the last look ended, good or not. */
  triedAt?: number;

  constructor(private read: () => T[] | Promise<T[]>, readonly times: LookTimes = LOOK_MS, private now: () => number = Date.now) {}

  /** When the last good look was taken, if any. */
  get at(): number | undefined {
    return this.good?.at;
  }

  /** The kept rows while they may be used (up to `hold` after the last good look); undefined after. */
  rows(): T[] | undefined {
    return this.good && this.now() - this.good.at <= this.times.hold ? this.good.rows : undefined;
  }

  /** The kept look is older than `fresh` (or there is none): it should be asked again. */
  stale(): boolean {
    return !this.good || this.now() - this.good.at >= this.times.fresh;
  }

  /** A look now, one at a time (callers during a look share it). */
  ask(): Promise<T[]> {
    // A look begun before forget() is not shared: what it brings is not kept.
    if (this.pending && this.pendingEra === this.era) return this.pending;
    this.pendingEra = this.era;
    return (this.pending = (async () => {
      this.runs++;
      const era = this.era, began = this.startedAt = this.now();
      try {
        // Starting a process holds the thread for 10 to 25 ms: never in the turn of the request that asked.
        await new Promise<void>(r => setImmediate(r));
        const rows = await this.read();
        // The rows are as old as the look's beginning (what it read may have changed while it ran).
        if (era === this.era) { this.good = { rows, at: began }; this.failure = undefined; }
        return rows;
      } catch (err) {
        if (era === this.era) this.failure = (err as Error)?.message ?? String(err);
        throw err;
      } finally {
        if (era === this.era) { this.pending = undefined; this.triedAt = this.now(); }
      }
    })());
  }

  /** A look of this era is under way. */
  get looking(): boolean {
    return !!this.pending && this.pendingEra === this.era;
  }

  private era = 0;
  private pendingEra = -1;
  /** Off: nothing kept, not even what a look under way brings (the next start looks again). */
  forget() {
    this.era++;
    this.good = undefined;
    this.failure = undefined;
    this.startedAt = this.triedAt = undefined;
  }
}
