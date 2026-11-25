import { afterEach, expect, it, vi } from 'vitest';

const disk = new Map<string, string>();
vi.mock('../src/features/composer/draft-overflow', () => ({
  overflowDraft: async (key: string, value?: string | null) => {
    if (value === undefined) return disk.get(key);
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); disk.clear(); });

it('checkpoints a queue edit larger than localStorage and restores its entire attachment after reload', async () => {
  let raw = '';
  const area = storageArea();
  vi.stubGlobal('sessionStorage', storageArea());
  vi.stubGlobal('localStorage', { ...area, get length() { return area.length; },
    setItem: (key: string, value: string) => {
      if (value.length > 200) throw new Error('quota');
      raw = value;
      area.setItem(key, value);
    },
  });
  vi.stubGlobal('window', { setTimeout: () => 0, addEventListener() {} });
  const picture = { id: 'img', name: 'a.png', kind: 'image' as const, dataUrl: 'data:image/png;base64,' + 'A'.repeat(5000) };
  const recovery = { queueId: 'row', preview: { text: 'inspect', files: ['img'] } };
  const draft = { text: 'inspect', attachments: [picture], recovery };
  const storage = await import('../src/features/composer/drafts');
  const { useStore } = await import('../src/state/store');
  storage.keepDrafts();
  useStore.getState().setDraft('chat', draft);
  expect(await storage.keepRecovery()).toBe(true);
  expect(raw).toMatch(/^overflow:/);
  vi.resetModules();
  const reload = await import('../src/features/composer/drafts');
  const { useStore: next } = await import('../src/state/store');
  reload.keepDrafts();
  await reload.keepRecovery();
  expect(next.getState().drafts.chat).toEqual(draft);
});

function storageArea() {
  const data = new Map<string,string>();
  return { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k,v), removeItem: (k: string) => data.delete(k) };
}
async function renderer(session: ReturnType<typeof storageArea>) {
  vi.resetModules();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('window', { setTimeout: () => 0, addEventListener() {} });
  const drafts = await import('../src/features/composer/drafts');
  const { useStore } = await import('../src/state/store');
  drafts.keepDrafts();
  await drafts.keepRecovery();
  return { drafts, store: useStore };
}
it('a second window cannot restore or overwrite the first window’s live checkpoint', async () => {
  vi.stubGlobal('localStorage', storageArea());
  const owner = storageArea(), other = storageArea();
  const a = await renderer(owner);
  const draft = { text: 'mine', attachments: [], recovery: { queueId: 'q', operationId: 'op1', preview: { text: 'mine', files: [] } } };
  a.store.getState().setDraft('chat', draft);
  await a.drafts.keepRecovery();
  const b = await renderer(other);
  expect(b.store.getState().drafts.chat).toBeUndefined();
  b.store.getState().setDraft('chat', { text: 'other', attachments: [] });
  await b.drafts.keepRecovery();
  const restored = await renderer(owner);
  expect(restored.store.getState().drafts.chat).toEqual(draft);
});
it('restores an ordinary picture-only send with its original submission identity', async () => {
  vi.stubGlobal('localStorage', storageArea());
  const owner = storageArea();
  const a = await renderer(owner);
  const { holdSend } = await import('../src/features/composer/pending');
  const draft = { text: '', attachments: [{ id: 'p', kind: 'image' as const, name: 'p.png', dataUrl: 'data:image/png;base64,AA==' }] };
  const p = holdSend('chat', draft);
  await a.drafts.keepRecovery();
  const b = await renderer(owner);
  const restored = b.store.getState().drafts.chat;
  expect(restored).toMatchObject(draft);
  expect((await import('../src/features/composer/pending')).submissionId('chat',restored)).toBe(p.id);
});

it('completing the later action leaves the earlier checkpoint and its ID intact', async () => {
  vi.stubGlobal('localStorage', storageArea());
  const owner = storageArea(), a = await renderer(owner);
  const pending = await import('../src/features/composer/pending');
  const first = pending.holdSend('chat', { text: 'first', attachments: [] });
  const second = pending.holdSend('chat', { text: 'second', attachments: [] });
  await a.drafts.keepRecovery();
  pending.sendDone(second);
  await a.drafts.keepRecovery();
  const b = await renderer(owner);
  expect(b.store.getState().drafts.chat).toMatchObject({ text: 'first', recovery: { retry: { id: first.id } } });
});

it('a duplicated window cannot claim a live owner; a closed owner has one adopter', async () => {
  vi.stubGlobal('localStorage', storageArea());
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _opts: object, cb: (lock: object | null) => unknown) => {
    if (held.has(key)) return cb(null);
    held.add(key); return cb({});
  } } });
  const tab = storageArea(), a = await renderer(tab);
  const id = tab.getItem('sable.windowId')!;
  const draft = { text: 'recover me', attachments: [], recovery: { operationId: 'orphan' } };
  a.store.getState().setDraft('chat', draft);
  await a.drafts.keepRecovery();
  const duplicate = storageArea(); duplicate.setItem('sable.windowId', id);
  expect((await renderer(duplicate)).store.getState().drafts.chat).toBeUndefined();
  expect(duplicate.getItem('sable.windowId')).not.toBe(id);
  held.delete('sable.window.' + id);
  const b = await renderer(storageArea());
  expect(b.store.getState().drafts.chat).toEqual(draft);
  expect((await renderer(storageArea())).store.getState().drafts.chat).toBeUndefined();
});
