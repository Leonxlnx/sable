import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STANDARD_SPEED, type Attachment, type ProviderId, type ProviderInfo, type QueuedMessage, type SessionMeta } from '@shared/protocol';
import { offeredSpeeds, speedFor } from '@shared/speed';
import { effortName, modelName, modelNameById, visibleModels } from '@desk/lib/models';
import { conn } from '@m/lib/conn';
import { claimFlight, dropFlight, inFlight, launchFlight } from '@m/lib/flight';
import { autoSized, fit } from '@m/lib/fit';
import { onKeyboard } from '@m/lib/keyboard';
import { onPutDraft } from '@m/lib/put-draft';
import { haptic } from '@m/lib/native';
import { ensureFolderCaps, getState, intend, sessionData, setState, undoIntent, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME } from '@m/ui/marks';
import { reduced, SNAP } from '@m/ui/motion';
import { MODE_ICON, SetupSheet, type SetupState } from './Setup';

/** Unsent words per chat, kept across restarts (Android may close the app in the background). */
const DRAFTS = 'sable.drafts';
const drafts = new Map<string, string>(
  (() => {
    try {
      return Object.entries(JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string>);
    } catch {
      return [];
    }
  })(),
);
let saveTimer = 0;
const saveDrafts = () => {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const o: Record<string, string> = {};
      for (const [k, v] of drafts) if (v.trim()) o[k] = v;
      localStorage.setItem(DRAFTS, JSON.stringify(o));
    } catch {
      /* private mode */
    }
  }, 400);
};

/**
 * A message whose send was cut off by a lost connection may or may not have reached the desktop.
 * It goes back into the field; when the conversation reloads and shows it arrived, the field clears
 * again (so it is never lost and never sent twice).
 */
const unsure = new Map<string, { text: string; at: number }>();
const LOST = /connection to the desktop was lost|did not answer in time/i;

/** The agents a chat can switch to, in the desktop's order. */
const AGENTS: ProviderId[] = ['claude', 'codex', 'opencode'];
const signedIn = (p: ProviderInfo | undefined) => !!p?.installed && (p.accounts?.length ? p.accounts.some((a) => a.auth.loggedIn) : !!p.auth?.loggedIn);
/** `/model <name>` typed as a message: picks the model (or switches the agent), never sent. */
const MODEL_CMD = /^\/model(?:\s+([\s\S]*))?$/i;
const toast = (text: string, level: 'info' | 'success' | 'error' = 'info') => setState({ toast: { text, level, at: Date.now() } });
/** The key's glyph changing (send to stop and back): quick, settled, the key itself never moves. */
const GLYPH = { type: 'spring', stiffness: 620, damping: 40 } as const;

/**
 * The composer: the desktop's frosted prompt bar at hand size. Send (an ivory disc), stop while a
 * turn runs, messages sent mid-turn wait in the queue above it (steer one in with its arrow). The
 * permission mode is one chip; the model with its effort and speed another. It rides up with the
 * keyboard on the keyboard's own curve (`--kb`, lib/keyboard.ts).
 */
