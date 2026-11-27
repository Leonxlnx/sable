import { useEffect, useRef, useState, type ReactNode } from 'react';
import { abortable, conn, ConfirmError, isOldPairLink, parsePairLink, SeparateError, type PairOffer } from '@m/lib/conn';
import { deviceName } from '@m/lib/native';
import { readWebFragment } from '@m/lib/web-link';
import { Field } from '@m/ui/Field';
import { launchFrom } from '@m/ui/Launch';
import { Icon } from '@m/ui/icons';
import { LogoMark, Ring } from '@m/ui/marks';
import { cleanDeviceName } from './device';
import './pair.css';

type Step =
  | { kind: 'idle' }
  /** A link is here: the name this browser asks with, which the person may change, then Pair. */
  | { kind: 'ready'; offer: PairOffer }
  | { kind: 'confirm'; offer: PairOffer; was: string; token?: string }
  | { kind: 'connecting'; offer: PairOffer }
  | { kind: 'waiting'; offer: PairOffer; name: string }
  | { kind: 'error'; text: string; offer?: PairOffer };

/** "Settings › Phone › Web access" as the desktop names it: the way there dim, the place at full strength. */
const WHERE = (
  <span className="pair-where">
    <span className="pair-where-dir">Settings › Phone ›</span> Web access
  </span>
);

/**
 * Pairing in a browser (the web build; the phone's own is screens/Pair.tsx). The link the desktop shows
 * opens this page with its one-time key in the fragment (read and erased before anything else,
 * lib/web-link.ts): the screen then shows, from its first frame, the computer it pairs with and the name
 * this browser asks under ("iPad · Safari", web/device.ts), editable, and Pair; nothing is asked before
 * that click. Without a link (a page opened by its address, or the Home Screen app, which keeps its own
 * storage) the link can be pasted. Removed on the desktop, it says so in one line, keeps nothing of the
 * chats, and pairs again from a new link. One status block, one line or two, never two at once.
 */
