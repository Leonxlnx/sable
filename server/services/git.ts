import { spawn } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DiffHunk, FileDiff, GitCommitResult, GitFileStatus, GitStatus, GitWorktree } from '../../shared/protocol';
import { makeFileDiff, parseUnifiedDiff } from '../../shared/diff';
import { folderNow, openContained, within as under, type FolderRoot } from '../core/contain';
import type { App } from '../app';

// ───────────────────────────── git runner ─────────────────────────────

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** git is not installed / not on PATH. */
  missing: boolean;
  timedOut: boolean;
  /** stdout hit maxBytes and was cut. */
  truncated: boolean;
}

/**
 * Runs git directly (no shell, so no quoting issues) with a hard timeout and output cap.
 * Never rejects: a missing binary, a timeout or a non-zero exit are reported in the result.
 */
export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBytes?: number; input?: string; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const max = opts.maxBytes ?? 16_000_000;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    const finish = (code: number | null, missing = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        missing,
        timedOut,
        truncated,
      });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C', ...opts.env },
      });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', missing: true, timedOut: false, truncated: false });
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
    }, opts.timeoutMs ?? 10_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (outLen >= max) {
        truncated = true;
        return;
      }
      if (outLen + d.length > max) {
        d = d.subarray(0, max - outLen);
        truncated = true;
      }
      out.push(d);
      outLen += d.length;
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (errLen < 64_000) {
        err.push(d);
        errLen += d.length;
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish(null, e.code === 'ENOENT'));
    child.on('close', (code) => finish(code));
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.input ?? '');
  });
}

/** Repository top-level for `cwd`, or null when not a repo / git missing / cwd unreadable. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    if (!(await stat(cwd)).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  if (r.code !== 0) return null;
  const top = r.stdout.trim();
  return top ? path.resolve(top) : null;
}

// ───────────────────────────── helpers ─────────────────────────────

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_DIFF_LINES = 4000;
const MAX_UNTRACKED_FILES = 300;
const MAX_UNTRACKED_BYTES = 1_000_000;
const UNTRACKED_BUDGET = 8_000_000;

const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Repo-root-relative git path → path relative to `cwd` (forward slashes). */
function relToCwd(root: string, cwd: string, p: string): string {
  if (path.resolve(root) === path.resolve(cwd)) return p;
  return toPosix(path.relative(cwd, path.join(root, p)));
}

/** `p` lies inside `dir` (or is it), both absolute, compared as Windows compares them there. */
export function inside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Reads a file prefix; null when unreadable. `binary` when NUL bytes appear in the first 8 KB.
 * `within`: only a file that lies in that folder as it is named (`within` canonical, or the chat's
 * folder as pinned: core/contain.ts `folderNow`), with nothing followed below the folder: a link
 * there (the file itself, or a folder on the way) is never read through (review wave 6, #1: a link
 * to another file in the folder would give that file's text under the link's name), nor a file with
 * another name elsewhere (a hard link: it is that file). That it lies there is established against
 * the opened handle (core/contain.ts `openContained`), and only a plain file is opened.
 */
export async function readText(file: string, maxBytes: number, within?: string | FolderRoot): Promise<FileText | null> {
  const got = await readIn(file, maxBytes, within);
  return got === 'outside' || got === 'link' ? null : got;
}

export interface FileText {
  text: string;
  binary: boolean;
  size: number;
}

/** `readText`, saying `outside` when the file is not established to lie in `within` as named, `link` when it is a link there (null: it could not be read). */
async function readIn(file: string, maxBytes: number, within?: string | FolderRoot): Promise<FileText | 'outside' | 'link' | null> {
  let fh: FileHandle | undefined;
  try {
    let st: BigIntStats;
    if (within) {
      // By its own name: never resolved, so a link below the folder is never followed.
      if (!under(typeof within === 'string' ? within : within.real, file)) return 'outside';
      let own: BigIntStats;
      try {
        own = await lstat(file, { bigint: true });
      } catch {
        return null;
      }
      if (own.isSymbolicLink()) return 'link';
      if (!own.isFile()) return null;
      // A link put on the way after that lookup shows in the walks (or the handle's own path): not inside.
      const got = await openContained(file, within);
      fh = got.fh;
      if (!got.inside) return 'outside';
      st = got.st;
    } else {
      fh = await open(file, 'r');
      st = await fh.stat({ bigint: true });
    }
    if (!st.isFile()) return null;
    const len = Math.min(Number(st.size), maxBytes);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const data = buf.subarray(0, bytesRead);
    const binary = data.subarray(0, 8192).includes(0);
    return { text: binary ? '' : data.toString('utf8'), binary, size: Number(st.size) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n : n + 1;
}

async function hasHead(cwd: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 5000 });
  return r.code === 0;
}

