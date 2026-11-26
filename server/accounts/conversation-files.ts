import { constants, copyFile, lstat, mkdir, opendir, realpath, rename, unlink, utimes, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openContained } from '../core/contain';

export type Agent = 'claude' | 'codex';
const SAFE_ID = /^[\w-]{1,128}$/;
export class UnsafePath extends Error {}
export class Unproven extends Error {}

function missing(err: unknown) {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

// The configured home and the conversation areas may be redirected by their owner.
export async function accountRoot(home: string, create = false) {
  if (create) await mkdir(home, { recursive: true });
  return realpath(home).catch(err => { if (!missing(err)) throw err; });
}

export async function directory(root: string, dir: string, create = false): Promise<boolean> {
  if (dir !== root) {
    const parent = path.dirname(dir);
    if (dir === parent) throw new UnsafePath();
    if (!await directory(root, parent, create)) return false;
  }
  let st = await lstat(dir).catch(err => { if (!missing(err)) throw err; });
  if (!st && create && dir !== root) {
    await mkdir(dir).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; });
    st = await lstat(dir);
  }
  if (!st) return false;
  if (!st.isDirectory() || st.isSymbolicLink()) throw new UnsafePath();
  return true;
}

export async function regular(root: string, file: string, allowHardLinks = false) {
  if (!await directory(root, path.dirname(file))) return;
  const st = await lstat(file, { bigint: true }).catch(err => { if (!missing(err)) throw err; });
  if (!st) return;
  if (!st.isFile() || !allowHardLinks && st.nlink !== 1n) throw new UnsafePath();
  return st;
}

export type Stamp = NonNullable<Awaited<ReturnType<typeof regular>>>;
export const sameFile = (a: Stamp, b: Stamp) => a.ino === b.ino && a.dev === b.dev;
export interface Root { home: string; dir: string; stamp: Stamp }

export async function resolveRoot(home: string, create = false): Promise<Root | undefined> {
  if (create) await mkdir(home).catch(err => { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; });
  const dir = await accountRoot(home).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new UnsafePath();
    throw err;
  });
  if (!dir) {
    // A dangling area junction is neither an empty area nor a place to create a folder.
    const entry = await lstat(home).catch(err => { if (!missing(err)) throw err; });
    if (entry) throw new UnsafePath();
    return;
  }
  const stamp = await lstat(dir, { bigint: true });
  if (!stamp.isDirectory()) throw new UnsafePath();
  return { home, dir, stamp };
}

export const transcriptArea = (agent: Agent) => agent === 'claude' ? 'projects' : 'sessions';
const shared = (a: Root, b: Root) => a.dir === b.dir || a.stamp.ino !== 0n && sameFile(a.stamp, b.stamp);
export const unchanged = (a: Stamp, b: Stamp | undefined) =>
  !!b && sameFile(a, b) && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;

export interface Pair { old: string; current: string; src: string; dst: string; sourceStat: Stamp; destinationStat: Stamp; appending: boolean }

// Only the reserved move can have its destination writer appending to the primary transcript.
export function currentFile(was: Stamp, now: Stamp | undefined, appending: boolean) {
  return unchanged(was, now) || (appending && !!now && sameFile(was, now) && now.size > was.size);
}

export async function checkedPair(old: string, current: string, rel: string, appending = false): Promise<Pair | undefined> {
  const src = path.join(old, rel), dst = path.join(current, rel);
  const sourceStat = await regular(old, src), destinationStat = await regular(current, dst);
  if (!sourceStat) throw new Unproven();
  if (!destinationStat || sourceStat.size > destinationStat.size) return;
  if (sameFile(sourceStat, destinationStat)) throw new UnsafePath();
  return { old, current, src, dst, sourceStat, destinationStat, appending };
}

