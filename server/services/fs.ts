import { existsSync } from 'node:fs';
import { access, open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirEntry } from '../../shared/protocol';
import type { App } from '../app';
import { repoRoot, runGit } from './git';

/** Folders and files that are noise in a project tree (shown dimmed, skipped by the search walk). */
export const NOISE = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.idea',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const toPosix = (p: string) => p.replace(/\\/g, '/');

// ───────────────────────────── roots ─────────────────────────────

async function exists(p: string, timeoutMs = 1500): Promise<boolean> {
  return Promise.race([
    access(p).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref()),
  ]);
}

export async function fsRoots(home: string): Promise<{ roots: DirEntry[]; home: string }> {
  const roots: DirEntry[] = [];
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const found = await Promise.all(letters.map((l) => exists(`${l}:\\`)));
    letters.forEach((l, i) => {
      if (found[i]) roots.push({ name: `${l}:`, path: `${l}:\\`, dir: true });
    });
  } else roots.push({ name: '/', path: '/', dir: true });

  const named: [string, string[]][] = [
    ['Home', [home]],
    ['Desktop', [path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')]],
    ['Documents', [path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Documents')]],
    ['Downloads', [path.join(home, 'Downloads')]],
  ];
  for (const [name, candidates] of named) {
    for (const c of candidates) {
      if (await exists(c)) {
        roots.push({ name, path: c, dir: true });
        break;
      }
    }
  }
  return { roots, home };
}

// ───────────────────────────── list ─────────────────────────────

function insideRepo(dir: string): boolean {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(path.join(cur, '.git'))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  return false;
}

export async function fsList(p: string): Promise<{ path: string; parent: string | null; entries: DirEntry[] }> {
  const dir = path.resolve(p);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why =
      code === 'ENOENT' ? 'it does not exist' : code === 'ENOTDIR' ? 'it is not a folder' : code === 'EPERM' || code === 'EACCES' ? 'access is denied' : (err as Error).message;
    throw new Error(`Cannot read folder ${dir}: ${why}`);
  }
  const entries = await Promise.all(
    dirents.map(async (d): Promise<DirEntry | null> => {
      const full = path.join(dir, d.name);
      try {
        let isDir = d.isDirectory();
        let size: number | undefined;
        if (d.isSymbolicLink() || d.isFile() || (!isDir && !d.isFile())) {
          const st = await stat(full).catch(() => null);
          if (st) {
            isDir = st.isDirectory();
            if (st.isFile()) size = st.size;
          } else if (d.isSymbolicLink()) return { name: d.name, path: full, dir: false };
        }
        const e: DirEntry = { name: d.name, path: full, dir: isDir };
        if (!isDir && size !== undefined) e.size = size;
        if (NOISE.has(d.name)) e.ignored = true;
        return e;
      } catch {
        return null;
      }
    }),
  );
  const list = entries.filter((e): e is DirEntry => !!e);

  // Ask git about the rest when cheap: only inside a repo, bounded, short timeout.
  const ask = list.filter((e) => !e.ignored);
  if (ask.length && ask.length <= 2000 && insideRepo(dir)) {
    const r = await runGit(dir, ['check-ignore', '-z', '--stdin'], {
      timeoutMs: 1500,
      input: ask.map((e) => e.name + (e.dir ? '/' : '')).join('\0') + '\0',
    });
    if (r.code === 0 || r.code === 1) {
      const ignored = new Set(r.stdout.split('\0').filter(Boolean).map((s) => s.replace(/\/$/, '')));
      for (const e of ask) if (ignored.has(e.name)) e.ignored = true;
    }
  }

  list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
  const up = path.dirname(dir);
  return { path: dir, parent: up === dir ? null : up, entries: list };
}

// ───────────────────────────── read ─────────────────────────────

export async function fsRead(
  p: string,
  maxBytes = 512 * 1024,
): Promise<{ path: string; content: string; truncated: boolean; size: number; binary: boolean }> {
  const file = path.resolve(p);
  let fh;
  try {
    fh = await open(file, 'r');
  } catch (err) {
    throw new Error(`Cannot open ${file}: ${(err as Error).message}`);
  }
  try {
    const st = await fh.stat();
    if (st.isDirectory()) throw new Error(`Cannot read ${file}: it is a folder`);
    const cap = Math.max(0, Math.floor(maxBytes));
    // A few extra bytes so a cut UTF-8 sequence at `cap` can be detected.
    const want = Math.min(st.size, Math.max(cap + 4, 8192));
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, 8192).includes(0)) {
      return { path: file, content: '', truncated: false, size: st.size, binary: true };
    }
    let end = Math.min(data.length, cap);
    const truncated = st.size > end;
    if (truncated) {
      // Do not cut a UTF-8 sequence in half.
      let back = end;
      while (back > 0 && back > end - 4 && (data[back] & 0xc0) === 0x80) back--;
      if (back < end && back >= 0 && (data[back] & 0xc0) === 0xc0) end = back;
    }
    let content = data.subarray(0, end).toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    return { path: file, content, truncated, size: st.size, binary: false };
  } finally {
    await fh.close().catch(() => {});
  }
}

