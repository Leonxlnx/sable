/**
 * Lanes at the git level: a worktree on a branch of its own for one session, a dry merge that
 * says whether it would land on the folder's branch, landing it, and discarding it. Every call
 * runs git directly with a timeout (`runGit`); nothing here runs unless it is asked.
 *
 * Safety: the main checkout is only ever changed by `git merge` (fast-forward, or a merge the
 * dry run found clean) after checking that none of the files it brings has uncommitted edits
 * there, and git itself refuses to overwrite local changes. A lane's own uncommitted work is
 * committed in the lane before it lands; discarding a lane is the only thing that drops work, and
 * only that lane's.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileDiff, LaneForecast, LaneLandResult, SessionLane } from '../../shared/protocol';
import { parseUnifiedDiff } from '../../shared/diff';
import { capDiff, gitError, repoRoot, runGit, type GitResult } from './git';

const T_FAST = 10_000;
const T_TREE = 60_000;
const T_CHECKOUT = 180_000;

/** Ignored folders of the main checkout a lane shares through a link, so the agent can build and test there. */
export const LANE_LINKS = ['node_modules'];

/** A throwaway identity for snapshot commits (objects nothing refers to; git prunes them). */
const SNAPSHOT_ENV = { GIT_AUTHOR_NAME: 'Sable', GIT_AUTHOR_EMAIL: 'sable@localhost', GIT_COMMITTER_NAME: 'Sable', GIT_COMMITTER_EMAIL: 'sable@localhost' };

const ok = (r: GitResult) => r.code === 0;
const line = (r: GitResult) => r.stdout.trim();
const nul = (s: string) => s.split('\0').filter(Boolean);

let mergeTreeOk: Promise<boolean> | undefined;
/** `git merge-tree --write-tree` needs git 2.38 or newer. Asked once. */
export function canDryMerge(): Promise<boolean> {
  mergeTreeOk ??= runGit(tmpdir(), ['version'], { timeoutMs: T_FAST }).then((r) => {
    const m = r.stdout.match(/(\d+)\.(\d+)/);
    return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
  });
  return mergeTreeOk;
}

/** A branch-safe slug of a title: `refactor-the-session-module` (at most `max` characters). */
export function laneSlug(title: string, max = 32): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let out = '';
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || words[0]?.slice(0, max) || '';
}

async function branchExists(root: string, name: string) {
  return ok(await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { timeoutMs: T_FAST }));
}

/** `sable/<slug>`, or `sable/<slug>-2` and on when that is taken. */
export async function freeBranch(root: string, slug: string): Promise<string> {
  const base = `sable/${slug || randomBytes(2).toString('hex')}`;
  if (!(await branchExists(root, base))) return base;
  for (let n = 2; n < 100; n++) if (!(await branchExists(root, `${base}-${n}`))) return `${base}-${n}`;
  return `${base}-${randomBytes(2).toString('hex')}`;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A link this module made (a junction on Windows): removed without touching what it points at. */
function unlinkLink(p: string) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  try {
    unlinkSync(p);
  } catch {
    // A directory junction on Windows: rmdir removes the link itself, never the target's contents.
    rmdirSync(p);
  }
}

export interface CreateLaneOptions {
  /** The session's folder (a repository, or a folder inside one). */
  folder: string;
  /** Where this lane's worktree goes (must not exist yet). */
  dir: string;
  /** The branch's slug: `sable/<slug>`. */
  slug: string;
  provisional?: boolean;
}

/**
 * A worktree at the main checkout's HEAD on a new branch. The main checkout's uncommitted work is
 * not carried: it is most often the other session's work in progress, and landing it from here
 * would land it twice. Ignored heavy folders (`node_modules`) are shared through a link.
 */
