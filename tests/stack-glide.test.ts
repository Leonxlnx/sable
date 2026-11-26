import { describe, expect, it } from 'vitest';
import { clearFor, drawnY, glideLeft, glideMs, glideY, rowMoves, trayShare, GLIDE_MAX_MS, GLIDE_NEAR, STACK_MS, TUCK } from '../src/features/composer/stack-glide';


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

  /** The largest move between two frames 16.7 ms apart of a glide of `d` px on `ms` (the curve worked out). */
  const worstFrame = (d: number, ms: number) => {
    let worst = 0;
    for (let t = 0; t < ms; t += 0.5) worst = Math.max(worst, glideLeft(d, t, ms) - glideLeft(d, t + 16.7, ms));
    return worst;
  };

  it('keeps its own time over a short way (a queue row, a strip, a 68 px card)', () => {
    for (const d of [0, 1, 13, 28, 68, GLIDE_NEAR, -28, -68]) expect(glideMs(d)).toBe(STACK_MS);
    // Measured before the change: 16.1 px in the largest step of a 68 px card. Unchanged.
    expect(worstFrame(68, glideMs(68))).toBeLessThan(18);
  });

  it('takes longer over a long way, so its fastest frame stays comfortable (a 473 px card: 123 px a frame before)', () => {
    expect(worstFrame(473, STACK_MS)).toBeGreaterThan(110);
    expect(glideMs(473)).toBeGreaterThan(600);
    expect(glideMs(473)).toBeLessThanOrEqual(GLIDE_MAX_MS);
    expect(worstFrame(473, glideMs(473))).toBeLessThan(52);
    // Grows with the root of the way: never slower than needed, the same either way.
    let prev = 0;
    for (let d = 0; d <= 1200; d += 8) {
      const ms = glideMs(d);
      expect(ms).toBeGreaterThanOrEqual(prev);
      expect(glideMs(-d)).toBe(ms);
      prev = ms;
    }
    expect(glideMs(240)).toBeLessThan(500);
    expect(glideMs(5000)).toBe(GLIDE_MAX_MS);
    expect(glideMs(Number.NaN)).toBe(STACK_MS);
  });

  it('a glide carries on from where it stands on its own clock, and drawnY reads that clock', () => {
    const made: { frames: Keyframe[]; opts: KeyframeAnimationOptions }[] = [];
    const el = {
      animate(frames: Keyframe[], opts: KeyframeAnimationOptions) {
        made.push({ frames, opts });
        return { playState: 'running', pause() {}, play() {}, cancel() { this.playState = 'idle'; } };
      },
    } as unknown as Element;
    const ms = glideMs(473);
    glideY(el, -473, 0, { ms });
    expect(made[0].opts.duration).toBe(ms);
    expect(drawnY(el, 100)).toBeCloseTo(glideLeft(-473, 100, ms));
    expect(drawnY(el, STACK_MS)).not.toBe(0);
    // The next change (a card arriving at once) starts from there, on the clock it is given.
    glideY(el, 300, 100, { ms: STACK_MS });
    expect(made[1].frames[0]).toEqual({ translate: `0 ${(300 + glideLeft(-473, 100, ms)).toFixed(2)}px` });
    expect(made[1].opts.duration).toBe(STACK_MS);
    // Left out, its own way decides.
    const el2 = { animate: el.animate.bind(el) } as unknown as Element;
    glideY(el2, 473, 0);
    expect(made[2].opts.duration).toBe(glideMs(473));
  });

  it('a glide is read from its own start: pending (its first frame not drawn yet) it is still where it stood', () => {
    const anim = { playState: 'running', startTime: null as number | null, pause() {}, play() {}, cancel() {} };
    const el = { animate: () => anim } as unknown as Element;
    glideY(el, 474, 0, { ms: glideMs(474) });
    // The first frame came 130 ms late on a busy page: until then the whole way is still to go.
    expect(drawnY(el, 130)).toBe(474);
    // Drawn from 130 on: counted from there, not from when it was made.
    anim.startTime = 130;
    expect(drawnY(el, 130 + 60)).toBeCloseTo(glideLeft(474, 60, glideMs(474)));
    expect(drawnY(el, 130 + 60)).toBeGreaterThan(glideLeft(474, 190, glideMs(474)) + 30);
    // The next change carries on from there too.
    const made: Keyframe[][] = [];
    (el as unknown as { animate: (f: Keyframe[]) => unknown }).animate = (f: Keyframe[]) => (made.push(f), { ...anim, startTime: null });
    glideY(el, 10, 130 + 60);
    expect(made[0][0]).toEqual({ translate: `0 ${(10 + glideLeft(474, 60, glideMs(474))).toFixed(2)}px` });
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

describe('a removed middle row (QueueTray glideTray)', () => {
  it("its words are gone before the row coming down reaches them", () => {
    const t = clearFor(28, 13);
    // Until then the row above has come less than a row's height less the ink: no overlap.
    expect(28 - glideLeft(28, t)).toBeLessThanOrEqual(15.01);
    expect(28 - glideLeft(28, t + 4)).toBeGreaterThan(15);
    // A few frames, never the 80 ms that overlapped.
    expect(t).toBeGreaterThan(30);
    expect(t).toBeLessThan(60);
    expect(clearFor(28, 30)).toBe(0);
    expect(clearFor(28, 0)).toBe(STACK_MS);
  });
});

it('binds each identical queue expectation once and defers its reorder until the row arrives', async () => {
  const { bindRow, keyOf, withExpected, acknowledgedOrder } = await import('../src/features/composer/queue-rows');
  const make = (id: string) => ({ id, submitId: id, text: 'same', createdAt: 0 });
  const waiting: import('../src/features/composer/queue-rows').ExpectedRow[] = ['a', 'b'].map(id => ({ pid: 'expect:' + id, submitId: id, text: 'same' }));
  const a = make('a'), b = make('b');
  expect(withExpected([a], waiting.slice(0, 1))).toEqual([a]);
  waiting[0].bound = bindRow(waiting[0], [a]);
  const provisional = withExpected([a], waiting)[1];
  expect(withExpected([b], waiting)).toEqual([b]);
  expect(keyOf(provisional)).toBe(keyOf(b));
  expect(keyOf(a)).not.toBe(keyOf(b));
  expect(acknowledgedOrder([provisional, a], [a])).toBeNull();
  expect(acknowledgedOrder([provisional, a], [a, b])).toEqual(['b', 'a']);
});
