import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { animate, AnimatePresence, motion, useAnimate, useMotionTemplate, useMotionValue, usePresence, useReducedMotion, type Transition, type Variants } from 'motion/react';
import { Backdrop } from '@/art/Backdrop';
import { MARK_CELLS, markCell, Ring } from '@/art/Logo';
import { ConnectCard } from '@/features/connect/Connect';
import { connectableAgents, isSignedIn } from '@/features/connect/plan';
import { Icon } from '@/icons';
import { bridge } from '@/lib/bridge';
import { tildePath } from '@/lib/format';
import { addProject, goHome, setSettings } from '@/state/actions';
import { focusComposer } from '@/state/hooks';
import { quietFocus } from '@/lib/quiet-focus';
import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import './onboarding.css';

const STEPS = 3;
type Dir = 1 | -1;

/** Fast, firm springs: everything settles well inside the ~550 ms a step change may take. */
const SLIDE: Transition = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 };
const WORD: Transition = { type: 'spring', stiffness: 560, damping: 40, mass: 0.7 };
const MARK: Transition = { type: 'spring', stiffness: 700, damping: 46 };
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const EASE_IN = [0.4, 0, 1, 1] as const;

/** A swell of light through the backdrop from a point on screen (the field listens for it). */
function pulse(x: number, y: number, strength = 1) {
  window.dispatchEvent(new CustomEvent('sable:pulse', { detail: { x, y, strength } }));
}

function pulseFrom(el: Element | null | undefined, strength = 1) {
  const r = el?.getBoundingClientRect();
  if (r) pulse(r.left + r.width / 2, r.top + r.height / 2, strength);
  else pulse(window.innerWidth / 2, window.innerHeight / 2, strength);
}

/**
 * The first-run welcome: three steps played as one continuous piece. A step change sends a wave
 * of light from the pressed control through the backdrop; the leaving step recedes away from the
 * direction of travel while the next one arrives from it in a tight stagger (headline words roll
 * up through their line, cards draw a hairline and unfold from it, the agent marks land last).
 * The mark stays and changes size, the progress pill stretches to the next dot before letting go.
 * Leaving the welcome hands over to the home screen: the mark travels to its place there.
 */
