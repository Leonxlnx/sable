import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { LimitNotice } from '../src/features/accounts/LimitNotice';
import type { NoticeItem } from '../shared/protocol';

const state = vi.hoisted(() => ({
  ui: { activeSessionId: 'chat' }, sessions: { chat: { provider: 'claude', status: 'idle' } },
  providers: { claude: { accounts: [{ id: 'other', label: 'Studio', auth: { loggedIn: true } }] } },
}));
vi.mock('../src/state/store', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('../src/state/hooks', () => ({ accountName: (a: {label: string}) => a.label, useLimitLevel: () => 'cap' }));
vi.mock('../src/lib/useNow', () => ({ useNow: Date.now }));
vi.mock('../src/features/usage/LimitReset', () => ({ useResets: () => undefined, useResetOffers: () => undefined }));
vi.mock('../src/features/usage/ResetInAgent', () => ({ useResetInAgent: () => undefined }));
vi.mock('../src/state/actions', () => ({}));
vi.mock('../src/features/composer/SpareStrip', () => ({ SpareClock: () => null }));

const render = (limit: NoticeItem['limit']) => renderToStaticMarkup(createElement(LimitNotice, {
  item: { id: 'refusal', ts: 1, type: 'notice', text: 'Limit', variant: 'error', limit },
}));
it('offers the selected account even with a full unrelated model week', () => {
  expect(render({ provider: 'claude', next: 'other', window: 'Weekly · Fable' })).toContain('Continue with Studio');
});
it('explains an empty selection only after the server decides', () => {
  expect(render({ window: 'Weekly · Fable' })).not.toContain('No other account has room');
  expect(render({ provider: 'claude', window: 'Weekly · Fable' })).toContain('No other account has room');
});
