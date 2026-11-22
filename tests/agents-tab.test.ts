import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem, UserItem, WorkflowRun } from '../shared/protocol';
import { agentIndex, figuresOf, groupDone, grow, latestSteps, liveKey, outcomeOf, progressIndex, promptLine, readProgress, stepCount, userIndex, workflowNow, type Timeline } from '../src/features/rail/agents-model';

const tool = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({ id, ts: 0, type: 'tool', name: 'Read', kind: 'read', title: `Read ${id}`, status: 'done', detail: {}, ...extra });
const agent = (id: string, extra: Partial<ToolItem> = {}): ToolItem => tool(id, { name: 'Agent', kind: 'agent', title: `Task ${id}`, detail: { description: `Task ${id}`, subagent: 'Explore' }, ...extra });
const user = (id: string, ts: number, text = `Message ${id}`): UserItem => ({ id, ts, type: 'user', text });

/** A small store-like timeline that changes the way the store does: a new array where an item joins. */
class Tl implements Timeline {
  items: Record<string, TimelineItem> = {};
  roots: string[] = [];
  children: Record<string, string[]> = {};
  add(item: TimelineItem) {
    this.items = { ...this.items, [item.id]: item };
    if (item.parentId) this.children = { ...this.children, [item.parentId]: [...(this.children[item.parentId] ?? []), item.id] };
    else this.roots = [...this.roots, item.id];
    return this;
  }
  patch(id: string, patch: Partial<ToolItem>) {
    this.items = { ...this.items, [id]: { ...this.items[id], ...patch } as TimelineItem };
    return this;
  }
}

describe('grow', () => {
  it('scans only what joined, and keeps the found array while nothing new matches', () => {
    let seen = 0;
    const pick = (id: string) => (seen++, id.startsWith('a') ? id : undefined);
    const one = grow(undefined, ['a1', 'x1'], pick);
    expect(one.found).toEqual(['a1']);
    seen = 0;
    const two = grow(one, ['a1', 'x1', 'x2'], pick);
    expect(seen).toBe(1);
    expect(two.found).toBe(one.found);
    const three = grow(two, ['a1', 'x1', 'x2', 'a2'], pick);
    expect(three.found).toEqual(['a1', 'a2']);
    // A list that did not just grow (a removal, a reset) is scanned again.
    expect(grow(three, ['x1', 'a2'], pick).found).toEqual(['a2']);
  });
});

describe('agentIndex', () => {
  it('lists agents at the top level and nested, oldest first, and holds its array through steps', () => {
    const t = new Tl().add(user('u1', 1)).add(agent('A', { ts: 10 })).add(tool('s1', { parentId: 'A', ts: 11 })).add(agent('B', { ts: 12 }));
    const index = agentIndex();
    const first = index(t);
    expect(first).toEqual(['A', 'B']);
    // A streamed patch (same arrays) and a new step (a new children array, no new agent): same array back.
    t.patch('s1', { status: 'running' });
    expect(index(t)).toBe(first);
    t.add(tool('s2', { parentId: 'A', ts: 13 }));
    expect(index(t)).toBe(first);
    // A sub-agent of a sub-agent joins in time order.
    t.add(agent('C', { parentId: 'A', ts: 11.5 }));
    expect(index(t)).toEqual(['A', 'C', 'B']);
  });

  it('costs one look per new item, not a scan of the whole session', () => {
    // Built in bulk (the store's copy per item is not what is measured here).
    const t = new Tl();
    for (let a = 0; a < 35; a++) {
      const id = `A${a}`;
      t.items[id] = agent(id, { ts: a * 1000 });
      t.roots.push(id);
      const kids: string[] = (t.children[id] = []);
      for (let s = 0; s < 200; s++) {
        t.items[`${id}-s${s}`] = tool(`${id}-s${s}`, { parentId: id, ts: a * 1000 + s });
        kids.push(`${id}-s${s}`);
      }
    }
    const index = agentIndex();
    expect(index(t)).toHaveLength(35);
    let reads = 0;
    const counted = new Proxy(t.items, {
      get(target, key) {
        reads++;
        return Reflect.get(target, key);
      },
    });
    t.add(tool('late', { parentId: 'A3', ts: 3500 }));
    index({ items: counted, roots: t.roots, children: t.children });
    // The new step, and the ts of each agent for the order: nowhere near the 7000 items.
    expect(reads).toBeLessThan(200);
  });
});

