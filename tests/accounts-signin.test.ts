import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthState, BridgeEvent, ProviderInfo } from '@shared/protocol';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import { CodexProvider } from '../server/providers/codex';
import { signedOut } from '@/lib/sign-in';

const sdk = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', async original => ({ ...await original<object>(), query: sdk }));
vi.mock('node:child_process', async original => ({ ...await original<object>(), spawn: vi.fn(() => ({ unref() {} })) }));

let dir: string;
let app: App;
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(process.env.TEMP!, 'signin-test-'));
  vi.stubEnv('SABLE_LOGIN', 'sdk');
  sdk.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  await dispose?.();
  dispose = undefined;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function start() {
  const events: BridgeEvent[] = [];
  app = new App({ home: dir, userHome: dir, quiet: true, providers: [ctx => {
    const p = new ClaudeProvider(ctx);
    Object.assign(p, { cli: async (reason: string) => ({ code: 0, stdout: reason === 'version' ? '1.0' : '{"loggedIn":false}' }) });
    vi.spyOn(p, 'caps').mockResolvedValue(p.buildCaps(undefined, []));
    return p;
  }] });
  app.subscribe(e => events.push(e));
  dispose = () => app.dispose();
  return events;
}

async function chat(p: ClaudeProvider, id: string) {
  const rt = new SessionRuntime({ id, provider: 'claude', cwd: dir, title: id, titleSource: 'auto', model: 'm',
    mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, () => {}, () => {});
  const session = await p.open(rt, {});
  const q = { close: vi.fn(), accountInfo: vi.fn(async () => ({ subscriptionType: 'pro' })), reinitialize: vi.fn() };
  Object.assign(session, { q });
  const live = session as typeof session & { onMessage(frame: object): void; holdsWork(): boolean };
  return { q, live };
}

const states = (events: BridgeEvent[]) => events.flatMap(e => e.type === 'auth.progress' ? [e.state] : []);

it('completes the browser sign-in on its own process while the idle chat holds 12 agents and 6 commands', async () => {
  vi.useFakeTimers();
  const events = start();
  const added = app.call('account.add', { provider: 'claude', label: 'Ultra2' });
  await vi.advanceTimersByTimeAsync(1000);
  const { account } = await added;
  const params = { provider: 'claude' as const, accountId: account.id };
  const p = app.provider('claude', account.id) as ClaudeProvider;
  const busy = await chat(p, 'busy');
  const tasks = Array.from({ length: 18 }, (_, i) => ({ task_id: 'task-' + i, task_type: i < 12 ? 'local_agent' : 'local_bash' }));
  for (const task of tasks) busy.live.onMessage({ type: 'system', subtype: 'task_started', ...task, is_backgrounded: true });
  expect(busy.live.holdsWork()).toBe(true);
  expect((await p.info(true)).auth.plan).toBe('Pro');
  busy.q.accountInfo.mockRejectedValueOnce(new Error('unavailable'));
  expect((await p.info(true)).auth).toMatchObject({ loggedIn: true, plan: 'Pro' });
  expect(busy.q.accountInfo).toHaveBeenCalledTimes(2);
  expect(busy.q.reinitialize).not.toHaveBeenCalled();

  let finish!: () => void;
  const login = { claudeAuthenticate: vi.fn(async () => ({ automaticUrl: 'https://example.invalid/', manualUrl: '' })),
    claudeOAuthWaitForCompletion: () => new Promise<void>(resolve => { finish = resolve; }),
    reinitialize: vi.fn(async () => ({ account: { subscriptionType: 'max', tokenSource: 'oauth', organization: 'Work', email: 'new@example.invalid' } })),
    close: vi.fn() };
  sdk.mockReturnValueOnce(login);
  await app.call('auth.login', params);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  await app.call('auth.refresh', params);
  const idle = await chat(p, 'idle');
  const secondIdle = await chat(p, 'also-idle');
  const other = await chat(app.provider('claude') as ClaudeProvider, 'other-account');
  const oldCaps = { ...p.buildCaps(undefined, []), models: [{ id: 'old', name: 'Old plan model' }] };
  app.cache.set(`caps:claude:${account.id}:`, oldCaps);
  p.onRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
  const warm = { close: vi.fn() };
  Object.assign(p, { warm: { q: warm, owner: {}, input: { end() {} }, timer: setTimeout(() => {}, 60_000) } });
  finish();
  await vi.waitFor(() => expect(states(events)).toContain('done'));
  expect(states(events)).toEqual(['started', 'url', 'done']);
  expect(login.reinitialize.mock.invocationCallOrder[0]).toBeLessThan(login.close.mock.invocationCallOrder[0]);
  expect(idle.q.close).toHaveBeenCalledOnce();
  expect(secondIdle.q.close).toHaveBeenCalledOnce();
  expect(warm.close).toHaveBeenCalledOnce();
  expect(other.q.close).not.toHaveBeenCalled();
  expect(busy.q.close).not.toHaveBeenCalled();
  expect((await app.call('provider.caps', params)).models).not.toEqual(oldCaps.models);
  expect(await p.limits()).toEqual([]);
  const auth = { loggedIn: true, plan: 'Max', planId: 'max', org: 'Work', method: 'oauth', email: 'new@example.invalid' };
  const updated = events.findLast(e => e.type === 'provider.updated');
  expect(updated?.provider.accounts?.find(a => a.id === account.id)?.auth).toEqual(auth);
  expect((await p.info(true)).auth).toEqual(auth);
  expect(busy.q.accountInfo).toHaveBeenCalledTimes(3);
  const journal = await app.call('auth.journal', {});
  expect(journal.join('')).not.toMatch(/Ultra2|new@example|example\.invalid/);
  const signIn = journal.map(line => JSON.parse(line)).filter(e => e.accountId === account.id && ['status', 'status-answer', 'signed-in'].includes(e.event));
  expect(signIn.slice(-3)).toMatchObject([{ event: 'status' }, { event: 'status-answer', answer: 'in' }, { event: 'signed-in' }]);

  await vi.advanceTimersByTimeAsync(120_001);
  expect((await p.info(true)).auth).toEqual(auth);
  for (const task of tasks) busy.live.onMessage({ type: 'system', subtype: 'task_notification', ...task, status: 'completed' });
  await vi.advanceTimersByTimeAsync(3100);
  expect(busy.q.close).toHaveBeenCalledOnce();
});

it('retries an unknown account, coalesces retries, keeps its known row and accepts a real sign-out', async () => {
  start();
  const { account } = await app.call('account.add', { provider: 'claude' });
  const p = app.provider('claude', account.id);
  const answer = (auth: AuthState): ProviderInfo => ({ id: p.id, name: p.name, installed: true, auth });
  const read = vi.spyOn(p, 'info').mockResolvedValue(answer({ loggedIn: false, checking: true }));
  const row = async (force = false) => (await app.providerInfo('claude', force ? account.id : undefined)).accounts!.find(a => a.id === account.id)!.auth;
  expect((await row(true)).checking).toBe(true);
  vi.useFakeTimers();
  const retry = Promise.all([row(), row()]);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await retry)[0].checking).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockResolvedValue(answer({ loggedIn: true, plan: 'Max' }));
  const next = row();
  await vi.advanceTimersByTimeAsync(8000);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2100);
  expect(await next).toEqual({ loggedIn: true, plan: 'Max' });
  await app.call('auth.refresh', { provider: 'claude', accountId: account.id });
  read.mockResolvedValue(answer({ loggedIn: false, checking: true }));
  expect(await row(true)).toEqual({ loggedIn: true, plan: 'Max' });
  read.mockResolvedValue(answer({ loggedIn: false }));
  expect(signedOut(await row(true))).toBe(true);
});

