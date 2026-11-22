import { createSession, homeChoice, spareSend } from '@/state/actions';
import { useStore } from '@/state/store';

/**
 * `/spare <message>`: the message waits in the chat's queue and starts by itself when an account of
 * its agent has weekly quota that would otherwise go unused (server/core/spare.ts). From home it
 * starts a new chat with the home choices, which then waits.
 */
export async function spareCommand(sessionId: string | null, arg: string): Promise<boolean> {
  const s = useStore.getState();
  const text = arg.trim();
  if (!text) {
    s.toast('Add a message after /spare');
    return false;
  }
  let id = sessionId;
  if (!id) {
    const choice = homeChoice();
    if (!choice) {
      s.setUi({ projectPicker: true });
      return false;
    }
    const made = await createSession(choice.chat ? { ...choice, chat: { text } } : choice);
    if (!made) return false;
    id = made.id;
  }
  // Refused (or not reached): false, and the composer puts `/spare <message>` back.
  return spareSend(id, text);
}
