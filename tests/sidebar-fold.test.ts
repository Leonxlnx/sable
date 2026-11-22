import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { edgeOf, reach, screenful } from '../src/features/sidebar/fold';
import { spring } from '../src/lib/motion';

const read = (p: string) => readFileSync(p, 'utf8');

describe('a folder folds and unfolds without its height being animated', () => {
  const fold = read('src/features/sidebar/fold.tsx');
  const sidebar = read('src/features/sidebar/Sidebar.tsx');
  const leave = read('src/features/sidebar/leave.ts');

  it('moves translate only, on the list’s spring, and nothing per frame', () => {
    // The height animated by script laid the whole list out on every frame, on a clock of its own.
    expect(sidebar).not.toMatch(/\bmotion\.div\b|AnimatePresence|FOLD_SHUT|FOLD_OPEN/);
    expect(fold).not.toContain('requestAnimationFrame');
    expect(fold).toContain("play(el, [{ translate: `0 ${a}px` }, { translate: `0 ${b}px` }], timing)");
    // That one call is every animation the fold starts.
    expect((fold.match(/\bplay\(/g) ?? []).length).toBe(1);
    expect(fold).not.toContain('.animate(');
    expect(fold).toContain('const FOLD = spring(440, 40);');
    expect(leave).toContain('const CLOSE = spring(440, 40);');
  });

  it('is told in the click, before the state changes', () => {
    // Every header and the Archived line: the cue first, then the toggle.
    const cues = [...sidebar.matchAll(/foldCue\(e\.currentTarget\);\s*(onToggle\([^)]*\)|setShowArchived\()/g)];
    expect(cues.length).toBe(4);
    // The measures are taken while the folder stands; the fold plays when React has taken the body out.
    const cue = fold.slice(fold.indexOf('export function foldCue'), fold.indexOf('export const Unfolding'));
    expect(cue.indexOf('// Reads, while the folder stands.')).toBeLessThan(cue.indexOf('new MutationObserver'));
    expect(cue.slice(cue.indexOf('new MutationObserver'))).not.toMatch(/getBoundingClientRect|offsetHeight|offsetTop/);
  });

  it('moves only as far as can be seen', () => {
    // A folder shorter than the room below its header: its whole height.
    expect(reach(93, 500)).toBe(93);
    // A folder of four hundred rows: the room and a little past the list's lower edge, never 12,000 px.
    expect(reach(12_400, 480)).toBe(540);
    // A header at the very bottom of the list still moves a little.
    expect(reach(600, 0)).toBe(60);
    expect(reach(600, -200)).toBe(60);
  });

  it('turns back from where the edge is, worked out and never read', () => {
    const curve = spring(440, 40);
    const run = { from: 93, to: 0 };
    // Not started: it stands where it began.
    expect(edgeOf(run, null, 5000)).toBe(93);
    // Under way: between the two, nearer the end with time.
    const a = edgeOf(run, 5000, 5040);
    const b = edgeOf(run, 5000, 5120);
    expect(a).toBeLessThan(93);
    expect(b).toBeLessThan(a);
    // Done.
    expect(edgeOf(run, 5000, 5000 + curve.duration)).toBe(0);
    // An unfold runs the other way.
    expect(edgeOf({ from: 20, to: 93 }, 5000, 5000 + curve.duration)).toBe(93);
    expect(edgeOf({ from: 20, to: 93 }, 5000, 5060)).toBeGreaterThan(20);
    expect(fold).not.toMatch(/getComputedStyle\([^)]*\)\.(translate|transform)/);
  });

  it('never slides a long folder as one layer, and builds a screenful of it first', () => {
    // What is below is taken apart when it is tall: only parts that can be seen move.
    expect(leave).toMatch(/if \(r\.height <= TALL \|\| !el\.children\.length\) out\.push\(el\);\s*else for \(const c of el\.children\) partsInView\(c, top, bottom, out\);/);
    expect(fold).toContain('partsInView(n, top, bottom, out);');
    expect(leave).toContain('for (const part of partsInView(n, view.top - 40, view.bottom + 40))');
    // A list of rows that mounts in a folder unfolding right now: a screenful, the rest when it stands.
    const list = sidebar.slice(sidebar.indexOf('const SessionList = memo'), sidebar.indexOf('function GroupBody'));
    expect(list).toContain('const unfolding = useContext(Unfolding);');
    expect(list).toContain('const n = wait ? Math.min(all.length, screenful(window.innerHeight, uiZoom())) : rowsNow(all.length);');
    expect(list).toContain('const rest = window.setTimeout(() => setShown(Infinity), wait);');
    // A body inside one that unfolds plays nothing of its own.
    expect(fold).toContain('const late = enter && !reducedMotion() && !(outer.until > now);');
  });

  it('counts a screenful in the rows the interface really draws', () => {
    // 900 px of window: 33 rows of 28 px and six more, far past the list's lower edge.
    expect(screenful(900, 1)).toBe(39);
    // A larger interface has fewer, taller rows: the same count is more than enough.
    expect(screenful(900, 1.25)).toBe(39);
    // A smaller one has more rows in the same window: counted without the zoom, the first batch
    // ended in view and what stood below jumped when the rest mounted.
    expect(screenful(900, 0.8)).toBe(47);
    expect(screenful(900, 0.8) * 30 * 0.8).toBeGreaterThan(900);
    // No zoom read (the root carries none): the interface's own size.
    expect(screenful(900, 0)).toBe(39);
    expect(screenful(900, Number.NaN)).toBe(39);
  });

  it('ends an unfold still under way when its body goes, whether the fold plays or not', () => {
    const cue = fold.slice(fold.indexOf('export function foldCue'), fold.indexOf('export const Unfolding'));
    // Nothing leaves the cue before the watcher for the body is set, except where there is no folder.
    expect(cue).not.toMatch(/listShift\([^;]*\) > 0\) return;/);
    expect(cue).toContain('const plain = !holdListEnd(trigger) && listShift(list.scrollTop, list.scrollHeight, list.clientHeight, height) > 0;');
    const gone = cue.slice(cue.indexOf('new MutationObserver'));
    // The slides of the unfold are cancelled first; only then does a plain fold stop there.
    expect(gone.indexOf('const at = stop(host);')).toBeGreaterThan(-1);
    expect(gone.indexOf('const at = stop(host);')).toBeLessThan(gone.indexOf('if (plain) return;'));
    expect(gone.indexOf('if (plain) return;')).toBeLessThan(gone.indexOf('host.appendChild(body);'));
  });

  it('is plain under reduced motion', () => {
    expect(fold).toMatch(/if \(!host \|\| !list \|\| !rows \|\| reducedMotion\(\)\) return;/);
    expect(fold).toContain('if (reducedMotion()) return void stop(host);');
  });
});
