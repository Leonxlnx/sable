/**
 * "Since you last looked" at the bridge (server/services/seen.ts): what is new, what is seen, a file
 * changed again, reverted, renamed, a lane's worktree, a chat with no git, the bounded store.
 * Real git in temporary folders decides what changed; the signatures are checked against git's own.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SeenFile } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerGit } from '../server/services/git';
import { MAX_FILES, TEXT_MAX, TEXT_TOTAL, blobId, bound, classify, registerSeen, type SeenEntry } from '../server/services/seen';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repoIn(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}

async function setup(opts: { git?: boolean; before?: (repo: string) => void } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-seen-'));
  temps.push(home);
  const repo = path.join(home, 'code', 'proj');
  if (opts.git === false) mkdirSync(repo, { recursive: true });
  else repoIn(repo);
  const app = new App({ home: path.join(home, 'profile'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
  apps.push(app);
  registerGit(app);
  const seen = registerSeen(app);
  opts.before?.(repo);
  const snap = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
  const id = snap.session.id;
  // A chat made now records where it begins (in a repository): wait for it.
  const t0 = Date.now();
  while (opts.git !== false && !seen.store.has(id) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
  const state = (p?: string) => app.call('seen.state', { sessionId: id, cwd: repo, ...(p ? { path: p } : {}) });
  const by = (files: SeenFile[]) => Object.fromEntries(files.map((f) => [f.path, f.state]));
  const mark = async (...paths: string[]) => {
    const now = await state();
    return app.call('seen.mark', { sessionId: id, cwd: repo, files: now.files.filter((f) => paths.includes(f.path)).map((f) => ({ path: f.path, hash: f.hash })) });
  };
  return { home, repo, app, id, seen, state, by, mark, w: (f: string, t: string) => writeFileSync(path.join(repo, f), t) };
}

describe('the rule', () => {
  it('classifies new, seen and changed again, and keeps a rename on its old name', () => {
    const seen: Record<string, SeenEntry> = { 'a.txt': { h: 'h1', at: 1, t: 'x' }, 'old.txt': { h: 'h9', at: 2 } };
    const out = classify(
      [
        { path: 'a.txt', hash: 'h1' },
        { path: 'b.txt', hash: 'h2' },
        { path: 'new.txt', oldPath: 'old.txt', hash: 'h9' },
      ],
      seen,
    );
    expect(out.map((f) => f.state)).toEqual(['seen', 'new', 'seen']);
    expect(classify([{ path: 'a.txt', hash: 'h3' }], seen)[0]).toMatchObject({ state: 'again', since: true });
    // A big file or a deletion has no diff since seen.
    expect(classify([{ path: 'a.txt', hash: 'big:1:2' }], seen)[0].since).toBeUndefined();
    expect(classify([{ path: 'a.txt', hash: 'deleted' }], seen)[0].since).toBeUndefined();
  });

  it('bounds the store: the newest files, small texts, a total for text', () => {
    const many: Record<string, SeenEntry> = {};
    for (let i = 0; i < MAX_FILES + 50; i++) many[`f${i}`] = { h: `h${i}`, at: i };
    const kept = bound(many);
    expect(Object.keys(kept)).toHaveLength(MAX_FILES);
    expect(kept.f0).toBeUndefined();
    expect(kept[`f${MAX_FILES + 49}`]).toBeTruthy();

    const big = 'x'.repeat(TEXT_MAX + 1);
    expect(bound({ a: { h: 'h', at: 1, t: big } }).a).toEqual({ h: 'h', at: 1 });
    const texts: Record<string, SeenEntry> = {};
    const each = Math.floor(TEXT_MAX * 0.9);
    const n = Math.ceil(TEXT_TOTAL / each) + 3;
    for (let i = 0; i < n; i++) texts[`t${i}`] = { h: 'h', at: i, t: 'y'.repeat(each) };
    const cut = bound(texts);
    const total = Object.values(cut).reduce((s, e) => s + (e.t?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(TEXT_TOTAL);
    // The newest keep their text, the oldest lose it but keep their signature.
    expect(cut[`t${n - 1}`].t).toBeTruthy();
    expect(cut.t0.t).toBeUndefined();
    expect(cut.t0.h).toBe('h');
  });
});

describe('seen states with real git', { timeout: 60_000 }, () => {
  it('signs a file as git does, lists new files, and a mark makes them seen', async () => {
    const { repo, state, by, mark, w, app, id } = await setup();
    w('a.txt', 'one\ntwo\nthree\nfour\n');
    w('c.txt', 'sea\n');
    let s = await state();
    expect(s.repo).toBe(true);
    expect(by(s.files)).toEqual({ 'a.txt': 'new', 'c.txt': 'new' });
    expect(s.files.find((f) => f.path === 'a.txt')!.hash).toBe(git(repo, 'hash-object', '--no-filters', 'a.txt'));
    expect(blobId(readFileSync(path.join(repo, 'c.txt')))).toBe(git(repo, 'hash-object', '--no-filters', 'c.txt'));
    // It began on a clean tree: both are to review.
    expect(app.runtime(id).meta.review).toBe(2);

    const r = await mark('a.txt');
    expect(r.ok).toBe(true);
    expect(by(r.files)).toEqual({ 'a.txt': 'seen', 'c.txt': 'new' });
    expect(app.runtime(id).meta.review).toBe(1);
    s = await state();
    expect(by(s.files)).toEqual({ 'a.txt': 'seen', 'c.txt': 'new' });
  });

  it('a file changed again reads as new and its diff shows only what is new since', async () => {
    const { state, by, mark, w } = await setup();
    w('a.txt', 'one\ntwo\nthree\nfour\n');
    await mark('a.txt');
    w('a.txt', 'one\nTWO\nthree\nfour\nfive\n');
    const s = await state();
    expect(s.files[0]).toMatchObject({ path: 'a.txt', state: 'again', since: true });
    const one = await state('a.txt');
    const lines = one.diff!.hunks.flatMap((h) => h.lines);
    // Since seen: "two" became "TWO" and "five" came; "four" (already seen) is context, not new.
    expect(lines.filter((l) => l.startsWith('+'))).toEqual(['+TWO', '+five']);
    expect(lines.filter((l) => l.startsWith('-'))).toEqual(['-two']);
    expect(lines).not.toContain('+four');
    expect(by(s.files)).toEqual({ 'a.txt': 'again' });
  });

  it('a file reverted leaves the list, and coming back to the seen content reads as seen', async () => {
    const { state, by, mark, w } = await setup();
    w('a.txt', 'one\ntwo\nthree\nfour\n');
    await mark('a.txt');
    w('a.txt', 'one\ntwo\nthree\n');
    expect((await state()).files).toEqual([]);
    w('a.txt', 'changed\n');
    expect(by((await state()).files)).toEqual({ 'a.txt': 'again' });
    w('a.txt', 'one\ntwo\nthree\nfour\n');
    expect(by((await state()).files)).toEqual({ 'a.txt': 'seen' });
  });

  it('a deletion is new until marked, and a staged rename keeps the seen state of its old name', async () => {
    const { repo, state, by, mark, w } = await setup();
    w('b.txt', 'bee\nmore\n');
    await mark('b.txt');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'b');
    w('b.txt', 'bee\nmore\n');
    // Renamed by git with the same content that was seen under the old name.
    git(repo, 'mv', 'b.txt', 'bee.txt');
    let s = await state();
    const renamed = s.files.find((f) => f.path === 'bee.txt');
    expect(renamed?.state).toBe('seen');
    unlinkSync(path.join(repo, 'a.txt'));
    s = await state();
    expect(by(s.files)['a.txt']).toBe('new');
    expect(s.files.find((f) => f.path === 'a.txt')!.hash).toBe('deleted');
    await mark('a.txt');
    expect(by((await state()).files)['a.txt']).toBe('seen');
  });

  it('a commit does not make a seen change new: the content is what was seen', async () => {
    const { repo, state, by, mark, w } = await setup();
    w('a.txt', 'one\ntwo\nthree\nfour\n');
    await mark('a.txt');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'four');
    expect((await state()).files).toEqual([]);
    w('a.txt', 'one\ntwo\nthree\nfour\nfive\n');
    const s = await state();
    expect(by(s.files)).toEqual({ 'a.txt': 'again' });
    const lines = (await state('a.txt')).diff!.hunks.flatMap((h) => h.lines).filter((l) => /^[-+]/.test(l));
    expect(lines).toEqual(['+five']);
  });

  it('undo takes a mark back once, and unmark makes a file new again', async () => {
    const { app, id, repo, state, by, mark, w } = await setup();
    w('a.txt', 'x\n');
    w('c.txt', 'y\n');
    const r = await mark('a.txt', 'c.txt');
    expect(by(r.files)).toEqual({ 'a.txt': 'seen', 'c.txt': 'seen' });
    const back = await app.call('seen.mark', { sessionId: id, cwd: repo, undo: r.undo });
    expect(back.ok).toBe(true);
    expect(by(back.files)).toEqual({ 'a.txt': 'new', 'c.txt': 'new' });
    expect((await app.call('seen.mark', { sessionId: id, cwd: repo, undo: r.undo })).ok).toBe(false);
    await mark('a.txt');
    const un = await app.call('seen.mark', { sessionId: id, cwd: repo, unmark: ['a.txt'] });
    expect(by(un.files)['a.txt']).toBe('new');
    expect(by((await state()).files)['a.txt']).toBe('new');
  });

  it('marks only what git lists, as the window had it, and refuses another folder', async () => {
    const { app, id, repo, home, state, w } = await setup();
    w('a.txt', 'v1\n');
    const v1 = (await state()).files[0].hash;
    w('a.txt', 'v2\n');
    // The person saw v1; v2 came meanwhile: still new, and v2's text is not kept as seen.
    const r = await app.call('seen.mark', { sessionId: id, cwd: repo, files: [{ path: 'a.txt', hash: v1 }, { path: '../outside.txt', hash: 'x' }] });
    expect(r.files.find((f) => f.path === 'a.txt')).toMatchObject({ state: 'again' });
    expect(r.files.find((f) => f.path === 'a.txt')!.since).toBeUndefined();
    const stored = JSON.parse(readFileSync(path.join(home, 'profile', 'seen', `${id}.json`), 'utf8'));
    expect(Object.keys(stored.files)).toEqual(['a.txt']);
    await expect(app.call('seen.state', { sessionId: id, cwd: home })).rejects.toThrow(/folder/);
  });

  it('records where the chat began: what was dirty then is seen, what the turn changes is new', async () => {
    const { app, id, repo, seen, state, by, w } = await setup({ before: (dir) => writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\npre\n') });
    w('a.txt', 'one\ntwo\nthree\npre\nagent\n');
    w('d.txt', 'dee\n');
    const s = await state();
    expect(by(s.files)).toEqual({ 'a.txt': 'again', 'd.txt': 'new' });
    expect(s.files[0].base).toBe(true);
    const lines = (await state('a.txt')).diff!.hunks.flatMap((h) => h.lines).filter((l) => /^[-+]/.test(l));
    expect(lines).toEqual(['+agent']);
    expect(app.runtime(id).meta.review).toBe(2);
    // A second turn's start records nothing again.
    await seen.begin(id);
    expect(by((await state()).files)).toEqual({ 'a.txt': 'again', 'd.txt': 'new' });
    void repo;
  });

  it('the Demo turn that edits files counts them on the chat when it ends', async () => {
    const { app, id, by, state, seen } = await setup();
    // The chat recorded where it began when it was made (a clean tree: nothing to review yet).
    const t0 = Date.now();
    while (!seen.store.has(id) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(seen.store.has(id)).toBe(true);
    await app.call('session.send', { sessionId: id, text: 'until green' });
    const end = Date.now() + 45_000;
    while (app.runtime(id).meta.review === undefined && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    const n = app.runtime(id).meta.review;
    expect(n).toBeGreaterThan(0);
    const s = await state();
    expect(s.files.filter((f) => f.state !== 'seen')).toHaveLength(n!);
    void by;
  });

  it('works in a lane: a worktree of its own folder', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-seen-lane-'));
    temps.push(home);
    const repo = path.join(home, 'code', 'proj');
    repoIn(repo);
    const lane = path.join(home, 'lanes', 'proj-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'lane-1', lane);
    const app = new App({ home: path.join(home, 'profile'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
    apps.push(app);
    registerGit(app);
    registerSeen(app);
    const snap = await app.call('session.create', { provider: 'demo', cwd: lane, mode: 'bypassPermissions' });
    writeFileSync(path.join(lane, 'a.txt'), 'lane\n');
    writeFileSync(path.join(repo, 'b.txt'), 'main\n');
    const s = await app.call('seen.state', { sessionId: snap.session.id, cwd: lane });
    expect(s.files.map((f) => f.path)).toEqual(['a.txt']);
    const r = await app.call('seen.mark', { sessionId: snap.session.id, cwd: lane, files: [{ path: 'a.txt', hash: s.files[0].hash }] });
    expect(r.files[0].state).toBe('seen');
    git(lane, 'worktree', 'list');
  });

  it('a chat with no git has no seen states, writes nothing and carries no count', async () => {
    const { app, id, home, state, w } = await setup({ git: false });
    w('a.txt', 'x\n');
    const s = await state();
    expect(s).toEqual({ repo: false, files: [] });
    const r = await app.call('seen.mark', { sessionId: id, cwd: path.join(home, 'code', 'proj'), files: [{ path: 'a.txt', hash: 'x' }] });
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(home, 'profile', 'seen', `${id}.json`))).toBe(false);
    expect(app.runtime(id).meta.review).toBeUndefined();
  });

  it('the seen file goes with the chat, and files of gone chats are removed at start', async () => {
    const { app, id, home, mark, w } = await setup();
    w('a.txt', 'x\n');
    await mark('a.txt');
    const file = path.join(home, 'profile', 'seen', `${id}.json`);
    expect(existsSync(file)).toBe(true);
    writeFileSync(path.join(home, 'profile', 'seen', 'gone-chat.json'), '{"v":1,"cwd":"x","files":{}}');
    await app.call('session.close', { sessionId: id, remove: true });
    expect(existsSync(file)).toBe(false);
    registerSeen(app);
    expect(existsSync(path.join(home, 'profile', 'seen', 'gone-chat.json'))).toBe(false);
  });
});
