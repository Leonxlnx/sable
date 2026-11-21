/**
 * Containment is established against the opened handle or not at all (review wave 4, #7), in one
 * module (server/core/contain.ts) used by the share capture (core/handed.ts) and the untracked-file
 * reader of a chat's changes (services/git.ts `readText` with `within`):
 * - a folder on the way that looks plain to one lookup and leads out through a junction to the next
 *   (the folder flipped between lookups), or the chat folder itself flipped, is never taken for the
 *   chat's folder: the folders' times differ between the looks before and after the open;
 * - a hard link to a file elsewhere is not in the folder (a share of one gets the outside policy);
 * - what cannot be established is not inside (fail closed); a write in a folder on the way during a
 *   check is tried once more.
 * `node:fs` and `node:fs/promises` are wrapped so a test can change the folders between lookups.
 * Fakes only: no agent process starts.
 */
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, ToolItem } from '@shared/protocol';

const hook: { look?: (fn: string, file: string) => void } = {};
const looks: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs')>();
  const looked = <F>(name: string, f: F) => {
    const w = ((file: PathLike, ...rest: unknown[]) => {
      looks.push(`${name} ${String(file)}`);
      hook.look?.(name, String(file));
      return (f as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as unknown as F;
    return Object.assign(w as object, f as object) as F;
  };
  const mine = { lstatSync: looked('lstat', m.lstatSync), statSync: looked('stat', m.statSync), realpathSync: looked('realpath', m.realpathSync), openSync: looked('open', m.openSync) };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>();
  const looked = <F>(name: string, f: F) =>
    ((file: PathLike, ...rest: unknown[]) => {
      looks.push(`${name} ${String(file)}`);
      hook.look?.(name, String(file));
      return (f as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as unknown as F;
  const mine = { lstat: looked('lstat', m.lstat), stat: looked('stat', m.stat), realpath: looked('realpath', m.realpath), open: looked('open', m.open) };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

const fs = await import('node:fs');
const { readText } = await import('../server/services/git');
const { SessionRuntime } = await import('../server/core/runtime');
const { CONTAIN, openContained, openContainedSync } = await import('../server/core/contain');

/** What this platform establishes by default: Linux by the handle's own path, elsewhere the two walks ('walk': not a proof, see core/contain.ts). */
const DEFAULT = CONTAIN.how;
// The walks' own tests (the races of waves 3 and 4) run with the walks where no handle names its
// file; the default there is tested on its own ('by default').
beforeEach(() => {
  CONTAIN.how = DEFAULT === 'none' ? 'walk' : DEFAULT;
});

const homes: string[] = [];
afterEach(() => {
  CONTAIN.how = DEFAULT;
  hook.look = undefined;
  looks.length = 0;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const under = (p: string, dir: string) => norm(p).startsWith(norm(dir) + path.sep);

/** A chat folder with `dir/a.txt`, and the same names outside it holding a secret. */
function folders() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sable-contain-')));
  homes.push(home);
  const root = path.join(home, 'chat');
  fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'inside the chat');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'a.txt'), 'outside secret');
  fs.writeFileSync(path.join(outside, 'dir', 'a.txt'), 'outside secret');
  return { home, root, outside, file: path.join(root, 'dir', 'a.txt') };
}

/** Swaps `dir` for a junction to `to` and back (the real folder waits beside it). */
function flipper(dir: string, to: string) {
  const aside = `${dir}-real`;
  let junction = false;
  return {
    set(on: boolean) {
      if (on === junction) return;
      if (on) {
        fs.renameSync(dir, aside);
        fs.symlinkSync(to, dir, 'junction');
      } else {
        fs.unlinkSync(dir);
        fs.renameSync(aside, dir);
      }
      junction = on;
    },
    get junction() {
      return junction;
    },
  };
}

/**
 * The race of the review: `dir` looks like a plain folder whenever it is looked up itself, and leads
 * out through a junction whenever something in it is looked up or opened; resolving the whole path
 * (realpath) sees the plain folder. Every lookup that does not name the folder or what is in it sees
 * whatever the last one left.
 */
function race(dir: string, to: string, after?: () => void) {
  const f = flipper(dir, to);
  hook.look = (fn, p) => {
    if (fn === 'realpath') f.set(false);
    else if (norm(p) === norm(dir)) f.set(false);
    else if (under(p, dir)) f.set(true);
    else return;
    after?.();
  };
  return f;
}

function session(cwd: string) {
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd, title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const add = (id: string, files: string[]) =>
    rt.add<ToolItem>({ id, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'Shared', status: 'running', detail: { files: files.map((p) => ({ path: p, name: path.basename(p) })) } });
  const share = (id: string, files: string[]) => {
    add(id, files);
    rt.patch<ToolItem>(id, { status: 'done' });
    return rt.get<ToolItem>(id)!.handed!;
  };
  /** The person allows the share themselves (they are shown its files), then it goes through. */
  const allowed = async (id: string, files: string[]) => {
    add(id, files);
    const detail = { files: files.map((p) => ({ path: p, name: path.basename(p) })) };
    const asked = rt.requestPermission({ itemId: id, toolName: 'SendUserFile', kind: 'share', title: 'Share', detail, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' }, { id: 'deny', label: 'Deny', tone: 'deny' }] });
    rt.answerPermission(rt.prompts().permissions[0].id, { optionId: 'allow' }, { person: true });
    await asked;
    rt.patch<ToolItem>(id, { status: 'done' });
    return rt.get<ToolItem>(id)!.handed!;
  };
  return { rt, share, allowed };
}

describe('the untracked-diff reader (readText within the chat folder)', () => {
  it('never reads outside when the folder on the way looks plain to its own lookup and leads out to the next (#7)', async () => {
    const { root, file } = folders();
    const f = race(path.join(root, 'dir'), path.join(path.dirname(root), 'outside'));
    const got = await readText(file, 1000, root);
    f.set(false);
    expect(got?.text).not.toBe('outside secret');
    expect(got).toBeNull();
  });

  it('never reads outside when the chat folder itself is flipped for a junction between lookups', async () => {
    const { root, outside, file } = folders();
    race(root, outside);
    const got = await readText(file, 1000, root);
    expect(got?.text).not.toBe('outside secret');
    expect(got).toBeNull();
  });

  it('still reads a file that plainly lies in the folder', async () => {
    const { root, file } = folders();
    expect((await readText(file, 1000, root))?.text).toBe('inside the chat');
  });
});

describe('what a share hands over counts as in the chat folder only when that is established', () => {
  it('a folder on the way flipped between lookups: not inside (#7)', () => {
    const { root, outside } = folders();
    const { share } = session(root);
    const f = race(path.join(root, 'dir'), path.join(outside));
    const handed = share('s1', ['dir/a.txt']);
    hook.look = undefined;
    f.set(false);
    expect(handed[0]).toMatchObject({ inside: false });
    expect(handed[0]?.granted).toBeUndefined();
  });

  it('the chat folder itself flipped between lookups: not inside', () => {
    const { root, outside } = folders();
    const { share } = session(root);
    race(root, outside);
    const handed = share('s1', ['dir/a.txt']);
    hook.look = undefined;
    expect(handed[0]?.inside).not.toBe(true);
  });

  it('a hard link in the folder to a file elsewhere: not inside; granted only when the person allowed that share', async () => {
    const { root, outside } = folders();
    fs.linkSync(path.join(outside, 'a.txt'), path.join(root, 'notes.txt'));
    const { share, allowed } = session(root);
    const byMode = share('s1', ['notes.txt']);
    expect(byMode[0]).toMatchObject({ inside: false });
    expect(byMode[0]?.granted).toBeUndefined();
    const byPerson = await allowed('s2', ['notes.txt']);
    expect(byPerson[0]).toMatchObject({ inside: false, granted: true });
  });

  it('a file that plainly lies in the folder is inside', () => {
    const { root } = folders();
    const { share } = session(root);
    expect(share('s1', ['dir/a.txt'])[0]).toMatchObject({ inside: true });
  });
});

describe('siblings of the chat folder coming and going', () => {
  it('never make a share or the untracked-diff reader take a file in the folder for outside', async () => {
    const { home, root, file } = folders();
    // Another thread makes and removes folders beside the chat folder as fast as it can, all along
    // (a new chat under the chats folder, a build in the projects folder, other tests in the temp folder).
    const stop = new Int32Array(new SharedArrayBuffer(4));
    const made = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `const { workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const { dir, stop, made } = workerData;
      for (let i = 0; Atomics.load(stop, 0) === 0; i++) {
        const p = path.join(dir, 'sibling-' + (i % 4));
        try {
          fs.mkdirSync(p);
          fs.writeFileSync(path.join(p, 'x'), 'x');
          fs.rmSync(p, { recursive: true });
          Atomics.add(made, 0, 1);
        } catch {}
      }`,
      { eval: true, workerData: { dir: home, stop, made } },
    );
    try {
      await vi.waitFor(() => expect(Atomics.load(made, 0)).toBeGreaterThan(50));
      const { share } = session(root);
      const parent = fs.lstatSync(home, { bigint: true }).ctimeNs;
      const at = Atomics.load(made, 0);
      for (let i = 0; i < 8; i++) {
        expect(share(`s${i}`, ['dir/a.txt'])[0], `share ${i}`).toMatchObject({ inside: true });
        expect((await readText(file, 1000, root))?.text, `read ${i}`).toBe('inside the chat');
        const a = openContainedSync(file, root);
        fs.closeSync(a.fd);
        expect(a.inside, `sync ${i}`).toBe(true);
      }
      // The folders beside it really came and went meanwhile.
      expect(Atomics.load(made, 0)).toBeGreaterThan(at);
      expect(fs.lstatSync(home, { bigint: true }).ctimeNs).not.toBe(parent);
    } finally {
      Atomics.store(stop, 0, 1);
      await worker.terminate();
    }
  });
});

describe('by default (review wave 5, #7)', () => {
  beforeEach(() => {
    CONTAIN.how = DEFAULT;
  });

  it("is the handle's own path on Linux, and the walks elsewhere", () => {
    expect(DEFAULT).toBe(process.platform === 'linux' ? 'proc' : 'walk');
  });

  it("a plain file in the folder is inside by default; with 'none' it is external, and a share of it reaches a phone only when the person allowed it", async () => {
    for (const how of [DEFAULT, 'none'] as const) {
      CONTAIN.how = how;
      const { root, file } = folders();
      const proven = how !== 'none';
      const a = openContainedSync(file, root);
      fs.closeSync(a.fd);
      expect(a.inside).toBe(proven);
      const b = await openContained(file, root);
      await b.fh.close();
      expect(b.inside).toBe(proven);
      expect((await readText(file, 1000, root))?.text).toBe(proven ? 'inside the chat' : undefined);
      const { share, allowed } = session(root);
      expect(share('s1', ['dir/a.txt'])[0]).toMatchObject({ inside: proven });
      expect(share('s1b', ['dir/a.txt'])[0]?.granted).toBeUndefined();
      expect(await allowed('s2', ['dir/a.txt'])).toMatchObject([proven ? { inside: true } : { inside: false, granted: true }]);
    }
  });
});

describe('a folder above the chat folder flipped between lookups (review wave 5, #7)', () => {
  // The walks check the folders above the chat's folder for links and ids only: this race is their
  // known gap (core/contain.ts, "What remains"). It holds by the handle's own path and with 'none'.
  beforeEach(() => {
    CONTAIN.how = DEFAULT === 'walk' ? 'none' : DEFAULT;
  });

  /** `home/proj/chat` is the chat's folder; `home/evil/chat` has the same names and a secret. */
  function above() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'sable-contain-up-')));
    homes.push(home);
    const proj = path.join(home, 'proj');
    const root = path.join(proj, 'chat');
    fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'inside the chat');
    const evil = path.join(home, 'evil');
    fs.mkdirSync(path.join(evil, 'chat', 'dir'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'chat', 'dir', 'a.txt'), 'outside secret');
    // `proj` looks plain to its own lookup and leads to `evil` for everything under it; resolving the whole path sees it plain.
    const f = flipper(proj, evil);
    const arm = () =>
      (hook.look = (fn, p) => {
        if (fn === 'realpath' || norm(p) === norm(proj) || !under(p, proj)) f.set(false);
        else f.set(true);
      });
    return { root, file: path.join(root, 'dir', 'a.txt'), f, arm };
  }

  it('the outside file is never taken for one in the chat folder, by the untracked-diff reader or a share', async () => {
    const { root, file, f, arm } = above();
    arm();
    const got = await readText(file, 1000, root);
    hook.look = undefined;
    f.set(false);
    expect(got?.text).not.toBe('outside secret');
    expect(got).toBeNull();
    arm();
    const sync = openContainedSync(file, root);
    hook.look = undefined;
    f.set(false);
    const read = Buffer.alloc(64);
    const n = fs.readSync(sync.fd, read, 0, 64, 0);
    fs.closeSync(sync.fd);
    expect(sync.inside && read.toString('utf8', 0, n) === 'outside secret').toBe(false);
    expect(sync.inside).toBe(false);
  });
});

