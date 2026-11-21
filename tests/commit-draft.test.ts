import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { cleanCommit, commitPrompt } from '../server/core/commit-draft';

describe('cleanCommit', () => {
  it('keeps a subject and a body, drops the fence, the lead and the quotes', () => {
    expect(cleanCommit('```\nCommit message: "Add folder button."\n\nShow it in the sidebar.\n```')).toBe('Add folder button\n\nShow it in the sidebar.');
    expect(cleanCommit('Fix the queue\nIt dropped the last message.')).toBe('Fix the queue\n\nIt dropped the last message.');
  });

  it('returns null when nothing is left', () => {
    expect(cleanCommit('  \n ')).toBeNull();
    expect(cleanCommit(null)).toBeNull();
  });
});

describe('commitPrompt', () => {
  it('cuts a long diff and says so', () => {
    const p = commitPrompt({ files: ['a.ts'], patch: 'x'.repeat(20_000), subjects: ['Fix'] }, '/repo');
    expect(p.user).toContain('(cut)');
    expect(p.maxTokens).toBeDefined();
    expect(p.cwd).toBe('/repo');
  });
});

describe('git.draft', () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("asks the chat's own agent and account, never another one", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-draft-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const repo = path.join(home, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'dev@example.com');
    git('config', 'user.name', 'Dev');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Start');
    writeFileSync(path.join(repo, 'a.txt'), 'two\n');

    const asked: string[] = [];
    const app = new App({
      home,
      quiet: true,
      providers: [
        (ctx) => {
          const p = new DemoProvider(ctx, { speed: 0 });
          p.quickTitle = async (prompt) => (asked.push(`demo:${ctx.account?.id ?? 'default'}:${prompt.user.includes('a.txt')}`), 'Change a\n\nOne line.');
          return p;
        },
        (ctx) => {
          const p = new DemoProvider(ctx, { speed: 0 }) as unknown as { id: string; name: string; quickTitle: unknown };
          Object.defineProperty(p, 'id', { value: 'claude' });
          p.quickTitle = async () => (asked.push('claude'), 'From another agent');
          return p as never;
        },
      ],
    });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'demo', cwd: repo, mode: 'default' });
    const res = await app.call('git.draft', { sessionId: snap.session.id, cwd: repo });
    expect(res).toEqual({ ok: true, message: 'Change a\n\nOne line.' });
    expect(asked).toEqual(['demo:default:true']);
    // No chat, no draft: nothing is asked of anyone.
    await expect(app.call('git.draft', { sessionId: 'nope', cwd: repo })).rejects.toThrow();
    expect(asked).toHaveLength(1);
  });
});
