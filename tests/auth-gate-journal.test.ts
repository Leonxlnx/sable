import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AuthGate, authGate, GATE, gateKey, noteAuthFailure, takeAuthFailure } from '../server/core/auth-gate';
import { AuthJournal, summarizeAuth, type AuthScope, type JournalRow } from '../server/core/auth-journal';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import type { UserItem } from '../shared/protocol';
import { PHONE_METHODS } from '../shared/protocol';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async load => ({ ...await load<object>(), spawn }));

/** A duplex CLI transport: the test controls replies, EOF, and actual OS exit independently. */
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1000 + children.length;
  exitCode: number | null = null;
  signalCode = null;
  kill = () => { this.exit(); return true; };
  reply(frame: object) { this.stdout.write(JSON.stringify(frame) + '\n'); }
  exit() { this.exitCode = 0; this.stdout.end(); this.emit('exit', 0, null); this.emit('close', 0, null); }
}
const children: Child[] = [];
let home: string;
let journal: AuthJournal;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'sable-auth-wire-'));
  journal = new AuthJournal(home);
  spawn.mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await journal.flush();
  for (const c of children.splice(0)) if (c.exitCode === null) c.exit();
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});
const scope = (agent: 'claude' | 'codex' = 'claude'): AuthScope => ({ agent, accountId: 'bada55', reason: 'chat', journal });
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const frame = (stream: PassThrough, obj: object) => stream.write(JSON.stringify(obj) + '\n');

it('two Windows folder names for one account take the same gate', async () => {
  const folder = path.join(home, 'profile'), alias = path.join(home, 'linked-profile');
  await mkdir(folder);
  await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(gateKey('claude', alias)).toBe(gateKey('claude', folder));
});

it('drains a pending reply during overlapping chats and records no payload', async () => {
  const gate = new AuthGate({ ...GATE, holdMs: 15, settleMs: 1, lingerMs: 45, minLifeMs: 30 });
  const id = scope(), env = { CLAUDE_CONFIG_DIR: home };
  const a = gate.spawner(undefined, undefined, id)({ command: 'fake', args: [], env });
  frame(a.stdin, { type: 'control_request', request_id: 'secret-request-id', request: { text: 'private@example.org' } });
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0].reply({ type: 'system' });
  const b = gate.spawner(undefined, undefined, id)({ command: 'fake', args: [], env });
  a.stdin.end(); // The SDK itself aborts its old query after the startup lease expired.
  await tick(240);
  expect(children).toHaveLength(2);
  expect(children[0].stdin.writableEnded).toBe(false);
  children[0].reply({ type: 'control_response', response: { request_id: 'secret-request-id' } });
  await vi.waitFor(() => expect(children[0].stdin.writableEnded).toBe(true));
  expect(children[1].exitCode).toBeNull();
  children[0].exit();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  children[1].exit();
  expect(b.exitCode).toBe(0);
  journal.record(id, { event: 'signed-out' });
  const lines = await journal.lines();
  expect(lines.join('')).not.toMatch(/private@example|secret-request|sable-auth-wire/);
  const rows: JournalRow[] = lines.map(line => JSON.parse(line));
  expect(rows.filter(r => r.event === 'start').map(r => r.alive)).toEqual([0, 1]);
  expect(rows.find(r => r.event === 'end')).toMatchObject({ inFlight: false, pid: 1000 });
  expect(rows.some(r => r.event === 'leave' && r.pid === 1000)).toBe(true);
  expect(summarizeAuth(rows)[0].events.filter(r => r.event === 'start')).toHaveLength(2);
});

it('keeps the Claude transport open until it answers a CLI-initiated control request', async () => {
  const gate = new AuthGate({ ...GATE, minLifeMs: 10, lingerMs: 40 });
  const child = gate.spawner(undefined, undefined, scope())({ command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } });
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0].reply({ type: 'control_request', request_id: 'permission', request: {} });
  child.kill();
  await tick(70);
  expect(children[0].exitCode).toBeNull();
  expect(children[0].stdin.writableEnded).toBe(false);
  frame(child.stdin, { type: 'control_response', response: { request_id: 'permission', subtype: 'success' } });
  await vi.waitFor(() => expect(children[0].exitCode).toBe(0));
});