export function Onboarding() {
  const [[step, dir], setNav] = useState<[number, Dir]>([0, 1]);
  const reduce = useReducedMotion() ?? false;
  const leaving = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const [scope, run] = useAnimate();
  const [present, safeToRemove] = usePresence();

  const done = useCallback(async (path?: string) => {
    if (leaving.current) return;
    leaving.current = true;
    if (path) await addProject(path);
    goHome();
    await setSettings({ onboarded: true });
    // The home composer is in place by the end of the hand-over: give it focus.
    window.setTimeout(() => focusComposer(), 460);
  }, []);

  const go = useCallback((to: number, from?: Element | null) => {
    const cur = stepRef.current;
    const next = Math.max(0, Math.min(STEPS - 1, to));
    if (next === cur) return;
    const d: Dir = next > cur ? 1 : -1;
    pulseFrom(from ?? document.querySelector('.onb-step:not([data-leaving]) .onb-go') ?? document.querySelector('.onb-col'), d > 0 ? 1 : 0.6);
    stepRef.current = next;
    setNav([next, d]);
  }, []);
  const next = useCallback((from?: Element | null) => go(stepRef.current + 1, from), [go]);
  const back = useCallback((from?: Element | null) => go(stepRef.current - 1, from), [go]);
  const chooseRef = useRef<(() => void) | null>(null);

  // Enter advances, Backspace or Alt+Left goes back, Escape skips. Dialogs on top keep their keys.
  // Nothing waits for an animation: a second Enter mid-change moves on at once.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useStore.getState().ui;
      if (ui.projectPicker || ui.settings || ui.paletteOpen || ui.historyOpen || document.querySelector('.dialog')) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      const inField = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key === 'Escape') {
        if (t?.closest('[data-escape-scope]')) return;
        e.preventDefault();
        void done();
      } else if (e.key === 'Enter' && !e.repeat && !e.metaKey && !e.ctrlKey) {
        // A focused control handles Enter itself.
        if (inField || (t && t !== document.body && t.closest('button, a, [role="button"]'))) return;
        e.preventDefault();
        if (stepRef.current === STEPS - 1) chooseRef.current?.();
        else next();
      } else if ((e.key === 'Backspace' && !inField) || (e.altKey && e.key === 'ArrowLeft')) {
        if (stepRef.current === 0) return;
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, back, done]);

  // The hand-over: the step lifts away, the light fades, and the mark travels to where the home
  // screen keeps its own (which stays hidden until ours lands on it).
  useEffect(() => {
    if (present) return;
    const root = scope.current as HTMLElement | null;
    if (!root) return safeToRemove?.();
    root.style.pointerEvents = 'none';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      delete document.documentElement.dataset.handover;
      safeToRemove?.();
    };
    if (reduce) {
      void run(root, { opacity: 0 }, { duration: 0.2 }).then(finish);
      return;
    }
    const raf = requestAnimationFrame(() => {
      const travel = root.querySelector<HTMLElement>('.onb-mark-travel');
      const target = document.querySelector<HTMLElement>('.home .logo-mark');
      const parts = [
        run('.onb-step', { opacity: 0, y: -16, scale: 0.98 }, { duration: 0.16, ease: EASE_IN }),
        run('.onb-foot', { opacity: 0 }, { duration: 0.12 }),
        run('.onb-bg', { opacity: 0 }, { duration: 0.4, delay: 0.08, ease: [0.4, 0, 0.2, 1] }),
      ];
      if (travel && target) {
        document.documentElement.dataset.handover = '';
        const from = layoutBox(travel);
        const to = layoutBox(target);
        // Land glyph on glyph: the mark as shown now (step scale included) onto the home mark's cells.
        const box = (travel.querySelector('.onb-mark-scale') ?? travel).getBoundingClientRect().width / zoom();
        const shown = (box * markCell(MARK_BOX)) / MARK_BOX;
        parts.push(
          run(travel, { x: to.x + to.w / 2 - (from.x + from.w / 2), y: to.y + to.h / 2 - (from.y + from.h / 2), scale: shown ? markCell(to.w) / shown : 1 }, { type: 'spring', stiffness: 300, damping: 34, mass: 0.9 }),
        );
      } else if (travel) parts.push(run(travel, { opacity: 0 }, { duration: 0.2 }));
      void Promise.all(parts.map((p) => new Promise<void>((resolve) => void p.then(resolve, resolve)))).then(finish);
    });
    // Never strand the overlay if an animation is interrupted.
    const guard = window.setTimeout(finish, 1200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(guard);
    };
  }, [present, reduce, run, scope, safeToRemove]);

  const stepVariants: Variants = reduce
    ? {
        enter: { opacity: 0 },
        show: { opacity: 1, transition: { duration: 0.16 } },
        leave: { opacity: 0, transition: { duration: 0.1 } },
      }
    : {
        enter: (d: Dir) => ({ x: 34 * d, opacity: 1 }),
        show: { x: 0, opacity: 1, scale: 1, transition: { x: SLIDE, staggerChildren: 0.04, delayChildren: 0.05 } },
        leave: (d: Dir) => ({ x: -40 * d, scale: 0.965, opacity: 0, transition: { duration: 0.13, ease: EASE_IN } }),
      };

  return (
    <motion.div
      ref={scope}
      className="onb"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Sable"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="onb-bg" aria-hidden>
        <div className="onb-light">
          <Backdrop surface="onboarding" />
        </div>
        <div className="onb-veil" />
      </div>

      <header className="onb-top" />

      <div className="onb-stage scroll">
        {/* The column re-centres at once; the leaving step is pinned where it was on screen and the mark glides. */}
        <div className="onb-col" data-step={step}>
          <OnbMark step={step} dir={dir} reduce={reduce} />

          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div key={step} className="onb-step" data-step={step} data-dir={dir > 0 ? 'fwd' : 'back'} custom={dir} variants={stepVariants} initial="enter" animate="show" exit="leave">
              <DirContext.Provider value={dir}>
                {step === 0 && <Welcome reduce={reduce} onNext={next} />}
                {step === 1 && <Agents reduce={reduce} onNext={next} />}
                {step === 2 && <Folder reduce={reduce} onChoose={(p) => void done(p)} onDone={() => void done()} chooseRef={chooseRef} />}
              </DirContext.Provider>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <footer className="onb-foot">
        <div className="onb-foot-side">
          <AnimatePresence initial={false}>
            {step > 0 && (
              <motion.button
                key="back"
                type="button"
                className="btn btn-ghost btn-sm onb-back"
                onClick={(e) => back(e.currentTarget)}
                initial={{ opacity: 0, x: reduce ? 0 : 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: reduce ? 0 : 10, transition: { duration: 0.12 } }}
                transition={SLIDE}
              >
                <Icon name="arrow-left" size={14} className="onb-back-icon" />
                Back
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        <Progress step={step} dir={dir} reduce={reduce} />
        <div className="onb-foot-side onb-foot-end">
          <button type="button" className="btn btn-ghost btn-sm onb-skip" onClick={() => void done()}>
            Skip
          </button>
        </div>
      </footer>
    </motion.div>
  );
}

/** The root's zoom (Interface size): layout lengths times this are screen pixels. */
const zoom = () => Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;

/** An element's box in layout pixels, ignoring transforms (so animations in flight do not skew it). */
function layoutBox(el: HTMLElement) {
  let x = 0;
  let y = 0;
  for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  for (let p = el.parentElement; p; p = p.parentElement) {
    x -= p.scrollLeft;
    y -= p.scrollTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

// ── the mark ──

/** The mark's box on the first step, and the home screen's mark it hands over to (Home.tsx). */
const MARK_BOX = 64;
const HOME_MARK = 36;

/** The scale that makes the mark exactly the home screen's on the later steps (same cells, same pixels). */
const smallScale = () => markCell(HOME_MARK) / markCell(MARK_BOX);

/**
 * The mark keeps its place across steps and only changes size. On every step change its cells
 * ripple once along the diagonal in the direction of travel (the solid corner first going
 * forward, the dithered corner first going back). At rest it is exactly LogoMark.
 */
function OnbMark({ step, dir, reduce }: { step: number; dir: Dir; reduce: boolean }) {
  const [scope, run] = useAnimate();
  const first = useRef(true);
  const cell = markCell(MARK_BOX);
  const at = (MARK_BOX - cell * 4) / 2;

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduce || !scope.current) return;
    for (const el of (scope.current as SVGElement).querySelectorAll<SVGRectElement>('rect')) {
      const d = Number(el.dataset.d);
      const i = dir > 0 ? d : 6 - d;
      void run(el, { scale: [1, 0.6, 1.08, 1] }, { duration: 0.34, delay: i * 0.03, ease: 'easeOut', times: [0, 0.3, 0.7, 1] });
    }
  }, [step, dir, reduce, run, scope]);

  return (
    <motion.div layout="position" className="onb-mark" transition={reduce ? { duration: 0 } : MARK}>
      <div className="onb-mark-travel">
        <motion.span
          className="onb-mark-scale"
          initial={{ opacity: 0, scale: reduce ? 1 : 0.86 }}
          animate={{ opacity: 1, scale: step === 0 ? 1 : smallScale() }}
          transition={reduce ? { duration: 0.15 } : MARK}
        >
          <svg ref={scope} viewBox={`0 0 ${MARK_BOX} ${MARK_BOX}`} width={MARK_BOX} height={MARK_BOX} shapeRendering="crispEdges" aria-hidden className="onb-mark-svg">
            <g fill="var(--text)">
              {MARK_CELLS.map(([c, r]) => (
                <rect key={`${c}${r}`} data-d={c + r} x={at + c * cell} y={at + r * cell} width={cell} height={cell} />
              ))}
            </g>
          </svg>
        </motion.span>
      </div>
    </motion.div>
  );
}

