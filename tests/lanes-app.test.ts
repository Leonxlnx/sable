/**
 * Lanes at the bridge: two Demo sessions in one temporary git folder. The Demo's "until green"
 * writes a small project for real into its session's folder, so the second session's edits land
 * in its lane and the first's in the folder. Temporary folders only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, SessionSnapshot } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerGit } from '../server/services/git';
import { registerScripts } from '../server/services/scripts';
import { folderNow, openContained } from '../server/core/contain';
import { registerTerm } from '../server/services/term';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(pred: () => boolean, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-lanes-app-'));
  temps.push(home);
  const repo = path.join(home, 'code', 'relay');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'README.md'), '# relay\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
  const app = new App({ home: path.join(home, 'profile'), providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: home });
  apps.push(app);
  // Lanes are off unless turned on (Settings › General).
  app.store.state.settings.autoLanes = true;
  const meta =(id: string) => app.runtime(id).meta;
  const idle = (id: string) => until(() => meta(id).status === 'idle' && !app.runtime(id).turnActive, `${id} idle`);
  const notices = (id: string) => app.runtime(id).items.filter((i): i is NoticeItem => i.type === 'notice').map((n) => [n.text, n.detail ?? '']);
  const turns = (id: string) => app.runtime(id).items.filter((i) => i.type === 'turn').length;
  const turn = async (snap: SessionSnapshot, text: string) => {
    const before = turns(snap.session.id);
    const t0 = Date.now();
    await app.call('session.send', { sessionId: snap.session.id, text });
    await until(() => turns(snap.session.id) > before, `the turn "${text}"`, 45_000);
    await idle(snap.session.id);
    if (process.env.LANES_DEBUG) console.log(text, Date.now() - t0, 'ms');
  };
  return { home, repo, app, meta, idle, notices, turn, lanes: path.join(home, 'profile', 'lanes') };
}

describe('lanes with two Demo sessions in one folder', { timeout: 180_000 }, () => {
  it('moves an already opened new agent when the checkout becomes busy before its first send', async () => {
    const { repo, app, turn, meta } = setup();
    const first = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    const second = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    expect(second.session.providerSessionId).toBeTruthy();
    await turn(first, 'until green');
    await turn(second, 'until green');
    const lane = meta(second.session.id).lane;
    expect(lane?.path).toBe(meta(second.session.id).cwd);
    expect(existsSync(path.join(lane!.path, 'src', 'session.js'))).toBe(true);
  });

  it('chooses one lane for two concurrent first sends', async () => {
    const { repo, app, turn, meta } = setup();
    const first = await app.call('session.create', { provider: 'demo', cwd: repo });
    const second = await app.call('session.create', { provider: 'demo', cwd: repo });
    await Promise.all([turn(first, 'hi'), turn(second, 'hi')]);
    expect([meta(first.session.id).cwd, meta(second.session.id).cwd].filter((cwd) => cwd === repo)).toHaveLength(1);
  });

  it('uses the selected nested worktree for the agent, changes, scripts and file containment', async () => {
    const { repo, app, turn, meta, idle } = setup();
    registerGit(app);
    registerScripts(app);
    const selected = path.join(repo, 'linked tree');
    git(repo, 'worktree', 'add', '-qb', "feature/tom's-$fix", selected);
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    app.runtime(a.session.id).update({ status: 'running' });
    const trees = await app.call('git.worktrees', { cwd: repo });
    const pick = trees.find((w) => w.path === selected)!;
    const b = await app.call('session.create', { provider: 'demo', cwd: pick.path, mode: 'bypassPermissions' });
    await idle(b.session.id);
    await turn(b, 'until green');
    const cwd = meta(b.session.id).cwd;
    expect(cwd).toBe(selected);
    expect(meta(b.session.id).lane).toBeFalsy();
    expect((await app.call('git.status', { cwd })).branch).toBe(pick.branch);
    expect(existsSync(path.join(selected, 'src', 'session.js'))).toBe(true);
    expect(existsSync(path.join(repo, 'src', 'session.js'))).toBe(false);
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { selected: 'echo chosen' } }));
    expect((await app.call('project.scripts', { cwd })).scripts.some((s) => s.name === 'selected')).toBe(true);
    const pin = await folderNow(cwd);
    expect(pin).toMatchObject({ real: cwd });
    if (typeof pin !== 'object') throw new Error('Missing folder pin');
    for (const dir of [selected, repo]) {
      const opened = await openContained(path.join(dir, 'README.md'), pin);
      try { expect(opened.inside).toBe(dir === selected); } finally { await opened.fh.close(); }
    }
    registerTerm(app);
    let output = '';
    let exited = false;
    const off = app.subscribe((event) => {
      if (event.type === 'term.data') output += event.data;
      if (event.type === 'term.exit') exited = true;
    });
    try {
      await app.call('term.run', { cwd, command: process.platform === 'win32' ? '(Get-Location).Path' : 'pwd' });
      await until(() => exited, 'terminal cwd');
      expect(output.trim()).toBe(selected);
    } finally { off(); }
  });

  it('protects the active owner of a selected Sable worktree', async () => {
    const { repo, app, meta, idle } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    const owner = (await app.call('lane.create', { sessionId: a.session.id })).lane!;
    app.runtime(a.session.id).update({ status: 'running' });
    const b = await app.call('session.create', { provider: 'demo', cwd: owner.path, title: 'Second' });
    await idle(b.session.id);
    expect(meta(b.session.id).lane?.root).toBe(owner.path);
    app.runtime(a.session.id).update({ status: 'idle' });
    expect(await app.call('lane.discard', { sessionId: a.session.id })).toMatchObject({ ok: false, error: expect.stringMatching(/chat/i) });
    expect(existsSync(owner.path)).toBe(true);
  });

  it('makes just one lane for duplicate create requests', async () => {
    const { repo, app } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    const make = () => app.call('lane.create', { sessionId: a.session.id });
    const results = await Promise.all([make(), make()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(2);
  });

  it('removes a lane made under a previous custom worktrees folder', async () => {
    const { repo, home, app, meta } = setup();
    app.store.state.settings.worktreesFolder = path.join(home, 'custom one');
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    expect((await app.call('lane.create', { sessionId: a.session.id })).ok).toBe(true);
    const { path: dir } = meta(a.session.id).lane!;
    app.store.state.settings.worktreesFolder = path.join(home, 'custom two');
    expect(await app.call('lane.discard', { sessionId: a.session.id })).toEqual({ ok: true });
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'branch', '--list', 'sable/*')).toBe('');
  });

  it('can discard an existing lane in the managed folder with an older directory name', async () => {
    const { repo, app, lanes } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo });
    const made = (await app.call('lane.create', { sessionId: chat.session.id })).lane!;
    const old = path.join(lanes, 'older checkout');
    git(repo, 'worktree', 'move', made.path, old);
    app.runtime(chat.session.id).update({ cwd: old, lane: { ...made, path: old } });
    expect(await app.call('lane.discard', { sessionId: chat.session.id })).toEqual({ ok: true });
    expect(existsSync(old)).toBe(false);
  });

  it('rechecks saved edits after restart before assigning the checkout to a new chat', async () => {
    const { repo, home, app, turn } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(a, 'until green');
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const back = new App({ home: path.join(home, 'profile'), userHome: home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    apps.push(back);
    const b = await back.call('session.create', { provider: 'demo', cwd: repo, title: 'Next' });
    await until(() => back.runtime(b.session.id).meta.status === 'idle', 'restored checkout check');
    expect(back.runtime(b.session.id).meta.lane?.folder).toBe(repo);
  });

  it('refuses the next send after the lane folder disappears and lets the chat discard it', async () => {
    const { repo, app, turn } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo });
    await turn(chat, 'hi');
    const { lane } = await app.call('lane.create', { sessionId: chat.session.id });
    rmSync(lane!.path, { recursive: true, force: true });
    git(repo, 'worktree', 'prune');
    await expect(app.call('session.send', { sessionId: chat.session.id, text: 'hi' })).rejects.toThrow(/lane folder is gone/i);
    expect(await app.call('lane.discard', { sessionId: chat.session.id })).toEqual({ ok: true });
    expect(app.runtime(chat.session.id).meta.cwd).toBe(repo);
  });

  it('refuses to send into a different repository initialized in the old lane directory', async () => {
    const { repo, app, turn } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(chat, 'hi');
    const { lane } = await app.call('lane.create', { sessionId: chat.session.id });
    rmSync(path.join(lane!.path, '.git'));
    git(lane!.path, 'init', '-qb', 'replacement');
    await expect(app.call('session.send', { sessionId: chat.session.id, text: 'until green' })).rejects.toThrow(/no longer contains this lane/i);
    expect(existsSync(path.join(lane!.path, 'src', 'session.js'))).toBe(false);
  });

  it('releases a deleted chat’s clean checkout while preserving its unlanded commits', async () => {
    const { repo, app } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    const l = (await app.call('lane.create', { sessionId: a.session.id })).lane!;
    writeFileSync(path.join(l.path, 'mine'), 'mine');
    git(l.path, 'add', 'mine');
    git(l.path, 'commit', '-qm', 'Keep mine');
    await app.call('session.close', { sessionId: a.session.id, remove: true });
    await until(() => !existsSync(l.path), 'clean checkout release', 8000);
    expect(git(repo, 'show', 'refs/heads/' + l.branch + ':mine')).toBe('mine');
  });

  it('reports a successful landing and keeps ignored local files until explicit discard', async () => {
    const { repo, app, meta, notices } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo });
    const l = (await app.call('lane.create', { sessionId: a.session.id })).lane!;
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'private-file\n');
    writeFileSync(path.join(l.path, 'private-file'), 'private local file');
    writeFileSync(path.join(l.path, 'work'), 'land this');
    expect(await app.call('lane.land', { sessionId: a.session.id })).toMatchObject({ ok: true });
    expect(git(repo, 'show', 'HEAD:work')).toBe('land this');
    expect(meta(a.session.id)).toMatchObject({ cwd: repo, lane: null });
    expect(notices(a.session.id).flat().join(' ')).toContain(l.path);
    expect(notices(a.session.id).flat().join(' ')).toContain('private-file');
    expect(readFileSync(path.join(l.path, 'private-file'), 'utf8')).toBe('private local file');
    expect(await app.call('lane.discard', { sessionId: a.session.id })).toEqual({ ok: true });
  });

  it('sends the next edit home after landing a built lane and reports its path on deletion', async () => {
    const { repo, app, turn } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    const sessionId = chat.session.id;
    const { lane } = await app.call('lane.create', { sessionId });
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'dist/\n');
    mkdirSync(path.join(lane!.path, 'dist'));
    writeFileSync(path.join(lane!.path, 'dist', 'local'), 'keep');
    writeFileSync(path.join(lane!.path, 'landed'), 'land me');
    expect((await app.call('lane.land', { sessionId })).ok).toBe(true);
    await turn(chat, 'until green');
    expect(existsSync(path.join(repo, 'src', 'session.js'))).toBe(true);
    expect(existsSync(path.join(lane!.path, 'src', 'session.js'))).toBe(false);
    const second = (await app.call('lane.create', { sessionId })).lane!;
    mkdirSync(path.join(second.path, 'dist'));
    writeFileSync(path.join(second.path, 'dist', 'local'), 'also keep');
    writeFileSync(path.join(second.path, 'second'), 'land again');
    expect((await app.call('lane.land', { sessionId })).ok).toBe(true);
    const messages: string[] = [];
    app.subscribe(e => { if (e.type === 'toast') messages.push(e.text); });
    await app.call('session.close', { sessionId, remove: true });
    await until(() => [lane!.path, second.path].every(dir => messages.some(text => text.includes(dir))), 'both retained worktree paths', 5000);
    expect(readFileSync(path.join(lane!.path, 'dist', 'local'), 'utf8')).toBe('keep');
  });

  it('finishes Land and Fork together on a closed lane and accepts the next send', async () => {
    const { repo, app, turn } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo });
    await turn(chat, 'hi');
    const sessionId = chat.session.id;
    const itemId = app.runtime(sessionId).items.find(i => i.type === 'text')!.id;
    const made = await app.call('lane.create', { sessionId });
    expect(made.ok, made.error).toBe(true);
    writeFileSync(path.join(made.lane!.path, 'work'), 'from a lane');
    await app.call('session.close', { sessionId });
    const [land, fork] = await Promise.all([
      app.call('lane.land', { sessionId }),
      app.call('session.fork', { sessionId, itemId }),
    ]);
    expect(land.ok).toBe(true);
    expect(fork.session.cwd).toBe(repo);
    await turn(chat, 'hi');
  }, 60_000);

  it('returns home when Git retains a landed branch with an older upstream', async () => {
    const { repo, app, meta, notices } = setup();
    const chat = await app.call('session.create', { provider: 'demo', cwd: repo });
    const l = (await app.call('lane.create', { sessionId: chat.session.id })).lane!;
    git(repo, 'branch', 'published', l.base);
    git(l.path, 'branch', '--set-upstream-to=published');
    writeFileSync(path.join(l.path, 'work'), 'landed');
    expect(await app.call('lane.land', { sessionId: chat.session.id })).toMatchObject({ ok: true });
    expect(existsSync(l.path)).toBe(false);
    expect(meta(chat.session.id)).toMatchObject({ cwd: repo, lane: null });
    expect(git(repo, 'show', 'HEAD:work')).toBe('landed');
    expect(notices(chat.session.id).flat().join(' ')).toContain('Git kept the branch');
  });

  it('keeps the race winner after archive, close and restart', async () => {
    const { repo, home, app, idle } = setup();
    const race = await app.call('race.start', { cwd: repo, task: 'until green', provider: 'demo', modes: { demo: 'bypassPermissions' } });
    expect(race.ok).toBe(true);
    const [a, b] = race.sessions!.map((s) => s.session);
    expect(a.lane?.path).not.toBe(b.lane?.path);
    for (const s of [a, b]) {
      await until(() => app.runtime(s.id).items.some((i) => i.type === 'turn'), 'race turn');
      await idle(s.id);
    }
    await app.call('session.update', { sessionId: a.id, patch: { archived: true } });
    await app.call('session.close', { sessionId: a.id });
    expect(existsSync(a.lane!.path)).toBe(true);
    await app.dispose();
    apps.splice(apps.indexOf(app), 1);
    const back = new App({ home: path.join(home, 'profile'), userHome: home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
    apps.push(back);
    expect(back.runtime(a.id).meta.cwd).toBe(a.lane!.path);
    await back.call('session.update', { sessionId: a.id, patch: { archived: false } });
    expect(await back.call('race.keep', { sessionId: a.id })).toMatchObject({ ok: true, discarded: true });
    expect(back.runtime(a.id).meta.cwd).toBe(repo);
    expect(back.runtime(b.id).meta.archived).toBe(true);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('gives the second session a lane, forecasts, refuses a conflict, then lands cleanly and comes home', async () => {
    const { repo, app, meta, notices, turn, lanes } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(a, 'until green');
    // The first session works in the folder itself and leaves its edits there, uncommitted.
    expect(meta(a.session.id).lane).toBeUndefined();
    expect(git(repo, 'status', '--porcelain')).toContain('src/');

    const b = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(b, 'until green');
    // The lane made at the start gets its name from the first message without holding it up.
    await until(() => !!meta(b.session.id).lane && !meta(b.session.id).lane!.provisional, 'the lane named');
    const lane = meta(b.session.id).lane!;
    expect(lane).toMatchObject({ folder: path.resolve(repo), branch: 'sable/until-green', from: 'main' });
    expect(lane.provisional).toBeUndefined();
    expect(lane.path.startsWith(lanes)).toBe(true);
    expect(meta(b.session.id).cwd).toBe(lane.path);
    expect(notices(b.session.id)).toContainEqual(['Working in lane sable/until-green', `“${meta(a.session.id).title}” is working in relay`]);
    // Its edits are in the lane, on its branch.
    expect(readFileSync(path.join(lane.path, 'src', 'session.js'), 'utf8')).toContain('IDLE_MINUTES');
    expect(git(lane.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sable/until-green');
    // The folder is still in the sidebar's place: the project is the folder, not the lane.
    expect(app['store'].state.projects.map((p) => p.path)).toEqual([path.resolve(repo)]);

    // The folder holds the first session's uncommitted copies of the same files: landing would overwrite them.
    let f = await app.call('lane.forecast', { sessionId: b.session.id });
    expect(f.state).toBe('blocked');
    expect(f.blocked).toContain('src/session.js');

    // The first session's work is committed, with a different session.js: a conflict.
    writeFileSync(path.join(repo, 'src', 'session.js'), 'export const IDLE_MINUTES = 15;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Fifteen minutes');
    f = await app.call('lane.forecast', { sessionId: b.session.id });
    expect(f).toMatchObject({ state: 'conflicts', conflicts: ['src/session.js'], target: 'main', behind: 1 });
    const refused = await app.call('lane.land', { sessionId: b.session.id, message: 'Session fixture' });
    expect(refused).toMatchObject({ ok: false, conflicts: ['src/session.js'] });
    expect(meta(b.session.id).lane?.path).toBe(lane.path);
    const head = git(repo, 'rev-parse', 'HEAD');

    // The folder's commit is undone: the lane lands cleanly, its uncommitted edits committed first.
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    f = await app.call('lane.forecast', { sessionId: b.session.id });
    expect(f).toMatchObject({ state: 'clean', target: 'main', ahead: 0, behind: 0, conflicts: [], blocked: [] });
    expect(f.uncommitted).toBeGreaterThan(0);
    const landed = await app.call('lane.land', { sessionId: b.session.id, message: 'Session fixture from the lane' });
    expect(landed).toMatchObject({ ok: true, how: 'fast-forward', commits: 1, target: 'main' });
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Session fixture from the lane');
    expect(git(repo, 'rev-parse', 'HEAD')).not.toBe(head);
    // The session is back in its folder; the lane's folder and branch are gone.
    expect(meta(b.session.id).cwd).toBe(path.resolve(repo));
    expect(meta(b.session.id).lane).toBeNull();
    expect(existsSync(lane.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'sable/*')).toBe('');
    expect(notices(b.session.id)).toContainEqual(['Landed sable/until-green on main', '1 commit']);
  });

  it('makes a lane on request and discards it with its work', async () => {
    const { repo, app, meta, turn, notices } = setup();
    const c = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(c, 'hi');
    const made = await app.call('lane.create', { sessionId: c.session.id });
    expect(made.ok, made.error).toBe(true);
    const lane = meta(c.session.id).lane!;
    expect(lane.branch).toMatch(/^sable\//);
    writeFileSync(path.join(lane.path, 'scratch.txt'), 'lane work\n');
    expect((await app.call('lane.create', { sessionId: c.session.id })).ok).toBe(false);
    const res = await app.call('lane.discard', { sessionId: c.session.id });
    expect(res).toEqual({ ok: true });
    expect(existsSync(lane.path)).toBe(false);
    expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
    expect(meta(c.session.id)).toMatchObject({ cwd: path.resolve(repo), lane: null });
    expect(notices(c.session.id).map((n) => n[0])).toContain(`Discarded lane ${lane.branch}`);
    // The conversation goes on in the folder.
    await turn(c, 'hi');
  });

  it('leaves a free folder alone, and makes no lane with the setting off', async () => {
    const { repo, app, meta, turn } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(a, 'hi');
    // Nothing of the first one's is uncommitted: the second works in the folder too.
    const b = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(b, 'hi');
    expect(meta(b.session.id).lane).toBeUndefined();

    await turn(a, 'until green');
    await app.call('app.setSettings', { patch: { autoLanes: false } });
    const c = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(c, 'hi');
    expect(meta(c.session.id).lane).toBeUndefined();
    expect(meta(c.session.id).cwd).toBe(path.resolve(repo));
  });

  it('removes a deleted chat’s lane only when it holds nothing to land', async () => {
    const { repo, app, meta, turn, lanes } = setup();
    const a = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(a, 'until green');
    const b = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(b, 'hi');
    // The lane is named from the first message in the background, without holding that message up.
    await until(() => meta(b.session.id).lane?.branch === 'sable/hi', 'the lane to take its name');
    const empty = meta(b.session.id).lane!;
    expect(empty.branch).toBe('sable/hi');
    const c = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'bypassPermissions' });
    await turn(c, 'until green');
    // Its name too comes in the background (on a busy machine after the turn): the lane as it ends up.
    await until(() => meta(c.session.id).lane?.branch === 'sable/until-green', 'the full lane to take its name');
    const full = meta(c.session.id).lane!;
    const logs: string[] = [];
    app.log = (...args: unknown[]) => void logs.push(args.join(' '));
    await app.call('session.close', { sessionId: b.session.id, remove: true });
    await app.call('session.close', { sessionId: c.session.id, remove: true });
    await until(() => !existsSync(empty.path), 'the empty lane to go');
    // The full lane's check runs git in the folder a moment longer (Windows holds the folder meanwhile).
    await until(() => logs.some((l) => l.startsWith('lane: kept with its work')), 'the full lane’s check');
    expect(existsSync(full.path)).toBe(true);
    expect(git(repo, 'branch', '--list', 'sable/*')).toContain(full.branch);
    expect(full.path.startsWith(lanes)).toBe(true);
  }, 30_000);
});
