import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import type { Pairing } from './conn';
import { removeChecked } from './credential';
import { NoteBook } from './note-book';
import { NotePoster, type ChatNote } from './note-post';
import type { LiveSpec, NoteAction } from './notes';
import { onScreen, onScreenChange } from './screen';
import { System } from './system-plugin';

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
 * The pairing kept on this phone: null when there is none. A read that fails throws, and so does a
 * pairing that is there but cannot be read as one (`damaged: true`): neither is ever taken as "none"
 * (a link would then pair without asking to replace it, and nothing of the old one would be erased).
 */
export async function loadPairing(): Promise<Pairing | null> {
  const { value } = await Preferences.get({ key: 'pairing' });
  if (!value) return null;
  const damaged = () => Object.assign(new Error('The pairing kept on this phone cannot be read'), { damaged: true as const });
  let p: Pairing;
  try {
    p = JSON.parse(value) as Pairing;
  } catch {
    throw damaged();
  }
  if (!p || typeof p !== 'object' || typeof p.token !== 'string' || !p.token || !Array.isArray(p.hosts)) throw damaged();
  return p;
}

/** A preference's text (null when there is none); a read that fails throws (never taken as "none"). */
export async function readPref(key: string): Promise<string | null> {
  return (await Preferences.get({ key })).value;
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
// Drawn by Android itself (android/…/Notes.java): a channel per tone, one notification per chat
// that updates in place, grouped under a summary, private on the lock screen. What they say is
// lib/notes.ts's.

/** One notification per chat: its newest state replaces the last ("Waiting for you", then "Done"). */
const idFor = (sessionId: string) => {
  let h = 7;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  const id = (Math.abs(h) % 2_000_000_000) + 2;
  return id === 7001 ? 2_000_000_002 : id; // reserved for KeepAliveService
};

/** A chat's notification, as Notes.java draws it. */
interface NoteSpec {
  id: number;
  sessionId: string;
  title: string;
  text: string;
  kind: string;
  lines: string[];
  chats: number;
  summary: string[];
  ask?: ChatNote['ask'];
}

/** What Android allows Sable: notifications at all, and (Android 16) Live Updates. */
export interface NoteStatus {
  enabled: boolean;
  live?: boolean;
  sdk: number;
}

const Notes = registerPlugin<{
  post(o: NoteSpec): Promise<void>;
  summary(o: { chats: number; lines: string[] }): Promise<void>;
  cancel(o: { ids: number[] }): Promise<void>;
  delivered(): Promise<{ ids: number[] }>;
  clearAll(): Promise<void>;
  cancelAction(o: { noteId: number; token: string }): Promise<{ removed: boolean }>;
  live(o: LiveSpec & { stop?: boolean }): Promise<void>;
  status(): Promise<NoteStatus>;
  settings(o: { live?: boolean }): Promise<void>;
}>('Notes');

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

/** Notifications and Live Updates as Android has them for Sable (null in a browser). */
export async function noteStatus(): Promise<NoteStatus | null> {
  if (!isNative) return null;
  try {
    return await Notes.status();
  } catch {
    return null;
  }
}

/** Android's own page for Sable's notifications (`live`: its Live Updates page on Android 16). */
export function openNoteSettings(live = false) {
  if (!isNative) return;
  void Notes.settings({ live }).catch(() => {});
}

/** What a notification says happened: a turn ended (or failed), or the chat waits on you. */
export type NoteKind = 'done' | 'failed' | 'waiting';

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
    prepare: async () => {},
    delivered: () =>
      Notes.delivered().then(
        (r) => r.ids,
        () => null,
      ),
    cancel: async (ids) => void (await Notes.cancel({ ids })),
    post: async (n, chats, summary) => {
      await Notes.post({ id: n.id, sessionId: n.sessionId, title: n.title, text: n.body, kind: n.kind, lines: n.lines, chats, summary, ...(n.ask ? { ask: n.ask } : {}) });
    },
    summary: (chats, lines) => Notes.summary({ chats, lines }),
    // Each step awaited and none swallowed: an erasure that leaves a chat's line in the shade says so (lib/erase.ts).
    clearAll: async () => {
      if (!isNative) return;
      await Notes.clearAll();
      const p = await LocalNotifications.getPending();
      if (p.notifications.length) await LocalNotifications.cancel({ notifications: p.notifications.map((n) => ({ id: n.id })) });
    },
  },
  posted,
  idFor,
);

