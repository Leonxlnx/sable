import { closeSync, fstatSync, lstatSync, openSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Whether a file opened for reading lies in a folder (a chat's), established against the open
 * handle, else not: where it cannot be established the answer is "not inside" (fail closed). Used by
 * a share's capture (core/handed.ts, sync) and the working-tree reader of a chat's changes for the
 * phone (services/git.ts `readText`, `checkedDiff`, async). The caller resolves the file's real place first (links
 * followed) and passes the folder canonical; a file whose place is not in the folder is opened and
 * is simply not inside.
 *
 * - Linux: the handle names its own file (/proc/self/fd): that path must lie in the folder and still
 *   be this very file (volume and id), with no other name (one link).
 * - Elsewhere (Windows, macOS: `CONTAIN.how` 'walk') a handle cannot say where its file is: Node has
 *   no GetFinalPathNameByHandle, `realpath` resolves a path anew (its own handle, not this one), and
 *   every lookup by name can be raced. What the walks below can say is the check there; it is not a
 *   proof (review wave 5, #7: a folder above the chat's folder flipped for a junction between their
 *   lookups makes a file outside agree with both, tests/contain.test.ts). 'none' (nothing is inside:
 *   every file counts as external) was tried and kept as an option: on Windows it withholds every
 *   phone diff and every Bypass share, which breaks the phone for the people it is for.
 * - `CONTAIN.how` 'walk': the
 *   open is put between two walks down the path:
 *   every folder from the volume's root to the file looked up with lstat (nothing followed), each a
 *   real folder (no link, no junction), the last a plain file with one link; between the two walks
 *   every folder is the same (volume and id), from the chat's folder itself down also with the same
 *   modify and change times, and the file is the handle's own (volume and id). A folder's times move
 *   with every name added, removed or renamed in it, and its own change time moves when it is renamed
 *   itself (measured on NTFS: away and back, swapped for a junction and back, moved elsewhere and
 *   back), so a folder on the way swapped for a junction and back, or the chat's folder itself,
 *   shows in them; with those times unmoved, each walk went through the folders it looked at, and
 *   the file the handle holds lies there. The chat folder's parent and the folders above it are
 *   checked for links and ids only: folders made or removed beside the chat's folder (a new chat,
 *   a build in the projects folder) move the parent's times but never the chat folder's.
 *   File times move by clock ticks (up to about 16 ms on Windows), so two changes within one tick
 *   leave the same time: a folder on the way changed less than `CONTAIN.settleMs` before a walk is
 *   looked at again once it has settled. Any difference refuses that try (a legitimate write in one
 *   of those folders during the check too); it is tried once more, then not inside. Windows also
 *   keeps every folder above an open file, or above a process's working folder (an agent's, during a
 *   share), from being renamed at all.
 *   What remains: someone who swaps a folder on the way and then puts its modify and change times
 *   back exactly (the change time needs SetFileInformationByHandle, not anything Node offers), or
 *   who flips a folder above the chat folder (its parent or further up: links and ids only)
 *   between two lookups while no process works in the chat folder. Either takes a local process
 *   racing the check on purpose, one that could as well copy the file into the folder.
 * - A file with another name elsewhere (a hard link) is that file too: it is never inside.
 */

export const CONTAIN = {
  /** A folder on the way must have been left alone this long before a walk can tell its next change (its times move by clock ticks). */
  settleMs: 25,
  /**
   * How it is established here: the handle's own path (Linux), the two walks around the open
   * (Windows, macOS: not a proof, see above), or not at all (`none`: nothing is inside).
   */
  how: (process.platform === 'linux' ? 'proc' : 'walk') as 'proc' | 'walk' | 'none',
};

