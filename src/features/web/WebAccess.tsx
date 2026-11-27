import { useEffect, useRef, useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Icon } from '@/icons';
import { uiZoom } from '@/lib/motion';
import { useNow } from '@/lib/view-hooks';
import { quietFocus } from '@/lib/quiet-focus';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { Spinner, Switch } from '@/ui';
import { Card, Check, Row } from '@/features/settings/parts';
import { webSection } from './web-model';
import { saveCertificate, takeWebScroll, useWebState, webApprove, webOffer, webRevoke } from './web-state';
import './web.css';

/**
 * Settings › Phone › Web access (only built in with `WEB_SHIPS`): Sable in a browser on a tablet, over
 * the home network (server/services/web-remote.ts). The switch; while on, the network it serves on, the
 * address, setting up a device (the certificate, then pairing), a device asking, the paired devices,
 * the steer switch, and the bridge's notices. What shows when is `webSection` (web-model.ts).
 */
export function WebAccess() {
  const state = useWebState();
  const webRemote = useStore((s) => s.settings.webRemote);
  const webNetwork = useStore((s) => s.settings.webNetwork);
  const webSteerDanger = useStore((s) => s.settings.webSteerDanger);
  const now = useNow(!!state?.pairing, 1000);
  const top = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  // Opened from the top bar's mark: the section comes into view once it is drawn.
  const ready = !!state;
  useEffect(() => {
    if (ready && takeWebScroll()) reveal(top.current, 'top');
  }, [ready]);

  // A pairing code asked for here comes into view whole (it opens under the fold).
  const offered = useRef(false);
  const pairing = !!state?.pairing;
  useEffect(() => {
    if (pairing && offered.current) reveal(top.current?.querySelector('.web-pair'), 'whole');
    offered.current = false;
  }, [pairing]);

  // A tablet that asks while the person looks at its code: the card with Allow comes into view.
  const asking = state?.listening ? state.request?.id : undefined;
  useEffect(() => {
    if (asking) reveal(top.current?.querySelector('.phone-ask'), 'whole');
  }, [asking]);

  if (!state) return null;
  const v = webSection(state, { webRemote, webNetwork, webSteerDanger }, now);

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="web-access" ref={top}>
      <Card>
        <Row label="Web access" help={v.status}>
          <Switch label="Web access" checked={v.on} disabled={!v.switchable} onChange={(on) => setSettings({ webRemote: on })} />
        </Row>
        {v.networks && (
          <div className="web-net">
            <Row label="Network" help={v.networkHelp} />
            {v.networks.length > 0 && (
              <div role="radiogroup" aria-label="Network" className="pick-list web-net-list">
                {v.networks.map((n) => (
                  <button key={n.id} type="button" role="radio" aria-checked={n.chosen} className="pick pick-plain" onClick={() => !n.chosen && setSettings({ webNetwork: n.id })}>
                    <span className="pick-name truncate">{n.name}</span>
                    <span className="web-net-addr num">{n.address}</span>
                    <Check on={n.chosen} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {v.address && (
          <Row
            label="Address"
            align="start"
            help={
              <span className="web-link">
                <span className="web-link-text num">{v.address.shown}</span>
                <CopyButton text={v.address.link} label="Copy address" size={13} />
              </span>
            }
          >
            {v.address.qr && <Qr qr={v.address.qr.qr} size={v.address.qr.size} label="QR code for the address" className="web-qr-small" />}
          </Row>
        )}
      </Card>

      {v.setup && (
        <Card title="Set up a device">
          {v.setup.caUrl && (
          <Row
            label={<Step n={1}>Install the certificate</Step>}
            align="start"
            help={
              <>
                <span className="web-link">
                  <span>Open</span>
                  <span className="web-link-text num">{v.setup.caUrl}</span>
                  <CopyButton text={v.setup.caUrl!} label="Copy the certificate's address" size={13} />
                </span>
                {v.setup.fingerprint.length > 0 && (
                  <span className="web-fp" aria-label="SHA-256 fingerprint">
                    <span className="web-fp-head">Trust it only if its SHA-256 reads</span>
                    {v.setup.fingerprint.map((line) => (
                      <code key={line} className="web-fp-line">
                        {line}
                      </code>
                    ))}
                  </span>
                )}
              </>
            }
          >
            <button type="button" className="btn btn-sm" disabled={busy === 'save'} onClick={() => void run('save', saveCertificate)}>
              {busy === 'save' ? <Spinner size={12} /> : <Icon name="download" size={14} />}
              Save certificate
            </button>
          </Row>
          )}
          {v.setup.pairing ? (
            <div className="web-pair">
              <Qr qr={v.setup.pairing.qr} size={v.setup.pairing.size} label="Pairing code for a browser" className="web-qr" />
              <div className="web-pair-side">
                <div className="set-row-label">
                  {v.setup.caUrl ? <Step n={2}>Pair</Step> : 'Pair'}
                </div>
                <p className="web-pair-how">Scan the code with the tablet’s camera, then allow it here.</p>
                <div className="phone-link">
                  <code className="phone-link-text">{v.setup.pairing.link}</code>
                  <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(v.setup!.pairing!.link)}>
                    Copy link
                  </button>
                </div>
                <div className="phone-pair-foot">
                  <span className="num">Works once, {v.setup.pairing.left} left</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void run('pair', () => webOffer(true))}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <Row label={v.setup.caUrl ? <Step n={2}>Pair</Step> : 'Pair'}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy === 'pair'}
                onClick={() => {
                  offered.current = true;
                  void run('pair', () => webOffer(false));
                }}
              >
                Show pairing code
              </button>
            </Row>
          )}
        </Card>
      )}

      {v.request && (
        <section className="phone-ask card" data-spot role="alertdialog" aria-labelledby="web-ask-title">
          <span className="phone-ask-icon">
            <Icon name="tablet" size={18} />
          </span>
          <div className="phone-ask-text">
            <div id="web-ask-title" className="phone-ask-title">
              Allow {v.request.name}?
            </div>
            <div className="phone-ask-sub num">{v.request.address}</div>
          </div>
          <div className="phone-ask-actions">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void run('ask', () => webApprove(v.request!.id, false))}>
              Deny
            </button>
            <button type="button" className="btn btn-primary" disabled={!!busy} ref={quietFocus} onClick={() => void run('ask', () => webApprove(v.request!.id, true))}>
              Allow
            </button>
          </div>
        </section>
      )}

      {v.devices.length > 0 && (
        <Card title="Web devices">
          {v.devices.map((d) => {
            const asking = confirm === d.id;
            return (
              <div
                key={d.id}
                className="web-dev"
                data-escape-scope={asking ? '' : undefined}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && asking) {
                    e.stopPropagation();
                    setConfirm(null);
                  }
                }}
              >
                <Row
                  label={
                    <span className="phone-dev">
                      <Icon name="tablet" size={15} />
                      {d.name}
                    </span>
                  }
                  help={asking ? 'Revoke it? It disconnects now and has to pair again.' : d.line}
                >
                  {asking ? (
                    <>
                      <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        disabled={busy === `revoke:${d.id}`}
                        onClick={() => void run(`revoke:${d.id}`, () => webRevoke(d.id)).then(() => setConfirm(null))}
                      >
                        {busy === `revoke:${d.id}` ? <Spinner size={12} /> : <Icon name="trash" size={14} />}
                        Revoke
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" onClick={() => setConfirm(d.id)}>
                      Revoke
                    </button>
                  )}
                </Row>
              </div>
            );
          })}
        </Card>
      )}

      {v.steer !== undefined && (
        <Card>
          <Row label="Let web devices steer chats that never ask" help="A browser may then send into Bypass and Full access chats, and into Codex chats.">
            <Switch label="Let web devices steer chats that never ask" checked={v.steer} onChange={(on) => setSettings({ webSteerDanger: on })} />
          </Row>
        </Card>
      )}

      {v.replacement && (
        <div className="web-note card" data-tone="warn" role="status">
          {v.replacement}
        </div>
      )}
      {v.unsaved && (
        <div className="web-note card" data-tone="error" role="alert">
          A revoked device is disconnected, but the change could not be saved yet. Sable keeps trying.
        </div>
      )}
      {v.error && (
        <div className="web-note card" data-tone="error" role="alert">
          {v.error}
        </div>
      )}
    </div>
  );
}

