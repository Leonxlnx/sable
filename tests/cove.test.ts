import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { liquidAt, planLiquid, frameBounds, type LiquidSpec } from '../src/features/composer/liquid-shape';

/**
 * The cove of the composer is one static outline written as numbers in composer.css (a CSS
 * `shape()` cannot compute a tangent). These tests derive the numbers again from the three that
 * are chosen (the key, the channel, where the straight edges end) and compare, so a change of one
 * of them cannot leave the pane, its rim and its shadows on different curves.
 */

const css = readFileSync(new URL('../src/features/composer/composer.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = css.slice(css.indexOf('/* cove:begin */'), css.indexOf('/* cove:end */'));
const prop = (name: string) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`--${name} is missing`);
  return m[1];
};
const px = (name: string) => parseFloat(prop(name));
/** Every "calc(100% - Npx)" and "Npx" of a shape, as numbers in order. */
const numbers = (shape: string) => [...shape.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
/** The arcs of a shape: where each ends (from the corner) and its radius. */
const arcs = (shape: string) => [...shape.matchAll(/arc to calc\(100% - ([\d.]+)px\) (?:calc\(100% - ([\d.]+)px\)|100%) of ([\d.]+)px (cw|ccw)/g)].map((m) => ({ x: Number(m[1]), y: m[2] === undefined ? 0 : Number(m[2]), r: Number(m[3]), dir: m[4] }));

const key = px('cove-key');
const gap = px('cove-gap');
const cut = px('cove-cut');
const kr = key / 2;
const C = kr + gap;
const T = cut - kr;
// The horn's rounding: a circle tangent to the straight edge (where the edge ends) and to the cove.
const f = (T * T + kr * kr - C * C) / (2 * (C + kr));
const ux = (kr - f) / (C + f);
const uy = T / (C + f);
const meet = (c: number) => ({ a: kr - c * ux, b: kr + c * uy });

/** One length of a shape (`100%`, `Npx`, `var(--rim-w)`, a `calc()` of them) on a box `size` long. */
function length(e: string, size: number, w: number): number {
  const flat = e.replace(/var\(--rim-w\)/g, `${w}px`).replace(/100%/g, `${size}px`).replace(/calc\(|\)/g, '');
  const parts = flat.trim().split(/\s+/);
  let v = parseFloat(parts[0]);
  for (let i = 1; i < parts.length; i += 2) v += (parts[i] === '-' ? -1 : 1) * parseFloat(parts[i + 1]);
  return v;
}

/** Splits at top-level separators (outside parentheses). */
function split(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface Arc {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  r: number;
}

/**
 * Walks a `shape()` on a box W by H with the rim `w` wide: every point it reaches, its straight
 * lines (where they run) and its arcs with their centres (y down; a clockwise arc turns right, so
 * its centre lies to the right of the chord).
 */
function walk(shape: string, W: number, H: number, w: number) {
  const body = shape.slice(shape.indexOf('(') + 1, shape.lastIndexOf(')'));
  let p = { x: 0, y: 0 };
  let start = p;
  const points: { x: number; y: number }[] = [];
  const lines: { kind: 'h' | 'v'; at: number }[] = [];
  const arcList: Arc[] = [];
  for (const cmd of split(body, ',')) {
    const t = split(cmd, ' ');
    if (t[0] === 'from') {
      p = start = { x: length(t[1], W, w), y: length(t[2], H, w) };
    } else if (t[0] === 'hline') {
      lines.push({ kind: 'h', at: p.y });
      p = { x: length(t[2], W, w), y: p.y };
    } else if (t[0] === 'vline') {
      lines.push({ kind: 'v', at: p.x });
      p = { x: p.x, y: length(t[2], H, w) };
    } else if (t[0] === 'arc') {
      const b = { x: length(t[2], W, w), y: length(t[3], H, w) };
      const r = length(t[5], W, w);
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const d = Math.hypot(dx, dy);
      const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
      const side = t[6] === 'cw' ? 1 : -1;
      arcList.push({ x0: p.x, y0: p.y, cx: (p.x + b.x) / 2 + (side * h * -dy) / d, cy: (p.y + b.y) / 2 + (side * h * dx) / d, r });
      p = b;
    } else if (t[0] === 'close') continue;
    else throw new Error(`unknown command ${cmd}`);
    points.push(p);
  }
  return { start, end: p, points, lines, arcs: arcList };
}

describe('the cove', () => {
  it('holds a key of the pane’s own corner radius, in the card’s corner', () => {
    const card = /\.cmp-card \{[^}]*border-radius: (\d+)px;/s.exec(css);
    expect(Number(card?.[1])).toBe(kr);
    const keys = /\.cmp-keys \{[^}]*width: (\d+)px;[^}]*height: (\d+)px;/s.exec(css);
    expect([Number(keys?.[1]), Number(keys?.[2])]).toEqual([key, key]);
    // The cove's disc is the key's with the channel all round, and reaches that far past the corner.
    expect(px('cove-disc')).toBeCloseTo(C * 2, 3);
    expect(px('cove-disc-out')).toBeCloseTo(-gap, 3);
  });

  it('ends its straight edges on whole pixels (the rim there is a ring on whole pixels)', () => {
    expect(Number.isInteger(cut)).toBe(true);
    // One family of corners: a horn is the pane's own corner, so the straight edge ends a corner,
    // the cove and a corner from the card's corner, and the cove is exactly a quarter circle.
    expect(f).toBeCloseTo(kr, 6);
    expect(cut).toBe(kr + C + kr);
    expect(meet(C)).toEqual({ a: expect.closeTo(kr, 6), b: expect.closeTo(C + kr, 6) });
  });

  it('nests what stands on the last line in its corners: the same 6 as the channel', () => {
    // The attach disc in the bottom-left corner and the last chip's round end in the base horn:
    // discs of 14 (a 28 px line) whose centres are the corners' own, 6 in from the pane's edge.
    const pad = /\.cmp-card \{[^}]*padding: 10px (\d+)px (\d+)px;/s.exec(css);
    expect([Number(pad?.[1]), Number(pad?.[2])]).toEqual([gap, gap]);
    const bar = /\.cmp-bar \{[^}]*height: (\d+)px;[^}]*padding-right: (\d+)px;/s.exec(css);
    const line = Number(bar?.[1]);
    expect(line / 2).toBe(kr - gap);
    // The line's centre is the key's, and it ends where the cove begins plus the channel.
    expect(gap + line / 2).toBe(kr);
    expect(Number(bar?.[2])).toBe(kr + C);
    // So the last chip's end is a disc about the base horn's centre (cut from the corner, kr up).
    expect(gap + Number(bar?.[2]) + line / 2).toBe(cut);
  });

  it('draws the pane on the derived curve: horn, cove, horn, each tangent to the next', () => {
    const [h1, cove, h2] = arcs(prop('cove-pane'));
    const p = meet(C);
    expect(h1.r).toBeCloseTo(f, 2);
    expect(h2.r).toBeCloseTo(f, 2);
    expect(cove.r).toBeCloseTo(C, 3);
    expect(cove.dir).toBe('ccw');
    expect([h1.x, h1.y]).toEqual([expect.closeTo(p.a, 2), expect.closeTo(p.b, 2)]);
    expect([cove.x, cove.y]).toEqual([expect.closeTo(p.b, 2), expect.closeTo(p.a, 2)]);
    // That point is on the cove (C from the key's centre) and on the horn's circle (f from its centre).
    expect(Math.hypot(h1.x - kr, h1.y - kr)).toBeCloseTo(C, 2);
    expect(Math.hypot(h1.x - f, h1.y - cut)).toBeCloseTo(f, 2);
    // And the horn's circle touches the cove from outside.
    expect(Math.hypot(kr - f, T)).toBeCloseTo(C + f, 6);
  });

  // The rim is a band between the outline and the same outline the rim's width in (tokens.css
  // --rim-w: 1px, or two device pixels where 1px is less: 1.6px at 125%, 1.3333px at 150%).
  // Walked as real paths on a one-line docked pane, at each of those widths.
  const W = 760;
  const H = 90;
  const widths = [1, 1.6, 1.3333, 1.8182, 1.1429];

  it('draws the cove’s rim between that curve and the same curve the rim’s width inside the pane', () => {
    for (const w of widths) {
      const band = walk(prop('cove-band'), W, H, w);
      const outer = band.arcs.slice(0, 3);
      const inner = band.arcs.slice(3);
      expect(outer.map((a) => a.r)).toEqual([expect.closeTo(f, 2), expect.closeTo(C, 3), expect.closeTo(f, 2)]);
      // The inner curve is the outer one offset: the same centres, taken in the other direction,
      // the horns' radii less the width and the cove's more.
      expect(inner.map((a) => a.r)).toEqual([expect.closeTo(f - w, 3), expect.closeTo(C + w, 3), expect.closeTo(f - w, 3)]);
      inner.forEach((a, i) => expect([a.cx, a.cy]).toEqual([expect.closeTo(outer[2 - i].cx, 2), expect.closeTo(outer[2 - i].cy, 2)]));
      // The cove's centre is the key's.
      expect([outer[1].cx, outer[1].cy]).toEqual([expect.closeTo(W - kr, 3), expect.closeTo(H - kr, 3)]);
      // Inner horn and inner cove still meet on the line between their centres, the width further out.
      const q = meet(C + w);
      expect([W - inner[1].x0, H - inner[1].y0]).toEqual([expect.closeTo(q.b, 2), expect.closeTo(q.a, 2)]);
    }
  });

  it('draws the rest of the rim as a path of the same kind, meeting the cove’s band where it begins', () => {
    for (const w of widths) {
      const rest = walk(prop('rim-rest'), W, H, w);
      const outer = rest.arcs.slice(0, 3);
      const inner = rest.arcs.slice(3);
      // The three plain corners: the pane's own radius, about the pane's own corner centres.
      expect(outer.map((a) => [a.cx, a.cy, a.r])).toEqual([
        [expect.closeTo(W - kr, 3), expect.closeTo(kr, 3), expect.closeTo(kr, 3)],
        [expect.closeTo(kr, 3), expect.closeTo(kr, 3), expect.closeTo(kr, 3)],
        [expect.closeTo(kr, 3), expect.closeTo(H - kr, 3), expect.closeTo(kr, 3)],
      ]);
      inner.forEach((a, i) => {
        expect([a.cx, a.cy]).toEqual([expect.closeTo(outer[2 - i].cx, 2), expect.closeTo(outer[2 - i].cy, 2)]);
        expect(a.r).toBeCloseTo(kr - w, 3);
      });
      // Its straight edges are the width wide: every inner line stands w in from the outer one.
      expect(rest.lines.filter((l) => l.kind === 'h').map((l) => l.at)).toEqual([0, H, H - w, w].map((v) => expect.closeTo(v, 3)));
      expect(rest.lines.filter((l) => l.kind === 'v').map((l) => l.at)).toEqual([W, 0, W - cut, w, W - w].map((v) => expect.closeTo(v, 3)));
      // The two bands share their ends: the cut on the right edge and on the bottom edge, outside and inside.
      const band = walk(prop('cove-band'), W, H, w);
      const ends = (p: { x: number; y: number }[]) => p.map((q) => [Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000].join());
      expect(ends([rest.start, rest.points.find((p) => p.y === H && p.x === W - cut)!, rest.points.find((p) => p.y === H - w && p.x === W - cut)!, rest.end])).toEqual(
        ends([band.start, band.points.find((p) => p.y === H && p.x === W - cut)!, band.points.find((p) => p.y === H - w && p.x === W - cut)!, band.end]),
      );
      expect(rest.end).toEqual({ x: expect.closeTo(W - w, 3), y: expect.closeTo(H - cut, 3) });
    }
  });

  it('uses the same curve for what is not the pane, and the same cut for the straight parts', () => {
    const pane = arcs(prop('cove-pane'));
    expect(pane.length).toBe(3);
    expect(arcs(prop('cove-notch')).slice(0, 3)).toEqual(pane);
    expect(numbers(prop('cove-rest')).filter((n) => n === cut).length).toBe(4);
    // The shade's discs: the horns' as large as their rounding, standing where the edges end.
    expect(px('horn-disc')).toBeCloseTo(f * 2, 2);
    expect(px('horn-at')).toBeCloseTo(cut - f, 2);
  });
});

