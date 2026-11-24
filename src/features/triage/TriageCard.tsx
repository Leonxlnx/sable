import { useImperativeHandle, useState, type MouseEvent, type ReactNode, type Ref } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { PermissionOption, PermissionRequest, QuestionRequest } from '@shared/protocol';
import { ProviderMark } from '@/art/Logo';
import { Icon } from '@/icons';
import { tildePath } from '@/lib/format';
import { PermissionSubject, restates } from '@/features/prompts/PermissionCard';
import { useQuestionAnswers, type QuestionAnswers } from '@/features/prompts/QuestionCard';
import type { PendingPrompt } from '@/state/pending';
import { useStore } from '@/state/store';
import { PathLabel, Tip } from '@/ui';
import { answerOrder, optionKeys, type DeckAction } from './deck';

/** The front card's answer to a key the deck passed on: true when it was taken. */
export interface CardHandle {
  act: (a: DeckAction) => boolean;
}

export interface CardProps {
  p: PendingPrompt;
  /** Where the card stands among everything waiting (oldest first), and how many wait. */
  pos: number;
  total: number;
  /** In front and ready for answers (a card that has just come forward waits a moment, so a quick second key cannot answer it unseen). */
  armed: boolean;
  /** Set to the card's answer keys while it is in front. */
  handle: Ref<CardHandle> | null;
  onPermission: (p: PendingPrompt, option: PermissionOption, note?: string) => void;
  onQuestion: (p: PendingPrompt, answers: Record<string, string[]> | null) => void;
  onOpen: (p: PendingPrompt) => void;
  /** Focus back on the deck (after a field closes, or after a click, so Enter goes on answering). */
  refocus: () => void;
}

/** A key shown in a button's tooltip, as a combination the tooltip spells out. */
const combo = (hint: string) => (hint === '↵' ? 'enter' : hint === '⇧↵' ? 'shift+enter' : hint.toLowerCase());

/** A tooltip that only names the key: the button already says what it does. */
function KeyTip({ hint, children }: { hint: string | undefined; children: ReactNode }) {
  return hint ? (
    <Tip label={null} keys={combo(hint)} side="bottom">
      {children}
    </Tip>
  ) : (
    <>{children}</>
  );
}

/** Where the request comes from: the agent, the chat and its folder (opens the chat), and the card's place in the deck. */
function From({ p, pos, total, onOpen }: Pick<CardProps, 'p' | 'pos' | 'total' | 'onOpen'>) {
  const session = useStore((s) => s.sessions[p.sessionId]);
  const home = useStore((s) => s.home);
  if (!session) return null;
  return (
    <div className="tri-from">
      <Tip label="Open chat" keys="o" side="top">
        <button type="button" className="tri-from-link" onClick={() => onOpen(p)} aria-label={`Open ${session.title}`}>
          <ProviderMark provider={session.provider} size={15} />
          <span className="tri-from-title truncate">{session.title}</span>
          {!session.chat && session.cwd && <PathLabel path={tildePath(session.cwd, home)} className="tri-from-folder" />}
        </button>
      </Tip>
      {total > 1 && (
        <span className="tri-pos num" aria-label={`${pos} of ${total} waiting`}>
          {pos}
          <span className="tri-pos-of"> of </span>
          {total}
        </span>
      )}
    </div>
  );
}

/** The front card's contents: where it comes from, what it asks, and its answers. */
export function CardBody(props: CardProps) {
  return props.p.kind === 'permission' ? <PermissionBody {...props} req={props.p.req} /> : <QuestionBody {...props} req={props.p.req} />;
}

