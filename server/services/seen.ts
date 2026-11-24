/**
 * "Since you last looked": what the person has seen of each changed file of a chat, kept by the
 * bridge per chat (`<home>/seen/<sessionId>.json`) and read by the Changes tab (`seen.state`,
 * `seen.mark`). No phone method: none of it is on `PHONE_METHODS`.
 *
 * The rule. A file's change is seen when the file's content now is the content the person had in
 * view when they marked it (the row's Mark seen, Mark all seen, or a diff closed after it stood open
 * long enough to be read: the window's rule, `READ_MS` in `src/features/rail/changes-seen.ts`). The
 * content, not the diff: a diff against the base moves when the base moves (a commit, a rebase of a
 * lane, a stage) while nothing the agent wrote changed, and the diff of the seen content against the
 * content now is exactly "what is new since I looked". The signature is git's own blob id of the
 * working-tree bytes (`sha1("blob <n>\0" + bytes)`, what `git hash-object --no-filters` gives), so a
 * test can ask git; a deletion is `deleted`; a file over `HASH_MAX` (or past the read budget) is
 * signed by its size and change time (`big:`), so it reads as new once it changes at all.
 *
 * A chat's first turn records where it began (`base`): the working tree's signatures then count as
 * seen (with their text when small), so a folder that was already dirty does not list its old
 * changes as new, and the first diff of such a file shows only what the chat did to it.
 *
 * Bounds: at most `MAX_FILES` files per chat (the oldest dropped first), text kept only for a file
 * of at most `TEXT_MAX` (so its diff since seen can be made; larger ones by signature only, and the
 * tab then shows the whole diff with a line that says so), at most `TEXT_TOTAL` of text per chat
 * (the oldest texts dropped first, their signatures kept). A chat whose folder changed starts over.
 * The file goes with the chat (`session.removed`), and files of chats that are gone are removed at
 * start.
 *
 * What is read: only files `git status` lists for the chat's own folder, under the repository, by
 * their own names (never through a link: `readOwn`), so nothing the Changes tab could not show. Git
 * runs through `runGit` (`findProgram`, never from the project folder). Nothing runs while the tab
 * is closed except one look when a turn starts (the chat's first only, for `base`) and one when a
 * turn ends (for the count, only in a chat that has seen states), one at a time across chats.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, GitFileStatus, SeenFile, SeenMarkResult, SeenState } from '../../shared/protocol';
import { makeFileDiff } from '../../shared/diff';
import { within } from '../core/contain';
import type { App } from '../app';
import { gitStatus, repoRoot } from './git';

/** Files a chat keeps a seen state for. */
export const MAX_FILES = 300;
/** The largest file whose seen text is kept (UTF-16 units of its text): its diff since seen can be made. */
export const TEXT_MAX = 64_000;
/** Seen text a chat keeps in all. */
export const TEXT_TOTAL = 1_500_000;
/** The largest file signed by its bytes; larger ones by size and change time. */
export const HASH_MAX = 8_000_000;
/** Bytes read for signatures per look. */
const READ_BUDGET = 64_000_000;
/** Undo records kept per chat. */
const UNDO_KEEP = 20;

export interface SeenEntry {
  /** The content's signature when it was seen. */
  h: string;
  /** When it was seen (ms). */
  at: number;
  /** The content then, when small enough. */
  t?: string;
  /** Recorded as the chat's starting point, not by the person. */
  base?: true;
}

export interface SeenFileData {
  v: 1;
  /** The chat's folder the paths are relative to. */
  cwd: string;
  files: Record<string, SeenEntry>;
}

/** What the window learns of one file now (`SeenFile`), with its text for the store when small. */
interface Signed {
  path: string;
  hash: string;
  text?: string;
}

// ───────────────────────────── the rule (pure) ─────────────────────────────

/** git's blob id of these bytes (`git hash-object --no-filters`). */
export function blobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Each changed file as seen, new or changed again since seen. A file renamed (git says from where:
 * `oldPath`) keeps the seen state of its old name while its content is the one seen there.
 */
