import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GitPullContext, GitPullRequestResult } from '../../shared/protocol';
import type { App } from '../app';
import { findProgram } from '../util/which';
import { gitError, repoRoot, runGit } from './git';

/**
 * Pull requests from the Changes tab: the branch is pushed to `origin` (with its upstream), then the
 * GitHub CLI (`gh pr create`) opens the pull request with the title and description the person
 * wrote, the description on stdin. Sable keeps nothing: gh holds the sign-in, git the remote.
 *
 * What the dialog shows is what happens: every address git pushes origin to (a separate push URL,
 * several, rewrites), the exact commit and the commits it brings, and the repository gh opens the
 * pull request in. The click sends that approval back; if the branch, its commit or the addresses
 * changed meanwhile nothing is pushed and the dialog reads them again. gh and git are run by their
 * absolute paths from PATH, never from the repository (server/util/which.ts).
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
  // A path (C:\repos\app.git, /srv/app.git) or scp-like address has no credentials to drop.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
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
    // gh from PATH, never a gh.exe the repository brings (server/util/which.ts). It works in the
    // folder (it reads the remotes there) and finds git itself without looking in it.
    const gh = findProgram('gh', { outside: [path.resolve(cwd)] });
    if (!gh) {
      resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
      return;
    }
    try {
      child = spawn(gh, args, {
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

/** `owner/name` as GitHub writes it, nothing that could read as an option. */
const repoLike = (s: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith('-');

/** The repository gh opens the pull request in, and its default branch, when gh can say. */
async function gitHubRepo(dir: string, gh: GhRunner): Promise<{ repo?: string; base?: string }> {
  const r = await gh(dir, ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef', '--jq', '.nameWithOwner + " " + .defaultBranchRef.name'], '', 15_000);
  if (r.code !== 0) return {};
  const [repo = '', base = ''] = r.stdout.trim().split(/\s+/);
  return { ...(repoLike(repo) ? { repo } : {}), ...(base ? { base } : {}) };
}

/** The default branch from origin's HEAD, else `main`. */
async function originBase(dir: string): Promise<string> {
  const head = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: 5000 });
  return (head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '') || 'main';
}

/**
 * Every address `git push origin` sends to, as git itself resolves them: a separate push URL,
 * several of them, `pushInsteadOf` and `insteadOf` rewrites all count. Null when origin is missing.
 */
export async function pushUrls(dir: string): Promise<string[] | null> {
  const r = await runGit(dir, ['remote', 'get-url', '--push', '--all', 'origin'], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** A short fingerprint of where the push goes (the full addresses, tokens included), to check it did not change. */
export const destinationOf = (urls: string[]) => createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 32);

/** `owner` of a GitHub address (https, ssh or scp-like), or undefined. */
export function gitHubOwner(url: string): string | undefined {
  const m = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/i);
  return m?.[1];
}

/** The commit HEAD names, in full. */
async function headCommit(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 5000 });
  const sha = r.code === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
}

/** The most commit subjects the dialog lists (the count is always exact). */
const MAX_LISTED = 50;

/** What the Changes tab needs to offer a pull request: the branch, its base, the commits it adds, a draft title and description. */
export async function pullContext(cwd: string, gh: GhRunner = runGh): Promise<GitPullContext> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { isRepo: false, remote: false, commits: [], title: '', body: '' };
  const [cur, urls, head] = await Promise.all([runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 }), pushUrls(dir), headCommit(dir)]);
  const branch = cur.code === 0 ? cur.stdout.trim() || undefined : undefined;
  const hub = await gitHubRepo(dir, gh);
  const found = hub.base ?? (await originBase(dir));
  // A name that is not a branch (it would reach git and gh as an argument) falls back to main.
  const base = branchLike(found) ? found : 'main';
  let commits: Commit[] = [];
  let count = 0;
  if (branch && head) {
    // Exactly what the push brings: the commits from the base (as GitHub has it when origin knows it) to this HEAD.
    const range = (await refExists(dir, `origin/${base}`)) ? `origin/${base}..${head}` : `${base}..${head}`;
    const [log, n] = await Promise.all([
      runGit(dir, ['log', '--reverse', '--format=%s%x1f%b%x1e', range], { timeoutMs: 10_000, maxBytes: 2_000_000 }),
      runGit(dir, ['rev-list', '--count', range], { timeoutMs: 10_000 }),
    ]);
    if (log.code === 0) commits = parseLog(log.stdout);
    count = n.code === 0 ? Number(n.stdout.trim()) || commits.length : commits.length;
  }
  const { title, body } = draftFrom(branch, commits);
  const remote = urls !== null && urls.length > 0;
  return {
    isRepo: true,
    branch,
    base,
    remote,
    ...(remote ? { pushUrls: urls.map(shownRemote), destination: destinationOf(urls) } : {}),
    ...(head ? { head } : {}),
    ...(hub.repo ? { repo: hub.repo } : {}),
    commits: commits.slice(0, MAX_LISTED).map((c) => c.subject.slice(0, 200)),
    commitCount: count,
    title: title.slice(0, 256),
    body: body.slice(0, 20_000),
  };
}

