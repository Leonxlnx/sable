import { describe, expect, it } from 'vitest';
import type { BridgeEvent, NoticeItem, PermissionRequest, QuestionRequest, SessionMeta, TimelineItem } from '../shared/protocol';
import { Attention, answerOf, cut, decide, firstSentence, type Signal, waitingChats, wordsFor } from '../src/lib/attention';
import { badgePixels, badgeText, readAttention, TaskbarAttention, type AttentionWindow } from '../electron/attention';
import { sameShown } from '../src/features/sidebar/status';
import { deckReducer, emptyDeck } from '../src/features/triage/deck';

const meta = (id: string, more: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'demo', cwd: '/w', title: 'Fix the login', titleSource: 'user', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 }, ...more }) as SessionMeta;

const status = (id: string, s: SessionMeta['status'], more: Partial<SessionMeta> = {}): BridgeEvent => ({ type: 'session.updated', id, patch: { status: s, ...more } });
const user = (id: string, n: number): BridgeEvent => ({ type: 'item.added', sessionId: id, item: { id: `u${n}`, type: 'user', text: 'go', ts: n } as TimelineItem });
const text = (id: string, n: number, t: string): BridgeEvent => ({ type: 'item.added', sessionId: id, item: { id: `t${n}`, type: 'text', text: t, streaming: false, ts: n } as TimelineItem });
const tool = (id: string, n: number, kind: string): BridgeEvent => ({ type: 'item.added', sessionId: id, item: { id: `s${n}`, type: 'tool', name: 'X', kind, title: 'x', status: 'done', detail: {}, ts: n } as unknown as TimelineItem });
const perm = (id: string, pid: string, more: Partial<PermissionRequest> = {}): BridgeEvent => ({
  type: 'permission.added',
  request: { id: pid, sessionId: id, toolName: 'Bash', kind: 'bash', title: 'Run npm test', detail: { command: 'npm test' }, options: [], createdAt: 1, ...more },
});
const question = (id: string, qid: string, q: string): BridgeEvent => ({ type: 'question.added', request: { id: qid, sessionId: id, questions: [{ question: q, options: [] }], createdAt: 1 } as QuestionRequest });
const limitCard = (id: string, nid: string, limit: NoticeItem['limit']): BridgeEvent => ({ type: 'item.added', sessionId: id, item: { id: nid, type: 'notice', variant: 'error', text: 'limit', limit, ts: 9 } as TimelineItem });

/** Feeds a sequence and gathers what came of it. */
function run(a: Attention, events: BridgeEvent[]): Signal[] {
  return events.flatMap((e) => a.feed(e));
}

function fresh(...metas: SessionMeta[]) {
  const a = new Attention();
  a.seed(metas.length ? metas : [meta('c')]);
  return a;
}

