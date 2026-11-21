import { createHash } from 'node:crypto';
import { close, closeSync, fstat, fstatSync, openSync, read, readSync, realpathSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { HandedFile, SharedFile } from '../../shared/protocol';
import { openContainedSync, within } from './contain';

export { within };

/** A file bigger than this is not read for its digest when it is shared (`unhashed: 'big'`); a phone does not get it. */
export const HASH_MAX = 2 * 1024 ** 3;
/**
 * A share's files are read for their digests at once (before the capture returns, so their handles
 * are closed by then) while their bytes together stay within this; the rest after, without holding
 * the step. An open file cannot be moved over or have its folder renamed on Windows: a build that
 * replaces a small shared file right after the share is never refused because of the digest.
 */
export const HASH_AT_ONCE = 1024 * 1024;

/** What a share's capture gives: the records at once, and their digests as they come in. */
export interface Handing {
  handed: (HandedFile | null)[];
  /**
   * The same records again, each with `sha256` or `unhashed` (null stays null), once every file has
   * been read through the handle the capture opened (each closed then). Absent when nothing is left
   * to read (every file read at once, too big, missing or unreadable). Never rejects.
   */
  digests?: Promise<(HandedFile | null)[]>;
}

/**
 * What a share step handed over, captured the moment it went through: each file's real place (links
 * followed), size, time and exact identity (the file id as a decimal string: a JS number rounds the
 * 64-bit ids Windows gives, so two files can share one), whether it lay in the chat's folder, and
 * the SHA-256 of its bytes then. A phone download is served only for that exact file and those bytes
 * (server/services/phone-guard.ts `grantFor`, phone.ts); a file replaced, rewritten or reached
 * through a link that now leads elsewhere is refused.
 * - In the chat's folder (`inside`) only when that is established against the opened handle
 *   (core/contain.ts): a file reached through a folder flipped for a junction around the open, or one
 *   with another name elsewhere (a hard link), is not; where it cannot be established, not either.
 *   Only Linux names a handle's file, so on Windows and macOS no file is inside: every file there is
 *   external and reaches a phone only as `granted` (the person allowed that share themselves).
 * - `approved`: what the person allowed themselves, captured when the permission was shown to them
 *   (`approvedShare`), which is what lets a file outside the chat's folder go to a phone (`granted`):
 *   only a file that is exactly one they were shown, at its place in the list, at the same real place
 *   and the same file (volume, id, size, time). A link retargeted, a file replaced, or a file added
 *   since is not granted.
 * - The digest is read through the very handle opened here (never the path again): at once for the
 *   first files within `HASH_AT_ONCE`, the others after this returns, so a share's step is never held
 *   by a big file. Recorded only when every byte was read and the file stayed as it was captured all
 *   along (size, modify and change times, volume and id, read before and after); otherwise
 *   `unhashed: 'changed'`, `'unreadable'` when a read failed, and `'big'` above `HASH_MAX` without
 *   reading. While a file is read after, its handle stays open (on Windows a build cannot move
 *   another file over it meanwhile).
 * `hashMax`, `atOnce`: the caps (tests).
 */
export function handOver(cwd: string, files: readonly SharedFile[] | undefined, approved?: ApprovedShare, opts: { hashMax?: number; atOnce?: number } = {}): Handing {
  const max = opts.hashMax ?? HASH_MAX;
  let now = opts.atOnce ?? HASH_AT_ONCE;
  let root: string | undefined;
  try {
    root = realpathSync(cwd);
  } catch {
    /* the chat's folder is gone: nothing counts as inside it */
  }
  const held: { fd: number; was: BigIntStats }[] = [];
  const handed = (files ?? []).map((f, i): HandedFile | null => {
    if (!f || typeof f.path !== 'string' || !f.path) return null;
    let fd: number | undefined;
    try {
      const listed = path.resolve(cwd, f.path);
      const real = realpathSync(listed);
      const got = openContainedSync(real, root);
      fd = got.fd;
      const record = recordOf(real, fd, got.st, got.inside);
      if (!record) return null;
      const shown = approved && approved.listed[i] !== undefined && samePath(approved.listed[i], listed) && sameFile(approved.files[i], record);
      const out: HandedFile = { ...record, ...(!record.inside && shown ? { granted: true } : {}) };
      if (record.size > max) return { ...out, unhashed: 'big' };
      if (record.size <= now) {
        now -= record.size;
        const h = fd;
        fd = undefined;
        return { ...out, ...digestSync(h, got.st) };
      }
      // Kept open: its digest is read through it after.
      held[i] = { fd, was: got.st };
      fd = undefined;
      return out;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeQuietly(fd);
    }
  });
  if (!held.some(Boolean)) return { handed };
  const digests = Promise.all(handed.map(async (r, i) => (r && held[i] ? { ...r, ...(await digestOf(held[i].fd, held[i].was)) } : r)));
  return { handed, digests };
}

/** The record of an opened file (its number readings for size and time, as the phone's checks read them), or null when it is not a plain file. */
function recordOf(real: string, fd: number, exact: BigIntStats, inside: boolean): HandedFile | null {
  const st = fstatSync(fd);
  if (!st.isFile() || !exact.isFile()) return null;
  return { path: real, size: st.size, mtimeMs: st.mtimeMs, ino: exact.ino.toString(), dev: st.dev, inside };
}

const CHUNK = 1024 * 1024;

const fstatOf = (fd: number) => new Promise<BigIntStats>((resolve, reject) => fstat(fd, { bigint: true }, (e, s) => (e ? reject(e) : resolve(s))));
const readAt = (fd: number, buf: Buffer, len: number, at: number) => new Promise<number>((resolve, reject) => read(fd, buf, 0, len, at, (e, n) => (e ? reject(e) : resolve(n))));
const closeLater = (fd: number) => new Promise<void>((resolve) => close(fd, () => resolve()));

function closeQuietly(fd: number) {
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

/** The file is still exactly as captured: size, modify and change times, volume and id. */
const unchanged = (s: BigIntStats, was: BigIntStats) => s.size === was.size && s.mtimeNs === was.mtimeNs && s.ctimeNs === was.ctimeNs && s.ino === was.ino && s.dev === was.dev;

/** `digestOf` at once (a small file, before the capture returns). */
function digestSync(fd: number, was: BigIntStats): Pick<HandedFile, 'sha256' | 'unhashed'> {
  try {
    if (!unchanged(fstatSync(fd, { bigint: true }), was)) return { unhashed: 'changed' };
    const size = Number(was.size);
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size + 1));
    let off = 0;
    while (off <= size) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, size + 1 - off), off);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    if (off !== size || !unchanged(fstatSync(fd, { bigint: true }), was)) return { unhashed: 'changed' };
    return { sha256: hash.digest('hex') };
  } catch {
    return { unhashed: 'unreadable' };
  } finally {
    closeQuietly(fd);
  }
}