/** What the person saw and approved in the dialog: the push goes there with that commit, or not at all. */
export interface PullApproval {
  title: string;
  body: string;
  base: string;
  draft: boolean;
  /** The branch shown. */
  branch?: string;
  /** The commit shown (full). */
  head?: string;
  /** `destination` from the context. */
  destination?: string;
  /** The GitHub repository shown (`owner/name`). */
  repo?: string;
}

const STALE = 'The branch, its commits or where origin pushes changed since this dialog opened. Check them again.';

/** Pushes the approved commit to origin's approved addresses and opens a pull request for it into `base`. */
export async function createPull(cwd: string, o: PullApproval, gh: GhRunner = runGh): Promise<GitPullRequestResult> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { ok: false, error: 'This folder is not a git repository.' };
  const title = o.title.trim();
  if (!title) return { ok: false, error: 'Write a title first.' };
  const base = o.base.trim();
  if (!base) return { ok: false, error: 'Choose the branch to merge into.' };
  if (!branchLike(base)) return { ok: false, error: `${base} is not a branch name.` };
  if (o.repo !== undefined && !repoLike(o.repo)) return { ok: false, error: `${o.repo} is not a GitHub repository name.` };
  if (!o.branch || !o.head || !o.destination) return { ok: false, error: STALE, stale: true };
  const cur = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 });
  const branch = cur.code === 0 ? cur.stdout.trim() : '';
  if (!branch) return { ok: false, error: 'This folder is on a detached HEAD. Check out a branch first.' };
  if (!branchLike(branch)) return { ok: false, error: `${branch} is not a branch name gh can open a pull request for.` };
  if (branch === base) return { ok: false, error: `This is ${base}. Make a branch for the pull request first.` };
  const urls = await pushUrls(dir);
  if (urls === null || urls.length === 0) return { ok: false, error: 'This repository has no remote named origin.' };
  // The same branch, the same commit, the same addresses as shown; anything else is looked at again first.
  if (branch !== o.branch || (await headCommit(dir)) !== o.head || destinationOf(urls) !== o.destination) return { ok: false, error: STALE, stale: true };

  // The approved commit (not whatever HEAD is by now), with its upstream, so the pull request's head
  // is on GitHub before gh opens it. Nothing else goes: no tags, no submodule commits.
  const push = await runGit(dir, ['push', '--no-follow-tags', '--recurse-submodules=no', '--set-upstream', 'origin', `${o.head}:refs/heads/${branch}`], { timeoutMs: 120_000 });
  if (push.code !== 0) return { ok: false, error: gitError(push, 'The push failed.') };

  // A fork's branch is named with its owner, so gh opens the pull request for the branch just pushed.
  const owners = [...new Set(urls.map(gitHubOwner))];
  const baseOwner = o.repo?.split('/')[0];
  const owner = owners.length === 1 ? owners[0] : undefined;
  const headRef = owner && baseOwner && owner.toLowerCase() !== baseOwner.toLowerCase() ? `${owner}:${branch}` : branch;
  const args = ['pr', 'create', ...(o.repo ? ['--repo', o.repo] : []), '--title', title, '--body-file', '-', '--base', base, '--head', headRef];
  if (o.draft) args.push('--draft');
  const r = await gh(dir, args, o.body.replace(/\r\n/g, '\n'), 60_000);
  const url = `${r.stdout}\n${r.stderr}`.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  if (r.code === 0 && url) return { ok: true, url, number: Number(url.split('/').pop()) };
  // gh names the pull request that already exists for this branch: the link goes with the error.
  return { ok: false, error: ghError(r, 'The pull request could not be created.'), url };
}

const opt = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export function registerPulls(app: App) {
  app.register('pulls.context', ({ cwd }) => pullContext(cwd));
  app.register('pulls.create', ({ cwd, title, body, base, draft, branch, head, destination, repo }) =>
    createPull(cwd, {
      title: String(title ?? ''),
      body: String(body ?? ''),
      base: String(base ?? ''),
      draft: draft === true,
      branch: opt(branch),
      head: opt(head),
      destination: opt(destination),
      repo: opt(repo),
    }),
  );
}
