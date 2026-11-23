/**
 * Account moves are stable (day 6, D-moves and the app's half of D-lost): a move never closes a
 * process under a turn (one the agent began by itself too) or a message on its way; a move Sable
 * makes by itself waits for work in the background (a young command, a sub-agent) and goes once it
 * ended; a move the person asks for goes ahead beside a command, says what was lost and the agent
 * hears it once; a return never compacts; a compaction that overran is carried whole once the
 * process says it exited; Remote Control comes back after a move, paced; a failed automatic move
 * leaves nothing behind and says so; the silent second send after a refused sign-in waits while the
 * agent still works (C5); a chat Sable closed under says "Ended early" where its turn stopped.
 * The Demo agent and fakes built on it; temporary folders only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type NoticeItem, type ProviderId, type SessionOptions, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import { AUTH_FAILURE_TEXT, parseSynthetic, stripWrappers } from '@shared/synthetic';
import { App, NotNow } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
import type { Provider, ProviderContext, ProviderSession } from '../server/providers/types';
import { lostLine, type SessionRuntime } from '../server/core/runtime';
import { lostClause, moveNote } from '../server/core/move-context';
import { noteAuthFailure, resetAuthFailures } from '../server/core/auth-gate';

const temps: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose().catch(() => {});
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  resetAuthFailures();
});

const temp = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), name));
  temps.push(dir);
  return dir;
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await tick(5);
  }
}

type Live = ReturnType<NonNullable<ProviderSession['liveWork']>>;

interface Ctl {
  /** Every message an agent was given: the account folder its process runs on, and the chat's account then. */
  sent: { text: string; home: string; chat: string; account: string }[];
  /** Every process opened and closed, by chat and account folder. */
  opened: { chat: string; home: string }[];
  closed: { chat: string; home: string }[];
  /** `/compact`: runs (`ok`), or never ends and ignores Stop (`stall`). */
  compact: 'ok' | 'stall';
  /** Whether a session says when its process exited, and how. */
  exited?: 'ok' | 'reject';
  /** A close ends what ran in the background in the process (as Claude Code's does). */
  stopsBackground?: boolean;
  /** A close cuts the turn its process ran and loses its commands, said once (as Claude Code's does). */
  closeCuts?: boolean;
}

/** The Demo, recording what each process was given and when it opened and closed. */
class MoveDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private ctl: Ctl,
  ) {
    super(ctx, { speed: 0 });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const home = this.configHome();
    this.ctl.opened.push({ chat: rt.id, home });
    const send = s.send.bind(s);
    const close = s.close.bind(s);
    const interrupt = s.interrupt.bind(s);
    let held = false;
    s.send = async (item, o) => {
      this.ctl.sent.push({ text: item.text, home, chat: rt.id, account: rt.meta.accountId ?? DEFAULT_ACCOUNT });
      if (item.text === '/compact' && this.ctl.compact === 'stall') {
        rt.beginTurn('Running /compact');
        held = true;
        return;
      }
      return send(item, o);
    };
    s.interrupt = async () => {
      if (held) return;
      return interrupt();
    };
    s.close = async () => {
      this.ctl.closed.push({ chat: rt.id, home });
      if (this.ctl.stopsBackground) rt.stopBackground();
      if (this.ctl.closeCuts) {
        const lost = rt.tasksLost('process');
        if (rt.turnActive) rt.cutTurn('closed');
        if (lost.length) rt.notice('info', lostLine(lost.length, 'process'), lost.join('\n'));
      }
      return close();
    };
    if (this.ctl.exited) s.exited = () => (this.ctl.exited === 'ok' ? Promise.resolve() : Promise.reject(new Error('still writing')));
    return s;
  }
}

function start(ctl: Partial<Ctl> = {}, opts: { compactTimeoutMs?: number; home?: string } = {}) {
  const home = opts.home ?? temp('sable-moves-');
  const c: Ctl = { sent: [], opened: [], closed: [], compact: 'ok', ...ctl };
  const app = new App({ home, providers: [(cx) => new MoveDemo(cx, c)], quiet: true, userHome: temp('sable-moves-user-'), compactTimeoutMs: opts.compactTimeoutMs });
  apps.push(app);
  return { app, home, ctl: c };
}
type H = ReturnType<typeof start>;

