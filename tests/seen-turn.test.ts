/** "This turn" in the Changes tab: the files the chat's last turn edited, sub-agents' edits included. */
import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@shared/protocol';
import { turnPaths } from '../src/features/rail/changes-seen';

const user = (id: string): TimelineItem => ({ id, type: 'user', text: 'go', at: 0 }) as unknown as TimelineItem;
const edit = (id: string, path: string, status = 'done'): TimelineItem =>
  ({ id, type: 'tool', kind: 'edit', status, name: 'Edit', title: path, result: { diff: [{ path, status: 'modified', additions: 1, deletions: 0, hunks: [] }] } }) as unknown as TimelineItem;
const agent = (id: string): TimelineItem => ({ id, type: 'tool', kind: 'agent', status: 'done', name: 'Task', title: 'x' }) as unknown as TimelineItem;

describe('turnPaths', () => {
  it('takes only the last turn, relative to the folder, with sub-agents and without failed edits', () => {
    const items: Record<string, TimelineItem> = {
      u1: user('u1'),
      e1: edit('e1', 'C:\\work\\relay\\src\\old.js'),
      u2: user('u2'),
      e2: edit('e2', 'C:\\work\\relay\\src\\session.js'),
      e3: edit('e3', 'C:\\work\\relay\\src\\failed.js', 'error'),
      a1: agent('a1'),
      c1: edit('c1', 'C:\\work\\relay\\docs\\notes.md'),
    };
    const out = turnPaths(items, ['u1', 'e1', 'u2', 'e2', 'e3', 'a1'], { a1: ['c1'] }, 'C:\\work\\relay');
    expect([...out].sort()).toEqual(['docs/notes.md', 'src/session.js']);
  });

  it('is empty before any edit', () => {
    expect(turnPaths({ u1: user('u1') }, ['u1'], {}, '/w').size).toBe(0);
  });
});
