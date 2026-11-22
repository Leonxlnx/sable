/**
 * The path of ultracode's moment: two lights leave the effort chip along the pane's rim, one each
 * way round the outline, at one speed, and meet on the far side. Pure, so it can be tested: the
 * view (Ultracode.tsx) moves a soft disc along each path inside the rim's own ring, which is all
 * that shows of it.
 *
 * The outline is taken as the card's box, with the cove's corner cut along its arc (three points:
 * where the bottom edge ends, the cove's middle, where the right edge ends). The discs are far
 * wider than a corner's rounding, so the plain corners are the box's own.
 */

export interface RunStop {
  x: number;
  y: number;
  /** How far along its path the light is here, 0..1 (the path is walked at one speed). */
  at: number;
}

export interface RimRun {
  /** From the chip to the left, up the left side and along the top. */
  a: RunStop[];
  /** From the chip to the right, round the cove, up the right side and back along the top. */
  b: RunStop[];
  /** Where they meet. */
  meet: { x: number; y: number };
  /** How far each of them travels. */
  length: number;
}

type Pt = { x: number; y: number };

const dist = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);

/** The first `len` px of a line through `pts`, with how far along each point is. */
function walk(pts: Pt[], len: number): RunStop[] {
  const out: RunStop[] = [{ ...pts[0], at: 0 }];
  let done = 0;
  for (let i = 1; i < pts.length && done < len; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (d <= 0) continue;
    if (done + d >= len) {
      const k = (len - done) / d;
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k, at: 1 });
      return out;
    }
    done += d;
    out.push({ ...pts[i], at: len > 0 ? done / len : 1 });
  }
  out[out.length - 1].at = 1;
  return out;
}

/**
 * The two paths for a card `w` by `h` whose light starts on the bottom edge at `x0`. `cut` is how
 * far from the bottom-right corner the pane's straight edges end (composer.css `--cove-cut`) and
 * `mid` how far in the cove's middle lies.
 */
export function rimRun(w: number, h: number, x0: number, cut = 66, mid = 38): RimRun {
  const sx = Math.max(0, Math.min(w - cut, x0));
  const start = { x: sx, y: h };
  const cove: Pt[] = [
    { x: w - cut, y: h },
    { x: w - mid, y: h - mid },
    { x: w, y: Math.max(0, h - cut) },
  ];
  const left: Pt[] = [start, { x: 0, y: h }, { x: 0, y: 0 }, { x: w, y: 0 }, cove[2], cove[1], cove[0], start];
  const right: Pt[] = [...left].reverse();
  let loop = 0;
  for (let i = 1; i < left.length; i++) loop += dist(left[i - 1], left[i]);
  const length = loop / 2;
  const a = walk(left, length);
  const b = walk(right, length);
  const end = a[a.length - 1];
  return { a, b, meet: { x: end.x, y: end.y }, length };
}
