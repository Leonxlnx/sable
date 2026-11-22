/**
 * A plan limit met by a chat's background work (limit1, day 5): the owner watched seven background
 * sub-agents of a chat on Max3 run into its 5-hour limit after the chat's own turn had ended. Seven
 * red boxes and a card "on This account", and nothing moved for ten minutes although other accounts
 * had room. Now:
 * - said once: no notice per refused sub-agent, one limit card naming the account, the step "Stopped";
 * - moved at once: the same decision as a refused turn, within seconds, what still runs stopped at
 *   the limit, and the chat carries on by itself with a hidden continuation naming those agents;
 * - back again: when the account it left takes work again, at rest or right before the next message,
 *   never mid-turn.
 * Demo agent and a fake Claude query only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT, type NoticeItem, type SessionMeta, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import { parseSynthetic, RESUME_UNDER_ANOTHER, stripWrappers } from '@shared/synthetic';
import { App } from '../server/app';
import { SessionRuntime } from '../server/core/runtime';
import { backgroundLimitDue, limitStoppedAgents, readingShowsRoom, returnRetryMs, returnTarget } from '../server/core/limit-policy';
import { ClaudeProvider } from '../server/providers/claude';
import { DemoProvider } from '../server/providers/demo';
import type { ProviderContext, ProviderSession } from '../server/providers/types';
import { agentLine } from '../src/features/timeline/agent-line';
import { statusLabel, statusTone } from '../src/features/sidebar/SessionRow';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}
function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** The demo agent recording each message it was given, with the account the chat was on then. */
class RecordingDemo extends DemoProvider {
  constructor(
    ctx: ProviderContext,
    private sent: { text: string; account: string }[],
    speed = 0,
  ) {
    super(ctx, { speed });
  }
  override async open(rt: SessionRuntime, opts: { loadTranscript?: boolean }): Promise<ProviderSession> {
    const s = await super.open(rt, opts);
    const send = s.send.bind(s);
    s.send = (item) => {
      this.sent.push({ text: item.text, account: rt.meta.accountId ?? DEFAULT_ACCOUNT });
      return send(item);
    };
    return s;
  }
}

/** The demo whose built-in account is at its limit too. */
class CappedDemo extends RecordingDemo {
  override limitProfile() {
    return super.limitProfile() === 'calm' && !this.configHome() ? ('cap' as const) : super.limitProfile();
  }
}

type Profile = 'calm' | 'cap' | 'near' | 'light';

async function setProfile(app: App, account: { id: string; dir?: string }, label: string, profile: Profile) {
  writeFileSync(path.join(account.dir!, 'demo-auth.json'), JSON.stringify({ email: `${label.toLowerCase()}@example.dev`, plan: 'Max', limits: profile }));
  await app.call('auth.refresh', { provider: 'demo', accountId: account.id });
  await app.call('provider.limits', { provider: 'demo', accountId: account.id, force: true });
}

async function demoAccount(app: App, label: string, profile: Profile) {
  const { account } = await app.call('account.add', { provider: 'demo', label });
  await setProfile(app, account, label, profile);
  return account;
}

function start(opts: { capped?: boolean; ms?: { settle: number; max: number } } = {}) {
  const home = temp('sable-limit-bg-');
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  const sent: { text: string; account: string }[] = [];
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    providers: [(ctx) => (opts.capped ? new CappedDemo(ctx, sent) : new RecordingDemo(ctx, sent))],
    backgroundLimitMs: opts.ms ?? { settle: 60, max: 400 },
  });
  cleanups.push(() => app.dispose());
  return { app, cwd, sent };
}

const agentStep = (i: number): ToolItem => ({
  id: `toolu_${i}`,
  ts: Date.now(),
  type: 'tool',
  name: 'Agent',
  kind: 'agent',
  title: `Audit part ${i}`,
  status: 'done',
  detail: { description: `Audit part ${i}`, subagent: 'Explore', background: true },
  result: { agent: { background: 'running' } },
});

const notices = (items: TimelineItem[]) => items.filter((i): i is NoticeItem => i.type === 'notice');
const cards = (items: TimelineItem[]) => notices(items).filter((n) => n.limit);
/** Red boxes of the agent's own words for a refused request (what the owner saw seven times). */
const redBoxes = (items: TimelineItem[]) => notices(items).filter((n) => n.variant === 'error' && !n.limit);