describe('the drop leaves from the key', () => {
  // A docked composer: the key's top point in the card's corner, the message landing above it.
  const spec: LiquidSpec = { from: { x: 1138, y: 742, edge: true, r: 20 }, to: { left: 852, top: 568, width: 306, height: 43, radii: [18, 18, 6, 18] }, kind: 'bubble' };
  const plan = planLiquid(spec);

  it('starts behind the key’s disc, whole, and rises straight up out of its top', () => {
    const r = spec.from.r!;
    const centre = { x: spec.from.x, y: spec.from.y + r };
    // Hidden at its birth: all of it inside the disc.
    expect(Math.hypot(plan.start.x - centre.x, plan.start.y - centre.y) + plan.r).toBeLessThan(r);
    const d = liquidAt(plan, plan.launch + 4).drop!;
    expect(d.x).toBeCloseTo(spec.from.x, 0);
    expect(d.y).toBeLessThan(spec.from.y);
  });

  it('is tied to the key until the thread parts, and the key keeps no swell of its own', () => {
    for (let t = plan.born + 2; t < plan.snap + 90; t += 6) {
      const f = liquidAt(plan, t);
      expect(f.edge?.r).toBe(20);
      expect(f.edge?.bob).toBe(0);
      // The collar stays near the neck: well inside the key's width.
      expect(f.edge!.k).toBeLessThan(plan.r);
    }
    expect(liquidAt(plan, plan.snap + 110).edge).toBeUndefined();
  });

  it('draws round the key’s shoulders, never over its face', () => {
    const b = frameBounds(liquidAt(plan, plan.launch))!;
    expect(b.y1).toBeLessThanOrEqual(spec.from.y + 20 * 0.6);
    expect(b.y1).toBeGreaterThan(spec.from.y);
  });
});
