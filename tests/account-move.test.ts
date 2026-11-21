/**
 * A chat keeps its head when it changes account: a big chat compacts on the account it leaves (when
 * that account can still run a turn), the switch line says what the move did to the context, the
 * first message after the move carries a short bounded note, and the agent-switch handover is
 * bounded and complete. The Demo agent and fakes built on it; temporary folders only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, NoticeItem, TimelineItem, Todo, ToolItem, UserItem } from '@shared/protocol';
import { parseSynthetic } from '@shared/synthetic';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext, ProviderSession } from '../server/providers/types';
import type { SessionRuntime } from '../server/core/runtime';
import { handoverText } from '../server/accounts/handover';
import { bigContext, changedFiles, COMPACT_OPENER, compactThreshold, contextClause, lastUnanswered, moveNote, shortTokens } from '../server/core/move-context';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

async function until(pred: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

type CompactMode = 'ok' | 'fail' | 'hang' | 'gate';
interface Sent {
  text: string;
  /** The account folder the send went to ('' for the built-in account). */
  home: string;
}

/**
 * The Demo agent recording every send and the account it went to; its `/compact` can fail, hang
 * (never end until stopped) or wait for the test (`gate`).
 */
class MoveDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private log: { sent: Sent[]; mode: CompactMode; release?: () => void },
  ) {
    super(ctx, { speed: 0 });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    const interrupt = s.interrupt.bind(s);
    let held = false;
    s.send = async (item) => {
      this.log.sent.push({ text: item.text, home: this.configHome() });
      if (item.text !== '/compact' || this.log.mode === 'ok') return send(item);
      if (this.log.mode === 'fail') throw new Error('compaction refused');
      rt.beginTurn('Running /compact');
      held = true;
      if (this.log.mode === 'gate') {
        this.log.release = () => {
          held = false;
          rt.notice('compact', 'Conversation compacted', '740k → 40k tokens');
          rt.update({ usage: { ...rt.meta.usage, contextTokens: 40_000 } });
          rt.endTurn();
        };
      }
    };
    s.interrupt = async () => {
      if (held) {
        held = false;
        rt.settle('cancelled');
        rt.notice('interrupted', 'Interrupted');
        rt.endTurn();
        return;
      }
      return interrupt();
    };
    return s;
  }
}

function start(opts: { mode?: CompactMode; compactTimeoutMs?: number } = {}) {
  const log: { sent: Sent[]; mode: CompactMode; release?: () => void } = { sent: [], mode: opts.mode ?? 'ok' };
  const home = temp('sable-move-');
  const app = new App({ home, providers: [(ctx) => new MoveDemo(ctx, log)], quiet: true, userHome: temp('sable-move-user-'), compactTimeoutMs: opts.compactTimeoutMs });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(e));
  return { app, home, log, events };
}

async function demoAccount(app: App, label: string, profile: 'calm' | 'cap' | 'near' | 'light') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');
const infoLines = (items: TimelineItem[]) => notices(items).filter((n) => n.variant === 'info');

/** A chat on `from` that answered once, then grew to `tokens` of a 1M window. */
async function bigChat(app: App, home: string, from: string, tokens = 740_000) {
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: from });
  const rt = app.runtime(snap.session.id);
  await app.call('session.send', { sessionId: rt.id, text: 'hi' });
  await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
  rt.update({ usage: { ...rt.meta.usage, contextTokens: tokens, contextWindow: 1_000_000 } });
  return rt;
}

// ───────────────────────────── the pure parts ─────────────────────────────

