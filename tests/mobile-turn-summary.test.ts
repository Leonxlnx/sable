import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../shared/protocol';
import { ANSWER_MAX, FILES_MAX, turnFiles, turnSummary } from '../mobile/src/lib/turn-summary';

const edit = (id: string, path: string, add: number, del: number, extra: Partial<TimelineItem> = {}) =>
  ({ id, ts: 0, type: 'tool', name: 'Edit', kind: 'edit', title: 'Edit', status: 'done', result: { diff: [{ path, status: 'modified', additions: add, deletions: del, hunks: [] }] }, ...extra }) as unknown as TimelineItem;

describe('phone 2.18: a finished turn shared as a message', () => {
  it('gathers each changed file once with its lines, sub-agents included, checks and unfinished edits left out', () => {
    const items: Record<string, TimelineItem> = {
      a: edit('a', 'C:/p/src/a.ts', 3, 1),
      b: edit('b', 'C:/p/src/a.ts', 2, 0),
      agent: { id: 'agent', ts: 0, type: 'tool', name: 'Task', kind: 'agent', title: 'Task', status: 'done' } as unknown as TimelineItem,
      k: edit('k', 'C:/p/src/b.ts', 5, 5),
      run: edit('run', 'C:/p/src/c.ts', 9, 9, { status: 'running' } as Partial<TimelineItem>),
      chk: edit('chk', 'C:/p/src/d.ts', 1, 1, { check: true } as unknown as Partial<TimelineItem>),
    };
    expect(turnFiles(items, { agent: ['k'] }, ['a', 'b', 'agent', 'run', 'chk'])).toEqual([
      { path: 'C:/p/src/a.ts', add: 5, del: 1 },
      { path: 'C:/p/src/b.ts', add: 5, del: 5 },
    ]);
  });

  it('says the chat, the message, the work, the files inside the folder and the answer, each bounded', () => {
    const back = (p: string) => p.replace(/\//g, String.fromCharCode(92));
    const files = Array.from({ length: FILES_MAX + 3 }, (_, i) => ({ path: back(`C:/p/src/f${i}.ts`), add: 2, del: 1 }));
    const text = turnSummary({ title: 'Session refactor', agent: 'Claude Code', prompt: 'refactor the session module', worked: '3m 12s', steps: 12, files, answer: 'Done. '.repeat(2000), cwd: back('C:/p') });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Session refactor');
    expect(lines[2]).toBe('refactor the session module');
    expect(lines[4]).toBe(`Claude Code · worked 3m 12s · 12 steps · ${FILES_MAX + 3} files changed (+${2 * (FILES_MAX + 3)} −${FILES_MAX + 3})`);
    expect(lines[5]).toBe('  src/f0.ts  +2 −1');
    expect(text).toContain('  and 3 more files');
    expect(text).not.toContain('f10.ts');
    expect(text.length).toBeLessThan(ANSWER_MAX + 1200);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('—');
  });

  it('a turn with no files and no time still reads as one line of work', () => {
    expect(turnSummary({ title: 'Hi', agent: 'Demo', steps: 0, files: [], answer: 'Hello.' })).toBe('Hi\n\nDemo · worked\n\nHello.');
  });
});
