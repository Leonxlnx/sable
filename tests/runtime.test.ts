/** SessionRuntime: the timeline, prompts and status transitions providers write to. */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionMeta, TextItem, ThinkingItem, ToolItem } from '@shared/protocol';
import { autoTitle, SessionRuntime } from '../server/core/runtime';

function make() {
  const events: BridgeEvent[] = [];
  const dirty: string[] = [];
  const meta: SessionMeta = {
    id: 's1',
    provider: 'demo',
    cwd: '/r',
    title: 'New session',
    titleSource: 'auto',
    model: 'demo-large',
    mode: 'default',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  const rt = new SessionRuntime(meta, (e) => events.push(structuredClone(e)), (_rt, what) => dirty.push(what));
  const statuses = () => events.flatMap((e) => (e.type === 'session.updated' && e.patch.status ? [e.patch.status] : []));
  return { rt, events, dirty, statuses };
}

const perm = { toolName: 'Bash', kind: 'bash' as const, title: 'Run tests', detail: { command: 'npm test' }, options: [{ id: 'allow', label: 'Allow once', tone: 'allow' as const }] };

describe('timeline', () => {
  it('adds, streams, patches and removes, emitting copies', () => {
    const { rt, events, dirty } = make();
    const text = rt.add<TextItem>({ type: 'text', text: '', streaming: true });
    rt.delta(text.id, 'text', 'Hello');
    rt.delta(text.id, 'text', ' world');
    rt.delta(text.id, 'text', '');
    rt.delta('missing', 'text', 'x');
    expect(rt.get<TextItem>(text.id)!.text).toBe('Hello world');
    // The added event carried a copy taken before the deltas.
    expect(events[0]).toMatchObject({ type: 'item.added', item: { text: '' } });
    expect(events.filter((e) => e.type === 'item.delta')).toHaveLength(2);

    rt.patch<TextItem>(text.id, { streaming: false });
    rt.patch('missing', {});
    expect(rt.items[0]).toMatchObject({ streaming: false });
    rt.remove(text.id);
    rt.remove(text.id);
    expect(rt.items).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['item.added', 'item.delta', 'item.delta', 'item.patch', 'item.removed']);
    expect(dirty.every((d) => d === 'items')).toBe(true);
  });

  it('remove takes nested items with it and emits once', () => {
    const { rt, events } = make();
    const agent = rt.add<ToolItem>({ type: 'tool', name: 'Agent', kind: 'agent', title: 'Run a subagent', status: 'running', detail: {} });
    const sub = rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: 'Read a', status: 'done', detail: {}, parentId: agent.id });
    rt.add<TextItem>({ type: 'text', text: 'deep', streaming: false, parentId: sub.id });
    const keep = rt.add<TextItem>({ type: 'text', text: 'after', streaming: false });
    events.length = 0;
    rt.remove(agent.id);
    expect(rt.items.map((i) => i.id)).toEqual([keep.id]);
    expect(rt.get(sub.id)).toBeUndefined();
    expect(events).toEqual([{ type: 'item.removed', sessionId: 's1', id: agent.id }]);
  });

  it('update emits only what changed', () => {
    const { rt, events } = make();
    rt.update({ title: 'New session', model: 'demo-large' });
    expect(events).toEqual([]);
    rt.update({ title: 'Refactor', model: 'demo-large' });
    expect(events).toEqual([{ type: 'session.updated', id: 's1', patch: { title: 'Refactor' } }]);
  });

  it('reset replaces items and keeps todos', () => {
    const { rt, events } = make();
    rt.setTodos([{ content: 'a', status: 'pending' }]);
    rt.add<TextItem>({ type: 'text', text: 'old', streaming: false });
    rt.reset([{ id: 'x', ts: 1, type: 'text', text: 'new', streaming: false }]);
    expect(rt.items.map((i) => i.id)).toEqual(['x']);
    expect(rt.get('x')).toBeDefined();
    expect(rt.snapshot().todos).toHaveLength(1);
    // The counts of what works and serves are published again after a reset, so the reset is not the last event.
    expect(events.findLast((e) => e.type === 'timeline.reset')).toMatchObject({ type: 'timeline.reset', items: [{ id: 'x' }] });
  });
});

