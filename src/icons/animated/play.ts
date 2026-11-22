/**
 * What sets the icons in motion (the motion itself is CSS: `animated.css`, and `icons.css` for the
 * icons that have no drawn version).
 *
 * One set of passive listeners on the document; features never listen themselves:
 *
 * - The pointer arrives on a control, or the keyboard focuses it: each icon in it plays its motion
 *   once (`data-ai` on its svg, taken away when the motion has ended). Nothing replays while the
 *   pointer rests there.
 * - The pointer or the focus leaves before the motion has ended: the motion settles. Barely begun,
 *   it runs back the way it came; further along, it runs out, both quicker than it would have
 *   played. The animation is never dropped, so nothing snaps. Coming back while it settles lets it
 *   run on.
 * - A press (pointer down, Enter or Space): the press beat (`data-ap`), a short second motion on
 *   properties of its own, so it plays over a hover motion that is still under way.
 * - An icon that changes under a control just pressed (copy to a check and back, pin to unpin)
 *   arrives (`data-ai-in`) instead of blinking over.
 *
 * Which elements count:
 * - a control: a button, a link, a tab, or anything marked `data-ai-host`;
 * - a row of a menu or a picker plays only its leading icon, and only once the pointer has rested on
 *   it a moment, so a pointer travelling down a list leaves it still; a control marked
 *   `data-ai-rest` (and the sidebar's project headers) waits for the pointer to rest in the same way;
 * - rows of dense lists (the conversation's steps, the sidebar's chats, any `-row`) and anything
 *   marked `data-still` stay still;
 * - `data-ai-scope="<selector>"` on a control widens what answers it to that ancestor: every icon in
 *   it that is not inside another control (a file card's cover answers the card's one button).
 *
 * Reduced motion: nothing is marked, so every icon is a plain state change.
 */

const CONTROL = "button, a, [role='button'], [role='tab'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], [data-ai-host]";
const ROW = "[role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [role='option'], .menu-item";
/** Controls that are rows of a list all the same (the sidebar's project headers): they too answer only once the pointer rests. */
const RESTS = `${ROW}, .sgroup-toggle, [data-ai-rest]`;
const STILL = ".row-btn, .work-line, .srow-main, [class$='-row'], [class*='-row ']";
/** What can move: the icon set, and the composer's own two glyphs (its add and send keys). */
const ICONS = 'svg[data-icon], svg.sk-glyph, svg.cmp-plus';
/** In a row, marks of its state are not its icon. */
const ROW_MARK = "[data-icon='check'], [data-icon^='caret-']";

/** How long the pointer rests on a row before its icon plays. */
const DWELL = 110;
/** Leaving before this share of the motion has played runs it back; after it, out. */
const BACK_UNTIL = 0.3;
const BACK_RATE = -1.7;
const OUT_RATE = 2.3;
/** How long a pressed control is watched for an icon that changes. */
const WATCH = 4000;

type Kind = 'hover' | 'press' | 'in';
const ATTR: Record<Kind, string> = { hover: 'data-ai', press: 'data-ap', in: 'data-ai-in' };
/** The keyframes of each kind, by the start of their name. */
const NAME: Record<Kind, RegExp> = { hover: /^ai-/, press: /^ap-/, in: /^an-/ };
/** A motion under way on one icon: its animations, once the frame that starts them has come. */
interface Run {
  anims: Animation[] | null;
}
const live: Record<Kind, WeakMap<Element, Run>> = { hover: new WeakMap(), press: new WeakMap(), in: new WeakMap() };

let reduce: MediaQueryList | null = null;
const still = () => !!reduce?.matches;

/**
 * Marks an icon so that its motion of this kind plays, and takes the mark away when all of it has
 * ended. The animations are looked up in the next frame, where the style is worked out anyway, so
 * marking costs the pointer's handler nothing but the attribute.
 */
function mark(svg: Element, kind: Kind) {
  const attr = ATTR[kind];
  const map = live[kind];
  const run: Run = { anims: null };
  svg.setAttribute(attr, '');
  map.set(svg, run);
  requestAnimationFrame(() => {
    if (map.get(svg) !== run) return;
    const re = NAME[kind];
    const anims = svg.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && re.test(a.animationName));
    const done = () => {
      if (map.get(svg) !== run) return;
      map.delete(svg);
      svg.removeAttribute(attr);
    };
    // Nothing moves (an icon without a motion of this kind): the mark goes at once.
    if (!anims.length) return done();
    run.anims = anims;
    void Promise.allSettled(anims.map((a) => a.finished)).then(done);
  });
}

/** Takes a mark back before its motion has begun (the pointer left within the frame). */
function unmark(svg: Element, kind: Kind) {
  live[kind].delete(svg);
  svg.removeAttribute(ATTR[kind]);
}

function start(svg: Element) {
  const going = live.hover.get(svg);
  if (!going) return mark(svg, 'hover');
  // Still moving (the pointer came back while it settled): it runs on at its own pace.
  for (const a of going.anims ?? []) if (a.playState === 'running' && a.playbackRate !== 1) a.updatePlaybackRate(1);
}

function settle(svg: Element) {
  const going = live.hover.get(svg);
  if (!going) return;
  if (!going.anims) return unmark(svg, 'hover');
  let now = 0;
  let end = 0;
  for (const a of going.anims) {
    now = Math.max(now, Number(a.currentTime) || 0);
    end = Math.max(end, Number(a.effect?.getComputedTiming().endTime) || 0);
  }
  const rate = now < end * BACK_UNTIL ? BACK_RATE : OUT_RATE;
  for (const a of going.anims) if (a.playState === 'running') a.updatePlaybackRate(rate);
}

