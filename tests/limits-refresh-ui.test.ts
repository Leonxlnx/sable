import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountInfo, LimitsReport, ProviderInfo } from '@shared/protocol';
import { accountKey, applyEvent, useStore, type Store } from '../src/state/store';
import { ConnectCard } from '../src/features/connect/Connect';
import { AccountSwitcher } from '../src/features/accounts/Switcher';
import { readStaleFullLimits } from '../src/state/actions';

const menu = vi.hoisted(() => ({
  select: undefined as (() => void) | undefined,
  open: undefined as ((open: boolean) => void) | undefined,
  call: vi.fn(async (_method: string, _params: unknown) => []),
}));
vi.mock('@/lib/bridge', () => ({ bridge: { call: menu.call, on: vi.fn(), onStatus: vi.fn() } }));
vi.mock('@/lib/useNow', () => ({ useNow: () => Date.now() }));
vi.mock('@/features/usage', () => ({ LimitsGlance: () => null }));
vi.mock('@/state/store', async original => {
  const store = await original<typeof import('../src/state/store')>();
  return { ...store, useStore: Object.assign((select: (s: Store) => unknown) => select(store.useStore.getState()), store.useStore) };
});
vi.mock('@/ui', async original => {
  const pass = ({ children }: { children: ReactNode }) => children;
  return { ...await original<object>(), Menu: pass, MenuContent: pass, MenuTrigger: () => null, MenuSep: () => null,
    MenuItem: ({ children, onSelect }: { children: string; onSelect: () => void }) => {
      if (children === 'Refresh') menu.select = onSelect;
      return null;
    } };
});
vi.mock('radix-ui', async original => {
  const radix = await original<typeof import('radix-ui')>();
  return { ...radix, DropdownMenu: { ...radix.DropdownMenu, Root: ({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => {
    menu.open = onOpenChange;
    return null;
  } } };
});

const account = (id: string, auth: AccountInfo['auth'] = { loggedIn: true }): AccountInfo =>
  ({ id, auth, provider: 'claude', label: id, isDefault: id === 'default' });
const setAccounts = (accounts: AccountInfo[]) => {
  const info: ProviderInfo = { id: 'claude', name: 'Claude Code', auth: { loggedIn: true }, installed: true, accounts };
  useStore.setState({ providers: { claude: info } });
};
afterEach(() => { menu.call.mockClear(); vi.useRealTimers(); });

it('the account-card Refresh sends force to the bridge for that account', () => {
  setAccounts([account('studio')]);
  renderToStaticMarkup(createElement(ConnectCard, { provider: 'claude' }));
  expect(menu.call).not.toHaveBeenCalled();
  menu.select!();
  expect(menu.call).toHaveBeenCalledWith('provider.limits', { provider: 'claude', accountId: 'studio', force: true });
});

it('shows the last signed-in row during a read and offers Sign in on a confirmed sign-out', () => {
  setAccounts([account('studio', { loggedIn: true, plan: 'Max', email: 'studio@example.invalid' })]);
  const provider = useStore.getState().providers.claude!;
  const card = () => renderToStaticMarkup(createElement(ConnectCard, { provider: 'claude' }));
  applyEvent({ type: 'provider.updated', provider: { ...provider, accounts: [account('studio', { loggedIn: false, checking: true })] } });
  expect(card()).toContain('studio@example.invalid');
  expect(card()).not.toContain('>Sign in<');
  setAccounts([account('studio', { loggedIn: false, checking: true })]);
  expect(card()).toContain('Checking sign-in');
  expect(card()).not.toContain('>Sign in<');
  applyEvent({ type: 'provider.updated', provider: { ...provider, accounts: [account('studio', { loggedIn: false })] } });
  expect(card()).toContain('>Sign in</button>');
});

it('opening the switcher and its pane spaces stale full accounts and checks each at most once in ten minutes', async () => {
  vi.useFakeTimers();
  const accounts = [account('default'), account('full'), account('room'), account('new'), account('out', { loggedIn: false }),
    account('key', { loggedIn: true, method: 'api_key' }), account('unmetered')];
  setAccounts(accounts);
  const reports = accounts.map(({ id }): LimitsReport => ({ provider: 'claude', accountId: id, history: {}, pace: {},
    readAt: Date.now() - (id === 'new' ? 60_000 : 700_000), planLimits: id !== 'unmetered',
    limits: [{ id: 'model_Fable', label: 'Weekly Fable', percent: id === 'room' ? 0 : 100 }] }));
  useStore.setState({ limitReports: Object.fromEntries(reports.map(r => [accountKey('claude', r.accountId), r])) });
  renderToStaticMarkup(createElement(AccountSwitcher));
  expect(menu.call).not.toHaveBeenCalled();
  menu.open!(true);
  const pane = () => readStaleFullLimits({ provider: 'claude', accountId: 'full' });
  void pane();
  await vi.advanceTimersByTimeAsync(0);
  expect(menu.call.mock.calls).toEqual([['provider.limits', { provider: 'claude', accountId: 'default', force: true }]]);
  await vi.advanceTimersByTimeAsync(4000);
  expect(menu.call.mock.calls[1]).toEqual(['provider.limits', { provider: 'claude', accountId: 'full', force: true }]);
  menu.open!(false);
  menu.open!(true);
  await pane();
  expect(menu.call).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(599_999);
  await pane();
  expect(menu.call).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await pane();
  expect(menu.call).toHaveBeenCalledTimes(3);
});
