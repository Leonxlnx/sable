import { useSyncExternalStore } from 'react';
import type { CustomState, ProviderId } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { applySnapshot, useStore } from '@/state/store';

/**
 * Customize Sable as the bridge has it (`custom.*`, `server/services/custom.ts`), held outside React
 * for Settings › Customize, the palette and the strip above the Customize chat's composer. Read once
 * the bridge is open (again after a reconnect); every change arrives as `custom.updated`. The sheet
 * itself is swapped by `live.ts`.
 */

let state: CustomState | null = null;
const listeners = new Set<() => void>();

function set(next: CustomState) {
  state = next;
  for (const l of listeners) l();
}

export function subscribeCustom(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const getCustom = (): CustomState | null => state;

/** The state, re-rendering the caller when it changes; null until the bridge answered (or when it has none). */
export function useCustom(): CustomState | null {
  return useSyncExternalStore(subscribeCustom, getCustom);
}

function refresh() {
  void bridge.call('custom.state', {}).then(set, () => {});
}

bridge.on((e) => {
  if (e.type === 'custom.updated') set(e.state);
});
bridge.onStatus((s) => s === 'open' && refresh());
if (bridge.status === 'open') refresh();

const fail = (err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error');

/** Something of the person's is applied now (their styles or their build). */
export const customized = (s: CustomState | null) => !!s && !s.ignored && ((s.styles.exists && s.styles.on && !s.styles.blocked) || s.build.serving);

/**
 * Opens the Customize chat (made the first time) and sends `text` to it when there is any. The
 * Demo agent in development when `provider` says so (`sable.customize`).
 */
export async function openCustomize(text?: string, provider?: ProviderId): Promise<string | null> {
  try {
    const snap = await bridge.call('custom.open', { ...(text?.trim() ? { text: text.trim() } : {}), ...(provider ? { provider } : {}) }, 120_000);
    applySnapshot(snap);
    useStore.getState().setUi({ activeSessionId: snap.session.id, race: null, settings: null });
    return snap.session.id;
  } catch (err) {
    fail(err);
    return null;
  }
}

/** "Use Sable's own look": the person's styles and build off at once. */
export async function useOriginal() {
  try {
    set(await bridge.call('custom.original', {}));
    useStore.getState().toast("Sable's own look is back", 'success');
  } catch (err) {
    fail(err);
  }
}

/** Your build's steps (each one the person's click). Long: progress arrives as `custom.updated`. */
export async function customStep(step: 'setup' | 'build' | 'bring' | 'use-on' | 'use-off'): Promise<boolean> {
  try {
    const long = 3_600_000;
    if (step === 'setup') set(await bridge.call('custom.setup', {}, long));
    else if (step === 'build') set(await bridge.call('custom.build', { use: true }, long));
    else if (step === 'bring') {
      const r = await bridge.call('custom.bring', {}, long);
      set(r);
      if (r.conflict?.length) useStore.getState().toast('Your changes conflict with this version: the Customize chat has the details');
    } else set(await bridge.call('custom.use', { on: step === 'use-on' }));
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}
