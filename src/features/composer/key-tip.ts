/**
 * Where the send key's tooltip stands: above the key, never over the rim's curves. The key sits in
 * the cove at the pane's bottom-right corner (composer.css, between `cove:begin` and `cove:end`):
 * 40 px, its top 40 px above the pane's bottom; the pane's right edge runs straight from its top
 * corner (radius 20) down to the cove's horn, 66 px above the bottom. A tip drawn 7 px over the
 * key, as every other tip, lay on the horn.
 *
 * The tip stands 6 px clear: on the straight part of the edge, 6 px above the horn, when that part
 * holds it with 6 px to spare at both ends (a pane of a few lines); else 6 px above the pane's top
 * edge (a resting pane, whose corner and horn are close together).
 */
export const KEY = 40;
const HORN = 66;
const CORNER = 20;
const CLEAR = 6;
/** The tooltip's height (13 px words and a key cap in a 24 px box, ui.css `.tooltip`). */
export const TIP_H = 24;

/** The tip's distance from the key's top, for a pane `height` tall. */
export function keyTipOffset(height: number): number {
  const keyTop = height - KEY;
  const fits = height - HORN - CLEAR - (CORNER + CLEAR) >= TIP_H;
  return fits ? keyTop - (height - HORN - CLEAR) : keyTop + CLEAR;
}
