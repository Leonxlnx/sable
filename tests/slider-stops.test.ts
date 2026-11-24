import { describe, expect, it } from 'vitest';
import { cubicBezier, holdX, nearestStop, settleAt, settleEase, settleMs, stopKey, stopX, wordLeft } from '../src/ui/stops';

// The stop slider's pure rules (src/ui/stops.ts): where stops stand, which stop a thumb is
// nearest, what a key does, where the word stands and how long a settle takes.

const W = 200;
const T = 14;

describe('stopX', () => {
  it('puts the first stop one radius in and the last one radius short of the end', () => {
    expect(stopX(0, 5, W, T)).toBe(7);
    expect(stopX(4, 5, W, T)).toBe(193);
  });
  it('spaces the stops evenly', () => {
    const xs = [0, 1, 2, 3, 4].map((i) => stopX(i, 5, W, T));
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    for (const g of gaps) expect(g).toBeCloseTo(46.5, 6);
  });
  it('holds an index outside the scale to its ends', () => {
    expect(stopX(-3, 5, W, T)).toBe(stopX(0, 5, W, T));
    expect(stopX(9, 5, W, T)).toBe(stopX(4, 5, W, T));
  });
  it('a scale of one stop or none stands at the start', () => {
    expect(stopX(0, 1, W, T)).toBe(7);
    expect(stopX(0, 0, W, T)).toBe(7);
  });
  it('a track narrower than the thumb keeps every stop at the start', () => {
    expect(stopX(3, 5, 10, T)).toBe(7);
  });
});

describe('holdX', () => {
  it('follows the pointer between the ends (1:1)', () => {
    expect(holdX(50, W, T)).toBe(50);
    expect(holdX(123.25, W, T)).toBe(123.25);
  });
  it('never lets the thumb leave the track', () => {
    expect(holdX(-40, W, T)).toBe(7);
    expect(holdX(500, W, T)).toBe(193);
  });
});

describe('nearestStop', () => {
  it('is each stop at its own place', () => {
    for (let i = 0; i < 5; i++) expect(nearestStop(stopX(i, 5, W, T), 5, W, T)).toBe(i);
  });
  it('changes exactly at the midpoint, a tie going up', () => {
    const mid = (stopX(1, 5, W, T) + stopX(2, 5, W, T)) / 2;
    expect(nearestStop(mid - 0.01, 5, W, T)).toBe(1);
    expect(nearestStop(mid, 5, W, T)).toBe(2);
  });
  it('holds a pointer past either end to that end', () => {
    expect(nearestStop(-100, 5, W, T)).toBe(0);
    expect(nearestStop(900, 5, W, T)).toBe(4);
  });
  it('a scale of one stop or none is always 0', () => {
    expect(nearestStop(150, 1, W, T)).toBe(0);
    expect(nearestStop(150, 0, W, T)).toBe(0);
  });
});

describe('stopKey', () => {
  it('steps down with Left, Down and Page Down', () => {
    for (const k of ['ArrowLeft', 'ArrowDown', 'PageDown']) expect(stopKey(k, 2, 5)).toBe(1);
  });
  it('steps up with Right, Up and Page Up', () => {
    for (const k of ['ArrowRight', 'ArrowUp', 'PageUp']) expect(stopKey(k, 2, 5)).toBe(3);
  });
  it('jumps to the ends with Home and End', () => {
    expect(stopKey('Home', 3, 5)).toBe(0);
    expect(stopKey('End', 1, 5)).toBe(4);
  });
  it('holds at an end, never wraps', () => {
    expect(stopKey('ArrowLeft', 0, 5)).toBe(0);
    expect(stopKey('ArrowRight', 4, 5)).toBe(4);
  });
  it('from no value set, any step lands on the first stop', () => {
    expect(stopKey('ArrowRight', -1, 5)).toBe(0);
    expect(stopKey('ArrowLeft', -1, 5)).toBe(0);
    expect(stopKey('End', -1, 5)).toBe(4);
  });
  it('answers no other key, and nothing on an empty scale', () => {
    expect(stopKey('Enter', 2, 5)).toBeNull();
    expect(stopKey('a', 2, 5)).toBeNull();
    expect(stopKey('ArrowLeft', 0, 0)).toBeNull();
  });
});

describe('wordLeft', () => {
  it('centres the word on the thumb', () => {
    expect(wordLeft(100, 40, W)).toBe(80);
  });
  it('holds the word inside the track at both ends', () => {
    expect(wordLeft(7, 40, W)).toBe(0);
    expect(wordLeft(193, 40, W)).toBe(160);
  });
  it('a word wider than the track starts at its left edge', () => {
    expect(wordLeft(100, 260, W)).toBe(0);
  });
});

describe('settleMs', () => {
  it('stays between 120 and 160 ms', () => {
    expect(settleMs(0)).toBe(120);
    expect(settleMs(10)).toBe(132);
    expect(settleMs(-10)).toBe(132);
    expect(settleMs(1000)).toBe(160);
  });
});

describe('settleAt: one clock for the thumb, the fill and the word', () => {
  it('starts where the thumb stood and ends exactly on the stop', () => {
    expect(settleAt(10, 100, 0, 140, 0)).toEqual({ x: 10, done: false });
    expect(settleAt(10, 100, 0, 140, 140)).toEqual({ x: 100, done: true });
    expect(settleAt(10, 100, 0, 140, 500)).toEqual({ x: 100, done: true });
  });
  it('has moved a good part of the way by the first frame (16 ms of 140)', () => {
    const { x } = settleAt(0, 100, 0, 140, 16);
    expect(x).toBeGreaterThan(15);
  });
  it('goes a hair past the stop and comes back, never more than 8 %', () => {
    let top = 0;
    for (let t = 0; t <= 140; t += 2) top = Math.max(top, settleAt(0, 100, 0, 140, t).x);
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(108);
  });
  it('works the other way the same', () => {
    let low = 100;
    for (let t = 0; t <= 140; t += 2) low = Math.min(low, settleAt(100, 0, 0, 140, t).x);
    expect(low).toBeLessThan(0);
    expect(low).toBeGreaterThan(-8);
  });
  it('a cubic-bezier is 0 and 1 at its ends and follows the linear one for (0,0,1,1)', () => {
    const lin = cubicBezier(0, 0, 1, 1);
    for (const p of [0.1, 0.5, 0.9]) expect(lin(p)).toBeCloseTo(p, 4);
    expect(settleEase(0)).toBe(0);
    expect(settleEase(1)).toBe(1);
  });
});