describe('the rule: what a chat says', () => {
  it('a turn the person began says it finished, with the answer s first sentence', () => {
    const a = fresh();
    const out = run(a, [user('c', 1), status('c', 'running'), text('c', 2, 'Let me run the tests.'), tool('c', 3, 'bash'), text('c', 4, 'The **login** now keeps the session. I also added a test.'), status('c', 'idle')]);
    expect(out).toEqual([{ kind: 'finished', chat: 'c', answer: 'The login now keeps the session.' }]);
  });

  it('the answer skips a closing nod ("Committed.") for the words before it', () => {
    const a = fresh();
    const out = run(a, [user('c', 1), status('c', 'running'), text('c', 2, 'Fixed the race in the queue.'), text('c', 3, 'Committed.'), status('c', 'idle')]);
    expect(out[0]).toMatchObject({ kind: 'finished', answer: 'Fixed the race in the queue.' });
  });

  it('streamed text counts (item.delta), bounded', () => {
    const a = fresh();
    run(a, [user('c', 1), status('c', 'running'), text('c', 2, '')]);
    a.delta('c', 't2', 'text', 'All forty tests ');
    a.delta('c', 't2', 'text', 'pass now. Nothing else changed.');
    a.delta('c', 't2', 'text', 'x'.repeat(5000));
    expect(run(a, [status('c', 'idle')])[0]).toMatchObject({ answer: 'All forty tests pass now.' });
  });

  it('a turn the agent began by itself that changed nothing is no news', () => {
    const a = fresh();
    expect(run(a, [user('c', 1), status('c', 'running'), status('c', 'idle')])).toHaveLength(1);
    // A wake: no message of the person before it.
    expect(run(a, [status('c', 'running'), text('c', 5, 'The watcher is still running.'), status('c', 'idle')])).toEqual([]);
  });

  it('a wake that changed files is news (an edit step, or more to review)', () => {
    const a = fresh();
    run(a, [user('c', 1), status('c', 'running'), status('c', 'idle')]);
    expect(run(a, [status('c', 'running'), tool('c', 5, 'edit'), status('c', 'idle')])).toHaveLength(1);
    expect(run(a, [status('c', 'running'), { type: 'session.updated', id: 'c', patch: { review: 3 } }, status('c', 'idle')])).toHaveLength(1);
  });

  it('a turn inside an /until loop is not news; the loop s end is', () => {
    const a = fresh(meta('c', { until: { check: 'pnpm test' } as SessionMeta['until'] }));
    expect(run(a, [user('c', 1), status('c', 'running'), status('c', 'idle')])).toEqual([]);
    expect(run(a, [{ type: 'session.updated', id: 'c', patch: { until: null } }, user('c', 2), status('c', 'running'), status('c', 'idle')])).toHaveLength(1);
  });

  it('a failed turn says so, also inside /until, and also for a wake', () => {
    const a = fresh(meta('c', { until: { check: 'x' } as SessionMeta['until'] }));
    expect(run(a, [status('c', 'running'), status('c', 'error', { lastError: 'Process exited with code 1\nstack' })])).toEqual([{ kind: 'failed', chat: 'c', error: 'Process exited with code 1' }]);
  });

  it('a permission waits: once per request, first only when nothing waited before', () => {
    const a = fresh();
    const out = run(a, [user('c', 1), status('c', 'running'), perm('c', 'p1'), status('c', 'awaiting'), perm('c', 'p1'), perm('c', 'p2')]);
    expect(out).toEqual([
      { kind: 'waiting', chat: 'c', need: { kind: 'permission', id: 'p1', tool: 'bash', plan: false }, first: true },
      { kind: 'waiting', chat: 'c', need: { kind: 'permission', id: 'p2', tool: 'bash', plan: false }, first: false },
    ]);
    // Answered: awaiting -> running is the same turn, no news; then it ends.
    expect(run(a, [{ type: 'permission.removed', sessionId: 'c', id: 'p1' }, { type: 'permission.removed', sessionId: 'c', id: 'p2' }, status('c', 'running'), status('c', 'idle')])).toHaveLength(1);
    expect(a.waits('c')).toBe(false);
  });

  it('a plan to approve and a question', () => {
    const a = fresh();
    const out = run(a, [perm('c', 'p', { toolName: 'ExitPlanMode', kind: 'plan', title: 'Present plan' }), question('c', 'q', 'Which logger?\nPick one.')]);
    expect(out.map((s) => s.kind === 'waiting' && s.need)).toEqual([
      { kind: 'permission', id: 'p', tool: 'plan', plan: true },
      { kind: 'question', id: 'q', text: 'Which logger?' },
    ]);
  });

  it('refreshes a sidebar row for review and mute alone', () => {
    const s = meta('c', { review: 1 });
    expect(sameShown(s, { ...s, review: undefined })).toBe(false);
    expect(sameShown(s, { ...s, muted: true })).toBe(false);
    expect(sameShown(s, { ...s, model: 'other' })).toBe(true);
  });

  it('reconnect replaces prompts answered away and keeps the other chat waiting', () => {
    const a = fresh(meta('a'), meta('b'));
    run(a, [perm('a', 'old'), question('b', 'kept', 'Still waiting')]);
    a.seedPrompts([], [{ sessionId: 'b', id: 'kept' } as QuestionRequest]);
    expect(a.waits('a')).toBe(false);
    expect(a.waits('b')).toBe(true);
    expect(run(a, [user('a', 1), status('a', 'running'), status('a', 'idle')])).toMatchObject([{ kind: 'finished' }]);
    expect(a.feed(perm('a', 'next'))[0]).toMatchObject({ first: true });
  });

  it('prompts known at start-up are not news', () => {
    const a = fresh();
    a.seedPrompts([{ id: 'p1', sessionId: 'c' } as PermissionRequest], []);
    expect(run(a, [perm('c', 'p1')])).toEqual([]);
    expect(a.waits('c')).toBe(true);
  });

  it('a limit card that owes a decision waits; carried on, it does not; the turn s end stays quiet meanwhile', () => {
    const a = fresh();
    run(a, [user('c', 1), status('c', 'running')]);
    // Undecided (no provider yet), then decided by the bridge with no account to go on with.
    expect(run(a, [limitCard('c', 'n1', { origin: 'user' })])).toEqual([]);
    const owed = run(a, [{ type: 'item.patch', sessionId: 'c', id: 'n1', patch: { limit: { origin: 'user', provider: 'claude', window: '5-hour limit' } } as Partial<TimelineItem> }]);
    expect(owed).toEqual([{ kind: 'waiting', chat: 'c', need: { kind: 'limit', id: 'n1', text: '5-hour limit reached' }, first: true }]);
    expect(run(a, [status('c', 'idle')])).toEqual([]);
    expect(a.limitChats()).toEqual(['c']);
    // The person chose "Continue at reset".
    run(a, [{ type: 'item.patch', sessionId: 'c', id: 'n1', patch: { limit: { origin: 'user', provider: 'claude', atReset: true } } as Partial<TimelineItem> }]);
    expect(a.limitChats()).toEqual([]);
  });

  it('a limit the bridge moves on by itself owes nothing', () => {
    const a = fresh();
    expect(run(a, [limitCard('c', 'n', { provider: 'claude', next: 'b', moving: true })])).toEqual([]);
    expect(run(a, [limitCard('c', 'n2', { provider: 'claude', continuedWith: 'b' })])).toEqual([]);
  });

  it('a new turn puts an owed limit card behind it', () => {
    const a = fresh();
    run(a, [limitCard('c', 'n', { provider: 'claude' })]);
    expect(a.limitWaits('c')).toBe(true);
    run(a, [user('c', 2), status('c', 'running')]);
    expect(a.limitWaits('c')).toBe(false);
  });

  it('a snapshot (timeline.reset) tells the owed cards of a chat read later', () => {
    const a = fresh();
    run(a, [{ type: 'timeline.reset', sessionId: 'c', items: [{ id: 'n', type: 'notice', variant: 'error', text: '', limit: { provider: 'codex' }, ts: 1 } as TimelineItem] }]);
    expect(a.limitWaits('c')).toBe(true);
  });

  it('work lost and the agent woken', () => {
    const a = fresh(meta('c', { lossWake: { attempts: [1] } }));
    expect(run(a, [{ type: 'session.updated', id: 'c', patch: { lossWake: { attempts: [1] } } }])).toEqual([]);
    const receipt = (attempts: number[], delivered?: string) => a.feed({ type: 'session.updated', id: 'c', patch: { lossWake: { attempts, delivered } } });
    expect(receipt([1, 2])).toEqual([]);
    expect(receipt([1, 2], 'batch-one')).toEqual([{ kind: 'lost', chat: 'c' }]);
    expect(receipt([2, 3], 'batch-one')).toEqual([]);
    expect(receipt([2, 3], 'batch-two')).toEqual([{ kind: 'lost', chat: 'c' }]);
  });

  it('a chat first seen mid-turn counts its end as the person s (its start was not seen)', () => {
    const a = new Attention();
    expect(a.feed(status('c', 'idle'), meta('c', { status: 'running' }))).toHaveLength(1);
  });

  it('chats are apart', () => {
    const a = fresh(meta('a'), meta('b'));
    const out = run(a, [user('a', 1), status('a', 'running'), status('b', 'running'), status('b', 'idle'), status('a', 'idle')]);
    expect(out.map((s) => s.chat)).toEqual(['a']);
  });
});