async function demoAccount(app: App, label: string, profile: 'calm' | 'cap' | 'near' | 'light') {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id, force: true });
  return account;
}

async function twoAccounts(h: H, studioProfile: 'light' | 'near' = 'light') {
  return { studio: await demoAccount(h.app, 'Studio', studioProfile), work: await demoAccount(h.app, 'Work', 'light') };
}

async function chat(h: H, accountId: string, opts: { tokens?: number; options?: SessionOptions } = {}) {
  const snap = await h.app.call('session.create', { provider: 'demo', cwd: path.join(h.home, 'p'), accountId, mode: 'bypassPermissions', ...(opts.options ? { options: opts.options } : {}) });
  const rt = h.app.runtime(snap.session.id);
  await h.app.call('session.send', { sessionId: rt.id, text: 'hi' });
  await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
  if (opts.tokens) rt.update({ usage: { ...rt.meta.usage, contextTokens: opts.tokens, contextWindow: 1_000_000 } });
  h.ctl.sent.length = 0;
  return rt;
}

/** A Bash step that left a command running in the agent's process (as Claude Code's task events say), begun `ageMs` ago. */
function command(rt: SessionRuntime, name: string, task: string, ageMs = 0) {
  const step = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: name, status: 'done', detail: { command: 'pnpm test', description: name, background: true } } as Omit<ToolItem, 'id' | 'ts'>);
  rt.taskStarted(step.id, { id: task, kind: 'command' });
  if (ageMs) rt.patch<ToolItem>(step.id, { task: { ...rt.get<ToolItem>(step.id)!.task!, since: Date.now() - ageMs } });
  return step;
}

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');
const lastNotice = (rt: SessionRuntime) => notices(rt.items).pop();

type Internals = {
  checkCap(rt: SessionRuntime): Promise<void>;
  knownLimits(provider: ProviderId): Promise<unknown>;
  applyDue(rt: SessionRuntime, handle: ProviderSession): Promise<void>;
  removingAccounts: Set<string>;
  fallbacks: Map<string, unknown>;
};
const internals = (app: App) => app as unknown as Internals;

/** The chat owes the return to Studio (a limit moved it to Work) and Studio has room again. */
async function owingReturn(h: H, opts: { tokens?: number } = {}) {
  const { studio, work } = await twoAccounts(h);
  const rt = await chat(h, work.id, opts);
  rt.update({ movedFrom: studio.id, returnAt: Date.now() - 1 });
  return { rt, studio, work };
}

