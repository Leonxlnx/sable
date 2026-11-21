import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPull, draftFrom, parseLog, pullContext, type GhResult, type GhRunner } from '../server/services/pulls';

let base = '';
let repo = '';
let origin = '';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A gh stand-in: records what it was asked and answers as the given result. */
function fakeGh(answer: Partial<GhResult> & { code: number | null }) {
  const calls: { args: string[]; input: string }[] = [];
  const run: GhRunner = async (_cwd, args, input = '') => {
    calls.push({ args, input });
    return { stdout: '', stderr: '', missing: false, timedOut: false, ...answer };
  };
  return { run, calls };
}

// gh that cannot say the default branch: the pull request falls back to origin's HEAD, then to main.
const noGitHub = fakeGh({ code: 1, stderr: 'not a GitHub repository' });

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'sable-pulls-'));
  origin = path.join(base, 'origin.git');
  repo = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { windowsHide: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Initial commit');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feature/login-rate-limit');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Limit login attempts', '-m', 'Five per minute.');
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('pull requests', () => {
  it('reads the branch, its base, the commits it adds and a draft title and description', async () => {
    const ctx = await pullContext(repo, noGitHub.run);
    expect(ctx).toMatchObject({
      isRepo: true,
      branch: 'feature/login-rate-limit',
      base: 'main',
      remote: true,
      commits: ['Limit login attempts'],
      title: 'Limit login attempts',
      body: 'Five per minute.',
    });
  });

  it('pushes the branch and opens the pull request with gh, the description on stdin', async () => {
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/7\n' });
    const res = await createPull(repo, { title: ' Limit login attempts ', body: 'Five per minute.\r\n', base: 'main', draft: true }, gh.run);
    expect(res).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/7', number: 7 });
    expect(git(repo, 'ls-remote', 'origin', 'refs/heads/feature/login-rate-limit')).toContain('refs/heads/feature/login-rate-limit');
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0].args).toEqual([
      'pr', 'create', '--title', 'Limit login attempts', '--body-file', '-', '--base', 'main', '--head', 'feature/login-rate-limit', '--draft',
    ]);
    expect(gh.calls[0].input).toBe('Five per minute.\n');
  });

  it('refuses the base branch, a missing title and a missing gh', async () => {
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/8\n' });
    git(repo, 'checkout', '-q', 'main');
    expect(await createPull(repo, { title: 'x', body: '', base: 'main', draft: false }, gh.run)).toEqual({
      ok: false,
      error: 'This is main. Make a branch for the pull request first.',
    });
    git(repo, 'checkout', '-q', 'feature/login-rate-limit');
    expect(await createPull(repo, { title: '  ', body: '', base: 'main', draft: false }, gh.run)).toEqual({ ok: false, error: 'Write a title first.' });
    const missing = fakeGh({ code: null, missing: true });
    const res = await createPull(repo, { title: 'x', body: '', base: 'main', draft: false }, missing.run);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not installed/);
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps the link when a pull request already exists for the branch', async () => {
    const gh = fakeGh({ code: 1, stderr: 'a pull request for branch "feature/login-rate-limit" into branch "main" already exists:\nhttps://github.com/acme/app/pull/3' });
    const res = await createPull(repo, { title: 'x', body: '', base: 'main', draft: false }, gh.run);
    expect(res.ok).toBe(false);
    expect(res.url).toBe('https://github.com/acme/app/pull/3');
  });

  it('drafts a title from one commit, or from the branch and a list of commits', () => {
    expect(draftFrom('fix/x', [{ subject: 'Fix it', body: 'Because.' }])).toEqual({ title: 'Fix it', body: 'Because.' });
    expect(draftFrom('feature/login-rate-limit', [{ subject: 'A', body: '' }, { subject: 'B', body: '' }])).toEqual({
      title: 'Login rate limit',
      body: '- A\n- B',
    });
    expect(draftFrom('feature/empty', [])).toEqual({ title: 'Empty', body: '' });
  });

  it('parses git log records with a subject and a body', () => {
    expect(parseLog('One\x1fbody one\x1e\nTwo\x1f\x1e')).toEqual([
      { subject: 'One', body: 'body one' },
      { subject: 'Two', body: '' },
    ]);
  });
});
