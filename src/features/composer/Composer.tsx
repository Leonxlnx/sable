import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DropdownMenu as RM } from 'radix-ui';
import type { Attachment, QueuedMessage } from '@shared/protocol';
import { stripWrappers, syntheticLine, syntheticOf } from '@shared/synthetic';
import { beginHandoff, bindHandoff, cancelHandoff, claimHandoff, takeHomeDraft } from '@/features/home/handoff';
import { Icon } from '@/icons';
import { pathForFile } from '@/lib/desktop';
import { isUltraEffort, toggledSpeed } from '@/lib/models';
import { EASE_OUT, play, reducedMotion } from '@/lib/motion';
import { holdFlights, launchFlight } from './flight';
import { launchKey } from './launch';
import { fieldBeat } from '@/art/events';
import { searchFiles, type FileHit } from '@/lib/workspace';
import { homeChoice, interrupt, sendMessage, setHomeUltracode, setUltracode, startFromHome, takeQueued, updateQueued } from '@/state/actions';
import { useHotkey } from '@/state/hooks';
import { useStore } from '@/state/store';
import { Tip } from '@/ui';
import { readFiles, withTextAttachments } from './attach';
import { AttachmentRow } from './Attachments';
import { useChoice } from './choice';
import { paidAsk, paidConfirmed } from './paid-speed';
import { APP_COMMANDS, appCommandsFor, commandRows, expandCommand, mentionRows, skillRows, type CommandCtx, type SuggestRow } from './commands';
import { keepDrafts } from './drafts';
import { carryOver, leaveField, putBack, shownUltra, swapIn, ultraAnswered, type UltraPick } from './restore';
import { holdSend, moveSend, sendBack, sendDone } from './pending';
import { watchWidth } from './width-watch';
import { HomeChips, ModelPopover, ModeMenu, openComposerMenu, useHomeSignedOut, useMenuPlace } from './Controls';
import { CoveSkin } from './Cove';
import { PROVIDER_NAME } from '@/art/Logo';
import { ModelEffort } from './Thinking';
import { Highlight } from './Highlight';
import { NO_QUEUE, QueueTray } from './QueueTray';
import { UntilStrip } from './UntilStrip';
import { SpareStrip } from './SpareStrip';
import { CustomStrip } from '@/features/customize/CustomStrip';
import { ReviewBar } from '@/features/review/ReviewBar';
import { SendKey } from './SendKey';
import { SuggestMenu } from './SuggestMenu';
import { modelCommand } from './model-command';
import { UltraEdge } from './Ultracode';
import './composer.css';

export interface ComposerProps {
  /** Existing session, or null on the home screen (a session is created on send). */
  sessionId: string | null;
  variant: 'home' | 'session';
  autoFocus?: boolean;
}

const EMPTY: Attachment[] = [];
// A draft per session survives a restart (text only): read back before the first composer renders.
keepDrafts();
const LINE = 22;
const PAD_Y = 10;
const MAX_LINES = 10;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type Trigger = { kind: 'slash' | 'mention' | 'skill'; start: number; query: string };

/** The token being typed at the caret, if it opens a typeahead. */
function findTrigger(text: string, caret: number, dollar: boolean): Trigger | null {
  const before = text.slice(0, caret);
  if (/^\/\S*$/.test(before)) return { kind: 'slash', start: 0, query: before.slice(1) };
  const m = /(^|\s)([@$])([^\s@$]*)$/.exec(before);
  if (!m) return null;
  if (m[2] === '$' && !dollar) return null;
  return { kind: m[2] === '@' ? 'mention' : 'skill', start: before.length - m[3].length - 1, query: m[3] };
}

/** The caret's left edge (CSS px from the field's left) at `index`, measured on a hidden twin of the field. */
let caretTwin: HTMLDivElement | null = null;
function caretLeft(ta: HTMLTextAreaElement, index: number): number {
  if (!caretTwin) {
    caretTwin = document.createElement('div');
    caretTwin.setAttribute('aria-hidden', 'true');
    caretTwin.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;';
    document.body.appendChild(caretTwin);
  }
  const cs = getComputedStyle(ta);
  const t = caretTwin;
  t.style.width = `${ta.clientWidth}px`;
  t.style.font = cs.font;
  t.style.padding = cs.padding;
  t.style.letterSpacing = cs.letterSpacing;
  t.textContent = ta.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '​';
  t.appendChild(mark);
  return mark.offsetLeft;
}

/** Images and files that go by path travel as attachments; text files are folded into the message. */
const parcel = (body: string, atts: Attachment[]) => ({ text: withTextAttachments(body, atts), attachments: atts.filter((a) => a.kind === 'image' || (a.kind === 'file' && !!a.path)) });

/** Files can be dropped anywhere on the stage; the newest composer on screen takes them. */
const dropOwners: number[] = [];
let dropSeq = 0;