describe('a move Sable makes by itself waits for work in the background (D1, E3)', { timeout: 20_000 }, () => {
  it('the return to the account a limit left waits for a young background command, and goes once it ended', async () => {
    const h = start();
    const { rt, studio, work } = await owingReturn(h);
    command(rt, 'Run app tests', 'b1');
    expect(rt.meta.commands).toBe(1);
    await h.app.returnAfterLimit(rt);
    // Nothing moved, nothing closed: the tests the agent waits on run on.
    expect(rt.meta.accountId).toBe(work.id);
    expect(rt.meta.movedFrom).toBe(studio.id);
    expect(h.ctl.closed).toHaveLength(0);
    // Word of its end: the chat is at rest, and goes back by itself.
    rt.taskEnded('b1', 'done');
    await until(() => (rt.meta.accountId ?? DEFAULT_ACCOUNT) === studio.id, 'the return once the command ended');
    expect(lastNotice(rt)).toMatchObject({ text: 'Back on Studio' });
    expect(rt.meta.movedFrom).toBeUndefined();
  });

  it('an older command (a server) does not hold it: the chat goes back, the command is lost and said so, and the agent hears it once', async () => {
    const h = start();
    const { rt, studio } = await owingReturn(h);
    const step = command(rt, 'Serve the app', 'b2', 31 * 60_000);
    await h.app.returnAfterLimit(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    // Lost with the process the move closed, never "ended": it may still run.
    expect(rt.get<ToolItem>(step.id)!.task).toMatchObject({ state: 'lost', why: 'move' });
    expect(rt.meta.commands).toBe(0);
    expect(lastNotice(rt)).toMatchObject({ text: 'Back on Studio · 1 background command lost', detail: 'Lost when the chat moved: Serve the app' });
    // The next message tells the agent, after the person's words; the chat shows only those.
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => h.ctl.sent.length === 1, 'the message');
    const text = h.ctl.sent[0].text;
    expect(text.startsWith('hi there\n\nSable lost track of these background tasks')).toBe(true);
    expect(text).toContain('"Serve the app" (command, task b2)');
    // The move's note no longer says that nothing else changed.
    expect(text).toContain('<system-reminder>\nThis conversation moved to another account of the same person, in the same folder with the same files.');
    expect(text).not.toContain('Nothing else changed');
    expect(stripWrappers(text)).toBe('hi there');
    expect((rt.items.filter((i) => i.type === 'user').pop() as UserItem).text).toBe('hi there');
    // Once.
    await until(() => rt.meta.status === 'idle', 'idle');
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    await until(() => h.ctl.sent.length === 2, 'the second message');
    expect(h.ctl.sent[1].text).toBe('hi again');
  });

  it('a cap move waits for a young command too, and goes once the chat is at rest', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    command(rt, 'Run app tests', 'b1');
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(h.ctl.closed).toHaveLength(0);
    rt.taskEnded('b1', 'failed');
    await until(() => rt.meta.accountId === work.id, 'the cap move at rest');
    expect(lastNotice(rt)!.text).toMatch(/^Moved to Work: /);
    // It happened: where it goes back is written now.
    expect(rt.meta.movedFrom).toBe(studio.id);
  });
});

