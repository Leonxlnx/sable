import { Children, createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { DropdownMenu as RM } from 'radix-ui';
import { ModelEffort } from '../src/features/composer/Phrase';
import { ConversationFind } from '../src/features/session/FindBar';
import { takeSteps } from '../src/features/timeline/nav-bus';
import type { Choice } from '../src/features/composer/choice';
import { levelChord, opensPanel, ultraChord } from '../src/features/composer/effort-track';

// Render the real panel and drive the callbacks Radix receives. The browser's focus and menu
// geometry are supplied by the test, so a closing animation needs no window or timing guess.
const ui = vi.hoisted(() => ({
  content: {} as ComponentProps<typeof RM.Content>,
  changeOpen: (_open: boolean) => {},
  modelPick: () => {},
  cross: (_pt: { clientX: number; clientY: number }) => {},
  enterScale: () => {},
  query: '',
  input: { focus: () => {} },
  triggerKey: (_event: unknown) => {},
  effects: [] as (() => void | (() => void))[],
  pop: { dataset: { state: 'open' }, contains: (_el: unknown) => false },
}));
vi.mock('radix-ui', async (load) => {
  const actual = await load<typeof import('radix-ui')>();
  const children = (p: { children?: ReactNode }) => p.children;
  return { ...actual, DropdownMenu: {
    Root: (p: ComponentProps<typeof RM.Root>) => { ui.changeOpen = p.onOpenChange!; return createElement(actual.DropdownMenu.Root, p); },
    Trigger: actual.DropdownMenu.Trigger, Portal: children,
    RadioGroup: (p: ComponentProps<typeof RM.RadioGroup>) => {
      if (p.className === 'mx-scale') {
        Object.assign(p.ref!, { current: { getBoundingClientRect: () => ({ left: 160, top: 0, bottom: 140 }) } });
        ui.enterScale = () => p.onPointerEnter?.({} as never);
      }
      if (p.className === 'mx-models' && ui.query) {
        const search = Children.toArray(p.children)[0] as ReactElement<{ children: ReactNode }>;
        for (const child of Children.toArray(search.props.children)) {
          if (isValidElement<{ ref: object }>(child) && child.type === 'input') Object.assign(child.props.ref, { current: ui.input });
        }
      }
      return p.children;
    },
    Content: (p: ComponentProps<typeof RM.Content>) => {
      ui.content = p;
      Object.assign(p.ref!, { current: ui.pop });
      return p.children;
    },
    RadioItem: (p: ComponentProps<typeof RM.RadioItem>) => {
      if (p.value === 'demo\u0001large') ui.modelPick = () => p.onSelect!(new Event('select'));
      if (p.value === 'demo\u0001deep') ui.cross = (pt) => p.onPointerMove!(pt as never);
      return p.children;
    },
  } };
});
vi.mock('../src/features/composer/Controls', () => ({
  useOtherAgentModels: () => [], useMenuPlace: () => ({ side: 'top' }), useReleaseGuard: () => ({}),
  MENU_PAD: 8, ROW_H: 28, Hits: () => null,
}));
vi.mock('react', async (load) => {
  const react = await load<typeof import('react')>();
  return { ...react, useState: (initial: unknown) => react.useState(initial === '' ? ui.query : initial),
    useEffect: (effect: () => void | (() => void)) => ui.effects.push(effect) };
});
vi.mock('../src/features/composer/Chip', () => ({ Chip: (p: { onKeyDown: typeof ui.triggerKey }) => { ui.triggerKey = p.onKeyDown; return null; } }));
vi.mock('../src/ui', () => ({ Tip: ({ children }: { children: ReactNode }) => children }));
const model = { id: 'large', name: 'Demo Large', efforts: ['medium', 'high'] };
function render() {
  const onClosed = vi.fn();
  vi.stubGlobal('document', { activeElement: {}, body: {} });
  vi.stubGlobal('window', globalThis);
  const choice = { provider: 'demo', caps: { models: [model] }, model, modelId: 'large',
    models: [model, { ...model, id: 'deep' }], effort: 'high', speeds: [], pickModel: vi.fn() } as unknown as Choice;
  renderToStaticMarkup(createElement(ModelEffort, { choice, side: 'top', onClosed,
    ultraOffered: false, ultracode: false, onUltracode: () => {} }));
  return { onClosed, choice };
}
afterEach(() => { ui.query = ''; ui.effects.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

it('leaves the clicked Find field focused through the end of dismissal', () => {
  const { onClosed } = render();
  const find = { focus: () => Object.assign(document, { activeElement: find }) };
  const target = { closest: () => find };
  const event = new Event('outside', { cancelable: true });
  Object.assign(event, { detail: { originalEvent: { target, preventDefault: vi.fn() } } });
  ui.content.onPointerDownOutside?.(event as Parameters<NonNullable<typeof ui.content.onPointerDownOutside>>[0]);
  if (!event.defaultPrevented) ui.changeOpen(false);
  expect(document.activeElement).toBe(find);
  const focus = new Event('outside', { cancelable: true });
  ui.content.onFocusOutside?.(focus as Parameters<NonNullable<typeof ui.content.onFocusOutside>>[0]);
  if (!focus.defaultPrevented) ui.changeOpen(false);
  const exit = new Event('close', { cancelable: true });
  ui.content.onCloseAutoFocus!(exit);
  expect(exit.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(find);
  expect(onClosed).not.toHaveBeenCalled();
});

it('returns focus immediately on a background click without leaving it on the body', () => {
  vi.useFakeTimers();
  const { onClosed } = render();
  const originalEvent = { target: { closest: () => null }, preventDefault: vi.fn() };
  const outside = Object.assign(new Event('outside', { cancelable: true }), { detail: { originalEvent } });
  ui.content.onPointerDownOutside!(outside as never);
  if (!outside.defaultPrevented) ui.changeOpen(false);
  expect(onClosed).toHaveBeenCalledOnce();
  expect(originalEvent.preventDefault).toHaveBeenCalledOnce();
});

it('focuses the composer in the model-pick event, before native AltGr input or the exit animation', () => {
  const { onClosed, choice } = render();
  ui.modelPick();
  ui.changeOpen(false);
  expect(choice.pickModel).toHaveBeenCalledWith('large');
  expect(onClosed).toHaveBeenCalledTimes(1);
  const exit = new Event('close', { cancelable: true });
  ui.content.onCloseAutoFocus!(exit);
  expect(exit.defaultPrevented).toBe(true);
  expect(onClosed).toHaveBeenCalledTimes(1);
});

it('cancels the crossed model’s 110 ms timer on entry into the effort scale', () => {
  vi.useFakeTimers();
  render();
  ui.content.onPointerMove!({ clientX: 60, clientY: 14 } as never);
  ui.cross({ clientX: 70, clientY: 22 });
  expect(vi.getTimerCount()).toBe(1);
  ui.enterScale();
  expect(vi.getTimerCount()).toBe(0);
});

function keyEvent(key: string, mods = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, getModifierState: () => false,
    nativeEvent: { isComposing: false }, target: ui.input, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...mods };
}
it('lets the filter edit the second letter of de without sending it to Radix typeahead', () => {
  ui.query = 'd';
  render();
  const key = keyEvent('e');
  ui.content.onKeyDownCapture!(key as never);
  expect(key.preventDefault).not.toHaveBeenCalled();
  expect(key.stopPropagation).toHaveBeenCalledOnce();
});
it('commits the first filtered model and hands native typing to the composer immediately', () => {
  vi.useFakeTimers();
  ui.query = 'de';
  const { onClosed, choice } = render();
  ui.content.onKeyDownCapture!(keyEvent('Enter') as never);
  expect(choice.pickModel).toHaveBeenCalledWith('large');
  expect(onClosed).toHaveBeenCalledOnce();
});
it('lets a row bypass Radix selection during AltGr and IME input', () => {
  render();
  for (const mods of [{ ctrlKey: true, altKey: true }, { getModifierState: () => true }, { nativeEvent: { isComposing: true } }]) {
    const key = keyEvent('Enter', { target: {}, ...mods });
    ui.content.onKeyDownCapture!(key as never);
    expect(key.stopPropagation).toHaveBeenCalledOnce();
    expect(key.preventDefault).not.toHaveBeenCalled();
  }
});
it('lets modified trigger keys through the real Radix trigger to their owner', () => {
  render();
  for (const mods of [{ altKey: true }, { altKey: true, ctrlKey: true }, { getModifierState: () => true }, { shiftKey: true }]) {
    for (const name of ['ArrowDown', 'Enter', ' ']) {
      const key = keyEvent(name, mods);
      ui.triggerKey(key);
      expect(key.preventDefault).not.toHaveBeenCalled();
      expect(key.stopPropagation).not.toHaveBeenCalled();
    }
  }
  const plain = keyEvent('Enter');
  ui.triggerKey(plain);
  expect(plain.preventDefault).toHaveBeenCalled();
});
it('rejects both Windows AltGr representations for every bar chord', () => {
  for (const mac of [false, true]) {
    for (const mods of [{ ctrlKey: true, altKey: true }, { getModifierState: (key: string) => key === 'AltGraph' }]) {
      const effort = { altKey: true, metaKey: mac, ...mods };
      expect(levelChord(keyEvent('ArrowRight', effort), mac)).toBeNull();
      expect(ultraChord(keyEvent('u', effort), mac)).toBe(false);
      expect(opensPanel(keyEvent('.', { ctrlKey: !mac, metaKey: mac, ...mods }), mac)).toBe(false);
    }
  }
});
it('delivers plain Alt+Down from the phrase to the conversation navigator exactly once', () => {
  render();
  ui.effects.length = 0;
  const win = new EventTarget();
  vi.stubGlobal('window', win);
  renderToStaticMarkup(createElement(ConversationFind, { sessionId: 'chat' }));
  const remove = ui.effects.map((effect) => effect());
  const jump = vi.fn(() => true);
  const release = takeSteps('chat', jump);
  try {
    for (const mods of [{}, { ctrlKey: true }, { getModifierState: (): boolean => true }]) {
      const e = Object.assign(new Event('keydown', { cancelable: true }), {
        key: 'ArrowDown', altKey: true, getModifierState: (): boolean => false, nativeEvent: {}, ...mods,
      });
      ui.triggerKey(e);
      win.dispatchEvent(e);
    }
    expect(jump.mock.calls).toEqual([[1]]);
  } finally {
    release();
    for (const cleanup of remove) cleanup?.();
  }
});
