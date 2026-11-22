import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVE_GLIDE_MS, rowLeft, rowMoved, willMove } from '../src/features/timeline/user-card';

describe('a steered message the agent takes glides to where it was taken', () => {
  it('knows the move in a change of the roots: the message now stands behind what stood after it', () => {
    expect(willMove('s', ['u', 'w', 's', 't', 'x'], ['u', 'w', 't', 'x', 's'])).toBe(true);
    // A frame's events are one write: the reply's first item is behind the moved message already.
    expect(willMove('s', ['u', 'w', 's', 't', 'x'], ['u', 'w', 't', 'x', 's', 'reply'])).toBe(true);
    // Behind only some of what stood after it: not the bridge's move.
    expect(willMove('s', ['u', 's', 't', 'x'], ['u', 't', 's', 'x', 'reply'])).toBe(false);
    // Already last, a new message, a removal, another message moving, the same list: not its move.
    expect(willMove('s', ['u', 'w', 's'], ['u', 'w', 's'])).toBe(false);
    expect(willMove('s', ['u', 'w', 's'], ['u', 'w', 's', 'n'])).toBe(false);
    expect(willMove('s', ['u', 's', 't'], ['u', 's', 't', 'n'])).toBe(false);
    expect(willMove('s', ['u', 's', 't'], ['u', 't'])).toBe(false);
    expect(willMove('s', ['u', 's', 't'], ['u', 's'])).toBe(false);
    expect(willMove('s', ['u', 's', 'q', 't'], ['u', 's', 't', 'q'])).toBe(false);
    expect(willMove('s', ['u', 't'], ['t', 's'])).toBe(false);
    const same = ['u', 's', 't'];
    expect(willMove('s', same, same)).toBe(false);
    expect(willMove('s', undefined, ['s'])).toBe(false);
  });

  it('reads the place before the list is laid out again and glides once', () => {
    const row = readFileSync(path.join(__dirname, '../src/features/timeline/User.tsx'), 'utf8');
    // The place is read in a store subscription (before React commits), never in the render.
    expect(row).toMatch(/useStore\.subscribe\(\(s, prev\) => \{[^}]*willMove\(item\.id/s);
    // Both paths (the row that stays, the row that remounts) glide on the same clock.
    expect(row.match(/duration: MOVE_GLIDE_MS/g)).toHaveLength(2);
    expect(MOVE_GLIDE_MS).toBeGreaterThanOrEqual(200);
    expect(MOVE_GLIDE_MS).toBeLessThanOrEqual(400);
  });

  it('a row that remounts within a moment is still the same message moving', () => {
    rowLeft('m', { left: 10, top: 20, queued: true }, 1000);
    expect(rowMoved('m', 1300)).toMatchObject({ left: 10, top: 20, queued: true });
    // Taken once.
    expect(rowMoved('m', 1310)).toBeNull();
    rowLeft('m', { left: 10, top: 20, queued: true }, 2000);
    expect(rowMoved('m', 2700)).toBeNull();
  });
});
