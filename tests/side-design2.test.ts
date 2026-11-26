import { describe, expect, it } from 'vitest';
import type { PermissionOption, SessionMeta } from '@shared/protocol';
import { buildGroups, holdGroups, keepOrder } from '@/features/sidebar/groups';
import { quietMarks } from '@/features/palette/Highlight';
import { SUGGEST_MAX, SUGGEST_MIN, suggestLeft, suggestWidth } from '@/features/composer/SuggestMenu';
import { answerOrder } from '@/features/triage/deck';
import { STATE_MARK, agentState, agentsHeader, commandRowState } from '@/features/rail/agents-model';

const s = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, provider: 'claude', cwd: 'D:/code/app', title: id, titleSource: 'auto', model: 'm', mode: 'default', status: 'idle', createdAt: 0, updatedAt: 0, usage: {}, ...over }) as SessionMeta;
const map = (...list: SessionMeta[]) => Object.fromEntries(list.map((x) => [x.id, x]));
const ids = (list: SessionMeta[]) => list.map((x) => x.id);

describe('sidebar: no row moves under the person (design2 #10)', () => {
  it('keepOrder keeps the places both lists share, puts new ones first, drops gone ones', () => {
    expect(keepOrder(['a', 'b', 'c'], ['c', 'a', 'b'], (x) => x)).toEqual(['a', 'b', 'c']);
    expect(keepOrder(['a', 'b'], ['n', 'b', 'a'], (x) => x)).toEqual(['n', 'a', 'b']);
    expect(keepOrder(['a', 'b', 'c'], ['c', 'a'], (x) => x)).toEqual(['a', 'c']);
    const same = ['a', 'b'];
    expect(keepOrder(['a', 'b'], same, (x) => x)).toBe(same);
  });

  it('another chat ticking to the top holds its place while held, and settles after', () => {
    const before = buildGroups(map(s('a', { updatedAt: 3 }), s('b', { updatedAt: 2 }), s('c', { cwd: 'D:/code/other', updatedAt: 1 })), [], 'recent');
    expect(ids(before.projects[0].sessions)).toEqual(['a', 'b']);
    // A background turn ends in b, and in the other folder's c: both would jump to the top.
    const after = buildGroups(map(s('a', { updatedAt: 3 }), s('b', { updatedAt: 9, status: 'running' }), s('c', { cwd: 'D:/code/other', updatedAt: 10 })), [], 'recent');
    expect(ids(after.projects.find((p) => p.name === 'app')!.sessions)).toEqual(['b', 'a']);
    expect(after.projects.map((p) => p.name)).toEqual(['other', 'app']);
    const held = holdGroups(before, after);
    expect(ids(held.projects.find((p) => p.name === 'app')!.sessions)).toEqual(['a', 'b']);
    expect(held.projects.map((p) => p.name)).toEqual(['app', 'other']);
    // The row still shows its new state: the held list carries the next objects.
    expect(held.projects[0].sessions[1].status).toBe('running');
    // Unheld, the next order is shown as it is.
    expect(holdGroups(after, after)).toBe(after);
  });

  it('a chat made while held comes in first; a removed one goes', () => {
    const before = buildGroups(map(s('a', { updatedAt: 3 }), s('b', { updatedAt: 2 })), []);
    const after = buildGroups(map(s('a', { updatedAt: 3 }), s('n', { updatedAt: 1 })), []);
    expect(ids(holdGroups(before, after).projects[0].sessions)).toEqual(['n', 'a']);
  });

  it('pinned chats and the chats group hold too', () => {
    const before = buildGroups(map(s('p', { pinned: true, updatedAt: 2 }), s('q', { pinned: true, updatedAt: 1 }), s('x', { chat: true, updatedAt: 2 }), s('y', { chat: true, updatedAt: 1 })), []);
    const after = buildGroups(map(s('p', { pinned: true, updatedAt: 2 }), s('q', { pinned: true, updatedAt: 5 }), s('x', { chat: true, updatedAt: 2 }), s('y', { chat: true, updatedAt: 5 })), []);
    const held = holdGroups(before, after);
    expect(ids(held.pinned)).toEqual(['p', 'q']);
    expect(ids(held.chats!.sessions)).toEqual(['x', 'y']);
  });
});

