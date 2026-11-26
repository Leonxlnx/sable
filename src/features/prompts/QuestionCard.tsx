import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Question, QuestionRequest } from '@shared/protocol';
import { Icon } from '@/icons';
import { respondQuestion } from '@/state/actions';
import { leaveCard } from './leave';
import { focusComposer } from '@/state/hooks';
import { play } from '@/lib/motion';
import { DOCK_GLIDE_EASE } from '@/features/session/dock-glide';
import { glideMs } from '@/features/composer/stack-glide';
import { usePromptKeys } from './keys';

interface Answer {
  picked: string[];
  /** null: "Other" not chosen. */
  other: string | null;
}

const blank = (): Answer => ({ picked: [], other: null });
const answered = (a: Answer | undefined) => !!a && (a.picked.length > 0 || !!a.other?.trim());

/** The answers being given to one question request, and what can be done with them (shared by the dock and the triage deck). */
export interface QuestionAnswers {
  qs: Question[];
  step: number;
  /** The direction of the last step, for the page's slide. */
  dir: number;
  q: Question | undefined;
  a: Answer;
  multi: boolean;
  last: boolean;
  /** Every question has an answer. */
  complete: boolean;
  /** The current question has an answer. */
  ready: boolean;
  sent: boolean;
  otherRef: RefObject<HTMLInputElement | null>;
  toggle: (label: string) => void;
  chooseOther: () => void;
  setOther: (text: string) => void;
  /** Leaves "Other" when nothing was written in it. */
  dropEmptyOther: () => void;
  go: (to: number) => void;
  /** The option at `n` (0-based), or "Other" right after the last option. False when there is none. */
  pick: (n: number) => boolean;
  /** Sends the answers (or, with `skip`, none). */
  send: (skip?: boolean) => void;
  /** Enter: on to the next question, or send when every question has its answer. */
  advance: () => void;
}

export function useQuestionAnswers(req: QuestionRequest, deliver: (answers: Record<string, string[]> | null, back: () => void) => void): QuestionAnswers {
  const qs = req.questions;
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [answers, setAnswers] = useState<Answer[]>(() => qs.map(blank));
  const [sent, setSent] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);
  const q = qs[step];
  const a = answers[step] ?? blank();
  const multi = !!q?.multiSelect;
  const last = step === qs.length - 1;
  const complete = qs.every((_, i) => answered(answers[i]));

  const update = (fn: (a: Answer) => Answer) => setAnswers((all) => all.map((x, i) => (i === step ? fn(x) : x)));

  const toggle = (label: string) =>
    update((cur) => {
      if (multi) return { ...cur, picked: cur.picked.includes(label) ? cur.picked.filter((l) => l !== label) : [...cur.picked, label] };
      return { picked: cur.picked[0] === label ? [] : [label], other: null };
    });

  const chooseOther = () => {
    update((cur) => (cur.other !== null ? (multi ? { ...cur, other: null } : cur) : { picked: multi ? cur.picked : [], other: '' }));
    requestAnimationFrame(() => otherRef.current?.focus());
  };

  const go = (to: number) => {
    setDir(to > step ? 1 : -1);
    setStep(to);
  };

  const send = (skip = false) => {
    if (sent) return;
    if (!skip && !complete) return;
    setSent(true);
    const out: Record<string, string[]> = {};
    qs.forEach((qq, i) => {
      const x = answers[i];
      out[qq.question] = [...x.picked, ...(x.other?.trim() ? [x.other.trim()] : [])];
    });
    // `back`: the answer was not taken, so the card may send again.
    deliver(skip ? null : out, () => setSent(false));
  };

  const advance = () => {
    if (!last && answered(a)) go(step + 1);
    else if (complete) send();
    else {
      const missing = answers.findIndex((x) => !answered(x));
      if (missing >= 0 && missing !== step) go(missing);
    }
  };

  const pick = (n: number) => {
    if (!q) return false;
    if (n < q.options.length) toggle(q.options[n].label);
    else if (n === q.options.length) chooseOther();
    else return false;
    return true;
  };

  return {
    qs,
    step,
    dir,
    q,
    a,
    multi,
    last,
    complete,
    ready: answered(a),
    sent,
    otherRef,
    toggle,
    chooseOther,
    setOther: (text) => update((cur) => ({ ...cur, other: text })),
    dropEmptyOther: () => {
      if (!a.other?.trim()) update((cur) => ({ ...cur, other: null }));
    },
    go,
    pick,
    send,
    advance,
  };
}

/** The stepper between questions, on the question's first line at the card's right; `children` (a count) sits before it.
 *  The question's own header ("Logger") is not shown: a kicker above the question only repeats it. */
export function QuestionHead({ x, children }: { x: QuestionAnswers; children?: ReactNode }) {
  const { qs, step, last } = x;
  return (
    <header className="qc-head">
      {children}
      {qs.length > 1 && (
        <div className="qc-stepper">
          <button type="button" className="icon-btn qc-step" aria-label="Previous question" disabled={step === 0} onClick={() => x.go(step - 1)}>
            <Icon name="caret-left" size={12} />
          </button>
          <span className="qc-count num">
            {step + 1} of {qs.length}
          </span>
          <button type="button" className="icon-btn qc-step" aria-label="Next question" disabled={last} onClick={() => x.go(step + 1)}>
            <Icon name="caret-right" size={12} />
          </button>
        </div>
      )}
    </header>
  );
}