export async function createLane(o: CreateLaneOptions): Promise<{ lane: SessionLane; cwd: string } | { error: string }> {
  const root = await repoRoot(o.folder);
  if (!root) return { error: 'This folder is not a git repository.' };
  const head = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeoutMs: T_FAST });
  if (!ok(head)) return { error: head.missing ? 'Git is not installed or not on PATH.' : 'This repository has no commits yet.' };
  const base = line(head);
  const cur = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: T_FAST });
  const from = ok(cur) ? line(cur) || undefined : undefined;
  const branch = await freeBranch(root, o.slug);
  if (existsSync(o.dir)) return { error: 'The lane folder already exists.' };
  mkdirSync(path.dirname(o.dir), { recursive: true });
  const add = await runGit(root, ['worktree', 'add', '--quiet', '-b', branch, o.dir, base], { timeoutMs: T_CHECKOUT });
  if (!ok(add)) {
    // Leave nothing half made behind.
    await runGit(root, ['worktree', 'remove', '--force', o.dir], { timeoutMs: T_TREE });
    if (existsSync(o.dir)) rmSync(o.dir, { recursive: true, force: true });
    await runGit(root, ['worktree', 'prune'], { timeoutMs: T_FAST });
    await runGit(root, ['branch', '-D', branch], { timeoutMs: T_FAST });
    return { error: gitError(add, 'Could not make the lane.') };
  }
  const links: string[] = [];
  for (const name of LANE_LINKS) {
    const src = path.join(root, name);
    const dst = path.join(o.dir, name);
    if (!isDir(src) || existsSync(dst)) continue;
    // Only what git ignores: a tracked folder is part of the lane already.
    const ignored = await runGit(root, ['check-ignore', '-q', name], { timeoutMs: T_FAST });
    if (!ok(ignored)) continue;
    try {
      symlinkSync(src, dst, 'junction');
      links.push(name);
    } catch {
      /* no link: the agent installs there if it needs to */
    }
  }
  const rel = path.relative(root, path.resolve(o.folder));
  const lane: SessionLane = { folder: path.resolve(o.folder), root, path: path.resolve(o.dir), branch, base, ...(from ? { from } : {}), createdAt: Date.now(), ...(links.length ? { links } : {}), ...(o.provisional ? { provisional: true } : {}) };
  return { lane, cwd: rel && !rel.startsWith('..') ? path.join(lane.path, rel) : lane.path };
}

/** Renames a lane's branch (its first message names it). Returns the new name, or null. */
export async function renameLane(lane: SessionLane, slug: string): Promise<string | null> {
  if (!slug) return null;
  // A busy machine can keep git waiting past the fast timeout (or a scanner holds a ref file for a
  // moment): the rename is tried again a few times before the made-up name stays.
  let tried: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // A try that timed out may still have gone through: then the branch already has the new name.
    if (tried && !(await branchExists(lane.root, lane.branch)) && (await branchExists(lane.root, tried))) return tried;
    const next = await freeBranch(lane.root, slug);
    tried = next;
    if (next === lane.branch) return null;
    const r = await runGit(lane.root, ['branch', '-m', lane.branch, next], { timeoutMs: attempt ? T_TREE : T_FAST });
    if (ok(r)) return next;
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  return null;
}

/** Uncommitted paths of a checkout (repository-relative, untracked included). */
async function dirtyPaths(dir: string): Promise<string[] | null> {
  const r = await runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: T_TREE });
  if (!ok(r)) return null;
  const out: string[] = [];
  const recs = r.stdout.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    out.push(rec.slice(3));
    // A rename or copy: the original path follows as its own record (and is changed too).
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++;
      if (recs[i]) out.push(recs[i]);
    }
  }
  return out;
}

/**
 * The lane's working tree as a commit on top of its HEAD, without touching its index: a copy of
 * the index takes everything (`add -A`), then `write-tree` and `commit-tree`. HEAD itself when
 * the lane has nothing uncommitted.
 */
