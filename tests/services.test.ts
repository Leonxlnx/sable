import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@shared/protocol';
import { App } from '../server/app';
import { registerServices } from '../server/services';
import { rankPaths } from '../server/services/fs';
import { gitWorktrees } from '../server/services/git';

const isWin = process.platform === 'win32';

let base = '';
let repo = '';
let plain = '';
let userHome = '';
let app: App;
const events: BridgeEvent[] = [];

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function until(pred: () => boolean, what: string, ms = 8000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const exitOf = (termId: string) =>
  events.find((e): e is Extract<BridgeEvent, { type: 'term.exit' }> => e.type === 'term.exit' && e.termId === termId);
const outputOf = (termId: string, stream?: 'out' | 'err') =>
  events
    .filter((e): e is Extract<BridgeEvent, { type: 'term.data' }> => e.type === 'term.data' && e.termId === termId)
    .filter((e) => !stream || e.stream === stream)
    .map((e) => e.data)
    .join('');

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'sable-svc-'));
  repo = path.join(base, 'repo');
  plain = path.join(base, 'plain');
  userHome = path.join(base, 'home');
  mkdirSync(repo);
  mkdirSync(plain);
  mkdirSync(userHome);

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, '.gitignore'), 'secret.log\n');
  writeFileSync(path.join(repo, 'README.md'), '# demo\nline 2\nline 3\n');
  writeFileSync(path.join(repo, 'staged.txt'), 'one\n');
  writeFileSync(path.join(repo, 'doomed.txt'), 'bye\n');
  mkdirSync(path.join(repo, 'src', 'components'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'components', 'Button.tsx'), 'export const Button = 1;\n');
  mkdirSync(path.join(repo, 'docs', 'button', 'guide', 'deep'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'button', 'guide', 'deep', 'index.md'), 'docs\n');
  writeFileSync(path.join(repo, 'file10.txt'), 'x\n');
  writeFileSync(path.join(repo, 'file2.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('branch', 'older');

  // Working-tree changes.
  writeFileSync(path.join(repo, 'README.md'), '# demo\nline two\nline 3\n');
  writeFileSync(path.join(repo, 'staged.txt'), 'one\ntwo\n');
  git('add', 'staged.txt');
  rmSync(path.join(repo, 'doomed.txt'));
  writeFileSync(path.join(repo, 'new.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(repo, 'secret.log'), 'ignored\n');
  mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]));

  app = new App({ home: path.join(base, 'store'), providers: [], quiet: true });
  registerServices(app, { userHome });
  app.subscribe((e) => events.push(e));
});

