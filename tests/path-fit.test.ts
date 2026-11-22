/**
 * A path's directory cut by whole folders (src/ui/path-fit.ts): the folders nearest the name stay,
 * a folder's name is never split, and the label says "…/" for what went.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dirCandidates, pickDir } from '../src/ui/path-fit';

describe('a directory cut by whole folders', () => {
  it('offers the whole directory, then one leading folder less each time, then the mark alone', () => {
    expect(dirCandidates('~/AppData/Local/Temp/')).toEqual(['~/AppData/Local/Temp/', '…/AppData/Local/Temp/', '…/Local/Temp/', '…/Temp/', '…/']);
    expect(dirCandidates('C:/Users/')).toEqual(['C:/Users/', '…/Users/', '…/']);
    expect(dirCandidates('src/')).toEqual(['src/', '…/']);
    expect(dirCandidates('/')).toEqual(['/', '…/']);
  });

  it('takes the longest that fits, and the mark alone when nothing does', () => {
    const c = dirCandidates('~/AppData/Local/Temp/');
    const w = [140, 150, 96, 56, 14];
    expect(pickDir(c, w, 200)).toBe('~/AppData/Local/Temp/');
    // The first cut is longer than the whole ("…/" is wider than "~/"): the next one that fits is taken.
    expect(pickDir(c, w, 139)).toBe('…/Local/Temp/');
    expect(pickDir(c, w, 96.4)).toBe('…/Local/Temp/');
    expect(pickDir(c, w, 60)).toBe('…/Temp/');
    expect(pickDir(c, w, 5)).toBe('…/');
  });

  it('is asked for only where a few labels show (menus, settings, dialogs), never in the conversation', () => {
    const read = (p: string) => readFileSync(path.join(__dirname, '..', p), 'utf8');
    expect(read('src/features/composer/Controls.tsx')).toContain('<PathLabel fit ');
    expect(read('src/features/settings/parts.tsx')).toContain('<PathLabel fit ');
    // A turn's steps can mount by the hundred: they keep the plain label.
    expect(read('src/features/timeline/Tool.tsx')).not.toContain('<PathLabel fit');
    expect(read('src/features/timeline/Synthetic.tsx')).not.toContain('<PathLabel fit');
  });
});
