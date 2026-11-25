import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bezier, easeOf, standsAt } from '../src/features/composer/glide-from';

describe('a chip glide starts from where the last one stands', () => {
  it('reads a CSS curve as the browser plays it', () => {
    const out = easeOf('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(out(0)).toBe(0);
    expect(out(1)).toBe(1);
    // Quick off the mark: most of the way in the first quarter.
    expect(out(0.25)).toBeGreaterThan(0.6);
    expect(easeOf('linear')(0.3)).toBeCloseTo(0.3);
    const std = bezier(0.4, 0, 0.2, 1);
    expect(std(0.5)).toBeGreaterThan(0.6);
    expect(std(0.1)).toBeLessThan(0.1);
  });

  it('holds at its start through its delay, is home at its end, and between follows its curve', () => {
    const ease = easeOf('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(standsAt(-46, -20, 160, ease)).toBe(-46);
    expect(standsAt(-46, 0, 160, ease)).toBe(-46);
    expect(standsAt(-46, 160, 160, ease)).toBe(0);
    const mid = standsAt(-46, 80, 160, ease);
    expect(mid).toBeGreaterThan(-46);
    expect(mid).toBeLessThan(0);
  });

  it('a second step mid-glide continues from where the first one stands: no jump', () => {
    const ease = easeOf('cubic-bezier(0.16, 1, 0.3, 1)');
    // First step: the name was 46 px right of its new place. 60 ms later a second step moves it 40 px more.
    const first = standsAt(46, 60, 224, ease);
    const second = 40 + first;
    // In the frame of the second step the name stands where the first glide had brought it (plus the new layout's offset).
    expect(standsAt(second, 0, 224, ease) - 40).toBeCloseTo(first, 6);
  });

  it('no glide of a chip is additive (Chromium keeps an additive animation off the compositor)', () => {
    const src = readFileSync('src/features/composer/Chip.tsx', 'utf8');
    expect(src).not.toMatch(/composite:\s*'add'/);
    expect(src).toMatch(/glideBy\(el\.querySelector\('\.cs-move > i'\)/);
  });
});
