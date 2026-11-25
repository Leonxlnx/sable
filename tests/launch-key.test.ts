import { describe, expect, it } from 'vitest';
import { KEY_GIVE, keyGive, keyScale } from '../src/features/composer/launch';

// The send key's launch copy (composer/launch.ts): its size is the key's layout box and its give
// starts where the key is drawn. A send by the pointer comes while the key still gives under it
// (`.cmp-send:active`, scale 0.94): sized from the drawn box (37.6 px for 40) the copy sank to 0.846
// and popped 2.4 px when the real key came back.
describe('launch key', () => {
  it('reads the scale the key is drawn at from its drawn and layout widths', () => {
    expect(keyScale(40, 40)).toBe(1);
    expect(keyScale(37.6, 40)).toBe(0.94);
    // Not readable or absurd: the key's own size.
    expect(keyScale(0, 0)).toBe(1);
    expect(keyScale(40, 0)).toBe(1);
    expect(keyScale(5, 40)).toBe(1);
    expect(keyScale(Number.NaN, 40)).toBe(1);
  });

  it('starts the give where the key stands and ends it at the key itself', () => {
    expect(keyGive()).toBe(KEY_GIVE);
    expect(keyGive(1)).toBe(KEY_GIVE);
    const held = keyGive(0.94);
    expect(held[0].scale).toBe('0.94');
    expect(held[0].easing).toBe(KEY_GIVE[0].easing);
    expect(held.slice(1)).toEqual(KEY_GIVE.slice(1));
    expect(held[held.length - 1].scale).toBe('1');
    // The deepest point is the same for every start: the copy is the key's size, so 0.9 of 40 px.
    expect(Math.min(...held.map((k) => Number(k.scale)))).toBe(0.9);
    // The source keyframes are never changed.
    expect(KEY_GIVE[0].scale).toBe('1');
  });
});
