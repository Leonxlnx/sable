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
import { groupTurns, lastResponse, shapeOf, endedEarly, type TurnGroup } from '@/features/timeline/turns';
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
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => { groups: (TurnGroup | { kind: 'item' })[] };
  shapeOf: (item: TimelineItem) => string;
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

describe('a turn that ended before the agent finished', () => {
  for (const phone of [false, true]) {
    const tag = phone ? 'phone' : 'desktop';
    it(`cut after a step, with no record of its end, reads as ended early (${tag})`, () => {
      // The reported case, as a transcript read back shows it: a read-only check, the stand-in, then the next message.
      const turns = layout([user('look at the jobs'), text('Let me check the queue.'), step(), text(STAND_IN_ANSWER), user('what happened?'), text('Nothing ran.')], false, phone);
      expect(turns[0].early).toBe(true);
      expect(turns[0].state).toBe('done');
      expect(turns[1].early).toBeUndefined();
    });

    it(`a finished, stopped, failed or running turn does not (${tag})`, () => {
      expect(layout([user('a'), step(), end()], false, phone)[0].early).toBeUndefined();
      expect(layout([user('a'), step(), notice('interrupted')], false, phone)[0].early).toBeUndefined();
      expect(layout([user('a'), step(), notice('error')], false, phone)[0].early).toBeUndefined();
      expect(layout([user('a'), step(), end('Boom')], false, phone)[0].early).toBeUndefined();
      expect(layout([user('a'), step()], true, phone)[0].early).toBeUndefined();
      // History with no turn records: a turn that ends with words is finished.
      expect(layout([user('a'), step(), text('Done: the queue is empty.'), user('b')], false, phone)[0].early).toBeUndefined();
      // Closed by a line of its own (a switch of agent, a rewind): not the agent's doing.
      expect(layout([user('a'), step(), mk({ type: 'notice', variant: 'info', text: 'Switched', agentSwitch: { from: 'claude', to: 'codex' } })], false, phone)[0].early).toBeUndefined();
    });
  }

  it('the rule reads the provider events only', () => {
    expect(endedEarly('done', null, ['l', 'w', '.'])).toBe(true);
    expect(endedEarly('done', null, ['w', 'h'])).toBe(true);
    expect(endedEarly('done', null, ['w', 't', 'n'])).toBe(false);
    // A warning after the last act says nothing about how the turn ended: the act before it decides.
    expect(endedEarly('done', null, ['w', 'a'])).toBe(true);
    expect(endedEarly('done', null, ['w', 't', 'a'])).toBe(false);
    expect(endedEarly('done', 'end', ['w'])).toBe(false);
    expect(endedEarly('done', null, ['w'], 'line')).toBe(false);
    expect(endedEarly('interrupted', null, ['w'])).toBe(false);
  });
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
    // And the turn reads as ended early, not as 41 minutes of work.
    const turn = groupTurns(['u', 'w'], rt.items.map((i) => shapeOf(i)).join(''), false).groups[0] as TurnGroup;
    expect(turn.early).toBe(true);
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
