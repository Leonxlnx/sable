/**
 * Codex's one-shot title (CodexProvider.quickTitle): the prompt goes out only while the chat still
 * holds the title it was asked under (review wave 2, #8), and only in a thread started with no tools,
 * no MCP servers, no apps and no plugins, checked on the thread itself before the prompt (#9). A fake
 * app-server only: nothing here calls a real model.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta, TurnItem, UserItem } from '@shared/protocol';
import { SessionRuntime } from '../server/core/runtime';
import { ChatTitles, titlePrompt } from '../server/core/titles';
import { CodexProvider } from '../server/providers/codex';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function until(pred: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

type Call = { method: string; params: Record<string, unknown> };

/**
 * A Codex provider on a fake app-server. `threadStart`: how thread/start answers (a promise a test
 * releases); `mcp`: how the title thread's own MCP listing answers; `mcpCache`: the account's last
 * known inventory (undefined: a cold cache).
 */
function codexTitle(opts: { threadStart?: () => Promise<unknown>; mcp?: (params: Record<string, unknown>) => unknown; mcpCache?: { name: string; scope?: string }[] } = {}) {
  const p = new CodexProvider({ emit: () => {}, log: () => {}, account: { id: 'work', dir: path.join(tmpdir(), 'codex-work') } });
  const calls: Call[] = [];
  const notify = (m: string, x: unknown) => (p as unknown as { onNotification(m: string, x: unknown): void }).onNotification(m, x);
  const answer = (threadId: string) => {
    notify('turn/started', { threadId, turn: { id: 'turn-t', status: 'inProgress', items: [] } });
    notify('item/completed', { threadId, turnId: 'turn-t', item: { id: 'm1', type: 'agentMessage', text: 'Session module cleanup' } });
    notify('turn/completed', { threadId, turn: { id: 'turn-t', status: 'completed', items: [] } });
  };
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'thread/start') {
        if (opts.threadStart) await opts.threadStart();
        return { thread: { id: 'tt1' }, model: params.model };
      }
      if (method === 'mcpServerStatus/list') return opts.mcp ? opts.mcp(params) : { data: [], nextCursor: null };
      if (method === 'turn/start') {
        setTimeout(() => answer('tt1'), 1);
        return { turn: { id: 'turn-t' } };
      }
      return {};
    },
  };
  const anyP = p as unknown as Record<string, unknown>;
  anyP.client = async () => rpc;
  anyP.caps = async () => ({ models: [{ id: 'gpt-6-mini', name: 'GPT-6 Mini', picker: true, efforts: ['minimal', 'low'] }] });
  if (opts.mcpCache) anyP.mcpCache = opts.mcpCache;
  return { p, calls, methods: () => calls.map((c) => c.method) };
}

