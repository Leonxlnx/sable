import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NoticeItem, TimelineItem } from '../shared/protocol';
import { ADDRESS_MAX, addressLabel, firstSentence, linkParts, noticeLevel, repeatRun, sameNotice, standsAsCard } from '../src/features/timeline/notice-read';

const MOVED =
  "Claude can't use thinking from another organization, so the thinking from before the move was left out. See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking";

const notice = (id: string, text: string, over: Partial<NoticeItem> = {}): NoticeItem => ({ type: 'notice', id, ts: 1, variant: 'error', text, ...over });

describe('noticeLevel', () => {
  it('an error is an error', () => {
    expect(noticeLevel({ variant: 'error', text: 'Could not send the message' })).toBe('error');
    expect(noticeLevel({ variant: 'error', text: 'You have reached your usage limit.' })).toBe('error');
  });
  it('a known message that only informs reads as information, whatever variant it came in', () => {
    expect(noticeLevel({ variant: 'error', text: MOVED })).toBe('info');
    expect(noticeLevel({ variant: 'error', text: 'Claude can’t use thinking from another organisation.' })).toBe('info');
  });
  it('a retry is a warning, every other variant tells', () => {
    expect(noticeLevel({ variant: 'retry', text: 'Retrying, attempt 2 of 10' })).toBe('warn');
    for (const variant of ['info', 'interrupted', 'compact', 'mode', 'model', 'command', 'rewind'] as const) expect(noticeLevel({ variant, text: 'x' })).toBe('info');
  });
  it('a level the item carries wins, an unknown one is ignored', () => {
    expect(noticeLevel({ variant: 'error', text: 'x', level: 'warn' })).toBe('warn');
    expect(noticeLevel({ variant: 'info', text: 'x', level: 'error' })).toBe('error');
    expect(noticeLevel({ variant: 'error', text: 'x', level: 'loud' })).toBe('error');
  });
  it('a warning whose words only inform still informs: the agent says "warning", nothing is to do', () => {
    expect(noticeLevel({ variant: 'error', text: MOVED, level: 'warn' })).toBe('info');
    expect(noticeLevel({ variant: 'error', text: MOVED, level: 'error' })).toBe('error');
  });
});

describe('standsAsCard', () => {
  it('an error is a card, and so is a notice with a level of its own; the rest are dividers', () => {
    expect(standsAsCard({ variant: 'error' })).toBe(true);
    expect(standsAsCard({ variant: 'info', level: 'warn' })).toBe(true);
    for (const variant of ['info', 'interrupted', 'compact', 'retry', 'mode', 'model', 'command', 'rewind'] as const) expect(standsAsCard({ variant })).toBe(false);
    expect(standsAsCard({ variant: 'info', level: 'loud' })).toBe(false);
  });
});

