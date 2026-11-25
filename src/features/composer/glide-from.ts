/**
 * A chip's glides stand on the compositor (Chip.tsx). They used to be additive (`composite: 'add'`,
 * so a step during a glide simply added its offset), and Chromium runs no additive animation on
 * the compositor: the name, the dot, the skin's moving end and the chips beside it glided on the
 * main thread while the rolled word and the fades ran on the compositor. Whenever the page was busy
 * as the level changed (the commit of the step itself), the two kept different time: "Extra high"
 * rolled in over "Demo Large" while the name still stood (filmed in the packaged app with the main
 * thread held for 220 ms: the words lay on each other for 150 ms, then the name jumped).
 *
 * Now a glide replaces the one before on the same element and starts from where that one stands,
 * worked out from its own clock (the animation's current time and its known curve), never read
 * from a computed style. Pure, so the rule can be tested.
 */

export type Ease = (x: number) => number;

/** A CSS cubic-bezier as a function of time (0 to 1) to progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

const eases = new Map<string, Ease>();
/** The curve of a CSS easing ("cubic-bezier(…)", "linear"; anything else as linear). */
export function easeOf(css: string): Ease {
  const hit = eases.get(css);
  if (hit) return hit;
  const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(css);
  const f = m ? bezier(+m[1], +m[2], +m[3], +m[4]) : (x: number) => Math.min(1, Math.max(0, x));
  eases.set(css, f);
  return f;
}

/**
 * Where a glide from `from` px to 0 stands `t` ms into its active time (before it: at `from`, as
 * `fill: 'backwards'` holds it; after it: home).
 */
export function standsAt(from: number, t: number, duration: number, ease: Ease): number {
  if (t <= 0) return from;
  if (t >= duration) return 0;
  return from * (1 - ease(t / duration));
}
