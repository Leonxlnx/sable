/**
 * Day 7 (win), review window-F2: the Agents tab's Commands head, the bar's "N commands running", the
 * row order and the fold follow a command's own state. The bridge patches a command's step in place
 * (its task started, lost with its process, reconciled as stopped) and writes no new list: what the
 * tab reads (`commandsView`, the selector it subscribes with) must still change.
 */
import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '../shared/protocol';
import { commandIndex, commandsView, noteIndex, type Timeline } from '../src/features/rail/agents-model';

/** A store-like timeline: a new array where an item joins, a revision per write, the changed ids. */
class Tl implements Timeline {
  items: Record<string, TimelineItem> = {};
  roots: string[] = [];
  children: Record<string, string[]> = {};
  rev = 0;
  changed = { since: 0, ids: [] as string[] };
  private write(ids: string[]) {
    this.changed = { since: this.rev, ids };
    this.rev++;
  }
  add(item: TimelineItem) {
    this.items = { ...this.items, [item.id]: item };
    this.roots = [...this.roots, item.id];
    this.write([item.id]);
    return this;
  }
  patch(id: string, patch: Partial<ToolItem>) {
    this.items = { ...this.items, [id]: { ...this.items[id], ...patch } as TimelineItem };
    this.write([id]);
    return this;
  }
}

const bash = (id: string, ts: number, extra: Partial<ToolItem> = {}): ToolItem => ({
  id,
  ts,
  type: 'tool',
  name: 'Bash',
  kind: 'bash',
  title: `Run ${id}`,
  status: 'done',
  detail: {},
  input: { command: 'pnpm dev', run_in_background: true },
  ...extra,
});

describe('window-F2: the commands follow their own state', () => {
  it('a task that starts after the list was read is counted running, sorted first and holds the fold open', () => {
    const t = new Tl();
    const view = commandsView(commandIndex(), noteIndex());
    for (let i = 1; i <= 5; i++) t.add(bash(`c${i}`, i, { task: { state: 'done', since: i } as ToolItem['task'] }));
    // Streamed: the call is listed while its step still runs, before the bridge's task event.
    t.add(bash('dev', 10, { status: 'running' }));
    const first = view(t);
    expect(first.running).toBe(0);
    expect(first.ids[0]).toBe('dev');
    // What the tab memoized on before (the lists of commands and notifications) does not change
    // when the bridge's taskStarted patches the same step: that was the stale head.
    const lists = commandIndex();
    const ends = noteIndex();
    const before = [lists(t), ends(t)];
    t.patch('dev', { status: 'done', task: { state: 'running', since: 11 } as ToolItem['task'] });
    expect([lists(t), ends(t)]).toEqual(before);
    expect(lists(t)).toBe(before[0]);
    expect(ends(t)).toBe(before[1]);
    const second = view(t);
    expect(second.running).toBe(1);
    expect(second.ids[0]).toBe('dev');
    // Nothing changed: the same object (the tab does not render).
    expect(view(t)).toBe(second);
  });

  it('a command lost with its process, or reconciled as stopped, stops counting', () => {
    const t = new Tl();
    const view = commandsView(commandIndex(), noteIndex());
    t.add(bash('dev', 1, { task: { state: 'running', since: 1 } as ToolItem['task'] }));
    t.add(bash('test', 2, { task: { state: 'running', since: 2 } as ToolItem['task'] }));
    expect(view(t).running).toBe(2);
    t.patch('dev', { task: { state: 'lost', since: 1, why: 'process' } as unknown as ToolItem['task'] });
    expect(view(t).running).toBe(1);
    expect(view(t).ids).toEqual(['test', 'dev']);
    t.patch('test', { task: { state: 'stopped', since: 2 } as ToolItem['task'] });
    expect(view(t).running).toBe(0);
    // A failed step counts as failed without any notification.
    t.add(bash('lint', 3, { status: 'running' }));
    view(t);
    t.patch('lint', { status: 'error' });
    expect(view(t).failed).toBe(1);
    expect(view(t).ids[0]).toBe('lint');
  });
});
