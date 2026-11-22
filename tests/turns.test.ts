import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { groupTurns, lastResponse, responseText, shapeOf, turnsIndex, type FlowChunk, type TurnGroup } from '@/features/timeline/turns';

/** Builds ids and a shape string from a compact spec: "U1 w2 t3 T4" (shape char + id). */
function spec(s: string) {
  const parts = s.split(/\s+/).filter(Boolean);
  return { ids: parts.map((p) => p.slice(1)), shape: parts.map((p) => p[0]).join('') };
}

const turns = (s: string, busy = false) => {
  const { ids, shape } = spec(s);
  return groupTurns(ids, shape, busy);
};

/** A flow in short: texts by id, shown pieces as `*id`, runs of steps as `[ids]`. */
const flowOf = (flow: FlowChunk[]) => flow.map((c) => (c.kind === 'steps' ? `[${c.ids.join(' ')}]` : c.kind === 'show' ? `*${c.id}` : c.id)).join(' ');

const onlyTurn = (s: string, busy = false) => {
  const { groups } = turns(s, busy);
  expect(groups).toHaveLength(1);
  expect(groups[0].kind).toBe('turn');
  return groups[0] as TurnGroup;
};

describe('shapeOf', () => {
  const base = { id: 'x', ts: 0 };
  it('reduces items to one character', () => {
    const cases: [TimelineItem, string][] = [
      [{ ...base, type: 'user', text: 'hi' }, 'U'],
      [{ ...base, type: 'user', text: 'hi', state: 'queued' }, 'Q'],
      [{ ...base, type: 'user', text: 'hi', state: 'queued', steered: true }, 'S'],
      [{ ...base, type: 'user', text: 'hi', state: 'sent', steered: true }, 'S'],
      [{ ...base, type: 'text', text: 'Hello', streaming: false }, 't'],
      [{ ...base, type: 'text', text: '', streaming: true }, 'l'],
      [{ ...base, type: 'text', text: 'Let me run the tests.', streaming: false }, 'l'],
      [{ ...base, type: 'text', text: 'The guard answers 403. Let me fix it.', streaming: false }, 't'],
      [{ ...base, type: 'text', text: '  ', streaming: false }, '.'],
      [{ ...base, type: 'thinking', text: '', streaming: false }, 'h'],
      [{ ...base, type: 'tool', name: 'Bash', kind: 'bash', title: 'Run', status: 'done', detail: {} }, 'w'],
      [{ ...base, type: 'tool', name: 'ExitPlanMode', kind: 'plan', title: 'Plan', status: 'awaiting', detail: {} }, 'p'],
      [{ ...base, type: 'tool', name: 'SendUserFile', kind: 'share', title: 'a.pdf', status: 'done', detail: { files: [{ path: '/a.pdf', name: 'a.pdf' }] } }, 'f'],
      [{ ...base, type: 'notice', variant: 'interrupted', text: 'Interrupted' }, 'i'],
      [{ ...base, type: 'notice', variant: 'error', text: 'Boom' }, 'e'],
      [{ ...base, type: 'notice', variant: 'command', text: '/context' }, 'c'],
      [{ ...base, type: 'notice', variant: 'mode', text: 'Plan mode' }, 'n'],
      [{ ...base, type: 'turn', durationMs: 1 }, 'T'],
      [{ ...base, type: 'turn', durationMs: 1, error: 'x' }, 'F'],
    ];
    for (const [item, ch] of cases) expect(shapeOf(item)).toBe(ch);
  });
});

