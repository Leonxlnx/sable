/**
 * How the live line's title changes (TurnView `useSwap`), pure. A title that changes fades through:
 * the old one goes in `SWAP_OUT_MS`, the new one comes in. A line still arriving (a checkpoint just
 * closed and the next live line's words are fading in, timeline.css `next-in`) takes its first real
 * title at once: fading through nothing right after it came read as the line going out at every
 * checkpoint (scratch/day7/design4-flash, the title at opacity 0 for about 200 ms).
 */

/** How long the old title takes to fade before the new one comes in (ms). Short: the line is the
 *  turn's pulse, and a title that is gone for a quarter of a second reads as a line that went out. */
export const SWAP_OUT_MS = 80;

/** A live line this young (ms) changes its title without fading through: it is still arriving. */
export const SWAP_FRESH_MS = 320;

/** Whether a live line born at `born` takes a new title at `now` without the fade through. */
export function swapsAtOnce(born: number, now: number): boolean {
  return now - born < SWAP_FRESH_MS;
}
