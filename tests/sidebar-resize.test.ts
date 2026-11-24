import { expect, it } from 'vitest';
import { keyWidth, sideRange } from '../src/features/sidebar/Resize';

it('announces the rendered separator and moves on the first arrow at 900 px', () => {
  const range = sideRange(268, 900);
  expect(range).toEqual({ now: 220, max: 220 });
  expect(keyWidth('ArrowLeft', false, range)).toBe(204);
  expect(keyWidth('End', false, range)).toBe(220);
  expect(keyWidth('ArrowLeft', true, range)).toBe(196);
  expect(sideRange(460, 700)).toEqual({ now: 196, max: 196 });
  expect(sideRange(268, 1400)).toEqual({ now: 268, max: 460 });
});
