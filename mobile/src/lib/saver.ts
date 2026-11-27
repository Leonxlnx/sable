import { Capacitor } from '@capacitor/core';
import { System } from './system-plugin';

/**
 * Battery saver (2.22): the system's own switch (Android's PowerManager, SystemPlugin `powerSave` and
 * its `powerSave` event), and, where the app cannot ask (a browser), a phone running low and not
 * charging (the Battery Status API: 20 % or less). While it is on the app's own motion is off, as
 * under reduced motion: the field keeps its still frame and plays no beat, a change of screen is made
 * at once, the working mark stands still (`<html data-saver>`, base.css).
 */

let system = false;
let low = false;
let on = false;
const listeners = new Set<(on: boolean) => void>();

function publish() {
  const next = system || low;
  if (next === on) return;
  on = next;
  if (typeof document !== 'undefined') document.documentElement?.toggleAttribute?.('data-saver', on);
  listeners.forEach((l) => l(on));
}

/** Whether the battery saver is on now. */
export const saver = () => on;

/** Told when it changes; returns the way to stop listening. */
export function onSaver(l: (on: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Set from outside (tests, and the rig: `window.__sableSaver(true)`). */
export function setSaver(v: boolean) {
  system = v;
  publish();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __sableSaver?: (v: boolean) => void }).__sableSaver = setSaver;
  if (Capacitor.isNativePlatform()) {
    void System.powerSave()
      .then((r) => setSaver(!!r.on))
      .catch(() => {});
    void System.addListener('powerSave', (r: { on: boolean }) => setSaver(!!r.on)).catch(() => {});
  }
  void (navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (k: string, f: () => void) => void }> })
    .getBattery?.()
    .then((b) => {
      const read = () => {
        low = !b.charging && b.level <= 0.2;
        publish();
      };
      read();
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
    })
    .catch(() => {});
}