function claudeChats() {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_CLAUDE_BIN', process.execPath);
  let closing = false;
  const provider = new ClaudeProvider({ account: { id: 'bada55', dir: home }, log() {}, emit() {}, journal, closing: () => closing });
  vi.spyOn(provider, 'caps').mockResolvedValue(provider.buildCaps(undefined, []));
  vi.spyOn(provider, 'readLimits').mockResolvedValue([]);
  const turns: SessionRuntime[] = [];
  const launch = async (id: string, readOnly = false) => {
    const rt = new SessionRuntime({ id, provider: 'claude', cwd: home, title: id, titleSource: 'auto', model: 'm',
      mode: 'default', options: { readOnly }, status: 'idle', createdAt: 0, updatedAt: 0,
      usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, () => {}, () => {});
    const session = await provider.open(rt, {});
    await session.send(rt.add<UserItem>({ type: 'user', text: 'work', state: 'sent' }));
    turns.push(rt);
    return { rt, session };
  };
  const close = async () => {
    closing = true;
    children.forEach(c => c.exit());
    await vi.advanceTimersByTimeAsync(1000);
    await provider.dispose();
  };
  return { launch, close, turns };
}

/** Drive the installed SDK through initialization and observe prompts delivered to each child. */
function answerControls(child: Child) {
  const messages: string[] = [];
  child.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const m = JSON.parse(line);
      if (m.type === 'user') messages.push(m.uuid);
      if (m.type !== 'control_request') continue;
      const response = m.request.subtype === 'initialize'
        ? { commands: [], models: [], agents: [], account: {}, output_style: 'default', available_output_styles: [] }
        : { mcpServers: [] };
      child.reply({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    }
  });
  return messages;
}

it('starts a second chat mid-turn, then a third, a sub-agent and a turn check on the same folder', async () => {
  const { launch, close, turns } = claudeChats();
  try {
    await launch('first');
    await launch('second');
    expect(children).toHaveLength(1);
    for (const [i, next] of ['third', 'sub-delegate', 'sub-check', undefined].entries()) {
      const delivered = answerControls(children[i]);
      await vi.advanceTimersByTimeAsync(GATE.settleMs - 1);
      expect(children).toHaveLength(i + 1);
      expect(delivered).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(i + 2);
      if (next) await launch(next, next === 'sub-check');
    }
    const last = answerControls(children[4]);
    await vi.advanceTimersByTimeAsync(1);
    expect(last).toHaveLength(1);
    expect(turns.map(rt => rt.turnActive)).toEqual([true, true, true, true, true]);
    expect(children.every(c => c.exitCode === null && !c.stdin.writableEnded)).toBe(true);
    const starts = (await journal.lines()).map(line => JSON.parse(line)).filter(r => r.event === 'start');
    expect(starts.map(r => [r.reason, r.alive])).toEqual([['chat', 0], ['chat', 1], ['chat', 2], ['sub-agent', 3], ['check', 4]]);
  } finally { await close(); }
});

it('starts a chat beside an idle chat and delivers the idle chat’s next turn to its original process', async () => {
  const { launch, close } = claudeChats();
  try {
    const { rt, session } = await launch('first');
    const delivered = answerControls(children[0]);
    await vi.advanceTimersByTimeAsync(GATE.settleMs);
    children[0].reply({ type: 'result', subtype: 'success', is_error: false, session_id: 'cc1', duration_ms: 1,
      usage: {}, total_cost_usd: 0, user_message_uuids: [delivered[0]] });
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.turnActive).toBe(false);
    await launch('second');
    expect(children).toHaveLength(2);
    expect(children[0].stdin.writableEnded).toBe(false);
    await session.send(rt.add<UserItem>({ type: 'user', text: 'again', state: 'sent' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toHaveLength(2);
    expect(children).toHaveLength(2);
  } finally { await close(); }
});

it('serializes two Claude login dialogs for aliases of one folder while a chat lives', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_LOGIN', 'cli');
  const provider = (id: string) => new ClaudeProvider({ account: { id, dir: home }, log() {}, emit() {}, journal });
  authGate.spawner(undefined, undefined, scope())({ command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } });
  await vi.advanceTimersByTimeAsync(0);
  children[0].reply({ type: 'system' });
  const first = provider('one').login();
  const second = provider('two').login();
  await vi.advanceTimersByTimeAsync(GATE.auxLeaseMs + GATE.holdMs);
  expect(children).toHaveLength(2);
  expect(children[0].exitCode).toBeNull();
  children[1].exit();
  await first;
  await vi.advanceTimersByTimeAsync(200);
  expect(children).toHaveLength(3);
  children[2].exit();
  await second;
});

