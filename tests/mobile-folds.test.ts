/**
 * What the reader opened on the phone (mobile/src/lib/folds.ts) outlives the element that showed
 * it: a checkpoint opened while its turn ran is open again inside the finished turn's fold.
 */
import { describe, expect, it } from 'vitest';

// Loaded by a path the root type check does not follow (the phone has its own config).
const at = (name: string) => `../mobile/src/lib/${name}`;
const folds = (await import(/* @vite-ignore */ at('folds'))) as { FOLDS_MAX: number; foldKey: (sid: string, turn: string, piece?: string) => string; wasOpen: (k: string) => boolean; keepOpen: (k: string, on: boolean) => void };
const forget = (await import(/* @vite-ignore */ at('forget'))) as { runForget: () => Promise<number> };

describe("the phone's folds", () => {
  it('remembers per chat, turn and piece, and lets go when closed', () => {
    const run = folds.foldKey('s1', 't1', 'run:3');
    expect(folds.wasOpen(run)).toBe(false);
    folds.keepOpen(run, true);
    expect(folds.wasOpen(run)).toBe(true);
    // The turn's own line, the same piece in another turn and in another chat are their own.
    expect(folds.wasOpen(folds.foldKey('s1', 't1'))).toBe(false);
    expect(folds.wasOpen(folds.foldKey('s1', 't2', 'run:3'))).toBe(false);
    expect(folds.wasOpen(folds.foldKey('s2', 't1', 'run:3'))).toBe(false);
    folds.keepOpen(run, false);
    expect(folds.wasOpen(run)).toBe(false);
  });

  it('is bounded: the oldest goes first, one opened again counts as new', () => {
    folds.keepOpen('first', true);
    folds.keepOpen('second', true);
    for (let i = 0; i < folds.FOLDS_MAX - 2; i++) folds.keepOpen(`k${i}`, true);
    folds.keepOpen('first', true);
    folds.keepOpen('one more', true);
    expect(folds.wasOpen('first')).toBe(true);
    expect(folds.wasOpen('second')).toBe(false);
    expect(folds.wasOpen('one more')).toBe(true);
  });

  it('goes with the desktop', async () => {
    folds.keepOpen('kept', true);
    expect(await forget.runForget()).toBe(0);
    expect(folds.wasOpen('kept')).toBe(false);
  });
});
