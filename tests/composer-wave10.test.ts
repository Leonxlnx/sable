/**
 * Review wave 10, sending (findings 2, 3, 4, 5, 8, 9; finding 1 in bridge-outbox.test.ts): a
 * message on its way is kept beside the draft and written on unload, refused messages go back in
 * the order they were sent and never merge with the same words typed again, what is typed on home
 * while its chat is made belongs to that chat alone, a race's retry goes only to the lane that
 * refused, `/spare` and `/until` hand back their outcome, a queue edit never overwrites another
 * window's edit. Pure helpers, a mocked bridge, and the bridge itself with the Demo agent.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../server/app';
import { DemoProvider } from '../server/providers/demo';
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

const { holdSend, sendBack, sendDone, draftsWithPending, resetPending } = await import('../src/features/composer/pending');
const { carryOver, leaveField, putBack } = await import('../src/features/composer/restore');
const { packDrafts, unpackDrafts } = await import('../src/features/composer/drafts');

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const att = (id: string): Attachment => ({ id, kind: 'file', name: `${id}.txt`, path: `C:/x/${id}.txt` }) as Attachment;
const d = (text: string, attachments: Attachment[] = []) => ({ text, attachments });

beforeEach(() => resetPending());

describe('a send not yet taken survives a reload (finding 2)', () => {
  it('is written with its draft, before what was typed since, and leaves once the bridge took it', () => {
    const p = holdSend('s1', d('deploy the fix'));
    // The field emptied as it left; the person typed on.
    const drafts = { s1: d('and then tag it'), s2: d('other chat') };
    const kept = unpackDrafts(JSON.stringify(packDrafts(draftsWithPending(drafts))));
    expect(kept.s1.text).toBe('deploy the fix\nand then tag it');
    expect(kept.s2.text).toBe('other chat');
    // A field left empty by the send still brings it back.
    expect(packDrafts(draftsWithPending({}))).toEqual({ s1: 'deploy the fix' });
    sendDone(p);
    expect(packDrafts(draftsWithPending(drafts)).s1).toBe('and then tag it');
  });

  it('the drafts writer writes again when a send is held or taken', () => {
    const src = read('src/features/composer/drafts.ts');
    expect(src).toContain('packDrafts(draftsWithPending(useStore.getState().drafts))');
    expect(src).toContain('onPending(soon)');
  });
});

describe('refused messages go back as they were sent (finding 9)', () => {
  it('the same words typed again are a second message', () => {
    const p = holdSend('s', d('yes'));
    // Typed after the send: leaveField keeps them though they match.
    const left = leaveField(d('yes'), d('yes'), true);
    expect(left.text).toBe('yes');
    expect(sendBack(p, left).text).toBe('yes\nyes');
    // putBack too never merges equal words.
    expect(putBack(d('yes'), d('yes')).text).toBe('yes\nyes');
  });

  it('two refused messages come back in the order they were sent, whichever is refused first', () => {
    const a = holdSend('s', d('first'));
    const b = holdSend('s', d('second'));
    let field = d('typed since');
    field = sendBack(a, field);
    expect(field.text).toBe('first\ntyped since');
    field = sendBack(b, field);
    expect(field.text).toBe('first\nsecond\ntyped since');

    resetPending();
    const c = holdSend('s', d('first', [att('A')]));
    const e = holdSend('s', d('second', [att('B')]));
    field = sendBack(e, d(''));
    field = sendBack(c, field);
    expect(field).toEqual({ text: 'first\nsecond', attachments: [att('A'), att('B')] });
  });

  it('a retry of the same message is the same submission; a changed one is new', () => {
    const p = holdSend('s', d('ship it', [att('A')]));
    const field = sendBack(p, d(''));
    const again = holdSend('s', field);
    expect(again.id).toBe(p.id);
    const back = sendBack(again, d(''));
    expect(holdSend('s', { ...back, text: 'ship it now' }).id).not.toBe(p.id);
  });

  it('the composer sends with the id and puts back through sendBack', () => {
    const src = read('src/features/composer/Composer.tsx');
    const submit = src.slice(src.indexOf('const submit = async'), src.indexOf('const submitRef'));
    expect(submit).toContain('const left = leaveField(now, draft, typed);');
    expect(submit).toContain('const pending = holdSend(key, draft);');
    expect(submit).toContain('setDraft(key, sendBack(pending, useStore.getState().drafts[key]));');
    expect(submit).toContain('submitId: pending.id');
  });
});

describe('home words belong to the chat the send made (finding 3)', () => {
  it('only that chat claims the flight and takes the draft, with or without the motion', async () => {
    const { bindHandoff, claimHandoff, takeHomeDraft } = await import('../src/features/home/handoff');
    bindHandoff('made');
    const card = {} as HTMLElement;
    // An existing chat opened meanwhile takes nothing.
    expect(claimHandoff(card, 'other')).toBe(false);
    expect(takeHomeDraft('other')).toBe(false);
    expect(takeHomeDraft('made')).toBe(true);
    expect(takeHomeDraft('made')).toBe(false);
  });

  it('carries words and files after what the chat holds', () => {
    expect(carryOver(undefined, d('and add tests', [att('A')]))).toEqual(d('and add tests', [att('A')]));
    expect(carryOver(d('refused first', [att('B')]), d('and add tests', [att('A'), att('B')]))).toEqual(d('refused first\nand add tests', [att('B'), att('A')]));
  });

  it('is bound before the chat opens, and the session composer carries it apart from the claim', async () => {
    const { startFromHome } = await import('../src/state/actions');
    const { useStore } = await import('../src/state/store');
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
    useStore.getState().setUi({ homeCwd: 'C:/work', homeProvider: 'demo', homeChat: false, activeSessionId: null });
    const meta = { id: 'made-2', provider: 'demo', cwd: 'C:/work', title: '', status: 'idle', createdAt: 1, updatedAt: 1 };
    let openWhenBound: string | null = 'unset';
    answer = (m) => (m === 'session.create' ? { session: meta, items: [], roots: [], children: {} } : { ok: true });
    await startFromHome('go', [], { onCreated: () => (openWhenBound = useStore.getState().ui.activeSessionId), submitId: 'sub' });
    expect(openWhenBound).toBe(null);
    expect(bridgeCalls.at(-1)).toMatchObject({ method: 'session.send', params: { submitId: 'sub' } });
    vi.unstubAllGlobals();
    answer = () => ({});
    const src = read('src/features/composer/Composer.tsx');
    expect(src).toContain('const claimed = claimHandoff(card.current, sessionId);');
    expect(src).toContain('const carried = takeHomeDraft(sessionId);');
  });
});

describe('a race follow-up refused by one lane (finding 4)', () => {
  it('is retried only where it was refused', async () => {
    const { retryTarget, raceTarget, setRaceTarget } = await import('../src/features/race/race');
    expect(retryTarget([0, 1], [true, false])).toBe('1');
    expect(retryTarget([0, 1], [false, true])).toBe('0');
    expect(retryTarget([0, 1], [false, false])).toBe('both');
    expect(retryTarget([0, 1], [true, true])).toBe(null);
    expect(retryTarget([1], [false])).toBe('1');
    // Kept with the race.
    setRaceTarget('r1', '1');
    expect(raceTarget('r1')).toBe('1');
    expect(raceTarget('r2')).toBe('both');
    const src = read('src/features/race/RaceView.tsx');
    expect(src).toContain('const retry = retryTarget(sides, results.map((r) => r.ok));');
    expect(src).toContain('setTarget(retry);');
  });
});

describe('/spare, /until, /rename and /model hand back their outcome (finding 5)', () => {
  beforeEach(() => {
    bridgeCalls.length = 0;
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {} });
  });
  afterEach(() => {
    answer = () => ({});
    vi.unstubAllGlobals();
  });
  const ctx = { sessionId: 's1', openModel() {}, openMode() {}, openEffort() {} };

  it('a refusal answers false, so the composer puts the command back', async () => {
    const { APP_COMMANDS } = await import('../src/features/composer/commands');
    const run = (name: string, arg: string) => APP_COMMANDS.find((c) => c.name === name)!.run(ctx, arg);
    answer = (m) => (m === 'spare.send' ? { ok: false, error: 'No account has spare quota' } : m === 'until.set' ? { ok: false, error: 'Another check runs' } : {});
    expect(await run('spare', 'write the changelog')).toBe(false);
    expect(await run('until', 'pnpm test --rounds 3')).toBe(false);
    answer = () => new Error('Not connected');
    expect(await run('spare', 'write the changelog')).toBe(false);
    expect(await run('until', 'pnpm test')).toBe(false);
    expect(await run('rename', 'Auth rewrite')).toBe(false);
    // Taken: true.
    answer = () => ({ ok: true });
    expect(await run('spare', 'write the changelog')).toBe(true);
    expect(await run('until', 'pnpm test')).toBe(true);
    expect(await run('rename', 'Auth rewrite')).toBe(true);
  });

  it('/model in a chat answers what the bridge said', async () => {
    const { modelCommand } = await import('../src/features/composer/model-command');
    const choice = { sessionId: 's1', caps: { models: [] }, provider: 'demo' } as never;
    answer = () => ({ ok: false, error: 'No model called x' });
    expect(await modelCommand('x', choice)).toBe(false);
    answer = () => ({ ok: true });
    expect(await modelCommand('x', choice)).toBe(true);
  });
});

describe('a queue edit never overwrites another window’s (finding 8)', () => {
  it('the bridge answers the message as the edit found it; the composer takes that one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sable-w10-'));
    const app = new App({ home, providers: [(c) => new DemoProvider(c, { speed: 0 })], quiet: true });
    try {
      const snap = await app.call('session.create', { provider: 'demo', cwd: path.join(home, 'relay-api'), mode: 'default' });
      const id = snap.session.id;
      const rt = app.runtime(id);
      await app.call('session.send', { sessionId: id, text: 'Refactor the session expiry logic out of the auth middleware' });
      const start = Date.now();
      while (!rt.snapshot().permissions.length && Date.now() - start < 6000) await new Promise((r) => setTimeout(r, 2));
      await app.call('session.send', { sessionId: id, text: 'old' });
      const [q] = rt.queue;
      // Window B edits it first; window A, which still shows "old", swaps its draft in.
      await app.call('queue.update', { sessionId: id, id: q.id, text: 'revised', attachments: [att('R')] });
      const res = await app.call('queue.update', { sessionId: id, id: q.id, text: 'draft of A' });
      expect(res).toMatchObject({ ok: true, previous: { id: q.id, text: 'revised', attachments: [{ id: 'R' }] } });
      expect(rt.queue[0].text).toBe('draft of A');
      // A phone gets no copy back (its own take path stays as it was).
      const phone = await app.call('queue.update', { sessionId: id, id: q.id, text: 'from the phone' }, { allowed: () => true });
      expect(phone).toEqual({ ok: true });
      // The same submission twice is one message.
      const before = rt.queue.length;
      await app.call('session.send', { sessionId: id, text: 'once', submitId: 'w10-1' });
      await app.call('session.send', { sessionId: id, text: 'once', submitId: 'w10-1' });
      expect(rt.queue.length).toBe(before + 1);
      await app.call('session.interrupt', { sessionId: id });
    } finally {
      await app.dispose();
      rmSync(home, { recursive: true, force: true });
    }
    const src = read('src/features/composer/Composer.tsx');
    expect(src).toContain('got = res.previous ?? q;');
  });
});
