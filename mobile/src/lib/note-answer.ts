import { conn } from './conn';
import { clearAnsweredNote } from './native';
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
