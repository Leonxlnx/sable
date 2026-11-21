import { useMemo, useState } from 'react';
import type { FileDiff, ToolItem } from '@shared/protocol';
import { makeFileDiff } from '@shared/diff';
import { Ring } from '@/art/Logo';
import { CodeBlock } from '@/components/CodeBlock';
import { CopyButton } from '@/components/CopyButton';
import { DiffView } from '@/components/DiffView';
import { ImageView } from '@/components/ImageView';
import { Markdown } from '@/components/Markdown';
import { Icon } from '@/icons';
import { parseAnsi } from '@/lib/ansi';
import { langFromPath, plural, relPath } from '@/lib/format';
import { onLinkClick } from '@/lib/links';
import { stepScope } from '@/features/review/jump';
import { useTimeline, useWhole } from './ctx';
import { hostOf, isActive, looksJson, partialJsonString, prettyJson } from './util';

/** Whether a row has anything to reveal. */
export function hasDetails(item: ToolItem): boolean {
  const r = item.result;
  const d = item.detail;
  switch (item.kind) {
    case 'bash':
      return !!d.command || !!item.output || !!r?.text;
    case 'edit':
    case 'write':
      return true;
    case 'read':
      return !!r?.file?.content || !!d.path;
    case 'todo':
      return !!d.todos?.length;
    case 'question':
      return !!d.questions?.length;
    case 'skill':
      return !!r?.text || !!d.skill;
    default:
      return !!r || item.input !== undefined || !!d.pattern || !!d.query || !!d.url;
  }
}

// ───────────────────────────────── bash ─────────────────────────────────

const MAX_OUTPUT = 120_000;

function Terminal({ item }: { item: ToolItem }) {
  const active = isActive(item);
  const r = item.result;
  const raw = active ? (item.output ?? '') : (r?.text ?? item.output ?? '');
  const clipped = raw.length > MAX_OUTPUT;
  const text = (clipped ? raw.slice(raw.indexOf('\n', raw.length - MAX_OUTPUT) + 1) : raw).replace(/\n+$/, '');
  const stderr = !active && r?.stderr && !text.includes(r.stderr.trim()) ? r.stderr.replace(/\n+$/, '') : '';
  const spans = useMemo(() => parseAnsi(text), [text]);
  const errSpans = useMemo(() => (stderr ? parseAnsi(stderr) : []), [stderr]);
  const command = item.detail.command ?? '';
  const has = !!text || !!stderr;
  return (
    <div className="term" data-failed={item.status === 'error' || undefined}>
      <div className="term-cmd">
        <span className="term-ps" aria-hidden>
          $
        </span>
        <code className="term-line">{command}</code>
        <span className="term-side">
          {active && <Ring size={12} className="tool-ring" />}
          {r?.interrupted && <span className="term-note">Interrupted</span>}
          {r?.exitCode != null && r.exitCode !== 0 && <span className="tool-exit">exit {r.exitCode}</span>}
          <CopyButton text={command} label="Copy command" size={13} className="cb-btn term-copy" />
        </span>
      </div>
      {has ? (
        // Reversed flow keeps the newest output in view without measuring anything.
        <div className="term-out vscroll">
          <div className="term-flow">
          {clipped && <div className="term-clip">Earlier output hidden</div>}
          {text && (
            <pre>
              {spans.map((s, i) =>
                s.cls ? (
                  <span key={i} className={s.cls}>
                    {s.text}
                  </span>
                ) : (
                  s.text
                ),
              )}
            </pre>
          )}
          {stderr && (
            <pre className="term-err">
              {errSpans.map((s, i) =>
                s.cls ? (
                  <span key={i} className={s.cls}>
                    {s.text}
                  </span>
                ) : (
                  s.text
                ),
              )}
            </pre>
          )}
          </div>
        </div>
      ) : (
        !active && item.status !== 'awaiting' && <div className="term-empty">{item.status === 'done' ? 'No output' : 'Did not run'}</div>
      )}
    </div>
  );
}

// ───────────────────────────────── edit / write ─────────────────────────────────

