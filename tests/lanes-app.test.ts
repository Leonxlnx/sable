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
    expect(made.ok).toBe(true);
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
