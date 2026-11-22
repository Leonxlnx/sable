import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { SharedFile, ToolItem } from '@shared/protocol';
import { CopyButton } from '@/components/CopyButton';
import { Markdown } from '@/components/Markdown';
import { fileIcon } from '@/features/composer/file-icon';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { formatBytes, relPath } from '@/lib/format';
import { reducedMotion } from '@/lib/motion';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { useFresh, useTimeline } from './ctx';
import { coverKind, coverWord, pictureFit, pictureKind, sheetOf, wantsText, type CoverKind, type Sheet } from './file-sheet';
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

// ── arriving ──

/** How long the arrival of a row of cards may take, with its staggers: after it the cards are at rest and only answer the pointer. */
const ARRIVE_MS = 1700;

/**
 * One observer for every card waiting for its first look at the screen: each card is decided on its
 * own (a share of many cards in a narrow pane is several rows, some of them off screen).
 */
const firstLooks = new Map<Element, (seen: boolean) => void>();
let looker: IntersectionObserver | null = null;
export function firstLook(el: Element, then: (seen: boolean) => void): () => void {
  looker ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      const cb = firstLooks.get(e.target);
      if (!cb) continue;
      firstLooks.delete(e.target);
      looker?.unobserve(e.target);
      cb(e.isIntersecting);
    }
  });
  firstLooks.set(el, then);
  looker.observe(el);
  return () => {
    if (!firstLooks.delete(el)) return;
    looker?.unobserve(el);
  };
}

/**
 * The arrival of a row of cards (files.css, `.fcard[data-arrive]`): only for a share that happens
 * while you watch (`fresh`), and only for the cards on screen when its files are named. Before the
 * row's first paint every card is marked waiting (`data-arrive="wait"`: every part held at its first
 * frame), and each card's own first look at the screen decides, once: in view, its motion runs
 * (`go`) and the mark is taken away when it is over; out of view, the mark goes at once and the card
 * simply stands there. Nothing ever moves off screen, and nothing is left running. (The marks are
 * written here, never rendered, so a later render of the row does not bring them back.)
 */
function useArrival(fresh: boolean, named: boolean) {
  const row = useRef<HTMLDivElement>(null);
  const decided = useRef(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !fresh || !named || decided.current) return;
    if (reducedMotion() || typeof IntersectionObserver === 'undefined') {
      decided.current = true;
      return;
    }
    const cards = Array.from(el.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('fcard'));
    const timers: number[] = [];
    const offs = cards.map((card) => {
      card.dataset.arrive = 'wait';
      return firstLook(card, (seen) => {
        decided.current = true;
        if (!seen) return void delete card.dataset.arrive;
        card.dataset.arrive = 'go';
        timers.push(window.setTimeout(() => delete card.dataset.arrive, ARRIVE_MS));
      });
    });
    return () => {
      offs.forEach((off) => off());
      timers.forEach((t) => window.clearTimeout(t));
      for (const card of cards) delete card.dataset.arrive;
    };
  }, [fresh, named]);
  return row;
}

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
  const active = isActive(item);
  // Shared while you watch: the cards arrive. History being laid out simply stands there.
  const fresh = useFresh(item.endedAt ?? item.ts);
  // The first card takes the place of the one that waited ("Sharing files"): its sheet is already in the well.
  const waited = useRef(false);
  const row = useArrival(fresh, files.length > 0);
  if (!files.length) {
    if (!active) return null;
    waited.current = true;
    // The call is still arriving: one card's room, so nothing jumps when the files are named.
    return (
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
    );
  }
  return (
    <div className="fshare">
      {caption && <Markdown text={caption} className="fshare-caption" />}
      <div
        className="fshare-list"
        role="list"
        aria-label={files.length === 1 ? 'Shared file' : 'Shared files'}
        ref={row}
        data-waited={waited.current || undefined}
      >
        {files.map((f, i) => (
          <FileCard key={`${i}:${f.path}`} file={f} failed={failed} readable={readable} active={active} itemId={item.id} index={i} sheet={sheetKey(item.id, i, f.path, f.size)} />
        ))}
      </div>
    </div>
  );
});

// ── the sheet: what the file's first page looks like ──

/** Sheets read so far, by share step and file (`sheetKey`). */
const sheets = new Map<string, Sheet>();
const SHEETS_MAX = 120;
/** A file that could not be read gets its cover. */
const COVER: Sheet = { kind: 'cover' };

/**
 * The page a card shows: for a text file its real first lines (read once, a couple of kilobytes),
 * a table for CSV, the drawing itself for an SVG; for anything else a cover with its kind.
 * While the share is still under way (`waiting`) and until a text file has been read, its sheet is
 * bare (`pending`), so a cover never flashes before its page; the page then draws in over it and
 * the card never changes size.
 * `key` (`sheetKey`): a new key never shows the page read for another.
 */
