import { describe, expect, it, vi } from 'vitest';
import type { TextItem, TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import { groupTurns, shapeOf, turnsIndex, type TurnGroup, type TurnLayout } from '@/features/timeline/turns';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
const MOBILE = '../mobile/src/lib/turns';
const phone = (await import(/* @vite-ignore */ MOBILE)) as {
  groupTurns: typeof groupTurns;
  shapeOf: typeof shapeOf;
  stabilize: (layout: TurnLayout, cache: Map<string, unknown>) => TurnLayout;
};

const prompt: UserItem = { id: 'prompt', ts: 1, type: 'user', text: 'Check the migration.' };
const steer: UserItem = { id: 'steer', ts: 3, type: 'user', text: 'Which table?', steered: true, state: 'queued' };
const taken: UserItem = { ...steer, state: 'sent' };
const step = (id: string, ts: number): ToolItem => ({ id, ts, type: 'tool', name: 'Read', title: 'Read file', kind: 'read', status: 'running', detail: {} });
const words = (id: string, ts: number, text: string, streaming = false): TextItem => ({ id, ts, type: 'text', text, streaming });
const end: TimelineItem = { id: 'end', ts: 12, type: 'turn', durationMs: 11 };

for (const platform of ['desktop', 'phone']) {
  // Follow successive root lists through the same index as the desktop TurnList.
  function reader() {
    const group = platform === 'desktop' ? turnsIndex() : phone.groupTurns;
    const shape = platform === 'desktop' ? shapeOf : phone.shapeOf;
    const cache = new Map<string, unknown>();
    return (items: TimelineItem[], busy = true) => {
      const ids = items.map((it) => it.id);
      const chars = items.map(shape).join('');
      const raw = group(ids, chars, busy);
      const layout = platform === 'phone' ? phone.stabilize(raw, cache) : raw;
      expect(layout).toEqual(raw);
      if (platform === 'desktop') expect(layout).toEqual(groupTurns(ids, chars, busy));
      const turn = layout.groups.at(-1) as TurnGroup;
      expect(turn.kind).toBe('turn');
      return { turn, queued: layout.queued };
    };
  }

  describe(`a steer from send through take (${platform})`, () => {
    it('keeps pre-take checkpoints above the card and puts the first post-take text under it', () => {
      const read = reader();
      const scan = step('scan', 2);
      const base = [prompt, scan];
      const before = read(base).turn;
      const queued = { ...prompt, id: 'later', state: 'queued' } as const;
      const sent = [...base, queued, steer];
      const checkWaiting = (items: TimelineItem[]) => {
        const { turn, queued: shelf } = read(items);
        expect(turn.segments.map((s) => s.lead)).toEqual(['prompt']);
        expect(turn.segments[0].reply).toBeNull();
        expect(turn.waiting).toEqual(['steer']);
        expect(shelf).toEqual(['later']);
        return turn.segments[0];
      };
      expect(checkWaiting(sent)).toEqual(before.segments[0]);
      const scanned = { ...scan, status: 'done', endedAt: 4 } as const;
      const waiting = [prompt, scanned, queued, steer];
      expect(checkWaiting(waiting)).toEqual(before.segments[0]);
      const note = words('note', 4, '', true);
      expect(checkWaiting([...waiting, note]).work).toEqual(['scan', 'note']);
      const streamed = { ...note, text: 'The migration passed.' };
      expect(checkWaiting([...waiting, streamed]).answer).toBe('note');
      const finished = { ...streamed, streaming: false };
      expect(checkWaiting([...waiting, finished]).answer).toBe('note');
      const verify = step('verify', 5);
      expect(checkWaiting([...waiting, finished, verify]).notes).toEqual(['note']);
      const lead = words('lead', 6, 'Let me check the index.');
      const afterSend = [finished, verify, lead];
      const prefix = checkWaiting([...waiting, ...afterSend]);
      const waitingIds = read([...waiting, ...afterSend]).turn.ids;
      expect(waitingIds).toEqual(['prompt', 'scan', 'note', 'verify', 'lead', 'steer']);
      expect(prefix.flow).toEqual([
        { kind: 'steps', key: 'scan', ids: ['scan'], count: 1 },
        { kind: 'text', id: 'note' },
        { kind: 'steps', key: 'verify', ids: ['verify', 'lead'], count: 1 },
      ]);

      // The desktop holds the moving removal. A reader that sees the two events
      // separately must also keep the same content throughout the intervening list.
      const moved = [prompt, scanned, queued, ...afterSend];
      if (platform === 'phone') expect(read(moved).turn.segments).toEqual([prefix]);
      const roots = [...moved, taken];
      const arrived = read(roots);
      expect(arrived.queued).toEqual(['later']);
      expect(arrived.turn.waiting ?? []).toEqual([]);
      expect(arrived.turn.liveSegment).toBe(0);
      expect(arrived.turn.ids).toEqual(waitingIds);
      expect(arrived.turn.segments[0]).toEqual(prefix);
      expect(arrived.turn.segments[1]).toMatchObject({ lead: 'steer', steered: true, flow: [], reply: null });

      const work = step('lookup', 7);
      const working = read([...roots, work]).turn;
      expect(working.liveSegment ?? working.segments.length - 1).toBe(1);
      expect(working.segments[0].flow).toEqual(prefix.flow);
      expect(working.segments[1].work).toEqual(['lookup']);
      const direct = { kind: 'text', id: 'reply' };
      const emptyReply = words('reply', 8, '', true);
      expect(read([...roots, work, emptyReply]).turn.segments[1].flow[0]).toEqual(direct);
      const reply = { ...emptyReply, text: 'The users table.' };
      const answering = read([...roots, work, reply]).turn.segments[1];
      expect(answering.flow[0]).toEqual(direct);
      expect(answering.answer).toBe('reply');
      const doneReply = { ...reply, streaming: false };
      expect(read([...roots, work, doneReply]).turn.segments[1].answer).toBe('reply');
      const report = words('report', 11, 'All indexes passed.');
      const finalRoots = [...roots, work, doneReply, report];
      const reported = read(finalRoots).turn;
      const history = [...finalRoots, end];
      const settled = read(history, false).turn;
      expect(settled.state).toBe('done');
      expect(settled.segments[0].notes).toEqual(['note', 'lead']);
      expect(reader()(history, false).turn).toEqual(settled);
      for (const turn of [reported, settled]) {
        expect(turn.segments[1]).toMatchObject({ lead: 'steer', reply: 'reply', answer: 'report', notes: [] });
        expect(turn.segments[1].flow[0]).toEqual(direct);
      }
    });

    it.each([false, true])('preserves the previous reply on a patch-only take (error in view: %s)', (error) => {
      const read = reader();
      const first = { ...taken, id: 'first', ts: 2 };
      const previous: TimelineItem[] = [prompt, first, words('first-reply', 3, 'The schema is current.')];
      if (error) previous.push({ type: 'notice', id: 'error', ts: 4, variant: 'error', text: 'Read failed.' });
      const before = read([...previous, steer]).turn;
      const after = read([...previous, taken]).turn;
      expect(before.segments.map((s) => s.lead)).toEqual(['prompt', 'first']);
      expect(after.segments.slice(0, -1)).toEqual(before.segments);
      expect(after.segments.at(-1)).toMatchObject({ lead: 'steer', flow: [] });
    });

    it('keeps waiting steers in order across a turn end and the next turn', () => {
      const read = reader();
      const second = { ...steer, id: 'second' };
      const later: UserItem = { ...prompt, id: 'later', state: 'queued' };
      const roots = [prompt, later, steer, second];
      expect(read(roots).turn.waiting).toEqual(['steer', 'second']);
      const closed = read([...roots, end], false);
      expect(closed.turn.waiting).toBeUndefined();
      expect(closed.queued).toEqual(['steer', 'second', 'later']);
      const next = { ...prompt, id: 'next' };
      expect(read([...roots, end, next]).turn.waiting).toEqual(['steer', 'second']);
      const stepHere = step('next-step', 14);
      const working = read([...roots, end, next, stepHere]).turn;
      expect(working.waiting).toEqual(['steer', 'second']);
      const firstTaken = read([prompt, later, second, end, next, stepHere, taken]).turn;
      expect(firstTaken.waiting).toEqual(['second']);
      expect(firstTaken.segments[0]).toEqual(working.segments[0]);
      const bothTaken = read([prompt, later, end, next, stepHere, taken, { ...second, state: 'sent' }]).turn;
      expect(bothTaken.segments.map((s) => s.lead)).toEqual(['next', 'steer', 'second']);
      expect(bothTaken.liveSegment).toBe(0);
      expect(bothTaken.waiting).toBeUndefined();
    });
  });
}