/** Parses `git diff --numstat -z` into path → counts (binary files count as 0). */
function parseNumstat(out: string, into: Map<string, { a: number; d: number }>) {
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let file = m[3];
    if (file === '') {
      // Rename/copy: "<a>\t<d>\t\0<old>\0<new>\0"
      i += 2;
      file = parts[i] ?? '';
    }
    if (!file) continue;
    const prev = into.get(file) ?? { a: 0, d: 0 };
    prev.a += m[1] === '-' ? 0 : Number(m[1]);
    prev.d += m[2] === '-' ? 0 : Number(m[2]);
    into.set(file, prev);
  }
}

function mapStatus(x: string, y: string): string {
  const norm = (c: string) => (c === 'T' ? 'M' : c === 'C' ? 'A' : c);
  if (x === 'A' || x === 'R' || x === 'C') return norm(x);
  if (y !== '.') return norm(y);
  return norm(x);
}

/** Limits a parsed file diff to MAX_DIFF_LINES hunk lines, keeping headers consistent. */
export function capDiff(f: FileDiff): FileDiff {
  let budget = MAX_DIFF_LINES;
  if (f.hunks.reduce((n, h) => n + h.lines.length, 0) <= budget) return f;
  const hunks: DiffHunk[] = [];
  for (const h of f.hunks) {
    if (budget <= 0) break;
    if (h.lines.length <= budget) {
      hunks.push(h);
      budget -= h.lines.length;
      continue;
    }
    const lines = h.lines.slice(0, budget);
    let o = 0;
    let n = 0;
    for (const l of lines) {
      if (l[0] !== '+') o++;
      if (l[0] !== '-') n++;
    }
    hunks.push({ ...h, lines, oldLines: o, newLines: n });
    budget = 0;
  }
  return { ...f, hunks };
}

// ───────────────────────────── handlers ─────────────────────────────

/** Options of `gitStatus` and `gitDiff`. */
export interface GitScope {
  /**
   * Only what lies in `cwd` itself (a pathspec for it, never a sibling folder of the repository), and
   * a file's working-tree text (untracked, or a tracked file's side of its diff: `checkedDiff`) read
   * only through a handle established to lie there (links followed, no other name elsewhere), else
   * withheld (`GitFileDiff.withheld`). The phone's Changes view.
   */
  within?: boolean;
}

/** `dir` as its canonical folder (links and junctions followed), for `GitScope.within`. */
async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

/** Why a phone gets nothing of a chat's changes: its folder is not the one the chat started in (core/contain.ts `folderNow`). */
export const FOLDER_CHANGED = "This chat's folder is not the folder the chat started in, so its changes show only on the computer.";

/**
 * The chat's folder for `GitScope.within`: the one pinned for it (core/contain.ts), or `gone`.
 * Another folder at its place (swapped for a junction to another repository, review wave 6, #2) is
 * refused (`FOLDER_CHANGED`), before git lists anything and again once it has (`stillThere`).
 */
async function chatFolder(dir: string): Promise<FolderRoot | 'gone'> {
  const now = await folderNow(dir);
  if (now === 'changed') throw new Error(FOLDER_CHANGED);
  return now;
}

async function stillThere(dir: string, was: FolderRoot): Promise<void> {
  const now = await folderNow(dir);
  if (typeof now !== 'object' || now.dev !== was.dev || now.ino !== was.ino) throw new Error(FOLDER_CHANGED);
}

