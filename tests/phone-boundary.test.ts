/**
 * The phone boundary, second review (server/services/phone.ts): an approval the phone gets shortened
 * is marked incomplete and cannot be allowed from the phone; a malformed upgrade target closes only
 * its socket; a phone's new chat is built from an allowlist (never `resume`); questions carry stable
 * ids the phone answers by, and an incomplete or lossy answer is refused; the frame budget counts
 * UTF-8 bytes, an event too big becomes `phone.stale`, and `queue.take` removes nothing it cannot
 * deliver. Demo agent and local sockets only: nothing real is started.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionRequest, PhoneTail, Question } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import { registerFs } from '../server/services/fs';
import { phonePermission, phoneQuestion, registerPhone } from '../server/services/phone';
import { FRAME_MAX } from '../server/services/phone-guard';
import { beside, helloSecure, pairSecure, wireClient } from './phone-wire';

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function setup() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-phone-boundary-'));
  homes.push(home);
  const app = new App({ home, quiet: true, providers: [(ctx) => new DemoProvider(ctx, { speed: 0 })] });
  apps.push(app);
  registerFs(app);
  registerPhone(app, { port: 0, host: '127.0.0.1' });
  const status = await app.call('phone.setEnabled', { on: true });
  expect(status.listening).toBe(true);
  return { app, home, port: status.port };
}

type Frame = Record<string, unknown>;

/** A socket to the endpoint (tests/phone-wire.ts). */
const client = (port: number) => wireClient(port);

/** Pairs a phone over the secure channel (the only way now), "Allow" clicked. */
const pairPhone = (app: App, port: number, name = 'Test phone') => pairSecure(app, port, name);

async function chatIn(app: App, c: ReturnType<typeof client>, cwd: string) {
  mkdirSync(cwd, { recursive: true });
  const created = (await c.call('session.create', { provider: 'demo', cwd })) as { result: PhoneTail };
  return app.sessions.get(created.result.session.id)!;
}

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const eventOf = (f: Frame) => f.event as { type?: string; [k: string]: unknown } | undefined;

// ── 5: approvals the phone gets shortened ──

const grantOptions: PermissionRequest['options'] = [
  { id: 'turn', label: 'Allow for this turn', tone: 'allow' },
  { id: 'session', label: 'Allow for this session', tone: 'always' },
  { id: 'deny', label: 'Decline', tone: 'deny' },
];
const manyFolders = Array.from({ length: 300 }, (_, i) => `C:\\work\\project\\folder-${i}`).join(', ');

