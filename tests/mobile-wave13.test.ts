/**
 * Phone 2.13 (night of 23/24 Nov): what the notifications say and when they offer keys, the live
 * notification while chats work, the summary's lines, and the page's edges read from the native side.
 * - A done notification carries the agent's last note, markdown taken off, cut at a sentence or a
 *   word (never mid-word), a heading or a code block skipped for the prose under it.
 * - Allow once and Deny ride on a permission's notification only when the notification shows all of
 *   it: never for a request the phone got shortened, a change (diff, files, content), a scope beyond
 *   its detail, an "always" alone, several prompts at once, or lines too long to show.
 * - The live notification lists every chat at work (its own turn, or sub-agents and commands it left
 *   working), with a clock that starts when the phone first saw the work and starts over for the next.
 * - The summary names the chats with a notification up, newest first.
 */
import { describe, expect, it } from 'vitest';
import type { PermissionRequest, SessionMeta, TimelineItem } from '@shared/protocol';
import { cutClean, lastNote, liveOf, liveWords, noteAsk, plainLine, turnSteps, waitingNote } from '../mobile/src/lib/notes';
import { NotePoster, type ChatNote } from '../mobile/src/lib/note-post';
import { NoteBook } from '../mobile/src/lib/note-book';

const text = (id: string, t: string, extra: Partial<TimelineItem> = {}) => ({ id, type: 'text', text: t, streaming: false, ts: 1, ...extra }) as unknown as TimelineItem;
const user = (id: string) => ({ id, type: 'user', text: 'go', ts: 1 }) as unknown as TimelineItem;
const tool = (id: string) => ({ id, type: 'tool', name: 'Bash', kind: 'bash', title: 'x', status: 'done', detail: {}, ts: 1 }) as unknown as TimelineItem;

const perm = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r1',
  sessionId: 's1',
  toolName: 'Bash',
  kind: 'bash',
  title: 'npm test',
  description: 'Run the test suite',
  detail: { command: 'npm test', cwd: 'D:\\work\\relay' },
  options: [
    { id: 'allow', label: 'Allow once', tone: 'allow' },
    { id: 'always', label: 'Always allow', tone: 'always' },
    { id: 'deny', label: 'Deny', tone: 'deny' },
  ],
  createdAt: 1,
  ...over,
});

const meta = (id: string, over: Partial<SessionMeta> = {}) => ({ id, title: `Chat ${id}`, status: 'idle', provider: 'demo', cwd: '/x', createdAt: 0, updatedAt: 0, usage: {}, ...over }) as unknown as SessionMeta;

describe('the last note', () => {
  it('is plain words: markdown off, links by their words, code by its text', () => {
    expect(plainLine('**Done.** See [the docs](https://x.y) and `npm test`.')).toBe('Done. See the docs and npm test.');
    expect(plainLine('- one\n- two')).toBe('one two');
  });

  it('cuts at a sentence when the first ones fit, else at a word with an ellipsis', () => {
    const t = 'Expiry now lives in the store. All 25 tests pass. One behaviour change: expired sessions are evicted on lookup, so the count on the admin page will drop.';
    expect(cutClean(t, 60)).toBe('Expiry now lives in the store. All 25 tests pass.');
    const words = cutClean('a'.repeat(5) + ' ' + 'bbbbbbbbbb '.repeat(20), 40);
    expect(words.endsWith('…')).toBe(true);
    expect(words.length).toBeLessThanOrEqual(40);
    expect(words.slice(0, -1)).toMatch(/b$/);
  });

  it('takes the newest text after the person spoke, the prose under a heading, nothing when the agent said nothing since', () => {
    expect(lastNote([user('u'), text('a', 'First.'), tool('t'), text('b', '# Report\n\nAll 300 steps are done.')])).toBe('All 300 steps are done.');
    expect(lastNote([text('a', 'Old answer.'), user('u'), tool('t')])).toBeNull();
    // A sub-agent's words are not the chat's note.
    expect(lastNote([user('u'), text('a', 'Mine.'), text('b', 'Sub-agent words.', { parentId: 'x' } as Partial<TimelineItem>)])).toBe('Mine.');
  });
});