/**
 * One notification per chat, grouped under Sable: its newest news as the line, the earlier ones of
 * this time away listed under it when expanded. A tap opens the chat where it matters: its prompt
 * when it waits on you, the newest turn when one ended; the summary opens home. `ask`: Allow once
 * and Deny on it (lib/notes.ts decides when that is safe).
 */
export async function notify(title: string, body: string, sessionId: string, kind: NoteKind = 'done', ask?: ChatNote['ask']) {
  if (!isNative) return;
  await poster.notify(title, body, sessionId, kind, ask);
}

/** Every chat's notification goes, with what was kept of them, and any still on its way (the desktop was forgotten; the erasure itself checks it: `eraseNative`). */
export function clearChatNotifications() {
  void poster.clear().catch(() => {});
}

/**
 * A chat read (on the phone or the desktop) or answered: its notification goes (after one still
 * going up). The summary goes only with the last chat's.
 */
export function clearNotification(sessionId: string) {
  if (!isNative) return;
  void poster.clearOne(sessionId);
}

/** A later notification in the same chat must survive the older action's round trip. */
export function clearAnsweredNote(a: NoteAction) {
  void poster.clearOne(a.sessionId, async () => (await Notes.cancelAction({ noteId: a.noteId, token: a.token })).removed);
}

/** Back on screen: the lines of the time away start over (the notifications stay until opened or swiped). */
export function forgetNotificationLines() {
  void poster.forgetLines();
}

/** Allow once or Deny pressed on a chat's notification (App.tsx answers it through the phone's approval path). */
export function onNoteAction(fn: (a: NoteAction) => void) {
  if (!isNative) return () => {};
  // Called by NotesPlugin.deliver with evaluateJavascript: a plugin event would wait until the app is on screen.
  const w = window as unknown as { __sableNoteAction?: (a: NoteAction) => void };
  const take = (a: NoteAction) => {
    if (a && typeof a.deviceId === 'string' && typeof a.sessionId === 'string' && typeof a.requestId === 'string' && typeof a.optionId === 'string' && typeof a.detail === 'string' && typeof a.token === 'string' && a.noteId === idFor(a.sessionId) && (a.verb === 'allow' || a.verb === 'deny')) fn(a);
  };
  w.__sableNoteAction = take;
  return () => {
    if (w.__sableNoteAction === take) delete w.__sableNoteAction;
  };
}

// ── the system: share a text, the app icon's shortcuts (android/…/SystemPlugin.java, lib/system-plugin.ts) ──

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

// ── the live notification and the connection kept in the background (android/…/KeepAliveService.java) ──

let latestLive: { key: string; payload: LiveSpec & { stop?: boolean } } | undefined;
let sentLive: { key: string; delivered: Promise<void> } | undefined;
function publishLive() {
  const update = latestLive;
  if (!update) return;
  const attempt = { key: update.key, delivered: Notes.live(update.payload) };
  sentLive = attempt;
  void attempt.delivered.catch(() => {
    if (sentLive === attempt) sentLive = undefined;
  });
  return attempt.delivered;
}
/**
 * What works now (lib/notes.ts `liveWords`), sent on every change: leaving the app then keeps the
 * connection with a live notification (Android would cut it), so the phone can say when it is done
 * or waits. `null` (or nothing at work or waiting) lets it go a minute later.
 */
export function setLive(spec: LiveSpec | null, stop = false) {
  if (!isNative) return;
  const next = spec ?? { chats: 0, waiting: 0, ...(stop && { stop: true }) };
  const key = JSON.stringify(next);
  if (sentLive?.key === key) return sentLive.delivered;
  latestLive = { key, payload: next };
  return publishLive();
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
  await step('live notification', async () => { await setLive(null, true); });
  return failed;
}

// ── app lifecycle ──

/**
 * The person can see the app (lib/screen.ts: Android's word on the phone, never the page's
 * visibility, which PageLife.java holds at visible while a chat works off screen).
 */
export const inForeground = onScreen;

/** On screen (true) or not, once per change; the live payload goes to Android again with it. */
export function onAppState(fn: (active: boolean) => void) {
  return onScreenChange((active) => {
    if (isNative) publishLive();
    fn(active);
  });
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
