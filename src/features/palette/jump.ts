import { revealItem } from '@/features/timeline/reveal';
import { openSession } from '@/state/actions';
import { useStore } from '@/state/store';

/**
 * Opens a chat at a message found by the palette's search: the chat opens (loading it when it was
 * not), the timeline builds and brings the message into view and lights it once (`revealItem`, as
 * the find bar's and the map's jumps do), and the words searched for are marked in it for a moment
 * (CSS highlights over the text: nothing in the conversation re-renders).
 */

const MARK = 'sable-jump';
/** How long the words stay marked. */
const MARK_MS = 2400;
/** How long to wait for the chat to load and build before giving up. */
const PATIENCE_MS = 8000;

type Registry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): Registry | undefined => (typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Registry }).highlights : undefined);
const makeHighlight = (ranges: Range[]) => new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(...ranges);

const builtRow = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)].find((el) => el.closest('.tl-scroll'));

/** One character folded for matching (its lowercase, a final sigma as any sigma). */
const foldChar = (ch: string) => ch.toLowerCase().replace(/ς/g, 'σ');
const foldText = (s: string) => {
  let out = '';
  for (const ch of s) out += foldChar(ch);
  return out;
};

/**
 * Every place the words stand in `text`, as [start, end) offsets into `text` itself. Lowercasing can
 * change a string's length (`İ` becomes two code units), so each character is folded on its own and
 * every folded unit remembers the original character it came from: an offset never lands past the
 * text or inside the wrong character. (The phone does the same: mobile/src/lib/find.ts.)
 */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const ws = words.map(foldText).filter(Boolean);
  if (!ws.length || !text) return [];
  let s = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    s += f;
    at += ch.length;
  }
  const out: [number, number][] = [];
  for (const w of ws) for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + w.length)) out.push([from[i], to[i + w.length - 1]]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Every occurrence of the words in an element's text, as ranges (a match inside one text node). */
function rangesIn(el: HTMLElement, words: string[]): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const [a, b] of matchRanges(n.nodeValue ?? '', words)) {
      const r = document.createRange();
      r.setStart(n, a);
      r.setEnd(n, b);
      out.push(r);
    }
  }
  return out.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b));
}

let current = 0;
let clearTimer = 0;

/** Opens the chat at the message and marks the words in it. */
export function openMessage(sessionId: string, itemId: string, words: string[]) {
  const mine = ++current;
  window.clearTimeout(clearTimer);
  registry()?.delete(MARK);
  openSession(sessionId);
  const until = performance.now() + PATIENCE_MS;
  let asked = 0;
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const tick = () => {
    if (mine !== current) return;
    const s = useStore.getState();
    // The person went somewhere else meanwhile.
    if (s.ui.activeSessionId !== sessionId) return;
    const d = s.data[sessionId];
    if (d?.loaded && !d.items[itemId]) return; // no longer in the chat (rewound)
    const row = d?.loaded ? builtRow(itemId) : undefined;
    // Lit by the timeline: it is in view; mark the words.
    if (row?.hasAttribute('data-reveal')) return void mark(row, words, mine, smooth);
    // Asked again now and then: the timeline may mount after the first request.
    if (d?.loaded && performance.now() - asked > 320) {
      asked = performance.now();
      revealItem(sessionId, itemId);
    }
    if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function mark(row: HTMLElement, words: string[], mine: number, smooth: boolean) {
  const reg = registry();
  const ranges = rangesIn(row, words);
  if (reg && ranges.length) {
    reg.set(MARK, makeHighlight(ranges.slice(0, 200)));
    clearTimer = window.setTimeout(() => mine === current && reg.delete(MARK), MARK_MS);
  }
  // A long message is centred by its middle: once it has arrived, bring the first match itself into view.
  const first = ranges[0];
  const scroller = row.closest<HTMLElement>('.tl-scroll');
  if (!first || !scroller) return;
  window.setTimeout(() => {
    if (mine !== current || !first.startContainer.isConnected) return;
    const r = first.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (r.top >= s.top + 72 && r.bottom <= s.bottom - 180) return;
    scroller.scrollBy({ top: r.top - s.top - s.height * 0.38, behavior: smooth ? 'smooth' : 'auto' });
  }, smooth ? 520 : 40);
}
