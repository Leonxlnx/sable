import { describe, expect, it } from 'vitest';
import {
  BAR_LEAVES,
  between,
  BORN,
  COLLAPSE,
  collapseEase,
  farthest,
  FILL_HANDOVER,
  fillAt,
  footAt,
  headAt,
  INK,
  linearEasing,
  meetX,
  planSignal,
  radiusAt,
  rimAt,
  shiftAt,
  shiftEase,
  signalBounds,
  tracePath,
  type SignalSpec,
} from '../src/features/composer/signal-shape';
import { ARROW_OUT_AT } from '../src/features/composer/launch';

// A docked composer at 1280 x 800 whose message lands just above it, the first message from home
// rising to the top of the column, a long message, a queue row, and a queued message leaving its row.
const card = { radii: [18, 18, 6, 18] as [number, number, number, number] };
const idle: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 852, top: 568, width: 306, height: 43, ...card }, kind: 'bubble' };
const home: SignalSpec = { from: { x: 1138, y: 430, edge: true, r: 20 }, to: { left: 852, top: 66, width: 306, height: 43, ...card }, kind: 'bubble', bar: { dx: 0, dy: 280 } };
const tall: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 550, top: 300, width: 608, height: 226, ...card }, kind: 'bubble' };
const wide: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 400, top: 560, width: 760, height: 66, ...card }, kind: 'bubble' };
const row: SignalSpec = { from: { x: 1138, y: 733, edge: true, r: 20 }, to: { left: 404, top: 649, width: 748, height: 28, radii: [14, 14, 14, 14] }, kind: 'row' };
const free: SignalSpec = { from: { x: 700, y: 663, edge: false }, to: idle.to, kind: 'bubble' };
const steer: SignalSpec = { ...idle, tone: 0.6 };
const bubbles = [['idle', idle], ['home', home], ['tall', tall], ['wide', wide], ['free', free]] as const;

/** The longest the key's handler and the first frame may take: readable within 240 ms of the press needs the words by 240 minus this. */
const PRESS_TO_ZERO = 40;

describe('the field’s words go in place', () => {
  it('a quarter of the dither at a time, the first before the first frame, all within about 60 ms', () => {
    const p = planSignal(idle);
    expect(p.dissolve[0]).toBeLessThan(16);
    for (let i = 1; i < 4; i++) expect(p.dissolve[i]).toBeGreaterThanOrEqual(p.dissolve[i - 1] + 16);
    expect(p.dissolve[3]).toBeLessThanOrEqual(64);
  });
});

describe('the line grows out of the key', () => {
  it('in the press’s first frame, with the arrow', () => {
    const p = planSignal(idle);
    expect(p.born).toBe(BORN);
    expect(p.born).toBeLessThan(16);
    expect(ARROW_OUT_AT).toBeLessThan(16);
    // The first frame shows it a few px out of the key already.
    expect(headAt(p, 16)).toBeGreaterThan(4);
  });

  for (const [name, spec] of bubbles) {
    it(`${name}: its foot stays on the key until the head has arrived, then follows it into the card`, () => {
      const p = planSignal(spec);
      for (let t = 0; t <= p.end; t++) {
        expect(footAt(p, t)).toBeLessThanOrEqual(headAt(p, t) + 1e-9);
        if (t <= p.land && !spec.bar) expect(footAt(p, t)).toBe(0);
      }
      expect(headAt(p, p.land)).toBeCloseTo(p.reach, 6);
      expect(footAt(p, p.taken)).toBeCloseTo(p.reach, 6);
      expect(p.taken).toBeLessThan(p.end);
    });

    it(`${name}: the head never jumps or goes back`, () => {
      const p = planSignal(spec);
      let last = 0;
      for (let t = p.born; t <= p.land; t++) {
        const s = headAt(p, t);
        expect(s).toBeGreaterThanOrEqual(last);
        // At most under half the way in one frame: it is seen travelling, never teleporting.
        expect(s - headAt(p, t - 16)).toBeLessThanOrEqual(p.reach * 0.45);
        last = s;
      }
    });
  }

  it('lets go of the key before the home bar leaves with it', () => {
    const p = planSignal(home);
    expect(p.release).toBeLessThanOrEqual(BAR_LEAVES);
    expect(BAR_LEAVES).toBeGreaterThan(BORN);
    expect(BAR_LEAVES).toBeLessThan(COLLAPSE);
  });

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

  it('is drawn whole between its foot and its head, round the bend', () => {
    const p = tracePath(free.from, free.to);
    const part = between(p, 10, 70);
    expect(part[0]).toEqual({ x: 700, y: 653 });
    expect(part).toContainEqual({ x: 700, y: 611 });
    expect(part[part.length - 1].y).toBe(611);
    expect(between(p, 30, 30)).toEqual([]);
  });

  it('draws within its region and never over the key’s face', () => {
    for (const spec of [idle, home, tall, row]) {
      const b = signalBounds(planSignal(spec), 0);
      expect(b.top + b.height).toBeLessThanOrEqual(Math.ceil(spec.from.y));
      expect(b.top).toBeLessThanOrEqual(spec.to.top);
    }
  });
});

