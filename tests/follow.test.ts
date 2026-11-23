import { describe, expect, it } from 'vitest';
import { glideFrame, springStep, type Glide } from '../src/features/timeline/follow';

const W = 24;

/** The step the follower used before: semi-implicit Euler. */
function eulerStep(pos: number, v: number, target: number, w: number, dt: number) {
  const nv = v + (-w * w * (pos - target) - 2 * w * v) * dt;
  return { pos: pos + nv * dt, v: nv };
}

/** Runs a glide from `from` to `to` on frames of `dt` seconds; returns every position written. */
function run(step: typeof springStep, from: number, to: number, dt: number, frames = 40): number[] {
  let s = { pos: from, v: 0 };
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    s = step(s.pos, s.v, to, W, dt);
    out.push(s.pos);
  }
  return out;
}

const turnsBack = (xs: number[]) => xs.some((x, i) => i > 0 && x < xs[i - 1] - 0.01);

describe('the conversation follower', () => {
  it('never turns back on long frames (the stepwise spring did: +75 px, then 21 px back)', () => {
    // The frames measured on a busy page: 34 ms (the cap) for a 115 px way to the end.
    expect(turnsBack(run(eulerStep, 0, 115, 0.034))).toBe(true);
    for (const dt of [0.004, 0.0167, 0.025, 0.034]) {
      const xs = run(springStep, 0, 115, dt);
      expect(turnsBack(xs)).toBe(false);
      expect(Math.max(...xs)).toBeLessThanOrEqual(115 + 1e-9);
    }
  });

  it('arrives as quickly as before at 60 frames a second', () => {
    const xs = run(springStep, 0, 115, 1 / 60, 30);
    const at = xs.findIndex((x) => x >= 115 - 0.4);
    expect(at).toBeGreaterThan(5);
    expect(at).toBeLessThan(30);
  });

  it('goes on from a move someone else made instead of writing its own older place back', () => {
    // A glide from 0 to 300; after a few frames scroll anchoring moves the view 120 px further down
    // the page (rows built above). The next frame must start from there.
    const g: Glide = { pos: 0, v: 0, wrote: 0 };
    let top = 0;
    for (let i = 0; i < 3; i++) {
      top = glideFrame(g, top, 300, W, 1 / 60).top;
      g.wrote = top;
    }
    // The follower before kept its own position and wrote it back: up again for a frame.
    const old = springStep(g.pos, g.v, 420, W, 1 / 60).pos;
    top += 120;
    expect(old).toBeLessThan(top);
    const next = glideFrame(g, top, 420, W, 1 / 60).top;
    expect(next).toBeGreaterThanOrEqual(top);
    // Anchoring the other way (rows above got shorter by 200 px, the end with them): the glide
    // takes the move too, and its next step is measured from there.
    const pos = g.pos;
    g.wrote = next;
    glideFrame(g, next - 200, 220, W, 1 / 60);
    expect(g.pos).toBeLessThan(pos);
    expect(g.pos).toBeGreaterThanOrEqual(next - 200);
  });

  it('ends exactly on the end', () => {
    const g: Glide = { pos: 0, v: 0, wrote: 0 };
    let top = 0;
    let done = false;
    for (let i = 0; i < 200 && !done; i++) {
      const f = glideFrame(g, top, 115, W, 1 / 60);
      top = g.wrote = f.top;
      done = f.done;
    }
    expect(done).toBe(true);
    expect(top).toBe(115);
  });
});