function Edits({ item }: { item: ToolItem }) {
  const { sessionId, cwd, home, live } = useTimeline();
  // Laying out history: diffs build just after the first paint instead of inside it.
  const eager = live.current;
  const d = item.detail;
  const diffs = item.result?.diff;
  // What was applied can be commented on for the chat's review (features/review).
  const reviews = useMemo(
    () => (sessionId ? diffs?.map((diff, i) => ({ sessionId, scope: stepScope(item.id, i), path: relPath(diff.path, cwd, home) })) : undefined),
    [diffs, sessionId, item.id, cwd, home],
  );
  // Before the call has run there is no result yet: preview what the input asks for.
  const preview = useMemo<FileDiff | null>(() => {
    if (diffs?.length || !d.path) return null;
    const path = relPath(d.path, cwd, home);
    if (item.kind === 'write' && d.content != null) return makeFileDiff(path, null, d.content);
    if (d.newText != null || d.oldText != null) return makeFileDiff(path, d.oldText ?? '', d.newText ?? '');
    return null;
  }, [diffs, d.path, d.content, d.oldText, d.newText, item.kind, cwd, home]);

  if (diffs?.length) {
    const many = diffs.length > 1;
    return (
      <div className="detail-stack">
        {diffs.map((diff, i) => (
          <DiffView key={i} diff={diff} showHeader={many} maxLines={many ? 40 : 60} eager={eager} review={reviews?.[i]} />
        ))}
      </div>
    );
  }
  if (preview) return <DiffView diff={preview} showHeader={false} maxLines={60} lineNumbers={item.kind === 'write'} eager={eager} />;

  // The input is still being typed by the model.
  const typing = isActive(item) && item.input === undefined;
  const path = d.path ?? partialJsonString(item.inputText, 'file_path') ?? partialJsonString(item.inputText, 'path');
  const body = item.kind === 'write' ? partialJsonString(item.inputText, 'content') : partialJsonString(item.inputText, 'new_string');
  const lines = body ? body.split('\n').length : 0;
  return (
    <div className="writing">
      <Icon name={item.kind === 'write' ? 'file-plus' : 'pencil'} size={14} />
      <span className="writing-path truncate">{path ? relPath(path, cwd, home) : 'Choosing a file'}</span>
      {typing ? (
        <span className="writing-state shimmer">{lines > 1 ? `Writing, ${plural(lines, 'line')}` : 'Writing'}</span>
      ) : (
        <span className="writing-state">{item.status === 'denied' ? 'Not applied' : item.status === 'cancelled' ? 'Cancelled' : item.status === 'error' ? 'Failed' : 'Applying'}</span>
      )}
    </div>
  );
}

// ───────────────────────────────── small pieces ─────────────────────────────────

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="detail-field">
      <span className="detail-label">{label}</span>
      <span className={mono ? 'detail-value detail-mono' : 'detail-value'}>{children}</span>
    </div>
  );
}

function FileList({ files }: { files: string[] }) {
  const { cwd, home } = useTimeline();
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 12);
  return (
    <div className="files">
      <ul>
        {shown.map((f, i) => {
          const rel = relPath(f, cwd, home);
          const cut = rel.lastIndexOf('/');
          return (
            <li key={i} title={f}>
              <Icon name="file-text" size={13} />
              <span className="truncate">
                {cut >= 0 && <span className="files-dir">{rel.slice(0, cut + 1)}</span>}
                {rel.slice(cut + 1)}
              </span>
            </li>
          );
        })}
      </ul>
      {files.length > 12 && !all && (
        <button type="button" className="link-btn" onClick={() => setAll(true)}>
          Show all {files.length}
        </button>
      )}
    </div>
  );
}

function ResultText({ text, markdown }: { text: string; markdown?: boolean }) {
  if (looksJson(text)) return <CodeBlock code={prettyJson(text)} lang="json" title="Result" maxHeight={300} />;
  if (markdown) {
    return (
      <div className="detail-prose">
        <Markdown text={text} />
      </div>
    );
  }
  return <CodeBlock code={text} title="Result" maxHeight={300} wrap />;
}

function Images({ images }: { images?: string[] }) {
  if (!images?.length) return null;
  return (
    <div className="detail-images">
      {images.map((src, i) => (
        <ImageView key={i} src={src} alt="Result image" className="user-thumb">
          <img src={src} alt="" loading="lazy" />
        </ImageView>
      ))}
    </div>
  );
}

// ───────────────────────────────── by kind ─────────────────────────────────