// ── motion pieces ──

/** The direction of the step change in progress, for pieces whose entrance depends on it. */
const DirContext = createContext<Dir>(1);

/**
 * Text that rolls in word by word through its own line, like an odometer: each word rises out of
 * a clip (or drops in, going back). Words wrap naturally, so a paragraph rolls in as a wave.
 */
function RollText({ text, as = 'p', className, reduce, stagger = 0.014 }: { text: string; as?: 'h1' | 'h2' | 'p'; className?: string; reduce: boolean; stagger?: number }) {
  const Cmp = motion[as];
  const dir = useContext(DirContext);
  const words = text.split(' ');
  const word: Variants = reduce
    ? { enter: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.16 } } }
    : { enter: (d: Dir) => ({ y: d > 0 ? '108%' : '-108%' }), show: { y: 0, transition: WORD } };
  return (
    <Cmp className={className} aria-label={text} variants={{ enter: {}, show: { transition: { staggerChildren: reduce ? 0 : stagger } } }}>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="onb-w" aria-hidden>
            <motion.span className="onb-w-in" variants={word} custom={dir}>
              {w}
            </motion.span>
          </span>
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Cmp>
  );
}

/** Rises in on its turn: for controls that should not roll. */
function Rise({ children, reduce, className, delay = 0 }: { children: ReactNode; reduce: boolean; className?: string; delay?: number }) {
  const variants: Variants = reduce
    ? { enter: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.16 } } }
    : { enter: { opacity: 0, y: 12, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 460, damping: 34, delay } } };
  return (
    <motion.div className={className} variants={variants}>
      {children}
    </motion.div>
  );
}

