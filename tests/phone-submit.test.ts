import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PermissionRequest, type PhonePermission } from '@shared/protocol';
import { offers, pressFrom, receipt, transition, type Press, type SendEvent, type Submission } from '../mobile/src/lib/submit';
import { forgetShown, permissionShown, shownPermissions } from '../mobile/src/lib/shown';
const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const file = { id: 'photo', kind: 'image' as const, name: 'photo.jpg', dataUrl: 'data:image/jpeg;base64,YQ==' };
const packet = { sessionId: 'chat', text: ' A ', submitId: 'ID', attachments: [file], steer: true };
const press: Press = { source: 'chat', revision: 1, returnRevision: 2, packet };
const events: SendEvent[] = [{ type: 'press', press }, { type: 'retry' }, { type: 'lost' }, { type: 'refused' }, { type: 'accepted' }, { type: 'discard' }];
type State = Submission['state'] | undefined;
const cases: [State, State[]][] = [
  [undefined, ['sending', undefined, undefined, undefined, undefined, undefined]],
  ['sending', ['sending', 'sending', 'unsure', 'refused', undefined, 'sending']],
  ['unsure', ['unsure', 'sending', 'unsure', 'refused', undefined, undefined]],
  ['refused', ['refused', 'sending', 'refused', 'refused', undefined, undefined]],
];
describe('one phone press', () => {
  for (const [state, expected] of cases) {
    it.each(events.map((event, i) => [event.type, event, expected[i]] as const))(`${state ?? 'absent'} + %s`, (_, event, next) => {
      const before = state && { ...press, state };
      const after = transition(before, event);
      expect(after?.state).toBe(next);
      if (after) expect(after.packet).toBe(packet);
      expect(before?.state).toBe(state);
    });
  }
  it('requires the original echoed ID on a positive receipt', () => {
    expect(receipt('ID', { ok: true })).toBe('lost');
    expect(receipt('ID', { ok: true, submitId: 'other' })).toBe('lost');
    expect(receipt('ID', { ok: true, submitId: 'ID' })).toBe('accepted');
  });
});

const disk = vi.hoisted(() => new Map<string, string>());
const desktop = vi.hoisted(() => ({ state: 'closed', call: vi.fn(), onOpen: vi.fn() }));
vi.mock('../mobile/src/lib/conn', () => ({ conn: desktop }));
const keep = vi.hoisted(() => vi.fn(async (k: string, v: string | null) => {
  if (v === null) disk.delete(k);
  else disk.set(k, v);
}));
vi.mock('../mobile/src/lib/native', () => ({ readPref: async (key: string) => disk.get(key) ?? null, durable: keep }));
const page = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => page.get(k) ?? null, setItem: (k: string, v: string) => page.set(k, v),
  removeItem: (k: string) => page.delete(k), key: (i: number) => [...page.keys()][i], get length() { return page.size; },
});
vi.stubGlobal('window', globalThis);

async function boot() {
  vi.resetModules();
  desktop.state = 'closed';
  const send = await import('../mobile/src/lib/phone-send');
  const drafts = await import('../mobile/src/lib/drafts');
  const { epoch } = await import('../mobile/src/lib/epoch');
  await send.recoverOutgoing();
  desktop.state = 'open';
  const field = () => offers(send.outgoing(), 'chat', drafts.composition('chat'));
  const type = (text: string, files = [file]) => drafts.setDraft('chat', text, { files, now: true });
  const tap = () => send.sendPress(pressFrom('chat', drafts.composition('chat'), true)(), epoch());
  return { ...send, ...drafts, field, type, tap };
}
beforeEach(() => {
  forgetShown();
  disk.clear();
  page.clear();
  desktop.call.mockReset();
  keep.mockClear();
});

