/**
 * What a chat still works on once its own turn is over, said the same way everywhere (day 6): a test
 * run the agent waits on is a command, never a sub-agent, and a chat with one is not at rest.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta, TimelineItem, ToolItem } from '../shared/protocol';
import { hasWork, servingLabel, workCounts, workLabel } from '../shared/work-label';
import { statusLabel, statusTone } from '../src/features/sidebar/SessionRow';
import { commandsSince } from '../src/features/timeline/Tail';

const meta = (extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 's', provider: 'claude', cwd: '.', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...extra }) as SessionMeta;

describe('the work label', () => {
  it('reserves serving for the chat and gives working commands priority', () => {
    const s = meta({ serving: 1, servingAddress: 'localhost:3311' });
    expect(servingLabel(s)).toBe('Serving localhost:3311');
    expect(servingLabel({ serving: 2 })).toBe('Serving 2 local servers');
    expect(hasWork(s)).toBe(false);
    expect(workLabel(s)).toBeNull();
    expect(statusTone(s)).toBe('idle');
    expect(statusLabel(s)).toBeNull();
    for (const serving of [0, 1]) {
      const mixed = meta({ serving, commands: 1 });
      expect(hasWork(mixed)).toBe(true);
      expect(workLabel(mixed)).toBe('1 command running');
      expect(statusTone(mixed)).toBe('working');
    }
  });

  it('names commands and sub-agents apart', () => {
    expect(workLabel({ commands: 1 })).toBe('1 command running');
    expect(workLabel({ commands: 3 })).toBe('3 commands running');
    expect(workLabel({ background: 1 })).toBe('1 sub-agent working');
    expect(workLabel({ background: 2 })).toBe('2 sub-agents working');
    expect(workLabel({ background: 2, commands: 1 })).toBe('2 sub-agents, 1 command');
    expect(workLabel({ background: 1, commands: 2 })).toBe('1 sub-agent, 2 commands');
    expect(workLabel({})).toBeNull();
    expect(workLabel({ background: 0, commands: 0 })).toBeNull();
  });

  it('reads only whole positive counts', () => {
    expect(workCounts({ background: -1, commands: Number.NaN })).toEqual({ agents: 0, commands: 0, jobs: 0 });
    // Whatever says nothing in words is no work either: the mark and the label always agree.
    expect(hasWork({ commands: 0.5 })).toBe(false);
    expect(workLabel({ commands: 0.5 })).toBeNull();
    expect(workLabel({ commands: 1.7 })).toBe('1 command running');
    expect(hasWork({})).toBe(false);
  });

  it('the sidebar, the palette and the quick switcher show a chat with a command at work', () => {
    expect(statusTone(meta({ commands: 1 }))).toBe('working');
    expect(statusLabel(meta({ commands: 1 }))).toBe('1 command running');
    expect(statusLabel(meta({ background: 2, commands: 1 }))).toBe('2 sub-agents, 1 command');
    // Its own turn failed, the command still runs: not at rest.
    expect(statusTone(meta({ status: 'error', lastError: 'x', commands: 1 }))).toBe('working');
    // Waiting on the person comes first; a running turn says what it does, and what still works beside it (day 7).
    expect(statusTone(meta({ status: 'awaiting', commands: 1 }))).toBe('awaiting');
    expect(statusLabel(meta({ status: 'running', activity: 'Reading' }))).toBe('Reading');
    expect(statusLabel(meta({ status: 'running', activity: 'Reading', commands: 1 }))).toBe('Reading · 1 command');
    expect(statusLabel(meta({ status: 'starting', background: 2, commands: 1 }))).toBe('Working · 2 sub-agents, 1 command');
    expect(statusTone(meta())).toBe('idle');
    expect(statusLabel(meta())).toBeNull();
  });
});

describe('the tail: how long the oldest command has run', () => {
  const cmd = (id: string, since: number, state: 'running' | 'done' = 'running'): ToolItem =>
    ({ id, ts: since, type: 'tool', name: 'Bash', kind: 'bash', title: id, status: 'done', detail: { background: true }, task: { id: `t-${id}`, kind: 'command', state, since } }) as ToolItem;

  it('follows the items write by write', () => {
    const since = commandsSince();
    const items: Record<string, TimelineItem> = { a: cmd('a', 500), b: cmd('b', 300) };
    expect(since({ items, rev: 1 })).toBe(300);
    items.b = cmd('b', 300, 'done');
    expect(since({ items, rev: 2, changed: { since: 1, ids: ['b'] } })).toBe(500);
    items.c = cmd('c', 100);
    expect(since({ items, rev: 3, changed: { since: 2, ids: ['c'] } })).toBe(100);
    // A new timeline reads every item again.
    expect(since({ items: { d: cmd('d', 900) }, rev: 9 })).toBe(900);
    expect(since({ items: {}, rev: 10 })).toBe(0);
  });
});

describe('the tail line while work goes on after the turn (day 7)', () => {
  it('says what works, monitors apart from commands', async () => {
    const { tailLabel } = await import('../shared/work-label');
    expect(tailLabel({ agents: 2, commands: 0 })).toBe('2 sub-agents working');
    expect(tailLabel({ agents: 1, commands: 0 })).toBe('1 sub-agent working');
    expect(tailLabel({ agents: 0, commands: 1 })).toBe('Waiting for 1 background command');
    expect(tailLabel({ agents: 0, commands: 3 })).toBe('Waiting for 3 background commands');
    expect(tailLabel({ agents: 0, commands: 1, monitors: 1 })).toBe('Waiting for 1 monitor');
    expect(tailLabel({ agents: 0, commands: 2, monitors: 1 })).toBe('Waiting for 1 command, 1 monitor');
    expect(tailLabel({ agents: 2, commands: 1 })).toBe('2 sub-agents, 1 command working');
    expect(tailLabel({ agents: 0, commands: 0 })).toBeNull();
    expect(tailLabel({ agents: 0, commands: 1, monitors: 5 })).toBe('Waiting for 1 monitor');
  });

  it('times all of it from the oldest piece still at work', async () => {
    const { workSince } = await import('../src/features/timeline/Tail');
    const read = workSince();
    const agent = (id: string, ts: number, background: 'running' | 'done'): ToolItem =>
      ({ id, ts, type: 'tool', name: 'Agent', kind: 'agent', title: id, status: 'done', detail: {}, result: { agent: { background } } }) as ToolItem;
    const mon = (id: string, since: number): ToolItem =>
      ({ id, ts: since, type: 'tool', name: 'Monitor', kind: 'other', title: id, status: 'done', detail: {}, task: { id: `t-${id}`, kind: 'monitor', state: 'running', since } }) as ToolItem;
    const items: Record<string, TimelineItem> = { a: agent('a', 400, 'running'), m: mon('m', 600) };
    expect(read({ items, rev: 1 })).toEqual({ since: 400, monitors: 1 });
    items.a = agent('a', 400, 'done');
    expect(read({ items, rev: 2, changed: { since: 1, ids: ['a'] } })).toEqual({ since: 600, monitors: 1 });
    // Nothing changed: the same answer (the tail does not render).
    const same = read({ items, rev: 2, changed: { since: 1, ids: ['a'] } });
    expect(read({ items, rev: 2 })).toBe(same);
  });
});