export function classify(files: readonly { path: string; oldPath?: string; hash: string }[], seen: Record<string, SeenEntry>): SeenFile[] {
  return files.map((f) => {
    const own = seen[f.path];
    const was = own ?? (f.oldPath ? seen[f.oldPath] : undefined);
    if (!was) return { path: f.path, hash: f.hash, state: 'new' };
    if (was.h === f.hash) return { path: f.path, hash: f.hash, state: 'seen', at: was.at, ...(was.base ? { base: true } : {}) };
    return { path: f.path, hash: f.hash, state: 'again', at: was.at, ...(was.t !== undefined && !f.hash.startsWith('big:') && f.hash !== 'deleted' ? { since: true } : {}), ...(was.base ? { base: true } : {}) };
  });
}

/** How many files wait to be looked at. */
export const toReview = (files: readonly SeenFile[]) => files.reduce((n, f) => n + (f.state === 'seen' ? 0 : 1), 0);

/**
 * The store's bounds: at most `MAX_FILES` entries (the oldest seen dropped), text only up to
 * `TEXT_MAX` each and `TEXT_TOTAL` in all (the oldest texts dropped first). Returns a new object.
 */
export function bound(files: Record<string, SeenEntry>): Record<string, SeenEntry> {
  let list = Object.entries(files).sort((a, b) => b[1].at - a[1].at);
  if (list.length > MAX_FILES) list = list.slice(0, MAX_FILES);
  let text = 0;
  const out: Record<string, SeenEntry> = {};
  for (const [p, e] of list) {
    let entry = e;
    if (entry.t !== undefined) {
      if (entry.t.length > TEXT_MAX || text + entry.t.length > TEXT_TOTAL) {
        const { t: _t, ...rest } = entry;
        entry = rest;
      } else text += entry.t.length;
    }
    out[p] = entry;
  }
  return out;
}

/** The diff of what is new since the seen text (`null` when it cannot be made). */
export function diffSince(file: string, seenText: string | undefined, nowText: string | null | undefined): FileDiff | null {
  if (seenText === undefined || nowText === undefined || nowText === null) return null;
  const d = makeFileDiff(file, seenText, nowText);
  return { ...d, status: 'modified' };
}

// ───────────────────────────── reading ─────────────────────────────

/**
 * A file's bytes by its own name, under `root` (never through a link, only a plain file), at most
 * `max` bytes: `big` with its size and change time when it is larger. Null when it cannot be read.
 */
