import { closeSync, fstatSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { HandedFile, SharedFile } from '../../shared/protocol';

/**
 * What a share step handed over, captured the moment it went through: each file's real place (links
 * followed), size, time and exact identity (the file id as a decimal string: a JS number rounds the
 * 64-bit ids Windows gives, so two files can share one), and whether it lay in the chat's folder. A
 * phone download is served only for that exact file (server/services/phone-guard.ts `grantFor`); a file
 * replaced, rewritten or reached through a link that now leads elsewhere is refused. `granted`: the
 * person allowed this share themselves, which is what lets a file outside the chat's folder go to a phone.
 */
export function handFiles(cwd: string, files: readonly SharedFile[] | undefined, granted: boolean): (HandedFile | null)[] {
  let root: string | undefined;
  try {
    root = realpathSync(cwd);
  } catch {
    /* the chat's folder is gone: nothing counts as inside it */
  }
  return (files ?? []).map((f) => {
    if (!f || typeof f.path !== 'string' || !f.path) return null;
    let fd: number | undefined;
    try {
      const real = realpathSync(path.resolve(cwd, f.path));
      // Both readings of the one open file.
      fd = openSync(real, 'r');
      const st = fstatSync(fd);
      const exact = fstatSync(fd, { bigint: true });
      if (!st.isFile()) return null;
      const inside = !!root && within(root, real);
      return { path: real, size: st.size, mtimeMs: st.mtimeMs, ino: exact.ino.toString(), dev: st.dev, inside, ...(!inside && granted ? { granted: true } : {}) };
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

/** `p` is `root` or lies under it (both real paths; case-insensitive on Windows). */
export function within(root: string, p: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
