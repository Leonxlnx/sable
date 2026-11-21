/**
 * The phone app's own rules (mobile/src/lib), each from a review finding: picks that settle however
 * late the answer (16), transport errors told apart (W3-29), `phone.stale` fetched once at a time (20),
 * approvals and questions answered only with what the phone was shown (5, 19), a bounded window of
 * turns around a deep search hit (24), notification bookkeeping reconciled with Android's (30), a late
 * picture bound to its viewer (26), a held message checked after a wait (W3-28), search matches in
 * the text's own offsets (29, also the desktop's palette), and downloads checked against the digest
 * the desktop named before they open or install. Pure modules, no device.
 */
import { describe, expect, it } from 'vitest';
import type { FileDiff, PermissionRequest, PhoneQuestionRequest, QuestionRequest } from '@shared/protocol';
import { Intents } from '../mobile/src/lib/intents';
import { isTransport, isUncertain, transportError } from '../mobile/src/lib/errors';
import { coalesce, staleFetch } from '../mobile/src/lib/stale';
import { answerCall, patchLines, permissionKeys } from '../mobile/src/lib/asks';
import { around, growDown, growUp, MOUNT_MAX, rangeOf, spacers, STEP, trimTop } from '../mobile/src/lib/window';
import { NoteBook } from '../mobile/src/lib/note-book';
import { openViewer, viewerLoaded, viewerState } from '../mobile/src/lib/viewer-state';
import { holder } from '../mobile/src/lib/held';
import { matchRanges, searchWords } from '../mobile/src/lib/find';
import { createDownloads, installable, SWAPPED, type FilesPlugin, type Status } from '../mobile/src/lib/download-core';
import { matchRanges as deskRanges } from '../src/features/palette/jump';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a pick whose answer comes late (16)', () => {
  it('rolls back when refused after the shown hold ran out', () => {
    let t = 0;
    const p = new Intents(6000, () => t);
    p.heard('c', { mode: 'default' });
    const gen = p.pick('c', 'mode', 'bypassPermissions', 'default');
    // Ten seconds on: the shown value no longer holds against updates, but the pick still waits for its answer.
    t = 10_000;
    expect(p.waiting('c', 'mode')).toBeUndefined();
    expect(p.outstanding('c', 'mode')).toBe(gen);
    expect(p.refused('c', 'mode', gen)).toEqual({ value: 'default' });
    expect(p.outstanding('c', 'mode')).toBeUndefined();
  });

  it('an answer that never came lets go of the newest pick only; an accepted one settles', () => {
    const p = new Intents();
    const a = p.pick('c', 'effort', 'high', 'low');
    const b = p.pick('c', 'effort', 'max', 'high');
    expect(p.unsure('c', 'effort', a)).toBe(false);
    expect(p.waiting('c', 'effort')).toBe('max');
    expect(p.unsure('c', 'effort', b)).toBe(true);
    expect(p.waiting('c', 'effort')).toBeUndefined();
    const c = p.pick('c', 'model', 'big', 'small');
    p.accepted('c', 'model', 'big', c);
    expect(p.outstanding('c', 'model')).toBeUndefined();
    expect(p.refused('c', 'model', c)).toBeNull();
  });

  it('tells the connection failing a call from the desktop refusing it', () => {
    expect(isTransport(transportError('The desktop did not answer in time', 'timeout'))).toBe(true);
    expect(isUncertain(transportError('The connection to the desktop was lost', 'lost'))).toBe(true);
    expect(isUncertain(transportError('Not connected to the desktop', 'unsent'))).toBe(false);
    expect(isTransport(new Error('That model is not available'))).toBe(false);
  });
});

describe('phone.stale (20)', () => {
  it("fetches the open chat's page, else the list", () => {
    expect(staleFetch({ sessionId: 'a' }, (id) => id === 'a')).toEqual({ kind: 'tail', sessionId: 'a' });
    expect(staleFetch({ sessionId: 'b' }, (id) => id === 'a')).toEqual({ kind: 'hello' });
    expect(staleFetch({}, () => true)).toEqual({ kind: 'hello' });
  });

  it('a burst runs one fetch at a time per key, and once more after if asked meanwhile', async () => {
    const runs: string[] = [];
    const gates: (() => void)[] = [];
    const go = coalesce((k) => {
      runs.push(k);
      return new Promise<void>((r) => gates.push(r));
    });
    go('a');
    go('a');
    go('a');
    go('b');
    expect(runs).toEqual(['a', 'b']);
    gates.shift()!();
    await tick();
    await tick();
    expect(runs).toEqual(['a', 'b', 'a']);
    gates.shift()!();
    gates.shift()!();
    await tick();
    await tick();
    expect(runs).toEqual(['a', 'b', 'a']);
  });
});

