import { describe, expect, it, vi } from 'vitest';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import * as desk from '@/features/timeline/turns';
import { shortDuration } from '@/features/timeline/util';
import { chatMarkdown } from '../server/core/chat-markdown';

vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
const MOBILE = '../mobile/src/lib/turns';
const phone = await import(/* @vite-ignore */ MOBILE) as typeof desk;

let serial = 0;
// Omitted stamps/figures in stored histories are possible even when today's protocol requires them.
const row = (type: TimelineItem['type'], ts: number | undefined, fields: object = {}) =>
  ({ type, ts, id: String(++serial), ...fields }) as TimelineItem;
const user = (ts: number, steered = false) => row('user', ts, { text: 'Go', state: 'sent', steered });
const step = (ts?: number, endedAt?: number, extra?: Partial<ToolItem>) =>
  row('tool', ts, { kind: 'read', name: 'Read', title: 'Read file', status: 'done', detail: {}, endedAt, ...extra });
const thought = (ts: number, endedAt: number) => row('thinking', ts, { text: 'Thinking', endedAt });
const record = (ts?: number, durationMs?: number) => row('turn', ts, { durationMs });
const stop = (ts: number) => row('notice', ts, { variant: 'interrupted', text: 'Stopped' });
const byId = (rows: TimelineItem[]) => Object.fromEntries(rows.map(r => [r.id, r]));
const clockStep = (close: number) => [user(100_000), step(101_000, 106_000), record(close, 0)];

it.each([90_000, 86_400_000])('exports five measured seconds when the closing clock steps to %i', close => {
  const md = chatMarkdown({ title: 'Timing', provider: 'demo', cwd: '', createdAt: 1 }, clockStep(close));
  expect(md.split('\n').filter(s => s.startsWith('**Steps**'))).toEqual(['**Steps** (1, 5 s)']);
});

