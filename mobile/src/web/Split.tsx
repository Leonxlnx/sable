import { useEffect, useRef, useState, type ReactNode } from 'react';
import { chatOf, type Route } from '@m/lib/nav';
import { useStore } from '@m/lib/store';
import { Field, paletteFor } from '@m/ui/Field';
import { Icon } from '@m/ui/icons';
import { Side } from './Side';
import './split.css';

/**
 * Sable in a browser at tablet width (820 px and wider; web/allow.ts `useSplit`): the desktop's window at
 * hand. Left the list of chats on the window's body (web/Side.tsx), right the stage, a sheet cut into the
 * body, which holds the open chat (the phone's conversation, its composer docked at its foot, laid out in
 * the desktop's column by split.css) and over it a chat's changes and a diff. The list folds away with its
 * button or Cmd/Ctrl+B (remembered for the page's life); Cmd/Ctrl+K opens search; Escape closes a screen
 * over the chat. Narrower than 820 px the phone's own flow stays (App.tsx).
 */
export function Split({ stack, children }: { stack: Route[]; children: ReactNode }) {
  const [folded, setFolded] = useState(() => sessionFold);
  const search = useRef<HTMLInputElement>(null);
  const selected = chatOf(stack.find((r) => r.name === 'chat'));
  const provider = useStore((s) => (selected ? s.sessions[selected]?.provider : s.settings?.defaultProvider));
  const fold = (v: boolean) => {
    sessionFold = v;
    setFolded(v);
  };

  // The root says it, for what floats over the whole page (a sheet stands over the stage, not the list).
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-split', '');
    return () => root.removeAttribute('data-split');
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (folded) root.setAttribute('data-folded', '');
    else root.removeAttribute('data-folded');
    return () => root.removeAttribute('data-folded');
  }, [folded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        fold(false);
        // The list is laid out again unfolded first.
        requestAnimationFrame(() => {
          search.current?.focus();
          search.current?.select();
        });
      } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        fold(!sessionFold);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="wsplit" data-folded={folded || undefined}>
      <div className="wside-slot" aria-hidden={folded || undefined} inert={folded || undefined}>
        <Side selected={selected} searchRef={search} />
      </div>
      <main className="wstage">
        <div className="wstage-body">
          {stack.length === 0 && (
            <div className="screen wempty">
              <Field palette={paletteFor(provider)} amount={0.32} focusX={0.6} focusY={1.08} spread={0.55} />
              <p className="wempty-text">Choose a chat.</p>
            </div>
          )}
          {children}
        </div>
        {/* Where the desktop's stands: the start of the stage's top bar, in both states. */}
        <button type="button" className="wicon wtoggle" aria-label={folded ? 'Show sidebar' : 'Hide sidebar'} title={folded ? 'Show sidebar' : 'Hide sidebar'} aria-expanded={!folded} onClick={() => fold(!folded)}>
          <Icon name="sidebar" size={17} />
        </button>
        <i className="wcorner" data-at="tl" aria-hidden />
        <i className="wcorner" data-at="tr" aria-hidden />
        <i className="wcorner" data-at="bl" aria-hidden />
        <i className="wcorner" data-at="br" aria-hidden />
      </main>
    </div>
  );
}

/** Whether the list is folded, for the page's life (a reload starts with it open, as the desktop does on a new window). */
let sessionFold = false;