describe('groupTurns', () => {
  it('reads a turn as checkpoints: runs of steps, each closed by the note that followed it', () => {
    const t = onlyTurn('U1 w2 t3 w4 w5 w6 t7 w8 t9 T10');
    expect(t.state).toBe('done');
    expect(t.end).toBe('10');
    expect(t.segments).toHaveLength(1);
    const s = t.segments[0];
    expect(s.lead).toBe('1');
    expect(s.answer).toBe('9');
    expect(s.work).toEqual(['2', '4', '5', '6', '8']);
    expect(s.steps).toBe(5);
    expect(s.flow).toEqual([
      { kind: 'steps', key: '2', ids: ['2'], count: 1 },
      { kind: 'text', id: '3' },
      { kind: 'steps', key: '4', ids: ['4', '5', '6'], count: 3 },
      { kind: 'text', id: '7' },
      { kind: 'steps', key: '8', ids: ['8'], count: 1 },
      { kind: 'text', id: '9' },
    ]);
    // The notes along the way fold with the work once the turn has ended; the answer never does.
    expect(s.notes).toEqual(['3', '7']);
    expect(t.ids).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('only ever grows at its end as the turn goes on: a run, then what closed it', () => {
    const steps = ['U1', 'U1 t2', 'U1 t2 h3', 'U1 t2 h3 w4', 'U1 t2 h3 w4 t5', 'U1 t2 h3 w4 t5 w6', 'U1 t2 h3 w4 t5 w6 t7'];
    expect(steps.map((s) => flowOf(onlyTurn(s, true).segments[0].flow))).toEqual(['', '2', '2 [3]', '2 [3 4]', '2 [3 4] 5', '2 [3 4] 5 [6]', '2 [3 4] 5 [6] 7']);
    // Settled the same way: what was said before the first step is a note too.
    const s = onlyTurn('U1 t2 h3 w4 t5 w6 t7 T8').segments[0];
    expect(flowOf(s.flow)).toBe('2 [3 4] 5 [6] 7');
    expect(s.notes).toEqual(['2', '5']);
    // With no work at all there is nothing to fold behind: the texts simply stand.
    expect(onlyTurn('U1 t2 T3').segments[0]).toMatchObject({ notes: [], answer: '2' });
    expect(onlyTurn('U1 t2 t3 T4').segments[0]).toMatchObject({ notes: [], answer: '3' });
  });

  it('keeps widgets and plans in view in their place, not as steps: each closes a checkpoint', () => {
    const s = onlyTurn('U1 w2 p3 w4 g5 t6 T7').segments[0];
    expect(flowOf(s.flow)).toBe('[2] *3 [4] *5 6');
    expect(s.steps).toBe(2);
    expect(s.work).toEqual(['2', '4']);
    expect(s.notes).toEqual([]);
  });

  it('starts a segment for every steered message; what a segment the steer cut said are notes', () => {
    const t = onlyTurn('U1 w2 t3 S4 t5 w6 w7 t8 T9');
    expect(t.segments.map((s) => [s.lead, s.steered, s.reply, s.answer, s.work, s.notes])).toEqual([
      ['1', false, null, null, ['2'], ['3']],
      ['4', true, '5', '8', ['6', '7'], []],
    ]);
    // The message, the reply to it, then the work that went on and the answer.
    expect(flowOf(t.segments[1].flow)).toBe('5 [6 7] 8');
  });

  it('stands the reply to a steered message right under it, whatever was still running', () => {
    const t = onlyTurn('U1 w2 S3 w4 t5 w6 t7 t8 T9');
    expect(t.segments[1]).toMatchObject({ reply: '5', answer: '8', work: ['4', '6'], notes: ['7'] });
    // A step still under way when the message came does not stand between the pair: it goes on in the run under it.
    expect(flowOf(t.segments[1].flow)).toBe('5 [4 6] 7 8');
    // A reply that is also the last word is the answer, shown once.
    expect(onlyTurn('U1 w2 S3 t4 T5').segments[1]).toMatchObject({ reply: null, answer: '4', work: [] });
    expect(flowOf(onlyTurn('U1 w2 S3 t4 T5').segments[1].flow)).toBe('4');
    // With steps before it and nothing after: the pair, then that work.
    expect(flowOf(onlyTurn('U1 w2 S3 w4 t5 T6').segments[1].flow)).toBe('5 [4]');
  });

  it('keeps the work of a live steered segment under the message until the reply comes, then under the pair', () => {
    const flows = ['U1 w2 S3', 'U1 w2 S3 w4', 'U1 w2 S3 w4 t5', 'U1 w2 S3 w4 t5 w6', 'U1 w2 S3 w4 t5 w6 t7'].map((s) => flowOf(onlyTurn(s, true).segments[1].flow));
    expect(flows).toEqual(['', '[4]', '5 [4]', '5 [4 6]', '5 [4 6] 7']);
  });

  it('keeps a steered message that is not answered yet as its own live segment', () => {
    const t = onlyTurn('U1 w2 w3 S4', true);
    expect(t.state).toBe('running');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[1]).toMatchObject({ lead: '4', steered: true, answer: null, work: [], steps: 0 });
    expect(t.segments[1].flow).toEqual([]);
  });

  it('folds what any segment said along the way once the turn has work, also a segment with none of its own', () => {
    const t = onlyTurn('U1 t2 S3 t4 w5 t6 T7');
    expect(t.segments.map((s) => [s.notes, s.reply, s.answer])).toEqual([
      [['2'], null, null],
      [[], '4', '6'],
    ]);
  });

  it('treats a steered message outside a turn as an ordinary one', () => {
    const t = onlyTurn('S1 t2 T3');
    expect(t.segments[0]).toMatchObject({ lead: '1', steered: true, answer: '2' });
  });

  it('keeps the running story in order: a text is the answer only while nothing follows it', () => {
    const t = onlyTurn('U1 w2 t3 w4', true);
    expect(t.state).toBe('running');
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[0].work).toEqual(['2', '4']);
    expect(flowOf(t.segments[0].flow)).toBe('[2] 3 [4]');
    const writing = onlyTurn('U1 w2 t3 w4 t5', true);
    expect(writing.segments[0].answer).toBe('5');
    // Settled, the last text is the answer again, wherever it stands.
    expect(onlyTurn('U1 w2 t3 w4').segments[0].answer).toBe('3');
  });

  it('shows notices that are all a turn holds (a /compact) instead of folding them', () => {
    const t = onlyTurn('U1 n2 T3');
    expect(t.segments[0].work).toEqual([]);
    // Shown, but not an error: it does not stand for a failure the turn's foot would otherwise say.
    expect(t.segments[0].errors).toEqual([]);
    expect(flowOf(t.segments[0].flow)).toBe('*2');
    // Among steps, a notice is part of the story.
    expect(onlyTurn('U1 w2 n3 t4 T5').segments[0].work).toEqual(['2', '3']);
  });

  it('does not count thinking as a step, and never shows it outside the steps', () => {
    const t = onlyTurn('U1 h2 g3 t4 T5');
    expect(t.segments[0].steps).toBe(0);
    expect(t.segments[0].work).toEqual(['2']);
    expect(flowOf(t.segments[0].flow)).toBe('[2] *3 4');
  });

  it('does not count task list updates as steps', () => {
    const t = onlyTurn('U1 w2 k3 w4 k5 t6 T7');
    expect(t.segments[0].steps).toBe(2);
    expect(t.segments[0].work).toEqual(['2', '3', '4', '5']);
  });

  it('closes an interrupted turn with its last message as the answer', () => {
    const { groups } = turns('U1 w2 t3 w4 i5 U6 t7 T8');
    expect(groups).toHaveLength(2);
    const [a, b] = groups as TurnGroup[];
    expect(a.state).toBe('interrupted');
    expect(a.end).toBeNull();
    expect(a.segments[0].answer).toBe('3');
    expect(a.segments[0].work).toEqual(['2', '4']);
    expect(a.ids).toContain('5');
    expect(b.state).toBe('done');
    expect(b.segments[0].answer).toBe('7');
  });

  it('lets a notice after an interruption stand on its own', () => {
    const { groups } = turns('U1 w2 t3 i4 n5');
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item']);
    const t = groups[0] as TurnGroup;
    expect(t.state).toBe('interrupted');
    expect(t.ids).toEqual(['1', '2', '3', '4']);
    expect(t.segments[0].work).toEqual(['2']);
  });

  it('is interrupted, not running, when the session is still busy with nothing after the notice', () => {
    expect(onlyTurn('U1 w2 i3', true).state).toBe('interrupted');
  });

  it('attaches an interruption written after the turn record to that turn', () => {
    const { groups } = turns('U1 t2 T3 i4');
    expect(groups).toHaveLength(1);
    expect((groups[0] as TurnGroup).state).toBe('interrupted');
  });

  it('answers a failed turn with its error, and keeps the last words before it in view', () => {
    const t = onlyTurn('U1 w2 t3 w4 t5 F6');
    expect(t.state).toBe('failed');
    expect(t.segments[0].answer).toBeNull();
    expect(t.segments[0].work).toEqual(['2', '4']);
    expect(flowOf(t.segments[0].flow)).toBe('[2] 3 [4] 5');
    // Where it stopped stays readable; what came before folds.
    expect(t.segments[0]).toMatchObject({ last: '5', notes: ['3'] });
    // A turn that ended well has no such words: its answer stands.
    expect(onlyTurn('U1 w2 t3 T4').segments[0].last).toBeNull();
  });

  it('keeps error notices out of the fold, where they happened', () => {
    const t = onlyTurn('U1 w2 e3');
    expect(t.state).toBe('failed');
    expect(t.segments[0].errors).toEqual(['3']);
    expect(t.segments[0].work).toEqual(['2']);
    expect(flowOf(t.segments[0].flow)).toBe('[2] *3');
  });

  it('does not fail a turn that recovered after an error', () => {
    const t = onlyTurn('U1 e2 w3 t4 T5');
    expect(t.state).toBe('done');
    expect(t.segments[0].answer).toBe('4');
    expect(t.segments[0].errors).toEqual(['2']);
    // The error stays where it happened, before the work that went on.
    expect(flowOf(t.segments[0].flow)).toBe('*2 [3] 4');
  });

  it('derives turns from messages in history without turn records', () => {
    const { groups } = turns('n0 U1 w2 t3 U4 t5 w6 t7 U8 t9');
    expect(groups.map((g) => g.kind)).toEqual(['item', 'turn', 'turn', 'turn']);
    const ts = groups.slice(1) as TurnGroup[];
    expect(ts.map((t) => t.state)).toEqual(['done', 'done', 'done']);
    expect(ts.map((t) => t.segments[0].answer)).toEqual(['3', '7', '9']);
    expect(ts[1].segments[0].work).toEqual(['6']);
    expect(flowOf(ts[1].segments[0].flow)).toBe('5 [6] 7');
  });

  it('marks only the open turn at the end as running', () => {
    const { groups } = turns('U1 t2 U3 w4', true);
    expect((groups as TurnGroup[]).map((t) => t.state)).toEqual(['done', 'running']);
  });

  it('keeps notices between turns as single items', () => {
    const { groups } = turns('U1 t2 T3 n4 n5 U6 t7 T8');
    expect(groups.map((g) => (g.kind === 'item' ? g.id : `turn:${g.key}`))).toEqual(['turn:1', '4', '5', 'turn:6']);
  });

  it('floats queued messages to the end', () => {
    const { groups, queued } = turns('U1 w2 Q3 t4', true);
    expect(queued).toEqual(['3']);
    expect((groups[0] as TurnGroup).segments[0].answer).toBe('4');
    expect((groups[0] as TurnGroup).ids).not.toContain('3');
  });

  it('uses command output and plans as answers', () => {
    expect(onlyTurn('U1 c2 T3').segments[0].answer).toBe('2');
    const plan = onlyTurn('U1 w2 w3 p4', true).segments[0];
    expect(plan.answer).toBe('4');
    expect(plan.steps).toBe(2);
  });

  it('skips empty texts', () => {
    const s = onlyTurn('U1 t2 w3 .4 T5').segments[0];
    expect(s.answer).toBe('2');
    expect(s.work).toEqual(['3']);
    expect(flowOf(s.flow)).toBe('2 [3]');
  });

  it('handles a turn with no answer at all', () => {
    const s = onlyTurn('U1 w2 w3 T4').segments[0];
    expect(s.answer).toBeNull();
    expect(s.steps).toBe(2);
  });
});

