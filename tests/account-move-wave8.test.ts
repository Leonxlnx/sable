/**
 * Review wave 8, account moves: a chat never shows one account while its agent runs on another
 * (#10); the compaction deadline bounds the whole move and a transcript that may still be written is
 * never copied (#11); Stop, a close and a phone's removal keep their effect during a move (#21); the
 * note and the summary after a move go only with a message the agent took, and survive a restart
 * (#22). The Demo agent and fakes built on it; temporary folders only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoticeItem, TimelineItem, ToolItem } from '@shared/protocol';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext, ProviderSession } from '../server/providers/types';
import type { SessionRuntime } from '../server/core/runtime';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose().catch(() => {});
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};

async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Ctl {
  sent: { text: string; home: string }[];
  /** `/compact`: ends when released (`gate`), never ends and ignores Stop (`stall`), or runs (`ok`). */
  compact: 'ok' | 'gate' | 'stall';
  release?: () => void;
  /** The next opens wait for this (one per open), when set. */
  openGate?: Promise<void>;
  /** The next ordinary sends fail (as many as this). */
  failSends: number;
  adopted: number;
}

class Demo8 extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private ctl: Ctl,
  ) {
    super(ctx, { speed: 0 });
  }
  override async adoptConversation(): Promise<boolean> {
    this.ctl.adopted++;
    return super.adoptConversation();
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    if (this.ctl.openGate) await this.ctl.openGate;
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    const interrupt = s.interrupt.bind(s);
    let held: 'gate' | 'stall' | undefined;
    const home = this.configHome();
    s.send = async (item, o) => {
      this.ctl.sent.push({ text: item.text, home });
      if (item.text === '/compact' && this.ctl.compact !== 'ok') {
        rt.beginTurn('Running /compact');
        held = this.ctl.compact;
        this.ctl.release = () => {
          held = undefined;
          rt.notice('compact', 'Conversation compacted', '740k → 40k tokens');
          rt.update({ usage: { ...rt.meta.usage, contextTokens: 40_000 } });
          rt.endTurn();
        };
        return;
      }
      if (item.text !== '/compact' && this.ctl.failSends > 0) {
        this.ctl.failSends--;
        throw new Error('the agent refused the message');
      }
      return send(item, o);
    };
    s.interrupt = async () => {
      if (held === 'stall') return;
      if (held === 'gate') {
        held = undefined;
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

function start(home = temp('sable-move8-'), opts: { compactTimeoutMs?: number; ctl?: Ctl } = {}) {
  const ctl: Ctl = opts.ctl ?? { sent: [], compact: 'ok', failSends: 0, adopted: 0 };
  const app = new App({ home, providers: [(ctx) => new Demo8(ctx, ctl)], quiet: true, userHome: temp('sable-move8-user-'), compactTimeoutMs: opts.compactTimeoutMs });
  apps.push(app);
  return { app, home, ctl };
}

async function demoAccount(app: App, label: string, profile: 'calm' | 'cap' | 'near' | 'light') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id });
  return account;
}

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');

async function chat(app: App, home: string, from: string, tokens = 60_000) {
  const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: from });
  const rt = app.runtime(snap.session.id);
  await app.call('session.send', { sessionId: rt.id, text: 'hi' });
  await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
  rt.update({ usage: { ...rt.meta.usage, contextTokens: tokens, contextWindow: 1_000_000 } });
  return rt;
}

describe('one account at a time (review wave 8, #10)', () => {
  it('a move is refused while the agent is still starting, and a handle that comes up after a move is never installed', async () => {
    const { app, home, ctl } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id);
    // The agent goes away (a restart would do the same); the next message starts it again, slowly.
    await rt.handle!.close();
    rt.handle = undefined;
    let open!: () => void;
    ctl.openGate = new Promise<void>((r) => (open = r));
    ctl.sent.length = 0;
    const sending = app.call('session.send', { sessionId: rt.id, text: 'next' });
    await until(() => rt.meta.status === 'starting', 'starting');
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).rejects.toThrow(/still starting/);
    expect(rt.meta.accountId).toBe(studio.id);
    // Whatever moves the account meanwhile, the start that began on Studio is not the chat's.
    rt.update({ accountId: work.id });
    ctl.openGate = undefined;
    open();
    await sending;
    await until(() => ctl.sent.length === 1, 'the message');
    expect(ctl.sent[0]).toMatchObject({ text: 'next', home: work.dir });
  });

  it('a move is refused while background work runs in the process it would close', async () => {
    const { app, home } = start();
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id);
    const step = rt.add<ToolItem>({ type: 'tool', name: 'Task', kind: 'agent', detail: 'helper', status: 'done', result: { agent: { background: 'running' } } } as unknown as Omit<ToolItem, 'id' | 'ts'>);
    await expect(app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).rejects.toThrow(/Background work/);
    expect(rt.meta.accountId).toBe(studio.id);
    rt.patch<ToolItem>(step.id, { result: { agent: { background: 'done' } } });
    expect(await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).toMatchObject({ ok: true });
    expect(rt.meta.accountId).toBe(work.id);
  });
});

