/**
 * The phone's native wrappers after review wave 6 (mobile/src/lib/native.ts and downloads.ts over
 * fakes of Capacitor's plugins): pairing data that is there but is not a pairing is "damaged", never
 * "none" (22); an erasure whose notifications Android could not remove says so (10); the downloads
 * module that loads onto a connection already open resumes what paused (17).
 */
import { describe, expect, it, vi } from 'vitest';

const cap = vi.hoisted(() => ({
  prefs: new Map<string, string>(),
  failRead: false,
  plugins: {} as Record<string, Record<string, (...a: never[]) => unknown>>,
  notes: { failRemove: false },
  calls: [] as { method: string; params: unknown }[],
  conn: {
    state: 'open',
    pairedSecurely: true,
    on: vi.fn(),
    onState: vi.fn(),
    opened: [] as (() => void)[],
    onOpen(l: () => void) {
      this.opened.push(l);
      return () => {};
    },
    sealed: () => ({
      fp: 'F'.repeat(43),
      call: (method: string, params: unknown) => (cap.calls.push({ method, params }), new Promise(() => {})),
    }),
  },
}));
vi.mock('../mobile/node_modules/@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: (name: string) => new Proxy({}, { get: (_t, k) => cap.plugins[name]?.[k as string] }),
}));
vi.mock('../mobile/node_modules/@capacitor/app', () => ({ App: { addListener: async () => ({ remove() {} }) } }));
vi.mock('@desk/features/timeline/lead-in', async () => await import('../src/features/timeline/lead-in'));
vi.mock('../mobile/node_modules/@capacitor/device', () => ({ Device: {} }));
vi.mock('../mobile/node_modules/@capacitor/haptics', () => ({ Haptics: {}, ImpactStyle: {}, NotificationType: {} }));
vi.mock('../mobile/node_modules/@capacitor/local-notifications', () => ({
  LocalNotifications: {
    removeAllDeliveredNotifications: async () => {
      if (cap.notes.failRemove) throw new Error('not removed');
    },
    getPending: async () => ({ notifications: [] }),
    cancel: async () => {},
  },
}));
vi.mock('../mobile/node_modules/@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => {
      if (cap.failRead) throw new Error('unreadable');
      return { value: cap.prefs.get(key) ?? null };
    },
    set: async ({ key, value }: { key: string; value: string }) => void cap.prefs.set(key, value),
    remove: async ({ key }: { key: string }) => void cap.prefs.delete(key),
  },
}));
vi.mock('../mobile/src/lib/conn', () => ({ conn: cap.conn }));

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('window', globalThis);
vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: () => {} });

cap.plugins.System = { keep: async () => {}, shortcuts: async () => {} };
cap.plugins.Files = { forgetAll: async () => {}, prune: async () => {} };
// Phone 2.13: the chats' notifications and the live one are Notes.java's (the erasure clears them through it).
cap.plugins.Notes = {
  live: async () => {},
  clearAll: async () => {
    if (cap.notes.failRemove) throw new Error('not removed');
  },
};

describe('the pairing as kept (22)', () => {
  it('there but not a pairing is damaged, never "none"; a read that fails throws as a read failure', async () => {
    const { loadPairing } = await import('../mobile/src/lib/native');
    cap.prefs.delete('pairing');
    await expect(loadPairing()).resolves.toBeNull();
    for (const bad of ['{not json', 'null', '"text"', JSON.stringify({ hosts: ['10.0.0.2'] }), JSON.stringify({ token: '', hosts: [] }), JSON.stringify({ token: 't', hosts: 'x' })]) {
      cap.prefs.set('pairing', bad);
      await expect(loadPairing()).rejects.toMatchObject({ damaged: true });
    }
    const good = { hosts: ['10.0.0.2'], port: 47820, token: 't'.repeat(43), deviceId: 'd', desktop: 'Desk' };
    cap.prefs.set('pairing', JSON.stringify(good));
    await expect(loadPairing()).resolves.toEqual(good);
    cap.failRead = true;
    const err = await loadPairing().catch((e) => e);
    cap.failRead = false;
    expect(err).toBeInstanceOf(Error);
    expect((err as { damaged?: boolean }).damaged).toBeUndefined();
  });
});