/**
 * Scrolls Settings' pane (and only it: scrollIntoView would also scroll the dialog's clipped boxes and
 * push the page away) so `el` stands at its top, or just whole in view.
 */
function reveal(el: Element | null | undefined, how: 'top' | 'whole') {
  const body = el?.closest<HTMLElement>('.set-body');
  if (!el || !body) return;
  const z = uiZoom();
  const box = el.getBoundingClientRect();
  const pane = body.getBoundingClientRect();
  if (how === 'top') body.scrollTop += (box.top - pane.top) / z - 12;
  else if (box.bottom > pane.bottom) {
    // After a click: the pane glides there (the person asked for it), never a jump.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    body.scrollBy({ top: Math.min(box.top - pane.top - 12 * z, box.bottom - pane.bottom + 24 * z) / z, behavior: still ? 'auto' : 'smooth' });
  }
}

function Step({ n, children }: { n: number; children: string }) {
  return (
    <span className="web-step">
      <span className="web-step-n num" aria-hidden>
        {n}
      </span>
      {children}
    </span>
  );
}

function Qr({ qr, size, label, className }: { qr: string; size: number; label: string; className: string }) {
  return (
    <div className={className}>
      <svg viewBox={`-3 -3 ${size + 6} ${size + 6}`} shapeRendering="crispEdges" role="img" aria-label={label}>
        <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#f2f1ee" />
        <path d={qr} fill="#0a0a0b" />
      </svg>
    </div>
  );
}
