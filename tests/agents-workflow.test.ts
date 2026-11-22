import { describe, expect, it } from 'vitest';
import type { RateLimit, ToolItem, WorkflowRun } from '../shared/protocol';
import { agentLimitOf, describeTool, mapResult, mergeWorkflow, resetFromText, workflowMeta, workflowStart } from '../server/providers/claude-tools';
import { workflowProgress } from '../server/providers/claude';
import { agentLine, isAgentLive, workflowLine, workflowProgressText } from '../src/features/timeline/agent-line';
import { appliesTo, limitTitle, modelLimits, windowModel } from '../src/features/usage/scope';

const SCRIPT = `export const meta = {
  name: 'source-anime-sfx',
  description: 'Find & download free sound effects, then audit licenses',
  phases: [
    { title: 'Find', detail: 'one agent per sound group' },
    { title: "Audit", detail: 'verify licenses' },
  ],
}

phase('Find')
const found = await parallel(groups.map((g) => () => agent(\`look for \${g}\`, { label: 'find:' + g })))
`;

describe('workflow mapping', () => {
  it('reads the meta literal of a workflow script', () => {
    expect(workflowMeta(SCRIPT)).toEqual({
      name: 'source-anime-sfx',
      description: 'Find & download free sound effects, then audit licenses',
      phases: [
        { title: 'Find', detail: 'one agent per sound group' },
        { title: 'Audit', detail: 'verify licenses' },
      ],
    });
    expect(workflowMeta(undefined)).toEqual({ phases: [] });
  });

  it('shows a Workflow call as an agent block that works in the background', () => {
    const view = describeTool('Workflow', { script: SCRIPT });
    expect(view.kind).toBe('agent');
    expect(view.detail).toMatchObject({ subagent: 'Workflow', background: true });
    expect(view.title).toBe('Find & download free sound effects, then audit licenses');
    expect(describeTool('Workflow', { name: 'deep-review' }).title).toBe('Deep review');
    const launched = mapResult('Workflow', {}, { status: 'async_launched', taskId: 'w1', taskType: 'local_workflow' }, 'launched', false);
    expect(launched.agent).toEqual({ background: 'running' });
  });

  it('folds the CLI progress rows into phases and agents, latest row per index', () => {
    let run: WorkflowRun = workflowStart({ script: SCRIPT });
    expect(run).toMatchObject({ name: 'source-anime-sfx', phase: 0, agents: [], status: 'running' });
    run = mergeWorkflow(run, [
      { type: 'workflow_phase', index: 1, title: 'Find' },
      { type: 'workflow_agent', index: 1, label: 'find:ambience', phaseIndex: 1, phaseTitle: 'Find', state: 'start', startedAt: 1000 },
      { type: 'workflow_agent', index: 2, label: 'find:sword', phaseIndex: 1, state: 'progress', tokens: 900, toolCalls: 3, lastToolSummary: 'Searching freesound' },
      { type: 'workflow_log', message: 'ignored' },
    ]);
    expect(run.phase).toBe(1);
    expect(run.agents.map((a) => [a.label, a.state])).toEqual([
      ['find:ambience', 'running'],
      ['find:sword', 'running'],
    ]);
    expect(run.agents[1]).toMatchObject({ tokens: 900, steps: 3, activity: 'Searching freesound', phase: 1 });
    run = mergeWorkflow(run, [
      { type: 'workflow_agent', index: 1, label: 'find:ambience', phaseIndex: 1, state: 'done', durationMs: 4000, tokens: 1200 },
      { type: 'workflow_agent', index: 2, label: 'find:sword', phaseIndex: 1, state: 'error', error: 'blocked' },
      { type: 'workflow_phase', index: 2, title: 'Audit' },
      { type: 'workflow_agent', index: 3, label: 'audit:licenses', phaseIndex: 2, state: 'start' },
    ]);
    expect(run.phase).toBe(2);
    expect(run.agents.map((a) => a.state)).toEqual(['done', 'error', 'running']);
    expect(run.agents[0].startedAt).toBe(1000);
    // Known only: the phase of phases, the agents finished of the agents started.
    expect(workflowProgressText(run)).toEqual(['Phase 2 of 2', '2 of 3 agents done']);
  });

  it('takes totals and the end from task events', () => {
    const run = workflowStart({ script: SCRIPT });
    const progressed = workflowProgress(run, { subtype: 'task_progress', usage: { total_tokens: 5000, tool_uses: 12, duration_ms: 9000 }, workflow_progress: [{ type: 'workflow_phase', index: 1, title: 'Find' }] });
    expect(progressed).toMatchObject({ tokens: 5000, steps: 12, phase: 1 });
    const line = workflowLine({ ...progressed, status: 'done', durationMs: 61_000, agents: [{ index: 1, label: 'a', state: 'done' }] });
    expect(line.state).toBe('Done');
    expect(line.parts).toEqual(['1 agent', '5.0k tokens', '1m 1s']);
  });

  it('is live while the run works, though its call returned at once', () => {
    const item = { id: 'w', ts: 0, type: 'tool', name: 'Workflow', kind: 'agent', title: 'x', status: 'done', detail: {}, staged: false, result: { agent: { background: 'running' } }, workflow: workflowStart({ script: SCRIPT }) } as ToolItem;
    expect(isAgentLive(item)).toBe(true);
    expect(isAgentLive({ ...item, workflow: { ...item.workflow!, status: 'done' } })).toBe(false);
  });
});

