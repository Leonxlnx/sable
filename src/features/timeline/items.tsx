import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { syntheticOf } from '@shared/synthetic';
import { Collapse } from '@/components/Collapse';
import { Markdown } from '@/components/Markdown';
import { cachedHeight } from '@/features/genui/near';
import { WidgetBlock } from '@/features/genui/WidgetBlock';
import { Icon } from '@/icons';
import { FileLinksProvider, useResolvedFiles } from '@/lib/file-links';
import { plural } from '@/lib/format';
import { useStore } from '@/state/store';
import { stepEntrance, useFresh, useItem, useTimeline } from './ctx';
import { takesStandIn } from './stand-in';
import { FileShare } from './FileCard';
import { Notice } from './Notice';
import { steadyTail, useSmoothLength } from './smooth';
import { Stamp } from './Stamp';
import { SyntheticLine } from './Synthetic';
import { Thinking } from './Thinking';
import { ToolView } from './Tool';
import { UserMessage } from './User';
import { CheckRow, UntilEnd } from './Until';
import { isExplore, useHeld } from './util';

type Row = { key: string; id: string; run?: undefined } | { key: string; run: string[]; id?: undefined };

/**
 * Renders a list of steps in order (inside a turn's work, or a sub-agent's thread). Consecutive
 * look-only tools (read, search, glob, fetch) fold into one line ("Read 6 files") that opens.
 * Task list updates repeat the same list: it keeps one row, where it first appeared, in its newest state.
 */
export const ItemList = memo(function ItemList({ ids }: { ids: string[]; nested?: boolean }) {
  const { sessionId } = useTimeline();
  // One character per item: whether it can join a run, or is a task list. Changes rarely, so the list re-renders rarely.
  const shape = useStore((s) => {
    const items = s.data[sessionId]?.items;
    if (!items) return '';
    let out = '';
    for (let i = 0; i < ids.length; i++) {
      const it = items[ids[i]];
      out += isExplore(it) ? 'e' : it?.type === 'tool' && it.kind === 'todo' ? 'k' : '-';
    }
    return out;
  });
  const cache = useRef(new Map<string, string[]>());

  const rows = useMemo(() => {
    const out: Row[] = [];
    const next = new Map<string, string[]>();
    // The task list keeps one row where it first appeared, showing its newest state: nothing moves.
    const firstTasks = shape.indexOf('k');
    const lastTasks = shape.lastIndexOf('k');
    for (let i = 0; i < ids.length; ) {
      if (shape[i] === 'k') {
        if (i === firstTasks) out.push({ key: ids[i], id: ids[lastTasks] });
        i++;
        continue;
      }
      if (shape[i] !== 'e') {
        out.push({ key: ids[i], id: ids[i] });
        i++;
        continue;
      }
      let j = i;
      while (j < ids.length && shape[j] === 'e') j++;
      let run = ids.slice(i, j);
      // Keep the same array while a run is unchanged so its row stays memoized.
      const prev = cache.current.get(ids[i]);
      if (prev && prev.length === run.length && prev[prev.length - 1] === run[run.length - 1]) run = prev;
      next.set(ids[i], run);
      out.push({ key: `run:${ids[i]}`, run });
      i = j;
    }
    cache.current = next;
    return out;
  }, [ids, shape]);

  // Built in blocks of rows: a new step re-renders only the last block, and earlier blocks out of
  // view skip layout and paint (content-visibility), so a 300-step turn costs what a short one does.
  // Always blocks, short lists too: a list that grows long never moves its rows to a new parent.
  const blocks = useMemo(() => {
    const out: Row[][] = [];
    for (let i = 0; i < rows.length; i += BLOCK) out.push(rows.slice(i, i + BLOCK));
    return out;
  }, [rows]);

  return (
    <>
      {blocks.map((b, i) => (
        <RowBlock key={b[0].key} rows={b} sealed={i < blocks.length - 1} />
      ))}
    </>
  );
});

const BLOCK = 24;

const renderRow = (r: Row) => (r.run ? <ExploreRun key={r.key} ids={r.run} /> : <ItemRow key={r.key} id={r.id} nested />);

const sameRows = (a: Row[], b: Row[]) => a.length === b.length && a.every((r, i) => r.key === b[i].key && r.id === b[i].id && r.run === b[i].run);

/** A block of rows that re-renders only when its own rows change. A sealed (full, earlier) block may skip layout off screen. */
const RowBlock = memo(
  function RowBlock({ rows, sealed }: { rows: Row[]; sealed: boolean }) {
    return (
      <div className="tl-block" data-sealed={sealed || undefined}>
        {rows.map(renderRow)}
      </div>
    );
  },
  (a, b) => a.sealed === b.sealed && sameRows(a.rows, b.rows),
);

