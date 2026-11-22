import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KEEP, SEATS, TAB_GAP, TAB_W, figure, fitRow, guestFigure, rowSeats, rowWidth, sameFit, type RowInput } from '@/features/rail/tab-row';
import { RAIL_TABS, railTabAt, railTabKeys } from '@/features/rail/tabs';

describe('side panel tabs', () => {
  it('lists every tab once, Agents fifth', () => {
    const ids = RAIL_TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['changes', 'files', 'browser', 'terminal', 'agents', 'tasks', 'context', 'device']);
  });

  it('keeps every shortcut: Agents moved up the row and is still Alt+7', () => {
    expect(railTabAt(1)).toBe('changes');
    expect(railTabAt(4)).toBe('terminal');
    expect(railTabAt(5)).toBe('tasks');
    expect(railTabAt(6)).toBe('context');
    expect(railTabAt(7)).toBe('agents');
    expect(railTabAt(8)).toBe('device');
    expect(railTabAt(9)).toBeUndefined();
    expect(railTabKeys('device')).toBe('alt+8');
    expect(railTabKeys('browser')).toBe('alt+3');
    expect(railTabKeys('agents')).toBe('alt+7');
    expect(new Set(RAIL_TABS.map((t) => t.key)).size).toBe(RAIL_TABS.length);
  });

  it('seats the five most used in the short row, Agents among them', () => {
    expect(RAIL_TABS.slice(0, SEATS).map((t) => t.id)).toEqual(['changes', 'files', 'browser', 'terminal', 'agents']);
  });
});

/** Eight tabs: Changes counts two digits (20 px), Agents and Tasks one (14 px); the longest name's box is 66 px. */
const COUNTS = [20, 0, 0, 0, 14, 14, 0, 0];
const row = (width: number, extra: Partial<RowInput> = {}): RowInput => ({ width, counts: COUNTS, longest: 66, ...extra });
/** What a fitted row takes as drawn: its tabs, More and the name's room. */
const used = (input: RowInput) => {
  const f = fitRow(input);
  return rowWidth(f.shown, input, f.counts) + (f.names ? input.longest : 0);
};

