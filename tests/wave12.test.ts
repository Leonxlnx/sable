/**
 * Review wave 12: what the fixes for wave 11 left wrong (they shipped in 0.2.17 before a second
 * pair of eyes saw them). One case per finding that was fixed.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullStatus } from '@shared/protocol';
import { Submissions, messagePrint } from '../server/core/submissions';
import { checkoutTop } from '../server/util/which';
import { QUIET_MS, createPullWatch, withFailures } from '../src/features/rail/pull-status';
import { isLeadIn } from '../src/features/timeline/lead-in';

describe('#1: a report already in a draft that begins with ! or / goes to the front, once', () => {
  const report = '2 of 5 checks failed on pull request #128\n- lint';

  it('is moved in front of the shell line or the command, whatever order they were in', () => {
    for (const typed of [`!git status\n\n${report}`, `/until npm test\n\n${report}`, `  !ls\n${report}\nand more`]) {
      const out = withFailures(typed, report);
      expect(out.startsWith(report), typed).toBe(true);
      expect(out.split(report)).toHaveLength(2);
      expect(/^\s*[!/]/.test(out)).toBe(false);
      // Nothing changes on another click.
      expect(withFailures(out, report)).toBe(out);
    }
  });

  it('a plain draft that holds the report is left as it is', () => {
    const typed = `Fix these.\n\n${report}`;
    expect(withFailures(typed, report)).toBe(typed);
  });
});

describe("#2, #3: the checkout's top is found by the folder's real path, afresh each time", () => {
  const home = path.resolve('/home/me');

  it('a junction into a checkout is followed before the walk goes up', () => {
    const tree = new Set([path.resolve('/work/app/.git')]);
    const exists = (p: string) => tree.has(path.resolve(p));
    // /links/web is a junction to /work/app/packages/web: its own parents hold no checkout.
    const real = (p: string) => (path.resolve(p) === path.resolve('/links/web') ? path.resolve('/work/app/packages/web') : path.resolve(p));
    expect(checkoutTop('/links/web', { exists, home, real })).toBe(path.resolve('/work/app'));
    expect(checkoutTop('/links/web', { exists, home })).toBeNull();
  });

  it('a junction to a home folder that is a repository is still the home folder', () => {
    const tree = new Set([path.resolve('/home/me/.git')]);
    const exists = (p: string) => tree.has(path.resolve(p));
    const real = (p: string) => (path.resolve(p) === path.resolve('/links/notes') ? path.resolve('/home/me') : path.resolve(p));
    expect(checkoutTop('/links/notes', { exists, home, real })).toBeNull();
  });

  it('a folder that becomes a checkout is one at the very next look', () => {
    const tree = new Set<string>();
    const exists = (p: string) => tree.has(path.resolve(p));
    const real = (p: string) => path.resolve(p);
    expect(checkoutTop('/work/new/sub', { exists, home, real })).toBeNull();
    tree.add(path.resolve('/work/new/.git'));
    expect(checkoutTop('/work/new/sub', { exists, home, real })).toBe(path.resolve('/work/new'));
  });
});

describe('#4, #6: one message under one id is sent once, whatever else comes under that id', () => {
  it('a steer retried as a plain send is the same message', () => {
    // The fingerprint is the words and the files: the bridge call passes nothing about steering.
    expect(messagePrint.length).toBe(2);
    expect(messagePrint('same words', [{ id: 'f1' }])).toBe(messagePrint('same words', [{ id: 'f1' }]));
  });

  it('a message still on its way is not pushed out by another under the same id', async () => {
    const subs = new Submissions<{ ok: boolean; n: number }>();
    let n = 0;
    let letGo!: () => void;
    const slow = () => new Promise<{ ok: boolean; n: number }>((res) => (letGo = () => res({ ok: true, n: ++n })));
    const one = messagePrint('one', []);
    const two = messagePrint('two', []);
    const first = subs.run('s', 'id-1', slow, one);
    const second = subs.run('s', 'id-1', async () => ({ ok: true, n: ++n }), two);
    // The retry of "one" while it is still going: the same send, not another.
    const retry = subs.run('s', 'id-1', async () => ({ ok: true, n: ++n }), one);
    expect(retry).toBe(first);
    expect(await second).toEqual({ ok: true, n: 1 });
    letGo();
    expect(await first).toEqual({ ok: true, n: 2 });
    expect(n).toBe(2);
    // And afterwards each is answered as it was.
    expect(await subs.run('s', 'id-1', async () => ({ ok: true, n: ++n }), one)).toEqual({ ok: true, n: 2 });
    expect(await subs.run('s', 'id-1', async () => ({ ok: true, n: ++n }), two)).toEqual({ ok: true, n: 1 });
    expect(n).toBe(2);
  });
});

describe('#7: a branch with no pull request is asked once more when the long quiet ends', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an ask held back by the quiet is made when it ends, while the tab is in view', async () => {
    const waiting: ((v: PullStatus | null) => void)[] = [];
    const read = vi.fn(() => new Promise<PullStatus | null>((res) => waiting.push(res)));
    const w = createPullWatch({ read, branchOf: () => 'main', seen: () => true });
    const answer = async (v: PullStatus | null) => {
      waiting.shift()!(v);
      await vi.advanceTimersByTimeAsync(0);
    };
    w.watch('/repo');
    await answer({ branch: 'main' });
    expect(read).toHaveBeenCalledTimes(1);
    // The window comes back a minute later: held back.
    await vi.advanceTimersByTimeAsync(60_000);
    void w.ask('/repo');
    expect(read).toHaveBeenCalledTimes(1);
    // Nothing more is asked of it, yet the folder is read once when the five minutes are over.
    await vi.advanceTimersByTimeAsync(QUIET_MS - 60_000 + 50);
    expect(read).toHaveBeenCalledTimes(2);
    await answer({ branch: 'main' });
    // No ask was held back since: nothing is scheduled.
    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('#8: a result inside a subordinate clause does not make an announcement a statement', () => {
  it('"checking what the command returns first" still announces', () => {
    for (const t of ["I'll update the docs — checking what the command returns first.", "I'll fix it, but checking whether the build passes first.", "I'll tidy up, but looking at how the parser reads it next."]) expect(isLeadIn(t, false), t).toBe(true);
  });

  it("a result that is the clause's own still stays in view", () => {
    for (const t of ["I'll retry, but checking the logs showed the backup failed.", "I'll rerun CI, but running it locally already failed."]) expect(isLeadIn(t, false), t).toBe(false);
  });
});

// ── review wave 13: what the corrections above left wrong ──

describe('wave 13 #1: a reported failure never folds for a determiner or a closing "first"', () => {
  it('"running that test failed" and "…failed first" stay in view', () => {
    for (const t of ["I'll retry, but running that test failed.", "I'll retry, but running the migration failed first.", "I'll look again, but checking that file showed the key is missing."]) expect(isLeadIn(t, false), t).toBe(false);
  });

  it('an indirect question still announces', () => {
    for (const t of ["I'll update the docs — checking what the command returns first.", "I'll fix it, but checking whether the build passes first."]) expect(isLeadIn(t, false), t).toBe(true);
  });
});

describe('wave 13 #2: only the report\'s own block is moved, never the same words inside a sentence', () => {
  const R = '2 of 5 checks failed on pull request #128\n- lint';

  it('a quoted report in the person\'s own line stays', () => {
    const typed = `/review Explain the quoted output "${R}"\n\n${R}`;
    const out = withFailures(typed, R);
    expect(out).toBe(`${R}\n\n/review Explain the quoted output "${R}"`);
    expect(withFailures(out, R)).toBe(out);
  });

  it('with no block of its own the report is added in front and the line is untouched', () => {
    const typed = `!echo "${R}"`;
    expect(withFailures(typed, R)).toBe(`${R}\n\n${typed}`);
  });
});

describe('wave 13 #4: a detached HEAD is not read again when the quiet ends', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no branch in the answer: nothing is scheduled', async () => {
    const waiting: ((v: PullStatus | null) => void)[] = [];
    const read = vi.fn(() => new Promise<PullStatus | null>((res) => waiting.push(res)));
    const w = createPullWatch({ read, branchOf: () => undefined, seen: () => true });
    w.watch('/repo');
    waiting.shift()!({});
    await vi.advanceTimersByTimeAsync(60_000);
    void w.ask('/repo');
    await vi.advanceTimersByTimeAsync(QUIET_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('wave 13 #3: the folders of a project are worked out once per call', () => {
  it('names the folder, its real path and the checkout, and keeps a found checkout for a moment', async () => {
    const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { projectFolders } = await import('../server/util/which');
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'sable-w13-')));
    try {
      const sub = path.join(base, 'repo', 'packages', 'web');
      mkdirSync(sub, { recursive: true });
      // Not a checkout yet: only the folder, and nothing is remembered.
      expect(projectFolders(sub, 1000)).toEqual([sub]);
      mkdirSync(path.join(base, 'repo', '.git'));
      // It became one: seen at the very next look.
      expect(projectFolders(sub, 1001)).toEqual([sub, path.join(base, 'repo')]);
      // Found: the same list within a few seconds without looking again (the folder is gone meanwhile).
      rmSync(path.join(base, 'repo', '.git'), { recursive: true });
      expect(projectFolders(sub, 3000)).toEqual([sub, path.join(base, 'repo')]);
      // And looked up afresh after that.
      expect(projectFolders(sub, 1001 + 5001)).toEqual([sub]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// ── review wave 14 ──

describe('wave 14 #2: a read that failed is tried again after the 20 s, not after the long quiet', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no answer is not "none"', async () => {
    const waiting: ((v: PullStatus | null) => void)[] = [];
    const read = vi.fn(() => new Promise<PullStatus | null>((res) => waiting.push(res)));
    const w = createPullWatch({ read, branchOf: () => 'feature/a', seen: () => true });
    w.watch('/repo');
    // The bridge could not be asked.
    waiting.shift()!(null);
    await vi.advanceTimersByTimeAsync(25_000);
    void w.ask('/repo');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('wave 14 #3: a moved report takes only blank lines with it', () => {
  it("keeps the next line's indentation", () => {
    const R = '2 of 5 checks failed on pull request #128\n- lint';
    const typed = `/review look at this\n\n${R}\n\n    const a = 1;\n    const b = 2;`;
    expect(withFailures(typed, R)).toBe(`${R}\n\n/review look at this\n\n    const a = 1;\n    const b = 2;`);
  });
});

describe('wave 14 #1: a kept checkout is reused only for the same real folder', () => {
  it('reads the real path every time and compares it', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(__dirname, '..', 'server/util/which.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export function projectFolders'));
    expect(fn.indexOf('const realDir = defaultReal(start);')).toBeLessThan(fn.indexOf('const known = found.get(start);'));
    expect(fn).toContain('known.real === realDir');
  });
});

describe('wave 14 #4, #5: a fitted path is measured in layout pixels and refitted when the window changes', () => {
  it('uses offsetWidth, one pixel of room, and a window listener', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(__dirname, '..', 'src/ui/path-fit.ts'), 'utf8');
    expect(src).toContain('s.offsetWidth');
    expect(src).not.toContain('getBoundingClientRect');
    expect(src).toMatch(/Math\.ceil\(widths\[candidates\.indexOf\(pick\)\]\) \+ 1/);
    expect(src).toContain("window.addEventListener('resize', refitAll)");
  });
});
