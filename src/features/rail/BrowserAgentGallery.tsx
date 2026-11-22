import { useEffect, useRef } from 'react';
import type { SignInInfo } from '@shared/protocol';
import { createPointer, POINTER, type AgentPointer } from './agent-pointer';
import { AgentLineView, SignInCardView } from './BrowserAgentUi';
import type { SignInAsk } from './sign-in';
import './browser.css';

/** The gallery's states of the agent on a page: its line, its pointer, the sign-in card (`?gallery#browser-agent`). */

const saved = (n: number): SignInInfo[] => ['student.one', 'teacher.two', 'parent.three'].slice(0, n).map((u, i) => ({ id: `0000000${i}`, origin: 'https://portal.example.test', username: u, createdAt: 0 }));
const ask = (p: Partial<SignInAsk>): SignInAsk => ({ tabId: 'gallery', origin: 'https://portal.example.test', address: 'https://portal.example.test/login', action: 'https://portal.example.test/session', saved: [], canSave: true, answer: () => {}, ...p });

function Frame({ label, children, h = 220 }: { label: string; children: React.ReactNode; h?: number }) {
  return (
    <figure style={{ margin: 0, display: 'grid', gap: 8 }}>
      <figcaption className="muted" style={{ fontSize: 'var(--t-small)' }}>
        {label}
      </figcaption>
      <div className="bw-view" style={{ position: 'relative', height: h, width: 380, background: 'var(--fill-1)', borderRadius: 'var(--r-md)' }}>
        {children}
      </div>
    </figure>
  );
}

/** A still pointer: at rest, or caught mid-press with its ring on the way out. */
function StillPointer({ press }: { press?: boolean }) {
  return (
    <div className="bw-pointer-layer">
      <div className="bw-pointer" data-on="" style={{ transform: 'translate3d(170px, 90px, 0)' }}>
        <span className="bw-pointer-ring" style={press ? { opacity: POINTER.ringOpacity * 0.6, transform: 'scale(1.1)' } : undefined} />
        <svg className="bw-pointer-mark" width="20" height="22" viewBox="0 0 20 22" style={press ? { transform: `scale(${POINTER.pressScale})` } : undefined}>
          <path className="bw-pointer-drop" d="M2.5 3.2 L2.5 18.2 L6.4 14.6 L9 20.4 L12 19.1 L9.5 13.4 L14.9 13.2 Z" />
          <path className="bw-pointer-face" d="M1.5 1.5 L1.5 16.5 L5.4 12.9 L8 18.7 L11 17.4 L8.5 11.7 L13.9 11.5 Z" />
        </svg>
      </div>
    </div>
  );
}

/** The live pointer, travelling between three targets and pressing on each, again and again while shown. */
function LivePointer() {
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const p: AgentPointer = createPointer(el);
    let on = true;
    const spots = [
      { x: 60, y: 50 },
      { x: 320, y: 90 },
      { x: 150, y: 180 },
    ];
    void (async () => {
      for (let i = 0; on; i++) {
        await p.moveTo(spots[i % spots.length]);
        await p.press();
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    return () => {
      on = false;
      p.dispose();
    };
  }, []);
  return <div className="bw-pointer-layer" ref={layer} />;
}

export function BrowserAgentStates() {
  return (
    <div style={{ display: 'grid', gap: 22 }}>
      <div style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
        <AgentLineView line={{ kind: 'driving' }} provider="claude" />
        <AgentLineView line={{ kind: 'driving' }} provider="codex" />
        <AgentLineView line={{ kind: 'driving', yielding: true }} provider="claude" />
        <AgentLineView line={{ kind: 'review', user: 'student.one' }} provider="claude" />
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'start' }}>
        <Frame label="Pointer at rest">
          <StillPointer />
        </Frame>
        <Frame label="Pointer pressing">
          <StillPointer press />
        </Frame>
        <Frame label="Pointer live">
          <LivePointer />
        </Frame>
      </div>
      <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'start' }}>
        <Frame label="First time" h={300}>
          <SignInCardView ask={ask({})} />
        </Frame>
        <Frame label="Not saved on this computer" h={300}>
          <SignInCardView ask={ask({ canSave: false, origin: 'http://127.0.0.1:4100', address: 'http://127.0.0.1:4100/', action: 'http://127.0.0.1:4100/session' })} />
        </Frame>
        <Frame label="One saved" h={300}>
          <SignInCardView ask={ask({ saved: saved(1) })} />
        </Frame>
        <Frame label="Several saved" h={340}>
          <SignInCardView ask={ask({ saved: saved(3) })} />
        </Frame>
        <Frame label="A long host" h={300}>
          <SignInCardView ask={ask({ origin: 'https://login.lernplattform.schulen.bundesland.example.test:8443' })} />
        </Frame>
      </div>
    </div>
  );
}
