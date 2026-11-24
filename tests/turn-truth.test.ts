/**
 * What a conversation says must be true (integ1, 22 Nov): a turn that ended by itself with Claude
 * Code's stand-in "No response requested.", a Write step that showed 41m 48s of idle time, and texts
 * Sable gives an agent that showed in the person's bubble once a transcript was read back. Fake SDK
 * messages and stored transcripts only: no real agent turns.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { DEFAULT_SETTINGS, type NoticeItem, type SessionMeta, type TimelineItem, type ToolItem, type UserItem } from '@shared/protocol';
import {
  HANDOVER_JOIN,
  isNobodysWords,
  isStandIn,
  parseSynthetic,
  partOfTurn,
  RESUME_AFTER_RESET,
  RESUME_LIMIT_RESET,
  RESUME_SUMMARY_TRAILER,
  RESUME_UNDER_ANOTHER,
  STAND_IN_ANSWER,
  stripWrappers,
  userText,
} from '@shared/synthetic';
import { groupTurns, lastResponse, runSpan, shapeOf, turnSpan, type TurnGroup } from '@/features/timeline/turns';
import { handoverText } from '../server/accounts/handover';
import { moveNote } from '../server/core/move-context';
import { failureMessage } from '../server/core/until';
import { transcript } from '../server/providers/codex-map';
import type { Turn } from '../server/providers/codex-types';
import { SessionRuntime } from '../server/core/runtime';
import { ClaudeProvider } from '../server/providers/claude';
import type { ProviderSession } from '../server/providers/types';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('@desk/features/review/model', async () => await import('../src/features/review/model'));
vi.mock('@desk/lib/word-diff', async () => await import('../src/lib/word-diff'));
const MOBILE = '../mobile/src/lib/turns';
const mobile = (await import(/* @vite-ignore */ MOBILE)) as {
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => { groups: (TurnGroup | { kind: 'item'; id: string })[] };
  shapeOf: (item: TimelineItem) => string;
  turnSpan: typeof turnSpan;
  runSpan: typeof runSpan;
};

let n = 0;
const mk = (p: Record<string, unknown>): TimelineItem => ({ id: `i${++n}`, ts: 1000 + n, ...p }) as unknown as TimelineItem;
const user = (text: string) => mk({ type: 'user', text, state: 'sent' });
const text = (t: string) => mk({ type: 'text', text: t, streaming: false });
const step = (status = 'done') => mk({ type: 'tool', name: 'Read', kind: 'read', title: 'Read a.ts', status, detail: {}, endedAt: 2000 + n });
const end = (error?: string) => mk({ type: 'turn', durationMs: 10, ...(error ? { error } : {}) });
const notice = (variant: string) => mk({ type: 'notice', variant, text: variant });

function layout(items: TimelineItem[], busy = false, phone = false) {
  const ids = items.map((i) => i.id);
  const shape = items.map((i) => (phone ? mobile.shapeOf(i) : shapeOf(i))).join('');
  const groups = (phone ? mobile.groupTurns(ids, shape, busy) : groupTurns(ids, shape, busy)).groups;
  return groups.filter((g): g is TurnGroup => g.kind === 'turn');
}