function PermissionBody({ p, req, pos, total, armed, handle, onPermission, onOpen, refocus }: CardProps & { req: PermissionRequest }) {
  const [note, setNote] = useState<string | null>(null);
  // The denial the note goes with (an agent may offer more than one).
  const [noteFor, setNoteFor] = useState<PermissionOption | null>(null);
  const input = useStore((s) => (req.itemId ? (s.data[p.sessionId]?.items[req.itemId] as { input?: unknown } | undefined)?.input : undefined));
  const keys = optionKeys(req.options);

  const choose = (o: PermissionOption | undefined) => {
    if (!o || !armed) return false;
    if (o.tone === 'deny' && req.allowFeedback) {
      setNoteFor(o);
      setNote('');
    } else onPermission(p, o);
    return true;
  };

  useImperativeHandle(handle, () => ({
    act: (a) => {
      if (note !== null) return false;
      if (a.type === 'allow') return choose(keys.allow);
      if (a.type === 'always') return choose(keys.always);
      if (a.type === 'deny') return choose(keys.deny);
      if (a.type === 'pick') return choose(req.options[a.index]);
      return false;
    },
  }));

  const deny = noteFor ?? keys.deny;
  const closeNote = () => (setNote(null), refocus());
  // A command's title is the command, shown in full just below: the card is titled with what it is for.
  const echo = req.kind === 'bash' && !!req.description && req.title.trim() === req.detail.command?.trim();
  const title = echo ? req.description! : req.title;
  const desc = !echo && req.description && !restates(req) ? req.description : null;

  // No on the left, yes on the right with the plain allow last: the way the card leaves (aside, or up).
  const button = (o: PermissionOption) => {
    const i = req.options.indexOf(o);
    const primary = o === keys.allow;
    return (
      <KeyTip key={o.id} hint={keys.hints[i]}>
        <button type="button" className={primary ? 'btn btn-primary' : o.tone === 'deny' ? 'btn btn-ghost' : 'btn'} data-tone={o.tone} onClick={() => choose(o)}>
          {o.label}
        </button>
      </KeyTip>
    );
  };
  const { no, yes } = answerOrder(req.options);

  return (
    <>
      <From p={p} pos={pos} total={total} onOpen={onOpen} />
      <header className="tri-ask">
        <div className="tri-ask-text">
          <h3 className="tri-title">{title}</h3>
          {desc && <p className="tri-desc">{desc}</p>}
        </div>
      </header>
      <div className="tri-subject pc-body">
        <PermissionSubject req={req} input={input} />
        {req.reason && (
          <p className="pc-reason">
            <Icon name="shield-warning" size={14} />
            {req.reason}
          </p>
        )}
      </div>
      {note !== null && deny ? (
        <div className="tri-foot tri-note">
          <input
            className="field tri-note-field"
            autoFocus
            placeholder="Tell the agent what to do instead"
            aria-label="Tell the agent what to do instead"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onPermission(p, deny, note.trim() || undefined);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeNote();
              }
            }}
          />
          <Tip label={null} keys="esc">
            <button type="button" className="btn btn-ghost" onClick={closeNote}>
              Back
            </button>
          </Tip>
          <KeyTip hint="↵">
            <button type="button" className="btn btn-primary" onClick={() => onPermission(p, deny, note.trim() || undefined)}>
              {deny.label}
            </button>
          </KeyTip>
        </div>
      ) : (
        <div className="tri-foot">
          {no.length > 0 && <div className="tri-foot-no">{no.map(button)}</div>}
          <div className="tri-foot-yes">
            {yes.map(button)}
          </div>
        </div>
      )}
    </>
  );
}

