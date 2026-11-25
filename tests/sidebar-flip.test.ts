import { describe, expect, it } from 'vitest';
import { steady } from '../src/features/sidebar/flip';

// Flip (sidebar/flip.tsx) slides a child from where it stood unless the slide would carry its words
// across another child's: only a child that changed its place against the others may arrive in
// place instead. `steady` says which children kept their order among themselves.
describe('which children merely shifted', () => {
  it('keeps a whole list that shifted under something new (Pinned appearing above the folders)', () => {
    // Old places of the children in their new order: nothing changed its order.
    expect(steady([0, 1, 2, 3])).toEqual([true, true, true, true]);
    // A section came or went between them (its place is not in the list).
    expect(steady([0, 2, 3])).toEqual([true, true, true]);
  });

  it('singles out the one that jumped (a folder to the top, a row to the top of its folder)', () => {
    expect(steady([3, 0, 1, 2])).toEqual([false, true, true, true]);
    expect(steady([1, 2, 3, 0])).toEqual([true, true, true, false]);
    expect(steady([0, 3, 1, 2])).toEqual([true, false, true, true]);
  });

  it('keeps the longest run when several moved', () => {
    const s = steady([4, 0, 1, 5, 2, 3]);
    expect(s.filter(Boolean).length).toBe(4);
    expect(s).toEqual([false, true, true, false, true, true]);
  });

  it('handles the empty and the single list', () => {
    expect(steady([])).toEqual([]);
    expect(steady([7])).toEqual([true]);
  });
});