/**
 * A card that arrives as a single hairline drawn from its centre outward, then unfolds from it to
 * full height (clip only, so nothing inside is ever stretched). Its contents follow in a stagger.
 */
function Unfold({ children, reduce, className }: { children: ReactNode; reduce: boolean; className?: string }) {
  const shell: Variants = reduce
    ? { enter: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.16 } } }
    : {
        enter: { clipPath: 'inset(49.5% 0% 49.5% 0% round 14px)' },
        show: {
          clipPath: 'inset(0% 0% 0% 0% round 14px)',
          transition: { clipPath: { duration: 0.28, delay: 0.21, ease: EASE_OUT }, staggerChildren: 0.04, delayChildren: 0.1 },
        },
      };
  const seam: Variants = reduce
    ? { enter: { opacity: 0 }, show: { opacity: 0 } }
    : {
        enter: { scaleX: 0, opacity: 1 },
        show: { scaleX: 1, opacity: [1, 1, 0], transition: { scaleX: { duration: 0.16, ease: EASE_OUT }, opacity: { duration: 0.3, times: [0, 0.5, 1] } } },
      };
  return (
    <div className="onb-unfold">
      <motion.div className={className} variants={shell} data-spot="">

        {children}
      </motion.div>
      <motion.span className="onb-seam" variants={seam} aria-hidden />
    </div>
  );
}

/** A row inside an unfolding card: slides up into place once the card has opened. */
function Item({ children, reduce, className }: { children: ReactNode; reduce: boolean; className?: string }) {
  const variants: Variants = reduce
    ? { enter: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.16 } } }
    : { enter: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 480, damping: 36 } } };
  return (
    <motion.div className={className} variants={variants}>
      {children}
    </motion.div>
  );
}

function GoButton({ label, onPress, autoFocus = true }: { label: string; onPress: (el: HTMLElement) => void; autoFocus?: boolean }) {
  return (
    <button type="button" className="btn btn-primary btn-lg onb-go" ref={autoFocus ? quietFocus : undefined} onClick={(e) => onPress(e.currentTarget)}>
      {label}
      <Icon name="arrow-right" size={15} className="onb-go-arrow" />
    </button>
  );
}

// ── step 1 ──

function Welcome({ reduce, onNext }: { reduce: boolean; onNext: (from?: Element | null) => void }) {
  return (
    <>
      <RollText as="h1" text="Sable" className="onb-name" reduce={reduce} />
      <RollText text="One place to run your coding agents. Follow every step, review every change." className="onb-lead" reduce={reduce} stagger={0.009} />
      <Rise reduce={reduce} className="onb-actions" delay={0.16}>
        <GoButton label="Get started" onPress={onNext} />
      </Rise>
    </>
  );
}

// ── step 2 ──

