import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { GitPullContext, GitPullRequestResult, PullCheck, PullFailures, PullRequestInfo, PullStatus } from '../../shared/protocol';
import type { App } from '../app';
import { findProgram, projectFolders } from '../util/which';
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
 *
 * Once the branch has a pull request the tab shows it with its checks (`pulls.status`, further
 * down): read-only, gh started only for an origin on github.com, everything it says bounded. On the
 * person's click the end of the failed checks' logs becomes a message for the chat (`pulls.failures`).
 */

export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** gh is not installed / not on PATH. */
  missing: boolean;
  timedOut: boolean;
}

/** How much of gh's output a call keeps, when not the default. */
export interface GhKeep {
  /** Keep the end of stdout, this many bytes of it (a log's last lines), instead of its beginning. */
  tailBytes?: number;
}

/** Runs gh the way runGit runs git: no shell, a timeout, never rejects. */
export type GhRunner = (cwd: string, args: string[], input?: string, timeoutMs?: number, keep?: GhKeep) => Promise<GhResult>;

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

/** Keeps the end of a stream: every chunk passes through, at most `max` bytes stay (twice that for a moment). */
export function endKeeper(max: number) {
  let parts: Buffer[] = [];
  let held = 0;
  return {
    push(d: Buffer) {
      parts.push(d);
      held += d.length;
      if (held <= max * 2) return;
      const all = Buffer.concat(parts);
      // A copy, so the bytes before it can go.
      parts = [Buffer.from(all.subarray(all.length - max))];
      held = max;
    },
    end(): Buffer {
      const all = Buffer.concat(parts);
      return all.length > max ? all.subarray(all.length - max) : all;
    },
  };
}

export function runGh(cwd: string, args: string[], input = '', timeoutMs = 60_000, keepOnly: GhKeep = {}): Promise<GhResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let done = false;
    // A log is read for its end: everything passes through, only the last bytes stay in memory.
    const end = keepOnly.tailBytes && keepOnly.tailBytes > 0 ? endKeeper(Math.min(keepOnly.tailBytes, GH_MAX_BYTES)) : null;
    const finish = (code: number | null, missing = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: (end ? end.end() : Buffer.concat(out)).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), missing, timedOut });
    };
    let child: ReturnType<typeof spawn>;
    // gh from PATH, never a gh.exe the repository brings (server/util/which.ts). It works in the
    // folder (it reads the remotes there) and finds git itself without looking in it.
    const gh = findProgram('gh', { outside: projectFolders(cwd) });
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
    child.stdout!.on('data', end ? end.push : keep(out));
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

// ───────────────────── the branch's pull request and its checks (`pulls.status`) ─────────────────────

/**
 * Read-only. Git alone says the branch and where origin pushes; gh is started only when one of
 * those addresses is on github.com, and asked one thing: the current branch's pull request. Whatever
 * goes wrong (no gh, no sign-in, no pull request, a timeout, an answer that does not parse) reads as
 * "no pull request": the tab shows nothing rather than an error. What gh says comes from GitHub, so
 * every string is cleaned and cut, the list of checks is bounded, and only addresses on
 * https://github.com/ are passed on.
 */

const PULL_FIELDS = 'number,title,state,isDraft,url,reviewDecision,statusCheckRollup,headRefOid';
const STATUS_TIMEOUT_MS = 10_000;
const MAX_TITLE = 200;
const MAX_CHECK_NAME = 120;
const MAX_URL = 500;
const MAX_CHECKS = 100;
/** The most entries of a pull request's checks looked at; the counts are over these. */
const MAX_ROLLUP = 2_000;

/** Characters that draw nothing but change how a line reads (direction marks, zero-width space, a byte order mark). */
const UNSEEN = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** Control characters and line separators: each run becomes one space. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** A string GitHub gave as one clean line of at most `max` characters; anything else as the empty string. */
export function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // Only its beginning is looked at: a megabyte of title is never walked.
  const line = v.slice(0, max * 8).replace(UNSEEN, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  // By character, so a cut never halves one.
  return [...line].slice(0, max).join('').trim();
}

/** An address on https://github.com/ as it may be linked or read a run id from, or undefined: no other address is passed on. */
export function gitHubUrl(v: unknown): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length > MAX_URL || /[\s\\\u0000-\u001f\u007f-\u009f]/.test(v)) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port || u.username || u.password) return undefined;
  return u.href.length <= MAX_URL ? u.href : undefined;
}