describe('linkParts', () => {
  it('makes an address a link and leaves the words around it', () => {
    expect(linkParts('See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking')).toEqual([
      { text: 'See docs for more: ' },
      { href: 'https://platform.claude.com/docs/en/build-with-claude/preserved-thinking', label: 'platform.claude.com/docs/en/…/preserved-thinking' },
    ]);
  });
  it('leaves out the stop, the comma and the bracket that end the sentence', () => {
    expect(linkParts('Read https://example.com/a.')).toEqual([{ text: 'Read ' }, { href: 'https://example.com/a', label: 'example.com/a' }, { text: '.' }]);
    expect(linkParts('(see https://example.com/a), then go on')).toEqual([{ text: '(see ' }, { href: 'https://example.com/a', label: 'example.com/a' }, { text: '), then go on' }]);
    expect(linkParts('http://example.com/x?y=1!')[0]).toEqual({ href: 'http://example.com/x?y=1', label: 'example.com/x?y=1' });
  });
  it('keeps a bracket the address opened itself', () => {
    expect(linkParts('https://en.wikipedia.org/wiki/Sable_(heraldry)')[0]).toMatchObject({ href: 'https://en.wikipedia.org/wiki/Sable_(heraldry)' });
  });
  it('shows a bare host without the slash', () => {
    expect(linkParts('https://example.com/')).toEqual([{ href: 'https://example.com/', label: 'example.com' }]);
  });
  it('never links anything but http and https', () => {
    for (const t of ['javascript:alert(1)', 'file:///C:/Users/me/secret.txt', 'C:\\Users\\me\\notes.txt', '/etc/passwd', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'ftp://example.com/x', 'www.example.com', 'vbscript:x'])
      expect(linkParts(`open ${t} now`)).toEqual([{ text: `open ${t} now` }]);
  });
  it('never links an address with a sign-in in it, or one that does not parse', () => {
    expect(linkParts('https://claude.com@evil.example/x')).toEqual([{ text: 'https://claude.com@evil.example/x' }]);
    expect(linkParts('https://user:pw@example.com/')).toEqual([{ text: 'https://user:pw@example.com/' }]);
    expect(linkParts('http://')).toEqual([{ text: 'http://' }]);
    expect(linkParts('https://[bad')).toEqual([{ text: 'https://[bad' }]);
  });
  it('a link only ever has an http or https href', () => {
    const parts = linkParts(`${MOVED} and http://localhost:5173/x, also javascript:https://example.com/y`);
    const links = parts.filter((p): p is { href: string; label: string } => 'href' in p);
    expect(links).toHaveLength(3);
    for (const l of links) expect(l.href).toMatch(/^https?:\/\//);
  });
  it('finds every address in a line', () => {
    const parts = linkParts('a https://a.example/1 b https://b.example/2 c');
    expect(parts.map((p) => ('href' in p ? p.label : p.text))).toEqual(['a ', 'a.example/1', ' b ', 'b.example/2', ' c']);
  });
  it('text without an address is one part', () => {
    expect(linkParts('Could not send the message')).toEqual([{ text: 'Could not send the message' }]);
    expect(linkParts('')).toEqual([]);
  });
});

describe('addressLabel', () => {
  it('shows a short address whole, without the scheme', () => {
    expect(addressLabel(new URL('https://docs.example.com/guide#limits'))).toBe('docs.example.com/guide#limits');
  });
  it('cuts a long one in the middle and keeps the host and the page', () => {
    const label = addressLabel(new URL('https://platform.claude.com/docs/en/build-with-claude/preserved-thinking'));
    expect(label).toBe('platform.claude.com/docs/en/…/preserved-thinking');
    expect(label.length).toBeLessThanOrEqual(ADDRESS_MAX);
  });
  it('never cuts the host, however long', () => {
    const host = `${'a'.repeat(30)}.${'b'.repeat(30)}.example`;
    const label = addressLabel(new URL(`https://${host}/one/two/three/four/five/six`));
    expect(label.startsWith(`${host}/`)).toBe(true);
    expect(label).toContain('…');
  });
  it('a homograph host shows as what it is', () => {
    expect(addressLabel(new URL('https://аpple.com/x'))).toMatch(/^xn--/);
  });
  it('cuts a long query as well', () => {
    const label = addressLabel(new URL(`https://example.com/search?q=${'x'.repeat(80)}&page=2`));
    expect(label.startsWith('example.com/')).toBe(true);
    expect(label.endsWith('&page=2')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(ADDRESS_MAX);
  });
});

describe('firstSentence', () => {
  it('a short notice stays whole', () => {
    expect(firstSentence('Could not send the message. Try again.')).toEqual({ head: 'Could not send the message. Try again.', rest: '' });
  });
  it('a long one shows its first sentence, the rest on demand', () => {
    expect(firstSentence(MOVED)).toEqual({
      head: "Claude can't use thinking from another organization, so the thinking from before the move was left out.",
      rest: 'See docs for more: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking',
    });
  });
  it('a stop inside an address or a number does not end the sentence', () => {
    const t = `Version 2.4 of the service at https://status.example.com/v2.4/incidents answered late for a long while today. ${'More words follow here. '.repeat(3)}`.trim();
    expect(firstSentence(t).head).toBe('Version 2.4 of the service at https://status.example.com/v2.4/incidents answered late for a long while today.');
  });
  it('a line break ends the first sentence too', () => {
    const t = `The first line stands on its own without a stop\n${'and the rest goes on for a good while longer than that '.repeat(3)}`.trim();
    expect(firstSentence(t).head).toBe('The first line stands on its own without a stop');
  });
  it('one long sentence stays whole, and so does one that would leave a few words behind', () => {
    const one = 'x'.repeat(40) + ' ' + 'word '.repeat(30).trim();
    expect(firstSentence(one)).toEqual({ head: one, rest: '' });
    const tail = `${'This sentence is long enough to be cut on its own, it goes on and on and on and on and on and on and on.'} Ok then.`;
    expect(firstSentence(tail).rest).toBe('');
  });
});

describe('repeatRun', () => {
  const run = (list: NoticeItem[]) => {
    const items: Record<string, TimelineItem> = Object.fromEntries(list.map((n) => [n.id, n]));
    const ids = list.map((n) => n.id);
    return ids.map((_, i) => repeatRun(ids, items, i));
  };
  it('the same notice seven times in a row is one with a count', () => {
    expect(run(Array.from({ length: 7 }, (_, i) => notice(`n${i}`, 'You have reached your usage limit.')))).toEqual([7, 0, 0, 0, 0, 0, 0]);
  });
  it('a notice on its own counts one', () => {
    expect(run([notice('a', 'One'), notice('b', 'Two'), notice('c', 'One')])).toEqual([1, 1, 1]);
  });
  it('other words, another detail or another kind start a new run', () => {
    expect(run([notice('a', 'Same'), notice('b', 'Same'), notice('c', 'Same', { detail: 'why' }), notice('d', 'Same', { detail: 'why' }), notice('e', 'Same', { variant: 'info' })])).toEqual([2, 0, 2, 0, 1]);
  });
  it('something between two of them keeps them apart', () => {
    const a = notice('a', 'Same');
    const b = notice('b', 'Same');
    const text: TimelineItem = { type: 'text', id: 't', ts: 1, text: 'words', streaming: false };
    const items: Record<string, TimelineItem> = { a, b, t: text };
    expect(['a', 't', 'b'].map((_, i, ids) => repeatRun(ids, items, i))).toEqual([1, 1, 1]);
  });
  it('a divider with a mark of its own never joins a run', () => {
    const sw = { from: 'claude', to: 'codex' } as NoticeItem['agentSwitch'];
    expect(sameNotice(notice('a', 'Switched', { agentSwitch: sw }), notice('b', 'Switched', { agentSwitch: sw }))).toBe(false);
    expect(sameNotice(notice('a', 'x'), undefined)).toBe(false);
  });
  it('a limit or a sign-in notice is always its own', () => {
    const limit = { resetsAt: 1 } as NoticeItem['limit'];
    expect(sameNotice(notice('a', 'You have reached your usage limit.', { limit }), notice('b', 'You have reached your usage limit.', { limit }))).toBe(false);
    expect(sameNotice(notice('a', 'Not signed in', { auth: {} as NoticeItem['auth'] }), notice('b', 'Not signed in', { auth: {} as NoticeItem['auth'] }))).toBe(false);
  });
});

describe('the card (Notice.tsx and its rules)', () => {
  const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  const src = read('src/features/timeline/Notice.tsx');
  const css = read('src/features/timeline/timeline.css');
  const block = css.slice(css.indexOf('/* ───────────── notices'), css.indexOf('/* ───────────── a turn'));

  it('every link opens outside and takes its address from linkParts alone', () => {
    const anchors = src.match(/<a\b[^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a).toContain('href={p.href}');
      expect(a).toContain('target="_blank"');
      expect(a).toMatch(/rel="[^"]*noreferrer[^"]*"/);
      expect(a).toContain('title={p.href}');
    }
    expect(src).not.toContain('dangerouslySetInnerHTML');
  });

  it('red and amber are the mark only: one rule each, on the icon', () => {
    expect(block.match(/var\(--red\)/g)).toHaveLength(1);
    expect(block.match(/var\(--amber\)/g)).toHaveLength(1);
    expect(block).toMatch(/\.notice-error > svg \{[^}]*color: var\(--red\);/);
    expect(block).toMatch(/\.notice-error\[data-level='warn'\] > svg \{\s*color: var\(--amber\);/);
    expect(block).toMatch(/\.notice-error\[data-level='info'\] > svg \{\s*color: var\(--text-3\);/);
  });

  it('a notice that informs or warns has no fill, an error one fill step', () => {
    expect(block).toMatch(/\.notice-error \{[^}]*background-color: var\(--fill-1\);/);
    expect(block).toMatch(/\.notice-error:is\(\[data-level='info'\], \[data-level='warn'\]\) \{\s*background-color: transparent;/);
  });

  it('the rest of a long notice never widens the card, and a row that shows nothing takes no room', () => {
    expect(block).toMatch(/\.notice-error-rest \{[^}]*width: 0;\s*min-width: 100%;/);
    expect(block).toMatch(/:is\(\.tl-item, \.tl-sub\)\[data-t='notice'\]:empty \{\s*display: none;/);
  });
});
