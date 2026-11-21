/**
 * Which of a chat's groups (turns, and items between them) are mounted. By default the newest
 * `count` ones (the chat follows its newest line). Opened at a message far back, or scrolled far,
 * a window instead: the groups from `lo` up to (not with) `hi`, named by their keys so groups added
 * before or after never move it, at most `MOUNT_MAX` at once; what lies above and below it stands as
 * spacers of the height those groups had (or an estimate for ones never drawn). Pure, so it can be
 * tested; screens/Chat.tsx measures and scrolls.
 */
export interface Win {
  /** The first group mounted. */
  lo: string;
  /** The first group after the window; null: it reaches the newest. */
  hi: string | null;
}

/** Groups mounted at most at once, and how many a scroll near an edge adds. */
export const MOUNT_MAX = 72;
export const STEP = 24;
/** A group never drawn is taken to be this tall (a turn's own `contain-intrinsic-size`). */
export const GUESS = 360;

export interface Range {
  lo: number;
  hi: number;
}

/** The mounted range: the newest `count` without a window; a window's keys found again (a key gone: its edge of the chat). */
export function rangeOf(keys: readonly string[], win: Win | null, count: number): Range {
  const n = keys.length;
  if (!win) return { lo: Math.max(0, n - count), hi: n };
  let lo = keys.indexOf(win.lo);
  if (lo < 0) lo = 0;
  let hi = win.hi === null ? n : keys.indexOf(win.hi);
  if (hi < 0) hi = n;
  if (hi <= lo) hi = Math.min(n, lo + 1);
  return { lo, hi };
}

const winOf = (keys: readonly string[], lo: number, hi: number): Win => ({ lo: keys[Math.max(0, Math.min(lo, keys.length - 1))], hi: hi >= keys.length ? null : keys[hi] });

/** `n` more toward the start; past `max`, the newest ones leave (their place stays as a spacer). */
export function growUp(keys: readonly string[], r: Range, n = STEP, max = MOUNT_MAX): Win {
  const lo = Math.max(0, r.lo - n);
  return winOf(keys, lo, Math.min(r.hi, lo + max));
}

/** `n` more toward the newest; past `max`, the oldest ones leave. */
export function growDown(keys: readonly string[], r: Range, n = STEP, max = MOUNT_MAX): Win {
  const hi = Math.min(keys.length, r.hi + n);
  return winOf(keys, Math.max(r.lo, hi - max), hi);
}

/** A window around group `at`: a few before it, more after (it is read on toward the newest). */
export function around(keys: readonly string[], at: number, before = 6, after = STEP): Win {
  const i = Math.max(0, Math.min(at, keys.length - 1));
  return winOf(keys, i - before, Math.min(keys.length, i + after + 1));
}

/** The window's oldest groups leave while it reaches the newest and holds more than `max` (a long session read live). */
export function trimTop(keys: readonly string[], r: Range, max = MOUNT_MAX): Win | null {
  if (r.hi < keys.length || r.hi - r.lo <= max + STEP) return null;
  return winOf(keys, r.hi - max, r.hi);
}

/** The spacers' heights: the groups before the window and after it, as measured, else the average of those measured, else `GUESS`. */
export function spacers(keys: readonly string[], r: Range, heights: ReadonlyMap<string, number>): { top: number; bottom: number } {
  let known = 0;
  let sum = 0;
  for (const h of heights.values()) {
    known++;
    sum += h;
  }
  const guess = known ? sum / known : GUESS;
  const total = (from: number, to: number) => {
    let t = 0;
    for (let i = from; i < to; i++) t += heights.get(keys[i]) ?? guess;
    return Math.round(t);
  };
  return { top: total(0, r.lo), bottom: total(r.hi, keys.length) };
}

/**
 * The groups' measured heights with `spacers`' sums kept over them: a running sum of the heights
 * before each group, made again only when the groups (a new `keys` list) or a measurement change.
 * A scroll frame then reads two numbers instead of adding up every group outside the window.
 */
export class SpacerSums {
  private heights = new Map<string, number>();
  private measured = 0;
  private keys: readonly string[] | null = null;
  /** `pre[i]`: the height of the groups before group `i` (`pre[keys.length]`: all of them). */
  private pre = new Float64Array(1);
  private stale = true;
  /** How many times the sums were made (tests). */
  builds = 0;

  /** A group's height as drawn; the sums are made again only when it differs from the one kept. */
  set(key: string, height: number) {
    const old = this.heights.get(key);
    if (old === height) return;
    this.measured += height - (old ?? 0);
    this.heights.set(key, height);
    this.stale = true;
  }

  /** Every height forgotten (the chat was replaced). */
  clear() {
    if (!this.heights.size) return;
    this.heights.clear();
    this.measured = 0;
    this.stale = true;
  }

  /** As `spacers(keys, r, heights)`, from the kept sums. */
  of(keys: readonly string[], r: Range): { top: number; bottom: number } {
    if (this.stale || keys !== this.keys) this.build(keys);
    const n = keys.length;
    const lo = Math.max(0, Math.min(r.lo, n));
    const hi = Math.max(lo, Math.min(r.hi, n));
    return { top: Math.round(this.pre[lo]), bottom: Math.round(this.pre[n] - this.pre[hi]) };
  }

  private build(keys: readonly string[]) {
    const guess = this.heights.size ? this.measured / this.heights.size : GUESS;
    const pre = this.pre.length > keys.length ? this.pre : new Float64Array(keys.length + 257);
    pre[0] = 0;
    for (let i = 0; i < keys.length; i++) pre[i + 1] = pre[i] + (this.heights.get(keys[i]) ?? guess);
    this.pre = pre;
    this.keys = keys;
    this.stale = false;
    this.builds++;
  }
}
