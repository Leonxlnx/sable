import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './conn';
import { NoteBook } from './note-book';

/** Thin wrappers over the Capacitor plugins, quiet when a plugin is missing (the web preview). */

export const isNative = Capacitor.isNativePlatform();

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const { value } = await Preferences.get({ key: 'pairing' });
    if (!value) return null;
    const p = JSON.parse(value) as Pairing;
    return p && typeof p.token === 'string' && Array.isArray(p.hosts) ? p : null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing | null) {
  try {
    if (p) await Preferences.set({ key: 'pairing', value: JSON.stringify(p) });
    else await Preferences.remove({ key: 'pairing' });
  } catch {
    /* web preview without storage */
  }
}

export async function loadPref<T>(key: string, fallback: T): Promise<T> {
  try {
    const { value } = await Preferences.get({ key });
    return value == null ? fallback : (JSON.parse(value) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown) {
  void Preferences.set({ key, value: JSON.stringify(value) }).catch(() => {});
}

export type HapticKind = 'tap' | 'send' | 'select' | 'success' | 'warning' | 'deny';

/** Settings › Haptics: on unless turned off on this phone. */
let hapticsOn = true;
void loadPref('haptics', true).then((v) => (hapticsOn = v !== false));
export const hapticsEnabled = () => hapticsOn;
export function setHaptics(on: boolean) {
  hapticsOn = on;
  savePref('haptics', on);
}

/** This app's own version ("1.3"), on the phone. */
export async function appVersion(): Promise<string | undefined> {
  if (!isNative) return undefined;
  try {
    return (await App.getInfo()).version;
  } catch {
    return undefined;
  }
}

export function haptic(kind: HapticKind) {
  if (!isNative || !hapticsOn) return;
  const run = () => {
    switch (kind) {
      case 'tap':
        return Haptics.impact({ style: ImpactStyle.Light });
      case 'send':
        return Haptics.impact({ style: ImpactStyle.Medium });
      case 'select':
        return Haptics.selectionChanged();
      case 'success':
        return Haptics.notification({ type: NotificationType.Success });
      case 'warning':
        return Haptics.notification({ type: NotificationType.Warning });
      case 'deny':
        return Haptics.notification({ type: NotificationType.Error });
    }
  };
  void run()?.catch(() => {});
}

export async function deviceName(): Promise<string> {
  try {
    const info = await Device.getInfo();
    const name = (info.name ?? '').trim();
    if (name && !/^sdk_|^generic/i.test(name)) return name;
    const model = (info.model ?? '').trim();
    if (model && !/^sdk_|gphone/i.test(model)) return `${info.manufacturer ? info.manufacturer[0].toUpperCase() + info.manufacturer.slice(1) + ' ' : ''}${model}`.trim();
    return isNative ? 'Android phone' : 'Browser';
  } catch {
    return 'Phone';
  }
}

// ── notifications: a turn ended or waits on you, while the app is in the background ──

let channelMade = false;

/** One notification per chat: its newest state replaces the last ("Waiting for you", then "Done"). */
const idFor = (sessionId: string) => {
  let h = 7;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 2;
};

export async function notificationsAllowed(): Promise<boolean> {
  if (!isNative) return false;
  try {
    return (await LocalNotifications.checkPermissions()).display === 'granted';
  } catch {
    return false;
  }
}

export async function askNotifications(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const r = await LocalNotifications.requestPermissions();
    return r.display === 'granted';
  } catch {
    return false;
  }
}

/** What a notification says happened: a turn ended (or failed), or the chat waits on you; 'home' for the summary. */
export type NoteKind = 'done' | 'waiting' | 'home';

/** Each chat's lines since the app was last on screen, newest first (one notification per chat holds them). */
const lines = new Map<string, { title: string; lines: string[] }>();
const GROUP = 'sable.chats';
const SUMMARY_ID = 1;

/** The chats with a notification up (kept across restarts, reconciled with Android's): the summary stays while there are two or more. */
const POSTED = 'sable.notified';
const posted = new NoteBook(
  {
    get: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(POSTED)),
    set: (v) => localStorage.setItem(POSTED, v),
  },
  (id) => idFor(id),
);

