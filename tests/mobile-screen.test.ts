/**
 * Phone 2.18: lib/screen.ts, the one answer to "can the person see the app". On the phone it is
 * Android's word (PageLife.java: the activity's onStart / onStop, and SystemPlugin `screen` at
 * start), never the page's visibility: PageLife shows the page for a moment every 20 seconds while a
 * chat works off screen (Chromium freezes a hidden page), so a "visible" page must not read as
 * someone looking (a chat would be marked read, a notification held back).
 */
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  screen: null as null | ((v: { shown: boolean }) => void),
  docListeners: new Map<string, (() => void)[]>(),
  attrs: new Set<string>(),
}));
vi.mock('../mobile/node_modules/@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => ({ screen: () => new Promise<{ shown: boolean }>((r) => (fake.screen = r)) }),
}));

const doc = {
  visibilityState: 'visible',
  head: { appendChild: () => {} },
  createElement: () => ({ textContent: '' }),
  documentElement: { toggleAttribute: (n: string, on: boolean) => void (on ? fake.attrs.add(n) : fake.attrs.delete(n)) },
  addEventListener: (type: string, fn: () => void) => fake.docListeners.set(type, [...(fake.docListeners.get(type) ?? []), fn]),
};
vi.stubGlobal('document', doc);
vi.stubGlobal('window', globalThis);

type Screen = { onScreen: () => boolean; onScreenChange: (fn: (on: boolean) => void) => () => void };
const SCREEN = '../mobile/src/lib/screen';
const push = (on: boolean) => (globalThis as unknown as { __sableScreen: (on: boolean) => void }).__sableScreen(on);
/** SystemPlugin `screen` answers the question asked at start. */
const answer = (shown: boolean) => fake.screen?.({ shown });

describe('on screen, on the phone', () => {
  it('follows Android, never the page: a page made visible off screen is not someone looking', async () => {
    const s = (await import(/* @vite-ignore */ SCREEN)) as Screen;
    const heard: boolean[] = [];
    s.onScreenChange((on) => heard.push(on));
    expect(s.onScreen()).toBe(true);
    push(false);
    expect(s.onScreen()).toBe(false);
    expect(fake.attrs.has('data-away')).toBe(true);
    // The page's own visibility is not listened to at all on the phone.
    expect(fake.docListeners.get('visibilitychange') ?? []).toHaveLength(0);
    doc.visibilityState = 'visible';
    for (const l of fake.docListeners.get('visibilitychange') ?? []) l();
    expect(s.onScreen()).toBe(false);
    // The answer to the start question came after the push: older, dropped.
    answer(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.onScreen()).toBe(false);
    push(true);
    expect(s.onScreen()).toBe(true);
    expect(fake.attrs.has('data-away')).toBe(false);
    expect(heard).toEqual([false, true]);
  });

  it('at start, Android\'s answer stands when nothing was pushed before it', async () => {
    vi.resetModules();
    fake.screen = null;
    const s = (await import(/* @vite-ignore */ SCREEN)) as Screen;
    expect(s.onScreen()).toBe(true);
    answer(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.onScreen()).toBe(false);
  });

  it('a listener that throws keeps no other from hearing', async () => {
    vi.resetModules();
    const s = (await import(/* @vite-ignore */ SCREEN)) as Screen;
    const heard: boolean[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    s.onScreenChange(() => {
      throw new Error('boom');
    });
    s.onScreenChange((on) => heard.push(on));
    push(false);
    expect(heard).toEqual([false]);
    err.mockRestore();
  });
});
