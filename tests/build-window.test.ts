import { describe, expect, it } from 'vitest';
import { frameContent } from '../src/features/genui/WidgetFrame';
import { MIN_TAIL, TAIL, tailStart } from '../src/features/timeline/build-window';

describe('the turns a conversation builds when it opens: by estimated height', () => {
  it('builds the newest groups until they fill what is wanted, at least two', () => {
    // Seven groups, the first a 4,000-line answer: the newest four fill 2,400 px, so the first three are not built.
    const heights = [120_000, 900, 4_000, 700, 800, 900, 600];
    expect(tailStart(heights, 2_400)).toBe(3);
    // Tall newest groups: still two.
    expect(tailStart([500, 500, 9_000, 9_000], 2_400)).toBe(2);
    expect(4 - tailStart([1, 1, 1, 50_000], 2_400)).toBe(MIN_TAIL);
  });

  it('never builds more than the old count, and a short chat whole', () => {
    expect(tailStart(Array(40).fill(10), 2_400)).toBe(40 - TAIL);
    expect(tailStart([100, 100, 100], 2_400)).toBe(0);
    expect(tailStart([], 2_400)).toBe(0);
  });

  it('keeps the same tail window across a settled widget’s transient small report', () => {
    let floor = 0;
    const start = (h: number) => {
      const size = frameContent({ off: false, settled: true, reserve: 160, floor, h });
      floor = size.floor;
      return tailStart([800, 600, size.content, 600], 900);
    };
    expect([start(400), start(40), start(400)]).toEqual([2, 2, 2]);
  });

  it('reaches a kept reading place within the count', () => {
    const heights = [5_000, 5_000, 5_000, 1_000, 1_000];
    expect(tailStart(heights, 2_400)).toBe(2);
    // The reader had left it 8,000 px from the end: built far enough to cover it.
    expect(tailStart(heights, 2_400, 8_000)).toBe(1);
  });
});
