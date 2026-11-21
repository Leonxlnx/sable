import { spawn } from 'node:child_process';
import path from 'node:path';
import type { GitPullContext, GitPullRequestResult } from '../../shared/protocol';
import type { App } from '../app';
import { gitError, repoRoot, runGit } from './git';

/**
 * Pull requests from the Changes tab: the branch is pushed to `origin` (with its upstream), then the
 * GitHub CLI (`gh pr create`) opens the pull request with the title and description the person
 * wrote, the description on stdin. Sable keeps nothing: gh holds the sign-in, git the remote.
 */

export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** gh is not installed / not on PATH. */
  missing: boolean;
  timedOut: boolean;
}

/** Runs gh the way runGit runs git: no shell, a timeout, never rejects. */
export type GhRunner = (cwd: string, args: string[], input?: string, timeoutMs?: number) => Promise<GhResult>;

/** The most of gh's output kept per call. */
const GH_MAX_BYTES = 1_000_000;

/** A branch name git would take (no leading dash, nothing git refuses in a ref), so it can never read as an option. */
export const branchLike = (name: string) => /^[^-\s~^:?*[\\][^\s~^:?*[\\]*$/.test(name) && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock');

/** A remote's address as it can be shown: any user name or token in it is left out. */
export function shownRemote(url: string): string {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // scp-like (git@github.com:acme/app.git) or a path: shown as it is.
    return u;
  }
}

export function runGh(cwd: string, args: string[], input = '', timeoutMs = 60_000): Promise<GhResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, missing = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), missing, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('gh', args, {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(null);
    }, timeoutMs);
    // Kept to a bound: what gh says is a link or a few lines, never more than this.
    let kept = 0;
    const keep = (list: Buffer[]) => (d: Buffer) => {
      if (kept >= GH_MAX_BYTES) return;
      list.push(d);
      kept += d.length;
    };
    child.stdout!.on('data', keep(out));
    child.stderr!.on('data', keep(err));
    child.on('error', (e: NodeJS.ErrnoException) => finish(null, e.code === 'ENOENT'));
    child.on('close', (code) => finish(code));
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}

/** What gh said, in a line or two a person can act on. */
export function ghError(r: GhResult, fallback: string): string {
  if (r.missing) return 'The GitHub CLI (gh) is not installed. Install it from cli.github.com, then run gh auth login.';
  if (r.timedOut) return 'GitHub took too long to answer.';
  const text = `${r.stderr}\n${r.stdout}`;
  if (/gh auth login|not logged in|authentication required/i.test(text)) return 'Sign in to GitHub first: run gh auth login.';
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(0, 3)
    .join(' ');
  return lines || fallback;
}

/** A title and description from the commits a pull request brings: one commit's own, or a list of subjects. */
export function draftFrom(branch: string | undefined, commits: { subject: string; body: string }[]): { title: string; body: string } {
  if (commits.length === 0) return { title: branch ? humanBranch(branch) : '', body: '' };
  if (commits.length === 1) return { title: commits[0].subject, body: commits[0].body };
  return { title: branch ? humanBranch(branch) : commits[0].subject, body: commits.map((c) => `- ${c.subject}`).join('\n') };
}

/** `feature/login-rate-limit` reads as "Login rate limit". */
function humanBranch(branch: string): string {
  const words = (branch.split('/').pop() ?? branch).replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

interface Commit {
  subject: string;
  body: string;
}

/** `git log --format=%s%x1f%b%x1e` output: one record per commit, subject and body split by a unit separator. */
export function parseLog(text: string): Commit[] {
  return text
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [subject = '', body = ''] = rec.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  return (await runGit(dir, ['rev-parse', '--verify', '--quiet', ref], { timeoutMs: 5000 })).code === 0;
}

/** The repository's default branch, from GitHub when gh can say, else from origin's HEAD, else `main`. */
async function defaultBranch(dir: string, gh: GhRunner): Promise<string> {
  const r = await gh(dir, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], '', 15_000);
  const fromGitHub = r.code === 0 ? r.stdout.trim() : '';
  if (fromGitHub) return fromGitHub;
  const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 5000 });
  const fromRemote = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
  return fromRemote || 'main';
}