function beat(svg: Element) {
  const going = live.press.get(svg);
  if (!going) return mark(svg, 'press');
  // Pressed again before the beat ended: from its start.
  for (const a of going.anims ?? []) a.currentTime = 0;
}

function arrive(svg: Element) {
  if (still()) return;
  const going = live.in.get(svg);
  if (!going) return mark(svg, 'in');
  for (const a of going.anims ?? []) a.currentTime = 0;
}

/** The icons that answer a control: its own, or those of its scope, never one that sits in another control. */
function iconsOf(ctl: Element): Element[] {
  if (ctl.matches(ROW)) {
    const first = ctl.querySelector(ICONS);
    return first && !first.matches(ROW_MARK) && first.closest(CONTROL) === ctl ? [first] : [];
  }
  const wider = ctl.getAttribute('data-ai-scope');
  const scope = (wider && ctl.closest(wider)) || ctl;
  const out: Element[] = [];
  for (const svg of scope.querySelectorAll(ICONS)) {
    const own = svg.closest(CONTROL);
    if (!own || own === ctl) out.push(svg);
  }
  return out;
}

/** 0: stays still. 1: answers at once. 2: a row, answers once the pointer rests. */
function kindOf(ctl: Element): 0 | 1 | 2 {
  if (ctl.hasAttribute('data-still') || ctl.matches(':disabled, [aria-disabled="true"]')) return 0;
  if (ctl.matches(RESTS)) return 2;
  return ctl.matches(STILL) ? 0 : 1;
}

const controlOf = (t: EventTarget | null) => (t instanceof Element ? t.closest(CONTROL) : null);

/**
 * Plays the icons in `root` (an icon's svg, or anything that holds icons) from code: the motion a
 * hover gives, or the press beat. For moments that are not a pointer on a control.
 */
export function playIcons(root: Element, kind: 'hover' | 'press' = 'hover') {
  if (still()) return;
  const svgs = root.matches(ICONS) ? [root] : Array.from(root.querySelectorAll(ICONS));
  for (const svg of svgs) (kind === 'hover' ? start : beat)(svg);
}

let started = false;

export function startIconMotion() {
  if (started || typeof window === 'undefined' || typeof document === 'undefined' || typeof matchMedia !== 'function') return;
  started = true;
  reduce = matchMedia('(prefers-reduced-motion: reduce)');

  /** The control under the pointer and the one the keyboard focused, and whether each answers at all (a still row costs nothing more). */
  let hot: Element | null = null;
  let hotOn = false;
  let focused: Element | null = null;
  let focusedOn = false;
  let dwell = 0;

  /** The control's icons play (a row's once the pointer has rested). False: this one stays still. */
  const enter = (ctl: Element): boolean => {
    if (still()) return false;
    const kind = kindOf(ctl);
    if (!kind) return false;
    if (kind === 1) {
      iconsOf(ctl).forEach(start);
      return true;
    }
    window.clearTimeout(dwell);
    dwell = window.setTimeout(() => {
      if ((hot === ctl || focused === ctl) && ctl.isConnected) iconsOf(ctl).forEach(start);
    }, DWELL);
    return true;
  };

  const leave = (ctl: Element) => {
    if (ctl === hot || ctl === focused) return;
    if (ctl.isConnected) iconsOf(ctl).forEach(settle);
  };

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const ctl = controlOf(e.target);
    if (ctl === hot) return;
    const was = hotOn ? hot : null;
    hot = ctl;
    hotOn = false;
    if (was) leave(was);
    if (ctl) hotOn = enter(ctl);
  };

  const onOut = () => {
    const was = hotOn ? hot : null;
    hot = null;
    hotOn = false;
    window.clearTimeout(dwell);
    if (was) leave(was);
  };

  const onFocusIn = (e: FocusEvent) => {
    const t = e.target;
    const ctl = controlOf(t);
    if (!ctl || ctl === focused || !(t as Element).matches(':focus-visible')) return;
    const was = focusedOn ? focused : null;
    focused = ctl;
    focusedOn = false;
    if (was) leave(was);
    focusedOn = ctl === hot ? hotOn : enter(ctl);
  };

  const onFocusOut = () => {
    const was = focusedOn ? focused : null;
    focused = null;
    focusedOn = false;
    if (was) leave(was);
  };

  // ── an icon that changes under a control just pressed ──
  let watching: MutationObserver | null = null;
  let unwatch = 0;
  const watch = (ctl: Element) => {
    watching ??= new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target instanceof Element && r.target.matches(ICONS)) arrive(r.target);
          continue;
        }
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches(ICONS)) arrive(n);
          else if (n.firstElementChild) for (const svg of n.querySelectorAll(ICONS)) arrive(svg);
        }
      }
    });
    // Every control pressed lately stays watched (a copy button turns back after a second); all are let go together.
    watching.observe(ctl, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-icon'] });
    window.clearTimeout(unwatch);
    unwatch = window.setTimeout(() => watching?.disconnect(), WATCH);
  };

  const press = (ctl: Element) => {
    if (still() || !kindOf(ctl)) return;
    const icons = iconsOf(ctl);
    if (!icons.length) return;
    icons.forEach(beat);
    watch(ctl);
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const ctl = controlOf(e.target);
    if (ctl) press(ctl);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
    const t = e.target;
    // The control itself holds the focus (a key typed into a field inside one is not a press).
    if (t instanceof Element && t.matches(CONTROL)) press(t);
  };

  document.addEventListener('pointerover', onOver, { passive: true });
  document.documentElement.addEventListener('pointerleave', onOut, { passive: true });
  document.addEventListener('focusin', onFocusIn, { passive: true });
  document.addEventListener('focusout', onFocusOut, { passive: true });
  document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  document.addEventListener('keydown', onKey, { passive: true, capture: true });
  window.addEventListener('blur', onOut);
}