describe('the stand-in answer', () => {
  it('is known exactly', () => {
    expect(isStandIn(STAND_IN_ANSWER)).toBe(true);
    expect(isStandIn('  No response requested.\n')).toBe(true);
    expect(isStandIn('No response requested. Then I wrote the file.')).toBe(false);
    // Claude Code's own sign-in failure line, as chats saved before 0.2.20 hold it: nobody's words either.
    expect(isNobodysWords('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
    expect(isNobodysWords('Failed to refresh OAuth token: another Claude Code process is refreshing it. Try again.')).toBe(true);
    expect(isNobodysWords('Failed to authenticate. API Error: 401 {"type":"error"}')).toBe(true);
    expect(isNobodysWords(STAND_IN_ANSWER)).toBe(true);
    // An answer that begins like it, or says more, stays the agent's.
    expect(isNobodysWords('Not logged in: the test user has no session, so the route redirects.')).toBe(false);
    expect(isNobodysWords('Failed to authenticate: OAuth session expired and could not be refreshed\n\nThat line comes from the CLI; here is why.')).toBe(false);
    expect(isNobodysWords('Failed to authenticate against staging, so I mocked the client.')).toBe(false);
    // The whole line is the CLI's, or it is the agent's: a second sentence, or other words after the known ones.
    expect(isNobodysWords('Failed to refresh OAuth token: the staging client used the wrong credentials. I fixed its configuration.')).toBe(false);
    expect(isNobodysWords('Failed to authenticate: OAuth session expired and could not be refreshed is what the CLI prints here.')).toBe(false);
    expect(isNobodysWords('Failed to authenticate. API Error: 401 on the staging route, so the token is stale.')).toBe(false);
    // The CLI's own variants still count.
    expect(isNobodysWords('Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.')).toBe(true);
    expect(isNobodysWords('Failed to refresh OAuth token: Request failed with status code 400')).toBe(true);
    expect(isNobodysWords('Failed to refresh OAuth token: getaddrinfo ENOTFOUND console.anthropic.com')).toBe(true);
    expect(isNobodysWords('Failed to authenticate: OAuth session expired and could not be refreshed · Please run /login')).toBe(true);
    expect(isNobodysWords('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login')).toBe(true);
  });

  for (const phone of [false, true]) {
    it(`is never a turn's answer (${phone ? 'phone' : 'desktop'})`, () => {
      const items = [user('check the queue'), step(), text(STAND_IN_ANSWER)];
      const [turn] = layout(items, false, phone);
      expect(turn.segments[0].answer).toBeNull();
      expect(turn.segments[0].flow.some((c) => c.kind === 'text')).toBe(false);
      if (!phone) {
        const all = Object.fromEntries(items.map((i) => [i.id, i]));
        expect(lastResponse(all, items.map((i) => i.id), false)).toBeNull();
      }
    });
  }
});

describe('how a turn ended: only the bridge says it was cut', () => {
  const early = (why: 'died' | 'closed' | 'restart', variant = 'info') => mk({ type: 'notice', variant, text: 'The turn was cut', early: why });
  const items = (list: TimelineItem[]) => Object.fromEntries(list.map((i) => [i.id, i])) as Record<string, TimelineItem>;

  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    const groups = (list: TimelineItem[], busy = false) => {
      const ids = list.map((i) => i.id);
      const shape = list.map((i) => (phone ? mobile.shapeOf(i) : shapeOf(i))).join('');
      return (phone ? mobile.groupTurns(ids, shape, busy) : groupTurns(ids, shape, busy)).groups;
    };
    const span = phone ? mobile.turnSpan : turnSpan;
    const run = phone ? mobile.runSpan : runSpan;

    it(`a turn with no record of its end says nothing about it (${tag})`, () => {
      // The reported case, as a transcript read back shows it: a read-only check, the stand-in, then the next message.
      const turns = layout([user('look at the jobs'), text('Let me check the queue.'), step(), text(STAND_IN_ANSWER), user('what happened?'), text('Nothing ran.')], false, phone);
      expect(turns[0].early).toBeUndefined();
      expect(turns[0].state).toBe('done');
      // Work the agent began by itself, settled with no record (the chat at rest): nothing either.
      expect(layout([user('a'), step(), end(), step(), step()], false, phone)[1].early).toBeUndefined();
      expect(layout([user('a'), step()], false, phone)[0].early).toBeUndefined();
      expect(layout([user('a'), mk({ type: 'thinking', text: 'Hm', streaming: false })], false, phone)[0].early).toBeUndefined();
    });

    it(`a wake turn with its record is a turn of its own, finished (${tag})`, () => {
      const list = [user('run the tests in the background'), step(), text('Started.'), end(), step(), text('The tests passed.'), end()];
      const turns = layout(list, false, phone);
      expect(turns).toHaveLength(2);
      expect(turns[1].segments[0].lead).toBeNull();
      expect(turns[1].end).toBe(list[6].id);
      expect(turns[1].state).toBe('done');
      expect(turns[1].early).toBeUndefined();
      // While it runs, it is the running turn.
      expect(layout(list.slice(0, 5), true, phone)[1].state).toBe('running');
    });

    it(`an early notice closes the turn above it and is that turn's line (${tag})`, () => {
      for (const variant of ['info', 'error', 'interrupted']) {
        const cut = early('died', variant);
        const list = [user('fix it'), step(), cut, user('go on'), text('Done.')];
        const gs = groups(list);
        const turn = gs[0] as TurnGroup;
        expect(turn.kind).toBe('turn');
        expect(turn.early).toBe(cut.id);
        expect(turn.state).toBe('done');
        expect(turn.ids).toContain(cut.id);
        // It is the turn's own line, not a piece of it.
        expect(turn.segments.some((sg) => sg.flow.some((c) => (c.kind === 'steps' ? c.ids.includes(cut.id) : c.id === cut.id)))).toBe(false);
        expect((gs[1] as TurnGroup).early).toBeUndefined();
      }
      // With nothing open (nothing of the turn in this timeline), it stands on its own.
      const lone = early('restart');
      expect(groups([lone])).toEqual([{ kind: 'item', key: lone.id, id: lone.id }]);
    });

    it(`a notice after the last act of a turn with no record stands on its own (${tag})`, () => {
      const t0 = 1_000_000;
      const u = mk({ type: 'user', text: 'a', state: 'sent', ts: t0 });
      const w = mk({ type: 'tool', name: 'Read', kind: 'read', title: 'Read a.ts', status: 'done', detail: {}, ts: t0 + 1000, endedAt: t0 + 4000 });
      const say = mk({ type: 'text', text: 'Read it: the queue is empty.', streaming: false, ts: t0 + 5000 });
      // An account move six hours later.
      const moved = mk({ type: 'notice', variant: 'info', text: 'Continued with Work', ts: t0 + 6 * 3_600_000 });
      const next = mk({ type: 'user', text: 'b', state: 'sent', ts: t0 + 6 * 3_600_000 + 60_000 });
      const gs = groups([u, w, say, moved, next]);
      const turn = gs[0] as TurnGroup;
      expect(turn.ids).not.toContain(moved.id);
      expect(gs[1]).toEqual({ kind: 'item', key: moved.id, id: moved.id });
      expect(turn.next).toBe(moved.id);
      expect(span(items([u, w, say, moved, next]), turn)).toBe(5000);
      // At the end of a chat at rest too.
      const end2 = groups([u, w, say, moved]);
      expect(end2[1]).toEqual({ kind: 'item', key: moved.id, id: moved.id });
      // In a running turn it is part of the work (more may come after it).
      expect((groups([u, w, moved], true)[0] as TurnGroup).ids).toContain(moved.id);
      // A notice that is all a turn holds (a /compact) is that turn.
      expect((groups([u, moved])[0] as TurnGroup).ids).toContain(moved.id);
    });

    it(`the time of a turn with no record: its work, not a settle six hours late (${tag})`, () => {
      const t0 = 2_000_000;
      const u = mk({ type: 'user', text: 'ship it', state: 'sent', ts: t0 });
      const a = mk({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Run tests', status: 'done', detail: {}, ts: t0 + 60_000, endedAt: t0 + 120_000 });
      // Still running when its process went away; the next turn's settle stamped it 6h 11m later.
      const b = mk({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Wait for CI', status: 'cancelled', detail: {}, ts: t0 + 487_000, endedAt: t0 + 22_260_000 });
      const later = mk({ type: 'user', text: 'and now?', state: 'sent', ts: t0 + 22_200_000 });
      const list = [u, a, b, later];
      const turn = groups(list)[0] as TurnGroup;
      expect(span(items(list), turn)).toBe(487_000);
      const r = turn.segments[0].flow.find((c) => c.kind === 'steps')!;
      expect(run(items(list), r as { ids: string[] }, u.id, null, turn.next)).toBe(487_000);
      // A step whose end came after the next message never reaches past it.
      const c = mk({ type: 'tool', name: 'Bash', kind: 'bash', title: 'Serve', status: 'done', detail: {}, ts: t0 + 1000, endedAt: t0 + 900_000 });
      const soon = mk({ type: 'user', text: 'b', state: 'sent', ts: t0 + 300_000 });
      const t2 = groups([u, c, soon])[0] as TurnGroup;
      expect(span(items([u, c, soon]), t2)).toBe(300_000);
      // The bridge's line says when it was cut: the turn ran to it.
      const cut = mk({ type: 'notice', variant: 'info', text: 'cut', early: 'closed', ts: t0 + 600_000 });
      const t3 = groups([u, a, b, cut])[0] as TurnGroup;
      expect(span(items([u, a, b, cut]), t3)).toBe(600_000);
      // With the agent's record: its own figure (C12, day 7), never the wall time around it.
      const rec = mk({ type: 'turn', durationMs: 90_000, ts: t0 + 125_000 });
      const t4 = groups([u, a, rec])[0] as TurnGroup;
      expect(span(items([u, a, rec]), t4)).toBe(90_000);
    });
  }
});

describe('a step shows only its own time', () => {
  it('a step in flight when Sable closed gets no end when the chat is read again (not the time it was opened)', () => {
    const now = Date.now();
    const meta = { id: 's', provider: 'demo', cwd: '.', title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 } } as SessionMeta;
    const rt = new SessionRuntime(meta, () => {}, () => {});
    // Written 41m 48s before the chat is opened again, cut by the restart.
    const write = { id: 'w', type: 'tool', name: 'Write', kind: 'write', title: 'Write a.md', status: 'running', detail: {}, ts: now - 2_508_000 } as ToolItem;
    rt.loadRestored([{ id: 'u', type: 'user', text: 'go', state: 'sent', ts: now - 2_600_000 } as UserItem, write]);
    rt.settle('cancelled', { endUnknown: true });
    expect(rt.get<ToolItem>('w')).toMatchObject({ status: 'cancelled' });
    expect(rt.get<ToolItem>('w')!.endedAt).toBeUndefined();
    // And the turn says nothing of how it ended (only the bridge's notice does), and not 41 minutes of work.
    const turn = groupTurns(['u', 'w'], rt.items.map((i) => shapeOf(i)).join(''), false).groups[0] as TurnGroup;
    expect(turn.early).toBeUndefined();
    expect(turnSpan(Object.fromEntries(rt.items.map((i) => [i.id, i])), turn)).toBe(92_000);
    // A stop while it runs still ends it now.
    const live = new SessionRuntime({ ...meta, id: 's2' }, () => {}, () => {});
    live.add<ToolItem>({ ...write, status: 'running', id: 'w2', ts: now - 1000 });
    live.settle('cancelled');
    expect(live.get<ToolItem>('w2')!.endedAt).toBeGreaterThanOrEqual(now);
  });

  it('Codex: a stored item without its own start or end has no time (never the gap before it)', () => {
    const turns = [
      {
        id: 't1',
        status: 'completed',
        startedAt: 1000,
        completedAt: 4000,
        durationMs: null,
        error: null,
        items: [
          { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'write it' }] },
          // Made long before, as the item before a long pause.
          { type: 'commandExecution', id: 'old', command: 'ls', cwd: '/r', commandActions: [], aggregatedOutput: '', exitCode: 0, status: 'completed', startedAtMs: 1_000_000, completedAtMs: 1_001_000 },
          // The next step, after a pause of 41 minutes, with no stored start: it took the one before.
          { type: 'fileChange', id: 'w', changes: [], status: 'completed', completedAtMs: 1_000_000 + 2_508_000 },
          { type: 'commandExecution', id: 'nostop', command: 'pwd', cwd: '/r', commandActions: [], aggregatedOutput: '', exitCode: 0, status: 'completed', startedAtMs: 3_600_000 },
        ],
      },
    ] as unknown as Turn[];
    const items = transcript(turns);
    const byId = (id: string) => items.find((i) => i.id === `t1:${id}`) as ToolItem;
    expect(byId('old').endedAt! - byId('old').ts).toBe(1000);
    expect(byId('w').endedAt).toBeUndefined();
    expect(byId('nostop').endedAt).toBeUndefined();
  });
});

// ───────────── Claude Code: the stand-in and failed requests, live and read back ─────────────

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function claude() {
  const p = new ClaudeProvider({ emit: () => {}, log: () => {}, settings: () => DEFAULT_SETTINGS });
  const anyP = p as unknown as Record<string, unknown>;
  anyP.caps = async () => ({ models: [{ id: 'm', name: 'M', isDefault: true }], modes: [], commands: [], skills: [], agents: [], mcpServers: [], tools: [], features: { steer: true } });
  anyP.readLimits = async () => [];
  const now = Date.now();
  const meta: SessionMeta = { id: 's1', provider: 'claude', cwd: process.cwd(), title: 't', titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: now, updatedAt: now, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, providerSessionId: 'cc1' };
  const rt = new SessionRuntime(meta, () => {}, () => {});
  const session = (await p.open(rt, {})) as unknown as Record<string, unknown> & ProviderSession;
  const q = { interrupt: async () => undefined, close: () => {} };
  session.ensure = function (this: Record<string, unknown>) {
    this.q ??= q;
    this.input ??= { push: () => {}, end: () => {} };
    return this.q;
  };
  cleanups.push(() => session.close());
  const message = (m: Record<string, unknown>) => (session.onMessage as (m: unknown) => void).call(session, { session_id: 'cc1', ...m });
  const synthetic = (t: string, extra: Record<string, unknown> = {}) =>
    message({ type: 'assistant', uuid: `a-${Math.random()}`, parent_tool_use_id: null, message: { id: `msg-${Math.random()}`, model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: t }] }, ...extra });
  return { p, rt, session, message, synthetic };
}