/** A chat on Max3 whose own turn ended with seven agents working in the background; Ultra3 has room. */
async function crewOnMax3(opts: { capped?: boolean; ultra?: boolean; ms?: { settle: number; max: number } } = {}) {
  const h = start(opts);
  await h.app.call('app.setSettings', { patch: { continueAtLimit: true } });
  const max3 = await demoAccount(h.app, 'Max3', 'light');
  const ultra3 = opts.ultra === false ? undefined : await demoAccount(h.app, 'Ultra3', 'light');
  // The built-in account's limits are known (at its limit too, with `capped`).
  await h.app.call('provider.limits', { provider: 'demo', force: true });
  const snap = await h.app.call('session.create', { provider: 'demo', cwd: h.cwd, accountId: max3.id, mode: 'bypassPermissions' });
  const rt = h.app.runtime(snap.session.id);
  await h.app.call('session.send', { sessionId: rt.id, text: 'hi' });
  await until(() => rt.meta.status === 'idle' && rt.items.some((i) => i.type === 'text'), 'first answer');
  rt.add<UserItem>({ type: 'user', text: 'audit the seven parts in the background', state: 'sent' });
  for (let i = 1; i <= 7; i++) rt.add<ToolItem>(agentStep(i));
  rt.add({ type: 'text', text: 'Seven agents are working on it.', streaming: false });
  expect(rt.meta.background).toBe(7);
  // Max3 reaches its 5-hour limit.
  await setProfile(h.app, max3, 'Max3', 'cap');
  h.sent.length = 0;
  return { ...h, rt, max3, ultra3: ultra3! };
}

const hit = (i: number) => ({ stepId: `toolu_${i}`, window: '5-hour limit', resetsAt: Date.now() + 38 * 60_000, detail: "You've hit your 5-hour limit" });

