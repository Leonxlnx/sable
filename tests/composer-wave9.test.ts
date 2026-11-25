/**
 * Review wave 9, the composer: words and files leave the field only for good (a refused send, a
 * queue edit the agent overtook, a first send from home whose message was refused, a command that
 * could not run), a message in the air lands only in its own chat, the ultracode chip follows the
 * session once the bridge answered, one resize observer per field, the pointer light off while the
 * governor sheds effects, the race's follow-up field on the cove, the working-tree menu's branch.
 * Pure helpers and a mocked bridge: no agent turns.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment } from '@shared/protocol';

const bridgeCalls: { method: string; params: unknown }[] = [];
let answer: (method: string, params: unknown) => unknown = () => ({});
vi.mock('@/lib/bridge', () => ({
  bridge: {
    status: 'closed',
    call: async (method: string, params: unknown) => {
      bridgeCalls.push({ method, params });
      const r = answer(method, params);
      if (r instanceof Error) throw r;
      return r;
    },
    on: () => () => {},
    onStatus: () => () => {},
  },
}));

const { leaveField, putBack, swapIn, shownUltra, ultraAnswered } = await import('../src/features/composer/restore');
const { claimable, flightKey, FRESH_SLACK_MS } = await import('../src/features/composer/flight');
const { watchWidth } = await import('../src/features/composer/width-watch');
const { spotLive } = await import('../src/ui/spot');

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const att = (id: string): Attachment => ({ id, kind: 'file', name: `${id}.txt`, path: `C:/x/${id}.txt` }) as Attachment;

describe('a send that leaves the field (finding 4)', () => {
  it('takes only the sent words and files: a file attached while the request was out stays', () => {
    const sent = { text: 'look at this', attachments: [att('A')] };
    // B attached while the message was on its way; the text is still the sent text.
    const left = leaveField({ text: 'look at this', attachments: [att('A'), att('B')] }, sent);
    expect(left).toEqual({ text: '', attachments: [att('B')] });
  });

  it('keeps words typed after the send', () => {
    expect(leaveField({ text: 'and the next', attachments: [att('A')] }, { text: 'first', attachments: [att('A')] })).toEqual({ text: 'and the next', attachments: [] });
  });

  it('refused: the sent file comes back beside the one added meanwhile, the words before the new ones', () => {
    const sent = { text: 'look at this', attachments: [att('A')] };
    const now = leaveField({ text: 'look at this', attachments: [att('A'), att('B')] }, sent);
    const typed = { ...now, text: 'also this' };
    expect(putBack(typed, sent)).toEqual({ text: 'look at this\nalso this', attachments: [att('A'), att('B')] });
    // Nothing typed: exactly as it was.
    expect(putBack(now, sent)).toEqual({ text: 'look at this', attachments: [att('A'), att('B')] });
    // Never a file twice.
    expect(putBack({ text: '', attachments: [att('A')] }, sent).attachments).toEqual([att('A')]);
  });
});

describe('Edit on a queued message (finding 3)', () => {
  it('swaps in the message, keeping what was typed or attached during the request', () => {
    const before = { text: 'draft B', attachments: [att('b')] };
    const got = { text: 'queued A', attachments: [att('a')] };
    // Nothing changed meanwhile: the field becomes A.
    expect(swapIn(before, before, got)).toEqual({ text: 'queued A', attachments: [att('a')] });
    // Typed on, and attached a file, while the bridge answered: nothing of it is lost.
    expect(swapIn({ text: 'draft B, more', attachments: [att('b'), att('c')] }, before, got)).toEqual({ text: 'queued A\ndraft B, more', attachments: [att('a'), att('c')] });
  });

  it('a take into an empty field keeps words typed meanwhile', () => {
    expect(swapIn({ text: 'typed', attachments: [] }, { text: '', attachments: [] }, { text: 'queued', attachments: [] })).toEqual({ text: 'queued\ntyped', attachments: [] });
  });

  it('the composer swaps only after the bridge said yes', () => {
    const src = read('src/features/composer/Composer.tsx');
    const edit = src.slice(src.indexOf('const editQueued'), src.indexOf('// ── ultracode'));
    expect(edit).toMatch(/const res = await updateQueued\([^)]*\);\s*if \(!res\.ok\) return;/);
    expect(edit.indexOf('updateQueued')).toBeLessThan(edit.indexOf('setDraft'));
    expect(edit).toContain('swapIn(useStore.getState().drafts[key], before');
  });
});

describe('bridge answers (findings 2, 3, 12)', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
    // A failure toasts, and a toast dismisses itself on a timer.
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });
  afterEach(() => {
    answer = () => ({});
    vi.unstubAllGlobals();
  });

  it('a first send from home whose message is refused reports the chat it made', async () => {
    const { startFromHome } = await import('../src/state/actions');
    const { useStore } = await import('../src/state/store');
    const s = useStore.getState();
    s.setUi({ homeCwd: 'C:/work', homeProvider: 'demo', homeChat: false });
    const meta = { id: 'new-1', provider: 'demo', cwd: 'C:/work', title: '', status: 'idle', createdAt: 1, updatedAt: 1 };
    answer = (m) => (m === 'session.create' ? { session: meta, items: [], roots: [], children: {} } : m === 'session.send' ? { ok: false, error: 'refused' } : {});
    let created = '';
    const res = await startFromHome('fix the tests', [att('A')], { onCreated: (id) => (created = id) });
    expect(res).toEqual({ ok: false, sessionId: 'new-1' });
    expect(created).toBe('new-1');
    expect(bridgeCalls.map((c) => c.method)).toEqual(['session.create', 'session.send']);
    // The composer then puts the words and files back under that chat (merged with what is there).
    const src = read('src/features/composer/Composer.tsx');
    expect(src).toContain('st.setDraft(res.sessionId, sendBack(pending, st.drafts[res.sessionId], res.sessionId));');
  });

  it('a first send that is taken reports ok', async () => {
    const { startFromHome } = await import('../src/state/actions');
    const meta = { id: 'new-2', provider: 'demo', cwd: 'C:/work', title: '', status: 'idle', createdAt: 1, updatedAt: 1 };
    answer = (m) => (m === 'session.create' ? { session: meta, items: [], roots: [], children: {} } : { ok: true });
    expect(await startFromHome('hello')).toEqual({ ok: true, sessionId: 'new-2' });
  });

  it('a queue edit the agent overtook answers ok: false (also when the bridge is unreachable)', async () => {
    const { updateQueued } = await import('../src/state/actions');
    answer = () => ({ ok: false });
    expect(await updateQueued('s', 'q1', 'draft B')).toEqual({ ok: false });
    answer = () => new Error('closed');
    expect(await updateQueued('s', 'q1', 'draft B')).toEqual({ ok: false });
  });

  it('/customize that cannot open its chat answers false, and the composer puts it back', async () => {
    const { APP_COMMANDS } = await import('../src/features/composer/commands');
    const cmd = APP_COMMANDS.find((c) => c.name === 'customize')!;
    answer = () => new Error('Not connected');
    const ctx = { sessionId: null, openModel() {}, openMode() {}, openEffort() {} };
    expect(await cmd.run(ctx, 'make the sidebar narrower')).toBe(false);
    // Typed meanwhile is kept, after the command.
    const typed = { text: '/customize make the sidebar narrower', attachments: [] };
    expect(putBack({ text: 'and darker', attachments: [] }, typed).text).toBe('/customize make the sidebar narrower\nand darker');
    const src = read('src/features/composer/Composer.tsx');
    expect(src).toMatch(/const ran = await cmd\.run\(ctx[^;]*;\s*if \(ran === false\) \{\s*setDraft\(key, putBack\(/);
  });
});

describe('a message in the air lands only in its own chat (finding 19)', () => {
  const t0 = 1_000_000;
  it('a row of another chat never claims it', () => {
    const f = flightKey('Continue', 'timeline', 'A', t0);
    expect(claimable(f, 'timeline', 'Continue', { session: 'A', ts: t0 + 50 })).toBe(true);
    expect(claimable(f, 'timeline', 'Continue', { session: 'B', ts: t0 + 50 })).toBe(false);
  });

  it('an old row with the same words never claims it', () => {
    const f = flightKey('Continue', 'timeline', 'A', t0);
    expect(claimable(f, 'timeline', 'Continue', { session: 'A', ts: t0 - 60_000 })).toBe(false);
    expect(claimable(f, 'timeline', 'Continue', { session: 'A', ts: t0 - FRESH_SLACK_MS + 1 })).toBe(true);
  });

  it('a first message from home claims in the chat it made, once scoped', () => {
    const f = flightKey('Start here', 'timeline', null, t0);
    expect(claimable(f, 'timeline', 'Start here', { session: 'new', ts: t0 + 10 })).toBe(true);
    expect(claimable({ ...f, session: 'new' }, 'timeline', 'Start here', { session: 'other', ts: t0 + 10 })).toBe(false);
  });

  it('the tray and the composer pass the chat; leaving a chat releases its flights', () => {
    expect(read('src/features/composer/QueueTray.tsx')).toContain('landInTray(el, q.text, sessionId)');
    expect(read('src/features/timeline/User.tsx')).toContain('session: sessionId, ts: item.ts');
    expect(read('src/features/composer/Composer.tsx')).toContain('holdFlights(sessionId)');
  });
});

describe('the ultracode chip (finding 20)', () => {
  it('follows the session once the bridge answered: turned off from another client it shows off', () => {
    // On here: the pick shows at once.
    let pick = { on: true, over: false, seq: 1 } as ReturnType<typeof ultraAnswered>;
    expect(shownUltra(false, pick)).toBe(true);
    // The bridge confirms (the session says true by then).
    pick = ultraAnswered(pick, 1);
    expect(shownUltra(true, pick)).toBe(true);
    // Another client turns it off: the chip says off (the old pick would have said on).
    expect(shownUltra(false, pick)).toBe(false);
  });

  it('a refused toggle leaves the session’s value', () => {
    const pick = ultraAnswered({ on: true, over: false, seq: 2 }, 2);
    expect(shownUltra(false, pick)).toBe(false);
  });

  it('an older answer never ends a newer pick', () => {
    const newer = { on: false, over: true, seq: 3 };
    expect(ultraAnswered(newer, 2)).toBe(newer);
  });
});

describe('one resize observer per field (finding 23)', () => {
  it('reports only real width changes, from the observer’s own numbers', () => {
    let made = 0;
    let fire: (w: number) => void = () => {};
    let disconnected = false;
    class FakeRO {
      constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
        made++;
        fire = (w) => cb([{ contentRect: { width: w } }]);
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    let calls = 0;
    const stop = watchWidth({} as Element, () => calls++);
    fire(600); // the mount
    fire(600);
    expect(calls).toBe(0);
    fire(580);
    expect(calls).toBe(1);
    fire(580);
    expect(calls).toBe(1);
    stop();
    expect(disconnected).toBe(true);
    expect(made).toBe(1);
    vi.unstubAllGlobals();
  });

  it('the composer makes it once (no measure in its deps)', () => {
    const src = read('src/features/composer/Composer.tsx');
    const block = src.slice(src.indexOf('const measureRef = useRef(measure);'));
    expect(block).toMatch(/watchWidth\(ta, \(\) => measureRef\.current\(\)\)[\s\S]*?\}, \[\]\);/);
  });
});

describe('the pointer light under the governor (finding 24)', () => {
  it('asks for no frame while effects are shed', () => {
    const env = { reduce: false, fine: true, shed: false };
    expect(spotLive({ pointerType: 'mouse' }, env)).toBe(true);
    expect(spotLive({ pointerType: 'mouse' }, { ...env, shed: true })).toBe(false);
    expect(spotLive({ pointerType: 'touch' }, env)).toBe(false);
    expect(spotLive({ pointerType: 'mouse' }, { ...env, reduce: true })).toBe(false);
  });

  it('goes dark the moment quality drops', () => {
    const src = read('src/ui/spot.ts');
    expect(src).toMatch(/attributeFilter: \['data-quality'\]/);
    expect(src).toMatch(/if \(shed\) clear\(\);/);
  });
});

describe('the race’s follow-up field (finding 21)', () => {
  it('wears the cove: the pane’s layers inside the card, the key in its corner, not in the bar', () => {
    const src = read('src/features/race/RaceView.tsx');
    const dock = src.slice(src.indexOf('function RaceDock'));
    const card = dock.slice(dock.indexOf('className="cmp-card"'));
    expect(card.indexOf('<CoveSkin />')).toBeGreaterThan(0);
    expect(card.indexOf('<CoveSkin />')).toBeLessThan(card.indexOf('className="cmp-field"'));
    const bar = card.slice(card.indexOf('className="cmp-bar"'), card.indexOf('<SendKey'));
    expect(bar).not.toContain('cmp-right');
    expect(card.indexOf('<SendKey')).toBeGreaterThan(card.indexOf('className="cmp-bar"'));
  });
});

describe('the working-tree menu (finding 26)', () => {
  it('gives the branch the room before the folder', () => {
    const css = read('src/features/composer/composer.css');
    const rule = /\.cm-row-dim \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/max-width: 35%;/);
  });
});

describe('ownership of a queued draft', () => {
  it('distinguishes a dropped reply from an explicit take', async () => {
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout() {} });
    try {
      const { takeQueued } = await import('../src/state/actions');
      answer = () => new Error('reply lost after removal');
      expect(await takeQueued('q', 'row')).toEqual({ kind: 'unknown' });
      answer = () => ({ taken: true });
      expect(await takeQueued('q', 'row')).toEqual({ kind: 'taken' });
    } finally { answer = () => ({}); vi.unstubAllGlobals(); }
  });

  it('keeps the preview after a lost reply and keeps files attached during a take', async () => {
    const { settleTake } = await import('../src/features/composer/restore');
    const preview = { text: 'queued', attachments: [att('a')] };
    expect(settleTake(preview, preview, { kind: 'unknown' })).toEqual(preview);
    const now = { ...preview, attachments: [...preview.attachments, att('b')] };
    expect(settleTake(now, preview, { kind: 'taken' })).toEqual(now);
    expect(settleTake(preview, preview, { kind: 'taken' })).toEqual({ text: '', attachments: [] });
    const message = { id: 'q', createdAt: 1, text: 'updated', attachments: [att('c')] };
    expect(settleTake(now, preview, { kind: 'message', message })).toEqual({ text: 'updated', attachments: [att('c'), att('b')] });
  });

  it('Enter during a take waits and only submits once ownership is confirmed', async () => {
    const { holdTake, waitForTake } = await import('../src/features/composer/pending');
    let resolve!: (owned: boolean) => void;
    const take = new Promise<boolean>(r => { resolve = r; });
    holdTake('enter', take);
    const send = vi.fn();
    const enter = async () => { if (await waitForTake('enter')) send(); };
    const first = enter(), second = enter();
    expect(send).not.toHaveBeenCalled();
    resolve(false);
    await Promise.all([first, second]);
    expect(send).not.toHaveBeenCalled();
    holdTake('enter', Promise.resolve(true));
    await Promise.all([enter(), enter()]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps full retry content before rewind and restores it on send failure', async () => {
    const { repeatMessage } = await import('../src/features/timeline/repeat-message');
    const { withPending } = await import('../src/features/composer/pending');
    const { useStore } = await import('../src/state/store');
    const draft = { text: 'again', attachments: [att('whole')] };
    const item = { ...draft, id: 'turn', type: 'user' as const, ts: 0 };
    const sends: unknown[] = [];
    answer = (method, params) => {
      if (method === 'session.rewind') { expect(withPending('retry', undefined)).toMatchObject(draft); return { ok: true }; }
      sends.push(params); return { ok: false };
    };
    try {
      await Promise.all([repeatMessage('retry', item, draft.text, 'retry'), repeatMessage('retry', item, draft.text, 'retry')]);
      expect(sends).toEqual([{ sessionId: 'retry', ...draft, submitId: expect.any(String) }]);
      expect(useStore.getState().drafts.retry).toMatchObject(draft);
    } finally { answer = () => ({}); }
  });
});

it('two footer presses during whole attachment loading make one submission', async () => {
  const { repeatMessage } = await import('../src/features/timeline/repeat-message');
  const { applySnapshot } = await import('../src/state/store');
  const cut = { id: 'p', type: 'user' as const, ts: 1, text: 'retry', more: true };
  const session: import('@shared/protocol').SessionMeta = {
    id: 'footer', provider: 'demo', title: '', titleSource: 'auto', cwd: '', status: 'idle', model: '', mode: 'default',
    createdAt: 0, updatedAt: 0, usage: { inputTokens: 0, outputTokens: 0, turns: 0 },
  };
  applySnapshot({ session, items: [cut], todos: [], permissions: [], questions: [], queue: [] });
  let resolve!: (answer: unknown) => void;
  const whole = new Promise(r => { resolve = r; });
  const sent: unknown[] = [];
  answer = (method, params) => {
    if (method === 'session.item') return whole;
    sent.push(params);
    return { ok: true };
  };
  try {
    const first = repeatMessage('footer', cut, cut.text, 'footer');
    const second = repeatMessage('footer', cut, cut.text, 'footer');
    const sameTurn = repeatMessage('footer', { ...cut, id: 'steer' }, 'steered', 'retry', cut.id);
    resolve({ item: { ...cut, more: false, attachments: [att('full')] } });
    await Promise.all([first, second, sameTurn]);
    expect(sent).toEqual([{ sessionId: 'footer', text: 'retry', attachments: [att('full')], submitId: expect.any(String) }]);
  } finally { answer = () => ({}); }
});

it('rewind and edit recovers whole files beside typing and never sends on its own', async () => {
  const { repeatMessage } = await import('../src/features/timeline/repeat-message');
  const { withPending } = await import('../src/features/composer/pending');
  const { useStore } = await import('../src/state/store');
  const key = 'edit-again';
  const item = { id: 'turn', type: 'user' as const, text: 'revise', ts: 0, attachments: [att('original')] };
  useStore.getState().setDraft(key, { text: 'my draft', attachments: [att('new')] });
  const before = bridgeCalls.length;
  answer = () => {
    expect(withPending(key, undefined).attachments).toEqual(item.attachments);
    return { ok: true };
  };
  try {
    expect(await repeatMessage(key, item, item.text, 'edit')).toBe(true);
    expect(useStore.getState().drafts[key]).toMatchObject({ text: 'revise\nmy draft', attachments: [att('original'), att('new')] });
    expect(bridgeCalls.slice(before).map(c => c.method)).toEqual(['session.rewind']);
  } finally { answer = () => ({}); }
});
