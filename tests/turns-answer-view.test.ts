import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { TurnList } from '@/features/timeline/TurnView';

// Render the real turn, fold, live line and footer in Node. ItemRow exposes the
// ink it was asked to draw. No window, animation clock or agent is needed.
const state = vi.hoisted(() => ({
  open: false,
  sessions: { '': { status: 'running' } },
  data: { '': { items: {} as Record<string, TimelineItem>, children: {}, rev: 0, permissions: [], questions: [] } },
}));
vi.mock('@/state/store', () => ({
  useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state, subscribe: vi.fn() }),
}));
// Keys do not appear in HTML. Keep the actual keyed reply element from each render.
const replyElements = vi.hoisted(() => [] as ReactElement[]);
vi.mock('react/jsx-dev-runtime', async original => {
  const runtime = await original<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, ...rest) => {
    const element = runtime.jsxDEV(type, props, key, ...rest);
    if (key !== undefined && props && typeof props === 'object' && 'id' in props && props.id === 'reply') replyElements.push(element);
    return element;
  };
  return { ...runtime, jsxDEV };
});
vi.mock('@/state/actions', () => ({}));
vi.mock('@/features/timeline/items', () => ({
  estimate: () => 40,
  ItemList: () => null,
  ItemRow: ({ id, answer }: { id: string; answer?: boolean }) => createElement('span', { 'data-row': id, 'data-ink': answer ? 'answer' : 'normal' }),
}));
vi.mock('@/features/timeline/fold', async original => ({ ...await original<object>(), useFold: () => [state.open, () => {}] }));
vi.mock('@/features/timeline/util', async original => ({ ...await original<object>(), useTick: () => 158_000 }));
vi.mock('@/features/timeline/Tail', () => ({ Tail: () => null }));
vi.mock('@/features/compare/BeforeAfter', () => ({ BeforeAfter: () => null }));
vi.mock('@/components/LazyTip', () => ({ LazyTip: ({ children }: { children: ReactNode }) => children }));

it('renders the reply before the live and Worked lines, and offers previews from the closing answer', () => {
  const rows: TimelineItem[] = [
    { type: 'user', id: 'person', ts: 1000, text: 'Where is the preview?' },
    { type: 'text', id: 'reply', ts: 2000, text: 'I saw the old page on http://localhost:3100.', streaming: false },
  ];
  for (let i = 0; i < 4; i++) rows.push({
    type: 'tool', id: `read${i}`, ts: 3000 + i, name: 'Read', kind: 'read', title: 'Read file', detail: {}, status: 'done',
  });
  const render = () => {
    state.data[''].items = Object.fromEntries(rows.map(i => [i.id, i]));
    state.data[''].rev++;
    return renderToStaticMarkup(createElement(TurnList, { ids: rows.map(i => i.id) }));
  };
  const direct = 'data-row="reply" data-ink="answer"';
  const live = render();
  expect(live).toContain('data-row="person"');
  expect(live.indexOf(direct)).toBeGreaterThan(live.indexOf('data-row="person"'));
  expect(live.indexOf('role="status"')).toBeGreaterThan(live.indexOf(direct));

  rows.push({ type: 'text', id: 'closing', ts: 157_000, text: 'The updated page is on http://localhost:3200.', streaming: false },
    { type: 'turn', id: 'end', ts: 158_000, durationMs: 157_000 });
  state.sessions[''].status = 'idle';
  const done = render();
  expect(replyElements.map(e => e.key)).toEqual(['reply', 'reply']);
  expect(replyElements[1].type).toBe(replyElements[0].type);
  expect(done.split(direct)).toHaveLength(2);
  expect(done).toMatch(/data-row="person".*data-row="reply" data-ink="answer".*Worked 2m 37s.*4 steps.*data-row="closing" data-ink="answer"/);
  expect(done).toContain('aria-label="Preview localhost:3200"');
  expect(done).not.toContain('aria-label="Preview localhost:3100"');
});

it('renders the stopped checkpoint, the resumed live clock and the opened Worked total', () => {
  const rows: TimelineItem[] = [
    { type: 'user', id: 'u', ts: 1000, text: 'Work' },
    { type: 'tool', id: 'w', ts: 3000, endedAt: 48_000, kind: 'read', name: 'Read', title: 'Read file', detail: {}, status: 'done' },
    { type: 'notice', id: 'cut', ts: 48_000, variant: 'interrupted', text: 'Stopped' },
    { type: 'user', id: 's', ts: 7000, steered: true, state: 'sent', text: 'Reply' },
  ];
  const render = () => {
    state.data[''].items = Object.fromEntries(rows.map(i => [i.id, i]));
    state.data[''].rev++;
    return renderToStaticMarkup(createElement(TurnList, { ids: rows.map(i => i.id) }));
  };
  state.sessions[''].status = 'running';
  const taken = render();
  expect(taken).toContain('Worked 45s');
  expect(taken.slice(taken.indexOf('role="status"'))).not.toContain('work-time num');
  rows.push({ type: 'notice', id: 'info', ts: 50_000, variant: 'info', text: 'Mode changed' },
    { type: 'thinking', id: 'h', ts: 150_000, text: 'Thinking', streaming: true });
  expect(render()).toMatch(/Worked 45s.*role="status".*work-time num">8s</);
  rows.push({ type: 'text', id: 'a', ts: 159_000, text: 'Here is the answer.', streaming: false },
    { type: 'turn', id: 'r', ts: 160_000, durationMs: 11_000 });
  state.sessions[''].status = 'idle';
  state.open = true;
  try {
    const opened = render();
    expect(opened).toContain('Worked 56s');
    expect(opened).toContain('Worked 45s');
    expect(opened).toContain('Thought for 10s');
  } finally {
    state.open = false;
  }
});
