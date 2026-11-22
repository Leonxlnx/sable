import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem, UserItem } from '../shared/protocol';
import {
  OPEN_ALL,
  WAVE_ROWS,
  agentIndex,
  commandIndex,
  commandRows,
  commandState,
  isBackgroundCommand,
  liveKey,
  noteIndex,
  overview,
  startsWave,
  userIndex,
  waveOpen,
  waveRows,
  type Timeline,
  type Wave,
} from '../src/features/rail/agents-model';

const tool = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({ id, ts: 0, type: 'tool', name: 'Read', kind: 'read', title: `Read ${id}`, status: 'done', detail: {}, ...extra });
const agent = (id: string, extra: Partial<ToolItem> = {}): ToolItem => tool(id, { name: 'Agent', kind: 'agent', title: `Task ${id}`, detail: { description: `Task ${id}`, subagent: 'Explore' }, ...extra });
const user = (id: string, ts: number, text = `Message ${id}`): UserItem => ({ id, ts, type: 'user', text });
const note = (o: { use: string; status: string; summary: string }) => `<task-notification>\n<task-id>t-${o.use}</task-id>\n<tool-use-id>${o.use}</tool-use-id>\n<status>${o.status}</status>\n<summary>${o.summary}</summary>\n</task-notification>`;

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
}

/** The overview of a timeline, as the tab works it out. */
const see = (t: Tl) => {
  const ids = agentIndex()(t);
  return overview(ids, liveKey(t.items, ids), t.items, userIndex()(t));
};

describe('what names a wave', () => {
  it("is a message the person sent, never one the harness wrote in their place", () => {
    expect(startsWave(user('u', 1, 'Fix the lane tests'))).toBe(true);
    // A slash command the person ran opens a turn of theirs.
    expect(startsWave(user('c', 1, '<command-name>/review</command-name>\n<command-message>review</command-message>'))).toBe(true);
    expect(startsWave(user('n', 1, note({ use: 'x', status: 'completed', summary: 'Background command "Run the send, calm and review scenarios" completed (exit code 0)' })))).toBe(false);
    expect(startsWave(user('o', 1, '<local-command-stdout>Set model to Opus</local-command-stdout>'))).toBe(false);
    expect(startsWave(user('r', 1, '<system-reminder>Nothing to answer.</system-reminder>'))).toBe(false);
    // Sable's own message for a failing /until check.
    expect(startsWave({ ...user('q', 1, 'The check failed'), until: { round: 1 } as never })).toBe(false);
    expect(startsWave(agent('a'))).toBe(false);
  });

  it('keeps agents a notification woke under the message that set the work going', () => {
    // His picture: "Background task finished: Run the send, calm and review scenar…" stood as a heading.
    const t = new Tl()
      .add(user('u1', 100, 'Run the scenarios and review what they find'))
      .add(agent('a1', { ts: 110 }))
      .add(user('n1', 200, note({ use: 'bash1', status: 'completed', summary: 'Background command "Run the send, calm and review scenarios" completed (exit code 0)' })))
      .add(agent('a2', { ts: 210 }))
      .add(agent('a3', { ts: 220 }))
      .add(user('u2', 300, 'Now the phone'))
      .add(agent('a4', { ts: 310 }));
    expect(userIndex()(t)).toEqual(['u1', 'u2']);
    expect(see(t).waves).toEqual([
      { user: 'u2', ids: ['a4'], failed: 0 },
      { user: 'u1', ids: ['a3', 'a2', 'a1'], failed: 0 },
    ]);
  });
});

