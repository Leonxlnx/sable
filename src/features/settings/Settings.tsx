import { startTransition, useDeferredValue, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Icon } from '@/icons';
import { useStore, type SettingsSection } from '@/state/store';
import { IconButton, Modal, useSlidePill } from '@/ui';
import { About } from './About';
import { Accounts } from './Accounts';
import { Agents } from './Agents';
import { Appearance } from './Appearance';
import { General } from './General';
import { Hooks } from './Hooks';
import { Mcp } from './Mcp';
import { Memory } from './Memory';
import { Models } from './Models';
import { Permissions } from './Permissions';
import { Phone } from './Phone';
import { Profile } from './Profile';
import { SavedPrompts } from './SavedPrompts';
import { matchSections, SECTIONS } from './sections';
import { Shortcuts } from './Shortcuts';
import { Skills } from './Skills';
import { Usage } from '@/features/usage/Usage';
import { Customize } from '@/features/customize/Customize';
import { takeComposerFocus } from './UseList';
import './settings.css';

const VIEWS: Record<SettingsSection, ComponentType> = {
  general: General,
  appearance: Appearance,
  accounts: Accounts,
  usage: Usage,
  models: Models,
  permissions: Permissions,
  phone: Phone,
  customize: Customize,
  mcp: Mcp,
  hooks: Hooks,
  skills: Skills,
  agents: Agents,
  memory: Memory,
  profile: Profile,
  prompts: SavedPrompts,
  shortcuts: Shortcuts,
  about: About,
};

/** The settings dialog: a nav column on the left, one section on the right. */
export function Settings() {
  const section = useStore((s) => s.ui.settings);
  const setUi = useStore((s) => s.setUi);
  // Keep showing the last section while the dialog animates out.
  const last = useRef<SettingsSection>('general');
  if (section) last.current = section;
  const current = section ?? last.current;
  // The dialog and its nav draw in the first frame; the section's content mounts in the next task,
  // under the dialog's own entrance, so opening Settings is never one long task.
  const body = useAfterOpen(!!section);
  // A section switch renders the nav (its pill starts to slide) first and the new section after,
  // in a background render that yields to the frame instead of one long task.
  const shown = useDeferredValue(current);
  // The first section comes in with the dialog (a rise and a fade under the dialog's own); a
  // section changed to afterwards replaces the last one in place and only settles (settings.css):
  // fading it in from nothing would blank the pane for a frame between two pages.
  const first = useRef<SettingsSection | null>(null);
  const swap = useRef(false);
  if (!section) {
    first.current = null;
    swap.current = false;
  } else if (body) {
    if (first.current === null) first.current = shown;
    else if (first.current !== shown) swap.current = true;
  }

  return (
    <Modal open={!!section} onOpenChange={(open) => !open && setUi({ settings: null })} title="Settings" className="settings-dialog" bare onCloseAutoFocus={takeComposerFocus}>
      <Nav current={current} open={!!section} />
      <div className="set-main">
        <IconButton icon="x" label="Close" keys="esc" className="set-close" tipSide="left" onClick={() => setUi({ settings: null })} />
        {body && <Section key={shown} id={shown} swap={swap.current} />}
      </div>
    </Modal>
  );
}

/** True one frame after `open` turns true; false again once the dialog has finished closing. */
function useAfterOpen(open: boolean) {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    let t = 0;
    let r = 0;
    // Closing: the content stays while the dialog animates out.
    if (!open) t = window.setTimeout(() => setAfter(false), 240);
    else r = requestAnimationFrame(() => (t = window.setTimeout(() => startTransition(() => setAfter(true)))));
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [open]);
  return after;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

