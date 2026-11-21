import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/icons';
import { IconSheet } from './IconSheet';
import {
  IconButton,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSep,
  MenuTrigger,
  Modal,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Segmented,
  Slider,
  Spinner,
  Switch,
  Tip,
  TipProvider,
} from '@/ui';
import '@/app/app.css';
import '@/features/composer/composer.css';
import '@/features/sidebar/sidebar.css';
import '@/features/rail/rail.css';
import '@/features/timeline/timeline.css';
import './gallery.css';

/**
 * Dev only (`?gallery`): every primitive in every state, for screenshots and design review.
 * Never part of a production bundle (main.tsx imports it behind import.meta.env.DEV).
 *
 * States are forced, not hovered: on mount every stylesheet rule that uses :hover, :active,
 * :focus-visible or :focus-within is copied with the pseudo-class swapped for [data-f~=...], and
 * each cell in a state row marks its control with that attribute. One still shows all states.
 */

type State = 'rest' | 'hover' | 'press' | 'focus' | 'disabled';
const STATES: State[] = ['rest', 'hover', 'press', 'focus', 'disabled'];
const FORCE: Record<State, string> = { rest: '', hover: 'hover', press: 'hover active', focus: 'focus', disabled: '' };

function useForcedStates() {
  useEffect(() => {
    const build = () => {
      const out: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const r of Array.from(rules)) {
          const t = r.cssText;
          if (!/:(hover|active|focus)/.test(t)) continue;
          if (r instanceof CSSMediaRule && /hover:\s*none|prefers-reduced-motion/.test(r.conditionText)) continue;
          out.push(
            t
              .replace(/:focus-visible/g, '[data-f~=focus]')
              .replace(/:focus-within/g, ':is([data-f~=focus],:has([data-f~=focus]))')
              .replace(/:focus(?![-\w])/g, '[data-f~=focus]')
              .replace(/:hover/g, '[data-f~=hover]')
              .replace(/:active/g, '[data-f~=active]'),
          );
        }
      };
      for (const s of Array.from(document.styleSheets)) {
        if ((s.ownerNode as Element | null)?.id === 'gal-forced') continue;
        try {
          walk(s.cssRules);
        } catch {
          /* cross-origin */
        }
      }
      let el = document.getElementById('gal-forced');
      if (!el) {
        el = document.createElement('style');
        el.id = 'gal-forced';
        // First in the head: a forced copy then wins only by its attribute (as the real pseudo-class
        // would), and later rules of equal weight still override it in source order.
        document.head.prepend(el);
      }
      el.textContent = out.join('\n');
    };
    build();
    // Vite injects CSS as it loads (and again on HMR): rebuild when the head changes.
    let t = 0;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = window.setTimeout(build, 60);
    });
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
}

/** One row of the same control in each state. `render` gets the state so it can pass `disabled`. */
function States({ label, render, only }: { label: string; render: (s: State) => ReactNode; only?: State[] }) {
  return (
    <div className="gal-row">
      <div className="gal-label">{label}</div>
      {STATES.map((s) => (
        <Cell key={s} state={s} hidden={!!only && !only.includes(s)}>
          {render(s)}
        </Cell>
      ))}
    </div>
  );
}

function Cell({ state, hidden, children }: { state: State; hidden: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const first = ref.current?.firstElementChild;
    // The control itself: the cell's first child, or the first control inside a wrapper.
    const el = first?.matches('button, input, textarea, a, [role]') ? first : (first?.querySelector('button, input, textarea, a') ?? first);
    if (!(el instanceof HTMLElement)) return;
    if (FORCE[state]) el.dataset.f = FORCE[state];
  });
  return (
    <div className="gal-cell" ref={ref}>
      {hidden ? null : children}
    </div>
  );
}