describe('the answer of a finished turn', () => {
  // `l` is a lead-in or a nod ("Committed.", "Done.", an announcement): see lead-in.ts.
  it('stays the report when a nod follows it: the nod stands under it as a last line', () => {
    const s = onlyTurn('U1 w2 t3 l4 T5').segments[0];
    expect(s).toMatchObject({ answer: '3', tail: ['4'], notes: [], work: ['2'] });
    expect(flowOf(s.flow)).toBe('[2] 3 4');
  });

  it('stays the report when steps and then a nod follow it', () => {
    const s = onlyTurn('U1 w2 t3 w4 w5 l6 T7').segments[0];
    expect(s).toMatchObject({ answer: '3', tail: ['6'], notes: [], work: ['2', '4', '5'] });
    expect(flowOf(s.flow)).toBe('[2] 3 [4 5] 6');
    // An earlier note still folds: only the last report is the answer.
    expect(onlyTurn('U1 w2 t3 w4 t5 w6 l7 T8').segments[0]).toMatchObject({ answer: '5', tail: ['7'], notes: ['3'] });
    // A task list update or a notice after the nod changes nothing.
    expect(onlyTurn('U1 w2 t3 w4 l5 k6 n7 T8').segments[0]).toMatchObject({ answer: '3', tail: ['5'] });
  });

  it('is the nod when the turn said nothing else, the last of several', () => {
    expect(onlyTurn('U1 w2 l3 T4').segments[0]).toMatchObject({ answer: '3', tail: [], notes: [] });
    expect(onlyTurn('U1 l2 w3 l4 T5').segments[0]).toMatchObject({ answer: '4', tail: [], work: ['2', '3'] });
  });

  it('is the last of two real reports: the earlier one folds as a note', () => {
    const s = onlyTurn('U1 w2 t3 w4 t5 T6').segments[0];
    expect(s).toMatchObject({ answer: '5', tail: [], notes: ['3'] });
  });

  it('reads a plan or command output the same way: a nod after it is not the answer', () => {
    expect(onlyTurn('U1 w2 p3 l4 T5').segments[0]).toMatchObject({ answer: '3', tail: ['4'] });
    expect(onlyTurn('U1 c2 l3 T4').segments[0]).toMatchObject({ answer: '2', tail: ['3'] });
  });

  it('keeps the rule in a steered segment and after an interruption', () => {
    // The reply is the report; "Done." after the work is its last line.
    const t = onlyTurn('U1 w2 S3 t4 w5 l6 T7');
    expect(t.segments[1]).toMatchObject({ reply: null, answer: '4', tail: ['6'], work: ['5'] });
    // A nod as the reply, a report after: the reply stays the reply.
    expect(onlyTurn('U1 w2 S3 l4 w5 t6 T7').segments[1]).toMatchObject({ reply: '4', answer: '6', tail: [] });
    expect(onlyTurn('U1 w2 t3 w4 l5 i6').segments[0]).toMatchObject({ answer: '3', tail: ['5'] });
  });

  it('leaves a running turn as it was: the nod waits in the work for a step', () => {
    const s = onlyTurn('U1 w2 t3 w4 l5', true).segments[0];
    expect(s).toMatchObject({ answer: null, tail: [], work: ['2', '4', '5'] });
  });

  it('keeps the last report of a failed turn in view, and a nod after it', () => {
    const s = onlyTurn('U1 w2 t3 w4 t5 l6 e7 F8').segments[0];
    expect(s).toMatchObject({ answer: null, last: '5', tail: ['6'], notes: ['3'] });
    // Nothing but a nod before the failure: it is those last words.
    expect(onlyTurn('U1 w2 l3 e4 F5').segments[0]).toMatchObject({ answer: null, last: '3', tail: [] });
  });
});