describe('a move the person asks for', { timeout: 20_000 }, () => {
  it('goes ahead beside a background command: the switch line names it, the agent hears it with its next message', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const step = command(rt, 'Run app tests', 'b1');
    expect(await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).toMatchObject({ ok: true, carried: 'conversation' });
    expect(rt.meta.accountId).toBe(work.id);
    expect(rt.get<ToolItem>(step.id)!.task).toMatchObject({ state: 'lost', why: 'move' });
    expect(lastNotice(rt)).toMatchObject({ text: 'Continued with Work · 1 background command lost', detail: 'Lost when the chat moved: Run app tests' });
    await h.app.call('session.send', { sessionId: rt.id, text: 'hello there' });
    await until(() => h.ctl.sent.length === 1, 'the message');
    expect(h.ctl.sent[0]).toMatchObject({ home: work.dir });
    expect(h.ctl.sent[0].text).toContain('"Run app tests" (command, task b1)');
    expect(parseSynthetic(h.ctl.sent[0].text)).toBeNull();
    expect(stripWrappers(h.ctl.sent[0].text)).toBe('hello there');
  });

  it('is never made under a turn the agent began meanwhile: it backs out with nothing changed (D2)', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id, { tokens: 740_000 });
    const before = rt.handle;
    // The move reads the limits (whether the old account can compact first); meanwhile a
    // notification wakes the agent.
    const known = internals(h.app).knownLimits.bind(h.app);
    let release!: () => void;
    let asked = false;
    const gate = new Promise<void>((r) => (release = r));
    internals(h.app).knownLimits = async (p) => ((asked = true), await gate, known(p));
    const moving = h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => asked, 'the move under way');
    rt.beginTurn('Thinking', { keepHold: true });
    release();
    await expect(moving).rejects.toThrow(NotNow);
    await expect(moving).rejects.toThrow(/still working/);
    // Nothing closed, nothing compacted, the turn still the agent's, the chat not moving any more.
    expect(rt.handle).toBe(before);
    expect(h.ctl.closed).toHaveLength(0);
    expect(h.ctl.sent).toHaveLength(0);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.moving).toBe(false);
    expect(rt.turnActive).toBe(true);
    expect(notices(rt.items).some((n) => /^Compacting/.test(n.text))).toBe(false);
    // Once that turn ended, the move is made.
    rt.endTurn();
    internals(h.app).knownLimits = known;
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await until(() => rt.meta.accountId === work.id, 'the move');
  });

  it("a turn only the agent knows of (its own word, liveWork) holds it too", async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    let live: Live = { turn: true, agents: 0, commands: 0 };
    (rt.handle as ProviderSession).liveWork = () => live;
    await expect(h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).rejects.toThrow(/still working/);
    expect(h.ctl.closed).toHaveLength(0);
    live = { turn: false, agents: 0, commands: 0 };
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    expect(rt.meta.accountId).toBe(work.id);
  });

  it('waits for a message on its way to the agent: the message goes to the account the chat is on (D6)', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const due = internals(h.app).applyDue.bind(h.app);
    let release!: () => void;
    let readying = false;
    const gate = new Promise<void>((r) => (release = r));
    internals(h.app).applyDue = async (r, handle) => ((readying = true), await gate, due(r, handle));
    const sending = h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    await until(() => readying, 'the message on its way');
    const moving = h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id }).then(
      () => 'moved',
      (err) => (err instanceof NotNow ? 'refused' : `failed: ${(err as Error).message}`),
    );
    await tick(60);
    // The move waits: nothing was closed under the message.
    expect(h.ctl.closed).toHaveLength(0);
    release();
    await sending;
    expect(['moved', 'refused']).toContain(await moving);
    // The message went to the account the chat was on when it went, never to one it was leaving.
    expect(h.ctl.sent).toHaveLength(1);
    const [m] = h.ctl.sent;
    expect(m.account).toBe(studio.id);
    expect(m.home).toBe(studio.dir);
  });

  it('shows the chat as moving for as long as the move runs, a compaction first included (D8)', async () => {
    const h = start({ compact: 'stall' }, { compactTimeoutMs: 300 });
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id, { tokens: 740_000 });
    const said: (boolean | undefined)[] = [];
    h.app.subscribe((e) => {
      if (e.type === 'session.updated' && e.id === rt.id && 'moving' in e.patch) said.push(e.patch.moving);
    });
    // The window's answer comes as the compaction starts; the move goes on.
    expect(await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id })).toMatchObject({ compacting: true });
    expect(rt.meta.moving).toBe(true);
    await until(() => rt.meta.accountId === work.id, 'the move');
    expect(rt.meta.moving).toBe(false);
    expect(said).toEqual([true, false]);
  });
});

