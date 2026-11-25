/**
 * Day 7 (win): "wenn ich steere oft wird keine antwort angezeigt". A message steered into a running
 * turn and the reply to it stand as a pair: the first text after the message, right under it, never
 * folded, while the turn runs and once it has gathered. Every way the pair could come apart, on the
 * pure turn model of the desktop and the phone (shape strings: shape char + id).
 */
import { describe, expect, it, vi } from 'vitest';
import { DELEGATE_REPORT, delegateReport } from '@shared/synthetic';
import type { UserItem } from '@shared/protocol';
import { groupTurns, shapeOf, type Segment, type TurnGroup } from '@/features/timeline/turns';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('@desk/features/review/model', async () => await import('../src/features/review/model'));
vi.mock('@desk/lib/word-diff', async () => await import('../src/lib/word-diff'));
const MOBILE = '../mobile/src/lib/turns';
const mobile = (await import(/* @vite-ignore */ MOBILE)) as { groupTurns: typeof groupTurns; shapeOf: typeof shapeOf };

it('hides the delegate report as a user card on desktop and phone, including a cut phone page', () => {
  const text = DELEGATE_REPORT + '\n\n' + delegateReport('Review', 'done', 'Result '.repeat(4000));
  const item: UserItem = { type: 'user', state: 'sent', id: 'report', ts: 10, text };
  expect(shapeOf(item)).toBe('u');
  expect(mobile.shapeOf({ ...item, text: text.slice(0, 900) })).toBe('u');
});

function spec(s: string) {
  const parts = s.split(/\s+/).filter(Boolean);
  return { ids: parts.map((p) => p.slice(1)), shape: parts.map((p) => p[0]).join('') };
}

for (const phone of [false, true]) {
  const tag = phone ? 'phone' : 'desktop';
  const layout = (s: string, busy: boolean) => {
    const { ids, shape } = spec(s);
    return (phone ? mobile.groupTurns : groupTurns)(ids, shape, busy);
  };
  const turnsOf = (s: string, busy: boolean) => layout(s, busy).groups.filter((g): g is TurnGroup => g.kind === 'turn');
  const segOf = (s: string, busy: boolean, lead: string): Segment => {
    for (const t of turnsOf(s, busy)) for (const sg of t.segments) if (sg.lead === lead) return sg;
    throw new Error(`no segment led by ${lead} in ${s}`);
  };
  /**
   * The reply `reply` stands right under steer `steer`: the first piece of its segment's flow, and
   * in view (the reply, the answer or a quiet last line), never a note that folds.
   */
  const pairs = (s: string, busy: boolean, steer: string, reply: string) => {
    const sg = segOf(s, busy, steer);
    expect(sg.steered, `${s}: ${steer} is a steered segment`).toBe(true);
    expect(sg.flow[0], `${s}: the reply stands first under ${steer}`).toEqual({ kind: 'text', id: reply });
    expect(sg.notes, `${s}: the reply never folds`).not.toContain(reply);
    expect([sg.reply, sg.answer, ...sg.tail], `${s}: the reply is in view`).toContain(reply);
  };

  describe(`a steered message and its reply (${tag})`, () => {
    it('a reply that reads like a lead-in or a nod is still the reply', () => {
      pairs('U1 w2 t3 S4 l5 w6 t7 T8', false, '4', '5');
      pairs('U1 w2 t3 S4 l5 w6 t7', true, '4', '5');
      pairs('U1 w2 t3 S4 l5 w6', true, '4', '5');
    });

    it('a reply that is the turn\'s last words is the reply and the answer, once', () => {
      pairs('U1 w2 S3 t4 T5', false, '3', '4');
      pairs('U1 w2 S3 t4', true, '3', '4');
      pairs('U1 w2 t3 S4 t5 T6', false, '4', '5');
      // A nod after a report: the report stays the answer, the nod the reply under its message.
      pairs('U1 w2 t3 S4 l5 T6', false, '4', '5');
      const t = turnsOf('U1 w2 t3 S4 l5 T6', false)[0];
      const answers = t.segments.map((s) => s.answer).filter(Boolean);
      expect(answers).toEqual(['3']);
    });

    it('two steers in a row: the reply stands under the second, right under the first', () => {
      pairs('U1 w2 S3 S4 t5 w6 t7 T8', false, '4', '5');
      pairs('U1 w2 S3 S4 t5 w6', true, '4', '5');
      // Each answered in turn: each its own.
      pairs('U1 w2 S3 t4 S5 t6 w7 t8 T9', false, '3', '4');
      pairs('U1 w2 S3 t4 S5 t6 w7 t8 T9', false, '5', '6');
    });

    it('a steer at the turn\'s very start, or after its last text', () => {
      pairs('U1 S2 t3 w4 t5 T6', false, '2', '3');
      pairs('U1 w2 t3 S4 w5 t6 w7 t8 T9', false, '4', '6');
      pairs('U1 w2 t3 S4 w5 t6', true, '4', '6');
    });

    it('a steer taken as the turn ended opens the next turn and is answered there', () => {
      pairs('U1 w2 t3 T4 S5 t6 T7', false, '5', '6');
      pairs('U1 w2 t3 T4 S5 w6 t7 w8 t9 T10', false, '5', '7');
    });

    it('a reply that streams while the checkpoint before it closes', () => {
      // Still being written: shaped like a lead-in until it is whole.
      pairs('U1 w2 S3 l4', true, '3', '4');
      pairs('U1 w2 w3 S4 l5 w6', true, '4', '5');
      pairs('U1 w2 w3 S4 t5 w6 l7', true, '4', '5');
    });

    it('a steer in a wake turn with no message at its head', () => {
      pairs('U1 t2 T3 w4 S5 t6 w7 t8 T9', false, '5', '6');
      pairs('U1 t2 T3 w4 S5 t6 w7', true, '5', '6');
    });

    it('a turn that failed or was interrupted after the reply keeps it', () => {
      pairs('U1 w2 S3 t4 w5 e6 F7', false, '3', '4');
      pairs('U1 w2 S3 t4 w5 i6', false, '3', '4');
      pairs('U1 w2 S3 t4 w5 i6 U7 t8 T9', false, '3', '4');
    });

    it('a notification taken between the steer and its reply does not take the reply', () => {
      pairs('U1 w2 S3 N4 t5 w6 t7 T8', false, '3', '5');
      pairs('U1 w2 S3 N4 t5 w6', true, '3', '5');
    });
  });
}