describe('work no message opened (a turn the agent began by itself)', () => {
  it('is a turn of its own, with no message at its head, instead of a row per step', () => {
    // A notification opened a turn and it ended; then the agent went on by itself (a second wake).
    const { groups } = turns('U1 t2 T3 N4 t5 T6 h7 t8 w9 w10 h11 w12', true);
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'turn', 'turn']);
    const own = groups[2] as TurnGroup;
    expect(own.key).toBe('7');
    expect(own.state).toBe('running');
    expect(own.segments).toHaveLength(1);
    expect(own.segments[0]).toMatchObject({ lead: null, steered: false, work: ['7', '9', '10', '11', '12'], steps: 3 });
    expect(flowOf(own.segments[0].flow)).toBe('[7] 8 [9 10 11 12]');
    expect(own.ids).toEqual(['7', '8', '9', '10', '11', '12']);
  });

  it('ends at its turn record, or at the next message', () => {
    const { groups } = turns('U1 t2 T3 w4 t5 T6 w7 t8 U9 t10 T11');
    expect(groups.map((g) => (g as TurnGroup).key)).toEqual(['1', '4', '7', '9']);
    expect((groups[1] as TurnGroup).segments[0]).toMatchObject({ lead: null, answer: '5', work: ['4'] });
    expect((groups[1] as TurnGroup).end).toBe('6');
    expect((groups[2] as TurnGroup).segments[0]).toMatchObject({ lead: null, answer: '8' });
  });

  it('takes a steered message and a notification as any turn does', () => {
    const t = turns('U1 t2 T3 w4 S5 t6 w7 t8 T9').groups[1] as TurnGroup;
    expect(t.segments.map((s) => [s.lead, s.steered, s.reply, s.answer])).toEqual([
      [null, false, null, null],
      ['5', true, '6', '8'],
    ]);
  });

  it('leaves notices outside any turn as single items, and an error too', () => {
    expect(turns('n0 U1 t2 T3 n4 e5 w6 t7 T8').groups.map((g) => (g.kind === 'item' ? g.id : `turn:${g.key}`))).toEqual(['0', 'turn:1', '4', '5', 'turn:6']);
    // Before the first message as well: what the agent wrote there is a turn.
    expect(turns('t0 U1 t2 T3').groups.map((g) => g.kind)).toEqual(['turn', 'turn']);
  });
});

