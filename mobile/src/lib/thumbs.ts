import { useEffect, useState } from 'react';
import { kindOfFile } from '@m/ui/FileGlyph';
import { conn } from './conn';
import { isTransport } from './errors';

/**
 * Small pictures of the files an agent handed over, for their rows (`phone.thumb`: the desktop's
 * own thumbnail of a picture, a PDF's first page, a video's frame). Asked once per file of a share
 * step and kept for this run (the last ones only); decoded before they show, so a row's picture
 * comes in whole. A desktop without them, or a file with none, keeps the row's drawn page.
 */
export type ThumbKind = 'image' | 'pdf' | 'video';
export interface Thumb {
  src: string;
  kind: ThumbKind;
}

const KEEP = 48;
/** By chat, step and file: the picture, or null when the desktop has none. */
const kept = new Map<string, Thumb | null>();
const asking = new Map<string, Promise<Thumb | null>>();

/** Which files a picture is asked for: pictures (not drawings), PDFs and videos. */
export function thumbKind(name: string): ThumbKind | null {
  const k = kindOfFile(name);
  if (k === 'image') return /\.svg$/i.test(name) ? null : 'image';
  return k === 'pdf' || k === 'video' ? k : null;
}

const keyOf = (sid: string, itemId: string, index: number) => `${sid}\u0000${itemId}\u0000${index}`;

function load(sid: string, itemId: string, index: number, kind: ThumbKind): Promise<Thumb | null> {
  const key = keyOf(sid, itemId, index);
  let p = asking.get(key);
  if (!p) {
    p = conn
      .call('phone.thumb', { sessionId: sid, itemId, index }, 30_000)
      .then(
        async (r) => {
          if (!r.data) return null;
          const img = new Image();
          img.src = r.data;
          await img.decode().catch(() => {});
          return { src: r.data, kind };
        },
        (err: Error) => {
          // The connection failed the call (never sent, lost on the way, no answer in time): asked again once
          // connected, never kept as "none". The desktop's own no (an older desktop, a changed file): none.
          if (isTransport(err)) throw err;
          return null;
        },
      )
      .then((t) => {
        kept.delete(key);
        kept.set(key, t);
        while (kept.size > KEEP) kept.delete(kept.keys().next().value as string);
        return t;
      })
      .finally(() => asking.delete(key));
    asking.set(key, p);
  }
  return p;
}

/** The picture of file `index` of share step `itemId` (null until it is there, or when there is none). */
export function useThumb(sid: string, itemId: string, index: number, name: string, size?: number): Thumb | null {
  const kind = size === 0 ? null : thumbKind(name);
  const key = keyOf(sid, itemId, index);
  const [got, setGot] = useState<{ key: string; t: Thumb | null } | null>(null);
  useEffect(() => {
    if (!kind || kept.has(key)) return;
    let live = true;
    let off: (() => void) | undefined;
    const ask = () =>
      load(sid, itemId, index, kind).then(
        (t) => live && setGot({ key, t }),
        // Not connected yet (a chat restored at launch) or no answer: asked again once the desktop is there.
        () => {
          if (live && !off) off = conn.onOpen(() => (off?.(), (off = undefined), void ask()));
        },
      );
    void ask();
    return () => {
      live = false;
      off?.();
    };
  }, [key, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!kind) return null;
  return kept.get(key) ?? (got?.key === key ? got.t : null);
}