describe('seven background agents refused at a limit with the turn ended', { timeout: 20_000 }, () => {
  it('says it once, moves at once, and carries on with a continuation naming them', async () => {
    const h = await crewOnMax3();
    // Five are refused with their next request; two are still in a long command.
    for (let i = 1; i <= 5; i++) h.rt.limitInBackground(hit(i));
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(redBoxes(h.rt.items)).toHaveLength(0);
    // Each refused one stopped at the limit, with the reason, and no longer counts.
    expect(h.rt.get<ToolItem>('toolu_1')!.result!.agent).toMatchObject({ background: 'stopped', limit: { window: '5-hour limit' } });
    expect(agentLine(h.rt.get<ToolItem>('toolu_1')!, 0)).toMatchObject({ state: 'Stopped', why: expect.stringMatching(/^5-hour limit reached/) });
    expect(h.rt.meta.background).toBe(2);

    await until(() => h.rt.meta.accountId === h.ultra3.id && h.sent.length > 0, 'the move and the continuation');
    const card = cards(h.rt.items);
    expect(card).toHaveLength(1);
    expect(card[0].limit).toMatchObject({ provider: 'demo', accountId: h.max3.id, continuedWith: h.ultra3.id });
    expect(redBoxes(h.rt.items)).toHaveLength(0);
    // The two still running stopped at the limit too (they would be refused with their next request).
    expect(h.rt.meta.background).toBe(0);
    expect(h.rt.get<ToolItem>('toolu_7')!.result!.agent).toMatchObject({ background: 'stopped', limit: { window: '5-hour limit' } });
    // One message, on the new account: the carry-on, naming all seven by their task and call id.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].account).toBe(h.ultra3.id);
    const text = h.sent[0].text;
    expect(text.startsWith(RESUME_UNDER_ANOTHER)).toBe(true);
    for (let i = 1; i <= 7; i++) expect(text).toContain(`"Audit part ${i}" (Explore, call toolu_${i})`);
    // Hidden as Sable's own words wherever a transcript is read back.
    const words = text.split('\n\n<system-reminder>')[0];
    expect(parseSynthetic(words)?.role).toBe('hidden');
    // Nothing new in the person's column.
    expect(h.rt.items.filter((i) => i.type === 'user' && i.text === text)).toHaveLength(0);
    // The chat remembers where it came from, and when that account takes work again.
    expect(h.rt.meta.movedFrom).toBe(h.max3.id);
    expect(h.rt.meta.returnAt).toBeGreaterThan(Date.now());
  });

  it('the same with the turn still running: the turn says it, its end moves', async () => {
    const h = await crewOnMax3();
    h.rt.beginTurn('Thinking');
    for (let i = 1; i <= 3; i++) h.rt.limitInBackground(hit(i));
    // While the turn runs no card of the background's own: the turn's refusal says it.
    expect(cards(h.rt.items)).toHaveLength(0);
    expect(h.rt.get<ToolItem>('toolu_2')!.result!.agent!.background).toBe('stopped');
    await tick(100);
    expect(h.rt.meta.accountId).toBe(h.max3.id);
    // The turn's own request is refused: its one card, then the turn ends.
    h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit' } });
    h.rt.settle('error');
    h.rt.endTurn('You have reached your usage limit.');
    await until(() => h.rt.meta.accountId === h.ultra3.id && h.sent.length > 0, 'the move');
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(redBoxes(h.rt.items)).toHaveLength(0);
    expect(h.rt.meta.background).toBe(0);
    for (let i = 1; i <= 7; i++) expect(h.sent[0].text).toContain(`call toolu_${i}`);
  });

  it('a turn cut mid-work with no sub-agents moves too, and the card offers no button while it moves', async () => {
    const h = await crewOnMax3();
    for (let i = 1; i <= 7; i++) h.rt.patch<ToolItem>(`toolu_${i}`, { result: { agent: { background: 'done' } } });
    h.rt.beginTurn('Thinking');
    h.rt.add({ type: 'text', text: 'Reading the parser first.', streaming: false });
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit' } });
    // Every state the card passes through: it says it moves before it has moved.
    const seen: NoticeItem['limit'][] = [];
    const patch = h.rt.patch.bind(h.rt);
    h.rt.patch = ((id: string, p: Partial<NoticeItem>) => (id === card.id && seen.push(p.limit), patch(id, p as never))) as typeof h.rt.patch;
    h.rt.settle('error');
    h.rt.endTurn("You've hit your 5-hour limit · resets 6pm (Europe/Berlin)");
    await until(() => h.rt.meta.accountId === h.ultra3.id && h.sent.length > 0, 'the move');
    expect(seen.findIndex((l) => l?.moving)).toBeGreaterThanOrEqual(0);
    expect(seen.findIndex((l) => l?.moving)).toBeLessThan(seen.findIndex((l) => l?.continuedWith));
    // No state offered the button (a `next` without `moving`) before the move.
    expect(seen.slice(0, seen.findIndex((l) => l?.continuedWith)).filter((l) => l?.next && !l.moving)).toHaveLength(0);
    expect(h.rt.get<NoticeItem>(card.id)!.limit).toMatchObject({ continuedWith: h.ultra3.id });
    expect(h.rt.get<NoticeItem>(card.id)!.limit!.moving).toBeUndefined();
    expect(h.sent[0].text.startsWith(RESUME_UNDER_ANOTHER)).toBe(true);
  });

  it('with continue at a limit off: the card offers the move, nothing moves', async () => {
    const h = await crewOnMax3();
    await h.app.call('app.setSettings', { patch: { continueAtLimit: false } });
    h.rt.beginTurn('Thinking');
    h.rt.add({ type: 'text', text: 'Reading the parser first.', streaming: false });
    const card = h.rt.add<NoticeItem>({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit' } });
    h.rt.settle('error');
    h.rt.endTurn("You've hit your 5-hour limit · resets 6pm (Europe/Berlin)");
    await until(() => !!h.rt.get<NoticeItem>(card.id)!.limit!.provider, 'the decision');
    await tick(200);
    expect(h.rt.get<NoticeItem>(card.id)!.limit).toMatchObject({ next: h.ultra3.id });
    expect(h.rt.get<NoticeItem>(card.id)!.limit!.moving).toBeUndefined();
    expect(h.rt.get<NoticeItem>(card.id)!.limit!.continuedWith).toBeUndefined();
    expect(h.rt.meta.accountId).toBe(h.max3.id);
    expect(h.sent).toHaveLength(0);
  });

  it('with no account with room: the card as today, with Continue at reset, and nothing moves', async () => {
    const h = await crewOnMax3({ capped: true, ultra: false });
    for (let i = 1; i <= 7; i++) h.rt.limitInBackground(hit(i));
    await until(() => !!cards(h.rt.items)[0]?.limit?.provider, 'the decision');
    await tick(150);
    const [card] = cards(h.rt.items);
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(card.limit).toMatchObject({ provider: 'demo', accountId: h.max3.id, window: '5-hour limit' });
    expect(card.limit!.next).toBeUndefined();
    expect(card.limit!.continuedWith).toBeUndefined();
    // "Continue at reset" is offered while the reset is ahead (LimitNotice's canWait).
    expect(card.limit!.resetsAt).toBeGreaterThan(Date.now());
    expect(h.rt.meta.accountId).toBe(h.max3.id);
    expect(h.sent).toHaveLength(0);
    expect(redBoxes(h.rt.items)).toHaveLength(0);
  });

  it('a window of another model (a sub-agent of its own model) is only that step\'s', async () => {
    const h = await crewOnMax3();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    h.rt.limitInBackground({ stepId: 'toolu_1', window: 'Weekly · Demo Deep' });
    await tick(200);
    expect(h.rt.get<ToolItem>('toolu_1')!.result!.agent).toMatchObject({ background: 'stopped', limit: { window: 'Weekly · Demo Deep' } });
    // No row of that window known for the account: the chat cannot tell, so it says it once.
    expect(cards(h.rt.items).length).toBeLessThanOrEqual(1);
  });
});

describe('back to the account a limit moved the chat from', { timeout: 20_000 }, () => {
  async function moved(settings: Record<string, unknown> = {}) {
    const h = await crewOnMax3();
    for (let i = 1; i <= 7; i++) h.rt.limitInBackground(hit(i));
    await until(() => h.rt.meta.accountId === h.ultra3.id && h.sent.length > 0 && h.rt.meta.status === 'idle', 'the move');
    if (Object.keys(settings).length) await h.app.call('app.setSettings', { patch: settings });
    h.sent.length = 0;
    return h;
  }
  const armSoon = (h: Awaited<ReturnType<typeof moved>>) => {
    h.rt.update({ returnAt: Date.now() + 20 });
    (h.app as unknown as { armReturn(rt: SessionRuntime): void }).armReturn(h.rt);
  };

  it('at rest, once its window has reset (read fresh): one switch line, no message', async () => {
    const h = await moved();
    const users = h.rt.items.filter((i) => i.type === 'user').length;
    // Still at its limit when the time comes: it stays (the fresh reading decides).
    armSoon(h);
    await tick(1300);
    expect(h.rt.meta.accountId).toBe(h.ultra3.id);
    expect(h.rt.meta.movedFrom).toBe(h.max3.id);
    // The window resets.
    await setProfile(h.app, h.max3, 'Max3', 'light');
    (h.app as unknown as { returnChecked: Map<string, number> }).returnChecked.clear();
    armSoon(h);
    await until(() => (h.rt.meta.accountId ?? DEFAULT_ACCOUNT) === h.max3.id, 'the return', 4000);
    expect(notices(h.rt.items).pop()).toMatchObject({ variant: 'info', text: expect.stringMatching(/^Back on Max3/) });
    expect(h.rt.items.filter((i) => i.type === 'user')).toHaveLength(users);
    expect(h.sent).toHaveLength(0);
    expect(h.rt.meta.movedFrom).toBeUndefined();
    // Never a hop for nothing: once back, nothing more happens.
    await h.app.returnAfterLimit(h.rt);
    expect(notices(h.rt.items).filter((n) => /^Back on/.test(n.text))).toHaveLength(1);
  });

  it('right before the next message', async () => {
    const h = await moved();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    h.rt.update({ returnAt: Date.now() - 1 });
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'next step' });
    await until(() => h.sent.length === 1, 'the message');
    expect(h.sent[0].account).toBe(h.max3.id);
    expect(h.sent[0].text.startsWith('next step')).toBe(true);
    expect(notices(h.rt.items).some((n) => /^Back on Max3/.test(n.text))).toBe(true);
  });

  it('never mid-turn: it waits for the turn to end', async () => {
    const h = await moved();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    h.rt.beginTurn('Thinking');
    armSoon(h);
    await tick(1300);
    await h.app.returnAfterLimit(h.rt);
    expect(h.rt.meta.accountId).toBe(h.ultra3.id);
    // The turn ends: at rest now, it goes back.
    h.rt.endTurn();
    await until(() => (h.rt.meta.accountId ?? DEFAULT_ACCOUNT) === h.max3.id, 'the return after the turn', 4000);
  });

  it('not while background work runs', async () => {
    const h = await moved();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    h.rt.update({ returnAt: Date.now() - 1 });
    h.rt.add<ToolItem>(agentStep(9));
    await h.app.returnAfterLimit(h.rt);
    expect(h.rt.meta.accountId).toBe(h.ultra3.id);
    // Its last background work ends: the chat is at rest.
    h.rt.patch<ToolItem>('toolu_9', { result: { agent: { background: 'done' } } });
    await until(() => (h.rt.meta.accountId ?? DEFAULT_ACCOUNT) === h.max3.id, 'the return at rest', 4000);
  });

  it('a move by hand is the person\'s choice: nothing to go back to', async () => {
    const h = await moved();
    await h.app.call('session.switchAccount', { sessionId: h.rt.id, accountId: DEFAULT_ACCOUNT });
    expect(h.rt.meta.movedFrom).toBeUndefined();
  });
});

