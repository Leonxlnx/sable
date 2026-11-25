import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { SessionMeta, UntilState } from '../shared/protocol';
import { Tail } from '../src/features/timeline/Tail';
import { hasWork, workLabel } from '../shared/work-label';
import { worksNow } from '../mobile/src/lib/chat-rules';
import { liveOf, livePayload, workEnded } from '../mobile/src/lib/notes';

const state = vi.hoisted(() => ({ sessions: { chat: {} as SessionMeta }, data: {} }));
vi.mock('../src/state/store', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../src/features/timeline/ctx', () => ({ useTimeline: () => ({ sessionId: 'chat' }), useFresh: () => false }));
vi.mock('../src/features/timeline/util', async (load) => ({ ...await load<typeof import('../src/features/timeline/util')>(), useTick: () => 6000 }));
vi.mock('../src/state/actions', () => ({}));
const idle = { id: 'chat', title: 'Chat', status: 'idle' } as SessionMeta;
const running = { ...idle, status: 'running' } as const;
const check = { ...idle, until: { phase: 'checking', since: 1000 } as UntilState };
it('shows Running the check and its own elapsed time in the transcript until the check ends', () => {
  state.sessions.chat = check;
  const tail = renderToStaticMarkup(createElement(Tail));
  expect(tail).toContain('Running the check');
  expect(tail).toContain('5s');
  state.sessions.chat = idle;
  expect(renderToStaticMarkup(createElement(Tail))).toBe('');
});
it('renders a quiet timed server button, then gives the working line to a concurrent command', () => {
  const server = { ...idle, serving: 1, servingSince: 1000, servingAddress: 'localhost:3311' };
  state.sessions.chat = server;
  const quiet = renderToStaticMarkup(createElement(Tail));
  expect(quiet).toContain('Serving localhost:3311. Open Agents');
  expect(quiet).toContain('5s');
  expect(quiet).not.toContain('work-ind');
  state.sessions.chat = { ...server, commands: 1 };
  const mixed = renderToStaticMarkup(createElement(Tail));
  expect(mixed).toContain('Waiting for 1 background command');
  expect(mixed).toContain('work-ind');
  expect(mixed).not.toContain('5s');
  state.sessions.chat = { ...server, serving: 2 };
  expect(renderToStaticMarkup(createElement(Tail))).toContain('Serving 2 local servers');
});

it('keeps the phone working mark and live clock through the check', () => {
  expect(worksNow(check)).toBe(true);
  expect(hasWork(check)).toBe(true);
  expect(workLabel(check)).toBe('Running the check');
  const turn = liveOf([running], [], 10);
  const live = liveOf([check], turn.chats, 20);
  expect(livePayload({ notify: true, fresh: true, conn: 'open', listAt: 1 }, live)).toMatchObject({ chat: 'chat', since: 10, text: 'Running the check' });
});
it('posts completion only after the check and remaining background work end', () => {
  const between = { ...idle, until: { phase: 'working' } as UntilState };
  expect(workEnded({ ...running, until: between.until }, between)).toBe(false);
  expect(workEnded(running, check)).toBe(false);
  expect(workEnded(check, check)).toBe(false);
  expect(workEnded(check, { ...idle, commands: 1 })).toBe(false);
  expect(workEnded(check, idle)).toBe(true);
  expect(workEnded(idle, idle)).toBe(false);
});
