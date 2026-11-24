import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a tool Sable runs inside a project folder (git, gh, the terminal's shell) really is.
 *
 * Spawned by a bare name, a program can come from the folder itself: on Windows the lookup tries
 * the current directory before PATH, and anywhere a relative PATH entry ("." , "bin", an empty
 * entry) reads against it. A repository could then ship its own `git.exe` or `gh.exe` and have it
 * run the moment the Changes tab or the pull request dialog asks a question. So such a tool is
 * looked up once in the absolute PATH entries that are not inside the folder it works in, and
 * spawned by that absolute path.
 */

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Folders a found program must not be inside (the working folder, the repository). */
  outside?: string[];
  /** Tests: whether a path is a program that can be run. */
  isProgram?: (file: string) => boolean;
  /** Tests: the real path of a file or folder (links resolved). */
  real?: (file: string) => string;
}

const api = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

function defaultIsProgram(platform: NodeJS.Platform) {
  return (file: string) => {
    try {
      if (!statSync(file).isFile()) return false;
      if (platform !== 'win32') accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

function defaultReal(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/** Whether `child` is `root` or inside it (case-insensitive on Windows). */
export function inside(root: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = api(platform);
  const fold = (s: string) => (platform === 'win32' ? p.resolve(s).toLowerCase() : p.resolve(s));
  const rel = p.relative(fold(root), fold(child));
  return rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel);
}

/** The PATH entries a lookup may use: absolute ones only, in order, none inside `outside`. */
export function trustedPathDirs(value: string, platform: NodeJS.Platform = process.platform, outside: string[] = []): string[] {
  const p = api(platform);
  const out: string[] = [];
  for (const raw of value.split(platform === 'win32' ? ';' : ':')) {
    // cmd.exe allows quoted entries.
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    // A drive-relative "C:bin" or a rooted "\bin" is not a full path on Windows.
    if (platform === 'win32' && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(dir)) continue;
    if (outside.some((o) => inside(o, dir, platform))) continue;
    out.push(dir);
  }
  return out;
}

/**
 * The top of the checkout `dir` belongs to: the nearest folder from it upward that holds `.git`. A
 * chat can work in a subfolder of a repository, and a program anywhere in that repository is the
 * project's own, never a tool to run (review wave 11, #1). The walk goes up the folder's real path
 * (a junction or a link is followed first: its own parents say nothing about the checkout it points
 * into), and nothing is remembered: a folder can become a checkout at any moment. Null when there
 * is none, and for a home folder or a drive that is itself a repository (dotfiles): tools installed
 * under it are the person's own.
 */
export function checkoutTop(dir: string, o: { exists?: (p: string) => boolean; home?: string; real?: (p: string) => string; realDir?: string } = {}): string | null {
  const real = o.real ?? defaultReal;
  const exists = o.exists ?? existsSync;
  const home = o.home === undefined && !o.real ? realHome() : real(path.resolve(o.home ?? os.homedir()));
  let at = o.realDir ?? real(path.resolve(dir));
  for (let i = 0; i < 64; i++) {
    const up = path.dirname(at);
    if (exists(path.join(at, '.git'))) return up === at || inside(at, home) ? null : at;
    if (up === at) break;
    at = up;
  }
  return null;
}

let homeIs: string | undefined;
/** The home folder's real path: looked up once (it does not move while Sable runs). */
function realHome(): string {
  return (homeIs ??= defaultReal(path.resolve(os.homedir())));
}

/** Checkouts found a moment ago, by the folder as named. Only found ones: "none" is looked up afresh, a folder can become a checkout at any moment. */
const found = new Map<string, { at: number; real: string; list: string[] }>();
const FOUND_MS = 5000;

/** A linked worktree's .git file points into the shared repository. Its checkout can supply
 * linked dependencies, so programs there are project programs too. Read only Git's path files. */
function sharedCheckout(top: string): string[] {
  const marker = path.join(top, '.git');
  try {
    const st = statSync(marker);
    if (!st.isFile() || st.size > 8192) return [];
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(marker, 'utf8'));
    if (!pointer) return [];
    let dir = defaultReal(path.resolve(top, pointer[1].trimEnd()));
    while (dir !== path.dirname(dir)) {
      if (path.basename(dir) === '.git') {
        const checkout = path.dirname(dir);
        return inside(checkout, realHome()) || checkout === path.dirname(checkout) ? [] : [checkout];
      }
      dir = path.dirname(dir);
    }
  } catch { /* no shared checkout */ }
  return [];
}

/**
 * The folders a tool that works in `dir` must not come from: the folder (as named and as it really
 * is) and the checkout it belongs to. Asked for every git and gh call, so the folder's real path is
 * read once per call and a checkout that was found is kept for a few seconds (a Changes refresh is
 * four git calls; on a slow share each look is a round trip that holds up the bridge).
 */
export function projectFolders(dir: string, now = Date.now()): string[] {
  const start = path.resolve(dir);
  // The folder's real path is read every time: a junction can be pointed at another checkout, and
  // what was found for the old one says nothing about the new (review wave 14, #1).
  const realDir = defaultReal(start);
  const known = found.get(start);
  if (known && known.real === realDir && now - known.at < FOUND_MS) return known.list;
  const top = checkoutTop(start, { realDir });
  const list = [...new Set([start, realDir, ...(top ? [top, ...sharedCheckout(top)] : [])])];
  if (top) {
    if (found.size >= 128) found.clear();
    found.set(start, { at: now, real: realDir, list });
  } else found.delete(start);
  return list;
}

const cache = new Map<string, string>();

/**
 * The absolute path of `name` from the trusted PATH entries, or null. On Windows only a native
 * program (.exe, .com) counts: a .cmd or .bat would need a shell, which searches the folder again.
 */
export function findProgram(name: string, o: FindOptions = {}): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const p = api(platform);
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const value = (platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const outside = o.outside ?? [];
  const isProgram = o.isProgram ?? defaultIsProgram(platform);
  const real = o.real ?? defaultReal;
  const exts = platform === 'win32' ? (/\.(exe|com)$/i.test(name) ? [''] : ['.exe', '.com']) : [''];
  const ok = (file: string) => !outside.some((root) => inside(real(root), real(file), platform) || inside(root, file, platform));

  const key = `${platform}\0${name}\0${value}\0${outside.join('\0')}`;
  const known = o.isProgram || o.real ? undefined : cache.get(key);
  if (known && isProgram(known) && ok(known)) return known;

  for (const dir of trustedPathDirs(value, platform, outside)) {
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (!isProgram(file) || !ok(file)) continue;
      if (!o.isProgram && !o.real) {
        if (cache.size >= 256) cache.clear();
        cache.set(key, file);
      }
      return file;
    }
  }
  return null;
}
