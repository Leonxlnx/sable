import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { App } from '../app';
import { chatMarkdown, markdownFileName } from '../core/chat-markdown';

/**
 * "Export chat" and "Copy as Markdown": the conversation as Markdown (`session.markdown`), and
 * written where the person chooses in the desktop app's own save dialog (`session.export`). A
 * bridge without a desktop shell (the dev server in a browser) has no dialog: it answers
 * `unsupported` and the window downloads the Markdown itself.
 */

/** Asks where to save: the chosen file, or undefined when the person cancelled. */
export type SaveDialog = (opts: { defaultPath: string; title: string }) => Promise<string | undefined>;

export interface ExportOptions {
  /** The save dialog (tests); by default Electron's, when the bridge runs in the desktop app. */
  showSave?: SaveDialog;
}

async function electronSave(): Promise<SaveDialog | undefined> {
  if (!process.versions.electron) return undefined;
  const { BrowserWindow, dialog } = await import('electron');
  return async ({ defaultPath, title }) => {
    const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const opts = { title, defaultPath, buttonLabel: 'Export', filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] as ('createDirectory' | 'showOverwriteConfirmation')[] };
    const r = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? undefined : r.filePath;
  };
}

/** Where the first export of a run is offered: the Downloads folder (or home when there is none). */
async function startFolder(): Promise<string> {
  if (process.versions.electron) {
    try {
      const { app } = await import('electron');
      return app.getPath('downloads');
    } catch {
      /* not ready */
    }
  }
  return path.join(os.homedir(), 'Downloads');
}

const AGENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', demo: 'Demo' };

export function registerExport(app: App, opts: ExportOptions = {}) {
  /** The folder the last export went to, offered again for the next one. */
  let lastDir: string | undefined;

  const markdown = async (sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Missing sessionId');
    // The whole conversation (loads it from disk when it was not open; nothing is cut here).
    const snap = await app.call('session.snapshot', { sessionId });
    const name = (p: string) => AGENT[p] ?? app.providers.get(p as never)?.name ?? p;
    return { markdown: chatMarkdown(snap.session, snap.items, { agentName: name }), fileName: markdownFileName(snap.session.title) };
  };

  app.register('session.markdown', ({ sessionId }) => markdown(sessionId));

  app.register('session.export', async ({ sessionId }) => {
    const show = opts.showSave ?? (await electronSave());
    if (!show) return { ok: false, unsupported: true };
    const { markdown: text, fileName } = await markdown(sessionId);
    const file = await show({ title: 'Export chat', defaultPath: path.join(lastDir ?? (await startFolder()), fileName) });
    if (!file) return { ok: false, canceled: true };
    const target = path.extname(file) ? file : `${file}.md`;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    lastDir = path.dirname(target);
    return { ok: true, path: target };
  });
}
