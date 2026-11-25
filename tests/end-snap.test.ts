import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { endSnap } from '../src/features/timeline/follow';

// A long chat kept at its end while its older pages arrive. The browser rounds the scroller's largest
// offset to a whole device pixel; the end of the conversation is drawn at its own offset less that
// scroll, so it is the END's offset that must be whole (Timeline.tsx keeps a margin below one device
// pixel above the conversation). Measured in the packaged app at 125%.

/** Where the conversation's end is drawn (device pixels from the scroller's top), kept at the end. */
function drawnEnd(end: number, pad: number, view: number, k: number): number {
  // What scrolls is the end's offset plus the padding under it; the scroll offset is whole device pixels.
  const scroll = Math.round((end + pad - view) * k);
  return end * k - scroll;
}

describe('the end on whole device pixels (follow.ts endSnap)', () => {
  const VIEW = 808;
  const PAD = 104;
  // The conversation's height as a long chat's pages are built above it: real heights of any fraction
  // (scratch/day7/jumps2/logs/j2-before-migrated.log, scroll heights with the fractions the rows have).
  const HEIGHTS = [5537.33, 14966.79, 24246.2, 33682.47, 43037.61, 52321.05, 61778.9, 71085.18, 80467.56, 89848.31];

  it('gives the room that makes the offset whole, below one device pixel', () => {
    for (const k of [1, 1.25, 1.5, 2, 1.25 * 0.9, 1.25 * 1.1]) {
      for (const end of [704, 5433.33, 14862.79, 99028.85, 350414.2]) {
        const e = endSnap(end, k);
        expect(e).toBeGreaterThanOrEqual(0);
        expect(e * k).toBeLessThan(1);
        const dev = (end + e) * k;
        expect(Math.abs(dev - Math.round(dev))).toBeLessThan(1e-6);
      }
    }
  });

  it('the end is drawn on one place from page to page at 125%', () => {
    const k = 1.25;
    const places = new Set<string>();
    for (const h of HEIGHTS) {
      const end = h - PAD;
      const e = endSnap(end, k);
      places.add(drawnEnd(end + e, PAD, VIEW, k).toFixed(3));
    }
    // The view's height less the dock's padding, in device pixels.
    expect([...places]).toEqual([((VIEW - PAD) * k).toFixed(3)]);
  });

  it('without it the end takes another fraction with every page (the shimmer)', () => {
    const k = 1.25;
    const places = new Set(HEIGHTS.map((h) => drawnEnd(h - PAD, PAD, VIEW, k).toFixed(2)));
    expect(places.size).toBeGreaterThan(4);
  });

  it('room added below the end instead cannot hold it: the end stands that much higher (0.2.35 as built)', () => {
    const k = 1.25;
    const places = new Set<string>();
    for (const h of HEIGHTS) {
      // The bottom padding that made the whole height a whole number of device pixels.
      const below = endSnap(h, k);
      places.add(drawnEnd(h - PAD, PAD + below, VIEW, k).toFixed(2));
    }
    expect(places.size).toBeGreaterThan(4);
  });

  it('settles: measured again it asks for the same', () => {
    const k = 1.25;
    const end = 145838.33;
    // The offset handed in never counts the room itself (Timeline.tsx measures the conversation's own box).
    expect(endSnap(end, k)).toBeCloseTo(endSnap(end, k, 0.3), 12);
  });

  it('keeps what it had when the scale cannot be read', () => {
    expect(endSnap(100.3, 0, 0.2)).toBe(0.2);
    expect(endSnap(Number.NaN, 1.25, 0.2)).toBe(0.2);
  });

  it('is written above the conversation, where it is no part of the box the view watches', () => {
    const src = readFileSync('src/features/timeline/Timeline.tsx', 'utf8');
    expect(src).toContain('inner.style.marginTop = e ? `${e.toFixed(3)}px` : \'\';');
    expect(src).not.toContain('inner.style.paddingBottom');
  });
});
