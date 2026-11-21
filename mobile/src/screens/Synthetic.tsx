import { AnimatePresence, motion } from 'motion/react';
import { memo, useMemo, useState } from 'react';
import type { PhoneItem, UserItem } from '@shared/protocol';
import { taskLabel, taskName, type Synthetic, type SyntheticPart, type TaskNote, type TaskOutcome } from '@shared/synthetic';
import { stampParts } from '@desk/features/timeline/util';
import { formatDuration, formatTokens, plural } from '@desk/lib/format';
import { renderMarkdown } from '@m/lib/md';
import { haptic } from '@m/lib/native';
import { applyFull, fetchItem, setState } from '@m/lib/store';
import { Icon, type IconName } from '@m/ui/icons';
import { REVEAL } from '@m/ui/motion';

/**
 * What Claude Code wrote in the person's place (shared/synthetic.ts), as the desktop shows it
 * (src/features/timeline/Synthetic.tsx) at hand size: quiet step-sized lines instead of message
 * bubbles. A background task or sub-agent that finished (its mark, what finished, the time; a tap
 * opens its report, usage and output file), a slash command as typed with what it printed under
 * it, a `!` command, a message from another session, a compacted conversation's summary.
 * Reminders and caveats are never drawn.
 */
export const SynLine = memo(function SynLine({ sid, it, syn }: { sid: string; it: UserItem; syn: Synthetic }) {
  const parts = syn.parts.filter((p) => p.kind !== 'hidden');
  const cut = !!(it as PhoneItem).cut;
  return (
    <div className="syn" data-role={syn.role}>
      {parts.map((p, i) => (
        <Part key={i} part={p} ts={it.ts} first={i === 0} more={cut ? () => fetchItem(sid, it.id).then((r) => applyFull(sid, r.item)) : undefined} />
      ))}
    </div>
  );
});

function Part({ part, ts, first, more }: { part: SyntheticPart; ts: number; first: boolean; more?: () => Promise<void> }) {
  switch (part.kind) {
    case 'task':
      return <TaskLine task={part.task} ts={ts} more={more} />;
    case 'command':
      return <StaticLine icon={part.name.toLowerCase() === '/model' ? 'cube' : 'terminal'} name={part.name} args={part.args} ts={ts} />;
    case 'bash':
      return <StaticLine icon="terminal" name={part.command} ts={ts} />;
    case 'output':
      return <Output text={part.text} error={part.error} mono={part.source === 'bash'} lone={first} />;
    case 'message':
      return <OpenLine icon="chat" title={`Message from ${part.from || 'another session'}`} body={part.text} ts={ts} more={more} />;
    case 'summary':
      return <OpenLine icon="clipboard" title="Conversation summary" body={part.text.replace(/^This session is being continued[^\n]*\n*/, '')} ts={ts} more={more} />;
    default:
      return null;
  }
}

function When({ ts }: { ts: number }) {
  if (!ts) return null;
  const { day, time } = stampParts(ts);
  return <span className="syn-time num">{day ? `${day}, ${time}` : time}</span>;
}

const MARK: Record<TaskOutcome, IconName> = { done: 'check', failed: 'x', stopped: 'hand', running: 'bell', unknown: 'bell' };

/** A long report opens cut here (characters), on a paragraph's end. */
const CUT = 1100;

function cutText(text: string): string {
  if (text.length <= CUT) return text;
  const para = text.lastIndexOf('\n\n', CUT);
  return text.slice(0, para > CUT * 0.5 ? para : CUT).trimEnd();
}

/** The report in markdown, cut long ("Show all" gives the rest, from the desktop when the phone got it cut). */
function Report({ text, more }: { text: string; more?: () => Promise<void> }) {
  const [whole, setWhole] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = whole ? text : cutText(text);
  const html = useMemo(() => renderMarkdown(shown, false), [shown]);
  // Cut here, or the phone got the message cut (phone.ts): then the rest comes from the desktop.
  const rest = shown.length < text.length || (!!more && !whole);
  return (
    <>
      <div className="md syn-md" data-tone="mid" dangerouslySetInnerHTML={{ __html: html }} />
      {rest && (
        <button
          type="button"
          className="syn-more"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            haptic('select');
            if (!more) return setWhole(true);
            setBusy(true);
            void more().finally(() => {
              setBusy(false);
              setWhole(true);
            });
          }}
        >
          {busy ? <span className="dots" /> : 'Show all'}
        </button>
      )}
    </>
  );
}

