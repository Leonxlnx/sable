import { memo, useEffect, useState } from 'react';
import type { SharedFile, ToolItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { fileIcon } from '@/features/composer/file-icon';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatBytes, relPath } from '@/lib/format';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useTimeline } from './ctx';
import { coverWord, pictureFit, pictureKind, sheetOf, wantsText, type Sheet } from './file-sheet';
import { isActive } from './util';
import './files.css';

/** Opens a file with the system's app for it, or shows it in the file manager. */
function openFile(path: string, reveal = false) {
  bridge.call('fs.open', { path, reveal }).catch((err: unknown) => useStore.getState().toast((err as Error)?.message ?? String(err), 'error'));
}

/** Where a file lies, as the card names it: relative to the session's folder, the folder's own name when it lies right there. */
export function folderOf(file: string, cwd: string, home: string): string {
  const norm = file.replace(/\\/g, '/');
  const dir = norm.slice(0, Math.max(0, norm.lastIndexOf('/')));
  if (!dir) return '';
  const rel = relPath(dir, cwd || null, home || null);
  if (rel !== '.') return rel;
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return root.slice(root.lastIndexOf('/') + 1) || rel;
}

/** A shared file's path as the computer knows it: one the agent named relative to the chat's folder lies in that folder. */
export function sharedPath(file: string, cwd: string): string {
  if (!file || /^([a-z]:[\\/]|[\\/])/i.test(file) || !cwd) return file;
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${file.replace(/^\.[\\/]/, '')}`;
}

/** Whether a share step's files may be read for their cards: only once it went through (not while asked, nor denied, stopped or failed). */
export const shareReadable = (item: Pick<ToolItem, 'status'>) => item.status === 'done';

/**
 * The key a card's page is kept under: this share step's file (a file handed over again is another
 * step, so a report rewritten at the same size shows its new page), at its size.
 */
export const sheetKey = (itemId: string, index: number, path: string, size?: number) => `${itemId}\n${index}\n${path}\n${size ?? ''}`;

/**
 * Files the agent hands over (Claude Code's SendUserFile), always in view like a widget: its caption
 * as a quiet line, then one card per file, side by side.
 */
export const FileShare = memo(function FileShare({ item }: { item: ToolItem }) {
  const files = item.detail.files ?? [];
  const caption = item.detail.caption?.trim();
  const failed = item.status === 'error';
  // A page of the file only once the share went through (never for one waiting, denied or stopped).
  const readable = shareReadable(item);
  if (!files.length) {
    // The call is still arriving: one card's room, so nothing jumps when the files are named.
    return isActive(item) ? (
      <div className="fshare">
        <div className="fshare-list">
          <div className="fcard fcard-wait" aria-busy>
            <span className="fcard-stage" aria-hidden>
              <span className="fcard-sheet">
                <span className="fcard-cover">
                  <span className="fcard-wait-line skel" style={{ width: '46%' }} />
                  <span className="fcard-wait-line skel" style={{ width: '78%' }} />
                  <span className="fcard-wait-line skel" style={{ width: '62%' }} />
                </span>
                <i className="fcard-fold" />
              </span>
            </span>
            <span className="fcard-foot">
              <span className="fcard-open">
                <span className="fcard-name shimmer">Sharing files</span>
              </span>
              <span className="fcard-meta">&nbsp;</span>
            </span>
          </div>
        </div>
      </div>
    ) : null;
  }
  return (
    <div className="fshare">
      {caption && <Markdown text={caption} className="fshare-caption" />}
      <div className="fshare-list" role="list" aria-label={files.length === 1 ? 'Shared file' : 'Shared files'}>
        {files.map((f, i) => (
          <FileCard key={`${i}:${f.path}`} file={f} failed={failed} readable={readable} itemId={item.id} index={i} sheet={sheetKey(item.id, i, f.path, f.size)} />
        ))}
      </div>
    </div>
  );
});

// ── the sheet: what the file's first page looks like ──

/** Sheets read so far, by share step and file (`sheetKey`). */
const sheets = new Map<string, Sheet>();
const SHEETS_MAX = 120;

/**
 * The page a card shows: for a text file its real first lines (read once, a couple of kilobytes),
 * a table for CSV, the drawing itself for an SVG; for anything else a cover with its kind.
 * The cover shows at once and the page fades in over it, so the card never changes size.
 * `key` (`sheetKey`): a new key never shows the page read for another.
 */
function useSheet(file: SharedFile, at: string, key: string, skip: boolean): Sheet | null {
  const want = !skip && wantsText(file.name, file.size);
  const [read, setRead] = useState<{ key: string; sheet: Sheet } | null>(null);
  useEffect(() => {
    if (!want || sheets.has(key)) return;
    let live = true;
    bridge
      .call('fs.read', { path: at, maxBytes: want })
      .then((r) => {
        const s = sheetOf(file.name, r.binary ? '' : r.content, r.truncated);
        if (sheets.size >= SHEETS_MAX) sheets.delete(sheets.keys().next().value!);
        sheets.set(key, s);
        if (live) setRead({ key, sheet: s });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, want]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!want) return null;
  return sheets.get(key) ?? (read?.key === key ? read.sheet : null);
}

// ── the picture: what the bridge can show of a picture, a PDF or a video ──

/** A picture of a shared file, decoded, with its size in pixels. */
interface Picture {
  src: string;
  w: number;
  h: number;
}

/** Pictures asked for so far, by share step and file (`sheetKey`): null when there is none. */
const pictures = new Map<string, Picture | null>();
const PICTURES_MAX = 80;

/** The sheet's width in CSS pixels (files.css `.fcard-sheet`). */
const SHEET_W = 156;

/**
 * A picture of the file for its sheet (`file.thumb`: Windows' own thumbnail in the desktop app, the
 * picture itself in a dev bridge), for pictures, documents and videos once the share went through.
 * Asked once per step and file and decoded before it shows, so it comes in whole, at its size; until
 * then (and when there is none) the cover stays.
 */
function usePicture(file: SharedFile, itemId: string, index: number, key: string, skip: boolean): Picture | null {
  const { sessionId } = useTimeline();
  const want = !skip && !!sessionId && !wantsText(file.name, file.size) && file.size !== 0 && !!pictureKind(file.name);
  const [got, setGot] = useState<{ key: string; pic: Picture | null } | null>(null);
  useEffect(() => {
    if (!want || pictures.has(key)) return;
    let live = true;
    const size = Math.round(SHEET_W * Math.min(3, Math.max(1, window.devicePixelRatio || 1)));
    const done = (pic: Picture | null) => {
      if (pictures.size >= PICTURES_MAX) pictures.delete(pictures.keys().next().value!);
      pictures.set(key, pic);
      if (live) setGot({ key, pic });
    };
    bridge
      .call('file.thumb', { sessionId, itemId, index, size })
      .then(async ({ data }) => {
        if (!data) return done(null);
        const img = new Image();
        img.src = data;
        await img.decode();
        done({ src: data, w: img.naturalWidth, h: img.naturalHeight });
      })
      // Not there, changed, or not a picture after all: the cover stays (asked again for a new step).
      .catch(() => done(null));
    return () => {
      live = false;
    };
  }, [key, want]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!want) return null;
  return pictures.get(key) ?? (got?.key === key ? got.pic : null);
}

const PictureSheet = memo(function PictureSheet({ pic, kind }: { pic: Picture; kind: 'image' | 'page' | 'video' }) {
  const fit = pictureFit(kind, pic.w, pic.h, SHEET_W);
  return (
    <span className="fcard-sheet fcard-pic" data-pic={kind} data-small={fit.small || undefined} style={{ height: fit.height }}>
      <img className="fcard-pic-img" src={pic.src} alt="" draggable={false} decoding="async" />
      {kind === 'video' && (
        <span className="fcard-play">
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
            <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.2-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5Z" fill="currentColor" />
          </svg>
        </span>
      )}
    </span>
  );
});

const Page = memo(function Page({ sheet }: { sheet: Sheet }) {
  if (sheet.kind === 'table') {
    return (
      <span className="fcard-page fcard-table">
        {sheet.rows.map((row, r) => (
          <span key={r} className="fcard-tr">
            {row.map((cell, c) => (
              <span key={c} className="fcard-td">
                {cell}
              </span>
            ))}
          </span>
        ))}
      </span>
    );
  }
  if (sheet.kind === 'image') return <img className="fcard-page fcard-img" src={sheet.src} alt="" draggable={false} decoding="async" />;
  if (sheet.kind === 'text') {
    return (
      <span className="fcard-page fcard-lines">
        {sheet.lines.map((l, i) => (
          <span key={i} className="fcard-line" data-head={l.head || undefined}>
            {l.text || ' '}
          </span>
        ))}
      </span>
    );
  }
  return null;
});

/**
 * One file as a card: a sheet of it in a small well (its first lines where it is text, a picture of
 * it for pictures, documents and videos, a cover with its kind otherwise), its name, its size and
 * where it lies. The whole card opens the file
 * with its app; Show in folder and Copy path come forward on hover or focus.
 */
const FileCard = memo(function FileCard({ file, failed, readable, itemId, index, sheet: key }: { file: SharedFile; failed: boolean; readable: boolean; itemId: string; index: number; sheet: string }) {
  const { cwd, home } = useTimeline();
  // Where it is on the computer: a name relative to the chat's folder lies in it.
  const at = sharedPath(file.path, cwd);
  const where = folderOf(at, cwd, home);
  // The folder by its own name (the whole path is the card's tooltip, and Show in folder goes there).
  const folder = where.slice(where.replace(/\/+$/, '').lastIndexOf('/') + 1);
  const size = formatBytes(file.size);
  const sheet = useSheet(file, at, key, failed || !readable);
  const page = sheet && sheet.kind !== 'cover' ? sheet : null;
  const pic = usePicture(file, itemId, index, key, failed || !readable);
  const picKind = pictureKind(file.name);
  return (
    <div className="fcard" role="listitem" data-spot data-failed={failed || undefined}>
      <span className="fcard-stage" aria-hidden>
        {pic && picKind ? (
          <PictureSheet pic={pic} kind={picKind} />
        ) : (
          <span className="fcard-sheet">
            {page ? (
              <Page sheet={page} />
            ) : (
              <span className="fcard-cover">
                <span className="fcard-ext">{coverWord(file.name)}</span>
                <span className="fcard-rule" />
                <span className="fcard-rule" />
                <span className="fcard-rule" />
              </span>
            )}
            <i className="fcard-fold" />
          </span>
        )}
      </span>
      <span className="fcard-foot">
        {/* The one button that opens the file: it covers the card, so a click anywhere on it opens. */}
        <button type="button" className="fcard-open" onClick={() => openFile(at)} aria-label={`Open ${file.name}`} title={at}>
          <Icon name={fileIcon(file.name)} size={15} className="fcard-kind" />
          <span className="fcard-name truncate">{file.name}</span>
        </button>
        <span className="fcard-meta">
          {size && <span className="fcard-size num">{size}</span>}
          {folder && <span className="fcard-folder truncate">{folder}</span>}
          {failed && <span className="fcard-fail">Not shared</span>}
        </span>
      </span>
      <span className="fcard-acts">
        <IconButton icon="folder-open" label="Show in folder" size={14} tipSide="top" className="fcard-act" onClick={() => openFile(at, true)} />
        <CopyButton text={at} label="Copy path" size={14} className="fcard-act" />
      </span>
    </div>
  );
});