describe('after a move', { timeout: 20_000 }, () => {
  it('a chat whose Remote Control was live gets its process back on the new account, one chat at a time, never one closed meanwhile (D3)', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const a = await chat(h, studio.id, { options: { remoteControl: true } });
    const b = await chat(h, studio.id, { options: { remoteControl: true } });
    expect(a.meta.remote?.url).toBeTruthy();
    h.ctl.opened.length = 0;
    await h.app.call('session.switchAccount', { sessionId: a.id, accountId: work.id });
    await h.app.call('session.switchAccount', { sessionId: b.id, accountId: work.id });
    // The first is opened again at once, on the account it moved to, with no message from the desktop.
    await until(() => !!a.handle && h.ctl.opened.some((o) => o.chat === a.id), "a's process");
    expect(h.ctl.opened.filter((o) => o.chat === a.id)).toEqual([{ chat: a.id, home: work.dir }]);
    expect(h.ctl.sent).toHaveLength(0);
    // The second waits its turn (a reset returns many chats at once); closed meanwhile, it is not started.
    expect(h.ctl.opened.some((o) => o.chat === b.id)).toBe(false);
    await h.app.call('session.close', { sessionId: b.id });
    await tick(3600);
    expect(h.ctl.opened.some((o) => o.chat === b.id)).toBe(false);
    expect(b.handle).toBeUndefined();
  });

  it('a return never compacts by itself (moves-M1): the line says the next message reads the conversation again', async () => {
    const h = start();
    const { rt, studio } = await owingReturn(h, { tokens: 740_000 });
    await h.app.returnAfterLimit(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(h.ctl.sent.map((s) => s.text)).not.toContain('/compact');
    expect(lastNotice(rt)).toMatchObject({ text: 'Back on Studio', detail: 'The next message reads all 740k tokens again' });
  });

  it('a compaction that overran is carried whole once the process says it exited (D7); one whose exit is not confirmed stays behind (moves-M3)', async () => {
    for (const exited of ['ok', 'reject'] as const) {
      const h = start({ compact: 'stall', exited }, { compactTimeoutMs: 80 });
      const { studio, work } = await twoAccounts(h);
      const rt = await chat(h, studio.id, { tokens: 740_000 });
      await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
      await until(() => rt.meta.accountId === work.id, 'the move', 3000);
      if (exited === 'ok') {
        expect(lastNotice(rt)).toMatchObject({ text: 'Continued with Work', detail: 'Could not compact first, so the next message reads all 740k tokens again' });
        expect(rt.meta.providerSessionId).toBeTruthy();
      } else {
        expect(lastNotice(rt)).toMatchObject({ text: 'New conversation with Work', detail: 'With a summary of the conversation so far' });
        expect(rt.meta.providerSessionId).toBeUndefined();
      }
      expect(rt.turnActive).toBe(false);
    }
  });
});

describe('a move Sable makes by itself that fails (D5)', { timeout: 20_000 }, () => {
  it('leaves nothing behind (where it goes back, where new chats start) and says so', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    internals(h.app).removingAccounts.add(`demo:${work.id}`);
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.movedFrom).toBeUndefined();
    expect(rt.meta.returnAt).toBeUndefined();
    expect(internals(h.app).fallbacks.has('demo')).toBe(false);
    expect(lastNotice(rt)).toMatchObject({ variant: 'error', level: 'warn', text: 'Could not move to Work', detail: expect.stringMatching(/being removed/) });
  });
});