it('records folder overlap and individual process ages at the moment of sign-in refusal', async () => {
  const id = scope();
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const end = journal.started(id, 'one', 101, undefined, now - 12_345);
    journal.started({ ...id, accountId: 'alias' }, 'one', 102, undefined, now - 875);
    journal.started({ ...id, accountId: 'elsewhere' }, 'two', 103);
    noteAuthFailure('wire-refused', undefined, 'turn', id, 101);
    end('exit', false);
    clock.mockReturnValue(now + 90_000);
    noteAuthFailure('wire-refused', undefined, 'turn', id, 102);
    const rows = (await journal.lines()).map(line => JSON.parse(line));
    expect(rows.filter(r => r.event === 'refused')).toMatchObject([
      { at: now, pid: 101, alive: 2, processes: [{ process: 1, pid: 101, ageMs: 12_345 }, { process: 2, pid: 102, ageMs: 875 }] },
      { at: now + 90_000, pid: 102, alive: 1, processes: [{ process: 2, pid: 102, ageMs: 90_875 }] },
    ]);
  } finally { takeAuthFailure('wire-refused'); clock.mockRestore(); }
});

it('coalesces a failed live usage read and spaces the next ordinary retry', async () => {
  const p = new ClaudeProvider({ account: { id: 'bada55', dir: home }, log() {}, emit() {}, journal });
  const usage = vi.fn().mockRejectedValue(new Error('temporarily unavailable'));
  const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage } as unknown as Parameters<ClaudeProvider['readLimits']>[0];
  await Promise.all([p.readLimits(query), p.readLimits(query)]);
  await p.readLimits(query);
  expect(usage).toHaveBeenCalledOnce();
  expect(children).toHaveLength(0);
});

it('does not overlap a cold limits process and a chat in either start order', async () => {
  const gate = new AuthGate({ ...GATE, holdMs: 15, settleMs: 1 });
  const launch = { command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } };
  const probe = gate.spawner(undefined, undefined, { ...scope(), reason: 'limits' });
  probe(launch);
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0].reply({ type: 'system' });
  gate.spawner(undefined, undefined, scope())(launch);
  await tick(240);
  expect(children).toHaveLength(1);
  children[0].exit();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  children[1].reply({ type: 'system' });
  const optional = probe(launch);
  await vi.waitFor(() => expect(optional.exitCode).toBe(1));
  expect(children).toHaveLength(2);
  children[1].exit();
});

it('lets a waiting chat start at the cold reader deadline', async () => {
  vi.useFakeTimers();
  const gate = new AuthGate({ ...GATE, auxLeaseMs: 120 });
  const launch = { command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } };
  gate.spawner(undefined, undefined, { ...scope(), reason: 'limits' })(launch);
  await vi.advanceTimersByTimeAsync(0);
  gate.spawner(undefined, undefined, scope())(launch);
  await vi.advanceTimersByTimeAsync(119);
  expect(children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(children).toHaveLength(2);
  expect(children[0].exitCode).toBeNull();
});

it('answers status as unknown without a version or status process when an alias has a live title', async () => {
  vi.useFakeTimers();
  const p = new ClaudeProvider({ account: { id: 'alias', dir: home }, log() {}, emit() {}, journal });
  authGate.spawner(undefined, undefined, { ...scope(), reason: 'title' })({ command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } });
  const status = p.info(true);
  await vi.advanceTimersByTimeAsync(GATE.holdMs);
  expect((await status).auth.checking).toBe(true);
  expect(children).toHaveLength(1);
  expect(children[0].exitCode).toBeNull();
});