const grant: PermissionRequest['options'] = [
  { id: 'once', label: 'Allow once', tone: 'allow' },
  { id: 'always', label: 'Allow all edits', tone: 'always' },
  { id: 'no', label: 'Deny', tone: 'deny' },
];
const req = (extra: Partial<PermissionRequest> & { incomplete?: true } = {}) => ({ id: 'p', sessionId: 's', toolName: 'Edit', kind: 'edit' as const, title: 'Edit a.ts', detail: {}, options: grant, createdAt: 1, ...extra });

describe('an approval on the phone (5, W3-4)', () => {
  it('offers no allowing key when the phone got it shortened; refusing and Later stay', () => {
    expect(permissionKeys(req()).grants.map((o) => o.id)).toEqual(['once', 'always']);
    const cut = permissionKeys(req({ incomplete: true }));
    expect(cut.grants).toEqual([]);
    expect(cut.denials.map((o) => o.id)).toEqual(['no']);
    expect(cut.desktopOnly).toBe(true);
  });

  it('shows every line of the change it got (600, not 160)', () => {
    const diff: FileDiff[] = [{ path: 'src/a.ts', status: 'modified', additions: 600, deletions: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 600, lines: Array.from({ length: 600 }, (_, i) => `+line ${i}`) }] }];
    const lines = patchLines(diff);
    expect(lines).toHaveLength(601);
    expect(lines[600]).toBe('+line 599');
  });
});

const q = (over: Partial<PhoneQuestionRequest> = {}): PhoneQuestionRequest => ({
  id: 'r',
  sessionId: 's',
  createdAt: 1,
  questions: [
    { id: 'q0', question: 'Which database?', options: [{ id: 'o0', label: 'Postgres' }, { id: 'o1', label: 'SQLite' }] },
    { id: 'q1', question: 'Which tests?', multiSelect: true, cut: true, options: [{ id: 'o0', label: 'Unit' }, { id: 'o1', label: 'End to end' }] },
  ],
  ...over,
});

describe('questions on the phone (19)', () => {
  it('answers by question and option ids, with words of its own', () => {
    const call = answerCall('s', q(), { q0: ['o1'], q1: ['o0', 'o1'] }, { q1: ' and smoke ' });
    expect(call).toEqual({ method: 'phone.answer', params: { sessionId: 's', requestId: 'r', picks: { q0: { options: ['o1'] }, q1: { options: ['o0', 'o1'], other: 'and smoke' } } } });
  });

  it('sends nothing for a questionnaire the phone got incomplete, or with a question unanswered; skipping always goes', () => {
    expect(answerCall('s', q({ incomplete: true }), { q0: ['o0'], q1: ['o0'] }, {})).toBeNull();
    expect(answerCall('s', q(), { q0: ['o0'] }, {})).toBeNull();
    expect(answerCall('s', q({ incomplete: true }), {}, {}, true)).toEqual({ method: 'question.respond', params: { sessionId: 's', requestId: 'r', answers: null } });
  });

  it("an older desktop's questions (no ids) are answered by their words, as before", () => {
    const old: QuestionRequest = { id: 'r', sessionId: 's', createdAt: 1, questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }] }] };
    expect(answerCall('s', old, { '#0': ['Postgres'] }, {})).toEqual({ method: 'question.respond', params: { sessionId: 's', requestId: 'r', answers: { 'Which database?': ['Postgres'] } } });
  });
});