type Internals = {
  readLimits: (provider: string, accountId: string, force: boolean | 'fresh') => Promise<{ limits: unknown[]; fresh: boolean; signIn: number }>;
  returnTimers: Map<string, unknown>;
};

describe('review wave 16', { timeout: 20_000 }, () => {
  async function moved() {
    const h = await crewOnMax3();
    for (let i = 1; i <= 7; i++) h.rt.limitInBackground(hit(i));
    await until(() => h.rt.meta.accountId === h.ultra3.id && h.sent.length > 0 && h.rt.meta.status === 'idle', 'the move');
    h.sent.length = 0;
    return { ...h, internals: h.app as unknown as Internals };
  }

  it('#6 with no account to go on with, what still runs is stopped for real, and only a confirmed stop is named', async () => {
    const h = await crewOnMax3({ capped: true, ultra: false });
    for (let i = 1; i <= 5; i++) h.rt.limitInBackground(hit(i));
    await until(() => !!cards(h.rt.items)[0]?.limit?.provider && h.rt.meta.background === 0, 'the decision', 4000);
    // The Demo has no per-task stop: its agent process was let go, which ends what it ran.
    expect(h.rt.handle).toBeUndefined();
    expect(h.rt.get<ToolItem>('toolu_7')!.result!.agent).toMatchObject({ background: 'stopped', limit: { window: '5-hour limit' } });

    // A move where the agent could not confirm the stop: those are not named to the agent.
    const m = await crewOnMax3();
    let asked = 0;
    (m.rt.handle as unknown as { stopBackgroundWork: () => Promise<boolean> }).stopBackgroundWork = async () => (asked++, false);
    for (let i = 1; i <= 5; i++) m.rt.limitInBackground(hit(i));
    await until(() => m.rt.meta.accountId === m.ultra3.id && m.sent.length > 0, 'the move');
    expect(asked).toBe(1);
    expect(m.sent[0].text).toContain('call toolu_5');
    expect(m.sent[0].text).not.toContain('call toolu_6');
    expect(m.sent[0].text).not.toContain('call toolu_7');
  });

  it('#7 past a full window on credits the account may not spend: the message is held, never sent there', async () => {
    const h = await crewOnMax3({ capped: true, ultra: false });
    for (let i = 1; i <= 7; i++) h.rt.patch<ToolItem>(`toolu_${i}`, { result: { agent: { background: 'done' } } });
    // The Demo's account at its limit runs on credits (the provider says so); the setting says no.
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'one more thing' });
    await until(() => !!cards(h.rt.items)[0]?.limit?.provider, 'the refusal');
    expect(h.sent).toHaveLength(0);
    // As refused at the limit: the message stands, the notice after it, nothing went to the agent.
    expect(h.rt.items.filter((i) => i.type === 'user').pop()).toMatchObject({ text: 'one more thing' });
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(cards(h.rt.items)[0].limit).toMatchObject({ provider: 'demo', accountId: h.max3.id });
    // Allowed for this account: it goes out.
    await h.app.call('app.setSettings', { patch: { creditsAtLimit: { [`demo:${h.max3.id}`]: true } } });
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'and this' });
    await until(() => h.sent.length === 1, 'the send');
    expect(h.sent[0].account).toBe(h.max3.id);
  });

  it('#7 with another account with room it moves first and the message goes there', async () => {
    const h = await crewOnMax3();
    for (let i = 1; i <= 7; i++) h.rt.patch<ToolItem>(`toolu_${i}`, { result: { agent: { background: 'done' } } });
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'one more thing' });
    await until(() => h.sent.length === 1, 'the send');
    expect(h.sent[0].account).toBe(h.ultra3.id);
    expect(cards(h.rt.items)[0].limit).toMatchObject({ continuedWith: h.ultra3.id });
  });

  it('#10 a chat closed during the wait is not moved or started again', async () => {
    const h = await crewOnMax3({ ms: { settle: 150, max: 600 } });
    for (let i = 1; i <= 3; i++) h.rt.limitInBackground(hit(i));
    await h.app.call('session.close', { sessionId: h.rt.id });
    await tick(900);
    expect(h.rt.meta.accountId).toBe(h.max3.id);
    expect(h.sent).toHaveLength(0);
    expect(cards(h.rt.items)[0].limit!.continuedWith).toBeUndefined();
  });

  it('#11 a send while the return reads the limits waits for it and goes to exactly one account', async () => {
    const h = await moved();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    const read = h.internals.readLimits.bind(h.app);
    h.internals.readLimits = async (...a) => (await tick(300), read(...a));
    h.rt.update({ returnAt: Date.now() - 1 });
    const back = h.app.returnAfterLimit(h.rt);
    await tick(20);
    await h.app.call('session.send', { sessionId: h.rt.id, text: 'next step' });
    await back;
    await until(() => h.sent.length === 1, 'the message');
    expect(h.sent[0].account).toBe(h.max3.id);
  });

  it('#12 a reading that is not fresh or fails never returns, and arms one more try', async () => {
    const h = await moved();
    await setProfile(h.app, h.max3, 'Max3', 'light');
    h.internals.readLimits = async () => ({ limits: [], fresh: false, signIn: 0 });
    h.rt.update({ returnAt: Date.now() - 1 });
    await h.app.returnAfterLimit(h.rt);
    expect(h.rt.meta.accountId).toBe(h.ultra3.id);
    expect(h.rt.meta.movedFrom).toBe(h.max3.id);
    expect(h.internals.returnTimers.has(h.rt.id)).toBe(true);
    h.internals.readLimits = async () => {
      throw new Error('no answer');
    };
    await h.app.returnAfterLimit(h.rt, { retry: true });
    expect(h.rt.meta.accountId).toBe(h.ultra3.id);
    expect(h.internals.returnTimers.has(h.rt.id)).toBe(true);
  });

  it('#13 "use first" never drops the return: back to the account it left once that one has room', async () => {
    const h = await moved();
    // While Max3 is held the promise stays.
    h.rt.update({ returnAt: Date.now() - 1 });
    await h.app.returnAfterLimit(h.rt, { retry: true });
    expect(h.rt.meta.movedFrom).toBe(h.max3.id);
    // Max3 back but nearer its limit than Ultra3 (use first would rank it later): it goes back to Max3.
    await setProfile(h.app, h.max3, 'Max3', 'near');
    h.rt.update({ returnAt: Date.now() - 1 });
    await h.app.returnAfterLimit(h.rt, { retry: true });
    await until(() => (h.rt.meta.accountId ?? DEFAULT_ACCOUNT) === h.max3.id, 'the return');
    expect(h.rt.meta.movedFrom).toBeUndefined();
  });

  it("#14 a continuation with its trailing note reads back as Sable's own, not the person's", () => {
    const note = '\n\n<system-reminder>\nThis conversation moved to another account.\n</system-reminder>';
    const bg = '\n\nThe same limit stopped these background agents before they finished: "Audit" (Explore, call toolu_1). Start again those whose work is still needed, and do not redo what they already finished.';
    expect(parseSynthetic(`${RESUME_UNDER_ANOTHER}${bg}${note}`)?.role).toBe('hidden');
    expect(parseSynthetic(`${RESUME_UNDER_ANOTHER}${note}`)?.role).toBe('hidden');
  });
});

