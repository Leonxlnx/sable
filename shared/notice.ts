/**
 * A notice's level: one reading for the window's card, the phone's line and both turn models
 * (a notice that is no error never marks its turn as failed).
 */
import type { NoticeItem } from './protocol';

/** info: it tells. warn: something was left out or will not hold. error: something failed. */
export type NoticeLevel = 'info' | 'warn' | 'error';

/**
 * What the agents write at warning level that only informs: nothing failed and nothing is to do.
 * Claude Code after a chat moved to another account: "Claude can't use thinking from another
 * organization … See docs for more: <address>".
 */
const INFORMS: readonly RegExp[] = [/\bthinking from another organi[sz]ation\b/i, /\bpreserved[- ]thinking\b/i];

/**
 * A notice's level. The item's own `level` wins where the bridge carries one (a warning whose
 * words are a known message that only informs still informs); else the variant says it: an error
 * is an error unless its words are such a message, a retry is a warning, everything else tells.
 */
export function noticeLevel(item: Pick<NoticeItem, 'variant' | 'text'> & { level?: unknown }): NoticeLevel {
  if (item.level === 'info' || item.level === 'error') return item.level;
  const informs = () => INFORMS.some((r) => r.test(item.text));
  if (item.level === 'warn') return informs() ? 'info' : 'warn';
  if (item.variant === 'retry') return 'warn';
  if (item.variant !== 'error') return 'info';
  return informs() ? 'info' : 'error';
}
