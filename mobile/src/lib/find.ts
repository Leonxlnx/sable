/**
 * Where searched words stand in a text, as offsets into the text itself. Lowercasing can change a
 * string's length (`İ` becomes two code units), so offsets found in a lowercased copy do not fit the
 * original: here each character is folded on its own and every folded unit remembers the original
 * character it came from. Words are split on whitespace. Pure; the desktop's palette jump
 * (src/features/palette/jump.ts) does the same.
 */

/** One character folded for matching (its lowercase, a final sigma as any sigma). */
const foldChar = (ch: string) => ch.toLowerCase().replace(/ς/g, 'σ');

/** A query's words, folded, each once. */
export function searchWords(query: string): string[] {
  return [...new Set(query.split(/\s+/).map(foldText).filter(Boolean))];
}

/** A text folded as `matchRanges` reads it. */
export function foldText(s: string): string {
  let out = '';
  for (const ch of s) out += foldChar(ch);
  return out;
}

/** The text folded, and for each folded unit the original character's start and end. */
function folded(text: string): { s: string; from: number[]; to: number[] } {
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
  return { s, from, to };
}

/** Every place the words stand in `text`, as [start, end) offsets into `text`, in order. */
export function matchRanges(text: string, words: readonly string[]): [number, number][] {
  const ws = words.map(foldText).filter(Boolean);
  if (!ws.length || !text) return [];
  const f = folded(text);
  const out: [number, number][] = [];
  for (const w of ws) {
    for (let i = f.s.indexOf(w); i >= 0; i = f.s.indexOf(w, i + w.length)) out.push([f.from[i], f.to[i + w.length - 1]]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
