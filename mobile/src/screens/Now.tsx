import { useState } from 'react';
import type { SessionMeta } from '@shared/protocol';
import { conn } from '@m/lib/conn';
import { canStop, worksNow } from '@m/lib/chat-rules';
import { clockOf, liveWords, useSecond } from '@m/lib/live-words';
import { haptic } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { veilFirst } from '@m/ui/screen-veil';
import { getState, setState, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark, StatusMark, Tiles } from '@m/ui/marks';

const toast = (text: string, level: 'info' | 'success' | 'error' = 'info') => setState({ toast: { text, level, at: Date.now() } });

/** The chats at work and those waiting on the person, as a string of ids (the waiting first, then the oldest turn first). */
function nowKey(sessions: Record<string, SessionMeta>): string {
  const out: SessionMeta[] = [];
  for (const s of Object.values(sessions)) if (!s.archived && (worksNow(s) || s.status === 'awaiting')) out.push(s);
  return out
    .sort((a, b) => (a.status === 'awaiting' ? 0 : 1) - (b.status === 'awaiting' ? 0 : 1) || a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
    .map((s) => s.id)
    .join(',');
}

/**
 * Now (2.21): everything at work across chats on one screen, for a glance from the sofa. Each chat is
 * one card: its agent and name, what it does now and since when, its steps and checkpoints (the bars),
 * its last line (the step it is on, as the desktop's live line names it), and Stop, which asks once.
 * A chat waiting on the person leads, amber. A tap on a card opens the chat. Nothing here loops but
 * the working marks; the clocks tick once a second while the screen is in view.
 */
export function NowScreen() {
  const key = useStore((st) => nowKey(st.sessions));
  const ids = key ? key.split(',') : [];
  const now = useSecond(ids.length > 0);
  const connState = useStore((s) => s.conn);
  const desktop = useStore((s) => s.desktop);
  return (
    <div className="screen now">
      <header className="sub-head">
        <button type="button" className="icon-btn back-btn" aria-label="Back" onClick={() => (haptic('tap'), veilFirst(() => nav.pop()))}>
          <Icon name="back" size={22} />
        </button>
        <span className="sub-head-title">Now</span>
        <span className="icon-btn-spacer" />
      </header>
      <div className="now-scroll">
        {ids.length === 0 ? (
          <p className="lm-empty">{connState === 'open' ? 'Nothing is running.' : `What runs shows when ${desktop ?? 'the computer'} is back.`}</p>
        ) : (
          <ul className="now-list">
            {ids.map((id) => (
              <NowCard key={id} id={id} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NowCard({ id, now }: { id: string; now: number }) {
  const s = useStore((st) => st.sessions[id]);
  const online = useStore((st) => st.conn === 'open');
  const [ask, setAsk] = useState(false);
  const [first] = useState(now);
  if (!s) return null;
  const waiting = s.status === 'awaiting';
  const w = liveWords(s);
  const own = s.status === 'running' || s.status === 'starting';
  const stop = () => {
    if (!ask) {
      haptic('tap');
      setAsk(true);
      window.setTimeout(() => setAsk(false), 3000);
      return;
    }
    haptic('warning');
    setAsk(false);
    void conn.call('session.interrupt', { sessionId: id }).catch((err: Error) => toast(err.message, 'error'));
  };
  return (
    <li className="now-card" data-waiting={waiting || undefined}>
      <button type="button" className="now-open" onClick={() => (haptic('tap'), veilFirst(() => nav.chat(id)))} aria-label={`${s.title}, ${PROVIDER_NAME[s.provider]}. ${waiting ? 'Waiting for you' : w.line}`}>
        <span className="now-head">
          <ProviderMark provider={s.provider} size={14} />
          <span className="now-title">{s.title}</span>
          {/* Its turn's clock; with the turn over, the tracked job's own (lib/live-words.ts: only where the bridge says when it began). */}
          {!waiting && (own || w.since) && <span className="now-time num">{clockOf(now - (w.since ?? first))}</span>}
        </span>
        <span className="now-line">
          <span className="now-mark">{waiting ? <StatusMark tone="awaiting" size={12} /> : <Tiles size={14} />}</span>
          <span className="now-words">{waiting ? 'Waiting for you' : w.line}</span>
          {!waiting && w.steps > 0 && <span className="now-steps num">{w.steps} {w.steps === 1 ? 'step' : 'steps'}</span>}
        </span>
        {!waiting && own && s.activity && <span className="now-last">{s.activity}</span>}
        {!waiting && w.steps > 0 && (
          <span className="now-cps" aria-hidden>
            {Array.from({ length: Math.min(w.done, 11) }, (_, i) => (
              <i key={i} />
            ))}
            <i className="cp-open" style={{ width: `${Math.min(28, 8 + w.open * 3)}px` }} />
          </span>
        )}
      </button>
      {canStop(s.status) && (
        <button type="button" className="now-stop" data-ask={ask || undefined} disabled={!online} onClick={stop} aria-label={ask ? 'Stop now' : 'Stop'}>
          <span className="stop-square sm" aria-hidden />
          <span>{ask ? 'Stop now' : 'Stop'}</span>
        </button>
      )}
    </li>
  );
}

/** Whether anything is at work or waiting (the home bar's key to this screen). */
export const anyNow = () => nowKey(getState().sessions) !== '';