/** `p` is `root` or lies under it (both real paths; case-insensitive on Windows). */
export function within(root: string, p: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** The file opened, and whether it is established that it lies in the folder. The caller closes it. */
export interface Contained<H> {
  handle: H;
  /** The handle's own reading, right after it was opened. */
  st: BigIntStats;
  inside: boolean;
}

/** Opens `file` (its real place) for reading, sync (a share's capture): see the module's comment. Throws when it cannot be opened. */
export function openContainedSync(file: string, root: string | undefined): { fd: number; st: BigIntStats; inside: boolean } {
  const got = runSync(check<number>(file, root));
  return { fd: got.handle, st: got.st, inside: got.inside };
}

/** Opens `file` (its real place) for reading, async: see the module's comment. Throws when it cannot be opened. */
export async function openContained(file: string, root: string | undefined): Promise<{ fh: FileHandle; st: BigIntStats; inside: boolean }> {
  const got = await runAsync(check<FileHandle>(file, root));
  return { fh: got.handle, st: got.st, inside: got.inside };
}

// ── the check, once for both: it asks for each lookup, the drivers below do it ──

type Op =
  | { k: 'lstat'; p: string }
  | { k: 'stat'; p: string }
  | { k: 'open'; p: string }
  | { k: 'fstat'; h: unknown }
  | { k: 'close'; h: unknown }
  /** The handle's own path (Linux), or null where the system does not say. */
  | { k: 'self'; h: unknown }
  | { k: 'sleep'; ms: number };

type Check<T> = Generator<Op, T, unknown>;

/** What is looked up: the volume's root down to the file; from `timedFrom` on, folders' times count too. */
interface Chain {
  paths: string[];
  timedFrom: number;
}

function chainOf(root: string, file: string): Chain | null {
  if (!within(root, file)) return null;
  const rel = path.relative(root, file);
  if (!rel) return null;
  const up: string[] = [];
  for (let at = root; ; ) {
    const parent = path.dirname(at);
    if (parent === at) break;
    up.unshift(parent);
    at = parent;
  }
  const paths = [...up, root];
  let at = root;
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    at = path.join(at, part);
    paths.push(at);
  }
  // The chat's folder itself (its own change time moves when it is swapped) and everything below it,
  // never its parent, whose times move with every folder made or removed beside it.
  return { paths, timedFrom: up.length };
}

interface Seen {
  ino: bigint;
  dev: bigint;
  m: bigint;
  c: bigint;
  nlink: bigint;
}

/** One walk down: what each lookup found, and how long to wait for folders that changed just now (0: none did); null when it is not a plain path. */
function* walk(chain: Chain): Check<{ seen: Seen[]; wait: number } | null> {
  const settle = BigInt(CONTAIN.settleMs) * 1_000_000n;
  // Taken before the lookups, so a folder's age is never overstated.
  const now = BigInt(Date.now()) * 1_000_000n;
  const seen: Seen[] = [];
  let wait = 0;
  for (let i = 0; i < chain.paths.length; i++) {
    const leaf = i === chain.paths.length - 1;
    const s = (yield { k: 'lstat', p: chain.paths[i] }) as BigIntStats;
    if (s.isSymbolicLink() || (leaf ? !s.isFile() : !s.isDirectory())) return null;
    // Its change time (which nothing in Node can set) tells whether its next change would show.
    if (!leaf && i >= chain.timedFrom && now - s.ctimeNs < settle) wait = Math.max(wait, Math.min(CONTAIN.settleMs, Math.ceil(Number(settle - (now - s.ctimeNs)) / 1e6)));
    seen.push({ ino: s.ino, dev: s.dev, m: s.mtimeNs, c: s.ctimeNs, nlink: s.nlink });
  }
  return { seen, wait };
}

/** The two walks agree: the same folders and file, and the timed folders untouched. */
function same(a: Seen[], b: Seen[], timedFrom: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].ino !== b[i].ino || a[i].dev !== b[i].dev) return false;
    if (i >= timedFrom && i < a.length - 1 && (a[i].m !== b[i].m || a[i].c !== b[i].c)) return false;
  }
  return true;
}

function* opened<H>(file: string): Check<{ handle: H; st: BigIntStats }> {
  const handle = (yield { k: 'open', p: file }) as H;
  try {
    return { handle, st: (yield { k: 'fstat', h: handle }) as BigIntStats };
  } catch (err) {
    yield { k: 'close', h: handle };
    throw err;
  }
}

/** A lookup that fails (a folder or the file gone for a moment) is a try that did not hold. */
function* tryWalk(chain: Chain): Check<{ seen: Seen[]; wait: number } | null | 'gone'> {
  try {
    return yield* walk(chain);
  } catch {
    return 'gone';
  }
}

