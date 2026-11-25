import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PHONE_METHODS, type PermissionRequest, type PhonePermission } from '@shared/protocol';
import { confirmKept, draftChanged, forgetSubmissions, submissionDone, submissionFor, submissionUnsure, unsureOf } from '../mobile/src/lib/submit';
import { forgetShown, permissionShown, shownPermissions } from '../mobile/src/lib/shown';
import { runForget } from '../mobile/src/lib/forget';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const pic = (id: string) => ({ id });
let n = 0;
const next = () => `id-${++n}`;

beforeEach(() => {
  n = 0;
  forgetSubmissions();
  forgetShown();
});

describe('a send from the phone has one id (review 0235b, finding 4)', () => {
  it('is made with the words and files before the first request, and a retry after a cut connection carries it again', () => {
    const first = submissionFor('chat', 'ship it', [pic('a')], next);
    expect(first).toMatchObject({ id: 'id-1', text: 'ship it' });
    // The connection cut the answer off: the words are back in the field, the send is kept.
    submissionUnsure('chat', first.id);
    expect(unsureOf('chat').map((s) => s.id)).toEqual(['id-1']);
    // Send again, the same words and files: the same id, so the desktop answers without sending twice.
    expect(submissionFor('chat', 'ship it', [pic('a')], next).id).toBe('id-1');
    // Other words, other files or another chat are other messages.
    expect(submissionFor('chat', 'ship it now', [pic('a')], next).id).toBe('id-2');
    expect(submissionFor('chat', 'ship it', [pic('b')], next).id).toBe('id-3');
    expect(submissionFor('other', 'ship it', [pic('a')], next).id).toBe('id-4');
  });

  it('is done with once the desktop answered: the same words sent later are a new message', () => {
    const a = submissionFor('chat', 'ok', undefined, next);
    submissionDone('chat', a.id);
    expect(unsureOf('chat')).toEqual([]);
    expect(submissionFor('chat', 'ok', undefined, next).id).toBe('id-2');
  });

  it('belongs to the field’s words as they were put back: edited or typed anew, it is let go', () => {
    const a = submissionFor('chat', 'ok', undefined, next);
    submissionUnsure('chat', a.id);
    // The field still holds exactly them (as restored): kept.
    draftChanged('chat', 'ok', []);
    draftChanged('chat', ' ok ', undefined);
    expect(unsureOf('chat')).toHaveLength(1);
    // One more letter, then the same words again: a new message with a new id.
    draftChanged('chat', 'ok!', []);
    expect(unsureOf('chat')).toEqual([]);
    expect(submissionFor('chat', 'ok', undefined, next).id).toBe('id-2');
    // Its pictures gone from the field (the chat was left and opened again): no longer that send.
    const b = submissionFor('chat', 'look', [pic('p')], next);
    submissionUnsure('chat', b.id);
    draftChanged('chat', 'look', []);
    expect(unsureOf('chat').map((s) => s.id)).not.toContain(b.id);
  });

  it('a send still on its way is not let go by the field clearing at the press', () => {
    const a = submissionFor('chat', 'ok', undefined, next);
    draftChanged('chat', '', []);
    submissionUnsure('chat', a.id);
    expect(unsureOf('chat').map((s) => s.id)).toEqual(['id-1']);
  });

  it('is settled by the desktop’s yes under its own id, and by nothing else', async () => {
    const sub = submissionFor('chat', 'ship it', undefined, next);
    submissionUnsure('chat', sub.id);
    const asked: string[] = [];
    const ask = (answer: { ok?: boolean; submitId?: string } | undefined) => (id: string) => (asked.push(id), Promise.resolve(answer));
    // It never arrived: kept, so the retry carries its id.
    expect(await confirmKept('chat', ask({ ok: false, submitId: sub.id }))).toEqual([]);
    // A yes that names no id (an older desktop) or another id is no receipt of this send.
    expect(await confirmKept('chat', ask({ ok: true }))).toEqual([]);
    expect(await confirmKept('chat', ask({ ok: true, submitId: 'someone-else' }))).toEqual([]);
    // The question got no answer: still not known.
    expect(await confirmKept('chat', () => Promise.reject(new Error('The connection to the desktop was lost')))).toEqual([]);
    expect(unsureOf('chat').map((s) => s.id)).toEqual([sub.id]);
    // The desktop has it, under this very id: done with.
    expect((await confirmKept('chat', ask({ ok: true, submitId: sub.id }))).map((s) => s.id)).toEqual([sub.id]);
    expect(unsureOf('chat')).toEqual([]);
    expect(asked.every((id) => id === sub.id)).toBe(true);
    // Only a kept send is asked about, in its own chat.
    asked.length = 0;
    submissionFor('chat', 'on its way', undefined, next);
    await confirmKept('chat', ask({ ok: true }));
    await confirmKept('elsewhere', ask({ ok: true }));
    expect(asked).toEqual([]);
  });

  it('a yes that comes after the words were edited settles nothing', async () => {
    const sub = submissionFor('chat', 'ship it', undefined, next);
    submissionUnsure('chat', sub.id);
    const got = confirmKept('chat', async (id) => {
      draftChanged('chat', 'ship it tomorrow', []);
      return { ok: true, submitId: id };
    });
    expect(await got).toEqual([]);
  });

  it('is forgotten with the computer', async () => {
    submissionUnsure('chat', submissionFor('chat', 'ok', undefined, next).id);
    await runForget();
    expect(unsureOf('chat')).toEqual([]);
  });

  it('the composer sends it, keeps it on a cut connection and clears the field on its receipt alone', () => {
    const screen = read('mobile/src/screens/Composer.tsx');
    expect(screen).toMatch(/const sub = submissionFor\(sid, t, attachments\);\s*try \{\s*const r = await conn\.call\('session\.send', \{ sessionId: sid, text: t, attachments, submitId: sub\.id \}\);\s*submissionDone\(sid, sub\.id\);/);
    expect(screen).toMatch(/if \(LOST\.test\(msg\)\) submissionUnsure\(sid, sub\.id\);\s*else submissionDone\(sid, sub\.id\);/);
    // Asked once connected, by id, with the question that sends nothing; the field goes only when it still holds that send.
    expect(screen).toMatch(/if \(!online\) return;\s*const e = epoch\(\);\s*void confirmKept\(sid, \(submitId\) => conn\.call\('session\.submission', \{ sessionId: sid, submitId \}\)\)/);
    expect(screen).toMatch(/if \(!got\.some\(\(sub\) => el\.value\.trim\(\) === sub\.text && filesKey\(filesNow\.current\) === sub\.files\)\) return;/);
    expect(screen).toMatch(/useEffect\(\(\) => draftChanged\(sid, text, files\), \[sid, text, files\]\);/);
    // The old rule (the newest message of the same words within 15 s) is gone.
    expect(screen).not.toMatch(/lastUser|u\.at - 15_000|const unsure = new Map/);
    // The phone may ask it.
    expect(PHONE_METHODS).toContain('session.submission');
    // A review and the "Continue" of an ended turn carry one id each too.
    expect(read('mobile/src/lib/comments.ts')).toMatch(/const sub = submissionFor\(sid, text, undefined\);\s*const r = await conn\.call\('session\.send', \{ sessionId: sid, text, submitId: sub\.id \}\)/);
    expect(read('mobile/src/screens/Timeline.tsx')).toMatch(/submitId\.current \?\?= crypto\.randomUUID\(\);\s*void conn\.call\('session\.send', \{ sessionId: sid, text: 'Continue', submitId: submitId\.current \}\)/);
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