export function Composer({ sid }: { sid: string }) {
  const s = useStore((st) => st.sessions[sid]);
  // A chat whose agent is not running has no caps of its own: the agent's for that folder fill the controls.
  const sessionCaps = useStore((st) => sessionData(st, sid).caps);
  const folderCaps = useStore((st) => {
    const ss = st.sessions[sid];
    return ss ? st.caps[`${ss.provider}:${ss.cwd}`] : undefined;
  });
  const caps = sessionCaps ?? folderCaps;
  const queue = useStore((st) => sessionData(st, sid).queue);
  const visibility = useStore((st) => st.settings?.modelVisibility);
  const providers = useStore((st) => st.providers);
  const allCaps = useStore((st) => st.caps);
  const sendWithEnter = useStore((st) => st.settings?.sendWithEnter !== false);
  const [text, setText] = useState(() => drafts.get(sid) ?? '');
  const online = useStore((st) => st.conn === 'open');
  // The newest message of yours, to settle a send the connection cut off.
  const lastUser = useStore((st) => {
    const d = st.data[sid];
    if (!d) return undefined;
    for (let i = d.roots.length - 1; i >= 0; i--) {
      const it = d.items[d.roots[i]];
      if (it?.type === 'user') return it;
    }
    return undefined;
  });
  const [files, setFiles] = useState<Attachment[]>([]);
  const [sheet, setSheet] = useState(false);
  const [focused, setFocused] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendKey = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const u = unsure.get(sid);
    if (!u || !lastUser || lastUser.type !== 'user') return;
    if (lastUser.text.trim() === u.text && lastUser.ts >= u.at - 15_000) {
      unsure.delete(sid);
      if (area.current && area.current.value.trim() === u.text) {
        setText('');
        drafts.set(sid, '');
        saveDrafts();
        area.current.style.height = '';
        fit(area.current, 168);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUser, sid]);

  useEffect(() => {
    if (!sessionCaps && !folderCaps && s && online) ensureFolderCaps(s.provider, s.cwd, s.accountId);
  }, [sessionCaps, folderCaps, s?.provider, s?.cwd, s?.accountId, online]);

  // The setup sheet lists the other agents' models: asked for once per agent and folder as it opens.
  useEffect(() => {
    if (!sheet || !s || !online) return;
    const ps = getState().providers;
    for (const p of AGENTS) if (p !== s.provider && signedIn(ps[p])) ensureFolderCaps(p, s.cwd);
  }, [sheet, s?.provider, s?.cwd, online]);

  // The keyboard put away (back, the keyboard's own key): the field lets go too, so it does not stay lifted.
  useEffect(() => onKeyboard((lift, prev) => lift === 0 && prev > 0 && document.activeElement === area.current && area.current?.blur()), []);

  // Words put here from the chat (a check's findings): into the field, ready to edit and send.
  useEffect(
    () =>
      onPutDraft(sid, (t) => {
        setText(t);
        drafts.set(sid, t);
        saveDrafts();
        const el = area.current;
        if (!el) return;
        el.value = t;
        fit(el, 168);
        el.focus();
      }),
    [sid],
  );

  // The field takes the height of a draft that came back from storage.
  useEffect(() => {
    if (area.current?.value) fit(area.current, 168);
  }, []);

  if (!s) return null;

  const running = s.status === 'running' || s.status === 'starting' || s.status === 'awaiting';
  const empty = !text.trim() && !files.length;
  const stopping = running && empty;
  const model = caps?.models.find((m) => m.id === s.model);
  const models = caps ? visibleModels(s.provider, caps.models, visibility, s.model) : [];
  const mode = caps?.modes.find((m) => m.id === s.mode);
  const efforts = model?.efforts ?? [];
  const effort = s.effort ?? model?.defaultEffort;
  const speeds = offeredSpeeds(model, false);
  const speed = speedFor(model, s.speed);
  const modelLabel = modelName(model) ?? modelNameById(s.model, caps?.models) ?? 'Model';
  const away = AGENTS.filter((p) => p !== s.provider && signedIn(providers[p]));
  // Every choice shows at once (the store holds it against older answers) and goes back if the desktop refuses it.
  const choose = <K extends 'model' | 'effort' | 'speed' | 'mode'>(key: K, value: SessionMeta[K], call: () => Promise<unknown>) => {
    const was = { [key]: s[key] } as Partial<SessionMeta>;
    intend(sid, { [key]: value } as Partial<SessionMeta>);
    void call().catch((err) => {
      undoIntent(sid, was);
      haptic('deny');
      toast((err as Error).message, 'error');
    });
  };
  const setup: SetupState = {
    agent: s.provider,
    models: models.map((m) => ({ id: m.id, name: modelName(m) ?? m.name })),
    model: s.model,
    onModel: (id) => choose('model', id, () => conn.call('session.setModel', { sessionId: sid, model: id })),
    efforts,
    effort,
    onEffort: (e) => choose('effort', e, () => conn.call('session.setEffort', { sessionId: sid, effort: e })),
    speeds: speeds.length ? [{ id: STANDARD_SPEED, name: 'Standard' }, ...speeds.map((x) => ({ id: x.id, name: x.name }))] : [],
    speed,
    onSpeed: (v) => choose('speed', v, () => conn.call('session.setSpeed', { sessionId: sid, speed: v })),
    modes: caps?.modes ?? [],
    mode: s.mode,
    onMode: (id) => choose('mode', id, () => conn.call('session.setMode', { sessionId: sid, mode: id })),
    // The other agents' models: picking one switches this chat to that agent, in place.
    others: away.map((p) => {
      const c = allCaps[`${p}:${s.cwd}`];
      return { provider: p, models: c ? visibleModels(p, c.models, visibility).map((m) => ({ id: m.id, name: modelName(m) ?? m.name })) : null };
    }),
    othersOff: running || !online,
    onOther: (provider, id) => {
      setSheet(false);
      void conn.call('session.switchAgent', { sessionId: sid, provider, model: id }).catch((err) => {
        haptic('deny');
        toast((err as Error).message, 'error');
      });
    },
  };

  const update = (v: string, hold = false) => {
    setText(v);
    drafts.set(sid, v);
    saveDrafts();
    const el = area.current;
    if (!el) return;
    if (hold) {
      // The bar holds still while the bead forms on its edge, then gathers to one line.
      const h = el.offsetHeight;
      el.style.height = `${h}px`;
      window.setTimeout(() => {
        if (el.value) return void ((el.style.height = ''), fit(el, 168));
        // Its height with nothing in it (measured once, here), then it glides there.
        el.style.height = autoSized ? '' : 'auto';
        const to = autoSized ? el.offsetHeight : Math.min(el.scrollHeight, 168);
        if (Math.abs(to - h) < 2) return void (el.style.height = autoSized ? '' : `${to}px`);
        el.style.height = `${h}px`;
        void el.offsetHeight;
        el.style.transition = 'height 240ms cubic-bezier(0.2, 0.8, 0.2, 1)';
        el.style.height = `${to}px`;
        window.setTimeout(() => {
          el.style.transition = '';
          if (autoSized) el.style.height = '';
        }, 260);
      }, 290);
      return;
    }
    fit(el, 168);
  };

  /** `/model <name>`: the bridge picks the model, or switches the chat to the agent that has it; nothing is sent. Bare `/model` opens the sheet. */
  const modelCommand = async (t: string, name: string) => {
    update('');
    if (!name) {
      haptic('tap');
      area.current?.blur();
      setSheet(true);
      return;
    }
    haptic('select');
    try {
      const r = await conn.call('session.send', { sessionId: sid, text: t });
      if (!r.ok) {
        haptic('deny');
        update(t);
        return toast(r.error ?? 'No such model', 'error');
      }
      const st = getState();
      const p = r.switched ?? st.sessions[sid]?.provider ?? s.provider;
      const list = sessionData(st, sid).caps?.models ?? st.caps[`${p}:${s.cwd}`]?.models;
      const name2 = (r.model && modelNameById(r.model, list)) ?? r.model ?? '';
      toast(r.switched ? `Switched to ${PROVIDER_NAME[r.switched]}${name2 ? `, ${name2}` : ''}` : `Model set to ${name2}`, 'success');
    } catch (err) {
      haptic('deny');
      update(t);
      toast((err as Error).message, 'error');
    }
  };

  const send = async () => {
    const t = text.trim();
    if ((!t && !files.length) || !online) return;
    const cmd = files.length ? null : MODEL_CMD.exec(t);
    if (cmd) return modelCommand(t, (cmd[1] ?? '').trim());
    const el = area.current;
    const bar = el?.closest<HTMLElement>('.composer');
    // The words drain into the bar's corner and leave as a drop (lib/flight.ts: the tick comes at the break).
    if (el && bar && t) launchFlight(t, el, bar);
    else haptic('tap');
    const attachments = files.length ? files : undefined;
    update('', true);
    setFiles([]);
    try {
      await conn.call('session.send', { sessionId: sid, text: t, attachments });
    } catch (err) {
      const msg = (err as Error).message;
      dropFlight();
      haptic('deny');
      update(t);
      setFiles(attachments ?? []);
      if (LOST.test(msg)) unsure.set(sid, { text: t, at: Date.now() });
      setState({ toast: { text: LOST.test(msg) ? 'The connection dropped while sending' : msg, level: 'error', at: Date.now() } });
    }
  };

  const stop = () => {
    haptic('warning');
    void conn.call('session.interrupt', { sessionId: sid }).catch(() => {});
  };

  const pick = async (list: FileList | null) => {
    if (!list) return;
    const next: Attachment[] = [];
    for (const f of Array.from(list).slice(0, 6)) {
      if (f.size > 8 * 1024 * 1024) continue;
      const dataUrl = await shrink(f);
      next.push({ id: crypto.randomUUID(), kind: 'image', name: f.name || 'Photo', dataUrl, mime: dataUrl.slice(5, dataUrl.indexOf(';')), size: Math.round((dataUrl.length * 3) / 4) });
    }
    setFiles((cur) => [...cur, ...next]);
  };

  return (
    <div className="composer-dock">
      <QueueTray sid={sid} queue={queue} />
      <div className="composer" data-focus={focused || undefined} onClick={(e) => e.target === e.currentTarget && area.current?.focus()}>
        <AnimatePresence initial={false}>
          {files.length > 0 && (
            <motion.div className="attach-row" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SNAP}>
              {files.map((f) => (
                <motion.span key={f.id} className="attach" layout initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SNAP}>
                  <img src={f.dataUrl} alt={f.name} />
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => (haptic('tap'), setFiles((cur) => cur.filter((x) => x.id !== f.id)))}>
                    <Icon name="x" size={12} weight="bold" />
                  </button>
                </motion.span>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <textarea
          ref={area}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={running ? 'Queue a follow-up' : 'Message'}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends (the keyboard shows a send key); Shift+Enter, or Enter with "Send with Enter" off on the desktop, is a new line.
            if (e.key === 'Enter' && !e.shiftKey && sendWithEnter && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-label="Message"
          enterKeyHint="send"
        />
        <div className="composer-bar">
          {caps?.features.images !== false && (
            <>
              <button type="button" className="tool-key" aria-label="Add a photo" onPointerDown={(e) => e.preventDefault()} onClick={() => (haptic('tap'), fileInput.current?.click())}>
                <Icon name="plus" size={19} />
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
            </>
          )}
          {(model || s.model || mode) && (
            <button
              type="button"
              className="setup-chip"
              aria-expanded={sheet}
              aria-haspopup="dialog"
              aria-label={`${modelLabel}${effort && efforts.length ? `, ${effortName(effort)}` : ''}${mode ? `, ${mode.name}` : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => (haptic('tap'), setSheet(true))}
            >
              {mode && <Icon name={MODE_ICON[mode.tone] ?? 'hand'} size={15} className="setup-chip-mode" />}
              <span className="setup-chip-model">{modelLabel}</span>
              {effort && efforts.length > 1 && <span className="setup-chip-dim">{effortName(effort)}</span>}
              <Icon name="updown" size={12} weight="bold" className="setup-chip-caret" />
            </button>
          )}
          <span className="bar-gap" />
          {/* One key that stays where it is: send, or stop while a turn runs and the field is empty. Only its glyph changes. */}
          <button
            ref={sendKey}
            type="button"
            className="send"
            data-stop={stopping || undefined}
            aria-label={stopping ? 'Stop' : running ? 'Queue' : 'Send'}
            disabled={!stopping && (empty || !online)}
            onPointerDown={(e) => !stopping && e.preventDefault()}
            onClick={stopping ? stop : () => void send()}
          >
            <AnimatePresence initial={false}>
              {stopping ? (
                <motion.span key="stop" className="stop-square" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={reduced() ? { duration: 0 } : GLYPH} />
              ) : (
                <motion.span key="send" className="send-glyph" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={reduced() ? { duration: 0 } : GLYPH}>
                  <Icon name="up" size={18} weight="bold" />
                </motion.span>
              )}
            </AnimatePresence>
          </button>
        </div>
      </div>

      <SetupSheet open={sheet} onClose={() => setSheet(false)} s={setup} />
    </div>
  );
}

/** Messages sent while the agent works: they go out when the turn ends, or now with the arrow (steered in). */
function QueueTray({ sid, queue }: { sid: string; queue: QueuedMessage[] }) {
  return (
    <div className="queue">
      <AnimatePresence initial={false}>
        {queue.map((q) => (
          <QueueRow key={q.id} sid={sid} q={q} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** One waiting message; a row its words are flying into lands as liquid instead of rising in. */
function QueueRow({ sid, q }: { sid: string; q: QueuedMessage }) {
  const ref = useRef<HTMLDivElement>(null);
  const [liquid] = useState(() => inFlight(q.text));
  useLayoutEffect(() => {
    if (liquid && ref.current) claimFlight(q.text, ref.current, 'row');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
          <motion.div
            ref={ref}
            className="queued glass-liquid"
            layout
            initial={liquid ? false : { opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 0.97, transition: { duration: 0.18 } }}
            transition={SNAP}
          >
            <span className="queued-text">{q.text || 'Photo'}</span>
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Send now"
              onClick={() => {
                haptic('send');
                void conn.call('queue.sendNow', { sessionId: sid, id: q.id }).catch(() => {});
              }}
            >
              <Icon name="steer" size={17} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              aria-label="Remove"
              onClick={() => {
                haptic('tap');
                void conn.call('queue.remove', { sessionId: sid, id: q.id }).catch(() => {});
              }}
            >
              <Icon name="x" size={15} />
            </button>
          </motion.div>
  );
}

/** Photos go to the desktop as data URLs: at most 1600 px on the long side, JPEG. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}
