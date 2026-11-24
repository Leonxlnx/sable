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
 * test can ask git; a deletion is `deleted`; a file over `HASH_MAX` is
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
import { createHash, webcrypto } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff, GitFileStatus, SeenFile, SeenMarkResult, SeenState } from '../../shared/protocol';
import { makeFileDiff } from '../../shared/diff';
import { folderNow, type FolderRoot } from '../core/contain';
import type { App } from '../app';
import { gitStatus, openOwnFile, repoRoot } from './git';

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
    return { path: f.path, hash: f.hash, state: 'again', at: was.at, ...(was.t !== undefined && !f.hash.startsWith('big:') && f.hash !== 'deleted' && f.hash !== 'link' ? { since: true } : {}), ...(was.base ? { base: true } : {}) };
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
 * HASH_MAX bytes. Reserve the bytes before reading so concurrent reads share the same budget.
 */
async function readOwn(file: string, root: FolderRoot, reserve: (bytes: number) => boolean, deadline?: number): Promise<{ bytes: Buffer; blob: Buffer<ArrayBuffer> } | { big: string } | 'link' | 'skipped' | null> {
  let fh: FileHandle | undefined;
  try {
    const got = await openOwnFile(file, root, deadline);
    if (!got || typeof got === 'string') return got === 'link' ? 'link' : null;
    fh = got.fh;
    const st = got.st;
    if (st.size > BigInt(HASH_MAX)) return { big: `big:${st.size}:${st.mtimeNs}` };
    if (!reserve(Number(st.size))) return 'skipped';
    const header = `blob ${st.size}\0`;
    const blob = Buffer.allocUnsafeSlow(header.length + Number(st.size));
    blob.write(header, 0, 'ascii');
    const bytes = blob.subarray(header.length);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fh.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    return { bytes, blob };
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
export async function signTree(cwd: string, only?: ReadonlySet<string>, limits?: { ms: number; entries: number }) {
  const dir = path.resolve(cwd);
  const deadline = limits ? performance.now() + limits.ms : undefined;
  let stopped = false;
  const expired = () => stopped || (deadline !== undefined && performance.now() >= deadline);
  const files: (Signed & { oldPath?: string; status: string })[] = [];
  const snapshot = (partial: boolean) => ({ files: files.filter(Boolean), partial });
  let budget = READ_BUDGET;
  const reserve = (n: number) => {
    if (expired() || n > budget) return false;
    budget -= n;
    return true;
  };
  const collect = async () => {
    const top = await repoRoot(dir, limits?.ms);
    if (expired()) return snapshot(true);
    if (!top) return null;
    const root = await folderNow(top);
    if (typeof root !== 'object') return null;
    if (expired()) return snapshot(true);
    const st = await gitStatus(dir, { namesOnly: true, top, deadline, maxEntries: limits?.entries });
    if (!st.isRepo) return null;
    const listed = only ? st.files.filter(f => only.has(f.path)) : st.files;
    let partial = !!st.partial;
    for (let i = 0; i < listed.length; i += 8) {
      if (expired()) return snapshot(true);
      await Promise.all(listed.slice(i, i + 8).map(async (f, j) => {
        const file = await signOne(dir, root, f, reserve, deadline);
        if (file) files[i + j] = file;
        else partial = true;
      }));
    }
    return snapshot(partial || expired());
  };
  if (!limits) return collect();
  // A slow filesystem operation already in progress can finish and close its handle later.
  // The next chat gets the queue back at the deadline, with an immutable snapshot of this look.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([collect(), new Promise<ReturnType<typeof snapshot>>(resolve => {
      timer = setTimeout(() => { stopped = true; resolve(snapshot(true)); }, Math.max(0, deadline! - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function signOne(dir: string, root: FolderRoot, f: GitFileStatus, reserve: (bytes: number) => boolean, deadline?: number): Promise<(Signed & { oldPath?: string; status: string }) | null> {
  const base = { path: f.path, status: f.status, ...(f.oldPath ? { oldPath: f.oldPath } : {}) };
  if (f.status === 'D') return { ...base, hash: 'deleted' };
  const got = await readOwn(path.resolve(dir, f.path), root, reserve, deadline);
  if (got === 'skipped') return null;
  if (got === 'link') return { ...base, hash: 'link' };
  if (!got) return { ...base, hash: 'unreadable' };
  if ('big' in got) return { ...base, hash: got.big };
  const text = textOf(got.bytes);
  // WebCrypto dispatches the digest to Node's native worker pool.
  const digest = await webcrypto.subtle.digest('SHA-1', got.blob);
  return { ...base, hash: Buffer.from(digest).toString('hex'), ...(text !== undefined ? { text } : {}) };
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
      this.known.set(id, false);
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

  private setCount(sessionId: string, n: number | undefined, many = false) {
    const rt = this.app.sessions.get(sessionId);
    if (rt && (rt.meta.review !== (n || undefined) || !!rt.meta.reviewMany !== many)) rt.update({ review: n || undefined, reviewMany: many || undefined });
  }

  /** `seen.state`: every changed file, or (`path`) one file with its diff since seen. */
  async state(sessionId: string, cwd: string, only?: string, limits?: { ms: number; entries: number }): Promise<SeenState> {
    const dir = this.folder(sessionId, cwd);
    const tree = await this.serial(() => signTree(dir, only ? new Set([only]) : undefined, limits));
    if (!tree) {
      if (!only) this.setCount(sessionId, undefined);
      return { repo: false, files: [] };
    }
    const data = this.store.read(sessionId, dir);
    const files = classify(tree.files, data.files);
    if (!only) {
      const known = this.store.has(sessionId);
      this.setCount(sessionId, known ? toReview(files) : undefined, known && tree.partial);
      return { repo: true, files, ...(tree.partial ? { partial: true } : {}) };
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

  private startedIn = new Map<string, string>();

  /** A chat's first turn: the working tree as it was counts as seen (`SeenEntry.base`). */
  async begin(sessionId: string) {
    const rt = this.app.sessions.get(sessionId);
    if (!rt || this.startedIn.get(sessionId) === rt.meta.cwd) return;
    let cwd: string;
    do {
      cwd = rt.meta.cwd;
      if (!cwd) return;
      await this.serial(async () => {
        if (rt.meta.cwd !== cwd || this.app.sessions.get(sessionId) !== rt) return;
        if (this.startedIn.get(sessionId) === cwd) return;
        this.store.read(sessionId, cwd);
        if (this.store.has(sessionId)) { this.startedIn.set(sessionId, cwd); return; }
        const tree = await signTree(cwd);
        if (rt.meta.cwd !== cwd || this.app.sessions.get(sessionId) !== rt) return;
        if (!tree || this.store.has(sessionId)) { this.startedIn.set(sessionId, cwd); return; }
        const now = Date.now();
        const files: Record<string, SeenEntry> = {};
        for (const s of tree.files) files[s.path] = { h: s.hash, at: now, base: true, ...(s.text !== undefined ? { t: s.text } : {}) };
        this.store.write(sessionId, { v: 1, cwd, files });
        this.startedIn.set(sessionId, cwd);
      });
    } while (cwd !== rt.meta.cwd && this.app.sessions.get(sessionId) === rt);
  }

  remove(sessionId: string) {
    this.startedIn.delete(sessionId);
    this.store.remove(sessionId);
  }

  /** A turn ended: the chat's count, where it has seen states. */
  async end(sessionId: string, limits = { ms: 400, entries: 2000 }) {
    const rt = this.app.sessions.get(sessionId);
    if (!rt?.meta.cwd || !this.store.has(sessionId)) return;
    return this.state(sessionId, rt.meta.cwd, undefined, limits);
  }
}

export function registerSeen(app: App): SeenService {
  const s = new SeenService(app);
  app.beforeFirstInput = id => s.begin(id);
  // Chats that are gone take their seen states with them.
  s.store.prune((id) => app.sessions.has(id));
  const timers = new Map<string, NodeJS.Timeout>();
  const later = (id: string, fn: () => Promise<unknown>, ms: number) => {
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
      s.remove(e.id);
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
    if ((now === 'idle' || now === 'error') && (prev === 'running' || prev === 'awaiting')) later(e.id, () => s.end(e.id), 1200);
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