describe('a message steered into a turn', () => {
  it('stands where the agent took it: what was written before it had the message stays above it', () => {
    const { rt } = make();
    rt.add({ type: 'user', text: 'fix the bug', state: 'sent' } as never);
    rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: 'Read a.ts', status: 'done' } as never);
    const steer = rt.add({ type: 'user', text: 'which account are you on?', state: 'queued', steered: true, ts: 5 } as never);
    // Written before the agent had the message: a note and the step it announces.
    const note = rt.add<TextItem>({ type: 'text', text: 'Reading the recovery code; the fix looks small.', streaming: false });
    const step = rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: 'Read b.ts', status: 'done' } as never);
    const child = rt.add<ToolItem>({ type: 'tool', name: 'Grep', kind: 'search', title: 'inside', status: 'done', parentId: step.id } as never);
    rt.taken(steer.id);
    const reply = rt.add<TextItem>({ type: 'text', text: 'On Max1.', streaming: false });
    const roots = rt.items.filter((i) => !i.parentId).map((i) => i.id);
    expect(roots.slice(-4)).toEqual([note.id, step.id, steer.id, reply.id]);
    expect(rt.items.some((i) => i.id === child.id)).toBe(true);
    // Taken, and it keeps the time it was sent.
    expect(rt.get(steer.id)).toMatchObject({ state: 'sent', steered: true, ts: 5 });
  });

  it('says the move as the two events every reader knows, marked as one move', () => {
    const { rt, events } = make();
    rt.add({ type: 'user', text: 'fix the bug', state: 'sent' } as never);
    const steer = rt.add({ type: 'user', text: 'which account?', state: 'queued', steered: true } as never);
    rt.add<TextItem>({ type: 'text', text: 'Reading the recovery code.', streaming: false });
    events.length = 0;
    rt.taken(steer.id);
    expect(events).toEqual([
      { type: 'item.removed', sessionId: 's1', id: steer.id, moving: true },
      { type: 'item.added', sessionId: 's1', item: expect.objectContaining({ id: steer.id, state: 'sent' }), moved: true },
    ]);
  });

  it('stays in its place when nothing was written meanwhile, and when only a step of its own nests after it', () => {
    const { rt, events } = make();
    rt.add({ type: 'user', text: 'fix the bug', state: 'sent' } as never);
    const steer = rt.add({ type: 'user', text: 'and the tests', state: 'queued', steered: true } as never);
    events.length = 0;
    rt.taken(steer.id);
    expect(rt.items.at(-1)?.id).toBe(steer.id);
    expect(events.some((e) => e.type === 'item.removed')).toBe(false);
    expect(rt.get(steer.id)).toMatchObject({ state: 'sent' });
  });
});

