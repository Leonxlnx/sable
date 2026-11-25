/**
 * Codex turns guarded against news that comes late or out of order (review wave 2): a Stop while the
 * thread reloads sends nothing (#12), an idle probe gives way to a newer status and a stale answer is
 * asked again within bounds (#13), and an error belongs to the turn it names (#14). A fake app-server
 * only: no real agent turns.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resultDigest } from '../server/core/delegate-result';
import { runSubAgent } from '../server/core/sub-agent';
import { SessionRuntime } from '../server/core/runtime';
import type { Provider } from '../server/providers/types';
import type { TextItem, ToolItem } from '../shared/protocol';
import { delegateReport, parseSynthetic } from '../shared/synthetic';
import { App } from '../server/app';
import { REPLY_FIRST_PROMPT } from '../shared/protocol';
import { CodexRpc } from '../server/providers/codex-rpc';
import { CodexProvider } from '../server/providers/codex';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
/** A gate a fake answer waits on. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { wait: () => shut, open };
}

type Answer = {
  steer?: (written?: () => void) => Promise<unknown>;
  interrupt?: () => void;
  unsubscribe?: () => void;
  threadRead?: () => unknown;
  /** turn/start's answer for the n-th start (may wait). */
  turnStart?: (n: number) => Promise<unknown> | unknown;
  /** thread/turns/list's answer for the n-th probe (may wait or fail). */
  turnsList?: (n: number) => Promise<unknown> | unknown;
  /** thread/resume's answer (an app-server that restarted reloads the thread). */
  resume?: () => Promise<unknown> | unknown;
};