describe('the rule: what a signal does', () => {
  const sig: Signal = { kind: 'waiting', chat: 'c', need: { kind: 'question', id: 'q', text: 'Which?' }, first: true };
  const away = { enabled: true, muted: false, onScreen: false, focused: false, typing: false };

  it('away: a notification and one flash for a chat that starts waiting', () => {
    expect(decide(sig, away)).toEqual({ notify: true, flash: true });
    expect(decide({ ...sig, first: false }, away)).toEqual({ notify: true, flash: false });
    expect(decide({ kind: 'finished', chat: 'c' }, away)).toEqual({ notify: true, flash: false });
  });

  it('the chat on screen in a focused window: nothing', () => {
    expect(decide(sig, { ...away, onScreen: true, focused: true })).toEqual({ notify: false, flash: false });
  });

  it('on screen but the window is not focused: notified and flashed', () => {
    expect(decide(sig, { ...away, onScreen: true })).toEqual({ notify: true, flash: true });
  });

  it('another chat while the window is focused: notified, no flash', () => {
    expect(decide(sig, { ...away, focused: true })).toEqual({ notify: true, flash: false });
  });

  it('muted, typing in it, or the master switch off: nothing', () => {
    expect(decide(sig, { ...away, muted: true })).toEqual({ notify: false, flash: false });
    expect(decide(sig, { ...away, typing: true })).toEqual({ notify: false, flash: false });
    expect(decide(sig, { ...away, enabled: false })).toEqual({ notify: false, flash: false });
  });

  it('the taskbar s figure counts chats, not prompts, and only known ones', () => {
    expect(waitingChats(['a', 'a', 'b'], ['b', 'c', 'gone'], (id) => id !== 'gone')).toBe(3);
  });
});

