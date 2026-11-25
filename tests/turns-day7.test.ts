/**
 * Day 7 (win): a cut turn opened by Sable's own hidden message keeps its "Ended early" line
 * (window-F1), a turn the bridge ended without a record is closed in the grouping (window-F3), and
 * recorded work uses the provider’s duration (C12), plus work outside its coverage. Desktop and phone read
 * the same: the pure turn model with item lists, no agent.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { RESUME_UNDER_ANOTHER } from '@shared/synthetic';
import { earlyWords, groupTurns, shapeOf, turnSpan, type TurnGroup } from '@/features/timeline/turns';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('@desk/features/review/model', async () => await import('../src/features/review/model'));
vi.mock('@desk/lib/word-diff', async () => await import('../src/lib/word-diff'));
const MOBILE = '../mobile/src/lib/turns';
const mobile = (await import(/* @vite-ignore */ MOBILE)) as {
  groupTurns: typeof groupTurns;
  shapeOf: typeof shapeOf;
  turnSpan: typeof turnSpan;
};

let n = 0;
const mk = (p: Record<string, unknown>): TimelineItem => ({ id: `i${++n}`, ts: 1000 + n, ...p }) as unknown as TimelineItem;
const note = (ts: number, summary = 'Background task finished') =>
  mk({ type: 'user', state: 'sent', ts, text: `<task-notification><task-id>b${n}</task-id><status>completed</status><summary>${summary}</summary></task-notification>` });
const step = (ts: number, endedAt = ts + 1000) => mk({ type: 'tool', name: 'Read', kind: 'read', title: 'Read a.ts', status: 'done', detail: {}, ts, endedAt });
const text = (t: string, ts: number) => mk({ type: 'text', text: t, streaming: false, ts });
const record = (ts: number, durationMs: number) => mk({ type: 'turn', durationMs, ts });
const map = (list: TimelineItem[]) => Object.fromEntries(list.map((i) => [i.id, i])) as Record<string, TimelineItem>;