/** A Codex chat in the bridge on a fake app-server whose answers a test chooses. */
async function codexFake(answer: Answer = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-codexguards-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let starts = 0;
  let probes = 0;
  const rpc = {
    request: async (method: string, params: Record<string, unknown>, _timeout?: number, written?: () => void) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'thread/resume') return answer.resume ? answer.resume() : { thread: { id: 'th1', model: 'm' }, model: 'm' };
      if (method === 'turn/start') {
        const n = ++starts;
        return answer.turnStart ? answer.turnStart(n) : { turn: { id: `turn${n}` } };
      }
      if (method === 'turn/steer' && answer.steer) return answer.steer(written);
      if (method === 'thread/read' && answer.threadRead) return answer.threadRead();
      if (method === 'thread/turns/list') return answer.turnsList ? answer.turnsList(++probes) : {};
      if (method === 'turn/interrupt') answer.interrupt?.();
      if (method === 'thread/unsubscribe') answer.unsubscribe?.();
      if (method === 'account/read') return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
      return {};
    },
  };
  let provider!: CodexProvider;
  const app = new App({
    home,
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
    quiet: true,
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'codex', cwd, mode: 'default', model: 'm' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  const notify = (method: string, p: unknown) => (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification(method, p);
  const status = (type: 'idle' | 'active') => notify('thread/status/changed', { threadId: 'th1', status: type === 'active' ? { type, activeFlags: [] } : { type } });
  const complete = (turn: string, s = 'completed') => notify('turn/completed', { threadId: 'th1', turn: { id: turn, status: s, items: [] } });
  const count = (method: string) => calls.filter((c) => c.method === method).length;
  /** The app-server exits: the next turn reloads the thread first (thread/resume). */
  const serverDied = () => (provider as unknown as { onExit(rpc: unknown, info: unknown): void }).onExit(rpc, { code: 1, signal: null, stderr: '' });
  /** The chat's Codex session (to make its rechecks quick). */
  const session = () => provider.sessions.get('th1') as unknown as Record<string, unknown>;
  return { app, id, rt, provider, calls, notify, status, complete, count, serverDied, session, send: (text: string) => app.call('session.send', { sessionId: id, text }), stop: () => app.call('session.interrupt', { sessionId: id }) };
}

it('holds a Codex card through turn/start and checks every queued sender after resume', async () => {
  const g = gate();
  const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1' } })) });
  await h.send('first');
  const session = h.session();
  session.loaded = false;
  let paired = true;
  h.app.phoneStillPaired = () => paired;
  await h.app.call('session.send', { sessionId: h.id, text: 'queued phone', submitId: 'phone-c', steer: true },
    { allowed: () => true, phoneSender: { deviceId: 'd', generation: 1 } });
  h.complete('turn1');
  await until(() => !!h.count('thread/resume'), 'queued thread resume');
  const card = h.rt.get('phone-c');
  paired = false;
  g.open();
  await tick(50);
  expect(h.count('turn/start')).toBe(1);
  expect(card).toMatchObject({ state: 'queued' });
});

it.each([true, false])('keeps ownership of a written steer across turn completion (acknowledged %s)', async accepted => {
  const g = gate();
  const h = await codexFake({ steer: async written => {
    written?.();
    await g.wait();
    if (!accepted) throw new Error('reply lost');
    return {};
  } });
  await h.send('first');
  const send = h.app.call('session.send', { sessionId: h.id, text: 'once only', steer: true });
  await until(() => h.count('turn/steer') === 1, 'steer');
  h.complete('turn1');
  await tick();
  g.open();
  await send;
  await tick();
  expect(h.count('turn/start')).toBe(1);
  if (accepted) expect(h.rt.items.find(i => i.type === 'user' && i.text === 'once only')).toMatchObject({ state: 'sent' });
  else expect(h.rt.queue.find(q => q.text === 'once only')).toMatchObject({ byHand: true, steerWait: { reason: expect.stringContaining('receipt') } });
});


it('distinguishes quoted reports and an internal until steer on the native wire', async () => {
  const { transcript } = await import('../server/providers/codex-map');
  const { userItemText } = await import('../shared/synthetic');
  const { failureMessage } = await import('../server/core/until');
  const h = await codexFake();
  await h.send('first');
  const quote = 'I copied this:\n\n' + delegateReport('Review', 'done', 'exactly this');
  await h.app.call('session.send', { sessionId: h.id, text: quote, steer: true });
  const check = { command: 'echo `date`', round: 1, rounds: 3, output: '', exitCode: 1 } as Parameters<typeof failureMessage>[0];
  const failure = failureMessage(check);
  const deliver = h.app as unknown as { deliver(rt: SessionRuntime, text: string, files: undefined, extra: object): Promise<unknown> };
  await deliver.deliver(h.rt, failure, undefined, { until: { check } });
  const content = h.calls.filter(c => c.method === 'turn/steer').map(c => c.params.input);
  const imported = content.map((input, i) => transcript([{ id: 't', items: [{ id: String(i), type: 'userMessage', content: input }] }] as never)[0]);
  expect(imported.map(userItemText)).toEqual([quote, '']);
  expect(userItemText({ type: 'user', text: failure })).toBe('');
});

it('sends a native steer while a foreground command is still running', async () => {
  const h = await codexFake();
  await h.send('run the tests');
  expect(h.calls.find(c => c.method === 'thread/start')?.params.developerInstructions).toEqual(expect.stringContaining(REPLY_FIRST_PROMPT));
  h.notify('item/started', { threadId: 'th1', turnId: 'turn1', item: { id: 'long', type: 'commandExecution', command: 'test', cwd: h.rt.meta.cwd, status: 'inProgress' } });
  const command = h.rt.items.find(i => i.type === 'tool' && i.kind === 'bash');
  expect(command).toMatchObject({ status: 'running' });
  await h.app.call('session.send', { sessionId: h.id, text: 'answer please', steer: true });
  expect(h.calls.filter(c => c.method === 'turn/steer')).toMatchObject([{ params: { expectedTurnId: 'turn1' } }]);
  expect(h.rt.items.find(i => i.type === 'user' && i.text === 'answer please')).toMatchObject({ state: 'sent' });
  expect(command).toMatchObject({ status: 'running' });
  expect(h.count('turn/interrupt')).toBe(0);
  h.complete('turn1');
});

it.each([
  ['codex', 'running'], ['claude', 'running'], ['codex', 'idle'], ['claude', 'idle'],
] as const)('releases a native delegate_to_%s and receives one report while %s', async (agent, phase) => {
  const h = await codexFake();
  await h.send('review');
  let child!: SessionRuntime;
  const fake = { open: async (rt: SessionRuntime) => {
    child = rt;
    return { send: async () => rt.beginTurn(), interrupt: async () => rt.endTurn(), close: async () => {} };
  } } as unknown as Provider;
  const real = h.app.provider.bind(h.app);
  h.app.provider = (p, a) => p === agent && !child ? fake : real(p, a);
  const tool = 'delegate_to_' + agent;
  const args = { description: 'Check this', prompt: 'Read this' };
  const n = { threadId: 'th1', turnId: 'turn1', item: { id: 'call1', type: 'dynamicToolCall', tool, arguments: args, status: 'inProgress' } };
  h.notify('item/started', n);
  const s = h.session() as unknown as { onRequest(m: string, p: unknown, id: number): Promise<unknown> };
  const result = s.onRequest('item/tool/call', { turnId: 'turn1', callId: 'call1', tool, arguments: args }, 2);
  await h.app.call('session.send', { sessionId: h.id, text: 'answer please', steer: true });
  expect(await result).toEqual({ success: true, contentItems: [{ type: 'inputText', text: 'The person sent a message, so this call returns early. The sub-agent keeps working in the background. Its report will be delivered to you when it finishes. Answer the person now, then carry on. Do not start the same task again.' }] });
  h.notify('item/completed', { ...n, item: { ...n.item, status: 'completed' } });
  if (phase === 'idle') h.complete('turn1');
  expect(h.rt.meta.background).toBe(1);
  child.add<TextItem>({ type: 'text', text: 'Checked the files', streaming: false });
  child.endTurn();
  const method = phase === 'idle' ? 'turn/start' : 'turn/steer';
  await until(() => h.count(method) === 2, 'child report');
  const report = h.calls.filter(c => c.method === method)[1].params.input as { text: string }[];
  expect(report).toHaveLength(1);
  expect(parseSynthetic(report[0].text)?.role).toBe('hidden');
  expect(h.rt.get<ToolItem>('turn1:call1')).toMatchObject({ status: 'done', result: { text: 'Checked the files' }, delegateReport: 'delivered' });
  expect(h.rt.items.find(i => i.type === 'text' && i.text === 'Checked the files')?.parentId).toBe('turn1:call1');
  expect(h.rt.meta.background ?? 0).toBe(0);
  h.complete(phase === 'idle' ? 'turn2' : 'turn1');
  await tick();
  expect(h.count('turn/start')).toBe(phase === 'idle' ? 2 : 1);
  expect(h.count('turn/steer')).toBe(phase === 'idle' ? 1 : 2);
});

it.each([false, true])('Stop interrupts the exact child Codex turn and closes its thread after confirmation (detached %s)', async detached => {
  const parent = await codexFake();
  let attempts = 0;
  const codex = await codexFake({
    interrupt: () => { if (++attempts === 1 && detached) throw Error('temporary RPC failure'); },
    turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }),
  });
  const step = parent.rt.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', title: 'Check', status: 'running', detail: {} });
  const result = runSubAgent({ provider: () => codex.provider, accountFor: () => undefined, defaultModel: () => 'm', modeFor: () => 'default', log: () => {} },
    parent.rt, { agent: 'codex', description: 'Check', prompt: 'inspect', background: detached }, step.id);
  await until(() => codex.count('turn/start') === 1, 'child turn start');
  await parent.stop();
  await until(() => codex.count('turn/interrupt') === (detached ? 2 : 1), 'confirmed child interrupt request');
  expect(codex.calls.find(c => c.method === 'turn/interrupt')?.params).toEqual({ threadId: 'th1', turnId: 'turn1' });
  expect(codex.count('thread/unsubscribe')).toBe(0);
  codex.complete('turn1', 'interrupted');
  await until(() => !parent.rt.delegates.size, 'child thread close');
  expect(codex.count('thread/unsubscribe')).toBe(1);
  expect((await result).ok).toBe(detached);
  expect(parent.rt.pendingDelegateReports.size).toBe(0);
});

