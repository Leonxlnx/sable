import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeItem, PermissionRequest, SessionMeta } from '@shared/protocol';
import { limitAction } from '../mobile/src/lib/chat-rules';
import { liveOf, livePayload, noteAnswer, noteAsk, workEnded, type NoteAction } from '../mobile/src/lib/notes';

const meta = (id: string, fields: Partial<SessionMeta> = {}) => ({ id, title: id, status: 'idle', ...fields }) as SessionMeta;
const settings = { conn: 'open', fresh: true, listAt: 10, notify: true };
const payload = (sessions: SessionMeta[], overrides: Partial<typeof settings> = {}) =>
  livePayload({ ...settings, ...overrides }, liveOf(sessions, [], 100, () => 3));

describe('the payload for Notes.live', () => {
  it('sends the chat, clock and steps for its turn and counts agents and commands independently', () => {
    expect(payload([meta('A', { status: 'running', activity: 'Editing' })])).toEqual({ chats: 1, waiting: 0, title: 'A', chat: 'A', text: 'Editing', since: 100, sub: '3 steps' });
    expect(payload([meta('B', { background: 2, commands: 1 }), meta('C', { archived: true, commands: 4 })])).toEqual({ chats: 1, waiting: 0, title: 'B', chat: 'B', text: '2 sub-agents, 1 command', since: 100 });
    expect(payload([meta('B', { status: 'awaiting', background: 1 }), meta('C', { status: 'starting' })])).toEqual({ chats: 2, waiting: 1, title: '2 chats working', text: 'B: 1 sub-agent working\nC: Starting', since: 100, sub: '1 waiting' });
    expect(payload([meta('B', { status: 'awaiting' })])).toEqual({ chats: 0, waiting: 1 });
    expect(payload([meta('C')])).toBeNull();
  });

  it('suppresses stale, disconnected and disabled work, including a reconnect awaiting its first list', () => {
    for (const off of [{ notify: false }, { fresh: false }, { listAt: undefined }, { conn: 'unpaired' }, { conn: 'denied' }, { conn: 'offline' }, { conn: 'connecting' }]) {
      expect(payload([meta('A', { status: 'running' })], off)).toBeNull();
    }
  });

  it('finishes only when the final command or sub-agent ends', () => {
    const running = meta('A', { status: 'running' });
    for (const tail of [meta('A', { commands: 1 }), meta('A', { background: 1 })]) {
      expect(workEnded(running, tail)).toBe(false);
      expect(workEnded(tail, meta('A'))).toBe(true);
    }
    expect(workEnded(meta('A'), meta('A'))).toBe(false);
  });
});

const request = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'r', sessionId: 's', toolName: 'Bash', kind: 'bash', title: 'Test', detail: { command: 'npm test' },
  options: [{ id: 'yes', label: 'Allow once', tone: 'allow' }, { id: 'no', label: 'Deny', tone: 'deny' }], createdAt: 1, ...overrides,
});

describe('an answer from the shade', () => {
  const action: NoteAction = { sessionId: 's', requestId: 'r', optionId: 'yes', verb: 'allow', noteId: 23, detail: 'Test\nnpm test', token: 'one-post', deviceId: 'phone' };
  const answer = (requests: PermissionRequest[], key = action, deviceId = 'phone') => noteAnswer(key, { permissions: requests, questions: [] }, deviceId);

  it('binds both keys to this pairing, chat, request, option and the detail displayed', () => {
    expect(answer([request()])).toEqual({ sessionId: 's', requestId: 'r', optionId: 'yes' });
    expect(answer([request()], { ...action, verb: 'deny', optionId: 'no' })).toEqual({ sessionId: 's', requestId: 'r', optionId: 'no' });
    expect(answer([], action)).toBeNull();
    expect(answer([request()], action, 'other-phone')).toBeNull();
    expect(answer([request({ id: 'new' })])).toBeNull();
    expect(answer([request({ sessionId: 'other' })])).toBeNull();
    expect(answer([request()], { ...action, verb: 'deny' })).toBeNull();
    expect(answer([request({ detail: { command: 'another command' } })])).toBeNull();
    expect(answer([request(), request({ id: 'second' })])).toBeNull();
  });

  it('shows the reason and declines actions for unseen edits, whole-turn grants and a decline that stops the turn', () => {
    expect(noteAsk(request({ reason: 'Additional network access' }))?.detail).toContain('Additional network access');
    expect(noteAsk(request({ detail: { newText: 'replacement' } }))).toBeNull();
    const [allow, deny] = request().options;
    expect(noteAsk(request({ options: [{ ...allow, label: 'Allow for this turn' }, deny] }))).toBeNull();
    expect(noteAsk(request({ options: [allow, { ...deny, label: 'Decline and stop' }] }))).toBeNull();
  });
});

it('builds each limit action from the clicked notice, including the earlier of two refusals', () => {
  const card = (id: string) => ({ type: 'notice', id, limit: { resetsAt: 200 } }) as NoticeItem;
  for (const id of ['older', 'newer']) {
    expect(limitAction('s', card(id), { id: 'other', label: 'Other' }, false, 100)).toEqual({ method: 'session.switchAccount', label: 'Continue with Other', params: { sessionId: 's', accountId: 'other', retry: true, refusalId: id } });
    expect(limitAction('s', card(id), undefined, false, 100)).toEqual({ method: 'spare.atReset', label: 'Continue at reset', params: { sessionId: 's', refusalId: id } });
  }
  expect(limitAction('s', card('old'), undefined, false, 200)).toBeNull();
  expect(limitAction('s', card('old'), undefined, true, 100)).toBeNull();
});

afterEach(() => vi.unstubAllGlobals());
it('replays insets delivered before JS loads and replaces all four edges and the keyboard lift on resize and close', async () => {
  const css = new Map<string, string>();
  const attrs = new Set<string>();
  vi.stubGlobal('document', { documentElement: {
    style: { setProperty: (key: string, value: string) => css.set(key, value) },
    setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name),
  } });
  vi.stubGlobal('window', { __sableInsetsState: [[24, 0, 16, 0], 200, 250] });
  const { keyboardLift } = await import('../mobile/src/lib/keyboard');
  expect(keyboardLift()).toBe(200);
  expect(css.get('--kb-ms')).toBe('0ms');
  window.__sableInsets!([0, 28, 10, 12], 80, 100);
  window.__sableInsets!([0, 28, 10, 12], 0, 180);
  expect([...css.entries()]).toEqual([['--sat', '0px'], ['--sar', '28px'], ['--sab', '10px'], ['--sal', '12px'], ['--kb-ms', '180ms'], ['--kb', '0px']]);
  expect(attrs.has('data-kb')).toBe(false);
});
