import { bridge } from '@/lib/bridge';
import { baseName } from '@/lib/format';
import { completeSession, useStore } from '@/state/store';

/**
 * "Export chat" and "Copy as Markdown" (the session header's menu, the palette). The bridge writes
 * the Markdown (`server/core/chat-markdown.ts`) and, in the desktop app, asks where to save it in
 * the system's own dialog; in a browser the file is downloaded instead.
 */

const toast = (text: string, level?: 'info' | 'success' | 'error') => useStore.getState().toast(text, level);
const fail = (err: unknown) => toast((err as Error)?.message ?? String(err), 'error');

/** One export at a time: a second press while the dialog is open does nothing. */
let exporting = false;

export async function exportChat(sessionId: string): Promise<void> {
  if (exporting) return;
  exporting = true;
  try {
    // The dialog waits for the person: no short timeout.
    const r = await bridge.call('session.export', { sessionId }, 30 * 60_000);
    if (r.unsupported) {
      const { markdown, fileName } = await bridge.call('session.markdown', { sessionId });
      download(markdown, fileName);
      toast(`Downloaded ${fileName}`, 'success');
    } else if (r.ok && r.path) toast(`Exported ${baseName(r.path)}`, 'success');
  } catch (err) {
    fail(err);
  } finally {
    exporting = false;
  }
}

export async function copyChatMarkdown(sessionId: string): Promise<void> {
  try {
    if (useStore.getState().data[sessionId]?.incomplete) await completeSession(sessionId);
    const { markdown } = await bridge.call('session.markdown', { sessionId });
    await navigator.clipboard.writeText(markdown);
    toast('Copied the chat as Markdown', 'success');
  } catch (err) {
    fail(err instanceof Error && /clipboard|denied|document is not focused/i.test(err.message) ? new Error('Could not reach the clipboard') : err);
  }
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
