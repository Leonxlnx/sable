/**
 * "BITTE EIN INDIKATOR wenn du noch arbeitest auch subagents" (night of 23/24 Nov): a chat whose
 * agent, sub-agents, workflows, background commands or /until check still work reads as working
 * wherever it is named (its row, a closed folder's header, the session header, the palette, the
 * quick switcher), all by one rule (`statusTone` in sidebar/status.ts); never as waiting or failed.
 */
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../shared/protocol';
import { isWorking, statusLabel, statusTone } from '../src/features/sidebar/status';
import { buildGroups, createGroupsSelector } from '../src/features/sidebar/groups';

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'demo', cwd: 'D:/work/app', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 1, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...extra }) as SessionMeta;

describe('a chat at work', () => {
  it('is working while its turn runs or starts, and says what it does', () => {
    expect(statusTone(meta('a', { status: 'running', activity: 'Editing app.ts' }))).toBe('working');
    expect(statusLabel(meta('a', { status: 'running', activity: 'Editing app.ts' }))).toBe('Editing app.ts');
    expect(statusTone(meta('a', { status: 'starting' }))).toBe('working');
    expect(statusLabel(meta('a', { status: 'starting' }))).toBe('Working');
  });

  it('is working once its turn is over while sub-agents or commands still work, whatever the turn ended in', () => {
    expect(statusTone(meta('a', { background: 3 }))).toBe('working');
    expect(statusLabel(meta('a', { background: 3 }))).toBe('3 sub-agents working');
    expect(statusTone(meta('a', { status: 'error', lastError: 'boom', background: 1 }))).toBe('working');
    expect(statusLabel(meta('a', { status: 'error', lastError: 'boom', background: 1 }))).toBe('1 sub-agent working');
    expect(statusTone(meta('a', { commands: 2, unread: true }))).toBe('working');
  });

  it('names the background work beside its own turn', () => {
    expect(statusLabel(meta('a', { status: 'running', activity: 'Reading', background: 2 }))).toBe('Reading · 2 sub-agents');
  });

  it('is working while an /until loop runs its check between turns', () => {
    const until = { phase: 'checking' } as SessionMeta['until'];
    expect(statusTone(meta('a', { until }))).toBe('working');
    expect(statusLabel(meta('a', { until }))).toBe('Running the check');
  });

  it('waiting on the person outranks the work, and rest is rest', () => {
    expect(statusTone(meta('a', { status: 'awaiting', background: 2 }))).toBe('awaiting');
    expect(statusTone(meta('a', { status: 'error' }))).toBe('error');
    expect(statusTone(meta('a', { unread: true }))).toBe('unread');
    expect(statusTone(meta('a'))).toBe('idle');
    expect(isWorking(meta('a'))).toBe(false);
    expect(statusLabel(meta('a'))).toBeNull();
  });
});

describe('a closed folder says its chats work', () => {
  const folder = (sessions: SessionMeta[]) => {
    const g = buildGroups(Object.fromEntries(sessions.map((s) => [s.id, s])), [{ path: 'D:/work/app', name: 'app', lastOpened: 1 } as never]);
    const top = g.top.find((e) => e.kind === 'folder');
    return top?.kind === 'folder' ? top.folder.attention : undefined;
  };

  it('by the rows\' own rule', () => {
    expect(folder([meta('a'), meta('b', { background: 1 })])).toBe('working');
    expect(folder([meta('a', { status: 'error', commands: 1 })])).toBe('working');
    expect(folder([meta('a', { until: { phase: 'checking' } as SessionMeta['until'] })])).toBe('working');
    expect(folder([meta('a', { background: 1 }), meta('b', { status: 'awaiting' })])).toBe('awaiting');
    expect(folder([meta('a'), meta('b')])).toBeUndefined();
    // A chat waiting for its reset after a limit (Spare) is no error to look at.
    expect(folder([meta('a', { status: 'error', spare: { at: 1 } as SessionMeta['spare'] })])).toBeUndefined();
  });

  it('changes the list\'s structure when work starts or ends, so the header redraws', () => {
    const select = createGroupsSelector();
    const projects = [{ path: 'D:/work/app', name: 'app', lastOpened: 1 } as never];
    const one = select({ sessions: { a: meta('a') }, projects });
    const two = select({ sessions: { a: meta('a', { background: 2 }) }, projects });
    expect(two).not.toBe(one);
    const three = select({ sessions: { a: meta('a', { background: 3 }) }, projects });
    // Still working: nothing the list shows changed.
    expect(three).toBe(two);
  });
});