// Reopen the same two singly-linked files for removal, keeping both handles through unlink.
export async function withPair<T>(p: Pair, action: (a: FileHandle, b: FileHandle) => Promise<T>): Promise<T> {
  const a = await openContained(p.src, p.old, true);
  try {
    const b = await openContained(p.dst, p.current, true);
    try {
      if (!a.inside || !b.inside) throw new UnsafePath();
      if (!unchanged(p.sourceStat, a.st) || !currentFile(p.destinationStat, b.st, p.appending)) throw new Unproven();
      return await action(a.fh, b.fh);
    } finally { await b.fh.close(); }
  } finally { await a.fh.close(); }
}

export function prefix(p: Pair, check: () => void) {
  return withPair(p, async (a, b) => {
    const size = Number(p.sourceStat.size);
    const chunk = Math.min(1024 * 1024, size);
    const left = Buffer.allocUnsafe(chunk), right = Buffer.allocUnsafe(chunk);
    for (let pos = 0; pos < size; pos += chunk) {
      check();
      const n = Math.min(chunk, size - pos);
      const [x, y] = await Promise.all([a.read(left, 0, n, pos), b.read(right, 0, n, pos)]);
      if (x.bytesRead !== n || y.bytesRead !== n) throw new Unproven();
      if (!left.subarray(0, n).equals(right.subarray(0, n))) return false;
    }
    return true;
  });
}

const accountFile = /^(?:\.credentials\.json|\.claude\.json|auth\.json)$/i;
const unsafeName = (name: string) => process.platform === 'win32' &&
  (/[.: ]$|[:\\/]/.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name));

export const safeId = (id: string) => SAFE_ID.test(id) && !unsafeName(id);

// A carry can omit an odd entry. The same observation vetoes removal.
async function skipUnsafe<T>(copying: boolean, action: () => Promise<T>) {
  try { return await action(); } catch (err) { if (!copying || !(err instanceof UnsafePath)) throw err; }
}

async function* entries(home: string, rel: string, check: () => void, copying: boolean, side = false) {
  check();
  const dir = path.join(home, rel);
  if (!await skipUnsafe(copying, () => directory(home, dir))) return;
  for await (const entry of await opendir(dir)) {
    check();
    if (accountFile.test(entry.name) && !side) continue;
    if (unsafeName(entry.name) || accountFile.test(entry.name)) {
      if (copying) continue;
      throw new UnsafePath();
    }
    yield entry;
  }
}

const rollout = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([\w-]{1,128})\.jsonl$/;
const claudeName = process.platform === 'win32' ? /^([\w-]{1,128})\.jsonl$/i : /^([\w-]{1,128})\.jsonl$/;

// Only names are cached. Every candidate goes back through regular(), the byte proof and
// the final handle/path checks. A targeted Claude scan needs just one lookup per project key.
export async function transcriptIndex(agent: Agent, area: string, check: () => void, only?: string, copying = false) {
  const found = new Map<string, string[]>();
  const windowsProjects = process.platform === 'win32' && agent === 'claude';
  const indexKey = (id: string) => windowsProjects ? id.toLowerCase() : id;
  const add = (id: string, rel: string) => {
    const key = indexKey(id);
    if (only && key !== indexKey(only)) return;
    const files = found.get(key);
    if (files) files.push(rel);
    else found.set(key, [rel]);
  };
  if (agent === 'claude') {
    for await (const key of entries(area, '', check, copying)) {
      if (key.isSymbolicLink() && !copying) throw new UnsafePath();
      if (!key.isDirectory()) continue;
      const dir = key.name;
      if (only) {
        const rel = path.join(dir, only + '.jsonl');
        if (await skipUnsafe(copying, () => regular(area, path.join(area, rel), copying))) add(only, rel);
      } else {
        for await (const entry of entries(area, dir, check, copying)) {
          const match = claudeName.exec(entry.name);
          if (match) add(match[1], path.join(dir, entry.name));
        }
      }
    }
  } else {
    const date = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
    const walk = async (rel: string, depth: number) => {
      for await (const entry of entries(area, rel, check, copying)) {
        const child = path.join(rel, entry.name);
        if (depth < date.length) {
          if (date[depth].test(entry.name)) await walk(child, depth + 1);
        } else {
          const match = rollout.exec(entry.name);
          if (match && (!only || match[1] === only) &&
            (!copying || await skipUnsafe(true, () => regular(area, path.join(area, child), true)))) add(match[1], child);
        }
      }
    };
    await walk('', 0);
  }
  return (id: string) => {
    const hits = found.get(indexKey(id)) ?? [];
    // Use the saved ID for the actual lookup even on a case-sensitive NTFS directory.
    // A case variant in the listing is only a hint that this key might hold the chat.
    return windowsProjects ? [...new Set(hits.map(rel => path.join(path.dirname(rel), id + '.jsonl')))] : hits;
  };
}