function Agents({ reduce, onNext }: { reduce: boolean; onNext: (from?: Element | null) => void }) {
  const agents = useStore((s) => connectableAgents(s.providers).join(',')).split(',') as ReturnType<typeof connectableAgents>;
  const ready = useStore((s) => connectableAgents(s.providers).every((id) => isSignedIn(s.providers[id])));
  const anyIn = useStore((s) => connectableAgents(s.providers).some((id) => isSignedIn(s.providers[id])));

  return (
    <>
      {/* Once everything is connected the headline rolls on to the next line of the story. */}
      <RollText key={ready ? 'ready' : 'connect'} as="h2" text={ready ? 'Your agents are ready' : 'Connect your agents'} className="onb-title" reduce={reduce} />
      <RollText text={anyIn ? 'Each runs on its own subscription. Add more accounts any time from the sidebar.' : 'Sign in with the subscription you already have. You can do this later in Settings.'} className="onb-sub" reduce={reduce} stagger={0.007} />
      <Unfold reduce={reduce} className="onb-card onb-agents">
        {agents.map((id) => (
          <Item key={id} reduce={reduce} className="onb-agent">
            <ConnectCard provider={id} compact />
          </Item>
        ))}
      </Unfold>
      <Rise reduce={reduce} className="onb-actions" delay={0.3}>
        <GoButton label="Continue" onPress={onNext} />
      </Rise>
    </>
  );
}

// ── step 3 ──

interface Place {
  name: string;
  path: string;
}

const DEV_DIRS = /^(repos|repositories|projects|dev|developer|code|src|source|sources|github|git|work|workspace|workspaces|sites)$/i;