it.each(['completed', 'idle', 'trailing item', 'unrelated stored turn', 'unidentified follow-up'])('keeps a delegated Codex root until its receiver ends and retries unsubscribe (%s)', async end => {
  const parent = await codexFake();
  let failed = false;
  const codex = await codexFake({ turnsList: () => ({ data: [{ id: 'subturn', status: 'completed' }] }), unsubscribe: () => { if (!failed) { failed = true; throw Error('temporary'); } } });
  const step = parent.rt.add<ToolItem>({ type: 'tool', name: 'delegate_to_codex', kind: 'agent', title: 'Review', status: 'running', detail: {} });
  const result = runSubAgent({ provider: () => codex.provider, accountFor: () => undefined, defaultModel: () => 'm', modeFor: () => 'default', log() {} },
    parent.rt, { agent: 'codex', description: 'Review', prompt: 'inspect', background: true }, step.id);
  await result;
  await until(() => codex.count('turn/start') === 1, 'child start');
  codex.notify('item/completed', { threadId: 'th1', turnId: 'turn1', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
    receiverThreadIds: ['receiver'], agentsStates: { receiver: { status: 'running' } } } });
  const unlinked = end === 'unrelated stored turn' || end === 'unidentified follow-up';
  if (end !== 'unrelated stored turn') codex.notify('turn/started', { threadId: 'receiver', turn: { id: 'subturn' } });
  codex.session().receiverWaitMs = unlinked ? 1800 : 60_000;
  codex.notify('item/completed', { threadId: 'th1', turnId: 'turn1', item: { type: 'agentMessage', id: 'words', text: 'Root findings' } });
  codex.complete('turn1');
  await tick();
  expect(parent.rt.delegates.has(step.id)).toBe(true);
  expect(step.delegateReport).toBe('working');
  if (end !== 'completed') {
    await parent.rt.persistDelegate!();
    const disk = parent.app.store.loadSession(parent.id).items;
    expect(disk.find(i => i.id === step.id)).toMatchObject({ delegateReceiversPending: true });
    const restored = new SessionRuntime({ ...parent.rt.meta }, () => {}, () => {});
    restored.loadRestored(disk);
    expect(restored.get<ToolItem>(step.id)?.result?.text).toContain('Sable restarted');
    // A pre-field save still has the running receiver on its spawn row.
    const older = structuredClone(parent.rt.items);
    delete (older.find(i => i.id === step.id) as ToolItem).delegateReceiversPending;
    restored.loadRestored(older);
    expect(restored.get<ToolItem>(step.id)?.result?.text).toContain('Sable restarted');
    codex.notify('thread/status/changed', { threadId: 'receiver', status: { type: 'idle' } });
    if (end === 'trailing item') codex.notify('item/completed', { threadId: 'receiver', turnId: 'subturn', item: { id: 'tail' } });
    if (end === 'unidentified follow-up') {
      codex.notify('thread/status/changed', { threadId: 'receiver', status: { type: 'active' } });
      codex.notify('thread/status/changed', { threadId: 'receiver', status: { type: 'idle' } });
    }
  } else codex.notify('turn/completed', { threadId: 'receiver', turn: { id: 'subturn', status: 'completed' } });
  await until(() => !parent.rt.delegates.size, 'receiver finish');
  expect(step.result?.text).toContain('Root findings');
  if (unlinked) {
    expect(step.result?.text).toContain('receiver completion was not confirmed');
    expect(step.status).toBe('error');
  } else expect(step.status).toBe('done');
  expect(codex.calls.filter(c => c.method === 'thread/unsubscribe').map(c => c.params.threadId)).toContain('th1');
  expect(codex.count('thread/unsubscribe')).toBeGreaterThanOrEqual(2);
});

