import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserAnswer, SessionMeta } from '@shared/protocol';
import { GuestLog, type GuestEvent } from '../electron/guest-log';
import { SessionRuntime } from '../server/core/runtime';
import { runBrowserTool } from '../server/providers/browser-tool';
import { useStore } from '@/state/store';
import { getLog, receivePageLog, setPage } from '@/features/rail/browser-store';
import type { PageController } from '@/features/rail/browser-agent';

const actions = vi.hoisted(() => ({ respondBrowser: vi.fn(), reportBrowserPage: vi.fn(), listSignIns: vi.fn() }));
vi.mock('@/state/actions', () => actions);

const url = 'http://localhost:4599/a';
let agent: typeof import('@/features/rail/browser-agent');
let unregister: (() => void) | undefined;
let session = 0;

beforeAll(async () => {
  vi.stubGlobal('window', { sableDesktop: { browser: {} } });
  agent = await import('@/features/rail/browser-agent');
  vi.unstubAllGlobals();
});

afterEach(() => {
  unregister?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The real tool and window handlers, with a fake webview and the socket replies delivered in memory. */
function windowWithPage() {
  vi.useFakeTimers();
  vi.stubGlobal('location', new URL('http://localhost:4598/'));
  const id = 'read-' + ++session;
  const meta: SessionMeta = { id, provider: 'demo', cwd: '/x', title: '', titleSource: 'auto', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, (e) => {
    if (e.type === 'browser.request') void agent.handleBrowserRequest(e.request);
  }, () => {});
  actions.respondBrowser.mockImplementation((_session: string, request: string, answer: BrowserAnswer) => rt.answerBrowser(request, answer));
  useStore.getState().setUi({ activeSessionId: id });
  const read = vi.fn(async () => ({ title: 'Page A', text: 'First page.', length: 11 }));
  const c: PageController = {
    sessionId: id, tabId: id, url: () => url, read,
    capture: async () => '', run: async () => null, key: async () => false, history: () => false,
  };
  unregister = agent.registerPage(c);
  const deliver = (batch: GuestEvent[]) => {
    for (const e of batch) receivePageLog(id, e.type === 'console' ? { ...e, count: e.dropped } : e);
  };
  return { rt, id, read, deliver };
}

describe('the load log in the first browser_read', () => {
  it('includes an inline error and a post-load 404 delivered after browser_open resolves', async () => {
    const { rt, id, read, deliver } = windowWithPage();
    const shell = new GuestLog();
    const opened = runBrowserTool(rt, 'open', { url });
    await vi.advanceTimersByTimeAsync(0);
    setPage(id, { url, loading: true, title: 'Page A', viewDoc: 1 });
    deliver(shell.commit(7));
    await vi.advanceTimersByTimeAsync(800);
    shell.console(7, { level: 'error', text: 'A-ERR-MARK' });
    shell.begin(7, 10);
    setPage(id, { loading: false });
    expect((await opened).ok).toBe(true);

    const first = runBrowserTool(rt, 'read', {});
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledOnce();
    shell.loadEnded(7, 1);
    deliver(shell.flush()); // The error arrived. The request is still in flight.
    shell.net(7, shell.end(10, 7), { url: 'http://localhost:4599/missing-a', method: 'GET', status: 404 });
    const delayed = shell.flush();
    await vi.advanceTimersByTimeAsync(670); // Past even the UI's 700 ms minimum for showing a read.
    deliver(delayed);
    const answer = await first;
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain('First page.');
    expect(answer.text).toContain('error: A-ERR-MARK');
    expect(answer.text).toContain('GET http://localhost:4599/missing-a (404)');
    expect(answer.text).not.toContain('still arriving');
  });

  it('returns the text and the partial log at 750 ms even while more lines arrive', async () => {
    const { rt, id, read, deliver } = windowWithPage();
    const shell = new GuestLog();
    read.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { title: 'Page A', text: 'First page.', length: 11 };
    });
    setPage(id, { url, viewDoc: 1 });
    deliver(shell.commit(7));
    shell.begin(7, 10); // A streaming request never ends.
    shell.loadEnded(7, 1);
    const first = runBrowserTool(rt, 'read', {});
    const done = vi.fn();
    void first.then(done);
    for (let beat = 0; beat < 4; beat++) {
      shell.console(7, { level: 'warning', text: 'line ' + beat });
      deliver(shell.flush());
      await vi.advanceTimersByTimeAsync(180);
    }
    await vi.advanceTimersByTimeAsync(29);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
    const answer = await first;
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain('First page.');
    expect(answer.text).toContain('warning: line 3');
    expect(answer.text).toContain('Failed requests: none received yet.');
    expect(answer.text).toContain('only entries received so far');
  });

  it('a same-URL reload cannot borrow the previous document’s ready marker or log', async () => {
    const { rt, id, deliver } = windowWithPage();
    const shell = new GuestLog();
    deliver(shell.commit(7));
    shell.console(7, { level: 'error', text: 'old document' });
    shell.loadEnded(7, 1);
    const old = shell.flush();
    setPage(id, { url, viewDoc: 2 }); // The webview has reloaded before the shell IPC catches up.
    const first = runBrowserTool(rt, 'read', {});
    await vi.advanceTimersByTimeAsync(0);
    deliver(old);
    await vi.advanceTimersByTimeAsync(750);
    const answer = await first;
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain('only entries received so far');
    expect(answer.text).not.toContain('old document');
  });

  it('asks for a fresh read if another document commits after the text was taken', async () => {
    const { rt, id, deliver } = windowWithPage();
    const shell = new GuestLog();
    setPage(id, { url, viewDoc: 1 });
    deliver(shell.commit(7));
    const first = runBrowserTool(rt, 'read', {});
    await vi.advanceTimersByTimeAsync(10);
    deliver(shell.commit(7)); // Same address, new document. Its webview event is still queued.
    await vi.advanceTimersByTimeAsync(700);
    expect(await first).toMatchObject({ ok: false, text: 'The page changed during the read. Try again.' });
  });

  it('applies the old tail before the single shell reset and drops old failures after it', () => {
    const { id, deliver } = windowWithPage();
    const shell = new GuestLog();
    deliver(shell.commit(7));
    shell.begin(7, 10);
    shell.console(7, { level: 'warning', text: 'last on A' });
    setPage(id, { viewDoc: 2 });
    const [tail, doc] = shell.commit(7);
    deliver([tail]);
    expect(getLog(id).console.map((l) => l.text)).toEqual(['last on A']);
    deliver([doc]);
    expect(getLog(id).console).toEqual([]);
    shell.console(7, { level: 'error', text: 'first on B' });
    shell.net(7, shell.end(10, 7), { url: '/slow-fail', method: 'GET', status: 500 });
    shell.loadEnded(7, 2);
    deliver(shell.flush());
    deliver([doc]);
    expect(getLog(id).console.map((l) => l.text)).toEqual(['first on B']);
    expect(getLog(id).failed).toEqual([]);
  });
});
