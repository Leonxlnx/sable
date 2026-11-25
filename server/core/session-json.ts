import type * as fs from 'node:fs';
import type { TimelineItem, ToolItem } from '../../shared/protocol';
import type { workerCut } from './trim';

/** Validate the omitted JSON token and parse its surroundings with the native parser.
 * The original byte span must fit the same whole-row reader used for indexed seeks. */
export function largeRowReader(isUtf8: (s: Buffer) => boolean, options: typeof workerCut, maxStringLength: number) {
  const placeholder = ' '.repeat(Math.max(options.old.at, options.recent.at) + 1);
  const url = /(?::|\\u003a)(?:\/|\\\/|\\u002f){2}/i;

  // Tag just the replaced token. A NUL in JSON has only one spelling, so
  // finding this key at the expected path proves which occurrence survived
  // JSON.parse, including duplicate keys. Probe twice only on a potential collision.
  function parseAt(head: string, sample: string, tail: string, key: 'images' | 'text' | 'content') {
    const owner = (item: any) => key === 'content' ? item?.result?.file : item?.result;
    const item = JSON.parse(head + '{"\\u0000":' + sample + '}' + tail);
    const target = owner(item), tag = target?.[key];
    if (item?.type !== 'tool' || Object.hasOwn(item, options.mark) || !tag || !Object.hasOwn(tag, '\0')) return;
    if ((head.includes('\\u0000') || tail.includes('\\u0000')) && owner(JSON.parse(head + 'null' + tail))?.[key] !== null) return;
    target[key] = tag['\0'];
    return item as ToolItem;
  }

  return function read(line: Buffer, recent: boolean, project: (it: ToolItem) => TimelineItem) {
    const length = line.length;
    if (length > maxStringLength) return;
    const cut = recent ? options.recent : options.old;
    const prefix = line.subarray(0, 8192);

    // Walk JSON tokens once. The two most recent tail checkpoints bound the
    // suffix we copy. Both edges fall between tokens, including UTF-8 and \u escapes.
    function stringBody(start: number, head: number, tail: number) {
      let at = start, units = 0, excess = 0, left = start, right = start, checkpoint = start, next = tail + 1;
      while (at < length) {
        const before = units;
        const c = line[at++];
        if (c === 34) {
          const end = at - 1;
          if (excess && !isUtf8(line.subarray(start, end))) return;
          return { end, units, excess, left, right: tail ? right : end };
        }
        if (c < 32) return;
        if (c === 92) {
          const esc = line[at++];
          if (esc === 117) {
            for (let i = 0; i < 4; i++) {
              const hex = line[at++];
              if (!(hex >= 48 && hex <= 57 || (hex | 32) >= 97 && (hex | 32) <= 102)) return;
            }
          } else if (!(esc === 34 || esc === 47 || esc === 92 || esc === 98 || esc === 102 ||
                       esc === 110 || esc === 114 || esc === 116)) return;
        } else if (c >= 128) {
          if (c < 194 || c > 244) return;
          const width = c < 224 ? 2 : c < 240 ? 3 : 4;
          at += width - 1;
          if (width === 4) units++;
          excess += width === 2 ? 1 : 2;
        }
        units++;
        if (before <= head) left = at;
        if (tail && units >= next) {
          right = checkpoint;
          checkpoint = at;
          next = units + tail + 1;
        }
      }
    }

    const images = prefix.indexOf('"images":[');
    if (images >= 0) {
      const begin = images + 9;
      const words = new DataView(line.buffer, line.byteOffset, length);
      function plain(start: number, end: number) {
        if (line.subarray(start, end).includes(92)) return false;
        let at = start;
        for (; at + 16 <= end; at += 16) {
          const a = words.getUint32(at), b = words.getUint32(at + 4);
          const c = words.getUint32(at + 8), d = words.getUint32(at + 12);
          if ((a | b | c | d | (a - 0x20202020) | (b - 0x20202020) |
              (c - 0x20202020) | (d - 0x20202020)) & 0x80808080) return false;
        }
        for (; at < end; at++) if (line[at] < 32 || line[at] >= 128) return false;
        return true;
      }
      let pos = begin + 1, count = 0, excessBytes = 0, size = 0;
      for (;;) {
        if (line[pos++] !== 34) return;
        let end = line.indexOf(34, pos);
        if (end < 0) return;
        if (plain(pos, end)) size += end - pos + 3;
        else {
          const body = stringBody(pos, 0, 0);
          if (!body) return;
          end = body.end;
          size += body.units + 3;
          excessBytes += body.excess;
        }
        count++;
        pos = end + 1;
        if (line[pos++] !== 44) break;
      }
      if (line[pos - 1] !== 93 || length - pos > 8192 || size <= cut.at) return;
      const head = line.toString('utf8', 0, begin), tail = line.toString('utf8', pos, length);
      const item = parseAt(head, 'null', tail, 'images');
      if (!item?.result) return;
      item.result.images = Array(count).fill('');
      item.result.images[0] = placeholder;
      const view = project(item);
      if (view.type === 'tool' && view.result && !Object.hasOwn(view.result, 'images'))
        return { value: view, chars: head.length + pos - begin - excessBytes + tail.length };
      return;
    }

    const result = prefix.indexOf('"result":{');
    if (result < 0) return;
    const file = prefix.indexOf('"content":"', result);
    const key = file >= 0 ? file : prefix.indexOf('"text":"', result);
    if (key < 0) return;
    const start = key + (file >= 0 ? 11 : 8);
    const body = stringBody(start, file >= 0 ? cut.head + cut.tail : cut.head, file >= 0 ? 0 : cut.tail);
    if (!body || body.units <= cut.at || body.left >= body.right) return;
    const end = body.end;
    if (length - end > 8192) return;
    const head = line.toString('utf8', 0, start - 1), tail = line.toString('utf8', end + 1);
    const field = (it: ToolItem) => file >= 0 ? it.result?.file?.content : it.result?.text;
    const sample = line.toString('utf8', start - 1, body.left) + placeholder.slice(0, cut.at + 1) +
      line.toString('utf8', body.right, end + 1);
    const short = parseAt(head, sample, tail, file >= 0 ? 'content' : 'text');
    if (short?.status !== 'done') return;
    // A bash preview (including its private reread flag) can depend on a URL in
    // the discarded middle. Include escaped colons and slashes in that check.
    if (file < 0 && short.kind === 'bash') {
      const raw = line.subarray(start, end);
      if ((raw.includes(58) || raw.includes('\\u003')) && url.test(raw.toString())) return;
    }
    const view = project(short);
    if (view.type === 'tool' && field(view) !== field(short))
      return { value: view, chars: head.length + end - start - body.excess + 2 + tail.length };
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