function useSheet(file: SharedFile, at: string, key: string, skip: boolean, waiting: boolean): { sheet: Sheet | null; pending: boolean } {
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
      // Gone or not readable: its cover (asked again when the card is next laid out).
      .catch(() => live && setRead({ key, sheet: COVER }));
    return () => {
      live = false;
    };
  }, [key, want]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!want) return { sheet: null, pending: waiting && wantsText(file.name, file.size) > 0 };
  const sheet = sheets.get(key) ?? (read?.key === key ? read.sheet : null);
  return { sheet, pending: !sheet };
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

/** A line's or a row's place on its page, for the stagger of its arrival (files.css `--l`). */
const nth = (i: number) => ({ '--l': i }) as CSSProperties;

const Page = memo(function Page({ sheet }: { sheet: Sheet }) {
  if (sheet.kind === 'table') {
    return (
      <span className="fcard-page fcard-table">
        {sheet.rows.map((row, r) => (
          <span key={r} className="fcard-tr" style={nth(r)}>
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
          <span key={i} className="fcard-line" data-head={l.head || undefined} style={nth(i)}>
            {l.text || ' '}
          </span>
        ))}
      </span>
    );
  }
  return null;
});

// ── the cover: what kind of file it is, in a few hairlines ──

/** A stroke that can draw itself (normalised length, as in the icon set). */
const L = ({ c, d }: { c: string; d: string }) => <path className={c} d={d} pathLength={1} />;

/** The bars of a sound, by height (centred on the cover's middle line). */
const BARS = [8, 16, 26, 12, 34, 20, 40, 28, 36, 16, 30, 22, 12, 18, 8];
/** The teeth of a zip, one zigzag from the left edge to where the pull sits. */
const TEETH = `M1,24${Array.from({ length: 19 }, (_, i) => `L${6 + i * 5},${i % 2 ? 30 : 18}`).join('')}`;

/**
 * The drawings, on a 124 by 52 grid under the cover's word. Static at rest; files.css draws them in
 * when the card arrives and gives each kind one small motion when the card is pointed at (the icon
 * engine marks the svg, as it does an icon: `data-ai`).
 */
const COVERS: Record<CoverKind, ReactNode> = {
  // a document: a paragraph, its last line short
  doc: (
    <>
      <L c="r r1" d="M1,3H123" />
      <L c="r r2" d="M1,15H123" />
      <L c="r r3" d="M1,27H99" />
      <L c="r r4" d="M1,39H61" />
    </>
  ),
  // a table: a header rule, three rows, two columns, and the cell that is picked while it moves
  table: (
    <>
      <rect className="cell" x="44" y="17" width="37" height="8" rx="1.5" fill="currentColor" stroke="none" opacity={0} />
      <L c="hd" d="M1,3H123" />
      <L c="r r1" d="M1,15H123" />
      <L c="r r2" d="M1,27H123" />
      <L c="r r3" d="M1,39H123" />
      <L c="col c1" d="M42,3V46" />
      <L c="col c2" d="M83,3V46" />
    </>
  ),
  // a picture: a frame, two hills, a sun
  picture: (
    <>
      <L c="fr" d="M4,1H120a3,3,0,0,1,3,3V44a3,3,0,0,1-3,3H4a3,3,0,0,1-3-3V4A3,3,0,0,1,4,1Z" />
      <path className="sun" d="M92,14a5.5,5.5,0,1,0,11,0a5.5,5.5,0,1,0-11,0Z" />
      <L c="hill" d="M2,41L33,22L55,35L77,17L122,44" />
    </>
  ),
  // an archive: a zip closed to its pull
  archive: (
    <>
      <L c="teeth" d={TEETH} />
      <g className="pull">
        <path d="M100,16h8a3,3,0,0,1,3,3v10a3,3,0,0,1-3,3h-8a3,3,0,0,1-3-3V19A3,3,0,0,1,100,16Z" />
        <path d="M111,24h6" />
        <path d="M117,24a2.5,2.5,0,1,0,5,0a2.5,2.5,0,1,0-5,0Z" />
      </g>
    </>
  ),
  // a video: a frame of film with its perforations, and a play mark
  video: (
    <>
      <L c="fr" d="M4,1H120a3,3,0,0,1,3,3V44a3,3,0,0,1-3,3H4a3,3,0,0,1-3-3V4A3,3,0,0,1,4,1Z" />
      <path className="perf" d="M9,9H117" strokeDasharray="4 8" />
      <path className="perf" d="M9,39H117" strokeDasharray="4 8" />
      <path className="tri" d="M57,18v12l10-6Z" fill="currentColor" />
    </>
  ),
  // sound: its wave as bars
  audio: (
    <>
      {BARS.map((h, i) => (
        <path key={i} className="bar" d={`M${6 + i * 8},${24 - h / 2}V${24 + h / 2}`} style={{ '--b': i } as CSSProperties} />
      ))}
    </>
  ),
  // code: indented lines, a caret after the last
  code: (
    <>
      <L c="r r1" d="M1,3H55" />
      <L c="r r2" d="M15,15H103" />
      <L c="r r3" d="M15,27H79" />
      <L c="r r4" d="M29,39H67" />
      <path className="caret" d="M75,34.5v9" />
    </>
  ),
  // any other file: three plain rules
  file: (
    <>
      <L c="r r1" d="M1,3H123" />
      <L c="r r2" d="M1,15H123" />
      <L c="r r3" d="M1,27H73" />
    </>
  ),
};

