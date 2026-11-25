/** Codex app-server shapes mapped into Sable's model (pure helpers only, no process). */
import { describe, expect, it } from 'vitest';
import { STEER_FIRST_BLOCK } from '@shared/protocol';
import { delegateReport, lostTasksNote, userItemText } from '@shared/synthetic';
import type { TextItem, ThinkingItem, ToolItem, TurnItem, UserItem } from '@shared/protocol';
import {
  activityFor,
  buildInput,
  matchSkill,
  changesToDiffs,
  commandTitle,
  draftItem,
  firstLine,
  mapHistory,
  mapLimits,
  mapMcp,
  mapModel,
  mapPlan,
  preset,
  samePath,
  sandboxPolicy,
  toEffort,
  transcript,
  shortenPaths,
  unwrapCommand,
  warningNotice,
} from '../server/providers/codex-map';

const X = <T>(v: unknown) => v as T;

describe('modes and models', () => {
  it('presets fall back to Ask and map sandboxes', () => {
    expect(preset('full-access')).toMatchObject({ approval: 'never', sandbox: 'danger-full-access' });
    expect(preset('nonsense').id).toBe('default');
    expect(preset(undefined).id).toBe('default');
    expect(sandboxPolicy('read-only')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(sandboxPolicy('danger-full-access')).toEqual({ type: 'dangerFullAccess' });
    expect(sandboxPolicy('workspace-write')).toMatchObject({ type: 'workspaceWrite', writableRoots: [] });
  });

  it('maps models and filters unknown efforts', () => {
    expect(toEffort('xhigh')).toBe('xhigh');
    expect(toEffort('turbo')).toBeUndefined();
    expect(toEffort(null)).toBeUndefined();
    expect(
      mapModel(
        X({
          id: 'm1',
          model: 'gpt-5.5-codex',
          displayName: 'GPT-5.5 Codex',
          description: '',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'bogus' }, { reasoningEffort: 'high' }],
          defaultReasoningEffort: 'high',
          isDefault: true,
        }),
      ),
    ).toEqual({ id: 'gpt-5.5-codex', name: 'GPT-5.5 Codex', description: undefined, efforts: ['low', 'high'], defaultEffort: 'high', supportsFast: false, isDefault: true, picker: true });
    expect(mapModel(X({ id: 'bare', model: '', displayName: '', supportedReasoningEfforts: [] }))).toMatchObject({ id: 'bare', name: 'bare', efforts: undefined });
  });

  it('keeps ultra as the level above max, and drops efforts that are not levels', () => {
    const raw = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].map((reasoningEffort) => ({ reasoningEffort }));
    expect(mapModel(X({ id: 'm', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: raw, defaultReasoningEffort: 'ultra' }))).toMatchObject({
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultEffort: 'ultra',
    });
  });

  it('maps MCP server status, inferring it when there is no runtime yet', () => {
    const base = { name: 'github', tools: { a: { name: 'create_issue', description: 'Create an issue\nmore' } }, authStatus: null, toolsError: null, serverInfo: null };
    expect(mapMcp(X({ ...base, runtimeStatus: 'connected' }))).toMatchObject({ status: 'connected', tools: [{ name: 'create_issue', description: 'Create an issue' }] });
    expect(mapMcp(X({ ...base, runtimeStatus: 'authenticationRequired' })).status).toBe('needs-auth');
    expect(mapMcp(X({ ...base, runtimeStatus: 'starting' })).status).toBe('pending');
    expect(mapMcp(X({ ...base, runtimeStatus: undefined, tools: {}, toolsError: 'spawn failed' }))).toMatchObject({ status: 'failed', error: 'spawn failed' });
    expect(mapMcp(X({ ...base, runtimeStatus: undefined, authStatus: 'notLoggedIn' })).status).toBe('needs-auth');
    expect(mapMcp(X({ ...base, runtimeStatus: undefined, tools: {} })).status).toBe('pending');
  });
});