function useStageDrop(card: RefObject<HTMLElement | null>, onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  // Read only while a file is over the stage (that render comes from setOver): a ref, so mounting
  // the composer does not render it twice.
  const host = useRef<HTMLElement | null>(null);
  const take = useRef(onFiles);
  take.current = onFiles;
  useEffect(() => {
    const me = ++dropSeq;
    dropOwners.push(me);
    const stage = card.current?.closest('.stage') ?? document.querySelector('.stage');
    const target: EventTarget = stage ?? window;
    host.current = (stage as HTMLElement | null) ?? null;
    let t = 0;
    const mine = () => dropOwners[dropOwners.length - 1] === me;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onOver = (e: Event) => {
      const d = e as DragEvent;
      if (!files(d) || !mine()) return;
      d.preventDefault();
      if (d.dataTransfer) d.dataTransfer.dropEffect = 'copy';
      setOver(true);
      window.clearTimeout(t);
      // dragover repeats every ~50 ms while a file is over the stage; silence means it left.
      t = window.setTimeout(() => setOver(false), 180);
    };
    const onDrop = (e: Event) => {
      const d = e as DragEvent;
      if (!files(d) || !mine()) return;
      d.preventDefault();
      window.clearTimeout(t);
      setOver(false);
      take.current([...(d.dataTransfer?.files ?? [])]);
    };
    // Anywhere else in the window a dropped file must not open in place of the app.
    const guard = (e: Event) => files(e as DragEvent) && e.preventDefault();
    target.addEventListener('dragenter', onOver);
    target.addEventListener('dragover', onOver);
    target.addEventListener('drop', onDrop);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.clearTimeout(t);
      dropOwners.splice(dropOwners.indexOf(me), 1);
      target.removeEventListener('dragenter', onOver);
      target.removeEventListener('dragover', onOver);
      target.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, [card]);
  return { over, host: host.current };
}

/** One calm drop state over the whole stage. */
const StageDrop = memo(function StageDrop({ host, images }: { host: HTMLElement | null; images: boolean }) {
  if (!host) return null;
  return createPortal(
    <div className="stage-drop" aria-hidden>
      <div className="stage-drop-label">
        <Icon name={images ? 'image' : 'file-plus'} size={18} />
        {images ? 'Drop files or images to attach them' : 'Drop files to attach them'}
      </div>
    </div>,
    host,
  );
});

/** The attach button and its menu: memoized, so the composer's renders (each keystroke, a status change) skip it. */
const AttachMenu = memo(function AttachMenu({ images, side, onAdd, onMention }: { images: boolean; side: 'top' | 'bottom'; onAdd: () => void; onMention: () => void }) {
  const [open, setOpen] = useState(false);
  const disc = useRef<HTMLButtonElement>(null);
  const place = useMenuPlace(disc, open, side, 2 * 28 + 8);
  return (
    <RM.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={images ? 'Attach files or images' : 'Attach files'} side="top">
        <RM.Trigger asChild>
          <button ref={disc} type="button" className="cmp-attach" aria-label="Attach">
            <PlusGlyph />
          </button>
        </RM.Trigger>
      </Tip>
      <RM.Portal>
        <RM.Content className="pop cm-pop" data-spot side={place.side} align="start" sideOffset={place.sideOffset} alignOffset={place.alignOffset} avoidCollisions={false} collisionPadding={10} style={{ width: 208 }} onCloseAutoFocus={(e) => e.preventDefault()}>
          <RM.Item className="menu-item" onSelect={onAdd}>
            <Icon name={images ? 'image' : 'file-plus'} size={15} />
            <span className="grow">{images ? 'Add files or images' : 'Add files'}</span>
          </RM.Item>
          <RM.Item className="menu-item" onSelect={onMention}>
            <Icon name="at" size={15} />
            <span className="grow">Mention a file</span>
          </RM.Item>
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
});

/** The add button's plus, drawn on the pixel grid so it sits dead centre at any interface size. */
function PlusGlyph() {
  return (
    <svg className="cmp-plus" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 2.25v9.5M2.25 7h9.5" />
    </svg>
  );
}

/**
 * Resolves once the frame being prepared now has been handed to the compositor (a task after its
 * animation frame), or after 100 ms when no frame comes (a hidden window draws none).
 */
function afterFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => window.setTimeout(go, 0));
    window.setTimeout(go, 100);
  });
}

/**
 * The composer: one card that takes text, mentions, commands and files, and sends them to the
 * agent (or starts a session from the home screen). While a turn runs, Enter queues and Ctrl+Enter
 * steers. Menus and keys are memoized children that keep their own state, so opening a menu or
 * typing never re-renders more than it must.
 */
