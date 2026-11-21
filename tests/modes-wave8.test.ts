/**
 * Review wave 8, finding 5: a phone's switch to a mode that never asks, made while work runs, must
 * not change what that work may do. `meta.mode` is the mode chosen (it goes with the next message);
 * `SessionRuntime.workMode` is the one the work runs under, and every boundary reads it: OpenCode's
 * own answers to permission prompts (and only ever a one-time grant), a Codex thread reloaded
 * mid-turn, a sub-agent the running turn starts. Fakes only (no agent process).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { runSubAgent } from '../server/core/sub-agent';
import { CodexProvider } from '../server/providers/codex';
import { OpenCodeProvider } from '../server/providers/opencode';

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

function tempDir(prefix: string) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return d;
}

const CODEX_MODES = [
  { id: 'default', name: 'Ask', tone: 'ask' },
  { id: 'auto', name: 'Auto', tone: 'edit' },
  { id: 'full-access', name: 'Full access', tone: 'danger' },
];

describe('the mode work in progress runs under', () => {
  it('Codex: a phone picks Full access mid-turn; a thread reloaded during that turn keeps the sandbox it had', async () => {
    const home = tempDir('sable-modes-w8-');
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd);
    const threads: Record<string, unknown>[] = [];
    const rpc = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          threads.push({ method, ...params });
          return { thread: { id: 'th1', model: 'm' }, model: 'm' };
        }
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
          anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: CODEX_MODES, commands: [], skills: [], agents: [], mcpServers: [], tools: [], skillTrigger: '$', features: { steer: true, compact: true } });
          provider ??= p;
          return p;
        },
      ],
    });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'auto', model: 'm' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'publish the scenes' });
    await until(() => rt.turnActive);
    await app.call('session.setMode', { sessionId: rt.id, mode: 'full-access', answerWaiting: false });
    expect(rt.meta.mode).toBe('full-access');
    expect(rt.workMode).toBe('auto');
    // The thread is loaded again while the turn runs (an app-server restart, an option change).
    const session = [...provider.sessions.values()][0] as unknown as { resumeOrStart(id: string): Promise<unknown> };
    await session.resumeOrStart('th1');
    expect(threads.at(-1)).toMatchObject({ method: 'thread/resume', sandbox: 'workspace-write' });
    expect(threads.at(-1)?.approvalPolicy).not.toBe('never');
    // A second held switch keeps the mode the work began with.
    await app.call('session.setMode', { sessionId: rt.id, mode: 'full-access', answerWaiting: false });
    expect(rt.workMode).toBe('auto');
    // At the desktop the switch is the person's at once.
    await app.call('session.setMode', { sessionId: rt.id, mode: 'full-access' });
    expect(rt.workMode).toBe('full-access');
  });

  it('a sub-agent the running turn starts gets the mode the work has, not the held one', async () => {
    const now = Date.now();
    const meta: SessionMeta = { id: 'p1', provider: 'claude', cwd: tmpdir(), title: 'x', titleSource: 'user', model: '', mode: 'full-access', status: 'running', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
    const parent = new SessionRuntime(meta, () => {}, () => {});
    // What session.setMode leaves behind for a phone's switch mid-turn.
    parent.heldMode = 'default';
    parent.dangerHeld = true;
    let given = '';
    await runSubAgent(
      {
        provider: () => ({ open: async () => Promise.reject(new Error('no process in tests')) }) as never,
        accountFor: () => undefined,
        defaultModel: () => undefined,
        modeFor: (_id, m) => (given = m),
        log: () => {},
      },
      parent,
      { agent: 'codex', prompt: 'look', description: 'Look' } as never,
      undefined,
    );
    expect(given).toBe('default');
  });
});

describe('OpenCode answers a prompt itself only under the mode its work runs under', () => {
  async function chat() {
    const cwd = tempDir('sable-oc-w8-');
    const now = Date.now();
    const meta: SessionMeta = { id: 's1', provider: 'opencode', cwd, title: 'New session', titleSource: 'auto', model: '', mode: 'build', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
    const rt = new SessionRuntime(meta, () => {}, () => {});
    const acp = {
      alive: true,
      init: { agentCapabilities: {} },
      request: (method: string) => new Promise((resolve) => (method === 'session/new' ? resolve({ sessionId: 'oc-1', configOptions: [] }) : method === 'session/set_config_option' ? resolve({}) : undefined)),
      notify: () => {},
      close: async () => {},
    };
    const provider = new OpenCodeProvider({ emit: () => {}, log: () => {} });
    (provider as unknown as { client: () => Promise<unknown> }).client = async () => acp;
    (provider as unknown as { servers: () => Promise<unknown[]> }).servers = async () => [];
    const session = (await provider.open(rt, {})) as unknown as { send(i: UserItem): Promise<void>; onPermission(p: unknown): Promise<unknown> };
    return { rt, session };
  }
  // OpenCode lists "always" first here: an automatic answer must still be the one-time grant.
  const ask = { toolCall: { toolCallId: 't1', kind: 'execute', title: 'rm -rf build', rawInput: { command: 'rm -rf build' } }, options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }, { optionId: 'once', kind: 'allow_once', name: 'Once' }, { optionId: 'no', kind: 'reject_once', name: 'No' }] };

  it("a phone's Allow all mid-turn: the turn's prompts still wait", async () => {
    const { rt, session } = await chat();
    await session.send(rt.add<UserItem>({ type: 'user', text: 'clean up', state: 'sent' }));
    // session.setMode from a phone while the turn runs (server/app.ts).
    rt.heldMode = rt.meta.mode;
    rt.dangerHeld = true;
    rt.update({ mode: 'allow-all' });
    const answer = session.onPermission(ask);
    await until(() => rt.prompts().permissions.length === 1);
    rt.cancelPrompts();
    expect(await answer).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('Allow all in effect answers at once with "once", never "always"', async () => {
    const { rt, session } = await chat();
    rt.update({ mode: 'allow-all' });
    expect(await session.onPermission(ask)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    // Only an "always" on offer: that is the person's to give, so it asks.
    const onlyAlways = { ...ask, options: [ask.options[0], ask.options[2]] };
    const answer = session.onPermission(onlyAlways);
    await until(() => rt.prompts().permissions.length === 1);
    rt.cancelPrompts();
    await answer;
  });
});
