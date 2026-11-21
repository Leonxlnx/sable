/**
 * The server's boundary after review wave 6 (scratch/reviews/out-wave6.md):
 * - #1: a tracked link in a phone's diff is withheld (a link is never read through: its target, even
 *   one in the chat folder, is not what the list named), and a submodule keeps git's own lines only
 *   by git's mode for the entry (160000), never because a file's lines read like one.
 * - #2: the chat's folder is the one it was when it became the chat's: swapped for a junction to
 *   another repository (or for another folder), nothing of it is listed, diffed or counted as inside
 *   a share.
 * - #3: a caller removed while its request waits (a phone) sends nothing: not at Codex's own
 *   dispatch after its thread loads, not after an account switch, and no option is set.
 * - #4: a Codex move with no change to its lines keeps both ends, in its diff and in the approval's
 *   scope (from Codex's own records).
 * - #5: what Claude's "always" saves shows per suggestion (what it does, its behaviour, where it is
 *   kept); where the phone cannot show all of it, "always" is the desktop's alone.
 * - #15: a phone's record of a request is its own bounded copy (no raw scope, nothing else passed on).
 * - #17: a new download start never closes a transfer in use: it is refused for now.
 * - #21: only a plain file is ever opened by the checked reader (a pipe is refused by its lookup, and
 *   the open never waits).
 * - #24: a queue edit's pictures: each id once, and the kept ones count against the total too.
 * `node:fs` and `node:fs/promises` pass through, but can show a file as a pipe (a name ending in
 * `.fifo`) and record every open. Temp folders, git, fakes and the Demo agent only: no real agent.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, PermissionRequest, PermissionScope, QuestionRequest, SessionSnapshot } from '@shared/protocol';

const opens: { p: string; flags: unknown }[] = [];
const asPipe = (p: string) => p.endsWith('.fifo');
/** A reading of a file shown as a pipe (the file itself is plain, on Windows there are none to make). */
const piped = <S extends { isFile(): boolean }>(s: S): S => Object.assign(s, { isFile: () => false, isFIFO: () => true });

vi.mock('node:fs', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs')>();
  const look = <F>(f: F) => {
    const w = ((file: PathLike, ...rest: unknown[]) => {
      const s = (f as unknown as (...a: unknown[]) => { isFile(): boolean })(file, ...rest);
      return asPipe(String(file)) ? piped(s) : s;
    }) as unknown as F;
    return Object.assign(w as object, f as object) as F;
  };
  const openSync = Object.assign((file: PathLike, flags?: unknown, ...rest: unknown[]) => {
    opens.push({ p: String(file), flags });
    return (m.openSync as (...a: unknown[]) => number)(file, flags, ...rest);
  }, m.openSync) as typeof m.openSync;
  const mine = { statSync: look(m.statSync), lstatSync: look(m.lstatSync), openSync };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>();
  const look = <F>(f: F) =>
    (async (file: PathLike, ...rest: unknown[]) => {
      const s = await (f as unknown as (...a: unknown[]) => Promise<{ isFile(): boolean }>)(file, ...rest);
      return asPipe(String(file)) ? piped(s) : s;
    }) as unknown as F;
  const open = (async (file: PathLike, flags?: unknown, ...rest: unknown[]) => {
    opens.push({ p: String(file), flags });
    return (m.open as (...a: unknown[]) => Promise<unknown>)(file, flags, ...rest);
  }) as typeof m.open;
  const mine = { stat: look(m.stat), lstat: look(m.lstat), open };
  return { ...m, ...mine, default: { ...m, ...mine } };
});

const fs = await import('node:fs');
const { CONTAIN, NotAFile, folderNow, folderNowSync, openContained, openContainedSync, pinFolder } = await import('../server/core/contain');
const { FOLDER_CHANGED, gitDiff, gitStatus, patchParts, readText } = await import('../server/services/git');
const { approvedShare, handOver } = await import('../server/core/handed');
const { PhoneChangesReader } = await import('../server/services/phone-changes');
const { FILE_ACTIVE_MS, FILE_CHUNK, FILE_MAX_TRANSFERS, PhoneFiles } = await import('../server/services/phone-files');
const { PHONE_ATTACH, phoneAttachments } = await import('../server/services/phone-guard');
const { PHONE_BYTES, phoneAllowed, phonePermission, phoneQuestion, promptsPage } = await import('../server/services/phone');
const { changeScope, changesToDiffs } = await import('../server/providers/codex-map');
const { alwaysScope } = await import('../server/providers/claude');
const { compactScope, withScope } = await import('../server/core/permission-scope');
const { App, CallerGone } = await import('../server/app');
const { CodexProvider } = await import('../server/providers/codex');
const { DemoProvider } = await import('../server/providers/demo');

