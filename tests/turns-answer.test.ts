import { describe, expect, it, vi } from 'vitest';
import type { TextItem, TimelineItem, ToolItem, UserItem } from '@shared/protocol';
import { RESUME_UNDER_ANOTHER, STAND_IN_ANSWER } from '@shared/synthetic';
import { groupTurns, responseText, shapeOf, turnSpan, type TurnGroup } from '@/features/timeline/turns';
import { chatMarkdown } from '../server/core/chat-markdown';
import { buildBrief } from '../server/core/check';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
const MOBILE = '../mobile/src/lib/turns';
const phone = await import(/* @vite-ignore */ MOBILE) as { groupTurns: typeof groupTurns; shapeOf: typeof shapeOf; turnSpan: typeof turnSpan };
const NOTES = '../mobile/src/lib/notes';
const { lastNote } = await import(/* @vite-ignore */ NOTES) as { lastNote: (items: TimelineItem[]) => string | null };

const prompt: UserItem = { type: 'user', id: 'person', ts: 1000, text: 'Please address both points.' };
const words = (id: string, text: string, streaming = false): TextItem => ({ type: 'text', id, ts: 2000, text, streaming });
const reply = words('reply', 'Understood, you are right on both points: …');
const steps: ToolItem[] = ['one', 'two', 'three', 'four'].map((id, i) => ({
  type: 'tool', id, ts: 3000 + i * 1000, name: 'Read', kind: 'read', title: 'Read file', detail: {}, status: 'done',
}));
const answer = { ...words('answer', 'The build stands, eight of ten smoke tests are green…'), ts: 157_000 };
const end: TimelineItem = { type: 'turn', id: 'end', ts: 158_000, durationMs: 157_000 };
const history = [prompt, reply, ...steps, answer, end];
const items = Object.fromEntries(history.map(it => [it.id, it]));

