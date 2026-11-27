import { useSyncExternalStore } from 'react';
import type { WebState } from '@shared/protocol';
import { bridge } from '@/lib/bridge';
import { openSettings } from '@/state/actions';
import { useStore } from '@/state/store';

/**
 * Web access as the desktop window knows it (server/services/web-remote.ts): `web.state` once, then
 * every `web.updated`. Read by Settings › Phone, the top bar's mark and a message's origin. Nothing at
 * all runs while web access is not in this run (`webShown`: the bridge's hello says so, for `WEB_SHIPS`
 * or the owner's `--web`): the hooks answer null and nothing is asked or subscribed.
 */
let state: WebState | null = null;
const listeners = new Set<() => void>();
let started = false;
/** Development only: a made-up state stays on screen until `sableWeb.live()`. */
let shown = false;

function set(next: WebState | null, made = false) {
  if (shown && !made) return;
  state = next;
  for (const l of listeners) l();
}

/** Asks the bridge again (after an answer that changed it, or a reconnect). */
export function refreshWeb(): Promise<void> {
  if (!webShown()) return Promise.resolve();
  return bridge.call('web.state', {}).then(set, () => {});
}

function start() {
  if (started || !webShown()) return;
  started = true;
  bridge.on((e) => {
    if (e.type === 'web.updated') set(e.state);
  });
  // A bridge that restarted knows other clients: ask again on every new socket.
  bridge.onStatus((s) => {
    if (s === 'open') void refreshWeb();
  });
  void refreshWeb();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Web access is in this run: the bridge's hello said so (`WEB_SHIPS`, or `Sable.exe --web` / `SABLE_WEB=1`: server/services/web-on.ts). */
export const webShown = () => useStore.getState().webAccess;

/** The whole state; null while web access is not in this run or not read yet. */
export function useWebState(): WebState | null {
  // Hello may answer after the first render (the top bar's mark): the hook runs again when it does.
  const on = useStore((s) => s.webAccess);
  if (on) start();
  const s = useSyncExternalStore(subscribe, () => state);
  return on ? s : null;
}

/** A `web.*` call whose answer is the new state: applied at once (the event follows with the same); a refusal is a toast. */
async function act(call: () => Promise<WebState>): Promise<void> {
  try {
    set(await call());
  } catch (err) {
    useStore.getState().toast((err as Error)?.message ?? String(err), 'error');
  }
}

/** A new pairing code (ten minutes, once), or `cancel` the open one. */
export const webOffer = (cancel: boolean) => act(() => bridge.call('web.offer', cancel ? { cancel: true } : {}));
export const webApprove = (requestId: string, allow: boolean) => act(() => bridge.call('web.approve', { requestId, allow }));
export const webRevoke = (deviceId: string) => act(() => bridge.call('web.revoke', { deviceId }));

/**
 * "Save certificate": the public root, where the person picks in the desktop's save dialog. The dev
 * server has no dialog: the window downloads it.
 */
export async function saveCertificate(): Promise<void> {
  const { toast } = useStore.getState();
  try {
    const r = await bridge.call('web.saveCa', {});
    if (r.ok) toast('Certificate saved', 'success');
    else if (r.missing) toast('There is no certificate yet', 'error');
    else if (r.unsupported && r.der) {
      const bytes = Uint8Array.from(atob(r.der), (c) => c.charCodeAt(0));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pkix-cert' }));
      a.download = 'Sable certificate.cer';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  } catch (err) {
    toast((err as Error)?.message ?? String(err), 'error');
  }
}

/** A paired web device's name, for a message it sent; undefined when the desktop does not know it (removed). */
export function useWebDeviceName(deviceId: string | undefined): string | undefined {
  const s = useWebState();
  return deviceId ? s?.devices.find((d) => d.id === deviceId)?.name : undefined;
}

// Settings › Phone opened onto the web section (the top bar's mark): read once by the section as it mounts.
let scrollTo = false;
export function openWebAccess() {
  scrollTo = true;
  openSettings('phone');
}
export function takeWebScroll(): boolean {
  const s = scrollTo;
  scrollTo = false;
  return s;
}

// Development only: `sableWeb.show(state)` puts a made-up state on screen (pictures of every state of the
// section without a real network or tablet); `sableWeb.live()` reads the bridge's again.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).sableWeb = {
    show: (s: WebState) => {
      shown = true;
      set(s, true);
    },
    live: () => {
      shown = false;
      return refreshWeb();
    },
  };
}