describe('turnsIndex (groupTurns followed run by run)', () => {
  it('always equals groupTurns, through added steps, changed and removed items, checks and busy changes', () => {
    const CHARS = 'UUUUUSSQxtttcpwwwwwwnhkkieeTTTFgZ..NNu';
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * n);
    };
    for (let walk = 0; walk < 120; walk++) {
      const index = turnsIndex();
      let ids: string[] = [];
      let chars: string[] = [];
      let next = 0;
      let busy = false;
      const owner = new Map<string, string>();
      const checkOf = (id: string) => owner.get(id);
      for (let step = 0; step < 100; step++) {
        const r = rnd(100);
        if (r < 55 || !ids.length) {
          const c = CHARS[rnd(CHARS.length)];
          const id = `i${next++}`;
          ids = [...ids, id];
          chars = [...chars, c];
          const sent = ids.filter((_, i) => chars[i] === 'U');
          if (c === 'x' && sent.length && rnd(4)) owner.set(id, sent[rnd(sent.length)]);
        } else if (r < 75) {
          chars = chars.slice();
          chars[rnd(chars.length)] = CHARS[rnd(CHARS.length)];
        } else if (r < 82) {
          const i = rnd(ids.length);
          ids = ids.filter((_, j) => j !== i);
          chars = chars.filter((_, j) => j !== i);
        } else if (r < 92) busy = !busy;
        else {
          const k = rnd(ids.length + 1);
          ids = ids.slice(0, k);
          chars = chars.slice(0, k);
        }
        const shape = chars.join('');
        expect(index(ids, shape, busy, checkOf)).toEqual(groupTurns(ids, shape, busy, checkOf));
      }
    }
  });

  it('keeps the turns before the running one as they were (the same objects) when a step joins', () => {
    const index = turnsIndex();
    const a = spec('U1 w2 t3 T4 U5 w6 t7 T8 U9 w10');
    const first = index(a.ids, a.shape, true);
    const b = spec('U1 w2 t3 T4 U5 w6 t7 T8 U9 w10 w11');
    const second = index(b.ids, b.shape, true);
    expect(second.groups[0]).toBe(first.groups[0]);
    expect(second.groups[1]).toBe(first.groups[1]);
    expect(second.groups[2]).not.toBe(first.groups[2]);
    expect((second.groups[2] as TurnGroup).ids).toEqual(['9', '10', '11']);
    // What it returned before is left as it was.
    expect((first.groups[2] as TurnGroup).ids).toEqual(['9', '10']);
    // A check attached to an earlier turn is a copy: the kept turn itself carries none.
    const c = spec('U1 w2 t3 T4 U5 w6 t7 T8 U9 w10 w11 x12');
    const third = index(c.ids, c.shape, true, (id) => (id === '12' ? '1' : undefined));
    expect((third.groups[0] as TurnGroup).checks).toEqual(['12']);
    expect((second.groups[0] as TurnGroup).checks).toBeUndefined();
  });
});

