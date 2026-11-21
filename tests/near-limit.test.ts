/**
 * The in-app limit warnings: one toast as a window reaches 80%, a stronger one when used up,
 * nothing repeated while it stays there, and a new warning once it has cooled below 70%.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimit } from '@shared/protocol';

vi.mock('@/art/Logo', () => ({ PROVIDER_NAME: { claude: 'Claude Code', codex: 'Codex', demo: 'Demo' } }));
vi.mock('@/features/usage/LimitReset', () => ({
  windowPhrase: (l: { label: string } | undefined) => (l ? `the ${l.label.toLowerCase()}` : 'the limits'),
}));

const g = globalThis as Record<string, unknown>;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => {};
g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
g.document = { hidden: false };
g.window = globalThis;

type StoreModule = typeof import('../src/state/store');
type NearModule = typeof import('../src/features/usage/near-limit');
let S: StoreModule;
let N: NearModule;

beforeAll(async () => {
  S = await import('../src/state/store');
  N = await import('../src/features/usage/near-limit');
});

const win = (percent: number, label = '5-hour limit', resetsAt = Date.now() + 3_600_000): RateLimit => ({
  id: label,
  label,
  percent,
  resetsAt,
  windowMins: 300,
});

const texts = () => S.useStore.getState().toasts.map((t) => ({ text: t.text, level: t.level }));

let stop: () => void;

beforeEach(() => {
  stop?.();
  S.useStore.setState({
    providers: { claude: { id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } } } as never,
    limits: {},
    limitReports: {},
    toasts: [],
  });
  stop = N.watchLimitWarnings();
});

describe('limit warnings', () => {
  it('warns once when a window reaches 80%, and not again while it stays there', () => {
    S.useStore.setState({ limits: { claude: [win(85)] } });
    expect(texts()).toEqual([{ text: 'Claude Code is at 85% of the 5-hour limit', level: 'warn' }]);

    S.useStore.setState({ limits: { claude: [win(90)] } });
    S.useStore.setState({ limits: { claude: [win(95)] } });
    expect(texts()).toHaveLength(1);
  });

  it('stays quiet below 80%', () => {
    S.useStore.setState({ limits: { claude: [win(79)] } });
    expect(texts()).toEqual([]);
  });

  it('warns again when a used-up window is announced as used up', () => {
    S.useStore.setState({ limits: { claude: [win(85)] } });
    S.useStore.setState({ limits: { claude: [win(100)] } });
    expect(texts()[1]).toEqual({ text: 'Claude Code has used up the 5-hour limit', level: 'error' });
  });

  it('does not repeat while a window dips between 70% and 80%, and warns again after it cools below 70%', () => {
    S.useStore.setState({ limits: { claude: [win(85)] } });
    S.useStore.setState({ limits: { claude: [win(75)] } });
    S.useStore.setState({ limits: { claude: [win(82)] } });
    expect(texts()).toHaveLength(1);

    S.useStore.setState({ limits: { claude: [win(60)] } });
    S.useStore.setState({ limits: { claude: [win(81)] } });
    expect(texts()).toHaveLength(2);
  });

  it('ignores a window whose reset has passed', () => {
    S.useStore.setState({ limits: { claude: [win(95, '5-hour limit', Date.now() - 1000)] } });
    expect(texts()).toEqual([]);
  });

  it('names the account when the agent has several', () => {
    S.useStore.setState({
      providers: {
        claude: {
          id: 'claude',
          name: 'Claude Code',
          installed: true,
          auth: { loggedIn: true },
          accounts: [
            { id: 'default', provider: 'claude', label: 'Main', isDefault: true, auth: { loggedIn: true } },
            { id: 'work', provider: 'claude', label: 'Work', isDefault: false, auth: { loggedIn: true } },
          ],
        },
      } as never,
      limits: { 'claude:work': [win(88)] },
    });
    expect(texts()).toEqual([{ text: 'Claude Code (Work) is at 88% of the 5-hour limit', level: 'warn' }]);
  });
});