describe('a sub-agent stopped by a plan limit', () => {
  const now = new Date(2026, 10, 18, 12, 0).getTime();

  it('reads the window and the reset from the CLI words', () => {
    const hit = agentLimitOf("You've hit your Fable limit · resets Nov 22, 12am", now);
    expect(hit?.window).toBe('Weekly · Fable');
    expect(new Date(hit!.resetsAt!).toString()).toBe(new Date(2026, 10, 22, 0, 0).toString());
    expect(agentLimitOf("You've hit your weekly limit", now)).toEqual({ window: 'Weekly · all models' });
    expect(agentLimitOf('You have hit your 5-hour limit · resets 3pm', now)?.window).toBe('5-hour limit');
    expect(agentLimitOf('Found 3 places where the limit is reached.', now)).toBeUndefined();
  });

  it('a reset time already past today is tomorrow', () => {
    expect(new Date(resetFromText('9am', now)!).getDate()).toBe(19);
  });

  it('keeps the limit on the agent result and says so in its line', () => {
    const r = mapResult('Agent', {}, undefined, "You've hit your Fable limit · resets Nov 22, 12am", false);
    expect(r.agent?.limit?.window).toBe('Weekly · Fable');
    const item = { id: 'a', ts: 0, type: 'tool', name: 'Agent', kind: 'agent', title: 'Review', status: 'done', detail: {}, staged: false, result: { agent: { limit: { window: 'Weekly · Fable' }, steps: 2 } }, endedAt: 5000 } as ToolItem;
    const line = agentLine(item, 0);
    expect(line.state).toBe('Stopped');
    expect(line.why).toBe('Fable weekly limit reached');
  });
});

describe('limits by model', () => {
  const now = Date.now();
  const w = (id: string, label: string, percent: number): RateLimit => ({ id, label, percent, resetsAt: now + 3_600_000, windowMins: 10_080 });
  const limits = [w('five_hour', '5-hour limit', 30), w('seven_day', 'Weekly · all models', 50), w('model_Fable', 'Weekly · Fable', 100), w('seven_day_opus', 'Weekly · Opus', 84)];

  it('knows which model a window limits', () => {
    expect(windowModel(limits[0])).toBeUndefined();
    expect(windowModel(limits[2])).toBe('fable');
    expect(windowModel(limits[3])).toBe('opus');
    expect(windowModel({ id: 'gpt-5.3-codex-spark:primary', label: 'GPT-5.3-Codex-Spark · 5-hour', percent: 0 })).toBe('gpt-5.3-codex-spark');
    expect(appliesTo(limits[2], { id: 'claude-opus-5-5', name: 'Opus 5.5' })).toBe(false);
    expect(appliesTo(limits[3], { id: 'claude-opus-5-5', name: 'Opus 5.5' })).toBe(true);
  });

  it('an Opus chat is not red for a full Fable week', () => {
    const opus = modelLimits(limits, { id: 'claude-opus-5-5', name: 'Opus 5.5' }, now);
    expect(opus.level).toBe('near');
    expect(opus.own.map((l) => l.id)).toEqual(['seven_day_opus']);
    expect(opus.other.map((l) => l.id)).toEqual(['model_Fable']);
    expect(opus.otherCap).toBe(true);
    const fable = modelLimits(limits, { id: 'claude-fable-5', name: 'Fable 5' }, now);
    expect(fable.level).toBe('cap');
    // Without a model (the account as a whole): only windows of every model set the level.
    const account = modelLimits(limits, {}, now);
    expect(account.level).toBeUndefined();
    expect(account.otherCap).toBe(true);
  });

  it('names windows as people say them', () => {
    expect(limitTitle('Weekly · Fable')).toBe('Fable weekly limit');
    expect(limitTitle('Weekly · all models')).toBe('Weekly limit');
    expect(limitTitle('5-hour limit')).toBe('5-hour limit');
    expect(limitTitle(undefined)).toBe('Plan limit');
  });
});
