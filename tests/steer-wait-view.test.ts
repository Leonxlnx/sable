import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { TimelineItem, UserItem } from '@shared/protocol';
import { UserMessage } from '@/features/timeline/User';

// The person's card with its waiting line, rendered in Node: the real component over a store that
// holds one running turn. No window, no clock of its own (the conversation's tick is fixed).
const NOW = 1_800_000_130_000;
const state = vi.hoisted(() => ({
  sessions: { chat: { status: 'running', provider: 'claude' } } as Record<string, { status: string; provider: string }>,
  data: { chat: { items: {} as Record<string, TimelineItem>, roots: [] as string[], caps: undefined } },
}));
vi.mock('@/state/store', () => ({
  useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state, subscribe: vi.fn() }),
}));
vi.mock('@/state/actions', () => ({ rewindTo: vi.fn(), steerNow: vi.fn() }));
vi.mock('@/features/timeline/ctx', () => ({ useTimeline: () => ({ sessionId: 'chat', stuck: { current: true } }) }));
vi.mock('@/features/timeline/util', async (original) => ({ ...(await original<object>()), useTick: () => NOW }));
vi.mock('@/features/timeline/Again', () => ({ MessageAgain: () => null }));
vi.mock('@/features/composer/flight', () => ({ landInTimeline: () => false }));
vi.mock('@/features/composer/settle', () => ({ afterSend: () => () => {}, sendInAir: () => false }));
vi.mock('@/components/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('@/ui', async (original) => ({
  ...(await original<object>()),
  // The tooltip's words beside its control, so the markup says what the action costs.
  Tip: ({ label, children }: { label: ReactNode; children: ReactNode }) => createElement('span', { 'data-tip': String(label) }, children),
}));

const steer = (over: Partial<UserItem> = {}): UserItem => ({ type: 'user', id: 'steer', ts: NOW - 20_000, text: 'answer me', steered: true, state: 'queued', ...over });

function show(item: UserItem, rest: TimelineItem[] = []) {
  const all = [...rest, item];
  state.data.chat.items = Object.fromEntries(all.map((i) => [i.id, i]));
  state.data.chat.roots = all.filter((i) => !i.parentId).map((i) => i.id);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  return renderToStaticMarkup(createElement(UserMessage, { item }));
}

const ask: TimelineItem = { type: 'user', id: 'ask', ts: NOW - 300_000, text: 'do the work', state: 'sent' };
const agent: TimelineItem = { type: 'tool', id: 'agent', ts: NOW - 130_000, name: 'Agent', kind: 'agent', title: 'Read the code', detail: {}, status: 'running' };

beforeEach(() => {
  state.sessions.chat = { status: 'running', provider: 'claude' };
  vi.restoreAllMocks();
});

it('says what a waiting steer waits on and for how long, and offers Send now with what it costs', () => {
  const html = show(steer({ steerWait: { stepId: 'agent' } }), [ask, agent]);
  expect(html).toContain('data-steered="true"');
  expect(html).toContain('data-phase="waiting"');
  expect(html).toContain('aria-label="Waiting for Read the code 2m 10s"');
  expect(html).toMatch(/steer-wait-label[^>]*>Waiting for Read the code</);
  // The clock stands in the room of its widest form.
  expect(html).toMatch(/steer-wait-clock num"><span aria-hidden="true">9m 59s<\/span><span>2m 10s<\/span>/);
  expect(html).toMatch(/data-tip="Interrupts the running step"><button type="button" class="steer-now"[^>]*>.*Send now<\/button>/);
  expect(html).not.toContain('aria-disabled');
  // The line is the card's row's last child: under the card, inside the row that glides.
  expect(html.indexOf('class="steer-wait"')).toBeGreaterThan(html.indexOf('class="user-card"'));
});

it('counts down to the bridge’s own send and keeps the action', () => {
  const html = show(steer({ steerWait: { stepId: 'agent', autoAt: NOW + 23_500 } }), [ask, agent]);
  expect(html).toContain('data-phase="countdown"');
  expect(html).toContain('aria-label="Sends in 0:24"');
  expect(html).toMatch(/steer-wait-label[^>]*>Sends in</);
  expect(html).not.toContain('steer-wait-dot');
  expect(html).toContain('Send now');
});

it('says Sending once the bridge’s time has come, with the action in place and out of reach', () => {
  const html = show(steer({ steerWait: { stepId: 'agent', autoAt: NOW - 500 } }), [ask, agent]);
  expect(html).toContain('data-phase="sending"');
  expect(html).toMatch(/steer-wait-label[^>]*>Sending</);
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toContain('steer-wait-clock');
});

it('names the agent’s next step when no step is known', () => {
  const html = show(steer({ steerWait: {} }), [ask]);
  expect(html).toContain('aria-label="Waiting for Claude Code’s next step 20s"');
  expect(html).toContain('data-tip="Interrupts what the agent is doing"');
});

it('offers no action where the bridge did not mark the steer, and still says what it waits on', () => {
  state.sessions.chat = { status: 'running', provider: 'codex' };
  const html = show(steer(), [ask, agent]);
  expect(html).toMatch(/steer-wait-label[^>]*>Waiting for Read the code</);
  expect(html).not.toContain('Send now');
  expect(html).not.toContain('steer-now');
});

it('shows no line once the agent took the message, under a queued message, or under a sub-agent’s', () => {
  expect(show(steer({ state: 'sent', steerWait: null }), [ask, agent])).not.toContain('steer-wait');
  expect(show(steer({ steered: false }), [ask, agent])).not.toContain('steer-wait');
  expect(show(steer({ parentId: 'agent', steerWait: {} }), [ask, agent])).not.toContain('steer-wait');
});
