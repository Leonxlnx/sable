/**
 * The OpenCode adapter against a fake ACP client (no process, no model): the sender's guard at
 * dispatch, a Stop before the prompt went, a turn that always ends, and permission requests whose
 * scope the phone can show or not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, NoticeItem, PermissionRequest, SessionMeta, ToolItem, UserItem } from '@shared/protocol';
import { delegateReport } from '@shared/synthetic';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { OpenCodeProvider } from '../server/providers/opencode';
import { AcpClient } from '../server/providers/opencode-acp';
import { permissionScope } from '../server/providers/opencode-map';
import { phonePermission } from '../server/services/phone';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = { method: string; params: any; resolve: (v: unknown) => void; reject: (e: Error) => void };

function fakeAcp(holdResume = false) {
  const calls: Call[] = [];
  const notes: { method: string; params: any }[] = [];
  let sessions = 0;
  const acp = {
    alive: true,
    init: { agentCapabilities: {} },
    request(method: string, params: any) {
      return new Promise((resolve, reject) => {
        calls.push({ method, params, resolve, reject });
        if (method === 'session/new') resolve({ sessionId: `oc-${++sessions}`, configOptions: [] });
        if (method === 'session/set_config_option') resolve({});
        if (method === 'session/resume' && !holdResume) resolve({ configOptions: [] });
      });
    },
    notify(method: string, params: any) {
      notes.push({ method, params });
    },
    close: async () => {},
  };
  return { acp, calls, notes, prompts: () => calls.filter((c) => c.method === 'session/prompt') };
}

it('reads a switched delegate report from a chunked OpenCode history replay', async () => {
  const fake = fakeAcp();
  const reader = fake.acp as unknown as AcpClient;
  const start = vi.spyOn(AcpClient, 'start').mockResolvedValue(reader);
  try {
    const provider = new OpenCodeProvider({ emit() {}, log() {} });
    const id = 'c3445196-413b-464f-82df-5be423802949';
    const text = delegateReport('Review', 'done', 'Findings', id);
    const receipts = provider.delegateReceipts('thread', process.cwd());
    await vi.waitFor(() => expect(fake.calls[0]?.method).toBe('session/load'));
    for (const piece of [text.slice(0, 30), text.slice(30)]) {
      reader.onNotification!('session/update', { sessionId: 'thread', update: { sessionUpdate: 'user_message_chunk', messageId: 'user', content: { text: piece } } });
    }
    fake.calls[0].resolve({});
    expect((await receipts).ids).toEqual(new Set([id]));
  } finally { start.mockRestore(); }
});

describe('OpenCode shared process exit', () => {
  let app: App;
  afterEach(async () => {
    await app?.dispose();
    vi.restoreAllMocks();
  });

  async function setup(holdResume = false) {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-acp-exit-'));
    dirs.push(home);
    const processes: ReturnType<typeof fakeAcp>[] = [];
    vi.spyOn(AcpClient, 'start').mockImplementation(async () => {
      const fake = fakeAcp(holdResume);
      processes.push(fake);
      return fake.acp as unknown as AcpClient;
    });
    app = new App({ home, userHome: home, quiet: true, providers: [ctx => {
      const p = new OpenCodeProvider(ctx);
      p.info = async () => ({ id: 'opencode', name: 'OpenCode', installed: true, auth: { loggedIn: true } });
      p.servers = async () => [];
      p.limits = async () => [];
      p.caps = async () => p.capsOf({ models: [], commands: [], at: Date.now() });
      return p;
    }] });
    const create = async () => {
      const { session } = await app.call('session.create', { provider: 'opencode', cwd: home });
      await app.call('session.send', { sessionId: session.id, text: 'begin' });
      return app.runtime(session.id);
    };
    const current = () => processes.at(-1)!;
    const update = (rt: SessionRuntime, data: object, fake = current()) =>
      (fake.acp as unknown as AcpClient).onNotification!('session/update', { sessionId: rt.meta.providerSessionId, update: data });
    const die = (fake = current()) => {
      fake.acp.alive = false;
      // The real client rejects its pending calls and publishes exit in the same callback.
      for (const c of fake.calls) c.reject(new Error('ACP died'));
      (fake.acp as unknown as AcpClient).onExit!({ code: 9, signal: null, stderr: 'test process exited' });
    };
    const atRest = async (rt: SessionRuntime) => {
      current().prompts().findLast(c => c.params.sessionId === rt.meta.providerSessionId)!.resolve({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(rt.turnActive).toBe(false));
    };
    const command = (rt: SessionRuntime, id: string) => {
      // ACP has no task-lifecycle notification. Exercise the real runtime mark on an ACP tool row.
      update(rt, { sessionUpdate: 'tool_call', toolCallId: id, name: 'bash', status: 'completed', rawInput: { command: id } });
      const row = rt.items.at(-1) as ToolItem;
      rt.taskStarted(row.id, { id, kind: 'command' });
      return row.id;
    };
    return { processes, current, create, update, die, atRest, command };
  }

  it('cuts each open prompt once, wakes only the resting chat with lost work, and leaves closed chats alone', async () => {
    const h = await setup();
    const active = await h.create();
    const other = await h.create();
    const resting = await h.create();
    const idle = await h.create();
    const closed = await h.create();
    await h.atRest(resting);
    await h.atRest(idle);
    const detached = h.command(closed, 'closed-build');
    await app.call('session.close', { sessionId: closed.id });
    expect(closed.get<ToolItem>(detached)?.task?.state).toBe('lost');
    const closedItems = [...closed.items];
    h.update(active, { sessionUpdate: 'tool_call', toolCallId: 'read', name: 'read', status: 'in_progress' });
    const step = active.items.at(-1)!.id;
    const command = h.command(resting, 'nightly-build');
    h.die();
    expect(active.get<ToolItem>(step)?.status).toBe('cancelled');
    for (const rt of [active, other]) {
      expect(rt.items.filter(i => i.type === 'notice' && i.early)).toMatchObject([{ text: 'Ended early', early: 'died', detail: expect.stringContaining('test process exited') }]);
      expect(rt.items.filter(i => i.type === 'turn')).toHaveLength(0);
      expect(rt.turnActive).toBe(false);
    }
    expect(resting.get<ToolItem>(command)?.task).toMatchObject({ state: 'lost', why: 'process' });
    await vi.waitFor(() => expect(h.current().prompts()).toHaveLength(1));
    expect(h.processes).toHaveLength(2);
    const sid = resting.meta.providerSessionId;
    expect(h.current().calls.filter(c => c.method === 'session/resume')).toMatchObject([{ params: { sessionId: sid } }]);
    expect(h.current().prompts()[0].params.sessionId).toBe(sid);
    expect(JSON.stringify(h.current().prompts()[0].params.prompt)).toContain('nightly-build');
    const notices = () => resting.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.detail?.includes('nightly-build'));
    expect(notices()).toHaveLength(1);
    expect(notices()[0].text).not.toContain('The agent was told');
    h.update(resting, { sessionUpdate: 'agent_message_chunk', content: { text: 'I will check the build.' } });
    expect(notices()).toMatchObject([{ text: expect.stringContaining('The agent was told') }]);
    expect(resting.pendingLost().count).toBe(0);
    expect(resting.items.filter(i => i.type === 'user')).toHaveLength(1);
    for (const rt of [resting, idle, closed]) expect(rt.items.filter(i => i.type === 'notice' && i.early)).toHaveLength(0);
    expect(closed.items).toEqual(closedItems);
    const old = h.processes[0];
    h.die(old);
    h.update(resting, { sessionUpdate: 'agent_message_chunk', content: { text: 'old process' } }, old);
    expect(resting.items.some(i => i.type === 'text' && i.text.includes('old process'))).toBe(false);
    expect(resting.turnActive).toBe(true);
    const next = h.command(resting, 'second-build');
    h.die();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(resting.get<ToolItem>(next)?.task?.state).toBe('lost');
    expect(resting.meta.lossWake?.blocked).toBe(true);
    expect(h.processes).toHaveLength(2);
    expect(resting.items.filter(i => i.type === 'notice' && i.early)).toHaveLength(1);
  });

  it('keeps the loss after Stop and resumes once for the next personal prompt', async () => {
    const h = await setup();
    const rt = await h.create();
    h.command(rt, 'lint');
    await app.call('session.interrupt', { sessionId: rt.id });
    h.die();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.processes).toHaveLength(1);
    expect(rt.pendingLost().count).toBe(1);
    await app.call('session.send', { sessionId: rt.id, text: 'continue' });
    expect(h.current().prompts()).toHaveLength(1);
    expect(JSON.stringify(h.current().prompts()[0].params.prompt)).toContain('lint');
    await h.atRest(rt);
    expect(rt.pendingLost().count).toBe(0);
    expect(rt.items.filter(i => i.type === 'notice' && i.early)).toHaveLength(1);
  });

  it('resumes each resting chat with only its own losses on one replacement process', async () => {
    const h = await setup();
    const chats = [await h.create(), await h.create()];
    for (const rt of chats) {
      await h.atRest(rt);
      h.command(rt, rt.id);
    }
    h.die();
    await vi.waitFor(() => {
      expect(h.processes).toHaveLength(2);
      expect(h.current().prompts()).toHaveLength(2);
    });
    for (const rt of chats) {
      const prompt = h.current().prompts().find(c => c.params.sessionId === rt.meta.providerSessionId)!;
      expect(JSON.stringify(prompt.params.prompt)).toContain(rt.id);
      expect(JSON.stringify(prompt.params.prompt)).not.toContain(chats.find(chat => chat !== rt)!.id);
      await h.atRest(rt);
      expect(rt.items.filter(i => i.type === 'notice' && i.text.includes('The agent was told'))).toHaveLength(1);
      expect(rt.pendingLost().count).toBe(0);
    }
  });

  it('holds an unconfirmed loss when ACP dies during session/resume', async () => {
    const h = await setup(true);
    const rt = await h.create();
    await h.atRest(rt);
    h.command(rt, 'still-owed');
    h.die();
    await vi.waitFor(() => expect(h.current().calls.filter(c => c.method === 'session/resume')).toHaveLength(1));
    h.die();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.processes).toHaveLength(2);
    expect(h.current().prompts()).toHaveLength(0);
    expect(h.current().calls.filter(c => c.method === 'session/new')).toHaveLength(0);
    expect(rt.meta.lossWake?.blocked).toBe(true);
    expect(rt.pendingLost().count).toBe(1);
    expect(rt.turnActive).toBe(false);
    expect(rt.items.filter(i => i.type === 'notice' && i.early)).toMatchObject([{ early: 'died' }]);
    expect(rt.items.some(i => i.type === 'notice' && i.text.includes('The agent was told'))).toBe(false);
  });

  it('detaches an unresponsive ACP process before a waiting chat resumes', async () => {
    const h = await setup();
    const stopped = await h.create();
    const peer = await h.create();
    const old = h.current();
    vi.useFakeTimers();
    try {
      await app.call('session.interrupt', { sessionId: stopped.id });
      await vi.advanceTimersByTimeAsync(8_000);
      await app.call('session.send', { sessionId: stopped.id, text: 'new instructions' });
      expect(old.prompts()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.processes).toHaveLength(2);
      expect(h.current().prompts()).toHaveLength(1);
      expect(peer.items.filter(i => i.type === 'notice' && i.early)).toMatchObject([{ early: 'closed' }]);
      h.die(old);
      expect(stopped.turnActive).toBe(true);
      expect(stopped.items.filter(i => i.type === 'notice' && i.early)).toHaveLength(0);
      expect(peer.items.filter(i => i.type === 'notice' && i.early)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

async function chat(opts: { slowClient?: Promise<void> } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sable-oc-'));
  dirs.push(cwd);
  const events: BridgeEvent[] = [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'opencode', cwd, title: 'New session', titleSource: 'auto', model: '', mode: 'build', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } };
  const rt = new SessionRuntime(meta, (e) => events.push(e), () => {});
  const fake = fakeAcp();
  const provider = new OpenCodeProvider({ emit: () => {}, log: () => {} });
  let gate: Promise<void> | undefined;
  (provider as unknown as { client: () => Promise<unknown> }).client = async () => {
    if (gate) await gate;
    return fake.acp;
  };
  (provider as unknown as { servers: () => Promise<unknown[]> }).servers = async () => [];
  const session = await provider.open(rt, {});
  gate = opts.slowClient;
  const user = (text: string) => rt.add<UserItem>({ type: 'user', text, state: 'sent' });
  return { rt, provider, session, fake, user, events };
}

describe('OpenCode turns', () => {
  it('sends a prompt and ends the turn when OpenCode answers', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('hi'));
    expect(rt.turnActive).toBe(true);
    expect(fake.prompts()).toHaveLength(1);
    fake.prompts()[0].resolve({ stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.turnActive).toBe(false);
    expect(rt.items.at(-1)?.type).toBe('turn');
  });

  it("asks the sender's guard right before the prompt goes, and sends nothing when it refuses", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { session, fake, user } = await chat({ slowClient: slow });
    let allowed = true;
    const check = () => {
      if (!allowed) throw new Error('gone');
    };
    const sent = session.send(user('hi'), { check });
    allowed = false;
    release();
    await expect(sent).rejects.toThrow('gone');
    expect(fake.prompts()).toHaveLength(0);
  });

  it('a Stop before the prompt went ends the turn at once and nothing goes later', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { rt, session, fake, user } = await chat({ slowClient: slow });
    const sent = session.send(user('hi'));
    await session.interrupt();
    expect(rt.turnActive).toBe(false);
    release();
    await sent;
    expect(fake.prompts()).toHaveLength(0);
    expect(rt.turnActive).toBe(false);
  });

  it('a message from a removed phone that waited in the queue never goes', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('first'));
    let allowed = true;
    const queued = user('second');
    await session.send(queued, {
      check: () => {
        if (!allowed) throw new Error('gone');
      },
    });
    allowed = false;
    fake.prompts()[0].resolve({ stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.prompts()).toHaveLength(1);
    expect(rt.get(queued.id)).toBeUndefined();
    expect(rt.turnActive).toBe(false);
  });

  it('a prompt that never answers still ends after a Stop', async () => {
    const { rt, session, fake, user } = await chat();
    await session.send(user('hi'));
    await session.interrupt();
    expect(fake.notes.map((n) => n.method)).toContain('session/cancel');
    // OpenCode does not answer the cancel: the turn ends by itself (8 s); here it is answered at once.
    fake.prompts()[0].resolve({ stopReason: 'cancelled' });
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.turnActive).toBe(false);
  });
});

describe('OpenCode after a Stop it does not answer, and after its process dies (review wave 8, #23)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('a Stop that times out ends the turn, but nothing else goes until the old prompt has answered', async () => {
    vi.useFakeTimers();
    const { rt, provider, session, fake, user } = await chat();
    await session.send(user('first'));
    await session.interrupt();
    vi.advanceTimersByTime(8_000);
    expect(rt.turnActive).toBe(false);
    // The next message waits: OpenCode may still be working on the stopped prompt.
    const next = user('second');
    await session.send(next);
    await flush();
    expect(fake.prompts()).toHaveLength(1);
    expect(rt.get<UserItem>(next.id)?.state).toBe('queued');
    // What the stopped prompt still streams is dropped, and what it asks is refused.
    const before = rt.items.length;
    (provider as unknown as { onNotification(m: string, p: unknown): void }).onNotification('session/update', { sessionId: 'oc-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'late', content: { text: 'late words' } } });
    expect(rt.items.length).toBe(before);
    expect(await (provider as unknown as { onRequest(m: string, p: unknown): Promise<unknown> }).onRequest('session/request_permission', { sessionId: 'oc-1', options: [{ optionId: 'y', kind: 'allow_once' }] })).toEqual({ outcome: { outcome: 'cancelled' } });
    // It answers at last: the waiting message goes.
    fake.prompts()[0].resolve({ stopReason: 'cancelled' });
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.prompts()).toHaveLength(2);
    expect(rt.turnActive).toBe(true);
  });

  it('a stopped prompt that never answers gives the process up, and the waiting message goes on a new one', async () => {
    vi.useFakeTimers();
    const { rt, session, fake, user } = await chat();
    await session.send(user('first'));
    await session.interrupt();
    vi.advanceTimersByTime(8_000);
    await session.send(user('second'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.calls.some((c) => c.method === 'session/resume')).toBe(true);
    expect(fake.prompts()).toHaveLength(2);
    expect(rt.turnActive).toBe(true);
  });

  it('after the process died the next message opens the conversation again instead of failing', async () => {
    const { rt, provider, session, fake, user } = await chat();
    await session.send(user('first'));
    (provider as unknown as { onExit(a: unknown, i: unknown): void }).onExit(fake.acp, { code: 1, signal: null, stderr: '' });
    expect(rt.turnActive).toBe(false);
    await session.send(user('again'));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.calls.some((c) => c.method === 'session/resume' && c.params.sessionId === 'oc-1')).toBe(true);
    expect(fake.prompts()).toHaveLength(2);
    expect(rt.turnActive).toBe(true);
  });

  it("a queued message's sender is asked again after the setup, right before its prompt goes", async () => {
    let release!: () => void;
    const { rt, session, fake, user } = await chat();
    await session.send(user('first'));
    let allowed = true;
    const queued = user('second');
    await session.send(queued, {
      check: () => {
        if (!allowed) throw new Error('gone');
      },
    });
    // The choices take a while to apply (a model switch): the phone is removed meanwhile.
    rt.update({ model: 'other' });
    const anyS = session as unknown as { options: unknown[] };
    anyS.options = [{ id: 'model', category: 'model', currentValue: 'm', options: [{ value: 'other' }] }];
    const slow = new Promise<void>((r) => (release = r));
    const orig = fake.acp.request.bind(fake.acp);
    fake.acp.request = (method: string, params: any) => (method === 'session/set_config_option' ? slow.then(() => ({})) : orig(method, params));
    fake.prompts()[0].resolve({ stopReason: 'end_turn' });
    await new Promise((r) => setTimeout(r, 0));
    allowed = false;
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.prompts()).toHaveLength(1);
    expect(rt.get(queued.id)).toBeUndefined();
    expect(rt.turnActive).toBe(false);
  });
});

describe('OpenCode permission scope', () => {
  const ask = (over: Partial<PermissionRequest>): PermissionRequest =>
    ({ id: 'p1', sessionId: 's1', toolName: 'Edit', kind: 'edit', title: 'Edit a.ts', detail: {}, options: [{ id: 'once', label: 'Allow once', tone: 'allow' }, { id: 'always', label: 'Always allow', tone: 'always' }], createdAt: 0, ...over }) as PermissionRequest;

  it('an edit names its files; one the diff shows needs no line', () => {
    const r = permissionScope('edit', { locations: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }] }, {}, ['/w/a.ts']);
    expect(r.scope?.files).toEqual([{ path: '/w/a.ts' }, { path: '/w/b.ts' }]);
    expect(r.lines).toEqual(['/w/b.ts']);
    const shown = phonePermission(ask({ scope: r.scope, reason: r.lines.join('\n'), diff: [{ path: '/w/a.ts', hunks: [], additions: 0, deletions: 0 } as any] }));
    expect(shown.incomplete).toBeUndefined();
  });

  it('a fetch names its host; a read its paths', () => {
    expect(permissionScope('fetch', {}, { url: 'https://example.com/x' }).lines).toEqual(['Network access to example.com']);
    expect(permissionScope('read', { locations: [{ path: '/etc/hosts' }] }, {}).lines).toEqual(['Read: /etc/hosts']);
  });

  it('a request that does not say what it does is the desktop\'s (review wave 8, #12)', () => {
    // A command with no command, a read with no paths, a move with only its source.
    const noCommand = permissionScope('execute', {}, {});
    expect(noCommand.scope?.unknown).toBe(true);
    expect(phonePermission(ask({ kind: 'bash', scope: noCommand.scope })).incomplete).toBe(true);
    const blankCommand = permissionScope('execute', {}, { command: '   ' });
    expect(blankCommand.scope?.unknown).toBe(true);
    const noPaths = permissionScope('read', {}, {});
    expect(phonePermission(ask({ kind: 'read', scope: noPaths.scope })).incomplete).toBe(true);
    const halfMove = permissionScope('move', { locations: [{ path: '/w/a.ts' }] }, {});
    expect(halfMove.scope?.unknown).toBe(true);
    expect(phonePermission(ask({ scope: halfMove.scope })).incomplete).toBe(true);
    // Both ends named: shown as one line, and the phone may answer.
    const move = permissionScope('move', { locations: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }] }, {});
    expect(move.scope?.files).toEqual([{ path: '/w/b.ts', from: '/w/a.ts' }]);
    expect(move.lines).toEqual(['/w/a.ts → /w/b.ts']);
    expect(phonePermission(ask({ scope: move.scope, reason: move.lines.join('\n') })).incomplete).toBeUndefined();
  });

  it('what Sable cannot describe is the desktop\'s, and "always" never goes to the phone', () => {
    const mcp = permissionScope('other', {}, {});
    expect(mcp.scope?.unknown).toBe(true);
    expect(phonePermission(ask({ scope: mcp.scope })).incomplete).toBe(true);
    const cmd = permissionScope('execute', {}, { command: 'ls' }, [], true);
    const shown = phonePermission(ask({ kind: 'bash', scope: cmd.scope }));
    expect(shown.incomplete).toBeUndefined();
    expect(shown.options.map((o) => o.id)).toEqual(['once']);
  });
});
