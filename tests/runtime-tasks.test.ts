/**
 * SessionRuntime's half of the day-6 contract: background commands and monitors as the bridge's own
 * state (`ToolItem.task`, `SessionMeta.commands`), what is lost with a process and told to the agent,
 * a settle that never turns idle time into work, and a cut turn the bridge knows of (`cutTurn`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, NoticeItem, SessionMeta, ThinkingItem, TimelineItem, ToolItem, TurnItem, UserItem } from '@shared/protocol';
import { lostLine, runsTask, SessionRuntime, worksInBackground } from '../server/core/runtime';

function make() {
  const events: BridgeEvent[] = [];
  const meta: SessionMeta = {
    id: 's1',
    provider: 'claude',
    cwd: '/r',
    title: 'Tests',
    titleSource: 'auto',
    model: 'm',
    mode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const rt = new SessionRuntime(meta, (e) => events.push(structuredClone(e)), () => {});
  const ends: { error?: string; hold?: boolean }[] = [];
  rt.onTurnEnd = (_r, error, opts) => ends.push({ error, hold: opts?.hold });
  let rests = 0;
  rt.onRest = () => rests++;
  const counts = () => events.flatMap((e) => (e.type === 'session.updated' && 'commands' in e.patch ? [e.patch.commands] : []));
  return { rt, events, ends, counts, rests: () => rests };
}

const bash = (extra: Partial<ToolItem> = {}) => ({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run app tests', status: 'done', detail: { command: 'pnpm test', description: 'Run app tests', background: true }, ...extra }) as Omit<ToolItem, 'id' | 'ts'>;

afterEach(() => {
  vi.useRealTimers();
});

describe('background commands', () => {
  it('a step that left a command running is counted apart from sub-agents, until word of its end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { rt, counts, rests } = make();
    const step = rt.add<ToolItem>(bash());
    rt.taskStarted(step.id, { id: 'b1', kind: 'command' });
    expect(rt.get<ToolItem>(step.id)!.task).toEqual({ id: 'b1', kind: 'command', state: 'running', since: 1_000_000 });
    expect(rt.meta.commands).toBe(1);
    // `background` keeps meaning sub-agents and workflows: phones already installed read it so.
    expect(rt.meta.background ?? 0).toBe(0);
    expect(worksInBackground(rt.get(step.id))).toBe(false);
    expect(runsTask(rt.get(step.id))).toBe(true);
    expect(rt.newestCommandAt).toBe(1_000_000);

    // Said again (task_started and the level both name it): nothing changes.
    vi.setSystemTime(1_005_000);
    rt.taskStarted(step.id, { id: 'b1', kind: 'command' });
    expect(rt.get<ToolItem>(step.id)!.task!.since).toBe(1_000_000);
    expect(counts()).toEqual([1]);

    rt.taskEnded('nobody', 'done');
    expect(rt.meta.commands).toBe(1);
    rt.taskEnded('b1', 'failed', 1_200_000);
    expect(rt.get<ToolItem>(step.id)!.task).toEqual({ id: 'b1', kind: 'command', state: 'failed', since: 1_000_000, endedAt: 1_200_000 });
    expect(rt.meta.commands).toBe(0);
    expect(rt.newestCommandAt).toBeUndefined();
    // The last background work ended with no turn running: the chat is at rest.
    expect(rests()).toBe(1);
    // A second end changes nothing.
    rt.taskEnded('b1', 'done');
    expect(rt.get<ToolItem>(step.id)!.task!.state).toBe('failed');
    expect(counts()).toEqual([1, 0]);
  });

  it('is not at rest while a sub-agent still works, and the newest command is the youngest', () => {
    const { rt, rests } = make();
    const agent = rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Map auth', status: 'done', detail: {}, result: { agent: { background: 'running' } } } as Omit<ToolItem, 'id' | 'ts'>);
    const a = rt.add<ToolItem>(bash());
    const b = rt.add<ToolItem>(bash({ title: 'Serve' }));
    rt.taskStarted(a.id, { id: 'a', kind: 'command' });
    rt.taskStarted(b.id, { id: 'm', kind: 'monitor' });
    expect(rt.meta.commands).toBe(2);
    expect(rt.newestCommandAt).toBe(Math.max(rt.get<ToolItem>(a.id)!.task!.since, rt.get<ToolItem>(b.id)!.task!.since));
    rt.taskEnded('a', 'done');
    rt.taskEnded('m', 'stopped');
    expect(rests()).toBe(0);
    rt.patch<ToolItem>(agent.id, { result: { agent: { background: 'done' } } } as Partial<ToolItem>);
    expect(rests()).toBe(1);
  });

  it('a step removed with its command takes it out of the count', () => {
    const { rt } = make();
    const step = rt.add<ToolItem>(bash());
    rt.taskStarted(step.id, { id: 'b1', kind: 'command' });
    rt.remove(step.id);
    expect(rt.meta.commands).toBe(0);
    rt.taskEnded('b1', 'done');
    expect(rt.meta.commands).toBe(0);
  });

  it('a process that went away loses its tasks once, names them for the person and, once, for the agent', () => {
    const { rt } = make();
    const a = rt.add<ToolItem>(bash());
    const b = rt.add<ToolItem>(bash({ title: 'Watch "logs"', detail: {} }));
    const done = rt.add<ToolItem>(bash({ title: 'Build' }));
    rt.taskStarted(a.id, { id: 'b1', kind: 'command' });
    rt.taskStarted(b.id, { id: 'm1', kind: 'monitor' });
    rt.taskStarted(done.id, { id: 'b2', kind: 'command' });
    rt.taskEnded('b2', 'done');

    expect(rt.tasksLost('move')).toEqual(['Run app tests', 'Watch "logs"']);
    expect(rt.get<ToolItem>(a.id)!.task).toMatchObject({ state: 'lost', why: 'move' });
    expect(rt.get<ToolItem>(a.id)!.task!.endedAt).toBeUndefined();
    expect(rt.get<ToolItem>(done.id)!.task!.state).toBe('done');
    expect(rt.meta.commands).toBe(0);
    // Nothing more runs: a second call loses nothing.
    expect(rt.tasksLost('process')).toEqual([]);

    expect(rt.takeLost()).toEqual([`"Run app tests" (command, task b1)`, `"Watch 'logs'" (monitor, task m1)`]);
    expect(rt.takeLost()).toEqual([]);
  });

  it('a lost task whose end is heard after all takes it and is not named to the agent', () => {
    const { rt } = make();
    const a = rt.add<ToolItem>(bash());
    rt.taskStarted(a.id, { id: 'b1', kind: 'command' });
    rt.tasksLost('process');
    rt.taskEnded('b1', 'done', 5);
    expect(rt.get<ToolItem>(a.id)!.task).toMatchObject({ state: 'done', endedAt: expect.any(Number) });
    expect(rt.get<ToolItem>(a.id)!.task!.why).toBeUndefined();
    expect(rt.takeLost()).toEqual([]);
  });

  it('names at most twelve to the agent, then how many more', () => {
    const { rt } = make();
    for (let n = 0; n < 14; n++) rt.taskStarted(rt.add<ToolItem>(bash({ title: `Job ${n}`, detail: {} })).id, { id: `t${n}`, kind: 'command' });
    expect(rt.tasksLost('limit')).toHaveLength(14);
    const told = rt.takeLost();
    expect(told).toHaveLength(13);
    expect(told[12]).toBe('2 more');
  });

  it('says the loss in plain words by why it happened', () => {
    expect(lostLine(1, 'process')).toBe("1 background command was lost with the agent's process");
    expect(lostLine(2, 'move')).toBe('2 background commands were lost when the chat moved');
    expect(lostLine(1, 'restart')).toBe('1 background command was lost when Sable closed');
  });
});

describe('a chat read after a restart', () => {
  it('marks a command still running as lost when Sable closed, counts nothing, and tells the agent next', () => {
    const { rt } = make();
    const items: TimelineItem[] = [
      { id: 'u', ts: 1, type: 'user', text: 'run the tests', state: 'sent' } as UserItem,
      { id: 'b', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run app tests', status: 'done', detail: {}, task: { id: 'b1', kind: 'command', state: 'running', since: 2 } } as ToolItem,
    ];
    // Their names as the person knows them, for the line the bridge writes.
    expect(rt.loadRestored(items)).toEqual(['Run app tests']);
    expect(rt.get<ToolItem>('b')!.task).toEqual({ id: 'b1', kind: 'command', state: 'lost', since: 2, why: 'restart' });
    expect(rt.meta.commands).toBe(0);
    // The changed step goes with the next save.
    const dirty = rt.takeDirty();
    expect(dirty !== 'all' && dirty.has('b')).toBe(true);
    expect(rt.takeLost()).toEqual([`"Run app tests" (command, task b1)`]);
  });

  it('a plain load counts what runs', () => {
    const { rt } = make();
    rt.load([{ id: 'b', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {}, task: { id: 'b1', kind: 'command', state: 'running', since: 2 } } as ToolItem]);
    expect(rt.meta.commands).toBe(1);
    rt.taskEnded('b1', 'done');
    expect(rt.meta.commands).toBe(0);
  });
});

describe('settle never makes idle time work', () => {
  it('a step left running six hours ago gets its status and no end; the settled turn gets its end', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);
    const { rt } = make();
    const old = rt.add<ToolItem>(bash({ status: 'running' }));
    vi.setSystemTime(t0 + 6 * 3600_000);
    rt.beginTurn();
    const now = rt.add<ToolItem>(bash({ status: 'running', title: 'Read' }));
    const think = rt.add<ThinkingItem>({ type: 'thinking', text: 'hmm', streaming: true });
    vi.setSystemTime(t0 + 6 * 3600_000 + 5000);
    rt.settle('cancelled');
    expect(rt.get<ToolItem>(old.id)!.status).toBe('cancelled');
    expect(rt.get<ToolItem>(old.id)!.endedAt).toBeUndefined();
    expect(rt.get<ToolItem>(now.id)).toMatchObject({ status: 'cancelled', endedAt: t0 + 6 * 3600_000 + 5000 });
    expect(rt.get<ThinkingItem>(think.id)).toMatchObject({ streaming: false, endedAt: t0 + 6 * 3600_000 + 5000 });
  });

  it('leaves a sub-agent that still works and a step whose command runs as they are', () => {
    const { rt } = make();
    rt.beginTurn();
    const agent = rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Map auth', status: 'done', detail: {}, result: { agent: { background: 'running' } } } as Omit<ToolItem, 'id' | 'ts'>);
    const child = rt.add<ToolItem>(bash({ status: 'running', parentId: agent.id }));
    const grandchild = rt.add<ToolItem>(bash({ status: 'running', parentId: child.id }));
    const served = rt.add<ToolItem>(bash({ status: 'running' }));
    rt.taskStarted(served.id, { id: 'srv', kind: 'command' });
    const plain = rt.add<ToolItem>(bash({ status: 'running' }));
    rt.settle('cancelled');
    expect(rt.get<ToolItem>(child.id)!.status).toBe('running');
    expect(rt.get<ToolItem>(grandchild.id)!.status).toBe('running');
    expect(rt.get<ToolItem>(served.id)!.status).toBe('running');
    expect(rt.get<ToolItem>(plain.id)!.status).toBe('cancelled');
  });

  it('in a chat read from disk, a straggler after the last turn record ends with no time', () => {
    const { rt } = make();
    rt.load([
      { id: 'u', ts: 1, type: 'user', text: 'hi', state: 'sent' } as UserItem,
      { id: 'b', ts: 2, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} } as ToolItem,
      { id: 't', ts: 3, type: 'turn', durationMs: 2 } as TurnItem,
    ]);
    rt.settle('cancelled');
    expect(rt.get<ToolItem>('b')).toMatchObject({ status: 'cancelled' });
    expect(rt.get<ToolItem>('b')!.endedAt).toBeUndefined();
  });
});

describe('a turn the bridge knows was cut', () => {
  const notices = (rt: SessionRuntime) => rt.items.filter((i): i is NoticeItem => i.type === 'notice');

  it('died: settles its steps at the cut, says "Ended early" with the reason and ends the turn with the queue held', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { rt, ends } = make();
    rt.beginTurn();
    const step = rt.add<ToolItem>(bash({ status: 'running' }));
    vi.setSystemTime(20_000);
    rt.cutTurn('died', { detail: 'Claude Code exited with code 1' });
    expect(rt.get<ToolItem>(step.id)).toMatchObject({ status: 'cancelled', endedAt: 20_000 });
    const [n] = notices(rt);
    expect(n).toMatchObject({ variant: 'info', text: 'Ended early', early: 'died', ts: 20_000 });
    expect(n.detail).toBe("The agent's process ended by itself while it worked.\n\nClaude Code exited with code 1");
    expect(rt.turnActive).toBe(false);
    expect(rt.meta.status).toBe('idle');
    expect(ends).toEqual([{ error: undefined, hold: true }]);
  });

  it('closed: the process is gone, so background work it held is settled too', () => {
    const { rt } = make();
    rt.beginTurn();
    const agent = rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Map auth', status: 'done', detail: {}, result: { agent: { background: 'running' } } } as Omit<ToolItem, 'id' | 'ts'>);
    const child = rt.add<ToolItem>(bash({ status: 'running', parentId: agent.id }));
    rt.stopBackground();
    rt.cutTurn('closed', { at: Date.now() });
    expect(rt.get<ToolItem>(child.id)!.status).toBe('cancelled');
    expect(notices(rt)[0]).toMatchObject({ early: 'closed', detail: "Sable closed the agent's process while it worked." });
  });

  it('no turn open: settles what was left running in the process and writes nothing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { rt, ends } = make();
    rt.beginTurn();
    rt.endTurn();
    vi.setSystemTime(11_000);
    // Work the agent did by itself after its turn, cut with its process.
    const step = rt.add<ToolItem>(bash({ status: 'running' }));
    vi.setSystemTime(12_000);
    rt.cutTurn('died');
    expect(rt.get<ToolItem>(step.id)).toMatchObject({ status: 'cancelled', endedAt: 12_000 });
    expect(notices(rt)).toEqual([]);
    expect(ends).toHaveLength(1);
  });

  it('restart: written from the load path with the time of the turn\'s last item, once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000_000);
    const { rt, ends } = make();
    rt.loadRestored([
      { id: 'u0', ts: 100, type: 'user', text: 'first', state: 'sent' } as UserItem,
      { id: 'old', ts: 150, type: 'tool', name: 'Bash', kind: 'bash', title: 'Old', status: 'running', detail: {} } as ToolItem,
      { id: 't0', ts: 200, type: 'turn', durationMs: 100 } as TurnItem,
      { id: 'u', ts: 1000, type: 'user', text: 'run it', state: 'sent' } as UserItem,
      { id: 'b', ts: 1500, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} } as ToolItem,
      { id: 'x', ts: 1800, type: 'text', text: 'Now the CSS.' } as TimelineItem,
    ]);
    rt.cutTurn('restart', { at: 1800 });
    expect(rt.get<ToolItem>('b')).toMatchObject({ status: 'cancelled', endedAt: 1800 });
    // Older than the cut turn: its status, never an end of hours later.
    expect(rt.get<ToolItem>('old')!.status).toBe('cancelled');
    expect(rt.get<ToolItem>('old')!.endedAt).toBeUndefined();
    expect(notices(rt)).toMatchObject([{ variant: 'info', text: 'Ended early', early: 'restart', ts: 1800, detail: 'Sable closed while the agent worked.' }]);
    rt.cutTurn('restart', { at: 1800 });
    expect(notices(rt)).toHaveLength(1);
    expect(ends).toEqual([]);
  });
});