describe('phone outbox over committed storage and bridge replies', () => {
  it('keeps B and its files when A loses its reply, and discards only A', async () => {
    const app = await boot();
    let lose!: () => void;
    desktop.call.mockImplementation((method: string) => method === 'session.send'
      ? new Promise((_, reject) => { lose = () => reject(new Error('connection lost')); })
      : Promise.reject(new Error('offline')));
    app.type(' A ');
    const sent = app.tap();
    await vi.waitFor(() => expect(lose).toBeDefined());
    const saved = JSON.parse(disk.get('sable.outgoing')!).entries[0];
    expect(saved.packet).toMatchObject({ text: ' A ', attachments: [file], steer: true });
    expect(app.getDraft('chat')).toBe('');
    app.type('B', [{ ...file, id: 'new' }]);
    lose();
    await expect(sent).rejects.toThrow();
    expect(app.field().field).toBeUndefined();
    expect(app.field().rows[0]).toMatchObject({ packet: saved.packet, state: 'unsure' });
    await app.discardPress(app.field().rows[0]);
    expect(app.composition('chat')).toMatchObject({ t: 'B', files: [{ id: 'new' }] });
    expect(app.outgoing()).toEqual([]);
  });

  it.each([false, true])('recovers after clear and before the answer (bridge accepted %s)', async accepted => {
    let app = await boot();
    desktop.call.mockImplementation(() => new Promise(() => {}));
    app.type(' A ');
    void app.tap();
    await vi.waitFor(() => expect(desktop.call).toHaveBeenCalledTimes(1));
    const original = desktop.call.mock.calls[0][1];
    expect(app.getDraft('chat')).toBe('');
    app = await boot();
    desktop.call.mockResolvedValue({ ok: accepted, submitId: original.submitId });
    await app.recoverOutgoing();
    expect(desktop.call.mock.calls.slice(1)).toEqual([['session.submission', { sessionId: 'chat', submitId: original.submitId }]]);
    if (accepted) expect(app.outgoing()).toEqual([]);
    else expect(app.field().field?.packet).toEqual(original);
  });

  it('loses two replies and retries twice with one id and one admission', async () => {
    const app = await boot();
    let attempts = 0;
    const admissions = new Set<string>();
    const packets: unknown[] = [];
    desktop.call.mockImplementation(async (method: string, p: typeof packet) => {
      if (method === 'session.submission') return { ok: admissions.has(p.submitId), submitId: p.submitId };
      packets.push(p);
      if (++attempts < 3) throw new Error('lost');
      admissions.add(p.submitId);
      return { ok: true, submitId: p.submitId };
    });
    app.type(' A ');
    await expect(app.tap()).rejects.toThrow('lost');
    await expect(app.retryPress(app.field().field!)).rejects.toThrow('lost');
    await app.retryPress(app.field().field!);
    expect(packets).toEqual([packets[0], packets[0], packets[0]]);
    expect(admissions.size).toBe(1);
    expect(app.outgoing()).toEqual([]);
  });

  it('admits identical deliberate presses independently while the first is outstanding', async () => {
    const app = await boot();
    const admissions = new Set<string>();
    let accept!: () => void;
    desktop.call.mockImplementation(async (_: string, p: typeof packet) => {
      admissions.add(p.submitId);
      if (admissions.size === 1) await new Promise<void>(resolve => { accept = resolve; });
      return { ok: true, submitId: p.submitId };
    });
    app.type(' A ');
    const first = app.tap();
    await vi.waitFor(() => expect(accept).toBeDefined());
    app.type(' A ');
    await app.tap();
    accept();
    await first;
    expect(admissions.size).toBe(2);
    expect(app.outgoing()).toEqual([]);
  });

  it('keeps an unanswered acceptance pending, and retries only after a negative query', async () => {
    const app = await boot();
    app.type(' A ');
    desktop.call.mockResolvedValue({ ok: true, submitId: 'wrong' });
    await expect(app.tap()).rejects.toThrow();
    await expect(app.retryPress(app.field().field!)).rejects.toThrow();
    const id = app.field().field!.packet.submitId;
    desktop.call.mockResolvedValue({ ok: true, submitId: id });
    await app.retryPress(app.field().field!);
    expect(desktop.call.mock.calls.filter(([method]) => method === 'session.send')).toHaveLength(1);
    expect(app.outgoing()).toEqual([]);
  });

  it('keeps the entire field when the first native commit fails', async () => {
    const app = await boot();
    app.type(' A ');
    keep.mockRejectedValueOnce(new Error('full'));
    await expect(app.tap()).rejects.toThrow('full');
    expect(app.composition('chat')).toMatchObject({ t: ' A ', files: [file] });
    expect(desktop.call).not.toHaveBeenCalled();
  });

  it('keeps the newer draft and its photo across restart when page storage is full', async () => {
    let app = await boot();
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      app.type('A');
      desktop.call.mockImplementation(async (method: string) => {
        if (method === 'session.send') app.type('B', [{ ...file, id: 'new-photo' }]);
        throw new Error('offline');
      });
      await expect(app.tap()).rejects.toThrow();
      await app.drained();
      app = await boot();
      expect(app.composition('chat')).toMatchObject({ t: 'B', files: [{ id: 'new-photo', dataUrl: file.dataUrl }] });
      expect(app.field().rows[0].packet.text).toBe('A');
    } finally {
      full.mockRestore();
    }
  });

  it.each([false, true])('preserves an intentional empty field during commit (typed B first %s)', async typed => {
    const app = await boot();
    let commit!: () => void;
    keep.mockImplementationOnce((key, value) => new Promise<void>(resolve => {
      commit = () => { disk.set(key, value!); resolve(); };
    }));
    desktop.call.mockResolvedValue({ ok: false });
    app.type('A');
    const pending = app.tap();
    await vi.waitFor(() => expect(commit).toBeDefined());
    expect(app.getDraft('chat')).toBe('A');
    expect(desktop.call).not.toHaveBeenCalled();
    if (typed) app.type('B');
    app.type('', []);
    commit();
    await expect(pending).rejects.toThrow();
    expect(app.field().field).toBeUndefined();
    expect(app.field().rows.map(s => s.packet.text)).toEqual(['A']);
  });

  it('replays a native clear after Android loses the page write, even after acceptance', async () => {
    let app = await boot();
    app.type('A');
    const beforeClear = page.get('sable.drafts')!;
    desktop.call.mockImplementation(async (_, p) => ({ ok: true, submitId: p.submitId }));
    await app.tap();
    page.set('sable.drafts', beforeClear);
    app = await boot();
    expect(app.composition('chat')).toMatchObject({ t: '', r: 2 });
    expect(app.outgoing()).toEqual([]);
  });

  it('drains the interrupted native write before erasure and never transmits it', async () => {
    const app = await boot();
    let commit!: () => void;
    keep.mockImplementationOnce((key, value) => new Promise<void>(resolve => {
      commit = () => { disk.set(key, value!); resolve(); };
    }));
    app.type('A');
    const pending = app.tap();
    await vi.waitFor(() => expect(commit).toBeDefined());
    const { eraseAll } = await import('../mobile/src/lib/erase');
    const erased = eraseAll({ storage: localStorage, native: async () => { disk.clear(); return []; } });
    commit();
    await expect(pending).rejects.toThrow('forgotten');
    await erased;
    expect(app.outgoing()).toEqual([]);
    expect(disk.size).toBe(0);
    expect(desktop.call).not.toHaveBeenCalled();
  });

  it('returns a refused first home message in the created chat', async () => {
    const app = await boot();
    app.setDraft(app.HOME_DRAFT, 'first', { now: true });
    const first = pressFrom(app.HOME_DRAFT, app.composition(app.HOME_DRAFT));
    desktop.call.mockResolvedValue({ ok: false, error: 'refused' });
    await expect(app.sendPress(first('chat', 0), 0)).rejects.toThrow('refused');
    expect(app.getDraft(app.HOME_DRAFT)).toBe('');
    expect(app.field().field).toMatchObject({ state: 'refused', packet: { submitId: expect.any(String), text: 'first', sessionId: 'chat' } });
  });

  it('recovers home words if Android kills the phone before createChat supplies a destination', async () => {
    let app = await boot();
    app.setDraft(app.HOME_DRAFT, 'start here', { now: true });
    await app.keepOpeningDraft(app.composition(app.HOME_DRAFT), 0);
    page.clear();
    app = await boot();
    expect(app.getDraft(app.HOME_DRAFT)).toBe('start here');
    expect(desktop.call).not.toHaveBeenCalled();
  });

  it('ignores a lost send reply after Forget and a new pairing', async () => {
    const app = await boot();
    let lose!: () => void;
    desktop.call.mockImplementation(() => new Promise((_, reject) => { lose = () => reject(new Error('old')); }));
    app.type('old');
    const sent = app.tap();
    await vi.waitFor(() => expect(lose).toBeDefined());
    const { eraseAll } = await import('../mobile/src/lib/erase');
    await eraseAll({ storage: localStorage, native: async () => { disk.clear(); return []; } });
    app.type('new', []);
    lose();
    await expect(sent).rejects.toThrow('forgotten');
    expect(app.getDraft('chat')).toBe('new');
    expect(app.outgoing()).toEqual([]);
    expect(disk.size).toBe(0);
  });
});