for (const [name, model] of Object.entries({ desktop: { groupTurns, shapeOf, turnSpan }, phone })) {
  const turn = (rows: TimelineItem[], busy = false) => model.groupTurns(rows.map(i => i.id), rows.map(model.shapeOf).join(''), busy).groups[0] as TurnGroup;
  const segment = (rows: TimelineItem[], busy = false) => turn(rows, busy).segments[0];
  describe(`opening reply on ${name}`, () => {
    it('keeps the owner’s reply under the message through four steps and settlement', () => {
      const first = segment([prompt, { ...reply, streaming: true }], true);
      expect(first).toMatchObject({ key: 'person', answer: 'reply', reply: null, flow: [{ kind: 'text', id: 'reply' }] });
      const finished = turn(history);
      expect(model.turnSpan(items, finished)).toBe(157_000);
      for (const s of [segment(history.slice(0, -2), true), segment(history.slice(0, -1), true), finished.segments[0]]) {
        expect(s).toMatchObject({ key: 'person', lead: 'person', reply: 'reply', notes: [], steps: 4 });
        expect(s.flow[0]).toEqual({ kind: 'text', id: 'reply' });
        expect(s.flow[1]).toEqual({ kind: 'steps', key: 'one', ids: steps.map(x => x.id), count: 4 });
      }
      expect(finished.segments[0].flow[0]).toEqual(first.flow[0]);
      expect(finished.segments[0].answer).toBe('answer');
      expect(finished.segments[0].flow[2]).toEqual({ kind: 'text', id: 'answer' });
    });

    it('uses one row for a sole answer, with work before or after it', () => {
      for (const rows of [[reply], [...steps, reply], [reply, ...steps]]) {
        const s = segment([prompt, ...rows, end]);
        expect(s).toMatchObject({ reply: null, answer: 'reply', notes: [] });
        expect(s.flow.filter(c => c.kind === 'text')).toEqual([{ kind: 'text', id: 'reply' }]);
      }
    });

    it('keeps a work-first note folded and a text-first reply visible even without work', () => {
      expect(segment([prompt, ...steps, reply, answer, end])).toMatchObject({ reply: null, answer: 'answer', notes: ['reply'] });
      expect(segment([prompt, reply, answer, end])).toMatchObject({ reply: 'reply', answer: 'answer', notes: [] });
    });

    it.each(['Let me run the tests.', 'Now the CSS.'])('shows the opening lead-in “%s” once and lets the step name itself', text => {
      const lead = words('lead', text);
      for (const s of [segment([prompt, lead, ...steps], true), segment([prompt, lead, ...steps, answer, end])]) {
        expect(s).toMatchObject({ reply: 'lead', narr: [], notes: [], work: steps.map(i => i.id) });
        expect(s.flow[0]).toEqual({ kind: 'text', id: 'lead' });
      }
    });

    it('skips empty words and stand-ins when finding the first visible act', () => {
      for (const text of ['  ', STAND_IN_ANSWER]) for (const streaming of [false, true]) {
        const blank = words('blank', text, streaming);
        expect(segment([prompt, blank, reply, ...steps, answer, end])).toMatchObject({ reply: 'reply' });
        expect(segment([prompt, blank, ...steps, answer, end])).toMatchObject({ reply: null, answer: 'answer' });
      }
    });

    it('pairs a wrapped human message with the reply, skipping an intervening hidden reminder', () => {
      const wrapped = { ...prompt, text: `${prompt.text}\n\n<system-reminder>Answer first.</system-reminder>` };
      const hidden = { ...prompt, id: 'hidden', text: RESUME_UNDER_ANOTHER };
      expect(segment([wrapped, hidden, reply, ...steps, answer, end])).toMatchObject({ lead: 'person', reply: 'reply', answer: 'answer' });
    });

    it('keeps the reply once above a failure', () => {
      const failure: TimelineItem = { type: 'notice', variant: 'error', text: 'Build failed.', id: 'error', ts: 8000 };
      const s = segment([prompt, reply, ...steps, failure, { ...end, error: 'Build failed.' }]);
      expect(s).toMatchObject({ reply: 'reply', answer: null, last: 'reply', notes: [], errors: ['error'] });
      expect(s.flow.filter(c => c.kind === 'text')).toEqual([{ kind: 'text', id: 'reply' }]);
    });

    it('assigns no reply to a wake, a notification, or a hidden reminder', () => {
      const agentWork = [reply, ...steps, answer, end];
      expect(segment([{ ...prompt, until: {} }, ...agentWork])).toMatchObject({ reply: null, answer: 'answer', notes: ['reply'] });
      expect(segment(agentWork)).toMatchObject({ lead: null, reply: null, notes: ['reply'] });
      for (const text of [RESUME_UNDER_ANOTHER, '<task-notification><summary>CI finished.</summary></task-notification>', '<command-name>/model</command-name>']) {
        expect(segment([{ ...prompt, text }, ...agentWork])).toMatchObject({ reply: null, notes: ['reply'] });
        // A card the person sent themselves (steered, or marked as authored) is theirs whatever it says:
        // quoting one of Sable's own notes never hides a message (review 0235, finding 20).
        expect(segment([{ ...prompt, text, steered: true }, ...agentWork])).toMatchObject({ reply: 'reply' });
        expect(segment([{ ...prompt, text, authored: true }, ...agentWork])).toMatchObject({ reply: 'reply' });
      }
    });
  });
}

it('copies, checks and notifies with the closing words and exports both texts in order', () => {
  const t = groupTurns(history.map(i => i.id), history.map(shapeOf).join(''), false).groups[0] as TurnGroup;
  expect(responseText(items, t)).toBe(answer.text);
  expect(buildBrief(history, prompt.id, '/demo')?.text).toContain(`<answer>\n${answer.text}\n</answer>`);
  expect(lastNote(history)).toBe(answer.text);
  const md = chatMarkdown({ provider: 'demo', cwd: '/demo', title: 'Both points', createdAt: 1000 }, history);
  expect(md).toContain(reply.text);
  expect(md.indexOf(answer.text)).toBeGreaterThan(md.indexOf(reply.text));
});
