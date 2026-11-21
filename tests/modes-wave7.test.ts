/**
 * Modes after review wave 7 (scratch/reviews/out-wave7.md):
 * - 1: a mode that never asks, chosen from a phone while a turn runs, answers that turn's later asks
 *   only from the next message on (the phone could not be shown them); chosen at the desktop it answers
 *   at once, as before. Codex (Full access) and Claude Code (Bypass, whose own mode waits too).
 * - 2: a Codex start's answer clears the pending policy only when no mode change came after it was sent.
 * Fake Codex app-server and a fake Claude query only.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import type { ProviderSession } from '../server/providers/types';

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

const MODES = [
  { id: 'default', name: 'Ask', tone: 'ask' },
  { id: 'auto', name: 'Auto', tone: 'edit' },
  { id: 'full-access', name: 'Full access', tone: 'danger' },
];

async function codexChat(mode: string) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-modes-w7-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const starts: Record<string, unknown>[] = [];
  let hold: Promise<void> | undefined;
  let turns = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return { thread: { id: String(params.threadId), model: 'm' }, model: 'm' };
      if (method === 'turn/start') {
        starts.push(params);
        await hold;
        return { turn: { id: `turn${++turns}` } };
      }
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
        anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: MODES, commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true, compact: true } });
        provider ??= p;
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode, model: 'm' });
  const rt = app.runtime(snap.session.id);
  const session = () => [...provider.sessions.values()][0] as unknown as { onRequest(method: string, p: unknown, id: number): Promise<unknown> };
  const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
  const complete = (turn: string) => notify('turn/completed', { threadId: 'th1', turn: { id: turn, status: 'completed', items: [] } });
  const holdStarts = () => {
    let open!: () => void;
    hold = new Promise<void>((r) => (open = r));
    return () => {
      hold = undefined;
      open();
    };
  };
  return { app, rt, session, complete, starts, holdStarts };
}

const fileChange = (turnId: string, itemId: string) => ({ threadId: 'th1', turnId, itemId, reason: 'Write outside the project', grantRoot: null });

describe('a mode that never asks, chosen from a phone mid-turn (1)', () => {
  it('Codex: the running turn keeps asking; from the next message Full access answers at once', async () => {
    const h = await codexChat('auto');
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'publish the scenes' });
    await until(() => h.starts.length === 1 && h.rt.turnActive);
    // The phone's switch (phone.ts sends `answerWaiting: false`).
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'full-access', answerWaiting: false });
    expect(h.rt.meta.mode).toBe('full-access');
    void h.session().onRequest('item/fileChange/requestApproval', fileChange('turn1', 'f1'), 1);
    await until(() => h.rt.prompts().permissions.length === 1);
    h.rt.cancelPrompts();
    h.complete('turn1');
    await until(() => !h.rt.turnActive);
    // The next message carries the policy and lifts the hold.
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'and the next one' });
    await until(() => h.starts.length === 2);
    expect(h.starts[1]).toMatchObject({ approvalPolicy: 'never' });
    expect(await h.session().onRequest('item/fileChange/requestApproval', fileChange('turn2', 'f2'), 2)).toEqual({ decision: 'accept' });
  });

  it('Codex: chosen at the desktop, the running turn is answered at once (as before)', async () => {
    const h = await codexChat('auto');
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'publish the scenes' });
    await until(() => h.rt.turnActive && h.starts.length === 1);
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'full-access' });
    expect(await h.session().onRequest('item/fileChange/requestApproval', fileChange('turn1', 'f1'), 1)).toEqual({ decision: 'accept' });
  });

  it('Codex: a desktop switch after the phone\'s lifts the hold at once', async () => {
    const h = await codexChat('auto');
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'publish the scenes' });
    await until(() => h.rt.turnActive && h.starts.length === 1);
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'full-access', answerWaiting: false });
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'full-access' });
    expect(await h.session().onRequest('item/fileChange/requestApproval', fileChange('turn1', 'f1'), 1)).toEqual({ decision: 'accept' });
  });

  it("Claude Code: Bypass from a phone mid-turn: the CLI keeps its mode and Sable's prompts wait until the next message", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-modes-w7-claude-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd);
    const modes: string[] = [];
    let session!: { canUseTool(name: string, input: Record<string, unknown>, o: Record<string, unknown>): Promise<unknown> };
    const app = new App({
      home,
      quiet: true,
      userHome: path.join(home, 'user'),
      providers: [
        (ctx) => {
          const p = new ClaudeProvider(ctx);
          const any = p as unknown as Record<string, unknown>;
          any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
          any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [{ id: 'default', name: 'Ask', tone: 'ask' }, { id: 'bypassPermissions', name: 'Bypass', tone: 'danger' }], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
          any.limits = async () => [];
          any.readLimits = async () => [];
          const open = p.open.bind(p);
          p.open = async (rt, o) => {
            const s = (await open(rt, o)) as unknown as Record<string, unknown>;
            s.ensure = function (this: Record<string, unknown>) {
              this.q ??= { interrupt: async () => {}, close: () => {}, setPermissionMode: async (m: string) => void modes.push(m) };
              this.input ??= { push: () => {}, end: () => {} };
              return this.q;
            };
            session = s as unknown as typeof session;
            return s as unknown as ProviderSession;
          };
          return p;
        },
      ],
    });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'claude', cwd, mode: 'default', model: 'm', options: { remoteControl: false } });
    const rt = app.runtime(snap.session.id);
    await until(() => !!session);
    (session as unknown as { ensure(): void }).ensure();
    rt.beginTurn('Working');
    await app.call('session.setMode', { sessionId: rt.id, mode: 'bypassPermissions', answerWaiting: false });
    expect(rt.meta.mode).toBe('bypassPermissions');
    expect(modes).toEqual([]);
    void session.canUseTool('Bash', { command: 'rm -rf build/*' }, { signal: new AbortController().signal });
    await until(() => rt.prompts().permissions.length === 1);
    rt.cancelPrompts();
    rt.endTurn();
    await app.call('session.send', { sessionId: rt.id, text: 'go on' });
    await until(() => modes.length === 1);
    expect(modes).toEqual(['bypassPermissions']);
    expect(await session.canUseTool('Bash', { command: 'rm -rf build/*' }, { signal: new AbortController().signal })).toMatchObject({ behavior: 'allow' });
  });
});

describe("a Codex start's answer and a newer mode change (2)", () => {
  it('a switch to Ask while a Full access turn/start is out still reaches the next turn', async () => {
    const h = await codexChat('full-access');
    const release = h.holdStarts();
    const sent = h.app.call('session.send', { sessionId: h.rt.id, text: 'publish the scenes' });
    await until(() => h.starts.length === 1);
    await h.app.call('session.setMode', { sessionId: h.rt.id, mode: 'default' });
    release();
    await sent;
    await until(() => h.rt.turnActive);
    await tick(30);
    h.complete('turn1');
    await until(() => !h.rt.turnActive);
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'and the next one' });
    await until(() => h.starts.length === 2);
    expect(h.starts[1]).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' }) });
  });

  it('without a newer change the next turn sends no policy', async () => {
    const h = await codexChat('full-access');
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'publish the scenes' });
    await until(() => h.starts.length === 1 && h.rt.turnActive);
    await tick(30);
    h.complete('turn1');
    await until(() => !h.rt.turnActive);
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'and the next one' });
    await until(() => h.starts.length === 2);
    expect(h.starts[1].approvalPolicy).toBeUndefined();
  });
});