const Cover = memo(function Cover({ name }: { name: string }) {
  const kind = coverKind(name);
  return (
    <span className="fcard-cover">
      <span className="fcard-ext">{coverWord(name)}</span>
      {/* `data-icon`: the icon engine plays it with the card's button; `data-anim`: it brings its own motion. */}
      <svg className="fcover" data-icon={`cover-${kind}`} data-anim="" viewBox="0 0 124 52" width="124" height="52" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {COVERS[kind]}
      </svg>
    </span>
  );
});

/** Opening gives a beat: the sheet is drawn out of the well a little and let go (files.css `[data-beat]`), once per press. */
function beat(card: HTMLElement | null) {
  if (!card || reducedMotion()) return;
  card.removeAttribute('data-beat');
  // Read once, so a second press in a row starts the beat again.
  void card.offsetWidth;
  card.setAttribute('data-beat', '');
  const sheet = card.querySelector('.fcard-sheet');
  const done = (e: Event) => {
    if (e.target !== sheet) return;
    card.removeEventListener('animationend', done);
    card.removeEventListener('animationcancel', done);
    card.removeAttribute('data-beat');
  };
  card.addEventListener('animationend', done);
  card.addEventListener('animationcancel', done);
}

/**
 * One file as a card: a sheet of it in a small well (its first lines where it is text, a picture of
 * it for pictures, documents and videos, a cover with its kind otherwise), its name, its size and
 * where it lies. The whole card opens the file
 * with its app; Show in folder and Copy path come forward on hover or focus.
 */
const FileCard = memo(function FileCard({
  file,
  failed,
  readable,
  active,
  itemId,
  index,
  sheet: key,
}: {
  file: SharedFile;
  failed: boolean;
  readable: boolean;
  /** The share is still under way: a text file's sheet stays bare until its page can be read. */
  active: boolean;
  itemId: string;
  index: number;
  sheet: string;
}) {
  const { cwd, home } = useTimeline();
  // Where it is on the computer: a name relative to the chat's folder lies in it.
  const at = sharedPath(file.path, cwd);
  const where = folderOf(at, cwd, home);
  // The folder by its own name (the whole path is the card's tooltip, and Show in folder goes there).
  const folder = where.slice(where.replace(/\/+$/, '').lastIndexOf('/') + 1);
  const size = formatBytes(file.size);
  const { sheet, pending } = useSheet(file, at, key, failed || !readable, active && !failed);
  const page = sheet && sheet.kind !== 'cover' ? sheet : null;
  const pic = usePicture(file, itemId, index, key, failed || !readable);
  const picKind = pictureKind(file.name);
  // A picture stands on the same sheet as the cover it takes over from (one element: it never arrives twice).
  const fit = pic && picKind ? pictureFit(picKind, pic.w, pic.h, SHEET_W) : null;
  return (
    <div className="fcard" role="listitem" data-spot data-failed={failed || undefined} style={{ '--i': index } as CSSProperties}>
      <span className="fcard-stage" aria-hidden>
        <span className={fit ? 'fcard-sheet fcard-pic' : 'fcard-sheet'} data-pic={fit ? picKind : undefined} data-small={fit?.small || undefined} style={fit ? { height: fit.height } : undefined}>
          {pic && fit ? (
            <>
              <img className="fcard-pic-img" src={pic.src} alt="" draggable={false} decoding="async" />
              {picKind === 'video' && (
                <span className="fcard-play">
                  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
                    <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.2-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5Z" fill="currentColor" />
                  </svg>
                </span>
              )}
            </>
          ) : (
            <>
              {page ? <Page sheet={page} /> : pending ? null : <Cover name={file.name} />}
              <i className="fcard-fold" />
            </>
          )}
        </span>
      </span>
      <span className="fcard-foot">
        {/* The one button that opens the file: it covers the card, so a click anywhere on it opens; the cover's drawing answers it too. */}
        <button
          type="button"
          className="fcard-open"
          data-ai-scope=".fcard"
          onClick={(e) => {
            beat(e.currentTarget.closest<HTMLElement>('.fcard'));
            openFile(at);
          }}
          aria-label={`Open ${file.name}`}
          title={at}
        >
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
