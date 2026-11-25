import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawnY, frameGate, glideLeft, glideY, STACK_MS } from '../src/features/composer/stack-glide';
import { cueCardLeft, takeCardLeft } from '../src/features/session/dock-glide';

/** The frames of a 60 Hz window, `n` of them from `t`. */
const steady = (t: number, n: number) => Array.from({ length: n }, (_, i) => t + i * 16.7);

describe('frames flow again (composer/stack-glide.ts frameGate)', () => {
  it('a quiet window lets a glide go after two frames on time', () => {
    const flows = frameGate();
    expect(steady(0, 4).map(flows)).toEqual([false, false, true, true]);
  });

  it('the frames measured after a permission card was answered: not into the gap, only after it', () => {
    // Packaged 0.2.36, a card with a diff answered (scratch/day7/jumps2/logs/j1-before.log): the
    // window drew at 100 and 115 ms, then nothing for 78 ms, then on time again.
    const flows = frameGate();
    const frames = [100.1, 115.1, 193.7, 212.2, 224.7, 238.1];
    expect(frames.map(flows)).toEqual([false, false, false, false, true, true]);
  });

  it('a late frame starts the count again', () => {
    const flows = frameGate();
    expect([0, 16, 80, 96, 160, 176, 192].map(flows)).toEqual([false, false, false, false, false, false, true]);
  });

  it('never waits longer than its limit, however the frames come', () => {
    const flows = frameGate(2, 24, 240);
    const out: boolean[] = [];
    for (let t = 0; t <= 300; t += 60) out.push(flows(t));
    // 0, 60, 120, 180 wait; 240 is the limit.
    expect(out).toEqual([false, false, false, false, true, true]);
  });
});

describe('the cue of a card that left (session/dock-glide.ts)', () => {
  it('is taken once, by the dock change right after it', () => {
    expect(takeCardLeft(1000)).toBe(false);
    cueCardLeft(1000);
    expect(takeCardLeft(1090)).toBe(true);
    expect(takeCardLeft(1100)).toBe(false);
  });

  it('is no cue for a change of the dock much later (a queue row a while after)', () => {
    cueCardLeft(1000);
    expect(takeCardLeft(2600)).toBe(false);
    // And it is spent: the next change is not held either.
    expect(takeCardLeft(2610)).toBe(false);
  });
});

/** A stand-in for an element and its animations: what `glideY` asks of them, nothing drawn. */
function fakeEl() {
  const made: { frames: Keyframe[]; anim: { playState: string; pause(): void; play(): void; cancel(): void } }[] = [];
  const el = {
    animate(frames: Keyframe[]) {
      const anim = {
        playState: 'running',
        pause() {
          this.playState = 'paused';
        },
        play() {
          this.playState = 'running';
        },
        cancel() {
          this.playState = 'idle';
        },
      };
      made.push({ frames, anim });
      return anim;
    },
  };
  return { el: el as unknown as Element, made };
}

describe('a glide that waits for the page (glideY with hold)', () => {
  let frames: ((t: number) => void)[] = [];
  let now = 0;
  /** One animation frame at `t` (ms). */
  const frame = (t: number) => {
    now = t;
    const due = frames;
    frames = [];
    for (const f of due) f(t);
  };

  beforeEach(() => {
    frames = [];
    now = 0;
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (id: number) => clearTimeout(id) });
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => frames.push(f));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is drawn where the thing stood and does not move until frames come on time', () => {
    const { el, made } = fakeEl();
    glideY(el, -68, 0, { hold: true });
    expect(made).toHaveLength(1);
    expect(made[0].frames[0]).toEqual({ translate: '0 -68.00px' });
    expect(made[0].anim.playState).toBe('paused');
    // The measured frames: two, then the gap.
    frame(100);
    frame(115);
    expect(made[0].anim.playState).toBe('paused');
    expect(drawnY(el, 150)).toBe(-68);
    frame(194);
    frame(212);
    expect(made[0].anim.playState).toBe('paused');
    frame(225);
    expect(made[0].anim.playState).toBe('running');
    // From there it is the dock's own glide, counted from the frame it was let go.
    expect(drawnY(el, 225)).toBe(-68);
    expect(drawnY(el, 225 + 60)).toBeCloseTo(glideLeft(-68, 60));
    expect(drawnY(el, 225 + STACK_MS)).toBe(0);
  });

  it('what is held beside it starts with it', () => {
    const { el, made } = fakeEl();
    const side = fakeEl();
    glideY(el, -40, 0, { hold: true, beside: () => [side.el.animate([{ translate: '0 12px' }, { translate: '0 0' }], { duration: STACK_MS })] });
    expect(side.made[0].anim.playState).toBe('paused');
    for (const t of [0, 16, 33]) frame(t);
    expect(made[0].anim.playState).toBe('running');
    expect(side.made[0].anim.playState).toBe('running');
  });

  it('a window that draws no frame lets it go by the clock', () => {
    const { el, made } = fakeEl();
    glideY(el, -68, 0, { hold: true });
    vi.advanceTimersByTime(399);
    expect(made[0].anim.playState).toBe('paused');
    vi.advanceTimersByTime(2);
    expect(made[0].anim.playState).toBe('running');
  });

  it('the next card arriving while it waits: the conversation is where it belongs already, nothing is played', () => {
    const { el, made } = fakeEl();
    // The card left: the conversation fell 68 and is held 68 higher. The next card (as tall) arrives:
    // the end is kept, which moves the conversation up 68 in the layout, where it is drawn already.
    glideY(el, -68, 0, { hold: true });
    frame(16);
    expect(glideY(el, 68, 40)).toBeNull();
    expect(made).toHaveLength(1);
    expect(made[0].anim.playState).toBe('idle');
    expect(drawnY(el, 41)).toBe(0);
    // The gate of the glide that is gone lets nothing go later.
    for (const t of [50, 66, 83, 100]) frame(t);
    expect(made[0].anim.playState).toBe('idle');
  });

  it('a glide under way is taken into the next from where it stands', () => {
    const { el, made } = fakeEl();
    glideY(el, -68, 0);
    expect(made[0].anim.playState).toBe('running');
    const left = glideLeft(-68, 50);
    glideY(el, 100, 50);
    expect(made).toHaveLength(2);
    expect(made[0].anim.playState).toBe('idle');
    expect(made[1].frames[0]).toEqual({ translate: `0 ${(100 + left).toFixed(2)}px` });
  });
});