it.each(['cancelled', 'error'] as const)('reports a %s login once with the CLI reason on failure', async state => {
  const events = start();
  const { account } = await app.call('account.add', { provider: 'claude' });
  const params = { provider: 'claude' as const, accountId: account.id };
  let reject!: (err: Error) => void;
  const reason = 'The browser denied this sign-in';
  sdk.mockReturnValueOnce({ claudeAuthenticate: async () => ({ automaticUrl: 'https://example.invalid' }),
    claudeOAuthWaitForCompletion: () => new Promise((_, fail) => { reject = fail; }), close: () => reject(new Error(reason)) });
  await app.call('auth.login', params);
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  if (state === 'cancelled') await app.call('auth.cancel', params);
  else reject(new Error(reason));
  await vi.waitFor(() => expect(states(events)).toEqual(['started', 'url', state]));
  if (state === 'error') expect(events.findLast(e => e.type === 'auth.progress')).toMatchObject({ message: reason });
});

it('reports completion when the six-second identity read expires and the follow-up status is still pending', async () => {
  const events = start();
  const { account } = await app.call('account.add', { provider: 'claude' });
  const params = { provider: 'claude' as const, accountId: account.id };
  const p = app.provider('claude', account.id);
  let finishStatus!: (info: ProviderInfo) => void;
  vi.spyOn(p, 'info').mockImplementation(() => new Promise(resolve => { finishStatus = resolve; }));
  const dialog = { claudeAuthenticate: async () => ({ automaticUrl: 'https://example.invalid' }),
    claudeOAuthWaitForCompletion: async () => {}, reinitialize: vi.fn(() => new Promise(() => {})), close: vi.fn() };
  sdk.mockReturnValueOnce(dialog);
  vi.useFakeTimers();
  await app.call('auth.login', params);
  await vi.advanceTimersByTimeAsync(5999);
  expect(dialog.reinitialize).toHaveBeenCalledOnce();
  expect(dialog.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(states(events)).toEqual(['started', 'url', 'done']);
  expect(dialog.close).toHaveBeenCalledOnce();
  finishStatus({ id: p.id, name: p.name, installed: true, auth: { loggedIn: false, checking: true } });
  await vi.advanceTimersByTimeAsync(1);
  expect(states(events)).toEqual(['started', 'url', 'done']);
  expect(app.accountList('claude').find(a => a.id === account.id)?.label).toBe(account.label);
});

it('reads the completed Codex sign-in on its shared busy server and keeps the last answer on failure', async () => {
  const p = new CodexProvider({ account: { id: 'codex-test', dir }, emit() {}, log() {}, dormant: () => true });
  const read = vi.fn().mockResolvedValue({ account: { type: 'chatgpt', planType: 'plus' } });
  const rpc = { alive: true, hasTurn: true, close: vi.fn(), request: (method: string) => method === 'account/read' ? read() :
    Promise.resolve({ type: 'chatgpt', loginId: 'test', authUrl: 'https://example.invalid' }) };
  Object.assign(p, { rpc });
  const pending = p.login();
  const internal = p as unknown as { pendingLogin?: object; onNotification(method: string, params: object): void };
  await vi.waitFor(() => expect(internal.pendingLogin).toBeDefined());
  internal.onNotification('account/login/completed', { loginId: 'test', success: true });
  await pending;
  expect((await p.info(true)).auth).toMatchObject({ loggedIn: true, plan: 'Plus' });
  expect(read).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 121_000);
  read.mockRejectedValueOnce(new Error('unavailable'));
  expect((await p.info(true)).auth).toMatchObject({ loggedIn: true, plan: 'Plus' });
  read.mockResolvedValue({ account: null, requiresOpenaiAuth: true });
  expect(signedOut((await p.info(true)).auth)).toBe(true);
  expect(rpc.close).not.toHaveBeenCalled();
});
