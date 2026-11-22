import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { branchLike, createPull, shownRemote, draftFrom, gitHubOwner, parseLog, pullContext, type GhResult, type GhRunner, type PullApproval } from '../server/services/pulls';

// Every test here runs real git several times: on a busy machine that passes the default 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

/** What the dialog sends back: the person's words plus the branch, commit and addresses it showed. */
async function approve(dir: string, o: { title: string; body: string; base: string; draft: boolean }, gh: GhRunner = noGitHub.run): Promise<PullApproval> {
  const ctx = await pullContext(dir, gh);
  return { ...o, branch: ctx.branch, head: ctx.head, destination: ctx.destination, repo: ctx.repo };
}

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
    const res = await createPull(repo, await approve(repo, { title: ' Limit login attempts ', body: 'Five per minute.\r\n', base: 'main', draft: true }), gh.run);
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
    expect(await createPull(repo, await approve(repo, { title: 'x', body: '', base: 'main', draft: false }), gh.run)).toEqual({
      ok: false,
      error: 'This is main. Make a branch for the pull request first.',
    });
    git(repo, 'checkout', '-q', 'feature/login-rate-limit');
    expect(await createPull(repo, await approve(repo, { title: '  ', body: '', base: 'main', draft: false }), gh.run)).toEqual({ ok: false, error: 'Write a title first.' });
    const missing = fakeGh({ code: null, missing: true });
    const res = await createPull(repo, await approve(repo, { title: 'x', body: '', base: 'main', draft: false }), missing.run);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not installed/);
    expect(gh.calls).toHaveLength(0);
  });

  it('keeps the link when a pull request already exists for the branch', async () => {
    const gh = fakeGh({ code: 1, stderr: 'a pull request for branch "feature/login-rate-limit" into branch "main" already exists:\nhttps://github.com/acme/app/pull/3' });
    const res = await createPull(repo, await approve(repo, { title: 'x', body: '', base: 'main', draft: false }), gh.run);
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

describe('the push goes where the dialog said, with what it said (review wave 8, finding 4)', () => {
  const ghAnswers: GhRunner = async (_cwd, args) => {
    if (args[0] === 'repo') return { code: 0, stdout: 'acme/app main\n', stderr: '', missing: false, timedOut: false };
    return { code: 0, stdout: 'https://github.com/acme/app/pull/9\n', stderr: '', missing: false, timedOut: false };
  };
  let other = '';
  let third = '';

  beforeAll(() => {
    other = path.join(base, 'elsewhere.git');
    third = path.join(base, 'third.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', other], { windowsHide: true });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', third], { windowsHide: true });
  });

  afterAll(() => {
    spawnSync('git', ['config', '--unset-all', 'remote.origin.pushurl'], { cwd: repo, windowsHide: true });
    spawnSync('git', ['config', '--unset', 'push.followTags'], { cwd: repo, windowsHide: true });
  });

  it('shows a separate push URL, not the fetch URL, and pushes only there', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/push-url');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Push elsewhere');
    git(repo, 'config', 'remote.origin.pushurl', other);
    const ctx = await pullContext(repo, ghAnswers);
    expect(ctx.pushUrls).toEqual([other]);
    expect(ctx.repo).toBe('acme/app');
    expect(ctx.commitCount).toBe(2);
    expect(ctx.head).toMatch(/^[0-9a-f]{40}$/);
    const calls: string[][] = [];
    const gh: GhRunner = async (c, args, i, t) => (calls.push(args), ghAnswers(c, args, i, t));
    const res = await createPull(repo, { title: 'T', body: '', base: 'main', draft: false, branch: ctx.branch, head: ctx.head, destination: ctx.destination, repo: ctx.repo }, gh);
    expect(res.ok).toBe(true);
    expect(git(repo, 'ls-remote', other, 'refs/heads/feature/push-url')).toContain(ctx.head!);
    expect(git(repo, 'ls-remote', origin, 'refs/heads/feature/push-url')).toBe('');
    expect(calls[0]).toEqual(['pr', 'create', '--repo', 'acme/app', '--title', 'T', '--body-file', '-', '--base', 'main', '--head', 'feature/push-url']);
  });

  it('lists every push URL when origin has several', async () => {
    git(repo, 'config', '--add', 'remote.origin.pushurl', third);
    const ctx = await pullContext(repo, ghAnswers);
    expect(ctx.pushUrls).toEqual([other, third]);
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
  });

  it('pushes nothing when the push URL changed after the dialog opened', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/moved-url');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Moved url');
    const shown = await approve(repo, { title: 'T', body: '', base: 'main', draft: false }, ghAnswers);
    git(repo, 'config', 'remote.origin.pushurl', third);
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/10\n' });
    const res = await createPull(repo, shown, gh.run);
    expect(res).toMatchObject({ ok: false, stale: true });
    expect(git(repo, 'ls-remote', third, 'refs/heads/feature/moved-url')).toBe('');
    expect(gh.calls).toHaveLength(0);
    git(repo, 'config', '--unset-all', 'remote.origin.pushurl');
  });

  it('pushes nothing when the branch got another commit or another branch was checked out meanwhile', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/moved-head');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Shown');
    const shown = await approve(repo, { title: 'T', body: '', base: 'main', draft: false });
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Not shown');
    expect(await createPull(repo, shown, noGitHub.run)).toMatchObject({ ok: false, stale: true });
    git(repo, 'checkout', '-q', '-b', 'feature/other-branch');
    const again = { ...shown, head: (await pullContext(repo, noGitHub.run)).head };
    expect(await createPull(repo, again, noGitHub.run)).toMatchObject({ ok: false, stale: true });
    expect(git(repo, 'ls-remote', origin, 'refs/heads/feature/moved-head')).toBe('');
    expect(git(repo, 'ls-remote', origin, 'refs/heads/feature/other-branch')).toBe('');
  });

  it('sends no tags with the branch, whatever push.followTags says', async () => {
    git(repo, 'checkout', '-q', '-b', 'feature/tagged');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'Tagged');
    git(repo, 'tag', '-a', 'v-secret', '-m', 'internal');
    git(repo, 'config', 'push.followTags', 'true');
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/11\n' });
    const res = await createPull(repo, await approve(repo, { title: 'T', body: '', base: 'main', draft: false }), gh.run);
    expect(res.ok).toBe(true);
    expect(git(repo, 'ls-remote', origin, 'refs/tags/v-secret')).toBe('');
  });

  it('refuses a click that carries no approval at all', async () => {
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/12\n' });
    expect(await createPull(repo, { title: 'T', body: '', base: 'main', draft: false }, gh.run)).toMatchObject({ ok: false, stale: true });
    expect(gh.calls).toHaveLength(0);
  });

  it('names a fork\'s branch with its owner', () => {
    expect(gitHubOwner('https://github.com/me/app.git')).toBe('me');
    expect(gitHubOwner('git@github.com:me/app.git')).toBe('me');
    expect(gitHubOwner('ssh://git@github.com/me/app')).toBe('me');
    expect(gitHubOwner('https://gitlab.com/me/app.git')).toBeUndefined();
  });
});

describe('what a pull request shows and accepts', () => {
  it('shows the remote without a token in it', () => {
    expect(shownRemote('https://someone:ghp_secret@github.com/acme/app.git\n')).toBe('https://github.com/acme/app.git');
    expect(shownRemote('git@github.com:acme/app.git')).toBe('git@github.com:acme/app.git');
  });

  it('takes only branch names, never one that reads as an option', async () => {
    expect(branchLike('main')).toBe(true);
    expect(branchLike('feature/login-rate-limit')).toBe(true);
    expect(branchLike('--output=x')).toBe(false);
    expect(branchLike('a..b')).toBe(false);
    expect(branchLike('a b')).toBe(false);
    const gh = fakeGh({ code: 0, stdout: 'https://github.com/acme/app/pull/8\n' });
    const res = await createPull(repo, await approve(repo, { title: 'T', body: '', base: '--repo=evil/app', draft: false }), gh.run);
    expect(res.ok).toBe(false);
    expect(gh.calls).toHaveLength(0);
  });
});
