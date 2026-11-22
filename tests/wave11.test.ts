/**
 * Review wave 11 (the last check before 0.2.17): one case per finding that was fixed.
 * (#2, the failed logs of another repository, is in tests/pulls-status.test.ts.)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Submissions, messagePrint } from '../server/core/submissions';
import { checkoutTop, findProgram } from '../server/util/which';
import { holdSend, moveSend, resetPending, sendBack, sendDone, withPending } from '../src/features/composer/pending';
import { withFailures } from '../src/features/rail/pull-status';
import { isLeadIn } from '../src/features/timeline/lead-in';

const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

describe('#1: a tool never comes from the checkout the folder belongs to', () => {
  const tree = new Set([path.resolve('/work/app/.git'), path.resolve('/home/me/.git')]);
  const exists = (p: string) => tree.has(path.resolve(p));
  const home = path.resolve('/home/me');

  it('finds the top of the checkout from a subfolder', () => {
    expect(checkoutTop('/work/app/packages/web', { exists, home })).toBe(path.resolve('/work/app'));
    expect(checkoutTop('/work/app', { exists, home })).toBe(path.resolve('/work/app'));
    expect(checkoutTop('/work/other', { exists, home })).toBeNull();
  });

  it('never takes a home folder that is itself a repository (dotfiles): the tools under it are the person\'s own', () => {
    expect(checkoutTop('/home/me/notes', { exists, home })).toBeNull();
    expect(checkoutTop('/home/me', { exists, home })).toBeNull();
  });

  it('a program in a sibling folder of the same checkout is not run', () => {
    const top = 'C:\\work\\app';
    const sub = 'C:\\work\\app\\packages\\web';
    const files = new Set(['c:\\work\\app\\tools\\gh.exe', 'c:\\program files\\github cli\\gh.exe']);
    const o = { platform: 'win32' as const, env: { Path: 'C:\\work\\app\\tools;C:\\Program Files\\GitHub CLI' }, isProgram: (f: string) => files.has(f.toLowerCase()), real: (f: string) => f };
    // Excluding only the subfolder lets the checkout's own gh through: what the review found.
    expect(findProgram('gh', { ...o, outside: [sub] })?.toLowerCase()).toBe('c:\\work\\app\\tools\\gh.exe');
    expect(findProgram('gh', { ...o, outside: [sub, top] })?.toLowerCase()).toBe('c:\\program files\\github cli\\gh.exe');
    // And both lookups pass the folders of the project, not the folder alone.
    expect(read('server/services/pulls.ts')).toContain("findProgram('gh', { outside: projectFolders(cwd) })");
    expect(read('server/services/git.ts')).toContain("findProgram('git', { outside: projectFolders(dir) })");
  });
});

describe('#3: failures from GitHub never ride behind a shell line or a command', () => {
  const report = '2 of 5 checks failed on pull request #128\n- lint';

  it('goes after what is typed in a plain draft, and first when the draft begins with ! or /', () => {
    expect(withFailures('Fix these.', report)).toBe(`Fix these.\n\n${report}`);
    expect(withFailures('', report)).toBe(report);
    for (const typed of ['!git status', '  !npm test', '/until npm test', '/race fix it']) {
      const out = withFailures(typed, report);
      expect(out.startsWith(report), typed).toBe(true);
      expect(/^\s*[!/]/.test(out), typed).toBe(false);
      expect(out).toContain(typed.trim());
      // A second click adds nothing.
      expect(withFailures(out, report)).toBe(out);
    }
  });
});

describe('#4: a first send from home is its chat\'s once the chat exists', () => {
  it('moves with the chat: a reload brings the words back there, not to home', () => {
    resetPending();
    const draft = { text: 'build the thing', attachments: [] };
    const p = holdSend('home', draft);
    expect(withPending('home', undefined).text).toBe('build the thing');
    moveSend(p, 's1');
    expect(withPending('home', undefined).text).toBe('');
    expect(withPending('s1', undefined).text).toBe('build the thing');
    // Accepted: gone from both.
    sendDone(p);
    expect(withPending('s1', undefined).text).toBe('');
    // Refused after the chat was made: back in that chat's field.
    const q = holdSend('home', draft);
    moveSend(q, 's2');
    expect(sendBack(q, undefined, 's2').text).toBe('build the thing');
    expect(withPending('s2', undefined).text).toBe('');
    expect(read('src/features/composer/Composer.tsx')).toMatch(/bindHandoff\(id\);\s*moveSend\(pending, id\);/);
  });
});

describe('#7: a submission id answers only the message it was given for', () => {
  it('the same id with other words is sent, not answered with the first result', async () => {
    const subs = new Submissions<{ ok: boolean; n?: number }>();
    let n = 0;
    const send = async () => ({ ok: true, n: ++n });
    const a = messagePrint('one', [], false);
    const b = messagePrint('two', [], false);
    expect(a).not.toBe(b);
    expect(messagePrint('one', [{ id: 'f1' }], false)).not.toBe(a);
    expect(messagePrint('one', [], true)).not.toBe(a);
    expect(await subs.run('s', 'id-1', send, a)).toEqual({ ok: true, n: 1 });
    // A retry of the same message: answered, not sent.
    expect(await subs.run('s', 'id-1', send, a)).toEqual({ ok: true, n: 1 });
    // Another message under the same id: sent.
    expect(await subs.run('s', 'id-1', send, b)).toEqual({ ok: true, n: 2 });
    expect(n).toBe(2);
  });

  it("a phone's send never carries one", () => {
    const phone = read('server/services/phone.ts');
    expect(phone).toMatch(/if \(method === 'session\.send'\) delete p\.submitId;/);
    expect(read('server/app.ts')).toContain('}, messagePrint(text, attachments, steer)));');
  });
});

describe('#8: the palette takes a pick again every time it opens', () => {
  it('lets the guard go on the closed-to-open change, not in a focus callback that may not run', () => {
    const src = read('src/features/palette/Palette.tsx');
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(open\) ran\.current = false;\s*\}, \[open\]\);/);
    expect(src).not.toContain('onOpenAutoFocus');
  });
});

describe('#9: a pick by Enter in a menu\'s search field hands the keys on', () => {
  it('arms the same hand-off as a row\'s pick', () => {
    const src = read('src/features/composer/Controls.tsx');
    expect(src).toMatch(/pick\(rows\[0\]\.m\.id\);[^}]*pickedByKey\(\);/);
    expect(src).toMatch(/goAway\(away\[0\]\.provider, away\[0\]\.m\.id\);\s*pickedByKey\(\);/);
    expect(read('src/ui/glide.ts')).toMatch(/export function pickedByKey\(\) \{\s*window\.setTimeout\(seal, 0\);/);
  });
});

describe('#10: a clause that opens like an announcement and then says what happened stays in view', () => {
  it('is a note', () => {
    for (const t of ["I'll retry, but checking the logs showed the backup failed.", "I'll rerun CI, but running it locally already failed."]) expect(isLeadIn(t, false), t).toBe(false);
  });

  it('a second announcement still folds', () => {
    for (const t of ["I'll rerun CI, but first let me check the logs.", 'Let me run the tests.', 'Now the CSS.']) expect(isLeadIn(t, false), t).toBe(true);
  });
});

describe('#11: a "Send now" the desktop refused takes its mark back on the phone', () => {
  it('clears the mark on ok: false as on a failure', () => {
    const src = read('mobile/src/screens/Composer.tsx');
    const at = src.indexOf("conn.call('queue.sendNow'");
    expect(at).toBeGreaterThan(0);
    const call = src.slice(at, at + 320);
    expect(call).toMatch(/\.then\(\s*\(r\) => \{\s*if \(!\(r as \{ ok\?: boolean \} \| undefined\)\?\.ok\) notSentHere\(sid\);/);
    expect(call).toMatch(/\(\) => notSentHere\(sid\),/);
  });
});

describe('#12: no freeze when the sidebar\'s column does not move', () => {
  it('a sidebar stepped aside for the side panel in a narrow window is left alone', () => {
    const side = read('src/features/sidebar/Sidebar.tsx');
    const hook = side.slice(side.indexOf('function useStageFreeze()'));
    const skip = hook.indexOf('if (isNarrow() && s.ui.railOpen && !!s.ui.activeSessionId && !!s.sessions[s.ui.activeSessionId]) return;');
    expect(skip).toBeGreaterThan(0);
    // Before the mark flies and before the view is frozen.
    expect(skip).toBeLessThan(hook.indexOf('flyBrand(opening, ms, easing)'));
    expect(skip).toBeLessThan(hook.indexOf("body.dataset.freeze = 'side'"));
    // One rule for "narrow", shared with the app shell.
    expect(read('src/app/App.tsx')).toContain("import { isNarrow } from '@/lib/narrow';");
    expect(read('src/lib/narrow.ts')).toContain('export const NARROW_PX = 1060;');
  });
});
