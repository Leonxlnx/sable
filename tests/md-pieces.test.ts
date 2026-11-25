import { describe, expect, it } from 'vitest';
import { columnAlign, inPieces, pieceBefore, pieceHeight, piecesOf, PIECE, PIECES_FROM } from '../src/components/md-pieces';

const sum = (a: readonly number[], from: number, to: number) => a.slice(from, to).reduce((x, y) => x + y, 0);

describe('a long text goes on the page in pieces, its end first', () => {
  it('puts a short text on the page whole', () => {
    expect(inPieces([100, 200, 300])).toBe(false);
    expect(inPieces(new Array(10).fill(PIECES_FROM / 10 - 1))).toBe(false);
    expect(inPieces([PIECES_FROM * 2])).toBe(false);
    expect(inPieces(new Array(10).fill(PIECES_FROM / 10))).toBe(true);
  });

  it('cuts a long text from its end into bounded pieces that cover it in order', () => {
    const sizes = Array.from({ length: 985 }, (_, i) => 40 + (i % 7) * 30);
    const pieces = piecesOf(sizes);
    expect(pieces[0][0]).toBe(0);
    expect(pieces.at(-1)![1]).toBe(sizes.length);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i][0]).toBe(pieces[i - 1][1]);
    // Every piece but the first is as full as the budget allows: the cut runs from the end.
    for (const [a, b] of pieces) expect(sum(sizes, a, b)).toBeLessThanOrEqual(PIECE);
    for (const [a, b] of pieces.slice(1)) expect(sum(sizes, a - 1, b)).toBeGreaterThan(PIECE);
    expect(pieces.length).toBeLessThan(40);
  });

  it('takes one block even when it alone is over the budget', () => {
    expect(pieceBefore([10, PIECE * 3, 10], 2)).toBe(1);
    expect(pieceBefore([PIECE * 5], 1)).toBe(0);
    expect(piecesOf([10, PIECE * 3, 10])).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it('stands in for a piece by its lines and blocks', () => {
    expect(pieceHeight([100, 250, 5], 0, 3)).toBe(26 + 14 + 3 * 26 + 14 + 26 + 14);
    expect(pieceHeight([100, 250, 5], 1, 2)).toBe(3 * 26 + 14);
  });
});

describe('a table column has one edge (columnAlign)', () => {
  it('figures stand on the right, also where the author centred them; a left set by the author holds', () => {
    expect(columnAlign(null, true)).toBe('right');
    expect(columnAlign('center', true)).toBe('right');
    expect(columnAlign('right', true)).toBe('right');
    expect(columnAlign('left', true)).toBe('left');
    expect(columnAlign('center', false)).toBe('center');
    expect(columnAlign(null, false)).toBe(null);
  });
});
