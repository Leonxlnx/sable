/** OpenCode's ACP shapes mapped into Sable's model (pure helpers only, no process). */
import { describe, expect, it } from 'vitest';
import { MODES, agentModeFor, commandsOf, contentText, describeCall, effortsOf, inputOf, mapGoLimits, modelsOf, parseAuthList, promptBlocks, resultOf, statusOf, todosOf } from '../server/providers/opencode-map';

describe('models and efforts', () => {
  const option = {
    id: 'model',
    currentValue: 'opencode/big-pickle',
    options: [
      { value: 'opencode/big-pickle', name: 'opencode/Big Pickle' },
      { value: 'opencode/glm-5.3', name: 'opencode/GLM-5.3' },
      { value: 'opencode-go/glm-5.3', name: 'opencode-go/GLM-5.3' },
    ],
  };

  it('drops the provider prefix and lists the models in sections: free first, then Zen, Go, others', () => {
    const models = modelsOf({
      ...option,
      options: [...option.options, { value: 'opencode/tidepool-alpha-free', name: 'opencode/Tidepool Alpha Free' }, { value: 'openai/gpt-5.5', name: 'openai/GPT-5.5' }],
    });
    expect(models.map((m) => `${m.group}: ${m.name}`)).toEqual([
      'Free: Tidepool Alpha Free',
      'OpenCode Zen: Big Pickle',
      'OpenCode Zen: GLM-5.3',
      'OpenCode Go: GLM-5.3',
      'OpenAI: GPT-5.5',
    ]);
    expect(models.find((m) => m.name === 'Big Pickle')?.isDefault).toBe(true);
    const twice = modelsOf({ options: [{ value: 'opencode/beam-free', name: 'opencode/Beam Free' }, { value: 'opencode-go/beam-free', name: 'opencode-go/Beam Free' }] });
    expect(twice.map((m) => m.id)).toEqual(['opencode/beam-free']);
    expect(models.find((m) => m.id === 'opencode-go/glm-5.3')?.id).toBe('opencode-go/glm-5.3');
  });

  it('keeps efforts Sable knows and leaves out "default"', () => {
    const efforts = effortsOf({ id: 'effort', options: ['default', 'low', 'medium', 'high', 'xhigh', 'turbo'].map((value) => ({ value })) });
    expect(efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortsOf(undefined)).toBeUndefined();
    expect(modelsOf(undefined)).toEqual([]);
  });

  it('has Build, Plan and Allow all, and only Plan changes what the agent runs', () => {
    expect(MODES.map((m) => m.id)).toEqual(['build', 'plan', 'allow-all']);
    expect(MODES.find((m) => m.id === 'allow-all')?.tone).toBe('danger');
    expect(agentModeFor('plan')).toBe('plan');
    expect(agentModeFor('allow-all')).toBe('build');
    expect(agentModeFor('default')).toBe('build');
  });

  it('lists the commands the agent announces', () => {
    expect(commandsOf([{ name: 'compact', description: 'Compact the session' }, { nope: 1 }])).toEqual([{ name: 'compact', description: 'Compact the session', argumentHint: undefined, kind: 'command' }]);
    expect(commandsOf(undefined)).toEqual([]);
  });
});

describe('sign-in', () => {
  it('reads stored and environment credentials', () => {
    const out = 'OpenCode Go       OPENCODE_API_KEY            environment\nOpenCode Console  Personal                    stored\n';
    expect(parseAuthList(out)).toEqual({ loggedIn: true, method: 'account', plan: 'OpenCode Console', org: 'Go · Console' });
    expect(parseAuthList('OpenAI   OPENAI_API_KEY   environment')).toEqual({ loggedIn: true, method: 'apiKey', plan: 'OpenAI', org: 'OpenAI' });
  });

  it('runs on free models with no sign-in', () => {
    expect(parseAuthList('')).toEqual({ loggedIn: true, method: 'free', plan: 'Free models', org: 'No sign-in needed' });
  });
});

