import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FileDiff, PermissionOption, PermissionRequest } from '@shared/protocol';
import { CodeBlock } from '@/components/CodeBlock';
import { DiffView } from '@/components/DiffView';
import { Markdown } from '@/components/Markdown';
import { Glyph, Icon, TOOL_ICON } from '@/icons';
import { langFromPath, relPath } from '@/lib/format';
import { respondPermission } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { useStore } from '@/state/store';
import { PathLabel } from '@/ui';
import { usePromptKeys } from './keys';


/** One labelled value. Code (commands, patterns) is set in the code font; a path is a label in the UI font. */
function Field({ label, value, mono, path }: { label: string; value?: string; mono?: boolean; path?: boolean }) {
  if (!value) return null;
  return (
    <div className="pc-field">
      <span className="pc-field-label">{label}</span>
      {path ? <PathLabel path={value} className="pc-field-value" /> : <span className={mono ? 'pc-field-value mono' : 'pc-field-value'}>{value}</span>}
    </div>
  );
}

/**
 * A scroller whose lower edge fades into the well while more is below (as the composer field does),
 * so no line is cut hard at the bottom; the fade goes once the end is in view.
 */
/** Past this many characters an option's own words take the whole button (its hint goes to the tooltip). */
const HINT_ROOM = 64;

export function FadeScroll({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 2);
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // The scroller's own height (the card is capped by the window) and its content's.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div ref={ref} className={className} onScroll={measure}>
      {children}
      <div className="pc-fade" data-on={more || undefined} aria-hidden />
    </div>
  );
}

const WARM_DIFF: FileDiff = {
  path: 'warm.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" import { a } from './a';", '-export const b = a(1);', '+export const b = a(2);', '+export const c = b + 1;', ' '] }],
};

let warmed = false;

/**
 * The first card of a run used to take several times longer than later ones (code paths and style
 * rules met for the first time, the highlighter's grammar loading). Once per run, when a turn
 * starts, a card with a small diff is laid out unseen during idle time and dropped, so the first
 * real card costs what later ones do. No handlers, no keys, nothing painted.
 */
export function CardWarmup({ active }: { active: boolean }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active || warmed) return;
    warmed = true;
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200));
    const id = idle(() => setOn(true), { timeout: 2000 });
    return () => (window.cancelIdleCallback ?? window.clearTimeout)(id);
  }, [active]);
  useEffect(() => {
    if (!on) return;
    const t = window.setTimeout(() => setOn(false), 1500);
    return () => window.clearTimeout(t);
  }, [on]);
  if (!on) return null;
  return (
    <div className="pc-warm" aria-hidden>
      <section className="pc glass-card" data-kind="edit">
        <header className="pc-head">
          <Glyph name={TOOL_ICON.edit.icon} tone="var(--amber)" size={30} />
          <div className="pc-titles">
            <h3 className="pc-title">Edit warm.ts</h3>
          </div>
        </header>
        <div className="pc-body">
          <FadeScroll className="pc-scroll pc-diffs scroll">
            <DiffView diff={WARM_DIFF} />
          </FadeScroll>
        </div>
        <div className="pc-foot">
          <button type="button" tabIndex={-1} className="btn btn-primary">
            <span>Allow</span>
          </button>
        </div>
      </section>
    </div>
  );
}

/** What the request is about, in full: the command, the diff, the plan, the address, the tool's input. */
export function PermissionSubject({ req, input }: { req: PermissionRequest; input: unknown }) {
  const d = req.detail;
  // Paths inside the session's folder read from there ("table.js"), as the step rows do.
  const cwd = useStore((s) => s.sessions[req.sessionId]?.cwd);
  const home = useStore((s) => s.home);
  const rel = (p?: string) => (p ? relPath(p, cwd, home) : p);
  switch (req.kind) {
    case 'bash':
      return d.command ? (
        <pre className="pc-cmd well scroll">
          <span className="pc-cmd-prompt">$ </span>
          {d.command}
        </pre>
      ) : null;
    case 'edit':
    case 'write':
      if (req.diff?.length)
        return (
          <FadeScroll className="pc-scroll pc-diffs scroll">
            {req.diff.map((f) => (
              <DiffView key={f.path} diff={{ ...f, path: rel(f.path)! }} />
            ))}
          </FadeScroll>
        );
      if (d.content ?? d.newText) return <CodeBlock code={(d.content ?? d.newText)!} lang={langFromPath(d.path)} title={rel(d.path)} maxHeight={260} />;
      return <Field label="File" value={rel(d.path)} path />;
    case 'plan':
      return d.plan ? (
        <FadeScroll className="pc-plan scroll">
          <Markdown text={d.plan} />
        </FadeScroll>
      ) : null;
    case 'fetch':
    case 'websearch': {
      const v = d.url ?? d.query;
      return v ? (
        <div className="pc-target well">
          <Icon name={d.url ? 'link' : 'search'} size={14} />
          <span className="pc-target-text">{v}</span>
        </div>
      ) : null;
    }
    case 'mcp': {
      const json = input && typeof input === 'object' && Object.keys(input).length ? JSON.stringify(input, null, 2) : null;
      return (
        <div className="pc-stack">
          {(d.server || d.tool) && (
            <div className="pc-mcp">
              <span>{d.server}</span>
              {d.server && d.tool && <span className="pc-mcp-sep">·</span>}
              <span>{d.tool}</span>
            </div>
          )}
          {json && <CodeBlock code={json} lang="json" maxHeight={220} />}
        </div>
      );
    }
    default:
      return (
        <div className="pc-fields">
          <Field label="Command" value={d.command} mono />
          <Field label="Path" value={d.path} path />
          <Field label="Pattern" value={d.pattern} mono />
          <Field label="Files" value={d.glob} mono />
          <Field label="Address" value={d.url} mono />
          <Field label="Query" value={d.query} />
          <Field label="Agent" value={d.subagent} />
          <Field label="Skill" value={d.skill} />
          <Field label="Task" value={d.prompt} />
        </div>
      );
  }
}

