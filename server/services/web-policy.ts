import type { App } from '../app';
import { phoneRefusal } from './custom';

/** Checked before dispatch and at each eventual provider write, against the destination runtime. */
export function webSteerRefusal(app: App, sessionId: unknown) {
  const rt = typeof sessionId === 'string' ? app.sessions.get(sessionId) : undefined;
  if (!rt) return 'Choose an existing chat on this computer.';
  const custom = phoneRefusal(app, 'session.send', { sessionId });
  if (custom) return custom;
  if (app.store.state.settings.webSteerDanger === true) return;
  if (app.changingMode(rt.id)) return 'Wait for the desktop to finish changing this chat’s mode.';
  // The current catalog can be absent while a restored chat loads. The built-in danger IDs still count.
  for (const mode of [rt.meta.mode, rt.workMode]) {
    if (['bypassPermissions', 'full-access', 'allow-all'].includes(mode) || rt.caps?.modes.some(m => m.id === mode && m.tone === 'danger'))
      return 'This chat runs without asking. Enable web steering for these chats on the desktop to send or answer.';
  }
}