describe('Claude Code', () => {
  it('a refused request\'s stand-in is no answer and no notice detail', async () => {
    const c = await claude();
    await c.session.send(c.rt.add<UserItem>({ type: 'user', text: 'go', state: 'sent' }));
    c.synthetic(STAND_IN_ANSWER, { error: 'rate_limit' });
    expect(c.rt.items.some((i) => i.type === 'text')).toBe(false);
    const n = c.rt.items.find((i): i is NoticeItem => i.type === 'notice' && !!i.limit);
    expect(n?.detail).toBeUndefined();
  });

  it('the resume stand-in and a failed request\'s own words never become a text', async () => {
    const c = await claude();
    await c.session.send(c.rt.add<UserItem>({ type: 'user', text: 'go', state: 'sent' }));
    c.synthetic(STAND_IN_ANSWER);
    c.synthetic('API Error: 500 {"type":"error"}', { error: 'server_error' });
    expect(c.rt.items.filter((i) => i.type === 'text')).toEqual([]);
    const n = c.rt.items.find((i): i is NoticeItem => i.type === 'notice' && i.variant === 'error');
    expect(n).toMatchObject({ text: 'The API had a server error.', detail: 'API Error: 500 {"type":"error"}' });
    // Local command output (also '<synthetic>', no error) still shows.
    c.synthetic('Total cost: $0.12');
    expect(c.rt.items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text)).toEqual(['Total cost: $0.12']);
  });

  it('a transcript read back: no stand-in, and a step whose start is unknown shows no time', async () => {
    const c = await claude();
    const t0 = Date.parse('2026-11-22T10:30:00Z');
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    const msgs = [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'look at the jobs' }, timestamp: at(0) },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: '/r/jobs.json' } }] }, timestamp: at(60_000) },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'ok' }] }, timestamp: at(61_000) },
      { type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: STAND_IN_ANSWER }] }, timestamp: at(62_000) },
      { type: 'user', uuid: 'u3', message: { role: 'user', content: 'what happened?' }, timestamp: at(50 * 60_000) },
      // Its own message carries no time: it would take the time of the item before the pause.
      { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'write1', name: 'Write', input: { file_path: '/r/a.md', content: 'x' } }] } },
      { type: 'user', uuid: 'u4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'write1', content: 'written' }] }, timestamp: at(50 * 60_000 + 3000) },
    ];
    (c.p as unknown as { withHistory: () => Promise<unknown> }).withHistory = async () => msgs;
    await (c.session as unknown as { loadTranscript: () => Promise<void> }).loadTranscript();
    expect(c.rt.items.some((i) => i.type === 'text')).toBe(false);
    const read = c.rt.get<ToolItem>('read1')!;
    expect(read.endedAt! - read.ts).toBe(1000);
    expect(c.rt.get<ToolItem>('write1')!.endedAt).toBeUndefined();
  });
});

