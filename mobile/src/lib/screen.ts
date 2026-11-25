import { Capacitor } from '@capacitor/core';
import { System } from './system-plugin';

/**
 * Whether the person can see the app: the one answer for everything that asks (a chat on screen is
 * read, "typing in it", whether a notification is needed, loops and animations that draw, how often
 * to reconnect, a download's loop).
 *
 * On the phone it is Android's word, never the page's visibility: while a chat works or waits and the
 * app is off screen, android/…/PageLife.java shows the page for a moment every 20 seconds on purpose
 * (Chromium freezes a hidden page a minute or five after it was hidden: no socket events, no timers,
 * no notification), so `document.visibilityState` says "visible" then while nobody looks. The
 * activity says when it is started or stopped (`window.__sableScreen(bool)`), and SystemPlugin
 * `screen` answers once at start. In a browser (the preview) it is the page's visibility.
 *
 * Off screen, `<html data-away>` pauses every CSS animation (the rule below): none asks for a frame
 * in those moments, and none runs on when the app comes back.
 */

const native = Capacitor.isNativePlatform();
const pageShown = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

let shown = pageShown();
const listeners = new Set<(on: boolean) => void>();

/** The person can see the app now. */
export const onScreen = () => shown;

/** Called with every change (true: back on screen); returns the way to stop listening. */
export function onScreenChange(fn: (on: boolean) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function mark(on: boolean) {
  const root = typeof document === 'undefined' ? undefined : document.documentElement;
  root?.toggleAttribute?.('data-away', !on);
}

/** A new answer, told to every listener in order (also the way tests drive it). */
export function setScreen(on: boolean) {
  if (on === shown) return;
  shown = on;
  mark(on);
  for (const l of [...listeners]) {
    try {
      l(on);
    } catch (err) {
      // One listener's fault never keeps the others from hearing it.
      console.error(err);
    }
  }
}

/** Every CSS animation holds while nobody looks (a working mark, a shimmer, a loader). */
export const AWAY_CSS = 'html[data-away] *,html[data-away] *::before,html[data-away] *::after{animation-play-state:paused!important}';

if (typeof document !== 'undefined') {
  if (typeof document.createElement === 'function' && document.head) {
    const style = document.createElement('style');
    style.textContent = AWAY_CSS;
    document.head.appendChild(style);
  }
  mark(shown);
  if (native) {
    // Android's own word, pushed (PageLife) and, at start, asked: an answer to the question that
    // arrives after a push is older than that push and is dropped.
    let pushes = 0;
    (window as unknown as { __sableScreen?: (on: boolean) => void }).__sableScreen = (on) => {
      pushes++;
      setScreen(on === true);
    };
    const asked = pushes;
    try {
      void System.screen()
        .then((r) => pushes === asked && typeof r?.shown === 'boolean' && setScreen(r.shown))
        .catch(() => {});
    } catch {
      // An app without the method (an older native shell): the pushes alone.
    }
  } else {
    document.addEventListener?.('visibilitychange', () => setScreen(pageShown()));
  }
}
