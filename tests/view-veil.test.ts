import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coverSteps, quartersOn, VEIL_STEP_IN, VEIL_WAIT_AFTER } from '../src/art/veil';

const read = (p: string) => readFileSync(p, 'utf8');

describe('a change of view: one veil, one clock, one direction', () => {
  const veil = read('src/art/veil.ts');
  const app = read('src/app/App.tsx');

  it('turns the quarters on in the dither order, the first in the first frame', () => {
    const { at, solidIn } = coverSteps([false, false, false, false]);
    expect(at).toEqual([0, VEIL_STEP_IN, 2 * VEIL_STEP_IN, 3 * VEIL_STEP_IN]);
    // Solid a frame after the last quarter begins to come on.
    expect(solidIn).toBe(3 * VEIL_STEP_IN + 16);
    expect(solidIn).toBeLessThanOrEqual(100);
  });

  it('carries on from the density that is drawn: a second change never steps back before solid', () => {
    // Two quarters are on (a cover half way, or a reveal half way): only the other two come.
    const half = coverSteps([true, true, false, false]);
    expect(half.at).toEqual([-1, -1, 0, VEIL_STEP_IN]);
    expect(half.solidIn).toBe(VEIL_STEP_IN + 16);
    // A reveal that had taken the last quarter off: it alone comes back.
    expect(coverSteps([true, true, true, false]).at).toEqual([-1, -1, -1, 0]);
    // Solid already: nothing to wait for.
    expect(coverSteps([true, true, true, true]).solidIn).toBe(0);
    // No quarter that is on is ever given a time to come on again.
    for (const on of [[true, false, true, false], [false, true, true, true]]) {
      coverSteps(on).at.forEach((t, q) => expect(t < 0).toBe(on[q]));
    }
  });

  it('knows the density from its own schedule, never from a style read after a long task', () => {
    // After a view was built for 100 ms the page's last frame is 100 ms old: a computed opacity says
    // "one quarter on" while the screen shows solid. The schedule says what is on screen.
    const cover = { born: 1000, at: [0, 22, 44, 66], start: 1016 as number | null };
    expect(quartersOn(cover, 1016)).toEqual([true, false, false, false]);
    expect(quartersOn(cover, 1016 + 45)).toEqual([true, true, true, false]);
    expect(quartersOn(cover, 1150)).toEqual([true, true, true, true]);
    // The start not reported yet: it leans to "on" (from when the cover was made), never to "off".
    expect(quartersOn({ ...cover, start: null }, 1070)).toEqual([true, true, true, true]);
    // A reveal under way: a quarter is off only once its own animation, whose start is known, has run.
    const offAt = [16 + 102, 16 + 68, 16 + 34, 16];
    const revealing = { ...cover, offStart: [1300, 1300, 1300, 1300], offAt };
    expect(quartersOn(revealing, 1300 + 16 + 20)).toEqual([true, true, true, false]);
    expect(quartersOn(revealing, 1300 + 16 + 34 + 20)).toEqual([true, true, false, false]);
    expect(quartersOn({ ...revealing, offStart: [null, null, null, null] }, 1500)).toEqual([true, true, true, true]);
    expect(veil.slice(veil.indexOf('export function veilCover'), veil.indexOf('export interface VeilSwitch'))).not.toContain('getComputedStyle(l)');
    expect(veil).toContain('const timeNow = () => performance.now();');
  });

  it('switches the views by animations on the veil’s own clock, never by the stage’s script', () => {
    // What goes and what comes are stepped inside veilReveal, tied to the cover's start.
    const reveal = veil.slice(veil.indexOf('export function veilReveal'));
    expect(reveal).toContain('cover.anims[0]?.startTime');
    expect(reveal).toMatch(/for \(const el of sw\.hide \?\? \[\]\)[\s\S]*?el\.animate\(/);
    expect(reveal).toMatch(/for \(const el of sw\.show \?\? \[\]\)[\s\S]*?el\.animate\(/);
    // The quarters go off after the hold, in the reverse of the order they came on.
    expect(reveal).toContain('hold + (3 - q) * VEIL_STEP_OUT');
    // In a swap the stage's own variants move nothing and fade nothing.
    expect(app).toContain("const STILL = { opacity: 1, y: 0, transition: { duration: 0 } } as const;");
    expect(app).not.toContain('VEIL_SWAP_AT');
    expect(app).not.toMatch(/veil\(el, 'swap'\)/);
    expect((app.match(/<HoldForVeil \/>/g) ?? []).length).toBe(3);
  });

  it('starts the cover before the new view is built', () => {
    const hook = app.slice(app.indexOf('function useShownView'), app.indexOf('export function App()'));
    // The cover in the layout effect of the commit that changes nothing on the stage; the view a frame later.
    expect(hook.indexOf('veilCover(el')).toBeGreaterThan(-1);
    expect(hook.indexOf('veilCover(el')).toBeLessThan(hook.indexOf('requestAnimationFrame'));
    expect(hook).toMatch(/requestAnimationFrame\(\(\) => \{\s*t = window\.setTimeout\(\(\) => setShown\(live\), 0\);/);
    // A window that draws no frame changes its view all the same.
    expect(hook).toMatch(/const cap = window\.setTimeout\(\(\) => setShown\(live\), \d+\);/);
    // A row's press starts it, whatever the chat needs first.
    expect(hook).toContain('onOpenCue(');
    const row = read('src/features/sidebar/SessionRow.tsx');
    expect(row.indexOf('cueOpen(session.id)')).toBeGreaterThan(-1);
    expect(row.indexOf('cueOpen(session.id)')).toBeLessThan(row.indexOf('openSession(session.id);'));
  });

  it('shows a waiting state only when the view takes long, and never a spinner', () => {
    expect(VEIL_WAIT_AFTER).toBeGreaterThanOrEqual(150);
    const wait = app.slice(app.indexOf('function waitingChat'), app.indexOf('/**', app.indexOf('function waitingChat')));
    expect(wait).toContain('class="skel');
    expect(wait).not.toMatch(/spinner|Tiles/);
    // Unseen from the start, brought in by an animation of its own: it shows while the page is busy.
    expect(veil).toMatch(/w\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], \{ duration: WAIT_IN, delay: solidIn \+ VEIL_WAIT_AFTER/);
  });
});
