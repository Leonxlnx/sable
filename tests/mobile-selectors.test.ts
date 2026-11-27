/**
 * The phone's screens never read all of a chat's loaded steps inside a store selector: a selector runs on
 * every write to the store. 2.22's first build did (the chat header's and the last line's "since when
 * does the background work run" and the monitors' count): three walks over every loaded step per
 * streamed event while a chat with background work was open.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../mobile/src/screens/', import.meta.url);
/** Readings that walk every loaded step of a chat (lib/work-now.ts). */
const WALKS = /(backgroundSince|runningMonitors)\(/;

describe("the phone reads a chat's steps outside store selectors", () => {
  it('no screen calls a whole-chat reading in a useStore selector', () => {
    const bad: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) {
      readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/useStore\(/.test(line) && WALKS.test(line)) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("the chat screen reads them when the chat's own counts change, in one place", () => {
    const chat = readFileSync(new URL('Chat.tsx', dir), 'utf8');
    expect(chat).toMatch(/function useBackground\(id: string\)/);
    // The header's words and the last line, nothing else.
    expect(chat.match(/useBackground\(id\)/g)?.length).toBe(2);
    expect(chat).toMatch(/\[id, key, tick\]/);
  });
});
