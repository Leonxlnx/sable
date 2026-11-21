import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
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
 * - Only a plain file is opened at all (review wave 6, #21): another kind of file (a pipe, a device,
 *   a folder) is refused by its lookup before the open, and the open itself never waits (no blocking
 *   open of a pipe put there between the two: `O_NONBLOCK` where the system has it); a handle that
 *   is not a plain file is refused too.
 * - The chat's folder is the one it was when it became the chat's (review wave 6, #2): `pinFolder`
 *   records its identity (volume and id) then, `folderNow` says whether the folder at that place is
 *   still that one (swapped for a junction to another folder, or for another folder: not), and a
 *   root given as a `FolderRoot` must be that folder in both walks (on Linux, by its own lookup).
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

/** A chat's folder as it is now (`real`, its canonical place) with the identity it was pinned with (`pinFolder`). */
export interface FolderRoot {
  real: string;
  dev: bigint;
  ino: bigint;
}

/** A chat's folder as a root: its canonical place, and its identity where it is known. */
type RootIn = string | FolderRoot | undefined;

const realOf = (r: RootIn) => (typeof r === 'string' ? r : r?.real);

/** Another kind of file than a plain one (a pipe, a device, a folder): never opened. */
export class NotAFile extends Error {
  constructor() {
    super('Not a plain file.');
  }
}

/** The file opened, and whether it is established that it lies in the folder. The caller closes it. */
export interface Contained<H> {
  handle: H;
  /** The handle's own reading, right after it was opened. */
  st: BigIntStats;
  inside: boolean;
}

/** Opens `file` (its real place) for reading, sync (a share's capture): see the module's comment. Throws when it cannot be opened or is not a plain file (`NotAFile`). */
export function openContainedSync(file: string, root: RootIn): { fd: number; st: BigIntStats; inside: boolean } {
  const got = runSync(check<number>(file, root));
  return { fd: got.handle, st: got.st, inside: got.inside };
}

/** Opens `file` (its real place) for reading, async: see the module's comment. Throws when it cannot be opened or is not a plain file (`NotAFile`). */
export async function openContained(file: string, root: RootIn): Promise<{ fh: FileHandle; st: BigIntStats; inside: boolean }> {
  const got = await runAsync(check<FileHandle>(file, root));
  return { fh: got.handle, st: got.st, inside: got.inside };
}

/** Opens a plain file for reading, sync, with no containment asked (a share's permission, as shown): another kind of file is refused before and after the open, and the open never waits. */
export function openPlainSync(file: string): { fd: number; st: BigIntStats } {
  const got = runSync(opened<number>(file));
  return { fd: got.handle, st: got.st };
}

// ── a chat's folder as it was when it became the chat's (review wave 6, #2) ──

/** Each chat folder's identity (volume and id), by its place as sessions name it (resolved, case-folded on Windows). */
const pins = new Map<string, { dev: bigint; ino: bigint }>();

const pinKey = (cwd: string) => (process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd));

/**
 * Records the folder at `cwd` as the chat's, when its folder becomes known (a chat made or restored,
 * a lane entered): its identity, links followed. Once: a later call keeps what was recorded first,
 * unless `fresh` (a folder Sable has just made there itself, a lane's worktree). False when there is
 * no folder there to record.
 */
export async function pinFolder(cwd: string, fresh = false): Promise<boolean> {
  if (!cwd) return false;
  const key = pinKey(cwd);
  if (pins.has(key) && !fresh) return true;
  try {
    const st = await stat(await realpath(path.resolve(cwd)), { bigint: true });
    if (!st.isDirectory()) return false;
    if (fresh || !pins.has(key)) pins.set(key, { dev: st.dev, ino: st.ino });
    return true;
  } catch {
    return false;
  }
}

/** The chat's folder now: the one pinned for it (its canonical place now), `gone` (no folder there), or `changed` (another folder than the one pinned). */
export type FolderNow = FolderRoot | 'gone' | 'changed';

/**
 * Whether the folder at `cwd` is still the one pinned for it (`pinFolder`; one never pinned is
 * pinned now). A folder swapped for a junction to another one, or for another folder, is `changed`:
 * nothing in it counts as the chat's (no phone listing or diff, no share inside it).
 */
export async function folderNow(cwd: string): Promise<FolderNow> {
  let real: string;
  let st: BigIntStats;
  try {
    real = await realpath(path.resolve(cwd));
    st = await stat(real, { bigint: true });
  } catch {
    return 'gone';
  }
  return judged(cwd, real, st);
}

/** `folderNow`, sync (a share's capture). */
export function folderNowSync(cwd: string): FolderNow {
  let real: string;
  let st: BigIntStats;
  try {
    real = realpathSync(path.resolve(cwd));
    st = statSync(real, { bigint: true });
  } catch {
    return 'gone';
  }
  return judged(cwd, real, st);
}

function judged(cwd: string, real: string, st: BigIntStats): FolderNow {
  if (!st.isDirectory()) return 'gone';
  const key = pinKey(cwd);
  let pin = pins.get(key);
  if (!pin) {
    pin = { dev: st.dev, ino: st.ino };
    pins.set(key, pin);
  }
  return pin.dev === st.dev && pin.ino === st.ino ? { real, dev: pin.dev, ino: pin.ino } : 'changed';
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
  /** The identity the chat's folder (`paths[timedFrom]`) must have, where it was pinned. */
  id?: { dev: bigint; ino: bigint };
}

function chainOf(root: string, file: string, id?: { dev: bigint; ino: bigint }): Chain | null {
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
  return { paths, timedFrom: up.length, ...(id ? { id } : {}) };
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
    // The chat's folder is another folder than the one pinned for it: that is final.
    if (chain.id && i === chain.timedFrom && (s.ino !== chain.id.ino || s.dev !== chain.id.dev)) return null;
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

/** Opens a plain file: another kind is refused by its lookup before the open and by its handle after it, and the open never waits. */
function* opened<H>(file: string): Check<{ handle: H; st: BigIntStats }> {
  const was = (yield { k: 'stat', p: file }) as BigIntStats;
  if (!was.isFile()) throw new NotAFile();
  const handle = (yield { k: 'open', p: file }) as H;
  try {
    const st = (yield { k: 'fstat', h: handle }) as BigIntStats;
    if (!st.isFile()) throw new NotAFile();
    return { handle, st };
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

function* check<H>(file: string, rootIn: RootIn): Check<Contained<H>> {
  const root = realOf(rootIn);
  const id = typeof rootIn === 'object' ? { dev: rootIn.dev, ino: rootIn.ino } : undefined;
  const chain = root ? chainOf(root, file, id) : null;
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
        // Its own path is the one asked for (the caller resolved it): nothing was followed on the way.
        const named = within(root, self) && within(self, file) && within(file, self);
        if (got.st.isFile() && got.st.nlink === 1n && named) {
          try {
            const now = (yield { k: 'stat', p: self }) as BigIntStats;
            ok = now.ino === got.st.ino && now.dev === got.st.dev;
            if (ok && id) {
              const dir = (yield { k: 'stat', p: root }) as BigIntStats;
              ok = dir.ino === id.ino && dir.dev === id.dev;
            }
          } catch {
            ok = false;
          }
        }
        // Named elsewhere, another kind of file, or more names: that is final.
        if (ok || last || !got.st.isFile() || got.st.nlink !== 1n || !named) return { ...got, inside: ok };
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

/** Read-only, and never waiting for a writer (a pipe put there after its lookup) where the system has the flag. */
const READ_NOW = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

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
      return openSync(op.p, READ_NOW);
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
      return open(op.p, READ_NOW);
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
