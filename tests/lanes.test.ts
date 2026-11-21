/** Lanes at the git level, on temporary repositories only. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLane, forecastLane, landLane, laneSlug, removeLane, renameLane } from '../server/services/git-lanes';
import { worktreesRoot } from '../server/core/lanes';
import type { SessionLane } from '@shared/protocol';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit on `main`, an ignored node_modules, and a lanes folder beside it. */
function repo() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-lanes-'));
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

describe('lanes', { timeout: 30_000 }, () => {
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