describe('overview', () => {
  it('puts who works now first, the longest runner on top, and counts what failed', () => {
    const t = new Tl()
      .add(user('u1', 100))
      .add(agent('old', { ts: 110, status: 'running' }))
      .add(agent('ok', { ts: 120 }))
      .add(agent('bad', { ts: 130, status: 'error' }))
      .add(agent('bg', { ts: 140, result: { agent: { background: 'running' } } }))
      .add(agent('late', { ts: 150 }));
    const o = see(t);
    expect(o.working).toEqual(['old', 'bg']);
    expect(o.done).toBe(3);
    expect(o.failed).toBe(1);
    // What failed stands first in its wave, then newest first.
    expect(o.waves).toEqual([{ user: 'u1', ids: ['bad', 'late', 'ok'], failed: 1 }]);
  });

  it('moves an agent from working to its wave when it ends, and nothing else', () => {
    const t = new Tl().add(user('u1', 100)).add(agent('a', { ts: 110, status: 'running' })).add(agent('b', { ts: 120, status: 'running' }));
    expect(see(t).working).toEqual(['a', 'b']);
    t.items = { ...t.items, a: { ...t.items.a, status: 'done', endedAt: 500 } as ToolItem };
    const o = see(t);
    expect(o.working).toEqual(['b']);
    expect(o.waves).toEqual([{ user: 'u1', ids: ['a'], failed: 0 }]);
  });

  it('is cheap for hundreds of agents', () => {
    const t = new Tl();
    for (let w = 0; w < 30; w++) {
      const u = `u${w}`;
      t.items[u] = user(u, w * 1000);
      t.roots.push(u);
      for (let a = 0; a < 20; a++) {
        const id = `a${w}-${a}`;
        t.items[id] = agent(id, { ts: w * 1000 + a + 1, ...(a === 7 ? { status: 'error' as const } : {}) });
        t.roots.push(id);
      }
    }
    const ids = agentIndex()(t);
    const users = userIndex()(t);
    const live = liveKey(t.items, ids);
    const t0 = performance.now();
    const o = overview(ids, live, t.items, users);
    const ms = performance.now() - t0;
    expect(o.done).toBe(600);
    expect(o.waves).toHaveLength(30);
    expect(o.failed).toBe(30);
    expect(ms).toBeLessThan(40);
    // What the tab then draws: the newest wave's rows and a line for each of the others.
    const drawn = o.waves.reduce((n, w, i) => n + 1 + (waveOpen(i, o.done, undefined) ? waveRows(w, false).ids.length : 0), 0);
    expect(drawn).toBeLessThanOrEqual(30 + WAVE_ROWS);
  });
});

describe('folding', () => {
  const wave = (n: number, failed = 0): Wave => ({ user: 'u', ids: Array.from({ length: n }, (_, i) => `a${i}`), failed });

  it('opens the newest wave, and every wave while the list is short', () => {
    expect(waveOpen(0, 500, undefined)).toBe(true);
    expect(waveOpen(1, 500, undefined)).toBe(false);
    expect(waveOpen(3, OPEN_ALL, undefined)).toBe(true);
    expect(waveOpen(3, OPEN_ALL + 1, undefined)).toBe(false);
  });

  it('keeps what the person chose', () => {
    expect(waveOpen(0, 500, false)).toBe(false);
    expect(waveOpen(9, 500, true)).toBe(true);
  });

  it('holds back the rows of a long wave, but never one or two, and never a failure', () => {
    expect(waveRows(wave(WAVE_ROWS + 2), false)).toEqual({ ids: wave(WAVE_ROWS + 2).ids, more: 0 });
    const long = waveRows(wave(127), false);
    expect(long.ids).toHaveLength(WAVE_ROWS);
    expect(long.more).toBe(127 - WAVE_ROWS);
    expect(waveRows(wave(127), true).more).toBe(0);
    // Failures come first in a wave: all eleven of them show.
    expect(waveRows(wave(127, 11), false).ids).toHaveLength(11);
    // A wave where everything failed still stays a short list.
    expect(waveRows(wave(127, 127), false).ids).toHaveLength(24);
  });
});

