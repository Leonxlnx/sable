import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SWAP_FRESH_MS, SWAP_OUT_MS, swapsAtOnce } from '../src/features/timeline/live-title';

const css = readFileSync(new URL('../src/features/timeline/timeline.css', import.meta.url), 'utf8');

/** The `from` block of a keyframes rule. */
function fromOf(name: string): string {
  const m = css.match(new RegExp(`@keyframes ${name} \\{\\s*from \\{([^}]*)\\}`));
  return m ? m[1] : '';
}

describe('a checkpoint closing never blanks the end of the running turn', () => {
  it('the live line still arriving takes its first real title at once, an older one fades through', () => {
    expect(swapsAtOnce(1000, 1000)).toBe(true);
    expect(swapsAtOnce(1000, 1000 + SWAP_FRESH_MS - 1)).toBe(true);
    expect(swapsAtOnce(1000, 1000 + SWAP_FRESH_MS)).toBe(false);
    expect(swapsAtOnce(1000, 9000)).toBe(false);
    // Longer than the line's own arrival (next-in, 160 ms), shorter than a held title (900 ms).
    expect(SWAP_FRESH_MS).toBeGreaterThan(160 + SWAP_OUT_MS);
    expect(SWAP_FRESH_MS).toBeLessThan(900);
  });

  it('the summary of a closed checkpoint is on screen from its first frame: no delay, never from nothing', () => {
    const rule = css.match(/\.work-head\[data-landed\] > \* \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/animation: land-in \d+ms var\(--ease-out\) backwards;/);
    const from = fromOf('land-in');
    const o = Number(from.match(/opacity: ([\d.]+)/)?.[1]);
    expect(o).toBeGreaterThanOrEqual(0.4);
    expect(from).not.toMatch(/transform|translate/);
  });

  it("the next live line's words start part way in, as the note above arrives from nothing", () => {
    const o = Number(fromOf('next-in').match(/opacity: ([\d.]+)/)?.[1]);
    expect(o).toBeGreaterThanOrEqual(0.3);
    expect(css).toMatch(/\.tl-work\[data-next\]\[data-live\] > \.work-head :is\(\.work-label, \.work-time\) \{\s*animation: next-in \d+ms var\(--ease\) backwards;/);
    expect(css).not.toMatch(/\.tl-work\[data-next\][^{]*\{\s*animation:\s*fade-in/);
  });
});
