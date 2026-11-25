import { describe, expect, it } from 'vitest';
import { endSnap } from '../src/features/timeline/follow';

// A long chat kept at its end while its older pages arrive: the browser rounds the scroller's largest
// offset to a whole device pixel, so the end stands on another device-pixel phase whenever the
// conversation's height changes by a fraction (Timeline.tsx keeps a padding below one device pixel).
describe('the end on whole device pixels', () => {
  const phase = (h: number, k: number) => Math.abs(h * k - Math.round(h * k));

  it('makes the height whole in device pixels at the usual scales', () => {
    for (const k of [1, 1.25, 1.5, 2, 1.25 * 0.9, 1.25 * 1.1]) {
      for (const h of [808, 5812.4, 14967.37, 99132.85, 350518.2]) {
        const e = endSnap(h, 0, k);
        expect(e).toBeGreaterThanOrEqual(0);
        expect(e * k).toBeLessThan(1);
        expect(phase(h + e, k)).toBeLessThan(1e-6);
      }
    }
  });

  it('settles: measured again with its own padding it asks for the same', () => {
    const k = 1.25;
    const h = 145942.33;
    const e = endSnap(h, 0, k);
    expect(endSnap(h + e, e, k)).toBeCloseTo(e, 9);
  });

  it('keeps the end on one phase from page to page at 125%', () => {
    const k = 1.25;
    let h = 5812.4;
    let extra = 0;
    const phases = new Set<number>();
    // Pages of older turns built above: real heights of any fraction.
    for (const page of [9154.6, 9279.23, 9435.97, 9354.4, 9283.18, 7874.4]) {
      h += page;
      extra = endSnap(h + extra, extra, k);
      phases.add(Math.round(phase(h + extra, k) * 1000));
    }
    expect([...phases]).toEqual([0]);
  });

  it('leaves the padding alone when the scale cannot be read', () => {
    expect(endSnap(100.3, 0.2, 0)).toBe(0.2);
    expect(endSnap(Number.NaN, 0.2, 1.25)).toBe(0.2);
  });
});