describe('background commands', () => {
  const bash = (id: string, extra: Partial<ToolItem> = {}): ToolItem => tool(id, { name: 'Bash', kind: 'bash', title: `Run ${id}`, detail: { command: `npm run ${id}`, background: true }, ...extra });

  it('are the shell steps sent to the background, apart from the agents', () => {
    expect(isBackgroundCommand(bash('b'))).toBe(true);
    // The Demo marks it on the input only.
    expect(isBackgroundCommand(tool('d', { kind: 'bash', detail: { command: 'npm test' }, input: { run_in_background: true } }))).toBe(true);
    expect(isBackgroundCommand(tool('f', { kind: 'bash', detail: { command: 'ls' } }))).toBe(false);
    expect(isBackgroundCommand(agent('a', { detail: { background: true } }))).toBe(false);
    const t = new Tl().add(user('u1', 1)).add(bash('build', { ts: 2 })).add(agent('a', { ts: 3 })).add(bash('tests', { ts: 4 }));
    expect(commandIndex()(t)).toEqual(['build', 'tests']);
    expect(agentIndex()(t)).toEqual(['a']);
  });

  it('a call that says it is a background command only in a later patch is found all the same', () => {
    // Claude Code streams a call: the step arrives with empty input, and `run_in_background` comes in a patch.
    const index = commandIndex();
    const t = new Tl().add(user('u1', 1)).add(bash('build', { ts: 2 })).add(tool('late', { kind: 'bash', ts: 3, status: 'running', detail: {}, input: {} }));
    expect(index(t)).toEqual(['build']);
    t.items.late = { ...(t.items.late as ToolItem), input: { run_in_background: true } };
    t.add(bash('tests', { ts: 4 }));
    // In the roots' order, not at the end.
    expect(index(t)).toEqual(['build', 'late', 'tests']);
    // A step that ended in the foreground is looked at no more, and the list keeps its identity.
    const t2 = new Tl().add(tool('fg', { kind: 'bash', ts: 1, status: 'running', detail: {}, input: {} }));
    const i2 = commandIndex();
    const first = i2(t2);
    t2.items.fg = { ...(t2.items.fg as ToolItem), status: 'done' };
    expect(i2(t2)).toBe(first);
    expect(first).toEqual([]);
  });

  it('end as their notification says, and are never called running without word of it', () => {
    const t = new Tl()
      .add(user('u1', 1))
      .add(bash('build', { ts: 2 }))
      .add(bash('tests', { ts: 3 }))
      .add(bash('serve', { ts: 4 }))
      .add(user('n1', 50, note({ use: 'build', status: 'completed', summary: 'Background command "Build the installer" completed (exit code 0)' })))
      .add(user('n2', 60, note({ use: 'tests', status: 'failed', summary: 'Background command "Run the test suite" failed with exit code 1' })));
    const notes = noteIndex()(t);
    expect(notes.get('build')).toEqual({ ts: 50, outcome: 'done', exitCode: 0 });
    expect(notes.get('tests')).toEqual({ ts: 60, outcome: 'failed', exitCode: 1 });
    expect(commandState(t.items.build as ToolItem, notes.get('build'))).toBe('done');
    expect(commandState(t.items.tests as ToolItem, notes.get('tests'))).toBe('failed');
    expect(commandState(t.items.serve as ToolItem, notes.get('serve'))).toBe('unknown');
    expect(commandState(bash('x', { status: 'running' }), undefined)).toBe('starting');
    expect(commandState(bash('x', { status: 'error' }), undefined)).toBe('failed');
    // What failed first, then newest first.
    expect(commandRows(commandIndex()(t), t.items, notes)).toEqual({ ids: ['tests', 'serve', 'build'], failed: 1 });
  });

  it('keeps the same map until another notification arrives', () => {
    const t = new Tl().add(user('u1', 1)).add(bash('build', { ts: 2 }));
    const index = noteIndex();
    const empty = index(t);
    expect(empty.size).toBe(0);
    t.add(tool('r1', { ts: 3 }));
    expect(index(t)).toBe(empty);
    t.add(user('n1', 50, note({ use: 'build', status: 'completed', summary: 'Background command "Build" completed (exit code 0)' })));
    const one = index(t);
    expect(one.size).toBe(1);
    t.add(user('u2', 60));
    expect(index(t)).toBe(one);
  });
});