describe('the switch of agent', { timeout: 20_000 }, () => {
  /** The Demo as `id` (a second agent stands in for Codex). */
  function fake(id: ProviderId, name: string, sent: { provider: ProviderId; text: string }[]) {
    return (ctx: ProviderContext): Provider => {
      const p = new DemoProvider(ctx, { speed: 0 });
      Object.assign(p, { id, name });
      const open = p.open.bind(p);
      p.open = async (rt, opts) => {
        const s = await open(rt, opts);
        const send = s.send.bind(s);
        s.send = async (item) => {
          sent.push({ provider: id, text: item.text });
          return send(item);
        };
        return s;
      };
      return p as unknown as Provider;
    };
  }

  it('goes ahead beside a background command, which is lost with the process and said so; a turn the agent says it runs holds it', async () => {
    const home = temp('sable-moves-switch-');
    const cwd = temp('sable-moves-switch-cwd-');
    const sent: { provider: ProviderId; text: string }[] = [];
    const app = new App({ home, providers: [fake('demo', 'Demo', sent), fake('codex', 'Codex', sent)], quiet: true });
    apps.push(app);
    const snap = await app.call('session.create', { provider: 'demo', cwd, mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
    (rt.handle as ProviderSession).liveWork = () => ({ turn: true, agents: 0, commands: 0 });
    await expect(app.call('session.switchAgent', { sessionId: rt.id, provider: 'codex' })).rejects.toThrow(/still working/);
    expect(rt.meta.provider).toBe('demo');
    (rt.handle as ProviderSession).liveWork = () => ({ turn: false, agents: 0, commands: 1 });
    const step = command(rt, 'Run app tests', 'b1');
    expect(await app.call('session.switchAgent', { sessionId: rt.id, provider: 'codex' })).toMatchObject({ ok: true });
    expect(rt.get<ToolItem>(step.id)!.task).toMatchObject({ state: 'lost', why: 'process' });
    expect(lastNotice(rt)).toMatchObject({ text: "1 background command was lost with the agent's process", detail: 'Run app tests' });
    sent.length = 0;
    await app.call('session.send', { sessionId: rt.id, text: 'hey there' });
    await until(() => sent.length === 1, 'the message');
    expect(sent[0].provider).toBe('codex');
    expect(sent[0].text).toContain('"Run app tests" (command, task b1)');
  });
});

describe('the silent second send after a refused sign-in (C5)', { timeout: 20_000 }, () => {
  interface Log {
    sent: string[];
    refuse: number;
  }
  /** The Demo, whose sends can be refused for the sign-in as Claude Code's are. */
  class AuthDemo extends DemoProvider {
    constructor(
      ctx: ProviderContext,
      private log: Log,
    ) {
      super(ctx, { speed: 0 });
    }
    override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
      const s = await super.open(rt, opts);
      const send = s.send.bind(s);
      s.send = async (item, o) => {
        this.log.sent.push(item.text);
        if (this.log.refuse <= 0) return send(item, o);
        this.log.refuse--;
        rt.beginTurn('Thinking');
        noteAuthFailure(rt.id);
        setTimeout(() => rt.endTurn(AUTH_FAILURE_TEXT), 0);
      };
      return s;
    }
  }

  async function refused() {
    const log: Log = { sent: [], refuse: 0 };
    const home = temp('sable-moves-auth-');
    const app = new App({ home, providers: [(ctx) => new AuthDemo(ctx, log)], quiet: true, userHome: temp('sable-moves-auth-user-'), refreshDelays: { info: 60_000, caps: 60_000, signIn: 10 } });
    apps.push(app);
    const { account } = await app.call('account.add', { provider: 'demo', label: 'Ultra1' });
    writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: 'ultra1@example.dev', plan: 'Max', limits: 'calm' }));
    await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p'), accountId: account.id });
    const rt = app.runtime(snap.session.id);
    await until(() => !!rt.handle, 'the agent');
    return { app, log, rt };
  }

  it('waits while the agent still works, and a turn that begins meanwhile is the agent taking the message: nothing goes twice', async () => {
    const { app, log, rt } = await refused();
    // Another request of the process was refused; the agent still holds the message and works on.
    (rt.handle as ProviderSession).liveWork = () => ({ turn: true, agents: 0, commands: 0 });
    log.refuse = 1;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => log.sent.length === 1 && !rt.turnActive, 'the refusal');
    await tick(300);
    expect(log.sent).toEqual(['hi there']);
    // Its sign-in renewed, the agent runs the message by itself.
    rt.beginTurn('Thinking', { keepHold: true });
    (rt.handle as ProviderSession).liveWork = () => ({ turn: true, agents: 0, commands: 0 });
    await tick(300);
    expect(log.sent).toEqual(['hi there']);
  });

  it('goes again once the agent says it is not working', async () => {
    const { app, log, rt } = await refused();
    let working = true;
    (rt.handle as ProviderSession).liveWork = () => ({ turn: working, agents: 0, commands: 0 });
    log.refuse = 1;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => log.sent.length === 1 && !rt.turnActive, 'the refusal');
    await tick(200);
    expect(log.sent).toEqual(['hi there']);
    working = false;
    await until(() => log.sent.length === 2, 'the second send');
    expect(log.sent).toEqual(['hi there', 'hi there']);
  });
});