describe('the rules, pure', () => {
  it('decides after the refusals stop, within a bound, or at once when nothing runs', () => {
    expect(backgroundLimitDue({ first: 0, last: 0, now: 0, running: 3 })).toBe(3000);
    expect(backgroundLimitDue({ first: 0, last: 14_000, now: 14_000, running: 3 })).toBe(1000);
    expect(backgroundLimitDue({ first: 0, last: 1000, now: 2000, running: 0 })).toBe(0);
  });

  it('returns to the account it left once that one takes work, never for nothing', () => {
    expect(returnTarget({ from: 'max3', current: 'ultra3', fromTakesWork: false })).toBeUndefined();
    expect(returnTarget({ from: 'max3', current: 'ultra3', fromTakesWork: true })).toBe('max3');
    expect(returnTarget({ from: 'max3', current: 'max3', fromTakesWork: true })).toBeUndefined();
  });

  it('believes only a fresh reading that shows room for the model', () => {
    const now = Date.now();
    const five = { id: 'five_hour', label: '5-hour limit', percent: 9, resetsAt: now + 3600_000 };
    expect(readingShowsRoom({ fresh: true, limits: [five], model: 'm', now, full: false })).toBe(true);
    expect(readingShowsRoom({ fresh: false, limits: [five], model: 'm', now, full: false })).toBe(false);
    expect(readingShowsRoom({ fresh: true, limits: [], model: 'm', now, full: false })).toBe(false);
    expect(readingShowsRoom({ fresh: true, limits: [five], model: 'm', now, full: true })).toBe(false);
    expect(returnRetryMs(0)).toBe(60_000);
    expect(returnRetryMs(3)).toBe(480_000);
    expect(returnRetryMs(20)).toBe(30 * 60_000);
  });

  it('names at most twelve stopped agents, each bounded', () => {
    const items: TimelineItem[] = [];
    for (let i = 0; i < 15; i++) items.push({ ...agentStep(i), detail: { description: 'x'.repeat(200) }, result: { agent: { background: 'stopped', limit: { window: '5-hour limit' } } } });
    const names = limitStoppedAgents(items);
    expect(names).toHaveLength(13);
    expect(names[12]).toBe('3 more');
    expect(names[0].length).toBeLessThan(130);
    // The note is cut from what the person sees.
    expect(stripWrappers(`do it\n\nThe same limit stopped these background agents before they finished: ${names.join('; ')}. Start again those whose work is still needed, and do not redo what they already finished.`)).toBe('do it');
  });
});