/** A rough height for a row that is not built yet, so the scrollbar and scroll position stay sensible. */
export function estimate(item: TimelineItem | undefined): number {
  switch (item?.type) {
    case 'user': {
      if (item.until) return 44;
      const syn = syntheticOf(item);
      if (syn) return syn.role === 'hidden' ? 0 : syn.role === 'output' ? 24 : 36;
      return 70 + Math.ceil(item.text.length / 70) * 24;
    }
    case 'text':
      return item.text ? 20 + Math.ceil(item.text.length / 95) * 27 + (item.text.match(/\n\n/g)?.length ?? 0) * 12 : 0;
    case 'tool':
      if (item.kind === 'widget') return (cachedHeight(item.id) ?? 340) + 24;
      if (item.kind === 'share') return 20 + Math.ceil((item.detail.files?.length || 1) / 3) * 200 + (item.detail.caption ? 36 : 0);
      return item.kind === 'agent' || item.kind === 'plan' ? 72 : 28;
    case undefined:
      return 0;
    default:
      return 34;
  }
}

/** No new words for this long while the text is live: the write head rests (ms). */
const REST_AFTER_MS = 700;

/**
 * Assistant prose. While it streams, the text is paced (see `useSmoothLength`), a marker or a
 * table row is shown only once it is whole (`steadyTail`), and the newest words ease in at the
 * write head; when the stream ends the head fades out.
 */
export const LiveText = memo(function LiveText({ text, streaming, id }: { text: string; streaming: boolean; id?: string }) {
  const { stuck } = useTimeline();
  const len = useSmoothLength(text, streaming, stuck, id);
  // While pacing catches up after the stream ended, the text keeps its live rendering.
  const live = streaming || len < text.length;
  const was = useRef(live);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const ended = was.current && !live;
    was.current = live;
    if (!ended) return;
    setLeaving(true);
    const t = window.setTimeout(() => setLeaving(false), 260);
    return () => window.clearTimeout(t);
  }, [live]);
  // A pause in the stream (a tool is running, the model is thinking): the head rests instead of
  // staying lit. Words only stamp the time; one slow timer looks at the stamp (nothing is armed per
  // word), and the state changes only at the pause's edges.
  const [resting, setResting] = useState(false);
  const lastWord = useRef(0);
  useEffect(() => {
    lastWord.current = performance.now();
    if (resting) setResting(false);
  }, [len]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live || resting) return;
    let t = 0;
    const check = () => {
      const idle = performance.now() - lastWord.current;
      if (idle >= REST_AFTER_MS) setResting(true);
      else t = window.setTimeout(check, REST_AFTER_MS - idle + 20);
    };
    t = window.setTimeout(check, REST_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [live, resting]);
  // Once settled, the files the answer names become links.
  const { cwd } = useTimeline();
  const files = useResolvedFiles(text, cwd || undefined, !live);
  return (
    <FileLinksProvider value={files}>
      <Markdown text={live ? steadyTail(text.slice(0, len)) : text} streaming={live} head={live ? (resting ? 'rest' : 'live') : leaving ? 'out' : undefined} />
    </FileLinksProvider>
  );
});

/**
 * One item, subscribed to itself only. `answer`: the reply a turn segment ends with. `mid`: a text
 * the agent wrote along the way (a report between steps): one tone back, eased there when it stops
 * being the newest in front of the reader.
 */
export const ItemRow = memo(function ItemRow({ id, nested = false, answer = false, mid = false }: { id: string; nested?: boolean; answer?: boolean; mid?: boolean }) {
  const item = useItem(id);
  const { sessionId } = useTimeline();
  // A message that takes the place of its stand-in (stand-in.ts) is already on screen: no entrance.
  const [replaces] = useState(() => !nested && takesStandIn(sessionId, item));
  const fresh = useFresh(item?.ts) && (!nested || stepEntrance(id)) && !replaces;
  if (!item) return null;
  // Written by the agent's harness in the person's place (a task finished, a slash command): a line, not a message.
  const syn = item.type === 'user' && !item.until ? syntheticOf(item) : null;
  let body;
  switch (item.type) {
    case 'user':
      if (syn?.role === 'hidden') return null;
      // A failing until check Sable sent: shown as the check's row, not as a message.
      body = item.until?.check ? <CheckRow check={item.until.check} sent /> : syn ? <SyntheticLine item={item} syn={syn} /> : <UserMessage item={item} />;
      break;
    case 'text':
      if (!item.text && !item.streaming) return null;
      body = (
        <>
          <LiveText id={item.id} text={item.text} streaming={!!item.streaming} />
          {!nested && <Stamp ts={item.ts} />}
        </>
      );
      break;
    case 'thinking':
      body = <Thinking item={item} />;
      break;
    case 'tool':
      // Generative UI: the call is the widget itself, not a step; files handed over are their cards.
      body = item.kind === 'widget' ? <WidgetBlock item={item} sessionId={sessionId} /> : item.kind === 'share' ? <FileShare item={item} /> : <ToolView item={item} />;
      break;
    case 'notice':
      body = item.until ? <UntilEnd item={item} /> : <Notice item={item} />;
      break;
    default:
      return null;
  }
  return (
    <div
      className={nested ? 'tl-sub' : 'tl-item'}
      data-item-id={item.id}
      data-t={item.type}
      data-k={item.type === 'tool' ? item.kind : item.type === 'user' && item.until ? 'check' : syn ? 'synthetic' : item.type === 'notice' && item.variant === 'command' ? 'command' : undefined}
      data-role={syn?.role}
      data-answer={answer || undefined}
      data-mid={mid || undefined}
      data-settle={(mid && fresh) || undefined}
      data-fresh={fresh || undefined}
    >
      {body}
    </div>
  );
});