describe('Allow once and Deny on a notification', () => {
  it('ride on a command the notification shows whole, with its folder', () => {
    const ask = noteAsk(perm());
    expect(ask).toEqual({ requestId: 'r1', allow: 'allow', deny: 'deny', detail: 'npm test\nin D:\\work\\relay\nRun the test suite' });
  });

  it('never for a request the phone got shortened, a change, files, content or a wider scope', () => {
    expect(noteAsk({ ...perm(), incomplete: true } as PermissionRequest)).toBeNull();
    expect(noteAsk(perm({ diff: [{ path: 'a.ts', additions: 1, deletions: 0, hunks: [] }] as unknown as PermissionRequest['diff'] }))).toBeNull();
    expect(noteAsk(perm({ detail: { files: [{ path: '/a/b.pdf', name: 'b.pdf' }] } }))).toBeNull();
    expect(noteAsk(perm({ detail: { path: '/a/b.ts', content: 'x' } as PermissionRequest['detail'] }))).toBeNull();
    expect(noteAsk(perm({ scope: { hosts: ['*'] } }))).toBeNull();
  });

  it('never without a plain allow once and a deny, nor for lines too long to show', () => {
    expect(noteAsk(perm({ options: [{ id: 'always', label: 'Always', tone: 'always' }, { id: 'deny', label: 'Deny', tone: 'deny' }] }))).toBeNull();
    expect(noteAsk(perm({ options: [{ id: 'allow', label: 'Allow', tone: 'allow' }] }))).toBeNull();
    expect(noteAsk(perm({ detail: { command: 'x'.repeat(201) } }))).toBeNull();
    expect(noteAsk(perm({ detail: { command: 'echo a\necho b' } }))).toBeNull();
  });

  it('a waiting chat says what it needs; keys only when one permission waits alone', () => {
    const one = waitingNote('s1', { permissions: [perm()], questions: [] });
    expect(one.text).toBe('npm test');
    expect(one.ask?.requestId).toBe('r1');
    const two = waitingNote('s1', { permissions: [perm(), perm({ id: 'r2' })], questions: [] });
    expect(two.text).toBe('npm test (2 waiting)');
    expect(two.ask).toBeUndefined();
    const q = waitingNote('s1', { permissions: [], questions: [{ id: 'q', sessionId: 's1', createdAt: 1, questions: [{ question: 'Which **store**?', header: '', options: [], multiSelect: false }] }] as never });
    expect(q).toEqual({ text: 'Which store?' });
    expect(waitingNote('s9', { permissions: [perm()], questions: [] })).toEqual({ text: 'Waiting for you' });
  });
});

