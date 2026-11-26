/**
 * The Agents tab, rebuilt for a glance (26 Nov: "948 done · 27 failed" over twenty waves said nothing
 * about now): what works now as one list in one grammar, tracked jobs among it; history that folds
 * away; a failure red only while it is news. The pure model behind `AgentsTab.tsx`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import { agentIndex, commandIndex, commandsView, failureIsNews, isJob, jobIndex, jobRan, jobRowState, jobTail, jobsView, lastLine, liveKey, noteIndex, nowRows, overview, userIndex, type Timeline } from '../src/features/rail/agents-model';
import { trackedEndReport } from '@shared/synthetic';

const user = (id: string, ts: number): UserItem => ({ id, ts, type: 'user', text: `message ${id}`, state: 'sent' }) as UserItem;
const agent = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({ id, ts: 0, type: 'tool', name: 'Task', kind: 'agent', title: `Agent ${id}`, status: 'done', detail: { description: `Agent ${id}` }, ...extra }) as ToolItem;
const job = (id: string, ts: number, tracked: Partial<NonNullable<ToolItem['tracked']>> = {}, extra: Partial<ToolItem> = {}): ToolItem =>
  ({ id, ts, type: 'tool', name: 'mcp__sable__track_work', kind: 'other', title: `Job ${id}`, status: 'done', detail: {}, tracked: { pid: 1, state: 'running', since: ts, ...tracked }, ...extra }) as ToolItem;
const command = (id: string, ts: number, task: Partial<NonNullable<ToolItem['task']>> = {}): ToolItem =>
  ({ id, ts, type: 'tool', name: 'Bash', kind: 'bash', title: `Command ${id}`, status: 'done', detail: { command: 'pnpm test', background: true }, task: { id: `t-${id}`, kind: 'command', state: 'running', since: ts, ...task } }) as ToolItem;

/** A timeline as the store keeps it: an item joins by a new roots array, a patch by a new revision. */
class Tl implements Timeline {
  items: Record<string, TimelineItem> = {};
  roots: string[] = [];
  children: Record<string, string[]> = {};
  rev = 0;
  changed?: { since: number; ids: string[] };
  add(it: TimelineItem) {
    this.items = { ...this.items, [it.id]: it };
    this.roots = [...this.roots, it.id];
    this.changed = { since: this.rev, ids: [it.id] };
    this.rev++;
    return this;
  }
  patch(id: string, patch: Partial<ToolItem>) {
    this.items = { ...this.items, [id]: { ...this.items[id], ...patch } as TimelineItem };
    this.changed = { since: this.rev, ids: [id] };
    this.rev++;
    return this;
  }
}

describe('tracked jobs in the tab', () => {
  it('a job joins when the bridge marks its step, which changes no list; running and past stand apart', () => {
    const t = new Tl().add(user('u', 1));
    const index = jobIndex();
    const view = jobsView(index);
    expect(index(t)).toEqual([]);
    // The call's step joins first, with no tracked work on it yet.
    const { tracked: _mark, ...bare } = job('j1', 10);
    t.add(bare as ToolItem);
    expect(index(t)).toEqual([]);
    t.patch('j1', { tracked: { pid: 7, state: 'running', since: 10 } });
    expect(index(t)).toEqual(['j1']);
    expect(view(t)).toEqual({ running: ['j1'], past: [] });
    const same = view(t);
    // The log's last line changes: the lists keep their identity (the card reads its own item).
    t.patch('j1', { tracked: { pid: 7, state: 'running', since: 10, line: '19 passed' } });
    expect(index(t)).toBe(index(t));
    expect(view(t)).toBe(same);
    t.add(job('j2', 20));
    expect(view(t).running).toEqual(['j1', 'j2']);
    t.patch('j1', { tracked: { pid: 7, state: 'ended', since: 10, endedAt: 70_010 } });
    expect(view(t)).toEqual({ running: ['j2'], past: ['j1'] });
    expect(isJob(t.items.j1)).toBe(true);
    expect(jobRowState((t.items.j1 as ToolItem).tracked!)).toBe('done');
    expect(jobRan((t.items.j1 as ToolItem).tracked!)).toBe(70_000);
    // Gone while Sable was closed: it ended, and no time is claimed for it.
    expect(jobRan({ pid: 1, state: 'ended', since: 10 })).toBe(0);
    expect(jobRowState({ pid: 1, state: 'left', since: 10 })).toBe('stopped');
  });

  it("an ended job's opened row shows the end of its log from the report, else its last line", () => {
    const report = trackedEndReport({ pid: 3, ran: '41m', lines: ['building', '19 passed', 'exit 0'], log: true });
    expect(jobTail(report, 'exit 0')).toEqual(['building', '19 passed', 'exit 0']);
    expect(jobTail(trackedEndReport({ pid: 3, ran: '5s' }), undefined)).toEqual([]);
    // A report that came cut to the window: the last line the row carries.
    expect(jobTail(`${report.slice(0, 60)}\n…`, 'exit 0')).toEqual(['exit 0']);
    expect(jobTail(undefined, undefined)).toEqual([]);
  });
});

