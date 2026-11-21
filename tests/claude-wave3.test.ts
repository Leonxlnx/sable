/**
 * Claude Code turns after a stop and a failed message (review wave 3):
 * - #8: a chat's title gets the start of the answer to the message that names it: only text of the
 *   result that answered it ok, never the final text of a message that failed before it.
 * - #9: a steer withdrawn at a stop that Claude Code reads late keeps what was sent (the timeline shows
 *   what it read, not a later edit in the queue), and its turn never lifts the hold the stop put on
 *   the queue: nothing queued goes out without the person.
 * - #14: the safety net of one stop never ends a newer turn.
 * The bridge with the real Claude Code adapter; its process replaced by a fake SDK stream (nothing starts).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextItem, TimelineItem, TurnItem, UserItem } from '@shared/protocol';
import { App } from '../server/app';
import { titleAsk } from '../server/core/titles';
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
  const home = mkdtempSync(path.join(tmpdir(), 'sable-claude-w3-'));
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
  const stop = () => app.call('session.interrupt', { sessionId: id });
  const users = () => rt.items.filter((i): i is UserItem => i.type === 'user');
  return { app, id, rt, asked, pushed, interrupts, send, replay, text, result, stop, users };
}

describe('#8: the answer a title is named with is the one the successful result gave', () => {
  it("never the final text of a message that failed, written after the steer's row", async () => {
    const h = await claudeApp();
    const a = await h.send('Rename the billing tab to payments');
    h.replay(a, 'Rename the billing tab to payments');
    const b = await h.send('Fix the login button that does nothing', true);
    // The first message's final text comes after the steer's row; then its result fails.
    h.text('Renamed the billing tab in the sidebar.');
    h.result([a], true);
    h.replay(b, 'Fix the login button that does nothing');
    h.text('The login button now submits the form.');
    h.result([b]);
    await until(() => !h.rt.turnActive, 'turn end');
    await until(() => h.asked.length === 1, 'title asked');
    expect(h.asked[0]).toContain('Fix the login button that does nothing');
    expect(h.asked[0]).toContain('The login button now submits the form.');
    expect(h.asked[0]).not.toContain('billing');
  });

  it('takes only the texts between the result before and the one that answered; none when that is not known', () => {
    const it = (i: Partial<TimelineItem> & { id: string; type: string }) => ({ ts: 1, ...i }) as TimelineItem;
    const items: TimelineItem[] = [
      it({ id: 'u1', type: 'user', text: 'First message', state: 'sent' } as Partial<UserItem> & { id: string; type: string }),
      it({ id: 'u2', type: 'user', text: 'The steer', state: 'sent', steered: true } as Partial<UserItem> & { id: string; type: string }),
      it({ id: 't1', type: 'text', text: 'Answer to the first.' } as Partial<TextItem> & { id: string; type: string }),
      it({ id: 'r1', type: 'turn', error: 'failed' } as Partial<TurnItem> & { id: string; type: string }),
      it({ id: 't2', type: 'text', text: 'Answer to the steer.' } as Partial<TextItem> & { id: string; type: string }),
      it({ id: 'r2', type: 'turn' } as Partial<TurnItem> & { id: string; type: string }),
    ];
    expect(titleAsk(items, ['u2'], (id) => (id === 'u2' ? 'r2' : undefined))).toMatchObject({ itemId: 'u2', answer: 'Answer to the steer.' });
    // Answered, but by no result of its own: which text is its answer is not known, so none goes.
    expect(titleAsk(items, ['u2'], () => null)).toMatchObject({ itemId: 'u2', answer: '' });
    // Its result is no longer in the chat (rewound): none either.
    expect(titleAsk(items, ['u2'], () => 'gone')).toMatchObject({ answer: '' });
    // An agent that reports no outcome per message: the turn's rule, as before.
    expect(titleAsk(items, ['u1'])).toMatchObject({ itemId: 'u1', answer: '' });
  });
});

describe('#9: a steer read after a stop', () => {
  it('shows what Claude Code read, keeps an edited copy queued, and lifts no hold: nothing queued goes out', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    const b = await h.send('and keep the old exports', true);
    await h.send('and add tests', true);
    await h.stop();
    h.result([a], true);
    expect(h.rt.turnActive).toBe(false);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports', 'and add tests']);
    // The person edits the first one while it waits in the queue.
    await h.app.call('queue.update', { sessionId: h.id, id: h.rt.queue[0].id, text: 'and keep the old exports for one release' });
    const sent = h.pushed.length;
    // Claude Code had the original after all.
    h.replay(b, 'and keep the old exports');
    expect(h.rt.turnActive).toBe(true);
    expect(h.users().map((u) => [u.text, u.state])).toEqual([
      ['Refactor the session module', 'sent'],
      ['and keep the old exports', 'sent'],
    ]);
    // The edit is the person's newer words: it stays in the queue, with the other one.
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports for one release', 'and add tests']);
    h.text('The old exports stay.');
    h.result([b]);
    expect(h.rt.turnActive).toBe(false);
    await tick(60);
    // The stop's hold holds: nothing went out without the person.
    expect(h.pushed).toHaveLength(sent);
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and keep the old exports for one release', 'and add tests']);
  });

  it('an unchanged copy is taken out of the queue (never sent twice), and the next message the person sends lifts the hold', async () => {
    const h = await claudeApp();
    const a = await h.send('Refactor the session module');
    h.replay(a, 'Refactor the session module');
    const b = await h.send('and keep the old exports', true);
    await h.send('and add tests', true);
    await h.stop();
    h.result([a], true);
    h.replay(b, 'and keep the old exports');
    expect(h.rt.queue.map((q) => q.text)).toEqual(['and add tests']);
    // The person writes into the running turn: the hold is theirs to lift.
    const d = await h.send('also update the changelog', true);
    h.result([b]);
    h.replay(d, 'also update the changelog');
    h.result([d]);
    expect(h.rt.turnActive).toBe(false);
    await until(() => h.pushed.some((p) => JSON.stringify(p.message.content).includes('and add tests')), 'the queued message sent');
  });
});

describe("#14: a stop's safety net belongs to its own turn", () => {
  it("one stop's late safety net never ends the next turn, stopped soon after", async () => {
    const h = await claudeApp();
    const a = await h.send('first');
    h.replay(a, 'first');
    const t0 = Date.now();
    await h.stop();
    // Its result comes at once: the first turn is over.
    h.result([a], true);
    expect(h.rt.turnActive).toBe(false);
    const b = await h.send('second');
    h.replay(b, 'second');
    await tick(900);
    await h.stop();
    expect(h.rt.turnActive).toBe(true);
    // Past the first stop's 2.5 s, before the second's: the second turn still waits for its own end.
    await tick(Math.max(0, 2700 - (Date.now() - t0)));
    expect(h.rt.turnActive).toBe(true);
    // Its own safety net still ends it when its result never comes.
    await until(() => !h.rt.turnActive, 'the second stop settles', 3000);
  }, 10_000);
});