function Head() {
  return (
    <div className="gal-row gal-head">
      <div className="gal-label" />
      {STATES.map((s) => (
        <div key={s} className="gal-cell">
          {s[0].toUpperCase() + s.slice(1)}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section className="gal-section" id={id}>
      <h2 className="gal-h">{title}</h2>
      {children}
    </section>
  );
}

const dis = (s: State) => s === 'disabled';

function MenuRows({ highlight }: { highlight?: number }) {
  const rows: { icon?: IconName; label: string; keys?: string; checked?: boolean; sub?: boolean; disabled?: boolean; danger?: boolean }[] = [
    { label: 'Plain row' },
    { icon: 'pencil', label: 'Rename', keys: 'f2' },
    { icon: 'copy', label: 'Copy path', keys: 'mod+shift+c' },
    { icon: 'pin', label: 'Pinned', checked: true },
    { icon: 'folder', label: 'Move to', sub: true },
    { icon: 'archive', label: 'Archive', disabled: true },
  ];
  return (
    <div className="pop gal-pop" data-static="">
      <div className="menu-label">Section</div>
      {rows.map((r, i) => (
        <div key={r.label} className="menu-item" data-highlighted={i === highlight ? '' : undefined} data-disabled={r.disabled ? '' : undefined} role="menuitem">
          {r.icon && <Icon name={r.icon} size={16} />}
          <span className="grow truncate">{r.label}</span>
          {r.keys && <Kbd combo={r.keys} />}
          {r.checked && <Icon name="check" size={14} />}
          {r.sub && <Icon name="caret-right" size={12} />}
        </div>
      ))}
      <div className="menu-sep" />
      <div className="menu-item" data-tone="danger" data-highlighted={highlight === 9 ? '' : undefined} role="menuitem">
        <Icon name="trash" size={16} />
        <span className="grow truncate">Delete</span>
      </div>
    </div>
  );
}

/** The composer's surface with its toolbar, static: the glass, the chips and the keys together. */
function GlassComposer({ focus }: { focus?: boolean }) {
  return (
    <div className="cmp-card" data-spot="">
      <div className="cmp-field">
        <textarea className="cmp-input" data-f={focus ? 'focus' : undefined} rows={2} readOnly placeholder="Describe a task or ask a question" defaultValue={focus ? 'Refactor the session module' : ''} />
      </div>
      <div className="cmp-bar">
        <div className="cmp-side">
          <button className="cmp-attach" aria-label="Attach">
            <Icon name="plus" size={14} />
          </button>
          <button className="tb-chip cm-mode">
            <Icon name="hand" size={14} />
            <span className="cm-mode-label">Ask first</span>
          </button>
        </div>
        <div className="cmp-side cmp-right">
          <button className="tb-chip cm-model">
            <span className="cm-model-name">Opus 4.5</span>
            <Icon name="caret-down" size={11} className="caret" />
          </button>
          <button className="tb-chip th-chip">
            <span className="th-pill">
              <span className="th-nm">High</span>
            </span>
          </button>
          <div className="cmp-keys">
            <button className="cmp-send" data-on="" data-ready={focus ? '' : undefined} aria-label="Send">
              <Icon name="arrow-up" size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Gallery() {
  useForcedStates();
  const [sw, setSw] = useState(true);
  const [sl, setSl] = useState(42);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('b');
  const [seg2, setSeg2] = useState<'list' | 'grid'>('list');
  const [modal, setModal] = useState(false);
  const [pin, setPin] = useState(true);

  useEffect(() => {
    document.documentElement.dataset.gallery = '';
    return () => void delete document.documentElement.dataset.gallery;
  }, []);

  return (
    <TipProvider>
      <div className="gal scroll">
        <header className="gal-top">
          <h1 className="h2">Controls</h1>
          <nav className="gal-nav">
            {['icons', 'buttons', 'toolbar', 'fields', 'toggles', 'menus', 'material', 'details', 'family', 'live'].map((id) => (
              <a key={id} href={`#${id}`} className="btn btn-ghost btn-sm">
                {id[0].toUpperCase() + id.slice(1)}
              </a>
            ))}
          </nav>
        </header>

        <Section title="Animated icons" id="icons">
          <IconSheet />
        </Section>

        <Section title="Buttons" id="buttons">
          <Head />
          <States label="Default" render={(s) => <button className="btn" disabled={dis(s)}>Continue</button>} />
          <States label="Primary" render={(s) => <button className="btn btn-primary" disabled={dis(s)}>Sign in</button>} />
          <States label="Ghost" render={(s) => <button className="btn btn-ghost" disabled={dis(s)}>Cancel</button>} />
          <States label="Danger" render={(s) => <button className="btn btn-danger" disabled={dis(s)}>Delete</button>} />
          <States
            label="With icon"
            render={(s) => (
              <button className="btn" disabled={dis(s)}>
                <Icon name="plus" size={14} />
                New session
              </button>
            )}
          />
          <States
            label="With shortcut"
            render={(s) => (
              <button className="btn" disabled={dis(s)}>
                Search
                <Kbd combo="mod+k" />
              </button>
            )}
          />
          <States
            label="Primary + shortcut"
            render={(s) => (
              <button className="btn btn-primary" disabled={dis(s)}>
                Allow once
                <Kbd combo="enter" />
              </button>
            )}
          />
          <States
            label="Loading"
            render={(s) => (
              <button className="btn" data-busy="" aria-busy disabled={dis(s)}>
                <Spinner size={12} />
                Saving
              </button>
            )}
          />
          <States label="Small" render={(s) => <button className="btn btn-sm" disabled={dis(s)}>Small</button>} />
          <States label="Large" render={(s) => <button className="btn btn-lg btn-primary" disabled={dis(s)}>Get started</button>} />
          <States label="Icon button" render={(s) => <IconButton icon="settings" label="Settings" disabled={dis(s)} />} />
          <States label="Icon button, on" render={(s) => <IconButton icon="sidebar" label="Sidebar" active disabled={dis(s)} />} />
          <States label="Icon button 26" render={(s) => <IconButton icon="refresh" label="Refresh" className="icon-btn-sm" disabled={dis(s)} />} />
          <States label="Icon button 22" render={(s) => <IconButton icon="dots" label="More" size={14} className="icon-btn-xs" disabled={dis(s)} />} />
          <States
            label="Disabled, with reason"
            render={(s) => <IconButton icon="trash" label="Delete" disabled={s === 'disabled' || s === 'hover'} disabledReason="Archive it first" />}
          />
          <States
            label="Select trigger"
            render={(s) => (
              <button className="btn btn-select gal-select" disabled={dis(s)}>
                <span className="grow truncate">Sonnet 4.5</span>
                <Icon name="caret-updown" size={12} />
              </button>
            )}
          />
          <States
            label="Chip"
            render={(s) => (
              <button className="chip" disabled={dis(s)}>
                <Icon name="folder" size={14} />
                sable
                <Icon name="caret-down" size={11} className="caret" />
              </button>
            )}
          />
          <States
            label="Tab"
            render={(s) => (
              <button className="tab" data-active={s === 'rest' ? undefined : undefined} disabled={dis(s)}>
                Changes <span className="count">12</span>
              </button>
            )}
          />
          <div className="gal-row">
            <div className="gal-label">Neighbours</div>
            <div className="gal-wide row">
              <button className="btn btn-ghost">Cancel</button>
              <button className="btn">Keep both</button>
              <button className="btn btn-primary">Replace</button>
              <span className="gal-gap" />
              <IconButton icon="copy" label="Copy" />
              <IconButton icon="refresh" label="Retry" />
              <IconButton icon="dots" label="More" />
              <span className="gal-gap" />
              <button className="btn btn-sm">Small</button>
              <button className="btn btn-sm btn-primary">Commit</button>
            </div>
          </div>
        </Section>

        <Section title="Composer toolbar" id="toolbar">
          <Head />
          <States
            label="Attach"
            render={(s) => (
              <button className="cmp-attach" aria-label="Attach" disabled={dis(s)}>
                <Icon name="plus" size={14} />
              </button>
            )}
          />
          <States
            label="Mode"
            render={(s) => (
              <button className="tb-chip cm-mode" disabled={dis(s)}>
                <Icon name="hand" size={14} />
                <span className="cm-mode-label">Ask</span>
              </button>
            )}
          />
          <States
            label="Model"
            render={(s) => (
              <button className="tb-chip cm-model" disabled={dis(s)}>
                <span className="cm-model-name">Opus 4.5</span>
                <Icon name="caret-down" size={11} className="caret" />
              </button>
            )}
          />
          <States
            label="Send"
            render={(s) => (
              <button className="cmp-send" data-on="" data-ready="" aria-label="Send" disabled={dis(s)}>
                <Icon name="arrow-up" size={14} />
              </button>
            )}
          />
          <States
            label="Send, empty"
            render={() => (
              <button className="cmp-send" data-on="" aria-label="Send">
                <Icon name="arrow-up" size={14} />
              </button>
            )}
          />
          <States
            label="Stop"
            only={['rest', 'press', 'focus']}
            render={() => (
              <button className="cmp-stop" data-on="" aria-label="Stop">
                <span className="cmp-stop-sq" />
              </button>
            )}
          />
          <States
            label="Effort"
            render={(s) => (
              <button className="tb-chip th-chip" disabled={dis(s)}>
                <span className="th-pill">
                  <span className="th-nm">High</span>
                </span>
              </button>
            )}
          />
          <div className="gal-row">
            <div className="gal-label">Open (menu showing)</div>
            <div className="gal-cell gal-wide" style={{ gap: 8 }}>
              <button className="cmp-attach" aria-label="Attach" aria-expanded="true">
                <Icon name="plus" size={14} />
              </button>
              <button className="tb-chip cm-mode" aria-expanded="true">
                <Icon name="hand" size={14} />
                <span className="cm-mode-label">Ask</span>
              </button>
              <button className="tb-chip cm-model" aria-expanded="true">
                <span className="cm-model-name">Opus 4.5</span>
                <Icon name="caret-down" size={11} className="caret" />
              </button>
              <button className="tb-chip th-chip" aria-expanded="true">
                <span className="th-pill">
                  <span className="th-nm">High</span>
                </span>
              </button>
            </div>
          </div>
        </Section>

        <Section title="Fields" id="fields">
          <Head />
          <States label="Text" render={(s) => <input className="field" defaultValue="refactor the session module" disabled={dis(s)} />} />
          <States label="Placeholder" render={(s) => <input className="field" placeholder="Name this account" disabled={dis(s)} />} />
          <States
            label="Search"
            render={(s) => (
              <label className="field-wrap">
                <Icon name="search" size={14} />
                <input className="field" placeholder="Search" disabled={dis(s)} />
                <Kbd combo="mod+k" />
              </label>
            )}
          />
          <States label="Error" render={(s) => <input className="field" aria-invalid defaultValue="~/missing/folder" disabled={dis(s)} />} />
          <States label="Textarea" render={(s) => <textarea className="field" rows={2} defaultValue={'Two lines of text\nin a textarea'} disabled={dis(s)} />} />
          <div className="gal-row">
            <div className="gal-label">Label + field</div>
            <div className="gal-wide">
              <label className="label" htmlFor="g-name">
                Account name
              </label>
              <input id="g-name" className="field" style={{ maxWidth: 280 }} defaultValue="Work" />
            </div>
          </div>
        </Section>

        <Section title="Toggles" id="toggles">
          <Head />
          <States label="Switch off" render={(s) => <Switch checked={false} onChange={() => {}} label="Off" disabled={dis(s)} />} />
          <States label="Switch on" render={(s) => <Switch checked onChange={() => {}} label="On" disabled={dis(s)} />} />
          <States
            label="Segmented"
            render={(s) => (
              <Segmented
                id={`g-seg-${s}`}
                value="b"
                onChange={() => {}}
                options={[
                  { value: 'a', label: 'Low' },
                  { value: 'b', label: 'Medium' },
                  { value: 'c', label: 'High' },
                ]}
              />
            )}
            only={['rest']}
          />
          <div className="gal-row">
            <div className="gal-label">Live</div>
            <div className="gal-wide row" style={{ gap: 20 }}>
              <Switch checked={sw} onChange={setSw} label="Live switch" />
              <div style={{ width: 200 }}>
                <Slider value={sl} onChange={setSl} label="Amount" />
              </div>
              <span className="num faint">{sl}</span>
              <Segmented
                id="g-seg-live"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: 'a', label: 'Low' },
                  { value: 'b', label: 'Medium' },
                  { value: 'c', label: 'High' },
                ]}
              />
              <Segmented
                id="g-seg-icons"
                value={seg2}
                onChange={setSeg2}
                options={[
                  { value: 'list', label: 'List', icon: 'list' },
                  { value: 'grid', label: 'Grid', icon: 'grid' },
                ]}
              />
            </div>
          </div>
        </Section>

        <Section title="Menus" id="menus">
          <div className="gal-menus">
            <div>
              <div className="gal-caption">Rest</div>
              <MenuRows />
            </div>
            <div>
              <div className="gal-caption">Highlighted row</div>
              <MenuRows highlight={2} />
            </div>
            <div>
              <div className="gal-caption">Danger highlighted</div>
              <MenuRows highlight={9} />
            </div>
            <div>
              <div className="gal-caption">Tooltip</div>
              <div className="tooltip gal-static">
                New session <Kbd combo="mod+n" />
              </div>
              <div className="gal-caption" style={{ marginTop: 24 }}>
                Toasts
              </div>
              <div className="gal-toasts">
                <button className="toast" data-level="info">
                  <Icon name="info" size={16} />
                  <span>Copied to clipboard</span>
                </button>
                <button className="toast" data-level="success">
                  <Icon name="check-circle" size={16} />
                  <span>Account added</span>
                </button>
                <button className="toast" data-level="error">
                  <Icon name="error" size={16} />
                  <span>Could not reach the bridge</span>
                </button>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Material: glass and flat controls" id="material">
          <div className="gal-stage">
            <div className="gal-glass-col" style={{ flex: 1.6 }}>
              <div className="gal-caption">Composer, rest</div>
              <GlassComposer />
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Composer, focused
              </div>
              <GlassComposer focus />
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Message
              </div>
              <div className="user gal-user">
                <div className="user-card">
                  <div className="user-text">Refactor the session module so it is easier to test</div>
                </div>
              </div>
            </div>
            <div className="gal-glass-col">
              <div className="gal-caption">Menu (.pop)</div>
              <MenuRows highlight={1} />
            </div>
            <div className="gal-glass-col">
              <div className="gal-caption">Frosted (.glass)</div>
              <div className="glass gal-pane" data-spot="">
                Find in conversation
              </div>
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Small (.glass)
              </div>
              <button className="glass gal-jump" data-spot="">
                <Icon name="arrow-down" size={13} />
                Jump to latest
              </button>
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Opaque (.glass-liquid)
              </div>
              <div className="glass-liquid gal-pane" data-spot="">
                A floating layer
              </div>
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Rim only (.glass-rim)
              </div>
              <div className="glass-rim gal-pane gal-rim" data-spot="">
                A fill of its own
              </div>
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Toast
              </div>
              <button className="toast" data-level="success">
                <Icon name="check-circle" size={16} />
                <span>Account added</span>
              </button>
              <div className="gal-caption" style={{ marginTop: 18 }}>
                Tooltip
              </div>
              <div className="tooltip gal-tip">
                Search and commands
                <Kbd combo="mod+k" />
              </div>
            </div>
          </div>
          <Head />
          <States
            label="Filled control (.tactile)"
            only={['rest', 'hover', 'press', 'focus']}
            render={() => (
              <button className="chip tactile gal-tactile">
                <Icon name="hand" size={14} />
                Ask first
              </button>
            )}
          />
          <div className="gal-row">
            <div className="gal-label">Filled control, on</div>
            <div className="gal-cell">
              <button className="chip tactile gal-tactile" aria-pressed="true">
                <Icon name="hand" size={14} />
                Ask first
              </button>
            </div>
          </div>
          <States
            label="Ivory key"
            only={['rest', 'hover', 'press', 'focus']}
            render={() => (
              <button className="cmp-send" data-on="" data-ready="" aria-label="Send">
                <Icon name="arrow-up" size={14} />
              </button>
            )}
          />
          <div className="gal-row">
            <div className="gal-label">Selected pill</div>
            <div className="gal-cell gal-wide">
              <div className="gal-list" style={{ width: 260 }}>
                <div className="gal-lrow">
                  <span className="gal-pill dither-sel" />
                  <Icon name="chat" size={15} />
                  <span className="truncate">Selected row</span>
                </div>
                <div className="gal-lrow">
                  <Icon name="chat" size={15} />
                  <span className="truncate">Plain row</span>
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Details" id="details">
          <div className="gal-grid">
            <div className="gal-tile">
              <div className="gal-caption">Kbd on a text line</div>
              <p>
                Press <Kbd combo="mod+k" /> to search, <Kbd combo="esc" /> to close, <Kbd combo="shift+enter" /> for a new line.
              </p>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Badge, count, dot</div>
              <div className="row">
                <span className="badge">Default</span>
                <span className="badge num">12</span>
                <span className="tab-count-demo num faint">3</span>
                <span className="dot" style={{ color: 'var(--amber)' }} />
                <span className="dot" style={{ color: 'var(--red)' }} />
              </div>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Meter</div>
              <div className="col" style={{ gap: 10 }}>
                <span className="meter">
                  <span className="meter-fill" style={{ ['--p' as string]: 0.36 }} />
                </span>
                <span className="meter" data-level="amber">
                  <span className="meter-fill" style={{ ['--p' as string]: 0.82 }} />
                </span>
                <span className="meter" data-level="red">
                  <span className="meter-fill" style={{ ['--p' as string]: 0.97 }} />
                </span>
              </div>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Skeleton</div>
              <div className="col" style={{ gap: 8 }}>
                <span className="skel" style={{ height: 10, width: '80%' }} />
                <span className="skel" style={{ height: 10, width: '55%' }} />
              </div>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">List rows</div>
              <div className="gal-list">
                <div className="gal-lrow">
                  <span className="gal-pill dither-sel" />
                  <Icon name="chat" size={15} />
                  <span className="truncate">Selected row with a dither pill</span>
                </div>
                <div className="gal-lrow" data-f="hover">
                  <Icon name="chat" size={15} />
                  <span className="truncate">Hovered row</span>
                </div>
                <div className="gal-lrow">
                  <Icon name="chat" size={15} />
                  <span className="truncate">A row whose title is far too long to fit in this column</span>
                </div>
              </div>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Scrollbar</div>
              <div className="scroll gal-scroll" data-f="hover">
                {Array.from({ length: 14 }, (_, i) => (
                  <div key={i} className="faint">
                    Line {i + 1} of a scrolling list
                  </div>
                ))}
              </div>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Text selection</div>
              <p className="gal-select-text">The selected words show the selection colour on ink.</p>
            </div>
            <div className="gal-tile">
              <div className="gal-caption">Spinner, path</div>
              <div className="row">
                <Spinner />
                <span className="path">
                  <span className="path-dir">~/code/</span>
                  <span className="path-name">sable</span>
                </span>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Family (feature controls next to the primitives)" id="family">
          <Head />
          <States label="icon-btn 28" render={(s) => <IconButton icon="dots" label="More" disabled={dis(s)} />} />
          <States
            label="Side new"
            render={(s) => (
              <button className="side-new" disabled={dis(s)} style={{ width: 150 }}>
                <Icon name="compose" size={15} />
                <span>New session</span>
              </button>
            )}
          />
          <States
            label="Row action 22"
            render={(s) => (
              <button className="srow-act" aria-label="More" disabled={dis(s)}>
                <Icon name="dots" size={14} />
              </button>
            )}
          />
          <States
            label="Group tool 22"
            render={(s) => (
              <button className="sgroup-tool" aria-label="New" disabled={dis(s)}>
                <Icon name="plus" size={13} />
              </button>
            )}
          />
          <States
            label="Rail tab"
            render={(s) => (
              <button className="rail-tab" disabled={dis(s)}>
                <Icon name="diff" size={15} />
              </button>
            )}
          />
          <States
            label="Rail bar icon 26"
            render={(s) => (
              <span className="rail-bar gal-inline">
                <IconButton icon="refresh" label="Refresh" disabled={dis(s)} />
              </span>
            )}
          />
          <States
            label="Window control"
            render={() => (
              <button className="wc-btn gal-wc" aria-label="Minimise">
                <span className="wc-pill">
                  <Icon name="minus" size={14} />
                </span>
              </button>
            )}
          />
        </Section>

        <Section title="Live (real Radix parts)" id="live">
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <Menu modal={false}>
              <MenuTrigger asChild>
                <button className="btn gal-live-menu">
                  Menu <Icon name="caret-down" size={11} />
                </button>
              </MenuTrigger>
              <MenuContent width={240}>
                <MenuLabel>Session</MenuLabel>
                <MenuItem icon="pencil" keys="f2">
                  Rename
                </MenuItem>
                <MenuItem icon="copy">Copy path</MenuItem>
                <MenuItem icon="pin" checked={pin} onSelect={() => setPin(!pin)}>
                  Pinned
                </MenuItem>
                <MenuItem icon="archive" disabled>
                  Archive
                </MenuItem>
                <MenuSep />
                <MenuItem icon="trash" tone="danger">
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
            <Popover>
              <PopoverTrigger asChild>
                <button className="btn gal-live-pop">Popover</button>
              </PopoverTrigger>
              <PopoverContent className="pop-pad" width={260}>
                <div className="col" style={{ gap: 10 }}>
                  <span>Amount</span>
                  <Slider value={sl} onChange={setSl} label="Amount" />
                </div>
              </PopoverContent>
            </Popover>
            <button className="btn gal-live-modal" onClick={() => setModal(true)}>
              Dialog
            </button>
            <Tip label="Settings" keys="mod+,">
              <button className="btn gal-live-tip">Tooltip</button>
            </Tip>
            <IconButton icon="copy" label="Copy" className="gal-live-ib1" />
            <IconButton icon="refresh" label="Retry" className="gal-live-ib2" />
          </div>
          <Modal
            open={modal}
            onOpenChange={setModal}
            title="Remove this account?"
            description="Sessions on it keep their history."
            footer={
              <>
                <button className="btn btn-ghost" onClick={() => setModal(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => setModal(false)}>
                  Remove
                </button>
              </>
            }
          >
            <input className="field" defaultValue="Work" />
          </Modal>
        </Section>
      </div>
    </TipProvider>
  );
}
