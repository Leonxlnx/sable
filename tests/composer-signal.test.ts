import { describe, expect, it } from 'vitest';
import {
  BAR_LEAVES,
  BORN,
  COLLAPSE,
  collapseEase,
  coolAt,
  ditherOn,
  headAt,
  linearEasing,
  meetX,
  outline,
  outlineLength,
  planSignal,
  shiftAt,
  shiftEase,
  signalBounds,
  tailAt,
  TAIL,
  tracePath,
  type SignalSpec,
} from '../src/features/composer/signal-shape';
import { RELEASE } from '../src/features/composer/flight';
import { ARROW_OUT_MS } from '../src/features/composer/launch';

// A docked composer at 1280 x 800 whose message lands just above it, the first message from home
// rising to the top of the column, a long message, a queue row, and a queued message leaving its row.
const card = { radii: [18, 18, 6, 18] as [number, number, number, number] };
const idle: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 852, top: 568, width: 306, height: 43, ...card }, kind: 'bubble' };
const home: SignalSpec = { from: { x: 1138, y: 430, edge: true, r: 20 }, to: { left: 852, top: 66, width: 306, height: 43, ...card }, kind: 'bubble', bar: { dx: 0, dy: 280 } };
const tall: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 550, top: 300, width: 608, height: 226, ...card }, kind: 'bubble' };
const row: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 404, top: 649, width: 748, height: 28, radii: [14, 14, 14, 14] }, kind: 'row' };
const free: SignalSpec = { from: { x: 700, y: 663, edge: false }, to: idle.to, kind: 'bubble' };

describe('the field’s words go in place', () => {
  it('a quarter of the dither at a time, the first before the first frame, all within about 90 ms', () => {
    const p = planSignal(idle);
    expect(p.dissolve[0]).toBeLessThan(16);
    for (let i = 1; i < 4; i++) expect(p.dissolve[i]).toBeGreaterThan(p.dissolve[i - 1] + 16);
    expect(p.dissolve[3]).toBeLessThanOrEqual(90);
  });

  it('are gone before the line leaves the key’s top, and the line leaves as the arrow does', () => {
    const p = planSignal(idle);
    expect(p.born).toBe(BORN);
    expect(p.born).toBeGreaterThanOrEqual(RELEASE);
    expect(p.born).toBeLessThan(RELEASE + ARROW_OUT_MS);
  });
});

describe('signal beats', () => {
  for (const [name, spec] of [['idle', idle], ['home', home], ['tall', tall], ['free', free]] as const) {
    it(`${name}: leaves, meets the card, closes, resolves and ends in order, readable within 300 ms`, () => {
      const p = planSignal(spec);
      expect(p.born).toBeLessThan(p.land);
      expect(p.land).toBeLessThan(p.close);
      expect(p.well[0]).toBeGreaterThan(p.land);
      expect(p.words[0]).toBeGreaterThan(p.well[0]);
      // Readable once half the words' cells are in (two quarters: a checker).
      expect(p.words[1]).toBeLessThanOrEqual(300);
      expect(p.hand).toBe(p.words[3]);
      expect(p.end).toBeGreaterThanOrEqual(p.close);
      expect(p.end).toBeGreaterThanOrEqual(p.hand);
      expect(p.end).toBeLessThanOrEqual(460);
    });
  }

  it('a send in a chat is done in about 380 to 450 ms', () => {
    const p = planSignal(idle);
    expect(p.end).toBeGreaterThanOrEqual(360);
    expect(p.end).toBeLessThanOrEqual(450);
  });

  it('a queue row has no well and is quicker', () => {
    const p = planSignal(row);
    expect(p.well).toEqual([]);
    expect(p.end).toBeLessThan(planSignal(idle).end);
  });

  it('the home bar leaves once the line is clear of it', () => {
    expect(BAR_LEAVES).toBeGreaterThan(BORN);
    expect(BAR_LEAVES).toBeLessThan(COLLAPSE);
  });
});

