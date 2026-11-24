/**
 * "oft obwohl account geswitched steht oben falscher account" (night of 23/24 Nov). The session
 * header (`SessionAccount`), the sidebar footer (`useFocusAccount` → `accountInUse`) and the menu's
 * check (`accountMark`) all read one field, `SessionMeta.accountId` of the chat in the store, which
 * `session.updated` keeps current. What went wrong: the bridge clears that field to undefined when a
 * chat moves to its agent's default account (Main), and JSON drops a key whose value is undefined,
 * so the window never heard of the move and went on naming the account the chat had left. The same
 * for `moving` (a spinner that never stopped after a move ended or failed), `activity` and
 * `lastError`. A cleared field must travel as null; the window removes it (`mergeMeta`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT, type BridgeEvent, type SessionMeta, type SessionSnapshot } from '@shared/protocol';
import { App } from '../server/app';
import { eventForWindow } from '../server/core/trim';
import { phoneEvent } from '../server/services/phone';

type Call = { method: string; params: Record<string, unknown>; resolve: (v: unknown) => void };
const calls: Call[] = [];
vi.mock('@/lib/bridge', () => ({
  bridge: {
    status: 'closed',
    call: (method: string, params: Record<string, unknown>) => new Promise((resolve) => calls.push({ method, params, resolve })),
    on: () => () => {},
    onStatus: () => () => {},
    start: () => {},
  },
}));

const store = await import('../src/state/store');
const actions = await import('../src/state/actions');
const { accountInUse, accountMark } = await import('../src/features/accounts/model');
const { useStore, applyEvent } = store;

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'demo', cwd: 'C:/w', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...extra }) as SessionMeta;
const snap = (session: SessionMeta): SessionSnapshot => ({ session, items: [], permissions: [], questions: [], todos: [], queue: [] });
const flush = () => new Promise((r) => setTimeout(r, 0));

const ACCOUNTS = [
  { id: DEFAULT_ACCOUNT, isDefault: true },
  { id: 'w2', isDefault: false },
  { id: 'w3', isDefault: false },
];

/** What the header names: the chat's own account. */
const header = (id: string) => useStore.getState().sessions[id]?.accountId ?? DEFAULT_ACCOUNT;
/** What the footer names while that chat is open (`useFocusAccount` → `accountInUse`). */
const footer = () => {
  const s = useStore.getState();
  const open = s.ui.activeSessionId ? s.sessions[s.ui.activeSessionId] : undefined;
  return accountInUse(ACCOUNTS, open ? (open.accountId ?? DEFAULT_ACCOUNT) : undefined)?.id;
};
/** Which row of the switcher's menu carries the check. */
const checked = () => ACCOUNTS.filter((a) => accountMark(a, footer()) === 'here').map((a) => a.id);

/** An event as it reaches the window: through JSON, as the bridge's socket sends it. */
const overTheWire = (e: BridgeEvent) => applyEvent(JSON.parse(JSON.stringify(e)) as BridgeEvent);

function reset(sessions: SessionMeta[], open: string | null) {
  calls.length = 0;
  store.resetKept();
  useStore.setState((s) => ({ ready: true, sessions: Object.fromEntries(sessions.map((m) => [m.id, m])), data: {}, ui: { ...s.ui, activeSessionId: open, race: null } }));
}

beforeEach(() => reset([meta('a', { accountId: 'w2' }), meta('b', { accountId: 'w3' })], 'a'));