it('keeps an idle quit interrupt open for the definitive Codex completion', async () => {
  const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress' }] }) });
  await h.send('review');
  Object.assign(h.rt, { awaitingQuitResult: true });
  await h.rt.handle!.interrupt();
  h.status('idle');
  await tick(1700);
  expect(h.rt.turnActive).toBe(true);
  h.notify('turn/completed', { threadId: 'th1', turn: { id: 'turn1', status: 'completed', items: [
    { id: 'final', type: 'agentMessage', text: 'Definitive review' },
  ] } });
  expect(h.rt.items.findLast(i => i.type === 'turn')).toMatchObject({ stopReason: 'completed' });
  expect(h.rt.get<TextItem>('turn1:final')?.text).toBe('Definitive review');
});

it('checks the recorded Codex dynamic result instead of trusting the call ID or status', async () => {
  const h = await codexFake({ threadRead: () => ({ thread: { turns: [{ id: 'turn', status: 'completed', items: [
    { id: 'wrong', type: 'dynamicToolCall', status: 'failed', contentItems: [{ type: 'inputText', text: 'Interrupted' }] },
    { id: 'good', type: 'dynamicToolCall', status: 'completed', contentItems: [{ type: 'inputText', text: 'answer' }] },
    { id: 'other', type: 'dynamicToolCall', status: 'completed', contentItems: [{ type: 'inputText', text: 'answer' }] },
  ] }] } }) });
  const wanted = { digest: resultDigest('answer') };
  const receipts = await h.provider.delegateReceipts('th1', '', undefined, { ids: new Set(), tools: new Map([['turn:good', wanted], ['turn:wrong', wanted]]) });
  expect([...receipts.ids]).toEqual(['tool:turn:good']);
});