/** The workflow run behind a check's address: its repository and its id, digits only. */
export function runOf(url: string | undefined): { repo: string; id: string } | undefined {
  const m = url ? /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/(\d{1,20})(?:[/?#]|$)/.exec(url) : null;
  return m && repoLike(m[1]) ? { repo: m[1], id: m[2] } : undefined;
}

type CheckState = PullCheck['state'];

/** What GitHub calls a check's outcome or progress, as one of four states; undefined for a word it may add later. */
function stateOf(word: string): CheckState | undefined {
  switch (word) {
    case 'SUCCESS':
      return 'passed';
    case 'FAILURE':
    case 'ERROR':
    case 'CANCELLED':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failed';
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'skipped';
    case 'QUEUED':
    case 'IN_PROGRESS':
    case 'WAITING':
    case 'PENDING':
    case 'REQUESTED':
    case 'EXPECTED':
      return 'running';
  }
  return undefined;
}

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

/**
 * `statusCheckRollup` as one small list. It holds check runs (`status`, `conclusion`, `name`,
 * `detailsUrl`) and commit statuses (`state`, `context`, `targetUrl`). A word GitHub may add later
 * counts as skipped: never as passed or failed, and never as running, which would be asked about
 * for ever. A job that was run again is listed once per attempt: the newest attempt of the same job
 * in the same run speaks. Failed first, then running, then the rest; the first 100 are kept and the
 * counts are over all of them.
 */
export function mapChecks(rollup: unknown): Pick<PullRequestInfo, 'checks' | 'counts'> {
  const counts = { passed: 0, failed: 0, running: 0, skipped: 0 };
  if (!Array.isArray(rollup)) return { checks: [], counts };
  const newest = new Map<string, { check: PullCheck; at: number }>();
  const n = Math.min(rollup.length, MAX_ROLLUP);
  for (let i = 0; i < n; i++) {
    const e: unknown = rollup[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const o = e as Record<string, unknown>;
    const status = o.__typename === 'StatusContext' || (o.__typename !== 'CheckRun' && typeof o.context === 'string');
    let state: CheckState;
    if (status) state = stateOf(upper(o.state)) ?? 'skipped';
    else {
      const conclusion = upper(o.conclusion);
      const said = stateOf(conclusion ? conclusion : upper(o.status));
      // A conclusion is an outcome; without one, only a known kind of waiting counts as running.
      state = conclusion ? (said && said !== 'running' ? said : 'skipped') : said === 'running' ? 'running' : 'skipped';
    }
    const name = cleanLine(status ? o.context : o.name, MAX_CHECK_NAME) || 'Unnamed check';
    const url = gitHubUrl(status ? o.targetUrl : o.detailsUrl);
    const key = `${status ? 's' : 'c'}\0${status ? '' : cleanLine(o.workflowName, MAX_CHECK_NAME)}\0${name}\0${runOf(url)?.id ?? ''}`;
    const began = typeof o.startedAt === 'string' ? Date.parse(o.startedAt) : NaN;
    // A check that has not begun is the newest attempt there is.
    const at = Number.isFinite(began) && began > 0 ? began : state === 'running' ? Infinity : 0;
    const was = newest.get(key);
    if (!was) newest.set(key, { check: { name, state, ...(url ? { url } : {}) }, at });
    else if (at >= was.at) {
      was.check = { name, state, ...(url ? { url } : {}) };
      was.at = at;
    }
  }
  const all = [...newest.values()].map((v) => v.check);
  for (const c of all) counts[c.state]++;
  const rank: Record<CheckState, number> = { failed: 0, running: 1, passed: 2, skipped: 3 };
  return { checks: all.sort((a, b) => rank[a.state] - rank[b.state]).slice(0, MAX_CHECKS), counts };
}

/** What `gh pr view --json …` printed, as the pull request the tab shows; undefined when it does not read as one. */
export function parsePull(stdout: string): PullRequestInfo | undefined {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const number = o.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return undefined;
  const url = gitHubUrl(o.url);
  const head = typeof o.headRefOid === 'string' && /^[0-9a-f]{40,64}$/.test(o.headRefOid) ? o.headRefOid : undefined;
  const said = upper(o.state);
  const state = said === 'MERGED' ? 'merged' : said === 'CLOSED' ? 'closed' : said === 'OPEN' ? (o.isDraft === true ? 'draft' : 'open') : undefined;
  if (!url || !head || !state) return undefined;
  const decision = upper(o.reviewDecision);
  const review = decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : undefined;
  return { number, title: cleanLine(o.title, MAX_TITLE), state, url, ...(review ? { review } : {}), head, ...mapChecks(o.statusCheckRollup) };
}

/** The checked-out branch, by git alone; undefined on a detached HEAD. */
async function currentBranch(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 });
  return r.code === 0 ? r.stdout.trim().slice(0, 400) || undefined : undefined;
}

/**
 * The checked-out branch's pull request and its checks. Read-only. gh is started only for a branch
 * whose origin pushes to github.com. When another branch was checked out while gh ran, the answer is
 * read once more for that branch (the answer always names the branch it is for).
 */
export async function pullStatus(cwd: string, gh: GhRunner = runGh): Promise<PullStatus> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return {};
  for (let round = 0; ; round++) {
    const branch = await currentBranch(dir);
    if (!branch) return {};
    const urls = await pushUrls(dir);
    if (!urls?.some((u) => gitHubOwner(u) !== undefined)) return { branch };
    const r = await gh(dir, ['pr', 'view', '--json', PULL_FIELDS], '', STATUS_TIMEOUT_MS);
    const now = await currentBranch(dir);
    if (now !== branch) {
      if (round === 0) continue;
      return now ? { branch: now } : {};
    }
    const pull = r.code === 0 && !r.timedOut && !r.missing ? parsePull(r.stdout) : undefined;
    return pull ? { branch, pull } : { branch };
  }
}