it('the installed SDK can close its query while the CLI finishes a usage request', async () => {
  const gate = new AuthGate({ ...GATE, settleMs: 5, minLifeMs: 25, lingerMs: 50 });
  const prompt = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt, options: { cwd: home, env: { ...process.env, CLAUDE_CONFIG_DIR: home, USERPROFILE: home, HOME: home },
    settingSources: [], pathToClaudeCodeExecutable: process.execPath, spawnClaudeCodeProcess: gate.spawner(undefined, undefined, scope()) } });
  const initialized = q.initializationResult();
  await vi.waitFor(() => expect(children).toHaveLength(1));
  const child = children[0];
  let usageId: string | undefined;
  child.stdin.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const m = JSON.parse(line);
      if (m.type !== 'control_request') continue;
      if (m.request.subtype === 'initialize') child.reply({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
        response: { commands: [], models: [], agents: [], account: {}, output_style: 'default', available_output_styles: [] } } });
      else usageId = m.request_id;
    }
  });
  await initialized;
  const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => {});
  await vi.waitFor(() => expect(usageId).toBeTruthy());
  q.close();
  await tick(100);
  expect(child.stdin.writableEnded).toBe(false);
  expect(child.exitCode).toBeNull();
  child.reply({ type: 'control_response', response: { subtype: 'success', request_id: usageId, response: {} } });
  await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
  child.exit();
  await read;
});

it('admits two dedicated Codex delegates beside their account and keeps other accounts out of the folder', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const ctx = { account: { id: 'owner', dir: home }, log() {}, emit() {}, journal };
  const account = new CodexProvider(ctx);
  const delegates = [account.forDelegate(), account.forDelegate()];
  const foreign = new CodexProvider({ ...ctx, account: { id: 'another', dir: home } });
  for (const [i, provider] of [account, ...delegates].entries()) {
    const start = provider.client().catch(err => err as Error);
    await vi.advanceTimersByTimeAsync(GATE.settleMs + 50);
    expect(children).toHaveLength(i + 1);
    children[i].reply({ id: 1, result: {} });
    expect(await start).not.toBeInstanceOf(Error);
  }
  const denied = foreign.client().catch(err => err as Error);
  await vi.advanceTimersByTimeAsync(GATE.settleMs + 50);
  expect(await denied).toBeInstanceOf(Error);
  expect(children).toHaveLength(3);
  children[1].exit();
  expect(children[0].exitCode).toBeNull();
  expect(children[2].exitCode).toBeNull();
  children[0].exit();
  children[2].exit();
  await Promise.all([account, ...delegates, foreign].map(p => p.dispose()));
});

it('coalesces Codex clients, drains a pending RPC before EOF and waits through real exit before replacement', async () => {
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const p = new CodexProvider({ account: { id: 'bada55', dir: home }, log() {}, emit() {}, journal });
  const ask = Promise.all([p.client(), p.client()]);
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0].reply({ id: 1, result: {} });
  const [rpc, same] = await ask;
  expect(rpc).toBe(same);
  children[0].reply({ method: 'turn/started', params: { threadId: 'native-child', turn: { id: 'outside-main-chat' } } });
  expect(await p.limits(true)).toEqual([]);
  children[0].reply({ method: 'turn/completed', params: { threadId: 'native-child', turn: { id: 'outside-main-chat' } } });
  let answer!: () => void;
  rpc.onRequest = () => new Promise<void>(resolve => { answer = resolve; });
  children[0].reply({ id: 'permission', method: 'item/tool/requestUserInput', params: {} });
  expect(rpc.inFlight).toBe(true);
  answer();
  await vi.waitFor(() => expect(rpc.inFlight).toBe(false));
  const request = rpc.request('account/read');
  const internals = p as unknown as { stopIfIdle(ms: number): void };
  internals.stopIfIdle(0);
  expect(await p.client()).toBe(rpc);
  children[0].reply({ id: 2, result: {} });
  await request;
  internals.stopIfIdle(0);
  const replacement = p.client();
  await tick(200);
  expect(children[0].stdin.writableEnded).toBe(false);
  expect(children).toHaveLength(1);
  await vi.waitFor(() => expect(children[0].stdin.writableEnded).toBe(true), { timeout: 3500 });
  expect(children).toHaveLength(1);
  children[0].exit();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  children[1].reply({ id: 1, result: {} });
  expect(await replacement).not.toBe(rpc);
  children[1].exit();
  await p.dispose();
}, 8000);

it('retires an unanswered Codex initialize and reopens the same folder', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const p = new CodexProvider({ account: { id: 'test', dir: home }, log() {}, emit() {}, journal });
  const failed = p.client().catch(err => err as Error);
  await vi.advanceTimersByTimeAsync(0);
  expect(children).toHaveLength(1);
  // Ignore EOF as well. On Windows the mocked taskkill launcher also gets no reply.
  const hung = children[0];
  const kill = vi.spyOn(hung, 'kill');
  await vi.advanceTimersByTimeAsync(34_000);
  expect(await failed).toBeInstanceOf(Error);
  expect(hung.exitCode).toBe(0);
  expect(kill).toHaveBeenCalled();
  const count = children.length;
  const next = p.client();
  await vi.advanceTimersByTimeAsync(0);
  expect(children).toHaveLength(count + 1);
  children[count].reply({ id: 1, result: {} });
  expect((await next).alive).toBe(true);
  children[count].exit();
  await p.dispose();
});