describe('the words', () => {
  it('title is the chat s name; the body says what it needs', () => {
    expect(wordsFor({ kind: 'waiting', chat: 'c', first: true, need: { kind: 'permission', id: 'p', tool: 'bash', plan: false } }, 'Fix the login')).toEqual({ title: 'Fix the login', body: 'Waits for approval: Run a command' });
    expect(wordsFor({ kind: 'waiting', chat: 'c', first: true, need: { kind: 'permission', id: 'p', tool: 'plan', plan: true } }, 'x').body).toBe('Plan to approve');
    expect(wordsFor({ kind: 'finished', chat: 'c' }, '').title).toBe('Untitled');
    expect(wordsFor({ kind: 'finished', chat: 'c', answer: 'Done.' }, 'x').body).toBe('Finished');
    expect(wordsFor({ kind: 'failed', chat: 'c', error: 'Exit 1' }, 'x').body).toBe('Failed');
    for (const [kind, label] of [['edit', 'Edit a file'], ['fetch', 'Read a page']] as const) {
      const [signal] = fresh().feed(perm('c', 'p', { kind, title: 'Private project details' }));
      expect(wordsFor(signal, 'Chat')).toEqual({ title: 'Chat', body: 'Waits for approval: ' + label });
    }
    expect(wordsFor(fresh().feed(question('c', 'q', 'Private question?'))[0], 'Chat').body).toBe('Asks you a question');
    expect(wordsFor(fresh().feed(limitCard('c', 'l', { provider: 'demo', window: 'Weekly' }))[0], 'Chat').body).toBe('Limit reached');
    expect(wordsFor({ kind: 'lost', chat: 'c' }, 'Chat').body).toBe('Background work was lost');
  });

  it('a long sentence is cut at a word, never mid-word', () => {
    const s = firstSentence('The session module now ' + 'reads its configuration once at start-up and '.repeat(5) + 'end.')!;
    expect(s.length).toBeLessThanOrEqual(111);
    expect(s.endsWith('…')).toBe(true);
    expect(s.slice(0, -1).endsWith(' ')).toBe(false);
    expect('The session module now reads its configuration once at start-up and'.startsWith(s.slice(0, 40))).toBe(true);
    expect(cut('abc def', 100)).toBe('abc def');
  });

  it('markdown goes, code blocks too; a heading line is skipped to the sentence', () => {
    expect(firstSentence('## Summary\n\nUpdated `store.ts` and [the docs](http://x). More.')).toBe('Summary');
    expect(firstSentence('```ts\nconst a = 1;\n```\nThe build passes.')).toBe('The build passes.');
    expect(answerOf([{ text: 'Now the CSS.' }])).toBeUndefined();
  });
});