/** Recent projects, else the places people usually keep code: a dev folder under home, Documents, Desktop. */
function usePlaces(): Place[] | null {
  const projects = useStore((s) => s.projects);
  const [found, setFound] = useState<Place[] | null>(null);
  const recent = [...projects].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0)).slice(0, 4);
  const hasRecent = recent.length > 0;

  useEffect(() => {
    if (hasRecent) return;
    let alive = true;
    // No action exists for these read-only lookups; the folder picker calls them the same way.
    void (async () => {
      try {
        const { roots, home } = await bridge.call('fs.roots', {});
        const listing = await bridge.call('fs.list', { path: home }).catch(() => null);
        const dev = (listing?.entries ?? []).filter((e) => e.dir && DEV_DIRS.test(e.name)).slice(0, 2);
        const named = (n: string) => roots.find((r) => r.name === n);
        const out: Place[] = [...dev.map((d) => ({ name: d.name, path: d.path }))];
        for (const n of ['Documents', 'Desktop', 'Home']) {
          const r = named(n);
          if (r && !out.some((o) => o.path === r.path)) out.push({ name: r.name, path: r.path });
        }
        if (alive) setFound(out.slice(0, 4));
      } catch {
        if (alive) setFound([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [hasRecent]);

  return hasRecent ? recent.map((p) => ({ name: p.name || p.path, path: p.path })) : found;
}

/** The folder part of a path, shown quietly after the name (the name itself is not repeated). */
function parentOf(path: string, home: string): string {
  const short = tildePath(path, home).replace(/\\/g, '/');
  const i = short.replace(/\/+$/, '').lastIndexOf('/');
  const parent = i > 0 ? short.slice(0, i) : short;
  return parent === '~' ? 'Home folder' : parent;
}

function Folder({ reduce, onChoose, onDone, chooseRef }: { reduce: boolean; onChoose: (path: string) => void; onDone: () => void; chooseRef: { current: (() => void) | null } }) {
  const places = usePlaces();
  const home = useStore((s) => s.home);
  const hasRecent = useStore((s) => s.projects.length > 0);
  const picker = useStore((s) => s.ui.projectPicker);
  const homeCwd = useStore((s) => s.ui.homeCwd);
  const projects = useStore((s) => s.projects);
  const opened = useRef<{ cwd: string | null; projects: unknown } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const pick = () => useStore.getState().setUi({ projectPicker: true });

  // The folder dialog (from here or its shortcut) adds the folder and closes itself: that is the choice.
  useEffect(() => {
    if (picker) {
      opened.current ??= { cwd: homeCwd, projects };
      return;
    }
    if (!opened.current) return;
    const before = opened.current;
    opened.current = null;
    if (homeCwd && (homeCwd !== before.cwd || projects !== before.projects)) onDone();
  }, [picker, homeCwd, projects, onDone]);

  const choose = (path: string) => {
    setChosen(path);
    onChoose(path);
  };
  chooseRef.current = () => (places?.[0] ? choose(places[0].path) : pick());

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>('.onb-place') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    rows[n]?.focus();
  };

  return (
    <>
      <RollText as="h2" text="Where do you want to work?" className="onb-title" reduce={reduce} />
      <RollText text={hasRecent ? 'Pick up where you left off, or open another folder.' : 'Pick a folder for your first session. You can open others any time.'} className="onb-sub" reduce={reduce} stagger={0.007} />
      <Unfold reduce={reduce} className="onb-card onb-places">
        <div ref={list} role="list" onKeyDown={onKeyDown} className="onb-places-list">
          {places === null ? (
            <div className="onb-places-loading">
              <Spinner size={14} />
            </div>
          ) : (
            places.map((p, i) => (
              <Item key={p.path} reduce={reduce}>
                <button type="button" role="listitem" className="onb-place" data-chosen={chosen === p.path || undefined} ref={i === 0 ? quietFocus : undefined} onClick={() => choose(p.path)}>
                  <Icon name="folder" size={17} className="onb-place-icon" />
                  <span className="onb-place-text">
                    <span className="onb-place-name truncate">{p.name}</span>
                    <span className="onb-place-path truncate">{parentOf(p.path, home)}</span>
                  </span>
                  {chosen === p.path ? <Ring size={14} label="Opening" /> : null}
                  <Icon name="arrow-right" size={14} className="onb-place-go" />
                </button>
              </Item>
            ))
          )}
          <Item reduce={reduce}>
            <button type="button" role="listitem" className="onb-place onb-place-pick" ref={places !== null && places.length === 0 ? quietFocus : undefined} onClick={pick}>
              <Icon name="folder-plus" size={17} className="onb-place-icon" />
              <span className="onb-place-text">
                <span className="onb-place-name">Choose a folder…</span>
              </span>
            </button>
          </Item>
        </div>
      </Unfold>
    </>
  );
}

// ── progress ──

/** Pill geometry: dots 6 px, centres 16 px apart; the pill reaches 7 px past a dot either side, and the other dots stand that much further off. */
const DOT = 6;
const PITCH = 16;
const REACH = 7;
const TRACK = (STEPS - 1) * PITCH + DOT + REACH * 2;
const edges = (i: number) => ({ left: i * PITCH, right: TRACK - (i * PITCH + DOT + REACH * 2) });

/**
 * One pill that moves between the dots like a caterpillar: its leading edge stretches to the next
 * dot first, then the trailing edge lets go and catches up (clip only, so it never distorts).
 */
function Progress({ step, dir, reduce }: { step: number; dir: Dir; reduce: boolean }) {
  const start = edges(step);
  const left = useMotionValue(start.left);
  const right = useMotionValue(start.right);
  const clip = useMotionTemplate`inset(0px ${right}px 0px ${left}px round 3px)`;

  useEffect(() => {
    const to = edges(step);
    if (reduce) {
      left.set(to.left);
      right.set(to.right);
      return;
    }
    const lead = { type: 'spring', stiffness: 700, damping: 40 } as const;
    const trail = { type: 'spring', stiffness: 380, damping: 34, delay: 0.09 } as const;
    const a = animate(left, to.left, dir > 0 ? trail : lead);
    const b = animate(right, to.right, dir > 0 ? lead : trail);
    return () => {
      a.stop();
      b.stop();
    };
  }, [step, dir, reduce, left, right]);

  return (
    <div className="onb-progress" role="img" aria-label={`Step ${step + 1} of ${STEPS}`} style={{ width: TRACK }}>
      {Array.from({ length: STEPS }, (_, i) => (
        // The dots beside the pill step away by its reach, so the gaps on both sides of it match the gap between two dots.
        <span key={i} className="onb-dot" data-done={i < step || undefined} style={{ left: REACH + i * PITCH, transform: `translateX(${Math.sign(i - step) * REACH}px)` }} />
      ))}
      <motion.span className="onb-pill" style={{ clipPath: clip }} />
    </div>
  );
}