const homes: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
const DEFAULT_HOW = CONTAIN.how;
afterEach(async () => {
  CONTAIN.how = DEFAULT_HOW;
  opens.length = 0;
  while (cleanups.length) await cleanups.pop()!();
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const temp = (tag: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `sable-w6-${tag}-`)));
  homes.push(d);
  return d;
};
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** A repository at `dir` with `files` committed. */
function repo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.symlinks', 'true');
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}
/** The phone's changes reader for one chat in `cwd`. */
const readerFor = (cwd: string) => new PhoneChangesReader(async () => ({ session: { cwd }, items: [] }) as unknown as SessionSnapshot);

/** Whether this user can make file links here (Windows needs developer mode). */
const canLink = (() => {
  const d = fs.mkdtempSync(path.join(tmpdir(), 'sable-w6-link-'));
  try {
    fs.writeFileSync(path.join(d, 't'), 'x');
    fs.symlinkSync(path.join(d, 't'), path.join(d, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

// ── #21 ──

describe('#21: only a plain file is opened, and an open never waits', () => {
  /** A chat folder with a plain file and one that shows as a pipe. */
  function chat() {
    const root = path.join(temp('fifo'), 'chat');
    fs.mkdirSync(path.join(root, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'plain');
    fs.writeFileSync(path.join(root, 'dir', 'p.fifo'), 'a pipe would block here');
    return { root, plain: path.join(root, 'dir', 'a.txt'), pipe: path.join(root, 'dir', 'p.fifo') };
  }
  const opened = (p: string) => opens.filter((o) => path.resolve(o.p).toLowerCase() === path.resolve(p).toLowerCase()).length;

  for (const how of ['walk', 'none', 'proc'] as const) {
    it(`a pipe at the leaf is refused before any open ('${how}')`, async () => {
      CONTAIN.how = how;
      const { root, pipe } = chat();
      expect(() => openContainedSync(pipe, root)).toThrow(NotAFile);
      await expect(openContained(pipe, root)).rejects.toThrow(NotAFile);
      expect(() => openContainedSync(pipe, undefined)).toThrow(NotAFile);
      expect(opened(pipe)).toBe(0);
    });
  }

  it('the diff reader, a share and the permission a share shows never open it', async () => {
    const { root, pipe } = chat();
    expect(await readText(pipe, 1000, root)).toBeNull();
    const { handed } = handOver(root, [{ path: 'dir/p.fifo', name: 'p.fifo' }]);
    expect(handed).toEqual([null]);
    expect(approvedShare(root, [{ path: 'dir/p.fifo', name: 'p.fifo' }]).files).toEqual([null]);
    expect(opened(pipe)).toBe(0);
  });

  it('a folder at the leaf is refused before the open too; a plain file opens read-only without waiting', async () => {
    const { root, plain } = chat();
    expect(() => openContainedSync(path.join(root, 'dir'), root)).toThrow(NotAFile);
    expect(opened(path.join(root, 'dir'))).toBe(0);
    const got = openContainedSync(plain, root);
    fs.closeSync(got.fd);
    expect(got.inside).toBe(true);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
    expect(opens.filter((o) => o.p === plain).map((o) => o.flags)).toEqual([flags]);
  });
});

// ── #1 ──

describe("#1: a link's target is never what a phone's diff shows; a submodule only by git's mode", () => {
  it.runIf(canLink)('a tracked link retargeted to an unchanged private file in the folder: withheld, the private text never goes', async () => {
    const cwd = path.join(temp('link'), 'chat');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, '.env'), 'API_KEY=hunter2\n');
    fs.writeFileSync(path.join(cwd, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(cwd, 'docs.txt'), 'public notes\n');
    fs.symlinkSync('docs.txt', path.join(cwd, 'link'), 'file');
    repo(cwd, {});
    expect(git(cwd, 'ls-files', '-s', 'link')).toMatch(/^120000 /);
    fs.unlinkSync(path.join(cwd, 'link'));
    fs.symlinkSync('.env', path.join(cwd, 'link'), 'file');
    const reader = readerFor(cwd);
    const list = await reader.changes('s1');
    expect(list.files.map((f) => f.path)).toEqual(['link']);
    await expect(reader.diff('s1', 'link')).rejects.toThrow(/is a link/);
    const raw = await gitDiff(cwd, 'link', false, { within: true });
    expect(raw).toMatchObject([{ path: 'link', withheld: 'link', hunks: [] }]);
    expect(JSON.stringify([list, raw])).not.toContain('hunter2');
  });

  it.runIf(canLink)('an untracked link: listed, never read through', async () => {
    const cwd = path.join(temp('link2'), 'chat');
    repo(cwd, { 'a.txt': 'one\n' });
    fs.writeFileSync(path.join(cwd, 'private.txt'), 'private words\n');
    git(cwd, 'add', 'private.txt');
    git(cwd, 'commit', '-q', '-m', 'private');
    fs.symlinkSync('private.txt', path.join(cwd, 'alias.txt'), 'file');
    const raw = await gitDiff(cwd, undefined, false, { within: true });
    expect(raw).toEqual([expect.objectContaining({ path: 'alias.txt', withheld: 'link' })]);
    const st = await gitStatus(cwd, { within: true });
    expect(st.files.find((f) => f.path === 'alias.txt')?.additions).toBe(0);
    expect(JSON.stringify(raw)).not.toContain('private words');
  });

  it("a plain file whose lines read like a submodule's, hard-linked to a file outside: withheld (git's mode is a file's)", async () => {
    const home = temp('subproj');
    const cwd = path.join(home, 'chat');
    repo(cwd, { 'pin.txt': `Subproject commit ${'1'.repeat(40)}\n` });
    fs.writeFileSync(path.join(home, 'outside.txt'), `Subproject commit ${'cafebabe'.repeat(5)}\n`);
    fs.unlinkSync(path.join(cwd, 'pin.txt'));
    fs.linkSync(path.join(home, 'outside.txt'), path.join(cwd, 'pin.txt'));
    const raw = await gitDiff(cwd, 'pin.txt', false, { within: true });
    expect(raw).toMatchObject([{ path: 'pin.txt', withheld: 'outside', hunks: [] }]);
    await expect(readerFor(cwd).diff('s1', 'pin.txt')).rejects.toThrow(/only on the computer/);
    expect(JSON.stringify(raw)).not.toContain('cafebabe');
  });

  it("a real submodule keeps git's own lines (its commits)", async () => {
    const cwd = path.join(temp('gitlink'), 'chat');
    repo(cwd, { 'a.txt': 'a\n' });
    const sub = path.join(cwd, 'sub');
    repo(sub, { f: '1\n' });
    fs.writeFileSync(path.join(sub, 'f'), '2\n');
    git(sub, 'commit', '-q', '-am', 'two');
    const first = git(sub, 'rev-parse', 'HEAD~1').trim();
    const second = git(sub, 'rev-parse', 'HEAD').trim();
    git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${first},sub`);
    git(cwd, 'commit', '-q', '-m', 'sub');
    const d = await readerFor(cwd).diff('s1', 'sub');
    expect(d.diff?.hunks.flatMap((h) => h.lines)).toEqual([`-Subproject commit ${first}`, `+Subproject commit ${second}`]);
  });

  it("git's patch is cut per file with the modes its header gives", () => {
    const parts = patchParts(
      [
        'diff --git a/sub b/sub',
        'index 1111111..2222222 160000',
        '--- a/sub',
        '+++ b/sub',
        '@@ -1 +1 @@',
        '-Subproject commit 1111111111111111111111111111111111111111',
        '+Subproject commit 2222222222222222222222222222222222222222',
        'diff --git a/x b/x',
        'old mode 100644',
        'new mode 120000',
        'index 3333333..4444444',
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-diff --git a/y b/y',
        '+old mode 160000',
        'diff --git a/n b/n',
        'new file mode 100644',
        'index 0000000..5555555',
      ].join('\n'),
    );
    expect(parts.map((p) => p.modes)).toEqual([{ was: '160000', now: '160000' }, { was: '100644', now: '120000' }, { now: '100644' }]);
  });
});

// ── #2 ──

describe("#2: the chat's folder is the one it was when it became the chat's", () => {
  /** `home/chat` (the chat's repository) and `home/other` (another one, with a secret in the same name). */
  function two() {
    const home = temp('swap');
    const chat = path.join(home, 'chat');
    const other = path.join(home, 'other');
    repo(chat, { 'a.txt': 'one\n' });
    fs.writeFileSync(path.join(chat, 'a.txt'), 'one\ntwo\n');
    repo(other, { 'a.txt': 'old\n', 'secret.txt': 'old\n' });
    fs.writeFileSync(path.join(other, 'a.txt'), 'TOP SECRET a\n');
    fs.writeFileSync(path.join(other, 'secret.txt'), 'TOP SECRET\n');
    const aside = `${chat}-real`;
    return {
      chat,
      other,
      swap() {
        fs.renameSync(chat, aside);
        fs.symlinkSync(other, chat, 'junction');
      },
      back() {
        fs.unlinkSync(chat);
        fs.renameSync(aside, chat);
      },
    };
  }

  it('swapped for a junction to another repository: nothing of it is listed, diffed or inside a share; back again, it is the chat\'s again', async () => {
    const t = two();
    expect(await pinFolder(t.chat)).toBe(true);
    const before = await readerFor(t.chat).changes('s1');
    expect(before.files.map((f) => f.path)).toEqual(['a.txt']);
    t.swap();
    try {
      expect(await folderNow(t.chat)).toBe('changed');
      expect(folderNowSync(t.chat)).toBe('changed');
      const reader = readerFor(t.chat);
      const seen: unknown[] = [];
      await expect(reader.changes('s1').then((r) => seen.push(r))).rejects.toThrow(FOLDER_CHANGED);
      await expect(reader.diff('s1', 'a.txt').then((r) => seen.push(r))).rejects.toThrow(FOLDER_CHANGED);
      await expect(gitStatus(t.chat, { within: true })).rejects.toThrow(FOLDER_CHANGED);
      await expect(gitDiff(t.chat, 'secret.txt', false, { within: true })).rejects.toThrow(FOLDER_CHANGED);
      const { handed } = handOver(t.chat, [{ path: 'secret.txt', name: 'secret.txt' }]);
      expect(handed[0]?.inside).toBe(false);
      expect(JSON.stringify(seen)).not.toContain('TOP SECRET');
    } finally {
      t.back();
    }
    const again = await readerFor(t.chat).diff('s1', 'a.txt');
    expect(again.diff?.hunks.flatMap((h) => h.lines)).toContain('+two');
    expect(handOver(t.chat, [{ path: 'a.txt', name: 'a.txt' }]).handed[0]?.inside).toBe(true);
  });

  it('swapped for another folder at the same place: not the chat\'s; a folder never pinned is pinned when first used', async () => {
    const t = two();
    expect(typeof (await folderNow(t.chat))).toBe('object');
    fs.renameSync(t.chat, `${t.chat}-old`);
    fs.mkdirSync(t.chat);
    try {
      expect(await folderNow(t.chat)).toBe('changed');
    } finally {
      fs.rmdirSync(t.chat);
      fs.renameSync(`${t.chat}-old`, t.chat);
    }
    expect(typeof (await folderNow(t.chat))).toBe('object');
    // A lane's worktree Sable has just made there is pinned anew (`fresh`).
    fs.renameSync(t.chat, `${t.chat}-old`);
    fs.mkdirSync(t.chat);
    expect(await pinFolder(t.chat, true)).toBe(true);
    expect(typeof (await folderNow(t.chat))).toBe('object');
    expect(await folderNow(path.join(t.chat, 'missing'))).toBe('gone');
  });

  it('a chat made in the bridge has its folder pinned as it was then', async () => {
    const t = two();
    const app = new App({ home: temp('pinapp'), quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    cleanups.push(() => app.dispose());
    await app.call('session.create', { provider: 'demo', cwd: t.chat });
    await tick(150);
    t.swap();
    try {
      // The swap came before anything asked: the folder pinned when the chat was made decides.
      expect(await folderNow(t.chat)).toBe('changed');
    } finally {
      t.back();
    }
  });
});

// ── #3 ──

/** A Codex chat in the bridge on a fake app-server (no process) whose thread reload a test can hold. */
async function codexFake(hold?: { resume?: () => Promise<void> }) {
  const home = temp('codex');
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const calls: string[] = [];
  let starts = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') {
        await hold?.resume?.();
        return { thread: { id: String(params.threadId), model: 'm' }, model: 'm' };
      }
      if (method === 'turn/start') return { turn: { id: `turn${++starts}` } };
      if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
      return {};
    },
  };
  let provider!: InstanceType<typeof CodexProvider>;
  const app = new App({
    home,
    quiet: true,
    providers: [
      (ctx) => {
        const p = new CodexProvider(ctx);
        const anyP = p as unknown as Record<string, unknown>;
        anyP.client = async () => rpc;
        anyP.version = async () => ({ installed: true, version: '1' });
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true, compact: true } });
        provider ??= p;
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'default', model: 'm' });
  const rt = app.runtime(snap.session.id);
  const notify = (method: string, p: Record<string, unknown>) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, { threadId: 'th1', ...p });
  const serverDied = () => (provider as unknown as { onExit(rpc: unknown, info: unknown): void }).onExit(rpc, { code: 1, signal: null, stderr: '' });
  const session = () => [...provider.sessions.values()][0] as unknown as { onRequest(method: string, p: unknown, id: number): Promise<unknown> };
  const count = (m: string) => calls.filter((c) => c === m).length;
  return { app, rt, cwd, notify, serverDied, session, count };
}

describe('#3: a caller removed while its request waits sends nothing and sets nothing', () => {
  it("Codex's turn/start never goes when the phone is removed while the thread reloads", async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait() });
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'first' });
    await until(() => h.count('turn/start') === 1);
    h.notify('turn/completed', { turn: { id: 'turn1', status: 'completed', items: [] } });
    await until(() => !h.rt.turnActive);
    h.serverDied();
    let ok = true;
    const sent = h.app.call('session.send', { sessionId: h.rt.id, text: 'from the phone' }, { allowed: () => ok });
    sent.catch(() => {});
    await until(() => h.count('thread/resume') === 1);
    ok = false;
    g.open();
    await expect(sent).rejects.toBeInstanceOf(CallerGone);
    await tick(50);
    expect(h.count('turn/start')).toBe(1);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.items.some((i) => i.type === 'user' && i.text === 'from the phone')).toBe(false);
    expect(h.rt.items.some((i) => i.type === 'notice' && /removed phone was not sent/.test(i.text))).toBe(true);
  });

  it('a send whose caller may still act goes as before', async () => {
    const h = await codexFake();
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'hello' }, { allowed: () => true });
    await until(() => h.count('turn/start') === 1);
  });

  it('options from a phone removed while the agent starts are never set', async () => {
    const home = temp('opts');
    const g = gate();
    let hold = false;
    let held = 0;
    const app = new App({
      home,
      quiet: true,
      providers: [
        (ctx) => {
          const p = new DemoProvider(ctx, { speed: 0 });
          const open = p.open.bind(p);
          p.open = async (rt, o) => {
            if (hold) {
              held++;
              await g.wait();
            }
            return open(rt, o);
          };
          return p;
        },
      ],
    });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(snap.session.id);
    await rt.handle?.close();
    rt.handle = undefined;
    hold = true;
    const was = !!rt.meta.options?.remoteControl;
    let ok = true;
    const set = app.call('session.setOptions', { sessionId: rt.id, options: { remoteControl: !was } }, { allowed: () => ok });
    set.catch(() => {});
    await until(() => held === 1);
    ok = false;
    g.open();
    await expect(set).rejects.toBeInstanceOf(CallerGone);
    expect(!!rt.meta.options?.remoteControl).toBe(was);
    // From the desktop (no guard) it is set at once, as before.
    await app.call('session.setOptions', { sessionId: rt.id, options: { remoteControl: !was } });
    expect(!!rt.meta.options?.remoteControl).toBe(!was);
  });

  it('an account switch for a removed caller moves nothing and copies no conversation', async () => {
    const home = temp('switch');
    const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
    cleanups.push(() => app.dispose());
    const { account } = await app.call('account.add', { provider: 'demo', label: 'Side' });
    const snap = await app.call('session.create', { provider: 'demo', cwd: home });
    const rt = app.runtime(snap.session.id);
    const from = rt.meta.accountId;
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: account.id, retry: true }, { allowed: () => false })).rejects.toBeInstanceOf(CallerGone);
    expect(rt.meta.accountId).toBe(from);
    // The desktop's own switch goes.
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: account.id });
    expect(rt.meta.accountId).toBe(account.id);
  });
});

// ── #4 ──

describe('#4: a Codex move with no change to its lines keeps both ends', () => {
  it('in its diff, and in the scope made from Codex\'s own records', () => {
    const changes = [{ path: '/w/src/a.ts', kind: { type: 'update' as const, move_path: '/etc/cron.d/a' }, diff: '' }];
    expect(changesToDiffs(changes)).toEqual([{ path: '/etc/cron.d/a', oldPath: '/w/src/a.ts', status: 'renamed', additions: 0, deletions: 0, hunks: [] }]);
    expect(changeScope({ changes: [{ path: '/w/src/a.ts', kind: 'update', to: '/etc/cron.d/a' }, { path: '/w/b.ts', kind: 'add' }] })).toEqual([{ path: '/etc/cron.d/a', from: '/w/src/a.ts' }, { path: '/w/b.ts' }]);
    expect(changeScope({ changes: [{ path: 5 }] })).toBeUndefined();
    expect(changeScope(undefined)).toBeUndefined();
  });

  it('an approval of such a move names where it goes; the phone shows both ends', async () => {
    const h = await codexFake();
    h.notify('item/started', { turnId: 'turn1', item: { type: 'fileChange', id: 'fc1', status: 'inProgress', changes: [{ path: '/w/src/a.ts', kind: { type: 'update', move_path: '/etc/cron.d/a' }, diff: '' }] } });
    await until(() => !!h.rt.get('turn1:fc1'));
    void h.session().onRequest('item/fileChange/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'fc1', reason: null, grantRoot: null }, 21);
    await until(() => h.rt.prompts().permissions.length > 0);
    const req = h.rt.prompts().permissions[0];
    h.rt.cancelPrompts();
    expect(req.scope?.files).toEqual([{ path: '/etc/cron.d/a', from: '/w/src/a.ts' }]);
    expect(req.diff).toEqual([expect.objectContaining({ path: '/etc/cron.d/a', oldPath: '/w/src/a.ts', status: 'renamed' })]);
    const shown = phonePermission(req);
    expect(shown.incomplete).toBeUndefined();
    // The destination hidden (as the lossy diff had it): desktop only.
    expect(phonePermission({ ...req, diff: [{ path: '/w/src/a.ts', status: 'modified', additions: 0, deletions: 0, hunks: [] }] }).incomplete).toBe(true);
  });
});

// ── #5 ──

/** A Claude permission as its adapter makes it (`alwaysScope`, the lines in its reason). */
function claudeAsk(suggestions: Parameters<typeof alwaysScope>[0]): PermissionRequest {
  const scope = compactScope(alwaysScope(suggestions));
  return {
    id: 'r1',
    sessionId: 's1',
    toolName: 'Bash',
    kind: 'bash',
    title: 'Run npm run build',
    detail: { command: 'npm run build' },
    ...(scope ? { scope, reason: withScope(undefined, scope) } : {}),
    options: [
      { id: 'allow', label: 'Allow once', tone: 'allow' },
      { id: 'always', label: 'Always allow Bash(npm run build:*)', hint: 'for this session', tone: 'always' },
      { id: 'deny', label: 'Deny', tone: 'deny' },
    ],
    createdAt: 1,
  } as PermissionRequest;
}

describe("#5: what Claude's \"always\" saves shows per suggestion, or that answer is the desktop's", () => {
  it('each suggestion with what it does, its behaviour and where it is kept', () => {
    const req = claudeAsk([
      { type: 'addDirectories', directories: ['/work/shared'], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build:*' }], behavior: 'allow', destination: 'userSettings' },
      { type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'deny', destination: 'projectSettings' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ]);
    expect(req.reason?.split('\n')).toEqual([
      'Always: access to /work/shared for this session',
      'Always: allow Bash(npm run build:*) in your settings, for every project',
      "Always: deny WebFetch in this project's settings",
      'Always: switch to acceptEdits mode for this session',
    ]);
    const shown = phonePermission(req);
    expect(shown.incomplete).toBeUndefined();
    expect(shown.options.map((o) => o.id)).toEqual(['allow', 'always', 'deny']);
    expect(() => phoneAllowed(req, 'always')).not.toThrow();
  });

  it('a save it cannot name, or one whose line does not show whole: "always" only on the desktop, "Allow once" still on the phone', () => {
    const odd = claudeAsk([
      { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
    ]);
    expect(odd.scope?.savesUnknown).toBe(true);
    expect(phonePermission(odd).options.map((o) => o.id)).toEqual(['allow', 'deny']);
    expect(() => phoneAllowed(odd, 'always')).toThrow(/only on the desktop/);
    expect(() => phoneAllowed(odd, 'allow')).not.toThrow();
    // A rule too long for the reason the phone gets: cut, so its line is not whole.
    const long = claudeAsk([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `x${'y'.repeat(2000)}` }], behavior: 'allow', destination: 'localSettings' }]);
    expect(phonePermission(long).options.map((o) => o.id)).toEqual(['allow', 'deny']);
    // The destination unknown: not named either.
    const where = claudeAsk([{ type: 'addDirectories', directories: ['/x'], destination: 'somewhere' as never }]);
    expect(phonePermission(where).options.map((o) => o.id)).toEqual(['allow', 'deny']);
  });
});

// ── #15 ──

describe("#15: a phone's record of a request is its own bounded copy", () => {
  it('no raw scope and nothing it did not ask for, however big the request', () => {
    const files = Array.from({ length: 50_000 }, (_, i) => ({ path: `/w/${'d'.repeat(200)}/${i}.ts` }));
    const scope: PermissionScope = { files, roots: ['r'.repeat(2_000_000)] };
    const req = { ...claudeAsk([]), scope, reason: 'x', toolName: 't'.repeat(100_000), blob: 'z'.repeat(5_000_000) } as unknown as PermissionRequest;
    const shown = phonePermission(req);
    expect(shown.incomplete).toBe(true);
    expect('scope' in shown).toBe(false);
    expect('blob' in shown).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThan(200_000);
    // The first record of a page is bounded too: a page of it stays small.
    const page = promptsPage({ permissions: [req, req], questions: [] }, undefined, PHONE_BYTES.prompts);
    expect(page.permissions.length).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(400_000);
  });

  it('a question goes with its own fields only', () => {
    const q = { id: 'q1', sessionId: 's1', createdAt: 1, extra: 'e'.repeat(1_000_000), questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, more: 'm'.repeat(1_000_000), options: [{ label: 'A', description: 'a', also: 'x'.repeat(1_000_000) }] }] } as unknown as QuestionRequest;
    const shown = phoneQuestion(q);
    expect(shown).toEqual({ id: 'q1', sessionId: 's1', createdAt: 1, questions: [{ id: 'q0', question: 'Which?', header: 'Pick', multiSelect: true, options: [{ id: 'o0', label: 'A', description: 'a' }] }] });
  });
});

// ── #17 ──

describe('#17: a new download start never closes a transfer in use', () => {
  function grants(n: number) {
    const dir = temp('dl');
    return Array.from({ length: n }, (_, i) => {
      const file = path.join(dir, `f${i}.bin`);
      fs.writeFileSync(file, Buffer.alloc(FILE_CHUNK + 10 * i, i + 1));
      const st = fs.statSync(file);
      const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return { deviceId: 'p1', path: file, name: path.basename(file), size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev, fileId: fs.statSync(file, { bigint: true }).ino.toString(), expires: Date.now() + 60_000, sha256 };
    });
  }
  const transfers = (files: InstanceType<typeof PhoneFiles>) => [...(files as unknown as { open: Map<string, { id: string; at: number; reads: number }> }).open.values()];

  it('all in use: refused for now, and every one open goes on', async () => {
    const files = new PhoneFiles();
    const gs = grants(FILE_MAX_TRANSFERS + 1);
    const open = [];
    for (const g of gs.slice(0, FILE_MAX_TRANSFERS)) open.push(await files.start('p1', g, g.sha256, () => true));
    const [over] = await Promise.allSettled([files.start('p1', gs[FILE_MAX_TRANSFERS], gs[FILE_MAX_TRANSFERS].sha256, () => true)]);
    expect(over.status).toBe('rejected');
    expect((over as PromiseRejectedResult).reason).toMatchObject({ retry: true });
    expect(files.count('p1')).toBe(FILE_MAX_TRANSFERS);
    for (const s of open) expect((await files.chunk('p1', s.transfer, 0, 16)).data.length).toBeGreaterThan(0);
    files.drop();
  });

  it('one no longer in use is closed for it (the oldest); one with a read under way never is', async () => {
    const files = new PhoneFiles();
    const gs = grants(FILE_MAX_TRANSFERS + 2);
    const open = [];
    for (const g of gs.slice(0, FILE_MAX_TRANSFERS)) open.push(await files.start('p1', g, g.sha256, () => true));
    const ts = transfers(files);
    // All left alone for a while, but the oldest still reading.
    for (const t of ts) t.at = Date.now() - FILE_ACTIVE_MS - 1000;
    ts[0].reads = 1;
    ts[1].at -= 10;
    const next = await files.start('p1', gs[FILE_MAX_TRANSFERS], gs[FILE_MAX_TRANSFERS].sha256, () => true);
    expect(next.transfer).toBeTruthy();
    expect(files.count('p1')).toBe(FILE_MAX_TRANSFERS);
    await expect(files.chunk('p1', open[1].transfer, 0, 16)).rejects.toThrow(/no longer open/);
    ts[0].reads = 0;
    expect((await files.chunk('p1', open[0].transfer, 0, 16)).data.length).toBeGreaterThan(0);
    files.drop();
  });
});

// ── #24 ──

describe("#24: a queue edit's pictures: each once, and every one counted", () => {
  const pic = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;
  const kept = (id: string, n: number): Attachment => ({ id, kind: 'image', name: id, dataUrl: pic(n), mime: 'image/png', size: Math.floor((n * 3) / 4) });

  it('the same picture twice is refused, kept or new', () => {
    const known = [kept('k1', 1000)];
    expect(() => phoneAttachments([{ id: 'k1' }, { id: 'k1' }], known)).toThrow(/only once/);
    expect(() => phoneAttachments([{ id: 'n1', dataUrl: pic(100) }, { id: 'n1', dataUrl: pic(100) }])).toThrow(/only once/);
    expect(phoneAttachments([{ id: 'k1' }, { id: 'n1', dataUrl: pic(100) }], known)?.map((a) => a.id)).toEqual(['k1', 'n1']);
  });

  it('kept pictures count against the total with the new ones; the kept ones alone as they were still go', () => {
    const big = PHONE_ATTACH.each - 100;
    const known = [kept('k1', big), kept('k2', big)];
    // New ones within the total by themselves, over it with what is kept.
    expect(() => phoneAttachments([{ id: 'k1' }, { id: 'n1', dataUrl: pic(PHONE_ATTACH.total - big + 10) }], known)).toThrow(/too big to send together/);
    expect(() => phoneAttachments([{ id: 'n1', dataUrl: pic(PHONE_ATTACH.total - big + 10) }, { id: 'k1' }], known)).toThrow(/too big to send together/);
    // The desktop's own pictures, kept as they were (no bigger than the message already was).
    expect(phoneAttachments([{ id: 'k1' }, { id: 'k2' }], known)?.length).toBe(2);
  });
});