describe('prompts', () => {
  it('sends text, pasted images and text files', () => {
    const blocks = promptBlocks('look', [
      { id: '1', kind: 'image', name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
      { id: '2', kind: 'text', name: 'n.txt', text: 'hi' },
      { id: '3', kind: 'file', name: 'b.zip', path: 'C:/b.zip' },
    ]);
    expect(blocks[0]).toEqual({ type: 'text', text: 'look\n\n<attachment name="n.txt">\nhi\n</attachment>\n\n[Attached file: C:/b.zip]' });
    expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  });
});

describe('tools', () => {
  it('titles OpenCode tools the way every agent\'s steps are titled', () => {
    expect(describeCall('read', 'read', { path: 'C:\\x\\note.txt' })).toMatchObject({ kind: 'read', title: 'Read note.txt', claudeName: 'Read' });
    expect(describeCall('shell', 'execute', { command: 'npm test' })).toMatchObject({ kind: 'bash', title: 'npm test', detail: { command: 'npm test' } });
    expect(describeCall('glob', 'search', { pattern: '**/*.ts' })).toMatchObject({ kind: 'glob', title: 'Find **/*.ts' });
    expect(describeCall('write', 'edit', { path: 'a.ts', content: 'x' })).toMatchObject({ kind: 'write', title: 'Write a.ts' });
    expect(describeCall('edit', 'edit', { path: 'a.ts', oldString: 'a', newString: 'b' })).toMatchObject({ kind: 'edit', detail: { oldText: 'a', newText: 'b' } });
    expect(describeCall('todowrite', 'other', { todos: [{ content: 'x', status: 'pending' }] })).toMatchObject({ kind: 'todo' });
  });

  it('shows an MCP server\'s tool as one', () => {
    expect(describeCall('github_create_issue', 'other', {})).toMatchObject({ kind: 'mcp', detail: { server: 'github', tool: 'create_issue' } });
  });

  it('knows a tool before its input arrives, and fills it in', () => {
    expect(describeCall('shell', 'execute', {}, 'shell').title).toBe('Run command');
    expect(inputOf({ rawInput: {} }, { command: 'ls' })).toEqual({ command: 'ls' });
    expect(inputOf({ rawInput: { cwd: '/x' } }, { command: 'ls' })).toEqual({ command: 'ls', cwd: '/x' });
    expect(statusOf('in_progress')).toBe('running');
    expect(statusOf('completed')).toBe('done');
    expect(statusOf('failed')).toBe('error');
    expect(statusOf('pending')).toBe('pending');
  });

  it('reads text and exit codes, and builds a diff for a change', () => {
    const update = { content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }], rawOutput: { metadata: { exit: 0 } } };
    expect(contentText(update.content)).toBe('hi\n');
    expect(resultOf('Bash', 'bash', {}, update, false)).toEqual({ text: 'hi\n', exitCode: 0 });
    expect(resultOf('Bash', 'bash', {}, { content: [] }, true)).toEqual({ isError: true });
    const written = resultOf('Write', 'write', { path: 'a.txt', content: 'abc' }, { content: [] }, false);
    expect(written.diff?.[0]).toMatchObject({ path: 'a.txt', status: 'added', additions: 1 });
    const own = resultOf('Edit', 'edit', {}, { content: [{ type: 'diff', path: 'b.txt', oldText: 'a\n', newText: 'b\n' }] }, false);
    expect(own.diff?.[0]).toMatchObject({ path: 'b.txt', status: 'modified', additions: 1, deletions: 1 });
  });

  it('maps a plan to the task list', () => {
    expect(todosOf([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }])).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ]);
  });
});

describe('plan limits', () => {
  it('maps the Go windows with their percent, reset and length', () => {
    const { limits, meta } = mapGoLimits({
      data: { go: { rolling: { percent: 0, limited: false, resetsAt: 1795241332749 }, weekly: { percent: 15, limited: false, resetsAt: 1795392000000 }, monthly: { percent: 45, limited: false, resetsAt: 1796610948000 } }, budgets: [] },
    });
    expect(meta).toEqual({ planLimits: true });
    expect(limits.map((l) => [l.id, l.label, l.percent, l.windowMins])).toEqual([
      ['go-rolling', '5-hour limit', 0, 300],
      ['go-weekly', 'Weekly', 15, 10080],
      ['go-monthly', 'Monthly', 45, 43200],
    ]);
    expect(limits[1].resetsAt).toBe(1795392000000);
  });

  it('a limited window reads as used up, and a missing window is left out', () => {
    const { limits } = mapGoLimits({ data: { go: { rolling: { percent: 80, limited: true, resetsAt: 5 } } } });
    expect(limits).toEqual([{ id: 'go-rolling', label: '5-hour limit', percent: 100, windowMins: 300, resetsAt: 5 }]);
  });

  it('without a Go plan the account has no plan limits', () => {
    expect(mapGoLimits({ data: { go: null } })).toEqual({ limits: [], meta: { planLimits: false } });
    expect(mapGoLimits({ data: {} })).toEqual({ limits: [], meta: { planLimits: false } });
  });
});