function QuestionBody({ p, req, pos, total, armed, handle, onQuestion, onOpen, refocus }: CardProps & { req: QuestionRequest }) {
  const x = useQuestionAnswers(req, (answers) => onQuestion(p, answers));
  const { q, qs, step, last, complete, sent } = x;

  useImperativeHandle(handle, () => ({
    act: (a) => {
      if (sent || !armed) return false;
      if (a.type === 'pick') return x.pick(a.index);
      if (a.type === 'advance') return x.advance(), true;
      if (a.type === 'skip') return x.send(true), true;
      if (a.type === 'step') {
        const to = step + a.by;
        if (qs.length < 2 || to < 0 || to >= qs.length) return false;
        x.go(to);
        return true;
      }
      return false;
    },
  }));

  if (!q) return null;
  const several = qs.length > 1;
  return (
    <>
      <From p={p} pos={pos} total={total} onOpen={onOpen} />
      <QuestionPage x={x} refocus={refocus} />
      <div className="tri-foot">
        <div className="tri-foot-no">
          <Tip label={null} keys="s">
            <button type="button" className="btn btn-ghost tri-skip" disabled={sent} onClick={() => armed && x.send(true)}>
              Skip
            </button>
          </Tip>
        </div>
        <div className="tri-foot-yes">
          {several && <Steps x={x} />}
          {several && step > 0 && (
            <Tip label={null} keys="←">
              <button type="button" className="btn btn-ghost" onClick={() => x.go(step - 1)}>
                Back
              </button>
            </Tip>
          )}
          {last ? (
            <Tip label={null} keys="enter">
              <button type="button" className="btn btn-primary" disabled={!complete || sent} onClick={() => armed && x.send()}>
                {several ? 'Send answers' : 'Send answer'}
              </button>
            </Tip>
          ) : (
            <Tip label={null} keys="enter">
              <button type="button" className="btn btn-primary" disabled={!x.ready} onClick={() => x.go(step + 1)}>
                Next
              </button>
            </Tip>
          )}
        </div>
      </div>
    </>
  );
}

/** Where a request of several questions is: one mark per question, the current one lit, answered ones a step brighter. */
function Steps({ x }: { x: QuestionAnswers }) {
  return (
    <span className="tri-steps" role="img" aria-label={`Question ${x.step + 1} of ${x.qs.length}`}>
      {x.qs.map((_, i) => (
        <i key={i} data-on={i === x.step || undefined} />
      ))}
    </span>
  );
}

/**
 * The current question as a column of choices (radio or check marks), with "Other" turning into a
 * field in place. A click hands focus back to the deck, so Enter goes on to the next question
 * instead of pressing the option again.
 */
function QuestionPage({ x, refocus }: { x: QuestionAnswers; refocus: () => void }) {
  const { q, a, multi, step, dir } = x;
  if (!q) return null;
  const role = multi ? 'checkbox' : 'radio';
  const byPointer = (e: MouseEvent) => e.detail > 0 && refocus();
  return (
    <AnimatePresence mode="popLayout" initial={false} custom={dir}>
      <motion.div
        key={step}
        className="tri-qpage"
        initial={{ opacity: 0, x: dir * 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: dir * -24, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 460, damping: 38 }}
      >
        <header className="tri-ask">
          <h3 className="tri-title tri-ask-text">{q.question}</h3>
        </header>
        <div className="tri-opts" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o) => {
            const on = a.picked.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                role={role}
                aria-checked={on}
                className="tri-opt"
                data-on={on || undefined}
                onClick={(e) => {
                  x.toggle(o.label);
                  byPointer(e);
                }}
              >
                <Mark multi={multi} on={on} />
                <span className="tri-opt-text">
                  <span className="tri-opt-label">{o.label}</span>
                  {o.description && <span className="tri-opt-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          {a.other === null ? (
            <button type="button" role={role} aria-checked={false} className="tri-opt" onClick={x.chooseOther}>
              <Mark multi={multi} on={false} />
              <span className="tri-opt-text">
                <span className="tri-opt-label tri-opt-other">Other</span>
              </span>
            </button>
          ) : (
            <div className="tri-opt tri-opt-field" data-on={a.other.trim() ? true : undefined}>
              <Mark multi={multi} on={!!a.other.trim()} />
              <input
                ref={x.otherRef}
                autoFocus
                className="tri-other-field"
                placeholder="Write your own answer"
                aria-label="Your own answer"
                value={a.other}
                onChange={(e) => x.setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    x.advance();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    x.dropEmptyOther();
                    refocus();
                  }
                }}
              />
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

/** A choice's mark: a ring that fills ivory with an ink dot, or a box that fills with an ink check. */
function Mark({ multi, on }: { multi: boolean; on: boolean }) {
  return (
    <span className={multi ? 'tri-mark tri-box' : 'tri-mark tri-radio'} data-on={on || undefined} aria-hidden>
      {multi ? <Icon name="check" size={11} /> : <i />}
    </span>
  );
}