export async function snapshotLane(dir: string): Promise<{ commit: string; uncommitted: number } | { error: string }> {
  const head = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeoutMs: T_FAST });
  if (!ok(head)) return { error: gitError(head, 'The lane has no commit.') };
  const dirty = await dirtyPaths(dir);
  if (!dirty) return { error: 'Could not read the lane.' };
  if (!dirty.length) return { commit: line(head), uncommitted: 0 };
  const real = line(await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { timeoutMs: T_FAST }));
  const tmp = path.join(tmpdir(), `sable-lane-${process.pid}-${randomBytes(4).toString('hex')}.index`);
  const env = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: tmp };
  try {
    // A copy of the real index keeps its file stats: only changed files are read again.
    try {
      copyFileSync(real, tmp);
    } catch {
      await runGit(dir, ['read-tree', 'HEAD'], { timeoutMs: T_TREE, env });
    }
    const add = await runGit(dir, ['add', '-A'], { timeoutMs: T_TREE, env });
    if (!ok(add)) return { error: gitError(add, 'Could not read the lane.') };
    const tree = await runGit(dir, ['write-tree'], { timeoutMs: T_TREE, env });
    if (!ok(tree)) return { error: gitError(tree, 'Could not read the lane.') };
    const commit = await runGit(dir, ['commit-tree', line(tree), '-p', line(head), '-m', 'Sable lane snapshot'], { timeoutMs: T_FAST, env });
    if (!ok(commit)) return { error: gitError(commit, 'Could not read the lane.') };
    return { commit: line(commit), uncommitted: dirty.length };
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.lock`, { force: true });
  }
}

/** The folder's branch and its head; `error` on a detached head or a merge or rebase in progress. */
async function targetOf(root: string): Promise<{ name: string; head: string } | { error: string }> {
  const [cur, head] = await Promise.all([
    runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: T_FAST }),
    runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { timeoutMs: T_FAST }),
  ]);
  if (head.missing) return { error: 'Git is not installed or not on PATH.' };
  if (!ok(cur) || !line(cur)) return { error: 'The folder is not on a branch.' };
  if (!ok(head)) return { error: 'The folder has no commit.' };
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']) {
    if (ok(await runGit(root, ['rev-parse', '--verify', '-q', ref], { timeoutMs: T_FAST }))) return { error: 'The folder is in the middle of a merge or rebase.' };
  }
  return { name: line(cur), head: line(head) };
}

/** Files and lines `to` brings over its merge base with `from`. */
async function changesBetween(dir: string, from: string, to: string): Promise<{ paths: string[]; additions: number; deletions: number } | null> {
  const mb = await runGit(dir, ['merge-base', from, to], { timeoutMs: T_FAST });
  if (!ok(mb)) return null;
  const r = await runGit(dir, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', line(mb), to], { timeoutMs: T_TREE });
  if (!ok(r)) return null;
  const paths: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const rec of nul(r.stdout)) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    paths.push(m[3]);
    additions += m[1] === '-' ? 0 : Number(m[1]);
    deletions += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { paths, additions, deletions };
}

/** A dry merge of `theirs` into `ours` in no working tree: the conflicting paths, or null when it cannot tell. */
async function dryMerge(dir: string, ours: string, theirs: string): Promise<string[] | null> {
  const r = await runGit(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs], { timeoutMs: T_TREE });
  if (r.code === 0) return [];
  if (r.code !== 1) return null;
  // `<tree>\0<path>\0<path>\0…`
  return [...new Set(nul(r.stdout).slice(1))];
}

async function aheadBehind(dir: string, target: string, lane: string): Promise<{ ahead: number; behind: number }> {
  const r = await runGit(dir, ['rev-list', '--left-right', '--count', `${target}...${lane}`], { timeoutMs: T_TREE });
  const [behind, ahead] = line(r).split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

const none = (reason: string, extra: Partial<LaneForecast> = {}): LaneForecast => ({ state: 'unavailable', ahead: 0, behind: 0, uncommitted: 0, files: 0, additions: 0, deletions: 0, conflicts: [], blocked: [], reason, ...extra });

/** Whether the lane would land on the folder's current branch now. Changes nothing. */
export async function forecastLane(lane: SessionLane): Promise<LaneForecast> {
  if (!isDir(lane.path)) return none('The lane folder is gone.');
  if (!(await canDryMerge())) return none('Lanes need git 2.38 or newer.');
  const target = await targetOf(lane.root);
  if ('error' in target) return none(target.error);
  const snap = await snapshotLane(lane.path);
  if ('error' in snap) return none(snap.error, { target: target.name });
  const laneHead = line(await runGit(lane.path, ['rev-parse', 'HEAD'], { timeoutMs: T_FAST }));
  const [counts, changes, conflicts, dirty] = await Promise.all([
    aheadBehind(lane.root, target.head, laneHead),
    changesBetween(lane.root, target.head, snap.commit),
    dryMerge(lane.root, target.head, snap.commit),
    dirtyPaths(lane.root),
  ]);
  if (!changes || !conflicts || !dirty) return none('Could not compare the lane with the folder.', { target: target.name, ...counts, uncommitted: snap.uncommitted });
  const touched = new Set(changes.paths);
  const blocked = dirty.filter((p) => touched.has(p));
  const base = { target: target.name, ...counts, uncommitted: snap.uncommitted, files: changes.paths.length, additions: changes.additions, deletions: changes.deletions, conflicts, blocked };
  if (!changes.paths.length) return { ...base, state: 'nothing' };
  if (conflicts.length) return { ...base, state: 'conflicts' };
  if (blocked.length) return { ...base, state: 'blocked' };
  return { ...base, state: 'clean' };
}

/** Commits everything uncommitted in the lane (`add -A`), the message on stdin. */
async function commitLane(lane: SessionLane, message: string): Promise<{ ok: true } | { error: string }> {
  const add = await runGit(lane.path, ['add', '-A'], { timeoutMs: T_TREE });
  if (!ok(add)) return { error: gitError(add, 'Could not stage the lane’s changes.') };
  const msg = message.replace(/\r\n/g, '\n').trim() || `Work from ${lane.branch}`;
  const c = await runGit(lane.path, ['commit', '--quiet', '--file=-', '--cleanup=whitespace'], { input: `${msg}\n`, timeoutMs: T_CHECKOUT });
  if (!ok(c) && !/nothing to commit/i.test(c.stdout + c.stderr)) return { error: gitError(c, 'The commit failed.') };
  return { ok: true };
}

/**
 * Lands the lane on the folder's current branch: commits what the lane has uncommitted, checks
 * the dry merge and the folder's own uncommitted files, then fast-forwards the branch to the
 * lane, or replays the lane's commits on the branch first and fast-forwards, or (when a replay
 * stops on a conflict of its own) joins them with a merge commit. The agent's commits are kept.
 * Does not end the lane (see `removeLane`).
 */
export async function landLane(lane: SessionLane, message: string): Promise<LaneLandResult> {
  if (!isDir(lane.path)) return { ok: false, error: 'The lane folder is gone.' };
  if (!(await canDryMerge())) return { ok: false, error: 'Lanes need git 2.38 or newer.' };
  const target = await targetOf(lane.root);
  if ('error' in target) return { ok: false, error: target.error };
  // Nothing in the folder changes before the dry run says it lands: check the snapshot first.
  const snap = await snapshotLane(lane.path);
  if ('error' in snap) return { ok: false, error: snap.error };
  const pre = await dryMerge(lane.root, target.head, snap.commit);
  if (!pre) return { ok: false, error: 'Could not compare the lane with the folder.' };
  if (pre.length) return { ok: false, conflicts: pre, error: 'The lane conflicts with the branch.' };
  const changes = await changesBetween(lane.root, target.head, snap.commit);
  const dirty = await dirtyPaths(lane.root);
  if (!changes || !dirty) return { ok: false, error: 'Could not compare the lane with the folder.' };
  const touched = new Set(changes.paths);
  const blocked = dirty.filter((p) => touched.has(p));
  if (blocked.length) return { ok: false, blocked, error: 'The folder has uncommitted edits in files the lane changes.' };
  if (!changes.paths.length) return { ok: false, error: 'There is nothing to land.' };

  if (snap.uncommitted) {
    const c = await commitLane(lane, message);
    if ('error' in c) return { ok: false, error: c.error };
  }
  const laneHead = line(await runGit(lane.path, ['rev-parse', 'HEAD'], { timeoutMs: T_FAST }));
  const commits = Number(line(await runGit(lane.root, ['rev-list', '--count', `${target.head}..${laneHead}`], { timeoutMs: T_TREE }))) || 0;
  const forward = async (): Promise<GitResult> => runGit(lane.root, ['merge', '--ff-only', '--quiet', lane.branch], { timeoutMs: T_CHECKOUT });

  // The branch has not moved since the lane began: it moves forward to the lane.
  if (ok(await runGit(lane.root, ['merge-base', '--is-ancestor', target.head, laneHead], { timeoutMs: T_FAST }))) {
    const ff = await forward();
    return ok(ff) ? { ok: true, how: 'fast-forward', commits, target: target.name } : { ok: false, error: gitError(ff, 'Could not land the lane.') };
  }
  // It moved: replay the lane's commits on it (in the lane), then move it forward.
  const rebase = await runGit(lane.path, ['rebase', '--quiet', target.head], { timeoutMs: T_CHECKOUT });
  if (ok(rebase)) {
    const ff = await forward();
    if (ok(ff)) return { ok: true, how: 'rebase', commits, target: target.name };
    return { ok: false, error: gitError(ff, 'Could not land the lane.') };
  }
  await runGit(lane.path, ['rebase', '--abort'], { timeoutMs: T_TREE });
  // A replay that stops on a conflict of its own (one the end result does not have): a merge commit.
  const merge = await runGit(lane.root, ['merge', '--no-ff', '--no-edit', '--quiet', '-m', `Land ${lane.branch}`, lane.branch], { timeoutMs: T_CHECKOUT });
  if (ok(merge)) return { ok: true, how: 'merge', commits, target: target.name };
  if (ok(await runGit(lane.root, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], { timeoutMs: T_FAST }))) await runGit(lane.root, ['merge', '--abort'], { timeoutMs: T_TREE });
  return { ok: false, error: gitError(merge, 'Could not land the lane.') };
}

/**
 * Ends a lane: its links, its worktree and its branch (`force`: even with unlanded work). The
 * caller makes sure `lane.path` is one of Sable's lanes.
 */
export async function removeLane(lane: SessionLane, opts: { force?: boolean } = {}): Promise<{ ok: true } | { error: string }> {
  for (const name of lane.links ?? LANE_LINKS) unlinkLink(path.join(lane.path, name));
  if (isDir(lane.path)) {
    // Node removes the folder itself: it unlinks any link or junction left inside without following
    // it (git for Windows walks into junctions it does not know, which could reach the main checkout's
    // node_modules). git then only forgets the worktree.
    try {
      rmSync(lane.path, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      return { error: (err as Error).message.includes('EBUSY') ? 'The lane folder is in use. Close what has it open and try again.' : 'Could not remove the lane folder.' };
    }
  }
  await runGit(lane.root, ['worktree', 'prune'], { timeoutMs: T_FAST });
  const del = await runGit(lane.root, ['branch', opts.force ? '-D' : '-d', lane.branch], { timeoutMs: T_FAST });
  if (!ok(del) && (await branchExists(lane.root, lane.branch))) return { error: gitError(del, 'Could not remove the lane’s branch.') };
  return { ok: true };
}

/**
 * What the lane would bring to the folder's branch, file by file: its working tree (uncommitted
 * work included, through a snapshot) against the point where it meets that branch, so two lanes
 * made from one folder compare file by file. Paths are repository-relative. Changes nothing.
 */
export async function laneDiff(lane: SessionLane): Promise<FileDiff[]> {
  if (!isDir(lane.path)) return [];
  const [target, snap] = await Promise.all([targetOf(lane.root), snapshotLane(lane.path)]);
  if ('error' in snap) return [];
  const mb = await runGit(lane.root, ['merge-base', 'error' in target ? lane.base : target.head, snap.commit], { timeoutMs: T_FAST });
  const from = ok(mb) ? line(mb) : lane.base;
  const d = await runGit(lane.root, ['diff', '--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/', from, snap.commit], { timeoutMs: T_TREE, maxBytes: 32_000_000 });
  if (d.code !== 0 && !d.stdout) return [];
  return parseUnifiedDiff(d.stdout).map((f) => capDiff(f.binary ? { ...f, hunks: [] } : f));
}