describe('the live notification', () => {
  it('lists every chat at work, sub-agents and commands too, with a clock from when it was first seen', () => {
    const list = [meta('a', { status: 'running', activity: 'Editing `session.ts`' }), meta('b', { status: 'idle', background: 2 }), meta('c', { status: 'idle' }), meta('d', { status: 'awaiting' })];
    const live = liveOf(list, [], 1000, (id) => (id === 'a' ? 12 : undefined));
    // 2.18: the line names the kind of step only, never a file, a command or a search term (lib/note-live.ts).
    expect(live.chats.map((c) => [c.id, c.line, c.since, c.steps])).toEqual([
      ['a', 'Editing', 1000, 12],
      ['b', '2 sub-agents working', 1000, undefined],
    ]);
    expect(live.waiting).toBe(1);
    // Later: a keeps its clock; b stopped and is forgotten, so its next work starts its own.
    const later = liveOf([meta('a', { status: 'running' }), meta('b', { status: 'idle' })], live.chats, 5000);
    expect(later.chats.map((c) => [c.id, c.since])).toEqual([['a', 1000]]);
    expect(liveOf([meta('b', { status: 'idle', commands: 1 })], later.chats, 9000).chats[0]).toMatchObject({ id: 'b', since: 9000, line: '1 command running' });
  });

  it('says one chat by its name and several by their count; nothing when nothing works', () => {
    expect(liveWords({ chats: [{ id: 'a', title: 'Refactor', line: 'Editing session.ts', since: 1, steps: 3 }], waiting: 1 })).toEqual({ title: 'Refactor', text: 'Editing session.ts', sub: '3 steps · 1 waiting' });
    expect(liveWords({ chats: [{ id: 'a', title: 'A', line: 'Working', since: 1 }, { id: 'b', title: 'B', line: '1 command running', since: 2 }], waiting: 0 })).toEqual({ title: '2 chats working', text: 'A: Working\nB: 1 command running' });
    expect(liveWords({ chats: [], waiting: 2 })).toBeNull();
    expect(liveOf([meta('x', { status: 'idle', archived: true, background: 3 })], [], 1).chats).toEqual([]);
  });

  it('counts the steps of the newest turn only', () => {
    expect(turnSteps([user('u1'), tool('a'), tool('b'), user('u2'), tool('c'), text('t', 'x'), tool('d')])).toBe(2);
    expect(turnSteps([])).toBe(0);
  });
  it('keeps earlier steps through queued and taken steers until an actual turn boundary', () => {
    const start = user('prompt');
    const roots = [start, tool('a'), tool('b')];
    for (const mark of [{ state: 'queued' }, { state: 'queued', steered: true }, { state: 'sent', steered: true }] as const) {
      const steer = { ...user('follow-up'), ...mark } as TimelineItem;
      expect(turnSteps([...roots, steer])).toBe(2);
      expect(turnSteps([...roots, steer, tool('c')])).toBe(3);
    }
    const end = { type: 'turn', id: 'end', ts: 2 } as TimelineItem;
    expect(turnSteps([...roots, end, tool('next')])).toBe(1);
  });
});

describe('the summary of the chats with a notification up', () => {
  it('names them newest first, and lets go of a chat once opened', async () => {
    const posts: { note: ChatNote; chats: number; summary: string[] }[] = [];
    const summaries: string[][] = [];
    let up: number[] = [];
    let store: string | null = null;
    const idFor = (s: string) => (s === 'a' ? 10 : s === 'b' ? 11 : 12);
    const book = new NoteBook({ get: () => store, set: (v) => (store = v) }, idFor);
    const poster = new NotePoster(
      {
        allowed: async () => true,
        prepare: async () => {},
        delivered: async () => up,
        summary: async (_chats, lines) => void summaries.push(lines),
        cancel: async (ids) => void (up = up.filter((x) => !ids.includes(x))),
        post: async (note, chats, summary) => {
          if (note.body === 'Suppressed') throw new Error('Channel disabled');
          posts.push({ note, chats, summary });
          up = [...new Set([...up, note.id, ...(chats > 1 ? [1] : [])])];
        },
        clearAll: async () => void (up = []),
      },
      book,
      idFor,
    );
    await poster.notify('A', 'Done', 'a', 'done');
    await poster.notify('A', 'Suppressed', 'a', 'waiting');
    await poster.notify('B', 'npm test', 'b', 'waiting', { requestId: 'r', allow: 'allow', deny: 'deny', detail: 'npm test', deviceId: 'paired' });
    expect(posts[1].chats).toBe(2);
    expect(posts[1].summary).toEqual(['B: npm test', 'A: Done']);
    expect(posts[1].note.ask?.requestId).toBe('r');
    await poster.clearOne('b', async () => false);
    expect(book.list()).toContain('b');
    await poster.clearOne('b');
    expect(summaries).toEqual([['A: Done']]);
    await poster.notify('C', 'Done', 'c', 'done');
    expect(posts[2].summary).toEqual(['C: Done', 'A: Done']);
    await poster.notify('A', 'Later', 'a', 'done');
    expect(posts[3].note.lines).toEqual(['Later', 'Done']);
  });
});