describe('what works now, as one list', () => {
  it('sub-agents, jobs and running commands stand together, the longest runner first; servers and finished work are not in it', () => {
    const t = new Tl()
      .add(user('u', 1))
      .add(agent('a', { ts: 300, status: 'running' }))
      .add(job('j', 100))
      .add(command('c', 200))
      .add(command('s', 150, { serving: 'localhost:3311' }))
      .add(command('old', 50, { state: 'done', endedAt: 60 }))
      .add(job('gone', 40, { state: 'ended', endedAt: 90 }))
      .add(agent('done', { ts: 20 }));
    const agents = agentIndex()(t);
    const o = overview(agents, liveKey(t.items, agents), t.items, userIndex()(t), t.roots);
    const cmds = commandsView(commandIndex(), noteIndex())(t);
    const jobs = jobsView(jobIndex())(t);
    expect(nowRows(o.working, jobs.running, cmds.live, t.items)).toEqual([
      { id: 'j', kind: 'job' },
      { id: 'c', kind: 'command' },
      { id: 'a', kind: 'agent' },
    ]);
    expect(cmds.servers).toEqual(['s']);
    expect(cmds.past).toEqual(['old']);
    expect(jobs.past).toEqual(['gone']);
    expect(nowRows([], [], [], t.items)).toEqual([]);
  });

  it("a command's last line of output is one cut plain line", () => {
    expect(lastLine('building\n12 of 40\n\n')).toBe('12 of 40');
    expect(lastLine('10%\r55%\r100% done')).toBe('100% done');
    expect(lastLine('\u001b[32m ok \u001b[0m\tall\u0007 good\n')).toBe('ok all good');
    expect(lastLine(`head\n${'x'.repeat(5000)}`).length).toBe(160);
    expect(lastLine('')).toBe('');
    expect(lastLine(undefined)).toBe('');
  });
});

describe('a failure is red only while it is news', () => {
  it('the newest wave, or failed since the person last looked; older failures are history', () => {
    const t = new Tl()
      .add(user('u1', 1000))
      .add(agent('old-bad', { ts: 1100, endedAt: 1200, status: 'error' }))
      .add(user('u2', 2000))
      .add(agent('mid-bad', { ts: 2100, endedAt: 5200, status: 'error' }))
      .add(agent('mid-ok', { ts: 2150, endedAt: 2300 }))
      .add(user('u3', 3000))
      .add(agent('new-bad', { ts: 3100, endedAt: 3200, status: 'error' }));
    const ids = agentIndex()(t);
    const see = (seenAt: number) => overview(ids, liveKey(t.items, ids), t.items, userIndex()(t), t.roots, seenAt);
    // The person looked at 4000: the newest wave's failure is news, the one that failed after that too.
    const o = see(4000);
    expect(o.waves.map((w) => [w.user, w.failed, w.news])).toEqual([['u3', 1, 1], ['u2', 1, 1], ['u1', 1, 0]]);
    // Looked after all of it: only the newest wave still says so in red.
    expect(see(9000).waves.map((w) => w.news)).toEqual([1, 0, 0]);
    // Unknown when they last looked (the default): nothing but the newest wave.
    expect(overview(ids, liveKey(t.items, ids), t.items, userIndex()(t), t.roots).waves.map((w) => w.news)).toEqual([1, 0, 0]);
    expect(failureIsNews(t.items['old-bad'] as ToolItem, false, 4000)).toBe(false);
    expect(failureIsNews(t.items['old-bad'] as ToolItem, true, 4000)).toBe(true);
  });

  it('the stylesheet keeps red for news: no rule colours a failure by its outcome alone', () => {
    const css = readFileSync(new URL('../src/features/rail/agents.css', import.meta.url), 'utf8');
    for (const rule of css.match(/[^{}]+\{[^{}]*var\(--red(?:-text)?\)[^{}]*\}/g) ?? []) {
      const selector = rule.slice(0, rule.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      // Red stands for news (a row, a wave's line) or for a failed step inside an opened row.
      expect(selector).toMatch(/\[data-news\]|\.agx-fail|\.agx-wf-agent\[data-state='error'\]/);
    }
    expect(css).toMatch(/\.agx-row\[data-news\] \.agx-mark\[data-state='failed'\] \{\s*color: var\(--red\);/);
    // Waiting on you is amber once: the mark, not the words beside it.
    expect(css).toMatch(/\.agx-now-wait \{\s*color: var\(--text-2\);/);
    expect(css.match(/var\(--amber\)/g)).toHaveLength(1);
  });
});
