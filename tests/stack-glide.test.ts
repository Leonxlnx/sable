import { describe, expect, it } from 'vitest';
import { glideLeft, rowMoves, trayShare, STACK_MS, TUCK } from '../src/features/composer/stack-glide';

const map = (o: Record<string, number>) => new Map(Object.entries(o));

describe('the dock glide (composer/stack-glide.ts)', () => {
  it('starts where it was drawn, ends at its place, and never turns back', () => {
    expect(glideLeft(28, 0)).toBe(28);
    expect(glideLeft(28, STACK_MS)).toBe(0);
    let prev = 28;
    for (let t = 0; t <= STACK_MS; t += 4) {
      const now = glideLeft(28, t);
      expect(now).toBeLessThanOrEqual(prev + 1e-9);
      prev = now;
    }
  });

  it('takes no more than a fifth of the way in its first frame (no step before the glide)', () => {
    expect(28 - glideLeft(28, 16.7)).toBeLessThan(28 / 5);
    expect(64 - glideLeft(64, 16.7)).toBeLessThan(64 / 5);
  });

  it('a tray adds its height less its tuck to the dock, nothing when it is gone', () => {
    expect(trayShare(0)).toBe(0);
    expect(trayShare(84)).toBe(84 - TUCK);
  });

  it('a new tray rises from behind the pane by its whole height', () => {
    const m = rowMoves(new Map(), map({ a: 26 }), 0, 84);
    expect(m.tray).toBe(84);
    expect(m.rows.size).toBe(0);
  });

  it('a row added at the bottom: the tray grows by a row and the rows above keep their place in the first frame', () => {
    // Before: a at 26 from the tray's bottom. After: a at 54, b (new) at 26.
    const m = rowMoves(map({ a: 26 }), map({ a: 54, b: 26 }), 84, 112);
    expect(m.tray).toBe(28);
    // a moved up 28 with the tray: nothing of its own.
    expect(m.rows.has('a')).toBe(false);
    expect(m.rows.has('b')).toBe(false);
  });

  it('the middle row removed: the row under it stays still, the one above comes down with the tray', () => {
    // a above, b (removed), c at the bottom.
    const m = rowMoves(map({ a: 82, b: 54, c: 26 }), map({ a: 54, c: 26 }), 140, 112);
    expect(m.tray).toBe(-28);
    expect(m.rows.has('a')).toBe(false);
    // c did not move in the layout: it is held against the tray's glide.
    expect(m.rows.get('c')).toBe(28);
    // Drawn where it stood in the first frame: tray offset + own offset = its own layout move (0).
    expect(m.tray + (m.rows.get('c') ?? 0)).toBe(0);
  });

  it('every row that stays is drawn where it stood in the first frame', () => {
    const before = map({ a: 110, b: 82, c: 54, d: 26 });
    const after = map({ a: 82, c: 54, d: 26 });
    const m = rowMoves(before, after, 168, 140);
    for (const [id, d] of after) {
      const was = before.get(id)!;
      // Screen y = -(distance from the bottom) + drawn offset; the first frame must equal the old y.
      expect(-d + m.tray + (m.rows.get(id) ?? 0)).toBeCloseTo(-was);
    }
  });
});