it('reconciles a Codex report by ID and waits for a personal retry decision for an absent one', async () => {
  const id = 'fea5b259-ff81-4da5-9670-bf4f16ae95ce';
  const words = delegateReport('Review', 'done', 'Findings', id);
  let active = true;
  const h = await codexFake({ threadRead: () => ({ thread: { turns: [{ id: 'old', status: active ? 'inProgress' : 'completed',
    items: [{ type: 'userMessage', content: [{ type: 'text', text: words }] }] }] } }) });
  h.rt.loadRestored([id, 'dfed6fdd-3fba-4c20-b5d6-25145a92a43f'].map((delivery, n) => ({
    type: 'tool', ts: n, id: 'call' + n, title: 'Review', name: 'delegate_to_claude', kind: 'agent', detail: {}, status: 'done',
    delegateReport: 'pending', delegateDeliveryId: delivery, delegateAttempt: { provider: 'codex', session: 'th1' }, result: { text: 'Findings' },
  })));
  h.rt.onDelegateReport!();
  await until(() => h.rt.get<ToolItem>('call0')?.delegateReport === 'delivered', 'recorded report');
  expect(h.rt.get<ToolItem>('call1')?.delegateReport).toBe('pending');
  expect(h.count('turn/start')).toBe(0);
  active = false;
  expect(h.rt.get<ToolItem>('call1')?.delegateReceiptState).toBe('unknown');
  await h.app.call('session.send', { sessionId: h.id, text: '/report-retry ' + h.rt.get<ToolItem>('call1')!.delegateRetryId });
  await until(() => h.count('turn/start') > 0, 'requested resend');
  const input = h.calls.find(c => c.method === 'turn/start')?.params.input as { text: string }[];
  expect(input[0].text).toContain('dfed6fdd-3fba-4c20-b5d6-25145a92a43f');
  expect(input[0].text).not.toContain(id);
  h.complete('turn1');
});

it('releases a report as unissued when an active Codex turn has no id', async () => {
  const h = await codexFake({ turnStart: () => ({}) });
  await h.send('begin');
  const release = vi.fn();
  await h.rt.handle!.send({ type: 'user', id: 'report', ts: Date.now(), text: 'report', state: 'sent' },
    { delegateReport: true, taken: vi.fn(), release });
  expect(h.count('turn/steer')).toBe(0);
  expect(release).toHaveBeenCalledWith(true);
});