function* check<H>(file: string, root: string | undefined): Check<Contained<H>> {
  const chain = root ? chainOf(root, file) : null;
  const how = CONTAIN.how;
  // No proof of where an opened file lies here: it is not inside.
  if (!root || !chain || how === 'none') return { ...(yield* opened<H>(file)), inside: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const last = attempt === 1;
    if (how === 'proc') {
      const got = yield* opened<H>(file);
      const self = (yield { k: 'self', h: got.handle }) as string | null;
      if (self !== null) {
        let ok = false;
        if (got.st.isFile() && got.st.nlink === 1n && within(root, self)) {
          try {
            const now = (yield { k: 'stat', p: self }) as BigIntStats;
            ok = now.ino === got.st.ino && now.dev === got.st.dev;
          } catch {
            ok = false;
          }
        }
        // Named outside the folder, another kind of file, or more names: that is final.
        if (ok || last || !got.st.isFile() || got.st.nlink !== 1n || !within(root, self)) return { ...got, inside: ok };
        yield { k: 'close', h: got.handle };
        continue;
      }
      // No /proc here: nothing names the handle's file, so it is not established.
      return { ...got, inside: false };
    }
    let before = yield* tryWalk(chain);
    if (before && before !== 'gone' && before.wait) {
      yield { k: 'sleep', ms: before.wait };
      before = yield* tryWalk(chain);
    }
    const got = yield* opened<H>(file);
    // A link or a junction on the way, or a file with another name: that is final.
    if (before === null || got.st.nlink !== 1n || !got.st.isFile()) return { ...got, inside: false };
    let after: { seen: Seen[]; wait: number } | null | 'gone' = 'gone';
    if (before !== 'gone' && !before.wait) {
      after = yield* tryWalk(chain);
      if (after === null) return { ...got, inside: false };
    }
    if (before !== 'gone' && !before.wait && after !== 'gone') {
      const a = before.seen[before.seen.length - 1];
      const b = after.seen[after.seen.length - 1];
      const ok = same(before.seen, after.seen, chain.timedFrom) && a.ino === got.st.ino && a.dev === got.st.dev && b.ino === got.st.ino && b.dev === got.st.dev && a.nlink === 1n && b.nlink === 1n;
      if (ok) return { ...got, inside: true };
    }
    if (last) return { ...got, inside: false };
    yield { k: 'close', h: got.handle };
  }
  /* not reached: the last try returns */
  throw new Error('unreachable');
}

// ── the drivers ──

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

function runSync<T>(g: Check<T>): T {
  let r = g.next();
  for (;;) {
    if (r.done) return r.value;
    let out: unknown;
    let failed = false;
    let err: unknown;
    try {
      out = doSync(r.value);
    } catch (e) {
      failed = true;
      err = e;
    }
    r = failed ? g.throw(err) : g.next(out);
  }
}

function doSync(op: Op): unknown {
  switch (op.k) {
    case 'lstat':
      return lstatSync(op.p, { bigint: true });
    case 'stat':
      return statSync(op.p, { bigint: true });
    case 'open':
      return openSync(op.p, 'r');
    case 'fstat':
      return fstatSync(op.h as number, { bigint: true });
    case 'close':
      try {
        closeSync(op.h as number);
      } catch {
        /* already gone */
      }
      return undefined;
    case 'self':
      try {
        return realpathSync(`/proc/self/fd/${op.h as number}`);
      } catch {
        return null;
      }
    case 'sleep':
      // A share's capture is synchronous: a short real sleep, only when a folder on the way changed just now.
      Atomics.wait(SLEEPER, 0, 0, op.ms);
      return undefined;
  }
}

async function runAsync<T>(g: Check<T>): Promise<T> {
  let r = g.next();
  for (;;) {
    if (r.done) return r.value;
    let out: unknown;
    let failed = false;
    let err: unknown;
    try {
      out = await doAsync(r.value);
    } catch (e) {
      failed = true;
      err = e;
    }
    r = failed ? g.throw(err) : g.next(out);
  }
}

async function doAsync(op: Op): Promise<unknown> {
  switch (op.k) {
    case 'lstat':
      return lstat(op.p, { bigint: true });
    case 'stat':
      return stat(op.p, { bigint: true });
    case 'open':
      return open(op.p, 'r');
    case 'fstat':
      return (op.h as FileHandle).stat({ bigint: true });
    case 'close':
      await (op.h as FileHandle).close().catch(() => {});
      return undefined;
    case 'self':
      return realpath(`/proc/self/fd/${(op.h as FileHandle).fd}`).catch(() => null);
    case 'sleep':
      await new Promise((r) => setTimeout(r, op.ms));
      return undefined;
  }
}