// ── Claude Code: what it really sends ──

async function claudeChat() {
  const home = temp('sable-limit-bg-claude-');
  const cwd = path.join(home, 'proj');
  mkdirSync(cwd);
  let session!: Record<string, unknown> & { onMessage(m: unknown): void };
  const app = new App({
    home,
    quiet: true,
    userHome: path.join(home, 'user'),
    backgroundLimitMs: { settle: 40, max: 200 },
    providers: [
      (ctx) => {
        const p = new ClaudeProvider(ctx);
        const any = p as unknown as Record<string, unknown>;
        any.info = async () => ({ id: 'claude', name: 'Claude Code', installed: true, auth: { loggedIn: true } });
        any.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: {} });
        any.limits = async () => [];
        any.readLimits = async () => [];
        const open = p.open.bind(p);
        p.open = async (rt, o) => {
          const s = (await open(rt, o)) as unknown as Record<string, unknown>;
          s.ensure = function (this: Record<string, unknown>) {
            this.q ??= { interrupt: async () => {}, close: () => {}, setPermissionMode: async () => {} };
            this.input ??= { push: () => {}, end: () => {} };
            return this.q;
          };
          session = s as typeof session;
          return s as unknown as ProviderSession;
        };
        return p;
      },
    ],
  });
  cleanups.push(() => app.dispose());
  const snap = await app.call('session.create', { provider: 'claude', cwd, mode: 'default', model: 'm', options: { remoteControl: false } });
  const rt = app.runtime(snap.session.id);
  await until(() => !!session, 'the session');
  (session as unknown as { ensure(): void }).ensure();
  return { app, rt, session };
}