describe('lead-ins', () => {
  it('folds a lead-in with the steps it announces, and keeps reports and the answer in view', () => {
    const t = onlyTurn('U1 l2 w3 l4 w5 w6 t7 l8 w9 t10 T11');
    const s = t.segments[0];
    expect(flowOf(s.flow)).toBe('[2 3 4 5 6] 7 [8 9] 10');
    expect(s.work).toEqual(['2', '3', '4', '5', '6', '8', '9']);
    expect(s.steps).toBe(4);
    expect(s.answer).toBe('10');
    expect(s.narr).toEqual([]);
  });

  it('says a lead-in in view when no step follows it', () => {
    // The last words of a settled turn that said nothing else are its answer, whatever they look like.
    expect(onlyTurn('U1 w2 l3 T4').segments[0]).toMatchObject({ answer: '3', work: ['2'] });
    // Before more text it is one more report.
    expect(flowOf(onlyTurn('U1 l2 t3 w4 t5 T6').segments[0].flow)).toBe('2 3 [4] 5');
  });

  it('keeps the newest lead-in of a running turn folded while it waits for its step', () => {
    const s = onlyTurn('U1 w2 t3 w4 l5', true).segments[0];
    expect(flowOf(s.flow)).toBe('[2] 3 [4 5]');
    expect(s.answer).toBeNull();
    expect(s.narr).toEqual(['5']);
  });

  it('forgets the lead-ins once the agent has said something in view', () => {
    expect(onlyTurn('U1 l2 w3 t4 w5', true).segments[0].narr).toEqual([]);
  });

  it('answers a settled turn with its lead-in when nothing else was said', () => {
    // "Let me fix the typo." then the edit, and the turn ends: the announcement is the answer, in view.
    const s = onlyTurn('U1 l2 w3 T4').segments[0];
    expect(s).toMatchObject({ answer: '2', work: ['3'], steps: 1 });
    expect(flowOf(s.flow)).toBe('2 [3]');
    // The newest of several.
    expect(onlyTurn('U1 l2 w3 l4 w5 T6').segments[0]).toMatchObject({ answer: '4', work: ['2', '3', '5'] });
    // While it runs it stays folded with its step.
    expect(onlyTurn('U1 l2 w3', true).segments[0]).toMatchObject({ answer: null, work: ['2', '3'] });
    // A report said along the way stays the answer; the lead-ins after it fold.
    expect(onlyTurn('U1 t2 l3 w4 T5').segments[0]).toMatchObject({ answer: '2', work: ['3', '4'] });
    // A failed turn still answers with its error.
    expect(onlyTurn('U1 l2 w3 F4').segments[0].answer).toBeNull();
  });

  it('keeps the last words in view when a notice or a task list update follows them', () => {
    // "I'll leave the config as it is." and then "Your message is back in the queue": said in view,
    // as the last line under the report before it (the answer), not folded with the notice.
    const s = onlyTurn('U1 t2 w3 l4 n5 T6').segments[0];
    expect(s).toMatchObject({ answer: '2', tail: ['4'], notes: [] });
    expect(flowOf(s.flow)).toBe('2 [3] 4 [5]');
    // With nothing said before them they are the answer.
    expect(onlyTurn('U1 w2 l3 k4 T5').segments[0]).toMatchObject({ answer: '3', work: ['2', '4'] });
    expect(onlyTurn('U1 w2 l3 h4 n5 T6').segments[0].answer).toBe('3');
    // A notice and then a step: the lead-in announced that step.
    expect(onlyTurn('U1 t2 l3 n4 w5 T6').segments[0]).toMatchObject({ answer: '2', work: ['3', '4', '5'] });
    // Running, it waits: a step may still come.
    expect(onlyTurn('U1 t2 w3 l4 n5', true).segments[0].work).toEqual(['3', '4', '5']);
  });

  it('answers a settled turn from an earlier segment when the last one said nothing', () => {
    const t = onlyTurn('U1 w2 t3 S4 w5 w6 T7');
    expect(t.segments.map((s) => s.answer)).toEqual(['3', null]);
    // While it runs, the cut segment keeps its words as a report.
    expect(onlyTurn('U1 w2 t3 S4 w5 w6', true).segments.map((s) => s.answer)).toEqual([null, null]);
    // When the last segment answers, the earlier one stays a report.
    expect(onlyTurn('U1 w2 t3 S4 w5 t6 T7').segments.map((s) => s.answer)).toEqual([null, '6']);
  });

  it('always shows the reply to a steered message, even when it reads as a lead-in', () => {
    const t = onlyTurn('U1 w2 S3 l4 l5 w6 t7 T8');
    expect(t.segments[1]).toMatchObject({ reply: '4', answer: '7', work: ['5', '6'] });
    expect(flowOf(t.segments[1].flow)).toBe('4 [5 6] 7');
  });
});

