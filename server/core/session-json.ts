import type * as fs from 'node:fs';
import type { TimelineItem, ToolItem } from '../../shared/protocol';
import type { workerCut } from './trim';

/** The normal parser and cut still handle every field outside one bulky result value.
 * This shortcut only accepts an ordinary JSON string or array which the shared cut
 * actually shortens. Live steps, unusual encodings and ambiguous paths fall back. */
export function largeRowReader(isUtf8: (s: Buffer) => boolean, options: typeof workerCut) {
  const placeholder = ' '.repeat(Math.max(options.old.at, options.recent.at) + 1);
  // Six bytes cover even a JSON escape for one JS code unit.
  const edge = 6 * Math.max(options.old.at, options.old.head + options.old.tail) + 8;
  return function read(line: Buffer, recent: boolean, project: (it: ToolItem) => TimelineItem) {
    const length = line.length;
    const prefix = line.subarray(0, 8192);
    const words = new DataView(line.buffer, line.byteOffset, length);

    // Count the original UTF-16 source units, validating the skipped string body.
    // Four printable ASCII bytes can pass together. Quotes delimit the supplied span.
    function stringChars(start: number, end: number, plain: boolean) {
      let chars = end - start, wide = false;
      for (let i = start; i < end;) {
        if (i + 4 <= end) {
          const word = words.getUint32(i);
          // High bits test for ASCII and controls. XOR turns a backslash into
          // zero, so the standard zero-byte test finds escapes in any lane.
          const slash = word ^ 0x5c5c5c5c;
          if (!(word & 0x80808080) && !((word - 0x20202020) & 0x80808080) &&
              !((slash - 0x01010101) & ~slash & 0x80808080)) { i += 4; continue; }
        }
        const c = line[i++];
        if (c < 32) return -1;
        if (c === 92) {
          const esc = line[i++];
          if (plain || i > end || (esc !== 110 && esc !== 114 && esc !== 116)) return -1;
        } else if (c >= 128) {
          if (plain) return -1;
          wide = true;
          if (c < 192) chars--;
          else if (c >= 240) chars++; // a supplementary code point takes two JS units
        }
      }
      return wide && !isUtf8(line.subarray(start, end)) ? -1 : chars;
    }

    const images = prefix.indexOf('"images":[');
    if (images >= 0) {
      const begin = images + 9;
      let pos = begin + 1, count = 0;
      for (;;) {
        if (line[pos++] !== 34) return;
        const end = line.indexOf(34, pos);
        if (end < 0 || end >= length || stringChars(pos, end, true) < 0) return;
        count++;
        pos = end + 1;
        if (line[pos++] !== 44) break;
      }
      if (line[pos - 1] !== 93 || length - pos > 8192 || pos - begin <= placeholder.length + 2) return;
      const head = line.toString('utf8', 0, begin), tail = line.toString('utf8', pos, length);
      const item = JSON.parse(head + '0' + tail);
      // Changing just this span must change result.images. This rules out nested
      // namesakes and duplicate keys without implementing a second object parser.
      if (item?.type !== 'tool' || Object.hasOwn(item, options.mark) || item.result?.images !== 0 ||
          JSON.parse(head + '1' + tail).result?.images !== 1) return;
      item.result.images = Array(count).fill('');
      item.result.images[0] = placeholder;
      const view = project(item);
      if (view.type === 'tool' && view.result && !Object.hasOwn(view.result, 'images'))
        return { value: view, chars: head.length + pos - begin + tail.length };
      return;
    }

    if (recent) return;
    const file = prefix.indexOf('"content":"');
    const key = file >= 0 ? file : prefix.indexOf('"text":"');
    if (key < 0) return;
    const start = key + (file >= 0 ? 11 : 8);
    const end = line.indexOf(34, start);
    if (end - start <= 2 * edge || length - end > 8192) return;
    const bodyChars = stringChars(start, end, false);
    if (bodyChars < 0) return;
    const head = line.toString('utf8', 0, start - 1), tail = line.toString('utf8', end + 1, length);
    const item = JSON.parse(head + 'null' + tail);
    if (item?.type !== 'tool' || item.status !== 'done' || Object.hasOwn(item, options.mark)) return;
    const field = (it: ToolItem) => file >= 0 ? it.result?.file?.content : it.result?.text;
    if (field(item) !== null) return;
    // A folded command can show announcement lines from its middle. Escaped
    // colons were already refused by stringChars. Leave all possible URLs to cut.
    if (file < 0 && item.kind === 'bash' && line.subarray(start, end).includes(58)) return;
    let left = start + edge, right = end - edge;
    while (line[left] >= 128 || line[left - 1] === 92) left++;
    while (line[right] >= 128 || line[right - 1] === 92) right--;
    if (left >= right) return;
    const sample = line.toString('utf8', start - 1, left) + line.toString('utf8', right, end + 1);
    const short = JSON.parse(head + sample + tail);
    if (typeof field(short) !== 'string') return;
    const view = project(short);
    if (view.type === 'tool' && field(view) !== field(short))
      return { value: view, chars: head.length + bodyChars + 2 + tail.length };
  };
}