describe('Claude Code: a background sub-agent refused at a limit', () => {
  it('writes no red box per refusal: the step stops at the limit, the chat says it once', async () => {
    const h = await claudeChat();
    for (let i = 1; i <= 7; i++) h.rt.add<ToolItem>(agentStep(i));
    const refused = (i: number) =>
      h.session.onMessage({
        type: 'assistant',
        uuid: `u${i}`,
        session_id: 'x',
        parent_tool_use_id: `toolu_${i}`,
        error: 'rate_limit',
        message: { id: `m${i}`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 5:10pm" }] },
      });
    for (let i = 1; i <= 7; i++) refused(i);
    expect(redBoxes(h.rt.items)).toHaveLength(0);
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(cards(h.rt.items)[0].limit!.window).toBe('5-hour limit');
    expect(h.rt.items.filter((i) => i.type === 'text' && /hit your/.test(i.text))).toHaveLength(0);
    expect(h.rt.meta.background).toBe(0);
    expect(h.rt.get<ToolItem>('toolu_4')!.result!.agent).toMatchObject({ background: 'stopped', limit: { window: '5-hour limit' } });
    // Its task's end ("failed") keeps the reason.
    h.session.onMessage({ type: 'system', subtype: 'task_started', session_id: 'x', uuid: 'ts', task_id: 't4', tool_use_id: 'toolu_4' });
    h.session.onMessage({ type: 'system', subtype: 'task_notification', session_id: 'x', uuid: 'tn', task_id: 't4', status: 'failed', summary: "You've hit your 5-hour limit" });
    expect(agentLine(h.rt.get<ToolItem>('toolu_4')!, 0)).toMatchObject({ state: 'Stopped', why: expect.stringMatching(/^5-hour limit reached/) });
    // The bridge has said which account (the card never reads "on This account").
    await until(() => !!cards(h.rt.items)[0].limit!.provider, 'the decision');
    expect(cards(h.rt.items)[0].limit!.accountId).toBe(DEFAULT_ACCOUNT);
    expect(cards(h.rt.items)).toHaveLength(1);
  });

  it('a turn cut mid-work by the limit ends in the limit card, not "The turn ended with an error"', async () => {
    for (const subAgents of [true, false]) {
      const h = await claudeChat();
      h.rt.beginTurn('Thinking');
      h.rt.add({ type: 'text', text: 'Reading the parser first.', streaming: false });
      if (subAgents) {
        h.rt.add<ToolItem>(agentStep(1));
        h.session.onMessage({ type: 'assistant', uuid: 'a1', session_id: 'x', parent_tool_use_id: 'toolu_1', error: 'rate_limit', message: { id: 'm1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 6pm (Europe/Berlin)" }] } });
      }
      h.session.onMessage({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'x', uuid: 'r', errors: ["You've hit your 5-hour limit · resets 6pm (Europe/Berlin)"], usage: {} });
      expect(h.rt.turnActive).toBe(false);
      expect(redBoxes(h.rt.items)).toHaveLength(0);
      const [card] = cards(h.rt.items);
      expect(cards(h.rt.items)).toHaveLength(1);
      expect(card.limit!.window).toBe('5-hour limit');
      // The reset read from the words: the next 6 pm.
      const at = new Date(card.limit!.resetsAt!);
      expect(at.getHours()).toBe(18);
      expect(card.limit!.resetsAt!).toBeGreaterThan(Date.now());
      // The turn's line carries no error, so no "Try again".
      expect(h.rt.items.filter((i) => i.type === 'turn' && i.error)).toHaveLength(0);
      // The bridge decided at the turn's end (one account here: the card stays).
      await until(() => !!cards(h.rt.items)[0].limit!.provider, 'the decision');
    }
  });

  it('a turn the notifications wake that is refused says it in the same card', async () => {
    const h = await claudeChat();
    h.rt.add<ToolItem>(agentStep(1));
    h.rt.add<ToolItem>(agentStep(2));
    h.session.onMessage({ type: 'assistant', uuid: 'a', session_id: 'x', parent_tool_use_id: 'toolu_1', error: 'rate_limit', message: { id: 'm1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } });
    expect(cards(h.rt.items)).toHaveLength(1);
    h.rt.beginTurn('Thinking', { keepHold: true });
    h.session.onMessage({ type: 'assistant', uuid: 'b', session_id: 'x', parent_tool_use_id: null, error: 'rate_limit', message: { id: 'm2', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } });
    expect(cards(h.rt.items)).toHaveLength(1);
    expect(redBoxes(h.rt.items)).toHaveLength(0);
  });
});

describe('working means working', () => {
  const meta = (patch: Partial<SessionMeta>): SessionMeta => ({ id: 's', provider: 'claude', cwd: '/w', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...patch });
  it('a chat whose sub-agents work shows working, also after its own turn failed', () => {
    expect(statusTone(meta({ background: 7 }))).toBe('working');
    expect(statusLabel(meta({ background: 7 }))).toBe('7 sub-agents working');
    expect(statusTone(meta({ status: 'error', lastError: 'x', background: 2 }))).toBe('working');
    expect(statusLabel(meta({ status: 'error', lastError: 'x', background: 2 }))).toBe('2 sub-agents working');
    // Waiting on the person still comes first.
    expect(statusTone(meta({ status: 'awaiting', background: 2 }))).toBe('awaiting');
    expect(statusTone(meta({ status: 'error' }))).toBe('error');
  });
});
