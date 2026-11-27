/**
 * Phone 2.22: what the desktop got in 0.2.41, on the phone. A tracked job (`track_work`,
 * `ToolItem.tracked`, `SessionMeta.tracked`) is work wherever the phone reads a chat's work, by the
 * shared rule and words; its row says where it stands in the Agents tab's words; "Working now" reads
 * what works in a chat by the desktop's own model (src/features/rail/now-model.ts); a handed-over
 * task's row says what 0.2.41's bridge leaves on it (a report sent again once reads "Report pending",
 * no notice), and a report's copy line is Sable's own text, never the person's.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionMeta, TimelineItem, ToolItem } from '@shared/protocol';
import { delegateReport, trackedEndReport, syntheticOf } from '@shared/synthetic';
import { hasWork, tailLabel, workLabel } from '@shared/work-label';

vi.mock('@desk/features/rail/now-model', async () => await import('../src/features/rail/now-model'));
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

const { liveWords } = await import('../mobile/src/lib/live-words');
const { workNow, workKey, runningMonitors, backgroundSince } = await import('../mobile/src/lib/work-now');
const { jobEndWord, jobRan, jobRowState, jobAgent, isAgentLive, STATE_MARK } = await import('../src/features/rail/now-model');
const { delegateWord, delegateRetry } = await import('../src/features/timeline/delegate-word');
const { shapeOf } = await import('../mobile/src/lib/turns');
const { worksNow } = await import('../mobile/src/lib/chat-rules');

const meta = (p: Partial<SessionMeta>) => ({ id: 's', title: 'Sign-in fix', provider: 'claude', status: 'idle', updatedAt: 0, ...p }) as SessionMeta;
const T0 = 1_800_000_000_000;

const job = (id: string, p: Partial<NonNullable<ToolItem['tracked']>> = {}, title = 'Codex builds the sign-in fix'): ToolItem =>
  ({ id, ts: T0, type: 'tool', name: 'mcp__sable__track_work', kind: 'other', title, status: 'done', detail: { description: 'Codex' }, tracked: { pid: 0, state: 'running', since: T0, by: 'Codex', ...p } }) as ToolItem;
const agent = (id: string, p: Partial<ToolItem> = {}): ToolItem =>
  ({ id, ts: T0 + 1000, type: 'tool', name: 'Task', kind: 'agent', title: 'Audit the routes', status: 'done', detail: { subagent: 'reviewer' }, result: { agent: { background: 'running' } }, ...p }) as ToolItem;
const command = (id: string, p: Partial<NonNullable<ToolItem['task']>> = {}): ToolItem =>
  ({ id, ts: T0 + 2000, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run the tests in watch mode', status: 'done', detail: { command: 'npm test -- --watch', background: true }, task: { id: `t-${id}`, kind: 'command', state: 'running', since: T0 + 2000, ...p } }) as ToolItem;
const items = (...list: ToolItem[]) => Object.fromEntries(list.map((i) => [i.id, i])) as Record<string, TimelineItem>;

describe('a chat whose only work is a tracked job', () => {
  const s = meta({ tracked: 1, trackedSince: T0, trackedTitle: 'Codex builds the sign-in fix' });

  it('works, by the shared rule, on home, in the Now list and in the header', () => {
    expect(hasWork(s)).toBe(true);
    expect(worksNow(s)).toBe(true);
    expect(workLabel(s)).toBe('Codex builds the sign-in fix');
  });

  it('says its title and since when the bridge says it began (the home row, the header, the Now card)', () => {
    expect(liveWords(s)).toEqual({ line: 'Codex builds the sign-in fix', since: T0, steps: 0, done: 0, open: 0 });
  });

  it('beside other work, says the parts and no clock of its own (sub-agents carry no start in the list)', () => {
    const w = liveWords(meta({ tracked: 1, trackedSince: T0, trackedTitle: 'x', background: 1 }));
    expect(w.line).toBe('1 sub-agent, 1 job');
    expect(w.since).toBeUndefined();
  });

  it('reads as the desktop last line says it', () => {
    expect(tailLabel({ agents: 0, commands: 0, jobs: 1, jobTitle: 'Codex builds the sign-in fix' })).toBe('Codex builds the sign-in fix');
    expect(tailLabel({ agents: 0, commands: 1, monitors: 1, jobs: 0 })).toBe('Waiting for 1 monitor');
  });
});

describe('a job row says where it stands', () => {
  it('running: the ring', () => {
    const t = job('j').tracked!;
    expect(jobRowState(t)).toBe('running');
    expect(STATE_MARK[jobRowState(t)]).toBe('ring');
    expect(jobEndWord(t)).toBe('');
  });

  it('ended with no end known: "Ended", never a made-up time', () => {
    const t = job('j', { state: 'ended' }).tracked!;
    expect(jobRowState(t)).toBe('done');
    expect(jobRan(t)).toBe(0);
    expect(jobEndWord(t)).toBe('Ended');
  });

  it('ended with its end seen: how long it ran', () => {
    const t = job('j', { state: 'ended', endedAt: T0 + 41 * 60_000 }).tracked!;
    expect(jobEndWord(t)).toBe('');
    expect(jobRan(t)).toBe(41 * 60_000);
  });

  it('let go: "Not tracked", a dash', () => {
    const t = job('j', { state: 'left' }).tracked!;
    expect(jobEndWord(t)).toBe('Not tracked');
    expect(STATE_MARK[jobRowState(t)]).toBe('minus');
  });

  it('names an agent by its mark, any other word as the word', () => {
    expect(jobAgent('Codex')).toBe('codex');
    expect(jobAgent('Claude Code')).toBe('claude');
    expect(jobAgent('build')).toBeNull();
  });

  it('keeps its place among the steps of its turn (it folds with the work, as on the desktop)', () => {
    expect(shapeOf(job('j'))).toBe('w');
  });
});

describe('Working now: what works in a chat, by the desktop model', () => {
  it('lists sub-agents, jobs and commands, the longest runner first, servers apart', () => {
    const list = items(command('c'), agent('a'), job('j'), command('srv', { serving: 'localhost:5173' }), job('old', { state: 'ended' }));
    const w = workNow(list);
    expect(w.rows).toEqual([
      { id: 'j', kind: 'job' },
      { id: 'a', kind: 'agent' },
      { id: 'c', kind: 'command' },
    ]);
    expect(w.servers).toEqual(['srv']);
    expect(workKey(w)).toBe('job:j,agent:a,command:c|srv|0');
  });

  it('a handed-over task whose child ended and whose report waits is no working row, whatever its launch result says', () => {
    const pending = agent('d', { name: 'mcp__sable__delegate_to_codex', delegateReport: 'pending' } as Partial<ToolItem>);
    expect(isAgentLive(pending)).toBe(false);
    expect(workNow(items(pending)).rows).toEqual([]);
  });

  it('counts what the bridge says works in an older part of the chat', () => {
    const w = workNow(items(job('j')), meta({ tracked: 2, background: 1 }));
    expect(w.unseen).toBe(2);
  });

  it('monitors and the oldest start', () => {
    const list = items(command('m', { kind: 'monitor' }), command('c'), job('j'));
    expect(runningMonitors(list)).toBe(1);
    expect(backgroundSince(meta({ commands: 2, tracked: 1, trackedSince: T0 }), list)).toBe(T0);
    expect(backgroundSince(meta({}), list)).toBeUndefined();
  });
});

describe('a handed-over task after 0.2.41', () => {
  it('a report sent again once reads as pending, with nothing to decide', () => {
    const row = { delegateReport: 'pending', delegateRedelivered: true } as unknown as ToolItem;
    expect(delegateWord(row)).toBe('Report pending');
    expect(delegateRetry(row)).toBeNull();
  });

  it('the second time it says the delivery is unknown and offers the one decision', () => {
    const row = { delegateReport: 'delivered', delegateReceiptState: 'unknown', delegateRetryId: '3f1c2a9e-8b7d-4c6e-9a5f-1d2e3c4b5a69' } as unknown as ToolItem;
    expect(delegateWord(row)).toBe('Delivery unknown');
    expect(delegateRetry(row)).toBe('/report-retry 3f1c2a9e-8b7d-4c6e-9a5f-1d2e3c4b5a69');
  });

  it('held for the next message or stopping, in the desktop words', () => {
    expect(delegateWord({ delegateReport: 'pending', delegateWait: 'budget' } as ToolItem)).toBe('With your next message');
    expect(delegateWord({ delegateReport: 'stopping' } as ToolItem)).toBe('Stopping');
  });

  it("a report with its copy line, and a tracked job's end, are Sable's own texts (hidden on the phone)", () => {
    const report = { id: 'u', ts: T0, type: 'user', text: delegateReport('Review the store', 'done', 'All good.', '9b1c') } as TimelineItem;
    expect(report.type === 'user' && report.text).toContain('If you already have the report with this Delivery ID, ignore this copy.');
    expect(syntheticOf(report as never)?.role).toBe('hidden');
    expect(shapeOf(report)).toBe('u');
    const ended = { id: 'e', ts: T0, type: 'user', text: delegateReport('Nightly build', 'ended', trackedEndReport({ pid: 4242, ran: '41m', lines: ['done'], log: true }), 'ab12') } as TimelineItem;
    expect(shapeOf(ended)).toBe('u');
  });
});
