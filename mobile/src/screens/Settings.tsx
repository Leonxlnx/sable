import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { baseName } from '@desk/lib/format';
import { conn } from '@m/lib/conn';
import { appVersion, askNotifications, haptic, hapticsEnabled, isNative, loadPref, notificationsAllowed, savePref, setHaptics } from '@m/lib/native';
import { homeFolder } from '@m/lib/race';
import { nav } from '@m/lib/nav';
import { setState, useStore } from '@m/lib/store';
import { AutoHeight } from '@m/ui/AutoHeight';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { LogoMark, ProviderMark, Ring } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { Sheet } from '@m/ui/Sheet';
import { LimitsSheet } from './Limits';

export const prefs = { notify: true };
void loadPref('notify', true).then((v) => (prefs.notify = v));

/** A Tailscale address (100.64.0.0/10): reached over the tailnet, from anywhere. */
const tailnet = (ip?: string) => !!ip && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

/**
 * The paired computer (how it is reached, and what to do when it is not), what this phone does
 * on its own (notifications, haptics), the chats' limits and archive, and forgetting the computer.
 */
export function Settings() {
  const desktop = useStore((s) => s.desktop);
  const state = useStore((s) => s.conn);
  const version = useStore((s) => s.version);
  const defaultProvider = useStore((s) => s.settings?.defaultProvider);
  const archivedCount = useStore((s) => Object.values(s.sessions).filter((x) => x.archived).length);
  const [notify, setNotify] = useState(prefs.notify);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [haptics, setHapticsOn] = useState(hapticsEnabled);
  const [mine, setMine] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [limits, setLimits] = useState(false);
  const [archive, setArchive] = useState(false);
  const p = conn.pairing;
  const name = desktop ?? p?.desktop ?? 'Desktop';

  useEffect(() => {
    void notificationsAllowed().then(setAllowed);
    void appVersion().then(setMine);
  }, []);

  const toggleNotify = async () => {
    haptic('select');
    const next = !notify;
    if (next && !allowed) {
      const ok = await askNotifications();
      setAllowed(ok);
      if (!ok) {
        setState({ toast: { text: 'Notifications are off for Sable in Android settings', level: 'info', at: Date.now() } });
        return;
      }
    }
    setNotify(next);
    prefs.notify = next;
    savePref('notify', next);
  };

  const toggleHaptics = () => {
    const next = !haptics;
    setHaptics(next);
    setHapticsOn(next);
    haptic('select');
  };

  return (
    <div className="screen settings">
      <header className="sub-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), nav.pop())}>
          <Icon name="back" size={22} />
        </button>
        <span className="sub-head-title">Settings</span>
        <span className="icon-btn-spacer" />
      </header>
      <div className="settings-scroll">
        <h1 className="page-title">Settings</h1>

        <Computer name={name} state={state} palette={paletteFor(defaultProvider)} />

        {/* Paired before the secure channel: it still works, plain; pairing again makes it secure (and installs possible). */}
        {p && !conn.pairedSecurely && (
          <div className="group-card set-secure">
            <button type="button" className="set-row" onClick={() => (haptic('tap'), setState({ repairing: true }))}>
              <Icon name="shield" size={20} />
              <span className="set-label">Pair again for a secure connection</span>
              <Icon name="next" size={16} className="set-chev" />
            </button>
          </div>
        )}

        {isNative && (
          <>
            <h3 className="set-title">This phone</h3>
            <div className="group-card">
              <button type="button" className="set-row switch-row" role="switch" aria-checked={notify && !!allowed} onClick={() => void toggleNotify()}>
                <Icon name="bell" size={20} />
                <span className="set-label">Notifications</span>
                <span className="switch" data-on={(notify && !!allowed) || undefined}>
                  <i />
                </span>
              </button>
              <button type="button" className="set-row switch-row" role="switch" aria-checked={haptics} onClick={toggleHaptics}>
                <Icon name="vibrate" size={20} />
                <span className="set-label">Haptics</span>
                <span className="switch" data-on={haptics || undefined}>
                  <i />
                </span>
              </button>
            </div>
          </>
        )}

        <h3 className="set-title">Chats</h3>
        <div className="group-card">
          <button type="button" className="set-row" onClick={() => (haptic('tap'), setLimits(true))}>
            <Icon name="gauge" size={20} />
            <span className="set-label">Limits</span>
            <Icon name="next" size={16} className="set-chev" />
          </button>
          <button type="button" className="set-row" onClick={() => (haptic('tap'), setArchive(true))}>
            <Icon name="archive" size={20} />
            <span className="set-label">Archived</span>
            {archivedCount > 0 && <span className="set-val num">{archivedCount}</span>}
            <Icon name="next" size={16} className="set-chev" />
          </button>
        </div>

        <h3 className="set-title">About</h3>
        <div className="group-card">
          <div className="set-row">
            <LogoMark size={17} className="set-logo" />
            <span className="set-label">Sable on {name}</span>
            <span className="set-val num">{version ?? <span className="skel set-skel" />}</span>
          </div>
          {mine && (
            <div className="set-row">
              <Icon name="phone" size={20} />
              <span className="set-label">This app</span>
              <span className="set-val num">{mine}</span>
            </div>
          )}
        </div>

        <div className="group-card set-danger">
          <button type="button" className="set-row" onClick={() => (haptic('tap'), setConfirm(true))}>
            <Icon name="unlink" size={20} />
            <span className="set-label">Forget this computer</span>
          </button>
        </div>
      </div>

      <Sheet open={confirm} onClose={() => setConfirm(false)} label="Forget this computer">
        <div className="confirm">
          <h2 className="confirm-title">Forget {name}?</h2>
          <p className="confirm-sub">To use it from this phone again, scan its code in Settings › Phone.</p>
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            onClick={() => {
              haptic('warning');
              setConfirm(false);
              // The token gone from the phone first; when it cannot be, it says so and nothing is forgotten.
              void conn.forget().then(() => nav.reset()).catch((err: Error) => setState({ toast: { text: err.message, level: 'error', at: Date.now() } }));
            }}
          >
            Forget
          </button>
          <button type="button" className="btn btn-lg btn-block btn-ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Sheet>
      <LimitsSheet open={limits} onClose={() => setLimits(false)} />
      <ArchiveSheet open={archive} onClose={() => setArchive(false)} />
    </div>
  );
}

