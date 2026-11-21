/**
 * The untracked-file reader for a chat's changes (server/services/git.ts `readText` with `within`):
 * the file the opened handle refers to must lie in the chat's folder. A folder on the way that
 * becomes a junction (or a link) to somewhere else between the containment check and the open is
 * caught after the open, so what lies outside is never read. `open` is wrapped to make the swap at
 * exactly that moment.
 */
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTAIN } from '../server/core/contain';

// These tests are about the untracked-file reader's races (review wave 3, #6) as the walks meet them.
// Where no handle names its file (Windows), the default ('none') counts every file as external, so
// nothing is read there at all (review wave 5, #7: tests/contain.test.ts, tests/files-wave5.test.ts).
// Here the walks ('walk') stand in for Linux's proof, so a plain file in the chat folder is read.
if (CONTAIN.how === 'none') CONTAIN.how = 'walk';

const hook: { beforeOpen?: (file: string) => void; beforePath?: (fn: string, file: string) => void } = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (file: PathLike, ...rest: unknown[]) => {
    hook.beforeOpen?.(String(file));
    return (m.open as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
  }) as typeof m.open;
  /** Every call that looks a path up again, hooked (the race of review wave 3, #6). */
  const looked = <F extends (...a: never[]) => unknown>(name: string, f: F) =>
    ((file: PathLike, ...rest: unknown[]) => {
      hook.beforePath?.(name, String(file));
      return (f as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as unknown as F;
  const realpath = looked('realpath', m.realpath);
  const stat = looked('stat', m.stat);
  const lstat = looked('lstat', m.lstat);
  const mine = { open, realpath, stat, lstat };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

const { readText } = await import('../server/services/git');

const homes: string[] = [];
afterEach(() => {
  hook.beforeOpen = undefined;
  hook.beforePath = undefined;
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function folders() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'sable-git-race-')));
  homes.push(home);
  const root = path.join(home, 'chat');
  mkdirSync(path.join(root, 'dir'), { recursive: true });
  writeFileSync(path.join(root, 'dir', 'a.txt'), 'inside the chat');
  const outside = path.join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'a.txt'), 'outside secret');
  return { root, outside };
}

describe('the untracked-diff reader', () => {
  it('reads a file that lies in the chat folder', async () => {
    const { root } = folders();
    expect((await readText(path.join(root, 'dir', 'a.txt'), 1000, root))?.text).toBe('inside the chat');
  });

  it('never reads outside when a folder on the way becomes a junction between the check and the open', async () => {
    const { root, outside } = folders();
    let swapped = false;
    hook.beforeOpen = (file) => {
      if (swapped || !file.endsWith('a.txt')) return;
      swapped = true;
      // The checked path's folder is moved away and a junction to the outside takes its place.
      renameSync(path.join(root, 'dir'), path.join(root, 'dir-old'));
      symlinkSync(outside, path.join(root, 'dir'), 'junction');
    };
    const got = await readText(path.join(root, 'dir', 'a.txt'), 1000, root);
    expect(swapped).toBe(true);
    expect(got?.text).not.toBe('outside secret');
    expect(got).toBeNull();
  });

  it('never reads outside when the folder flips back for the check after the open and to the junction again for the next look (#6)', async () => {
    const { root, outside } = folders();
    const dir = path.join(root, 'dir');
    const real = path.join(root, 'dir-real');
    renameSync(dir, real);
    // The folder on the way is a junction to the outside at the open, then the real folder, then the junction again, and so on at every look after it.
    let junction = false;
    const flip = (to: boolean) => {
      if (to === junction) return;
      if (to) {
        renameSync(dir, real);
        symlinkSync(outside, dir, 'junction');
      } else {
        unlinkSync(dir);
        renameSync(real, dir);
      }
      junction = to;
    };
    renameSync(real, dir);
    let opened = false;
    let looks = 0;
    hook.beforeOpen = (file) => {
      if (!file.endsWith('a.txt')) return;
      flip(true);
      opened = true;
    };
    hook.beforePath = () => {
      if (!opened) return;
      flip(looks++ % 2 === 1);
    };
    const got = await readText(path.join(root, 'dir', 'a.txt'), 1000, root);
    expect(opened).toBe(true);
    expect(looks).toBeGreaterThan(0);
    expect(got?.text).not.toBe('outside secret');
    expect(got).toBeNull();
  });

  it('never reads a file elsewhere through a hard link in the chat folder', async () => {
    const { root, outside } = folders();
    linkSync(path.join(outside, 'a.txt'), path.join(root, 'notes.txt'));
    expect(await readText(path.join(root, 'notes.txt'), 1000, root)).toBeNull();
  });

  it('never reads through a link below the folder, even one that stays in it (review wave 6, #1: a file is read as named)', async () => {
    const { root } = folders();
    symlinkSync(path.join(root, 'dir'), path.join(root, 'alias'), 'junction');
    expect(await readText(path.join(root, 'alias', 'a.txt'), 1000, root)).toBeNull();
    expect((await readText(path.join(root, 'dir', 'a.txt'), 1000, root))?.text).toBe('inside the chat');
  });
});