function Nav({ current, open }: { current: SettingsSection; open: boolean }) {
  const setUi = useStore((s) => s.setUi);
  const refs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const filterRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const shown = matchSections(query);
  // The selection pill slides between rows without layout projection (nothing measured on mount).
  const pill = useSlidePill(current, 8);

  // A fresh filter every time the dialog opens.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // When the section changes from elsewhere (palette, a link) while focus sits in the nav, keep focus on the active row.
  useEffect(() => {
    const el = refs.current[current];
    if (el && document.activeElement !== el && document.activeElement?.closest('.set-nav-list')) el.focus();
  }, [current]);

  const go = (id: SettingsSection, focus = false) => {
    setUi({ settings: id });
    if (focus) refs.current[id]?.focus();
  };

  const onFilter = (value: string) => {
    setQuery(value);
    const best = value.trim() ? matchSections(value)[0] : undefined;
    if (best) setUi({ settings: best.id });
  };

  const intoPanel = () => {
    const body = document.querySelector<HTMLElement>('#set-panel .set-body');
    (body?.querySelector<HTMLElement>(FOCUSABLE) ?? body)?.focus();
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const target = shown.find((s) => s.id === current) ?? shown[0];
      if (target) go(target.id, true);
    } else if (e.key === 'Enter' && shown[0]) {
      e.preventDefault();
      if (!shown.some((s) => s.id === current)) go(shown[0].id);
      // Let the new section mount before moving focus into it.
      window.setTimeout(intoPanel, 260);
    }
  };

  const onListKey = (e: KeyboardEvent) => {
    const i = shown.findIndex((s) => s.id === current);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % shown.length;
    else if (e.key === 'ArrowUp') {
      if (i <= 0) {
        e.preventDefault();
        filterRef.current?.focus();
        return;
      }
      next = i - 1;
    } else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = shown.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type to filter: the keystroke lands in the filter field.
      e.preventDefault();
      filterRef.current?.focus();
      onFilter(query + e.key);
      return;
    }
    if (next < 0 || !shown.length) return;
    e.preventDefault();
    go(shown[next].id, true);
  };

  return (
    <nav className="set-nav" aria-label="Settings sections">
      <div className="set-nav-title">Settings</div>
      <div className="set-nav-filter">
        <Icon name="search" size={14} />
        <input
          ref={filterRef}
          className="field"
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search settings"
          spellCheck={false}
          autoComplete="off"
          data-escape-scope={query ? '' : undefined}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={onFilterKey}
        />
      </div>
      <div className="set-nav-list" role="tablist" aria-orientation="vertical" onKeyDown={onListKey}>
        {shown.map((s) => {
          const active = s.id === current;
          return (
            <button
              key={s.id}
              ref={(el) => {
                refs.current[s.id] = el;
              }}
              type="button"
              role="tab"
              id={`set-tab-${s.id}`}
              aria-selected={active}
              aria-controls="set-panel"
              tabIndex={active || (!shown.some((x) => x.id === current) && s === shown[0]) ? 0 : -1}
              data-active={active || undefined}
              data-gap={(s.gap && !query) || undefined}
              className="set-nav-row"
              onClick={() => go(s.id)}
            >
              {active && <span ref={pill} className="set-nav-pill dither-sel" />}
              <Icon name={s.icon} size={16} className="set-nav-icon" />
              <span className="truncate">{s.label}</span>
            </button>
          );
        })}
        {!shown.length && <p className="set-nav-empty">No setting matches “{query.trim()}”.</p>}
      </div>
    </nav>
  );
}

function Section({ id, swap }: { id: SettingsSection; swap: boolean }) {
  const meta = SECTIONS.find((s) => s.id === id)!;
  const View = VIEWS[id];
  // A plain element with a CSS entrance (settings.css): a motion element here would make motion
  // measure the page's layout every time a section mounts.
  return (
    <div className="set-section" data-swap={swap || undefined} id="set-panel" role="tabpanel" aria-labelledby={`set-tab-${id}`}>
      <header className="set-head">
        <h2 className="set-title">{meta.label}</h2>
      </header>
      <div className="set-body scroll" tabIndex={-1}>
        <div className="set-col">
          <View />
        </div>
      </div>
    </div>
  );
}