/** The SHA-256 of the bytes behind `fd`, only when they are exactly the file captured as `was` all along; the handle is closed on every path. */
async function digestOf(fd: number, was: BigIntStats): Promise<Pick<HandedFile, 'sha256' | 'unhashed'>> {
  const same = (s: BigIntStats) => unchanged(s, was);
  try {
    if (!same(await fstatOf(fd))) return { unhashed: 'changed' };
    const size = Number(was.size);
    const hash = createHash('sha256');
    // One byte past its size is asked for, to see it grew.
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size + 1));
    let off = 0;
    while (off <= size) {
      const n = await readAt(fd, buf, Math.min(buf.length, size + 1 - off), off);
      if (!n) break;
      hash.update(buf.subarray(0, n));
      off += n;
    }
    if (off !== size || !same(await fstatOf(fd))) return { unhashed: 'changed' };
    return { sha256: hash.digest('hex') };
  } catch {
    return { unhashed: 'unreadable' };
  } finally {
    await closeLater(fd);
  }
}

/** What the person was shown when a share asked to be allowed: each listed file's place, and the file it was then. */
export interface ApprovedShare {
  listed: string[];
  /** Each file's identity as shown (`inside` is not established here: the share's own capture decides it). */
  files: (HandedFile | null)[];
}

/** Captures what a share's permission shows, as it is shown (`handOver` compares the completed share with it). */
export function approvedShare(cwd: string, files: readonly SharedFile[] | undefined): ApprovedShare {
  return {
    listed: (files ?? []).map((f) => (f && typeof f.path === 'string' && f.path ? path.resolve(cwd, f.path) : '')),
    files: (files ?? []).map((f) => {
      if (!f || typeof f.path !== 'string' || !f.path) return null;
      let fd: number | undefined;
      try {
        const real = realpathSync(path.resolve(cwd, f.path));
        fd = openSync(real, 'r');
        return recordOf(real, fd, fstatSync(fd, { bigint: true }), false);
      } catch {
        return null;
      } finally {
        if (fd !== undefined) closeQuietly(fd);
      }
    }),
  };
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The same file at the same real place, unchanged (`a` as approved, `b` as handed over). */
function sameFile(a: HandedFile | null | undefined, b: HandedFile): boolean {
  return !!a && samePath(a.path, b.path) && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
