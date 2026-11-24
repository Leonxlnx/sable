import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOVE_GLIDE_MS, endShift, glideOffset, rowLeft, rowMoved, willMove } from '../src/features/timeline/user-card';

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
  it('starts where the eye last saw the card, counting the scroll that keeps the end in the same frame (win2 day 7)', () => {
    // The film: the card stood at 600 px; after the take it lies 27 px lower in the content, and the
    // reply's first words and a note made the view scroll 102 px to keep its end. Laid out before that
    // scroll, the card reads 627; on screen it lands at 525.
    const shift = endShift(true, 1191, 708, 381);
    expect(shift).toBe(102);
    const off = glideOffset(600, 627, shift);
    // It starts at 600 on screen (525 + 75) and glides up to 525: never above where it lands.
    expect(627 - shift + off).toBe(600);
    expect(off).toBe(75);
    // Before: the start was 600 - 627 = -27 from the layout, which the scroll put at 498 on screen
    // (102 px up in one frame), and from there it glided down to 525.
    expect(627 - shift + (600 - 627)).toBeLessThan(525);
    // Scrolled away from the end, or nothing grew: the layout alone, as before.
    expect(endShift(false, 1191, 708, 381)).toBe(0);
    expect(endShift(true, 1089, 708, 381)).toBe(0);
    expect(glideOffset(600, 562, 0)).toBe(38);
  });
});
