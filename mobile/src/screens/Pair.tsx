import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pushBack } from '@m/lib/back';
import { conn, offerLink, parsePairLink, type PairOffer } from '@m/lib/conn';
import { askNotifications, deviceName, haptic } from '@m/lib/native';
import { Field } from '@m/ui/Field';
import { launchFrom } from '@m/ui/Launch';
import { SNAP } from '@m/ui/motion';
import { Icon } from '@m/ui/icons';
import { LogoMark, Ring } from '@m/ui/marks';
import { Scanner } from './Scanner';

type Step =
  | { kind: 'idle' }
  | { kind: 'connecting'; offer: PairOffer }
  | { kind: 'waiting'; offer: PairOffer; phone: string }
  | { kind: 'error'; text: string; quiet?: boolean; offer?: PairOffer };

/** "Settings › Phone" as the desktop names it: the way there dim, the place at full strength. */
const WHERE = (
  <span className="pair-where">
    <span className="pair-where-dir">Settings ›</span> Phone
  </span>
);

/**
 * First run (or after the desktop removed this phone): pair by scanning the desktop's code or
 * pasting its link. One status block under the mark says where pairing stands (reaching the
 * computer, waiting for Allow there and under which name, or what went wrong with a way to try
 * again); it keeps its height in every state, and the keys under it keep theirs.
 */
