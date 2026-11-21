import { memo, useRef, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';
import { fileIcon } from '@/features/composer/file-icon';
import { Icon, type IconName } from '@/icons';
import { FileProse, openFileLink, useFileLinks } from '@/lib/file-links';
import { onLinkClick } from '@/lib/links';
import { PENDING_HREF, lexBlocks, repairTail, type LexState } from '@/lib/md';
import { FenceWidget, MermaidBlock, WIDGET_FENCE } from '@/features/genui/blocks';
import { numericColumns, TableCopy, wideColumns } from '@/features/genui/table';
import { CodeBlock } from './CodeBlock';
import { ImageView } from './ImageView';
import './markdown.css';

export interface MarkdownProps {
  text: string;
  /** The text is still arriving: the newest words ease in at the write head and unfinished syntax is tolerated. */
  streaming?: boolean;
  /** The write head after the newest word: writing ('live'), resting in a pause ('rest'), leaving ('out'). */
  head?: 'live' | 'rest' | 'out';
  className?: string;
}

/**
 * The write head. Zero width, so it never wraps a line by itself or moves the words around it.
 * The newest words are still wet: a short feather in the stage colour lies over them and lifts as
 * the head moves on, so text eases in with one element per answer instead of one per word.
 */
const Caret = () => <span className="md-caret" aria-hidden />;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) return known;
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/**
 * Inline code in a settled answer. A real file it names (`src/server/session.ts`) becomes a quiet
 * chip in the interface face, its kind, the folder dim and the name regular, that opens on click
 * as any file link does (lib/file-links.tsx); anything else stays code.
 */
function CodeWord({ word }: { word: string }) {
  const links = useFileLinks();
  const file = links?.files[word];
  if (!file || !links) return <code className="md-code">{word}</code>;
  const norm = word.replace(/\\/g, '/').replace(/\/+$/, '');
  const cut = norm.lastIndexOf('/');
  const name = norm.slice(cut + 1) || norm;
  return (
    <a className="md-fileref" href={`file:///${file.replace(/\\/g, '/')}`} title={file} onClick={(e) => openFileLink(e, file, links.cwd)} onAuxClick={(e) => e.preventDefault()}>
      <Icon name={fileIcon(name.replace(/:\d+(?::\d+)?$/, ''))} size={12} className="md-fileref-icon" />
      {cut > 0 && <span className="md-fileref-dir">{norm.slice(0, cut + 1)}</span>}
      <span className="md-fileref-name">{name}</span>
    </a>
  );
}

/** GitHub's alerts (`> [!NOTE]`): a quiet callout with its kind named, no colour. */
const ALERT = /^\[!(note|tip|important|warning|caution)\][ \t]*\n?/i;
const ALERTS: Record<string, { label: string; icon: IconName }> = {
  note: { label: 'Note', icon: 'info' },
  tip: { label: 'Tip', icon: 'lightbulb' },
  important: { label: 'Important', icon: 'info' },
  warning: { label: 'Warning', icon: 'warning' },
  caution: { label: 'Caution', icon: 'warning' },
};

/** The alert a quote opens with, and the quote's blocks without its marker; null for a plain quote. */
function alertOf(kids: Token[]): { kind: string; kids: Token[] } | null {
  const first = kids[0];
  if (first?.type !== 'paragraph') return null;
  const m = ALERT.exec(first.raw);
  if (!m) return null;
  const p = first as Tokens.Paragraph;
  const head = p.tokens[0];
  if (head?.type !== 'text' || !ALERT.test((head as Tokens.Text).text)) return null;
  const text = (head as Tokens.Text).text.replace(ALERT, '');
  const rest = text ? [{ ...head, text, raw: text, tokens: undefined } as Token, ...p.tokens.slice(1)] : p.tokens.slice(1);
  // The line break after the marker (answers keep single line breaks) goes with it.
  while (rest[0]?.type === 'br' || (rest[0]?.type === 'text' && !(rest[0] as Tokens.Text).text.trim())) rest.shift();
  const body = rest.length ? [{ ...p, tokens: rest, raw: p.raw.replace(ALERT, ''), text: p.text.replace(ALERT, '') } as Token] : [];
  return { kind: m[1].toLowerCase(), kids: [...body, ...kids.slice(1)] };
}

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\.?\/)/i;
const SAFE_SRC = /^(https?:|data:image\/|blob:)/i;

