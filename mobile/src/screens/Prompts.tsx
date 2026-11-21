import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PermissionOption, PermissionRequest, Question, QuestionRequest } from '@shared/protocol';
import { fit } from '@m/lib/fit';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { diffLines, renderMarkdown } from '@m/lib/md';
import { haptic } from '@m/lib/native';
import { sessionData, setState, useStore } from '@m/lib/store';
import { AutoHeight } from '@m/ui/AutoHeight';
import { Icon, TOOL_ICON } from '@m/ui/icons';
import { StatusMark } from '@m/ui/marks';
import { REVEAL, SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';

const fail = (err: unknown) => setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });

/**
 * What the agent asks: permission prompts and questions as sheets, the oldest first. "Later"
 * closes the sheet; a line above the composer brings it back.
 */
export function Prompts({ sid }: { sid: string }) {
  const permissions = useStore((s) => sessionData(s, sid).permissions);
  const questions = useStore((s) => sessionData(s, sid).questions);
  const [later, setLater] = useState<string | null>(null);
  const perm = permissions[0];
  const question = perm ? undefined : questions[0];
  const current = perm?.id ?? question?.id ?? null;
  const open = !!current && later !== current;
  const waiting = permissions.length + questions.length;

  useEffect(() => {
    if (current && later !== current) haptic('warning');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return (
    <>
      <AnimatePresence>
        {current && later === current && (
          <motion.button
            key="later"
            type="button"
            className="waiting-line glass-liquid"
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={SNAP}
            whileTap={{ scale: 0.98 }}
            onClick={() => (haptic('tap'), setLater(null))}
          >
            <StatusMark tone="awaiting" size={12} />
            <span className="waiting-text">{perm ? perm.title : question!.questions[0]?.question || 'A question for you'}</span>
            {waiting > 1 && <span className="waiting-more num">+{waiting - 1}</span>}
            <span className="waiting-go">Review</span>
          </motion.button>
        )}
      </AnimatePresence>
      <Sheet open={open && !!perm} onClose={() => setLater(current)} label="Permission">
        {perm && <PermissionBody key={perm.id} sid={sid} req={perm} more={waiting - 1} onLater={() => setLater(perm.id)} />}
      </Sheet>
      <Sheet open={open && !!question} onClose={() => setLater(current)} label="Question" tall>
        {question && <QuestionBody key={question.id} sid={sid} req={question} onLater={() => setLater(question.id)} />}
      </Sheet>
    </>
  );
}

/** A path as a label: the folder dim, the name at full strength. */
function PathLabel({ path }: { path: string }) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return (
    <span className="ask-path">
      {i >= 0 && <span className="ask-path-dir">{path.slice(0, i + 1)}</span>}
      <span className="ask-path-name">{path.slice(i + 1)}</span>
    </span>
  );
}

export function PermissionBody({ sid, req, more, onLater, laterLabel = 'Later' }: { sid: string; req: PermissionRequest; more: number; onLater: () => void; laterLabel?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  // Deny with a note, as on the desktop: when the agent takes one, Deny turns the keys into a field
  // ("what to do instead") with Back and Deny; an empty note denies plainly.
  const [note, setNote] = useState<PermissionOption | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => (note ? pushBack(() => (setNote(null), true)) : undefined), [note]);
  const answer = async (o: PermissionOption, msg?: string) => {
    if (busy) return;
    setBusy(o.id);
    haptic(o.tone === 'deny' ? 'deny' : 'success');
    try {
      await conn.call('permission.respond', { sessionId: sid, requestId: req.id, optionId: o.id, ...(msg ? { message: msg } : {}) });
    } catch (err) {
      setBusy(null);
      fail(err);
    }
  };
  const choose = (o: PermissionOption) => {
    if (o.tone === 'deny' && req.allowFeedback) {
      haptic('tap');
      setNote(o);
    } else void answer(o);
  };
  const d = req.detail;
  const add = req.diff?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const del = req.diff?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const ordered = [...req.options].sort((a, b) => rank(a) - rank(b));
  // Granting keys stacked (the first one ivory); refusing and "Later" side by side under them.
  const grants = ordered.filter((o) => o.tone !== 'deny');
  const denials = ordered.filter((o) => o.tone === 'deny');
  const command = d.command && d.command.trim() !== req.title.trim() ? d.command : undefined;
  const path = !command && d.path && !req.title.includes(d.path.split(/[\\/]/).pop() ?? '\u0000') ? d.path : undefined;
  return (
    <div className="ask">
      <div className="ask-head">
        <span className="ask-glyph">
          <Icon name={TOOL_ICON[req.kind] ?? 'tool'} size={20} />
        </span>
        <div className="ask-titles">
          <h2 className="ask-title">{req.title}</h2>
          {req.description && req.description !== req.title && <p className="ask-sub">{req.description}</p>}
        </div>
        {more > 0 && <span className="ask-count num">+{more}</span>}
      </div>

      {command && (
        <pre className="ask-code no-drag">
          <span className="ask-code-sign">$ </span>
          {command}
        </pre>
      )}
      {path && (
        <div className="ask-well">
          <Icon name="file" size={16} />
          <PathLabel path={path} />
        </div>
      )}
      {d.url && (
        <div className="ask-well">
          <Icon name="globe" size={16} />
          <span className="ask-url">{d.url}</span>
        </div>
      )}
      {req.diff && req.diff.length > 0 && (
        <div className="ask-diff-card">
          <button type="button" className="ask-diff num" aria-expanded={showDiff} onClick={() => (haptic('select'), setShowDiff((v) => !v))}>
            <Icon name="file" size={16} />
            <span className="ask-diff-name">{req.diff.length === 1 ? req.diff[0].path.split(/[\\/]/).pop() : `${req.diff.length} files`}</span>
            <span className="add">+{add}</span>
            <span className="del">−{del}</span>
            <Icon name="caretDown" size={13} weight="bold" className="ask-diff-caret" />
          </button>
          <AnimatePresence initial={false}>
            {showDiff && (
              <motion.div className="ask-patch-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={REVEAL}>
                <pre className="ask-patch no-drag" dangerouslySetInnerHTML={{ __html: patchHtml(req.diff) }} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {d.plan && <div className="md ask-plan no-drag" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.plan) }} />}
      {req.reason && <p className="ask-reason">{req.reason}</p>}

      <AutoHeight className="ask-actions-wrap">
        <AnimatePresence mode="popLayout" initial={false}>
          {note ? (
            <motion.div key="note" className="ask-actions" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={SNAP}>
              <form
                className="ask-note"
                onSubmit={(e) => {
                  e.preventDefault();
                  void answer(note, message.trim() || undefined);
                }}
              >
                <textarea
                  className="ask-note-input no-drag"
                  rows={1}
                  autoFocus
                  value={message}
                  placeholder="Tell the agent what to do instead"
                  aria-label="Tell the agent what to do instead"
                  enterKeyHint="send"
                  disabled={!!busy}
                  onChange={(e) => {
                    setMessage(e.target.value);
                    fit(e.target, 132);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void answer(note, message.trim() || undefined);
                    }
                  }}
                />
                <div className="ask-split">
                  <button type="button" className="btn ask-btn btn-ghost ask-later" disabled={!!busy} onClick={() => (haptic('tap'), setNote(null))}>
                    Back
                  </button>
                  <button type="submit" className="btn ask-btn ask-deny" disabled={!!busy && busy !== note.id} data-busy={busy === note.id || undefined}>
                    {busy === note.id ? <span className="dots" /> : note.label}
                  </button>
                </div>
              </form>
            </motion.div>
          ) : (
            <motion.div key="keys" className="ask-actions" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={SNAP}>
              {grants.map((o, i) => (
                <button key={o.id} type="button" className={`btn btn-block ask-btn ${i === 0 ? 'btn-primary' : ''}`} disabled={!!busy && busy !== o.id} data-busy={busy === o.id || undefined} onClick={() => choose(o)}>
                  {busy === o.id ? <span className="dots" /> : o.label}
                </button>
              ))}
              <div className="ask-split">
                {denials.map((o) => (
                  <button key={o.id} type="button" className="btn ask-btn ask-deny" disabled={!!busy && busy !== o.id} data-busy={busy === o.id || undefined} onClick={() => choose(o)}>
                    {busy === o.id ? <span className="dots" /> : o.label}
                  </button>
                ))}
                <button type="button" className="btn ask-btn btn-ghost ask-later" disabled={!!busy} onClick={() => (haptic('tap'), onLater())}>
                  {laterLabel}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </AutoHeight>
    </div>
  );
}

/** The change an edit asks to make: its hunks, coloured, at most 160 lines. */
function patchHtml(diff: NonNullable<PermissionRequest['diff']>): string {
  const lines: string[] = [];
  for (const f of diff) {
    if (diff.length > 1) lines.push(`@@ ${f.path.split(/[\\/]/).pop()}`);
    for (const h of f.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`);
      lines.push(...h.lines);
      if (lines.length > 160) break;
    }
    if (lines.length > 160) break;
  }
  return diffLines(lines.slice(0, 160).join('\n'));
}

const rank = (o: PermissionOption) => (o.tone === 'allow' ? 0 : o.tone === 'always' ? 1 : 2);

/** A short name for a question in the steps above it: its own header, else its first words. */
const tabName = (q: Question, i: number) => q.header?.trim() || `Question ${i + 1}`;

/**
 * The agent's questions, one at a time: a step per question above (its header, a check once it is
 * answered), the answers as a card of rows with their own words under them, and one more row to
 * write something else. The key at the foot goes to the next question, and answers on the last.
 */
export function QuestionBody({ sid, req, onLater, laterLabel = 'Later' }: { sid: string; req: QuestionRequest; onLater: () => void; laterLabel?: string }) {
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState(1);
  const n = req.questions.length;
  const done = (i: number) => (picked[i]?.length ?? 0) > 0 || !!(other[i] ?? '').trim();
  const ready = useMemo(() => req.questions.every((_, i) => done(i)), [req, picked, other]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = req.questions[at];
  const last = at === n - 1;

  const go = (i: number) => {
    if (i === at || i < 0 || i >= n) return;
    haptic('select');
    setDir(i > at ? 1 : -1);
    setAt(i);
  };

  const submit = async (skip?: boolean) => {
    setBusy(true);
    haptic(skip ? 'tap' : 'success');
    const answers: Record<string, string[]> = {};
    req.questions.forEach((qq, i) => {
      const list = [...(picked[i] ?? [])];
      const o = (other[i] ?? '').trim();
      if (o) list.push(o);
      answers[qq.question] = list;
    });
    try {
      await conn.call('question.respond', { sessionId: sid, requestId: req.id, answers: skip ? null : answers });
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  // The next unanswered question, or the answer itself on the last.
  const next = () => {
    if (!last) return go(at + 1);
    if (ready) void submit();
    else go(req.questions.findIndex((_, i) => !done(i)));
  };

  return (
    <div className="ask ask-q">
      {n > 1 && (
        <div className="q-steps no-drag" role="tablist" aria-label="Questions">
          {req.questions.map((qq, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === at} className="q-step" data-on={i === at || undefined} data-done={done(i) || undefined} onClick={() => go(i)}>
              {done(i) && i !== at ? <Icon name="check" size={12} weight="bold" /> : <span className="q-step-n num">{i + 1}</span>}
              <span className="q-step-name">{tabName(qq, i)}</span>
            </button>
          ))}
        </div>
      )}
      <AutoHeight className="q-pane">
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={at}
            className="question"
            custom={dir}
            initial={{ opacity: 0, x: dir * 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: dir * -28 }}
            transition={SNAP}
          >
            <h2 className="ask-title q-title">{q.question}</h2>
            <div className="choices q-choices" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
              {q.options.map((o) => {
                const on = picked[at]?.includes(o.label) ?? false;
                return (
                  <button
                    key={o.label}
                    type="button"
                    className="choice choice-mark"
                    data-selected={on || undefined}
                    role={q.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    onClick={() => {
                      haptic('select');
                      setPicked((p) => ({ ...p, [at]: q.multiSelect ? (on ? (p[at] ?? []).filter((x) => x !== o.label) : [...(p[at] ?? []), o.label]) : on ? [] : [o.label] }));
                      if (!q.multiSelect) setOther((x) => ({ ...x, [at]: '' }));
                    }}
                  >
                    <span className="pick" data-kind={q.multiSelect ? 'check' : 'radio'} aria-hidden>
                      <svg viewBox="0 0 16 16" width="12" height="12">
                        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span className="choice-label opt">
                      <span>{o.label}</span>
                      {o.description && <span className="opt-desc">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
              <OtherRow
                value={other[at] ?? ''}
                on={!!(other[at] ?? '').trim()}
                onChange={(v) => {
                  setOther((x) => ({ ...x, [at]: v }));
                  if (!q.multiSelect && v) setPicked((p) => ({ ...p, [at]: [] }));
                }}
              />
            </div>
          </motion.div>
        </AnimatePresence>
      </AutoHeight>
      <div className="ask-actions q-actions">
        <button type="button" className="btn btn-primary btn-block ask-btn" disabled={busy || (last ? !ready : !done(at))} onClick={next}>
          {busy ? <span className="dots" /> : last ? 'Answer' : 'Next'}
        </button>
        <div className="q-links">
          <button type="button" className="link-btn" disabled={busy} onClick={() => void submit(true)}>
            Skip
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => (haptic('tap'), onLater())}>
            {laterLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The last row of the answers: write something else (it counts as the answer once it has words). */
function OtherRow({ value, on, onChange }: { value: string; on: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className="choice choice-mark q-other" data-selected={on || undefined}>
      <span className="q-other-glyph" aria-hidden>
        <Icon name="pencilLine" size={16} />
      </span>
      <input
        ref={ref}
        className="q-other-input"
        placeholder="Something else"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        enterKeyHint="done"
        onKeyDown={(e) => e.key === 'Enter' && ref.current?.blur()}
        aria-label="Another answer"
      />
    </label>
  );
}