export function Pair({ link, onLinkUsed, denied, onCancel }: { link?: string | null; onLinkUsed: () => void; denied?: string; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>(denied ? { kind: 'error', text: denied, quiet: true } : { kind: 'idle' });
  const [scan, setScan] = useState(false);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const busy = step.kind === 'connecting' || step.kind === 'waiting';
  const inFlight = useRef(false);
  const cancelled = useRef(false);
  const mark = useRef<HTMLDivElement>(null);

  // Back closes the link field first; pairing again from an older pairing, Back leaves it (that pairing goes on).
  useEffect(() => (onCancel && !busy && !paste ? pushBack(() => (onCancel(), true)) : undefined), [onCancel, busy, paste]);
  useEffect(() => (paste ? pushBack(() => (setPaste(false), true)) : undefined), [paste]);
  useEffect(() => (busy ? pushBack(() => (cancel(), true)) : undefined), [busy]);

  const cancel = () => {
    cancelled.current = true;
    haptic('tap');
    conn.cancelPair();
    setStep({ kind: 'idle' });
  };

  const start = async (raw: string) => {
    if (inFlight.current) return;
    const offer = parsePairLink(raw);
    if (!offer) {
      haptic('warning');
      setStep({ kind: 'error', text: 'That is not a Sable pairing link' });
      return;
    }
    inFlight.current = true;
    cancelled.current = false;
    setScan(false);
    setPaste(false);
    setText('');
    setStep({ kind: 'connecting', offer });
    const phone = await deviceName();
    try {
      await conn.pair(offer, phone, () => setStep({ kind: 'waiting', offer, phone }));
      haptic('success');
      // Home opens out of this mark (the launch glides it into the bar).
      const r = mark.current?.querySelector('svg')?.getBoundingClientRect();
      if (r) launchFrom(r);
      onLinkUsed();
      // The one moment to ask: right after pairing, so a turn that ends while the phone is away can say so.
      void askNotifications();
    } catch (err) {
      if (!cancelled.current) {
        haptic('deny');
        const msg = (err as Error).message;
        // The computer was not reached: the same code works again. A refusal or a used key does not.
        setStep({ kind: 'error', text: msg, offer: /did not answer|closed the connection/i.test(msg) ? offer : undefined });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // "Paste link": a pairing link on the clipboard pairs at once; otherwise the field opens.
  const openPaste = async () => {
    haptic('tap');
    if (paste) return setPaste(false);
    try {
      const clip = await navigator.clipboard?.readText?.();
      if (clip && parsePairLink(clip)) return void start(clip);
    } catch {
      /* no clipboard access: the field */
    }
    setPaste(true);
  };

  // A link that opened the app: paired once; the screen stays until pairing ends (App shows it while `link` is set).
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (link && started.current !== link) {
      started.current = link;
      void start(link);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  const name = (o: PairOffer) => o.name ?? 'your computer';
  let status: ReactNode;
  let tone: string | undefined;
  if (step.kind === 'idle')
    status = onCancel ? (
      <>
        <p className="pair-line pair-strong">Pair again for a secure connection</p>
        <p className="pair-sub">On your computer, open {WHERE} and scan the code.</p>
      </>
    ) : (
      <p className="pair-line">On your computer, open {WHERE} and scan the code.</p>
    );
  else if (step.kind === 'connecting')
    status = (
      <>
        <p className="pair-line pair-strong">
          <Ring size={13} /> Reaching {name(step.offer)}
        </p>
        <p className="pair-sub num">{step.offer.hosts.slice(0, 2).join(' · ')}</p>
      </>
    );
  else if (step.kind === 'waiting') {
    tone = 'waiting';
    status = (
      <>
        <p className="pair-line pair-strong">
          <i className="pair-dot" /> Click Allow on {name(step.offer)}
        </p>
        <p className="pair-sub">Shown there as {step.phone}</p>
      </>
    );
  } else {
    tone = step.quiet ? undefined : 'error';
    const again = step.offer;
    status = (
      <>
        <p className="pair-line pair-strong">
          {!step.quiet && <i className="pair-dot" />} {step.text}
        </p>
        {again ? (
          <button type="button" className="pair-retry" onClick={() => (haptic('tap'), void start(offerLink(again)))}>
            <Icon name="retry" size={15} /> Try again
          </button>
        ) : (
          <p className="pair-sub">Show a new code on your computer: {WHERE}</p>
        )}
      </>
    );
  }

  return (
    <div className="screen pair">
      <Field palette="ember" amount={1} focusX={0.62} focusY={1.04} spread={1.2} active={busy} />
      <div className="pair-veil" />
      <div className="pair-main">
        <motion.div ref={mark} className="pair-mark" data-busy={busy || undefined} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={SNAP}>
          <LogoMark size={64} cells />
        </motion.div>
        <motion.h1 className="pair-title" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SNAP, delay: 0.08 }}>
          Sable
        </motion.h1>
        <div className="pair-status" data-tone={tone}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={step.kind === 'error' ? `e:${step.text}` : step.kind} className="pair-status-in" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
              {status}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="pair-actions">
        <AnimatePresence initial={false}>
          {paste && !busy && (
            <motion.form
              className="pair-paste"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={SNAP}
              onSubmit={(e) => {
                e.preventDefault();
                void start(text);
              }}
            >
              <div className="pair-field">
                <Icon name="link" size={18} />
                <input
                  className="pair-input"
                  autoFocus
                  placeholder="sable://pair?…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  aria-label="Pairing link"
                />
                <button type="submit" className="pair-go" disabled={!text.trim()} aria-label="Pair">
                  <Icon name="up" size={17} weight="bold" />
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
        <AnimatePresence mode="popLayout" initial={false}>
          {busy ? (
            <motion.div key="cancel" className="pair-buttons" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={SNAP}>
              <span className="pair-spacer" aria-hidden />
              <button type="button" className="btn btn-lg pair-alt pair-cancel" onClick={cancel}>
                Cancel
              </button>
            </motion.div>
          ) : (
            <motion.div key="go" className="pair-buttons" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={SNAP}>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => (haptic('tap'), setScan(true))}>
                <Icon name="scan" size={20} /> Scan code
              </button>
              <button type="button" className="btn btn-lg pair-alt" onClick={() => void openPaste()} aria-expanded={paste}>
                <Icon name="clipboard" size={19} /> Paste link
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        {onCancel && !busy && (
          <button type="button" className="link-btn pair-later" onClick={() => (haptic('tap'), onCancel())}>
            Not now
          </button>
        )}
      </div>

      <AnimatePresence>
        {scan && (
          <Scanner
            onCode={(c) => void start(c)}
            onClose={() => setScan(false)}
            onPaste={() => {
              setScan(false);
              void openPaste();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