export async function gitStatus(cwd: string, scope: GitScope = {}): Promise<GitStatus> {
  const dir = path.resolve(cwd);
  const none: GitStatus = { isRepo: false, files: [], additions: 0, deletions: 0 };
  const pin = scope.within ? await chatFolder(dir) : undefined;
  if (pin === 'gone') return none;
  const root = await repoRoot(dir);
  if (!root) return none;
  // A pathspec for the folder itself: git lists nothing outside it.
  const spec = scope.within ? ['--', '.'] : [];

  const [st, unstaged, staged] = await Promise.all([
    runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...spec], { timeoutMs: 15_000 }),
    runGit(dir, ['diff', '--numstat', '-z', '--no-ext-diff', ...spec], { timeoutMs: 15_000 }),
    runGit(dir, ['diff', '--numstat', '-z', '--no-ext-diff', '--cached', ...spec], { timeoutMs: 15_000 }),
  ]);
  if (st.code !== 0) return none;
  // What git listed is the chat's folder's only while that folder is still the one pinned.
  if (pin) await stillThere(dir, pin);
  // Files as git names them, from the repository's canonical place: read as named (`readText`).
  const top = pin ? await realDir(root) : root;

  const result: GitStatus = { isRepo: true, files: [], additions: 0, deletions: 0 };
  let oid = '';
  let head = '';
  const files: (GitFileStatus & { raw: string })[] = [];
  const recs = st.stdout.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    if (rec.startsWith('# ')) {
      const [, key, ...rest] = rec.split(' ');
      const val = rest.join(' ');
      if (key === 'branch.oid') oid = val;
      else if (key === 'branch.head') head = val;
      else if (key === 'branch.ab') {
        const m = val.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const fields = rec.split(' ');
      const xy = fields[1];
      const raw = fields.slice(fieldCount).join(' ');
      if (kind === '2') i++; // original path follows as its own NUL-terminated record
      const x = xy[0];
      const y = xy[1];
      files.push({
        raw,
        path: relToCwd(root, dir, raw),
        status: kind === 'u' ? 'U' : mapStatus(x, y),
        staged: kind !== 'u' && x !== '.',
      });
    } else if (kind === '?') {
      const raw = rec.slice(2);
      files.push({ raw, path: relToCwd(root, dir, raw), status: '?', staged: false });
    }
  }
  result.branch = head && head !== '(detached)' ? head : oid && oid !== '(initial)' ? oid.slice(0, 7) : undefined;

  // numstat paths are repo-root relative, like porcelain paths.
  const counts = new Map<string, { a: number; d: number }>();
  if (unstaged.code === 0) parseNumstat(unstaged.stdout, counts);
  if (staged.code === 0) parseNumstat(staged.stdout, counts);

  // Untracked files have no numstat: count their lines, a few files at a time, within a budget.
  const untracked = files.filter((f) => f.status === '?');
  let budget = UNTRACKED_BUDGET;
  for (const f of untracked) f.additions = 0;
  const counted = untracked.slice(0, MAX_UNTRACKED_FILES);
  for (let i = 0; i < counted.length && budget > 0; i += 8) {
    const batch = counted.slice(i, i + 8);
    const share = Math.min(MAX_UNTRACKED_BYTES, Math.max(1, Math.floor(budget / batch.length)));
    const texts = await Promise.all(batch.map((f) => readText(path.join(top, f.raw), share, pin)));
    texts.forEach((t, k) => {
      if (!t) return;
      budget -= Math.min(t.size, share);
      batch[k].additions = t.binary ? 0 : countLines(t.text);
    });
  }
  for (const f of files) {
    if (f.status === '?') {
      f.deletions = 0;
    } else {
      const c = counts.get(f.raw);
      f.additions = c?.a ?? 0;
      f.deletions = c?.d ?? 0;
    }
    result.additions += f.additions ?? 0;
    result.deletions += f.deletions ?? 0;
  }
  result.files = files.map(({ raw: _raw, ...rest }) => rest);
  return result;
}

/** A file's diff, or (`GitScope.within`) its place in the list with its text withheld, and why. */
export type GitFileDiff = FileDiff & { withheld?: 'outside' | 'link' | 'big' | 'unreadable' };