it('bounds a replacement wait when the retiring Codex process has not exited', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const provider = new CodexProvider({ account: { id: 'owner', dir: home }, log() {}, emit() {}, journal });
  const starting = provider.client();
  await vi.advanceTimersByTimeAsync(0);
  const child = children[0];
  child.reply({ id: 1, result: {} });
  await starting;
  await vi.advanceTimersByTimeAsync(GATE.minLifeMs);
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  (provider as unknown as { stopIfIdle(ms: number): void }).stopIfIdle(0);
  const refused = provider.client().catch(err => err);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await refused).message).toContain('already in use');
  expect(child.exitCode).toBeNull();
  kill.mockRestore();
  const replacement = provider.client();
  await vi.advanceTimersByTimeAsync(0);
  children.at(-1)!.reply({ id: 1, result: {} });
  expect((await replacement).alive).toBe(true);
  children.at(-1)!.exit();
  await provider.dispose();
});

it('starts a Codex chat while a cold capability reader waits after wake', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const p = new CodexProvider({ account: { id: 'test', dir: home }, log() {}, emit() {}, journal });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const before = vi.spyOn(authGate, 'beforeRead').mockImplementation(() => gate);
  const paused = vi.spyOn(authGate, 'readsPaused').mockReturnValue(true);
  try {
    const reader = p.caps(home);
    await vi.advanceTimersByTimeAsync(0);
    const rt = new SessionRuntime({ id: 'wake', provider: 'codex', cwd: home, title: 'Wake', titleSource: 'user', model: 'm',
      mode: 'default', status: 'idle', createdAt: 1, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, () => {}, () => {});
    let attached = false;
    const chat = p.open(rt, {}).then(() => { attached = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(children).toHaveLength(1);
    children[0].stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        if (!request.id) continue;
        const result = request.method === 'thread/start' ? { thread: { id: 'wake' }, model: 'm' } : { data: [] };
        children[0].reply({ id: request.id, result });
      }
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(attached).toBe(true);
    await chat;
    release();
    expect((await reader).models).toEqual([]);
    expect(children).toHaveLength(1);
    children[0].exit();
    await p.dispose();
  } finally { release(); before.mockRestore(); paused.mockRestore(); }
});

it('releases a timed-out status reader after its grace even without a close event', async () => {
  vi.stubEnv('SABLE_CLAUDE_BIN', process.execPath);
  const p = new ClaudeProvider({ account: { id: 'test', dir: home }, log() {}, emit() {}, journal });
  const reading = p.info(true);
  await vi.waitFor(() => expect(children).toHaveLength(1));
  vi.useFakeTimers();
  children[0].stdout.write('9.9.9');
  children[0].exit();
  await vi.advanceTimersByTimeAsync(0);
  const kill = vi.spyOn(children[1], 'kill').mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(12_000);
  expect((await reading).auth.checking).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(authGate.canReadAlone(gateKey('claude', home))).toBe(true);
  expect(journal.busy).toBe(false);
  const again = p.info(true);
  await vi.advanceTimersByTimeAsync(0);
  children.at(-1)!.stdout.write('{"loggedIn":false}');
  children.at(-1)!.exit();
  expect((await again).auth.checking).toBeFalsy();
});

it('retires a standalone SDK reader that still owes a reply when its probe closes', async () => {
  vi.useFakeTimers();
  const key = gateKey('claude', home);
  const proc = authGate.spawner(undefined, undefined, { ...scope(), reason: 'limits' })({
    command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home },
  });
  await vi.advanceTimersByTimeAsync(0);
  children[0].reply({ type: 'system' });
  frame(proc.stdin, { type: 'control_request', request_id: 'usage' });
  await vi.advanceTimersByTimeAsync(GATE.auxLeaseMs);
  proc.kill();
  await vi.advanceTimersByTimeAsync(3000);
  expect(children[0].exitCode).toBe(0);
  expect(authGate.canReadAlone(key)).toBe(true);
  expect(journal.busy).toBe(false);
});

