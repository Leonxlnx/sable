import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './conn';
import { removeChecked } from './credential';
import { NoteBook } from './note-book';
import { NotePoster, SUMMARY_ID } from './note-post';

/** Thin wrappers over the Capacitor plugins, quiet when a plugin is missing (the web preview). */

export const isNative = Capacitor.isNativePlatform();

/**
 * Writes (or with `null` removes) a key of the app's preferences and resolves only once it is on the
 * phone's storage (SystemPlugin `keep`: Android's commit, not the background apply that Capacitor's
 * Preferences uses); throws when it could not be written. In the web preview, Preferences itself.
 */
export async function durable(key: string, value: string | null) {
  if (isNative) return void (await System.keep(value === null ? { key } : { key, value }));
  if (value === null) await Preferences.remove({ key });
  else await Preferences.set({ key, value });
}

/**
 * The pairing kept on this phone: null when there is none (or what is there is not one). A read that
 * fails throws: it is never taken as "none" (a link would then pair without asking to replace it).
 */
export async function loadPairing(): Promise<Pairing | null> {
  const { value } = await Preferences.get({ key: 'pairing' });
  if (!value) return null;
  try {
    const p = JSON.parse(value) as Pairing;
    return p && typeof p.token === 'string' && Array.isArray(p.hosts) ? p : null;
  } catch {
    return null;
  }
}

/** Keeps the pairing, on the phone's storage before it resolves (throws when it could not be written: the caller decides what to say). */
export async function savePairing(p: Pairing) {
  await durable('pairing', JSON.stringify(p));
}

/**
 * Removes the pairing's token from the phone's storage, and checks that it is gone: a removal that
 * failed (or a value still there) throws a sentence to show, so Forget never looks done while a
 * restart would connect with the old token again.
 */
export async function removePairing() {
  await removeChecked({ remove: ({ key }) => durable(key, null), get: (o) => Preferences.get(o) }, 'pairing');
}

/**
 * An erasure under way (conn.ts), kept on the phone's storage so a start after Android closed the app
 * in the middle of it goes on with it: `forget` (the pairing this phone had is to go, with everything
 * kept for it), `to` (a pairing that replaces it with another computer was being kept: once that one
 * is the pairing here, what was kept for the old one goes).
 */
export interface EraseMark {
  forget?: boolean;
  to?: string;
}

const MARK = 'erasing';

/** The erasure under way, if any (a read that fails throws; a mark that cannot be read is taken as Forget). */
export async function loadMark(): Promise<EraseMark | null> {
  const { value } = await Preferences.get({ key: MARK });
  if (!value) return null;
  try {
    const m = JSON.parse(value) as EraseMark;
    return m && typeof m === 'object' ? { ...(m.forget ? { forget: true } : {}), ...(typeof m.to === 'string' ? { to: m.to } : {}) } : { forget: true };
  } catch {
    return { forget: true };
  }
}

/** Keeps the mark (null: done), on the phone's storage before it resolves. */
export async function saveMark(m: EraseMark | null) {
  await durable(MARK, m && (m.forget || m.to) ? JSON.stringify(m) : null);
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

const GROUP = 'sable.chats';

/** The chats with a notification up (kept across restarts, reconciled with Android's): the summary stays while there are two or more. */
const POSTED = 'sable.notified';
const posted = new NoteBook(
  {
    get: () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(POSTED)),
    set: (v) => localStorage.setItem(POSTED, v),
  },
  (id) => idFor(id),
);