export function WebPair({ link, onLinkUsed, onLinkDone, removed }: { link?: string | null; onLinkUsed: () => void; onLinkDone?: () => void; removed?: boolean }) {
  const [step, setStep] = useState<Step>(() => {
    const offer = link ? parsePairLink(link) : null;
    return offer ? { kind: 'ready', offer } : { kind: 'idle' };
  });
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  // Removed on the desktop: said for as long as this screen is up, also once the pairing is forgotten here.
  const [wasRemoved] = useState(!!removed);
  const inFlight = useRef(false);
  const mark = useRef<HTMLDivElement>(null);
  const busy = step.kind === 'connecting' || step.kind === 'waiting';

  // The name it asks with: what this browser is, until the person writes another.
  useEffect(() => {
    void deviceName().then((n) => setName((cur) => cur || n));
  }, []);

  // Removed: nothing of that pairing stays here (its token, and the chats the page held).
  useEffect(() => {
    if (removed && conn.state === 'denied') void conn.forget().catch(() => {});
  }, [removed]);

  // A link that came after the first frame (App hands it over once the saved pairing was read).
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!link || seen.current === link) return;
    seen.current = link;
    const offer = parsePairLink(link);
    if (offer && step.kind !== 'connecting' && step.kind !== 'waiting') setStep({ kind: 'ready', offer });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  const read = (raw: string) => {
    // A pasted address of this page (https://…/#p=…&f=…), or the sable:// link itself.
    let link = raw.trim();
    try {
      const u = new URL(link);
      if (u.protocol === 'https:' && u.hash) link = readWebFragment(u as unknown as Location, { state: null, replaceState: () => {} } as unknown as History) ?? link;
    } catch {
      /* not an address */
    }
    return link;
  };

  const usePasted = () => {
    const raw = read(text);
    const offer = parsePairLink(raw);
    if (!offer) return setStep({ kind: 'error', text: isOldPairLink(raw) ? 'This link is from an older Sable. Update Sable on the computer.' : 'That is not a Sable pairing link' });
    setText('');
    setStep({ kind: 'ready', offer });
  };

  const go = async (offer: PairOffer, token?: string) => {
    if (inFlight.current) return;
    const asked = cleanDeviceName(name) || 'Web browser';
    const was = token ? null : conn.replaces(offer);
    if (was) return setStep({ kind: 'confirm', offer, was: was.desktop || 'your computer', token: conn.confirmFor(offer) });
    inFlight.current = true;
    setStep({ kind: 'connecting', offer });
    const signal = conn.beginPair();
    try {
      await abortable(conn.pair(offer, asked, () => !signal.aborted && setStep({ kind: 'waiting', offer, name: asked }), signal, token), signal);
      const r = mark.current?.querySelector('svg')?.getBoundingClientRect();
      if (r) launchFrom(r);
      onLinkUsed();
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ConfirmError) return setStep({ kind: 'confirm', offer, was: err.was.desktop || 'your computer', token: conn.confirmFor(offer) });
      const msg = err instanceof SeparateError ? 'This browser has an older pairing. Remove it on the computer, then pair again.' : (err as Error).message;
      setStep({ kind: 'error', text: msg, offer: /did not answer|closed the connection/i.test(msg) ? offer : undefined });
    } finally {
      inFlight.current = false;
    }
  };

  const cancel = () => {
    conn.cancelPair();
    setStep({ kind: 'idle' });
    onLinkDone?.();
  };

  const computer = (o: PairOffer) => o.name ?? 'your computer';
  let lines: ReactNode;
  let tone: string | undefined;
  if (step.kind === 'idle')
    lines = wasRemoved ? (
      <>
        <p className="wp-line wp-strong">This browser was removed on the desktop.</p>
        <p className="wp-sub">To pair it again, open a new pairing link from {WHERE}, or paste it here.</p>
      </>
    ) : (
      <>
        <p className="wp-line wp-strong">Pair this browser with your computer</p>
        <p className="wp-sub">Open the pairing link from {WHERE} on your computer, or paste it here.</p>
      </>
    );
  else if (step.kind === 'ready')
    lines = (
      <>
        <p className="wp-line wp-strong">Pair with {computer(step.offer)}</p>
        <p className="wp-sub">The computer shows this name when it asks you to allow this browser.</p>
      </>
    );
  else if (step.kind === 'confirm')
    lines = (
      <>
        <p className="wp-line wp-strong">{step.was === computer(step.offer) ? `Pair with ${computer(step.offer)} again?` : `Replace ${step.was}?`}</p>
        <p className="wp-sub">{step.was === computer(step.offer) ? 'The old pairing ends once the computer allows this one.' : `This browser then connects to ${computer(step.offer)} instead.`}</p>
      </>
    );
  else if (step.kind === 'connecting')
    lines = (
      <>
        <p className="wp-line wp-strong">
          <Ring size={13} /> Reaching {computer(step.offer)}
        </p>
        <p className="wp-sub num">{step.offer.hosts.slice(0, 2).join(' · ')}</p>
      </>
    );
  else if (step.kind === 'waiting') {
    tone = 'waiting';
    lines = (
      <>
        <p className="wp-line wp-strong">
          <i className="wp-dot" /> Click Allow on {computer(step.offer)}
        </p>
        <p className="wp-sub">Shown there as {step.name}</p>
      </>
    );
  } else {
    tone = 'error';
    lines = (
      <>
        <p className="wp-line wp-strong">
          <i className="wp-dot" /> {step.text}
        </p>
        <p className="wp-sub">{step.offer ? 'The same link works again.' : <>Open a new pairing link from {WHERE}, or paste it here.</>}</p>
      </>
    );
  }

  const pasting = step.kind === 'idle' || (step.kind === 'error' && !step.offer);
  return (
    <div className="screen pair wpair">
      <Field palette="ember" amount={0.5} focusX={0.62} focusY={1.1} spread={0.95} active={busy} />
      <div className="pair-veil" />
      <div className="wp-main">
        <div ref={mark} className="pair-mark" data-busy={busy || undefined}>
          <LogoMark size={56} cells />
        </div>
        <h1 className="wp-title">Sable</h1>
        <div className="wp-status" data-tone={tone} role="status" aria-live="polite">
          {/* One block, keyed by the step: the new words fade in where the old ones were, never over them. */}
          <div key={step.kind === 'error' ? `e:${step.text}` : step.kind} className="wp-status-in">
            {lines}
          </div>
        </div>

        <div className="wp-form">
          {step.kind === 'ready' ? (
            <form
              className="wp-row"
              onSubmit={(e) => {
                e.preventDefault();
                void go(step.offer);
              }}
            >
              <label className="wp-field">
                <span className="wp-label">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false} aria-label="This browser's name" enterKeyHint="go" />
              </label>
              <button type="submit" className="btn btn-primary wp-go" disabled={!cleanDeviceName(name)}>
                Pair
              </button>
            </form>
          ) : step.kind === 'confirm' ? (
            <div className="wp-row">
              <button type="button" className="btn wp-alt" onClick={cancel}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary wp-go" onClick={() => void go(step.offer, step.token)}>
                {step.was === computer(step.offer) ? 'Pair again' : 'Replace'}
              </button>
            </div>
          ) : busy ? (
            <div className="wp-row wp-row-end">
              <button type="button" className="btn wp-alt" onClick={cancel}>
                Cancel
              </button>
            </div>
          ) : step.kind === 'error' && step.offer ? (
            <div className="wp-row wp-row-end">
              <button type="button" className="btn btn-primary wp-go" onClick={() => void go(step.offer!)}>
                <Icon name="retry" size={15} /> Try again
              </button>
            </div>
          ) : pasting ? (
            <form
              className="wp-row"
              onSubmit={(e) => {
                e.preventDefault();
                usePasted();
              }}
            >
              <label className="wp-field">
                <Icon name="link" size={15} />
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Pairing link" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} aria-label="Pairing link" enterKeyHint="go" />
              </label>
              <button type="submit" className="btn wp-go" disabled={!text.trim()}>
                Continue
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

