import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, FileDiff, SessionMeta, TextItem, ToolItem, ToolKind, UserItem } from '../shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { sessionPatchForJson } from '../server/core/trim';

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const patches: Partial<SessionMeta>[] = [];
  const emit = (e: BridgeEvent) => {
    if (e.type === 'session.updated' && 'live' in e.patch) patches.push(sessionPatchForJson(e.patch));
  };
  const rt = new SessionRuntime({ id: 's', status: 'idle' } as SessionMeta, emit, () => {});
  const tool = (kind: ToolKind, fields: Partial<ToolItem> = {}) => rt.add<ToolItem>({
    type: 'tool', kind, name: 'private tool', title: 'private command', detail: { path: 'private path' },
    status: 'running', ...fields,
  });
  return { rt, patches, tool };
}
const diff = (path: string): FileDiff => ({ path, status: 'modified', additions: 1, deletions: 0, hunks: [] });
afterEach(() => vi.useRealTimers());

describe('publishing the running turn to clients without the timeline', () => {
  it('coalesces counts for one second, flushes a quiet tail, and sends kind changes and closed checkpoints immediately', () => {
    const { rt, patches, tool } = fixture();
    rt.add<UserItem>({ type: 'user', text: 'private request', ts: 9000, state: 'sent' });
    rt.beginTurn();
    tool('read');
    patches.length = 0;
    const reads = Array.from({ length: 20 }, (_, i) => tool('read', { detail: { path: String(i) } }));
    expect(rt.snapshot().session.live).toMatchObject({ startedAt: 9000, steps: 21, doingCount: 21 });
    vi.advanceTimersByTime(999);
    expect(patches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].live?.steps).toBe(21);
    tool('bash');
    expect(patches.at(-1)?.live).toMatchObject({ doing: 'bash', doingCount: 1 });
    const words = rt.add<TextItem>({ type: 'text', text: 'Let me check. ', streaming: true });
    expect(patches.at(-1)?.live).toMatchObject({ doing: 'writing', checkpoints: 0, checkpointSteps: 22 });
    rt.delta(words.id, 'text', 'The tests passed.');
    expect(patches.at(-1)?.live).toMatchObject({ doing: 'writing', checkpoints: 1, checkpointSteps: 0 });
    const n = patches.length;
    for (let i = 0; i < 200; i++) rt.delta(words.id, 'text', ' private');
    vi.advanceTimersByTime(2000);
    expect(patches).toHaveLength(n);
    rt.patch<ToolItem>(reads[9].id, { kind: 'plan' }); // splits an earlier checkpoint
    expect(patches.at(-1)?.live).toMatchObject({ checkpoints: 2, steps: 21 });
    expect(JSON.stringify(patches)).not.toContain('private');
    rt.settle();
    expect(rt.meta.live?.doing).toBe('other');
    rt.endTurn();
    expect(patches.at(-1)).toMatchObject({ live: null });
  });

  it('replaces and deduplicates settled diffs including children, and excludes edits belonging to an older agent', () => {
    const { rt, tool } = fixture();
    const previous = tool('agent');
    rt.beginTurn();
    const edit = tool('edit', { result: { diff: [diff('private file')] } });
    const agent = tool('agent');
    tool('edit', { parentId: agent.id, status: 'done', result: { diff: [diff('private file'), diff('private nested')] } });
    rt.patch<ToolItem>(edit.id, { status: 'done' });
    tool('write', { parentId: previous.id, status: 'done', result: { diff: [diff('private old')] } });
    expect(rt.meta.live).toMatchObject({ steps: 2, files: 2, doing: 'agent', doingCount: 1 });
    rt.patch<ToolItem>(edit.id, { result: { diff: [diff('private replacement')] } });
    expect(rt.meta.live?.files).toBe(3);
    rt.patch<ToolItem>(agent.id, { kind: 'other' });
    expect(rt.meta.live?.files).toBe(1);
    rt.patch<ToolItem>(agent.id, { kind: 'agent' });
    expect(rt.meta.live?.files).toBe(3);
    rt.remove(agent.id);
    expect(rt.meta.live).toMatchObject({ steps: 1, files: 1 });
    expect(JSON.stringify(rt.meta.live)).not.toContain('private');
    rt.endTurn();
  });

  it('clears at reset, rewind and restore and cancels an outstanding publication', () => {
    const { rt, patches, tool } = fixture();
    rt.beginTurn();
    const first = tool('bash');
    tool('bash');
    const stale = { ...rt.meta };
    rt.reset([first]);
    expect(patches.at(-1)).toMatchObject({ live: null });
    vi.advanceTimersByTime(5000);
    expect(rt.meta.live).toBeUndefined();
    tool('bash');
    expect(rt.meta.live).toMatchObject({ steps: 2 });
    rt.reset([]);
    rt.notice('rewind', 'Rewound');
    expect(rt.meta.live).toBeUndefined();
    rt.endTurn();
    const restored = new SessionRuntime(stale, () => {}, () => {});
    expect(restored.meta.live).toBeUndefined(); // before lazy hydration
    restored.loadRestored([first]);
    expect(restored.meta.live).toBeUndefined();
  });

  it('publishes waiting on a prompt and clears even if agents and serving commands outlive the turn', async () => {
    const { rt, patches, tool } = fixture();
    rt.beginTurn();
    const agent = tool('agent', { status: 'done', result: { agent: { background: 'running' } } });
    const cmd = tool('bash', { status: 'done', task: { kind: 'command', id: 'srv', state: 'running', since: 1, serving: true } });
    const q = rt.ask([{ question: 'private?', options: [] }]);
    expect(patches.at(-1)?.live?.doing).toBe('waiting');
    rt.answerQuestion(rt.prompts().questions[0].id, {});
    await q;
    expect(patches.at(-1)?.live?.doing).toBe('other');
    rt.endTurn();
    expect(rt.meta).toMatchObject({ background: 1, serving: 1 });
    const count = patches.length;
    rt.patch<ToolItem>(agent.id, { result: { agent: { background: 'done' } } });
    rt.delta(cmd.id, 'output', 'private log');
    vi.advanceTimersByTime(5000);
    expect(rt.meta.live).toBeUndefined();
    expect(patches).toHaveLength(count);
  });

  it('delivers the final file total before the clear and leaves an unknown tool name private', () => {
    const { rt, tool, patches } = fixture();
    rt.beginTurn();
    tool('private tool name' as ToolKind);
    expect(rt.meta.live?.doing).toBe('other');
    const edit = tool('edit');
    tool('edit');
    rt.patch<ToolItem>(edit.id, { status: 'done', result: { diff: [diff('private file')] } });
    expect(patches.at(-1)?.live?.files).toBe(0);
    rt.add({ type: 'turn', durationMs: 1 });
    expect(patches.at(-2)?.live?.files).toBe(1);
    expect(patches.at(-1)).toMatchObject({ live: null });
    rt.endTurn();
    expect(JSON.stringify(patches)).not.toContain('private');
  });
});