function inline(tokens: Token[] | undefined, live: boolean, path: string): ReactNode {
  if (!tokens) return null;
  return tokens.map((t, i) => {
    const key = `${path}${i}`;
    switch (t.type) {
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) return inline(tt.tokens, live, `${key}.`);
        // Settled prose: files it names become links (when the answer knows of any).
        return live ? decode(tt.text) : <FileProse key={key} text={decode(tt.text)} />;
      }
      case 'escape':
        return decode((t as Tokens.Escape).text);
      case 'strong':
        return <strong key={key}>{inline((t as Tokens.Strong).tokens, live, `${key}.`)}</strong>;
      case 'em':
        return <em key={key}>{inline((t as Tokens.Em).tokens, live, `${key}.`)}</em>;
      case 'del':
        return <del key={key}>{inline((t as Tokens.Del).tokens, live, `${key}.`)}</del>;
      case 'codespan': {
        const text = decode((t as Tokens.Codespan).text);
        return live ? (
          <code key={key} className="md-code">
            {text}
          </code>
        ) : (
          <CodeWord key={key} word={text} />
        );
      }
      case 'br':
        return <br key={key} />;
      case 'link': {
        const l = t as Tokens.Link;
        const children = inline(l.tokens, live, `${key}.`);
        if (l.href === PENDING_HREF) {
          return (
            <a key={key} className="md-link">
              {children}
            </a>
          );
        }
        if (!SAFE_HREF.test(l.href)) return <span key={key}>{children}</span>;
        return (
          <a key={key} className="md-link" href={l.href} title={l.title ?? undefined} target="_blank" rel="noopener noreferrer" onClick={onLinkClick}>
            {children}
          </a>
        );
      }
      case 'image': {
        const im = t as Tokens.Image;
        if (!SAFE_SRC.test(im.href)) return <span key={key}>{im.text}</span>;
        return (
          <ImageView key={key} src={im.href} alt={im.text}>
            <img className="md-img" src={im.href} alt={im.text} title={im.title ?? undefined} loading="lazy" decoding="async" />
          </ImageView>
        );
      }
      case 'html':
        // Raw HTML is shown as written, never interpreted.
        return (t as Tokens.HTML).text;
      default:
        return 'text' in t && typeof t.text === 'string' ? decode(t.text) : t.raw;
    }
  });
}

function listItem(item: Tokens.ListItem, loose: boolean, live: boolean, tail: boolean, key: string): ReactNode {
  let last = item.tokens.length - 1;
  while (last >= 0 && item.tokens[last].type === 'space') last--;
  const body = item.tokens.map((t, i) => {
    const k = `${key}.${i}`;
    const head = tail && i === last;
    if (t.type === 'text') {
      const content = inline((t as Tokens.Text).tokens ?? [t], live, `${k}.`);
      return loose ? (
        <p key={k}>
          {content}
          {head && <Caret />}
        </p>
      ) : (
        <span key={k}>
          {content}
          {head && <Caret />}
        </span>
      );
    }
    return block(t, live, k, head);
  });
  if (item.task) {
    return (
      <li key={key} className="md-task" data-checked={item.checked || undefined}>
        <span className="md-check" role="checkbox" aria-checked={!!item.checked} aria-disabled>
          {item.checked && <Icon name="check" size={10} />}
        </span>
        <div className="md-task-body">{body}</div>
      </li>
    );
  }
  return <li key={key}>{body}</li>;
}

/** A list item, re-rendered only when its own text changes: a long list streams one item at a time. */
const ListItem = memo(
  function ListItem({ item, loose, live, tail, k }: { raw: string; item: Tokens.ListItem; loose: boolean; live: boolean; tail: boolean; k: string }) {
    return <>{listItem(item, loose, live, tail, k)}</>;
  },
  (a, b) => a.raw === b.raw && a.loose === b.loose && a.tail === b.tail && a.live === b.live,
);

/** A table row, re-rendered only when its own cells change. */
const TableRow = memo(
  function TableRow({ row, align, figures, live, k }: { raw: string; row: Tokens.TableCell[]; align: Tokens.Table['align']; figures: boolean[]; live: boolean; k: string }) {
    return (
      <tr>
        {row.map((c, i) => (
          <td key={i} className={figures[i] ? 'num' : undefined} style={align[i] ? { textAlign: align[i]! } : undefined}>
            {inline(c.tokens, live, `${k}.${i}.`)}
          </td>
        ))}
      </tr>
    );
  },
  (a, b) => a.raw === b.raw && a.live === b.live,
);