describe("what Claude Code writes in the person's place (shared/synthetic.ts)", () => {
  const user = (text: string): TimelineItem => ({ id: 'x', ts: 0, type: 'user', text, state: 'sent' });
  const NOTE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Build" completed (exit code 0)</summary>\n</task-notification>';

  it('reads each kind as its own character', () => {
    expect(shapeOf(user(NOTE))).toBe('N');
    expect(shapeOf(user('<teammate-message teammate_id="r">hi</teammate-message>'))).toBe('N');
    expect(shapeOf(user('<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>'))).toBe('U');
    expect(shapeOf(user('<bash-input>ls</bash-input>'))).toBe('U');
    expect(shapeOf(user('<local-command-stdout>Set model to Opus 5.5</local-command-stdout>'))).toBe('n');
    expect(shapeOf(user('This session is being continued from a previous conversation that ran out of context.'))).toBe('n');
    expect(shapeOf(user('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'))).toBe('u');
    expect(shapeOf(user('<system-reminder>x</system-reminder>'))).toBe('u');
    expect(shapeOf(user('[Request interrupted by user]'))).toBe('u');
    // The person's own words with a reminder added are still their message.
    expect(shapeOf(user('Fix it\n<system-reminder>x</system-reminder>'))).toBe('U');
  });

  it('opens a turn with a notification, its line where the message would be', () => {
    const { groups } = turns('U1 t2 T3 N4 t5 T6');
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'turn']);
    const t = groups[1] as TurnGroup;
    expect(t.key).toBe('4');
    expect(t.segments[0]).toMatchObject({ lead: '4', answer: '5', steered: false });
    expect(t.state).toBe('done');
  });

  it('stacks notifications that come together in one turn, the answer under the last', () => {
    const { groups } = turns('U1 t2 T3 N4 N5 t6 T7');
    expect(groups).toHaveLength(2);
    const t = groups[1] as TurnGroup;
    expect(t.segments.map((s) => s.lead)).toEqual(['4', '5']);
    expect(t.segments[0].flow).toEqual([]);
    expect(t.segments[1].answer).toBe('6');
  });

  it('gives a notification taken while the agent works a segment of its own', () => {
    const t = onlyTurn('U1 w2 N3 w4 t5 T6');
    expect(t.segments.map((s) => s.lead)).toEqual(['1', '3']);
    expect(t.segments[0]).toMatchObject({ work: ['2'], answer: null });
    expect(t.segments[1]).toMatchObject({ work: ['4'], answer: '5' });
    const live = onlyTurn('U1 w2 N3 w4', true);
    expect(live.state).toBe('running');
    expect(flowOf(live.segments[1].flow)).toBe('[4]');
  });

  it('opens a turn of its own for a notification after an interruption', () => {
    const { groups } = turns('U1 w2 i3 N4 t5 T6');
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'turn']);
    expect((groups[0] as TurnGroup).state).toBe('interrupted');
    expect((groups[1] as TurnGroup).key).toBe('4');
  });

  it('shows a command with its output under it, and nothing for the caveat before it', () => {
    const { groups } = turns('U1 t2 T3 u4 U5 n6 T7');
    expect(groups.map((g) => g.key)).toEqual(['1', '5']);
    const t = groups[1] as TurnGroup;
    expect(t.segments[0]).toMatchObject({ lead: '5', errors: [], work: [], answer: null });
    expect(flowOf(t.segments[0].flow)).toBe('*6');
    // Without a turn record, the next message closes it.
    expect(turns('U1 t2 T3 u4 U5 n6 U7 t8 T9').groups.map((g) => g.key)).toEqual(['1', '5', '7']);
  });

  it('gives the work after a reminder that woke the agent a turn, and a reminder inside a turn is nothing', () => {
    const { groups } = turns('U1 t2 T3 u4 w5 t6 T7');
    expect(groups).toHaveLength(2);
    expect((groups[1] as TurnGroup).segments[0]).toMatchObject({ lead: '4', work: ['5'], answer: '6' });
    const t = onlyTurn('U1 w2 u3 t4 T5');
    expect(t.segments[0]).toMatchObject({ work: ['2'], answer: '4' });
    expect(t.ids).toContain('3');
    // Still starting: the turn shows (its live line), though nothing is in it yet.
    expect(turns('U1 t2 T3 u4', true).groups.map((g) => g.key)).toEqual(['1', '4']);
    // A reminder alone at the end, with the chat at rest: nothing at all.
    expect(turns('U1 t2 T3 u4').groups.map((g) => g.key)).toEqual(['1']);
  });

  it('keeps an output with no command before it as a line of its own', () => {
    expect(turns('U1 t2 T3 n4').groups.map((g) => g.kind)).toEqual(['turn', 'item']);
  });
});

