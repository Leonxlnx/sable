import { conn } from './conn';
import { clearAnsweredNote } from './native';
import { noteStop } from './note-live';
import { liveEnabled, noteAnswer, type NoteAction } from './notes';
import { getState } from './store';

/** The receiver has already left an Open action. Send an unlocked tap once, on this pairing. */
export async function answerFromNote(action: NoteAction) {
  const state = getState();
  if (!liveEnabled(state) || action.deviceId !== conn.pairing?.deviceId) return;
  const params = noteAnswer(action, state.pending, conn.pairing.deviceId);
  if (!params) {
    if (!state.pending.permissions.some((p) => p.id === action.requestId && p.sessionId === action.sessionId)) clearAnsweredNote(action);
    return;
  }
  try {
    // The runtime returns ok:false when the desktop has already removed this exact request.
    await conn.call('permission.respond', params);
    clearAnsweredNote(action);
  } catch {
    // A closed socket or refused answer leaves Open in place. Never replay it on reconnect.
  }
}

/**
 * Stop now, confirmed on a chat's live card (KeepAliveService; the phone was unlocked for it): the chat
 * is stopped as its own Stop does, only while its turn still runs on this connection (note-live.ts
 * `noteStop`). Never replayed: a closed socket stops nothing, and the card goes back to its keys.
 */
export async function stopFromNote(data: { sessionId?: unknown } | undefined) {
  const state = getState();
  const params = noteStop(data?.sessionId, state.sessions, liveEnabled(state));
  if (!params) return;
  try {
    await conn.call('session.interrupt', params);
  } catch {
    // Refused or offline: the chat's card still offers Stop.
  }
}

// NotesPlugin.deliverStop calls it with evaluateJavascript (a plugin event waits until the app is on
// screen). Installed with this module, which App.tsx loads for the answers above.
if (typeof window !== 'undefined') {
  (window as unknown as { __sableNoteStop?: (d: { sessionId?: unknown }) => void }).__sableNoteStop = (d) => void stopFromNote(d);
}
