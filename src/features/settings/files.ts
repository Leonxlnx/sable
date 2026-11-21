/**
 * The agents' settings and instruction files as Settings lists them: one entry per file. In a chat
 * whose folder is the home folder the user's file and the project's file are the same file (the
 * bridge lists it under both scopes): it shows once, under the scope listed first (the user's).
 */
interface ScopedFile {
  path: string;
  scope: string;
}

/** One spelling per file: slashes one way, no trailing one, case aside (Windows paths). */
const same = (path: string) => path.split('\\').join('/').replace(/\/+$/, '').toLowerCase();

export function oneOfEach<T extends ScopedFile>(files: T[]): T[] {
  const seen = new Set<string>();
  return files.filter((f) => {
    const k = same(f.path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A list key: the kind of file and where it is (two scopes never share one). */
export const fileKey = (f: ScopedFile) => `${f.scope}:${f.path}`;