describe('the taskbar (electron/attention.ts)', () => {
  function fakeWindow(focused = false) {
    const calls: unknown[][] = [];
    const w: AttentionWindow & { focused: boolean } = {
      focused,
      setOverlayIcon: (img, d) => calls.push(['overlay', img, d]),
      flashFrame: (f) => calls.push(['flash', f]),
      isFocused: () => w.focused,
      isDestroyed: () => false,
    };
    return { w, calls };
  }

  it('Windows: the overlay follows the count, one flash, stopped on focus and when nothing waits', () => {
    const t = new TaskbarAttention({ platform: 'win32', image: (n) => `img${n}` });
    const { w, calls } = fakeWindow();
    t.set(w, { count: 1, flash: true });
    t.set(w, { count: 2, flash: true });
    t.set(w, { count: 2, flash: false });
    expect(calls).toEqual([
      ['overlay', 'img1', '1 chat waiting on you'],
      ['flash', true],
      ['overlay', 'img2', '2 chats waiting on you'],
    ]);
    t.stop(w);
    t.stop(w);
    t.set(w, { count: 0, flash: false });
    expect(calls.slice(3)).toEqual([['flash', false], ['overlay', null, '']]);
  });

  it('no flash while the window is focused', () => {
    const t = new TaskbarAttention({ platform: 'win32', image: () => 'i' });
    const { w, calls } = fakeWindow(true);
    t.set(w, { count: 1, flash: true });
    expect(calls).toEqual([['overlay', 'i', '1 chat waiting on you']]);
  });

  it('nothing waits any more: a running flash stops', () => {
    const t = new TaskbarAttention({ platform: 'win32', image: () => 'i' });
    const { w, calls } = fakeWindow();
    t.set(w, { count: 1, flash: true });
    t.set(w, { count: 0, flash: false });
    expect(calls).toEqual([['overlay', 'i', '1 chat waiting on you'], ['flash', true], ['overlay', null, ''], ['flash', false]]);
  });

  it('a Mac: the Dock s badge and one bounce', () => {
    const dock = { badge: '', bounces: 0, cancelled: 0, setBadge(s: string) { this.badge = s; }, bounce() { this.bounces++; return 7; }, cancelBounce() { this.cancelled++; } };
    const t = new TaskbarAttention({ platform: 'darwin', image: () => null, dock });
    const { w, calls } = fakeWindow();
    t.set(w, { count: 12, flash: true });
    expect([dock.badge, dock.bounces, calls.length]).toEqual(['9+', 1, 0]);
    t.stop(w);
    expect(dock.cancelled).toBe(1);
  });

  it('Linux and the rest: nothing', () => {
    const t = new TaskbarAttention({ platform: 'linux', image: () => 'i' });
    const { w, calls } = fakeWindow();
    t.set(w, { count: 3, flash: true });
    expect(calls).toEqual([]);
  });

  it('the page s message is read narrowly', () => {
    expect(readAttention({ count: 2.7, flash: 'yes' })).toEqual({ count: 2, flash: false });
    expect(readAttention({ count: 1e9, flash: true })).toEqual({ count: 999, flash: true });
    expect(readAttention({ count: 'x' })).toBeNull();
    expect(readAttention(null)).toBeNull();
  });

  it('the overlay: an ink disc, an amber rim, an ivory figure, transparent corners', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(10)).toBe('9+');
    for (const size of [16, 20, 24, 32]) {
      const px = badgePixels(1, size);
      expect(px.length).toBe(size * size * 4);
      const at = (x: number, y: number) => [...px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
      expect(at(0, 0)[3]).toBe(0);
      // The rim at the top centre is amber (BGRA).
      const top = at(Math.floor(size / 2), 0);
      expect(top[2]).toBeGreaterThan(150);
      expect(top[2]).toBeGreaterThan(top[0] + 60);
      // Some pixels are ivory: the figure.
      let ivory = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) ivory++;
      expect(ivory).toBeGreaterThan(size / 2);
    }
  });
});

describe('the deck opens on the asked card', () => {
  it('raise brings a card to the front and keeps the order behind it', () => {
    const s = emptyDeck(['a', 'b', 'c', 'd']);
    expect(deckReducer(s, { type: 'raise', key: 'c' }).order).toEqual(['c', 'd', 'a', 'b']);
    expect(deckReducer(s, { type: 'raise', key: 'a' })).toBe(s);
    expect(deckReducer(s, { type: 'raise', key: 'zz' })).toBe(s);
  });
});