// ───────────────────────────── search ─────────────────────────────

const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const CACHE_MS = 15_000;

interface Candidate {
  rel: string;
  lower: string;
  /** Index of the basename start in `rel`. */
  base: number;
  dir: boolean;
  depth: number;
}

const cache = new Map<string, { at: number; list: Promise<Candidate[]> }>();

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }];
  while (queue.length && files.length < MAX_FILES) {
    const { dir, rel, depth } = queue.shift()!;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (NOISE.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH) queue.push({ dir: path.join(dir, e.name), rel: r, depth: depth + 1 });
      } else if (e.isFile() || e.isSymbolicLink()) {
        files.push(r);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

async function listFiles(cwd: string): Promise<string[]> {
  if (await repoRoot(cwd)) {
    const r = await runGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      timeoutMs: 8000,
      maxBytes: 8_000_000,
    });
    if (r.code === 0 || r.stdout) {
      const seen = new Set<string>();
      for (const f of r.stdout.split('\0')) {
        if (!f || seen.has(f)) continue;
        seen.add(f);
        if (seen.size >= MAX_FILES) break;
      }
      return [...seen];
    }
  }
  return walk(cwd);
}

function buildCandidates(files: string[]): Candidate[] {
  const out: Candidate[] = [];
  const dirs = new Set<string>();
  const add = (rel: string, dir: boolean) => {
    const slash = rel.lastIndexOf('/');
    let depth = 0;
    for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) depth++;
    out.push({ rel, lower: rel.toLowerCase(), base: slash + 1, dir, depth });
  };
  for (const raw of files) {
    const rel = toPosix(raw);
    add(rel, false);
    let i = rel.lastIndexOf('/');
    while (i > 0) {
      const d = rel.slice(0, i);
      if (dirs.has(d)) break;
      dirs.add(d);
      i = d.lastIndexOf('/');
    }
  }
  for (const d of dirs) add(d, true);
  return out;
}

function candidates(cwd: string): Promise<Candidate[]> {
  const key = process.platform === 'win32' || process.platform === 'darwin' ? cwd.toLowerCase() : cwd;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.list;
  const list = listFiles(cwd).then(buildCandidates);
  cache.set(key, { at: now, list });
  list.catch(() => cache.delete(key));
  // Keep the cache from growing without bound.
  if (cache.size > 32) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  return list;
}

const SCORE_MATCH = 16;
const BONUS_SEGMENT = 10; // after "/"
const BONUS_WORD = 8; // after - _ . space, or camelCase hump, or start
const BONUS_CONSECUTIVE = 6;
const GAP = 1;

function boundaryBonus(rel: string, j: number): number {
  if (j === 0) return BONUS_WORD;
  const prev = rel.charCodeAt(j - 1);
  if (prev === 47 /* / */) return BONUS_SEGMENT;
  if (prev === 45 || prev === 95 || prev === 46 || prev === 32) return BONUS_WORD;
  const cur = rel.charCodeAt(j);
  if (cur >= 65 && cur <= 90 && prev >= 97 && prev <= 122) return BONUS_WORD - 1;
  if (cur >= 48 && cur <= 57 && !(prev >= 48 && prev <= 57)) return BONUS_WORD - 2;
  return 0;
}

const NEG = -1e9;
let rowA = new Float64Array(256);
let rowB = new Float64Array(256);

