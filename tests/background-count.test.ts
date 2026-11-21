/**
 * A chat's count of background work (`SessionMeta.background`): sub-agents and workflows still
 * working after their own call returned. The bridge keeps it from the chat's steps, so lists and the
 * conversation can say that a chat still works when its own turn has ended.
 */
import { describe, expect, it } from 'vitest';
import type { BridgeEvent, SessionMeta, ToolItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { watchAwake } from '../server/core/awake';

function chat() {
  const events: BridgeEvent[] = [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: '/w', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, (e) => events.push(e), () => {});
  const counts = () => events.flatMap((e) => (e.type === 'session.updated' && 'background' in e.patch ? [e.patch.background] : []));
  return { rt, events, counts };
}
const agent = (id: string, background?: 'running' | 'done' | 'stopped') =>
  ({ id, type: 'tool', name: 'Task', kind: 'agent', title: 'Agent', status: 'done', detail: {}, ...(background ? { result: { agent: { background } } } : {}) }) as unknown as ToolItem;

describe('background work of a chat', () => {
  it('counts sub-agents sent to the background, and falls as each ends', () => {
    const { rt, counts } = chat();
    rt.add<ToolItem>(agent('a1', 'running'));
    rt.add<ToolItem>({ ...agent('a2'), status: 'running' });
    expect(rt.meta.background).toBe(1);
    rt.patch<ToolItem>('a2', { status: 'done', result: { agent: { background: 'running' } } } as Partial<ToolItem>);
    expect(rt.meta.background).toBe(2);
    rt.patch<ToolItem>('a1', { result: { agent: { background: 'done' } } } as Partial<ToolItem>);
    rt.patch<ToolItem>('a2', { result: { agent: { background: 'stopped' } } } as Partial<ToolItem>);
    expect(rt.meta.background).toBe(0);
    expect(counts()).toEqual([1, 2, 1, 0]);
  });

  it('a workflow counts while it runs', () => {
    const { rt } = chat();
    rt.add<ToolItem>({ ...agent('w1'), workflow: { status: 'running', phases: [], agents: [], phase: 0 } } as unknown as ToolItem);
    expect(rt.meta.background).toBe(1);
    rt.patch<ToolItem>('w1', { workflow: { status: 'done', phases: [], agents: [], phase: 0 } } as unknown as Partial<ToolItem>);
    expect(rt.meta.background).toBe(0);
  });

  it('a removed step, a stop of everything in the background and a reset are followed', () => {
    const { rt, counts } = chat();
    rt.add<ToolItem>(agent('a1', 'running'));
    rt.add<ToolItem>(agent('a2', 'running'));
    rt.remove('a1');
    expect(rt.meta.background).toBe(1);
    rt.stopBackground();
    expect(rt.meta.background).toBe(0);
    rt.reset([agent('b1', 'running')]);
    expect(rt.meta.background).toBe(1);
    expect(counts().at(-1)).toBe(1);
  });

  it('a chat read from disk has its count without announcing it', () => {
    const { rt, events } = chat();
    rt.load([agent('a1', 'running'), agent('a2', 'done')]);
    expect(rt.meta.background).toBe(1);
    expect(events).toHaveLength(0);
  });

  it('keeps the computer awake while only background work runs', () => {
    const { rt } = chat();
    const listeners = new Set<(e: BridgeEvent) => void>();
    const seen: boolean[] = [];
    const rt2 = new SessionRuntime(rt.meta, (e) => listeners.forEach((l) => l(e)), () => {});
    const off = watchAwake({ get sessions() { return [rt2].values(); }, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) }, (b) => seen.push(b), 0);
    rt2.add<ToolItem>(agent('a1', 'running'));
    expect(seen).toEqual([true]);
    off();
  });
});
