/**
 * How long the bridge keeps its event loop to itself. The bridge runs in the desktop's main process, which
 * also routes the window's input: while one task of the bridge runs, a click, a key or a wheel step waits.
 * Two readings, both numbers and fixed words only (never a title, a path or a text):
 *
 * - the loop's own lateness: a timer that should fire every `EVERY_MS` and says how late it was;
 * - named work: a part of the bridge that is known to walk a whole chat (`stallMark`) says how long it
 *   took in one go, so a late timer has a name beside it.
 *
 * Kept in memory (the last `KEEP` of each) and read through `diag.stalls`; nothing is written anywhere.
 * The timer runs only while somebody reads: a first reading starts it, and it stops by itself `IDLE_MS`
 * after the last one (the bridge costs nothing at rest). Named work is noted always: that costs a
 * clock reading where the work is.
 */

const EVERY_MS = 50;
/** A timer this late is a stall worth keeping (ms). */
export const STALL_MS = 100;
/** A named part of the bridge this long in one go is kept (ms). */
export const MARK_MS = 40;
const KEEP = 120;
/** The timer stops this long after the last reading (ms). */
const IDLE_MS = 30 * 60_000;

export interface StallReading {
  /** How long the readings cover (ms). */
  forMs: number;
  /** Late timers of at least 100, 250, 500 and 1000 ms. */
  late: { over100: number; over250: number; over500: number; over1000: number; worst: number };
  /** The latest stalls, newest first: how long ago (ms) and how late (ms). */
  stalls: { agoMs: number; ms: number }[];
  /** Named work that held the loop, by its word: how often, the sum and the worst (ms). */
  marks: Record<string, { count: number; totalMs: number; worstMs: number }>;
  /** The latest of it, newest first. */
  marked: { agoMs: number; what: string; ms: number }[];
}

class Stalls {
  private began = performance.now();
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private due = 0;
  private late = { over100: 0, over250: 0, over500: 0, over1000: 0, worst: 0 };
  private stalls: { at: number; ms: number }[] = [];
  private marks = new Map<string, { count: number; totalMs: number; worstMs: number }>();
  private marked: { at: number; what: string; ms: number }[] = [];

  start() {
    if (this.timer) return;
    this.began = performance.now();
    this.due = this.began + EVERY_MS;
    this.timer = setInterval(() => {
      const now = performance.now();
      const ms = now - this.due;
      this.due = now + EVERY_MS;
      if (ms < STALL_MS) return;
      if (ms > this.late.worst) this.late.worst = Math.round(ms);
      this.late.over100++;
      if (ms >= 250) this.late.over250++;
      if (ms >= 500) this.late.over500++;
      if (ms >= 1000) this.late.over1000++;
      this.stalls.push({ at: now, ms: Math.round(ms) });
      if (this.stalls.length > KEEP) this.stalls.shift();
    }, EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.idle);
    this.timer = undefined;
    this.idle = undefined;
  }

  note(what: string, ms: number) {
    if (ms < MARK_MS) return;
    const m = this.marks.get(what) ?? { count: 0, totalMs: 0, worstMs: 0 };
    m.count++;
    m.totalMs += Math.round(ms);
    if (ms > m.worstMs) m.worstMs = Math.round(ms);
    this.marks.set(what, m);
    this.marked.push({ at: performance.now(), what, ms: Math.round(ms) });
    if (this.marked.length > KEEP) this.marked.shift();
  }

  read(): StallReading {
    // Somebody looks: the lateness is measured from now on, until nobody has looked for a while.
    this.start();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
    const now = performance.now();
    return {
      forMs: Math.round(now - this.began),
      late: { ...this.late },
      stalls: this.stalls.slice().reverse().map((s) => ({ agoMs: Math.round(now - s.at), ms: s.ms })),
      marks: Object.fromEntries(this.marks),
      marked: this.marked.slice().reverse().map((m) => ({ agoMs: Math.round(now - m.at), what: m.what, ms: m.ms })),
    };
  }
}

export const stalls = new Stalls();

/**
 * Times one stretch of work that runs without a pause: `const done = stallMark('save'); …; done();`.
 * `what` is a fixed word of the code, never anything read from a chat.
 */
export function stallMark(what: string): () => void {
  const t0 = performance.now();
  return () => stalls.note(what, performance.now() - t0);
}