/**
 * One notification per chat, grouped under Sable: its newest news as the line, the earlier ones of
 * this time away listed under it when expanded ("Waiting for you", then "Done"). A tap opens the chat
 * where it matters: its prompt when it waits on you, the newest turn when one ended; the group's own
 * line opens home.
 */
export async function notify(title: string, body: string, sessionId: string, kind: NoteKind = 'done') {
  if (!isNative) return;
  try {
    // Never ask from the background (the plugin would try to show a prompt): only post when allowed.
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') return;
    if (!channelMade) {
      channelMade = true;
      await LocalNotifications.createChannel({ id: 'turns', name: 'Turns', description: 'A turn ended or waits for you', importance: 4, visibility: 1, vibration: true }).catch(() => {});
    }
    const line = body.slice(0, 180);
    const cur = lines.get(sessionId) ?? { title, lines: [] };
    cur.title = title;
    cur.lines = [line, ...cur.lines.filter((l) => l !== line)].slice(0, 5);
    lines.set(sessionId, cur);
    // What is still up: a notification swiped away no longer counts in the summary.
    const delivered = await LocalNotifications.getDeliveredNotifications().then(
      (r) => r.notifications.map((n) => n.id),
      () => null,
    );
    if (delivered) posted.reconcile(delivered);
    const count = posted.countWith(sessionId);
    // A summary left from chats that were swiped away goes first (with it its group: this chat's own is posted again below).
    if (count < 2 && delivered?.includes(SUMMARY_ID)) await LocalNotifications.cancel({ notifications: [{ id: SUMMARY_ID }] }).catch(() => {});
    const common = { channelId: 'turns', smallIcon: 'ic_stat_sable', iconColor: '#f2f1ee', isExactNotification: false, group: GROUP };
    const notifications: Parameters<typeof LocalNotifications.schedule>[0]['notifications'] = [
      // Shown now, not at a time: no exact alarm (asking for one would open a settings screen, impossible from the background).
      { ...common, id: idFor(sessionId), title, body: line, extra: { sessionId, kind }, ...(cur.lines.length > 1 ? { inboxList: cur.lines, summaryText: title } : {}) },
    ];
    // Two chats or more: one summary holds them together (its own tap opens home).
    if (count > 1) notifications.push({ ...common, id: SUMMARY_ID, title: 'Sable', body: `${count} chats`, groupSummary: true, summaryText: `${count} chats`, extra: { kind: 'home' } });
    await LocalNotifications.schedule({ notifications });
    // Written down once it is up (a schedule that failed leaves nothing behind).
    posted.add(sessionId);
  } catch {
    /* not allowed */
  }
}

/** Every chat's notification goes, with what was kept of them (the desktop was forgotten). */
export function clearChatNotifications() {
  lines.clear();
  posted.clear();
  if (!isNative) return;
  void LocalNotifications.removeAllDeliveredNotifications().catch(() => {});
  void LocalNotifications.getPending()
    .then((p) => (p.notifications.length ? LocalNotifications.cancel({ notifications: p.notifications.map((n) => ({ id: n.id })) }) : undefined))
    .catch(() => {});
}

/**
 * A chat opened on the phone: its notification goes. The summary goes only with the last chat's
 * (cancelling a summary takes every notification of its group with it).
 */
export function clearNotification(sessionId: string) {
  if (!isNative) return;
  lines.delete(sessionId);
  const had = posted.remove(sessionId);
  const ids = [{ id: idFor(sessionId) }, ...(had && posted.size === 0 ? [{ id: SUMMARY_ID }] : [])];
  void LocalNotifications.cancel({ notifications: ids }).catch(() => {});
}

/** Back on screen: the lines of the time away start over (the notifications stay until opened or swiped). */
export function forgetNotificationLines() {
  lines.clear();
}

