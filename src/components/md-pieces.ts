/**
 * A long settled text is put on the page in pieces (`Markdown.tsx`): its last piece first, then one
 * piece more above it per frame, each bounded by the characters it holds, so a 4,000-line answer is
 * some thirty small commits instead of one task of 200 ms and more. Each piece is a box of its own
 * that skips layout and paint while it is out of view (`content-visibility: auto`, standing in for
 * its estimated height until it has been laid out): a piece put above the view costs its own
 * elements and nothing of the rest. The last piece first, because a conversation is read from its
 * end: a view pinned at the end shows the answer's end at rest from the first frame, and a reading
 * place kept as a distance from the end (`Timeline.tsx` `restore`) lands exactly once the pieces
 * reach it; what arrives above is kept out of view by scroll anchoring. Pure: block sizes in.
 */

/** A text shorter than this (characters) is put on the page whole, as one box. */
export const PIECES_FROM = 24_000;
/** What one piece holds at most (characters; always at least one block). */
export const PIECE = 6_000;

/** Whether a text of blocks this long (characters each) goes on the page in pieces. */
export function inPieces(sizes: readonly number[], from = PIECES_FROM): boolean {
  let total = 0;
  for (const n of sizes) total += n;
  return total >= from && sizes.length > 1;
}

/** Where the piece that ends before `end` begins: as many blocks before `end` as fit in `piece`, at least one. */
export function pieceBefore(sizes: readonly number[], end: number, piece = PIECE): number {
  let i = Math.min(end, sizes.length);
  if (i <= 0) return 0;
  let n = sizes[--i];
  while (i > 0 && n + sizes[i - 1] <= piece) n += sizes[--i];
  return i;
}

/** The text's pieces in reading order, as [start, end) block ranges, cut from its end. */
export function piecesOf(sizes: readonly number[], piece = PIECE): [number, number][] {
  const out: [number, number][] = [];
  for (let end = sizes.length; end > 0; ) {
    const start = pieceBefore(sizes, end, piece);
    out.push([start, end]);
    end = start;
  }
  return out.reverse();
}

/**
 * About how tall a piece stands before it is laid out (px): its characters as lines of the reading
 * column (about 100 to a line at 26 px) and a paragraph's gap per block. Only a stand-in: once laid
 * out, the box keeps its real height.
 */
export function pieceHeight(sizes: readonly number[], start: number, end: number): number {
  let h = 0;
  for (let i = start; i < end; i++) h += Math.max(1, Math.ceil(sizes[i] / 100)) * 26 + 14;
  return Math.round(h);
}
