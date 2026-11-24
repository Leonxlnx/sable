/**
 * Toasts: the same words while they stand are one toast, and the stack moves as one body on the
 * compositor (ui/index.tsx `Toasts`).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = { hidden: false };
g.window = globalThis;

type StoreModule = typeof import('../src/state/store');
let S: StoreModule;
beforeAll(async () => {
  S = await import('../src/state/store');
});

const texts = () => S.useStore.getState().toasts.map((t) => t.text);

describe('the same toast twice is one toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    S.useStore.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('joins equal words at the same level, whoever sends them', () => {
    const { toast } = S.useStore.getState();
    toast('Claude Code is at 99% of the weekly limit', 'warn');
    toast('Claude Code is at 99% of the weekly limit', 'warn');
    expect(texts()).toEqual(['Claude Code is at 99% of the weekly limit']);
    // Other words, or the same words at another level, are another toast.
    toast('Copied', 'info');
    toast('Claude Code is at 99% of the weekly limit', 'error');
    expect(texts()).toHaveLength(3);
  });

  it('starts the time of the one in view anew', () => {
    const { toast } = S.useStore.getState();
    toast('Copied', 'info');
    const id = S.useStore.getState().toasts[0].id;
    vi.advanceTimersByTime(3000);
    toast('Copied', 'info');
    // The same toast, not a new one in its place: nothing leaves and nothing arrives.
    expect(S.useStore.getState().toasts.map((t) => t.id)).toEqual([id]);
    // Its first time (3.8 s) has passed: it still stands, and goes 3.8 s after the repeat.
    vi.advanceTimersByTime(1000);
    expect(texts()).toEqual(['Copied']);
    vi.advanceTimersByTime(2900);
    expect(texts()).toEqual([]);
  });

  it('is read out again when it is said again, in place', () => {
    const { toast } = S.useStore.getState();
    toast('Could not save the file', 'error');
    const first = S.useStore.getState().toasts[0];
    expect(first.again).toBeUndefined();
    toast('Could not save the file', 'error');
    toast('Could not save the file', 'error');
    const now = S.useStore.getState().toasts;
    // The same toast in the same place, counted: the window gives its words a new node per count,
    // which is what a live region reads out (the same node left alone was never announced again).
    expect(now).toHaveLength(1);
    expect(now[0].id).toBe(first.id);
    expect(now[0].again).toBe(2);
    const ui = readFileSync('src/ui/index.tsx', 'utf8');
    expect(ui).toContain('<span key={t.again ?? 0}>{t.text}</span>');
    expect(ui).toMatch(/className="toasts" aria-live="polite"/);
    // Counting moves nothing: the stack is laid out again only when its order changes.
    expect(ui).toContain("const order = toasts.map((t) => t.id).join(' ');");
  });

  it('comes again once the first has gone, and a dismissed one does not come back by its timer', () => {
    const { toast, dismissToast } = S.useStore.getState();
    toast('Copied', 'info');
    dismissToast(S.useStore.getState().toasts[0].id);
    expect(texts()).toEqual([]);
    toast('Copied', 'info');
    expect(texts()).toEqual(['Copied']);
    // The first one's timer was cleared with it: the second stands its full time.
    vi.advanceTimersByTime(3700);
    expect(texts()).toEqual(['Copied']);
    vi.advanceTimersByTime(200);
    expect(texts()).toEqual([]);
  });
});

describe('the stack moves as one body, on the compositor', () => {
  const ui = readFileSync('src/ui/index.tsx', 'utf8');
  const toasts = ui.slice(ui.indexOf('// ── toasts ──'), ui.indexOf('// ── paths ──'));

  it('knows where a toast stands mid-slide from the slide itself', async () => {
    const { slideLeft, spring } = await import('../src/lib/motion');
    const curve = spring(420, 34);
    // Not started (its start is not known to the page yet): it has not moved.
    expect(slideLeft(curve, 47, null, 1000)).toBe(47);
    expect(slideLeft(curve, 47, 1000, 1000)).toBe(47);
    // Under way: between its start and home, and less with time.
    const early = slideLeft(curve, 47, 1000, 1040);
    const late = slideLeft(curve, 47, 1000, 1120);
    expect(early).toBeLessThan(47);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(-3);
    // Settled.
    expect(slideLeft(curve, 47, 1000, 1000 + curve.duration)).toBe(0);
    // The curve's value is the spring the easing string traces.
    expect(curve.value(0)).toBe(0);
    expect(curve.value(1)).toBe(1);
    expect(curve.value(0.5)).toBeGreaterThan(0.9);
    expect(toasts).not.toMatch(/getComputedStyle\([^)]*\)\.translate/);
  });

  it('lets a toast that still arrives go from what shows of it', async () => {
    const { fadeShown, spring } = await import('../src/lib/motion');
    const curve = spring(420, 34);
    // Not started: nothing shows yet. Whole at 0.55 of the spring's way, and from then on.
    expect(fadeShown(curve, 0.55, null, 1000)).toBe(0);
    expect(fadeShown(curve, 0.55, 1000, 1000)).toBe(0);
    const early = fadeShown(curve, 0.55, 1000, 1016);
    const later = fadeShown(curve, 0.55, 1000, 1040);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(later);
    expect(later).toBeLessThan(1);
    expect(fadeShown(curve, 0.55, 1000, 1000 + curve.duration / 2)).toBe(1);
    expect(fadeShown(curve, 0.55, 1000, 1000 + curve.duration * 3)).toBe(1);
    // The arrival's keyframes and the worked-out value use one number.
    expect(toasts).toContain('{ opacity: 1, offset: TOAST_FADE }');
    expect(toasts).toContain('fadeShown(TOAST_SPRING, TOAST_FADE,');
    // The leave starts there (from whole it flashed up for a frame) and holds its first and last frame.
    expect(toasts).toContain('const shown = Math.min(shownOf(slides[0], at), shownOf(slides[1], at));');
    expect(toasts).toMatch(/\[\{ opacity: shown, translate: `0 \$\{held\}px` \}, \{ opacity: 0, translate: `0 \$\{held \+ TOAST_SINK\}px` \}\], \{[^}]*fill: 'both' \}/);
    // What shows is read before the slides are cancelled.
    expect(toasts.indexOf('const shown = Math.min(')).toBeLessThan(toasts.indexOf('for (const s of slides) s?.anim.cancel();'));
  });

  it('animates opacity, translate and transform only, with no script per frame', () => {
    expect(ui).not.toContain("from 'motion/react'");
    expect(toasts).not.toContain('requestAnimationFrame');
    for (const m of toasts.matchAll(/play\(/g)) {
      const keyframes = toasts.slice(m.index, m.index! + 300).split('duration')[0];
      expect(keyframes).not.toMatch(/\b(height|width|top|bottom|margin\w*|filter|boxShadow)\s*:/);
    }
  });

  it('brings a toast under a stack from one place lower, and lets one go under the others', () => {
    // No two toasts ever share a place: the newcomer starts its own height and the gap below.
    expect(toasts).toContain('slideToast(r.el, pushed ? r.h + gap : TOAST_RISE, true)');
    // The one that leaves is out of the flow at once, held by its lower edge, under the rest.
    expect(toasts).toMatch(/position:absolute;right:0;bottom:\$\{was\.up\}px;z-index:-1;/);
    expect(toasts).toContain("el.setAttribute('data-gone', '')");
    // Two slides add up (translate and transform): a second change restarts nothing.
    expect(toasts).toContain("i === 0 ? { translate: `0 ${v}px` } : { transform: `translateY(${v}px)` }");
    // Reduced motion: places are kept, nothing is animated.
    expect(toasts.indexOf('if (reducedMotion()) return;')).toBeLessThan(toasts.indexOf('// Writes.'));
  });
});

describe('a queued message removed leaves in the frame of the click', () => {
  const tray = readFileSync('src/features/composer/QueueTray.tsx', 'utf8').replace(/\r\n/g, '\n');
  const dissolve = readFileSync('src/lib/dissolve.ts', 'utf8').replace(/\r\n/g, '\n');

  it('breaks into the tray’s dither as a dead copy and is out of the list before the bridge is asked', () => {
    const remove = tray.slice(tray.indexOf('const remove = ('), tray.indexOf('const move = ('));
    expect(remove).toContain("dissolve(row, { ground: '--panel', anchor: 'bottom', before: first })");
    expect(remove.indexOf('onLeave(q.id, true);')).toBeGreaterThan(remove.indexOf('dissolve(row'));
    // The copy is held where the row stood while the tray glides (QueueTray `glideTray`).
    expect(remove).toContain("leaving?.ghost.setAttribute('data-qghost', '');");
    expect(remove).toContain("row.style.display = 'none';");
    expect(remove.indexOf('onLeave(q.id, true);')).toBeLessThan(remove.indexOf('removeQueued(sessionId, q.id)'));
    // The last row is not taken out alone: the tray folds into the pane with it (`foldTray`).
    expect(remove).toContain('const last = rows.length <= 1;');
    expect(remove).toContain('if (row && !last) {');
    // Not taken by the bridge: the row comes back.
    expect(remove).toContain('onLeave(q.id, false)');
    // The glyph fragments drawn over the neighbours are gone from the tray.
    expect(tray).not.toContain('shatter');
    // The tray shows what is left from that frame on (and a row taken back to edit is gone too).
    expect(tray).toContain('const shown = left.size || takingNow.size ? all.filter((q) => !left.has(q.id) && !takingNow.has(q.id)) : all;');
    expect(tray).toContain('{shown.length > 0 && (');
  });

  it('brings a refused removal back as a new row that can fly again', () => {
    // The row that left may still be in the page, hidden: the one that comes back is another
    // element (its key counts the returns), never that one, still hidden.
    expect(tray).toContain('lives.current.set(id, (lives.current.get(id) ?? 0) + 1);');
    expect(tray).toContain('key={`${keyOf(q.id)}/${lives.get(q.id) ?? 0}`}');
    const leave = tray.slice(tray.indexOf('const leave = useCallback('), tray.indexOf('const waiting = useSyncExternalStore'));
    // Back in the tray, it is no longer "removed by hand": taken by the agent later, it flies.
    expect(leave).toMatch(/if \(!on\) \{[^}]*gone\.delete\(id\);/);
    // A flight never starts from the hidden row.
    expect(tray).toContain(".find((el) => el.style.display !== 'none')?.querySelector<HTMLElement>('.cq-text')");
  });

  it('says so when the agent had already taken the message, and steps over rows that are leaving', () => {
    const remove = tray.slice(tray.indexOf('const remove = ('), tray.indexOf('const move = ('));
    // The bridge's answer is read: not removed and no longer in the queue means it went out.
    expect(remove).toMatch(/\.then\(\(res\) => \{[^}]*res\.ok === false && !shown\.current\.some\(\(x\) => x\.id === q\.id\)\) useStore\.getState\(\)\.toast\('That message had already gone out\.'\);/);
    // A return is counted only for a row that is really back in the queue.
    const leave = tray.slice(tray.indexOf('const leave = useCallback('), tray.indexOf('const waiting = useSyncExternalStore'));
    expect(leave).toMatch(/if \(held\.current\.some\(\(q\) => q\.id === id\)\) \{[^}]*lives\.current\.set\(id,[^}]*\} else lives\.current\.delete\(id\);/);
    // Arrow keys count live rows only: a hidden row still in the page shifted the focus by one,
    // and Delete then removed the wrong message.
    const keys = tray.slice(tray.indexOf('onKey={(e) => {'), tray.indexOf("} else if (e.key === 'Enter' || e.key === 'F2') {"));
    expect(keys).toContain(".filter((el) => el.style.display !== 'none');");
    expect(keys).toContain('const at = els.indexOf(e.currentTarget);');
  });

  it('closes the tray on the compositor: one glide for the whole dock, never a height by script', () => {
    // A queue is used while a turn streams: the height animated by script got five frames a second.
    const glide = tray.slice(tray.indexOf('function glideTray'), tray.indexOf('export interface QueueTrayProps'));
    expect(glide).not.toMatch(/style\.height|height: 0|requestAnimationFrame/);
    // The tray, the rows that stay, a removed row's copy and what stands above: one clock (stack-glide.ts).
    expect(glide).toContain('const edge = glideY(cq, m.tray, t);');
    expect(glide).toContain('glideY(g, -m.tray, t);');
    expect(glide).toContain('for (const el of aboveTray(clip)) glideY(el, share, t);');
    // The last row: the tray goes into the pane as one dead copy, the strips come down with it.
    expect(glide).toContain("const ghost = reducedMotion() ? null : ghostOf(clip, { anchor: 'bottom' });");
    expect(glide).toContain("clip.style.display = 'none';");
    const sg = readFileSync('src/features/composer/stack-glide.ts', 'utf8');
    expect(sg).toContain("play(el, [{ translate: `0 ${from.toFixed(2)}px` }, { translate: '0 0' }], { duration: STACK_MS, easing: STACK_EASE })");
    const css = readFileSync('src/features/composer/composer.css', 'utf8').replace(/\r\n/g, '\n');
    expect(css).toMatch(/\.cq-clip \{[^}]*margin-bottom: -20px;/);
    // Only its lower edge cuts, and the tray's body goes on below its box: a tray drawn higher never shows a gap.
    expect(css).toMatch(/\.cq-clip \{[^}]*clip-path: inset\(-480px 0 0 0\);/);
    expect(css).toMatch(/\.cq::after \{[^}]*top: 100%;[^}]*background-color: var\(--panel\);/);
    expect(css).toMatch(/\.cq \{[^}]*padding-bottom: 20px;/);
    // motion slides the rows itself only for a change of order among the same rows.
    expect(tray).toContain('layoutDependency={measure}');
    expect(tray).toContain('if (set !== measured.current.set) measured.current = { set, measure: measured.current.measure };');
  });

  it('never leaves a copy that could be taken for the row', () => {
    for (const attr of ['data-qrow', 'data-qid', 'data-row', 'data-toast', 'tabindex']) expect(dissolve).toContain(`'${attr}'`);
  });
});
