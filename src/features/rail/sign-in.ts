import { useSyncExternalStore } from 'react';
import type { SignInInfo } from '@shared/protocol';

/**
 * The window's side of a sign-in (browser_sign_in): what the tab shows over the page while it
 * waits for the person, kept outside React per tab. The card's password goes from its field
 * straight into the answer's promise and on into the page; it is never put into the app's store.
 */

/** What the person chose. */
export type SignInChoice =
  | { kind: 'cancel' }
  | { kind: 'saved'; id: string; username: string }
  | { kind: 'typed'; username: string; password: string; save: boolean }
  /** "Not this time" on the line of a saved sign-in: the card asks instead. */
  | { kind: 'notNow' };

export interface SignInAsk {
  tabId: string;
  /** Scheme, host and port as the browser has them: what the card shows, large. */
  origin: string;
  /** 'card': the person signs in (or picks one of several saved); 'auto': one saved sign-in is used unless they say not this time. */
  mode: 'card' | 'auto';
  saved: SignInInfo[];
  /** This computer can save a sign-in (the desktop's safeStorage); else the card says it is used once. */
  canSave: boolean;
  answer(choice: SignInChoice): void;
}

/** How long the line of a saved sign-in waits for "Not this time". */
export const AUTO_WAIT_MS = 2600;
/** How long "Signed in as name" stays. */
export const SIGNED_LINE_MS = 3200;

const asks = new Map<string, SignInAsk>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getSignInAsk = (tabId: string) => asks.get(tabId);

export function useSignInAsk(tabId: string): SignInAsk | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => asks.get(tabId),
  );
}

/** Shows the card (or the line) on a tab and waits for the person; another ask on the tab cancels the old one. */
export function askSignIn(a: Omit<SignInAsk, 'answer'>, signal?: { cancelled(): boolean }): Promise<SignInChoice> {
  asks.get(a.tabId)?.answer({ kind: 'cancel' });
  return new Promise((resolve) => {
    let done = false;
    const ask: SignInAsk = {
      ...a,
      answer(choice) {
        if (done) return;
        done = true;
        if (asks.get(a.tabId) === ask) asks.delete(a.tabId);
        emit();
        resolve(choice);
      },
    };
    asks.set(a.tabId, ask);
    emit();
    if (a.mode === 'auto' && a.saved[0]) {
      const pick = a.saved[0];
      setTimeout(() => ask.answer({ kind: 'saved', id: pick.id, username: pick.username }), AUTO_WAIT_MS);
    }
    // The tab closed, the session went away: the ask ends as a cancel.
    if (signal) {
      const poll = setInterval(() => {
        if (done) return clearInterval(poll);
        if (signal.cancelled()) {
          clearInterval(poll);
          ask.answer({ kind: 'cancel' });
        }
      }, 500);
    }
  });
}

/** Cancels whatever a tab is asking (its page moved, the tab closed). */
export function cancelSignIn(tabId: string) {
  asks.get(tabId)?.answer({ kind: 'cancel' });
}

/** "https://", "mebis.bycs.de", ":8443": the origin in the parts the card sets apart. */
export function originParts(origin: string): { scheme: string; host: string } {
  try {
    const u = new URL(origin);
    return { scheme: `${u.protocol}//`, host: u.host };
  } catch {
    return { scheme: '', host: origin };
  }
}