describe('the compaction deadline bounds the whole move (review wave 8, #11)', () => {
  it('a compaction that does not stop when asked: the move ends in time, and its transcript is not copied', async () => {
    const { app, home, ctl } = start(undefined, { compactTimeoutMs: 80 });
    ctl.compact = 'stall';
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id, 740_000);
    ctl.adopted = 0;
    const t0 = Date.now();
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => rt.meta.accountId === work.id, 'the move', 3000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ctl.adopted).toBe(0);
    expect(notices(rt.items).pop()).toMatchObject({ text: 'New conversation with Work', detail: 'With a summary of the conversation so far' });
    expect(rt.turnActive).toBe(false);
    // The next message carries the summary.
    ctl.sent.length = 0;
    await app.call('session.send', { sessionId: rt.id, text: 'go on' });
    await until(() => ctl.sent.length === 1, 'the next message');
    expect(ctl.sent[0].home).toBe(work.dir);
    expect(ctl.sent[0].text).toMatch(/User: hi[\s\S]*---\n\ngo on/);
  });

  it('a compaction stopped in time is carried as it is', async () => {
    const { app, home, ctl } = start(undefined, { compactTimeoutMs: 80 });
    ctl.compact = 'gate';
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id, 740_000);
    ctl.adopted = 0;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => rt.meta.accountId === work.id, 'the move', 3000);
    expect(ctl.adopted).toBe(1);
    expect(notices(rt.items).pop()).toMatchObject({ text: 'Continued with Work' });
  });
});

describe('Stop, a close and a removed phone during a move (review wave 8, #21)', () => {
  it('Stop while a send compacts before its cap move: the message starts no turn and waits in the queue', { timeout: 15_000 }, async () => {
    const { app, home, ctl } = start();
    ctl.compact = 'gate';
    const studio = await demoAccount(app, 'Studio', 'near');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id, 740_000);
    await app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    ctl.sent.length = 0;
    const sending = app.call('session.send', { sessionId: rt.id, text: 'hello again' });
    await until(() => !!ctl.release && rt.turnActive, 'compacting');
    await app.call('session.interrupt', { sessionId: rt.id });
    await sending;
    await until(() => rt.meta.accountId === work.id, 'the move');
    await new Promise((r) => setTimeout(r, 100));
    expect(ctl.sent.map((s) => s.text)).toEqual(['/compact']);
    expect(rt.queue.map((q) => q.text)).toEqual(['hello again']);
  });

  it('a message a phone queued during the move is not sent once that phone was removed', async () => {
    const { app, home, ctl } = start();
    ctl.compact = 'gate';
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id, 740_000);
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => !!ctl.release, 'compacting');
    let paired = true;
    await app.call('session.send', { sessionId: rt.id, text: 'from the phone' }, { allowed: () => paired });
    expect(rt.queue.map((q) => q.text)).toEqual(['from the phone']);
    paired = false;
    ctl.sent.length = 0;
    ctl.release!();
    await until(() => rt.meta.accountId === work.id, 'the move');
    await until(() => notices(rt.items).some((n) => n.text === 'A message from a removed phone was not sent'), 'the line');
    expect(ctl.sent).toEqual([]);
    expect(rt.queue).toEqual([]);
  });

  it('a chat deleted during the move: nothing is copied and nothing moves', async () => {
    const { app, home, ctl } = start();
    ctl.compact = 'gate';
    const studio = await demoAccount(app, 'Studio', 'light');
    const work = await demoAccount(app, 'Work', 'light');
    const rt = await chat(app, home, studio.id, 740_000);
    ctl.adopted = 0;
    await app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => !!ctl.release, 'compacting');
    await app.call('session.close', { sessionId: rt.id, remove: true });
    ctl.release!();
    await new Promise((r) => setTimeout(r, 150));
    expect(ctl.adopted).toBe(0);
    expect(rt.meta.accountId).toBe(studio.id);
  });
});

describe('the note and the summary go only with a message the agent took (review wave 8, #22)', () => {
  it('a send that fails keeps them for the next message, and a restart keeps the summary', async () => {
    const home = temp('sable-move8-');
    const ctl: Ctl = { sent: [], compact: 'ok', failSends: 0, adopted: 0 };
    const first = start(home, { ctl });
    const studio = await demoAccount(first.app, 'Studio', 'light');
    const work = await demoAccount(first.app, 'Work', 'light');
    const rt = await chat(first.app, home, studio.id);
    (first.app as unknown as { provider: (p: string, a: string) => DemoProvider }).provider('demo', work.id).adoptConversation = async () => false;
    expect((await first.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).carried).toBe('summary');
    expect(rt.meta.moveNote?.summary).toBeDefined();
    // The first message after the move never reaches the agent.
    ctl.failSends = 1;
    ctl.sent.length = 0;
    await first.app.call('session.send', { sessionId: rt.id, text: 'one' });
    await until(() => ctl.sent.length === 1 && rt.meta.status !== 'running', 'the failed send');
    expect(ctl.sent[0].text).toMatch(/User: hi/);
    expect(rt.meta.moveNote?.summary).toBeDefined();

    // Sable restarts: the summary is still there for the next message.
    await first.app.dispose();
    apps.splice(apps.indexOf(first.app), 1);
    const second = start(home, { ctl });
    const again = second.app.runtime(rt.id);
    expect(again.meta.moveNote?.summary).toBeDefined();
    ctl.sent.length = 0;
    // The Demo picks its scenario from the person's words alone (the summary before them is Sable's): a greeting is quick.
    await second.app.call('session.send', { sessionId: rt.id, text: 'hi two' });
    await until(() => ctl.sent.length === 1, 'the next message');
    expect(ctl.sent[0].home).toBe(work.dir);
    expect(ctl.sent[0].text).toMatch(/User: hi[\s\S]*---\n\nhi two\n\n<system-reminder>\nThis conversation moved/);
    await until(() => again.meta.status === 'idle', 'idle');
    expect(again.meta.moveNote).toBeNull();
  });
});
