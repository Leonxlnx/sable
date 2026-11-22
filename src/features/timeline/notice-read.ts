/**
 * How a notice reads (Notice.tsx): its level, the addresses in its words, its first sentence, and
 * how often it stands in a row. Pure, so the card and the tests share one reading.
 */
import type { NoticeItem, TimelineItem } from '@shared/protocol';

// The level itself is read in one place for the window, the phone and the turn models.
export { noticeLevel, type NoticeLevel } from '@shared/notice';

/**
 * Whether a notice stands as a card with its level's mark, or is one of the quiet dividers: an
 * error does, and so does anything the bridge gave a level of its own.
 */
export function standsAsCard(item: Pick<NoticeItem, 'variant'> & { level?: unknown }): boolean {
  return item.variant === 'error' || item.level === 'info' || item.level === 'warn' || item.level === 'error';
}

/** A piece of a notice's words: plain text, or an address to open. */
export type NoticePart = { text: string } | { href: string; label: string };

/** How long an address may stand in a line before its middle is cut. */
export const ADDRESS_MAX = 48;

const ADDRESS = /\bhttps?:\/\/[^\s<>"'`‘’“”]+/gi;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The address without what only ends the sentence around it: stops, quotes, a bracket it never opened. */
function trimAddress(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s[s.length - 1];
    if (!last) return s;
    if ('.,;:!?…*_~'.includes(last)) s = s.slice(0, -1);
    else if (CLOSERS[last] && s.split(last).length > s.split(CLOSERS[last]).length) s = s.slice(0, -1);
    else return s;
  }
}

/** A web address as it is opened, or null: http and https only, a host, no name or password in it. */
function webAddress(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || u.username || u.password) return null;
  return u;
}

/**
 * An address as a label: no scheme, the host always whole (what it opens must never be hidden), a
 * long path cut in its middle at folder edges where it can: `host/docs/…/page`.
 */
export function addressLabel(u: URL, max = ADDRESS_MAX): string {
  const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
  const whole = u.host + rest;
  if (whole.length <= max) return whole;
  const room = Math.max(10, max - u.host.length - 1);
  // The end first: the last part of a path names the page.
  let tail = rest.slice(-Math.ceil(room * 0.7));
  const edge = tail.indexOf('/');
  if (edge > 0 && tail.length - edge >= 6) tail = tail.slice(edge);
  let head = rest.slice(0, Math.max(0, room - tail.length));
  const back = head.lastIndexOf('/');
  if (back >= 0) head = head.slice(0, back + 1);
  return `${u.host}${head}…${tail}`;
}

/**
 * A notice's words with the addresses in them as links. Only `http://` and `https://` addresses
 * that parse are links; everything else (a path, `javascript:`, `file:`, an address with a
 * sign-in in it) stays text. The stop that ends the sentence is not part of the address.
 */
export function linkParts(text: string): NoticePart[] {
  const out: NoticePart[] = [];
  let from = 0;
  const say = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && 'text' in last) last.text += s;
    else out.push({ text: s });
  };
  for (const m of text.matchAll(ADDRESS)) {
    const raw = trimAddress(m[0]);
    const u = webAddress(raw);
    const at = m.index ?? 0;
    say(text.slice(from, at));
    if (u) out.push({ href: u.href, label: addressLabel(u) });
    else say(raw);
    from = at + raw.length;
  }
  say(text.slice(from));
  return out;
}

/** A notice longer than this shows its first sentence; the rest opens on demand. */
export const NOTICE_LONG = 110;

/** Where a sentence ends: a stop (and the quote or bracket it closes) before a new sentence's capital or figure, or a line break. */
const SENTENCE_END = /[.!?]["')\]]?(?=\s+["'([]?[A-Z0-9])|\s*\n+/g;

/**
 * A long notice as its first sentence and the rest. `rest` is empty when the notice is short, is
 * one sentence, or would leave only a few words behind.
 */
export function firstSentence(text: string): { head: string; rest: string } {
  const t = text.trim();
  if (t.length <= NOTICE_LONG) return { head: t, rest: '' };
  for (const m of t.matchAll(SENTENCE_END)) {
    // A line break ends the sentence before it; a stop belongs to it.
    const end = (m.index ?? 0) + (/^\s/.test(m[0]) ? 0 : m[0].length);
    const head = t.slice(0, end).trim();
    const rest = t.slice(end).trim();
    // A stop after a few letters is an abbreviation or a number, not the sentence.
    if (head.length < 24) continue;
    return rest.length < 16 ? { head: t, rest: '' } : { head, rest };
  }
  return { head: t, rest: '' };
}

/**
 * The same notice again: the same kind, words and detail. A notice with a part of its own (a limit
 * with its reset and accounts, a sign-in, an agent switch, the end of an /until) never counts:
 * each is its own.
 */
export function sameNotice(a: TimelineItem | undefined, b: TimelineItem | undefined): boolean {
  if (a?.type !== 'notice' || b?.type !== 'notice') return false;
  if (a.limit || b.limit || a.auth || b.auth || a.agentSwitch || b.agentSwitch || a.until || b.until) return false;
  return a.variant === b.variant && a.text === b.text && (a.detail ?? '') === (b.detail ?? '');
}

/**
 * How many times the notice at `at` stands in a row from there on, in its list of siblings: 1 when
 * it stands alone, 0 when the one right before it is the same notice (that one carries the count,
 * and this one is not shown).
 */
export function repeatRun(list: readonly string[], items: Readonly<Record<string, TimelineItem>>, at: number): number {
  const item = items[list[at]];
  if (item?.type !== 'notice') return 1;
  if (at > 0 && sameNotice(items[list[at - 1]], item)) return 0;
  let n = 1;
  while (at + n < list.length && sameNotice(items[list[at + n]], item)) n++;
  return n;
}
