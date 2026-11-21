/**
 * The count of background work (`SessionMeta.background`) after review wave 7 (scratch/reviews/out-wave7.md):
 * - 4: after a restart a chat starts at 0, and its old running steps are stopped as it is read, with no
 *   count announced on the way.
 * - 5: a Claude process let go (rewind, account handover, shutdown) takes its background work with it.
 * - 6: a step in a terminal state, or a workflow whose own run ended, never counts (one rule, shared
 *   with the Agents tab); the Demo workflow ends with its launch result done too.
 * - 7: Codex's own sub-agents: a spawn whose receiver still runs counts until a later call or its own
 *   thread says it ended.
 * - 8: Claude's task list says what runs: a task's end that names no step finds it by its task id, and
 *   an empty list stops what still counts.
 * Demo agent, a fake Claude query and a fake Codex app-server only.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, SessionMeta, ToolItem } from '@shared/protocol';
import { worksInBackground } from '@shared/background';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider, receiverStatus } from '../server/providers/codex';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderSession } from '../server/providers/types';
import { isAgentLive } from '../src/features/timeline/agent-line';

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
function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

const agent = (id: string, extra: Partial<ToolItem> = {}) =>
  ({ id, ts: Date.now(), type: 'tool', name: 'Task', kind: 'agent', title: 'Agent', status: 'done', detail: {}, result: { agent: { background: 'running' } }, ...extra }) as ToolItem;
const workflow = (id: string, status: 'running' | 'done', extra: Partial<ToolItem> = {}) =>
  agent(id, { name: 'Workflow', workflow: { status, phases: [], agents: [], phase: 0 }, ...extra } as Partial<ToolItem>);

function chat() {
  const events: BridgeEvent[] = [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: '/w', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, (e) => events.push(e), () => {});
  return { rt, events };
}

// ── 4 ──

describe('a restart (4)', () => {
  it('starts every restored chat at 0, and reads its old running steps as stopped without announcing a count', async () => {
    const home = temp('sable-bg-w7-');
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd);
    const make = () => new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: path.join(home, 'user') });
    const first = make();
    const snap = await first.call('session.create', { provider: 'demo', cwd });
    const rt = first.runtime(snap.session.id);
    rt.add<ToolItem>(agent('a1'));
    rt.add<ToolItem>(workflow('w1', 'running'));
    expect(rt.meta.background).toBe(2);
    // As after a crash: the file and the list still say two run.
    rt.handle = undefined;
    await first.dispose();

    const second = make();
    cleanups.push(() => second.dispose());
    const events: BridgeEvent[] = [];
    second.subscribe((e) => events.push(e));
    const restored = second.sessions.get(snap.session.id)!;
    expect(restored.meta.background ?? 0).toBe(0);
    await second.call('session.snapshot', { sessionId: restored.id });
    expect(restored.meta.background ?? 0).toBe(0);
    expect(restored.get<ToolItem>('a1')?.result?.agent?.background).toBe('stopped');
    expect(restored.get<ToolItem>('w1')?.workflow?.status).toBe('stopped');
    const counts = events.flatMap((e) => (e.type === 'session.updated' && 'background' in e.patch ? [e.patch.background] : []));
    expect(counts.filter((n) => (n ?? 0) > 0)).toEqual([]);
  });

  it('loadRestored marks what it stopped for the next save', () => {
    const { rt, events } = chat();
    rt.loadRestored([agent('a1'), agent('a2', { result: { agent: { background: 'done' } } } as Partial<ToolItem>)]);
    expect(rt.meta.background).toBe(0);
    expect(events).toHaveLength(0);
    const dirty = rt.takeDirty();
    expect(dirty !== 'all' && [...dirty]).toEqual(['a1']);
  });
});

// ── 6 ──

describe('one rule for background work (6)', () => {
  it('a failed, stopped or denied step never counts; a workflow outranks its launch result', () => {
    expect(worksInBackground(agent('a'))).toBe(true);
    expect(worksInBackground(workflow('w', 'running', { status: 'error' }))).toBe(false);
    expect(worksInBackground(workflow('w', 'running', { status: 'denied' }))).toBe(false);
    expect(worksInBackground(agent('a', { status: 'cancelled' }))).toBe(false);
    expect(worksInBackground(workflow('w', 'done'))).toBe(false);
    expect(worksInBackground(workflow('w', 'running'))).toBe(true);
    // The Agents tab says the same.
    for (const it of [agent('a'), workflow('w', 'running', { status: 'error' }), workflow('w', 'done'), workflow('w', 'running')]) expect(isAgentLive(it)).toBe(worksInBackground(it));
  });

  it('the runtime counts by it', () => {
    const { rt } = chat();
    rt.add<ToolItem>(workflow('w1', 'running', { status: 'running' }));
    expect(rt.meta.background).toBe(1);
    rt.patch<ToolItem>('w1', { status: 'error' });
    expect(rt.meta.background).toBe(0);
    rt.add<ToolItem>(workflow('w2', 'running'));
    rt.patch<ToolItem>('w2', { workflow: { status: 'done', phases: [], agents: [], phase: 0 } } as Partial<ToolItem>);
    expect(rt.meta.background).toBe(0);
  });

  it('the Demo workflow ends with nothing counted', async () => {
    const home = temp('sable-bg-w7-demo-');
    const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true, userHome: path.join(home, 'user') });
    cleanups.push(() => app.dispose());
    const snap = await app.call('session.create', { provider: 'demo', cwd: home, mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'run a workflow' });
    await until(() => rt.items.some((i) => i.type === 'tool' && i.workflow?.status === 'done') && !rt.turnActive, 30_000);
    const wf = rt.items.find((i): i is ToolItem => i.type === 'tool' && !!i.workflow)!;
    expect(wf.result?.agent?.background).toBe('done');
    expect(rt.meta.background ?? 0).toBe(0);
  }, 40_000);
});

// ── 5 and 8 ──

async function claudeChat() {
  const home = temp('sable-bg-w7-claude-');
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  let session!: Record<string, unknown> & { onMessage(m: unknown): void };
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    providers: [
      (ctx) => {
        const p = new ClaudeProvider(ctx);
        const any = p as unknown as Record<string, unknown>;
        any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
        any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
        any.limits = async () => [];
        any.readLimits = async () => [];
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Record<string, unknown>;
          s.ensure = function (this: Record<string, unknown>) {
            this.q ??= { interrupt: async () => {}, close: () => {}, setPermissionMode: async () => {} };
            this.input ??= { push: () => {}, end: () => {} };
            return this.q;
          };
          session = s as typeof session;
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
  const system = (m: Record<string, unknown>) => session.onMessage({ type: 'system', session_id: 'x', uuid: `u${Math.random()}`, ...m });
  return { app, rt, session, system };
}

describe('a Claude process let go (5)', () => {
  it('a rewind settles the background agents of the process it closes', async () => {
    const h = await claudeChat();
    h.rt.add({ type: 'user', text: 'first', state: 'sent', id: 'u1', ts: Date.now() } as never);
    h.rt.add<ToolItem>(agent('a1'));
    h.rt.add({ type: 'user', text: 'second', state: 'sent', id: 'u2', ts: Date.now() } as never);
    expect(h.rt.meta.background).toBe(1);
    await h.app.call('session.rewind', { sessionId: h.rt.id, itemId: 'u2' });
    expect(h.rt.get<ToolItem>('a1')?.result?.agent?.background).toBe('stopped');
    expect(h.rt.meta.background).toBe(0);
  });

  it('closing the session (a handover, shutdown) does too', async () => {
    const h = await claudeChat();
    h.rt.add<ToolItem>(agent('a1'));
    await h.rt.handle!.close();
    expect(h.rt.meta.background).toBe(0);
  });
});

describe("Claude's task list (8)", () => {
  it("a task's end that names no step finds it by the task id", async () => {
    const h = await claudeChat();
    h.rt.add<ToolItem>(agent('toolu_1', { result: undefined, status: 'running' }));
    h.system({ subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_1', description: 'x' });
    h.rt.patch<ToolItem>('toolu_1', { status: 'done', result: { agent: { background: 'running' } } });
    expect(h.rt.meta.background).toBe(1);
    h.system({ subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done' });
    expect(h.rt.get<ToolItem>('toolu_1')?.result?.agent?.background).toBe('done');
    expect(h.rt.meta.background).toBe(0);
  });

  it('an empty list stops what still counts; a list without its task stops that one only', async () => {
    const h = await claudeChat();
    h.rt.add<ToolItem>(agent('toolu_1'));
    h.rt.add<ToolItem>(agent('toolu_2'));
    h.rt.add<ToolItem>(agent('toolu_3', { status: 'running', result: undefined }));
    h.system({ subtype: 'task_started', task_id: 't1', tool_use_id: 'toolu_1', description: 'x' });
    h.system({ subtype: 'task_started', task_id: 't2', tool_use_id: 'toolu_2', description: 'y' });
    h.system({ subtype: 'background_tasks_changed', tasks: [{ task_id: 't2', task_type: 'local_agent', description: 'y' }] });
    expect(h.rt.get<ToolItem>('toolu_1')?.result?.agent?.background).toBe('stopped');
    expect(h.rt.meta.background).toBe(1);
    h.system({ subtype: 'background_tasks_changed', tasks: [] });
    expect(h.rt.meta.background).toBe(0);
    // A call that still runs is no background work yet: untouched.
    expect(h.rt.get<ToolItem>('toolu_3')?.status).toBe('running');
  });
});

// ── 7 ──

describe("Codex's own sub-agents (7)", () => {
  async function codexChat() {
    const home = temp('sable-bg-w7-codex-');
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd);
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
    const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'auto', model: 'm' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'split the work' });
    await until(() => provider.sessions.size > 0 && rt.turnActive);
    const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
    const collab = (id: string, tool: string, states: Record<string, string>, receivers = Object.keys(states)) =>
      notify('item/completed', {
        threadId: 'th1',
        turnId: 'turn1',
        item: { type: 'collabAgentToolCall', id, tool, status: 'completed', receiverThreadIds: receivers, prompt: 'look', model: null, agentsStates: Object.fromEntries(Object.entries(states).map(([k, s]) => [k, { status: s, message: null }])) },
      });
    return { app, rt, notify, collab };
  }

  it('a spawn whose receiver still runs counts until a wait reports it completed', async () => {
    const h = await codexChat();
    h.collab('sp1', 'spawnAgent', { sub1: 'running' });
    expect(h.rt.get<ToolItem>('turn1:sp1')?.result?.agent?.background).toBe('running');
    expect(h.rt.meta.background).toBe(1);
    h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn1', status: 'completed', items: [] } });
    await until(() => !h.rt.turnActive);
    // The parent's turn ended: the sub-agent still counts.
    expect(h.rt.meta.background).toBe(1);
    h.collab('w1', 'wait', { sub1: 'completed' });
    expect(h.rt.get<ToolItem>('turn1:sp1')?.result?.agent?.background).toBe('done');
    expect(h.rt.meta.background).toBe(0);
  });

  it("the receiver's own thread ending says so too; two receivers work while either does", async () => {
    const h = await codexChat();
    h.collab('sp1', 'spawnAgent', { sub1: 'running', sub2: 'pendingInit' });
    expect(h.rt.meta.background).toBe(1);
    h.notify('turn/completed', { threadId: 'sub1', turn: { id: 'x', status: 'completed', items: [] } });
    expect(h.rt.meta.background).toBe(1);
    h.notify('turn/completed', { threadId: 'sub2', turn: { id: 'y', status: 'failed', items: [] } });
    expect(h.rt.get<ToolItem>('turn1:sp1')?.result?.agent?.background).toBe('failed');
    expect(h.rt.meta.background).toBe(0);
  });

  it('a spawn whose receiver is done at once never counts; a closed chat stops what still runs', async () => {
    const h = await codexChat();
    h.collab('sp1', 'spawnAgent', { sub1: 'completed' });
    expect(h.rt.get<ToolItem>('turn1:sp1')?.result?.agent?.background).toBeUndefined();
    h.collab('sp2', 'spawnAgent', { sub2: 'running' });
    expect(h.rt.meta.background).toBe(1);
    await h.rt.handle!.close();
    expect(h.rt.meta.background).toBe(0);
    expect(receiverStatus('shutdown')).toBe('stopped');
  });
});