describe('when a chat is big', () => {
  it('is 150k tokens, or 40% of a smaller window', () => {
    expect(compactThreshold(1_000_000)).toBe(150_000);
    expect(compactThreshold(200_000)).toBe(80_000);
    expect(compactThreshold(undefined)).toBe(150_000);
    expect(bigContext(149_999, 1_000_000)).toBe(false);
    expect(bigContext(150_000, 1_000_000)).toBe(true);
    expect(bigContext(90_000, 200_000)).toBe(true);
    expect(bigContext(undefined, 200_000)).toBe(false);
  });

  it('says tokens the way the ring does, and words each outcome plainly', () => {
    expect(shortTokens(740_123)).toBe('740k');
    expect(shortTokens(38_400)).toBe('38k');
    expect(shortTokens(1_200_000)).toBe('1.2M');
    expect(contextClause({ kind: 'compacted', before: 740_000, after: 38_000 })).toEqual({ suffix: ' · context 740k → 38k' });
    expect(contextClause({ kind: 'compacted', before: 740_000 })).toEqual({ suffix: ' · context compacted' });
    expect(contextClause({ kind: 'asIs', tokens: 740_000 })).toEqual({ detail: 'The next message reads all 740k tokens again' });
    expect(contextClause({ kind: 'asIs', tokens: 740_000 }, true)).toEqual({ detail: 'Carrying on reads all 740k tokens again' });
    expect(contextClause({ kind: 'notCompacted', tokens: 740_000 })).toEqual({ detail: 'Could not compact first, so the next message reads all 740k tokens again' });
    expect(contextClause({ kind: 'plain' })).toEqual({});
  });

  it('hides the compaction opener in the conversation', () => {
    expect(parseSynthetic(COMPACT_OPENER)?.role).toBe('hidden');
  });
});

describe('the note after a move', () => {
  const user = (id: string, text: string): UserItem => ({ id, ts: 1, type: 'user', text, state: 'sent' });
  const reply = (id: string, text: string): TimelineItem => ({ id, ts: 1, type: 'text', text, streaming: false });

  it('quotes the last message that has no answer, and none once answered', () => {
    expect(lastUnanswered([user('u1', 'fix it'), reply('a1', 'done')])).toBeUndefined();
    expect(lastUnanswered([user('u1', 'fix it'), reply('a1', 'done'), user('u2', 'and the docs?')])?.id).toBe('u2');
    // What a harness wrote in the person's place is not their question.
    expect(lastUnanswered([user('u1', 'fix it'), user('u2', '<system-reminder>x</system-reminder>')])?.id).toBe('u1');
  });

  it('is bounded whatever the chat holds', () => {
    const todos: Todo[] = Array.from({ length: 30 }, (_, i) => ({ content: `Step ${i} ${'x'.repeat(400)}`, status: i === 0 ? 'in_progress' : i % 5 === 4 ? 'completed' : 'pending' }));
    const items: TimelineItem[] = [];
    for (let i = 0; i < 5000; i++) items.push(user(`u${i}`, `question ${i}`), reply(`a${i}`, 'y'.repeat(2000)));
    items.push(user('last', `Why does the importer drop rows? ${'z'.repeat(20_000)}`));
    const note = moveNote(items, todos);
    expect(note.length).toBeLessThan(1800);
    expect(note.startsWith('<system-reminder>\nThis conversation moved to another account')).toBe(true);
    expect(note).toContain('Nothing else changed: the same folder, the same files.');
    expect(note).toContain('"Why does the importer drop rows?');
    expect(note).toContain('(in progress)');
    expect(note).toMatch(/- and \d+ more/);
    expect(note.endsWith('</system-reminder>')).toBe(true);
    // The message about to go out is never quoted back.
    expect(moveNote(items, [], { skip: 'last' })).not.toContain('importer');
  });
});

