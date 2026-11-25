import { describe, expect, it } from 'vitest';
import { keyTipOffset, KEY, TIP_H } from '../src/features/composer/key-tip';

// The pane's outline in numbers (composer.css cove:begin..end): the horn 66 px above the bottom,
// the top corner's radius 20. The tip's box, measured from the pane's top, must keep 6 px off both.
const tipBox = (h: number) => {
  const bottom = h - KEY - keyTipOffset(h);
  return { top: bottom - TIP_H, bottom };
};

describe('keyTipOffset', () => {
  it('stands above a resting pane, 6 px clear of its top edge', () => {
    for (const h of [90, 100, 112]) expect(tipBox(h).bottom).toBe(-6);
  });

  it('stands on the straight edge of a taller pane, 6 px above the horn and clear of the corner', () => {
    for (const h of [122, 140, 260]) {
      const b = tipBox(h);
      expect(b.bottom).toBe(h - 66 - 6);
      expect(b.top).toBeGreaterThanOrEqual(20 + 6);
    }
  });

  it('never lies on the horn or the corner at any height', () => {
    for (let h = 80; h < 400; h++) {
      const b = tipBox(h);
      const onCorner = b.bottom > 0 && b.top < 26;
      const onHorn = b.bottom > h - 72;
      expect(onCorner || onHorn).toBe(false);
    }
  });
});