/** The description only repeats the title ("Write table.js" / "table.js") or the command shown below it. */
export function restates(req: PermissionRequest): boolean {
  const d = (req.description ?? '').trim().toLowerCase();
  return req.title.toLowerCase().includes(d) || d === (req.detail.command ?? '').trim().toLowerCase();
}

/** A tool waiting for approval: what it wants to do, and one key per answer. */
export function PermissionCard({ sessionId, req, more }: { sessionId: string; req: PermissionRequest; more: number }) {
  const [feedback, setFeedback] = useState(false);
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const input = useStore((s) => (req.itemId ? (s.data[sessionId]?.items[req.itemId] as { input?: unknown } | undefined)?.input : undefined));
  const deny = req.options.find((o) => o.tone === 'deny');
  // Enter takes the lit (allow) answer; without one, the first.
  const primary = req.options.find((o) => o.tone === 'allow') ?? req.options[0];
  const tool = TOOL_ICON[req.kind] ?? TOOL_ICON.other;

  const respond = (o: PermissionOption, msg?: string) => {
    if (sent) return;
    setSent(true);
    void respondPermission(sessionId, req.id, o.id, msg);
    focusComposer();
  };

  const choose = (o: PermissionOption) => {
    if (o.tone === 'deny' && req.allowFeedback) setFeedback(true);
    else respond(o);
  };

  usePromptKeys(!feedback && !sent, (e) => {
    if (/^[1-9]$/.test(e.key)) {
      const o = req.options[Number(e.key) - 1];
      if (o) {
        e.preventDefault();
        choose(o);
      }
    } else if (e.key === 'Enter' && !e.shiftKey && primary) {
      e.preventDefault();
      choose(primary);
    } else if (e.key === 'Escape' && deny) {
      e.preventDefault();
      choose(deny);
    }
  });


  return (
    <section className="pc glass-card" data-spot data-kind={req.kind} aria-label={req.title} aria-live="polite">
      <header className="pc-head">
        <Glyph name={tool.icon} tone="var(--amber)" size={30} />
        <div className="pc-titles">
          <h3 className="pc-title">{req.title}</h3>
          {req.description && !restates(req) && <p className="pc-desc">{req.description}</p>}
        </div>
        {more > 0 && <span className="pc-more">{more} more waiting</span>}
      </header>

      <div className="pc-body">
        <PermissionSubject req={req} input={input} />
        {req.reason && (
          <p className="pc-reason">
            <Icon name="shield-warning" size={14} />
            {req.reason}
          </p>
        )}
      </div>

      {feedback && deny ? (
        <div className="pc-foot pc-feedback">
          <input
            className="field pc-feedback-field"
            autoFocus
            placeholder="Tell the agent what to do instead"
            aria-label="Tell the agent what to do instead"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                respond(deny, message.trim() || undefined);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setFeedback(false);
                focusComposer();
              }
            }}
          />
          <button type="button" className="btn btn-ghost" onClick={() => (setFeedback(false), focusComposer())}>
            Back
          </button>
          <button type="button" className="btn" onClick={() => respond(deny, message.trim() || undefined)}>
            {deny.label}
          </button>
        </div>
      ) : (
        <div className="pc-foot">
          {req.options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              disabled={sent}
              className={o.tone === 'allow' ? 'btn btn-primary' : o.tone === 'always' ? 'btn' : 'btn btn-ghost'}
              data-tone={o.tone}
              title={o.hint ? `${o.label}. ${o.hint}` : o.label}
              onClick={() => choose(o)}
            >
              <span>{o.label}</span>
              {/* A long option (a whole command) keeps its own words; its hint is in the tooltip. */}
              {o.hint && o.label.length <= HINT_ROOM && <span className="pc-hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