/** A gate a fake answer waits on. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

const prompt = () => titlePrompt({ message: 'Summarize the session module', answer: '' }, process.cwd());

describe('#8: the title prompt goes out only while it is still wanted', () => {
  it('a title given up while its thread starts sends no prompt: the thread is let go', async () => {
    const g = gate();
    const { p, calls, methods } = codexTitle({ threadStart: g.wait });
    const ctrl = new AbortController();
    const asked = p.quickTitle(prompt(), ctrl.signal);
    await until(() => calls.some((c) => c.method === 'thread/start'), 'thread/start');
    // The 45 s timeout of ChatTitles fires while the app-server is still starting the thread.
    ctrl.abort();
    g.open();
    expect(await asked).toBeNull();
    await tick(5);
    expect(methods()).not.toContain('turn/start');
    expect(methods()).toContain('thread/unsubscribe');
  });

  it('a title no longer held (renamed, titles off, another account) when its thread is ready sends no prompt', async () => {
    const g = gate();
    const { p, calls, methods } = codexTitle({ threadStart: g.wait });
    let holds = true;
    const asked = p.quickTitle(prompt(), new AbortController().signal, () => holds);
    await until(() => calls.some((c) => c.method === 'thread/start'), 'thread/start');
    holds = false;
    g.open();
    expect(await asked).toBeNull();
    await tick(5);
    expect(methods()).not.toContain('turn/start');
    expect(methods()).toContain('thread/unsubscribe');
  });

  function chat() {
    const now = Date.now();
    const meta: SessionMeta = { id: 's1', provider: 'codex', accountId: 'work', cwd: process.cwd(), title: 'Summarize the session module', titleSource: 'auto', model: 'gpt-6', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 1 } };
    const rt = new SessionRuntime(meta, () => {}, () => {});
    const msg = rt.add<UserItem>({ type: 'user', text: 'Summarize the session module', state: 'sent' });
    rt.add<TurnItem>({ type: 'turn', durationMs: 1 });
    return { rt, msg };
  }

  for (const [what, change] of [
    ['renamed by the person', (rt: SessionRuntime, s: { chatTitles?: boolean }) => (void s, rt.update({ title: 'Mine', titleSource: 'user' }))],
    ['titles switched off', (_rt: SessionRuntime, s: { chatTitles?: boolean }) => (s.chatTitles = false)],
    ['moved to another account', (rt: SessionRuntime, s: { chatTitles?: boolean }) => (void s, rt.update({ accountId: 'home' }))],
  ] as const) {
    it(`through ChatTitles: a chat ${what} while the title thread starts gets no prompt sent`, async () => {
      const g = gate();
      const { p, calls, methods } = codexTitle({ threadStart: g.wait });
      const settings: { chatTitles?: boolean } = {};
      const titles = new ChatTitles({
        settings: () => settings,
        model: () => (pr, signal, holds) => p.quickTitle(pr, signal, holds),
        open: () => true,
        log: () => {},
      });
      cleanups.push(() => titles.dispose());
      const { rt, msg } = chat();
      titles.turnEnded(rt, [msg.id]);
      await until(() => calls.some((c) => c.method === 'thread/start'), 'thread/start');
      change(rt, settings);
      g.open();
      await until(() => methods().includes('thread/unsubscribe'), 'thread/unsubscribe');
      await tick(5);
      expect(methods()).not.toContain('turn/start');
      expect(rt.meta.title).not.toBe('Session module cleanup');
    });
  }

  it('a title still held goes out and comes back', async () => {
    const { p, methods } = codexTitle();
    expect(await p.quickTitle(prompt(), new AbortController().signal, () => true)).toBe('Session module cleanup');
    expect(methods()).toEqual(['thread/start', 'mcpServerStatus/list', 'turn/start', 'thread/unsubscribe']);
  });
});

describe('#9: a title thread has no tools, no MCP servers, no apps and no plugins, checked before the prompt', () => {
  it('starts with an explicit empty configuration, also when the inventory was never read', async () => {
    const { p, calls } = codexTitle();
    expect(await p.quickTitle(prompt(), new AbortController().signal)).toBe('Session module cleanup');
    const start = calls.find((c) => c.method === 'thread/start')!.params;
    const config = start.config as Record<string, unknown>;
    // Every MCP server of the account's config.toml replaced by none (the override replaces the whole table).
    expect(config.mcp_servers).toEqual({});
    // Apps (connectors) off by default, with no app of the account's listed.
    expect(config.apps).toEqual({ _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } });
    // The bundled computer-use plugin off even when the inventory never named it.
    expect(config.plugins).toEqual({ 'unified-computer-use@openai-bundled': { enabled: false } });
    expect(config).toMatchObject({ web_search: 'disabled', project_doc_max_bytes: 0 });
    expect(start.dynamicTools).toEqual([]);
    expect(start.selectedCapabilityRoots).toEqual([]);
    expect(start).toMatchObject({ ephemeral: true, environments: [], sandbox: 'read-only', approvalPolicy: 'never' });
    // The title thread's own MCP listing is asked before the prompt goes.
    const check = calls.find((c) => c.method === 'mcpServerStatus/list')!;
    expect(check.params).toMatchObject({ threadId: 'tt1' });
    expect(calls.findIndex((c) => c.method === 'mcpServerStatus/list')).toBeLessThan(calls.findIndex((c) => c.method === 'turn/start'));
  });

  it("every plugin the inventory knows is off too", async () => {
    const { p, calls } = codexTitle({ mcpCache: [{ name: 'linear' }, { name: 'computer-use', scope: 'computer-use@openai-bundled' }, { name: 'figma', scope: 'figma@market' }] });
    await p.quickTitle(prompt(), new AbortController().signal);
    const config = calls.find((c) => c.method === 'thread/start')!.params.config as Record<string, unknown>;
    expect(config.plugins).toEqual({ 'unified-computer-use@openai-bundled': { enabled: false }, 'computer-use@openai-bundled': { enabled: false }, 'figma@market': { enabled: false } });
    expect(config.mcp_servers).toEqual({});
  });

  for (const [what, mcp] of [
    ['lists a server (the override did not hold)', () => ({ data: [{ name: 'linear', tools: {}, authStatus: 'unsupported' }], nextCursor: null })],
    ['cannot be read', () => Promise.reject(new Error('mcpServerStatus/list failed'))],
    ['answers with no list', () => ({})],
  ] as const) {
    it(`skips the title when the thread's MCP listing ${what}: no prompt, the thread let go`, async () => {
      const { p, methods } = codexTitle({ mcp });
      expect(await p.quickTitle(prompt(), new AbortController().signal)).toBeNull();
      await tick(5);
      expect(methods()).not.toContain('turn/start');
      expect(methods()).toContain('thread/unsubscribe');
    });
  }
});