describe('turns and prompts', () => {
  it('goes running → awaiting → running → idle around a permission', async () => {
    const { rt, statuses, events } = make();
    rt.setSuggestion('old suggestion');
    rt.beginTurn('Reading');
    expect(rt.suggestion).toBeUndefined();
    const answer = rt.requestPermission(perm);
    const req = rt.snapshot().permissions[0];
    expect(req).toMatchObject({ sessionId: 's1', title: 'Run tests' });
    expect(rt.meta.status).toBe('awaiting');

    expect(rt.answerPermission('nope', { optionId: 'allow' })).toBe(false);
    expect(rt.answerPermission(req.id, { optionId: 'allow' })).toBe(true);
    await expect(answer).resolves.toEqual({ optionId: 'allow' });
    // Answering twice is a no-op.
    expect(rt.answerPermission(req.id, { optionId: 'allow' })).toBe(false);
    expect(rt.snapshot().permissions).toEqual([]);
    rt.endTurn();
    expect(statuses()).toEqual(['running', 'awaiting', 'running', 'idle']);
    expect(events.filter((e) => e.type === 'permission.added' || e.type === 'permission.removed').map((e) => e.type)).toEqual(['permission.added', 'permission.removed']);
  });

  it('stays awaiting until every prompt is answered', async () => {
    const { rt } = make();
    rt.beginTurn();
    const p = rt.requestPermission(perm);
    const q = rt.ask([{ question: 'Which?', options: [{ label: 'A' }] }], 'tool-1');
    const snap = rt.snapshot();
    expect(snap.questions[0]).toMatchObject({ itemId: 'tool-1' });
    rt.answerPermission(snap.permissions[0].id, { optionId: 'allow' });
    expect(rt.meta.status).toBe('awaiting');
    rt.answerQuestion(snap.questions[0].id, { 'Which?': ['A'] });
    expect(rt.meta.status).toBe('running');
    await expect(p).resolves.toEqual({ optionId: 'allow' });
    await expect(q).resolves.toEqual({ 'Which?': ['A'] });
  });

  it('cancelPrompts and endTurn resolve open prompts with null', async () => {
    const { rt } = make();
    rt.beginTurn();
    const p = rt.requestPermission(perm);
    const q = rt.ask([{ question: 'Which?', options: [] }]);
    rt.endTurn('Boom');
    await expect(p).resolves.toBeNull();
    await expect(q).resolves.toBeNull();
    expect(rt.meta).toMatchObject({ status: 'error', lastError: 'Boom' });
    expect(rt.turnActive).toBe(false);
  });

  it('an abort signal cancels a prompt', async () => {
    const { rt } = make();
    rt.beginTurn();
    const ac = new AbortController();
    const p = rt.requestPermission(perm, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeNull();
    expect(rt.meta.status).toBe('running');
  });

  it('prompts outside a turn do not change the status', () => {
    const { rt, statuses } = make();
    void rt.requestPermission(perm);
    expect(rt.meta.status).toBe('idle');
    expect(statuses()).toEqual([]);
    rt.cancelPrompts();
  });

  it('settle closes anything left in flight', () => {
    const { rt } = make();
    const text = rt.add<TextItem>({ type: 'text', text: 'partial', streaming: true });
    const think = rt.add<ThinkingItem>({ type: 'thinking', text: 'hmm', streaming: true });
    const running = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} });
    const waiting = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'awaiting', detail: {} });
    const done = rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'done', detail: {} });
    rt.settle('error');
    expect(rt.get<TextItem>(text.id)!.streaming).toBe(false);
    expect(rt.get<ThinkingItem>(think.id)).toMatchObject({ streaming: false, endedAt: expect.any(Number) });
    expect(rt.get<ToolItem>(running.id)).toMatchObject({ status: 'error', endedAt: expect.any(Number) });
    expect(rt.get<ToolItem>(waiting.id)!.status).toBe('error');
    expect(rt.get<ToolItem>(done.id)!.status).toBe('done');
    expect(rt.get<ToolItem>(done.id)!.endedAt).toBeUndefined();
  });

  it('settle stamps only the turn it settles, at the time it is given and never before a step began', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { rt } = make();
      // Left running by work before this turn (its process went away unnoticed).
      const straggler = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} });
      vi.setSystemTime(6 * 3600_000);
      rt.beginTurn();
      const late = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} });
      rt.settle('cancelled', { at: 5 * 3600_000 });
      expect(rt.get<ToolItem>(straggler.id)!.status).toBe('cancelled');
      expect(rt.get<ToolItem>(straggler.id)!.endedAt).toBeUndefined();
      expect(rt.get<ToolItem>(late.id)!.endedAt).toBe(6 * 3600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a step does not count the time spent waiting for approval as its own', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const { rt } = make();
      rt.beginTurn();
      // Two calls at once: the first waits 40s for approval, the second runs after it for 2s.
      const a = rt.add<ToolItem>({ type: 'tool', name: 'Skill', kind: 'skill', title: 'Use a skill', status: 'awaiting', detail: {} });
      const b = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'running', detail: {} });
      const answer = rt.requestPermission({ ...perm, itemId: a.id });
      vi.setSystemTime(50_000);
      rt.answerPermission(rt.snapshot().permissions[0].id, { optionId: 'allow' });
      await answer;
      vi.setSystemTime(51_000);
      rt.patch<ToolItem>(a.id, { status: 'done', endedAt: Date.now() });
      vi.setSystemTime(53_000);
      rt.patch<ToolItem>(b.id, { status: 'done', endedAt: Date.now() });
      expect(rt.get<ToolItem>(a.id)!.waitedMs).toBe(40_000);
      expect(rt.get<ToolItem>(b.id)!.waitedMs).toBe(40_000);
      // A call that started after the wait carries nothing.
      const c = rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: 'Read', status: 'running', detail: {} });
      vi.setSystemTime(54_000);
      rt.patch<ToolItem>(c.id, { status: 'done', endedAt: Date.now() });
      expect(rt.get<ToolItem>(c.id)!.waitedMs).toBeUndefined();
      // A prompt still open when a step ends counts up to that end.
      const d = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'awaiting', detail: {} });
      void rt.requestPermission(perm);
      vi.setSystemTime(57_000);
      rt.patch<ToolItem>(d.id, { status: 'cancelled', endedAt: Date.now() });
      expect(rt.get<ToolItem>(d.id)!.waitedMs).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('autoTitle', () => {
  it('uses the first meaningful line, without markdown markers', () => {
    expect(autoTitle('refactor the session module')).toBe('refactor the session module');
    expect(autoTitle('\n\n  # Fix   the login bug  \nmore detail')).toBe('Fix the login bug');
    expect(autoTitle('> quoted ask')).toBe('quoted ask');
    expect(autoTitle('- bullet item')).toBe('bullet item');
  });

  it('skips fenced code and falls back to New session', () => {
    expect(autoTitle('```ts\nconst a = 1;\n```\nexplain this')).toBe('explain this');
    expect(autoTitle('```\nonly code\n```')).toBe('New session');
    expect(autoTitle('   ')).toBe('New session');
    expect(autoTitle('#')).toBe('New session');
    expect(autoTitle('---')).toBe('New session');
    expect(autoTitle('> \n')).toBe('New session');
  });

  it('clips long lines with an ellipsis', () => {
    const t = autoTitle('word '.repeat(30));
    expect(t.length).toBeLessThanOrEqual(55);
    expect(t.endsWith('…')).toBe(true);
  });
});