it('holds actual auxiliary starts for thirty seconds after wake and spaces a later burst', async () => {
  vi.useFakeTimers();
  const gate = new AuthGate({ ...GATE, spreadMs: 1000, jitterMs: 0 });
  gate.noteTimer(Date.now() - 120_000);
  const times: number[] = [];
  const go = (i: number) => gate.run(String(i), async () => { times.push(Date.now()); }, { ...scope(), reason: 'limits' });
  const first = Promise.all([go(1), go(2)]);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(times).toEqual([]);
  await vi.advanceTimersByTimeAsync(1002);
  await first;
  expect(times[1] - times[0]).toBe(1000);
  await vi.advanceTimersByTimeAsync(40_000);
  const later = Promise.all([go(3), go(4)]);
  await vi.advanceTimersByTimeAsync(1002);
  await later;
  expect(times[3] - times[2]).toBe(1000);
});

it('paces actual starts when different folders unblock together after wake', async () => {
  vi.useFakeTimers();
  const gate = new AuthGate({ ...GATE, spreadMs: 1000, jitterMs: 0, auxLeaseMs: 60_000 });
  const keys = ['folder-one', 'folder-two'];
  const holders = await Promise.all(keys.map(key => gate.enter(key, 'aux')));
  gate.noteTimer(Date.now() - 125_000);
  const times: number[] = [];
  const waiting = Promise.all(keys.map(async key => {
    const leave = await gate.enter(key, 'start', scope());
    times.push(Date.now());
    leave();
  }));
  await vi.advanceTimersByTimeAsync(8000);
  holders.forEach(leave => leave());
  await vi.advanceTimersByTimeAsync(3000);
  await waiting;
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
});

it('asks the CLI once for JSON status, preserves unknown and omits all CLI output from the journal', async () => {
  vi.stubEnv('SABLE_CLAUDE_BIN', process.execPath);
  const p = new ClaudeProvider({ account: { id: 'bada55', dir: home }, log() {}, emit() {}, journal });
  const first = p.info();
  await vi.waitFor(() => expect(children).toHaveLength(1));
  children[0].stdout.write('9.9.9');
  children[0].exit();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  children[1].stdout.write(JSON.stringify({ loggedIn: true, email: 'private@example.org', subscriptionType: 'max' }));
  children[1].exit();
  expect((await first).auth.plan).toBe('Max');
  const check = p.info(true);
  await vi.waitFor(() => expect(children).toHaveLength(3));
  children[2].stdout.write('temporary failure with private output');
  children[2].exit();
  expect((await check).auth).toEqual((await first).auth);
  const lines = await journal.lines();
  expect(lines.join('')).not.toMatch(/private|example|9\.9\.9/);
  expect(lines.map(line => JSON.parse(line)).filter(row => row.event === 'status-answer').map(row => row.answer)).toEqual(['in', 'unknown']);
});

it('a status timeout returns unknown and leaves the reader alive until its actual exit', async () => {
  vi.stubEnv('SABLE_CLAUDE_BIN', process.execPath);
  const p = new ClaudeProvider({ account: { id: 'bada55', dir: home }, log() {}, emit() {}, journal });
  const reading = p.info(true);
  await vi.waitFor(() => expect(children).toHaveLength(1));
  vi.useFakeTimers();
  children[0].stdout.write('9.9.9');
  children[0].exit();
  await vi.advanceTimersByTimeAsync(0);
  expect(children).toHaveLength(2);
  children[1].stdout.write('{"loggedIn":false}'); // No exit to confirm this partial answer.
  authGate.spawner(undefined, undefined, scope())({ command: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: home } });
  await vi.advanceTimersByTimeAsync(11_999);
  expect(children).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect((await reading).auth.checking).toBe(true);
  expect(children).toHaveLength(3);
  expect(children[1].exitCode).toBeNull();
  expect(children[1].stdin.writableEnded).toBe(false);
  children[1].exit();
});