describe('the card opens out of where the line arrives', () => {
  for (const [name, spec] of bubbles) {
    it(`${name}: one growing shape from the point of arrival to the farthest corner`, () => {
      const p = planSignal(spec);
      const at = p.path[p.path.length - 1];
      expect(radiusAt(p, p.land)).toBe(0);
      let last = 0;
      for (let t = p.land; t <= p.close; t++) {
        const r = radiusAt(p, t);
        expect(r).toBeGreaterThanOrEqual(last);
        last = r;
      }
      expect(radiusAt(p, p.close)).toBeCloseTo(p.rmax, 6);
      // The dithered edge has cleared the farthest corner by then.
      expect(p.rmax).toBeGreaterThan(farthest(spec.to, at) + 12);
    });

    it(`${name}: the words stand whole once the shape holds them, readable within 240 ms of the press`, () => {
      const p = planSignal(spec);
      expect(p.words[1] - p.words[0]).toBe(16);
      expect(p.words[0]).toBeGreaterThan(p.land);
      expect(radiusAt(p, p.words[1])).toBeGreaterThan(0.9 * p.rmax);
      expect(p.words[1]).toBeLessThanOrEqual(240 - PRESS_TO_ZERO);
    });

    it(`${name}: something of the send is on screen in every frame from the press to the card`, () => {
      const p = planSignal(spec);
      for (let t = 0; t <= p.hand; t++) {
        const words = t < p.dissolve[3];
        const line = headAt(p, t) - footAt(p, t) > 0.5;
        const shape = radiusAt(p, t) > 0;
        expect(words || line || shape).toBe(true);
      }
    });

    it(`${name}: the canvas’s well hands over to the card’s own in three frames, its hot hairline cools away by the end`, () => {
      const p = planSignal(spec);
      expect(fillAt(p, p.land)).toBeCloseTo(INK.a, 6);
      expect(fillAt(p, p.fill[0])).toBeCloseTo(INK.a, 6);
      expect(fillAt(p, p.fill[1])).toBe(0);
      expect(p.fill[1] - p.fill[0]).toBe(FILL_HANDOVER);
      expect(FILL_HANDOVER).toBeGreaterThanOrEqual(48);
      expect(p.hand).toBe(p.fill[1]);
      expect(rimAt(p, p.land)).toBeGreaterThan(0.8);
      expect(rimAt(p, p.close)).toBeGreaterThan(0.8);
      expect(rimAt(p, p.end)).toBe(0);
    });
  }

  it('a send in a chat is done in about 300 ms', () => {
    const p = planSignal(idle);
    expect(p.end).toBeGreaterThanOrEqual(260);
    expect(p.end).toBeLessThanOrEqual(340);
  });

  it('a steer opens at the waiting tone', () => {
    const p = planSignal(steer);
    expect(fillAt(p, p.land)).toBeCloseTo(INK.a * 0.6, 6);
    expect(rimAt(p, p.land)).toBeCloseTo(rimAt(planSignal(idle), p.land) * 0.6, 6);
  });

  it('a queue row has no well and is done sooner', () => {
    const p = planSignal(row);
    expect(p.fill).toEqual([]);
    expect(fillAt(p, p.land + 20)).toBe(0);
    expect(p.hand).toBeLessThan(planSignal(wide).hand);
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
