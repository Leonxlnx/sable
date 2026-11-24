import { describe, expect, it } from 'vitest';
import { tailGlide, tailPlace } from '../src/features/timeline/follow';
import { frameContent } from '../src/features/genui/WidgetFrame';

/**
 * Day 7: "x sub-agents working" jumps when a chat is opened. Measured in the packaged app (scratch/day7/tail,
 * rb2-cold): a widget above the line was drawn again with the chat, dropped from its remembered 396 px to
 * 34 and grew back; the view kept the end each frame, but the line's glide read every change as a move and
 * threw it 467 px down and 533 px up while it stood still.
 */
describe('the conversation’s last line keeps its place', () => {
  const CH = 776;

  it('does not glide while the view keeps the end and a height above it changes', () => {
    // The heights of rb2-cold, frame by frame: the widget's turn 609 -> 247 -> 536 -> 584 -> 601 -> 607 -> 609.
    const base = 131_900;
    const sh0 = 132_140;
    const turn = [609, 247, 536, 584, 601, 607, 609];
    let prev: { place: number; stuck: boolean } | null = null;
    const glides: number[] = [];
    const old: number[] = [];
    let oldTop: number | null = null;
    for (const h of turn) {
      const off = base + (h - 609);
      const sh = sh0 + (h - 609);
      const place = tailPlace(off, true, sh, CH);
      glides.push(tailGlide(prev, place, true));
      prev = { place, stuck: true };
      // What the line's top in the content (the old measure) said.
      if (oldTop !== null) old.push(oldTop - off);
      oldTop = off;
    }
    expect(glides.every((g) => g === 0)).toBe(true);
    // The old measure called the first change a 362 px move.
    expect(old[0]).toBe(362);
  });

  it('glides when a conversation shorter than the view pushes it down', () => {
    const a = tailPlace(300, true, 500, CH);
    const b = tailPlace(360, true, 560, CH);
    expect(tailGlide({ place: a, stuck: true }, b, true)).toBe(-60);
  });

  it('measures from the top while the reader is away from the end, and a change of measure is no move', () => {
    expect(tailPlace(5000, false, 9000, CH)).toBe(5000);
    expect(tailGlide({ place: 5000, stuck: false }, 5040, false)).toBe(-40);
    expect(tailGlide({ place: tailPlace(8000, true, 9000, CH), stuck: true }, tailPlace(8000, false, 9000, CH), false)).toBe(0);
    expect(tailGlide(null, 10, true)).toBe(0);
  });

  it('goes on from where a glide under way has drawn it', () => {
    // Drawn 30 px above its old place, and the new place is 20 px below the old one: 50 px to travel.
    expect(tailGlide({ place: 100, stuck: false }, 120, false, -30)).toBe(-50);
    expect(tailGlide({ place: 100, stuck: false }, 101, false)).toBe(0);
    expect(tailGlide({ place: 100, stuck: false }, 700, false)).toBe(0);
  });
});

describe('a widget drawn again keeps its height until it is measured', () => {
  it('never takes the empty frame’s height reported before the code is drawn', () => {
    // Mount with the remembered height, the empty page's 18 px, the render, then the measured 394.
    let floor = 0;
    const seen: number[] = [];
    const step = (settled: boolean, h: number | null) => {
      const r = frameContent({ off: false, settled, h, floor, reserve: 394 });
      floor = r.floor;
      seen.push(r.content);
    };
    step(false, null);
    step(false, 18);
    // The final render is reported; its height is not measured yet.
    step(false, 18);
    step(true, 394);
    expect(seen).toEqual([394, 394, 394, 394]);
  });

  it('keeps its height while a script-drawn widget measures its bare page first (a busy page)', () => {
    // ra-runwarm: drawn, measured 18 px, then 394 px some 300 ms later once its script had drawn it.
    let floor = 0;
    const seen: number[] = [];
    for (const [settled, h] of [[false, null], [false, 18], [true, 18], [true, 18], [true, 394]] as const) {
      const r = frameContent({ off: false, settled, h, floor, reserve: 394 });
      floor = r.floor;
      seen.push(r.content);
    }
    expect(seen).toEqual([394, 394, 394, 394, 394]);
    expect(floor).toBe(394);
  });

  it('holds a settled widget through 400, 40, 400 and a new smaller candidate', () => {
    let floor = 0;
    const frame = (h: number, shrink = false) => {
      const size = frameContent({ settled: true, off: false, h, reserve: 160, floor, shrink });
      floor = size.floor;
      return size.content;
    };
    expect([frame(400), frame(40), frame(400), frame(80), frame(70), frame(70, true)]).toEqual([400, 400, 400, 400, 400, 70]);
    expect([frame(400), frame(70)]).toEqual([400, 400]);
  });

  it('takes its measured height once drawn: taller at once, smaller once that height has stayed', () => {
    expect(frameContent({ off: false, settled: true, h: 450, floor: 200, reserve: 200 })).toEqual({ content: 450, floor: 450 });
    expect(frameContent({ off: false, settled: true, h: 150, floor: 200, reserve: 200 })).toEqual({ content: 200, floor: 200 });
    const r = frameContent({ off: false, settled: true, h: 150, floor: 200, reserve: 200, shrink: true });
    expect(r).toEqual({ content: 150, floor: 150 });
    expect(frameContent({ off: true, settled: false, h: null, floor: 0, reserve: 160 }).content).toBe(52);
  });
});