describe('an erasure on Android (10)', () => {
  it('notifications Android could not remove are a step that failed (the erasure keeps its mark)', async () => {
    const { eraseNative } = await import('../mobile/src/lib/native');
    await expect(eraseNative()).resolves.toEqual([]);
    cap.notes.failRemove = true;
    await expect(eraseNative()).resolves.toEqual(['notifications']);
    cap.notes.failRemove = false;
    // Files that could not all be removed count too.
    cap.plugins.Files.forgetAll = async () => {
      throw new Error('Some files could not be removed.');
    };
    await expect(eraseNative()).resolves.toEqual(['files']);
    cap.plugins.Files.forgetAll = async () => {};
  });
});

it('delivers the first working payload after idle, dedupes equals, and retries only the current failed delivery', async () => {
  const { setLive } = await import('../mobile/src/lib/native');
  let reject!: (error: Error) => void;
  const live = vi.fn().mockResolvedValue(undefined);
  cap.plugins.Notes.live = live;
  try {
    const work = { chats: 1, waiting: 0, chat: 'a', title: 'A', text: 'Working', since: 22 };
    setLive(null);
    live.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
    setLive(work);
    setLive({ ...work });
    expect(live.mock.calls.map(([payload]) => payload)).toEqual([{ chats: 0, waiting: 0 }, work]);
    setLive(null);
    setLive(work);
    reject(new Error('old call'));
    await Promise.resolve();
    setLive(work);
    expect(live).toHaveBeenCalledTimes(4);
    live.mockRejectedValueOnce(new Error('unavailable'));
    setLive(null, true);
    await Promise.resolve();
    setLive(null, true);
    expect(live.mock.calls.slice(4)).toEqual([[{ chats: 0, waiting: 0, stop: true }], [{ chats: 0, waiting: 0, stop: true }]]);
  } finally {
    cap.plugins.Notes.live = async () => {};
  }
});

it('takes socket work to the real native wrapper before Home and updates it while WebView frames are suspended', async () => {
  const { onAppState, setLive } = await import('../mobile/src/lib/native');
  const modulePath = '../mobile/src/lib/store';
  const s = await import(/* @vite-ignore */ modulePath);
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const priorDocument = document;
  vi.stubGlobal('document', page);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const live = vi.fn().mockResolvedValue(undefined);
  cap.plugins.Notes.live = live;
  const off = onAppState(() => {});
  const stop = s.watchLive(setLive);
  try {
    s.setState({ conn: 'open', fresh: true, listAt: 1, notify: true, sessions: { a: { id: 'a', title: 'Chat', status: 'idle' } } });
    const receive = cap.conn.on.mock.calls[0][0];
    const update = (patch: object) => receive({ type: 'session.updated', id: 'a', patch });
    update({ status: 'running' });
    const working = live.mock.lastCall?.[0];
    expect(working).toMatchObject({ chats: 1, waiting: 0, chat: 'a', text: 'Working' });
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    expect(live.mock.lastCall).toEqual([working]);
    update({ status: 'idle', background: 1 });
    expect(live.mock.lastCall?.[0]).toMatchObject({ chat: 'a', text: '1 sub-agent working', since: working.since });
    update({ background: null });
    expect(live.mock.lastCall).toEqual([{ chats: 0, waiting: 0 }]);
    update({ commands: 2 });
    expect(live.mock.lastCall?.[0]).toMatchObject({ chats: 1, text: '2 commands running' });
  } finally {
    stop();
    page.visibilityState = 'visible';
    page.dispatchEvent(new Event('visibilitychange'));
    off();
    s.setState({ fresh: false, sessions: {} });
    vi.stubGlobal('document', priorDocument);
    cap.plugins.Notes.live = async () => {};
  }
});

describe('downloads loading onto an open connection (17)', () => {
  it('a download that paused goes on at once, not only at the next reconnect', async () => {
    mem.set('sable.downloads', JSON.stringify({ 's:i:0': { state: 'paused', via: 'channel', secure: true, total: 10, from: { sid: 's', itemId: 'i', index: 0 } } }));
    cap.calls.length = 0;
    await import('../mobile/src/lib/downloads');
    await new Promise((r) => setTimeout(r, 0));
    expect(cap.calls.map((c) => c.method)).toEqual(['phone.fileStart']);
    expect(cap.calls[0].params).toMatchObject({ sessionId: 's', itemId: 'i', index: 0 });
    expect(cap.conn.opened).toHaveLength(1);
  });
});