describe('the tab row for its width', () => {
  it('is all eight with a name only when the longest name fits beside them', () => {
    const all = rowWidth(8, row(0), true);
    expect(all).toBe(8 * TAB_W + 7 * TAB_GAP + 48);
    expect(fitRow(row(all + 66))).toEqual({ shown: 8, names: true, counts: true });
    // One pixel less: the tabs past the fifth go to More, the name stays.
    expect(fitRow(row(all + 65))).toEqual({ shown: 5, names: true, counts: true });
  });

  it('sheds in one order as it narrows: tabs past five, the name, the fifth and fourth tab, the figures, tabs', () => {
    const steps: string[] = [];
    let last = '';
    for (let w = 400; w >= 20; w--) {
      const f = fitRow(row(w));
      const key = `${f.shown}${f.names ? ' name' : ''}${f.counts ? ' counts' : ''}`;
      if (key !== last) steps.push(key);
      last = key;
    }
    expect(steps).toEqual(['8 name counts', '5 name counts', '5 counts', '4 counts', '3 counts', '3', '2', '1']);
  });

  it('never asks for more than the row has, down to one tab and More', () => {
    const least = TAB_W + TAB_GAP + TAB_W;
    for (let w = 400; w >= least; w--) expect(used(row(w))).toBeLessThanOrEqual(w);
  });

  it('gives back nothing it shed: narrower never shows more', () => {
    let prev = fitRow(row(400));
    for (let w = 399; w >= 20; w--) {
      const f = fitRow(row(w));
      expect(f.shown).toBeLessThanOrEqual(prev.shown);
      if (!prev.names) expect(f.names).toBe(false);
      if (!prev.counts) expect(f.counts).toBe(false);
      prev = f;
    }
  });

  it('at the default panel in the desktop app (a 219 px row) seats five and More with their figures', () => {
    expect(fitRow(row(219))).toEqual({ shown: 5, names: false, counts: true });
    // The narrowest panel (a 143 px row): three and More, the changes count still there.
    expect(fitRow(row(143))).toEqual({ shown: 3, names: false, counts: true });
    expect(KEEP).toBe(3);
    expect(SEATS).toBe(5);
  });

  it('always seats the selected tab: one from More takes the last seat, and More stays More', () => {
    expect(rowSeats(8, 5, 2)).toEqual([0, 1, 2, 3, 4]);
    // Context (the seventh) chosen from More: Agents waits in More meanwhile.
    expect(rowSeats(8, 5, 6)).toEqual([0, 1, 2, 3, 6]);
    expect(rowSeats(8, 3, 4)).toEqual([0, 1, 4]);
    expect(rowSeats(8, 1, 7)).toEqual([7]);
    expect(rowSeats(8, 8, 7)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('lets a guest show its figure only where it fits the seat it was lent: the selection moves nothing else', () => {
    // The row is fitted for the tabs that own its seats: `fitRow` does not know the selection.
    const need = [20, 0, 0, 0, 14, 14, 0, 0];
    // Tasks in Agents' seat: its one digit fits the room kept there.
    expect(guestFigure(COUNTS, need, 5, 5)).toBe(true);
    // Agents in Terminal's seat (a four-seat row): Terminal keeps no room for a figure.
    expect(guestFigure(COUNTS, need, 4, 4)).toBe(false);
    // Tasks with three digits in Agents' one-digit seat.
    expect(guestFigure(COUNTS, [20, 0, 0, 0, 14, 28, 0, 0], 5, 5)).toBe(false);
    // A tab in its own seat always shows it; so does a guest with nothing to count.
    expect(guestFigure(COUNTS, need, 5, 4)).toBe(true);
    expect(guestFigure(COUNTS, need, 4, 6)).toBe(true);
  });

  it('knows two fits apart', () => {
    expect(sameFit(fitRow(row(219)), fitRow(row(218)))).toBe(true);
    expect(sameFit(fitRow(row(219)), fitRow(row(143)))).toBe(false);
  });

  it('writes a count as its tab shows it', () => {
    expect(figure(0)).toBe('');
    expect(figure(undefined)).toBe('');
    expect(figure(73)).toBe('73');
    expect(figure(1000)).toBe('999+');
  });
});

describe('the selected tab pill', () => {
  const rail = readFileSync(new URL('../src/features/rail/Rail.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/features/rail/rail.css', import.meta.url), 'utf8');

  it('lies inside the selected tab and is never placed or sized by script', () => {
    // It was one pill for the whole row with a width worked out from the DOM: resized narrower it kept
    // the width of a name that had closed, over the next two tabs.
    expect(rail).not.toMatch(/setPill|animate=\{\{[^}]*width/);
    expect(rail).not.toContain("from 'motion/react'");
    expect(css).toMatch(/\.rail-tab-pill \{[^}]*position: absolute;[^}]*inset: 0;/);
    expect(css).not.toContain('.rail-tabs-pill');
  });

  it('moves by transform and opacity only, and not at all when the panel is resized', () => {
    const motion = rail.slice(rail.indexOf('function useRowMotion'), rail.indexOf('function RailTabs'));
    const frames = [...motion.matchAll(/play\([^[]*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(frames.length).toBeGreaterThan(2);
    for (const f of frames) expect(f).toMatch(/^(?:(?!width|left|borderRadius|scale).)*$/s);
    // Only a change of selection moves anything.
    expect(motion).toContain('was.tab === tab || reducedMotion()');
  });

  it('has a name that takes its own room in the flow: nothing animates a width', () => {
    expect(css).toMatch(/\.rail-tab-name \{[^}]*flex-shrink: 0;/);
    expect(css).not.toContain('.rail-tab-label');
  });

  it('leaves More the three dots: no tab stands in for the menu', () => {
    expect(rail).toContain('<Icon name="dots" size={16} />');
    expect(rail).not.toContain('rail-more-caret');
    expect(css).not.toContain('rail-more-caret');
  });
});