// ───────────── what Sable writes never shows as the person's ─────────────

describe("Sable's own texts", () => {
  const items: TimelineItem[] = [user('add a logger'), text('Added src/lib/logger.ts.')];

  it('a handover before the person\'s words: each head, the words alone', () => {
    for (const opts of [{}, { from: 'Codex' }, { from: 'Codex', since: true }]) {
      const sent = `${handoverText(items, opts)}${HANDOVER_JOIN}now the tests`;
      expect(stripWrappers(sent)).toBe('now the tests');
      expect(userText(sent)).toBe('now the tests');
      expect(parseSynthetic(sent)).toBeNull();
    }
  });

  it('a handover and the note after a move, around the words', () => {
    const sent = `${handoverText(items)}${HANDOVER_JOIN}go on\n\n${moveNote(items, [])}`;
    expect(stripWrappers(sent)).toBe('go on');
    expect(shapeOf(mk({ type: 'user', text: sent, state: 'sent' }))).toBe('U');
  });

  it('a turn carried on after a limit: nothing of the person\'s, it opens no turn of its own', () => {
    for (const t of [RESUME_AFTER_RESET, RESUME_UNDER_ANOTHER, RESUME_LIMIT_RESET, `${handoverText(items)}${HANDOVER_JOIN}${RESUME_UNDER_ANOTHER}`]) {
      const s = parseSynthetic(t);
      expect(s?.role).toBe('hidden');
      expect(partOfTurn(s)).toBe(true);
      expect(userText(t)).toBe('');
      expect(shapeOf(mk({ type: 'user', text: t, state: 'sent' }))).toBe('u');
      expect(mobile.shapeOf(mk({ type: 'user', text: t, state: 'sent' }))).toBe('u');
    }
    expect(stripWrappers(`add a logger${RESUME_SUMMARY_TRAILER}`)).toBe('add a logger');
  });

  it("an /until round's failure", () => {
    const t = failureMessage({ command: 'pnpm test', round: 1, rounds: 5, exitCode: 1, output: 'FAIL a.test.ts' } as never);
    expect(parseSynthetic(t)?.role).toBe('hidden');
    expect(userText(t)).toBe('');
    // Output of several lines, with a fence of its own inside (the outer one grows past it).
    const long = failureMessage({ command: 'pnpm test', round: 2, rounds: 5, exitCode: 1, output: 'FAIL a.test.ts\n\n```\nexpected 1\n```\n\n2 failed' } as never);
    expect(parseSynthetic(long)?.role).toBe('hidden');
    // Pasted by the person with a question and a fenced fix of their own under it: all of it is theirs.
    const pasted = t + '\n\nWhy does this still fail? I tried:\n\n```text\nretry()\n```';
    expect(parseSynthetic(pasted)).toBeNull();
    expect(stripWrappers(pasted)).toBe(pasted);
  });

  it("the Browser tab's line after the words", () => {
    expect(stripWrappers('read the page\n\n[Sable: the user\'s Browser tab shows localhost:5173/ titled "Sable". browser_read reads it.]')).toBe('read the page');
  });

  it("the person's own words stay as they are", () => {
    for (const t of ['This continues to fail, why?', 'The check `x` failed for me yesterday', 'Carry on from there.', 'hi']) {
      expect(parseSynthetic(t)).toBeNull();
      expect(stripWrappers(t)).toBe(t);
    }
  });

  it('a handover read back as a summary for the next account keeps only the person\'s words', () => {
    const before = [user(`${handoverText(items)}${HANDOVER_JOIN}now the tests`), text('Tests added.')];
    const again = handoverText(before);
    expect(again).toContain('User: now the tests');
    expect(again).not.toContain('User: This continues');
  });
});