describe('limits, history, plan', () => {
  it('labels windows and converts reset seconds to ms', () => {
    const limits = mapLimits(
      X([
        { limitId: null, primary: { usedPercent: 34.4, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 120, windowDurationMins: 10080, resetsAt: null } },
        { limitId: 'gpt-5.5', limitName: 'GPT-5.5', primary: { usedPercent: -3, windowDurationMins: 1440, resetsAt: 1_800_000_000_000 }, secondary: null },
      ]),
    );
    expect(limits).toEqual([
      { id: 'codex:primary', label: '5-hour limit', percent: 34, resetsAt: 1_800_000_000_000, windowMins: 300 },
      { id: 'codex:secondary', label: 'Weekly limit', percent: 100, resetsAt: undefined, windowMins: 10080 },
      { id: 'gpt-5.5:primary', label: 'GPT-5.5 · Daily limit', percent: 0, resetsAt: 1_800_000_000_000, windowMins: 1440 },
    ]);
    expect(mapLimits(X([{ primary: { usedPercent: 1, windowDurationMins: 45 } }]))[0].label).toBe('45-minute limit');
    expect(mapLimits(X([{ primary: { usedPercent: 1, windowDurationMins: 4320 } }]))[0].label).toBe('3-day limit');
    expect(mapLimits(X([{ primary: { usedPercent: 1 } }]))[0].label).toBe('Usage limit');
  });

  it('firstLine skips blank lines and clips', () => {
    expect(firstLine('\n\n  hello world  \nnext')).toBe('hello world');
    expect(firstLine('abcdefghij', 5)).toBe('abcd…');
    expect(firstLine('')).toBe('');
  });

  it('mapHistory prefers the name, then the preview', () => {
    const t = { id: 'th1', name: null, preview: '\nFix the flaky test\nmore', cwd: '/r', gitInfo: { branch: 'main' }, createdAt: 100, updatedAt: 200 };
    expect(mapHistory(X(t))).toEqual({ provider: 'codex', providerSessionId: 'th1', title: 'Fix the flaky test', cwd: '/r', branch: 'main', updatedAt: 200_000, preview: 'Fix the flaky test' });
    expect(mapHistory(X({ ...t, name: 'Named', preview: '', updatedAt: null, gitInfo: null }))).toMatchObject({ title: 'Named', updatedAt: 100_000, preview: undefined, branch: undefined });
    expect(mapHistory(X({ ...t, preview: '' })).title).toBe('Untitled thread');
  });

  it('mapPlan converts step statuses', () => {
    expect(mapPlan(X({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Edit', status: 'inProgress' }, { step: 'Test', status: 'pending' }] }))).toEqual([
      { id: '0', content: 'Read', status: 'completed' },
      { id: '1', content: 'Edit', status: 'in_progress' },
      { id: '2', content: 'Test', status: 'pending' },
    ]);
    expect(mapPlan(X({ plan: null }))).toEqual([]);
  });

  it('samePath ignores trailing separators and the \\\\?\\ prefix', () => {
    expect(samePath('/repo/app/', '/repo/app')).toBe(true);
    expect(samePath('/repo/app', '/repo/other')).toBe(false);
    if (process.platform === 'win32') {
      expect(samePath('\\\\?\\C:\\Repo\\App', 'c:\\repo\\app\\')).toBe(true);
    }
  });
});

describe('input', () => {
  const skills = [{ name: 'review', description: 'Review code', path: '/skills/review/SKILL.md' }];

  it('inlines text attachments, references files and adds images', () => {
    const input = buildInput(
      'look at this',
      [
        { id: '1', kind: 'text', name: 'notes.txt', text: 'hello' },
        { id: '2', kind: 'file', name: 'a.ts', path: '/r/a.ts' },
        { id: '3', kind: 'image', name: 'shot.png', dataUrl: 'data:image/png;base64,AA' },
        { id: '4', kind: 'image', name: 'disk.png', path: '/r/disk.png' },
      ],
      [],
    );
    expect(input[0]).toEqual({ type: 'text', text: 'look at this\n\n<attachment name="notes.txt">\nhello\n</attachment>\n\n[Attached file: /r/a.ts]', text_elements: [] });
    expect(input.slice(1)).toEqual([
      { type: 'image', url: 'data:image/png;base64,AA' },
      { type: 'localImage', path: '/r/disk.png' },
    ]);
  });

  it('turns $skill mentions into skill inputs once each', () => {
    const input = buildInput('$review this, then $review again and $unknown', undefined, skills);
    expect(input.filter((i) => i.type === 'skill')).toEqual([{ type: 'skill', name: 'review', path: '/skills/review/SKILL.md' }]);
    expect(buildInput('price is a$review', undefined, skills).filter((i) => i.type === 'skill')).toEqual([]);
  });

  it('matches a skill mention followed by punctuation, preferring the longest name', () => {
    const many = [
      { name: 'review', path: '/r' },
      { name: 'review.deep', path: '/rd' },
      { name: 'reviewer', path: '/rr' },
    ] as typeof skills;
    expect(buildInput('please run $review.', undefined, many).filter((i) => i.type === 'skill')).toEqual([{ type: 'skill', name: 'review', path: '/r' }]);
    expect(matchSkill('review:', many)?.name).toBe('review');
    expect(matchSkill('review.deep.', many)?.name).toBe('review.deep');
    expect(matchSkill('reviewer', many)?.name).toBe('reviewer');
    expect(matchSkill('reviews', many)).toBeUndefined();
  });

  it('matches a plugin skill by the short name the menu inserts, unless two share it', () => {
    const plugins = [
      { name: 'pdf:pdf', path: '/p' },
      { name: 'vercel:deploy', path: '/v' },
      { name: 'netlify:deploy', path: '/n' },
      { name: 'review', path: '/r' },
    ] as typeof skills;
    expect(buildInput('$pdf the report', undefined, plugins).filter((i) => i.type === 'skill')).toEqual([{ type: 'skill', name: 'pdf:pdf', path: '/p' }]);
    expect(matchSkill('pdf:pdf', plugins)?.name).toBe('pdf:pdf');
    expect(matchSkill('pdf.', plugins)?.name).toBe('pdf:pdf');
    expect(matchSkill('deploy', plugins)).toBeUndefined();
    expect(matchSkill('vercel:deploy', plugins)?.name).toBe('vercel:deploy');
    expect(matchSkill('review', plugins)?.name).toBe('review');
  });
});

describe('commands and titles', () => {
  it('unwraps the shell wrappers Codex reports', () => {
    expect(unwrapCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem src'`)).toBe('Get-ChildItem src');
    expect(unwrapCommand('pwsh -NoLogo -NoProfile -Command "npm test"')).toBe('npm test');
    expect(unwrapCommand('cmd.exe /c dir')).toBe('dir');
    expect(unwrapCommand(`/bin/bash -lc 'rg -n "expiresAt" src'`)).toBe('rg -n "expiresAt" src');
    expect(unwrapCommand('zsh -c ls')).toBe('ls');
    expect(unwrapCommand('  git status  ')).toBe('git status');
  });

  it('titles reads, listings and searches from their actions', () => {
    expect(commandTitle('cat a.ts', X([{ type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/r/a.ts' }]))).toBe('Read a.ts');
    expect(
      commandTitle(
        'cat a b',
        X([
          { type: 'read', name: '', path: '/r/a.ts' },
          { type: 'read', name: 'b.ts', path: '/r/b.ts' },
        ]),
      ),
    ).toBe('Read 2 files');
    expect(commandTitle('ls src', X([{ type: 'listFiles', path: '/r/src/' }]))).toBe('List src');
    expect(commandTitle('rg x', X([{ type: 'search', query: 'expiresAt', path: null }]))).toBe('Search “expiresAt”');
    expect(commandTitle('rg', X([{ type: 'search', query: null, path: null }]))).toBe('Search files');
    expect(commandTitle(`bash -lc 'npm   run   build'`, null)).toBe('npm run build');
    expect(commandTitle('x'.repeat(80), [])).toHaveLength(64);
    expect(commandTitle('', [])).toBe('Run command');
  });

  it('activity lines', () => {
    expect(activityFor(X({ type: 'agentMessage' }))).toBe('Writing');
    expect(activityFor(X({ type: 'commandExecution', command: 'bash -lc "npm test"', commandActions: [] }))).toBe('Running npm test');
    expect(activityFor(X({ type: 'fileChange', changes: [{ path: '/r/a.ts' }] }))).toBe('Editing a.ts');
    expect(activityFor(X({ type: 'fileChange', changes: [{ path: 'a' }, { path: 'b' }] }))).toBe('Editing 2 files');
    expect(activityFor(X({ type: 'mcpToolCall', server: 'gh', tool: 'issues' }))).toBe('Calling gh.issues');
    expect(activityFor(X({ type: 'userMessage' }))).toBeUndefined();
  });
});

describe('diffs', () => {
  it('parses unified hunks, renames and whole-file adds and deletes', () => {
    const patch = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
    const diffs = changesToDiffs(
      X([
        { path: '/r/a.ts', kind: { type: 'update', move_path: null }, diff: patch },
        { path: '/r/old.ts', kind: { type: 'update', move_path: '/r/new.ts' }, diff: patch },
        { path: '/r/added.md', kind: { type: 'add' }, diff: 'line 1\nline 2\n' },
        { path: '/r/gone.md', kind: { type: 'delete' }, diff: 'bye\n' },
        { path: '/r/empty.ts', kind: { type: 'update', move_path: null }, diff: '' },
      ]),
    );
    expect(diffs.map((d) => [d.path, d.status, d.additions, d.deletions])).toEqual([
      ['/r/a.ts', 'modified', 1, 1],
      ['/r/new.ts', 'renamed', 1, 1],
      ['/r/added.md', 'added', 2, 0],
      ['/r/gone.md', 'deleted', 0, 1],
      ['/r/empty.ts', 'modified', 0, 0],
    ]);
    expect(diffs[1].oldPath).toBe('/r/old.ts');
    expect(changesToDiffs(null)).toEqual([]);
  });
});

describe('draftItem and transcript', () => {
  it('commands: running, done, failed by exit code', () => {
    const cmd = { type: 'commandExecution', id: 'c1', command: "bash -lc 'npm test'", cwd: '/r', commandActions: [], aggregatedOutput: null, exitCode: null, status: 'inProgress' };
    const running = draftItem(X(cmd)) as ToolItem;
    expect(running).toMatchObject({ type: 'tool', kind: 'bash', title: 'npm test', status: 'running', detail: { command: 'npm test', cwd: '/r' } });
    expect(running.result).toBeUndefined();
    const failed = draftItem(X({ ...cmd, status: 'completed', exitCode: 1, aggregatedOutput: 'FAIL', completedAtMs: 99 })) as ToolItem;
    expect(failed).toMatchObject({ status: 'error', output: 'FAIL', result: { text: 'FAIL', exitCode: 1, isError: true }, endedAt: 99 });
    const ok = draftItem(X({ ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: 'ok' })) as ToolItem;
    expect(ok).toMatchObject({ status: 'done', result: { exitCode: 0, isError: false } });
    expect((draftItem(X({ ...cmd, status: 'declined' })) as ToolItem).status).toBe('denied');
  });

  it('messages, reasoning, file changes, mcp calls and web searches', () => {
    expect(draftItem(X({ type: 'userMessage' }))).toBeNull();
    expect(draftItem(X({ type: 'agentMessage', text: 'Hi' }), { streaming: true })).toEqual({ type: 'text', text: 'Hi', streaming: true });
    const think = draftItem(X({ type: 'reasoning', summary: ['A', 'B'], content: ['raw'] })) as ThinkingItem;
    expect(think).toMatchObject({ type: 'thinking', text: 'A\n\nB', streaming: false });
    const write = draftItem(X({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: '/r/new.md', kind: { type: 'add' }, diff: 'x\n' }] })) as ToolItem;
    expect(write).toMatchObject({ kind: 'write', title: 'Create new.md', status: 'done' });
    const edits = draftItem(X({ type: 'fileChange', id: 'f', status: 'failed', changes: [{ path: 'a', kind: { type: 'update' }, diff: '' }, { path: 'b', kind: { type: 'delete' }, diff: '' }] })) as ToolItem;
    expect(edits).toMatchObject({ kind: 'edit', title: 'Edit 2 files', status: 'error', result: { isError: true } });
    const mcp = draftItem(X({ type: 'mcpToolCall', server: 'gh', tool: 'issues', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'ok' }, { type: 'image' }] }, error: null })) as ToolItem;
    expect(mcp).toMatchObject({ name: 'mcp__gh__issues', kind: 'mcp', title: 'gh · issues', result: { text: 'ok\n[image]' } });
    const mcpErr = draftItem(X({ type: 'mcpToolCall', server: 'gh', tool: 'issues', status: 'failed', error: { message: 'denied' } })) as ToolItem;
    expect(mcpErr.result).toEqual({ text: 'denied', isError: true });
    expect(draftItem(X({ type: 'webSearch', query: '', action: { type: 'openPage', url: 'https://vite.dev' } }))).toMatchObject({ kind: 'fetch', title: 'Open https://vite.dev' });
    expect(draftItem(X({ type: 'webSearch', query: '', action: { type: 'search', query: null, queries: ['a', 'b'] } }), { streaming: true })).toMatchObject({ kind: 'websearch', title: 'Search “a, b”', status: 'running' });
    expect(draftItem(X({ type: 'contextCompaction' }), { streaming: true })).toBeNull();
    expect(draftItem(X({ type: 'contextCompaction' }))).toEqual({ type: 'notice', variant: 'compact', text: 'Context compacted' });
    expect(draftItem(X({ type: 'somethingNew' }))).toMatchObject({ type: 'tool', kind: 'other', title: 'something New' });
  });

  it("imports a person's own reminder block even when Sable appended the same reminder", () => {
    for (const words of [STEER_FIRST_BLOCK, 'I quoted this:\n\n' + STEER_FIRST_BLOCK]) {
      for (const content of [[words], [words, STEER_FIRST_BLOCK]]) {
        const [row] = transcript(X([{ id: 't', items: [{ type: 'userMessage', id: 'u', content: content.map(text => ({ type: 'text', text })) }] }]));
        expect(userItemText(row)).toBe(words);
      }
    }
  });

  it('preserves a quoted report in an ambiguous legacy steer block', () => {
    const words = 'I copied this:\n\n' + delegateReport('Review', 'done', 'Ready');
    const content = [words, STEER_FIRST_BLOCK].map(text => ({ type: 'text', text }));
    const [row] = transcript(X([{ id: 't', items: [{ type: 'userMessage', id: 'u', content }] }]));
    expect(userItemText(row)).toBe(words);
  });

  it('removes a carried report before the file suffix that Codex builds', () => {
    const text = 'review this' + lostTasksNote(['Build']) + '\n\n' + delegateReport('Review', 'done', 'private receipt');
    const content = [...buildInput(text, [{ id: 'f', name: 'notes.txt', kind: 'text', text: 'my notes' }], [], { words: 'review this', start: 0 }), { type: 'text', text: STEER_FIRST_BLOCK }];
    const [row] = transcript(X([{ id: 't', items: [{ type: 'userMessage', id: 'u', content }] }]));
    expect(userItemText(row)).toBe('review this\n\n<attachment name="notes.txt">\nmy notes\n</attachment>');
  });

  it('transcript rebuilds turns with stable ids, cancelling tools left running', () => {
    const items = transcript(
      X([
        {
          id: 'turn1',
          status: 'interrupted',
          startedAt: 100,
          completedAt: 103,
          durationMs: null,
          error: null,
          items: [
            { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'run tests' }, { type: 'localImage', path: '/r/s.png' }] },
            { type: 'reasoning', id: 'r', summary: [], content: [] },
            { type: 'agentMessage', id: 'm', text: 'Running them.' },
            { type: 'commandExecution', id: 'c', command: 'npm test', cwd: '/r', commandActions: [], aggregatedOutput: null, exitCode: null, status: 'inProgress' },
          ],
        },
        { id: 'turn2', status: 'failed', startedAt: 200, completedAt: null, durationMs: 50, error: { message: 'Boom' }, items: [] },
        { id: 'turn3', status: 'inProgress', startedAt: 300, completedAt: null, durationMs: null, error: null, items: [{ type: 'agentMessage', id: 'm', text: 'still going' }] },
      ]),
    );
    expect(items.map((i) => i.id)).toEqual(['turn1:u', 'turn1:m', 'turn1:c', 'turn1:int', 'turn1:turn', 'turn2:turn', 'turn3:m']);
    const user = items[0] as UserItem;
    expect(user).toMatchObject({ type: 'user', text: 'run tests', ts: 100_000, providerId: 'u' });
    expect(user.attachments).toEqual([{ id: 'u:0', kind: 'image', name: 's.png', path: '/r/s.png' }]);
    expect((items[1] as TextItem).text).toBe('Running them.');
    expect((items[2] as ToolItem).status).toBe('cancelled');
    expect(items[3]).toMatchObject({ type: 'notice', variant: 'interrupted' });
    expect(items[4] as TurnItem).toMatchObject({ type: 'turn', durationMs: 3000, stopReason: 'interrupted', ts: 103_000 });
    expect(items[5] as TurnItem).toMatchObject({ durationMs: 50, error: 'Boom' });
  });
});

describe('codex warnings', () => {
  const PATH = String.raw`E:\Codex\.codex\config.toml`;
  const CONFIG = [
    'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.',
    `  user (${PATH}): \`a.b\` is ignored.`,
    `  user (${PATH}): \`c.d\` is ignored.`,
  ].join('\n');

  it('shortens absolute paths to the file name', () => {
    expect(shortenPaths(`user (${PATH}): x`)).toBe('user (config.toml): x');
    expect(shortenPaths('see /home/someone/.codex/config.toml now')).toBe('see config.toml now');
    expect(shortenPaths('in ~/.codex/config.toml')).toBe('in config.toml');
    expect(shortenPaths('a/b and http: fine')).toBe('a/b and http: fine');
  });

  it('shows a warning once per run, without the full path', () => {
    const seen = new Set<string>();
    const n = warningNotice(CONFIG, seen);
    expect(n?.text).toBe('Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.');
    expect(n?.detail).toBe('user (config.toml): `a.b` is ignored.\nuser (config.toml): `c.d` is ignored.');
    // The next thread (or a resume) sends it again: shown no more.
    expect(warningNotice(CONFIG, seen)).toBeNull();
    expect(warningNotice('', seen)).toBeNull();
    expect(warningNotice('Something else', seen)).toEqual({ text: 'Something else', detail: undefined });
  });
});
