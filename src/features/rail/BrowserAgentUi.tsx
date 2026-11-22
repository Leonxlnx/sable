import { useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@shared/protocol';
import { PROVIDER_NAME, ProviderMark } from '@/art/Logo';
import { Icon } from '@/icons';
import { Switch } from '@/ui';
import { usePage } from './browser-store';
import { originParts, useSignInAsk, type SignInAsk } from './sign-in';

/**
 * What the Browser tab shows of the agent's own use of the page: one line under the toolbar (who is
 * driving, with Stop; who it signed in as) and
 * the sign-in card over the page. All of it is the app's own, drawn by the tab, never in the page.
 */

/** What the line says: who it signed in as, or who is driving. */
export type LineKind = { kind: 'signed'; user: string } | { kind: 'driving'; yielding?: boolean };

/**
 * What the person reads before saving a sign-in (the card's Save choice, Settings › Permissions): the
 * two things no fix removes. A page's own scripts can read what is filled into it, and once signed in
 * the agent works in that page, with that session.
 */
export const SIGN_IN_RISK = 'The page can read what is filled into it, and the agent then works in the signed-in page.';

/** The line under the toolbar: at most one thing at a time, the most pressing first. */
export function AgentLine({ tabId, provider, running, onStop }: { tabId: string; provider: ProviderId; running: boolean; onStop: () => void }) {
  const page = usePage(tabId);
  const line: LineKind | null = page.signedInAs ? { kind: 'signed', user: page.signedInAs } : page.driving && running ? { kind: 'driving', yielding: page.yielding } : null;
  if (!line) return null;
  return <AgentLineView line={line} provider={provider} onStop={onStop} />;
}

export function AgentLineView({ line, provider, onStop }: { line: LineKind; provider: ProviderId; onStop?: () => void }) {
  if (line.kind === 'signed') {
    return (
      <div className="bw-line" role="status" data-kind="signed">
        <Icon name="check" size={14} className="bw-line-icon" />
        <span className="bw-line-text truncate">Signed in as {line.user}</span>
      </div>
    );
  }
  const name = PROVIDER_NAME[provider];
  return (
    <div className="bw-line" role="status" data-kind="driving" aria-label={line.yielding ? `${name} waits while you use this page` : `${name} is using this page`}>
      <ProviderMark provider={provider} size={14} className="bw-line-mark" />
      <span className="bw-line-text truncate">{line.yielding ? 'waits while you use this page' : 'is using this page'}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onStop}>
        <Icon name="stop" size={13} />
        Stop
      </button>
    </div>
  );
}

/**
 * The sign-in card over the page: the site's origin as the browser has it (never a name the page or
 * the agent gave), large; the sign-ins saved for it, one of which the person picks (always: nothing
 * picks one by itself), or another account with a user name and password; Save for this site (where this computer can keep it); Sign in and Cancel. Enter signs in,
 * Escape cancels. The password stays in this component's field until it goes into the answer.
 */
export function SignInCard({ tabId }: { tabId: string }) {
  const ask = useSignInAsk(tabId);
  if (!ask) return null;
  // A new ask is a new card: nothing typed for another one carries over.
  return <SignInCardView key={`${ask.origin}:${ask.saved.length}`} ask={ask} />;
}

export function SignInCardView({ ask }: { ask: SignInAsk }) {
  const { scheme, host } = originParts(ask.origin);
  const [pick, setPick] = useState<string | null>(ask.saved[0]?.id ?? null);
  const [user, setUser] = useState('');
  const [save, setSave] = useState(true);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  const typing = pick === null;

  useEffect(() => {
    const t = requestAnimationFrame(() => (typing ? userRef.current : document.querySelector<HTMLButtonElement>('.bw-signin .btn-primary'))?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(t);
  }, [typing]);

  const submit = () => {
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
  const ready = !typing || (!!user.trim() && !empty);

  return (
    <div className="bw-signin-scrim">
      <form
        className="bw-signin glass-liquid"
        data-spot=""
        role="dialog"
        aria-label={`Sign in to ${host}`}
        data-escape-scope=""
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
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

        {ask.saved.length > 0 && (
          <div className="bw-signin-picks" role="radiogroup" aria-label="Saved sign-ins">
            {ask.saved.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={pick === s.id} className="bw-signin-pick" data-on={pick === s.id || undefined} onClick={() => setPick(s.id)}>
                <Icon name="user" size={15} />
                <span className="truncate">{s.username}</span>
                {pick === s.id && <Icon name="check" size={13} className="bw-signin-check" />}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={typing} className="bw-signin-pick" data-on={typing || undefined} onClick={() => setPick(null)}>
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
            <input ref={passRef} className="field" type="password" placeholder="Password" aria-label="Password" autoComplete="off" maxLength={1000} onChange={(e) => setEmpty(!e.target.value)} />
          </div>
        )}

        {typing && ask.canSave && save && <p className="bw-signin-risk">{SIGN_IN_RISK}</p>}

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
          <button type="submit" className="btn btn-sm btn-primary" disabled={!ready}>
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
