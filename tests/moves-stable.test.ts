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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT, type NoticeItem, type ProviderId, type SessionOptions, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import { AUTH_FAILURE_TEXT, RESUME_UNDER_ANOTHER, parseSynthetic, stripWrappers } from '@shared/synthetic';
import type { RateLimit, SessionMeta } from '@shared/protocol';
import { Attention } from '../src/lib/attention';
import { updateWaits } from '../server/services/update';
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
  /** A continued turn whose SDK events are driven by the test. */
  carryOn?: (rt: SessionRuntime) => void;
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
      if (this.ctl.carryOn && item.text.startsWith(RESUME_UNDER_ANOTHER)) return this.ctl.carryOn(rt);
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

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { wait, release };
}

describe('move and quit races', { timeout: 20000 }, () => {
  it('D2 reserves the transcript after an ordinary close', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    let exited = false;
    rt.handle!.exited = async () => { if (!exited) throw Error('still writing'); };
    await h.app.call('session.close', { sessionId: rt.id });
    const opens = h.ctl.opened.length;
    await h.app.call('session.send', { sessionId: rt.id, text: 'try before exit' }).catch(() => {});
    expect(h.ctl.opened).toHaveLength(opens);
    const copy = vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation');
    await expect(h.app.switchAccount(rt, work.id)).rejects.toThrow(/exit/i);
    expect(copy).not.toHaveBeenCalled();
    exited = true;
    await h.app.switchAccount(rt, work.id);
    expect(copy).toHaveBeenCalledOnce();
  });

  it.each(['automatic', 'send now'])('D4 preserves the queued entry and attachment after lane failure (%s)', async mode => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    await tick();
    rt.beginTurn();
    const attachments: UserItem['attachments'] = [{ id: 'picture', kind: 'file', name: 'example.txt', path: 'example.txt' }];
    let paired = true;
    await h.app.call('session.send', { sessionId: rt.id, text: 'inspect it', attachments }, { allowed: () => paired });
    const queued = structuredClone(rt.queue[0]);
    const cwd = path.join(h.home, 'missing-lane');
    rt.update({ cwd, lane: { folder: h.home, root: h.home, branch: 'sable/test', base: 'abc', createdAt: 1, path: cwd } });
    if (mode === 'automatic') {
      rt.endTurn();
      await tick(80);
    } else {
      await expect(h.app.call('queue.sendNow', { sessionId: rt.id, id: queued.id })).rejects.toThrow(/lane/i);
    }
    expect(rt.queue).toEqual([queued]);
    expect(h.ctl.sent).toHaveLength(0);
    rt.update({ cwd: h.home, lane: null });
    paired = false;
    if (!rt.turnActive) rt.beginTurn();
    rt.endTurn();
    await until(() => rt.queue.length === 0, 'the revoked phone guard');
    expect(h.ctl.sent).toHaveLength(0);
    expect(notices(rt.items).some(n => n.text.includes('removed phone'))).toBe(true);
  });

  it('closes personal and provider turn admission when the installer launches', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    h.app.updates = { installing: true, state: { status: 'ready', current: '1' }, dispose() {} };
    await expect(h.app.call('session.send', { sessionId: rt.id, text: 'late' })).rejects.toThrow(/update/i);
    expect(h.ctl.sent).toEqual([]);
    rt.beginTurn('Provider wake', { keepHold: true });
    expect(rt.turnActive).toBe(false);
  });

  it('restores one instruction when quit interrupts a queued send awaiting the provider', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    const wait = gate();
    const started = gate();
    rt.handle!.send = async () => { rt.beginTurn('Thinking'); started.release(); await wait.wait; };
    const entry = rt.enqueue('Only explain the change');
    const delivery = h.app.call('queue.sendNow', { sessionId: rt.id, id: entry.id });
    try {
      await started.wait;
      await h.app.dispose();
      apps.splice(apps.indexOf(h.app), 1);
      const back = start({}, { home: h.home });
      const snap = await back.app.call('session.snapshot', { sessionId: rt.id });
      expect(snap.queue).toEqual([]);
      expect(snap.items.filter(i => i.type === 'user' && i.text === entry.text)).toMatchObject([{ id: entry.id }]);
    } finally { wait.release(); await delivery; }
  });

  it('keeps an interrupted queued steer for a manual retry after restart', async () => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    rt.beginTurn();
    const entered = gate(), reply = gate();
    rt.handle!.send = async () => { entered.release(); await reply.wait; };
    const entry = rt.enqueue('Explain the correction');
    const delivery = h.app.call('queue.sendNow', { sessionId: rt.id, id: entry.id });
    try {
      await entered.wait;
      await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
      const back = start({}, { home: h.home });
      const snap = await back.app.call('session.snapshot', { sessionId: rt.id });
      expect(snap.items.filter(i => i.id === entry.id)).toHaveLength(0);
      expect(snap.queue).toMatchObject([{ id: entry.id, text: entry.text, byHand: true }]);
    } finally { reply.release(); await delivery; }
  });

  it('D7 closing a chat cancels its armed reset across restart', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', resetsAt: Date.now() + 60000 } });
    await h.app.call('spare.atReset', { sessionId: rt.id });
    expect(rt.meta.spare?.reason).toBe('reset');
    await h.app.call('session.close', { sessionId: rt.id });
    await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
    expect(start({}, { home: h.home }).app.runtime(rt.id).meta.spare).toBeFalsy();
  });

  it('D8 Stop during a background refusal copy holds the queued instruction', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: false } });
    rt.limitInBackground({ window: 'Weekly' });
    rt.enqueue('leave this queued');
    await until(() => !!lastNotice(rt)?.limit?.provider, 'background decision');
    const entered = gate(), go = gate();
    vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation').mockImplementationOnce(async () => { entered.release(); await go.wait; return true; });
    const move = h.app.switchAccount(rt, work.id, { retry: true });
    await entered.wait;
    try { await h.app.call('session.interrupt', { sessionId: rt.id }); } finally { go.release(); }
    await move;
    await tick(80);
    expect(h.ctl.sent).toEqual([]);
    expect(rt.queue.map(q => q.text)).toEqual(['leave this queued']);
  });

  it('D11 drains queued work after a fresh personal turn supersedes a wake refusal', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: false } });
    rt.limitInBackground({ window: 'Weekly · Fable' });
    rt.enqueue('queued follow-up');
    await until(() => !!lastNotice(rt)?.limit?.provider, 'background decision');
    await h.app.call('session.setModel', { sessionId: rt.id, model: 'opus' });
    await h.app.call('session.send', { sessionId: rt.id, text: 'fresh message' });
    await until(() => !rt.turnActive, 'fresh answer');
    await tick(80);
    expect(h.ctl.sent.map(s => s.text)).toEqual(['fresh message', 'queued follow-up']);
  });

  it('D15 quit during lane cleanup keeps the deleted chat out of the registry', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    const entered = gate(), go = gate();
    const lanes = (h.app as unknown as { lanes: { closed(rt: SessionRuntime): Promise<void> } }).lanes;
    vi.spyOn(lanes, 'closed').mockImplementationOnce(async () => { entered.release(); await go.wait; });
    const remove = h.app.call('session.close', { sessionId: rt.id, remove: true });
    await entered.wait;
    try { await h.app.dispose(); } finally { go.release(); }
    await remove; apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    expect((await again.app.call('app.hello', {})).sessions.map(s => s.id)).not.toContain(rt.id);
  });

  it.each(['reset', 'sign-in', 'move'])('D1 verifies a missing lane before opening or dispatching a %s retry', async reason => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('session.close', { sessionId: rt.id });
    rt.stopRequested = false;
    const cwd = path.join(h.home, 'gone');
    rt.update({ cwd, lane: { folder: h.home, root: h.home, branch: 'sable/test', base: 'abc', createdAt: 1, path: cwd } });
    const user = rt.add<UserItem>({ type: 'user', text: 'edit the file', state: 'sent' });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', userItemId: user.id, provider: 'demo', accountId: studio.id } });
    const opens = h.ctl.opened.length;
    const planner = h.app as unknown as {
      resumeRefused(rt: SessionRuntime, reason: 'reset'): Promise<void>;
      refusalMark(rt: SessionRuntime): never;
      sendAfterSignIn(rt: SessionRuntime, item: UserItem, bg: string[], mark: unknown): Promise<void>;
    };
    const retry = reason === 'move' ? h.app.switchAccount(rt, work.id, { retry: true }) : reason === 'sign-in' ?
      planner.sendAfterSignIn(rt, user, [], planner.refusalMark(rt)) : planner.resumeRefused(rt, 'reset');
    await retry.catch(() => {});
    expect(h.ctl.opened).toHaveLength(opens);
    expect(h.ctl.sent).toEqual([]);
    expect(rt.meta.accountId).toBe(studio.id);
  });

  it('D1 checks the lane again after waiting for an old transcript writer', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    const entered = gate(), exit = gate();
    let first = true;
    rt.handle!.exited = async () => {
      if (first) { first = false; throw Error('Still writing'); }
      entered.release();
      await exit.wait;
    };
    await h.app.call('session.close', { sessionId: rt.id });
    const opened = h.ctl.opened.length;
    const send = h.app.call('session.send', { sessionId: rt.id, text: 'next instruction' });
    await entered.wait;
    const cwd = path.join(h.home, 'lost-checkout');
    rt.update({ cwd, lane: { path: cwd, folder: h.home, root: h.home, branch: 'sable/lost', base: 'abc', createdAt: 1 } });
    exit.release();
    await expect(send).rejects.toThrow(/lane/i);
    expect(h.ctl.opened).toHaveLength(opened);
  });

  it('D3 announces a locked registry and recovers the saved chats before accepting changes', async () => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
    const file = path.join(h.home, 'state.json'), saved = readFileSync(file, 'utf8');
    writeFileSync(file, '{unreadable');
    const again = start({}, { home: h.home });
    const messages: string[] = [];
    again.app.subscribe(e => { if (e.type === 'toast') messages.push(e.text); });
    const hello = again.app.call('app.hello', {});
    try {
      for (const change of [
        () => again.app.call('session.create', { provider: 'demo', cwd: h.home }),
        () => again.app.call('account.add', { provider: 'demo', label: 'Lost account' }),
        () => again.app.call('app.setSettings', { patch: { autoLanes: true } }),
      ]) await expect(change()).rejects.toThrow(/read.*(chat|saved)/i);
      expect(messages.join(' ')).toMatch(/read.*(chat|saved)/i);
      expect(readFileSync(file, 'utf8')).toBe('{unreadable');
    } finally { writeFileSync(file, saved); }
    expect((await hello).sessions.map(s => s.id)).toContain(rt.id);
    const added = await again.app.call('session.create', { provider: 'demo', cwd: h.home });
    await again.app.dispose(); apps.splice(apps.indexOf(again.app), 1);
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions.map((s: SessionMeta) => s.id).sort()).toEqual([rt.id, added.session.id].sort());
  });

  it.each(['exit', 'withdrawal', 'receipt', 'uncertain'])('D6 waits for the outcome of the first Claude handoff (%s)', async outcome => {
    const home = temp('sable-first-receipt-');
    const app = new App({ home, userHome: home, quiet: true, providers: [ctx => Object.assign(new DemoProvider(ctx, { speed: 0 }), { id: 'claude' as const })] });
    apps.push(app);
    const { account } = await app.call('account.add', { provider: 'claude', label: 'Destination' });
    writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: 'destination@example.test', plan: 'Max', limits: 'light' }));
    await app.call('auth.refresh', { provider: 'claude', accountId: account.id });
    const snap = await app.call('session.create', { provider: 'claude', cwd: home });
    const rt = app.runtime(snap.session.id);
    const source = rt.meta.providerSessionId;
    const owner = rt.add<UserItem>({ type: 'user', text: 'retry my message', state: 'sent' });
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', userItemId: owner.id, provider: 'claude', next: account.id } });
    const dest = app.provider('claude', account.id), open = dest.open.bind(dest);
    const entered = gate();
    let taken: (() => void) | undefined;
    let withdraw: (() => void) | undefined;
    let uncertain: (() => void) | undefined;
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      handle.send = async (_item, opts) => { rt.beginTurn(); taken = opts?.taken; withdraw = opts?.release; uncertain = opts?.uncertain; entered.release(); };
      return handle;
    });
    const move = app.call('session.switchAccount', { sessionId: rt.id, accountId: account.id, retry: true, refusalId: card.id }).then(() => 'moved', () => 'failed');
    await entered.wait;
    await tick();
    expect(rt.meta.moving).toBe(true);
    expect(rt.meta.movedFrom).toBe(DEFAULT_ACCOUNT);
    expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
    if (outcome === 'receipt') {
      taken!();
      expect(await move).toBe('moved');
      expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBe(account.id);
      return;
    }
    if (outcome === 'uncertain') {
      uncertain!();
      expect(await move).toBe('failed');
      expect(rt.meta.moving).toBeFalsy();
      expect(rt.meta.accountId).toBe(account.id);
      expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
      expect(notices(rt.items).filter(n => n.text === 'Delivery unconfirmed')).toHaveLength(1);
      return;
    }
    if (outcome === 'withdrawal') withdraw!();
    else rt.cutTurn('died', { detail: 'launch failed before reading' });
    expect(await move).toBe('failed');
    expect(rt.meta.accountId ?? DEFAULT_ACCOUNT).toBe(DEFAULT_ACCOUNT);
    expect(rt.meta.movedFrom).toBeUndefined();
    expect(rt.meta.providerSessionId).toBe(source);
    expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
    expect(rt.handle).toBeTruthy();
  });

  it.each(['read', 'exit'])('keeps the reset card actionable until Claude reads its hidden continuation (%s)', async outcome => {
    const home = temp('sable-reset-receipt-');
    const app = new App({ home, userHome: home, quiet: true, providers: [ctx => Object.assign(new DemoProvider(ctx, { speed: 0 }), {
      id: 'claude' as const,
      limits: async () => {
        const limits = [{ id: 'five_hour', label: '5-hour limit', percent: 5 }];
        ctx.emit({ type: 'limits.updated', provider: 'claude', limits, meta: { planLimits: true } });
        return limits;
      },
    })] });
    apps.push(app);
    const snap = await app.call('session.create', { provider: 'claude', cwd: home });
    const rt = app.runtime(snap.session.id);
    await until(() => !!rt.handle, 'fake provider ready');
    const card = rt.add<NoticeItem>({ type: 'notice', text: 'Limit', variant: 'error', limit: { origin: 'background', provider: 'claude', resetsAt: Date.now() - 1 } });
    let read: (() => void) | undefined, exit: (() => void) | undefined;
    const sent: string[] = [];
    rt.handle!.send = async (item, opts) => { sent.push(item.text); read = opts?.taken; exit = opts?.release; rt.beginTurn(); };
    await app.call('spare.atReset', { sessionId: rt.id, refusalId: card.id });
    await until(() => sent.length > 0, 'reset continuation enqueued');
    expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
    expect(rt.meta.spare?.refusalId).toBe(card.id);
    if (outcome === 'read') {
      read!();
      await until(() => !!rt.get<NoticeItem>(card.id)?.limit?.atReset, 'receipt');
    } else {
      exit!(); rt.cutTurn('died');
      await until(() => rt.items.some(i => i.type === 'notice' && /could not start/i.test(i.text)), 'recoverable missed delivery');
      expect(rt.meta.spare?.refusalId).toBe(card.id);
      expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
    }
    expect(sent).toHaveLength(1);
  });

  it('D9 quit during rejected destination cleanup saves the source thread and open refusal', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id), source = rt.meta.providerSessionId;
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', next: work.id } });
    const dest = h.app.provider('demo', work.id), open = dest.open.bind(dest);
    const entered = gate(), go = gate();
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args), close = handle.close.bind(handle);
      handle.send = async () => { throw Error('destination refused input'); };
      handle.close = async () => { entered.release(); await go.wait; await close(); };
      return handle;
    });
    const move = h.app.switchAccount(rt, work.id, { retry: true }).catch(() => {});
    await entered.wait;
    try { await h.app.dispose(); } finally { go.release(); }
    await move; apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    const snap = await again.app.call('session.snapshot', { sessionId: rt.id });
    expect(snap.session).toMatchObject({ accountId: studio.id, providerSessionId: source });
    expect(notices(snap.items).find(n => n.id === card.id)?.limit?.continuedWith).toBeUndefined();
  });

  it('D10 keeps a stopped instruction out of the hidden move note', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.add<UserItem>({ type: 'user', text: 'cancelled instruction', state: 'sent' });
    rt.beginTurn(); rt.cutTurn('closed');
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'background', provider: 'demo' } });
    await h.app.switchAccount(rt, work.id, { retry: true });
    expect(h.ctl.sent[0].text).not.toContain('cancelled instruction');
  });

  it('D12 a fresh Fable window holds the return of an Opus chat across restart', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.update({ model: 'opus' });
    const later = Date.now() + 120000;
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'background', provider: 'demo', window: 'Weekly · Fable', resetsAt: Date.now() + 60000, next: work.id } });
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true });
    await until(() => !rt.turnActive, 'destination rest');
    await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    const back = again.app.runtime(rt.id);
    back.update({ returnAt: Date.now() - 1 });
    vi.spyOn(again.app as unknown as { readLimits(): Promise<unknown> }, 'readLimits').mockResolvedValue({ fresh: true, limits: [
      { id: 'seven_day', label: 'Weekly', percent: 21 }, { id: 'model_Fable', label: 'Weekly · Fable', percent: 100, resetsAt: later },
    ] });
    await again.app.returnAfterLimit(back);
    expect(back.meta).toMatchObject({ accountId: work.id, returnAt: later, movedFrom: studio.id });
  });

  it('D13 switching off automatic continuation cancels a credits move during copy', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const bridge = h.app as unknown as { onCredits(rt: SessionRuntime): Promise<void> };
    writeFileSync(path.join(studio.dir!, 'demo-auth.json'), JSON.stringify({ email: 'studio@example.dev', plan: 'Max', limits: 'cap' }));
    await h.app.call('provider.limits', { provider: 'demo', accountId: studio.id, force: true });
    vi.spyOn(h.app, 'nextAccount').mockResolvedValue(work.id);
    const entered = gate(), go = gate();
    vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation').mockImplementationOnce(async () => { entered.release(); await go.wait; return true; });
    const moving = bridge.onCredits(rt);
    await entered.wait;
    try { await h.app.call('app.setSettings', { patch: { continueAtLimit: false } }); } finally { go.release(); }
    await moving;
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.movedFrom).toBeUndefined();
  });

  it('D13 stays on recovered quota when a prior reading still says credits', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    for (const limits of ['cap', 'light']) {
      writeFileSync(path.join(studio.dir!, 'demo-auth.json'), JSON.stringify({ email: 'studio@example.dev', plan: 'Max', limits }));
      await h.app.call('provider.limits', { provider: 'demo', accountId: studio.id, force: true });
    }
    vi.spyOn(h.app, 'nextAccount').mockResolvedValue(work.id);
    const decision = vi.spyOn(h.app as unknown as { onCredits(rt: SessionRuntime): Promise<void> }, 'onCredits');
    rt.beginTurn();
    rt.endTurn();
    await decision.mock.results[0].value;
    expect(rt.meta.accountId).toBe(studio.id);
  });

  it('D14 accepts an identical resolved default picker on the next account', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.update({ model: 'default' });
    const caps = { ...rt.caps!, models: [{ id: 'default', name: 'Default', description: 'Opus 5.5 · Current' }, { id: 'opus', name: 'Opus' }] };
    rt.setCaps(caps);
    for (const id of [DEFAULT_ACCOUNT, work.id]) h.app.cache.set('caps:demo:' + id + ':' + path.resolve(rt.meta.cwd).toLowerCase(), caps);
    expect(await h.app.nextAccount('demo', studio.id, { rt, refusedModel: 'fable', except: [DEFAULT_ACCOUNT] })).toBe(work.id);
  });

  it('retains an unconfirmed writer until a source reopen or transcript copy can verify exit', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const old = rt.handle!;
    let exited = false;
    old.exited = async () => { if (!exited) throw Error('still writing'); };
    const copy = vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation');
    await expect(h.app.switchAccount(rt, work.id, { waits: true })).rejects.toThrow();
    const opens = h.ctl.opened.length;
    await h.app.call('session.send', { sessionId: rt.id, text: 'while still writing' }).catch(() => {});
    expect(h.ctl.opened).toHaveLength(opens);
    await expect(h.app.switchAccount(rt, work.id, { waits: true })).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
    exited = true;
    await h.app.switchAccount(rt, work.id, { waits: true });
    expect(copy).toHaveBeenCalledOnce();
  });
  it('sends a refused card once when its scheduled reset falls inside a manual copy', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.add<UserItem>({ type: 'user', text: 'one request', state: 'sent' });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', accountId: studio.id, resetsAt: Date.now() + 60000 } });
    await h.app.call('spare.atReset', { sessionId: rt.id });
    const copy = gate(), entered = gate();
    vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation').mockImplementationOnce(async () => { entered.release(); await copy.wait; return true; });
    const move = h.app.switchAccount(rt, work.id, { retry: true });
    await entered.wait;
    try {
      const planner = h.app as unknown as { startSpare(rt: SessionRuntime, account: string, wait: NonNullable<SessionMeta['spare']>): Promise<void> };
      await planner.startSpare(rt, studio.id, rt.meta.spare!);
    } finally { copy.release(); }
    await move;
    expect(h.ctl.sent.map(s => [s.account, s.text.split('\n\n')[0]])).toEqual([[work.id, 'one request']]);
  });
  it('keeps the source thread on disk when quit interrupts a summary handoff', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const sourceId = rt.meta.providerSessionId;
    rt.add<UserItem>({ type: 'user', text: 'retry me', state: 'sent' });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', accountId: studio.id } });
    const dest = h.app.provider('demo', work.id);
    vi.spyOn(dest, 'adoptConversation').mockResolvedValue(false);
    const open = dest.open.bind(dest), entered = gate(), go = gate();
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      entered.release(); await go.wait; return open(...args);
    });
    const move = h.app.switchAccount(rt, work.id, { retry: true }).catch(() => {});
    await entered.wait;
    const quit = h.app.dispose();
    go.release();
    await Promise.all([quit, move]);
    apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    expect(again.app.runtime(rt.id).meta).toMatchObject({ accountId: studio.id, providerSessionId: sourceId });
  });
  it('finishes the first slow return before draining its waiting send', async () => {
    const h = start();
    const { rt, studio } = await owingReturn(h);
    const app = h.app as unknown as { readLimits(...args: unknown[]): Promise<unknown> };
    const read = app.readLimits.bind(app), release = gate();
    const reads = vi.spyOn(app, 'readLimits').mockImplementation(async (...args) => { await release.wait; return read(...args); });
    const normal = global.setTimeout;
    const timers = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => normal(fn, ms === 15000 ? 10 : ms, ...args)) as typeof normal);
    try {
      await h.app.call('session.send', { sessionId: rt.id, text: 'after return' });
      expect(rt.queue.map(q => q.text)).toEqual(['after return']);
      release.release();
      await until(() => h.ctl.sent.length > 0, 'the waiting send');
      expect(reads.mock.calls.filter(args => args[1] === studio.id)).toHaveLength(1);
      expect(h.ctl.sent[0].account).toBe(studio.id);
    } finally { release.release(); timers.mockRestore(); }
  });

  it.each(['picker', 'Opus window'])('requires configured Opus eligibility as well as Fable room (%s)', async (reason) => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const third = await demoAccount(h.app, 'Third', 'light');
    const rt = await chat(h, studio.id);
    rt.update({ model: 'opus' });
    rt.setCaps({ ...rt.caps!, models: [{ id: 'opus', name: 'Opus' }] });
    const cache = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    for (const [id, weekly] of [[studio.id, 10], [work.id, 1], [third.id, 40], [DEFAULT_ACCOUNT, 100]] as const) {
      cache.set('demo:' + id, [
        { id: 'seven_day', label: 'Weekly', percent: weekly },
        { id: 'model_Fable', label: 'Weekly · Fable', percent: id === studio.id ? 100 : 1 },
        { id: 'model_Opus', label: 'Weekly · Opus', percent: reason === 'Opus window' && id === work.id ? 100 : 0 },
      ]);
      h.app.cache.set('caps:demo:' + id + ':' + path.resolve(rt.meta.cwd).toLowerCase(), { ...rt.caps, models: reason === 'picker' && id === work.id ? [{ id: 'sonnet', name: 'Sonnet' }] : [{ id: 'opus', name: 'Opus' }] });
    }
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    rt.limitInBackground({ window: 'Weekly · Fable' });
    await until(() => h.ctl.sent.length > 0, 'Fable retry');
    expect(h.ctl.sent[0].account).toBe(third.id);
  });

  it('retries autonomous work after restart without replaying the stopped instruction', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: false } });
    rt.add<UserItem>({ type: 'user', text: 'stopped instruction', state: 'sent' });
    rt.beginTurn(); rt.cutTurn('closed');
    rt.limitInBackground({ window: 'Weekly', resetsAt: Date.now() + 60000 });
    await until(() => notices(rt.items).some(n => n.limit?.provider), 'decided wake');
    await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    await again.app.call('session.snapshot', { sessionId: rt.id });
    const planner = again.app as unknown as { startSpare(rt: SessionRuntime, id: string, wait: { reason: 'reset' }): Promise<void> };
    await planner.startSpare(again.app.runtime(rt.id), studio.id, { reason: 'reset' });
    expect(again.ctl.sent).toHaveLength(1);
    expect(again.ctl.sent[0].text).not.toContain('stopped instruction');
  });

  it.each([false, true])('carries the original attachments through two refusals without progress (automatic %s)', async (automatic) => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const third = await demoAccount(h.app, 'Third', 'light');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: automatic, continueAtReset: false } });
    const attachments: UserItem['attachments'] = [{ id: 'attachment', kind: 'file', path: 'test.txt', name: 'test.txt' }];
    const request = rt.add<UserItem>({ type: 'user', text: 'read this', attachments, state: 'sent' });
    const refuse = () => {
      rt.beginTurn();
      rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { window: 'Weekly' } });
      rt.add({ type: 'turn', durationMs: 1 }); rt.endTurn('Limit');
    };
    const cache = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    for (const [id, percent] of [[studio.id, 100], [DEFAULT_ACCOUNT, 100], [work.id, 2], [third.id, 42]] as const) {
      cache.set('demo:' + id, [{ id: 'seven_day', label: 'Weekly', percent }]);
    }
    const b = h.app.provider('demo', work.id), openB = b.open.bind(b);
    vi.spyOn(b, 'open').mockImplementationOnce(async (...args) => {
      const handle = await openB(...args);
      handle.send = async () => {
        refuse();
        if (automatic) await until(() => !!lastNotice(rt)?.limit?.provider, 'decision before the previous dispatch settles');
      };
      return handle;
    });
    const c = h.app.provider('demo', third.id), openC = c.open.bind(c);
    const received: UserItem[] = [];
    vi.spyOn(c, 'open').mockImplementationOnce(async (...args) => {
      const handle = await openC(...args); handle.send = async item => { received.push(item); }; return handle;
    });
    refuse();
    if (!automatic) {
      await until(() => !!lastNotice(rt)?.limit?.provider, 'first refused turn');
      await h.app.switchAccount(rt, work.id, { retry: true });
      await until(() => !!lastNotice(rt)?.limit?.provider, 'second refused turn');
      await h.app.switchAccount(rt, third.id, { retry: true });
    }
    await until(() => received.length > 0, 'retry on the third account');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: request.id, attachments });
    expect(received[0].text.startsWith('read this')).toBe(true);
  });
  it('restores Continue on a limit card abandoned during copy', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', accountId: studio.id, next: work.id, moving: true } });
    rt.update({ moving: true });
    await h.app.dispose(); apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    const snap = await again.app.call('session.snapshot', { sessionId: rt.id });
    const restored = notices(snap.items).find(n => n.id === card.id);
    expect(restored?.limit?.moving).toBeFalsy();
    expect(restored?.limit?.next).toBe(work.id);
  });

  it('lets a later independent wake return to an account that recovered', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const cache = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    const weekly = (id: string, percent: number) => cache.set('demo:' + id, [{ id: 'seven_day', label: 'Weekly', percent, resetsAt: Date.now() + 86400000 }]);
    weekly(DEFAULT_ACCOUNT, 100); weekly(studio.id, 100); weekly(work.id, 0);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    rt.limitInBackground({ window: 'Weekly' });
    await until(() => rt.meta.accountId === work.id && !rt.turnActive && h.ctl.sent.length === 1 && !rt.meta.moving, 'first successful wake');
    weekly(studio.id, 0); weekly(work.id, 100);
    rt.limitInBackground({ window: 'Weekly' });
    await until(() => notices(rt.items).filter(n => n.limit?.provider).length === 2, 'next decision');
    expect(notices(rt.items).filter(n => n.limit).at(-1)?.limit?.next).toBe(studio.id);
  });

  it('holds a due wake during its delivery grace and names it on a manual move', async () => {
    const h = start();
    const { rt, studio, work } = await owingReturn(h);
    const wakeAt = Date.now() - 1000;
    rt.handle!.liveWork = () => ({ turn: false, commands: 0, agents: 0, wakeAt });
    await h.app.returnAfterLimit(rt);
    expect(rt.meta.accountId).toBe(work.id);
    await h.app.switchAccount(rt, studio.id);
    expect(lastNotice(rt)?.detail).toMatch(/wake-up/i);
  });
  it('P4 waits for notification grace and returns when the deadline expires', async () => {
    const h = start();
    const { rt, studio, work } = await owingReturn(h);
    const untilAt = Date.now() + 800;
    rt.handle!.liveWork = () => ({ commands: 0, turn: false, agents: 0, notificationUntil: untilAt });
    await h.app.returnAfterLimit(rt);
    expect(rt.meta.accountId).toBe(work.id);
    await until(() => rt.meta.accountId === studio.id, 'return after notification grace');
  });

  it('P6 retries both independently refused inputs on their own cards in order', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    vi.spyOn(h.app, 'nextAccount').mockImplementation(async (_provider, from) => from === studio.id ? work.id : undefined);
    rt.beginTurn();
    const owners = ['first drawing', 'second drawing'].map(text => rt.add<UserItem>({ type: 'user', text, state: 'sent' }));
    const cards = owners.map(owner => rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', userItemId: owner.id } }));
    rt.endTurn('Limit');
    await until(() => cards.every(card => rt.get<NoticeItem>(card.id)?.limit?.continuedWith), 'both independent continuations');
    expect(h.ctl.sent.map(send => send.text.split('\n')[0])).toEqual(owners.map(owner => owner.text));
    for (const card of cards) expect(rt.get<NoticeItem>(card.id)?.limit).toMatchObject({ accountId: studio.id, continuedWith: work.id });
  });

  it.each(['move', 'reset'])('P6 honors the personal refusal selected for a manual %s', async mode => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const cards = ['first request', 'second request'].map((text, i) => {
      const user = rt.add<UserItem>({ type: 'user', text, state: 'sent' });
      return rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', origin: 'user', userItemId: user.id, next: work.id, accountId: studio.id, resetsAt: Date.now() + (i + 1) * 60000 } });
    });
    if (mode === 'reset') {
      const { spare } = await h.app.call('spare.atReset', { sessionId: rt.id, refusalId: cards[0].id });
      expect(spare?.refusalId).toBe(cards[0].id);
      expect(spare?.at).toBe(cards[0].limit!.resetsAt);
    } else {
      await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true, refusalId: cards[0].id });
      expect(h.ctl.sent[0].text.split('\n')[0]).toBe('first request');
      expect(cards[1].limit?.continuedWith).toBeUndefined();
    }
  });

  it('P6 keeps the first automatic reset until its personal continuation is delivered', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: true } });
    rt.beginTurn();
    const cards = ['first reset', 'second reset'].map((text, i) => {
      const owner = rt.add<UserItem>({ type: 'user', state: 'sent', text });
      return rt.add<NoticeItem>({ type: 'notice', text: 'Limit', variant: 'error', limit: { origin: 'user', userItemId: owner.id, resetsAt: Date.now() + (i ? 60000 : 1800) } });
    });
    rt.endTurn('Limit');
    await until(() => !!rt.meta.spare, 'automatic reset');
    await tick(200);
    expect(rt.meta.spare?.refusalId).toBe(cards[0].id);
    expect(rt.meta.spare?.at).toBe(cards[0].limit?.resetsAt);
    await until(() => rt.meta.spare?.refusalId === cards[1].id, 'second reset');
    expect(h.ctl.sent[0].text.split('\n')[0]).toBe('first reset');
  });

  it('P7 enriches a late stopped refusal without moving or releasing the queue', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    vi.spyOn(h.app, 'nextAccount').mockResolvedValue(work.id);
    const owner = rt.add<UserItem>({ type: 'user', state: 'sent', text: 'stopped request' });
    await h.app.call('session.interrupt', { sessionId: rt.id });
    rt.beginTurn();
    rt.enqueue('wait for this new turn');
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', userItemId: owner.id } });
    rt.onStoppedLimit?.(rt, card);
    await until(() => !!rt.get<NoticeItem>(card.id)?.limit?.provider, 'late manual continuation');
    expect(rt.get<NoticeItem>(card.id)?.limit).toMatchObject({ accountId: studio.id, next: work.id });
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.queue.map(q => q.text)).toEqual(['wait for this new turn']);
    expect(h.ctl.sent).toHaveLength(0);
  });

  it.each(['new message', 'send now'])('P13 releases the unread queue on an accepted explicit steer (%s)', async mode => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.beginTurn();
    rt.handle!.send = async () => {};
    const queued = rt.enqueue('first held message');
    rt.enqueue('second held message');
    rt.unreadQueueHeld = true;
    if (mode === 'send now') await h.app.call('queue.sendNow', { sessionId: rt.id, id: queued.id });
    else await h.app.call('session.send', { sessionId: rt.id, text: 'explicit steer', steer: true });
    expect(rt.unreadQueueHeld).toBe(false);
  });

  it('P13 leaves an unread steer queued through an automatic wake continuation', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    vi.spyOn(h.app, 'nextAccount').mockResolvedValue(work.id);
    const dest = h.app.provider('demo', work.id), open = dest.open.bind(dest);
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      handle.send = async item => {
        h.ctl.sent.push({ text: item.text, home: '', chat: rt.id, account: work.id });
        rt.beginTurn(); rt.endTurn();
      };
      return handle;
    });
    rt.beginTurn();
    const unread = rt.add<UserItem>({ type: 'user', text: 'unread steer', state: 'queued', steered: true });
    rt.returnUntaken({ ids: new Set([unread.id]), holdQueue: true });
    rt.endTurn(undefined, { backgroundLimit: true });
    rt.limitInBackground({ window: 'Weekly · Fable' });
    await until(() => rt.meta.accountId === work.id && !rt.meta.moving, 'automatic wake continuation');
    await tick(80);
    expect(h.ctl.sent).toHaveLength(1);
    expect(rt.queue.map(q => q.text)).toEqual(['unread steer']);
  });

  it('retains a lost-task note until Claude confirms the exact send', async () => {
    const home = temp('sable-confirm-');
    const calls: { text: string; taken?: () => void; release?: () => void; uncertain?: () => void }[] = [];
    const app = new App({ home, userHome: home, quiet: true, providers: [ctx => {
      const p = new DemoProvider(ctx, { speed: 0 });
      const open = p.open.bind(p);
      return Object.assign(p, { id: 'claude' as const, open: async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        handle.send = async (item, opts) => { calls.push({ text: item.text, ...opts }); };
        return handle;
      } });
    }] });
    apps.push(app);
    const snap = await app.call('session.create', { provider: 'claude', cwd: home });
    const rt = app.runtime(snap.session.id);
    await until(() => !!rt.handle, 'Claude');
    const step = command(rt, 'test watcher', 'ci');
    rt.tasksLost('process');
    await app.call('session.send', { sessionId: rt.id, text: 'launch fails before input' });
    expect(rt.get<ToolItem>(step.id)?.task?.lossTold).toBeFalsy();
    await app.store.flush();
    const saved = app.store.loadSession(rt.id).items.find(i => i.id === step.id) as ToolItem;
    expect(saved.task?.state).toBe('lost');
    expect(saved.task?.lossTold).toBeFalsy();
    await app.call('session.send', { sessionId: rt.id, text: 'second input before receipt' });
    expect(calls[0].text).toContain('task ci');
    expect(calls[1].text).not.toContain('task ci');
    calls[0].release!(); // The launch failed before the first input was read.
    await app.call('session.send', { sessionId: rt.id, text: 'retry' });
    expect(calls[2].text).toContain('task ci');
    calls[2].taken!();
    expect(rt.get<ToolItem>(step.id)?.task?.lossTold).toBe(true);
    await app.call('session.send', { sessionId: rt.id, text: 'after confirmation' });
    expect(calls[3].text).not.toContain('task ci');
    const another = command(rt, 'Review follow-up', 'review');
    rt.tasksLost('process', 'death');
    await until(() => calls.length === 5, 'the standalone recovery input');
    expect(parseSynthetic(calls[4].text)?.role).toBe('hidden');
    expect(rt.get<ToolItem>(another.id)?.task?.lossTold).toBeFalsy();
    expect(notices(rt.items).filter(i => i.text.includes('The agent was told'))).toHaveLength(0);
    calls[4].uncertain!();
    const waiting = notices(rt.items).find(i => i.text.includes("hasn't confirmed"));
    expect(waiting).toBeDefined();
    calls[4].taken!();
    calls[4].taken!();
    expect(rt.get<ToolItem>(another.id)?.task?.lossTold).toBe(true);
    expect(notices(rt.items).filter(i => i.text.includes('The agent was told'))).toEqual([expect.objectContaining({ id: waiting!.id })]);
  });
  it('a reset armed for an older refusal leaves its replacement alone', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const limit = { provider: 'demo' as const, accountId: studio.id, resetsAt: Date.now() + 60000 };
    rt.add<UserItem>({ type: 'user', text: 'old request', state: 'sent' });
    const old = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit });
    const { spare } = await h.app.call('spare.atReset', { sessionId: rt.id });
    rt.patch<NoticeItem>(old.id, { limit: { ...limit, continuedWith: studio.id } });
    rt.add<UserItem>({ type: 'user', text: 'new request', state: 'sent' });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit });
    const planner = h.app as unknown as { startSpare(rt: SessionRuntime, account: string, wait: NonNullable<SessionMeta['spare']>): Promise<void> };
    await planner.startSpare(rt, studio.id, spare!);
    expect(h.ctl.sent).toHaveLength(0);
  });
  it('keeps a personal retry attached to its card when Claude also reports its refused wake', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const third = await demoAccount(h.app, 'Third', 'light');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const cache = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    cache.set('demo:default', [{ id: 'seven_day', label: 'Weekly', percent: 100 }]);
    for (const [id, percent, fable] of [[studio.id, 81, 100], [work.id, 0, 100], [third.id, 52, 21]] as const) {
      cache.set('demo:' + id, [{ id: 'seven_day', label: 'Weekly', percent }, { id: 'model_Fable', label: 'Weekly · Fable', percent: fable }]);
    }
    rt.beginTurn('Steer');
    const user = rt.add<UserItem>({ type: 'user', text: 'my steer', state: 'sent' });
    const personal = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', userItemId: user.id, window: 'Weekly' } });
    rt.endTurn('Limit', { hold: true, backgroundLimit: false });
    rt.limitInBackground({ window: 'Weekly · Fable' });
    await until(() => h.ctl.sent.length > 0 && !rt.meta.moving, 'moving the refused steer');
    expect(h.ctl.sent.map(s => [s.account, s.text.split('\n\n')[0]])).toEqual([[third.id, 'my steer']]);
    expect(rt.get<NoticeItem>(personal.id)?.limit?.continuedWith).toBe(third.id);
  });
  it('lets an already reserved reset dispatch once while Continue waits', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.add<UserItem>({ type: 'user', text: 'reset won', state: 'sent' });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', accountId: studio.id, resetsAt: Date.now() + 60000 } });
    const { spare } = await h.app.call('spare.atReset', { sessionId: rt.id });
    const entered = gate(), release = gate();
    const handle = rt.handle!;
    const send = handle.send.bind(handle);
    vi.spyOn(handle, 'send').mockImplementationOnce(async (item, opts) => {
      entered.release(); await release.wait; opts?.check?.(); await send(item, opts);
    });
    const planner = h.app as unknown as { startSpare(rt: SessionRuntime, account: string, wait: NonNullable<SessionMeta['spare']>): Promise<void> };
    const reset = planner.startSpare(rt, studio.id, spare!);
    await entered.wait;
    const move = h.app.switchAccount(rt, work.id, { retry: true }).catch(() => {});
    release.release();
    await Promise.all([reset, move]);
    expect(h.ctl.sent.map(s => [s.account, s.text])).toEqual([[studio.id, 'reset won']]);
  });
  it('moves-M1 lets an in-flight cap check yield to a root refusal', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id, { tokens: 740_000 });
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true, accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    const slow = gate();
    let checking = false;
    vi.spyOn(h.app as unknown as { canRunTurn(): Promise<boolean> }, 'canRunTurn').mockImplementationOnce(async () => { checking = true; await slow.wait; return false; });
    const move = internals(h.app).checkCap(rt);
    await until(() => checking, 'cap check');
    rt.limitInBackground({ window: 'Weekly', resetsAt: Date.now() + 86400_000 });
    await tick(200);
    slow.release();
    await move;
    await until(() => h.ctl.sent.length > 0, 'the carry-on after the cap yields');
    expect(h.ctl.sent[0]).toMatchObject({ account: work.id, text: expect.stringContaining(RESUME_UNDER_ANOTHER) });
  });

  it('moves-M1 carries a refusal delivered while the capped process closes', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true, accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    const wait = gate();
    const handle = rt.handle!;
    const close = handle.close.bind(handle);
    let closing = false;
    handle.close = async () => { closing = true; await wait.wait; await close(); };
    const cap = internals(h.app).checkCap(rt);
    await until(() => closing, 'the old process closing');
    rt.limitInBackground({ window: 'Weekly', resetsAt: Date.now() + 86400_000 });
    wait.release();
    await cap;
    await until(() => h.ctl.sent.length > 0, 'the late refusal continuing');
    expect(h.ctl.sent[0]).toMatchObject({ account: work.id, text: expect.stringContaining(RESUME_UNDER_ANOTHER) });
    expect(notices(rt.items).find((n) => n.limit)?.limit).toMatchObject({ accountId: studio.id, continuedWith: work.id });
  });

  it('C6 checks new process work immediately before an automatic close', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id, { tokens: 740_000 });
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    const canRun = vi.spyOn(h.app as unknown as { canRunTurn(): Promise<boolean> }, 'canRunTurn').mockImplementation(async () => {
      command(rt, 'Wait for CI', 'ci');
      return false;
    });
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(h.ctl.closed).toHaveLength(0);
    canRun.mockRestore();
    await h.app.switchAccount(rt, work.id, { compact: false });
    expect(rt.meta.accountId).toBe(work.id);
  });

  it('moves-M4 bounds a recurring wake by the first hour and tells both sides what was lost', async () => {
    const h = start();
    const { rt, studio, work } = await owingReturn(h);
    const startAt = Date.now();
    (rt.handle as ProviderSession).liveWork = () => ({ turn: false, commands: 0, agents: 0, wakeAt: Date.now() + 900_000 });
    await h.app.returnAfterLimit(rt);
    expect(rt.meta.accountId).toBe(work.id);
    const now = vi.spyOn(Date, 'now').mockReturnValue(startAt + 3601_000);
    try {
      await h.app.returnAfterLimit(rt);
      expect(rt.meta.accountId).toBe(studio.id);
      expect(lastNotice(rt)?.detail).toMatch(/wake-up/i);
      await h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
      expect(h.ctl.sent.at(-1)?.text).toMatch(/wake-up/i);
    } finally { now.mockRestore(); }
  });

  it('moves-M5 closes the sibling limit cards of this refusal only', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const card = () => rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', next: work.id } });
    const history = card();
    rt.add<UserItem>({ type: 'user', text: 'the refused message', state: 'sent' });
    const first = card();
    const second = card();
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true });
    for (const n of [first, second]) expect(rt.get<NoticeItem>(n.id)?.limit?.continuedWith).toBe(work.id);
    expect(rt.get<NoticeItem>(history.id)?.limit?.continuedWith).toBeUndefined();
  });

  it('runtime-F6 holds the update through the transcript copy', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    let busy: boolean | undefined;
    h.app.provider('demo', work.id).adoptConversation = async () => { busy = updateWaits([rt]).busy; return true; };
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    expect(busy).toBe(true);
    expect(updateWaits([rt]).busy).toBe(false);
  });

  it('C14 keeps the pending restart across an unopened run and writes the line once', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.beginTurn('Thinking');
    rt.add({ type: 'text', text: 'before quit', streaming: true });
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const unopened = start({}, { home: h.home });
    unopened.app.store.saveState();
    await unopened.app.dispose();
    apps.splice(apps.indexOf(unopened.app), 1);
    for (let i = 0; i < 2; i++) {
      const again = start({}, { home: h.home });
      const snap = await again.app.call('session.snapshot', { sessionId: rt.id });
      expect(notices(snap.items).filter((n) => n.early === 'restart')).toHaveLength(1);
      await again.app.dispose();
      apps.splice(apps.indexOf(again.app), 1);
    }
  });

  it('keeps the lost-task note across a rejected handoff and restart until a send accepts it', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    command(rt, 'Build the app', 'job1');
    const limits = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    limits.set('demo:default', [{ id: 'seven_day', label: 'Weekly', percent: 100, resetsAt: Date.now() + 86400_000 }]);
    const dest = h.app.provider('demo', work.id);
    const open = dest.open.bind(dest);
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const s = await open(...args);
      s.send = async () => { throw Error('cannot send now'); };
      return s;
    });
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    rt.limitInBackground({ window: 'Weekly' });
    await until(() => notices(rt.items).some((n) => n.detail?.includes('cannot send now')), 'the failed handoff');
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    await again.app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    expect(again.ctl.sent[0].text).toContain('"Build the app" (command, task job1)');
  });

  it('C14 retains the restart marker when the recovered timeline cannot be saved', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.beginTurn('Thinking');
    rt.add({ type: 'text', text: 'last work', streaming: true });
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const blocked = path.join(h.home, 'sessions', rt.id + '.json.' + process.pid + '.tmp');
    mkdirSync(blocked);
    const again = start({}, { home: h.home });
    await again.app.call('session.snapshot', { sessionId: rt.id });
    await again.app.dispose();
    apps.splice(apps.indexOf(again.app), 1);
    const state = JSON.parse(readFileSync(path.join(h.home, 'state.json'), 'utf8')) as { sessions: SessionMeta[] };
    expect(state.sessions.find((s) => s.id === rt.id)?.pendingRestart).toBe(true);
    rmSync(blocked, { recursive: true });
    const restored = start({}, { home: h.home });
    const snap = await restored.app.call('session.snapshot', { sessionId: rt.id });
    expect(notices(snap.items).filter((n) => n.early === 'restart')).toHaveLength(1);
  });

  it('C7 stopping inside the destination dispatch suppresses the retry', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { provider: 'demo', next: work.id } });
    const wait = gate();
    let atDispatch = false;
    const dest = h.app.provider('demo', work.id);
    const open = dest.open.bind(dest);
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const s = await open(...args);
      const send = s.send.bind(s);
      s.send = async (item, opts) => { atDispatch = true; await wait.wait; opts?.check?.(); await send(item); };
      return s;
    });
    const moving = h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true });
    await until(() => atDispatch, 'the provider dispatch');
    await h.app.call('session.interrupt', { sessionId: rt.id });
    wait.release();
    await moving;
    expect(h.ctl.sent).toHaveLength(0);
    expect(rt.meta.accountId).toBe(work.id);
  });

  it('C10 freezes the last pre-quit version while a previous save is draining', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const line = rt.add({ type: 'text', text: 'draft', streaming: true });
    const writing = h.app.store.flush();
    rt.patch(line.id, { text: 'final answer' });
    rt.update({ title: 'at quit' });
    const closing = h.app.dispose();
    rt.patch(line.id, { text: 'after quit' });
    rt.update({ title: 'after quit' });
    await Promise.all([writing, closing]);
    apps.splice(apps.indexOf(h.app), 1);
    await tick(1550);
    const again = start({}, { home: h.home });
    const snap = await again.app.call('session.snapshot', { sessionId: rt.id });
    expect(snap.session.title).toBe('at quit');
    expect(snap.items.find((i) => i.id === line.id)).toMatchObject({ text: 'final answer' });
  });

  it('runtime-F4 saves the final answer before a slow check disposer', async () => {
    const h = start();
    const { studio } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const line = rt.add({ type: 'text', text: 'final answer', streaming: false });
    const done = gate();
    let checking = false;
    vi.spyOn((h.app as unknown as { checks: { dispose(): Promise<void> } }).checks, 'dispose').mockImplementation(async () => { checking = true; await done.wait; });
    const quit = h.app.dispose();
    try {
      await until(() => checking, 'disposing checks');
      expect(h.app.store.loadSession(rt.id).items.map((i) => i.id)).toContain(line.id);
    } finally { done.release(); await quit; apps.splice(apps.indexOf(h.app), 1); }
  });

  it('an old window updating a pin cannot relabel a moved process', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const stale = { pinned: true, accountId: studio.id, movedFrom: work.id, returnAt: Date.now() };
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await h.app.call('session.update', { sessionId: rt.id, patch: stale });
    expect(rt.meta).toMatchObject({ pinned: true, accountId: work.id });
    expect(rt.meta.movedFrom).toBeUndefined();
  });

  it('another automatic move back to the preferred account clears its return', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    rt.update({ movedFrom: work.id, returnAt: Date.now() + 86400_000 });
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(work.id);
    expect(rt.meta.movedFrom).toBeUndefined();
    expect(rt.meta.returnAt).toBeUndefined();
  });

  it('holds the source account until a refused handoff has rolled back', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { next: work.id } });
    const wait = gate();
    let delivering = false;
    const dest = h.app.provider('demo', work.id);
    const open = dest.open.bind(dest);
    vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      handle.send = async () => { delivering = true; await wait.wait; throw Error('cannot start'); };
      return handle;
    });
    const move = h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true }).catch((e: Error) => e);
    await until(() => delivering, 'the destination dispatch');
    try {
      await expect(h.app.call('account.remove', { provider: 'demo', accountId: studio.id })).rejects.toThrow(/move/);
    } finally { wait.release(); await move; }
    expect(rt.meta.accountId).toBe(studio.id);
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi' });
    expect(h.ctl.sent.at(-1)?.home).toBe(studio.dir);
  });

  it('a failed return keeps the source header through start and reconnect, and a later return succeeds', async () => {
    const h = start();
    const { rt, studio, work } = await owingReturn(h);
    const dest = h.app.provider('demo', studio.id);
    const wait = gate();
    let starting = false;
    vi.spyOn(dest, 'open').mockImplementationOnce(async () => { starting = true; await wait.wait; throw Error('source unavailable'); });
    const moving = h.app.returnAfterLimit(rt);
    try {
      await until(() => starting, 'the destination start');
      expect((await h.app.call('app.hello', {})).sessions.find((s) => s.id === rt.id)?.accountId).toBe(work.id);
      expect((await h.app.call('session.snapshot', { sessionId: rt.id })).session.accountId).toBe(work.id);
    } finally { wait.release(); await moving; }
    expect(lastNotice(rt)).toMatchObject({ variant: 'info', text: 'Could not return to Studio' });
    expect(rt.meta).toMatchObject({ accountId: work.id, movedFrom: studio.id, status: 'idle' });
    await h.app.returnAfterLimit(rt, { retry: true });
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.returnAt).toBeUndefined();
  });

  it('the window receives the built-in account and cleared return at a manual move, including across reconnect', async () => {
    const h = start();
    const { rt, work } = await owingReturn(h);
    let header: SessionMeta = structuredClone(rt.meta);
    h.app.subscribe((e) => {
      const wire = JSON.parse(JSON.stringify(e)) as typeof e;
      if (wire.type === 'session.updated' && wire.id === rt.id) Object.assign(header, wire.patch);
      if (wire.type === 'session.added' && wire.session.id === rt.id) header = wire.session;
    });
    const dest = h.app.provider('demo', DEFAULT_ACCOUNT);
    const copy = gate();
    let copying = false;
    dest.adoptConversation = async () => { copying = true; await copy.wait; return true; };
    const moving = h.app.call('session.switchAccount', { sessionId: rt.id, accountId: DEFAULT_ACCOUNT });
    await until(() => copying, 'copy');
    try {
      const hello = await h.app.call('app.hello', {});
      expect(hello.sessions.find((s) => s.id === rt.id)?.accountId).toBe(work.id);
      expect((await h.app.call('session.snapshot', { sessionId: rt.id })).session.accountId).toBe(work.id);
    } finally { copy.release(); await moving; }
    expect(header.accountId ?? DEFAULT_ACCOUNT).toBe(DEFAULT_ACCOUNT);
    expect(header.returnAt ?? undefined).toBeUndefined();
    expect(header.movedFrom ?? undefined).toBeUndefined();
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    expect(h.ctl.sent.at(-1)).toMatchObject({ account: DEFAULT_ACCOUNT, home: '' });
  });
});