describe('a deep search hit (24)', () => {
  const keys = Array.from({ length: 3000 }, (_, i) => `t${i}`);
  it('mounts a bounded window around the hit, never every turn after it', () => {
    const w = around(keys, 120);
    const r = rangeOf(keys, w, 24);
    expect(r.lo).toBeLessThanOrEqual(120);
    expect(r.hi).toBeGreaterThan(120);
    expect(r.hi - r.lo).toBeLessThanOrEqual(MOUNT_MAX);
    expect(r.hi).toBeLessThan(keys.length);
  });

  it('moves as it is read: toward the newest it lets the oldest go, toward the start the newest; never more than the cap', () => {
    let r = rangeOf(keys, around(keys, 120), 24);
    for (let i = 0; i < 10; i++) r = rangeOf(keys, growDown(keys, r), 24);
    expect(r.hi - r.lo).toBeLessThanOrEqual(MOUNT_MAX);
    expect(r.lo).toBeGreaterThan(120);
    for (let i = 0; i < 20; i++) r = rangeOf(keys, growUp(keys, r), 24);
    expect(r.lo).toBe(0);
    expect(r.hi).toBe(MOUNT_MAX);
    // Named by keys: turns added at the newest end do not move it.
    const more = [...keys, 't3000', 't3001'];
    expect(rangeOf(more, growUp(keys, r), 24)).toEqual(r);
    // Reaching the newest, a window that grew past the cap gives up its oldest turns.
    const end = { lo: 3000 - MOUNT_MAX - STEP - 1, hi: 3000 };
    expect(rangeOf(keys, trimTop(keys, end), 24)).toEqual({ lo: 3000 - MOUNT_MAX, hi: 3000 });
  });

  it('stands what is not mounted as spacers of the height it had, else an estimate', () => {
    const heights = new Map([
      ['t0', 100],
      ['t1', 300],
      ['t9', 50],
    ]);
    const sp = spacers(keys.slice(0, 10), { lo: 2, hi: 9 }, heights);
    expect(sp).toEqual({ top: 400, bottom: 50 });
    const guess = spacers(keys.slice(0, 4), { lo: 3, hi: 4 }, new Map([['t3', 200]]));
    expect(guess.top).toBe(600);
  });
});

describe('notifications grouped under Sable (30)', () => {
  const store = () => {
    let v: string | null = null;
    return { get: () => v, set: (x: string) => void (v = x) };
  };
  const idFor = (sid: string) => sid.length * 1000 + sid.charCodeAt(0);
  it('a notification swiped away no longer counts; one whose schedule failed was never counted', () => {
    const s = store();
    const book = new NoteBook(s, idFor);
    book.add('chat-a');
    // A is swiped away; B comes: Android shows nothing, the summary would say one chat, not two.
    book.reconcile([]);
    expect(book.countWith('chat-b')).toBe(1);
    // Only once scheduled is it written down (and kept across a restart).
    book.add('chat-b');
    expect(new NoteBook(s, idFor).list()).toEqual(['chat-b']);
    book.reconcile([idFor('chat-b'), 1]);
    expect(book.list()).toEqual(['chat-b']);
    expect(book.remove('chat-b')).toBe(true);
    book.add('x');
    book.clear();
    expect(new NoteBook(s, idFor).size).toBe(0);
  });
});

describe('the picture viewer (26)', () => {
  it("a late picture lands only in the viewer that asked for it, at an index it has", () => {
    const first = openViewer({ srcs: [null, null], index: 0, key: 's\u0000step1' });
    // Closed while its second picture loads, then another step's viewer opens.
    const second = openViewer({ srcs: [null], index: 0, key: 's\u0000step2' });
    expect(viewerLoaded(first, 's\u0000step1', 1, 'data:old')).toBe(false);
    expect(viewerLoaded(second, 's\u0000step1', 0, 'data:old')).toBe(false);
    expect(viewerLoaded(second, 's\u0000step2', 3, 'data:x')).toBe(false);
    expect(viewerState()?.srcs).toEqual([null]);
    expect(viewerLoaded(second, 's\u0000step2', 0, 'data:new')).toBe(true);
    expect(viewerState()?.srcs).toEqual(['data:new']);
  });
});

describe('a held message (W3-28)', () => {
  it('an older hold neither reopens nor closes a newer one', () => {
    const h = holder<string>();
    const a = h.hold('answer A');
    expect(h.release()).toBe(true);
    const b = h.hold('answer B');
    expect(h.holds(a)).toBe(false);
    expect(h.release(a)).toBe(false);
    expect(h.current()).toBe(b);
    expect(h.release(b)).toBe(true);
  });
});