afterAll(async () => {
  await app?.dispose();
  // Give killed processes a moment to release their cwd handles on Windows.
  for (let i = 0; i < 40; i++) {
    try {
      rmSync(base, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

// ───────────────────────────── fs ─────────────────────────────

describe('fs', () => {
  it('roots lists drives / and existing home folders', async () => {
    mkdirSync(path.join(userHome, 'Desktop'));
    const { roots, home } = await app.call('fs.roots', {});
    expect(home).toBe(userHome);
    expect(roots.every((r) => r.dir)).toBe(true);
    if (isWin) expect(roots.some((r) => /^[A-Z]:\\$/.test(r.path))).toBe(true);
    else expect(roots[0].path).toBe('/');
    expect(roots.find((r) => r.name === 'Home')?.path).toBe(userHome);
    expect(roots.find((r) => r.name === 'Desktop')?.path).toBe(path.join(userHome, 'Desktop'));
    expect(roots.some((r) => r.name === 'Downloads')).toBe(false);
  });

  it('list sorts dirs first naturally, flags noise and git-ignored entries, reports sizes', async () => {
    const res = await app.call('fs.list', { path: repo + path.sep + '.' });
    expect(res.path).toBe(repo);
    expect(res.parent).toBe(base);
    const names = res.entries.map((e) => e.name);
    const firstFile = res.entries.findIndex((e) => !e.dir);
    expect(res.entries.slice(0, firstFile).every((e) => e.dir)).toBe(true);
    expect(names.indexOf('file2.txt')).toBeLessThan(names.indexOf('file10.txt'));
    const by = Object.fromEntries(res.entries.map((e) => [e.name, e]));
    expect(by['.git'].ignored).toBe(true);
    expect(by['node_modules'].ignored).toBe(true);
    expect(by['secret.log'].ignored).toBe(true);
    expect(by['src'].ignored).toBeFalsy();
    expect(by['README.md'].size).toBe(readFileSync(path.join(repo, 'README.md')).length);
    expect(by['src'].dir).toBe(true);
  });

  it('list returns parent null at a root and throws clearly for missing folders', async () => {
    const root = path.parse(repo).root;
    expect((await app.call('fs.list', { path: root })).parent).toBeNull();
    await expect(app.call('fs.list', { path: path.join(base, 'nope') })).rejects.toThrow(/does not exist/);
  });

  it('read truncates, reports size, and detects binary files', async () => {
    const big = path.join(plain, 'big.txt');
    writeFileSync(big, 'é'.repeat(100)); // 200 bytes, 2-byte chars
    const r = await app.call('fs.read', { path: big, maxBytes: 51 });
    expect(r).toMatchObject({ truncated: true, size: 200, binary: false });
    expect(r.content).toBe('é'.repeat(25)); // no half character
    const full = await app.call('fs.read', { path: big });
    expect(full).toMatchObject({ truncated: false, content: 'é'.repeat(100) });
    const bin = await app.call('fs.read', { path: path.join(repo, 'blob.bin') });
    expect(bin).toMatchObject({ binary: true, content: '', size: 5 });
    await expect(app.call('fs.read', { path: repo })).rejects.toThrow(/folder/);
  });

  it('search ranks basename matches over deep path matches and includes directories', async () => {
    const res = await app.call('fs.search', { cwd: repo, query: 'button' });
    expect(res[0].rel).toBe('src/components/Button.tsx');
    expect(res[0].path).toBe(path.join(repo, 'src', 'components', 'Button.tsx'));
    expect(res.some((r) => r.dir && r.rel === 'docs/button')).toBe(true);
    // Ignored files are not offered; untracked ones are.
    const all = await app.call('fs.search', { cwd: repo, query: 'txt', limit: 100 });
    expect(all.some((r) => r.rel === 'new.txt')).toBe(true);
    expect(all.some((r) => r.rel.includes('node_modules'))).toBe(false);
    const secret = await app.call('fs.search', { cwd: repo, query: 'secret' });
    expect(secret).toHaveLength(0);
    // Subsequence across segments.
    const sub = await app.call('fs.search', { cwd: repo, query: 'scbtn' });
    expect(sub[0]?.rel).toBe('src/components/Button.tsx');
  });

  it('search with an empty query returns shallow entries; walk fallback outside repos', async () => {
    const res = await app.call('fs.search', { cwd: repo, query: '', limit: 5 });
    expect(res).toHaveLength(5);
    expect(res.every((r) => !r.rel.includes('/'))).toBe(true);

    mkdirSync(path.join(plain, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(plain, 'node_modules', 'x', 'skip.js'), '');
    mkdirSync(path.join(plain, 'lib'));
    writeFileSync(path.join(plain, 'lib', 'helper.ts'), '');
    const walked = await app.call('fs.search', { cwd: plain, query: 'helper' });
    expect(walked[0]).toMatchObject({ rel: 'lib/helper.ts', dir: false });
    const skip = await app.call('fs.search', { cwd: plain, query: 'skip' });
    expect(skip).toHaveLength(0);
  });

  it('search ranking is fast on a few thousand files', () => {
    // Pure ranking on synthetic paths (creating thousands of real files is slow on Windows).
    const files: string[] = [];
    for (let d = 0; d < 50; d++) {
      for (let f = 0; f < 100; f++) files.push(`packages/pkg-${d}/src/feature/module${f}Handler.ts`);
    }
    rankPaths(files, 'warm');
    const t = performance.now();
    const res = rankPaths(files, 'pkg7mod42');
    const res2 = rankPaths(files, 'handler');
    expect(performance.now() - t).toBeLessThan(400);
    expect(res[0].rel).toBe('packages/pkg-7/src/feature/module42Handler.ts');
    expect(res2).toHaveLength(40);
  });
});

// ───────────────────────────── git ─────────────────────────────

describe('git', () => {
  it('status outside a repo', async () => {
    expect(await app.call('git.status', { cwd: plain })).toEqual({ isRepo: false, files: [], additions: 0, deletions: 0 });
    expect(await app.call('git.status', { cwd: path.join(base, 'missing') })).toMatchObject({ isRepo: false });
  });

  it('status reports modified, staged, untracked and deleted files with counts', async () => {
    const st = await app.call('git.status', { cwd: repo });
    expect(st).toMatchObject({ isRepo: true, branch: 'main' });
    const by = Object.fromEntries(st.files.map((f) => [f.path, f]));
    expect(by['README.md']).toMatchObject({ status: 'M', staged: false, additions: 1, deletions: 1 });
    expect(by['staged.txt']).toMatchObject({ status: 'M', staged: true, additions: 1, deletions: 0 });
    expect(by['doomed.txt']).toMatchObject({ status: 'D', staged: false, additions: 0, deletions: 1 });
    expect(by['new.txt']).toMatchObject({ status: '?', staged: false, additions: 3 });
    expect(by['blob.bin']).toMatchObject({ status: '?', additions: 0 });
    expect(by['secret.log']).toBeUndefined();
    expect(st.additions).toBe(1 + 1 + 3);
    expect(st.deletions).toBe(1 + 1);
  });

  it('status paths are relative to a sub-folder cwd', async () => {
    writeFileSync(path.join(repo, 'src', 'components', 'Button.tsx'), 'export const Button = 2;\n');
    const st = await app.call('git.status', { cwd: path.join(repo, 'src') });
    expect(st.files.some((f) => f.path === 'components/Button.tsx')).toBe(true);
    expect(st.files.some((f) => f.path === '../README.md')).toBe(true);
    git('checkout', '--', 'src/components/Button.tsx');
  });

  it('diff covers modified, staged and untracked files; staged-only and single-path modes', async () => {
    const all = await app.call('git.diff', { cwd: repo });
    const by = Object.fromEntries(all.map((f) => [f.path, f]));
    expect(by['README.md'].hunks[0].lines).toEqual([' # demo', '-line 2', '+line two', ' line 3']);
    expect(by['staged.txt']).toMatchObject({ status: 'modified', additions: 1 });
    expect(by['doomed.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(by['new.txt']).toMatchObject({ status: 'added', additions: 3 });
    expect(by['new.txt'].hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }]);
    expect(by['blob.bin']).toMatchObject({ status: 'added', binary: true, hunks: [] });
    expect(by['secret.log']).toBeUndefined();

    const staged = await app.call('git.diff', { cwd: repo, staged: true });
    expect(staged.map((f) => f.path)).toEqual(['staged.txt']);

    const one = await app.call('git.diff', { cwd: repo, path: 'README.md' });
    expect(one.map((f) => f.path)).toEqual(['README.md']);
    const untracked = await app.call('git.diff', { cwd: repo, path: path.join(repo, 'new.txt') });
    expect(untracked.map((f) => f.path)).toEqual(['new.txt']);
    expect(await app.call('git.diff', { cwd: plain })).toEqual([]);
  });

  it('diff caps huge files at ~4000 lines with consistent headers', async () => {
    const huge = path.join(repo, 'huge.txt');
    writeFileSync(huge, Array.from({ length: 6000 }, (_, i) => `l${i}`).join('\n') + '\n');
    const [f] = await app.call('git.diff', { cwd: repo, path: 'huge.txt' });
    const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
    expect(f.hunks[0].newLines).toBe(f.hunks[0].lines.length);
    rmSync(huge);
  });

  it('branches lists most recent first and the current branch', async () => {
    git('checkout', '-q', '-b', 'feature');
    git('commit', '-q', '--allow-empty', '-m', 'later', '--date', '2030-01-01T00:00:00');
    spawnSync('git', ['commit', '-q', '--amend', '--allow-empty', '--no-edit'], {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: '2030-01-01T00:00:00' },
      windowsHide: true,
    });
    const res = await app.call('git.branches', { cwd: repo });
    expect(res.current).toBe('feature');
    expect(res.branches[0]).toBe('feature');
    expect(res.branches.sort()).toEqual(['feature', 'main', 'older']);
    git('checkout', '-q', 'main');
    expect(await app.call('git.branches', { cwd: plain })).toEqual({ branches: [] });
  });

  it('worktrees lists the main checkout first and each linked tree, lanes included', async () => {
    const side = path.join(base, 'side');
    const lane = path.join(base, 'lanes', 'x');
    git('worktree', 'add', '-q', '-b', 'side', side);
    git('worktree', 'add', '-q', '-b', 'lane-x', lane);
    const all = await gitWorktrees(repo);
    expect(all[0].main).toBe(true);
    expect(all[0].branch).toBe('main');
    expect(all.slice(1).every((w) => !w.main)).toBe(true);
    expect(all.map((w) => w.branch).sort()).toEqual(['lane-x', 'main', 'side']);
    const sideTree = all.find((w) => w.branch === 'side');
    expect(sideTree?.path).toBe(path.resolve(side));
    expect(sideTree?.head).toMatch(/^[0-9a-f]{7}$/);
    expect(await gitWorktrees(plain)).toEqual([]);
    git('worktree', 'remove', '--force', lane);
    git('worktree', 'remove', '--force', side);
    git('branch', '-D', 'side', 'lane-x');
  });

  it('status handles detached HEAD', async () => {
    const sha = git('rev-parse', 'HEAD').trim();
    git('checkout', '-q', '--detach');
    const st = await app.call('git.status', { cwd: repo });
    expect(st.branch).toBe(sha.slice(0, 7));
    git('checkout', '-q', 'main');
  });

  it('commit stages everything, passes the message verbatim, and refuses empty or no-op commits', async () => {
    expect(await app.call('git.commit', { cwd: repo, message: '   ' })).toEqual({ ok: false, error: 'Write a commit message first.' });
    expect(await app.call('git.commit', { cwd: plain, message: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/not a git repository/) });

    const message = `-n "quoted" $(echo nope) & | ; \`tick\`\n\n#12 body line`;
    const res = await app.call('git.commit', { cwd: repo, message });
    expect(res).toMatchObject({ ok: true, summary: '-n "quoted" $(echo nope) & | ; `tick`' });
    expect(res.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(git('log', '-1', '--format=%B').trim()).toBe(message);
    expect(git('rev-parse', '--short', 'HEAD').trim()).toBe(res.hash);
    // Untracked and deleted files were included; ignored ones were not.
    const st = await app.call('git.status', { cwd: repo });
    expect(st.files).toEqual([]);
    expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('new.txt');
    expect(git('show', '--name-only', '--format=', 'HEAD')).not.toContain('secret.log');

    expect(await app.call('git.commit', { cwd: repo, message: 'again' })).toEqual({ ok: false, error: 'Nothing to commit.' });
  });
});

// ───────────────────────────── term ─────────────────────────────

describe('term', () => {
  it('streams output and reports exit code 0', async () => {
    const { termId } = await app.call('term.run', { cwd: plain, command: 'echo hello-sable' });
    await until(() => !!exitOf(termId), 'echo exit');
    expect(exitOf(termId)!.code).toBe(0);
    expect(outputOf(termId, 'out')).toContain('hello-sable');
  });

  it('reports a failing exit code and stderr', async () => {
    const command = isWin ? '[Console]::Error.WriteLine("boom"); exit 3' : 'echo boom 1>&2; exit 3';
    const { termId } = await app.call('term.run', { cwd: plain, command });
    await until(() => !!exitOf(termId), 'failing exit');
    expect(exitOf(termId)!.code).toBe(3);
    expect(outputOf(termId, 'err')).toContain('boom');
  });

  it.runIf(isWin)('decodes console tools and reports errors against the command only', async () => {
    const ping = (await app.call('term.run', { cwd: plain, command: 'ping -n 1 127.0.0.1' })).termId;
    const fail = (await app.call('term.run', { cwd: plain, command: 'Get-Item C:\\nope-sable; Write-Output "ü ok"' })).termId;
    await until(() => !!exitOf(ping) && !!exitOf(fail), 'ping and failing command');
    expect(outputOf(ping)).toContain('127.0.0.1');
    expect(outputOf(ping)).not.toContain('\ufffd');
    expect(outputOf(fail, 'out')).toContain('ü ok');
    expect(outputOf(fail, 'err')).toContain('Get-Item C:\\nope-sable');
    expect(outputOf(fail, 'err')).not.toMatch(/OutputEncoding|SABLE_COMMAND|ScriptBlock/);
    expect(exitOf(fail)!.code).toBe(1);
  });

  it('kills a long-running command', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    const { termId } = await app.call('term.run', { cwd: plain, command });
    if (isWin) await until(() => outputOf(termId).includes('127.0.0.1'), 'ping output');
    const t = Date.now();
    expect(await app.call('term.kill', { termId })).toEqual({ ok: true });
    await until(() => !!exitOf(termId), 'killed exit');
    expect(Date.now() - t).toBeLessThan(5000);
    expect(exitOf(termId)!.code).not.toBe(0);
    expect(await app.call('term.kill', { termId })).toEqual({ ok: false });
  });

  it('caps concurrent runs at 6', async () => {
    const command = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    const ids: string[] = [];
    try {
      for (let i = 0; i < 6; i++) ids.push((await app.call('term.run', { cwd: plain, command })).termId);
      await expect(app.call('term.run', { cwd: plain, command })).rejects.toThrow(/limit 6/);
    } finally {
      for (const termId of ids) await app.call('term.kill', { termId });
      await until(() => ids.every((id) => !!exitOf(id)), 'all killed', 10_000);
    }
    // A slot is free again.
    const { termId } = await app.call('term.run', { cwd: plain, command: 'echo again' });
    await until(() => !!exitOf(termId), 'echo after cap');
  }, 20_000);

  it('rejects a missing cwd', async () => {
    await expect(app.call('term.run', { cwd: path.join(base, 'missing'), command: 'echo x' })).rejects.toThrow(/not found/);
  });
});

// ───────────────────────────── memory ─────────────────────────────

describe('memory', () => {
  it('lists claude/demo and codex locations with exists flags', async () => {
    writeFileSync(path.join(plain, 'CLAUDE.md'), 'project rules');
    const claude = await app.call('memory.list', { cwd: plain, provider: 'claude' });
    expect(claude.map((m) => [m.path, m.scope])).toEqual([
      [path.join(userHome, '.claude', 'CLAUDE.md'), 'user'],
      [path.join(plain, 'CLAUDE.md'), 'project'],
      [path.join(plain, '.claude', 'CLAUDE.md'), 'project'],
      [path.join(plain, 'CLAUDE.local.md'), 'local'],
    ]);
    expect(claude[1]).toMatchObject({ exists: true, content: 'project rules' });
    expect(claude[0].exists).toBe(false);
    expect(await app.call('memory.list', { cwd: plain, provider: 'demo' })).toEqual(claude);
    const codex = await app.call('memory.list', { cwd: plain, provider: 'codex' });
    expect(codex.map((m) => [m.path, m.scope, m.exists])).toEqual([
      [path.join(userHome, '.codex', 'AGENTS.md'), 'user', false],
      [path.join(plain, 'AGENTS.md'), 'project', false],
    ]);
  });

  it('writes only memory files, creating parent folders', async () => {
    const target = path.join(userHome, '.claude', 'CLAUDE.md');
    expect(await app.call('memory.write', { path: target, content: 'be nice' })).toEqual({ ok: true });
    expect(readFileSync(target, 'utf8')).toBe('be nice');
    const list = await app.call('memory.list', { cwd: plain, provider: 'claude' });
    expect(list[0]).toMatchObject({ exists: true, content: 'be nice' });
    await app.call('memory.write', { path: path.join(plain, 'AGENTS.md'), content: 'x' });
    await expect(app.call('memory.write', { path: path.join(plain, 'notes.md'), content: 'x' })).rejects.toThrow(/Refusing/);
    await expect(app.call('memory.write', { path: path.join(plain, 'claude.md'), content: 'x' })).rejects.toThrow(/Refusing/);
    await expect(app.call('memory.write', { path: path.join(plain, 'CLAUDE.md.bak'), content: 'x' })).rejects.toThrow(/Refusing/);
  });
});
