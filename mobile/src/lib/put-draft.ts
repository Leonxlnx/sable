/**
 * Words put into a chat's composer from elsewhere in the chat (a check's findings: "Fix these", a
 * queued message taken back to edit), never sent by themselves. The composer of that chat takes them
 * and focuses its field; `append` keeps what it already holds and adds them on a line of their own.
 */
const listeners = new Map<string, (text: string, append: boolean) => void>();

export function putDraft(sid: string, text: string, opts: { append?: boolean } = {}) {
  listeners.get(sid)?.(text, !!opts.append);
}

export function onPutDraft(sid: string, fn: (text: string, append: boolean) => void) {
  listeners.set(sid, fn);
  return () => {
    if (listeners.get(sid) === fn) listeners.delete(sid);
  };
}