// ───────────────────── the failed checks, for the chat (`pulls.failures`) ─────────────────────

/** How many runs' failed logs one message carries. */
const MAX_RUNS = 3;
const LOG_TIMEOUT_MS = 20_000;
/** The end of a run's failed log that is read at all: the last 60 lines come from these bytes. */
const LOG_TAIL_BYTES = 256_000;
const LOG_LINES = 60;
/** One line of a log, at most (a minified bundle on one line would take the whole budget). */
const LOG_LINE_CHARS = 400;
export const LOG_CHARS = 6_000;
export const FAILURES_CHARS = 16_000;
/** The failed checks named in the message. */
const MAX_NAMED = 10;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * The end of what `gh run view <id> --log-failed` printed, as plain text: the last 60 lines, at
 * most 6,000 characters (cut from the beginning, at a line). Each line of that log starts with its
 * job, its step and a timestamp; the job and step are said once, where they change.
 */
export function logTail(raw: string, maxChars = LOG_CHARS): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out: string[] = [];
  let where = '';
  for (const full of lines.slice(-LOG_LINES)) {
    const parts = full.split('\t');
    const at = parts.length >= 3 ? cleanLine(`${parts[0]} / ${parts[1]}`, 160) : '';
    const said = (parts.length >= 3 ? parts.slice(2).join('\t') : full)
      .replace(ANSI, '')
      .replace(UNSEEN, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, '')
      .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')
      .trimEnd();
    if (at && at !== where) {
      where = at;
      out.push(`[${at}]`);
    }
    out.push(said.length > LOG_LINE_CHARS ? `${said.slice(0, LOG_LINE_CHARS)}…` : said);
  }
  return endOf(out.join('\n'), maxChars);
}

/** The last `max` characters of a text, starting at a line where one begins in them. */
function endOf(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const end = text.slice(text.length - max);
  const nl = end.indexOf('\n');
  return nl >= 0 && nl < end.length - 1 ? end.slice(nl + 1) : end;
}

/** A run's failed log for the message: which failed checks it belongs to, and its end. */
export interface FailedLog {
  checks: string[];
  log: string;
}

/**
 * The message "Send failures to chat" puts into the composer: which checks failed for which pull
 * request (at most ten named, each with its address), then the end of each run's failed log (at
 * most three, 6,000 characters each). Never more than 16,000 characters in all.
 */