describe('an approval the phone gets shortened', () => {
  it('is marked incomplete; one shown whole is not', () => {
    const base = { id: 'p', sessionId: 's', toolName: 'permissions', kind: 'other' as const, title: 'Grant additional permissions?', detail: {}, options: grantOptions, createdAt: 1 };
    expect(phonePermission({ ...base, description: `Write: ${manyFolders}` }).incomplete).toBe(true);
    expect(phonePermission({ ...base, description: 'Write: C:\\work\\project' }).incomplete).toBeUndefined();
    // A long command, a diff with more lines than the phone gets, more options than it lists.
    expect(phonePermission({ ...base, kind: 'bash', detail: { command: `echo ${'x'.repeat(10_000)}` } }).incomplete).toBe(true);
    const hunk = (n: number) => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: n, lines: Array.from({ length: n }, (_, i) => `+line ${i}`) });
    const diff = (hunks: number, lines: number) => [{ path: 'a.ts', status: 'modified' as const, additions: hunks * lines, deletions: 0, hunks: Array.from({ length: hunks }, () => hunk(lines)) }];
    expect(phonePermission({ ...base, kind: 'edit', diff: diff(10, 30) }).incomplete).toBeUndefined();
    expect(phonePermission({ ...base, kind: 'edit', diff: diff(1, 5000) }).incomplete).toBe(true);
    expect(phonePermission({ ...base, options: Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}`, tone: 'allow' as const })) }).incomplete).toBe(true);
    // An edit's whole text is not what the phone shows when the change is there whole.
    expect(phonePermission({ ...base, kind: 'edit', detail: { path: 'a.ts', newText: 'y'.repeat(50_000) }, diff: diff(2, 20) }).incomplete).toBeUndefined();
    expect(phonePermission({ ...base, kind: 'write', detail: { path: 'a.ts', content: 'y'.repeat(50_000) } }).incomplete).toBe(true);
  });

  it('cannot be allowed from the phone; declined it can, and a whole one is allowed', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    const asked = rt.requestPermission({ toolName: 'permissions', kind: 'other', title: 'Grant additional permissions?', description: `Write: ${manyFolders}`, detail: {}, options: grantOptions });
    const got = (await c.next((f) => eventOf(f)?.type === 'permission.added')) as { event: { request: PermissionRequest & { incomplete?: boolean } } };
    expect(got.event.request.incomplete).toBe(true);
    const requestId = got.event.request.id;
    for (const optionId of ['turn', 'session']) {
      const r = await c.call('permission.respond', { sessionId: rt.id, requestId, optionId });
      expect(r.ok, optionId).toBe(false);
      expect(r.error).toMatch(/desktop/);
    }
    expect(rt.prompts().permissions.map((p) => p.id)).toEqual([requestId]);
    expect((await c.call('permission.respond', { sessionId: rt.id, requestId, optionId: 'deny' })).ok).toBe(true);
    expect((await asked)?.optionId).toBe('deny');

    const small = rt.requestPermission({ toolName: 'shell', kind: 'bash', title: 'Run this command?', description: 'ls', detail: { command: 'ls' }, options: grantOptions });
    const second = (await c.next((f) => eventOf(f)?.type === 'permission.added' && (f.event as { request: PermissionRequest }).request.id !== requestId)) as { event: { request: PermissionRequest & { incomplete?: boolean } } };
    expect(second.event.request.incomplete).toBeUndefined();
    expect((await c.call('permission.respond', { sessionId: rt.id, requestId: second.event.request.id, optionId: 'turn' })).ok).toBe(true);
    expect((await small)?.optionId).toBe('turn');
    c.ws.close();
  });
});

// ── 6: a malformed upgrade target ──

describe('an upgrade with a malformed target', () => {
  it('closes only that socket; the endpoint and a paired phone go on', async () => {
    const { app, port } = await setup();
    const { c, token, deviceId, fingerprint } = await pairPhone(app, port);
    for (const target of ['//[', '//[::1', 'http://[x', '//a:b:c']) {
      const answer = await new Promise<string>((resolve) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        });
        let text = '';
        s.on('data', (d) => (text += String(d)));
        s.on('close', () => resolve(text));
        s.on('error', () => resolve(text));
        setTimeout(() => {
          s.destroy();
          resolve(`timeout: ${text}`);
        }, 3000);
      });
      expect(answer, target).toMatch(/^HTTP\/1\.1 4\d\d/);
    }
    expect((await c.call('app.hello')).ok).toBe(true);
    const again = (await helloSecure(port, { deviceId, token, fingerprint })).c;
    expect(await again.next((f) => 'welcome' in f)).toBeTruthy();
    expect((await app.call('phone.status', {})).listening).toBe(true);
    again.ws.close();
    c.ws.close();
  });
});

// ── 7: a new chat from the phone ──

describe('a new chat from the phone', () => {
  it('is built from an allowlist: never resume, a handover or a desktop-only option', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const seen: Record<string, unknown>[] = [];
    const call = app.call.bind(app);
    app.call = ((method: string, params: never) => {
      if (method === 'session.create') seen.push(params);
      return call(method as never, params);
    }) as typeof app.call;
    const cwd = beside(home, 'chat');
    mkdirSync(cwd, { recursive: true });
    const r = (await c.call('session.create', {
      provider: 'demo',
      cwd,
      model: 'demo-fast',
      mode: 'default',
      title: 'From the phone',
      resume: 'someone-elses-thread',
      handoverFrom: 'another-chat',
      ultracode: true,
      options: { remoteControl: false, browserTab: true, computerUse: true },
      lane: { slug: 'x' },
      bogus: 1,
    })) as { ok: boolean; result: PhoneTail };
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]).sort()).toEqual(['cwd', 'mode', 'model', 'options', 'provider', 'title']);
    expect(seen[0].options).toEqual({ remoteControl: false });
    const meta = app.sessions.get(r.result.session.id)!.meta;
    expect(meta.providerSessionId).not.toBe('someone-elses-thread');
    expect(meta.ultracode).toBeUndefined();
    // Fields of the wrong kind are refused, not passed on.
    expect((await c.call('session.create', { provider: 'demo', cwd: 42 })).ok).toBe(false);
    expect((await c.call('session.create', { provider: 'demo', cwd, chat: { text: 5 } })).ok).toBe(false);
    c.ws.close();
  });
});

// ── 19: questions answered by id ──

const long = `Which of these should change? ${'Context the agent wrote at length. '.repeat(200)}`;
const questions = (): Question[] => [
  { question: long, header: 'Scope', options: [{ label: 'Only the login page' }, { label: 'The whole settings area' }] },
  { question: 'Ship it today?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false },
];

describe('questions on the phone', () => {
  it('carry stable ids for questions and options, the words for display only', () => {
    const q = phoneQuestion({ id: 'r1', sessionId: 's', questions: questions(), createdAt: 1 });
    expect(q.questions.map((x) => x.id)).toEqual(['q0', 'q1']);
    expect(q.questions[1].options.map((o) => o.id)).toEqual(['o0', 'o1']);
    expect(q.incomplete).toBeUndefined();
    const many = phoneQuestion({ id: 'r2', sessionId: 's', questions: Array.from({ length: 13 }, (_, i) => ({ question: `Q${i}?`, options: [{ label: 'a' }] })), createdAt: 1 });
    expect(many.incomplete).toBe(true);
    const wide = phoneQuestion({ id: 'r3', sessionId: 's', questions: [{ question: 'Pick', options: Array.from({ length: 30 }, (_, i) => ({ label: `opt ${i}` })) }], createdAt: 1 });
    expect(wide.incomplete).toBe(true);
  });

  it('are answered by id into the original keys; incomplete or lossy answers are refused', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    const asked = rt.ask(questions());
    const got = (await c.next((f) => eventOf(f)?.type === 'question.added')) as { event: { request: ReturnType<typeof phoneQuestion> } };
    const req = got.event.request;
    expect(req.questions[0].question.length).toBeLessThan(long.length);
    expect(req.questions[0].cut).toBe(true);
    const answer = (picks: unknown) => c.call('phone.answer', { sessionId: rt.id, requestId: req.id, picks });
    // A question left out, an unknown id, two picks for a single answer, nothing picked: refused, the question still waits.
    for (const bad of [{ q0: { options: ['o1'] } }, { q0: { options: ['o9'] }, q1: { options: ['o0'] } }, { q0: { options: ['o0'] }, q1: { options: ['o0', 'o1'] } }, { q0: { options: ['o0'] }, q1: {} }, { q0: { options: ['o0'] }, q1: { options: ['o0'] }, q7: { options: ['o0'] } }]) {
      const r = await answer(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    // The old shape keyed by the words the phone showed (shortened here): refused, never answered with nothing.
    const old = await c.call('question.respond', { sessionId: rt.id, requestId: req.id, answers: { [req.questions[0].question]: ['Only the login page'], 'Ship it today?': ['Yes'] } });
    expect(old.ok).toBe(false);
    expect(rt.prompts().questions.map((q) => q.id)).toEqual([req.id]);
    const ok = await answer({ q0: { options: ['o1'] }, q1: { other: 'Tomorrow morning' } });
    expect(ok.ok).toBe(true);
    expect(await asked).toEqual({ [long]: ['The whole settings area'], 'Ship it today?': ['Tomorrow morning'] });
    c.ws.close();
  });

  it('the old shape still answers a question the phone got whole; skipping still works', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    const asked = rt.ask([{ question: 'Ship it today?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    const got = (await c.next((f) => eventOf(f)?.type === 'question.added')) as { event: { request: { id: string } } };
    expect((await c.call('question.respond', { sessionId: rt.id, requestId: got.event.request.id, answers: { 'Something else?': ['Yes'] } })).ok).toBe(false);
    expect((await c.call('question.respond', { sessionId: rt.id, requestId: got.event.request.id, answers: { 'Ship it today?': ['Yes'] } })).ok).toBe(true);
    expect(await asked).toEqual({ 'Ship it today?': ['Yes'] });
    const skipped = rt.ask([{ question: 'Another?', options: [{ label: 'Yes' }] }]);
    const second = (await c.next((f) => eventOf(f)?.type === 'question.added' && (f.event as { request: { id: string } }).request.id !== got.event.request.id)) as { event: { request: { id: string } } };
    expect((await c.call('question.respond', { sessionId: rt.id, requestId: second.event.request.id, answers: null })).ok).toBe(true);
    expect(await skipped).toBeNull();
    c.ws.close();
  });

  it('an incomplete questionnaire cannot be answered from the phone', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    void rt.ask(Array.from({ length: 13 }, (_, i) => ({ question: `Question ${i}?`, options: [{ label: 'Yes' }] })));
    const got = (await c.next((f) => eventOf(f)?.type === 'question.added')) as { event: { request: ReturnType<typeof phoneQuestion> } };
    expect(got.event.request.incomplete).toBe(true);
    const picks = Object.fromEntries(got.event.request.questions.map((q) => [q.id, { options: ['o0'] }]));
    const r = await c.call('phone.answer', { sessionId: rt.id, requestId: got.event.request.id, picks });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/desktop/);
    expect(rt.prompts().questions).toHaveLength(1);
    c.ws.close();
  });
});

// ── 20: the frame budget in bytes, invalidation, queue.take ──

describe('the frame budget', () => {
  it('counts UTF-8 bytes: an event under the budget in characters but over it in bytes is not sent', async () => {
    const { app, port } = await setup();
    const { c } = await pairPhone(app, port);
    const cjk = '漢'.repeat(Math.floor(FRAME_MAX.event / 2));
    expect(cjk.length).toBeLessThan(FRAME_MAX.event);
    expect(Buffer.byteLength(cjk)).toBeGreaterThan(FRAME_MAX.event);
    app.emit({ type: 'toast', level: 'info', text: cjk });
    app.emit({ type: 'toast', level: 'info', text: 'small' });
    await c.next((f) => eventOf(f)?.text === 'small');
    expect(c.frames.some((f) => typeof eventOf(f)?.text === 'string' && (eventOf(f)!.text as string).length > 1000)).toBe(false);
    c.ws.close();
  });

  it('an event too big for the phone becomes phone.stale for its chat, so the phone fetches it', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    app.emit({ type: 'todos.updated', sessionId: rt.id, todos: [{ content: 'x'.repeat(FRAME_MAX.event + 100), status: 'pending' }] });
    const stale = await c.next((f) => eventOf(f)?.type === 'phone.stale');
    expect(eventOf(stale)).toEqual({ type: 'phone.stale', sessionId: rt.id, of: 'todos.updated' });
    expect(c.frames.some((f) => eventOf(f)?.type === 'todos.updated')).toBe(false);
    // A queued message that long reaches the phone's list cut, and its tail stays within budget.
    rt.enqueue('y'.repeat(FRAME_MAX.event + 100));
    const q = await c.next((f) => eventOf(f)?.type === 'queue.updated');
    expect(((eventOf(q)!.queue as { text: string }[])[0]).text.length).toBeLessThan(10_000);
    c.ws.close();
  });

  it('queue.take removes nothing when its reply cannot go to the phone', async () => {
    const { app, port, home } = await setup();
    const { c } = await pairPhone(app, port);
    const rt = await chatIn(app, c, beside(home, 'chat'));
    // Under the result budget in characters, over it in bytes.
    const q = rt.enqueue('漢'.repeat(Math.ceil(FRAME_MAX.result / 2.9)));
    const r = await c.call('queue.take', { sessionId: rt.id, id: q.id }, 15_000);
    expect(r.ok).toBe(false);
    expect(rt.queue.map((m) => m.id)).toEqual([q.id]);
    // A message that fits is taken and comes back.
    const small = rt.enqueue('small one');
    const ok = (await c.call('queue.take', { sessionId: rt.id, id: small.id })) as { ok: boolean; result: { message: { text: string } } };
    expect(ok.ok).toBe(true);
    expect(ok.result.message.text).toBe('small one');
    await until(() => rt.queue.length === 1);
    expect(rt.queue.map((m) => m.id)).toEqual([q.id]);
    c.ws.close();
  }, 30_000);
});