describe('a mode change names the permission cards the phone showed (review 0235b, finding 23)', () => {
  const req = (id: string, over: Partial<PhonePermission> = {}): PermissionRequest =>
    ({ id, sessionId: 'chat', toolName: 'Bash', kind: 'bash', title: `Run ${id}`, detail: {}, options: [], createdAt: 1, revision: `rev-${id}`, ...over }) as PermissionRequest;

  it('names a card that was on screen, as the revision it showed', () => {
    const a = req('a');
    const b = req('b');
    permissionShown('chat', a);
    // `b` only waits in the list ("+1"): it was never drawn, so it is not named.
    expect(shownPermissions('chat', [a, b])).toEqual([{ id: 'a', revision: 'rev-a' }]);
  });

  it('never names a request that came shortened, one that changed since it was shown, or another chat’s', () => {
    permissionShown('chat', req('cut', { incomplete: true, revision: undefined }));
    expect(shownPermissions('chat', [req('cut', { incomplete: true, revision: undefined })])).toEqual([]);
    const a = req('a');
    permissionShown('chat', a);
    expect(shownPermissions('chat', [req('a', { revision: 'rev-newer' })])).toEqual([]);
    expect(shownPermissions('chat', [req('a', { incomplete: true })])).toEqual([]);
    permissionShown('chat', a);
    expect(shownPermissions('other', [a])).toEqual([]);
    // Shown again as it is now: named with the new revision.
    const newer = req('a', { revision: 'rev-newer' });
    permissionShown('chat', newer);
    expect(shownPermissions('chat', [newer])).toEqual([{ id: 'a', revision: 'rev-newer' }]);
  });

  it('keeps nothing of a request that no longer waits', () => {
    const a = req('a');
    permissionShown('chat', a);
    expect(shownPermissions('chat', [])).toEqual([]);
    // The same id waiting again was not shown again.
    expect(shownPermissions('chat', [a])).toEqual([]);
  });

  it('is read at the tap and sent with the mode, and every permission card reports itself', () => {
    const screen = read('mobile/src/screens/Composer.tsx');
    expect(screen).toContain("conn.call('session.setMode', { sessionId: sid, mode: id, shownPermissions: shownPermissions(sid, sessionData(getState(), sid).permissions) })");
    const prompts = read('mobile/src/screens/Prompts.tsx');
    const body = prompts.slice(prompts.indexOf('export function PermissionBody('));
    expect(body).toMatch(/useEffect\(\(\) => permissionShown\(sid, req\), \[sid, req\]\);/);
    // The chat's sheet and the deck both draw that one component.
    expect(prompts).toMatch(/<PermissionBody key=\{perm\.id\} sid=\{sid\} req=\{perm\}/);
    expect(read('mobile/src/screens/Deck.tsx')).toMatch(/<PermissionBody sid=\{front\.sessionId\} req=\{front\.perm\}/);
  });
});