describe('the agent-switch handover', () => {
  it('stays within its budget for a huge chat, keeps the task as last put, the todos and the files changed', () => {
    const items: TimelineItem[] = [];
    for (let i = 0; i < 3000; i++) {
      items.push({ id: `u${i}`, ts: i, type: 'user', text: `ask ${i}`, state: 'sent' });
      items.push({ id: `a${i}`, ts: i, type: 'text', text: 'w'.repeat(3000), streaming: false });
    }
    items.push({ id: 'task', ts: 1, type: 'user', text: 'Port the importer to streams and keep the CLI flags', state: 'sent' });
    // A long turn after it: many long replies and edits, more than the budget holds.
    for (let i = 0; i < 40; i++) {
      items.push({ id: `r${i}`, ts: 1, type: 'text', text: `Progress ${i} ${'p'.repeat(1200)}`, streaming: false });
      items.push({ id: `e${i}`, ts: 1, type: 'tool', name: 'Edit', kind: 'edit', title: `Edit f${i}.ts`, status: 'done', detail: { path: `/w/app/src/f${i}.ts` } } as ToolItem);
    }
    const todos: Todo[] = [
      { content: 'Stream the parser', status: 'completed' },
      { content: 'Keep the CLI flags', status: 'in_progress' },
      { content: 'Update the docs', status: 'pending' },
    ];
    const files = changedFiles(items, '/w/app');
    expect(files[0]).toBe('src/f0.ts');
    expect(files).toHaveLength(40);
    const text = handoverText(items, { from: 'Claude Code', maxChars: 4500, todos, files });
    expect(text.length).toBeLessThanOrEqual(4500 + 200);
    expect(text).toContain('User: Port the importer to streams and keep the CLI flags');
    expect(text).toContain('(earlier messages left out)');
    expect(text).toContain('Open todos:\n- Keep the CLI flags (in progress)\n- Update the docs');
    expect(text).not.toContain('Stream the parser');
    expect(text).toMatch(/Files changed: src\/f0\.ts, src\/f1\.ts, .*, and 25 more/);
    // In order: the task before what came after it.
    expect(text.indexOf('User: Port the importer')).toBeLessThan(text.indexOf('Agent: Progress 39'));
  });

  it('reads sub-agents’ edits and diffs for the files changed', () => {
    const items: TimelineItem[] = [
      { id: 't1', ts: 1, type: 'tool', name: 'apply_patch', kind: 'edit', title: 'Edit 2 files', status: 'done', detail: { path: 'C:\\w\\a.ts' }, result: { diff: [{ path: 'C:\\w\\a.ts', status: 'modified', additions: 1, deletions: 0, hunks: [] }, { path: 'C:\\w\\lib\\b.ts', status: 'added', additions: 1, deletions: 0, hunks: [] }] } } as unknown as ToolItem,
      { id: 't2', ts: 1, parentId: 'agent', type: 'tool', name: 'Write', kind: 'write', title: 'Write c.ts', status: 'done', detail: { path: 'C:/w/c.ts' } } as ToolItem,
      { id: 't3', ts: 1, type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit d.ts', status: 'error', detail: { path: 'C:/w/d.ts' } } as ToolItem,
    ];
    expect(changedFiles(items, 'C:\\w')).toEqual(['a.ts', 'lib/b.ts', 'c.ts']);
  });
});

// ───────────────────────────── the moves ─────────────────────────────

describe('moving a chat to another account', () => {
  it('a big chat compacts on the account it leaves, then moves, and says so', async () => {
    const { app, home, log } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id);
    log.sent.length = 0;
    const res = await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    expect(res).toMatchObject({ ok: true, compacting: true });
    await until(() => rt.meta.accountId === work.id, 'the move');
    // `/compact` went to the old account, where the cache is warm.
    expect(log.sent).toEqual([{ text: '/compact', home: studio.dir }]);
    // The compaction's own line, and the switch line with the context before and after.
    expect(notices(rt.items).some((n) => n.variant === 'compact')).toBe(true);
    const line = infoLines(rt.items).pop()!;
    expect(line.text).toMatch(/^Continued with Work · context 740k → \d+k$/);
    expect(line.detail).toBeUndefined();
    // The "Compacting before the move" line went with the compaction; the opener stays hidden.
    expect(infoLines(rt.items).some((n) => n.text.startsWith('Compacting before the move'))).toBe(false);
    const opener = rt.items.find((i): i is UserItem => i.type === 'user' && i.text === COMPACT_OPENER);
    expect(opener).toBeDefined();
    // The ring reads the compacted context at once.
    expect(rt.meta.usage.contextTokens).toBeLessThan(50_000);
    expect(rt.meta.status).toBe('idle');

    // The next message goes to the new account with the note, once.
    await app.call('session.send', { sessionId: rt.id, text: 'hello there' });
    await until(() => log.sent.length === 2, 'the next send');
    expect(log.sent[1].home).toBe(work.dir);
    expect(log.sent[1].text).toMatch(/^hello there\n\n<system-reminder>\nThis conversation moved to another account/);
    await until(() => rt.meta.status === 'idle', 'idle');
    await app.call('session.send', { sessionId: rt.id, text: 'thanks' });
    await until(() => log.sent.length === 3, 'third send');
    expect(log.sent[2].text).toBe('thanks');
    // The person sees only what they typed.
    expect(rt.items.filter((i): i is UserItem => i.type === 'user' && !parseSynthetic(i.text)).map((u) => u.text)).toEqual(['hi', 'hello there', 'thanks']);
  });

  it('a small chat just moves', async () => {
    const { app, home, log } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id, 60_000);
    log.sent.length = 0;
    const res = await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    expect(res).toEqual({ ok: true, carried: 'conversation' });
    expect(log.sent).toEqual([]);
    expect(infoLines(rt.items).pop()).toMatchObject({ text: 'Continued with Work' });
    expect(infoLines(rt.items).pop()!.detail).toBeUndefined();
    expect(rt.meta.usage.contextTokens).toBe(60_000);
  });

  it('a chat at its limit moves as it is, and says the next message reads it all again', async () => {
    const { app, home, log } = start();
    const capped = await demoAccount(app, 'Studio', 'cap');
    const work = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: capped.id });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => notices(rt.items).some((n) => n.limit?.provider), 'limit notice');
    rt.update({ usage: { ...rt.meta.usage, contextTokens: 740_000, contextWindow: 1_000_000 } });
    log.sent.length = 0;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true });
    await until(() => rt.items.some((i) => i.type === 'text') && rt.meta.status === 'idle', 'answer under Work');
    // No compaction on an account that cannot run a turn: the refused message goes again, with the note.
    expect(log.sent.map((s) => s.text.split('\n')[0])).toEqual(['hi']);
    expect(log.sent[0].home).toBe(work.dir);
    expect(log.sent[0].text).toContain('<system-reminder>\nThis conversation moved to another account');
    const line = infoLines(rt.items).pop()!;
    expect(line).toMatchObject({ text: 'Carried as it is', detail: 'Carrying on reads all 740k tokens again' });
    expect(notices(rt.items).find((n) => n.limit)!.limit!.continuedWith).toBe(work.id);
  });

  it('moves on its own at a limit as it is (Continue at a limit on)', async () => {
    const { app, home, log } = start();
    await app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const capped = await demoAccount(app, 'Studio', 'cap');
    const work = await demoAccount(app, 'Work', 'light');
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: capped.id });
    const rt = app.runtime(snap.session.id);
    rt.update({ usage: { ...rt.meta.usage, contextTokens: 740_000, contextWindow: 1_000_000 } });
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.meta.accountId === work.id && rt.items.some((i) => i.type === 'text') && rt.meta.status === 'idle', 'automatic continue');
    expect(log.sent.some((s) => s.text === '/compact')).toBe(false);
    expect(infoLines(rt.items).pop()).toMatchObject({ detail: 'Carrying on reads all 740k tokens again' });
  });

  it('a failed compaction still moves, and says it could not compact', async () => {
    const { app, home, log } = start({ mode: 'fail' });
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id);
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => rt.meta.accountId === work.id, 'the move');
    expect(log.sent.some((s) => s.text === '/compact' && s.home === studio.dir)).toBe(true);
    expect(infoLines(rt.items).pop()).toMatchObject({ text: 'Continued with Work', detail: 'Could not compact first, so the next message reads all 740k tokens again' });
    // Nothing of the attempt is left: no opener, no status line, no running turn; the ring keeps its count.
    expect(rt.items.some((i) => i.type === 'user' && i.text === COMPACT_OPENER)).toBe(false);
    expect(rt.turnActive).toBe(false);
    expect(rt.meta.usage.contextTokens).toBe(740_000);
  });

  it('a compaction that takes too long is stopped, and the chat moves as it is', async () => {
    const { app, home } = start({ mode: 'hang', compactTimeoutMs: 60 });
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id);
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => rt.meta.accountId === work.id, 'the move');
    expect(rt.turnActive).toBe(false);
    expect(rt.meta.status).toBe('idle');
    expect(infoLines(rt.items).pop()).toMatchObject({ text: 'Continued with Work', detail: 'Could not compact first, so the next message reads all 740k tokens again' });
  });

  it('a message sent while it compacts waits, then goes to the new account; no second move meanwhile', async () => {
    const { app, home, log } = start({ mode: 'gate' });
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id);
    log.sent.length = 0;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => !!log.release, 'compaction running');
    expect(infoLines(rt.items).pop()!.text).toBe('Compacting before the move to Work');
    expect(rt.meta.status).toBe('running');
    // Sent while it compacts (as a steer too): it waits in the queue, never reaching the old account.
    const r1 = await app.call('session.send', { sessionId: rt.id, text: 'and the docs?', steer: true });
    expect(r1.ok).toBe(true);
    expect(rt.queue.map((q) => q.text)).toEqual(['and the docs?']);
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: studio.id })).rejects.toThrow(/still working|moving/);
    log.release!();
    await until(() => rt.meta.accountId === work.id, 'the move');
    await until(() => log.sent.length === 2, 'the queued message');
    expect(log.sent[1].home).toBe(work.dir);
    expect(log.sent[1].text.startsWith('and the docs?\n\n<system-reminder>')).toBe(true);
    expect(infoLines(rt.items).filter((n) => n.text.startsWith('Continued with Work')).pop()!.text).toBe('Continued with Work · context 740k → 40k');
    expect(rt.meta.usage.contextTokens).toBeLessThan(740_000);
  });

  it('a big chat past its cap compacts there (it can still run a turn), then moves with the cap line', { timeout: 15_000 }, async () => {
    const { app, home, log } = start();
    const studio = await demoAccount(app, 'Studio', 'near');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id);
    log.sent.length = 0;
    // Studio's weekly is at 74%: a 70% cap is reached; the next message moves the chat first.
    await app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    await app.call('session.send', { sessionId: rt.id, text: 'hello again' });
    expect(rt.meta.accountId).toBe(work.id);
    expect(log.sent[0]).toEqual({ text: '/compact', home: studio.dir });
    await until(() => log.sent.length === 2, 'the message under Work');
    expect(log.sent[1].home).toBe(work.dir);
    expect(log.sent[1].text).toContain('<system-reminder>\nThis conversation moved');
    expect(infoLines(rt.items).find((n) => n.text.startsWith('Moved to Work'))!.text).toMatch(/^Moved to Work: Studio reached its 70% cap · context 740k → \d+k$/);
  });

  it('a new conversation with a summary empties the ring until its first turn', async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id, 60_000);
    // The conversation cannot be carried: a summary starts a new one.
    (app as unknown as { provider: (p: string, a: string) => DemoProvider }).provider('demo', work.id).adoptConversation = async () => false;
    const res = await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    expect(res.carried).toBe('summary');
    expect(rt.meta.usage.contextTokens).toBeUndefined();
  });

  it('a slash command after a move leaves the note for the next message', async () => {
    const { app, home, log } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await bigChat(app, home, studio.id, 60_000);
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    log.sent.length = 0;
    await app.call('session.send', { sessionId: rt.id, text: '/context' });
    await until(() => log.sent.length === 1 && rt.meta.status === 'idle', 'the command');
    expect(log.sent[0].text).toBe('/context');
    await app.call('session.send', { sessionId: rt.id, text: 'go on' });
    await until(() => log.sent.length === 2, 'the next message');
    expect(log.sent[1].text).toContain('<system-reminder>\nThis conversation moved');
  });
});
