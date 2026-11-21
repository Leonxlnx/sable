import { useEffect, useState } from 'react';
import type { MessageHit } from '@shared/protocol';
import { bridge } from '@/lib/bridge';

/**
 * Messages across chats for the palette, asked of the bridge (`search.messages`: what the person
 * wrote and what the agents said, newest chats first, a few per chat). Asked once typing pauses; an
 * answer that is partial (chats not read yet) is asked again with its cursor, each time going on
 * where the last one stopped, until it is whole. A new query drops what the old one was still
 * waiting for (the bridge stops this window's search too, never another window's).
 */

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 170;
const ROUNDS = 16;
export const PER_CHAT = 3;
export const MAX_HITS = 24;
/** This window, to the bridge: its searches stop only its own. */
const SCOPE = `w${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export interface MessageResults {
  /** The query the hits answer (they stay while a newer one is asked, so the list does not blink). */
  q: string;
  hits: MessageHit[];
  /** More may come: the search is under way. */
  busy: boolean;
  /** Chats with a part that could not be read (their messages there were not searched). */
  skipped?: number;
}

const NONE: MessageResults = { q: '', hits: [], busy: false };

export function useMessageSearch(query: string, enabled: boolean): MessageResults {
  const [found, setFound] = useState<MessageResults>(NONE);
  const q = query.trim();
  const on = enabled && q.length >= MIN_QUERY;

  useEffect(() => {
    if (!on) {
      setFound(NONE);
      return;
    }
    let live = true;
    setFound((f) => ({ q: f.q, hits: f.hits, busy: true }));
    const t = window.setTimeout(async () => {
      try {
        let cursor: string | undefined;
        for (let round = 0; round < ROUNDS && live; round++) {
          const r = await bridge.call('search.messages', { query: q, perChat: PER_CHAT, limit: MAX_HITS, scope: SCOPE, ...(cursor ? { cursor } : {}) }, 20_000);
          if (!live) return;
          setFound({ q, hits: r.hits, busy: !!r.partial && round < ROUNDS - 1, ...(r.skipped ? { skipped: r.skipped } : {}) });
          if (!r.partial) return;
          cursor = r.cursor;
        }
      } catch {
        // An older bridge, or the search failed: no messages section.
        if (live) setFound({ q, hits: [], busy: false });
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, on]);

  return on ? found : NONE;
}

/** The query's words as search reads them: lower case, each once. */
export const wordsOf = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];

/**
 * The snippet for one line: when the first match sits far in, the start is cut (at a word) so the
 * match shows near the left edge.
 */
export function leadIn(text: string, words: string[], lead = 26): string {
  const low = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at <= lead) return text;
  let from = at - lead;
  const sp = text.indexOf(' ', from);
  if (sp >= 0 && sp < at) from = sp + 1;
  return `…${text.slice(from).replace(/^…/, '')}`;
}

/** Every character of the text that belongs to an occurrence of one of the words (for the marks). */
export function markIndices(text: string, words: string[]): number[] {
  const low = text.toLowerCase();
  const out = new Set<number>();
  for (const w of words) {
    if (!w) continue;
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) for (let k = 0; k < w.length; k++) out.add(i + k);
  }
  return [...out].sort((a, b) => a - b);
}