/** The current question with its options and "Other"; `onFieldEscape` runs after Escape in the "Other" field. */
export function QuestionPage({ x, onFieldEscape }: { x: QuestionAnswers; onFieldEscape: () => void }) {
  const { q, a, multi, step, dir } = x;
  if (!q) return null;
  return (
    <AnimatePresence mode="popLayout" initial={false} custom={dir}>
      <motion.div
        key={step}
        className="qc-page"
        custom={dir}
        initial={{ opacity: 0, x: dir * 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: dir * -24, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 460, damping: 38 }}
      >
        <h3 className="pc-title qc-question">{q.question}</h3>
        {multi && <p className="pc-desc">Choose any that apply</p>}
        <div className="qc-options" role={multi ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o, i) => {
            const on = a.picked.includes(o.label);
            return (
              <button key={o.label} type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={on} className="qc-opt" data-on={on || undefined} onClick={() => x.toggle(o.label)}>
                <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden>
                  {on && (multi ? <Icon name="check" size={11} /> : <i />)}
                </span>
                <span className="qc-opt-text">
                  <span className="qc-opt-label">{o.label}</span>
                  {o.description && <span className="qc-opt-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          {a.other === null ? (
            <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={false} className="qc-opt qc-other" onClick={x.chooseOther}>
              <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden />
              <span className="qc-opt-text">
                <span className="qc-opt-label">Other</span>
              </span>
            </button>
          ) : (
            <div className="qc-opt qc-other" data-on={a.other.trim() ? true : undefined}>
              <span className={multi ? 'qc-mark qc-box' : 'qc-mark qc-radio'} aria-hidden>
                {a.other.trim() && (multi ? <Icon name="check" size={11} /> : <i />)}
              </span>
              <input
                ref={x.otherRef}
                autoFocus
                className="qc-other-field"
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
                    onFieldEscape();
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

/** Structured questions from the agent: pick options, or write your own answer. */
export function QuestionCard({ sessionId, req, more }: { sessionId: string; req: QuestionRequest; more: number }) {
  const x = useQuestionAnswers(req, (answers, back) => {
    leaveCard(req.id, back);
    void respondQuestion(sessionId, req.id, answers);
    focusComposer();
  });
  const { q, qs, step, last, complete, sent } = x;

  usePromptKeys(!sent, (e) => {
    if (/^[1-9]$/.test(e.key)) {
      if (x.pick(Number(e.key) - 1)) e.preventDefault();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      x.advance();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      x.send(true);
    } else if (qs.length > 1 && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const to = step + (e.key === 'ArrowRight' ? 1 : -1);
      if (to >= 0 && to < qs.length) {
        e.preventDefault();
        x.go(to);
      }
    }
  });

  // The next question is taller (more options): the card's upper edge used to jump there in one
  // frame while the two questions crossfaded. It opens upward instead, its header riding the edge,
  // in step with the task strip and the conversation above (SessionView.tsx, Timeline.tsx). Paint
  // only: the card has its new size at once, nothing is laid out again. A shorter one is left as
  // it is (there is nothing to draw above the new edge).
  const card = useRef<HTMLElement>(null);
  const seen = useRef({ step, tall: 0 });
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const was = seen.current;
    const tall = el.offsetHeight;
    seen.current = { step, tall };
    const d = tall - was.tall;
    if (was.step === step || !was.tall || d < 8) return;
    const round = getComputedStyle(el).borderTopLeftRadius || '0px';
    // The dock's own curve: the card grows on the clock the conversation above it glides on (the dock grows by d).
    const timing = { duration: glideMs(d), easing: DOCK_GLIDE_EASE };
    play(el, [{ clipPath: `inset(${d}px 0 0 0 round ${round} ${round} 0 0)` }, { clipPath: `inset(0 0 0 0 round ${round} ${round} 0 0)` }], timing);
    play(el.querySelector('.qc-head'), [{ translate: `0 ${d}px` }, { translate: '0 0' }], timing);
  });

  if (!q) return null;

  return (
    <section
      ref={card}
      className="pc qc glass-card"
      data-spot
      data-head={qs.length > 1 ? (more > 0 ? 'both' : 'step') : more > 0 ? 'more' : undefined}
      aria-label="Questions from the agent"
    >
      <QuestionHead x={x}>{more > 0 && <span className="pc-more">{more} more waiting</span>}</QuestionHead>

      <QuestionPage x={x} onFieldEscape={() => focusComposer()} />

      <div className="pc-foot qc-foot">
        <button type="button" className="btn btn-ghost qc-skip" disabled={sent} onClick={() => x.send(true)}>
          Skip
        </button>
        <span className="grow" />
        {/* One way forward, as Enter does it: on to the next question until the last has its answer,
            then send. Two keys of which neither could be pressed read as a card that was stuck. */}
        {!last ? (
          <button type="button" className="btn btn-primary" disabled={!x.ready} onClick={() => x.go(step + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!complete || sent} onClick={() => x.send()}>
            {qs.length > 1 ? 'Send answers' : 'Send answer'}
          </button>
        )}
      </div>
    </section>
  );
}