describe('userIndex', () => {
  it('keeps the ids of the messages, the same array until one is sent', () => {
    const t = new Tl().add(user('u1', 1)).add(agent('A', { ts: 2 }));
    const index = userIndex();
    const a = index(t);
    expect(a).toEqual(['u1']);
    t.add(tool('r1', { ts: 3 }));
    expect(index(t)).toBe(a);
    t.add(user('u2', 4));
    expect(index(t)).toEqual(['u1', 'u2']);
  });
});

describe('liveKey', () => {
  it('marks what works now, including background agents and running workflows', () => {
    const run: WorkflowRun = { phases: [], phase: 1, agents: [], status: 'running' };
    const items = {
      a: agent('a', { status: 'running' }),
      b: agent('b'),
      c: agent('c', { result: { agent: { background: 'running' } } }),
      d: agent('d', { workflow: run }),
      e: agent('e', { workflow: { ...run, status: 'done' } }),
    };
    expect(liveKey(items, ['a', 'b', 'c', 'd', 'e'])).toBe('10110');
  });
});

describe('progressIndex', () => {
  it('says what it does now and counts its steps as they join', () => {
    const t = new Tl().add(agent('A', { status: 'running' }));
    const p = progressIndex();
    expect(readProgress(p(t.items, t.children.A))).toEqual({ steps: 0, now: '' });
    t.add(tool('s1', { parentId: 'A', title: 'Read session.ts' })).add(tool('s2', { parentId: 'A', title: 'Run the tests', kind: 'bash' }));
    expect(readProgress(p(t.items, t.children.A))).toEqual({ steps: 2, now: 'Run the tests' });
    t.add({ id: 'th', ts: 0, type: 'thinking', text: '…', streaming: true, parentId: 'A' });
    expect(readProgress(p(t.items, t.children.A)).now).toBe('Thinking');
    t.add({ id: 'tx', ts: 0, type: 'text', text: 'Found', streaming: true, parentId: 'A' });
    expect(readProgress(p(t.items, t.children.A)).now).toBe('Writing the report');
  });

  it('shows its own task list as progress when it keeps one', () => {
    const t = new Tl().add(agent('A', { status: 'running' }));
    const p = progressIndex();
    t.add(
      tool('todo', {
        parentId: 'A',
        kind: 'todo',
        title: 'Update the task list',
        detail: {
          todos: [
            { content: 'a', status: 'completed' },
            { content: 'b', status: 'in_progress' },
            { content: 'c', status: 'pending' },
          ],
        },
      }),
    );
    expect(readProgress(p(t.items, t.children.A)).todo).toEqual({ done: 1, total: 3 });
  });

  it('returns the same string while nothing it shows changed', () => {
    const t = new Tl().add(agent('A', { status: 'running' })).add(tool('s1', { parentId: 'A' }));
    const p = progressIndex();
    const a = p(t.items, t.children.A);
    t.patch('s1', { output: 'more output' });
    expect(p(t.items, t.children.A)).toBe(a);
  });
});

describe('latestSteps and stepCount', () => {
  it('lists the latest steps oldest first, skipping text', () => {
    const t = new Tl().add(agent('A'));
    for (let i = 0; i < 8; i++) t.add(tool(`s${i}`, { parentId: 'A' }));
    t.add({ id: 'tx', ts: 0, type: 'text', text: 'Report', streaming: false, parentId: 'A' });
    expect(latestSteps(t.items, t.children.A, 3)).toBe('s5,s6,s7');
    expect(stepCount(t.items, t.children.A)).toBe(8);
  });
});

