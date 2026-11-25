/** Sub-agents from the other agent: the child's work nests under the calling step, its answer is the result. */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, ToolItem } from '@shared/protocol';
import { App } from '../server/app';
import { GatedProcess } from '../server/core/auth-gate';
import { runSubAgent, claimStep } from '../server/core/sub-agent';
import { SessionRuntime } from '../server/core/runtime';
import type { Provider, ProviderSession } from '../server/providers/types';
import { AGENT_INPUT_SCHEMA, agentToolDescription, agentOfTool, describeAgentCall, readAgentCall } from '../server/providers/agent-tool';
import { DemoProvider } from '../server/providers/demo';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-sub-'));
  homes.push(home);
  const app = new App({ home, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })], quiet: true });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(e));
  return { app, home, events };
}

describe('sub-agent tool', () => {
  it('bounds Claude Code tree retirement when the owned process never confirms exit', async () => {
    const process = Object.setPrototypeOf(new EventEmitter(), GatedProcess.prototype) as GatedProcess;
    // A physical process stand-in with no PID cannot invoke the system's tree killer.
    const kill = vi.fn();
    Object.assign(process, { ended: false, child: { pid: undefined, exitCode: null, signalCode: null, kill } });
    vi.useFakeTimers();
    try {
      const termination = expect(process.terminateDelegate()).rejects.toThrow(/exit was not confirmed/i);
      await vi.advanceTimersByTimeAsync(4800);
      await termination;
      expect(kill.mock.calls.filter(([signal]) => signal === 'SIGKILL')).toHaveLength(4);
      expect(process.listenerCount('exit')).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['open', 'send', 'root', 'receiver', 'save', 'close'])('ends the delegate wait when %s never answers', async phase => {
    const rt = new SessionRuntime({ id: 'parent', provider: 'codex', cwd: process.cwd(), title: 'test', titleSource: 'user',
      model: 'm', mode: 'default', status: 'idle', createdAt: 1, updatedAt: 1, usage: { turns: 0, inputTokens: 0, outputTokens: 0 } }, () => {}, () => {});
    const never = new Promise<void>(() => {});
    let finishOpen!: () => void;
    let child!: SessionRuntime;
    const hard = vi.fn(async () => {});
    const handle = { send: async () => {
      child.beginTurn();
      if (phase === 'send') return never;
      if (phase !== 'root') child.endTurn();
    }, waitForReceivers: () => phase === 'receiver' ? never : undefined,
      close: () => phase === 'close' ? never : Promise.resolve(), terminateDelegate: hard } as unknown as ProviderSession;
    const provider = { open: async (r: SessionRuntime) => {
      child = r;
      if (phase === 'open') await new Promise<void>(resolve => { finishOpen = resolve; });
      return handle;
    } } as unknown as Provider;
    if (phase === 'save') rt.persistDelegate = () => never;
    vi.useFakeTimers();
    try {
      let result: { ok: boolean; text: string } | undefined;
      void runSubAgent({ provider: () => provider, accountFor: () => undefined, defaultModel: () => 'm', modeFor: () => 'default', log() {} },
        rt, { agent: 'codex', prompt: 'test', description: 'deadline' }, 'step').then(r => { result = r; });
      const bound = { open: 90_000, send: 90_000, root: 86_400_000, receiver: 600_000, save: 5000, close: 6000 }[phase]!;
      await vi.advanceTimersByTimeAsync(bound + 10);
      expect(result).toBeDefined();
      expect(rt.get<ToolItem>('step')?.status).not.toBe('running');
      expect(rt.delegates.size).toBe(0);
      if (phase === 'save') expect(rt.items.some(i => i.type === 'notice' && i.text.includes('Could not save'))).toBe(true);
      if (phase === 'open') finishOpen();
      await vi.advanceTimersByTimeAsync(1510);
      if (phase === 'open' || phase === 'close') expect(hard).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('names its agent and reads its call', () => {
    expect(agentOfTool('delegate_to_codex')).toBe('codex');
    expect(agentOfTool('mcp__sable__delegate_to_codex')).toBe('codex');
    expect(agentOfTool('delegate_to_claude')).toBe('claude');
    expect(agentOfTool('show_widget')).toBeUndefined();
    for (const agent of ['claude', 'codex'] as const) {
      expect(AGENT_INPUT_SCHEMA.properties.background.type).toBe('boolean');
      expect(agentToolDescription(agent)).toContain('background: true');
      expect(readAgentCall(agent, { prompt: 'review', background: true })?.background).toBe(true);
      expect(readAgentCall(agent, { prompt: 'review', background: 'false' })?.background).toBeUndefined();
    }
    expect(readAgentCall('codex', { prompt: '  ' })).toBeNull();
    expect(readAgentCall('codex', { prompt: 'Review src/app.ts', description: 'Review the app' })).toEqual({ agent: 'codex', description: 'Review the app', prompt: 'Review src/app.ts' });
    expect(describeAgentCall('codex', { description: 'Review the app', prompt: 'x' })).toMatchObject({ kind: 'agent', title: 'Review the app', detail: { subagent: 'Codex' } });
  });

  it('runs the other agent nested under the calling step and returns its answer', async () => {
    const { app, home } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const parent = app.runtime(snap.session.id);
    const step = parent.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', title: 'Say hi', status: 'running', detail: {} });
    const claimed = new Set<string>();
    expect(claimStep(parent, (it) => it.name === 'delegate_to_codex', claimed)).toBe(step.id);
    expect(claimStep(parent, (it) => it.name === 'delegate_to_codex', claimed)).toBeUndefined();

    const r = await runSubAgent(
      { provider: (id, acc) => app.provider(id, acc), accountFor: () => undefined, defaultModel: () => undefined, modeFor: () => 'bypassPermissions', log: () => {} },
      parent,
      { agent: 'demo', description: 'Say hi', prompt: 'hi' },
      step.id,
    );
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/relay-api/);
    const nested = parent.items.filter((i) => i.parentId === step.id);
    expect(nested.some((i) => i.type === 'text')).toBe(true);
    // The task is the step's prompt: no message of its own, and nothing outside the step.
    expect(parent.items.filter((i) => i.type === 'user')).toHaveLength(0);
    expect(nested.every((i) => i.id.startsWith('sub-'))).toBe(true);
  });

  it('keeps a Demo child waiting for permission after its foreground call is released', async () => {
    const { app, home } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const rt = app.runtime(snap.session.id);
    const step = rt.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', title: 'Refactor', status: 'running', detail: {} });
    const running = runSubAgent({ provider: id => app.provider(id), accountFor: () => undefined, defaultModel: () => undefined, modeFor: () => 'default', log() {} },
      rt, { agent: 'demo', description: 'Refactor', prompt: 'refactor the session module' }, step.id);
    for (let i = 0; i < 200 && !rt.prompts().permissions.length; i++) await new Promise(r => setTimeout(r, 10));
    const ask = rt.prompts().permissions[0];
    expect(ask.sessionId).toBe(rt.id);
    rt.releaseDelegates();
    expect((await running).text).toContain('Answer the person now');
    rt.endTurn();
    expect(rt.prompts().permissions).toEqual([ask]);
    expect(rt.meta.background).toBe(1);
    await app.call('session.interrupt', { sessionId: rt.id });
    for (let i = 0; i < 100 && rt.delegates.size; i++) await new Promise(r => setTimeout(r, 5));
    expect(rt.delegates.size).toBe(0);
    expect(rt.pendingDelegateReports.size).toBe(0);
    expect(step.delegateReport).toBe('stopped');
  });

  it('asks its permission questions in the parent session, on the calling step', async () => {
    const { app, home, events } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const parent = app.runtime(snap.session.id);
    const step = parent.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', title: 'Refactor', status: 'running', detail: {} });
    const running = runSubAgent(
      { provider: (id, acc) => app.provider(id, acc), accountFor: () => undefined, defaultModel: () => undefined, modeFor: () => 'default', log: () => {} },
      parent,
      { agent: 'demo', description: 'Refactor', prompt: 'refactor the session module' },
      step.id,
    );
    const asked = () => events.find((e): e is Extract<BridgeEvent, { type: 'permission.added' }> => e.type === 'permission.added');
    for (let i = 0; i < 200 && !asked(); i++) await new Promise((r) => setTimeout(r, 20));
    const req = asked();
    expect(req?.request.sessionId).toBe(parent.id);
    // Stopping the parent's prompts ends the child's wait; it winds down.
    parent.cancelPrompts();
    await Promise.race([running, new Promise((r) => setTimeout(r, 3000))]);
  });
});