it('serves a dormant account from cache until the desktop asks for it', async () => {
  const app = new App({ home, providers: [ctx => new CodexProvider(ctx)], quiet: true });
  const stored = { id: 'codex' as const, name: 'Codex', installed: true, auth: { loggedIn: true } };
  app.cache.set('info:codex', stored);
  app.store.state.accounts.push({ id: 'older', provider: 'codex', label: 'fixture', createdAt: Date.now() - 86400_000 });
  const extraInfo = vi.spyOn(app.provider('codex', 'older'), 'info').mockResolvedValue(stored);
  const p = app.provider('codex');
  const info = vi.spyOn(p, 'info').mockResolvedValue(stored);
  const limits = vi.spyOn(p, 'limits').mockResolvedValue([]);
  try {
    const found = await app.providerInfo('codex');
    expect(found.auth.loggedIn).toBe(true);
    expect(found.accounts?.find(a => a.id === 'older')?.auth.checking).toBe(true);
    expect(extraInfo).not.toHaveBeenCalled();
    await app.call('provider.limits', { provider: 'codex' });
    expect(info).not.toHaveBeenCalled();
    expect(limits).not.toHaveBeenCalled();
    await app.call('provider.limits', { provider: 'codex', force: true });
    expect(limits).toHaveBeenCalledOnce();
    expect(children).toHaveLength(0);
  } finally { await app.dispose(); }
});

it('seals and drains seven accounts concurrently, including a request still outstanding beyond three seconds', async () => {
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('SABLE_CODEX_BIN', process.execPath);
  const app = new App({ home, providers: [ctx => new CodexProvider(ctx)], quiet: true });
  const ids = ['default', ...Array.from({length: 6}, (_, i) => 'account-' + i)];
  for (const id of ids.slice(1)) app.store.state.accounts.push({ id, provider: 'codex', label: 'private', createdAt: Date.now() });
  const starting = Promise.all(ids.map(id => (app.provider('codex', id) as CodexProvider).client()));
  await vi.waitFor(() => expect(children).toHaveLength(7));
  for (const c of children) {
    c.stdin.once('finish', () => c.exit());
    c.reply({ id: 1, result: {} });
  }
  const [rpc] = await starting;
  const pending = rpc.request('account/read');
  let acknowledged = false;
  const quit = app.dispose(() => { acknowledged = true; });
  await tick(3200);
  expect(acknowledged).toBe(false);
  expect(children[0].stdin.writableEnded).toBe(false);
  children[0].reply({ id: 2, result: {} });
  await Promise.all([pending, quit]);
  expect(acknowledged).toBe(true);
  const ends = (await app.journal.lines()).map(line => JSON.parse(line)).filter(row => row.event === 'end');
  expect(ends).toHaveLength(7);
  for (const row of ends) {
    expect(row.inFlight, JSON.stringify(row)).toBe(false);
    expect(row.ageMs, JSON.stringify(row)).toBeGreaterThanOrEqual(GATE.minLifeMs);
  }
}, 12_000);

it('includes a process already running two minutes before sign-out, wake, and an alias of its folder', async () => {
  const id = scope(), alias = { ...id, accountId: 'other-id' };
  let now = Date.now() - 130_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const end = journal.started(id, 'same-folder', 101);
    now += 125_000;
    journal.record(undefined, { event: 'wake' });
    const otherEnd = journal.started(alias, 'same-folder', 102);
    end('eof', false);
    journal.record(id, { event: 'signed-out' });
    const [summary] = summarizeAuth((await journal.lines()).map(line => JSON.parse(line)));
    expect(summary.aliveAtWindowStart).toMatchObject([{ pid: 101 }]);
    expect(summary.events.map(e => e.event)).toEqual(['wake', 'start', 'end', 'signed-out']);
    expect(summary.events[1]).toMatchObject({ accountId: 'other-id', alive: 1, pid: 102 });
    otherEnd('exit', false);
  } finally { clock.mockRestore(); }
});

it('keeps the bounded history across a restart and serves the most recent lines only on the desktop', async () => {
  const id = scope();
  for (let i = 0; i < 4000; i++) journal.record(id, { event: 'retry' });
  await journal.flush();
  for (let i = 0; i < 200; i++) journal.record(id, { event: 'refused' });
  await journal.flush();
  const disk = await readFile(path.join(home, 'cache', 'auth-journal.jsonl'), 'utf8');
  expect(disk.trimEnd().split('\n')).toHaveLength(4000);
  const app = new App({ home, providers: [], quiet: true });
  try {
    expect(await app.call('auth.journal', { limit: 2 })).toEqual((await journal.lines()).slice(-2));
    expect(PHONE_METHODS).not.toContain('auth.journal');
  } finally { await app.dispose(); }
});
