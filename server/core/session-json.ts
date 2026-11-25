import type * as fs from 'node:fs';

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
