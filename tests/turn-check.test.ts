/** "Check with Codex": the other agent reviews a finished turn's changes, read-only, under the turn. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeEvent, FileDiff, TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import { makeFileDiff } from '@shared/diff';
import { App } from '../server/app';
import { handoverText } from '../server/accounts/handover';
import { BRIEF_CAPS, briefFiles, buildBrief, CHECK_LEAD, checkerOf, editsOf, NO_PROBLEMS, readOnlyMode, TurnChecks, turnSlice, withoutChecks, type CheckDeps } from '../server/core/check';
import { SessionRuntime } from '../server/core/runtime';
import { READ_ONLY_DENIAL, runSubAgent } from '../server/core/sub-agent';
import { DemoProvider } from '../server/providers/demo';
import { pickScenario } from '../server/providers/demo-scenarios';
import { checkFailure, checkedAlready, hasFindings, withLineRefs } from '@/features/timeline/check-turn';
import { groupTurns, shapeOf, type TurnGroup } from '@/features/timeline/turns';

// ─────────────────────────────────── fixtures ───────────────────────────────────

let n = 0;
const at = () => 1_000 + n++;
const user = (id: string, text: string, extra: Partial<UserItem> = {}): UserItem => ({ id, ts: at(), type: 'user', text, state: 'sent', ...extra });
const text = (id: string, t: string, parentId?: string): TimelineItem => ({ id, ts: at(), type: 'text', text: t, streaming: false, ...(parentId ? { parentId } : {}) });
const turnEnd = (id: string): TimelineItem => ({ id, ts: at(), type: 'turn', durationMs: 1000 });
function edit(id: string, file: string, before: string | null, after: string, extra: Partial<ToolItem> = {}): ToolItem {
  const diff: FileDiff = makeFileDiff(file, before, after);
  return { id, ts: at(), type: 'tool', name: before === null ? 'Write' : 'Edit', kind: before === null ? 'write' : 'edit', title: `Edit ${file}`, status: 'done', detail: { path: file }, result: { diff: [diff] }, ...extra };
}

const CWD = 'C:/work/relay-api';

/** One finished turn with a steered message, a sub-agent's edit and the turn's own edits; then the next turn. */
function conversation(): TimelineItem[] {
  return [
    user('u1', 'Move session expiry into the store'),
    text('t1', 'Reading the store first.'),
    edit('e1', `${CWD}/src/server/session.ts`, 'const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\nconst c = 4;\n'),
    user('s1', 'Keep the public error codes', { steered: true }),
    { id: 'ag', ts: at(), type: 'tool', name: 'Task', kind: 'agent', title: 'Write tests', status: 'done', detail: {} },
    edit('e2', 'tests/session.test.ts', null, "it('expires', () => {});\n", { parentId: 'ag' }),
    edit('e3', `${CWD}/src/auth/middleware.ts`, 'deny(res, reason);\n', 'deny(res, CODES[reason]);\n', { status: 'error' }),
    text('t2', 'Expiry now lives in `SessionStore.validate()`.'),
    turnEnd('end1'),
    user('u2', 'Now add a changelog entry'),
    edit('e4', 'CHANGELOG.md', null, '- expiry\n'),
    turnEnd('end2'),
  ];
}

// ─────────────────────────────────── the brief ───────────────────────────────────

