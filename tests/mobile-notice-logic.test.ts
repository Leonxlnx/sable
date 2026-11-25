import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoticeItem, PermissionRequest, SessionMeta } from '@shared/protocol';
import { limitAction, limitProvider, worksNow } from '../mobile/src/lib/chat-rules';
import { phoneEvent } from '../server/services/phone';
import { liveOf, livePayload, noteAnswer, noteAsk, workEnded, type NoteAction } from '../mobile/src/lib/notes';

const meta = (id: string, fields: Partial<SessionMeta> = {}) => ({ id, title: id, status: 'idle', ...fields }) as SessionMeta;
const settings = { conn: 'open', fresh: true, listAt: 10, notify: true };
const payload = (sessions: SessionMeta[], overrides: Partial<typeof settings> = {}) =>
  livePayload({ ...settings, ...overrides }, liveOf(sessions, [], 100, () => 3));

describe('the payload for Notes.live', () => {
  it('sends the chat, clock and steps for its turn and counts agents and commands independently', () => {
    // 2.18: each chat at work also gets a card of its own (lib/note-live.ts `liveCard`, tests/mobile-note-live.test.ts).
    const card = (id: string, line: string, extra: object = {}) => expect.objectContaining({ id, title: id, line, since: 100, ...extra });
    expect(payload([meta('A', { status: 'running', activity: 'Editing' })])).toEqual({ chats: 1, waiting: 0, title: 'A', chat: 'A', text: 'Editing', since: 100, sub: '3 steps', cards: [card('A', 'Editing', { steps: 3, meta: '3 steps', keys: ['open', 'stop'] })] });
    expect(payload([meta('B', { background: 2, commands: 1 }), meta('C', { archived: true, commands: 4 })])).toEqual({ chats: 1, waiting: 0, title: 'B', chat: 'B', text: '2 sub-agents, 1 command', since: 100, cards: [card('B', '2 sub-agents, 1 command', { keys: ['open'] })] });
    expect(payload([meta('B', { status: 'awaiting', background: 1 }), meta('C', { status: 'starting' })])).toEqual({ chats: 2, waiting: 1, title: '2 chats working', text: 'B: 1 sub-agent working\nC: Starting', since: 100, sub: '1 waiting', cards: [card('B', '1 sub-agent working', { others: '1 other chat working · 1 waiting' }), card('C', 'Starting')] });
    expect(payload([meta('B', { status: 'awaiting' })])).toEqual({ chats: 0, waiting: 1 });
    expect(payload([meta('C')])).toBeNull();
  });

  it('finishes work while a local server stays on and drops the ongoing notification', () => {
    const serving = meta('A', { serving: 1 });
    const mixed = { ...serving, commands: 1 };
    expect(worksNow(serving)).toBe(false);
    expect(worksNow(mixed)).toBe(true);
    expect(workEnded(mixed, serving)).toBe(true);
    expect(payload([serving])).toBeNull();
    expect(payload([mixed])?.text).toBe('1 command running');
    expect(phoneEvent({ type: 'session.updated', id: 'A', patch: { servingAddress: undefined, servingSince: undefined } })).toMatchObject({ patch: { servingSince: null, servingAddress: null } });
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

it('looks up both account IDs under the refusal provider after an agent switch', () => {
  for (const limit of [{ next: 'default' }, { continuedWith: 'default' }]) {
    expect(limitProvider({ ...limit, provider: 'claude' }, 'codex')).toBe('claude');
    expect(limitProvider(limit, 'codex')).toBe('codex');
    expect(limitProvider({ ...limit, provider: 'claude' })).toBe('claude');
  }
});

it('builds each limit action from the clicked notice, including the earlier of two refusals', () => {
  const card = (id: string) => ({ type: 'notice', id, limit: { resetsAt: 200 } }) as NoticeItem;
  for (const id of ['older', 'newer']) {
    expect(limitAction('s', card(id), { id: 'other', label: 'Other' }, false, 100)).toEqual({ method: 'session.switchAccount', label: 'Continue with Other', params: { sessionId: 's', accountId: 'other', retry: true, refusalId: id } });
    expect(limitAction('s', card(id), undefined, false, 100)).toEqual({ method: 'spare.atReset', label: 'Continue at reset', params: { sessionId: 's', refusalId: id } });
  }
  for (const now of [200, 201]) {
    expect(limitAction('s', card('old'), undefined, false, now)).toEqual({ method: 'spare.atReset', label: 'Continue now', params: { sessionId: 's', refusalId: 'old' } });
    expect(limitAction('s', card('old'), undefined, true, now)).toBeNull();
  }
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
  // 2.18: the lift is believed only while a field has the focus (here the composer's field).
  (document as unknown as { activeElement: unknown }).activeElement = { tagName: 'TEXTAREA' };
  vi.stubGlobal('window', { __sableInsetsState: [[24, 0, 16, 0], 200, 250] });
  const { keyboardLift } = await import('../mobile/src/lib/keyboard');
  expect(keyboardLift()).toBe(200);
  expect(css.get('--kb-ms')).toBe('0ms');
  window.__sableInsets!([0, 28, 10, 12], 80, 100);
  window.__sableInsets!([0, 28, 10, 12], 0, 180);
  expect([...css.entries()]).toEqual([['--sat', '0px'], ['--sar', '28px'], ['--sab', '10px'], ['--sal', '12px'], ['--kb-ms', '180ms'], ['--kb', '0px']]);
  expect(attrs.has('data-kb')).toBe(false);
});

it('2.18: lifts nothing while no field has the focus, and passes the navigation bar on when the native side gives it', async () => {
  vi.resetModules();
  const css = new Map<string, string>();
  const attrs = new Set<string>();
  vi.stubGlobal('document', { activeElement: { tagName: 'BODY' }, documentElement: {
    style: { setProperty: (key: string, value: string) => css.set(key, value), removeProperty: (key: string) => css.delete(key) },
    setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name), hasAttribute: (name: string) => attrs.has(name),
  } });
  // A keyboard the native side never took back (it says 300) with nothing focused: no bar stands a keyboard high.
  vi.stubGlobal('window', { __sableInsetsState: [[56, 0, 32, 0], 300, 250, 24] });
  const { keyboardLift } = await import('../mobile/src/lib/keyboard');
  expect(keyboardLift()).toBe(0);
  expect(css.get('--sab')).toBe('32px');
  expect(css.get('--sab-nav')).toBe('24px');
  expect(attrs.has('data-nav')).toBe(true);
  // An older native side (three arguments): the pane goes by --sab alone.
  window.__sableInsets!([56, 0, 32, 0], 0, 0);
  expect(css.has('--sab-nav')).toBe(false);
  expect(attrs.has('data-nav')).toBe(false);
});

it('2.18: never lifts twice what the system already took off the page for the keyboard', async () => {
  const { effectiveLift, editable } = await import('../mobile/src/lib/keyboard');
  expect(effectiveLift({ raw: 300, focused: true, full: 987, height: 987, visual: 987 })).toBe(300);
  expect(effectiveLift({ raw: 300, focused: false, full: 987, height: 987, visual: 987 })).toBe(0);
  // The window resized by 300 for the keyboard (a system that still honours adjustResize): nothing left to lift.
  expect(effectiveLift({ raw: 300, focused: true, full: 987, height: 687, visual: 687 })).toBe(0);
  // The WebView shrank its visual viewport by 280: only the rest is lifted.
  expect(effectiveLift({ raw: 300, focused: true, full: 987, height: 987, visual: 707 })).toBe(20);
  expect(editable({ tagName: 'INPUT', type: 'search' } as unknown as Element)).toBe(true);
  expect(editable({ tagName: 'INPUT', type: 'checkbox' } as unknown as Element)).toBe(false);
  expect(editable({ tagName: 'BUTTON' } as unknown as Element)).toBe(false);
});