/** Opening and searching use the same generation, prefix and replacement rules. A missing
 * offset or one outside the base appends the suffix. An unmatched override has no visible row. */
export function sessionTail<T>(baseGen: unknown, mtime: number, tail: { baseGen?: number; from?: number } | null, length: number, overrides: Map<string, T>) {
  const gen = typeof baseGen === 'number' ? baseGen : -mtime;
  if (!tail || tail.baseGen !== gen) return null;
  const from = tail.from;
  return {
    from: typeof from === 'number' && Number.isInteger(from) && from >= 0 && from <= length ? from : length,
    item: (id: string, original: T) => overrides.has(id) ? overrides.get(id)! : original,
  };
}

/** Parse each member of the large root arrays independently, preserving its original byte range.
 * Also runs verbatim in the worker. JSON.parse validates each value, the cursor validates separators. */
export function scanSession(io: typeof fs, fd: number, visit: (key: string, value: any, offset: number, length: number, chars: number) => void) {
  const size = io.fstatSync(fd).size;
  const buf = Buffer.allocUnsafe(1 << 18);
  let pos = 0, start = 0, end = 0;
  function peek() {
    if (pos === end && pos < size) {
      start = pos;
      end += io.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      if (end === start) throw new Error('Incomplete session file');
    }
    return pos < end ? buf[pos - start] : -1;
  }
  function space() {
    for (let c = peek(); c === 32 || c === 9 || c === 10 || c === 13; c = peek()) pos++;
    return peek();
  }
  function take(char: number) {
    if (space() !== char) throw new Error('Invalid session JSON');
    pos++;
  }
  function value() {
    const offset = pos;
    let depth = 0, string = false, escape = false;
    let c = peek();
    if (c < 0) throw new Error('Missing JSON value');
    do {
      if (string) {
        if (escape) escape = false;
        else if (c === 92) escape = true;
        else if (c === 34) string = false;
        else {
          // Scan ordinary string bytes without calling peek for each one.
          let i = pos - start + 1;
          const n = end - start;
          while (i < n && buf[i] !== 34 && buf[i] !== 92) i++;
          pos = start + i;
          c = peek();
          continue;
        }
      } else if (c === 34) string = true;
      else if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) {
        if (!depth) break;
        depth--;
      } else if (!depth && (c === 44 || c === 58 || c <= 32)) break;
      pos++;
      if (!depth && !string && (c === 34 || c === 125 || c === 93)) break;
      c = peek();
    } while (c >= 0);
    const length = pos - offset;
    let bytes;
    if (offset >= start) bytes = buf.subarray(offset - start, pos - start);
    else {
      bytes = Buffer.allocUnsafe(length);
      for (let i = 0; i < length;) {
        const n = io.readSync(fd, bytes, i, length - i, offset + i);
        if (!n) throw new Error('Incomplete JSON value');
        i += n;
      }
    }
    const json = bytes.toString('utf8');
    return { parsed: JSON.parse(json), chars: json.length, offset, length };
  }
  const meta: Record<string, any> = Object.create(null);
  take(123);
  if (space() !== 125) for (;;) {
    if (space() !== 34) throw new Error('Expected a session field');
    const key = value().parsed as string;
    take(58);
    if (space() === 91 && ['items', 'over', 'todos', 'queue'].includes(key)) {
      pos++;
      if (Object.hasOwn(meta, key)) throw new Error('Duplicate session field');
      meta[key] = [];
      if (space() !== 93) for (;;) {
        space();
        const row = value();
        visit(key, row.parsed, row.offset, row.length, row.chars);
        if (space() === 93) break;
        take(44);
      }
      take(93);
    } else meta[key] = value().parsed;
    if (space() === 125) break;
    take(44);
  }
  take(125);
  if (space() !== -1 || !Array.isArray(meta.items)) throw new Error('Invalid session document');
  return meta;
}
