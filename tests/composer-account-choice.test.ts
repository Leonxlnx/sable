import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { Capabilities, ProviderInfo, SessionMeta } from '../shared/protocol';
import { useOtherAgentModels } from '../src/features/composer/Controls';
import { useChoice, type Choice } from '../src/features/composer/choice';
import { rememberCaps, resetSeenCaps } from '../src/features/composer/caps-seen';
import { capsKey, useStore } from '../src/state/store';
import { homeChoice } from '../src/state/actions';

const { effects, fetchCaps } = vi.hoisted(() => ({ effects: [] as (() => void)[], fetchCaps: vi.fn() }));
vi.mock('../src/features/usage', () => ({ LimitDot: () => null }));
vi.mock('react', async (load) => ({ ...await load<typeof import('react')>(), useEffect: (effect: () => void) => effects.push(effect) }));
vi.mock('../src/state/store', async (load) => {
  const actual = await load<typeof import('../src/state/store')>();
  return { ...actual, ensureProviderCaps: fetchCaps, useStore: Object.assign(
    (select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => select(actual.useStore.getState()), actual.useStore) };
});
const caps = (id: string, ultracode = false): Capabilities => ({
  models: [{ id, name: id }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '/',
  features: { images: false, thinking: false, rewind: false, steer: false, compact: false, fast: false, ultracode },
});
const cwd = 'D:/project';
const provider = { id: 'claude', installed: true, auth: { loggedIn: true },
  accounts: ['default', 'a', 'b'].map((id) => ({ id, auth: { loggedIn: true } })) } as ProviderInfo;
function setup(saved?: string, folder = cwd) {
  useStore.getState().setUi({ homeAccount: { claude: 'b' }, homeCwd: cwd, homeProvider: 'claude', homeUltracode: true });
  useStore.setState({ providers: { claude: provider }, sessions: { chat: {
    cwd, provider: 'codex', agents: [{ provider: 'claude', cwd: folder, accountId: saved }],
  } as SessionMeta }, providerCaps: {} });
}
function otherModels() {
  function Models() {
    return useOtherAgentModels({ sessionId: 'chat', provider: 'codex' } as Choice, true).map(({ m }) => m.id).join(',');
  }
  effects.length = 0;
  const shown = renderToStaticMarkup(createElement(Models));
  effects.forEach((effect) => effect());
  return shown;
}
afterEach(() => { resetSeenCaps(); fetchCaps.mockClear(); vi.unstubAllGlobals(); });
it('lists and requests the returning leg’s account, even after the Home account changes', () => {
  setup('a', 'd:\\PROJECT\\');
  useStore.setState({ providerCaps: { [capsKey('claude', cwd, 'a')]: caps('A-only'), [capsKey('claude', cwd, 'b')]: caps('B-only') } });
  expect(otherModels()).toBe('A-only');
  expect(fetchCaps).toHaveBeenCalledWith('claude', cwd, 'a');
});
it('does not lend the built-in account’s list to a named account', () => {
  setup('a');
  useStore.setState({ providerCaps: { [capsKey('claude', cwd)]: caps('Built-in') } });
  expect(otherModels()).toBe('');
  expect(fetchCaps).toHaveBeenCalledWith('claude', cwd, 'a');
});
it('keeps a built-in account’s folder ending in @a distinct from account a', () => {
  expect(capsKey('claude', cwd + '@a')).not.toBe(capsKey('claude', cwd, 'a'));
  expect(capsKey('claude', cwd + '%40a')).not.toBe(capsKey('claude', cwd + '@a'));
});
it('uses the built-in account for an old leg, or Home when the account or Claude folder changed', () => {
  for (const [saved, folder, expected] of [[undefined, cwd, 'default'], ['gone', cwd, 'b'], ['a', 'D:/old', 'b']] as const) {
    setup(saved, folder);
    otherModels();
    expect(fetchCaps).toHaveBeenLastCalledWith('claude', cwd, expected);
  }
});

it('submits the Ultracode switch shown on Home after reload, including a newer live refusal', () => {
  const disk = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => disk.set(k, v) });
  setup();
  rememberCaps('claude', 'a', caps('A', false));
  rememberCaps('claude', 'b', caps('B', true));
  resetSeenCaps();
  function Switch() { return String(!!useChoice(null).caps?.features.ultracode); }
  const check = (on: boolean) => {
    expect(renderToStaticMarkup(createElement(Switch))).toBe(String(on));
    expect(!!homeChoice()?.ultracode).toBe(on);
  };
  check(true);
  useStore.setState({ providerCaps: { [capsKey('claude', 'D:/other', 'b')]: caps('B', false) } });
  check(false);
  useStore.setState({ providerCaps: { [capsKey('claude', null, 'b')]: caps('B', true) } });
  check(true);
  useStore.getState().setUi({ homeAccount: { claude: 'a' } });
  check(false);
});