it.each(['immediate', 'retry', 'force', 'second force'])('hard-closes the dedicated app-server after unconfirmed interrupts without closing its account peer (exit delayed %s)', async delayed => {
  const h = await codexFake();
  const confirmExit = gate();
  const rpc = {
    alive: true, ended: new Promise<void>(() => {}), close: vi.fn(async () => {
      if (delayed.includes('force') || delayed === 'retry' && rpc.close.mock.calls.length === 1) return new Promise<void>(() => {});
      rpc.alive = false;
    }),
    forceDelegate: vi.fn(async () => {
      if (delayed === 'second force') {
        if (rpc.forceDelegate.mock.calls.length === 1) return;
        await confirmExit.wait();
      }
      rpc.alive = false;
    }),
    request: vi.fn(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'only-child' }, model: 'm' };
      if (method === 'turn/start') return { turn: { id: 'only-turn' } };
      if (method === 'thread/turns/list') return { data: [{ id: 'only-turn', status: 'inProgress' }] };
      return {};
    }),
  };
  const start = vi.spyOn(CodexRpc, 'start').mockResolvedValue(rpc as unknown as CodexRpc);
  const scoped = h.provider.forDelegate.bind(h.provider);
  vi.spyOn(h.provider, 'forDelegate').mockImplementation(() => {
    const p = scoped();
    p.caps = h.provider.caps;
    return p;
  });
  try {
    await h.provider.ctx.runAgent!(h.rt, { agent: 'codex', description: 'Hard close', prompt: 'inspect', background: true }, undefined);
    await until(() => rpc.request.mock.calls.some(([method]) => method === 'turn/start'), 'isolated child started');
    await h.app.call('session.close', { sessionId: h.id, remove: true });
    expect(h.app.sessions.has(h.id)).toBe(false);
    expect(rpc.alive).toBe(true);
    if (delayed === 'second force') {
      await tick(8600);
      expect((h.app as unknown as { retiredDelegates: Set<unknown> }).retiredDelegates.size).toBe(1);
      confirmExit.open();
    }
    await until(() => !rpc.alive, 'deleted process retired', 9000);
    await until(() => !(h.app as unknown as { retiredDelegates: Set<unknown> }).retiredDelegates.size, 'confirmed process released');
    expect(rpc.forceDelegate).toHaveBeenCalledTimes(delayed === 'second force' ? 2 : delayed === 'force' ? 1 : 0);
    expect(rpc.close).toHaveBeenCalledWith(0, 'timeout');
    expect(rpc.request.mock.calls.filter(([method]) => method === 'turn/interrupt').length).toBeGreaterThan(1);
    expect(rpc.close.mock.calls.length).toBeGreaterThanOrEqual(delayed === 'immediate' ? 1 : 2);
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.count('turn/interrupt')).toBe(0);
  } finally { vi.restoreAllMocks(); }
}, 20_000);

const lastTurn = (rt: SessionRuntime) => rt.items.findLast((i) => i.type === 'turn') as { stopReason?: string; error?: string } | undefined;

