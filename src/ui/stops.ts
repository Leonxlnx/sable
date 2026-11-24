/**
 * A slider with stops (`Slider` with `stops` in ui/index.tsx): the pure rules, kept apart from the
 * view so they can be tested.
 *
 * The track is `width` px wide and the thumb a disc of `thumb` px that never leaves it, so the
 * stops stand from one thumb's radius in to one thumb's radius short of the far end, evenly. While
 * dragged the thumb stands wherever the pointer puts it (1:1, held to the track); the value is the
 * nearest stop at every moment, and on release the thumb settles on that stop.
 */

/** Where stop `i` of `n` stands on a track `width` wide, its centre in px from the track's left. */
export function stopX(i: number, n: number, width: number, thumb: number): number {
  const r = thumb / 2;
  if (n <= 1) return r;
  const span = Math.max(0, width - thumb);
  return r + (span * Math.max(0, Math.min(n - 1, i))) / (n - 1);
}

/** The thumb's centre for a pointer at `x` (px from the track's left, less the grab offset): held to the track. */
export function holdX(x: number, width: number, thumb: number): number {
  const r = thumb / 2;
  return Math.max(r, Math.min(Math.max(r, width - r), x));
}

/** The stop nearest a thumb centred at `x`. A point exactly between two stops goes to the higher one. */
export function nearestStop(x: number, n: number, width: number, thumb: number): number {
  if (n <= 1) return 0;
  const span = Math.max(1, width - thumb);
  const t = (holdX(x, width, thumb) - thumb / 2) / span;
  return Math.max(0, Math.min(n - 1, Math.floor(t * (n - 1) + 0.5)));
}

/**
 * Where a key takes the value (`n` stops, at `i`); null for a key that is not the slider's, the
 * same index where it holds at an end. Left and Down step down, Right and Up step up (the reading
 * direction; Page Up and Down the same, a scale this short has no bigger step), Home the lowest,
 * End the highest. Nothing wraps.
 */
export function stopKey(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  const at = Math.max(0, Math.min(n - 1, i < 0 ? -1 : i));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
    case 'PageDown':
      return i < 0 ? 0 : Math.max(0, at - 1);
    case 'ArrowRight':
    case 'ArrowUp':
    case 'PageUp':
      return i < 0 ? 0 : Math.min(n - 1, at + 1);
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return null;
  }
}

/**
 * Where the value's word stands over the thumb: centred on it, held inside the track so it never
 * reaches past either end (`w` the word's width). Returns its left edge.
 */
export function wordLeft(thumbX: number, w: number, width: number): number {
  const left = thumbX - w / 2;
  return Math.max(0, Math.min(Math.max(0, width - w), left));
}

/** How long the settle onto a stop takes, by how far the thumb has to go: short and soft (120 to 160 ms). */
export function settleMs(dist: number): number {
  return Math.round(Math.max(120, Math.min(160, 120 + Math.abs(dist) * 1.2)));
}

/** cubic-bezier(x1, y1, x2, y2) as a function of the share of time (y may pass 1: an overshoot). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const bx = (m: number) => 3 * (1 - m) * (1 - m) * m * x1 + 3 * (1 - m) * m * m * x2 + m * m * m;
  const by = (m: number) => 3 * (1 - m) * (1 - m) * m * y1 + 3 * (1 - m) * m * m * y2 + m * m * m;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (bx(m) < p) lo = m;
      else hi = m;
    }
    return by((lo + hi) / 2);
  };
}

/** The settle's curve: soft, a hair past the stop and back (the house's press release). */
export const settleEase = cubicBezier(0.22, 1.28, 0.42, 1);

/**
 * Where a settle from `from` to `to` that began at `start` stands at `now` (ms, one clock), and
 * whether it is done. The thumb, the fill and the word are all placed from this one number in the
 * same frame, so nothing trails the thumb by a frame.
 */
export function settleAt(from: number, to: number, start: number, ms: number, now: number): { x: number; done: boolean } {
  const p = ms > 0 ? (now - start) / ms : 1;
  if (p >= 1) return { x: to, done: true };
  return { x: from + (to - from) * settleEase(Math.max(0, p)), done: false };
}
