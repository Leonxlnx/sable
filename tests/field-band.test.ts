import { describe, expect, it } from 'vitest';
import { bandFade, Field, type Look } from '../src/art/field';

// The session's horizon in a canvas of a fixed size (Look.band): a change of the stage or the dock
// moves the light by a glide in the field, never by a resized canvas redrawn at once.

const ASPECT = 3;
const look = (band: [number, number, number] | null): Look => ({
  variant: 'streak',
  palette: 'mint',
  focus: [0.5, 1.15],
  gain: 0.7,
  speed: 0,
  seed: 3.7,
  full: false,
  react: 0,
  band,
});

/** The topmost lit row (canvas heights) in the band's centre column. */
function glowTop(f: Field): number {
  const out = new Float32Array(4);
  for (let y = 0; y <= 1; y += 0.002) {
    f.shade(ASPECT / 2, y, out);
    if (out[3] > 0) return y;
  }
  return 1;
}

describe('bandFade', () => {
  it('keeps the old overlay stops: all light at the bottom, none at the top', () => {
    expect(bandFade(1)).toBe(1);
    expect(bandFade(0)).toBe(0);
    expect(bandFade(-0.2)).toBe(0);
    expect(bandFade(1 - 0.52)).toBeCloseTo(0.9, 5);
    expect(bandFade(1 - 0.8)).toBeCloseTo(0.3, 5);
  });
});

describe('the band glides', () => {
  it('takes its first band as it is', () => {
    const a = new Field(look(null));
    a.step(look([0.6, 0.3, 0.3]), 0, ASPECT);
    const b = new Field(look([0.6, 0.3, 0.3]));
    b.step(look([0.6, 0.3, 0.3]), 0, ASPECT);
    expect(glowTop(a)).toBeCloseTo(glowTop(b), 3);
  });

  it('a taller dock moves the light up over a few frames, not in one', () => {
    const f = new Field(look([0.6, 0.3, 0.3]));
    f.step(look([0.6, 0.3, 0.3]), 0, ASPECT);
    const from = glowTop(f);
    const target = new Field(look([0.6, 0.5, 0.3]));
    target.step(look([0.6, 0.5, 0.3]), 0, ASPECT);
    const to = glowTop(target);
    expect(to).toBeLessThan(from - 0.05);
    f.step(look([0.6, 0.5, 0.3]), 16, ASPECT);
    const one = glowTop(f);
    // One frame in: on its way, well short of the end.
    expect(one).toBeLessThan(from);
    expect(one).toBeGreaterThan(from + (to - from) * 0.4);
    // Within its 260 ms, there.
    for (let t = 32; t <= 400; t += 16) f.step(look([0.6, 0.5, 0.3]), t, ASPECT);
    expect(glowTop(f)).toBeCloseTo(to, 2);
  });

  it('rows above the band are not evaluated', () => {
    const f = new Field(look([0.6, 0.3, 0.3]));
    f.step(look([0.6, 0.3, 0.3]), 0, ASPECT);
    const sp = new Float32Array(2);
    f.span(0.2, sp);
    expect(sp[0]).toBeGreaterThan(sp[1]);
    f.span(0.9, sp);
    expect(sp[0]).toBeLessThan(sp[1]);
  });
});
