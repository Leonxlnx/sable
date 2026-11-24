/** Lanes at the git level, on temporary repositories only. */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLane, forecastLane, landLane, laneDiff, laneSlug, removeLane, renameLane } from '../server/services/git-lanes';
import * as gitService from '../server/services/git';
import { carryClaudeToFolder, claudeFolderKey, worktreesRoot } from '../server/core/lanes';
import { gitWorktrees, gitStatus } from '../server/services/git';
import { projectFolders, findProgram } from '../server/util/which';
import type { SessionLane } from '@shared/protocol';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit on `main`, an ignored node_modules, and a lanes folder beside it. */
function repo() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable lanes '));
  temps.push(home);
  const root = path.join(home, 'app');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(root, 'src', 'session.js'), 'export const IDLE = 60;\n');
  writeFileSync(path.join(root, 'src', 'auth.js'), 'export const auth = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# app\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  return { home, root, lanes: path.join(home, 'lanes') };
}

async function lane(r: ReturnType<typeof repo>, slug = 'refactor-session', folder = r.root): Promise<{ lane: SessionLane; cwd: string }> {
  const made = await createLane({ folder, dir: path.join(r.lanes, slug.slice(0, 6)), slug });
  if ('error' in made) throw new Error(made.error);
  return made;
}

// Each landing drives several dozen real Git processes, including on shared Windows runners.
const gitTestTimeout = 120_000;

