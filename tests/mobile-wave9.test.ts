/**
 * The phone's screens after review wave 9 (findings 1, 10, 11, 13, 17, 22), through the rules they
 * now share (mobile/src/lib/chat-rules.ts) and the phone's own turn grouping:
 * - 1: what a command printed (a user item Claude Code wrote) is drawn as a user line wherever a turn
 *   keeps it in view, never as a step block (which read `detail` it does not have);
 * - 10: a search hit folded away names the folds that hide it (the turn's line, a checkpoint);
 * - 11: a running chat answered on the computer can still be stopped;
 * - 13: a sub-agent's edit counts for the turn's changes and its check; a turn no message opened
 *   offers no check (the RPC takes that message);
 * - 17: only a message the person sent, newer than the last followed, pulls the reader down;
 * - 22: a chat whose sub-agents still work is working for its row, the count and the moment it is done.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));

import * as rules from '../mobile/src/lib/chat-rules';

// Loaded by a path the root type check does not follow: the phone's turn model resolves `@desk` through its own config.
const TURNS = '../mobile/src/lib/turns';
type Chunk = { kind: 'text' | 'show'; id: string } | { kind: 'steps'; key: string; ids: string[]; count: number };
interface Seg {
  lead: string | null;
  steered: boolean;
  flow: Chunk[];
  notes: string[];
}
type Group = { kind: 'turn'; key: string; segments: Seg[]; state: 'running' | 'done' | 'failed' | 'interrupted'; ids: string[]; end: string | null } | { kind: 'item'; key: string; id: string };
const turns = (await import(/* @vite-ignore */ TURNS)) as {
  groupTurns: (ids: readonly string[], shape: string, busy: boolean) => { groups: Group[]; queued: string[] };
  shapeString: (roots: string[], items: Record<string, TimelineItem>) => string;
};

let clock = 1000;
const at = () => (clock += 1000);
const user = (id: string, text: string, extra: Record<string, unknown> = {}): TimelineItem => ({ id, type: 'user', ts: at(), text, ...extra }) as TimelineItem;
const text = (id: string, t: string): TimelineItem => ({ id, type: 'text', ts: at(), text: t }) as TimelineItem;
const tool = (id: string, kind: string, extra: Record<string, unknown> = {}): TimelineItem =>
  ({ id, type: 'tool', ts: at(), name: kind, kind, title: kind, status: 'done', detail: {}, ...extra }) as TimelineItem;
const end = (id: string): TimelineItem => ({ id, type: 'turn', ts: at(), durationMs: 1000 }) as TimelineItem;
const diff = (path: string, additions: number, deletions: number) => ({ result: { diff: [{ path, status: 'modified', additions, deletions, hunks: [] }] } });

function layout(list: TimelineItem[], busy = false) {
  const items: Record<string, TimelineItem> = {};
  for (const it of list) items[it.id] = it;
  const roots = list.filter((it) => !it.parentId).map((it) => it.id);
  return { items, roots, ...turns.groupTurns(roots, turns.shapeString(roots, items), busy) };
}

describe('wave 9 #1: a command result in view is drawn as what it is', () => {
  it('a /model exchange whose only result is the command output never reaches the step block', () => {
    const l = layout([user('cmd', '<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>'), user('out', '<local-command-stdout>Set model to Opus</local-command-stdout>'), end('T')]);
    const turn = l.groups.find((g) => g.kind === 'turn');
    expect(turn?.kind).toBe('turn');
    // Every piece the turn keeps in view is drawn by its own type: the printed output as a user line.
    for (const g of l.groups) {
      if (g.kind !== 'turn') {
        expect(rules.showKind(l.items[g.id])).not.toBe('block');
        continue;
      }
      for (const s of g.segments)
        for (const c of s.flow) {
          if (c.kind !== 'show') continue;
          const kind = rules.showKind(l.items[c.id]);
          if (l.items[c.id].type !== 'tool') expect(kind).not.toBe('block');
        }
    }
    // It stands in view (a lone notice, or command output): exactly where the step block used to be asked to draw it.
    const shown = l.groups.flatMap((g) => (g.kind === 'turn' ? g.segments.flatMap((s) => s.flow.filter((c) => c.kind === 'show').map((c) => (c as { id: string }).id)) : [g.id]));
    expect(shown).toContain('out');
    expect(rules.showKind(l.items.out)).toBe('user');
  });

  it('only steps are blocks; a type it does not know shows nothing', () => {
    expect(rules.showKind(tool('a', 'agent'))).toBe('block');
    expect(rules.showKind(tool('p', 'plan'))).toBe('plan');
    expect(rules.showKind(tool('s', 'share'))).toBe('share');
    expect(rules.showKind(tool('c', 'agent', { check: { turn: 'u', agent: 'codex' } }))).toBe('check');
    expect(rules.showKind(text('t', 'Hello'))).toBe('text');
    expect(rules.showKind(end('T'))).toBeNull();
    expect(rules.showKind(undefined)).toBeNull();
  });
});

