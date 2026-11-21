/**
 * The untracked-file reader for a chat's changes (server/services/git.ts `readText` with `within`):
 * the file the opened handle refers to must lie in the chat's folder. A folder on the way that
 * becomes a junction (or a link) to somewhere else between the containment check and the open is
 * caught after the open, so what lies outside is never read. `open` is wrapped to make the swap at
 * exactly that moment.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hook: { beforeOpen?: (file: string) => void } = {};

vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (file: PathLike, ...rest: unknown[]) => {
    hook.beforeOpen?.(String(file));
    return (m.open as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
  }) as typeof m.open;
  return { ...m, open, default: { ...m, open } };
});

const { readText } = await import('../server/services/git');

const homes: string[] = [];
afterEach(() => {
  hook.beforeOpen = undefined;
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
});