describe('#12: a Stop while the thread reloads sends nothing', () => {
  it('a message stopped while its thread is resumed after an app-server restart never reaches turn/start', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    expect(h.count('turn/start')).toBe(1);
    h.serverDied();
    void h.send('second').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.stop();
    await tick();
    expect(h.rt.turnActive).toBe(false);
    g.open();
    await tick(50);
    expect(h.count('turn/start')).toBe(1);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a command stopped while its thread is resumed never starts (the command path)', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('/compact').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    await h.stop();
    await tick();
    g.open();
    await tick(50);
    expect(h.count('thread/compact/start')).toBe(0);
    expect(h.rt.turnActive).toBe(false);
  });

  it('a message not stopped goes out once the thread is back', async () => {
    const g = gate();
    const h = await codexFake({ resume: () => g.wait().then(() => ({ thread: { id: 'th1', model: 'm' }, model: 'm' })) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    h.serverDied();
    void h.send('second').catch(() => {});
    await until(() => h.count('thread/resume') === 1, 'thread/resume');
    g.open();
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    expect(h.rt.turnActive).toBe(true);
  });
});

describe('#13: an idle probe gives way to newer news, and a stale answer is asked again within bounds', () => {
  for (const [what, answer] of [
    ['finds no record', () => ({})],
    ['fails', () => Promise.reject(new Error('thread/turns/list failed'))],
  ] as const) {
    it(`the thread goes active again while the probe is out and the probe ${what}: the live turn stays open`, async () => {
      const g = gate();
      const h = await codexFake({ turnsList: () => g.wait().then(answer) });
      await h.send('first');
      await tick();
      h.status('idle');
      await until(() => h.count('thread/turns/list') === 1, 'the idle probe', 3000);
      // Codex picks the turn up again before the probe answers.
      h.status('active');
      g.open();
      await tick(50);
      expect(h.rt.turnActive).toBe(true);
      h.complete('turn1');
      await tick();
      expect(h.rt.turnActive).toBe(false);
      expect(lastTurn(h.rt)?.stopReason).toBe('completed');
    });
  }

  it('a stale "inProgress" answer while the thread stays idle is asked again, and the stored end then closes the turn', async () => {
    const h = await codexFake({ turnsList: (n) => ({ data: [{ id: 'turn1', status: n === 1 ? 'inProgress' : 'completed', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [30, 30, 30];
    await h.send('second');
    h.status('idle');
    await until(() => !h.rt.turnActive || h.count('turn/start') === 2, 'the turn closed', 3000);
    await until(() => h.count('turn/start') === 2, 'the queued input checkpointed and sent');
    expect(h.count('thread/turns/list')).toBe(2);
    expect(lastTurn(h.rt)?.stopReason).toBe('completed');
    // It ended as the thread stored it: the queued message went out.
    expect(h.count('turn/start')).toBe(2);
  });

  it('an answer that stays "inProgress" is asked a few times, then the turn stays open, unsure, with the queue held (wave 3, #11)', async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [20, 20];
    await h.send('second');
    h.status('idle');
    await until(() => h.rt.meta.activity === 'Waiting for Codex', 'the turn left unsure', 3000);
    expect(h.rt.turnActive).toBe(true);
    expect(h.count('thread/turns/list')).toBe(3);
    expect(h.count('turn/start')).toBe(1);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['second']);
  });

  it('a newer status between rechecks stops them', async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn1', status: 'inProgress', items: [] }] }) });
    await h.send('first');
    await tick();
    h.session().idleRecheckMs = [200, 200];
    h.status('idle');
    await until(() => h.count('thread/turns/list') === 1, 'the idle probe', 3000);
    h.status('active');
    await tick(500);
    expect(h.count('thread/turns/list')).toBe(1);
    expect(h.rt.turnActive).toBe(true);
  });
});

describe('#14: an error belongs to the turn it names', () => {
  it("a late error of the turn that ended does not fail the next one or hold its queue", async () => {
    const h = await codexFake({ turnsList: () => ({ data: [{ id: 'turn2', status: 'completed', items: [] }] }) });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    await h.send('second');
    await tick();
    await h.send('third');
    // turn1's error arrives after turn2 began.
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'stale failure' } });
    h.status('idle');
    await tick(1700);
    await tick(50);
    expect(h.rt.items.filter((i) => i.type === 'turn').map((t) => (t as { error?: string }).error)).toEqual([undefined, undefined]);
    expect(h.rt.meta.status).not.toBe('error');
    expect(h.count('turn/start')).toBe(3);
    expect(h.rt.items.some((i) => i.type === 'notice' && (i as { text?: string }).text === 'stale failure')).toBe(false);
  });

  it("an error naming the previous turn while the next turn/start awaits its reply is not the new turn's", async () => {
    let release!: (v: unknown) => void;
    const h = await codexFake({
      turnStart: (n) => (n === 1 ? { turn: { id: 'turn1' } } : new Promise((r) => (release = r))),
      turnsList: () => ({ data: [{ id: 'turn2', status: 'completed', items: [] }] }),
    });
    await h.send('first');
    await tick();
    h.complete('turn1');
    await tick();
    void h.send('second');
    await until(() => h.count('turn/start') === 2, 'the second turn/start');
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'stale failure' } });
    release({ turn: { id: 'turn2' } });
    await tick();
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'turn2', status: 'inProgress', items: [] } });
    h.status('idle');
    await tick(1700);
    await tick(50);
    expect(h.rt.turnActive).toBe(false);
    expect(lastTurn(h.rt)).toMatchObject({ stopReason: 'completed' });
    expect(lastTurn(h.rt)?.error).toBeUndefined();
  });

  it("an error naming the new turn while its turn/start awaits its reply is kept for it", async () => {
    let release!: (v: unknown) => void;
    const h = await codexFake({ turnStart: () => new Promise((r) => (release = r)) });
    void h.send('first');
    await until(() => h.count('turn/start') === 1, 'turn/start');
    h.notify('turn/started', { threadId: 'th1', turn: { id: 'turn1', status: 'inProgress', items: [] } });
    h.notify('error', { threadId: 'th1', turnId: 'turn1', willRetry: false, error: { message: 'model overloaded' } });
    release({ turn: { id: 'turn1' } });
    await tick();
    h.status('idle');
    await tick(1700);
    expect(h.rt.turnActive).toBe(false);
    expect(lastTurn(h.rt)?.error).toBe('model overloaded');
  });
});