/** The biggest side of a tracked file whose diff is made for the phone (`GitScope.within`): read whole, both sides. */
const MAX_SIDE_BYTES = 2_000_000;

const SUBPROJECT = /^[-+ ]Subproject commit [0-9a-f]+(-dirty)?$/;

/**
 * A tracked file's diff for `GitScope.within`: the old side from git's own objects (`base`, as
 * `git diff <base>` has it), the working tree's side read by its own name through a handle
 * established to lie in `within` (`readIn`, core/contain.ts), and the diff made from the two; git's
 * own patch read the working tree by its path (a hard link to a file elsewhere, a junction on the
 * way) and is never used for that side. Withheld (no text, no counts) where the file is not
 * established to lie there, is a link (`link`: git's side of a link is its link text, and a link is
 * never read through, review wave 6, #1), cannot be read, or a side is over `MAX_SIDE_BYTES`. A
 * deletion and a submodule keep git's own patch: neither reads the working tree. A submodule is
 * told by git's own mode for the entry (160000, `modes`), never by what the lines say.
 * `top`: the repository's canonical place, which git's paths are relative to.
 */
async function checkedDiff(top: string, root: string, base: string, f: FileDiff, modes: Modes, within: FolderRoot): Promise<GitFileDiff> {
  if (f.status === 'deleted') return f;
  const none = (withheld: NonNullable<GitFileDiff['withheld']>): GitFileDiff => ({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, additions: 0, deletions: 0, hunks: [], withheld });
  if (modes.now === GITLINK) return f.hunks.every((h) => h.lines.every((l) => SUBPROJECT.test(l) || l.startsWith('\\'))) ? f : none('unreadable');
  const now = await readIn(path.join(top, f.path), MAX_SIDE_BYTES + 1, within);
  if (now === 'outside') return none('outside');
  if (now === 'link') return none('link');
  if (!now) return none('unreadable');
  if (now.size > MAX_SIDE_BYTES) return none('big');
  const old = f.status === 'added' || base === EMPTY_TREE || modes.was === GITLINK ? null : await blobOf(root, base, f.oldPath ?? f.path);
  if (old === 'big') return none('big');
  if (old === undefined) return none('unreadable');
  const binary = now.binary || !!old?.binary;
  if (binary) return { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, additions: 0, deletions: 0, hunks: [], binary: true };
  const made = makeFileDiff(f.path, old ? old.text : null, now.text);
  return { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, additions: made.additions, deletions: made.deletions, hunks: made.hunks };
}

/** Git's mode of an entry for a submodule (a commit, not a file). */
const GITLINK = '160000';

/** Git's modes of one file's entry in its diff: before (`was`) and in the working tree (`now`), as git's own header lines give them. */
interface Modes {
  was?: string;
  now?: string;
}

/**
 * Git's patch cut into one part per file (each begins with its `diff --git` line: a line of a hunk
 * always begins with its mark, so it never does), each with the modes its header lines give.
 */
export function patchParts(patch: string): { text: string; modes: Modes }[] {
  const out: { lines: string[]; head: boolean; modes: Modes }[] = [];
  let cur: (typeof out)[number] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { lines: [line], head: true, modes: {} };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (!cur.head) continue;
    const l = line.replace(/\r$/, '');
    if (l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('Binary files ') || l === 'GIT binary patch') {
      cur.head = false;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(?:old mode|deleted file mode) (\d{6})$/))) cur.modes.was = m[1];
    else if ((m = l.match(/^(?:new mode|new file mode) (\d{6})$/))) cur.modes.now = m[1];
    else if ((m = l.match(/^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/))) {
      cur.modes.was ??= m[1];
      cur.modes.now ??= m[1];
    }
  }
  return out.map((c) => ({ text: c.lines.join('\n'), modes: c.modes }));
}

