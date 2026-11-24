import { useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@shared/protocol';
import { PROVIDER_NAME, ProviderMark } from '@/art/Logo';
import { Icon } from '@/icons';
import { Switch } from '@/ui';
import { usePage } from './browser-store';
import { originParts, useSignInAsk, type SignInAsk } from './sign-in';

/**
 * What the Browser tab shows of the agent's own use of the page: one line under the toolbar (who is
 * driving, with Stop; after a sign-in, Continue or Close, which hand the page back or take it away) and
 * the sign-in card over the page. All of it is the app's own, drawn by the tab, never in the page.
 */

/** What the line says: a signed-in page waiting for the person, or who is driving. */
export type LineKind = { kind: 'review'; user: string } | { kind: 'driving'; yielding?: boolean };

/**
 * What the person reads on every sign-in, saved or used once (the card) and under Settings ›
 * Permissions: the things no fix removes. A page's own scripts can read what is filled into it, the
 * agent then works in the signed-in page, and what is saved is safe from other people on this
 * computer but not from programs (agents included) that run as the person.
 */
export const SIGN_IN_RISK = 'The page can read what is filled into it, and the agent then works in the signed-in page.';
export const SIGN_IN_SAVED_RISK = 'Saved like your browser’s passwords: safe from other people on this computer, not from programs or agents that run as you.';

/** The line under the toolbar: at most one thing at a time, the most pressing first. */
export function AgentLine({ tabId, provider, running, onStop, onFinish }: { tabId: string; provider: ProviderId; running: boolean; onStop: () => void; onFinish: (how: 'continue' | 'close') => void }) {
  const page = usePage(tabId);
  const line: LineKind | null = page.filled && page.hold && !page.signing && page.signedInAs !== undefined ? { kind: 'review', user: page.signedInAs } : page.driving && running ? { kind: 'driving', yielding: page.yielding } : null;
  if (!line) return null;
  return <AgentLineView line={line} provider={provider} onStop={onStop} onFinish={onFinish} />;
}

export function AgentLineView({ line, provider, onStop, onFinish }: { line: LineKind; provider: ProviderId; onStop?: () => void; onFinish?: (how: 'continue' | 'close') => void }) {
  if (line.kind === 'review') {
    // After a sign-in the page is the person's until they say: they look at it first (it may still show what was filled).
    return (
      <div className="bw-line" role="status" data-kind="review">
        <Icon name="check" size={14} className="bw-line-icon" />
        <span className="bw-line-text truncate">{line.user ? `Signed in as ${line.user}. Continue gives the agent this page.` : 'Continue gives the agent this page.'}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onFinish?.('close')}>
          Close page
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onFinish?.('continue')}>
          Continue
        </button>
      </div>
    );
  }
  const name = PROVIDER_NAME[provider];
  return (
    <div className="bw-line" role="status" data-kind="driving" aria-label={line.yielding ? `${name} waits while you use this page` : `${name} is using this page`}>
      <ProviderMark provider={provider} size={14} className="bw-line-mark" />
      <span className="bw-line-text truncate">{line.yielding ? `${name} waits while you use this page` : `${name} is using this page`}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onStop}>
        <Icon name="stop" size={13} />
        Stop
      </button>
    </div>
  );
}

/**
 * The sign-in card over the page: the site's origin as the browser has it (never a name the page or
 * the agent gave), large; the page's address and where its form sends, as Electron main found them;
 * the sign-ins saved for it, none chosen until the person picks one, or another account with a user
 * name and password; the risk sentence, every time; Save for this site (where this computer can keep
 * it); Cancel and Sign in. Sign in is no default button: Enter signs in only from the password field
 * the person typed into, and a pick is a click. Escape cancels.
 */
export function SignInCard({ tabId }: { tabId: string }) {
  const ask = useSignInAsk(tabId);
  if (!ask) return null;
  // A new ask is a new card: nothing typed for another one carries over.
  return <SignInCardView key={`${ask.origin}:${ask.action}:${ask.saved.length}`} ask={ask} />;
}

/** `undefined`: nothing chosen yet; `'new'`: another account, typed here; else a saved entry's id. */
type Pick = string | undefined;

