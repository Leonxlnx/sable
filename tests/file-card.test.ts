import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@shared/protocol';
import { capsFromAnywhere } from '@/features/composer/choice';
import { folderOf, shareReadable, sharedPath, sheetKey } from '@/features/timeline/FileCard';
import { coverWord, sheetOf, wantsText } from '@/features/timeline/file-sheet';

describe('folderOf', () => {
  it('names where a shared file lies, relative to the session folder or home', () => {
    expect(folderOf('C:\\work\\relay-api\\reports\\audit.pdf', 'C:\\work\\relay-api', 'C:\\Users\\me')).toBe('reports');
    expect(folderOf('/work/relay-api/out/a/b.csv', '/work/relay-api', '/home/me')).toBe('out/a');
    expect(folderOf('/home/me/Downloads/b.csv', '/work/relay-api', '/home/me')).toBe('~/Downloads');
    expect(folderOf('/srv/data/b.csv', '/work/relay-api', '/home/me')).toBe('/srv/data');
  });

  it('says the folder itself by name when the file lies right in it', () => {
    expect(folderOf('/work/relay-api/audit.pdf', '/work/relay-api', '/home/me')).toBe('relay-api');
    expect(folderOf('C:\\work\\relay-api\\audit.pdf', 'C:\\work\\relay-api\\', '')).toBe('relay-api');
  });

  it('has nothing to say for a bare name', () => {
    expect(folderOf('audit.pdf', '/work', '/home/me')).toBe('');
  });
});

describe('a shared file on its card', () => {
  it('is read for its page only once the share went through', () => {
    expect(shareReadable({ status: 'done' })).toBe(true);
    for (const status of ['pending', 'running', 'awaiting', 'denied', 'cancelled', 'error'] as const) expect(shareReadable({ status }), status).toBe(false);
  });

  it('lies in the chat folder when the agent named it relative to it', () => {
    expect(sharedPath('reports/audit.pdf', 'C:\\work\\relay-api')).toBe('C:\\work\\relay-api\\reports/audit.pdf');
    expect(sharedPath('./out.csv', '/work/relay-api/')).toBe('/work/relay-api/out.csv');
    expect(sharedPath('C:\\Users\\me\\a.txt', 'C:\\work')).toBe('C:\\Users\\me\\a.txt');
    expect(sharedPath('/srv/a.txt', '/work')).toBe('/srv/a.txt');
    expect(sharedPath('a.txt', '')).toBe('a.txt');
  });

  it('keeps its page per share step: the same file shared again at the same size is read again', () => {
    const before = sheetKey('share-1', 0, 'C:\\work\\report.md', 1200);
    expect(sheetKey('share-2', 0, 'C:\\work\\report.md', 1200)).not.toBe(before);
    expect(sheetKey('share-1', 0, 'C:\\work\\report.md', 1200)).toBe(before);
    expect(sheetKey('share-1', 1, 'C:\\work\\report.md', 1200)).not.toBe(before);
  });
});

describe('a file card sheet', () => {
  it('reads only what a first page needs, and nothing for kinds it cannot show', () => {
    expect(wantsText('notes.md', 900)).toBeGreaterThan(0);
    expect(wantsText('data.CSV')).toBeGreaterThan(0);
    expect(wantsText('audit.pdf', 1024)).toBe(0);
    expect(wantsText('shot.png', 4000)).toBe(0);
    expect(wantsText('empty.txt', 0)).toBe(0);
    expect(wantsText('logo.svg', 2000)).toBeGreaterThan(2000);
    expect(wantsText('huge.svg', 5_000_000)).toBe(0);
  });

  it('names the kind on a cover by its extension', () => {
    expect(coverWord('auth-audit.pdf')).toBe('.pdf');
    expect(coverWord('Build.ZIP')).toBe('.zip');
    expect(coverWord('Makefile')).toBe('file');
    expect(coverWord('.gitignore')).toBe('file');
    expect(coverWord('odd.name with spaces')).toBe('file');
  });

  it('shows text by its first lines, a Markdown heading without its marks', () => {
    const s = sheetOf('notes.md', '\uFEFF\n# Title\n\nfirst line\n\tindented', false);
    expect(s).toEqual({ kind: 'text', lines: [{ text: 'Title', head: true }, { text: '' }, { text: 'first line' }, { text: '  indented' }] });
    // A cut read ends in a piece of a line: it is left out.
    const cut = sheetOf('a.txt', 'one\ntwo\nthr', true);
    expect(cut.kind === 'text' && cut.lines.map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('shows CSV as a table, quoted cells whole, rows evened out', () => {
    const s = sheetOf('t.csv', 'route,p50,p95\n"GET /a,b",1.2,4\nshort,1\n', false);
    expect(s).toEqual({ kind: 'table', rows: [['route', 'p50', 'p95'], ['GET /a,b', '1.2', '4'], ['short', '1', '']] });
    expect(sheetOf('one-column.csv', 'a\nb\n', false).kind).toBe('text');
  });

  it('shows a whole SVG as an image and falls back to a cover otherwise', () => {
    const s = sheetOf('m.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', false);
    expect(s.kind === 'image' && s.src.startsWith('data:image/svg+xml;charset=utf-8,%3Csvg')).toBe(true);
    expect(sheetOf('m.svg', '<svg ', true).kind).toBe('cover');
    expect(sheetOf('m.svg', 'not a drawing', false).kind).toBe('cover');
    expect(sheetOf('a.txt', '   \n', false).kind).toBe('cover');
  });
});

describe('capsFromAnywhere', () => {
  const caps = (n: string) => ({ n }) as unknown as Capabilities;
  it("lends an agent's answer from another folder, under the same account only", () => {
    const all = { 'codex:': caps('codex'), 'claude:D:/a': caps('default'), 'claude:D:/b@work': caps('work') };
    expect(capsFromAnywhere(all, 'claude', undefined)).toBe(all['claude:D:/a']);
    expect(capsFromAnywhere(all, 'claude', 'default')).toBe(all['claude:D:/a']);
    expect(capsFromAnywhere(all, 'claude', 'work')).toBe(all['claude:D:/b@work']);
    expect(capsFromAnywhere(all, 'claude', 'other')).toBeUndefined();
    expect(capsFromAnywhere(all, 'demo', undefined)).toBeUndefined();
  });
});