export async function sideFiles(home: string, roots: string[], check: () => void, copying = false) {
  const files: string[] = [], dirs: string[] = [];
  const walk = async (rel: string) => {
    if (!await skipUnsafe(copying, () => directory(home, path.join(home, rel)))) return;
    for await (const entry of entries(home, rel, check, copying, true)) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && await skipUnsafe(copying, () => regular(home, path.join(home, child), copying))) files.push(child);
      else if (!copying) throw new UnsafePath();
    }
    dirs.push(rel); // children before parents for nonrecursive rmdir
  };
  for (const root of roots) await walk(root);
  return { files, dirs };
}

function copy(from: string, to: string, rel: string) {
  return skipUnsafe(true, async () => {
    const src = path.join(from, rel), dst = path.join(to, rel);
    if (!await regular(from, src, true)) return false;
    await directory(to, path.dirname(dst), true);
    const previous = await regular(to, dst, true);
    // A stale hard-linked destination must get an independent file without writing through its other name.
    const out = previous && previous.nlink > 1n ? path.join(path.dirname(dst), randomUUID() + '.tmp') : dst;
    await copyFile(src, out, out === dst && previous ? 0 : constants.COPYFILE_EXCL);
    try {
      const now = new Date();
      await utimes(out, now, now);
      if (out !== dst) await rename(out, dst);
    } finally { if (out !== dst) await unlink(out).catch(err => { if (!missing(err)) throw err; }); }
    return true;
  });
}

export const projectSide = (main: string, id: string) => path.join(path.dirname(main), id);

async function copySides(from: string, to: string, roots: string[]) {
  const side = await sideFiles(from, roots, () => {}, true);
  for (const rel of side.dirs) await skipUnsafe(true, () => directory(to, path.join(to, rel), true));
  for (const rel of side.files) await copy(from, to, rel);
}

export async function carry(agent: Agent, fromHome: string, toHome: string, id: string) {
  if (!safeId(id)) return false;
  const from = await accountRoot(fromHome);
  if (!from) return false;
  const area = transcriptArea(agent);
  const src = await skipUnsafe(true, () => resolveRoot(path.join(from, area)));
  if (!src) return false;
  const mains = (await transcriptIndex(agent, src.dir, () => {}, id, true))(id);
  if (!mains.length) return false;
  const to = await accountRoot(toHome, true);
  if (!to) throw Error('Destination account folder disappeared');
  const dst = await skipUnsafe(true, () => resolveRoot(path.join(to, area), true));
  if (!dst) return false;
  if (!shared(src, dst)) {
    const copied: string[] = [];
    for (const rel of mains) if (await copy(src.dir, dst.dir, rel)) copied.push(rel);
    if (!copied.length) return false;
    if (agent === 'claude') await copySides(src.dir, dst.dir, copied.map(rel => projectSide(rel, id)));
  }
  if (agent === 'claude') {
    const history = await skipUnsafe(true, () => resolveRoot(path.join(from, 'file-history')));
    if (history && await skipUnsafe(true, () => directory(history.dir, path.join(history.dir, id)))) {
      const dest = await skipUnsafe(true, () => resolveRoot(path.join(to, 'file-history'), true));
      if (dest && !shared(history, dest)) await copySides(history.dir, dest.dir, [id]);
    }
  }
  return true;
}