/** A file as `rev` has it (repository-relative path), from git's objects: undefined when git cannot say, `big` over `MAX_SIDE_BYTES`. */
async function blobOf(root: string, rev: string, file: string): Promise<{ text: string; binary: boolean } | 'big' | undefined> {
  const r = await runGit(root, ['cat-file', 'blob', `${rev}:${file}`], { timeoutMs: 10_000, maxBytes: MAX_SIDE_BYTES + 1 });
  if (r.code !== 0 && !r.truncated) return undefined;
  if (r.truncated || Buffer.byteLength(r.stdout) > MAX_SIDE_BYTES) return 'big';
  const binary = r.stdout.slice(0, 8192).includes('\0');
  return { text: binary ? '' : r.stdout, binary };
}

export async function gitDiff(cwd: string, file?: string, stagedOnly?: boolean, scope: GitScope = {}): Promise<GitFileDiff[]> {
  const dir = path.resolve(cwd);
  const root = await repoRoot(dir);
  if (!root) return [];
  // Within the folder: a file named out of it has no diff here, and no file means the folder itself.
  if (scope.within && file && !inside(path.resolve(dir, file), dir)) return [];
  const spec = file ? ['--', path.resolve(dir, file)] : scope.within ? ['--', '.'] : [];
  const pin = scope.within ? await chatFolder(dir) : undefined;
  if (pin === 'gone') return [];
  const base = (await hasHead(dir)) ? 'HEAD' : EMPTY_TREE;
  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-M',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...(stagedOnly ? ['--cached', base] : [base]),
    ...spec,
  ];
  const [d, others] = await Promise.all([
    runGit(dir, args, { timeoutMs: 20_000, maxBytes: 32_000_000 }),
    stagedOnly
      ? Promise.resolve(null)
      : runGit(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--full-name', ...spec], { timeoutMs: 10_000 }),
  ]);
  // What git gave is the chat's folder's only while that folder is still the one pinned.
  if (pin) await stillThere(dir, pin);
  const top = pin ? await realDir(root) : root;
  const out: GitFileDiff[] = [];
  const add = (f: GitFileDiff) => {
    const fixed: GitFileDiff = { ...f, path: relToCwd(root, dir, f.path) };
    if (f.oldPath) fixed.oldPath = relToCwd(root, dir, f.oldPath);
    if (fixed.binary) fixed.hunks = [];
    out.push(capDiff(fixed));
  };
  if (d.code === 0 || d.stdout) {
    if (pin && !stagedOnly) {
      // Within the folder (the phone), the working tree's side is never git's reading of the path.
      for (const part of patchParts(d.stdout)) for (const parsed of parseUnifiedDiff(part.text)) add(await checkedDiff(top, root, base, parsed, part.modes, pin));
    } else for (const parsed of parseUnifiedDiff(d.stdout)) add(parsed);
  }
  if (others && others.code === 0) {
    const list = others.stdout.split('\0').filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
    let budget = UNTRACKED_BUDGET;
    for (const raw of list) {
      const rel = relToCwd(root, dir, raw);
      const t = budget > 0 ? await readIn(path.join(top, raw), Math.min(MAX_UNTRACKED_BYTES, budget), pin) : null;
      if (t === 'outside' || t === 'link') {
        out.push({ path: rel, status: 'added', additions: 0, deletions: 0, hunks: [], withheld: t });
        continue;
      }
      if (!t) continue;
      budget -= t.text.length;
      if (t.binary) {
        out.push({ path: rel, status: 'added', additions: 0, deletions: 0, hunks: [], binary: true });
        continue;
      }
      const fd = makeFileDiff(rel, null, t.text);
      out.push(capDiff(fd));
    }
  }
  return out;
}

export async function gitBranches(cwd: string): Promise<{ current?: string; branches: string[] }> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { branches: [] };
  const [cur, refs] = await Promise.all([
    runGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5000 }),
    runGit(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'], {
      timeoutMs: 10_000,
    }),
  ]);
  const branches = refs.code === 0 ? refs.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const current = cur.code === 0 ? cur.stdout.trim() || undefined : undefined;
  return { current, branches };
}

/**
 * The working trees of the repository at `cwd`, main checkout first (lanes included). Bare,
 * locked and prunable entries are left out, and so is any tree whose folder is gone.
 */
