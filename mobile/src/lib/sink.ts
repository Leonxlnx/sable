import type { FilesPlugin } from './download-core';

/**
 * Where the secure channel's bytes go without Android (the web preview, tests): in memory, written
 * strictly in order, checked whole with WebCrypto against the digest before they count, as
 * FilesPlugin.java does with the app's private files. Bounded (`max` bytes in all): a file's whole
 * size is reserved when it is admitted (`stageBegin`), so two files that each fit cannot together
 * pass the bound while they are written. A check still running when everything is forgotten keeps
 * nothing (its generation is gone).
 */
export function memorySink(opts: { max?: number } = {}) {
  const max = opts.max ?? 64 * 1024 * 1024;
  type Part = { key: string; name: string; size: number; sha256: string; chunks: Uint8Array[]; have: number };
  const parts = new Map<string, Part>();
  const files = new Map<string, { name: string; bytes: Uint8Array }>();
  /** Bytes reserved: each file being written by its whole size, each verified file by its bytes. */
  let used = 0;
  let next = 0;
  let gen = 0;
  const unb64 = (s: string) => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sink: Pick<FilesPlugin, 'stageBegin' | 'stageWrite' | 'stageFinish' | 'stageDrop'> & {
    open(file: string): void;
    forgetAll(): void;
    /** A verified file's bytes (tests). */
    bytesOf(file: string): Uint8Array | undefined;
    used(): number;
  } = {
    async stageBegin(o) {
      for (const [id, p] of parts) if (p.key === o.key && p.sha256 === o.sha256 && p.size === o.size && p.name === o.name) return { id, have: p.have };
      for (const [id, p] of parts) if (p.key === o.key) (parts.delete(id), (used -= p.size));
      // Admitted with its whole size reserved.
      if (o.size > max - used) throw new Error('Not enough space on this phone.');
      used += o.size;
      const id = `m${++next}`;
      parts.set(id, { key: o.key, name: o.name, size: o.size, sha256: o.sha256.toLowerCase(), chunks: [], have: 0 });
      return { id, have: 0 };
    },
    async stageWrite(o) {
      const p = parts.get(o.id);
      if (!p) throw new Error('The download stopped. Try again.');
      if (o.offset !== p.have) throw new Error('The download stopped. Try again.');
      const b = unb64(o.data);
      if (p.have + b.length > p.size) throw new Error('The download stopped. Try again.');
      p.chunks.push(b);
      p.have += b.length;
      return { have: p.have };
    },
    async stageFinish(o) {
      const p = parts.get(o.id);
      if (!p) throw new Error('The file is no longer on this phone.');
      parts.delete(o.id);
      const g = gen;
      const bytes = new Uint8Array(p.have);
      let at = 0;
      for (const c of p.chunks) (bytes.set(c, at), (at += c.length));
      const ok = p.have === p.size && hex(await crypto.subtle.digest('SHA-256', bytes)) === p.sha256;
      // Forgotten while it was checked: nothing of it is kept.
      if (g !== gen) return { ok: false };
      if (!ok) {
        used -= p.size;
        return { ok: false };
      }
      files.set(o.id, { name: p.name, bytes });
      return { ok: true, file: o.id };
    },
    async stageDrop(o) {
      const p = parts.get(o.id);
      if (p) (parts.delete(o.id), (used -= p.size));
    },
    open(file) {
      const f = files.get(file);
      if (!f) throw new Error('The file is no longer on this phone.');
      const url = URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>]));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    forgetAll() {
      gen++;
      parts.clear();
      files.clear();
      used = 0;
    },
    /** Bytes reserved now (tests). */
    used: () => used,
    bytesOf: (file) => files.get(file)?.bytes,
  };
  return sink;
}
