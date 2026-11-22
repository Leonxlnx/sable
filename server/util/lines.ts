import type { Readable } from 'node:stream';

/**
 * Newline-delimited frames from a child's stdout, each bounded before it is kept: `readline` holds a
 * whole line in memory until its newline comes, so one endless line from a broken or hostile agent
 * could fill the desktop process's memory. A frame over `maxBytes` is dropped as it grows (what came
 * of it and what follows up to its newline) and reported once through `onOverflow`.
 */
export function boundedLines(input: Readable, maxBytes: number, onLine: (line: string) => void, onOverflow?: (bytes: number) => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  /** Bytes of an oversized frame dropped so far (its newline has not come yet). */
  let skipping = 0;
  const emit = (buf: Buffer) => {
    let s = buf.toString('utf8');
    if (s.endsWith('\r')) s = s.slice(0, -1);
    onLine(s);
  };
  input.on('data', (chunk: Buffer | string) => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (buf.length) {
      const nl = buf.indexOf(0x0a);
      const piece = nl < 0 ? buf : buf.subarray(0, nl);
      if (skipping) skipping += piece.length;
      else if (size + piece.length > maxBytes) {
        skipping = size + piece.length;
        parts = [];
        size = 0;
      } else {
        parts.push(piece);
        size += piece.length;
      }
      if (nl < 0) break;
      if (skipping) {
        onOverflow?.(skipping);
        skipping = 0;
      } else {
        emit(parts.length === 1 ? parts[0] : Buffer.concat(parts, size));
        parts = [];
        size = 0;
      }
      buf = buf.subarray(nl + 1);
    }
  });
  input.on('end', () => {
    if (!skipping && size) emit(Buffer.concat(parts, size));
    parts = [];
    size = 0;
  });
}