describe('the line', () => {
  it('runs straight up from the key to the card’s lower edge when the key is under the card', () => {
    const p = planSignal(idle);
    expect(p.path).toEqual([
      { x: 1138, y: 733 },
      { x: 1138, y: 611 },
    ]);
    expect(p.reach).toBeCloseTo(122, 5);
  });

  it('bends once along the card’s lower edge when it is not, meeting it clear of the corners', () => {
    const p = tracePath(free.from, free.to);
    expect(p).toHaveLength(3);
    expect(p[1]).toEqual({ x: 700, y: 611 });
    expect(p[2].y).toBe(611);
    expect(p[2].x).toBe(meetX(free.to, 700));
    expect(p[2].x).toBe(852 + 18);
  });

  it('is one motion: the head never jumps or goes back, and its speed never steps where the trace becomes the outline', () => {
    const p = planSignal(idle);
    let last = 0;
    let lastV = 0;
    for (let t = p.born; t <= p.close; t++) {
      const s = headAt(p, t);
      expect(s).toBeGreaterThanOrEqual(last);
      const v = s - last;
      if (t > p.born + 1) expect(Math.abs(v - lastV)).toBeLessThan(1.2);
      lastV = v;
      last = s;
    }
    expect(headAt(p, p.close)).toBeCloseTo(p.total, 5);
    expect(headAt(p, p.land)).toBeGreaterThanOrEqual(p.reach - 8);
  });

  it('answers in its first frame: a head 16 ms after it leaves is already out of the key', () => {
    const p = planSignal(idle);
    expect(headAt(p, p.born + 16)).toBeGreaterThan(1);
  });

  it('has a solid run behind its head, then a tail that thins in dither steps to nothing', () => {
    expect(tailAt(0)).toBe(1);
    expect(tailAt(TAIL * 0.29)).toBe(1);
    expect(tailAt(TAIL)).toBe(0);
    let shown = 0;
    let far = 0;
    for (let i = 0; i < 64; i++) {
      if (ditherOn(i, tailAt(TAIL * 0.4))) shown++;
      if (ditherOn(i, tailAt(TAIL * 0.9))) far++;
    }
    expect(shown).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });

  it('closes round the card: two heads of half the outline each, meeting at the top', () => {
    const p = planSignal(idle);
    const pts = outline(idle.to, p.path[p.path.length - 1].x);
    expect(pts.length).toBe(outlineLength(idle.to));
    expect(p.half * 2).toBe(pts.length);
    const meet = pts[Math.round(pts.length / 2)];
    expect(meet.y).toBeCloseTo(idle.to.top + 0.5, 0);
    // Every point on the card's inner hairline.
    for (const q of pts) {
      expect(q.x).toBeGreaterThanOrEqual(idle.to.left);
      expect(q.x).toBeLessThanOrEqual(idle.to.left + idle.to.width);
      expect(q.y).toBeGreaterThanOrEqual(idle.to.top);
      expect(q.y).toBeLessThanOrEqual(idle.to.top + idle.to.height);
    }
  });

  it('cools into the card’s own hairline once closed, before the end', () => {
    const p = planSignal(idle);
    expect(coolAt(p, p.close)).toBe(1);
    expect(coolAt(p, p.end)).toBe(0);
  });

  it('draws within its region and never over the key’s face', () => {
    for (const spec of [idle, home, tall, row]) {
      const b = signalBounds(planSignal(spec), 0);
      expect(b.top + b.height).toBeLessThanOrEqual(Math.ceil(spec.from.y));
      expect(b.top).toBeLessThanOrEqual(spec.to.top);
    }
  });
});

describe('late corrections', () => {
  it('move what is still to come by the difference, eased in, and add up', () => {
    const p = planSignal(idle, [{ at: 100, dx: 0, dy: -30, dur: 160 }]);
    expect(shiftAt(p, 100).y).toBeCloseTo(0, 6);
    expect(shiftAt(p, 260).y).toBeCloseTo(-30, 6);
    expect(shiftAt(p, 180).y).toBeCloseTo(-15, 6);
    p.shifts.push({ at: 200, dx: 4, dy: 0, dur: 100 });
    expect(shiftAt(p, 400)).toEqual({ x: 4, y: -30 });
  });

  it('share their curve with the card’s layer (a CSS linear() of the same ease)', () => {
    const css = linearEasing(shiftEase, 4);
    expect(css).toBe('linear(0, 0.1035, 0.5, 0.8965, 1)');
    expect(collapseEase(0)).toBe(0);
    expect(collapseEase(1)).toBeCloseTo(1, 6);
  });
});