describe('outcomes and figures', () => {
  it('reads how an agent ended', () => {
    expect(outcomeOf(agent('a'))).toBe('done');
    expect(outcomeOf(agent('a', { status: 'error' }))).toBe('failed');
    expect(outcomeOf(agent('a', { result: { agent: { background: 'failed' } } }))).toBe('failed');
    expect(outcomeOf(agent('a', { result: { agent: { background: 'stopped' } } }))).toBe('stopped');
    expect(outcomeOf(agent('a', { result: { agent: { limit: { window: 'Weekly · Demo Deep' } } } }))).toBe('stopped');
    expect(outcomeOf(agent('a', { status: 'cancelled' }))).toBe('interrupted');
    expect(outcomeOf(agent('a', { status: 'denied' }))).toBe('denied');
    expect(outcomeOf(agent('a', { detail: { background: true } }))).toBe('unknown');
    const run: WorkflowRun = { phases: [], phase: 1, agents: [], status: 'failed' };
    expect(outcomeOf(agent('w', { workflow: run }))).toBe('failed');
    expect(outcomeOf(agent('w', { workflow: { ...run, status: 'done' } }))).toBe('done');
  });

  it("takes the agent's own figures, and the call's time only for a call that waited for it", () => {
    expect(figuresOf(agent('a', { result: { agent: { tokens: 363_000, steps: 178, durationMs: 2_693_000 } } }))).toEqual({ ms: 2_693_000, tokens: 363_000, steps: 178 });
    expect(figuresOf(agent('a', { ts: 1000, endedAt: 61_000, waitedMs: 10_000 })).ms).toBe(50_000);
    // Sent to the background: the call's own time says nothing.
    expect(figuresOf(agent('a', { ts: 1000, endedAt: 2000, result: { agent: { background: 'done' } } })).ms).toBe(0);
    const run: WorkflowRun = { phases: [], phase: 2, agents: [{ index: 1, label: 'a', state: 'done' }, { index: 2, label: 'b', state: 'error' }], status: 'done', tokens: 5000, durationMs: 90_000 };
    expect(figuresOf(agent('w', { workflow: run }))).toMatchObject({ ms: 90_000, tokens: 5000, agents: 2, failed: 1 });
  });
});

describe('groupDone', () => {
  it('puts each agent under the message that started it, newest first', () => {
    const items: Record<string, TimelineItem> = {
      u1: user('u1', 100),
      u2: user('u2', 200),
      a: agent('a', { ts: 110 }),
      b: agent('b', { ts: 120 }),
      c: agent('c', { ts: 210 }),
      z: agent('z', { ts: 50 }),
    };
    expect(groupDone(['z', 'a', 'b', 'c'], items, ['u1', 'u2'])).toEqual([
      { user: 'u2', ids: ['c'] },
      { user: 'u1', ids: ['b', 'a'] },
      { user: '', ids: ['z'] },
    ]);
  });

  it('goes by where things stand, not by when a message was sent: an agent started before the agent took a message is not under it', () => {
    // u2 was sent into the running turn at 105 and taken after agent a had started: it stands behind a.
    const items: Record<string, TimelineItem> = {
      u1: user('u1', 100),
      a: agent('a', { ts: 110 }),
      n: agent('n', { ts: 112, parentId: 'a' }),
      u2: user('u2', 105),
      b: agent('b', { ts: 130 }),
    };
    const roots = ['u1', 'a', 'u2', 'b'];
    expect(groupDone(['a', 'n', 'b'], items, ['u1', 'u2'], roots)).toEqual([
      { user: 'u2', ids: ['b'] },
      // The nested agent stands where its parent does.
      { user: 'u1', ids: ['n', 'a'] },
    ]);
    // By the times alone a and its child would be filed under the message they never saw.
    expect(groupDone(['a', 'n', 'b'], items, ['u1', 'u2'])[0]).toEqual({ user: 'u2', ids: ['b', 'n', 'a'] });
  });
});

describe('workflowNow', () => {
  it('names the phase and what one of its agents does', () => {
    const run: WorkflowRun = {
      phases: [{ title: 'Survey' }, { title: 'Fix' }, { title: 'Verify' }],
      phase: 2,
      status: 'running',
      agents: [
        { index: 1, label: 'survey:a', phase: 1, state: 'done' },
        { index: 2, label: 'fix:a', phase: 2, state: 'running', activity: 'Edit errors.ts' },
        { index: 3, label: 'fix:b', phase: 2, state: 'queued' },
      ],
    };
    expect(workflowNow(run)).toEqual({ phase: 'Phase 2 of 3', title: 'Fix', doing: 'Edit errors.ts', done: 1, agents: 3 });
  });
});

describe('promptLine', () => {
  it('keeps the first line, short', () => {
    expect(promptLine('  Fix the login\nand more')).toBe('Fix the login');
    expect(promptLine('x'.repeat(120))).toHaveLength(90);
    expect(promptLine('   ')).toBe('Message');
  });
});
