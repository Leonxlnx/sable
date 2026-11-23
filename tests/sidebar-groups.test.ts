import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { buildGroups, createGroupsSelector } from '@/features/sidebar/groups';

const s = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'claude', cwd: 'D:/code/app', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: {}, ...over }) as SessionMeta;

const map = (...list: SessionMeta[]) => Object.fromEntries(list.map((x) => [x.id, x]));

describe('sidebar groups', () => {
  it('orders rows by recency and folders by their latest row', () => {
    const g = buildGroups(map(s('a', { updatedAt: 1 }), s('b', { updatedAt: 3 }), s('c', { cwd: 'D:/code/other', updatedAt: 2 })), []);
    expect(g.projects.map((p) => p.name)).toEqual(['app', 'other']);
    expect(g.projects[0].sessions.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('tells a folder that mixes agents from one that mixes accounts', () => {
    const g = buildGroups(map(s('a'), s('b'), s('c', { provider: 'codex' })), []);
    expect(g.projects[0].mix).toBe('agent');
    const one = buildGroups(map(s('a'), s('b', { accountId: 'work' })), []);
    expect(one.projects[0].mix).toBe('account');
    expect(buildGroups(map(s('a'), s('b')), []).projects[0].mix).toBeUndefined();
  });

  it('puts the most pressing state on a folder', () => {
    const g = buildGroups(map(s('a', { unread: true }), s('b', { status: 'running' }), s('c', { status: 'awaiting' })), []);
    expect(g.projects[0].attention).toBe('awaiting');
  });

  it('a folder whose chat has only a background command running is working, as the row says (day 6)', () => {
    const g = buildGroups(map(s('a', { status: 'error', commands: 1 }), s('b', { unread: true })), []);
    expect(g.projects[0].attention).toBe('working');
  });

  it('keeps folders in their manual order while chats inside go newest first', () => {
    const sessions = map(s('a', { updatedAt: 9 }), s('b', { updatedAt: 3 }), s('c', { cwd: 'D:/code/other', updatedAt: 1 }));
    const projects = [
      { path: 'D:/code/app', name: 'app', lastOpened: 0, order: 1 },
      { path: 'D:/code/other', name: 'other', lastOpened: 0, order: 0 },
      { path: 'D:/code/zeta', name: 'zeta', lastOpened: 0, order: 2, pinned: true },
    ];
    const manual = buildGroups(sessions, projects);
    expect(manual.projects.map((p) => p.name)).toEqual(['zeta', 'other', 'app']);
    expect(manual.projects[2].sessions.map((x) => x.id)).toEqual(['a', 'b']);
    expect(buildGroups(sessions, projects, 'recent').projects.map((p) => p.name)).toEqual(['zeta', 'app', 'other']);
    expect(buildGroups(sessions, projects, 'name').projects.map((p) => p.name)).toEqual(['zeta', 'app', 'other']);
  });

  it('leaves a removed folder out with its chats, pinned chats stay pinned', () => {
    const sessions = map(s('a'), s('b', { pinned: true }), s('c', { cwd: 'D:/code/other' }));
    const g = buildGroups(sessions, [{ path: 'D:\\code\\app', name: 'app', lastOpened: 0, hidden: true }]);
    expect(g.projects.map((p) => p.name)).toEqual(['other']);
    expect(g.pinned.map((x) => x.id)).toEqual(['b']);
  });

  it('shows a folder by the name it was given in Sable', () => {
    const g = buildGroups(map(s('a')), [{ path: 'D:/code/app', name: 'Client work', lastOpened: 0 }]);
    expect(g.projects.map((p) => [p.name, p.path])).toEqual([['Client work', 'D:/code/app']]);
    const select = createGroupsSelector();
    const sessions = map(s('a'));
    const before = select({ sessions, projects: [{ path: 'D:/code/app', name: 'app', lastOpened: 0 }] });
    const after = select({ sessions, projects: [{ path: 'D:/code/app', name: 'Client work', lastOpened: 0 }] });
    expect(after).not.toBe(before);
    expect(after.projects[0].name).toBe('Client work');
  });

  it('keeps the same groups while only what rows show changes', () => {
    const select = createGroupsSelector();
    const projects: never[] = [];
    const first = select({ sessions: map(s('a', { updatedAt: 1 }), s('b', { updatedAt: 2 })), projects });
    const touched = select({ sessions: map(s('a', { updatedAt: 1, title: 'renamed', activity: 'Reading' }), s('b', { updatedAt: 2 })), projects });
    expect(touched).toBe(first);
    const moved = select({ sessions: map(s('a', { updatedAt: 3 }), s('b', { updatedAt: 2 })), projects });
    expect(moved).not.toBe(first);
    expect(moved.projects[0].sessions.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
