import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomeChips } from '../src/features/composer/Controls';
import { homeChoice } from '../src/state/actions';
import { useStore } from '../src/state/store';
import { pathKey } from '../src/features/sidebar/groups';

// Exercise the actual menu selection and home send choice without opening a window or a socket.
const { picks, effects, readTrees } = vi.hoisted(() => ({
  picks: new Map<string, () => void>(),
  effects: [] as (() => void | (() => void))[],
  readTrees: vi.fn(async (_cwd: string) => []),
}));
vi.mock('react', async (load) => ({ ...await load<typeof import('react')>(), useEffect: (effect: () => void | (() => void)) => effects.push(effect) }));
vi.mock('../src/lib/workspace', () => ({ worktrees: readTrees }));
vi.mock('radix-ui', async (load) => {
  const actual = await load<typeof import('radix-ui')>();
  const content = ({ children }: { children: ReactNode }) => children;
  return { ...actual, DropdownMenu: { ...actual.DropdownMenu, Root: content, Trigger: content, Portal: content, Content: content,
    Item: ({ title, onSelect, children }: { title?: string; onSelect(): void; children: ReactNode }) => {
      if (title) picks.set(title, onSelect);
      return children;
    },
  } };
});

const root = 'D:\\my project';
const side = 'C:\\linked folders\\side';
const branch = "fix/tom's-$choice";
beforeEach(() => {
  const cached = JSON.stringify({ [pathKey(root)]: [{ path: root, branch: 'main', main: true }, { path: side, branch, main: false }] });
  vi.stubGlobal('localStorage', { getItem: (key: string) => key === 'sable.treesSeen.v1' ? cached : null, setItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

it('refreshes the worktrees when returning from Git to an already open home', async () => {
  const windowEvents = new EventTarget();
  vi.stubGlobal('window', windowEvents);
  try {
    const cwd = 'D:\\another repo';
    useStore.getState().setUi({ homeCwd: cwd, homeChat: false });
    effects.length = 0;
    renderToStaticMarkup(createElement(HomeChips, { onClosed: () => {} }));
    const unmount = effects.map((effect) => effect());
    await Promise.resolve();
    expect(readTrees).toHaveBeenCalledTimes(1);
    windowEvents.dispatchEvent(new Event('focus'));
    expect(readTrees).toHaveBeenCalledTimes(2);
    for (const close of unmount) close?.();
    windowEvents.dispatchEvent(new Event('focus'));
    expect(readTrees).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
vi.mock('../src/state/store', async (load) => {
  const actual = await load<typeof import('../src/state/store')>();
  const current = () => actual.useStore.getState();
  return { ...actual, useStore: Object.assign((select: (state: ReturnType<typeof current>) => unknown) => select(current()), actual.useStore) };
});
vi.mock('../src/features/composer/Chip', () => ({ Chip: (props: { 'aria-label'?: string }) => createElement('button', { 'aria-label': props['aria-label'] }) }));
vi.mock('../src/ui', () => ({ Tip: ({ children }: { children: ReactNode }) => children, PathLabel: () => null }));
vi.mock('../src/features/usage', () => ({ LimitDot: () => null }));

it('keeps the selected branch on the first frame and sends its worktree as the new chat folder', () => {
  useStore.getState().setUi({ homeCwd: root, homeChat: false });
  const render = () => renderToStaticMarkup(createElement(HomeChips, { onClosed: () => {} }));
  expect(render()).toContain('Working tree: main');
  picks.get(side)!();
  expect(homeChoice()).toMatchObject({ cwd: side });
  expect(homeChoice()?.chat).toBeUndefined();
  expect(render()).toContain('Working tree: fix/tom&#x27;s-$choice');
});