describe('search highlighting (29)', () => {
  it('splits a query on whitespace, not on the letter s', () => {
    expect(searchWords('build  failed ')).toEqual(['build', 'failed']);
    expect(searchWords('tests pass')).toEqual(['tests', 'pass']);
  });

  it('gives offsets in the text itself, also where lowercasing changes the length', () => {
    for (const ranges of [matchRanges, deskRanges]) {
      const t = 'İok then OK';
      const r = ranges(t, ['ok']);
      expect(r).toEqual([
        [1, 3],
        [9, 11],
      ]);
      for (const [a, b] of r) expect(b).toBeLessThanOrEqual(t.length);
      // A match that starts inside an expanded character covers the whole character.
      const i = ranges('İstanbul', ['i']);
      expect(i[0]).toEqual([0, 1]);
      expect(ranges('The build failed. Build again.', ['build', 'failed'])).toEqual([
        [4, 9],
        [10, 16],
        [18, 23],
      ]);
      expect(ranges('ΟΔΟΣ', ['οδός'.normalize('NFD').replace(/\p{M}/gu, '')])).toEqual([[0, 4]]);
    }
  });
});

describe('a download over DownloadManager (a pairing from before the secure channel), checked against what the desktop named', () => {
  type Plug = FilesPlugin & { removed: string[]; verifyWith: (o: { sha256: string }) => { ok: boolean } };
  const plugin = (status: Status, verify: (o: { sha256: string }) => { ok: boolean }): Plug => {
    const removed: string[] = [];
    return {
      removed,
      verifyWith: verify,
      download: async () => ({ id: '7' }),
      status: async () => status,
      cancel: async ({ id }) => void removed.push(id),
      verify: async (o) => verify(o),
      stageBegin: async () => ({ id: 's', have: 0 }),
      stageWrite: async () => ({ have: 0 }),
      stageFinish: async () => ({ ok: false }),
      stageDrop: async () => {},
    };
  };
  const make = (p: Plug, link: { sha256?: string; secure?: boolean }) => {
    const slept: number[] = [];
    let wake: () => void = () => {};
    const dl = createDownloads({
      plugin: p,
      link: async () => ({ url: 'http://10.0.0.2:47820/f/t/app.apk', size: 4, ...link }),
      native: true,
      sleep: (ms: number) => (slept.push(ms), new Promise<void>((r) => (wake = r))),
    });
    return { dl, slept, wake: () => wake() };
  };
  const FILE = { sid: 's', itemId: 'i', index: 0, name: 'app.apk' };

  it('a swapped file is refused and removed: it never reaches the installer', async () => {
    const p = plugin({ state: 'done', bytes: 4, total: 4 }, () => ({ ok: false }));
    const { dl } = make(p, { sha256: 'a'.repeat(64), secure: true });
    await dl.start('k', FILE);
    await tick();
    await tick();
    expect(dl.get('k').state).toBe('failed');
    expect(dl.get('k').error).toBe(SWAPPED);
    expect(p.removed).toEqual(['7']);
    expect(installable(dl.get('k'))).toBe(false);
  });

  it('a file that is what was named opens, but never goes to the installer: only a verified private copy from the secure channel does', async () => {
    const ok = plugin({ state: 'done', bytes: 4, total: 4 }, (o) => ({ ok: o.sha256 === 'b'.repeat(64) }));
    const sealed = make(ok, { sha256: 'B'.repeat(64), secure: true });
    await sealed.dl.start('k', FILE);
    await tick();
    await tick();
    expect(sealed.dl.get('k')).toMatchObject({ state: 'done', verified: true, sha256: 'b'.repeat(64) });
    expect(installable(sealed.dl.get('k'))).toBe(false);
    const plain = make(ok, { sha256: 'b'.repeat(64), secure: false });
    await plain.dl.start('k', FILE);
    await tick();
    await tick();
    expect(plain.dl.get('k')).toMatchObject({ state: 'done', verified: true });
    expect(installable(plain.dl.get('k'))).toBe(false);
    // An older desktop names no digest: the file opens, but is no app to install.
    const none = make(ok, {});
    await none.dl.start('k', FILE);
    await tick();
    await tick();
    expect(none.dl.get('k')).toMatchObject({ state: 'done', verified: false });
    expect(installable(none.dl.get('k'))).toBe(false);
  });
});