describe('palette and slash menu: quiet matches, no descriptions, the width it needs (design2 #15)', () => {
  it('marks only a match that landed as one run per word', () => {
    expect(quietMarks([0, 1, 2])).toEqual([0, 1, 2]);
    expect(quietMarks([0, 1, 5, 9])).toBeUndefined();
    expect(quietMarks([0, 1, 6, 7], 2)).toEqual([0, 1, 6, 7]);
    expect(quietMarks([], 1)).toBeUndefined();
    expect(quietMarks(undefined)).toBeUndefined();
  });

  it('the slash menu is as wide as its widest row, within the card and its bounds, and never narrows while open', () => {
    expect(suggestWidth(120, 700)).toBe(SUGGEST_MIN);
    expect(suggestWidth(300, 700)).toBe(300);
    expect(suggestWidth(900, 700)).toBe(SUGGEST_MAX);
    expect(suggestWidth(900, 400)).toBe(400);
    expect(suggestWidth(250, 700, 320)).toBe(320);
    expect(suggestWidth(250, 300, 320)).toBe(300);
  });

  it('it stands at the trigger, inside the card', () => {
    expect(suggestLeft(100, 700, 260, 15)).toBe(100);
    expect(suggestLeft(100, 700, 260, 218)).toBe(300);
    expect(suggestLeft(100, 700, 260, 690)).toBe(540);
  });
});

describe('a permission has one order of answers everywhere (design2 #14)', () => {
  const o = (id: string, tone?: PermissionOption['tone']): PermissionOption => ({ id, label: id, tone }) as PermissionOption;
  it('no apart first, the rest in the agent order, the plain allow last', () => {
    const r = answerOrder([o('allow', 'allow'), o('always', 'always'), o('deny', 'deny')]);
    expect(r.no.map((x) => x.id)).toEqual(['deny']);
    expect(r.yes.map((x) => x.id)).toEqual(['always', 'allow']);
  });
  it('without an allow tone the first yes is the primary, still last', () => {
    const r = answerOrder([o('a'), o('b', 'always'), o('d', 'deny')]);
    expect(r.yes.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('the Agents tab leads every row with its state (design2 #12)', () => {
  it('every outcome and command state has a state mark, never a kind glyph', () => {
    const marks = Object.values(STATE_MARK);
    expect(marks).not.toContain('terminal');
    expect(marks).not.toContain('tree');
    expect(STATE_MARK[agentState('done')]).toBe('check');
    expect(STATE_MARK[agentState('failed')]).toBe('x');
    expect(STATE_MARK[agentState('interrupted')]).toBe('minus');
    expect(STATE_MARK[agentState('unknown')]).toBe('question');
    expect(STATE_MARK[commandRowState('starting')]).toBe('ring');
    expect(STATE_MARK[commandRowState('lost')]).toBe('circle-dashed');
    expect(STATE_MARK[commandRowState('done')]).toBe('check');
  });

  it('the header says what is true now as one figure, and nothing once nothing works', () => {
    expect(agentsHeader({ working: 0, running: 1 })).toBe('1 working');
    expect(agentsHeader({ working: 2, running: 1 })).toBe('3 working');
    // Tracked jobs are work like any other; the cards under the header say what each thing is.
    expect(agentsHeader({ working: 1, running: 0, jobs: 2 })).toBe('3 working');
    expect(agentsHeader({ working: 0, running: 0, serving: 1 })).toBe('1 serving');
    expect(agentsHeader({ working: 1, running: 0, serving: 1 })).toBe('1 working');
    // Once nothing works it says nothing: never a total of what ended or failed (26 Nov: "948 done · 27 failed").
    expect(agentsHeader({ working: 0, running: 0 })).toBe('');
  });
});

describe('one scrollbar for every scroller (design2 #5)', () => {
  // Chromium ignores the ::-webkit-scrollbar parts on an element whose scrollbar-width or
  // scrollbar-color is not auto, and scrollbar-color is inherited: one such declaration brings
  // Windows' own bar with its arrow buttons back to every scroller under it (seen in the packaged app).
  it('no stylesheet sets scrollbar-color, or a scrollbar-width other than none, but the two still to clear', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.css')) files.push(p);
      }
    };
    walk('src');
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*scrollbar-color\s*:/.test(line) || (/^\s*scrollbar-width\s*:/.test(line) && !/none/.test(line))) found.push(`${f.split(String.fromCharCode(92)).join('/')}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
    const base = readFileSync('src/styles/base.css', 'utf8');
    expect(base).not.toMatch(/\.scroll\s*>\s*\*/);
    expect(base).toMatch(/^::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/m);
  });
});
