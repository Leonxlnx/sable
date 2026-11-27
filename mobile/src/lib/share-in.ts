import { useSyncExternalStore } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { composition, HOME_DRAFT, setDraft } from './drafts';
import { nav } from './nav';
import { System } from './system-plugin';

/**
 * Share into Sable (2.22): text or a link another app hands over through Android's share sheet
 * (MainActivity `takeShare`, SystemPlugin `shared`, kept until the page listens). The phone asks which
 * chat it goes to (screens/ShareSheet.tsx, the Recent list) and puts it in that chat's draft, after
 * what the draft holds, on a paragraph of its own; or in the new chat's field. Never sent by itself.
 */

export interface Shared {
  text: string;
  at: number;
}

/** What a share says at most (the native side cuts it too): a draft, not a file. */
export const SHARED_MAX = 20_000;

let shared: Shared | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The share's words: the subject leads when the text does not already hold it (a page's title, then its link). */
export function sharedText(text: string, subject?: string): string {
  const t = text.trim();
  const s = subject?.trim();
  const out = s && !t.includes(s) ? `${s}\n${t}` : t;
  return out.length > SHARED_MAX ? out.slice(0, SHARED_MAX) : out;
}

export function offerShare(text: string, subject?: string, now = Date.now()) {
  const t = sharedText(text, subject);
  if (!t) return;
  shared = { text: t, at: now };
  emit();
}

export const dropShare = () => {
  shared = null;
  emit();
};

export const useShared = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => shared,
  );

/**
 * Where the words go: after what the draft already holds (a blank line between), or alone. The files
 * the draft holds stay with it.
 */
export function withShared(draft: string, text: string): string {
  return draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text;
}

/** Into a chat's draft, and the chat opens on it (its field takes the words and the focus). */
export function shareInto(sid: string, text: string) {
  const d = composition(sid);
  setDraft(sid, withShared(d.t, text), { why: 'put', now: true, ...(d.files?.length ? { files: d.files } : {}) });
  dropShare();
  nav.chat(sid);
}

/** Into the new chat's field on home, which opens with the keyboard. */
export function shareIntoNew(text: string) {
  setDraft(HOME_DRAFT, withShared(composition(HOME_DRAFT).t, text), { why: 'put', now: true });
  dropShare();
  nav.reset();
  window.setTimeout(() => window.dispatchEvent(new Event('sable:newchat')), 320);
}

/** The chats a share may go to, as the Recent list orders them: pinned first, then the newest; none archived. */
export function shareTargets(sessions: Record<string, SessionMeta>, max = 12): SessionMeta[] {
  return Object.values(sessions)
    .filter((s) => !s.archived && !s.custom)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
    .slice(0, max);
}

/** Listens for shares from Android (once, at the app's start). */
export function listenForShares(): () => void {
  let off: (() => void) | undefined;
  void System.addListener('share', (r: { text?: string; subject?: string }) => typeof r.text === 'string' && offerShare(r.text, r.subject))
    .then((h) => (off = () => void h.remove()))
    .catch(() => {});
  return () => off?.();
}