describe('turn check brief', () => {
  it('takes the turn up to its end, with steered messages and no checks or queued messages', () => {
    const items = conversation();
    items.splice(9, 0, { id: 'chk', ts: at(), type: 'tool', name: 'sable_check', kind: 'agent', title: 'x', status: 'done', detail: {}, check: { turn: 'u0', agent: 'codex' } });
    const slice = turnSlice(items, 'u1')!;
    expect(slice.asks.map((u) => u.id)).toEqual(['u1', 's1']);
    expect(slice.roots.map((i) => i.id)).toEqual(['t1', 'e1', 'ag', 'e3', 't2', 'end1']);
    expect(slice.ended).toBe(true);
    // Edits that went through, the sub-agent's included, in order; a failed one is not a change.
    expect(editsOf(items, slice.roots).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(turnSlice(items, 't1')).toBeNull();
    expect(turnSlice(items, 'nope')).toBeNull();
  });

  it('holds the request, the final answer and the changes, paths relative to the folder', () => {
    const brief = buildBrief(conversation(), 'u1', CWD)!;
    expect(brief.text.startsWith(CHECK_LEAD)).toBe(true);
    expect(brief.text).toContain('Move session expiry into the store');
    expect(brief.text).toContain('(Added while it worked) Keep the public error codes');
    expect(brief.text).toContain('<answer>\nExpiry now lives in `SessionStore.validate()`.\n</answer>');
    expect(brief.text).not.toContain('Reading the store first.');
    // Only correctness, regressions and missed requirements; findings as `path:line`, severity, one sentence.
    expect(brief.text).toMatch(/correctness bugs, regressions and parts of the request the changes miss/);
    expect(brief.text).toContain('`path/to/file.ts:42` High:');
    expect(brief.text).toContain(NO_PROBLEMS);
    expect(brief.files.map((f) => f.path)).toEqual(['src/server/session.ts', 'tests/session.test.ts']);
    expect(briefFiles(brief.text)).toEqual(['src/server/session.ts', 'tests/session.test.ts']);
    expect(brief.text).toContain('- src/server/session.ts (+2 -1)');
    expect(brief.text).toContain('- tests/session.test.ts (new, +1)');
    expect(brief.text).toContain('--- a/src/server/session.ts\n+++ b/src/server/session.ts\n@@ -1,2 +1,3 @@');
    expect(brief.text).toContain('--- /dev/null\n+++ b/tests/session.test.ts');
    // The next turn's changes are not this turn's.
    expect(brief.text).not.toContain('CHANGELOG');
    expect(brief.cut).toBe(false);
  });

  it('caps the diff and says when it was cut', () => {
    const items: TimelineItem[] = [user('u', 'Rewrite everything')];
    for (let i = 0; i < 6; i++) items.push(edit(`e${i}`, `src/f${i}.ts`, null, Array.from({ length: 400 }, (_, j) => `export const v${j} = ${j};`).join('\n') + '\n'));
    items.push(text('a', 'Done.'), turnEnd('end'));
    const reads: string[] = [];
    const brief = buildBrief(items, 'u', CWD, { ...BRIEF_CAPS, diff: 20_000 }, item => {
      reads.push(item.id);
      return item;
    })!;
    expect(reads).toEqual(['e0', 'e1']);
    expect(brief.cut).toBe(true);
    expect(brief.files).toHaveLength(6);
    expect(brief.text).toMatch(/The changes are cut here \(\d+ more edits left out\)\. Read the changed files for the rest\./);
    const changes = brief.text.slice(brief.text.indexOf('<changes>'), brief.text.indexOf('</changes>'));
    expect(changes.length).toBeLessThan(20_100);
    // Every changed file is still named, cut or not.
    expect(briefFiles(brief.text)).toHaveLength(6);
  });

  it('names the checker and its read-only mode', () => {
    expect(checkerOf('claude')).toBe('codex');
    expect(checkerOf('codex')).toBe('claude');
    expect(checkerOf('demo')).toBe('demo');
    expect(readOnlyMode('codex')).toBe('read-only');
    expect(readOnlyMode('claude')).toBe('plan');
    // The Demo agent knows a brief, in plan mode too.
    expect(pickScenario(`${CHECK_LEAD}\nrefactor`, 'plan', 0).id).toBe('turnCheck');
  });
});

// ─────────────────────────────────── the window ───────────────────────────────────

describe('turn check in the conversation', () => {
  const layout = (s: string, busy: boolean, of: Record<string, string>) => {
    const parts = s.split(/\s+/).filter(Boolean);
    return groupTurns(
      parts.map((p) => p.slice(1)),
      parts.map((p) => p[0]).join(''),
      busy,
      (id) => of[id],
    );
  };

  it('goes under the turn it checks, never into a turn, even while another one runs', () => {
    const { groups } = layout('U1 w2 t3 T4 U5 w6 xC t7', true, { C: '1' });
    expect(groups).toHaveLength(2);
    const [first, second] = groups as TurnGroup[];
    expect(first.checks).toEqual(['C']);
    expect(second.ids).not.toContain('C');
    expect(second.state).toBe('running');
    expect(second.segments[0].work).toEqual(['6']);
  });

  it('stands on its own where it is when its turn is gone', () => {
    const { groups } = layout('U1 t2 T3 xC U5 t6 T7', false, { C: 'gone' });
    expect(groups.map((g) => (g.kind === 'item' ? g.id : g.key))).toEqual(['1', 'C', '5']);
  });

  it('reads a check as its own shape', () => {
    expect(shapeOf({ id: 'c', ts: 1, type: 'tool', name: 'sable_check', kind: 'agent', title: '', status: 'running', detail: {}, check: { turn: 'u', agent: 'codex' } })).toBe('x');
  });

  it('knows findings, failures and path:line links', () => {
    expect(hasFindings('No problems found.')).toBe(false);
    expect(hasFindings('- `a.ts:3` High: breaks.')).toBe(true);
    const fail = { id: 'c', ts: 1, type: 'tool', name: 'sable_check', kind: 'agent', title: '', status: 'error', detail: {}, result: { text: 'The sub-agent could not run: Provider not available: codex' } } as ToolItem;
    expect(checkFailure(fail)).toBe('Provider not available: codex');
    const links = withLineRefs({ cwd: CWD, files: { 'src/server/session.ts': `${CWD}/src/server/session.ts` } }, '- `src/server/session.ts:63` Medium: x. Also src/server/session.ts:48:5 and other.ts:2');
    expect(links?.files['src/server/session.ts:63']).toBe(`${CWD}/src/server/session.ts`);
    expect(links?.files['src/server/session.ts:48:5']).toBe(`${CWD}/src/server/session.ts`);
    expect(links?.files['other.ts:2']).toBeUndefined();
    const items = { a: { id: 'a', ts: 1, type: 'tool', name: 'sable_check', kind: 'agent', title: '', status: 'cancelled', detail: {} } as ToolItem };
    expect(checkedAlready(items, ['a'])).toBe(false);
    expect(checkedAlready({ a: { ...items.a, status: 'done' } }, ['a'])).toBe(true);
  });
});

// ─────────────────────────────────── the bridge ───────────────────────────────────

const homes: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

async function until(pred: () => boolean, what: string, ms = 6000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An app with the Demo agent only; `opened` records every session the provider opens (the checker's too). */
function setup(speed = 0) {
  const home = mkdtempSync(path.join(tmpdir(), 'sable-check-'));
  homes.push(home);
  const opened: { id: string; mode: string }[] = [];
  const app = new App({
    home,
    quiet: true,
    providers: [
      (ctx) => {
        const p = new DemoProvider(ctx, { speed });
        const open = p.open.bind(p);
        p.open = (rt, o) => {
          opened.push({ id: rt.meta.id, mode: rt.meta.mode });
          return open(rt, o);
        };
        return p;
      },
    ],
  });
  apps.push(app);
  const events: BridgeEvent[] = [];
  app.subscribe((e) => events.push(e));
  return { app, home, events, opened };
}

/** A Demo chat whose first turn refactored the session module (edits to session.ts and middleware.ts). */
async function refactored(speed = 0) {
  const h = setup(speed);
  const snap = await h.app.call('session.create', { provider: 'demo', cwd: path.join(h.home, 'relay-api'), mode: 'bypassPermissions' });
  const rt = h.app.runtime(snap.session.id);
  await h.app.call('session.send', { sessionId: rt.id, text: 'refactor the session module' });
  await until(() => rt.items.some((i) => i.type === 'turn') && !rt.turnActive, 'the turn', 20_000);
  const turnId = rt.items.find((i): i is UserItem => i.type === 'user')!.id;
  return { ...h, rt, turnId };
}

describe('turn check run', () => {
  it('runs the Demo checker under one step after the turn, outside the main agent, and ends with its findings', async () => {
    const { app, rt, turnId, opened, events } = await refactored();
    const before = rt.items.length;
    const users = rt.items.filter((i) => i.type === 'user').length;

    const r = await app.call('turn.check', { sessionId: rt.id, turnId });
    expect(r.ok).toBe(true);
    const root = rt.get<ToolItem>(r.itemId!)!;
    expect(root).toMatchObject({ type: 'tool', kind: 'agent', status: 'running', check: { turn: turnId, agent: 'demo' }, detail: { subagent: 'Demo' } });
    expect(root.parentId).toBeUndefined();
    // Placed after the turn: its end is before it.
    const endAt = rt.items.findIndex((i) => i.type === 'turn');
    expect(rt.items.indexOf(root)).toBe(before);
    expect(rt.items.indexOf(root)).toBeGreaterThan(endAt);
    // A second click on the same turn while it runs gives the same check.
    expect((await app.call('turn.check', { sessionId: rt.id, turnId })).itemId).toBe(root.id);

    await until(() => rt.get<ToolItem>(root.id)?.status !== 'running', 'the check', 20_000);
    const done = rt.get<ToolItem>(root.id)!;
    expect(done.status).toBe('done');
    expect(done.result?.text).toMatch(/^- `src\/server\/session\.ts:\d+` Medium: /);
    expect(done.result?.text).toMatch(/\n- `src\/server\/session\.ts:\d+` Low: /);

    // The checker ran as a child session of its own, read-only (the Demo's plan mode).
    const child = opened.find((o) => o.id.startsWith('sub-'));
    expect(child?.mode).toBe('plan');
    // Its steps nest under the check; nothing reached the chat as a message of its own.
    const nested = rt.items.filter((i) => i.parentId === root.id);
    expect(nested.some((i) => i.type === 'tool' && i.kind === 'read')).toBe(true);
    expect(nested.some((i) => i.type === 'text')).toBe(true);
    expect(rt.items.filter((i) => i.type === 'user')).toHaveLength(users);
    expect(rt.items.some((i) => i.type === 'user' && i.text.startsWith(CHECK_LEAD))).toBe(false);
    // The chat itself never ran: no new turn, no permission asked.
    expect(rt.items.filter((i) => i.type === 'turn' && !i.parentId)).toHaveLength(1);
    expect(events.some((e) => e.type === 'permission.added')).toBe(false);
    expect(rt.meta.status).toBe('idle');
    // A summary for an agent (account move, fork) leaves the check out.
    expect(handoverText(withoutChecks(rt.items))).not.toMatch(/checked this turn/);
    expect(handoverText(rt.items)).toMatch(/checked this turn/);
  });

  it('refuses a turn without changes and an unknown turn', async () => {
    const { app } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(tmpdir(), 'sable-check-none'), mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    await app.call('session.send', { sessionId: rt.id, text: 'hi' });
    await until(() => rt.items.some((i) => i.type === 'turn') && !rt.turnActive, 'the turn', 10_000);
    const turnId = rt.items.find((i) => i.type === 'user')!.id;
    expect(await app.call('turn.check', { sessionId: rt.id, turnId })).toEqual({ ok: false, error: 'This turn changed no files.' });
    expect((await app.call('turn.check', { sessionId: rt.id, turnId: 'nope' })).ok).toBe(false);
  });

  it('stops when asked, and the step says so', async () => {
    const { app, rt, turnId } = await refactored();
    const r = await app.call('turn.check', { sessionId: rt.id, turnId });
    expect((await app.call('turn.checkStop', { sessionId: rt.id, itemId: r.itemId! })).ok).toBe(true);
    await until(() => rt.get<ToolItem>(r.itemId!)?.status !== 'running', 'the stop', 10_000);
    expect(rt.get<ToolItem>(r.itemId!)?.status).toBe('cancelled');
    // Stopped, the turn can be checked again.
    expect((await app.call('turn.check', { sessionId: rt.id, turnId })).itemId).not.toBe(r.itemId);
  });

  it('settling the chat (a stopped turn) leaves a running check alone', () => {
    const rt = new SessionRuntime({ id: 's', provider: 'demo', cwd: CWD, title: '', titleSource: 'auto', model: '', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } }, () => {}, () => {});
    const root = rt.add<ToolItem>({ type: 'tool', name: 'sable_check', kind: 'agent', title: '', status: 'running', detail: {}, check: { turn: 'u', agent: 'demo' } });
    const step = rt.add<ToolItem>({ type: 'tool', name: 'Read', kind: 'read', title: '', status: 'running', detail: {}, parentId: root.id });
    const other = rt.add<ToolItem>({ type: 'tool', name: 'Bash', kind: 'bash', title: '', status: 'running', detail: {} });
    rt.apart.add(root.id);
    rt.settle('cancelled');
    expect(rt.get<ToolItem>(root.id)?.status).toBe('running');
    expect(rt.get<ToolItem>(step.id)?.status).toBe('running');
    expect(rt.get<ToolItem>(other.id)?.status).toBe('cancelled');
  });
});

const meta = (provider: 'demo' | 'claude' | 'codex' = 'claude') => ({ id: 's', provider, cwd: CWD, title: '', titleSource: 'auto' as const, model: '', mode: 'default', status: 'idle' as const, createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } });

describe('turn check outcomes', () => {
  function withRun(run: CheckDeps['run'], available = true) {
    const rt = new SessionRuntime(meta(), () => {}, () => {});
    rt.load(conversation());
    const checks = new TurnChecks({ available: () => available, busy: () => false, log: () => {}, run });
    return { rt, checks };
  }

  it('says when the checker is not signed in', () => {
    const { rt, checks } = withRun(async () => ({ ok: true, text: '' }), false);
    expect(checks.start(rt, 'u1')).toEqual({ ok: false, error: 'Codex is not signed in.' });
    expect(rt.items.some((i) => i.type === 'tool' && i.check)).toBe(false);
  });

  it('turns a plan limit into one line on the step, without the limit notice and its actions', async () => {
    const { rt, checks } = withRun(async (parent, _call, itemId) => {
      parent.add({ type: 'notice', variant: 'error', text: 'You have reached your usage limit.', limit: { window: '5-hour limit', resetsAt: 123 }, parentId: itemId });
      return { ok: false, text: 'The sub-agent stopped: You have reached your usage limit.' };
    });
    const r = checks.start(rt, 'u1');
    await until(() => rt.get<ToolItem>(r.itemId!)?.status !== 'running', 'the check');
    const step = rt.get<ToolItem>(r.itemId!)!;
    expect(step.status).toBe('error');
    expect(step.result?.agent?.limit).toEqual({ window: '5-hour limit', resetsAt: 123 });
    expect(rt.items.some((i) => i.parentId === step.id && i.type === 'notice')).toBe(false);
  });

  it('fails calmly when the checker cannot run or writes nothing', async () => {
    const a = withRun(async () => ({ ok: false, text: 'The sub-agent could not run: Provider not available: codex' }));
    const r = a.checks.start(a.rt, 'u1');
    await until(() => a.rt.get<ToolItem>(r.itemId!)?.status !== 'running', 'the check');
    expect(a.rt.get<ToolItem>(r.itemId!)).toMatchObject({ status: 'error', result: { text: 'The sub-agent could not run: Provider not available: codex' } });
    expect(checkFailure(a.rt.get<ToolItem>(r.itemId!)!)).toBe('Provider not available: codex');

    const b = withRun(async () => ({ ok: true, text: 'The sub-agent finished without a written answer.' }));
    const q = b.checks.start(b.rt, 'u1');
    await until(() => b.rt.get<ToolItem>(q.itemId!)?.status !== 'running', 'the check');
    expect(b.rt.get<ToolItem>(q.itemId!)).toMatchObject({ status: 'error', result: { text: 'It finished without writing any findings.' } });
  });

  it('answers "No problems found." for a turn the Demo checker passes', async () => {
    const { app, home } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'bypassPermissions' });
    const rt = app.runtime(snap.session.id);
    const u = rt.add<UserItem>({ type: 'user', text: 'Add a login rate limiter', state: 'sent' });
    const { id: _id, ts: _ts, ...write } = edit('w', 'src/auth/rate-limit.ts', null, 'export const LIMIT = 5;\n');
    rt.add<ToolItem>(write);
    rt.add({ type: 'text', text: 'Added the limiter.', streaming: false });
    rt.add({ type: 'turn', durationMs: 10 });
    const r = await app.call('turn.check', { sessionId: rt.id, turnId: u.id });
    await until(() => rt.get<ToolItem>(r.itemId!)?.status !== 'running', 'the check', 20_000);
    expect(rt.get<ToolItem>(r.itemId!)).toMatchObject({ status: 'done', result: { text: NO_PROBLEMS } });
    expect(hasFindings(NO_PROBLEMS)).toBe(false);
  });
});

describe('read-only child', () => {
  it('denies every permission at once and never asks the user', async () => {
    const { app, home, events } = setup();
    const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'p') });
    const parent = app.runtime(snap.session.id);
    const step = parent.add<ToolItem>({ type: 'tool', name: 'sable_check', kind: 'agent', title: 'Check', status: 'running', detail: {} });
    // Ask mode: the refactor's first edit needs a permission, which a read-only child is refused.
    const r = await runSubAgent(
      { provider: (id, acc) => app.provider(id, acc), accountFor: () => undefined, defaultModel: () => undefined, modeFor: () => 'default', log: () => {} },
      parent,
      { agent: 'demo', description: 'Check', prompt: 'refactor the session module' },
      step.id,
      undefined,
      { readOnly: true },
    );
    expect(events.some((e) => e.type === 'permission.added')).toBe(false);
    const edits = parent.items.filter((i): i is ToolItem => i.type === 'tool' && i.kind === 'edit' && i.parentId === step.id);
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.status === 'denied')).toBe(true);
    expect(r.text).toMatch(/skipped|won't go ahead/);
    expect(READ_ONLY_DENIAL).toMatch(/read-only/);
  });
});
