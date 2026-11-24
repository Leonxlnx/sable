import { describe, expect, it } from 'vitest';
import type { ToolItem } from '@shared/protocol';
import { agentLine, agentProvider, agentTrail, agentType, readTrail } from '@/features/timeline/agent-line';
import { mapResult, splitAgentUsage } from '../server/providers/claude-tools';
import { taskFigures } from '../server/providers/claude';

const agent = (extra: Partial<ToolItem> = {}): ToolItem => ({ id: 'a', ts: 1000, type: 'tool', name: 'Agent', kind: 'agent', title: 'Map auth', status: 'done', detail: {}, ...extra });

describe('a sub-agent result keeps its figures', () => {
  it('reads tokens, steps and time from the structured result', () => {
    const r = mapResult('Agent', {}, { status: 'completed', content: [{ type: 'text', text: 'Report' }], totalTokens: 41234, totalToolUseCount: 14, totalDurationMs: 72000 }, 'Report', false);
    expect(r).toEqual({ text: 'Report', agent: { tokens: 41234, steps: 14, durationMs: 72000 } });
  });

  it('reads them from the text a stored transcript keeps, and leaves them out of the report', () => {
    const text = "Report line\n\nagentId: abc123 (use SendMessage with to: 'abc123' to continue this agent)\n<usage>total_tokens: 9100\ntool_uses: 3\nduration_ms: 15000</usage>";
    expect(splitAgentUsage(text)).toEqual({ text: 'Report line', stats: { tokens: 9100, steps: 3, durationMs: 15000 } });
    expect(mapResult('Task', {}, undefined, text, false)).toEqual({ text: 'Report line', agent: { tokens: 9100, steps: 3, durationMs: 15000 } });
    expect(splitAgentUsage('Just a report')).toEqual({ text: 'Just a report', stats: {} });
  });

  it('a background launch is marked as still working and shows no placeholder text', () => {
    const r = mapResult('Agent', { run_in_background: true }, { status: 'async_launched', agentId: 'x', description: 'd' }, 'Async agent launched successfully.', false);
    // The agent's own id is kept with the step, so a later resume of the same agent (SendMessage) finds its row.
    expect(r).toEqual({ agent: { taskId: 'x', background: 'running' } });
  });

  it('task events give only the figures they carry', () => {
    expect(taskFigures({ total_tokens: 5, tool_uses: 2, duration_ms: 900 })).toEqual({ tokens: 5, steps: 2, durationMs: 900 });
    expect(taskFigures(undefined)).toEqual({});
  });
});

describe('agentLine', () => {
  it('says done with steps, tokens when known, and time', () => {
    expect(agentLine(agent({ endedAt: 73000, result: { agent: { tokens: 41234, steps: 14 } } }), 9)).toEqual({ state: 'Done', parts: ['14 steps', '41k tokens', '1m 12s'] });
    // No figures from the agent: the steps seen under it and its own running time, no tokens.
    expect(agentLine(agent({ endedAt: 6000, waitedMs: 2000 }), 5)).toEqual({ state: 'Done', parts: ['5 steps', '3s'] });
  });

  it('names every other end', () => {
    expect(agentLine(agent({ status: 'error', endedAt: 3000 }), 2)).toEqual({ state: 'Failed', tone: 'error', parts: ['2 steps', '2s'] });
    expect(agentLine(agent({ status: 'cancelled', endedAt: 3000 }), 0).state).toBe('Interrupted');
    expect(agentLine(agent({ status: 'denied', endedAt: 3000 }), 0)).toEqual({ state: 'Denied', parts: [] });
  });

  it('a background agent says it is still working, without the time of the call that started it', () => {
    expect(agentLine(agent({ endedAt: 1100, result: { agent: { background: 'running', steps: 2, tokens: 9300 } } }), 2)).toEqual({ state: 'Working in the background', parts: ['2 steps', '9.3k tokens'] });
    expect(agentLine(agent({ endedAt: 1100, result: { agent: { background: 'done', steps: 8, tokens: 20000, durationMs: 65000 } } }), 8)).toEqual({ state: 'Done', parts: ['8 steps', '20k tokens', '1m 5s'] });
    expect(agentLine(agent({ endedAt: 90000, detail: { background: true } }), 0)).toEqual({ state: 'Started in the background', parts: [] });
  });
});

describe('who a sub-agent is', () => {
  it('names the kind in plain words, and the other agent by its name', () => {
    expect(agentType(agent({ detail: { subagent: 'Explore' } }))).toBe('Explore');
    expect(agentType(agent({ detail: { subagent: 'general-purpose' } }))).toBe('General purpose');
    expect(agentType(agent({ detail: { subagent: 'design-taste:design-reviewer' } }))).toBe('Design reviewer');
    const codex = agent({ name: 'mcp__sable__delegate_to_codex', detail: { subagent: 'Codex' } });
    expect(agentProvider(codex)).toBe('codex');
    expect(agentType(codex)).toBe('Codex');
    // Codex's own sub-agents carry a model id: never shown.
    expect(agentType(agent({ name: 'spawnAgent', detail: { subagent: 'gpt-5.2-codex' } }))).toBe('');
  });
});

describe('agentTrail', () => {
  const items = { t1: { type: 'tool' }, t2: { type: 'tool' }, t3: { type: 'tool' }, t4: { type: 'tool' }, h: { type: 'thinking' }, x: { type: 'text' } };

  it('keeps the latest steps and counts all of them', () => {
    expect(readTrail(agentTrail(items, ['h', 't1', 't2', 't3', 't4'], 3))).toEqual({ steps: 4, ids: ['t2', 't3', 't4'], now: '' });
  });

  it('what it does now takes one of the places', () => {
    expect(readTrail(agentTrail(items, ['t1', 't2', 't3', 't4', 'x'], 3))).toEqual({ steps: 4, ids: ['t3', 't4'], now: 'Writing the report' });
    expect(readTrail(agentTrail(items, ['h'], 3))).toEqual({ steps: 0, ids: [], now: 'Thinking' });
    expect(readTrail(agentTrail(items, [], 3))).toEqual({ steps: 0, ids: [], now: 'Starting' });
  });
});