async function readOwn(file: string, root: string, max: number): Promise<{ bytes: Buffer } | { big: string } | null> {
  if (!within(root, file)) return null;
  let fh: FileHandle | undefined;
  try {
    const own = await lstat(file, { bigint: true });
    if (own.isSymbolicLink() || !own.isFile()) return null;
    if (own.size > BigInt(max)) return { big: `big:${own.size}:${own.mtimeNs}` };
    fh = await open(file, 'r');
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.ino !== own.ino || st.dev !== own.dev) return null;
    if (st.size > BigInt(max)) return { big: `big:${st.size}:${st.mtimeNs}` };
    const buf = Buffer.alloc(Number(st.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { bytes: buf.subarray(0, bytesRead) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const textOf = (bytes: Buffer): string | undefined => (bytes.length > TEXT_MAX * 3 || bytes.subarray(0, 8192).includes(0) ? undefined : bytes.toString('utf8'));

/**
 * The changed files of `cwd` as git lists them, each signed. Null outside a repository. `only`:
 * just these paths (still only when git lists them).
 */
export async function signTree(cwd: string, only?: ReadonlySet<string>): Promise<{ files: (Signed & { oldPath?: string; status: string })[] } | null> {
  const dir = path.resolve(cwd);
  const st = await gitStatus(dir);
  if (!st.isRepo) return null;
  const root = await repoRoot(dir);
  if (!root) return null;
  const listed = only ? st.files.filter((f) => only.has(f.path)) : st.files;
  let budget = READ_BUDGET;
  const out: (Signed & { oldPath?: string; status: string })[] = [];
  for (let i = 0; i < listed.length; i += 8) {
    const batch = listed.slice(i, i + 8);
    const signed = await Promise.all(batch.map((f) => signOne(dir, root, f, () => budget)));
    for (const s of signed) {
      if (s.read) budget -= s.read;
      out.push(s.file);
    }
  }
  return { files: out };
}

async function signOne(dir: string, root: string, f: GitFileStatus, budget: () => number): Promise<{ file: Signed & { oldPath?: string; status: string }; read?: number }> {
  const base = { path: f.path, status: f.status, ...(f.oldPath ? { oldPath: f.oldPath } : {}) };
  if (f.status === 'D') return { file: { ...base, hash: 'deleted' } };
  const got = await readOwn(path.resolve(dir, f.path), root, Math.min(HASH_MAX, Math.max(0, budget())));
  if (!got) return { file: { ...base, hash: 'unreadable' } };
  if ('big' in got) return { file: { ...base, hash: got.big } };
  const text = textOf(got.bytes);
  return { file: { ...base, hash: blobId(got.bytes), ...(text !== undefined ? { text } : {}) }, read: got.bytes.length };
}

// ───────────────────────────── the store ─────────────────────────────

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const sameDir = (a: string, b: string) => {
  const n = (s: string) => path.resolve(s).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Seen states per chat on disk, one small file each, written whole (they are bounded) through a temporary file. */
export class SeenStore {
  readonly dir: string;
  private cache = new Map<string, SeenFileData>();
  private undos = new Map<string, { id: string; prev: Record<string, SeenEntry | null> }[]>();
  private undoSeq = 0;
  private known = new Map<string, boolean>();

  constructor(home: string) {
    this.dir = path.join(home, 'seen');
  }

  private file(id: string) {
    if (!SAFE_ID.test(id)) throw new Error('Bad session id');
    return path.join(this.dir, `${id}.json`);
  }

  /** The chat's seen states for `cwd` (empty when none, or kept for another folder). */
  read(id: string, cwd: string): SeenFileData {
    let data = this.cache.get(id);
    if (!data) {
      try {
        const raw = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<SeenFileData>;
        if (raw && raw.v === 1 && typeof raw.cwd === 'string' && raw.files && typeof raw.files === 'object') data = { v: 1, cwd: raw.cwd, files: bound(clean(raw.files)) };
      } catch {
        /* none yet, or unreadable: starts empty */
      }
      data ??= { v: 1, cwd, files: {} };
      this.cache.set(id, data);
    }
    if (!sameDir(data.cwd, cwd)) {
      data = { v: 1, cwd, files: {} };
      this.cache.set(id, data);
    }
    return data;
  }

  /** The chat has a seen file (its start recorded, or a mark): only then does it carry a count. */
  has(id: string): boolean {
    let known = this.known.get(id);
    if (known === undefined) {
      try {
        readFileSync(this.file(id));
        known = true;
      } catch {
        known = false;
      }
      this.known.set(id, known);
    }
    return known;
  }

  write(id: string, data: SeenFileData) {
    const next: SeenFileData = { v: 1, cwd: data.cwd, files: bound(data.files) };
    this.cache.set(id, next);
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next));
    renameSync(tmp, file);
    this.known.set(id, true);
  }

  /** Puts entries (null removes one) and remembers what they replaced; returns the undo's id. */
  put(id: string, cwd: string, changes: Record<string, SeenEntry | null>): string {
    const data = this.read(id, cwd);
    const prev: Record<string, SeenEntry | null> = {};
    const files = { ...data.files };
    for (const [p, e] of Object.entries(changes)) {
      prev[p] = files[p] ?? null;
      if (e) files[p] = e;
      else delete files[p];
    }
    this.write(id, { ...data, files });
    const undo = `u${++this.undoSeq}`;
    const list = this.undos.get(id) ?? [];
    list.push({ id: undo, prev });
    if (list.length > UNDO_KEEP) list.shift();
    this.undos.set(id, list);
    return undo;
  }

  /** Takes back a `put` (only once). */
  undo(id: string, cwd: string, undo: string): boolean {
    const list = this.undos.get(id);
    const at = list?.findIndex((u) => u.id === undo) ?? -1;
    if (!list || at < 0) return false;
    const [u] = list.splice(at, 1);
    const data = this.read(id, cwd);
    const files = { ...data.files };
    for (const [p, e] of Object.entries(u.prev)) {
      if (e) files[p] = e;
      else delete files[p];
    }
    this.write(id, { ...data, files });
    return true;
  }

  remove(id: string) {
    this.cache.delete(id);
    this.undos.delete(id);
    this.known.set(id, false);
    try {
      rmSync(this.file(id), { force: true });
    } catch {
      /* gone */
    }
  }

  /** Removes the files of chats that are gone. */
  prune(alive: (id: string) => boolean) {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      const m = n.match(/^([A-Za-z0-9_-]{1,128})\.json$/);
      if (m && !alive(m[1])) this.remove(m[1]);
      else if (/\.tmp$/.test(n)) rmSync(path.join(this.dir, n), { force: true });
    }
  }
}

/** Only well-formed entries survive a read. */
function clean(files: Record<string, unknown>): Record<string, SeenEntry> {
  const out: Record<string, SeenEntry> = {};
  for (const [p, e] of Object.entries(files)) {
    if (!e || typeof e !== 'object' || p.length > 4096) continue;
    const x = e as Partial<SeenEntry>;
    if (typeof x.h !== 'string' || x.h.length > 200 || typeof x.at !== 'number') continue;
    out[p] = { h: x.h, at: x.at, ...(typeof x.t === 'string' ? { t: x.t } : {}), ...(x.base === true ? { base: true } : {}) };
  }
  return out;
}

// ───────────────────────────── the service ─────────────────────────────

/** Seen states for the app's chats: the RPC handlers, the count on the chat, the turn's start and end. */
export class SeenService {
  readonly store: SeenStore;
  /** One look at a time across chats (a turn's end in five chats is five looks, one after another). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private app: App) {
    this.store = new SeenStore(app.store.dir);
  }

  /** The chat's folder: a call for another folder is refused (the tab shows the chat's own). */
  private folder(sessionId: string, cwd: string): string {
    const rt = this.app.sessions.get(sessionId);
    if (!rt) throw new Error('Session not found');
    if (!rt.meta.cwd || !sameDir(rt.meta.cwd, cwd)) throw new Error("Not this chat's folder");
    return rt.meta.cwd;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private setCount(sessionId: string, n: number | undefined) {
    const rt = this.app.sessions.get(sessionId);
    if (rt && rt.meta.review !== (n || undefined)) rt.update({ review: n || undefined });
  }

  /** `seen.state`: every changed file, or (`path`) one file with its diff since seen. */
  async state(sessionId: string, cwd: string, only?: string): Promise<SeenState> {
    const dir = this.folder(sessionId, cwd);
    const tree = await this.serial(() => signTree(dir, only ? new Set([only]) : undefined));
    if (!tree) {
      if (!only) this.setCount(sessionId, undefined);
      return { repo: false, files: [] };
    }
    const data = this.store.read(sessionId, dir);
    const files = classify(tree.files, data.files);
    if (!only) {
      this.setCount(sessionId, this.store.has(sessionId) ? toReview(files) : undefined);
      return { repo: true, files };
    }
    const f = files[0];
    const signed = tree.files[0];
    if (!f || f.state !== 'again') return { repo: true, files };
    const was = data.files[f.path] ?? (signed?.oldPath ? data.files[signed.oldPath] : undefined);
    const diff = diffSince(f.path, was?.t, signed?.text);
    return { repo: true, files, ...(diff ? { diff } : {}) };
  }

  /**
   * `seen.mark`: these files seen as the window had them (`hash`: what the person had in view; the
   * text kept is read now and kept only when it is still that content), or (`unmark`) new again, or
   * (`undo`) a mark taken back.
   */
  async mark(sessionId: string, cwd: string, p: { files?: { path: string; hash: string }[]; unmark?: string[]; undo?: string }): Promise<SeenMarkResult> {
    const dir = this.folder(sessionId, cwd);
    if (p.undo) {
      const ok = this.store.undo(sessionId, dir, p.undo);
      return { ok, ...(await this.state(sessionId, dir)) };
    }
    const want = new Map<string, string>();
    for (const f of (p.files ?? []).slice(0, MAX_FILES)) if (f && typeof f.path === 'string' && typeof f.hash === 'string' && f.hash.length <= 200) want.set(f.path, f.hash);
    const changes: Record<string, SeenEntry | null> = {};
    if (want.size) {
      const tree = await this.serial(() => signTree(dir, new Set(want.keys())));
      if (!tree) return { ok: false, repo: false, files: [] };
      const now = Date.now();
      // Only what git lists: a path the tab does not show is never marked (nor read).
      for (const s of tree.files) {
        const hash = want.get(s.path)!;
        changes[s.path] = { h: hash, at: now, ...(s.hash === hash && s.text !== undefined ? { t: s.text } : {}) };
      }
    }
    for (const u of (p.unmark ?? []).slice(0, MAX_FILES)) if (typeof u === 'string') changes[u] = null;
    if (!Object.keys(changes).length) return { ok: false, ...(await this.state(sessionId, dir)) };
    const undo = this.store.put(sessionId, dir, changes);
    return { ok: true, undo, ...(await this.state(sessionId, dir)) };
  }

  /** A chat's first turn: the working tree as it was counts as seen (`SeenEntry.base`). */
  async begin(sessionId: string) {
    const rt = this.app.sessions.get(sessionId);
    const cwd = rt?.meta.cwd;
    if (!cwd || this.store.has(sessionId)) return;
    const tree = await this.serial(() => signTree(cwd));
    if (!tree || this.store.has(sessionId) || !this.app.sessions.has(sessionId)) return;
    const now = Date.now();
    const files: Record<string, SeenEntry> = {};
    for (const s of tree.files) files[s.path] = { h: s.hash, at: now, base: true, ...(s.text !== undefined ? { t: s.text } : {}) };
    // An empty start is recorded too: from now on this chat counts what it changes.
    this.store.write(sessionId, { v: 1, cwd, files });
  }

  /** A turn ended: the chat's count, where it has seen states. */
  async end(sessionId: string) {
    const rt = this.app.sessions.get(sessionId);
    if (!rt?.meta.cwd || !this.store.has(sessionId)) return;
    await this.state(sessionId, rt.meta.cwd).catch(() => {});
  }
}

export function registerSeen(app: App): SeenService {
  const s = new SeenService(app);
  // Chats that are gone take their seen states with them.
  s.store.prune((id) => app.sessions.has(id));
  const timers = new Map<string, NodeJS.Timeout>();
  const later = (id: string, fn: () => Promise<void>, ms: number) => {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void fn().catch(() => {});
      }, ms),
    );
  };
  const was = new Map<string, string>();
  const off = app.subscribe((e) => {
    if (e.type === 'session.removed') {
      clearTimeout(timers.get(e.id));
      timers.delete(e.id);
      was.delete(e.id);
      s.store.remove(e.id);
      return;
    }
    // A chat made just now records where it begins at once, before its first turn can change anything.
    if (e.type === 'session.added') {
      if (Date.now() - e.session.createdAt < 10_000) void s.begin(e.session.id).catch(() => {});
      return;
    }
    if (e.type !== 'session.updated' || !e.patch.status) return;
    const prev = was.get(e.id);
    const now = e.patch.status;
    was.set(e.id, now);
    if (now === 'running' && prev !== 'running' && prev !== 'awaiting') void s.begin(e.id).catch(() => {});
    else if ((now === 'idle' || now === 'error') && (prev === 'running' || prev === 'awaiting')) later(e.id, () => s.end(e.id), 1200);
  });
  app.onDispose(() => {
    off();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });
  app.register('seen.state', ({ sessionId, cwd, path: file }) => s.state(String(sessionId ?? ''), String(cwd ?? ''), typeof file === 'string' ? file : undefined));
  app.register('seen.mark', ({ sessionId, cwd, files, unmark, undo }) =>
    s.mark(String(sessionId ?? ''), String(cwd ?? ''), {
      files: Array.isArray(files) ? files : undefined,
      unmark: Array.isArray(unmark) ? unmark : undefined,
      undo: typeof undo === 'string' ? undo : undefined,
    }),
  );
  return s;
}