describe('the account a chat is on, as the window shows it', () => {
  it('sends every cleared session field across JSON and removes it from the open chat', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-session-patch-'));
    const app = new App({ home, userHome: home, providers: [], quiet: true });
    try {
      const old = {
        activity: 'Reading', lastError: 'Stopped', remote: { status: 'paired' }, capState: {},
        moving: true, pendingRestart: true, providerSessionId: 'thread', movedFrom: 'w3', returnAt: 400,
        spare: { reason: 'reset', since: 1 }, race: { id: 'r', rival: 'b', side: 0, task: 'test', folder: 'x', startedAt: 1 },
        lane: { folder: 'x', root: 'x', path: 'y', branch: 'side', base: 'base', createdAt: 1 },
      } satisfies Partial<SessionMeta>;
      reset([meta('a', { accountId: 'w2', ...old })], 'a');
      const clears = Object.fromEntries(Object.keys(old).map((key) => [key, undefined]));
      const expected = Object.fromEntries(Object.keys(old).map((key) => [key, null]));
      app.subscribe((e) => {
        if (e.type !== 'session.updated') return;
        expect(e.patch.moving).toBeUndefined();
        const wire = JSON.parse(JSON.stringify(eventForWindow(e)));
        expect(wire.patch).toEqual({ ...expected, accountId: DEFAULT_ACCOUNT, commands: 0, pinned: false, branch: '' });
        applyEvent(wire);
        const phone = JSON.parse(JSON.stringify(phoneEvent(e)));
        expect(phone.patch).toMatchObject({ accountId: DEFAULT_ACCOUNT, activity: null, remote: null, race: null, lane: null, commands: 0, pinned: false, branch: '' });
      });
      app.emit({ type: 'session.updated', id: 'a', patch: { ...clears, accountId: undefined, commands: 0, pinned: false, branch: '' } });
      const session = useStore.getState().sessions.a;
      for (const key of Object.keys(old)) expect(session).not.toHaveProperty(key);
      expect(session.title).toBe('a');
      expect(header('a')).toBe(DEFAULT_ACCOUNT);
      expect(footer()).toBe(DEFAULT_ACCOUNT);
    } finally {
      await app.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps required fields intact on phones that shallow-merge session patches', () => {
    const e = phoneEvent({ type: 'session.updated', id: 'a', patch: { cwd: undefined, usage: undefined, remote: undefined, status: 'idle' } });
    const { patch } = JSON.parse(JSON.stringify(e));
    const old = meta('a', { remote: { status: 'connected' } });
    expect({ ...old, ...patch }).toEqual({ ...old, remote: null, status: 'idle' });
  });

  it('a cleared field is lost on the wire as undefined: the reason the header kept the old account', () => {
    overTheWire({ type: 'session.updated', id: 'a', patch: { accountId: undefined, status: 'idle' } });
    // JSON dropped the key: nothing told the window the chat is on Main now.
    expect(header('a')).toBe('w2');
  });

  it('a move back to the default account (sent as null) shows in the header, the footer and the check at once', () => {
    overTheWire({ type: 'session.updated', id: 'a', patch: { accountId: null, moving: null } as unknown as Partial<SessionMeta> });
    expect(header('a')).toBe(DEFAULT_ACCOUNT);
    expect(footer()).toBe(DEFAULT_ACCOUNT);
    expect(checked()).toEqual([DEFAULT_ACCOUNT]);
    expect('accountId' in useStore.getState().sessions.a).toBe(false);
    expect(useStore.getState().sessions.a.moving).toBeUndefined();
  });

  it('a move to another extra account shows in the same write', () => {
    overTheWire({ type: 'session.updated', id: 'a', patch: { moving: true } });
    expect(header('a')).toBe('w2');
    overTheWire({ type: 'session.updated', id: 'a', patch: { accountId: 'w3', moving: false } });
    expect(header('a')).toBe('w3');
    expect(footer()).toBe('w3');
    expect(checked()).toEqual(['w3']);
  });

  it('a move that failed keeps the account and stops saying it moves', () => {
    overTheWire({ type: 'session.updated', id: 'a', patch: { moving: true } });
    overTheWire({ type: 'session.updated', id: 'a', patch: { moving: null } as unknown as Partial<SessionMeta> });
    expect(header('a')).toBe('w2');
    expect(useStore.getState().sessions.a.moving).toBeUndefined();
  });

  it('a move at a limit and the return afterwards both show', () => {
    overTheWire({ type: 'session.updated', id: 'a', patch: { accountId: 'w3', movedFrom: 'w2' } as Partial<SessionMeta> });
    expect(header('a')).toBe('w3');
    overTheWire({ type: 'session.updated', id: 'a', patch: { accountId: 'w2', movedFrom: null, returnAt: null } as unknown as Partial<SessionMeta> });
    expect(header('a')).toBe('w2');
    expect(footer()).toBe('w2');
  });

  it('a chat that moved while another was on screen opens on its new account', async () => {
    // b is not loaded (only its meta): the event still reaches its meta.
    overTheWire({ type: 'session.updated', id: 'b', patch: { accountId: null } as unknown as Partial<SessionMeta> });
    expect(footer()).toBe('w2');
    actions.openSession('b');
    const c = calls.find((x) => x.method === 'session.snapshot' && x.params.sessionId === 'b')!;
    // The bridge answers with the chat as it holds it now.
    c.resolve(snap(meta('b')));
    await flush();
    expect(useStore.getState().ui.activeSessionId).toBe('b');
    expect(header('b')).toBe(DEFAULT_ACCOUNT);
    expect(footer()).toBe(DEFAULT_ACCOUNT);
  });

  it('a chat dropped from the kept ones keeps its account (the meta is never dropped)', async () => {
    useStore.setState((s) => ({ data: { ...s.data, b: { ...(s.data.b ?? {}), loaded: true, items: {}, roots: [], children: {}, permissions: [], questions: [], todos: [], queue: [], rev: 1 } as never } }));
    store.trimKept();
    overTheWire({ type: 'session.updated', id: 'b', patch: { accountId: 'w2' } });
    expect(header('b')).toBe('w2');
  });

  it('nulls are removed, other fields stay', () => {
    const m = store.mergeMeta(meta('x', { accountId: 'w2', activity: 'Reading', lastError: 'x', title: 'kept' }), { accountId: null, activity: null, lastError: null, status: 'idle' } as unknown as Partial<SessionMeta>);
    expect(m).toMatchObject({ id: 'x', title: 'kept', status: 'idle' });
    expect(m.accountId).toBeUndefined();
    expect(m.activity).toBeUndefined();
    expect(m.lastError).toBeUndefined();
  });
});

it('sends the selected refusal id with both limit-card actions', async () => {
  calls.length = 0;
  const move = actions.switchSessionAccount('a', 'w3', true, 'older-notice');
  const wait = actions.continueAtReset('a', 'newer-notice');
  expect(calls.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: 'session.switchAccount', params: { sessionId: 'a', accountId: 'w3', retry: true, refusalId: 'older-notice' } },
    { method: 'spare.atReset', params: { sessionId: 'a', refusalId: 'newer-notice' } },
  ]);
  calls.forEach((c) => c.resolve({ ok: true }));
  await Promise.all([move, wait]);
});