describe('nothing the person must read folds away (review wave 9)', () => {
  it('keeps a report as the answer when a steered message is answered by a nod', () => {
    // "The migration requires index X." · "Commit it" · "Committed."
    const t = onlyTurn('U1 w2 t3 S4 l5 T6');
    expect(t.segments[0]).toMatchObject({ answer: '3', notes: [] });
    expect(t.segments[1]).toMatchObject({ lead: '4', reply: '5', answer: null, notes: [] });
    // Work after the steer, then the nod: the nod is still the reply under the message.
    const u = onlyTurn('U1 w2 t3 w4 S5 w6 l7 T8');
    expect(u.segments[0].answer).toBe('3');
    expect(u.segments[1]).toMatchObject({ reply: '7', answer: null });
    // A notification taken up mid-turn, then a nod: the nod is a quiet line, the report the answer.
    const n = onlyTurn('U1 w2 t3 N4 w5 l6 T7');
    expect(n.segments[0].answer).toBe('3');
    expect(n.segments[1]).toMatchObject({ answer: null, tail: ['6'] });
    // A steer answered by something of substance keeps its own answer.
    const s = onlyTurn('U1 w2 t3 S4 w5 t6 T7');
    expect(s.segments[0].answer).toBeNull();
    expect(s.segments[1].answer).toBe('6');
  });

  it('keeps the last report in view over a failure that came after a steer', () => {
    const t = onlyTurn('U1 w2 t3 S4 w5 e6 F7');
    expect(t.state).toBe('failed');
    expect(t.segments[0].last).toBe('3');
    expect(t.segments[0].notes).toEqual([]);
    expect(t.segments[1].errors).toEqual(['6']);
  });

  it('never takes a notice in view for the failure shown: the terminal error still shows', () => {
    // A model change, then the turn record with "Authentication expired".
    const t = onlyTurn('U1 n2 F3');
    expect(t.state).toBe('failed');
    expect(t.segments.some((s) => s.errors.length)).toBe(false);
    // An error notice is the failure shown.
    expect(onlyTurn('U1 w2 e3 F4').segments[0].errors).toEqual(['3']);
  });

  it('gives a rewind its own line, out of the turn it cut', () => {
    const base = { id: 'x', ts: 0 };
    expect(shapeOf({ ...base, type: 'notice', variant: 'rewind', text: 'Rewound the conversation', detail: 'Files could not be restored.' })).toBe('Z');
    const { groups } = turns('U1 w2 t3 S4 w5 Z6');
    expect(groups.map((g) => g.kind)).toEqual(['turn', 'item']);
    expect((groups[0] as TurnGroup).ids).not.toContain('6');
  });

  it('keeps a checkpoint the same checkpoint when the lead-in that opened it becomes the answer', () => {
    const live = onlyTurn('U1 w2 g3 l4 w5', true);
    const done = onlyTurn('U1 w2 g3 l4 w5 T6');
    const keyOf = (t: TurnGroup) => t.segments[0].flow.flatMap((c) => (c.kind === 'steps' && c.ids.includes('5') ? [c.key] : []))[0];
    expect(done.segments[0].answer).toBe('4');
    expect(keyOf(live)).toBe('5');
    expect(keyOf(done)).toBe(keyOf(live));
  });
});

describe('/copy copies what "Copy response" copies (review wave 9)', () => {
  const at = (id: string, ts: number) => ({ id, ts });
  const items: Record<string, TimelineItem> = {
    u1: { ...at('u1', 1), type: 'user', text: 'Add the migration' },
    w2: { ...at('w2', 2), type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit', status: 'done', detail: {} },
    t3: { ...at('t3', 3), type: 'text', text: 'The migration requires index X.', streaming: false },
    w4: { ...at('w4', 4), type: 'tool', name: 'Bash', kind: 'bash', title: 'git commit', status: 'done', detail: {} },
    t5: { ...at('t5', 5), type: 'text', text: 'Committed.', streaming: false },
    e6: { ...at('e6', 6), type: 'turn', durationMs: 5 },
  };
  const roots = Object.keys(items);

  it('copies the report, not the nod after it', () => {
    const { groups } = groupTurns(roots, roots.map((id) => shapeOf(items[id])).join(''), false);
    const turn = groups[0] as TurnGroup;
    expect(responseText(items, turn)).toBe('The migration requires index X.');
    expect(lastResponse(items, roots, false)).toBe(responseText(items, turn));
  });

  it('has nothing to copy before a turn has answered', () => {
    expect(lastResponse({ u1: items.u1 }, ['u1'], true)).toBeNull();
  });
});