/** What the Changes tab needs to offer a pull request: the branch, its base, the commits it adds, a draft title and description. */
export async function pullContext(cwd: string, gh: GhRunner = runGh): Promise<GitPullContext> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { isRepo: false, remote: false, commits: [], title: '', body: '' };
  const [cur, remote] = await Promise.all([
    runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 }),
    runGit(dir, ['remote', 'get-url', 'origin'], { timeoutMs: 5000 }),
  ]);
  const branch = cur.code === 0 ? cur.stdout.trim() || undefined : undefined;
  const found = await defaultBranch(dir, gh);
  // A name that is not a branch (it would reach git and gh as an argument) falls back to main.
  const base = branchLike(found) ? found : 'main';
  let commits: Commit[] = [];
  if (branch) {
    // Against the base as GitHub has it when origin knows it, else the local base.
    const range = (await refExists(dir, `origin/${base}`)) ? `origin/${base}..HEAD` : `${base}..HEAD`;
    const log = await runGit(dir, ['log', '--reverse', '--format=%s%x1f%b%x1e', range], { timeoutMs: 10_000 });
    if (log.code === 0) commits = parseLog(log.stdout);
  }
  const { title, body } = draftFrom(branch, commits);
  return { isRepo: true, branch, base, remote: remote.code === 0, ...(remote.code === 0 && remote.stdout.trim() ? { remoteUrl: shownRemote(remote.stdout) } : {}), commits: commits.map((c) => c.subject), title, body };
}

/** Pushes the branch to origin and opens a pull request for it into `base`. */
export async function createPull(
  cwd: string,
  o: { title: string; body: string; base: string; draft: boolean },
  gh: GhRunner = runGh,
): Promise<GitPullRequestResult> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { ok: false, error: 'This folder is not a git repository.' };
  const title = o.title.trim();
  if (!title) return { ok: false, error: 'Write a title first.' };
  const base = o.base.trim();
  if (!base) return { ok: false, error: 'Choose the branch to merge into.' };
  if (!branchLike(base)) return { ok: false, error: `${base} is not a branch name.` };
  const cur = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 });
  const branch = cur.code === 0 ? cur.stdout.trim() : '';
  if (!branch) return { ok: false, error: 'This folder is on a detached HEAD. Check out a branch first.' };
  if (!branchLike(branch)) return { ok: false, error: `${branch} is not a branch name gh can open a pull request for.` };
  if (branch === base) return { ok: false, error: `This is ${base}. Make a branch for the pull request first.` };
  const remote = await runGit(dir, ['remote', 'get-url', 'origin'], { timeoutMs: 5000 });
  if (remote.code !== 0) return { ok: false, error: 'This repository has no remote named origin.' };

  // Pushed with its upstream, so the pull request's head is on GitHub before gh opens it.
  const push = await runGit(dir, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { timeoutMs: 120_000 });
  if (push.code !== 0) return { ok: false, error: gitError(push, 'The push failed.') };

  const args = ['pr', 'create', '--title', title, '--body-file', '-', '--base', base, '--head', branch];
  if (o.draft) args.push('--draft');
  const r = await gh(dir, args, o.body.replace(/\r\n/g, '\n'), 60_000);
  const url = `${r.stdout}\n${r.stderr}`.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  if (r.code === 0 && url) return { ok: true, url, number: Number(url.split('/').pop()) };
  // gh names the pull request that already exists for this branch: the link goes with the error.
  return { ok: false, error: ghError(r, 'The pull request could not be created.'), url };
}

export function registerPulls(app: App) {
  app.register('pulls.context', ({ cwd }) => pullContext(cwd));
  app.register('pulls.create', ({ cwd, title, body, base, draft }) =>
    createPull(cwd, { title: String(title ?? ''), body: String(body ?? ''), base: String(base ?? ''), draft: draft === true }),
  );
}
