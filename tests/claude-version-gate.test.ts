import { describe, expect, it } from 'vitest';
import { atLeast } from '../server/providers/claude';

describe('the CLI version a targeted interrupt needs', () => {
  it('holds from 2.1.325 on, not for that version alone', () => {
    expect(atLeast('2.1.325', [2, 1, 325])).toBe(true);
    expect(atLeast('2.1.326', [2, 1, 325])).toBe(true);
    expect(atLeast('2.2.0', [2, 1, 325])).toBe(true);
    expect(atLeast('3.0.0-beta.1', [2, 1, 325])).toBe(true);
    expect(atLeast('2.1.325 (Claude Code)', [2, 1, 325])).toBe(true);
  });
  it('does not hold for an older or unreadable version', () => {
    expect(atLeast('2.1.324', [2, 1, 325])).toBe(false);
    expect(atLeast('2.0.999', [2, 1, 325])).toBe(false);
    expect(atLeast('1.0', [2, 1, 325])).toBe(false);
    expect(atLeast('', [2, 1, 325])).toBe(false);
    expect(atLeast(undefined, [2, 1, 325])).toBe(false);
    expect(atLeast(21325, [2, 1, 325])).toBe(false);
  });
});
