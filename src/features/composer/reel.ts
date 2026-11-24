/**
 * The reel a word rolls on when it changes by direction (Chip.tsx `data-roll`: the effort's level
 * went up or down, ultracode went on or off). Pure, so the rule can be tested.
 *
 * The old word and the new one travel the same way on one clock, one line apart: the old one
 * leaves the way the value went, the new one follows it in from the other side. A line (16 px) is
 * more than a word is tall at the bar's size (13 px text: about 13 from an ascender to a
 * descender), so the two never share a pixel; and they hand over by opacity while they travel
 * (the old one gone and the new one whole by 60% of the way), so the place is never empty and
 * never holds two whole words. The chip cuts both at its top and bottom (composer.css).
 */

/** How far a word rolls: one line. */
export const ROLL_PX = 16;
/** How long the roll takes. */
export const ROLL_MS = 190;
/**
 * The reel's curve: quick off the mark (the first frame has already moved 3 to 4 px), the two
 * words handing over within the first 60 ms, then a soft arrival over the rest.
 */
export const ROLL_EASE = 'cubic-bezier(0.25, 0.8, 0.25, 1)';

/** The two halves of the reel as keyframes, both for one animation curve: `way` is -1 for up, 1 for down. */
export function reel(way: 1 | -1): { out: Keyframe[]; in: Keyframe[] } {
  return {
    out: [
      { opacity: 1, transform: 'translateY(0px)' },
      { opacity: 0, transform: `translateY(${way * ROLL_PX * 0.6}px)`, offset: 0.6 },
      { opacity: 0, transform: `translateY(${way * ROLL_PX}px)` },
    ],
    in: [
      { opacity: 0, transform: `translateY(${-way * ROLL_PX}px)` },
      { opacity: 1, transform: `translateY(${-way * ROLL_PX * 0.4}px)`, offset: 0.6 },
      { opacity: 1, transform: 'translateY(0px)' },
    ],
  };
}

/** Where on the reel's curve (0 to 1) a roll stands `ms` after it began: ROLL_EASE solved for its time. */
export function rollAt(ms: number): number {
  const x = ms / ROLL_MS;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // cubic-bezier(0.25, 0.8, 0.25, 1): x(s) and y(s) of the curve's own parameter s.
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * 0.25 + 3 * (1 - s) * s * s * 0.25 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * 0.8 + 3 * (1 - s) * s * s + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < x) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

/** Where a word that rolled in (`way` as in `reel`) stands `ms` after its roll began: its offset and how much of it shows. */
export function inPose(way: 1 | -1, ms: number): { y: number; opacity: number } {
  const p = rollAt(ms);
  const opacity = Math.min(1, p / 0.6);
  // Linear between the `in` keyframes on the eased progress, as Web Animations plays them.
  const y = p < 0.6 ? -way * ROLL_PX * (1 - 0.6 * (p / 0.6)) : -way * ROLL_PX * 0.4 * ((1 - p) / 0.4);
  return { y, opacity };
}

/**
 * The `out` half for a word that leaves before it was home (a step that came while it still rolled
 * in): it goes on from where it stands, never from rest (that was a jump, or a blink when it was
 * simply hidden), and leaves `way` with the same hand-over by opacity.
 */
export function reelFrom(way: 1 | -1, from: { y: number; opacity: number }): Keyframe[] {
  return [
    { opacity: from.opacity, transform: `translateY(${from.y.toFixed(2)}px)` },
    { opacity: 0, transform: `translateY(${(from.y + way * ROLL_PX * 0.6).toFixed(2)}px)`, offset: 0.6 },
    { opacity: 0, transform: `translateY(${(from.y + way * ROLL_PX).toFixed(2)}px)` },
  ];
}
