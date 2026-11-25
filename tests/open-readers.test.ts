import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@shared/protocol';
import { applySnapshot, completeSession, resetKept, useStore } from '@/state/store';
import { AgentsTab } from '@/features/rail/AgentsTab';
import { ContextTab } from '@/features/rail/ContextTab';
import { conversationHits } from '@/features/session/FindBar';
import { APP_COMMANDS, type CommandCtx } from '@/features/composer/commands';
import { copyChatMarkdown } from '@/features/export/export';
import { searchAll } from '@/features/palette/messages';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/features/usage', () => ({ LimitsGlance: () => null }));
vi.mock('@/lib/bridge', () => ({ bridge: { status: 'connecting', call, on: () => () => {}, onStatus: () => {} } }));
vi.mock('@/state/store', async load => {
  const actual = await load<typeof import('@/state/store')>();
  return { ...actual, useStore: Object.assign((select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) =>
    select(actual.useStore.getState()), actual.useStore) };
});
const snap: SessionSnapshot = {
  session: { id: 's', provider: 'demo', title: 'History', titleSource: 'user', cwd: 'C:/w', model: 'm',
    mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { turns: 0, inputTokens: 0, outputTokens: 0 } },
  items: [{ id: 't', type: 'turn', durationMs: 1, ts: 4 }], permissions: [], questions: [], todos: [], queue: [],
};
afterEach(() => { resetKept(); vi.unstubAllGlobals(); call.mockReset(); });
it('find, the two history tabs and copy wait for the prefix; palette search follows its own complete source', async () => {
  let answer!: (value: SessionSnapshot) => void;
  call.mockImplementation(method => method === 'session.markdown' ? Promise.resolve({ markdown: 'Complete transcript' }) :
    new Promise(resolve => { answer = resolve; }));
  vi.stubGlobal('window', { clearTimeout, setTimeout });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  applySnapshot({ ...snap, page: { kind: 'end', before: 2, rootsBefore: 2, recentAt: 0 } });
  const ui = (Tab: typeof ContextTab | typeof AgentsTab) => renderToStaticMarkup(createElement(Tab, { sessionId: 's', active: false }));
  expect(ui(AgentsTab)).toContain('Reading conversation');
  expect(ui(ContextTab)).toContain('Reading conversation');
  expect(conversationHits('s', 'needle')).toBeNull();
  const copy = APP_COMMANDS.find(c => c.name === 'copy')!.run({ sessionId: 's' } as CommandCtx, '');
  const markdown = copyChatMarkdown('s');
  expect(call.mock.calls.some(([m]) => m === 'session.markdown')).toBe(false);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  const search = vi.fn().mockResolvedValueOnce({ hits: [], partial: true, cursor: 'next' })
    .mockResolvedValueOnce({ hits: [{ itemId: 'u' }], partial: false });
  const show = vi.fn();
  await searchAll(search, 'needle', () => true, show);
  expect(show.mock.calls.map(([r]) => r.busy)).toEqual([true, false]);
  expect(show.mock.lastCall![0].hits).toEqual([{ itemId: 'u' }]);
  answer({ ...snap, page: { kind: 'older', before: 0, rootsBefore: 0, recentAt: 0 }, items: [
    { id: 'u', ts: 1, type: 'user', text: 'Find a needle' },
    { id: 'a', ts: 2, type: 'text', text: 'I found the needle in the older part of this conversation.', streaming: false },
  ] });
  await Promise.all([copy, markdown]);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Complete transcript');
  await completeSession('s');
  expect(conversationHits('s', 'needle')?.map(h => h.itemId)).toEqual(['u', 'a']);
  expect(ui(AgentsTab)).not.toContain('Reading conversation');
  expect(ui(ContextTab)).toContain('Context window');
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith('I found the needle in the older part of this conversation.');
  expect(useStore.getState().data.s.incomplete).toBe(false);
});


it('finishes every reader after backed-off pages and one failed whole retry', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  try {
    call.mockRejectedValue(Error('page unavailable'));
    applySnapshot({ ...snap, page: { kind: 'end', before: 2, rootsBefore: 2, recentAt: 0 } });
    const results = Promise.allSettled([completeSession('s'), completeSession('s')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await results).map(r => r.status === 'rejected' && r.reason.message)).toEqual(Array(2).fill('Could not read the whole conversation'));
    expect(call.mock.calls.filter(([, p]) => p.page)).toHaveLength(3);
    expect(call.mock.calls.filter(([, p]) => !p.page)).toHaveLength(1);
    for (const Tab of [AgentsTab, ContextTab]) {
      const ui = renderToStaticMarkup(createElement(Tab, { sessionId: 's', active: false }));
      expect(ui).toContain('Could not read the whole conversation');
      expect(ui).toContain('Try again');
    }
  } finally { vi.useRealTimers(); }
});

it('Try again shares a successful replacement between the waiting readers', async () => {
  const { retryHistory } = await import('@/state/store');
  vi.stubGlobal('window', { clearTimeout, setTimeout });
  applySnapshot(snap);
  useStore.setState(s => ({ data: { ...s.data, s: { ...s.data.s, incomplete: true, historyFailed: true } } }));
  let resolve!: (value: SessionSnapshot) => void;
  call.mockImplementation(() => new Promise(r => { resolve = r; }));
  const retry = retryHistory('s');
  const joined = Promise.all([completeSession('s'), completeSession('s'), retryHistory('s')]);
  expect(call).toHaveBeenCalledTimes(1);
  resolve(snap);
  await Promise.all([retry, joined]);
  expect(useStore.getState().data.s.incomplete).toBe(false);
});