/** A tool row that reads its own item (used inside runs, where rows are not wrapped as timeline items). */
const ToolById = memo(function ToolById({ id }: { id: string }) {
  const item = useItem<ToolItem>(id);
  if (!item || item.type !== 'tool') return null;
  return (
    <div data-item-id={item.id}>
      <ToolView item={item} />
    </div>
  );
});

function summarize(sessionId: string, ids: string[]) {
  return (s: ReturnType<typeof useStore.getState>): string => {
    const items = s.data[sessionId]?.items;
    let files = 0;
    let searches = 0;
    let pages = 0;
    let active = '';
    if (items) {
      for (const id of ids) {
        const it = items[id];
        if (!it || it.type !== 'tool') continue;
        if (it.kind === 'read') files++;
        else if (it.kind === 'fetch') pages++;
        else searches++;
        if (it.status !== 'done') active = it.title;
      }
    }
    return `${files}|${searches}|${pages}|${active}`;
  };
}

/** "Read 6 files", "Searched 3 times", "Explored 4 files, 2 searches": one line for a run of looking. */
function runLabel(files: number, searches: number, pages: number): string {
  if (!searches && !pages) return `Read ${plural(files, 'file')}`;
  if (!files && !pages) return `Searched ${searches === 1 ? 'once' : `${searches} times`}`;
  if (!files && !searches) return `Fetched ${plural(pages, 'page')}`;
  return `Explored ${[files && plural(files, 'file'), searches && plural(searches, 'search', 'searches'), pages && plural(pages, 'page')].filter(Boolean).join(', ')}`;
}

const ExploreRun = memo(function ExploreRun({ ids }: { ids: string[] }) {
  const { sessionId } = useTimeline();
  const grouped = ids.length >= 2;
  const [open, setOpen] = useState(false);
  const fresh = useFresh() && stepEntrance(ids[0]);
  const summary = useStore(useMemo(() => summarize(sessionId, ids), [sessionId, ids]));
  const [files, searches, pages, ...rest] = summary.split('|');
  // A quick run of reads names each file long enough to be read, not a flicker of names; done at once.
  const now = rest.join('|');
  const held = useHeld(now, 450);
  const active = now && held;
  const label = runLabel(Number(files), Number(searches), Number(pages));

  return (
    <div className="tl-sub" data-t="tool" data-k="run" data-fresh={fresh || undefined}>
      {grouped && (
        <button type="button" className="row-btn tool-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="tool-icon">
            <Icon name={Number(searches) || Number(pages) ? 'search' : 'file-text'} size={14} />
          </span>
          {active ? (
            <>
              <span className="tool-title shimmer">{Number(searches) && !Number(files) ? 'Searching' : 'Reading'}</span>
              <span className="tool-sub truncate">{active}</span>
            </>
          ) : (
            <span className="tool-title truncate">{label}</span>
          )}
          <span className="tool-meta">{active ? <span className="num">{label.replace(/^\w+ /, '')}</span> : null}</span>
          <Icon name="caret-right" size={10} className="row-caret" />
        </button>
      )}
      {/* Becoming a group swaps the single row for the group's line in place, at the same height:
          nothing grows and shrinks at once (a fresh fold starts closed without animating). */}
      <Collapse key={grouped ? 'group' : 'single'} open={!grouped || open}>
        <div className={grouped ? 'run-rows' : undefined}>
          {ids.map((id) => (
            <ToolById key={id} id={id} />
          ))}
        </div>
      </Collapse>
    </div>
  );
});