export function ToolDetails({ item }: { item: ToolItem }) {
  const { cwd, home } = useTimeline();
  // Shown open: a step that came cut is fetched whole.
  useWhole(item);
  const d = item.detail;
  const r = item.result;
  const failed = item.status === 'error';

  switch (item.kind) {
    case 'bash':
      return <Terminal item={item} />;

    case 'edit':
    case 'write':
      return (
        <>
          <Edits item={item} />
          {failed && r?.text && <pre className="tool-error">{r.text}</pre>}
        </>
      );

    case 'read': {
      const file = r?.file;
      const path = relPath(file?.path ?? d.path ?? '', cwd, home);
      const from = file?.startLine ?? d.range?.[0];
      const to = file?.startLine != null && file.numLines != null ? file.startLine + file.numLines - 1 : d.range?.[1];
      const partial = from != null && to != null && (from > 1 || (file?.totalLines != null && to < file.totalLines));
      if (!file?.content) {
        return (
          <div className="detail-stack">
            <Field label="File">
              {path}
            </Field>
            {r?.text && <ResultText text={r.text} />}
            <Images images={r?.images} />
          </div>
        );
      }
      return (
        <CodeBlock
          code={file.content}
          lang={langFromPath(file.path)}
          title={partial ? `${path} · lines ${from}–${to}${file.totalLines ? ` of ${file.totalLines}` : ''}` : path}
          startLine={from ?? 1}
          maxHeight={300}
        />
      );
    }

    case 'search':
    case 'glob': {
      const where = d.path ? relPath(d.path, cwd, home) : '';
      const content = item.kind === 'search' && r?.text && r.text !== r.files?.join('\n') ? r.text : '';
      return (
        <div className="detail-stack">
          <div className="detail-fields">
            {d.pattern && (
              <Field label="Pattern" mono>
                {d.pattern}
              </Field>
            )}
            {(d.glob || (where && where !== '.')) && (
              <Field label="In">
                {[where !== '.' && where, d.glob].filter(Boolean).join(' · ')}
              </Field>
            )}
          </div>
          {content ? (
            <CodeBlock code={content} title={r?.count != null ? plural(r.count, 'match', 'matches') : 'Matches'} maxHeight={280} />
          ) : r?.files?.length ? (
            <FileList files={r.files} />
          ) : r ? (
            <div className="detail-quiet">{r.text || 'Nothing found'}</div>
          ) : null}
          {r?.truncated && <div className="detail-quiet">Results were truncated</div>}
        </div>
      );
    }

    case 'websearch':
      return (
        <div className="detail-stack">
          {d.query && !item.title.includes(d.query) && <Field label="Query">{d.query}</Field>}
          {r?.links?.length ? (
            <ul className="links">
              {r.links.map((l, i) => (
                <li key={i}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer" className="link-row" onClick={onLinkClick}>
                    <Icon name="globe" size={14} />
                    <span className="link-title truncate">{l.title || l.url}</span>
                    <span className="link-host">{hostOf(l.url)}</span>
                    <Icon name="external" size={12} className="link-out" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            r?.text && <ResultText text={r.text} markdown />
          )}
        </div>
      );

    case 'fetch':
      return (
        <div className="detail-stack">
          {d.url && (
            <a href={d.url} target="_blank" rel="noopener noreferrer" className="link-row link-solo" onClick={onLinkClick}>
              <Icon name="globe" size={14} />
              <span className="link-title truncate">{d.url}</span>
              <Icon name="external" size={12} className="link-out" />
            </a>
          )}
          {r?.text && <ResultText text={r.text} markdown />}
        </div>
      );

    case 'todo':
      return (
        <ul className="todos">
          {d.todos?.map((t, i) => (
            <li key={t.id ?? i} data-status={t.status}>
              <span className="todo-mark">
                {t.status === 'in_progress' ? <Ring size={13} label="In progress" className="tool-ring" /> : <Icon name={t.status === 'completed' ? 'check-circle' : 'circle'} size={15} />}
              </span>
              <span className="todo-text">{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
            </li>
          ))}
        </ul>
      );

    case 'question': {
      const answers = r?.answers;
      return (
        <div className="qa">
          {d.questions?.map((q, i) => {
            const picked = answers?.[q.question] ?? (q.header ? answers?.[q.header] : undefined);
            return (
              <div className="qa-item" key={i}>
                <div className="qa-q">{q.question}</div>
                {picked?.length ? (
                  <div className="qa-a">
                    {picked.map((a) => (
                      <span className="qa-chip" key={a}>
                        <Icon name="check" size={11} />
                        {a}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="detail-quiet">{item.status === 'awaiting' || isActive(item) ? 'Waiting for your answer' : 'No answer'}</div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    case 'skill':
      return (
        <div className="detail-stack">
          {d.skill && !item.title.includes(d.skill) && <Field label="Skill">{d.skill}</Field>}
          {r?.text ? <ResultText text={r.text} markdown /> : <div className="detail-quiet">{isActive(item) ? 'Loading the skill' : 'No output'}</div>}
        </div>
      );

    case 'browser':
      return (
        <div className="detail-stack">
          {d.url && (
            <a href={d.url} target="_blank" rel="noopener noreferrer" className="link-row link-solo" onClick={onLinkClick}>
              <Icon name="globe" size={14} />
              <span className="link-title truncate">{d.url}</span>
              <Icon name="external" size={12} className="link-out" />
            </a>
          )}
          {/* What the agent ran or typed in the page, then the page's own words without the note the agent gets around them. */}
          {typeof (item.input as { script?: unknown } | undefined)?.script === 'string' && <CodeBlock code={(item.input as { script: string }).script} title="Script" maxHeight={200} wrap />}
          {item.name.endsWith('browser_type') && typeof (item.input as { text?: unknown } | undefined)?.text === 'string' && <Field label="Typed">{(item.input as { text: string }).text}</Field>}
          <Images images={r?.images} />
          {r?.text && !r.images?.length && (
            <CodeBlock code={/<untrusted_page_data>\n([\s\S]*)\n<\/untrusted_page_data>/.exec(r.text)?.[1] ?? r.text} title={failed ? 'Error' : 'Result'} maxHeight={300} wrap />
          )}
        </div>
      );

    case 'mcp':
    default: {
      const input = item.input !== undefined ? prettyJson(item.input) : item.inputText;
      return (
        <div className="detail-stack">
          {item.kind !== 'mcp' && item.name && item.name !== item.title && (
            <Field label="Tool" mono>
              {item.name}
            </Field>
          )}
          {input && input !== '{}' && <CodeBlock code={input} lang="json" title="Input" maxHeight={220} streaming={item.input === undefined} />}
          {r?.text && <ResultText text={r.text} />}
          {r?.stderr && <pre className="tool-error">{r.stderr}</pre>}
          <Images images={r?.images} />
        </div>
      );
    }
  }
}