for (const phone of [false, true]) {
  const tag = phone ? 'phone' : 'desktop';
  const shape = (list: TimelineItem[]) => list.map((i) => (phone ? mobile.shapeOf(i) : shapeOf(i))).join('');
  const group = (list: TimelineItem[], busy = false) => (phone ? mobile.groupTurns : groupTurns)(list.map((i) => i.id), shape(list), busy).groups;
  const turns = (list: TimelineItem[], busy = false) => group(list, busy).filter((g): g is TurnGroup => g.kind === 'turn');
  const span = phone ? mobile.turnSpan : turnSpan;

  describe(`window-F1: a cut turn Sable's own message opened (${tag})`, () => {
    it('keeps its "Ended early" line when the process died before it wrote anything', () => {
      const carry = mk({ type: 'user', state: 'sent', text: RESUME_UNDER_ANOTHER, ts: 5000 });
      const cut = mk({ type: 'notice', variant: 'info', text: 'Ended early', detail: "The agent's process ended by itself while it worked.\n\nAPI Error: 500 overloaded", early: 'died', ts: 6000 });
      expect(shape([carry, cut])).toBe('uE');
      const ts = turns([carry, cut]);
      expect(ts).toHaveLength(1);
      expect(ts[0].early).toBe(cut.id);
      expect(ts[0].state).toBe('done');
      // A reminder with nothing after it is still left out.
      expect(turns([mk({ type: 'user', state: 'sent', text: RESUME_UNDER_ANOTHER })])).toHaveLength(0);
    });
  });

  describe(`window-F3: a notification turn the bridge ended without a record (${tag})`, () => {
    const t0 = 10_000_000;
    const list = () => {
      const n1 = note(t0);
      // An hour later the next notification wakes the model: a minute of work and its record.
      const n2 = note(t0 + 3_600_000, 'CI finished');
      const w = step(t0 + 3_600_000 + 5_000);
      const say = text('CI passed.', t0 + 3_600_000 + 50_000);
      const rec = record(t0 + 3_600_000 + 60_000, 58_000);
      return { n1, n2, w, say, rec, all: [n1, n2, w, say, rec] };
    };

    it('the next notification begins its own turn', () => {
      const { n1, n2, rec, all } = list();
      expect(shape(all).slice(0, 2)).toBe('NN');
      const ts = turns(all);
      expect(ts).toHaveLength(2);
      expect(ts[0].segments[0].lead).toBe(n1.id);
      expect(ts[0].ids).toEqual([n1.id]);
      expect(ts[1].segments[0].lead).toBe(n2.id);
      expect(ts[1].end).toBe(rec.id);
    });

    it('"Worked" never spans the hour between them', () => {
      const { all } = list();
      const ts = turns(all);
      expect(span(map(all), ts[1])).toBe(58_000);
    });

    it('a notification taken while the person\'s turn works still joins that turn', () => {
      const u = mk({ type: 'user', state: 'sent', text: 'run the suite', ts: t0 });
      const w = step(t0 + 1000);
      const n2 = note(t0 + 2000);
      const say = text('Both finished.', t0 + 3000);
      const ts = turns([u, w, n2, say], true);
      expect(ts).toHaveLength(1);
      expect(ts[0].segments.map((s) => s.lead)).toEqual([u.id, n2.id]);
      // And a notification turn that did work, still running, takes the next one in as before.
      const n1 = note(t0);
      const w1 = step(t0 + 1000);
      const n3 = note(t0 + 2000);
      const t2 = turns([n1, w1, n3], true);
      expect(t2).toHaveLength(1);
      expect(t2[0].segments.map((s) => s.lead)).toEqual([n1.id, n3.id]);
    });
  });

  describe(`C12: "Worked" respects the record’s coverage (${tag})`, () => {
    it('a steer that waited hours adds nothing', () => {
      const t0 = 50_000_000;
      // The person's turn ended; the steer sent four hours before, during it, was taken only now and
      // opens the next turn. It keeps the time it was sent.
      const u = mk({ type: 'user', state: 'sent', text: 'watch CI', ts: t0 - 4 * 3_600_000 - 1000 });
      const r0 = record(t0 - 1000, 4 * 3_600_000);
      const s = mk({ type: 'user', state: 'sent', steered: true, text: 'and the lint', ts: t0 - 4 * 3_600_000 });
      const w = step(t0 + 1000);
      const say = text('Both are green.', t0 + 400_000);
      const rec = record(t0 + 480_000, 470_000);
      const all = [u, r0, s, w, say, rec];
      const ts = turns(all);
      expect(ts[1].segments[0].lead).toBe(s.id);
      // The one-second read finished eight seconds before coverage began.
      expect(span(map(all), ts[1])).toBe(471_000);
    });

    it('adds only observed work outside the record’s wall-time coverage', () => {
      const t0 = 70_000_000;
      const u = mk({ type: 'user', state: 'sent', text: 'go', ts: t0 });
      const w = step(t0 + 1000);
      const rec = record(t0 + 125_000, 90_000);
      expect(span(map([u, w, rec]), turns([u, w, rec])[0])).toBe(91_000);
      const late = record(t0 + 60_000, 100_000);
      expect(span(map([u, w, late]), turns([u, w, late])[0])).toBe(100_000);
    });

    it('a record with no figure (OpenCode, old Codex history) falls back to the items', () => {
      const t0 = 90_000_000;
      const u = mk({ type: 'user', state: 'sent', text: 'go', ts: t0 });
      const w = step(t0 + 1000);
      const rec = record(t0 + 30_000, 0);
      expect(span(map([u, w, rec]), turns([u, w, rec])[0])).toBe(30_000);
      const bad = record(t0 + 30_000, Number.NaN);
      expect(span(map([u, w, bad]), turns([u, w, bad])[0])).toBe(30_000);
    });
  });
}

describe('window-F1: the process\'s own words under "Ended early"', () => {
  it('are what follows the bridge\'s reason, bounded', () => {
    expect(earlyWords("The agent's process ended by itself while it worked.\n\nAPI Error: 500 overloaded")).toBe('API Error: 500 overloaded');
    expect(earlyWords("The agent's process ended by itself while it worked.")).toBe('');
    expect(earlyWords(undefined)).toBe('');
    expect(earlyWords(`reason\n\n${'x'.repeat(3000)}`).length).toBe(2001);
  });
});