/** `tail`: this block holds the newest words, so the write head goes at its end. */
function block(t: Token, live: boolean, key: string, tail = false): ReactNode {
  switch (t.type) {
    case 'space':
      return null;
    case 'paragraph':
      return (
        <p key={key}>
          {inline((t as Tokens.Paragraph).tokens, live, `${key}.`)}
          {tail && <Caret />}
        </p>
      );
    case 'text':
      return (
        <p key={key}>
          {inline((t as Tokens.Text).tokens ?? [t], live, `${key}.`)}
          {tail && <Caret />}
        </p>
      );
    case 'heading': {
      const h = t as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, h.depth))}` as 'h1';
      return (
        <Tag key={key}>
          {inline(h.tokens, live, `${key}.`)}
          {tail && <Caret />}
        </Tag>
      );
    }
    case 'code': {
      const c = t as Tokens.Code;
      const lang = (c.lang || '').trim().split(/\s+/)[0].toLowerCase();
      // Generative UI in plain answers: ```widget renders in a frame, ```mermaid as a diagram.
      if (lang === WIDGET_FENCE) return <FenceWidget key={key} code={c.text} streaming={live} />;
      if (lang === 'mermaid') return <MermaidBlock key={key} code={c.text} streaming={live} />;
      return <CodeBlock key={key} code={c.text} lang={c.lang || undefined} streaming={live} />;
    }
    case 'blockquote': {
      const all = (t as Tokens.Blockquote).tokens;
      const alert = alertOf(all);
      const kids = alert ? alert.kids : all;
      let last = kids.length - 1;
      while (last >= 0 && kids[last].type === 'space') last--;
      const body = kids.map((c, i) => block(c, live, `${key}.${i}`, tail && i === last));
      if (!alert) return <blockquote key={key}>{body}</blockquote>;
      const a = ALERTS[alert.kind];
      return (
        <div key={key} className="md-callout" data-kind={alert.kind} role="note">
          <div className="md-callout-head">
            <Icon name={a.icon} size={14} />
            {a.label}
          </div>
          {body}
          {tail && last < 0 && <Caret />}
        </div>
      );
    }
    case 'list': {
      const l = t as Tokens.List;
      const n = l.items.length - 1;
      const items = l.items.map((it, i) =>
        live ? <ListItem key={i} raw={it.raw} item={it} loose={l.loose} live={live} tail={tail && i === n} k={`${key}.${i}`} /> : listItem(it, l.loose, false, false, `${key}.${i}`),
      );
      const tasks = l.items.some((it) => it.task);
      return l.ordered ? (
        <ol key={key} start={typeof l.start === 'number' && l.start !== 1 ? l.start : undefined} data-loose={l.loose || undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key} data-loose={l.loose || undefined} data-tasks={tasks || undefined}>
          {items}
        </ul>
      );
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const plain = { header: tb.header.map((c) => c.text), rows: tb.rows.map((r) => r.map((c) => c.text)) };
      // Columns of figures align right in tabular digits, unless the author aligned them.
      const figures = numericColumns(plain);
      const wide = wideColumns(plain);
      const align: Tokens.Table['align'] = tb.header.map((_, i) => tb.align[i] ?? (figures[i] ? 'right' : null));
      const tall = tb.rows.length > 12;
      return (
        <div className="md-tablewrap" key={key}>
          <div className="md-table hscroll" data-tall={tall || undefined}>
            <table>
              <thead>
                <tr>
                  {tb.header.map((c, i) => (
                    <th key={i} className={figures[i] ? 'num' : wide[i] ? 'wide' : undefined} style={align[i] ? { textAlign: align[i]! } : undefined}>
                      {inline(c.tokens, live, `${key}.h${i}.`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((row, r) => (
                  <TableRow key={r} raw={row.map((c) => c.text).join('|') + align.join(',')} row={row} align={align} figures={figures} live={live} k={`${key}.${r}`} />
                ))}
              </tbody>
            </table>
          </div>
          {!live && <TableCopy markdown={tb.raw} table={plain} />}
        </div>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'html':
      return (
        <p key={key} className="md-raw">
          {(t as Tokens.HTML).text.trim()}
        </p>
      );
    default:
      return <p key={key}>{t.raw}</p>;
  }
}

/**
 * One top-level block. A settled block never re-renders: its raw text is its identity. Only the
 * newest block re-renders while text streams, and it holds plain text nodes (no element per word),
 * so a frame of streaming touches one paragraph. Code re-renders when it stops being the live tail
 * (to pick up colours).
 */
const Block = memo(
  function Block({ token, live, tail }: { raw: string; token: Token; live: boolean; tail: boolean }) {
    return <>{block(token, live, 'b', tail)}</>;
  },
  (a, b) => a.raw === b.raw && a.tail === b.tail && (a.live === b.live || a.token.type !== 'code'),
);

/** Renders assistant markdown. Self-contained: give it text, and say whether it is still streaming. */
export const Markdown = memo(function Markdown({ text, streaming = false, head, className }: MarkdownProps) {
  const state = useRef<LexState | null>(null);
  const source = streaming ? repairTail(text.replace(/\r\n?/g, '\n')) : text.replace(/\r\n?/g, '\n');
  if (!state.current || state.current.text !== source) state.current = lexBlocks(streaming ? state.current : null, source);
  const blocks = state.current.blocks;
  let last = blocks.length - 1;
  while (last >= 0 && blocks[last].token.type === 'space') last--;
  return (
    <div className={`md ${className ?? ''}`} data-streaming={streaming || undefined} data-head={head}>
      {blocks.map((b, i) => (b.token.type === 'space' ? null : <Block key={i} raw={b.raw} token={b.token} live={streaming && i === last} tail={!!head && i === last} />))}
    </div>
  );
});