/** Origin and path of an address, for the card ("portal.example.test/login"). */
const shortAddress = (url: string) => {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
};

export function SignInCardView({ ask }: { ask: SignInAsk }) {
  const { scheme, host } = originParts(ask.origin);
  const [pick, setPick] = useState<Pick>(ask.saved.length ? undefined : 'new');
  const [user, setUser] = useState('');
  const [save, setSave] = useState(true);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const firstPick = useRef<HTMLButtonElement>(null);
  const [empty, setEmpty] = useState(true);
  const typing = pick === 'new';

  useEffect(() => {
    // Focus goes to what the person must choose or type, never to Sign in.
    const t = requestAnimationFrame(() => (typing ? userRef.current : firstPick.current)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(t);
  }, [typing]);

  const submit = () => {
    if (pick === undefined) return;
    if (!typing) {
      const s = ask.saved.find((x) => x.id === pick);
      if (s) ask.answer({ kind: 'saved', id: s.id, username: s.username });
      return;
    }
    const password = passRef.current?.value ?? '';
    if (!user.trim() || !password) return;
    if (passRef.current) passRef.current.value = '';
    ask.answer({ kind: 'typed', username: user.trim(), password, save: save && ask.canSave });
  };
  const cancel = () => ask.answer({ kind: 'cancel' });
  const ready = pick !== undefined && (!typing || (!!user.trim() && !empty));

  return (
    <div className="bw-signin-scrim">
      <div
        className="bw-signin glass-liquid"
        data-spot=""
        role="dialog"
        aria-label={`Sign in to ${host}`}
        data-escape-scope=""
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }}
      >
        <p className="bw-signin-origin" title={ask.origin}>
          <span className="bw-signin-scheme">{scheme}</span>
          <span className="bw-signin-host">{host}</span>
        </p>
        <p className="bw-signin-where" title={`${ask.address}\n${ask.action}`}>
          <span className="truncate">{shortAddress(ask.address)}</span>
          <Icon name="arrow-right" size={12} />
          <span className="truncate">{shortAddress(ask.action)}</span>
        </p>

        {ask.saved.length > 0 && (
          <div className="bw-signin-picks" role="radiogroup" aria-label="Saved sign-ins">
            {ask.saved.map((s, i) => (
              <button key={s.id} ref={i === 0 ? firstPick : undefined} type="button" role="radio" aria-checked={pick === s.id} className="bw-signin-pick" data-on={pick === s.id || undefined} onClick={() => setPick(s.id)}>
                <Icon name="user" size={15} />
                <span className="truncate">{s.username}</span>
                {pick === s.id && <Icon name="check" size={13} className="bw-signin-check" />}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={typing} className="bw-signin-pick" data-on={typing || undefined} onClick={() => setPick('new')}>
              <Icon name="plus" size={15} />
              <span className="truncate">Another account</span>
              {typing && <Icon name="check" size={13} className="bw-signin-check" />}
            </button>
          </div>
        )}

        {typing && (
          <div className="bw-signin-fields">
            <input
              ref={userRef}
              className="field"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="User name"
              aria-label="User name"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              maxLength={200}
            />
            <input
              ref={passRef}
              className="field"
              type="password"
              placeholder="Password"
              aria-label="Password"
              autoComplete="off"
              maxLength={1000}
              onChange={(e) => setEmpty(!e.target.value)}
              onKeyDown={(e) => {
                // Enter signs in only from the password the person typed.
                if (e.key !== 'Enter') return;
                e.preventDefault();
                submit();
              }}
            />
          </div>
        )}

        <p className="bw-signin-risk">{SIGN_IN_RISK}</p>
        {typing && ask.canSave && save && <p className="bw-signin-risk">{SIGN_IN_SAVED_RISK}</p>}

        <div className="bw-signin-foot">
          {typing &&
            (ask.canSave ? (
              <label className="bw-signin-save">
                <Switch checked={save} onChange={setSave} label="Save for this site" />
                <span>Save for this site</span>
              </label>
            ) : (
              <span className="bw-signin-once">Used once, not saved</span>
            ))}
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!ready} onClick={submit}>
            Sign in
          </button>
        </div>
      </div>
    </div>
  );
}