describe('the account that refused Fable', () => {
  it.each(['planning', 'final reading'])('keeps an Opus reset pinned to its refused and wake models at %s', async stage => {
    const h = start();
    const rt = await chat(h, DEFAULT_ACCOUNT);
    rt.update({ model: 'opus' });
    const later = Date.now() + 3600000;
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: {
      provider: 'demo', origin: 'background', resetsAt: Date.now() - 1,
      window: 'Weekly · Fable', wakeWindow: 'Weekly · Sonnet',
    } });
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Another limit', limit: { provider: 'demo', window: 'Weekly · Opus' } });
    let reads = 0;
    const planner = h.app as unknown as { spareAccounts(p: string): Promise<unknown[]> };
    vi.spyOn(planner, 'spareAccounts').mockImplementation(async () => {
      const full = ++reads > 1 || stage === 'planning';
      return [{ id: DEFAULT_ACCOUNT, signedIn: true, planLimits: true, limits: [
        { id: 'model_opus', label: 'Weekly · Opus', percent: 10 },
        { id: 'model_fable', label: 'Weekly · Fable', percent: full ? 100 : 10, resetsAt: later },
        { id: 'model_sonnet', label: 'Weekly · Sonnet', percent: full ? 100 : 10, resetsAt: later + 60000 },
      ] }];
    });
    await h.app.call('spare.atReset', { sessionId: rt.id, refusalId: card.id });
    await until(() => h.ctl.sent.length > 0 || rt.meta.spare?.at === later + 60000, 'planner decision');
    expect(h.ctl.sent).toEqual([]);
    expect(rt.meta.spare).toMatchObject({ refusalId: card.id, at: later + 60000 });
    expect(reads).toBeGreaterThanOrEqual(stage === 'planning' ? 1 : 2);
  });

  it('keeps a known reset actionable when the alternative account lookup fails', async () => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: true } });
    vi.spyOn(h.app, 'nextAccount').mockRejectedValueOnce(new Error('reading accounts failed'));
    const resetsAt = Date.now() + 3600_000;
    rt.limitInBackground({ window: 'Weekly · Fable', resetsAt });
    await until(() => !!rt.meta.spare, 'reset wait after lookup failure');
    const card = notices(rt.items).find(n => n.id === rt.meta.spare?.refusalId);
    expect(card?.limit).toMatchObject({ window: 'Weekly · Fable', resetsAt });
    expect(card!.limit!.provider).toBeUndefined();
    expect(h.ctl.sent).toEqual([]);
  });

  it('revalidates a manual Continue destination after its Fable week fills', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    const limits = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
    const full = [{ id: 'model_Fable', label: 'Weekly · Fable', percent: 100, resetsAt: Date.now() + 60000 }];
    limits.set('demo:' + work.id, full);
    limits.set('demo:default', full);
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'background', provider: 'demo', accountId: studio.id, next: work.id, window: 'Weekly · Fable' } });
    await expect(h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true, refusalId: card.id })).rejects.toThrow(/room/i);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(card.limit?.next).toBeUndefined();
    expect(h.ctl.sent).toEqual([]);
  });

  it('still carries agent-begun work after restarting with its limit card open', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false, continueAtReset: false } });
    rt.add<UserItem>({ type: 'user', text: 'already handled', state: 'sent' });
    rt.add({ type: 'turn', durationMs: 100 });
    rt.limitInBackground({ window: 'Weekly · Fable' });
    await until(() => notices(rt.items).some((n) => !!n.limit?.provider), 'the decided refusal');
    await h.app.dispose();
    apps.splice(apps.indexOf(h.app), 1);
    const again = start({}, { home: h.home });
    await again.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id, retry: true });
    expect(again.ctl.sent[0].text.startsWith(RESUME_UNDER_ANOTHER)).toBe(true);
  });

  it.each(['wake', 'wake (overage row)', 'person', 'person (words only)'] as const)('carries the %s request once to the account with Fable room', async (origin) => {
    const h = start();
    const { studio, work } = await twoAccounts(h);
    const third = await demoAccount(h.app, 'Third', 'light');
    const rt = await chat(h, studio.id);
    const reset = Date.now() + 86400_000;
    const window = 'Weekly · Fable';
    for (const [id, weekly, fable] of [[studio.id, 81, 100], [work.id, 0, 100], [third.id, 52, 21], [DEFAULT_ACCOUNT, 100, 100]] as const) {
      const limits: RateLimit[] = [{ id: 'seven_day', label: 'Weekly', percent: weekly, resetsAt: reset }, { id: id === studio.id && origin === 'wake (overage row)' ? 'seven_day_overage_included' : 'model_Fable', label: window, percent: fable, resetsAt: reset }];
      (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache.set(`demo:${id}`, limits);
    }
    rt.update({ model: 'opus' });
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true, defaultModels: { demo: 'opus' } } });
    if (origin.startsWith('wake')) {
      rt.limitInBackground({ window, resetsAt: reset });
    } else {
      rt.add<UserItem>({ type: 'user', text: 'my new question', state: 'sent' });
      rt.beginTurn('Thinking');
      rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Fable limit', detail: "You've hit your Fable limit · resets Nov 25, 3pm (Europe/Berlin). Switch to another model to continue.", limit: { window: origin === 'person (words only)' ? 'Weekly · all models' : window, resetsAt: reset } });
      rt.endTurn('Fable limit');
    }
    expect(notices(rt.items).some((n) => !!n.limit)).toBe(true);
    await until(() => h.ctl.sent.length > 0, 'the carry-on');
    const card = notices(rt.items).find((n) => n.limit)!;
    expect(card.limit).toMatchObject({ accountId: studio.id, next: third.id, continuedWith: third.id });
    expect(h.ctl.sent.map((s) => [s.home, s.account, s.text.split('\n\n')[0]])).toEqual([[third.dir, third.id, origin.startsWith('wake') ? RESUME_UNDER_ANOTHER : 'my new question']]);
  });
});

