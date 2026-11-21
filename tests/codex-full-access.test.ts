/**
 * Codex fixes a turn's approval policy when the turn starts. A chat switched to Full access during a
 * turn begun in another mode must not keep asking: its asks are answered at once (as Claude Code's
 * are in Bypass), while in other modes they still wait for the person; questions always wait.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { CodexProvider } from '../server/providers/codex';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(10);
  }
}

async function codexChat(mode: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codex-full-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return { thread: { id: String(params.threadId), model: 'm' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: 'turn1' } };
      if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
      return {};
    },
  };
  let provider!: InstanceType<typeof CodexProvider>;
  const app = new App({
    home: path.join(home, 'data'),
    quiet: true,
    providers: [
      (ctx) => {
        const p = new CodexProvider(ctx);
        const anyP = p as unknown as Record<string, unknown>;
        anyP.client = async () => rpc;
        anyP.version = async () => ({ installed: true, version: '1' });
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true, compact: true } });
        provider ??= p;
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode, model: 'm' });
  const rt = app.runtime(snap.session.id);
  await app.call('session.send', { sessionId: rt.id, text: 'publish the scenes' });
  await until(() => provider.sessions.size > 0);
  const session = () => [...provider.sessions.values()][0] as unknown as { onRequest(method: string, p: unknown, id: number): Promise<unknown> };
  return { app, rt, session };
}

const command = { threadId: 'th1', turnId: 'turn1', itemId: 'c1', command: 'gh repo view x/y --json url', cwd: '/w', reason: 'May I check the name?' };

describe('Codex in Full access', () => {
  it('a turn begun in Auto, switched to Full access: its later asks are allowed at once', async () => {
    const h = await codexChat('auto');
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'full-access' });
    const answer = await h.session().onRequest('item/commandExecution/requestApproval', command, 1);
    expect(answer).toEqual({ decision: 'accept' });
    expect(h.rt.prompts().permissions).toHaveLength(0);
    expect(await h.session().onRequest('item/fileChange/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'f1', reason: null, grantRoot: null }, 2)).toEqual({ decision: 'accept' });
    expect(await h.session().onRequest('item/permissions/requestApproval', { threadId: 'th1', turnId: 'turn1', itemId: 'p1', cwd: '/w', reason: null, permissions: { network: { enabled: true } } }, 3)).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(await h.session().onRequest('execCommandApproval', { conversationId: 'th1', callId: 'x', command: ['ls'], cwd: '/w', reason: null, parsedCmd: [] }, 4)).toEqual({ decision: 'approved' });
  });

  it('in Auto the same ask waits for the person', async () => {
    const h = await codexChat('auto');
    void h.session().onRequest('item/commandExecution/requestApproval', command, 1);
    await until(() => h.rt.prompts().permissions.length > 0);
    expect(h.rt.prompts().permissions[0].title).toBe('Run this command?');
    h.rt.cancelPrompts();
  });
});

describe("an \"Always allow\" rule's name", () => {
  it('is the command inside the shell, also from a path with spaces', async () => {
    const { innerCommand } = await import('../server/providers/codex-map');
    expect(innerCommand(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'gh repo view x/y --json url'])).toBe('gh repo view x/y --json url');
    expect(innerCommand(['/bin/bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(innerCommand(['cmd.exe', '/c', 'dir'])).toBe('dir');
    expect(innerCommand(['git', 'status'])).toBe('git status');
  });
});
