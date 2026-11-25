import { useSyncExternalStore } from 'react';
import { onScreen, onScreenChange } from './screen';

/** One shared clock for relative times, ticking every 30 s while someone listens. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(l: () => void) {
  listeners.add(l);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      // Off screen (lib/screen.ts: the page may be held visible there) nothing draws.
      if (!onScreen()) return;
      now = Date.now();
      listeners.forEach((fn) => fn());
    }, 30_000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

// Back on screen: the relative times are read again at once.
onScreenChange((on) => {
  if (!on || timer === undefined) return;
  now = Date.now();
  listeners.forEach((fn) => fn());
});

export const useNow = () => useSyncExternalStore(subscribe, () => now);
