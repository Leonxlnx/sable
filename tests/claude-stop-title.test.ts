/**
 * Claude Code answers each message of the person's with a result of its own, and a steer can keep a
 * turn going past one. Two things that broke there (review wave 2, #10 and #11):
 * - A message whose result failed while a steer kept the turn going named the chat once the steer's
 *   result settled it: the title model got the failed message. Only a message the agent answered ok
 *   names a chat.
 * - Stopping while a steer was still unread left the chat on "Thinking" for good: the interrupt's result
 *   named the running message, the steer kept the turn, and Claude Code never read it. A stop holds
 *   through the turn's end: unread steers go back to the queue and their bookkeeping goes.
 * The bridge with the real Claude Code adapter; its process replaced by a fake SDK stream (nothing starts).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { ClaudeProvider } from '../server/providers/claude';
import type { ProviderSession } from '../server/providers/types';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await tick(5);
  }
}

type Session = Record<string, unknown> & ProviderSession;

async function claudeApp() {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-stop-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const asked: string[] = [];
  const pushed: { uuid: string; priority?: string; message: { content: unknown } }[] = [];
  const interrupts: number[] = [];
  const sessions: Session[] = [];
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    providers: [
      (ctx) => {
        const p = new ClaudeProvider(ctx);
        const any = p as unknown as Record<string, unknown>;
        any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
        any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
        any.limits = async () => [];
        any.readLimits = async () => [];
        p.quickTitle = async (prompt) => (asked.push(prompt.user), 'A title');
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Session;
          // The SDK query and its input, faked: what is sent is recorded, nothing starts.
          s.ensure = function (this: Record<string, unknown>) {
            this.q ??= { interrupt: async () => void interrupts.push(Date.now()), close: () => {} };
            this.input ??= { push: (m: (typeof pushed)[number]) => pushed.push(m), end: () => {} };
            return this.q;
          };
          sessions.push(s);
          return s as unknown as ProviderSession;
        };
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'claude', cwd, mode: 'default' });
  const id = snap.session.id;
  const rt = app.runtime(id);
  const message = (m: Record<string, unknown>) => (sessions[0].onMessage as (m: unknown) => void).call(sessions[0], { session_id: 'cc1', ...m });
  const send = async (text: string, steer = false) => {
    const n = pushed.length;
    await app.call('session.send', { sessionId: id, text, ...(steer ? { steer: true } : {}) });
    await until(() => pushed.length > n, `"${text}" sent`);
    return pushed.at(-1)!.uuid;
  };
  const replay = (uuid: string, content: string) => message({ type: 'user', isReplay: true, uuid, parent_tool_use_id: null, message: { role: 'user', content } });
  const text = (t: string) => message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: t }] } });
  const result = (uuids: string[], failed = false) =>
    message({
      type: 'result',
      subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed,
      ...(failed ? { errors: ['Tool execution failed'] } : {}),
      duration_ms: 10,
      usage: {},
      total_cost_usd: 0,
      user_message_uuids: uuids,
      user_message_uuid: uuids.at(-1),
    });
  const state = (s: 'idle' | 'running') => message({ type: 'system', subtype: 'session_state_changed', state: s, uuid: `st-${Math.random()}` });
  const users = () => rt.items.filter((i): i is UserItem => i.type === 'user');
  return { app, id, rt, asked, pushed, interrupts, message, send, replay, text, result, state, users };
}

describe('a chat is named only from a message its agent answered ok', () => {
  it('a message whose result failed while a steer kept the turn going never names the chat; the steer does', async () => {
    const h = await claudeApp();
    const a = await h.send('Rename the billing tab to payments');
    h.replay(a, 'Rename the billing tab to payments');
    const b = await h.send('Fix the login button that does nothing', true);
    // The first message's own result fails; the steer, not read yet, keeps the turn.
    h.result([a], true);
    expect(h.rt.turnActive).toBe(true);
    h.replay(b, 'Fix the login button that does nothing');
    h.text('The login button now submits the form.');
    h.result([b]);
    await until(() => !h.rt.turnActive, 'turn end');
    await until(() => h.asked.length === 1, 'title asked');
    expect(h.asked[0]).toContain('Fix the login button that does nothing');
    expect(h.asked[0]).not.toContain('billing');
  });
});

describe('a stop with a steer Claude Code has not read', () => {
  it("settles when the interrupt's result names only the running message: the steer goes back to the queue", async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    await h.send('and keep the old exports', true);
    await h.app.call('session.interrupt', { sessionId: h.id });
    expect(h.interrupts).toHaveLength(1);
    // Claude Code stops the running message and drops the steer it never read.
    h.result([a], true);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).toBe('idle');
    expect(h.rt.meta.activity).toBeUndefined();
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports']);
    expect(h.users().map((u) => u.text)).toEqual(['Refactor the session module']);
    expect(h.rt.items.some((i) => i.type === 'notice' && (i as NoticeItem).variant === 'interrupted')).toBe(true);
    // Nothing of the steer is left waiting in the adapter: the next message runs and ends as usual.
    const c = await h.send('just the refactor then');
    h.replay(c, 'just the refactor then');
    h.result([c]);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.meta.status).toBe('idle');
  });

  it('settles at once when Claude Code only says it is idle', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    await h.send('and keep the old exports', true);
    await h.app.call('session.interrupt', { sessionId: h.id });
    h.state('idle');
    // Not after the 2.5 s safety net: at the idle.
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports']);
  });

  it('a withdrawn steer Claude Code reads after all is taken out of the queue, never sent twice', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    const b = await h.send('and keep the old exports', true);
    await h.app.call('session.interrupt', { sessionId: h.id });
    h.result([a], true);
    expect(h.rt.queue).toHaveLength(1);
    const sent = h.pushed.length;
    // It had it after all: it reads the steer and answers it.
    h.replay(b, 'and keep the old exports');
    expect(h.rt.queue).toHaveLength(0);
    expect(h.rt.turnActive).toBe(true);
    expect(h.users().map((u) => [u.text, u.state])).toEqual([
      ['Refactor the session module', 'sent'],
      ['and keep the old exports', 'sent'],
    ]);
    h.text('The old exports stay.');
    h.result([b]);
    expect(h.rt.turnActive).toBe(false);
    await tick(30);
    expect(h.pushed).toHaveLength(sent);
    expect(h.rt.queue).toHaveLength(0);
  });
});
