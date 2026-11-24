/**
 * Menu-aim for the model and effort panel (Phrase.tsx): resting on a model makes the scale beside
 * it show that model's levels. A pointer on its way from a model to the scale crosses other model
 * rows; while it heads into the scale those rows must not take the scale over, or the level it
 * lands on would belong to another model. Pure, so it can be tested: the view keeps the last
 * pointer position and asks.
 */

export interface Pt {
  x: number;
  y: number;
}

/** The near edge of the scale's column: its left side, from top to bottom. */
export interface Edge {
  x: number;
  top: number;
  bottom: number;
}

/**
 * Whether a pointer that moved from `from` to `to` is heading into the column beyond `edge`: it
 * moves toward it and stays inside the triangle from where it was to the column's near corners
 * (widened by `slack`). A pointer already past the edge, or moving away, is not aiming.
 */
export function aimsAt(from: Pt, to: Pt, edge: Edge, slack = 6): boolean {
  const dx = to.x - from.x;
  if (dx <= 0 || from.x >= edge.x || to.x >= edge.x) return false;
  const run = edge.x - from.x;
  const up = (edge.top - slack - from.y) / run;
  const down = (edge.bottom + slack - from.y) / run;
  const slope = (to.y - from.y) / dx;
  return slope >= up && slope <= down;
}

/** How long a model row the pointer crossed while aiming waits before it takes the scale (the pointer stopped there). */
export const AIM_WAIT_MS = 110;