describe('lanes', { timeout: gitTestTimeout }, () => {
  it('checks Git capability with the same checkout exclusions as the forecast', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    const run = vi.spyOn(gitService, 'runGit');
    try {
      // Include the first version probe when there is one. A warm probe needs no subprocess.
      await forecastLane(l);
      expect(run.mock.calls.filter(([, args]) => args[0] === 'version').every(([cwd]) => cwd === l.path)).toBe(true);
    } finally { run.mockRestore(); }
  });
  it('slugs a title into a branch name', () => {
    expect(laneSlug('Refactor the session module, please!')).toBe('refactor-the-session-module');
    expect(laneSlug('Über café: fix ü')).toBe('uber-cafe-fix-u');
    expect(laneSlug('')).toBe('');
    expect(laneSlug('a'.repeat(50)).length).toBe(32);
  });

  it('makes a worktree on its own branch at HEAD, without the folder’s uncommitted work, sharing node_modules', async () => {
    const r = repo();
    writeFileSync(path.join(r.root, 'src', 'session.js'), 'export const IDLE = 5; // the other session, mid-edit\n');
    const { lane: l, cwd } = await lane(r);
    expect(l.branch).toBe('sable/refactor-session');
    expect(l.from).toBe('main');
    expect(l.root).toBe(path.resolve(r.root));
    expect(cwd).toBe(l.path);
    expect(git(l.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sable/refactor-session');
    expect(readFileSync(path.join(l.path, 'src', 'session.js'), 'utf8')).toBe('export const IDLE = 60;\n');
    // The folder's own edit is untouched.
    expect(readFileSync(path.join(r.root, 'src', 'session.js'), 'utf8')).toContain('mid-edit');
    expect(l.links).toEqual(['node_modules']);
    expect(readFileSync(path.join(l.path, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
    // The link is ignored there too: the lane is clean.
    expect(git(l.path, 'status', '--porcelain')).toBe('');
    // A second lane from the same title gets a branch of its own.
    const second = await createLane({ folder: r.root, dir: path.join(r.lanes, 'second'), slug: 'refactor-session' });
    expect('lane' in second && second.lane.branch).toBe('sable/refactor-session-2');
  });

  it('runs a session from a folder inside the repository in the same folder of the lane', async () => {
    const r = repo();
    const { lane: l, cwd } = await lane(r, 'inner', path.join(r.root, 'src'));
    expect(cwd).toBe(path.join(l.path, 'src'));
    expect(l.folder).toBe(path.join(r.root, 'src'));
  });

  it('forecasts a clean landing, then lands by fast-forward with the agent’s commits and the uncommitted work', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    expect((await forecastLane(l)).state).toBe('nothing');
    // The agent commits one change and leaves another uncommitted, plus a new file.
    writeFileSync(path.join(l.path, 'src', 'session.js'), 'export const IDLE = 30;\n');
    git(l.path, 'commit', '-q', '-am', 'Shorter idle');
    writeFileSync(path.join(l.path, 'src', 'auth.js'), 'export const auth = 2;\n');
    writeFileSync(path.join(l.path, 'src', 'new.js'), 'export {};\n');
    const f = await forecastLane(l);
    expect(f).toMatchObject({ state: 'clean', target: 'main', ahead: 1, behind: 0, uncommitted: 2, files: 3, conflicts: [], blocked: [] });
    // The forecast changed nothing: the lane's index and the folder are as they were.
    expect(git(l.path, 'status', '--porcelain')).toContain('?? src/new.js');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(l.base);

    const res = await landLane(l, 'Auth two and a new module');
    expect(res).toMatchObject({ ok: true, how: 'fast-forward', commits: 2, target: 'main' });
    expect(git(r.root, 'log', '--format=%s', '-3').split('\n')).toEqual(['Auth two and a new module', 'Shorter idle', 'first']);
    expect(readFileSync(path.join(r.root, 'src', 'auth.js'), 'utf8')).toBe('export const auth = 2;\n');
    expect(existsSync(path.join(r.root, 'src', 'new.js'))).toBe(true);
    expect(git(r.root, 'status', '--porcelain')).toBe('');
    expect((await forecastLane(l)).state).toBe('nothing');
  });

  it('replays the lane on a branch that moved, keeping the folder’s other uncommitted edits', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'src', 'session.js'), 'export const IDLE = 30;\n');
    // Meanwhile the folder moves on in another file, and has an uncommitted edit of its own elsewhere.
    writeFileSync(path.join(r.root, 'README.md'), '# app\n\nNotes.\n');
    git(r.root, 'commit', '-q', '-am', 'Notes');
    writeFileSync(path.join(r.root, 'src', 'auth.js'), 'export const auth = 9; // mine\n');
    const f = await forecastLane(l);
    expect(f).toMatchObject({ state: 'clean', ahead: 0, behind: 1, uncommitted: 1, files: 1 });
    const res = await landLane(l, 'Shorter idle');
    expect(res).toMatchObject({ ok: true, how: 'rebase', commits: 1 });
    expect(git(r.root, 'log', '--format=%s', '-3').split('\n')).toEqual(['Shorter idle', 'Notes', 'first']);
    expect(readFileSync(path.join(r.root, 'src', 'session.js'), 'utf8')).toBe('export const IDLE = 30;\n');
    expect(readFileSync(path.join(r.root, 'src', 'auth.js'), 'utf8')).toContain('// mine');
  });

  it('lists conflicts before landing and changes nothing when asked to land anyway', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'src', 'session.js'), 'export const IDLE = 30;\n');
    writeFileSync(path.join(l.path, 'src', 'auth.js'), 'export const auth = 2;\n');
    writeFileSync(path.join(r.root, 'src', 'session.js'), 'export const IDLE = 15;\n');
    git(r.root, 'commit', '-q', '-am', 'Fifteen');
    const head = git(r.root, 'rev-parse', 'HEAD');
    const f = await forecastLane(l);
    expect(f).toMatchObject({ state: 'conflicts', conflicts: ['src/session.js'], behind: 1, files: 2 });
    const res = await landLane(l, 'x');
    expect(res.ok).toBe(false);
    expect(res.conflicts).toEqual(['src/session.js']);
    // Neither side moved; the lane's work is still uncommitted where it was.
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(r.root, 'status', '--porcelain')).toBe('');
    expect(git(l.path, 'rev-parse', 'HEAD')).toBe(l.base);
    expect(readFileSync(path.join(l.path, 'src', 'auth.js'), 'utf8')).toBe('export const auth = 2;\n');
  });

  it('will not land over uncommitted edits in the folder', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'src', 'session.js'), 'export const IDLE = 30;\n');
    writeFileSync(path.join(l.path, 'docs.md'), 'lane docs\n');
    writeFileSync(path.join(r.root, 'src', 'session.js'), 'export const IDLE = 1; // unsaved work\n');
    writeFileSync(path.join(r.root, 'docs.md'), 'my own untracked docs\n');
    const f = await forecastLane(l);
    expect(f.state).toBe('blocked');
    expect(f.blocked.sort()).toEqual(['docs.md', 'src/session.js']);
    const res = await landLane(l, 'x');
    expect(res.ok).toBe(false);
    expect(readFileSync(path.join(r.root, 'src', 'session.js'), 'utf8')).toContain('unsaved work');
    expect(readFileSync(path.join(r.root, 'docs.md'), 'utf8')).toBe('my own untracked docs\n');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(l.base);
  });

  it('renames the branch, and discards the lane without touching the shared node_modules', async () => {
    const r = repo();
    const { lane: l } = await lane(r, '4f2a');
    const next = await renameLane(l, 'add-login-form');
    expect(next).toBe('sable/add-login-form');
    expect(git(l.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sable/add-login-form');
    l.branch = next!;
    writeFileSync(path.join(l.path, 'src', 'session.js'), 'export const IDLE = 30;\n');
    git(l.path, 'commit', '-q', '-am', 'unlanded');
    const res = await removeLane(l, { force: true });
    expect(res).toEqual({ ok: true });
    expect(existsSync(l.path)).toBe(false);
    expect(git(r.root, 'branch', '--list', 'sable/*')).toBe('');
    expect(git(r.root, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(r.root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
    expect(readFileSync(path.join(r.root, 'src', 'session.js'), 'utf8')).toBe('export const IDLE = 60;\n');
  });

  it('removes a lane without following a link or junction left deeper inside it', async () => {
    const r = repo();
    const { lane: l } = await lane(r, 'deep');
    // What an install inside the lane leaves: a package's own node_modules linking out of the lane.
    const outside = path.join(r.home, 'outside-store');
    mkdirSync(path.join(outside, 'pkg'), { recursive: true });
    writeFileSync(path.join(outside, 'pkg', 'keep.js'), 'keep\n');
    mkdirSync(path.join(l.path, 'packages', 'a'), { recursive: true });
    symlinkSync(outside, path.join(l.path, 'packages', 'a', 'node_modules'), 'junction');
    expect(await removeLane(l, { force: true })).toEqual({ ok: true });
    expect(existsSync(l.path)).toBe(false);
    expect(readFileSync(path.join(outside, 'pkg', 'keep.js'), 'utf8')).toBe('keep\n');
    expect(git(r.root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('refuses a folder that is not a repository or has no commit', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-lanes-'));
    temps.push(home);
    expect(await createLane({ folder: home, dir: path.join(home, 'l'), slug: 'x' })).toEqual({ error: 'This folder is not a git repository.' });
    git(home, 'init', '-q');
    expect(await createLane({ folder: home, dir: path.join(home, 'l'), slug: 'x' })).toEqual({ error: 'This repository has no commits yet.' });
  });
});

describe('lane checkout integrity', { timeout: gitTestTimeout }, () => {
  it('keeps an empty project subfolder usable in a new checkout', async () => {
    const r = repo();
    const folder = path.join(r.root, '..notes');
    mkdirSync(folder);
    const made = await lane(r, 'inner', folder);
    expect(made.cwd).toBe(path.join(made.lane.path, '..notes'));
    expect(existsSync(made.cwd)).toBe(true);
  });

  it('reports an unusable worktrees folder in words', async () => {
    const r = repo();
    const result = await createLane({ folder: r.root, dir: path.join(r.root, 'README.md', 'lane'), slug: 'folder' });
    expect(result).toEqual({ error: expect.stringMatching(/folder/i) });
    expect(git(r.root, 'branch', '--list', 'sable/*')).toBe('');
  });

  it('allocates distinct branches to simultaneous requests with the same title', async () => {
    const r = repo();
    const made = await Promise.all(['one', 'two', 'three'].map((name) => createLane({ folder: r.root, dir: path.join(r.lanes, name), slug: 'same' })));
    expect(made.every((m) => 'lane' in m)).toBe(true);
    expect(new Set(made.map((m) => 'lane' in m && m.lane.branch)).size).toBe(3);
  });

  it.each(['detached', 'renamed', 'deleted'] as const)('preserves work when the lane branch is %s', async (kind) => {
    const r = repo();
    const { lane: l } = await lane(r);
    if (kind === 'renamed') git(l.path, 'branch', '-m', 'mine');
    else git(l.path, 'switch', '--detach');
    if (kind === 'deleted') git(l.path, 'branch', '-D', l.branch);
    writeFileSync(path.join(l.path, 'valuable'), 'keep me');
    expect((await forecastLane(l)).state).toBe('unavailable');
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect(git(l.path, 'status', '--porcelain')).toContain('?? valuable');
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(l.base);
  });

  it('waits for the original base branch when the folder switched branches', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    git(r.root, 'switch', '-qc', 'unrelated');
    git(r.root, 'branch', '-D', 'main');
    writeFileSync(path.join(l.path, 'work'), 'keep me');
    expect(await forecastLane(l)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('main') });
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect((await laneDiff(l)).map((f) => f.path)).toEqual(['work']);
    expect(git(r.root, 'rev-parse', 'HEAD')).toBe(l.base);
  });

  it('never renames a recycled branch after the worktree switched away', async () => {
    const r = repo();
    const { lane: l } = await lane(r, 'provisional');
    git(l.path, 'switch', '-qc', 'my-checkout');
    expect(await renameLane(l, 'first-message')).toBeNull();
    expect(git(r.root, 'branch', '--list', l.branch)).toContain(l.branch);
    expect(git(l.path, 'branch', '--show-current')).toBe('my-checkout');
  });

  it('leaves an unfinished merge in place even when it has no file changes', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    git(r.root, 'commit', '-q', '--allow-empty', '-m', 'Base checkpoint');
    git(l.path, 'merge', '--no-ff', '--no-commit', 'main');
    expect(git(l.path, 'status', '--porcelain')).toBe('');
    expect((await forecastLane(l)).state).toBe('unavailable');
    expect(await removeLane(l, { keepUnmergedBranch: true })).toHaveProperty('error');
    expect(git(l.path, 'rev-parse', 'MERGE_HEAD')).toBe(git(r.root, 'rev-parse', 'HEAD'));
  });

  it('blocks ignored base files and file versus directory collisions before committing', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(r.root, '.git', 'info', 'exclude'), 'settings.local\n');
    writeFileSync(path.join(r.root, 'settings.local'), 'my settings');
    writeFileSync(path.join(l.path, 'settings.local'), 'lane settings');
    git(l.path, 'add', '-f', 'settings.local');
    mkdirSync(path.join(r.root, 'result'));
    writeFileSync(path.join(r.root, 'result', 'draft'), 'my draft');
    writeFileSync(path.join(l.path, 'result'), 'lane result');
    const f = await forecastLane(l);
    expect(f.state).toBe('blocked');
    expect(f.blocked.sort()).toEqual(['result/draft', 'settings.local']);
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect(git(l.path, 'rev-parse', 'HEAD')).toBe(l.base);
    expect(readFileSync(path.join(r.root, 'settings.local'), 'utf8')).toBe('my settings');
  });

  it('preserves a staged version that differs from the lane working copy', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'README.md'), 'staged');
    git(l.path, 'add', 'README.md');
    writeFileSync(path.join(l.path, 'README.md'), 'unstaged');
    expect((await forecastLane(l)).state).toBe('unavailable');
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect(git(l.path, 'show', ':README.md')).toBe('staged');
  });

  it('preserves local edits inside an initialized submodule', async () => {
    const lib = repo();
    const r = repo();
    writeFileSync(path.join(r.root, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
    git(r.root, 'add', '.gitmodules');
    git(r.root, 'update-index', '--add', '--cacheinfo', '160000,' + git(lib.root, 'rev-parse', 'HEAD') + ',lib');
    git(r.root, 'commit', '-qm', 'Add lib');
    const { lane: l } = await lane(r);
    cpSync(lib.root, path.join(l.path, 'lib'), { recursive: true });
    writeFileSync(path.join(l.path, 'lib', 'README.md'), 'nested work');
    git(l.path, 'config', 'submodule.lib.ignore', 'all');
    writeFileSync(path.join(l.path, 'work'), 'parent work');
    expect(await forecastLane(l)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/submodule/i) });
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect(readFileSync(path.join(l.path, 'lib', 'README.md'), 'utf8')).toBe('nested work');
  });

  it.each(['registered', 'embedded'])('preserves the only repository containing a submodule commit when the parent is clean (%s)', async (kind) => {
    const r = repo();
    const lib = repo();
    if (kind === 'registered') {
      writeFileSync(path.join(r.root, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ./lib\n');
      git(r.root, 'add', '.gitmodules');
    }
    git(r.root, 'update-index', '--add', '--cacheinfo', '160000,' + git(lib.root, 'rev-parse', 'HEAD') + ',lib');
    git(r.root, 'commit', '-qm', 'Add lib');
    mkdirSync(path.join(r.root, 'lib'));
    expect(git(r.root, 'status', '--porcelain')).toBe('');
    const { lane: l } = await lane(r);
    const nested = path.join(l.path, 'lib');
    cpSync(lib.root, nested, { recursive: true });
    git(nested, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'Unpublished');
    git(l.path, 'add', 'lib');
    git(l.path, 'commit', '-qm', 'Use unpublished lib');
    expect(await forecastLane(l)).toMatchObject({ state: 'clean', files: 1 });
    expect((await landLane(l, 'Use lib')).ok).toBe(true);
    expect(await removeLane(l, { keepUnmergedBranch: true })).toMatchObject({ error: expect.stringMatching(/submodule/i) });
    expect(git(nested, 'log', '-1', '--format=%s')).toBe('Unpublished');
  });

  it('lands tracked work beside an ignored lane file and preserves that file on cleanup', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(r.root, '.git', 'info', 'exclude'), 'local-only\n');
    writeFileSync(path.join(l.path, 'local-only'), 'important local data');
    writeFileSync(path.join(l.path, 'new'), 'to land');
    expect(await forecastLane(l)).toMatchObject({ state: 'clean', files: 1 });
    expect((await landLane(l, 'work')).ok).toBe(true);
    expect(await removeLane(l)).toMatchObject({ error: expect.stringContaining('local-only') });
    expect(readFileSync(path.join(l.path, 'local-only'), 'utf8')).toBe('important local data');
  });

  it('lands history-only commits', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    git(l.path, 'commit', '-q', '--allow-empty', '-m', 'Checkpoint');
    expect(await forecastLane(l)).toMatchObject({ state: 'clean', ahead: 1, files: 0 });
    expect((await landLane(l, 'work')).ok).toBe(true);
    expect(git(r.root, 'log', '-1', '--format=%s')).toBe('Checkpoint');
  });

  it('falls back to a two-parent merge without including staged base work', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'README.md'), 'intermediate');
    git(l.path, 'commit', '-qam', 'Intermediate');
    git(l.path, 'restore', '--source', l.base, '--', 'README.md');
    writeFileSync(path.join(l.path, 'work'), 'result');
    git(l.path, 'add', '-A');
    git(l.path, 'commit', '-qm', 'Final');
    const tip = git(l.path, 'rev-parse', 'HEAD');
    writeFileSync(path.join(r.root, 'README.md'), 'new base');
    git(r.root, 'commit', '-qam', 'Base moved');
    const base = git(r.root, 'rev-parse', 'HEAD');
    writeFileSync(path.join(r.root, 'mine'), 'keep staged');
    git(r.root, 'add', 'mine');
    expect(await landLane(l, 'land')).toMatchObject({ ok: true, how: 'merge' });
    expect(git(r.root, 'show', '-s', '--format=%P', 'HEAD')).toBe([base, tip].join(' '));
    expect(git(r.root, 'status', '--porcelain')).toBe('A  mine');
  });

  it('keeps a detached base untouched and compares lane files from their fork point', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'work'), 'local');
    writeFileSync(path.join(r.root, 'other'), 'base only');
    git(r.root, 'add', 'other');
    git(r.root, 'commit', '-qm', 'Advance base');
    expect((await laneDiff(l)).map((f) => f.path)).toEqual(['work']);
    git(r.root, 'switch', '--detach');
    expect(await forecastLane(l)).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('branch') });
    expect((await landLane(l, 'work')).ok).toBe(false);
    expect(git(r.root, 'status', '--porcelain')).toBe('');
  });

  it('omits already landed commits from the lane diff when the base checkout switches away', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    writeFileSync(path.join(l.path, 'already landed'), 'first');
    git(l.path, 'add', '-A');
    git(l.path, 'commit', '-qm', 'First part');
    git(r.root, 'merge', '--ff-only', l.branch);
    writeFileSync(path.join(l.path, 'still to land'), 'second');
    git(r.root, 'switch', '-qc', 'other', l.base);
    expect((await laneDiff(l)).map((f) => f.path)).toEqual(['still to land']);
  });

  it('refuses an unrelated folder at the old lane path and respects a locked lane', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    git(r.root, 'worktree', 'lock', l.path);
    expect(await removeLane(l, { force: true })).toHaveProperty('error');
    expect(existsSync(l.path)).toBe(true);
    git(r.root, 'worktree', 'unlock', l.path);
    renameSync(l.path, l.path + '-saved');
    mkdirSync(l.path);
    writeFileSync(path.join(l.path, 'mine'), 'keep');
    expect(await removeLane(l, { force: true })).toHaveProperty('error');
    expect(readFileSync(path.join(l.path, 'mine'), 'utf8')).toBe('keep');
  });

  it('forgets only the requested missing checkout, before or after Git prunes it', async () => {
    const r = repo();
    const { lane: a } = await lane(r, 'first');
    const { lane: b } = await lane(r, 'second');
    rmSync(a.path, { recursive: true, force: true });
    rmSync(b.path, { recursive: true, force: true });
    expect((await forecastLane(a)).reason).toMatch(/gone/);
    expect(await removeLane(a, { force: true })).toEqual({ ok: true });
    expect(git(r.root, 'worktree', 'list', '--porcelain')).toContain(b.branch);
    git(r.root, 'worktree', 'prune');
    expect(await removeLane(b, { force: true })).toEqual({ ok: true });
    expect(git(r.root, 'branch', '--list', 'sable/*')).toBe('');
  });

  it('lists usable locked and detached trees with literal branch names and omits missing trees', async () => {
    const r = repo();
    const branch = "feature/tom's-$fix";
    const dir = path.join(r.home, 'linked checkout');
    git(r.root, 'worktree', 'add', '-qb', branch, dir);
    git(r.root, 'worktree', 'lock', dir);
    const detached = path.join(r.home, 'detached');
    git(r.root, 'worktree', 'add', '-q', '--detach', detached);
    const gone = await lane(r, 'gone');
    rmSync(gone.cwd, { recursive: true, force: true });
    const trees = await gitWorktrees(dir);
    expect(trees.map((w) => w.path).sort()).toEqual([r.root, dir, detached].sort());
    expect(trees.find((w) => w.path === dir)?.branch).toBe(branch);
    expect(trees.find((w) => w.path === detached)?.head).toBe(git(dir, 'rev-parse', 'HEAD').slice(0, 7));
  });

  it('reads a checkout across drive letters and excludes shared project tools from lookup', async () => {
    const r = repo();
    const scratch = path.resolve('scratch/day6/lanes');
    mkdirSync(scratch, { recursive: true });
    const other = mkdtempSync(path.join(scratch, 'repo with spaces '));
    temps.push(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'config', 'user.name', 'Test');
    git(other, 'config', 'user.email', 'test@example.com');
    git(other, 'config', 'commit.gpgsign', 'false');
    git(other, 'commit', '-qm', 'first', '--allow-empty');
    const made = await createLane({ folder: other, dir: path.join(r.lanes, 'my lane'), slug: 'cross-drive' });
    if ('error' in made) throw new Error(made.error);
    const excluded = projectFolders(made.cwd);
    const bin = path.join(other, 'bin');
    expect(findProgram('tool', { outside: excluded, env: { Path: bin, PATH: bin }, isProgram: () => true })).toBeNull();
    expect((await gitStatus(made.cwd)).branch).toBe(made.lane.branch);
    expect((await gitWorktrees(made.cwd)).map((w) => w.path)).toContain(other);
    writeFileSync(path.join(made.cwd, 'across drives'), 'in the lane');
    expect(await forecastLane(made.lane)).toMatchObject({ state: 'clean', uncommitted: 1 });
    expect(git(made.cwd, 'diff', '--cached', '--name-only')).toBe('');
    expect(await landLane(made.lane, 'Across drives')).toMatchObject({ ok: true });
    expect(readFileSync(path.join(other, 'across drives'), 'utf8')).toBe('in the lane');
  });

  it('identifies the current branch when home picked a junction to the checkout', async () => {
    const r = repo();
    const { lane: l } = await lane(r);
    const alias = path.join(r.home, 'shortcut');
    symlinkSync(l.path, alias, 'junction');
    const list = await gitWorktrees(path.join(alias, 'src'));
    expect(list.find((tree) => tree.path === alias)?.branch).toBe(l.branch);
  });

  it('carries the latest conversation back from the lane', () => {
    const r = repo();
    const next = path.join(r.lanes, 'chat');
    const transcript = (cwd: string) => path.join(r.home, 'projects', claudeFolderKey(cwd), 'abc.jsonl');
    mkdirSync(path.dirname(transcript(r.root)), { recursive: true });
    writeFileSync(transcript(r.root), 'first');
    expect(carryClaudeToFolder(r.home, 'abc', next, r.root)).toBe(true);
    writeFileSync(transcript(next), 'second');
    expect(carryClaudeToFolder(r.home, 'abc', r.root, next)).toBe(true);
    expect(readFileSync(transcript(r.root), 'utf8')).toBe('second');
    // Some existing conversations have their transcript under a different provider folder key.
    renameSync(path.dirname(transcript(next)), path.join(r.home, 'projects', 'previous-key'));
    writeFileSync(path.join(r.home, 'projects', 'previous-key', 'abc.jsonl'), 'third');
    expect(carryClaudeToFolder(r.home, 'abc', r.root, next)).toBe(true);
    expect(readFileSync(transcript(r.root), 'utf8')).toBe('third');
  });
});

describe('worktrees folder', () => {
  it('defaults to the lanes folder under Sable home, and resolves a chosen folder and ~', () => {
    const user = path.resolve('/people/ada');
    const sable = path.join(user, '.sable');
    expect(worktreesRoot(undefined, user, sable)).toBe(path.join(sable, 'lanes'));
    expect(worktreesRoot('  ', user, sable)).toBe(path.join(sable, 'lanes'));
    expect(worktreesRoot('~/Worktrees', user, sable)).toBe(path.resolve(user, 'Worktrees'));
    expect(worktreesRoot('~', user, sable)).toBe(path.resolve(user));
    expect(worktreesRoot(path.resolve('/data/wt'), user, sable)).toBe(path.resolve('/data/wt'));
  });
});