describe('wave 9 #10: a search hit names the folds that hide it', () => {
  const l = layout([
    user('u', 'Look into the cache'),
    tool('w1', 'read'),
    text('report', 'The cache keeps every entry for an hour, which explains the stale rows.'),
    tool('w2', 'edit'),
    text('answer', 'I shortened the cache to five minutes and the stale rows are gone.'),
    end('T'),
  ]);
  const turn = l.groups.find((g) => g.kind === 'turn');
  if (turn?.kind !== 'turn') throw new Error('no turn');

  it('an intermediate report of a finished turn folds into its line: the line opens', () => {
    expect(turn.segments[0].notes).toContain('report');
    expect(rules.foldTarget(turn, 'report')).toEqual({ found: true, fold: true, run: null });
  });

  it('a step opens its checkpoint as well', () => {
    const t = rules.foldTarget(turn, 'w2');
    expect(t.found && t.fold).toBe(true);
    expect(t.run).not.toBeNull();
    const run = turn.segments[0].flow.find((c) => c.kind === 'steps' && c.key === t.run);
    expect(run && run.kind === 'steps' && run.ids).toContain('w2');
  });

  it('the answer and the message stay in view: nothing to open', () => {
    expect(rules.foldTarget(turn, 'answer')).toEqual({ found: true, fold: false, run: null });
    expect(rules.foldTarget(turn, 'u')).toEqual({ found: true, fold: false, run: null });
    expect(rules.foldTarget(turn, 'elsewhere').found).toBe(false);
  });
});

describe('wave 9 #11: the read-only footer keeps Stop', () => {
  it('a running, starting or waiting chat can be stopped; one at rest cannot', () => {
    expect(rules.canStop('running')).toBe(true);
    expect(rules.canStop('starting')).toBe(true);
    expect(rules.canStop('awaiting')).toBe(true);
    expect(rules.canStop('idle')).toBe(false);
    expect(rules.canStop(undefined)).toBe(false);
  });
});

