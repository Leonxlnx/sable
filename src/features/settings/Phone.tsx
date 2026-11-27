import { useEffect, useState } from 'react';
import type { PhoneStatus } from '@shared/protocol';
import { WebAccess } from '@/features/web/WebAccess';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { setSettings } from '@/state/actions';
import { useStore } from '@/state/store';
import { timeAgo } from '@/lib/format';
import { useNow } from '@/lib/useNow';
import { quietFocus } from '@/lib/quiet-focus';
import { Switch } from '@/ui';
import { Card, Row } from './parts';
import './phone.css';

/**
 * Settings › Phone: the LAN endpoint for Sable's phone app (server/services/phone.ts), pairing by
 * QR code or link, the phone asking to pair, and the paired phones. The bridge pushes
 * `phone.updated`; no store state (nothing else in the app needs it).
 */
/** "now", "5m ago", "2h ago". */
const ago = (ts: number, now: number) => {
  const t = timeAgo(ts, now);
  return t === 'now' ? 'now' : /\d[mhdw]$/.test(t) ? `${t} ago` : `on ${t}`;
};

export function Phone() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const awake = useStore((s) => s.settings.phoneAwake !== false);
  // Web access is in this run (WEB_SHIPS, or the owner's --web: the bridge's hello says so).
  const web = useStore((s) => s.webAccess);
  const now = useNow();

  useEffect(() => {
    let live = true;
    void bridge.call('phone.status', {}).then((s) => live && setStatus(s), () => {});
    const off = bridge.on((e) => {
      if (e.type === 'phone.updated') setStatus(e.status);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const run = async (fn: () => Promise<PhoneStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch {
      /* the next phone.updated tells */
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="set-stack" />;
  const on = status.enabled;
  const pairing = status.pairing && status.pairing.expiresAt > now ? status.pairing : undefined;
  const mins = pairing ? Math.min(10, Math.max(1, Math.round((pairing.expiresAt - Date.now()) / 60_000))) : 0;

  return (
    <div className="set-stack">
      <Card>
        <Row label="Phone access" help={on ? (status.listening ? `On this network at ${status.hosts[0] ?? status.name}:${status.port}` : (status.error ?? 'Starting')) : 'Paired phones connect over your home network'}>
          <Switch label="Phone access" checked={on} disabled={busy} onChange={(v) => void run(() => bridge.call('phone.setEnabled', { on: v }))} />
        </Row>
        {/* A sleeping computer cannot answer the phone (server/core/awake.ts); never on battery. */}
        {on && (
          <Row label="Stay awake for the phone" help="While plugged in, with a phone paired">
            <Switch label="Stay awake for the phone" checked={awake} onChange={(phoneAwake) => setSettings({ phoneAwake })} />
          </Row>
        )}
      </Card>

      {status.request && (
        <section className="phone-ask card" data-spot role="alertdialog" aria-labelledby="phone-ask-title">
          <span className="phone-ask-icon">
            <Icon name="phone" size={18} />
          </span>
          <div className="phone-ask-text">
            <div id="phone-ask-title" className="phone-ask-title">
              Allow {status.request.name}?
            </div>
            <div className="phone-ask-sub num">{status.request.address}</div>
          </div>
          <div className="phone-ask-actions">
            <button type="button" className="btn" onClick={() => void run(() => bridge.call('phone.approve', { requestId: status.request!.id, allow: false }))}>
              Deny
            </button>
            <button type="button" className="btn btn-primary" ref={quietFocus} onClick={() => void run(() => bridge.call('phone.approve', { requestId: status.request!.id, allow: true }))}>
              Allow
            </button>
          </div>
        </section>
      )}

      {on && status.listening && (
        <Card title="Pair a phone">
          {pairing ? (
            <div className="phone-pair">
              <div className="phone-qr" aria-label="Pairing code">
                <svg viewBox={`-3 -3 ${pairing.size + 6} ${pairing.size + 6}`} shapeRendering="crispEdges" role="img" aria-label="QR code for the Sable app">
                  <rect x={-3} y={-3} width={pairing.size + 6} height={pairing.size + 6} fill="#f2f1ee" />
                  <path d={pairing.qr} fill="#0a0a0b" />
                </svg>
              </div>
              <div className="phone-pair-side">
                <ol className="phone-steps">
                  <li>Open Sable on the phone</li>
                  <li>Scan this code, or paste the link</li>
                  <li>Allow the phone here</li>
                </ol>
                <div className="phone-link">
                  <code className="phone-link-text">{pairing.link}</code>
                  <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(pairing.link)}>
                    Copy link
                  </button>
                </div>
                <div className="phone-pair-foot">
                  <span className="num">Works once, for {mins} min</span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => void run(() => bridge.call('phone.pair', { cancel: true }))}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <Row label="New phone">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(() => bridge.call('phone.pair', {}))}>
                Show pairing code
              </button>
            </Row>
          )}
        </Card>
      )}

      {status.saveError && (
        <div className="phone-save-error card" role="alert">
          {status.saveError}
        </div>
      )}

      {status.devices.length > 0 && (
        <Card title="Phones">
          {status.devices.map((d) => (
            <Row
              key={d.id}
              label={
                <span className="phone-dev">
                  <Icon name="phone" size={15} />
                  {d.name}
                </span>
              }
              help={
                <>
                  {d.online ? 'Connected' : d.lastSeen ? `Last seen ${ago(d.lastSeen, now)}` : `Paired ${ago(d.pairedAt, now)}`}
                  {/* Paired before the secure channel: it works, plain, until it pairs again. */}
                  {!d.secure && <span className="phone-dev-plain"> · Pair again for a secure connection</span>}
                </>
              }
            >
              <button type="button" className="btn btn-sm" onClick={() => void run(() => bridge.call('phone.revoke', { deviceId: d.id }))}>
                Remove
              </button>
            </Row>
          ))}
        </Card>
      )}

      {/* Sable in a browser on a tablet (switched off until it ships, WEB_SHIPS; on for one run with --web). */}
      {web && <WebAccess />}
    </div>
  );
}
