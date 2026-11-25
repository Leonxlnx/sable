import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { createRequire } from 'node:module';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '../shared/protocol';
import { SessionFiles } from '../server/core/session-file';
import { largeRowReader } from '../server/core/session-json';
import { cutItem, LIGHT, workerCut } from '../server/core/trim';

it('projects escaped result text with ordinary numeric tokens at both densities', () => {
  const read = largeRowReader(isUtf8, workerCut, 1 << 20);
  // Include a surrogate pair, JSON Unicode escapes, escaped quotes and runs of backslashes.
  const text = ('start\\\n"🙂界\b\f\r\t/\x01' + 'p'.repeat(87)).repeat(800);
  const item: ToolItem = { id: 'shaped', type: 'tool', ts: 1730000000000, name: 'Bash', kind: 'bash',
    title: 'test', status: 'done', detail: {}, input: { path: 'z:\\fixture' }, result: { text, exitCode: 2.125 } };
  const raw = JSON.stringify(item).replaceAll('/', '\\/');
  for (const recent of [false, true]) {
    const cut = (it: ToolItem) => cutItem(it, recent ? workerCut.recent : workerCut.old);
    const got = read(Buffer.from(raw), recent, cut);
    expect(got?.value).toStrictEqual(cut(JSON.parse(raw)));
    expect(got?.chars).toBe(raw.length);
    for (const token of ['-0', '1e400', '-1e-400', '9007199254740993', '0.123456789012345678901']) {
      const line = raw.replace('2.125', token);
      expect(read(Buffer.from(line), recent, cut)?.value).toStrictEqual(cut(JSON.parse(line)));
    }
    const url = raw.replace('start', 'http\\u003a\\u002f\\/localhost');
    expect(read(Buffer.from(url), recent, cut)).toBeUndefined();
    for (const bad of ['\\u12az', '\\q', '\x02']) {
      expect(read(Buffer.from(raw.replace('start', bad)), recent, cut)).toBeUndefined();
    }
  }
});

it('counts escaped image strings by decoded size and indexes their exact source length', () => {
  const read = largeRowReader(isUtf8, workerCut, 1 << 20);
  const cut = (it: ToolItem) => cutItem(it, workerCut.old);
  const raw = (images: string[]) => JSON.stringify({ id: 'im', type: 'tool', status: 'done', kind: 'read',
    detail: {}, ts: 1, title: '界', result: { images } }).replaceAll('!', '\\u0021');
  const short = raw(['!'.repeat(80)]);
  expect(read(Buffer.from(short), false, cut)).toBeUndefined();
  const long = raw(['!'.repeat(80), '界🙂\n"\\'.repeat(500)]);
  const got = read(Buffer.from(long), false, cut);
  expect(got?.value).toStrictEqual(cut(JSON.parse(long)));
  expect(got?.chars).toBe(long.length);
  const collision = long.slice(0, -2) + ',"images":{"\\u0000":null}}}';
  expect(read(Buffer.from(collision), false, cut)).toBeUndefined();
});

it('matches the fully parsed cut and indexed original for every sampled shape at both densities', async () => {
  const fixture = (name: string) => gunzipSync(readFileSync(new URL('./fixtures/session-' + name + '.gz', import.meta.url)));
  const samples = JSON.parse(fixture('shapes.json').toString());
  const { rowFromShape } = createRequire(import.meta.url)('./fixtures/session-shapes.cjs');
  const bytes = fixture('rows.ndjson');
  function *lines() {
    for (let at = 0; at < bytes.length;) {
      const nl = bytes.indexOf(10, at), end = nl < 0 ? bytes.length : nl;
      yield bytes.subarray(at, end);
      at = end + 1;
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'sable-shapes-'));
  const file = (id: string) => path.join(dir, id + '.json');
  try {
    const fd = openSync(file('base'), 'wx');
    try {
      writeSync(fd, '{"gen":7,"items":[\n');
      let i = 0;
      for (const line of lines()) {
        assert.equal(line.toString(), JSON.stringify(rowFromShape(samples[i].row, i)));
        if (i++) writeSync(fd, ',\n');
        writeSync(fd, line);
      }
      assert.equal(i, 440);
      writeSync(fd, '\n],"todos":[]}');
    } finally { closeSync(fd); }
    for (const recent of [true, false]) {
      const turns = Array.from({length: 4}, (_, i) => ({ id: 'turn-' + i, ts: i, type: 'turn', durationMs: 1 }));
      if (!recent) writeFileSync(file('base.tail'), JSON.stringify({ baseGen: 7, items: turns }));
      const reader = new SessionFiles(file);
      const data = await reader.loadAsync('base');
      assert.equal(data.unreadable, undefined);
      assert.equal(data.items.length, samples.length + (recent ? 0 : turns.length));
      let i = 0;
      for (const line of lines()) {
        const whole = JSON.parse(line.toString());
        const item = data.items[i++] as TimelineItem & { [LIGHT]?: unknown };
        const { [LIGHT]: _, ...view } = item;
        assert.deepStrictEqual(view, cutItem(whole, recent ? workerCut.recent : workerCut.old));
        assert.deepStrictEqual(reader.wholeItem('base', item), whole);
      }
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
}, 30000);