export function onNotificationTap(fn: (sessionId: string, kind: NoteKind) => void) {
  if (!isNative) return () => {};
  const h = LocalNotifications.addListener('localNotificationActionPerformed', (a) => {
    const x = a.notification.extra as { sessionId?: string; kind?: NoteKind } | undefined;
    if (x?.sessionId) fn(x.sessionId, x.kind === 'waiting' ? 'waiting' : 'done');
    else if (x?.kind === 'home') fn('', 'home');
  });
  return () => void h.then((x) => x.remove());
}

// ── the system: share a text, the app icon's shortcuts (android/…/SystemPlugin.java) ──

const System = registerPlugin<{
  share(o: { text: string; title?: string }): Promise<void>;
  shortcuts(o: { chats: { id: string; title: string }[] }): Promise<void>;
}>('System');

/** Android's share sheet for a text (a message); a browser's own where there is one. False when nothing could share it. */
export async function shareText(text: string, title?: string): Promise<boolean> {
  try {
    if (isNative) await System.share({ text, ...(title ? { title } : {}) });
    else if (navigator.share) await navigator.share({ text, ...(title ? { title } : {}) });
    else return false;
    return true;
  } catch {
    return false;
  }
}

let shortcutsKey = '';
/** The app icon's shortcuts: "New chat" (static, in the manifest) and the last chats, newest first. */
export function setShortcuts(chats: { id: string; title: string }[]) {
  if (!isNative) return;
  const key = JSON.stringify(chats);
  if (key === shortcutsKey) return;
  shortcutsKey = key;
  void System.shortcuts({ chats }).catch(() => (shortcutsKey = ''));
}

/** The chats' shortcuts go ("New chat" stays): the desktop was forgotten. */
export function clearShortcuts() {
  shortcutsKey = '';
  setShortcuts([]);
}

// ── the connection kept in the background (android/…/KeepAliveService.java) ──

const KeepAlive = registerPlugin<{ arm(o: { text?: string }): Promise<void> }>('KeepAlive');
let armed: string | null = null;

/**
 * While a chat runs or waits, `text` names it: leaving the app then keeps the connection (Android
 * would cut it), so the phone can say when it is done or waits. Null lets it go.
 */
export function keepAlive(text: string | null) {
  if (!isNative || text === armed) return;
  armed = text;
  void KeepAlive.arm(text ? { text } : {}).catch(() => {});
}

// ── app lifecycle ──

let foreground = typeof document === 'undefined' || document.visibilityState !== 'hidden';
export const inForeground = () => foreground;

export function onAppState(fn: (active: boolean) => void) {
  const onVis = () => {
    foreground = document.visibilityState === 'visible';
    fn(foreground);
  };
  document.addEventListener('visibilitychange', onVis);
  let remove: (() => void) | undefined;
  if (isNative) {
    const h = App.addListener('appStateChange', ({ isActive }) => {
      foreground = isActive;
      fn(isActive);
    });
    remove = () => void h.then((x) => x.remove());
  }
  return () => {
    document.removeEventListener('visibilitychange', onVis);
    remove?.();
  };
}

export function onBackButton(fn: () => boolean) {
  if (!isNative) return () => {};
  const h = App.addListener('backButton', () => {
    if (!fn()) void App.minimizeApp();
  });
  return () => void h.then((x) => x.remove());
}

/**
 * Sable's links opened from the camera, another app or the app icon's shortcuts (`sable://pair?...`,
 * `sable://new`, `sable://chat/<id>`), the launch one included.
 */
export function onPairLink(fn: (url: string) => void) {
  if (!isNative) {
    const q = new URLSearchParams(location.search).get('pair');
    if (q) setTimeout(() => fn(q), 0);
    return () => {};
  }
  void App.getLaunchUrl().then((r) => r?.url && fn(r.url)).catch(() => {});
  const h = App.addListener('appUrlOpen', ({ url }) => fn(url));
  return () => void h.then((x) => x.remove());
}

export function openExternal(url: string) {
  window.open(url, '_blank', 'noopener');
}