describe('wave 9 #13: the turn check', () => {
  it('a sub-agent that made the only edit: the turn changed files and can be checked', () => {
    const l = layout([user('u', 'Fix it'), tool('agent', 'agent', { kids: 1 }), tool('edit', 'edit', { parentId: 'agent', ...diff('src/a.ts', 3, 1) }), text('a', 'Fixed the parser.'), end('T')]);
    const turn = l.groups.find((g) => g.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('no turn');
    const c = rules.turnChanges(l.items, { agent: ['edit'] }, turn.ids);
    expect(c).toMatchObject({ files: 1, add: 3, del: 1, unknown: [] });
    expect(c.edits).toEqual(['agent']);
    expect(rules.checkOpener(turn, l.items)).toBe('u');
  });

  it("a sub-agent whose steps the phone has not got is named: the desktop says what it changed", () => {
    const l = layout([user('u', 'Fix it'), tool('agent', 'agent', { kids: 4 }), text('a', 'Fixed the parser.'), end('T')]);
    const turn = l.groups.find((g) => g.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('no turn');
    expect(rules.turnChanges(l.items, {}, turn.ids)).toMatchObject({ files: 0, unknown: ['agent'] });
  });

  it('a finished background turn that begins with an edit offers no check (no message to send)', () => {
    const l = layout([user('u', 'Start the build'), text('a', 'Started it in the background.'), end('T1'), tool('edit', 'edit', diff('src/b.ts', 1, 0)), text('b', 'The build wrote its stamp.'), end('T2')]);
    const own = l.groups.filter((g) => g.kind === 'turn');
    const last = own[own.length - 1];
    if (last?.kind !== 'turn') throw new Error('no turn');
    expect(last.key).toBe('edit');
    expect(rules.turnChanges(l.items, {}, last.ids).files).toBe(1);
    expect(rules.checkOpener(last, l.items)).toBeNull();
  });

  it('a turn still running, or one that failed, is not offered', () => {
    const l = layout([user('u', 'Go'), tool('edit', 'edit', diff('x', 1, 0))], true);
    const run = l.groups[0];
    if (run.kind !== 'turn') throw new Error('no turn');
    expect(run.state).toBe('running');
    expect(rules.checkOpener(run, l.items)).toBeNull();
    expect(rules.checkOpener({ ...run, state: 'failed' }, l.items)).toBeNull();
    expect(rules.checkOpener({ ...run, state: 'done' }, l.items)).toBe('u');
  });
});

describe('wave 9 #17: what pulls a reader to the newest line', () => {
  const note = '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "Build" completed (exit code 0)</summary></task-notification>';

  it('a turn a notification began changes nothing', () => {
    const before = layout([user('u1', 'Build it'), text('a', 'Started.'), end('T1')]);
    const after = layout([user('u1', 'Build it'), text('a', 'Started.'), end('T1'), user('n1', note), tool('w', 'bash')]);
    const prev = rules.newestSent(before.roots, before.items);
    const next = rules.newestSent(after.roots, after.items);
    expect(next?.id).toBe('u1');
    expect(rules.followSent(prev, next)).toBe(false);
  });

  it('a background tool that starts a turn of its own changes nothing', () => {
    const before = layout([user('u1', 'Hi'), text('a', 'Hello.'), end('T1')]);
    const after = layout([user('u1', 'Hi'), text('a', 'Hello.'), end('T1'), tool('w', 'bash')]);
    expect(rules.followSent(rules.newestSent(before.roots, before.items), rules.newestSent(after.roots, after.items))).toBe(false);
  });

  it('a rewind that leaves an older message last changes nothing; a new message follows', () => {
    const u1 = user('u1', 'First');
    const u2 = user('u2', 'Second');
    const u3 = user('u3', 'Third');
    expect(rules.followSent({ id: u2.id, ts: u2.ts }, { id: u1.id, ts: u1.ts })).toBe(false);
    expect(rules.followSent({ id: u2.id, ts: u2.ts }, { id: u3.id, ts: u3.ts })).toBe(true);
    expect(rules.followSent(undefined, { id: u1.id, ts: u1.ts })).toBe(true);
    expect(rules.followSent({ id: u1.id, ts: u1.ts }, { id: u1.id, ts: u1.ts })).toBe(false);
  });

  it("a failing check Sable sent back is not the person's message", () => {
    const l = layout([user('u1', 'Make the tests pass'), end('T1'), user('back', 'The check failed', { until: { check: { passed: false, command: 'pnpm test', round: 1, rounds: 3 } } })]);
    expect(rules.newestSent(l.roots, l.items)?.id).toBe('u1');
  });
});

describe('wave 9 #22: a chat whose sub-agents still work is working', () => {
  it('one predicate: its turn, or sub-agents left at work', () => {
    expect(rules.worksNow({ status: 'running' })).toBe(true);
    expect(rules.worksNow({ status: 'starting' })).toBe(true);
    expect(rules.worksNow({ status: 'idle', background: 1 })).toBe(true);
    expect(rules.worksNow({ status: 'idle', background: 0 })).toBe(false);
    expect(rules.worksNow({ status: 'idle' })).toBe(false);
    // Waiting on you reads as that, whatever still runs behind it. A turn that ended with an error
    // while its sub-agents work on is still a chat at work (day 5: "show you are working when SUBAGENTS are").
    expect(rules.worksNow({ status: 'awaiting', background: 1 })).toBe(false);
    expect(rules.worksNow({ status: 'error', background: 1 })).toBe(true);
    expect(rules.worksNow({ status: 'error', background: 0 })).toBe(false);
  });
});