/** Best alignment score of `q` as a subsequence of `c.rel` (Smith-Waterman-like DP), or null. */
export function fuzzyScore(q: string, c: Candidate): number | null {
  const s = c.lower;
  const n = q.length;
  const m = s.length;
  // Fast reject: subsequence check.
  let qi = 0;
  for (let j = 0; j < m && qi < n; j++) if (s.charCodeAt(j) === q.charCodeAt(qi)) qi++;
  if (qi < n) return null;

  if (rowA.length < m + 1) {
    rowA = new Float64Array(m * 2);
    rowB = new Float64Array(m * 2);
  }
  let prev = rowA;
  let cur = rowB;
  // Row 0: first query char.
  for (let j = 0; j < m; j++) {
    prev[j] = s.charCodeAt(j) === q.charCodeAt(0) ? SCORE_MATCH + boundaryBonus(c.rel, j) * 2 - j * 0.05 : NEG;
  }
  for (let i = 1; i < n; i++) {
    const qc = q.charCodeAt(i);
    let run = NEG; // max over k < j-1 of prev[k] + GAP*k
    for (let j = 0; j < m; j++) {
      if (j >= 2 && prev[j - 2] > NEG) run = Math.max(run, prev[j - 2] + GAP * (j - 2));
      if (s.charCodeAt(j) !== qc) {
        cur[j] = NEG;
        continue;
      }
      const bonus = boundaryBonus(c.rel, j);
      let best = NEG;
      if (j >= 1 && prev[j - 1] > NEG) best = prev[j - 1] + BONUS_CONSECUTIVE + Math.max(bonus, 2);
      if (run > NEG) best = Math.max(best, run - GAP * (j - 1) + bonus);
      cur[j] = best > NEG ? best + SCORE_MATCH : NEG;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  let best = NEG;
  for (let j = 0; j < m; j++) if (prev[j] > best) best = prev[j];
  if (best <= NEG) return null;

  // Basename bonuses: the thing people type is usually the file name.
  const base = c.lower.slice(c.base);
  const stem = base.replace(/\.[^.]+$/, '');
  if (base === q || stem === q) best += 60;
  else if (base.startsWith(q)) best += 40;
  else if (base.includes(q)) best += 28;
  else {
    let k = 0;
    for (let j = 0; j < base.length && k < n; j++) if (base.charCodeAt(j) === q.charCodeAt(k)) k++;
    if (k === n) best += 14;
  }
  // Shorter / shallower paths win ties.
  best -= c.rel.length * 0.15 + c.depth * 1.5;
  // @-mentions are mostly files; a folder only wins when it matches clearly better.
  if (c.dir) best -= 10;
  return best;
}

export async function fsSearch(
  cwd: string,
  query: string,
  limit = 40,
): Promise<{ path: string; rel: string; dir: boolean }[]> {
  const root = path.resolve(cwd);
  const all = await candidates(root);
  const max = Math.max(1, Math.min(limit, 500));
  const q = query.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, '');
  const out = (c: Candidate) => ({ path: path.join(root, c.rel), rel: c.rel, dir: c.dir });

  if (!q) {
    // Shallowest first; among the shallowest few hundred, most recently modified first.
    const pool = [...all].sort((a, b) => a.depth - b.depth || a.rel.length - b.rel.length).slice(0, 300);
    const mt = await Promise.all(
      pool.map((c) =>
        stat(path.join(root, c.rel)).then(
          (s) => s.mtimeMs,
          () => 0,
        ),
      ),
    );
    const idx = pool.map((_, i) => i);
    idx.sort((a, b) => pool[a].depth - pool[b].depth || mt[b] - mt[a] || collator.compare(pool[a].rel, pool[b].rel));
    return idx.slice(0, max).map((i) => out(pool[i]));
  }

  return rank(all, q, max).map(out);
}

function rank(all: Candidate[], q: string, max: number): Candidate[] {
  const scored: { c: Candidate; s: number }[] = [];
  for (const c of all) {
    const s = fuzzyScore(q, c);
    if (s !== null) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.rel.length - b.c.rel.length || collator.compare(a.c.rel, b.c.rel));
  return scored.slice(0, max).map(({ c }) => c);
}

/** Pure ranking over relative file paths (directories derived); exposed for tests and benchmarks. */
export function rankPaths(files: string[], query: string, limit = 40): { rel: string; dir: boolean }[] {
  const q = query.trim().toLowerCase().replace(/\\/g, '/').replace(/\s+/g, '');
  return rank(buildCandidates(files), q, limit).map((c) => ({ rel: c.rel, dir: c.dir }));
}

export function registerFs(app: App, opts: { home?: string } = {}) {
  const home = opts.home ?? os.homedir();
  app.register('fs.roots', () => fsRoots(home));
  app.register('fs.list', ({ path: p }) => fsList(p));
  app.register('fs.read', ({ path: p, maxBytes }) => fsRead(p, maxBytes));
  app.register('fs.search', ({ cwd, query, limit }) => fsSearch(cwd, query, limit));
}