describe('a move Sable makes by itself waits for work in the background (D1, E3)', { timeout: 20_000 }, () => {
  it.each(['return', 'cap'])('the night run holds a %s on B through both the fresh and resumed agent', async reason => {
    const h = start();
    const { studio: a, work: b } = await twoAccounts(h);
    const rt = await chat(h, a.id, { tokens: 453000 });
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const reset = Date.now() + 3600000;
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: '5-hour limit reached', limit: { origin: 'background', window: '5-hour', resetsAt: reset } });
    h.ctl.carryOn = r => {
      r.beginTurn();
      r.add<ToolItem>({ id: 'fresh-call', type: 'tool', name: 'Agent', kind: 'agent', title: 'Fresh', status: 'done', detail: {}, result: { agent: { background: 'running' } } });
      r.setReportedTasks([{ id: 'fresh', itemId: 'fresh-call', agent: true }, { id: 'resumed', agent: true }]);
    };
    await h.app.switchAccount(rt, b.id, { automatic: true, retry: true, limitReturn: { at: reset } });
    expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBe(b.id);
    expect(h.ctl.sent.map(s => s.account)).toEqual([b.id]);
    expect(notices(rt.items).some(i => i.text === 'Carried as it is' && i.detail?.includes('453k'))).toBe(true);
    rt.update({ returnAt: reason === 'return' ? Date.now() - 1 : reset, usage: { ...rt.meta.usage, contextTokens: 462000 } });
    if (reason === 'cap') await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${b.id}`]: { weekly: 1 } } } });
    rt.endTurn();
    const check = () => reason === 'return' ? h.app.returnAfterLimit(rt) : internals(h.app).checkCap(rt);
    await check();
    expect(rt.meta.background).toBe(2);
    rt.stopBackground(i => i.id === 'fresh-call');
    rt.setReportedTasks([{ id: 'resumed', agent: true }]);
    await check();
    expect(rt.meta.accountId).toBe(b.id);
    expect(h.ctl.closed.filter(s => s.home === b.dir)).toEqual([]);
    expect(h.ctl.sent.map(s => s.text)).not.toContain('/compact');
    rt.setReportedTasks([]);
    await until(() => !rt.meta.moving && rt.meta.accountId !== b.id, 'the deferred move');
    if (reason === 'return') {
      expect(rt.meta.accountId).toBe(a.id);
      expect(h.ctl.sent.map(s => s.text)).not.toContain('/compact');
    }
  });

  it.each(['return', 'cap'])('wakes exactly once on the destination after a %s loses an old command', async reason => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    command(rt, 'Serve reports', 'old-server', 31 * 60_000);
    if (reason === 'return') {
      rt.update({ movedFrom: work.id, returnAt: Date.now() - 1 });
      await h.app.returnAfterLimit(rt);
    } else {
      await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
      await internals(h.app).checkCap(rt);
    }
    await until(() => h.ctl.sent.length > 0, 'the lost-work wake', 800);
    expect(h.ctl.sent.map(s => s.account)).toEqual([work.id]);
    expect(h.ctl.sent[0].text).toContain('Serve reports');
    expect(h.ctl.sent[0].text).toContain('no notification will come');
    expect(parseSynthetic(h.ctl.sent[0].text)?.role).toBe('hidden');
    expect(notices(rt.items).filter(n => n.text.includes('The agent was told and carries on.'))).toHaveLength(1);
    expect(rt.pendingLost().names).toEqual([]);
  });

  it.each(['death', 'capability'] as const)('wakes at rest after process %s with the command and the SDK-list-only agent in one message', async cause => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    command(rt, 'Collect reports', 'report');
    rt.setReportedTasks([{ id: 'reviewer', agent: true }]);
    rt.tasksLost('process', cause);
    rt.setReportedTasks([]);
    await until(() => h.ctl.sent.length > 0, 'a hidden wake', 800);
    expect(h.ctl.sent).toHaveLength(1);
    expect(h.ctl.sent[0].text).toContain('Collect reports');
    expect(h.ctl.sent[0].text).toContain('reviewer');
    expect(parseSynthetic(h.ctl.sent[0].text)?.role).toBe('hidden');
    expect(notices(rt.items).filter(n => n.text.startsWith('2 background tasks were lost'))).toHaveLength(1);
    await until(() => !rt.turnActive, 'the wake answer');
    expect(h.ctl.sent).toHaveLength(1);
  });

  it.each(['Stop', 'close', 'manual move', 'held phone mode'])('leaves lost work for a personal message after %s', async action => {
    const h = start({ closeCuts: true }), { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    command(rt, 'Waiting for CI', 'ci');
    if (action === 'manual move') await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    else if (action === 'close') await h.app.call('session.close', { sessionId: rt.id });
    else {
      if (action === 'held phone mode') {
        rt.beginTurn();
        await h.app.call('session.setMode', { sessionId: rt.id, mode: 'bypassPermissions', answerWaiting: false });
        rt.endTurn();
      }
      rt.tasksLost('process', 'death');
      if (action === 'Stop') await h.app.call('session.interrupt', { sessionId: rt.id });
    }
    await tick(80);
    expect(h.ctl.sent).toHaveLength(0);
    expect(rt.pendingLost().names.join()).toContain('Waiting for CI');
    if (action === 'held phone mode') expect(rt.dangerHeld).toBe(true);
  });

  it('keeps the phone mode held through an automatic reset', async () => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    rt.beginTurn();
    await h.app.call('session.setMode', { sessionId: rt.id, mode: 'bypassPermissions', answerWaiting: false });
    rt.endTurn();
    const card = rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'background', provider: 'demo' } });
    const planner = h.app as unknown as { startSpare(rt: SessionRuntime, account: string, wait: { reason: 'reset'; refusalId: string }): Promise<void> };
    await planner.startSpare(rt, DEFAULT_ACCOUNT, { reason: 'reset', refusalId: card.id });
    expect(rt.dangerHeld).toBe(true);
    expect(h.ctl.sent).toEqual([]);
    expect(rt.get<NoticeItem>(card.id)?.limit?.continuedWith).toBeUndefined();
  });

  it('a delayed loss stays on its original account after a manual move', async () => {
    const h = start(), { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    rt.update({ lossWake: { attempts: [Date.now() - 599_650, Date.now()] } });
    command(rt, 'Collect reports', 'reports');
    rt.tasksLost('process', 'capability');
    await tick(25);
    await h.app.call('session.switchAccount', { sessionId: rt.id, accountId: work.id });
    await tick(400);
    expect(h.ctl.sent).toEqual([]);
    await h.app.call('session.send', { sessionId: rt.id, text: 'Check on the reports' });
    expect(h.ctl.sent[0].text).toContain('Collect reports');
  });

  it('a confirmed personal turn frees recovery from an older refusal', async () => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'Limit', limit: { origin: 'user', provider: 'demo' } });
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    await until(() => !rt.turnActive, 'the later successful turn');
    command(rt, 'Collect reports', 'reports');
    rt.tasksLost('process', 'capability');
    await until(() => h.ctl.sent.length === 2, 'recovery after the personal turn', 1000);
    expect(h.ctl.sent[1].text).toContain('Collect reports');
  });

  it.each([false, true])('announces a loss only after the provider accepts it (accepted %s)', async accepted => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    const tracker = new Attention();
    tracker.seed([rt.meta]);
    const news: string[] = [];
    const off = h.app.subscribe(event => news.push(...tracker.feed(event).map(signal => signal.kind)));
    const entered = gate(), reply = gate(), done = gate();
    rt.handle!.send = async () => {
      entered.release();
      await reply.wait;
      done.release();
      if (!accepted) throw Error('input was rejected');
    };
    command(rt, 'Collect reports', 'reports');
    rt.tasksLost('process', 'capability');
    try {
      await entered.wait;
      expect(news).not.toContain('lost');
    } finally { reply.release(); await done.wait; await tick(); off(); }
    expect(news.filter(kind => kind === 'lost')).toHaveLength(accepted ? 1 : 0);
  });

  it('a personal send in flight receives the loss instead of a second send', async () => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    const inLane = gate(), go = gate();
    const lanes = (h.app as unknown as { lanes: { ready(rt: SessionRuntime): Promise<void> } }).lanes;
    vi.spyOn(lanes, 'ready').mockImplementationOnce(async () => { inLane.release(); await go.wait; });
    const personal = h.app.call('session.send', { sessionId: rt.id, text: 'Show me the results' });
    await inLane.wait;
    try {
      command(rt, 'Collect results', 'ci');
      rt.tasksLost('process', 'death');
      await tick(60);
      expect(h.ctl.sent).toHaveLength(0);
    } finally { go.release(); await personal; }
    await until(() => !rt.turnActive, 'the answer');
    expect(h.ctl.sent).toHaveLength(1);
    expect(stripWrappers(h.ctl.sent[0].text)).toBe('Show me the results');
    expect(h.ctl.sent[0].text).toContain('Collect results');
  });

  it('a loss waits for the limit decision and move, then rides the one carry-on', async () => {
    const h = start(), { studio, work } = await twoAccounts(h);
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
    const deciding = gate(), decide = gate(), copying = gate(), copy = gate();
    vi.spyOn(h.app, 'nextAccount').mockImplementationOnce(async () => { deciding.release(); await decide.wait; return work.id; });
    vi.spyOn(h.app.provider('demo', work.id), 'adoptConversation').mockImplementationOnce(async () => { copying.release(); await copy.wait; return true; });
    rt.limitInBackground({ window: '5-hour', resetsAt: Date.now() + 3600000 });
    await deciding.wait;
    try {
      command(rt, 'Review output', 'r');
      rt.tasksLost('process', 'death');
      await tick(60);
      expect(h.ctl.sent).toHaveLength(0);
      decide.release();
      await copying.wait;
      await tick(60);
      expect(h.ctl.sent).toHaveLength(0);
    } finally { decide.release(); copy.release(); }
    await until(() => h.ctl.sent.length > 0 && !rt.turnActive && !rt.meta.moving, 'the limit carry-on');
    expect(h.ctl.sent.map(s => s.account)).toEqual([work.id]);
    expect(h.ctl.sent[0].text).toContain('Review output');
    expect(parseSynthetic(h.ctl.sent[0].text)?.role).toBe('hidden');
    expect(notices(rt.items).filter(n => n.text.includes('The agent was told and carries on.'))).toHaveLength(1);
  });

  it.each(['rate limit', 'early death', 'later death', 'another process'])('bounds automatic recovery across a %s', async guard => {
    const h = start(), rt = await chat(h, DEFAULT_ACCOUNT);
    await tick();
    vi.useFakeTimers();
    try {
      const lose = async (id: string, cause: 'death' | 'capability') => {
        command(rt, id, id);
        rt.tasksLost('process', cause);
        await vi.advanceTimersByTimeAsync(1000);
      };
      await lose('first', 'capability');
      expect(h.ctl.sent).toHaveLength(1);
      if (guard === 'another process') rt.processGeneration++;
      if (guard === 'later death') await vi.advanceTimersByTimeAsync(120000);
      if (guard === 'rate limit') {
        await lose('second', 'capability');
        await lose('third', 'capability');
        expect(h.ctl.sent).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(600000);
        expect(h.ctl.sent).toHaveLength(3);
      } else {
        // A process that crashes without any new tasks must still trip the guard.
        rt.tasksLost('process', 'death');
        await vi.advanceTimersByTimeAsync(600000);
        await lose('second', 'capability');
        expect(h.ctl.sent).toHaveLength(guard === 'early death' ? 1 : 2);
      }
    } finally { vi.useRealTimers(); }
  });
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
  it.each(['copy', 'missing copy', 'close', 'exit', 'compact', 'compact result', 'open', 'send'] as const)('recovers an automatic %s failure on the old account and retries', async (failure) => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id, { tokens: failure.startsWith('compact') ? 740_000 : undefined });
    const dest = h.app.provider('demo', work.id);
    const id = rt.meta.providerSessionId;
    const emitted: string[] = [];
    h.app.subscribe((raw) => {
      const e = JSON.parse(JSON.stringify(raw)) as typeof raw;
      if (e.type === 'session.updated' && e.id === rt.id && e.patch.accountId !== undefined) emitted.push(e.patch.accountId);
      if (e.type === 'session.added' && e.session.id === rt.id) emitted.push(e.session.accountId ?? DEFAULT_ACCOUNT);
    });
    const fail = async () => { throw Error('simulated ' + failure + ' failure'); };
    const opened = dest.open.bind(dest);
    if (failure === 'copy') vi.spyOn(dest, 'adoptConversation').mockImplementationOnce(fail);
    if (failure === 'missing copy') vi.spyOn(dest, 'adoptConversation').mockResolvedValueOnce(false);
    if (failure === 'close') vi.spyOn(rt.handle!, 'close').mockImplementationOnce(fail);
    if (failure === 'exit') rt.handle!.exited = vi.fn(async () => {}).mockImplementationOnce(fail);
    if (failure === 'compact') vi.spyOn(rt.handle!, 'send').mockImplementationOnce(fail);
    if (failure === 'compact result') vi.spyOn(rt.handle!, 'send').mockImplementationOnce(async () => {
      rt.beginTurn('Compacting');
      rt.notice('error', 'Could not compact the transcript', 'simulated compact failure');
      rt.endTurn('simulated compact failure');
    });
    if (failure === 'open') vi.spyOn(dest, 'open').mockImplementationOnce(async () => {
      rt.notice('error', 'The new process could not start');
      return fail();
    });
    if (failure === 'send') vi.spyOn(dest, 'open').mockImplementationOnce(async (...args) => {
      const handle = await opened(...args);
      handle.send = async () => {
        rt.beginTurn('Starting');
        rt.notice('error', 'The new process could not take the message');
        return fail();
      };
      return handle;
    });
    if (failure === 'send' || failure === 'open') {
      // The account that refused this turn is the only one with a full week.
      const limits = (h.app as unknown as { limitsCache: Map<string, RateLimit[]> }).limitsCache;
      limits.set('demo:default', [{ id: 'seven_day', label: 'Weekly', percent: 100, resetsAt: Date.now() + 86400_000 }]);
      await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
      rt.limitInBackground({ window: 'Weekly', resetsAt: Date.now() + 86400_000 });
      await until(() => notices(rt.items).some((n) => /simulated/.test(n.detail ?? '')), 'the switch explanation');
    } else {
      await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
      await internals(h.app).checkCap(rt);
    }
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.providerSessionId).toBe(id);
    expect(emitted.at(-1)).toBe(studio.id);
    expect(rt.meta.movedFrom).toBeUndefined();
    expect(rt.meta.returnAt).toBeUndefined();
    expect(rt.meta.status).toBe('idle');
    expect(rt.turnActive).toBe(false);
    if (['copy', 'open', 'send'].includes(failure)) expect(rt.handle).toBeDefined();
    expect(notices(rt.items).some((n) => n.variant === 'error' && !n.limit)).toBe(false);
    expect(notices(rt.items).some((n) => /could not|stayed/i.test(n.text + ' ' + n.detail))).toBe(true);
    // The account is usable. The same cap can move the same chat on the next try.
    await h.app.call('app.setSettings', { patch: { accountCaps: {} } });
    await h.app.call('session.send', { sessionId: rt.id, text: 'hi again' });
    expect(h.ctl.sent.at(-1)).toMatchObject({ home: studio.dir, account: studio.id });
    await until(() => !rt.turnActive, 'idle after recovery');
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(work.id);
  });

  it('leaves nothing behind (where it goes back, where new chats start) and says so', async () => {
    const h = start();
    const { studio, work } = await twoAccounts(h, 'near');
    const rt = await chat(h, studio.id);
    await h.app.call('app.setSettings', { patch: { accountCaps: { [`demo:${studio.id}`]: { weekly: 70 } } } });
    const accounts: string[] = [];
    h.app.subscribe((e) => {
      if (e.type === 'session.updated' && e.id === rt.id && e.patch.accountId) accounts.push(e.patch.accountId);
    });
    internals(h.app).removingAccounts.add(`demo:${work.id}`);
    await internals(h.app).checkCap(rt);
    expect(rt.meta.accountId).toBe(studio.id);
    expect(rt.meta.movedFrom).toBeUndefined();
    expect(rt.meta.returnAt).toBeUndefined();
    expect(internals(h.app).fallbacks.has('demo')).toBe(false);
    expect(accounts.at(-1)).toBe(studio.id);
    expect(lastNotice(rt)).toMatchObject({ variant: 'info', text: 'Could not move to Work', detail: expect.stringMatching(/being removed/) });
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

  it('removes only the sign-in refusal footer during a silent retry', async () => {
    const { app, rt } = await refused();
    const handle = rt.handle!;
    const send = handle.send.bind(handle);
    let completed = '', refusedEnd = '';
    vi.spyOn(handle, 'send').mockImplementationOnce(async () => {
      rt.beginTurn();
      completed = rt.add({ type: 'turn', durationMs: 50 }).id;
      refusedEnd = rt.add({ type: 'turn', durationMs: 1 }).id;
      noteAuthFailure(rt.id);
      rt.endTurn(AUTH_FAILURE_TEXT);
    }).mockImplementation(send);
    await app.call('session.send', { sessionId: rt.id, text: 'retry after sign-in' });
    await until(() => !rt.get(refusedEnd), 'the silent retry');
    expect(rt.get(completed)).toMatchObject({ type: 'turn', durationMs: 50 });
  });
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

  it('says what happened when the agent still holds the refused message after ten seconds', async () => {
    const { app, log, rt } = await refused();
    (rt.handle as ProviderSession).liveWork = () => ({ turn: true, agents: 0, commands: 0 });
    log.refuse = 1;
    await app.call('session.send', { sessionId: rt.id, text: 'hi there' });
    await until(() => log.sent.length === 1 && !rt.turnActive, 'the refusal');
    await until(() => notices(rt.items).some((n) => /sign-in/i.test(n.text) && /still working/i.test(n.detail ?? '')), 'the sign-in notice', 12500);
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
