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
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key === 'sable.drafts' ? raw : null,
    setItem: (_key: string, value: string) => {
      if (value.length > 200) throw new Error('quota');
      raw = value;
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