function TaskLine({ task, ts, more }: { task: TaskNote; ts: number; more?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const name = taskName(task);
  const result = task.result?.trim() ?? '';
  const u = task.usage;
  const failed = task.outcome === 'failed';
  // The red mark says it failed; its exit code waits in the details (the line keeps room for the name).
  const exit = failed && task.exitCode != null && task.exitCode !== 0 ? `Exit code ${task.exitCode}` : '';
  const facts = [exit, u?.tokens ? `${formatTokens(u.tokens)} tokens` : '', u?.toolUses ? plural(u.toolUses, 'tool use') : '', u?.durationMs ? formatDuration(u.durationMs) : ''].filter(Boolean).join(' · ');
  const can = !!(result || facts || task.outputFile);
  const copy = (path: string) => {
    void navigator.clipboard
      ?.writeText(path)
      .then(() => (haptic('success'), setState({ toast: { text: 'Path copied', level: 'success', at: Date.now() } })))
      .catch(() => {});
  };
  return (
    <div className="step syn-line" data-outcome={task.outcome} data-open={open || undefined}>
      <button type="button" className="step-line" disabled={!can} aria-expanded={can ? open : undefined} onClick={() => can && (haptic('select'), setOpen((v) => !v))}>
        <span className="step-icon syn-mark">
          <Icon name={MARK[task.outcome]} size={14} weight={task.outcome === 'done' || failed ? 'bold' : 'regular'} />
        </span>
        <span className="syn-title">{taskLabel(task)}</span>
        {name && <span className="syn-sub">{name}</span>}
        <When ts={ts} />
      </button>
      <AnimatePresence initial={false}>
        {open && can && (
          <motion.div className="step-detail-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <div className="syn-details">
              {result && <Report text={result} more={more} />}
              {facts && <div className="syn-facts num">{facts}</div>}
              {task.outputFile && (
                <button type="button" className="syn-file" onClick={() => copy(task.outputFile!)} aria-label={`Copy the output file's path, ${task.outputFile}`}>
                  <Icon name="file" size={14} />
                  {/* Left-to-right marks hold the slashes in place inside the box that cuts from the start. */}
                  <span className="syn-file-path">{`‎${task.outputFile}‎`}</span>
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A slash command as typed ("/model opus"), or a `!` command. */
function StaticLine({ icon, name, args, ts }: { icon: IconName; name: string; args?: string; ts: number }) {
  return (
    <div className="step syn-line" data-outcome="done">
      <div className="step-line">
        <span className="step-icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="syn-title syn-cmd">
          <span className="syn-cmd-name">{name}</span>
          {args && <span className="syn-cmd-args"> {args}</span>}
        </span>
        <When ts={ts} />
      </div>
    </div>
  );
}

const OUT_LINES = 3;

/** What a command printed: dim lines under it, the first few in view. */
function Output({ text, error, mono, lone }: { text: string; error: boolean; mono: boolean; lone: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const hidden = lines.length - OUT_LINES;
  const shown = all || hidden <= 1 ? text : lines.slice(0, OUT_LINES).join('\n');
  return (
    <div className="syn-out" data-error={error || undefined} data-mono={mono || undefined} data-lone={lone || undefined}>
      <div className="syn-out-text">{shown}</div>
      {hidden > 1 && (
        <button type="button" className="syn-more" onClick={() => (haptic('select'), setAll((a) => !a))}>
          {all ? 'Show less' : `${hidden} more lines`}
        </button>
      )}
    </div>
  );
}

/** A line that opens to a body of text (a message from elsewhere, a conversation summary). */
function OpenLine({ icon, title, body, ts, more }: { icon: IconName; title: string; body: string; ts: number; more?: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const text = body.trim();
  const first = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return (
    <div className="step syn-line" data-outcome="done" data-open={open || undefined}>
      <button type="button" className="step-line" disabled={!text} aria-expanded={text ? open : undefined} onClick={() => text && (haptic('select'), setOpen((v) => !v))}>
        <span className="step-icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="syn-title">{title}</span>
        {icon === 'chat' && first && <span className="syn-sub">{first}</span>}
        <When ts={ts} />
      </button>
      <AnimatePresence initial={false}>
        {open && text && (
          <motion.div className="step-detail-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
            <div className="syn-details">
              <Report text={text} more={more} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
