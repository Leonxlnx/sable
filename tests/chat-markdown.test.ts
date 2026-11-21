/** Export a chat (server/core/chat-markdown.ts, server/services/export.ts): the Markdown of a Demo conversation, and writing it where the person chooses. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta, TimelineItem } from '@shared/protocol';
import { App } from '../server/app';
import { chatMarkdown, duration, inlineCode, markdownFileName } from '../server/core/chat-markdown';
import { DemoProvider } from '../server/providers/demo';
import { registerExport, type SaveDialog } from '../server/services/export';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function until(pred: () => boolean, what: string, ms = 6000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function demoChat(prompt: string, opts: { showSave?: SaveDialog } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-export-'));
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  registerExport(app, opts);
  cleanups.push(async () => {
    await app.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'bypassPermissions' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  await app.call('session.send', { sessionId: id, text: prompt });
  await until(() => !rt.turnActive && rt.meta.status !== 'running' && rt.meta.status !== 'awaiting' && rt.items.some((i) => i.type === 'turn'), 'the demo turn');
  return { app, id, rt, home };
}

const META: Pick<SessionMeta, 'title' | 'provider' | 'cwd' | 'chat' | 'createdAt'> = { title: 'Fix the login', provider: 'claude', cwd: 'C:\\work\\relay-api', createdAt: Date.UTC(2026, 10, 21, 12) };
let n = 0;
const at = (it: Partial<TimelineItem> & { type: TimelineItem['type'] }) => ({ id: `it-${++n}`, ts: n, ...it }) as TimelineItem;

describe('a Demo conversation as Markdown', () => {
  it('has the person’s message, the agent’s texts and a compact list of its steps, without ids or thinking', async () => {
    const { app, id, rt } = await demoChat('refactor the session module');
    const { markdown, fileName } = await app.call('session.markdown', { sessionId: id });
    expect(fileName).toBe(markdownFileName(rt.meta.title));
    const lines = markdown.split('\n');
    expect(lines[0]).toBe(`# ${rt.meta.title}`);
    expect(lines[2]).toMatch(/^Demo · relay-api · \d{1,2} \w{3} \d{4}$/);
    expect(markdown).toContain('## You\n\nrefactor the session module');
    expect(markdown).toContain('## Demo');
    // Every text the agent wrote is there, in order.
    const texts = rt.items.filter((i) => i.type === 'text' && !i.parentId && i.text.trim()).map((i) => (i as { text: string }).text.trim());
    expect(texts.length).toBeGreaterThan(0);
    let from = 0;
    for (const t of texts) {
      const at = markdown.indexOf(t, from);
      expect(at, t.slice(0, 60)).toBeGreaterThan(-1);
      from = at + t.length;
    }
    // Steps: the commands with their exit codes, the files changed with their counts.
    expect(markdown).toMatch(/\*\*Steps\*\* \(\d+(, [^)]+)?\)/);
    expect(markdown).toContain('- Ran `npm test`: exit 1');
    expect(markdown).toMatch(/- Changed `src\/[^`]+`: \+\d+( −\d+)?/);
    expect(markdown).toMatch(/- Also read \d+ files?/);
    // Nothing internal: no item ids, no thinking, no tool output.
    for (const it of rt.items) expect(markdown).not.toContain(it.id);
    for (const it of rt.items) if (it.type === 'thinking' && it.text.length > 20) expect(markdown).not.toContain(it.text.slice(0, 40));
    expect(markdown).not.toContain('FAIL ');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown).not.toMatch(/\n{3,}/);
  });

  it('notes a widget where the agent showed it', async () => {
    const { app, id, rt } = await demoChat('show me a chart of latency');
    const widget = rt.items.find((i) => i.type === 'tool' && i.kind === 'widget');
    expect(widget).toBeTruthy();
    const { markdown } = await app.call('session.markdown', { sessionId: id });
    const title = (widget as { input?: { title?: string } }).input?.title;
    expect(markdown).toContain(title ? `> Widget: ${title}` : '> Widget');
    expect(markdown).not.toContain('<svg');
    expect(markdown).not.toContain('<script');
  });

  it('writes the file where the person chose, and nothing when they cancel', async () => {
    let answer: string | undefined;
    const asked: string[] = [];
    const { app, id, home } = await demoChat('hi', {
      showSave: async ({ defaultPath }) => {
        asked.push(defaultPath);
        return answer;
      },
    });
    expect(await app.call('session.export', { sessionId: id })).toEqual({ ok: false, canceled: true });
    expect(asked[0]).toMatch(/\.md$/);
    answer = path.join(home, 'out', 'chat');
    const r = await app.call('session.export', { sessionId: id });
    expect(r).toEqual({ ok: true, path: `${answer}.md` });
    expect(readFileSync(`${answer}.md`, 'utf8')).toBe((await app.call('session.markdown', { sessionId: id })).markdown);
    // The next export starts in the folder the last one went to.
    answer = undefined;
    await app.call('session.export', { sessionId: id });
    expect(path.dirname(asked[2])).toBe(path.join(home, 'out'));
  });

  it('has no dialog outside the desktop app: the window downloads instead', async () => {
    const { app, id } = await demoChat('hi');
    expect(await app.call('session.export', { sessionId: id })).toEqual({ ok: false, unsupported: true });
    expect(existsSync(path.join(tmpdir(), 'nothing.md'))).toBe(false);
  });
});

describe('the Markdown builder', () => {
  it('keeps a steer in its turn, a command the person ran, attachments; leaves out what the harness wrote', () => {
    const items = [
      at({ type: 'user', text: 'Fix the login', attachments: [{ id: 'a', kind: 'image', name: 'screen.png' }] }),
      at({ type: 'thinking', text: 'secret thoughts', streaming: false }),
      at({ type: 'text', text: 'Looking at it.', streaming: false }),
      at({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run tests', status: 'done', detail: { command: 'pnpm test\n--run' }, output: 'lots of output', result: { exitCode: 0 } }),
      at({ type: 'user', text: 'also check the logout', steered: true }),
      at({ type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit', status: 'done', detail: { path: 'C:\\work\\relay-api\\src\\auth.ts' }, result: { diff: [{ path: 'C:\\work\\relay-api\\src\\auth.ts', status: 'modified', additions: 3, deletions: 1, hunks: [] }] } }),
      at({ type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit', status: 'done', detail: { path: 'C:\\work\\relay-api\\src\\auth.ts' }, result: { diff: [{ path: 'C:\\work\\relay-api\\src\\auth.ts', status: 'modified', additions: 2, deletions: 0, hunks: [] }] } }),
      at({ type: 'tool', name: 'Write', kind: 'write', title: 'Write', status: 'done', detail: { path: 'C:\\work\\relay-api\\src\\new.ts' }, result: { diff: [{ path: 'C:\\work\\relay-api\\src\\new.ts', status: 'added', additions: 9, deletions: 0, hunks: [] }] } }),
      at({ type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: { path: 'a.ts' } }),
      at({ type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: { path: 'b.ts' } }),
      at({ type: 'tool', name: 'Grep', kind: 'search', title: 'Search', status: 'done', detail: { pattern: 'x' } }),
      at({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Deploy', status: 'denied', detail: { command: 'rm -rf `dist`' } }),
      at({ type: 'text', text: 'Done: login and logout fixed.', streaming: false }),
      at({ type: 'turn', durationMs: 72_000 }),
      at({ type: 'user', text: '<task-notification><summary>Build finished</summary></task-notification>' }),
      at({ type: 'user', text: '<command-name>/compact</command-name>' }),
      at({ type: 'notice', variant: 'compact', text: 'Compacted' }),
    ];
    const md = chatMarkdown(META, items, { timeZone: 'UTC' });
    expect(md).toBe(
      [
        '# Fix the login',
        '',
        'Claude Code · relay-api · 21 Nov 2026',
        '',
        '## You',
        '',
        'Fix the login',
        '',
        '_Attached: screen.png_',
        '',
        '## Claude Code',
        '',
        'Looking at it.',
        '',
        '## You',
        '',
        'also check the logout',
        '',
        '## Claude Code',
        '',
        'Done: login and logout fixed.',
        '',
        '**Steps** (8, 1 min 12 s)',
        '',
        '- Ran `pnpm test …`: exit 0',
        '- Ran `` rm -rf `dist` ``: not allowed',
        '- Changed `src/auth.ts`: +5 −1',
        '- Created `src/new.ts`: +9',
        '- Also read 2 files and searched 1 time',
        '',
        '## You',
        '',
        '`/compact`',
        '',
      ].join('\n'),
    );
  });

  it('counts sub-agents’ edits in the turn, names agent switches, notes plans, questions and errors', () => {
    const agent = at({ type: 'tool', name: 'Task', kind: 'agent', title: 'Explore', status: 'done', detail: { description: 'Explore the auth flow' } });
    const items = [
      at({ type: 'user', text: 'Plan it' }),
      at({ type: 'tool', name: 'ExitPlanMode', kind: 'plan', title: 'Plan', status: 'done', detail: { plan: '1. Read\n2. Fix' } }),
      agent,
      at({ type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit', status: 'done', parentId: agent.id, detail: {}, result: { diff: [{ path: 'src/x.ts', status: 'modified', additions: 1, deletions: 1, hunks: [] }] } }),
      at({ type: 'tool', name: 'AskUserQuestion', kind: 'question', title: 'Ask', status: 'done', detail: { questions: [{ question: 'Which database?', options: [] }] }, result: { answers: { 'Which database?': ['Postgres'] } } }),
      at({ type: 'turn', durationMs: 4000, error: 'Rate limited' }),
      at({ type: 'notice', variant: 'info', text: 'Switched', agentSwitch: { from: 'claude', to: 'codex' } }),
      at({ type: 'user', text: 'Go on' }),
      at({ type: 'text', text: 'On it.', streaming: false }),
    ];
    const md = chatMarkdown({ ...META, provider: 'codex' }, items, { timeZone: 'UTC' });
    expect(md).toContain('## Claude Code\n\n**Plan**\n\n1. Read\n2. Fix');
    expect(md).toContain('> Which database?\n>\n> Answer: Postgres');
    expect(md).toContain('- Agent: Explore the auth flow (1 step)');
    expect(md).toContain('- Changed `src/x.ts`: +1 −1');
    expect(md).toContain('> Error: Rate limited');
    expect(md).toContain('> Switched to Codex\n\n## You\n\nGo on\n\n## Codex\n\nOn it.');
    expect(md.split('\n')[2]).toBe('Codex · relay-api · 21 Nov 2026');
  });

  it('names the file after the chat and codes what has backticks in it', () => {
    expect(markdownFileName('Fix: the <login> / logout?')).toBe('Fix the login logout.md');
    expect(markdownFileName('  ...  ')).toBe('Chat.md');
    expect(inlineCode('a `b` c')).toBe('``a `b` c``');
    expect(inlineCode('`x`')).toBe('`` `x` ``');
    expect(duration(45_000)).toBe('45 s');
    expect(duration(3_723_000)).toBe('1 h 2 min');
  });
});
