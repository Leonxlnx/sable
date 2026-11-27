/**
 * Phone 2.22: text shared into Sable from another app goes into a chat's draft as one paragraph
 * after what the draft holds (never sent), offered to the chats of the Recent list (pinned first,
 * the newest after, none archived); and the home-screen widget counts the chats at work by the shared
 * rule and those waiting on the person.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@shared/protocol';
import { SHARED_MAX, sharedText, shareTargets, withShared } from '../mobile/src/lib/share-in';
import { widgetCounts } from '../mobile/src/lib/widget';

const meta = (id: string, p: Partial<SessionMeta> = {}) => ({ id, title: id, provider: 'claude', status: 'idle', updatedAt: 0, cwd: 'D:/x', ...p }) as SessionMeta;

describe('a share', () => {
  it('leads with its subject when the text does not hold it (a page title, then its link)', () => {
    expect(sharedText('https://example.com/post', 'A post')).toBe('A post\nhttps://example.com/post');
    expect(sharedText('A post https://example.com/post', 'A post')).toBe('A post https://example.com/post');
    expect(sharedText('  just words  ')).toBe('just words');
  });

  it('is bounded', () => {
    expect(sharedText('x'.repeat(SHARED_MAX + 50)).length).toBe(SHARED_MAX);
  });

  it("goes after the draft's own words, a blank line between, or alone", () => {
    expect(withShared('', 'link')).toBe('link');
    expect(withShared('Look at this  \n', 'link')).toBe('Look at this\n\nlink');
  });

  it('is offered to the Recent list: pinned first, then the newest; never archived or the Customize chat', () => {
    const sessions = {
      a: meta('a', { updatedAt: 3 }),
      b: meta('b', { updatedAt: 9 }),
      c: meta('c', { updatedAt: 1, pinned: true }),
      d: meta('d', { updatedAt: 99, archived: true }),
      e: meta('e', { updatedAt: 50, custom: true } as Partial<SessionMeta>),
    };
    expect(shareTargets(sessions).map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(shareTargets(sessions, 2).map((s) => s.id)).toEqual(['c', 'b']);
  });
});

describe('the widget', () => {
  it('counts chats at work by the shared rule (a tracked job too) and those waiting, none archived', () => {
    const c = widgetCounts({
      run: meta('run', { status: 'running' }),
      job: meta('job', { tracked: 1 }),
      wait: meta('wait', { status: 'awaiting' }),
      serve: meta('serve', { serving: 1 }),
      old: meta('old', { status: 'running', archived: true }),
      rest: meta('rest'),
    });
    expect(c).toEqual({ working: 2, waiting: 1 });
  });
});