describe('core/contain.ts', () => {
  it('a plain file in the folder is inside, sync and async; the handle is the file', async () => {
    const { root, file } = folders();
    const a = openContainedSync(file, root);
    try {
      expect(a.inside).toBe(true);
      expect(a.st.ino).toBe(fs.statSync(file, { bigint: true }).ino);
    } finally {
      fs.closeSync(a.fd);
    }
    const b = await openContained(file, root);
    try {
      expect(b.inside).toBe(true);
      expect((await b.fh.stat({ bigint: true })).ino).toBe(fs.statSync(file, { bigint: true }).ino);
    } finally {
      await b.fh.close();
    }
  });

  it('a file outside the folder by its path is opened, not inside, with no folder looked at', () => {
    const { root, outside } = folders();
    const f = path.join(outside, 'a.txt');
    const got = openContainedSync(f, root);
    fs.closeSync(got.fd);
    expect(got.inside).toBe(false);
    expect(looks.filter((l) => l.startsWith('lstat'))).toEqual([]);
    const none = openContainedSync(f, undefined);
    fs.closeSync(none.fd);
    expect(none.inside).toBe(false);
  });

  it('a junction on the way is not inside', async () => {
    const { root } = folders();
    fs.symlinkSync(path.join(root, 'dir'), path.join(root, 'alias'), 'junction');
    const via = path.join(root, 'alias', 'a.txt');
    const got = openContainedSync(via, root);
    fs.closeSync(got.fd);
    expect(got.inside).toBe(false);
    const a = await openContained(via, root);
    await a.fh.close();
    expect(a.inside).toBe(false);
  });

  it('a write in a folder on the way during the check: looked at once more, then inside', async () => {
    const { root, file } = folders();
    let opens = 0;
    let made = 0;
    // A new file in the chat folder at the first open of each check (a new entry moves the folder's times).
    hook.look = (fn, p) => {
      if (fn === 'open' && norm(p) === norm(file) && opens++ === 0) fs.writeFileSync(path.join(root, `new${made++}.txt`), 'x');
    };
    const got = openContainedSync(file, root);
    fs.closeSync(got.fd);
    expect(opens).toBe(2);
    expect(got.inside).toBe(true);
    opens = 0;
    const a = await openContained(file, root);
    await a.fh.close();
    expect(opens).toBe(2);
    expect(a.inside).toBe(true);
  });

  it('a folder that keeps changing during every check: not inside (fail closed)', async () => {
    const { root, file } = folders();
    let n = 0;
    hook.look = (fn, p) => {
      if (fn === 'open' && norm(p) === norm(file)) fs.writeFileSync(path.join(root, `new${n++}.txt`), 'x');
    };
    const got = openContainedSync(file, root);
    fs.closeSync(got.fd);
    expect(got.inside).toBe(false);
    const a = await openContained(file, root);
    await a.fh.close();
    expect(a.inside).toBe(false);
  });

  it('a flipped folder whose time is put back is still caught by its change time', () => {
    const { root, outside, file } = folders();
    // A whole second, so it is put back exactly.
    const T = 1_700_000_000;
    fs.utimesSync(root, T, T);
    race(path.join(root, 'dir'), outside, () => fs.utimesSync(root, T, T));
    const got = openContainedSync(file, root);
    hook.look = undefined;
    fs.closeSync(got.fd);
    expect(fs.statSync(root, { bigint: true }).mtimeNs).toBe(BigInt(T) * 1_000_000_000n);
    expect(got.inside).toBe(false);
  });

  it('a folder changed a moment ago is looked at once it has settled (its times move by clock ticks)', async () => {
    expect(CONTAIN.settleMs).toBeGreaterThanOrEqual(16);
    const { root } = folders();
    const f = path.join(root, 'dir', 'fresh.txt');
    fs.writeFileSync(f, 'just written');
    let t = Date.now();
    const got = openContainedSync(f, root);
    const took = Date.now() - t;
    fs.closeSync(got.fd);
    expect(got.inside).toBe(true);
    expect(took).toBeGreaterThanOrEqual(CONTAIN.settleMs - 10);
    fs.writeFileSync(path.join(root, 'dir', 'fresh2.txt'), 'x');
    t = Date.now();
    const a = await openContained(path.join(root, 'dir', 'fresh2.txt'), root);
    const tookAsync = Date.now() - t;
    await a.fh.close();
    expect(a.inside).toBe(true);
    expect(tookAsync).toBeGreaterThanOrEqual(CONTAIN.settleMs - 10);
  });

  it.runIf(process.platform === 'linux')("on Linux, by the handle's own path", async () => {
    const { root, outside, file } = folders();
    expect(CONTAIN.how).toBe('proc');
    const a = openContainedSync(file, root);
    fs.closeSync(a.fd);
    expect(a.inside).toBe(true);
    fs.symlinkSync(outside, path.join(root, 'out'));
    const b = await openContained(path.join(root, 'out', 'a.txt'), root);
    await b.fh.close();
    expect(b.inside).toBe(false);
  });
});
