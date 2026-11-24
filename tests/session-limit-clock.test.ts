import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionLimits } from '../src/features/usage/scope';
import { accountUsed, usedText } from '../src/features/usage/words';

const state = vi.hoisted(() => ({
  sessions: { chat: { provider: 'claude', model: 'large' } }, data: {}, limitReports: {},
  limits: [{ id: 'five_hour', label: '5-hour limit', percent: 100, resetsAt: 200 }],
}));
vi.mock('../src/state/store', () => ({
  accountKey: () => 'account',
  useStore: (select: (s: unknown) => unknown) => select({ ...state, limits: { account: state.limits } }),
}));
vi.mock('../src/lib/useNow', () => ({ useNow: () => Date.now() }));
// Keep this hook's memo between the two static renders, just as an already mounted header does.
vi.mock('react', async (load) => {
  let deps: unknown[] | undefined;
  let value: unknown;
  return { ...await load<typeof import('react')>(), useMemo: (read: () => unknown, next: unknown[]) => {
    if (!deps || next.length !== deps.length || next.some((v, i) => v !== deps![i])) value = read();
    deps = next;
    return value;
  } };
});
afterEach(() => vi.useRealTimers());
it('clears the cap beside 0% used on the reset tick without a new account report', () => {
  vi.useFakeTimers();
  function Header() {
    const lim = useSessionLimits('chat')!;
    return [lim.level ?? 'clear', usedText(accountUsed(state.limits, Date.now())!.pct)].join(' / ');
  }
  vi.setSystemTime(199);
  expect(renderToStaticMarkup(createElement(Header))).toBe('cap / 100% used');
  vi.setSystemTime(200);
  expect(renderToStaticMarkup(createElement(Header))).toBe('clear / 0% used');
});
