import { closeSync, fstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { HandedFile, SharedFile } from '../../shared/protocol';

/**
 * What a share step handed over, captured the moment it went through: each file's real place (links
 * followed), size, time and exact identity (the file id as a decimal string: a JS number rounds the
 * 64-bit ids Windows gives, so two files can share one), and whether it lay in the chat's folder. A
 * phone download is served only for that exact file (server/services/phone-guard.ts `grantFor`); a file
 * replaced, rewritten or reached through a link that now leads elsewhere is refused. `approved`: what
 * the person allowed themselves, captured when the permission was shown to them (`approvedShare`),
 * which is what lets a file outside the chat's folder go to a phone (`granted`): only a file that is
 * exactly one they were shown, at its place in the list, at the same real place and the same file
 * (volume, id, size, time). A link retargeted, a file replaced, or a file added since is not granted.
 */
export function handFiles(cwd: string, files: readonly SharedFile[] | undefined, approved?: ApprovedShare): (HandedFile | null)[] {
  let root: string | undefined;
  try {
    root = realpathSync(cwd);
  } catch {
    /* the chat's folder is gone: nothing counts as inside it */
  }
  return (files ?? []).map((f, i) => {
    if (!f || typeof f.path !== 'string' || !f.path) return null;
    let fd: number | undefined;
    try {
      const listed = path.resolve(cwd, f.path);
      const real = realpathSync(listed);
      // Both readings of the one open file.
      fd = openSync(real, 'r');
      const st = fstatSync(fd);
      const exact = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return null;
      const inside = !!root && within(root, real);
      const record: HandedFile = { path: real, size: st.size, mtimeMs: st.mtimeMs, ino: exact.ino.toString(), dev: st.dev, inside };
      const shown = approved && approved.listed[i] !== undefined && samePath(approved.listed[i], listed) && sameFile(approved.files[i], record);
      return { ...record, ...(!inside && shown ? { granted: true } : {}) };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

/** What the person was shown when a share asked to be allowed: each listed file's place, and the file it was then. */
export interface ApprovedShare {
  listed: string[];
  files: (HandedFile | null)[];
}

/** Captures what a share's permission shows, as it is shown (`handFiles` compares the completed share with it). */
export function approvedShare(cwd: string, files: readonly SharedFile[] | undefined): ApprovedShare {
  return { listed: (files ?? []).map((f) => (f && typeof f.path === 'string' && f.path ? path.resolve(cwd, f.path) : '')), files: handFiles(cwd, files) };
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The same file at the same real place, unchanged (`a` as approved, `b` as handed over). */
function sameFile(a: HandedFile | null | undefined, b: HandedFile): boolean {
  return !!a && samePath(a.path, b.path) && a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** `p` is `root` or lies under it (both real paths; case-insensitive on Windows). */
export function within(root: string, p: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