export function failuresMessage(pull: PullRequestInfo, logs: FailedLog[]): string {
  const failed = pull.checks.filter((c) => c.state === 'failed');
  const total = pull.counts.passed + pull.counts.failed + pull.counts.running;
  const n = pull.counts.failed;
  const count = n === total ? `${n} ${n === 1 ? 'check' : 'checks'}` : `${n} of ${total} checks`;
  const head = [
    `${count} failed on pull request #${pull.number}${pull.title ? `, ${pull.title}` : ''} (${pull.url}):`,
    ...failed.slice(0, MAX_NAMED).map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`),
    ...(n > MAX_NAMED ? [`- and ${n - MAX_NAMED} more`] : []),
  ].join('\n');
  let text = head;
  for (const l of logs.slice(0, MAX_RUNS)) {
    const title = `\n\nThe end of the failed log of ${l.checks.slice(0, 3).join(', ') || 'the run'}${l.checks.length > 3 ? ` and ${l.checks.length - 3} more` : ''}:\n`;
    // A fence longer than any run of backticks in the log, so the log cannot close it.
    const fence = '`'.repeat(Math.max(3, (l.log.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0) + 1));
    const room = Math.min(LOG_CHARS, FAILURES_CHARS - text.length - title.length - fence.length * 2 - 2);
    // Too little left to say anything of this log: the message ends here.
    if (room < 200) break;
    const log = endOf(l.log, room);
    if (!log.trim()) continue;
    text += `${title}${fence}\n${log}\n${fence}`;
  }
  return text.slice(0, FAILURES_CHARS);
}

/**
 * The failed checks of pull request `number` as a message for the chat, on the person's click.
 * Read-only: the status is read again first, and when the pull request's head is not `head` any
 * more (or nothing failed) the answer is `stale` and no log is read. Run ids come from the failed
 * checks' own addresses on github.com (`/actions/runs/<digits>`): at most three runs, each
 * `gh run view <id> --log-failed`, one after the other, 20 s each, only the end of its output kept.
 */
export async function pullFailures(cwd: string, asked: { number: number; head: string }, gh: GhRunner = runGh): Promise<PullFailures> {
  const dir = path.resolve(cwd);
  const { pull } = await pullStatus(dir, gh);
  if (!pull || pull.number !== asked.number || pull.head !== asked.head) return { stale: true };
  const failed = pull.checks.filter((c) => c.state === 'failed');
  if (failed.length === 0) return { stale: true };
  // Only runs in the pull request's own repository: a check can link to a run anywhere the person
  // can read, and another repository's log is not this pull request's failure (it stays a name).
  const own = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pull.url)?.[1]?.toLowerCase();
  const runs = new Map<string, { repo: string; id: string; checks: string[] }>();
  for (const c of failed) {
    const run = runOf(c.url);
    if (!run || !own || run.repo.toLowerCase() !== own) continue;
    const key = `${run.repo}/${run.id}`;
    const known = runs.get(key);
    if (known) known.checks.push(c.name);
    else if (runs.size < MAX_RUNS) runs.set(key, { ...run, checks: [c.name] });
  }
  const logs: FailedLog[] = [];
  for (const run of runs.values()) {
    const r = await gh(dir, ['run', 'view', run.id, '--repo', run.repo, '--log-failed'], '', LOG_TIMEOUT_MS, { tailBytes: LOG_TAIL_BYTES });
    // A log that could not be read (expired, no access, too slow) is left out: the checks are still named.
    if (r.code !== 0 || r.timedOut || r.missing) continue;
    const log = logTail(r.stdout);
    if (log.trim()) logs.push({ checks: run.checks, log });
  }
  return { text: failuresMessage(pull, logs) };
}

const opt = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * The gh the Changes tab reads a pull request with. `SABLE_NO_GITHUB=1` (a test server, a check
 * that must stay on this machine): gh is never started for it, and the tab shows no pull request.
 */
export function readingGh(env: NodeJS.ProcessEnv = process.env): GhRunner {
  if (env.SABLE_NO_GITHUB === '1') return async () => ({ code: null, stdout: '', stderr: '', missing: true, timedOut: false });
  return runGh;
}

export function registerPulls(app: App) {
  // One read per folder at a time: a second ask while gh runs gets the same answer.
  const reading = new Map<string, Promise<PullStatus>>();
  app.register('pulls.status', ({ cwd }) => {
    const dir = path.resolve(String(cwd ?? ''));
    let p = reading.get(dir);
    if (!p) {
      p = pullStatus(dir, readingGh()).finally(() => reading.delete(dir));
      reading.set(dir, p);
    }
    return p;
  });
  app.register('pulls.failures', ({ cwd, number, head }) => pullFailures(String(cwd ?? ''), { number: Number(number), head: String(head ?? '') }, readingGh()));
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