export const Composer = memo(function Composer({ sessionId, variant, autoFocus }: ComposerProps) {
  const key = sessionId ?? 'home';
  // A message on its way out (see submit): the field is already empty on screen and every render
  // until the store follows shows it so, or React would write the words back for a frame.
  const sent = useRef<{ text: string; attachments: Attachment[] } | null>(null);
  const storedText = useStore((s) => s.drafts[key]?.text ?? '');
  const storedAttachments = useStore((s) => s.drafts[key]?.attachments ?? EMPTY);
  const text = sent.current ? '' : storedText;
  const attachments = sent.current ? EMPTY : storedAttachments;
  const setDraft = useStore((s) => s.setDraft);
  const sendWithEnter = useStore((s) => s.settings.sendWithEnter);
  const status = useStore((s) => (sessionId ? s.sessions[sessionId]?.status : undefined));
  const suggestion = useStore((s) => (sessionId ? s.data[sessionId]?.suggestion : undefined));
  const cwd = useStore((s) => (sessionId ? (s.sessions[sessionId]?.cwd ?? null) : s.ui.homeChat ? null : s.ui.homeCwd));
  const queue = useStore((s) => (sessionId ? (s.data[sessionId]?.queue ?? NO_QUEUE) : NO_QUEUE));
  const storedUltra = useStore((s) => (sessionId ? !!s.sessions[sessionId]?.ultracode : !!s.ui.homeUltracode));
  const toast = useStore((s) => s.toast);
  const choice = useChoice(sessionId);
  const caps = choice.caps;

  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLTextAreaElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const listId = useId();

  const [caret, setCaret] = useState(0);
  // Whether the field has focus matters only to an open typeahead: kept in a ref, and a render is
  // asked for only when there is a trigger to show or hide (focus moving on mount or on a send
  // renders nothing).
  const focusedRef = useRef(false);
  const [, bumpFocus] = useReducer((n: number) => n + 1, 0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [recall, setRecall] = useState<number | null>(null);
  // Ultracode as just switched here, over the value the session had then: it shows at once, until
  // the bridge answers that request (restore.ts `UltraPick`), or the session says anything else.
  const [ultraPick, setUltraPick] = useState<UltraPick | null>(null);
  const ultraSeq = useRef(0);
  const searchSeq = useRef(0);

  const busy = status === 'running' || status === 'awaiting' || status === 'starting';
  // A chat with nothing said yet asks for the first task, as home does; later the field is a reply.
  // While its conversation still loads, the session itself says which: a chat that has had a turn
  // (or runs one) is a reply. So the field never stands blank and then names itself a moment later.
  const fresh = useStore((s) => {
    if (variant !== 'session' || !sessionId) return false;
    const d = s.data[sessionId];
    if (d?.loaded) return !d.roots.length;
    const st = s.sessions[sessionId]?.status;
    return !(s.sessions[sessionId]?.usage?.turns ?? 0) && st !== 'running' && st !== 'awaiting' && st !== 'starting';
  });
  const shell = variant === 'session' && text.startsWith('!');
  const trimmed = text.trim();
  const canSend = shell ? text.slice(1).trim().length > 0 : trimmed.length > 0 || attachments.length > 0;
  const showStop = variant === 'session' && busy && !canSend;
  const ghost = !text && suggestion && !attachments.length ? suggestion : null;
  // The suggestion this composer was made with (a chat switched to makes a new one): it stands
  // there from the first frame. Fading it in left the field blank for five frames on every switch,
  // between the last chat's suggestion going and this one's arriving.
  const [bornWith] = useState(() => suggestion);
  const popSide = variant === 'home' ? 'bottom' : 'top';
  const steerable = !!caps?.features.steer;
  const ultraOffered = !!caps?.features.ultracode;
  const ultra = ultraOffered && shownUltra(storedUltra, ultraPick?.session === sessionId ? ultraPick : null);
  // "Ultra" is one look across agents: ultracode on (a mode), or an Ultra level (an effort).
  const ultraLook = ultra || isUltraEffort(choice.effort);
  const images = !!caps?.features.images;
  // Home, with an agent that is not signed in: the placeholder says so (the chip below opens Accounts).
  const signedOut = useHomeSignedOut() && variant === 'home';
  const homeAgent = useStore((s) => s.ui.homeProvider);


  // ── text helpers ──

  const setText = useCallback(
    (next: string, caretAt?: number) => {
      setDraft(key, { text: next });
      pendingCaret.current = caretAt ?? next.length;
    },
    [key, setDraft],
  );

  const focus = useCallback(() => ref.current?.focus({ preventScroll: true }), []);

  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    const ta = ref.current;
    if (pos == null || !ta) return;
    pendingCaret.current = null;
    ta.setSelectionRange(pos, pos);
    // An empty field has no trigger for the caret to find: the render this would ask for (after
    // every send, in the send's busiest frames) is left out; typing sets the caret again.
    if (text) setCaret(pos);
  }, [text]);

  // ── auto-grow: measure a hidden twin so the visible field can animate its height ──

  const minLines = variant === 'home' ? 2 : 1;
  // The suggestion renders on one truncated line, so it never grows the field.
  const measured = ghost ? '' : text === '!' && shell ? '! Run a shell command in the terminal' : text;
  const measure = useCallback(() => {
    const m = mirror.current;
    const ta = ref.current;
    if (!m || !ta) return;
    m.value = measured || ' ';
    const content = m.scrollHeight;
    const max = LINE * MAX_LINES + PAD_Y;
    const h = Math.min(max, Math.max(LINE * minLines + PAD_Y, content));
    ta.style.height = `${h}px`;
    ta.style.overflowY = content > max ? 'auto' : 'hidden';
  }, [measured, minLines]);

  // The pill layer scrolls (and reserves a scrollbar) exactly like the field above it.
  const syncHighlight = useCallback(() => {
    const ta = ref.current;
    const layer = hl.current;
    if (!ta || !layer) return;
    layer.style.overflowY = ta.style.overflowY === 'auto' ? 'scroll' : 'hidden';
    layer.scrollTop = ta.scrollTop;
  }, []);

  // Only when the text changes: a render for any other reason (focus, a menu) reads no layout.
  useLayoutEffect(() => {
    measure();
    syncHighlight();
  }, [measure, syncHighlight]);

  // One observer for the field's life: a new width measures again with the text of the moment.
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    const stop = watchWidth(ta, () => measureRef.current());
    // The first measurement never animates.
    const raf = requestAnimationFrame(() => ta.setAttribute('data-ready', ''));
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, []);

  // A chat left (a switch, or its view closing) takes its messages still in the air with it (rows
  // of another chat never take them in any case: flight.ts `claimable`).
  useEffect(() => (sessionId ? holdFlights(sessionId) : undefined), [sessionId]);

  // ── the home-to-session hand-off lands on this card ──

  useLayoutEffect(() => {
    if (variant !== 'session') return;
    const claimed = claimHandoff(card.current, sessionId);
    // Words and files typed on home while this chat was being made (the home field kept the
    // keyboard) are this chat's alone: they come along, with the glide or without it (reduced
    // motion), and the keyboard moves here now, so nothing typed right after the first send is lost.
    const carried = takeHomeDraft(sessionId);
    if (carried) {
      const st = useStore.getState();
      const home = st.drafts.home;
      if (home && (home.text || home.attachments.length)) {
        const next = carryOver(st.drafts[key], home);
        setDraft(key, { attachments: next.attachments });
        setText(next.text);
        setDraft('home', { text: '', attachments: [] });
      }
    }
    if (claimed || carried) focus();
  }, [variant, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── focus ──

  useEffect(() => {
    if (!autoFocus) return;
    const t = window.setTimeout(() => {
      // Never take focus from a dialog or from another field the person is typing in (a rename).
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && el !== ref.current && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (!document.querySelector('[role="dialog"]') && !typing) focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [autoFocus, sessionId, focus]);

  useHotkey(
    'mod+l',
    useCallback(
      (e: globalThis.KeyboardEvent) => {
        e.preventDefault();
        focus();
      },
      [focus],
    ),
  );

  useEffect(() => {
    const onFocus = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; append?: boolean }>).detail ?? {};
      const ta = ref.current;
      const cur = useStore.getState().drafts[key]?.text ?? '';
      if (typeof detail.text === 'string') {
        if (detail.append) {
          const at = ta && document.activeElement === ta ? ta.selectionStart : cur.length;
          const pre = cur.slice(0, at);
          const sep = pre && !/\s$/.test(pre) ? ' ' : '';
          const ins = sep + detail.text;
          setText(pre + ins + cur.slice(at), at + ins.length);
        } else setText(detail.text);
      }
      const want = pendingCaret.current;
      window.requestAnimationFrame(() => {
        focus();
        const pos = want ?? ta?.value.length ?? 0;
        ta?.setSelectionRange(pos, pos);
        setCaret(pos);
      });
    };
    window.addEventListener('sable:focus-composer', onFocus);
    return () => window.removeEventListener('sable:focus-composer', onFocus);
  }, [key, setText, focus]);

  // ── typeahead ──

  // "$" invokes a skill only for an agent that uses it (Codex) and has skills to offer.
  const trigger = shell ? null : findTrigger(text, caret, caps?.skillTrigger === '$' && !!caps.skills.length);
  const trigKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const focused = focusedRef.current;
  const wantMenu = !!trigger && focused && dismissed !== trigKey && (trigger.kind !== 'mention' || !!cwd);

  useEffect(() => {
    if (!trigKey) setDismissed(null);
  }, [trigKey]);

  useEffect(() => {
    if (!wantMenu || trigger?.kind !== 'mention' || !cwd) return;
    const q = trigger.query;
    const my = ++searchSeq.current;
    setFilesLoading(true);
    const t = window.setTimeout(() => {
      searchFiles(cwd, q, 30)
        .then((r) => my === searchSeq.current && (setFiles(r), setFilesLoading(false)))
        .catch(() => my === searchSeq.current && (setFiles([]), setFilesLoading(false)));
    }, 80);
    return () => window.clearTimeout(t);
  }, [wantMenu, trigger?.kind, trigger?.query, cwd]);

  const rows: SuggestRow[] = useMemo(() => {
    if (!wantMenu || !trigger) return [];
    if (trigger.kind === 'slash') return commandRows(trigger.query, caps, sessionId);
    if (trigger.kind === 'skill') return skillRows(trigger.query, caps);
    return mentionRows(files, trigger.query, caps);
  }, [wantMenu, trigger?.kind, trigger?.query, caps, sessionId, files]); // eslint-disable-line react-hooks/exhaustive-deps

  // A "$" that no skill answers ("$20") is ordinary text: no menu.
  const menuOpen = wantMenu && !(trigger?.kind === 'skill' && trigger.query && !rows.length);

  useEffect(() => setActive(0), [trigKey, trigger?.query]);

  // The typeahead grows out of the caret: where the trigger character sits, measured once per trigger.
  const [originX, setOriginX] = useState(0);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!menuOpen || !trigger || !ta) return;
    const c = card.current;
    const z = parseFloat(document.documentElement.style.zoom) || 1;
    const inset = c ? (ta.getBoundingClientRect().left - c.getBoundingClientRect().left) / z : 0;
    setOriginX(caretLeft(ta, trigger.start) + inset);
  }, [menuOpen, trigKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const { model: speedModel, speed, speeds, setSpeed } = choice;
  const ctx: CommandCtx = useMemo(
    () => ({
      sessionId,
      openModel: () => openComposerMenu('model'),
      setModel: (name: string) => modelCommand(name, choice),
      openMode: () => openComposerMenu('mode'),
      openEffort: () => openComposerMenu('effort'),
      // A paid speed (Claude's fast mode) is asked for in the effort popover the first time in a session.
      toggleSpeed: speeds.length
        ? () => {
            const next = toggledSpeed(speedModel, speed, speeds);
            if (sessionId && speeds.find((s) => s.id === next)?.paid && !paidConfirmed(sessionId)) {
              paidAsk(sessionId, next);
              openComposerMenu('effort');
            } else setSpeed(next);
          }
        : undefined,
    }),
    [sessionId, speedModel, speed, speeds, setSpeed, choice],
  );

  const accept = (row: SuggestRow | undefined) => {
    if (!row || !trigger) return;
    let end = caret;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const before = text.slice(0, trigger.start);
    const after = text.slice(end);
    if (row.kind === 'app') {
      const cmd = APP_COMMANDS.find((c) => c.name === row.name);
      if (!cmd) return;
      if (cmd.argumentHint) {
        const ins = `/${cmd.name} `;
        setText(before + ins + after.replace(/^\s+/, ''), before.length + ins.length);
        return;
      }
      setText(after.replace(/^\s+/, ''), 0);
      cmd.run(ctx, '');
      return;
    }
    const ins = trigger.kind === 'slash' ? `/${row.name} ` : trigger.kind === 'skill' ? `$${row.name} ` : row.kind === 'dir' ? `@${row.value}` : `@${row.value} `;
    const rest = ins.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after;
    setText(before + ins + rest, before.length + ins.length);
  };

  // ── attachments ──

  const addFiles = useCallback(
    async (list: File[]) => {
      if (!list.length) return;
      const current = useStore.getState().drafts[key]?.attachments ?? [];
      const { added, refused } = await readFiles(list, { images, current, pathOf: pathForFile });
      if (added.length) setDraft(key, { attachments: [...(useStore.getState().drafts[key]?.attachments ?? []), ...added] });
      if (refused) toast(refused);
      focus();
    },
    [key, images, setDraft, toast, focus],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      setDraft(key, { attachments: (useStore.getState().drafts[key]?.attachments ?? []).filter((a) => a.id !== id) });
      focus();
    },
    [key, setDraft, focus],
  );

  const { over: dropping, host: dropHost } = useStageDrop(card, addFiles);

  const mention = () => {
    const ta = ref.current;
    const at = ta ? ta.selectionStart : text.length;
    const pre = text.slice(0, at);
    const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
    setText(pre + ins + text.slice(at), at + ins.length);
    setDismissed(null);
    window.requestAnimationFrame(focus);
  };
  // Stable for the memoized attach menu: it renders once, not with every keystroke.
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  const mentionStable = useCallback(() => mentionRef.current(), []);
  const pickFiles = useCallback(() => fileInput.current?.click(), []);

  // ── sending ──

  /**
   * The send motion, drawn on a layer over the field (the field itself is already empty and
   * live): the sent text rolls up about 12px behind the field's top edge and fades (80 ms), and
   * the next placeholder rises from 8px below (100 ms, two frames later). The backdrop gets a pulse.
   */
  const rollOut = (sent: string, next: string | null, flew: boolean, queued = false) => {
    // The backdrop's wave: a message that leaves as liquid sends its own, from where its drop
    // parts from the bar (flight.ts); any other leaves the key with one.
    if (!flew) fieldBeat('send', card.current?.querySelector('.cmp-send') ?? card.current, 1);
    const field = ref.current?.parentElement;
    if (!field || !sent) return;
    const layer = document.createElement('div');
    layer.className = 'cmp-roll';
    layer.setAttribute('aria-hidden', 'true');
    const old = document.createElement('div');
    // The words are in the air (flight.ts): only the next placeholder rises here.
    if (!flew) {
      old.textContent = sent;
      layer.appendChild(old);
    }
    const out = play(old, [{ transform: 'translateY(0px)', opacity: 1 }, { transform: 'translateY(-12px)', opacity: 0 }], { duration: 80, easing: 'cubic-bezier(0.3, 0, 0.6, 1)', fill: 'forwards' });
    if (!out) return;
    field.appendChild(layer);
    let last: Animation = out;
    if (next) {
      const ph = document.createElement('div');
      ph.className = 'cmp-roll-ph';
      ph.textContent = next;
      layer.appendChild(ph);
      card.current?.setAttribute('data-rolling', '');
      last = play(ph, [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(0px)', opacity: 1 }], { duration: flew ? 160 : 100, delay: flew ? (queued ? 300 : 150) : 33, easing: EASE_OUT, fill: 'both' }) ?? out;
    }
    const done = () => {
      layer.remove();
      card.current?.removeAttribute('data-rolling');
    };
    last.finished.then(done, done);
  };

  // The backdrop answers the turn's end (light settling onto the composer, or a dip on an error).
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && variant === 'session') {
      if (status === 'error') fieldBeat('fail', card.current, 1);
      else fieldBeat('done', card.current, 1, 'top');
    }
    wasBusy.current = busy;
  }, [busy, variant, sessionId]);

  const clear = () => {
    setDraft(key, { text: '', attachments: [] });
    pendingCaret.current = 0;
    setRecall(null);
  };

  const submit = async (steer = false) => {
    // A second press before the store has followed the first: that message is already on its way.
    if (sent.current) return;
    if (shell) {
      const command = text.slice(1).trim();
      if (!command || !sessionId) return;
      useStore.getState().setUi({ railOpen: true, railTab: 'terminal', pendingCommand: { id: Date.now(), sessionId, command } });
      clear();
      return;
    }
    if (!canSend) return;
    const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (m && !attachments.length) {
      const cmd = appCommandsFor(sessionId).find((c) => c.name === m[1]);
      if (cmd) {
        const typed = { text, attachments: EMPTY };
        clear();
        // A command that answers (opening a chat, starting a race) and fails: its words come back.
        const ran = await cmd.run(ctx, (m[2] ?? '').trim());
        if (ran === false) {
          setDraft(key, putBack(useStore.getState().drafts[key], typed));
          pendingCaret.current = typed.text.length;
        }
        return;
      }
    }
    const draft = { text, attachments };
    // A command picked by its short name goes out under the full one the agent knows it by.
    const body = expandCommand(trimmed, caps);
    const out = parcel(body, attachments);
    // The words leave the field for where they land: the conversation, or the queue tray while a
    // turn runs (a steer goes into the turn). Measured once here, before the field empties.
    const steering = steer && busy && steerable;
    const ta = ref.current;
    const flew = !!ta && !!body && !reducedMotion();
    const flight = flew ? launchFlight({ el: ta, text: body }, { dest: sessionId && busy && !steering ? 'tray' : 'timeline', steer: steering, first: !sessionId, session: sessionId }) : null;
    if (variant === 'session') launchKey(card.current);
    // In a session the next placeholder is always the queueing one: the turn is running (or about to).
    // A queued message's words rise through the field into the tray: the placeholder waits for them.
    rollOut(text, variant === 'session' ? 'Queue a follow-up' : null, flew, !!sessionId && busy && !steering);
    // From home: the composer starts its glide to the dock at once, before the session exists. What
    // home starts is read once, here: the message goes to the agent shown when Send was pressed,
    // whatever an agent's late answer changes in the frame that follows.
    const choice = sessionId ? null : homeChoice();
    if (choice) beginHandoff(card.current);
    // The press itself only touches the page: the field empties on screen now, and the store, React
    // and the bridge follow once this frame is on the compositor. So the bubble, the key and the
    // glide are already moving there when the work they set off (the composer and the conversation
    // re-rendering, a session mounting) takes the main thread.
    if (ta) ta.value = '';
    sent.current = draft;
    await afterFrame();
    // Typed in since (onChange let go of the hold): the field's words are a new message, whatever they say.
    const typed = sent.current !== draft;
    if (sent.current === draft) sent.current = null;
    const now = useStore.getState().drafts[key];
    // Words typed meanwhile stay, and files attached meanwhile; the sent words and their own files
    // go (restore.ts). Until the bridge answers, the message is kept beside the field (pending.ts):
    // a reload brings it back, a refusal puts it back in the order it was sent.
    const left = leaveField(now, draft, typed);
    const pending = holdSend(key, draft);
    setDraft(key, left);
    if (!left.text) pendingCaret.current = 0;
    setRecall(null);
    // Refused: the words fly back into the field and are put back there, with their files (before
    // anything typed or attached since).
    const giveBack = async () => {
      await flight?.settle(false);
      // The next placeholder may still be rising under the words.
      card.current?.querySelector('.cmp-roll')?.remove();
      card.current?.removeAttribute('data-rolling');
      setDraft(key, sendBack(pending, useStore.getState().drafts[key]));
      pendingCaret.current = draft.text.length;
    };
    if (sessionId) {
      const res = await sendMessage(sessionId, out.text, out.attachments, { submitId: pending.id, ...(steer && busy ? { steer: true } : {}) });
      if (res.ok) {
        sendDone(pending);
        void flight?.settle(true);
      } else await giveBack();
      return;
    }
    const res = await startFromHome(out.text, out.attachments, {
      submitId: pending.id,
      choice,
      // The chat exists and is about to open: the drop in the air and what home holds now are its.
      onCreated: (id) => {
        flight?.scope(id);
        bindHandoff(id);
        moveSend(pending, id);
      },
    });
    if (res.ok) {
      sendDone(pending);
      void flight?.settle(true);
      return;
    }
    cancelHandoff();
    if (!res.sessionId) {
      await giveBack();
      return;
    }
    // The chat was made and is open, and only the message was refused: home has gone, so the words
    // go back into that chat's field (a retry sends them there), merged with what is there already.
    flight?.release();
    const st = useStore.getState();
    st.setDraft(res.sessionId, sendBack(pending, st.drafts[res.sessionId], res.sessionId));
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const onSend = useCallback((steer: boolean) => void submitRef.current(steer), []);
  const onStop = useCallback(() => sessionId && void interrupt(sessionId), [sessionId]);

  // ── the queue ──

  /**
   * Edit puts a queued message back into the composer. With a draft already there, the two swap:
   * the draft takes the message's place in the queue, so nothing typed is lost.
   */
  const editQueued = useCallback(
    async (q: QueuedMessage) => {
      if (!sessionId) return;
      const d = useStore.getState().drafts[key];
      const before = { text: d?.text ?? '', attachments: d?.attachments ?? EMPTY };
      let got: QueuedMessage | null = q;
      if (before.text.trim() || before.attachments.length) {
        const out = parcel(before.text.trim(), before.attachments);
        // The agent may have taken the message meanwhile: then nothing swaps and the draft stays.
        const res = await updateQueued(sessionId, q.id, out.text, out.attachments);
        if (!res.ok) return;
        // The message as the bridge had it when the draft took its place: another window may have
        // edited it after this one showed it, and that edit is what comes into the field.
        got = res.previous ?? q;
      } else got = await takeQueued(sessionId, q.id);
      if (!got) return;
      // What was typed or attached while the bridge answered stays, after the message.
      const next = swapIn(useStore.getState().drafts[key], before, { text: got.text, attachments: got.attachments ?? EMPTY });
      setDraft(key, { attachments: next.attachments });
      setText(next.text, got.text.length);
      setRecall(null);
      window.requestAnimationFrame(focus);
    },
    [sessionId, key, setDraft, setText, focus],
  );

  // ── ultracode ──

  const toggleUltra = useCallback(
    (on: boolean) => {
      // Home keeps the choice in the store at once: nothing to wait for.
      if (!sessionId) return setHomeUltracode(on);
      const seq = ++ultraSeq.current;
      setUltraPick({ on, over: !on, seq, session: sessionId });
      // Taken or refused, the session's own value is the truth from the answer on.
      void setUltracode(sessionId, on).then(() => setUltraPick((p) => ultraAnswered(p, seq)));
    },
    [sessionId],
  );

  const userTexts = () => {
    const d = sessionId ? useStore.getState().data[sessionId] : undefined;
    if (!d) return [];
    const out: string[] = [];
    for (const id of d.roots) {
      const it = d.items[id];
      if (it?.type !== 'user' || !it.text.trim()) continue;
      // What Claude Code wrote into the conversation comes back only as the command the person typed.
      const s = syntheticOf(it);
      if (s) {
        if (s.role === 'command') out.push(syntheticLine(s));
        continue;
      }
      out.push(stripWrappers(it.text));
    }
    return out;
  };

  const cycleMode = () => {
    const modes = caps?.modes ?? [];
    if (modes.length < 2) return;
    const i = modes.findIndex((m) => m.id === choice.mode?.id);
    choice.setMode(modes[(i + 1) % modes.length].id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = MAC ? e.metaKey : e.ctrlKey;
    const ta = e.currentTarget;

    if (menuOpen) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
        e.preventDefault();
        setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % rows.length : (a - 1 + rows.length) % rows.length));
        return;
      }
      const row = rows[active];
      // A command or skill typed out in full sends on Enter (Tab still completes it).
      const typedOut = e.key === 'Enter' && sendWithEnter && !!row && row.kind !== 'app' && trigger?.kind !== 'mention' && trigger?.query === row.name;
      if (((e.key === 'Enter' && !e.shiftKey && !mod) || (e.key === 'Tab' && !e.shiftKey)) && row && !typedOut) {
        e.preventDefault();
        accept(row);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(trigKey);
        return;
      }
    }

    if (e.key === 'Tab' && e.shiftKey && !mod) {
      e.preventDefault();
      cycleMode();
      return;
    }
    if (e.key === 'Tab' && !mod && ghost) {
      e.preventDefault();
      setText(ghost);
      return;
    }
    if (e.key === 'Enter') {
      if (variant === 'session' && busy && !shell) {
        // While a turn runs: the send keys queue, the same keys with the modifier steer.
        const steerKeys = sendWithEnter ? mod && !e.shiftKey : mod && e.shiftKey;
        const queueKeys = sendWithEnter ? !mod && !e.shiftKey : mod && !e.shiftKey;
        if (steerKeys || queueKeys) {
          e.preventDefault();
          void submit(steerKeys && steerable);
        }
        return;
      }
      const send = sendWithEnter ? !e.shiftKey || mod : mod;
      if (send) {
        e.preventDefault();
        void submit();
      }
      return;
    }
    if (variant === 'session' && !e.shiftKey && !mod && !e.altKey) {
      // The last queued message comes back into the field for editing before history recall.
      if (e.key === 'ArrowUp' && text === '' && !attachments.length && recall === null && queue.length && sessionId) {
        e.preventDefault();
        void editQueued(queue[queue.length - 1]);
        return;
      }
      if (e.key === 'ArrowUp' && (text === '' || recall !== null) && !text.slice(0, ta.selectionStart).includes('\n')) {
        const list = userTexts();
        const next = recall === null ? 0 : recall + 1;
        if (next < list.length) {
          e.preventDefault();
          setRecall(next);
          setText(list[list.length - 1 - next]);
        }
        return;
      }
      if (e.key === 'ArrowDown' && recall !== null && !text.slice(ta.selectionEnd).includes('\n')) {
        e.preventDefault();
        const list = userTexts();
        if (recall <= 0) {
          setRecall(null);
          setText('');
        } else {
          setRecall(recall - 1);
          setText(list[list.length - recall] ?? '');
        }
      }
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    // Typed right after a send: these words are the next message (submit leaves them be).
    sent.current = null;
    pendingCaret.current = null;
    setDraft(key, { text: e.target.value });
    setCaret(e.target.selectionStart);
    if (recall !== null) setRecall(null);
  };

  const queueing = variant === 'session' && busy && !shell;
  // The bar stands complete in the first frame of a chat that opens: its placeholder from the
  // session itself (above), its mode, model and effort from the session and the agent's last
  // known answer (choice.ts, caps-seen.ts). Nothing waits for the conversation to load.
  const placeholder = ghost || (shell && text === '!') ? '' : variant === 'home' ? (signedOut ? `Sign in to ${PROVIDER_NAME[homeAgent]} to start` : 'Describe a task or ask a question') : queueing ? 'Queue a follow-up' : fresh ? 'Describe a task or ask a question' : 'Reply';

  return (
    <div className="composer" data-variant={variant}>
      {menuOpen && (
        <SuggestMenu
          id={listId}
          anchor={card}
          rows={rows}
          active={active}
          placement={variant === 'home' ? 'down' : 'up'}
          originX={originX}
          loading={trigger?.kind === 'mention' && filesLoading}
          empty={trigger?.kind === 'mention' ? 'No file matches.' : trigger?.kind === 'skill' ? 'No skill matches.' : 'No command matches. Enter sends it to the agent.'}
          onHover={setActive}
          onPick={(i) => {
            accept(rows[i]);
            focus();
          }}
        />
      )}

      {variant === 'session' && sessionId && <UntilStrip sessionId={sessionId} />}
      {variant === 'session' && sessionId && <SpareStrip sessionId={sessionId} />}
      {variant === 'session' && sessionId && <CustomStrip sessionId={sessionId} />}
      {variant === 'session' && sessionId && <ReviewBar sessionId={sessionId} />}
      {variant === 'session' && sessionId && <QueueTray sessionId={sessionId} queue={queue} running={busy} steerable={steerable} onEdit={editQueued} onFocusComposer={focus} />}

      <div
        ref={card}
        className="cmp-card"
        data-spot
        data-ultra={ultraLook || undefined}
        data-shell={shell || undefined}
        data-empty={!text && !attachments.length ? '' : undefined}
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t.classList.contains('cmp-bar') || t.classList.contains('cmp-side')) {
            e.preventDefault();
            focus();
          }
        }}
      >
        <CoveSkin />
        {attachments.length > 0 && <AttachmentRow items={attachments} onRemove={removeAttachment} />}

        <div className="cmp-field">
          <Highlight ref={hl} text={ghost ? '' : text} caps={caps} sessionId={sessionId} shell={shell} />
          <textarea
            ref={ref}
            className="cmp-input"
            data-composer=""
            value={text}
            rows={1}
            placeholder={placeholder}
            aria-label={variant === 'home' ? 'Describe a task' : queueing ? 'Queue a follow-up' : 'Message'}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={menuOpen && rows.length ? `${listId}-${active}` : undefined}
            spellCheck={false}
            onChange={onChange}
            onSelect={(e) => !sent.current && setCaret(e.currentTarget.selectionStart)}
            onScroll={syncHighlight}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const list = [...e.clipboardData.files];
              if (!list.length) return;
              e.preventDefault();
              void addFiles(list);
            }}
            onFocus={() => {
              focusedRef.current = true;
              if (trigger) bumpFocus();
            }}
            onBlur={() => {
              focusedRef.current = false;
              if (trigger) bumpFocus();
            }}
          />
          <textarea ref={mirror} className="cmp-input cmp-mirror" rows={1} tabIndex={-1} readOnly aria-hidden />
          {ghost && (
            <div className="cmp-ghost" data-still={ghost === bornWith || undefined} aria-hidden>
              <span className="cmp-ghost-text">{ghost}</span>
            </div>
          )}
          {shell && text === '!' && (
            <div className="cmp-ghost" aria-hidden>
              <span className="cmp-ghost-pre">!</span> Run a shell command in the terminal
            </div>
          )}
        </div>

        <div className="cmp-bar">
          <div className="cmp-side">
            {shell ? (
              <span className="cmp-shell" key="shell">
                <Icon name="prompt" size={13} />
                Shell
              </span>
            ) : (
              <>
                <AttachMenu images={images} side={popSide} onAdd={pickFiles} onMention={mentionStable} />
                <ModeMenu choice={choice} side={popSide} onClosed={focus} />
              </>
            )}
          </div>
          <div className="cmp-side cmp-right">
            <div className="cmp-agent" inert={shell || undefined}>
              <ModelPopover choice={choice} side={popSide} onClosed={focus} />
              <ModelEffort choice={choice} side={popSide} onClosed={focus} ultraOffered={ultraOffered} ultracode={ultra} onUltracode={toggleUltra} />
            </div>
          </div>
        </div>

        {/* The key is no part of the pane: it rests in the cove the pane's corner makes for it. */}
        <SendKey
          canSend={canSend}
          busy={busy}
          showStop={showStop}
          steerable={steerable}
          sendWithEnter={sendWithEnter}
          shell={shell}
          stoppable={variant === 'session' && !!sessionId}
          onSend={onSend}
          onStop={onStop}
        />

        <UltraEdge on={ultraLook} card={card} />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      {dropping && <StageDrop host={dropHost} images={images} />}
      {variant === 'home' && <HomeChips onClosed={focus} />}
    </div>
  );
});