/**
 * The paired computer: a window onto its field, its name, and one line under it that says how it
 * is reached, or what to do when it is not (try again, pair again). The card keeps its height in
 * every state; only that line and the state pill change, crossfading in place.
 */
function Computer({ name, state, palette }: { name: string; state: string; palette: ReturnType<typeof paletteFor> }) {
  const listed = useStore((s) => !!s.fresh);
  const error = useStore((s) => s.connError);
  const p = conn.pairing;
  const host = p?.lastHost ?? p?.hosts[0];
  const word = state === 'open' ? 'Connected' : state === 'connecting' ? (listed ? 'Reconnecting' : 'Connecting') : state === 'denied' ? 'Not allowed' : 'Offline';
  const lineKey = state === 'offline' ? 'offline' : state === 'denied' ? 'denied' : 'addr';
  return (
    <section className="computer" data-state={state}>
      <Field palette={palette} amount={1} focusX={0.78} focusY={1.25} spread={0.9} active={state === 'connecting'} className="computer-field" />
      <div className="computer-top">
        <span className="computer-glyph">
          <Icon name="desktop" size={22} />
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={word} className="computer-state" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={SNAP}>
            {state === 'connecting' ? <Ring size={11} /> : <i className="conn-dot" />}
            {word}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="computer-name">{name}</div>
      <div className="computer-line">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={lineKey} className="computer-line-in" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={SNAP}>
            {lineKey === 'addr' ? (
              <span className="computer-addr num">
                {host ? `${host}:${p?.port}` : ''}
                {tailnet(host) && <span className="computer-via"> · Tailscale</span>}
              </span>
            ) : lineKey === 'offline' ? (
              <>
                <span className="computer-addr">Not reachable</span>
                <button type="button" className="computer-act" onClick={() => (haptic('tap'), conn.wake())}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <span className="computer-addr">{error ?? 'Removed on the desktop'}</span>
                <button type="button" className="computer-act" onClick={() => (haptic('tap'), void conn.forget().then(() => nav.reset()).catch((err: Error) => setState({ toast: { text: err.message, level: 'error', at: Date.now() } })))}>
                  Pair again
                </button>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

/** Chats archived on the desktop or here, newest first; Restore brings one back to home. */
function ArchiveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useStore((s) => s.sessions);
  const online = useStore((s) => s.conn === 'open');
  const [going, setGoing] = useState<Set<string>>(() => new Set());
  const list = useMemo(
    () =>
      Object.values(sessions)
        .filter((s) => s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const restore = (s: SessionMeta) => {
    haptic('select');
    setGoing((g) => new Set(g).add(s.id));
    void conn
      .call('session.update', { sessionId: s.id, patch: { archived: false } })
      .catch((err) => setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } }))
      .finally(() => setGoing((g) => ((g = new Set(g)), g.delete(s.id), g)));
  };
  return (
    <Sheet open={open} onClose={onClose} title="Archived">
      <AutoHeight>
        {list.length === 0 ? (
          <p className="lim-empty">No archived chats.</p>
        ) : (
          <ul className="arch">
            <AnimatePresence initial={false}>
              {list.map((s) => (
                <motion.li key={s.id} className="arch-row" initial={false} exit={{ opacity: 0, height: 0 }} transition={SNAP}>
                  <ProviderMark provider={s.provider} size={16} />
                  <span className="arch-text">
                    <span className="arch-title">{s.title || 'Untitled'}</span>
                    {!s.chat && <span className="arch-dir">{baseName(homeFolder(s))}</span>}
                  </span>
                  <button type="button" className="arch-go" disabled={!online || going.has(s.id)} onClick={() => restore(s)}>
                    Restore
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </AutoHeight>
    </Sheet>
  );
}
