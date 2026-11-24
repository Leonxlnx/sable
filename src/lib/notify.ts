/**
 * What "this chat needs you" does (the rule itself is `lib/attention.ts`): a system notification per
 * chat that replaces itself, the taskbar's overlay with the number of chats waiting and one flash
 * of its button (through the desktop shell, `electron/attention.ts`; nothing without the shell),
 * and a click that brings the window forward onto the deck's card for that chat, or the chat.
 *
 * The store feeds it (`heard`, from `applyEvent`) and starts it with the bridge (`startNotify`);
 * nothing here runs at import, so the store may import it.
 */
import { onScreen as chatsOnScreen, touchKept, trimKept, useStore } from '@/state/store';
import { selectPending } from '@/state/pending';
import { askFront } from '@/features/triage/front';
import { Attention, decide, type Signal, waitingChats, wordsFor } from './attention';
import { desktop } from './desktop';

export const attention = new Attention();

/** How long after a key in a chat's composer the person counts as typing there. */
const TYPING_MS = 4000;
let typedAt = 0;
let typedIn: string | null = null;

/**
 * Verification runs of the desktop app (`--eval`) never show a real notification on the owner's
 * screen: what would be shown is kept here, with its click, for the run to read back.
 */
interface Shown {
  chat: string;
  title: string;
  body: string;
  click: () => void;
}
const dry = !!desktop?.debug;
const shownLog: Shown[] = [];

/** The open notification of each chat, and whether it says the chat waits. */
const open = new Map<string, { close: () => void; waiting: boolean }>();

/** Signals the tracker answered for one event: acted on after the store applied that event. */
export function heard(signals: Signal[]) {
  if (!signals.length) return;
  queueMicrotask(() => {
    for (const s of signals) {
      try {
        act(s);
      } catch {
        /* telling the person is best effort: it never stands in the way of the events */
      }
    }
  });
}

function act(sig: Signal) {
  const s = useStore.getState();
  const meta = s.sessions[sig.chat];
  if (!meta) return;
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return;
  const visible = !document.hidden;
  const focused = visible && document.hasFocus();
  const onScreen = visible && chatsOnScreen(s).includes(sig.chat);
  const typing = typedIn === sig.chat && performance.now() - typedAt < TYPING_MS;
  const what = decide(sig, { enabled: !!s.settings.notifyOnDone, muted: !!meta.muted, onScreen, focused, typing });
  if (what.flash) flash = true;
  if (what.notify) show(sig, meta.title);
  sync();
}

function show(sig: Signal, chatTitle: string) {
  const { title, body } = wordsFor(sig, chatTitle);
  const chat = sig.chat;
  const click = () => {
    focusWindow();
    openFor(chat);
  };
  if (dry) {
    shownLog.push({ chat, title, body, click });
    if (shownLog.length > 50) shownLog.shift();
    open.set(chat, { close: () => {}, waiting: sig.kind === 'waiting' });
    return;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    // One per chat: the same tag replaces the one before (a new one is not a pile).
    const n = new Notification(title, { body, tag: `chat:${chat}` });
    n.onclick = () => {
      click();
      n.close();
    };
    n.onclose = () => {
      if (open.get(chat)?.close === close) open.delete(chat);
    };
    const close = () => n.close();
    open.set(chat, { close, waiting: sig.kind === 'waiting' });
  } catch {
    /* notifications are best effort */
  }
}

function focusWindow() {
  if (desktop?.attention) desktop.attention.focus();
  else window.focus();
}

/** A click: the deck on the chat's card when something of it waits there, else the chat. */
export function openFor(chat: string) {
  const s = useStore.getState();
  if (!s.sessions[chat]) return;
  const prompts = selectPending(s).filter((p) => p.sessionId === chat);
  if (prompts.length) {
    askFront(prompts[0].key);
    s.setUi({ triageOpen: true });
    return;
  }
  if (s.ui.triageOpen) s.setUi({ triageOpen: false });
  touchKept(chat);
  s.setUi({ activeSessionId: chat, race: null });
  trimKept();
}

// ── the shell's part ──

let flash = false;
let lastCount = -1;

/** The number of chats waiting, to the shell; a flash asked for goes with it once. */
function sync() {
  const s = useStore.getState();
  const prompts = new Set(selectPending(s).map((p) => p.sessionId));
  const count = waitingChats(prompts, attention.limitChats(), (id) => !!s.sessions[id]);
  // A chat that no longer waits: its "waiting" notification is out of date.
  for (const [chat, n] of open) {
    if (n.waiting && !prompts.has(chat) && !attention.limitWaits(chat)) {
      n.close();
      open.delete(chat);
    }
  }
  if (count === lastCount && !flash) return;
  lastCount = count;
  const f = flash && count > 0;
  flash = false;
  desktop?.attention?.set({ count, flash: f });
}

export function startNotify() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  // The figure follows every change of what waits (an answer on the phone, a chat removed).
  let prev: unknown;
  let prevLimits = '';
  useStore.subscribe((s) => {
    const p = selectPending(s);
    const limits = attention.limitChats().join();
    if (p === prev && limits === prevLimits) return;
    prev = p;
    prevLimits = limits;
    sync();
  });
  document.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as Element | null;
      if (!t?.closest?.('.composer')) return;
      const id = useStore.getState().ui.activeSessionId;
      if (!id) return;
      typedIn = id;
      typedAt = performance.now();
    },
    true,
  );
  if (dry) (window as { sableNotes?: unknown }).sableNotes = { shown: shownLog, sync, openFor };
}
