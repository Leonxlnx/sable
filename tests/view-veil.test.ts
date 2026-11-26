import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coverSteps, quartersOn, VEIL_QUICK, VEIL_STEP_IN, VEIL_WAIT_AFTER } from '../src/art/veil';

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
    // The quarters go off after the hold, in the reverse of the order they came on (from the
    // highest that came on: three for the quick change, four for the full cover).
    expect(reveal).toContain('hold + Math.max(0, top - q) * cover.stepOut');
    // Each quarter's way out is whole in its keyframes, on from the first frame. As a short animation
    // behind a delay, the quarters went off early when the page committed the new view: what had been
    // covered showed for some frames under a quarter of the veil, then the veil was solid again.
    expect(reveal).not.toMatch(/delay:/);
    expect(reveal).toMatch(/\{ opacity: 1, offset: at\(offAt\[q\], out\) \},\s*\{ opacity: 0, offset: at\(offAt\[q\] \+ FRAME, out\) \}/);
    // Pinned to the moment of the reveal, not to the frame that first shows them (a frame or two
    // after a view was built and laid out): the switch never comes late on top of the build.
    expect(reveal).toContain('a.startTime = now;');
    expect((reveal.match(/pin\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // The gate is a clock on the same timeline, not an animation of the veil.
    expect(reveal).toContain('new Animation(new KeyframeEffect(null, null,');
    // In a swap the stage's own variants move nothing and fade nothing.
    expect(app).toContain("const STILL = { opacity: 1, y: 0, transition: { duration: 0 } } as const;");
    expect(app).not.toContain('VEIL_SWAP_AT');
    expect(app).not.toMatch(/veil\(el, 'swap'\)/);
    expect((app.match(/<HoldForVeil \/>/g) ?? []).length).toBe(3);
  });

  it('changes to a chat that is already here without ever going solid', () => {
    // Three quarters at most, a frame a step: the old chat shows through while the new one is built.
    expect(VEIL_QUICK.peak).toBe(3);
    expect(VEIL_QUICK.step).toBe(16);
    const quick = coverSteps([false, false, false, false], VEIL_QUICK.peak, VEIL_QUICK.step);
    expect(quick.at).toEqual([0, 16, 32, Infinity]);
    expect(quick.solidIn).toBe(48);
    // Never a quarter past the peak, whatever was on.
    expect(coverSteps([true, false, false, false], 3, 16).at).toEqual([-1, 0, 16, Infinity]);
    const cover = { born: 1000, at: quick.at, start: 1016 as number | null };
    expect(quartersOn(cover, 5000)).toEqual([true, true, true, false]);
    // Down a frame a step from the peak, the new view in its place (nothing rises).
    const reveal = veil.slice(veil.indexOf('export function veilReveal'));
    expect(reveal).toContain('const rise = cover.peak < 4 ? 0 : sw.rise;');
    // The take-over of the veil's waiting state by the new view (0.2.38) is out again (desk2, hotfix): the
    // veil's goes with the veil, the view's own comes on the open's clock. No view keeps an old hide.
    expect(veil).not.toMatch(/kept|keep\?:/);
    expect(reveal).toMatch(/for \(const old of el\.getAnimations\(\)\) if \(old\.id === HIDE\) old\.cancel\(\);/);
    // Chosen for a chat whose conversation is in the window, from another chat; no waiting state.
    const hook = app.slice(app.indexOf('function useShownView'), app.indexOf('export function App()'));
    expect(hook).toContain('quick: !!shown.sessionId && warmChat(live.sessionId)');
    expect(hook).toContain('quick: !!now.shown.sessionId && warmChat(id)');
    expect(veil).toContain('if (!wait && opts.waiting && !quick) {');
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
    // Unseen from the start, brought in by the page's timer, never by a delay on the compositor: a
    // view being built holds the page and lands with the frame that drops the waiting state, so with
    // a compositor delay a long chat in memory showed the skeleton while it was laid out and then cut
    // it off in one frame. The reveal clears the timer.
    expect(veil).not.toMatch(/delay: solidIn \+ VEIL_WAIT_AFTER/);
    expect(veil).toMatch(/waitTimer = window\.setTimeout\(\(\) => \{\s*if \(w\.isConnected\) waitIn\(w\);\s*\}, solidIn \+ VEIL_WAIT_AFTER\);/);
    expect(veil).toMatch(/const waitIn = \(w: HTMLElement\) => w\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\], \{ duration: WAIT_IN,[^}]*\}\);/);
    // The same waiting state in the new view (a conversation on screen before it is read, Timeline.tsx
    // `Reading`): the open's clock (the cover's due time; without a cover, from its mount), brought by
    // the page's timer too.
    const alone = veil.slice(veil.indexOf('export function waitingIn'), veil.indexOf('const covers'));
    expect(alone).toMatch(/const due = cover\?\.waitDue \?\? timeNow\(\) \+ after;[^]*if \(due <= timeNow\(\)\) show\(due\);\s*else t = window\.setTimeout\(\(\) => show\(\), due - timeNow\(\)\);/);
    expect(alone).toContain('const a = waitIn(el);');
    expect(alone).not.toMatch(/delay:/);
    const reveal = veil.slice(veil.indexOf('export function veilReveal'));
    expect(reveal.indexOf('window.clearTimeout(cover.waitTimer)')).toBeGreaterThan(-1);
    expect(reveal.indexOf('window.clearTimeout(cover.waitTimer)')).toBeLessThan(reveal.indexOf('const seen ='));
  });
});