/** Posts one at a time, each reconciled with what Android shows; Forget lets go of any still on its way (lib/note-post.ts). */
const poster = new NotePoster(
  {
    // Never ask from the background (the plugin would try to show a prompt): only post when allowed.
    allowed: async () => (await LocalNotifications.checkPermissions()).display === 'granted',
    prepare: async () => {
      if (channelMade) return;
      channelMade = true;
      await LocalNotifications.createChannel({ id: 'turns', name: 'Turns', description: 'A turn ended or waits for you', importance: 4, visibility: 1, vibration: true }).catch(() => {});
    },
    delivered: () =>
      LocalNotifications.getDeliveredNotifications().then(
        (r) => r.notifications.map((n) => n.id),
        () => null,
      ),
    cancel: async (ids) => void (await LocalNotifications.cancel({ notifications: ids.map((id) => ({ id })) })),
    post: async (n, chats) => {
      const common = { channelId: 'turns', smallIcon: 'ic_stat_sable', iconColor: '#f2f1ee', isExactNotification: false, group: GROUP };
      const notifications: Parameters<typeof LocalNotifications.schedule>[0]['notifications'] = [
        // Shown now, not at a time: no exact alarm (asking for one would open a settings screen, impossible from the background).
        { ...common, id: n.id, title: n.title, body: n.body, extra: { sessionId: n.sessionId, kind: n.kind }, ...(n.lines.length > 1 ? { inboxList: n.lines, summaryText: n.title } : {}) },
      ];
      // Two chats or more: one summary holds them together (its own tap opens home).
      if (chats > 1) notifications.push({ ...common, id: SUMMARY_ID, title: 'Sable', body: `${chats} chats`, groupSummary: true, summaryText: `${chats} chats`, extra: { kind: 'home' } });
      await LocalNotifications.schedule({ notifications });
    },
    clearAll: async () => {
      if (!isNative) return;
      await LocalNotifications.removeAllDeliveredNotifications().catch(() => {});
      const p = await LocalNotifications.getPending();
      if (p.notifications.length) await LocalNotifications.cancel({ notifications: p.notifications.map((n) => ({ id: n.id })) });
    },
  },
  posted,
  idFor,
);

/**
 * One notification per chat, grouped under Sable: its newest news as the line, the earlier ones of
 * this time away listed under it when expanded ("Waiting for you", then "Done"). A tap opens the chat
 * where it matters: its prompt when it waits on you, the newest turn when one ended; the group's own
 * line opens home. Two chats finishing together are posted one after the other (the second with the
 * summary of two).
 */
export async function notify(title: string, body: string, sessionId: string, kind: NoteKind = 'done') {
  if (!isNative) return;
  await poster.notify(title, body, sessionId, kind);
}

/** Every chat's notification goes, with what was kept of them, and any still on its way (the desktop was forgotten). */
export function clearChatNotifications() {
  void poster.clear();
}

/**
 * A chat opened on the phone: its notification goes (after one still going up). The summary goes
 * only with the last chat's (cancelling a summary takes every notification of its group with it).
 */
export function clearNotification(sessionId: string) {
  if (!isNative) return;
  void poster.clearOne(sessionId);
}

/** Back on screen: the lines of the time away start over (the notifications stay until opened or swiped). */
export function forgetNotificationLines() {
  void poster.forgetLines();
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
  keep(o: { key: string; value?: string }): Promise<void>;
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

// ── erasing what was kept for a desktop (lib/erase.ts) ──

const FilesNative = registerPlugin<{ forgetAll(): Promise<void> }>('Files');
/** Preferences kept for the desktop (the pairing itself and the erasure's mark are conn.ts's). */
const PAIRING_PREFS = ['sable.taken'];

/**
 * Android's side of an erasure, each step awaited: every private file (downloads under way, verified
 * copies and their records), the copies Sable put in Downloads/Sable and the system downloads it made
 * (FilesPlugin `forgetAll`, which fails when anything is left), the chats' notifications, the app
 * icon's chat shortcuts and the line that kept the connection. The steps that failed, by name.
 */
export async function eraseNative(): Promise<string[]> {
  const failed: string[] = [];
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      failed.push(name);
    }
  };
  // The preferences that belong to the pairing (words taken back from the queue: lib/drafts.ts).
  for (const key of PAIRING_PREFS) await step(key, () => durable(key, null));
  if (!isNative) return failed;
  await step('files', () => FilesNative.forgetAll());
  await step('notifications', () => poster.clear());
  shortcutsKey = '';
  await step('shortcuts', () => System.shortcuts({ chats: [] }));
  keepAlive(null);
  return failed;
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
