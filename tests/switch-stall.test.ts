/**
 * Hotfix of 0.2.38: a chat on the stage never stands as "reading" for ever. A first read that has
 * not answered after `STALL_MS` (the bridge answering otherwise) is asked again from its end, and
 * after as long again the conversation says it could not be read, with Try again, which asks anew
 * instead of sharing the request that stalled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMeta, SessionSnapshot, TimelineItem } from '@shared/protocol';

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; done?: boolean };
const calls: Call[] = [];
const fake = { status: 'open' as string };
vi.mock('@/lib/bridge', () => ({
  bridge: {
    get status() {
      return fake.status;
    },
    call: (method: string, params: Record<string, unknown>) => new Promise((resolve, reject) => calls.push({ method, params, resolve, reject })),
    on: () => () => {},
    onStatus: () => () => {},
    start: () => {},
  },
}));

const store = await import('../src/state/store');
const { useStore, STALL_MS } = store;

const meta = (id: string): SessionMeta =>
  ({ id, provider: 'demo', cwd: 'C:/w', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }) as SessionMeta;
const snap = (id: string): SessionSnapshot => ({ session: meta(id), items: [{ id: `${id}-0`, ts: 0, type: 'text', text: 'x', streaming: false } as TimelineItem], permissions: [], questions: [], todos: [], queue: [] });
const snapCalls = () => calls.filter((c) => c.method === 'session.snapshot');
const open = () => snapCalls().filter((c) => !c.done);

beforeEach(() => {
  calls.length = 0;
  fake.status = 'open';
  store.resetKept();
  useStore.setState((s) => ({ ready: true, sessions: { a: meta('a'), b: meta('b') }, data: {}, ui: { ...s.ui, activeSessionId: 'a', race: null } }));
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('a chat whose conversation never comes', () => {
  it('is asked again from its end, then says it could not be read', async () => {
    void store.loadSession('a').catch(() => {});
    expect(snapCalls()).toHaveLength(1);
    store.readStalled('a');
    // A second request beside the one that stalled.
    expect(snapCalls()).toHaveLength(2);
    expect(useStore.getState().data.a?.historyFailed).toBeFalsy();
    vi.advanceTimersByTime(STALL_MS);
    expect(useStore.getState().data.a?.historyFailed).toBe(true);
    // Try again asks anew (the stalled request is not handed back).
    void store.retryHistory('a').catch(() => {});
    expect(snapCalls()).toHaveLength(3);
    expect(useStore.getState().data.a?.historyFailed).toBe(false);
    const last = open().at(-1)!;
    last.done = true;
    last.resolve(snap('a'));
    await vi.runAllTimersAsync();
    expect(useStore.getState().data.a?.loaded).toBe(true);
    expect(useStore.getState().data.a?.historyFailed).toBeFalsy();
  });

  it('a late answer to the second request still puts the conversation in place of the line', async () => {
    void store.loadSession('a').catch(() => {});
    store.readStalled('a');
    vi.advanceTimersByTime(STALL_MS);
    expect(useStore.getState().data.a?.historyFailed).toBe(true);
    const second = snapCalls()[1];
    second.done = true;
    second.resolve(snap('a'));
    await vi.runAllTimersAsync();
    expect(useStore.getState().data.a?.loaded).toBe(true);
    expect(useStore.getState().data.a?.historyFailed).toBeFalsy();
  });

  it('an answer within the second wait marks nothing', async () => {
    void store.loadSession('a').catch(() => {});
    store.readStalled('a');
    const second = snapCalls()[1];
    second.done = true;
    second.resolve(snap('a'));
    await vi.advanceTimersByTimeAsync(10);
    vi.advanceTimersByTime(STALL_MS);
    expect(useStore.getState().data.a?.loaded).toBe(true);
    expect(useStore.getState().data.a?.historyFailed).toBeFalsy();
  });

  it('asks nothing while there is no connection (the window says so already), nor for a chat that is here', () => {
    fake.status = 'connecting';
    void store.loadSession('a').catch(() => {});
    store.readStalled('a');
    expect(snapCalls()).toHaveLength(1);
    vi.advanceTimersByTime(STALL_MS);
    expect(useStore.getState().data.a?.historyFailed).toBeFalsy();
    fake.status = 'open';
    store.applySnapshot(snap('b'));
    calls.length = 0;
    store.readStalled('b');
    expect(snapCalls()).toHaveLength(0);
  });
});

describe('a store listener that throws', () => {
  it('never keeps the listeners after it (the stage among them) from hearing the change', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBad = useStore.subscribe(() => {
      throw new Error('a listener failed');
    });
    const heard: (string | null)[] = [];
    const offGood = useStore.subscribe((s) => heard.push(s.ui.activeSessionId));
    useStore.getState().setUi({ activeSessionId: 'b' });
    expect(useStore.getState().ui.activeSessionId).toBe('b');
    expect(heard).toEqual(['b']);
    offBad();
    offGood();
    quiet.mockRestore();
  });
});