export async function gitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return [];
  const r = await runGit(dir, ['worktree', 'list', '--porcelain'], { timeoutMs: 5000 });
  if (r.code !== 0) return [];
  const blocks = r.stdout
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: GitWorktree[] = [];
  for (const [i, block] of blocks.entries()) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      fields.set(sp < 0 ? line : line.slice(0, sp), sp < 0 ? '' : line.slice(sp + 1));
    }
    const tree = fields.get('worktree');
    if (!tree || fields.has('bare') || fields.has('locked') || fields.has('prunable')) continue;
    const resolved = path.resolve(tree);
    try {
      if (!(await stat(resolved)).isDirectory()) continue;
    } catch {
      continue;
    }
    const ref = fields.get('branch');
    out.push({
      path: resolved,
      branch: ref ? ref.replace(/^refs\/heads\//, '') : undefined,
      head: fields.get('HEAD')?.slice(0, 7) || undefined,
      main: i === 0,
    });
  }
  return out;
}

/** The last meaningful lines of git's complaint, without hint noise. */
export function gitError(r: GitResult, fallback: string): string {
  if (r.missing) return 'Git is not installed or not on PATH.';
  if (r.timedOut) return 'Git took too long and was stopped.';
  const text = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(0, 3)
    .join(' ');
  return text || fallback;
}

/**
 * Stages every change (`git add -A`) and commits it. The message goes to git on stdin
 * (`commit -F -`), never through a shell, so quotes, dashes and newlines are safe.
 */
export async function gitCommit(cwd: string, message: string): Promise<GitCommitResult> {
  const msg = message.replace(/\r\n/g, '\n').trim();
  if (!msg) return { ok: false, error: 'Write a commit message first.' };
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { ok: false, error: 'This folder is not a git repository.' };

  const add = await runGit(dir, ['add', '-A'], { timeoutMs: 60_000 });
  if (add.code !== 0) return { ok: false, error: gitError(add, 'Could not stage the changes.') };
  const commit = await runGit(dir, ['commit', '--quiet', '--file=-', '--cleanup=whitespace'], { input: `${msg}\n`, timeoutMs: 120_000 });
  if (commit.code !== 0) {
    if (/nothing to commit|no changes added/i.test(commit.stdout + commit.stderr)) return { ok: false, error: 'Nothing to commit.' };
    return { ok: false, error: gitError(commit, 'The commit failed.') };
  }
  const head = await runGit(dir, ['log', '-1', '--format=%h%x00%s'], { timeoutMs: 5000 });
  const [hash, summary] = head.stdout.trim().split('\0');
  return { ok: true, hash: hash || undefined, summary: summary ?? msg.split('\n')[0] };
}

/** What a commit message is written from: the changed files, the start of the diff, the recent subjects. */
export interface CommitDraftInput {
  files: string[];
  patch: string;
  subjects: string[];
}

/** The changes of a folder for a commit message, without staging anything. `{ error }` when there is nothing to describe. */
export async function gitDraftInput(cwd: string): Promise<CommitDraftInput | { error: string }> {
  const dir = path.resolve(cwd);
  if (!(await repoRoot(dir))) return { error: 'This folder is not a git repository.' };
  const st = await runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 15_000 });
  if (st.code !== 0) return { error: gitError(st, 'Could not read the changes.') };
  const files = st.stdout.split('\0').filter(Boolean).map((e) => e.slice(3));
  if (!files.length) return { error: 'Nothing to commit.' };
  const head = await runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 5000 });
  if (head.code !== 0) return { files, patch: '', subjects: [] };
  const [diff, log] = await Promise.all([
    runGit(dir, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M'], { timeoutMs: 20_000, maxBytes: 4_000_000 }),
    runGit(dir, ['log', '-8', '--format=%s'], { timeoutMs: 5000 }),
  ]);
  return {
    files,
    patch: diff.code === 0 ? diff.stdout : '',
    subjects: log.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

export function registerGit(app: App) {
  app.register('git.status', ({ cwd }) => gitStatus(cwd));
  app.register('git.diff', ({ cwd, path: file, staged }) => gitDiff(cwd, file, staged));
  app.register('git.branches', ({ cwd }) => gitBranches(cwd));
  app.register('git.commit', ({ cwd, message }) => gitCommit(cwd, typeof message === 'string' ? message : ''));
}