describe('a turn Sable closed under', { timeout: 20_000 }, () => {
  it('says "Ended early" once the chat is read again, at the time of its last item; a chat at rest says nothing', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const working = await chat(h, studio.id);
    const resting = await chat(h, studio.id);
    // Sable goes down while a turn runs: a step in flight, the status saved as running.
    working.beginTurn('Thinking');
    const step = working.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run app tests', status: 'running', detail: { command: 'pnpm test' } } as Omit<ToolItem, 'id' | 'ts'>);
    working.update({ status: 'running' });
    const last = working.get(step.id)!.ts;
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const next = start({}, { home: h.home });
    await next.app.call('session.snapshot', { sessionId: working.id });
    const rt = next.app.runtime(working.id);
    const cut = rt.items.filter((i): i is NoticeItem => i.type === 'notice' && !!i.early);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ text: 'Ended early', early: 'restart', ts: last });
    expect(rt.get<ToolItem>(step.id)!.status).toBe('cancelled');
    expect(rt.meta.status).toBe('idle');
    // Read again in the same run: no second line.
    await next.app.call('session.snapshot', { sessionId: working.id });
    expect(rt.items.filter((i) => i.type === 'notice' && !!i.early)).toHaveLength(1);
    await next.app.call('session.snapshot', { sessionId: resting.id });
    expect(next.app.runtime(resting.id).items.some((i) => i.type === 'notice' && !!i.early)).toBe(false);
  });

  it('quitting reads as Sable closing, whatever the agent\'s close wrote: one "Ended early", the command lost when Sable closed, and the agent told with its next message', async () => {
    const h = start({ closeCuts: true });
    const { studio } = await twoAccounts(h);
    const working = await chat(h, studio.id);
    const step = command(working, 'Run app tests', 'b1');
    working.beginTurn('Thinking');
    working.update({ status: 'running' });
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const next = start({ closeCuts: true }, { home: h.home });
    await next.app.call('session.snapshot', { sessionId: working.id });
    const rt = next.app.runtime(working.id);
    expect(notices(rt.items).filter((n) => n.early).map((n) => n.early)).toEqual(['restart']);
    expect(rt.get<ToolItem>(step.id)!.task).toMatchObject({ state: 'lost', why: 'restart' });
    expect(notices(rt.items).some((n) => n.text.includes('lost with the agent'))).toBe(false);
    // The person is told once, after the turn's own line, at the time the chat stopped.
    expect(notices(rt.items).slice(-2).map((n) => n.text)).toEqual(['Ended early', '1 background command was lost when Sable closed']);
    expect(lastNotice(rt)).toMatchObject({ detail: 'Run app tests' });
    expect(lastNotice(rt)!.ts).toBe(notices(rt.items).find((n) => n.early)!.ts);
    await next.app.call('session.snapshot', { sessionId: working.id });
    expect(notices(rt.items).filter((n) => n.text.endsWith('lost when Sable closed'))).toHaveLength(1);
    await next.app.call('session.send', { sessionId: rt.id, text: 'go on' });
    await until(() => next.ctl.sent.length === 1, 'the message');
    expect(next.ctl.sent[0].text).toContain('"Run app tests" (command, task b1)');
    expect(stripWrappers(next.ctl.sent[0].text)).toBe('go on');
  });

  it('a turn the close cut while Sable goes down starts nothing after it: no cap move, no agent opened', async () => {
    const h = start({ closeCuts: true });
    const { studio } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    rt.beginTurn('Thinking');
    rt.update({ status: 'running' });
    const opened = h.ctl.opened.length;
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    await tick(300);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(h.ctl.opened).toHaveLength(opened);
    expect(notices(rt.items).some((n) => n.text.startsWith('Moved to'))).toBe(false);
  });
});

describe('the words, pure', () => {
  it('a switch line names what the move lost, bounded', () => {
    expect(lostClause([])).toEqual({});
    expect(lostClause(['Run app tests'])).toEqual({ suffix: ' · 1 background command lost', detail: 'Lost when the chat moved: Run app tests', names: 'Run app tests' });
    const many = Array.from({ length: 10 }, (_, i) => `Task ${i}`);
    expect(lostClause(many).suffix).toBe(' · 10 background commands lost');
    expect(lostClause(many).detail).toMatch(/Task 7 and 2 more$/);
  });

  it('the note after a move says nothing else changed only when nothing was lost', () => {
    expect(moveNote([], [])).toContain('Nothing else changed');
    expect(moveNote([], [], { lost: true })).not.toContain('Nothing else changed');
  });
});