for (const [platform, model] of Object.entries({ desktop: desk, phone })) {
  const group = (rows: TimelineItem[], busy = false) =>
    model.groupTurns(rows.map(r => r.id), rows.map(model.shapeOf).join(''), busy).groups[0] as desk.TurnGroup;
  const span = (rows: TimelineItem[]) => model.turnSpan(byId(rows), group(rows));
  describe(platform, () => {
    it.each([90_000, 86_400_000])('keeps the measured tool interval when the closing clock steps to %i', close => {
      const rows = clockStep(close);
      expect(span(rows)).toBe(5000);
      expect(model.runSpan(byId(rows), { ids: [rows[1].id] }, rows[0].id, rows[2].id, rows[2].id)).toBe(5000);
    });

    it('keeps the eight steps before Stop and adds the recorded reply', () => {
      // Seconds from 07:13:00. The supplied shape leaves the first thought unstamped.
      const sec = (s: number) => s * 1000;
      const rows = [
        user(sec(14)), thought(sec(18), sec(21)), step(sec(21), sec(24)), step(sec(24), sec(26)),
        thought(sec(26), sec(28)), thought(sec(28), sec(30)), step(sec(30), sec(117)), step(sec(33), sec(46)),
        thought(sec(118), sec(124)), step(sec(124), sec(135)), step(sec(135), sec(150)),
        thought(sec(151), sec(170)), thought(sec(172), sec(220)), step(sec(223), sec(239)),
        step(sec(227) + 900, sec(1813), { kind: 'agent', status: 'error' }),
        row('notice', sec(1813), { variant: 'info', text: 'Stopped agent' }), stop(sec(1813)),
        user(sec(1814), true), thought(sec(1814), sec(1822)), row('text', sec(1823), { text: 'I hear you.' }),
        record(sec(1823), 9976),
      ];
      const turn = group(rows);
      expect(turn.segments.reduce((n, s) => n + s.steps, 0)).toBe(8);
      const agent = rows.find(r => r.type === 'tool' && r.kind === 'agent')!;
      const child = step(sec(230), sec(1800), { parentId: agent.id });
      expect(model.turnSpan(byId([...rows, child]), turn)).toBe(1_804_976);
      expect(shortDuration(span(rows)!)).toBe('30m 5s');
    });

    it('counts a covering record once across a normal steer', () => {
      const work = [user(1000), step(2000, 6000)];
      expect(span([...work, record(10_000, 9000)])).toBe(9000);
      expect(span([...work, user(3000, true), step(6100, 8000), record(10_000, 9000)])).toBe(9000);
    });

    it('preserves the Stop and missing-duration fallbacks', () => {
      const work = [user(1000), step(2000, 4000)];
      expect(span([...work, stop(5000)])).toBe(4000);
      expect(span([...work, record(8000)])).toBe(7000);
      expect(span([...work, stop(5000), user(2500, true), step(60_000, 62_000), record(63_000)])).toBe(7000);
    });

    it('keeps disjoint records and counts overlapping record time once', () => {
      // Grouping usually closes at a record. Exercise the span contract for a view retaining both.
      for (const [start, expected] of [[8000, 4000], [3500, 3500]]) {
        const rows = [user(1000), step(2100, 3000), record(4000, 2000), user(start, true),
          step(start + 100, start + 500), record(start + 2000, 2000)];
        const turn = { ...group(rows), ids: rows.map(r => r.id), end: rows.at(-1)!.id };
        expect(model.turnSpan(byId(rows), turn)).toBe(expected);
      }
    });

    it('uses the last cut or steer when a record has no timestamp', () => {
      const work = [user(1000), step(2000, 5000), stop(5500)];
      expect(span([...work, user(3000, true), step(70_000, 72_000), record(undefined, 4000)])).toBe(7500);
      expect(span([...work, step(70_000, 72_000), record(undefined, 4000)])).toBe(7500);
      // A step straddling the take overlaps the undated record anchored there.
      expect(span([user(1000), step(2000, 12_000), user(8000, true), record(undefined, 5000)])).toBe(11_000);
    });

    it('excludes idle gaps at a carried limit and clips a step crossing record coverage', () => {
      const limit = row('notice', 5000, { variant: 'error', text: 'Limit reached', limit: { continuedWith: 'Next' } });
      expect(span([user(1000), step(2000, 4000), limit, step(60_000, 65_000), record(70_000, 6000)])).toBe(13_000);
    });

    it('uses only known signs of an unfinished step across restart', () => {
      const restart = row('notice', 6000, { variant: 'info', text: 'Ended early', early: 'restart' });
      expect(span([user(1000), step(4000, 6000), step(6000), restart, user(600_000)])).toBe(5000);
      expect(span([step(4000), record(60_000, 3000)])).toBe(3000);
      expect(span([step(undefined, 50_000), record(60_000, 3000)])).toBe(3000);
    });

    it('clips a checkpoint closed by a note to the work and record it spans', () => {
      const [lead, work, note, rec] = [user(1000), step(2000, 5000), row('text', 100_000, { text: 'Ready.' }), record(101_000, 10_000)];
      const items = byId([lead, work, note, rec]);
      // The first three seconds of work and nine seconds of the record precede the note.
      expect(model.runSpan(items, { ids: [work.id] }, lead.id, note.id, rec.id)).toBe(12_000);
      expect(span([lead, work, note, rec])).toBe(13_000);
    });

    it('measures checkpoints on either side of a waiting steer', () => {
      const rows = [user(1000), step(2000, 5000), stop(5000), user(2500, true), step(60_000, 68_000)];
      const items = byId(rows);
      const live = group(rows, true);
      expect(live.state).toBe('running');
      expect(live.liveSegment ?? live.segments.length - 1).toBe(1);
      expect(model.runSpan(items, { ids: [rows[1].id] }, rows[0].id, rows[3].id)).toBe(3000);
      const note = row('text', 69_000, { text: 'Fixed it.' });
      expect(model.runSpan(byId([...rows, note]), { ids: [rows[4].id] }, rows[3].id, note.id)).toBe(9000);
    });
  });
}
