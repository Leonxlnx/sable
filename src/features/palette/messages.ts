import { useEffect, useState } from 'react';
import type { MessageHit } from '@shared/protocol';
import { bridge } from '@/lib/bridge';

/**
 * Messages across chats for the palette, asked of the bridge (`search.messages`: what the person
 * wrote and what the agents said, newest chats first, a few per chat). Asked once typing pauses; an
 * answer that is partial (chats not read yet) is asked again, each time going on where the last
 * one stopped, until it is whole. A new query drops what the old one was still waiting for (the
 * bridge stops its search too).
 */

export const MIN_QUERY = 2;
const DEBOUNCE_MS = 170;
const ROUNDS = 16;
export const PER_CHAT = 3;
export const MAX_HITS = 24;

export interface MessageResults {
  /** The query the hits answer (they stay while a newer one is asked, so the list does not blink). */
  q: string;
  hits: MessageHit[];
  /** More may come: the search is under way. */
  busy: boolean;
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
        for (let round = 0; round < ROUNDS && live; round++) {
          const r = await bridge.call('search.messages', { query: q, perChat: PER_CHAT, limit: MAX_HITS }, 20_000);
          if (!live) return;
          setFound({ q, hits: r.hits, busy: !!r.partial && round < ROUNDS - 1 });
          if (!r.partial) return;
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
