/**
 * perf1: a burst of bridge events (the Demo's fleet: thousands of steps in a few seconds) is applied
 * once per frame, as one store write per session, in the order it came; an answer from the bridge
 * never overtakes the events sent before it; nothing is lost or reordered against other events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, SessionMeta, TimelineItem } from '@shared/protocol';

let listener: ((e: BridgeEvent) => void) | null = null;
const bridgeMock: { beforeAnswer?: () => void } = {};
vi.mock('@/lib/bridge', () => ({
  bridge: Object.assign(bridgeMock, {
    status: 'closed',
    call: () => new Promise(() => {}),
    on: (l: (e: BridgeEvent) => void) => ((listener = l), () => {}),
    onStatus: () => () => {},
    start: () => {},
  }),
}));

const store = await import('../src/state/store');
const { useStore } = store;

const meta = (id: string) => ({ id, provider: 'demo', cwd: 'C:/w', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }) as SessionMeta;
const text = (id: string, parentId?: string) => ({ id, ts: 0, type: 'text', text: '', streaming: true, ...(parentId ? { parentId } : {}) }) as TimelineItem;
const send = (e: BridgeEvent) => listener!(e);

beforeEach(() => {
  store.startBridge();
  store.flushEvents();
  useStore.setState({ ready: true, sessions: { s: meta('s') }, data: {} });
  store.applySnapshot({ session: meta('s'), items: [text('a')], permissions: [], questions: [], todos: [], queue: [] });
});

describe('a burst of events', () => {
  it('waits for the frame, then applies everything in order as one store write', () => {
    let writes = 0;
    const off = useStore.subscribe(() => writes++);
    const rev = useStore.getState().data.s.rev;
    for (let i = 0; i < 500; i++) send({ type: 'item.added', sessionId: 's', item: text(`c${i}`, 'a') });
    send({ type: 'item.delta', sessionId: 's', id: 'a', field: 'text', delta: 'Hel' });
    send({ type: 'item.patch', sessionId: 's', id: 'c3', patch: { streaming: false } as never });
    send({ type: 'item.delta', sessionId: 's', id: 'a', field: 'text', delta: 'lo' });
    send({ type: 'item.removed', sessionId: 's', id: 'c4' });
    expect(useStore.getState().data.s.children.a).toBeUndefined();
    store.flushEvents();
    off();
    const d = useStore.getState().data.s;
    expect(writes).toBe(1);
    expect(d.children.a).toHaveLength(499);
    expect(d.children.a).not.toContain('c4');
    expect((d.items.a as { text: string }).text).toBe('Hello');
    expect((d.items.c3 as { streaming: boolean }).streaming).toBe(false);
    // Readers that follow revisions see every id the burst touched.
    expect(store.changedSince(d, rev)).toEqual(expect.arrayContaining(['a', 'c0', 'c3', 'c4', 'c499']));
  });

  it('keeps the order against other events: a reset in the middle replaces what came before it', () => {
    send({ type: 'item.added', sessionId: 's', item: text('x') });
    send({ type: 'timeline.reset', sessionId: 's', items: [text('r')] });
    send({ type: 'item.added', sessionId: 's', item: text('y') });
    send({ type: 'todos.updated', sessionId: 's', todos: [{ content: 't', status: 'pending' }] as never });
    store.flushEvents();
    const d = useStore.getState().data.s;
    expect(d.roots).toEqual(['r', 'y']);
    expect(d.todos).toHaveLength(1);
  });

  it('an answer from the bridge is handed back only after the events sent before it', () => {
    send({ type: 'item.added', sessionId: 's', item: text('before') });
    expect(bridgeMock.beforeAnswer).toBe(store.flushEvents);
    bridgeMock.beforeAnswer!();
    expect(useStore.getState().data.s.roots).toContain('before');
  });

  it('a hidden window that draws no frame is caught up by the timer', async () => {
    send({ type: 'item.added', sessionId: 's', item: text('late') });
    await new Promise((r) => setTimeout(r, store.HOLD_EVENTS_MS + 20));
    expect(useStore.getState().data.s.roots).toContain('late');
  });
});
