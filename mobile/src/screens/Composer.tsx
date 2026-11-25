import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STANDARD_SPEED, type Attachment, type ProviderId, type ProviderInfo, type QueuedMessage, type SessionMeta } from '@shared/protocol';
import { offeredSpeeds, speedFor } from '@shared/speed';
import { effortName, modelName, modelNameById, visibleModels } from '@desk/lib/models';
import { rowActs, rowDelivery } from '@desk/features/composer/queue-rows';
import { conn } from '@m/lib/conn';
import { claimFlight, dropFlight, inFlight, launchFlight } from '@m/lib/flight';
import { autoSized, fit } from '@m/lib/fit';
import { onKeyboard } from '@m/lib/keyboard';
import { onPutDraft } from '@m/lib/put-draft';
import { notSentHere, sentHere } from '@m/lib/follow';
import { getDraft, onDraft, pendingTakes, setDraft, settleTaken, stageTaken } from '@m/lib/drafts';
import { epoch, still } from '@m/lib/epoch';
import { confirmTake, STILL_QUEUED, takeBack, type TakeDeps } from '@m/lib/take';
import { haptic } from '@m/lib/native';
import { acceptIntent, closeGap, ensureFolderCaps, getState, intend, sessionData, setState, undoIntent, unsureIntent, useStore } from '@m/lib/store';
import { isUncertain } from '@m/lib/errors';
import { shownPermissions } from '@m/lib/shown';
import { confirmKept, draftChanged, filesKey, submissionDone, submissionFor, submissionUnsure } from '@m/lib/submit';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME } from '@m/ui/marks';
import { reduced, SNAP } from '@m/ui/motion';
import { ModeChip, ModeSheet, ModelPhrase, ModelSheet, type SetupState } from './Setup';

/**
 * A message whose send was cut off by a lost connection may or may not have reached the desktop.
 * It goes back into the field with the id it was sent under (lib/submit.ts): a retry carries the same
 * id, so it is never sent twice, and the field clears again only on that id's receipt (the desktop's
 * yes to a question under that id, asked once connected again), never because a message of the same
 * words turned up. Unsent words per chat: lib/drafts.ts; the sends it cut off forget themselves with
 * the computer (lib/submit.ts).
 */
const LOST = /connection to the desktop was lost|did not answer in time/i;

/** Words taken back from the queue: kept on the phone before the desktop lets the message go (lib/take.ts). */
const takes: TakeDeps = {
  take: (sid, id) => conn.call('queue.take', { sessionId: sid, id, ack: true }),
  done: (take, kept) => conn.call('phone.takeDone', { take, kept }),
  stage: stageTaken,
  settle: settleTaken,
};
// Receipts a cut connection left unanswered: confirmed once connected again (the desktop answers each the same however often).
const confirmPending = () => void pendingTakes().then((list) => list.forEach((t) => void confirmTake(takes, t)));
conn.onOpen(confirmPending);
if (conn.state === 'open') confirmPending();

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
  const [text, setText] = useState(() => getDraft(sid));
  const online = useStore((st) => st.conn === 'open');
  const [files, setFiles] = useState<Attachment[]>([]);
  const filesNow = useRef(files);
  filesNow.current = files;
  const [sheet, setSheet] = useState<'model' | 'mode' | null>(null);
  const [focused, setFocused] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendKey = useRef<HTMLButtonElement>(null);
  // A send the connection cut off is asked about once connected again, by its own id (the desktop's
  // `session.submission` sends nothing). Its yes is the receipt: the words put back in the field go
  // again, when they are still exactly what was sent. A no leaves them for the retry.
  useEffect(() => {
    if (!online) return;
    const e = epoch();
    void confirmKept(sid, (submitId) => conn.call('session.submission', { sessionId: sid, submitId })).then((got) => {
      const el = area.current;
      if (!still(e) || !el) return;
      if (!got.some((sub) => el.value.trim() === sub.text && filesKey(filesNow.current) === sub.files)) return;
      setText('');
      setDraft(sid, '');
      setFiles([]);
      el.style.height = '';
      fit(el, 168);
    });
  }, [online, sid]);

  // A send kept for a retry belongs to the field's words as they were put back: edited, it is let go.
  useEffect(() => draftChanged(sid, text, files), [sid, text, files]);

  useEffect(() => {
    if (!sessionCaps && !folderCaps && s && online) ensureFolderCaps(s.provider, s.cwd, s.accountId);
  }, [sessionCaps, folderCaps, s?.provider, s?.cwd, s?.accountId, online]);

  // The setup sheet lists the other agents' models: asked for once per agent and folder as it opens.
  useEffect(() => {
    if (sheet !== 'model' || !s || !online) return;
    const ps = getState().providers;
    for (const p of AGENTS) if (p !== s.provider && signedIn(ps[p])) ensureFolderCaps(p, s.cwd);
  }, [sheet, s?.provider, s?.cwd, online]);

  // The keyboard put away (back, the keyboard's own key): the field lets go too, so it does not stay lifted.
  useEffect(() => onKeyboard((lift, prev) => lift === 0 && prev > 0 && document.activeElement === area.current && area.current?.blur()), []);

  // Words put here from the chat (a check's findings, a queued message taken back): into the field, ready to edit and send.
  useEffect(
    () =>
      onPutDraft(sid, (words, append) => {
        const had = area.current?.value ?? '';
        const t = append && had.trim() ? `${had.trimEnd()}\n${words}` : words;
        setText(t);
        setDraft(sid, t);
        const el = area.current;
        if (!el) return;
        el.value = t;
        fit(el, 168);
        el.focus();
      }),
    [sid],
  );

  // The draft changed from elsewhere (words taken back from the queue, recovered at a start): the field
  // shows it at once, so what is typed next goes on from it and never writes an older text over it.
  useEffect(
    () =>
      onDraft(sid, (t, why) => {
        setText(t);
        const el = area.current;
        if (!el) return;
        el.value = t;
        fit(el, 168);
        if (why === 'taken') el.focus();
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
  // Every choice shows at once (the store holds it against older answers). Accepted, it is the field's
  // truth; refused, the field goes back to what the desktop last said, but only for the newest choice
  // of that field (an older one failing late changes nothing: lib/intents.ts), however late the
  // refusal comes. No answer at all (a timeout, the connection gone): the desktop is asked what it is.
  const choose = <K extends 'model' | 'effort' | 'speed' | 'mode'>(key: K, value: SessionMeta[K], call: () => Promise<unknown>) => {
    const gen = intend(sid, key, value);
    void call().then(
      () => acceptIntent(sid, key, value, gen),
      (err) => {
        if (isUncertain(err)) {
          if (unsureIntent(sid, key, gen)) toast('The desktop did not answer. It shows what the chat uses now.', 'error');
          return;
        }
        if (!undoIntent(sid, key, gen)) return;
        haptic('deny');
        toast((err as Error).message, 'error');
      },
    );
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
    // With the permission cards this phone showed (lib/shown.ts), read at the tap: a mode that never
    // asks answers those and no other.
    onMode: (id) => choose('mode', id, () => conn.call('session.setMode', { sessionId: sid, mode: id, shownPermissions: shownPermissions(sid, sessionData(getState(), sid).permissions) })),
    // The other agents' models: picking one switches this chat to that agent, in place.
    others: away.map((p) => {
      const c = allCaps[`${p}:${s.cwd}`];
      return { provider: p, models: c ? visibleModels(p, c.models, visibility).map((m) => ({ id: m.id, name: modelName(m) ?? m.name })) : null };
    }),
    othersOff: running || !online,
    onOther: (provider, id) => {
      setSheet(null);
      void conn.call('session.switchAgent', { sessionId: sid, provider, model: id }).catch((err) => {
        haptic('deny');
        toast((err as Error).message, 'error');
      });
    },
  };

  const update = (v: string, hold = false) => {
    setText(v);
    setDraft(sid, v);
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
      setSheet('model');
      return;
    }
    haptic('select');
    const e = epoch();
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
      // Forgotten meanwhile: the words belonged to that computer; nothing goes back.
      if (!still(e)) return;
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
    // Opened far back (a search hit): the chat goes to its newest, where the message lands.
    void closeGap(sid).catch(() => {});
    const e = epoch();
    // The conversation follows this message to the end (lib/follow.ts); not when the desktop queues it.
    sentHere(sid);
    // Its id, made with the words and files before the first request; a retry of a send the connection
    // cut off gets the id it was sent under (lib/submit.ts).
    const sub = submissionFor(sid, t, attachments);
    try {
      const r = await conn.call('session.send', { sessionId: sid, text: t, attachments, submitId: sub.id });
      submissionDone(sid, sub.id);
      if (r.queued || !r.ok) notSentHere(sid);
    } catch (err) {
      notSentHere(sid);
      const msg = (err as Error).message;
      dropFlight();
      // Forgotten (or replaced by another computer) while it went: its words are not put back.
      if (!still(e)) return;
      // Cut off: kept with its id for the retry. Refused: the desktop forgot it too.
      if (LOST.test(msg)) submissionUnsure(sid, sub.id);
      else submissionDone(sid, sub.id);
      haptic('deny');
      update(t);
      setFiles(attachments ?? []);
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
                <Icon name="plus" size={20} />
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ''))} />
            </>
          )}
          <ModeChip mode={mode} open={sheet === 'mode'} onOpen={() => setSheet('mode')} />
          <span className="bar-gap" />
          <ModelPhrase model={model || s.model ? modelLabel : undefined} effort={effort && efforts.length > 1 ? effortName(effort) : undefined} open={sheet === 'model'} onOpen={() => setSheet('model')} />
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

      <ModelSheet open={sheet === 'model'} onClose={() => setSheet(null)} s={setup} />
      <ModeSheet open={sheet === 'mode'} onClose={() => setSheet(null)} s={setup} />
    </div>
  );
}

/** Messages sent while the agent works: they go out when the turn ends, or now with the arrow (steered in). */
function QueueTray({ sid, queue }: { sid: string; queue: QueuedMessage[] }) {
  // A long queue comes as its first page: the rest is counted, and stays on the desktop in order.
  const total = useStore((st) => sessionData(st, sid).queueTotal ?? 0);
  return (
    <div className="queue">
      <AnimatePresence initial={false}>
        {queue.map((q) => (
          <QueueRow key={q.id} sid={sid} q={q} />
        ))}
      </AnimatePresence>
      {total > queue.length && <p className="queue-more num">{total - queue.length} more queued on the desktop</p>}
    </div>
  );
}

/**
 * One waiting message; a row its words are flying into lands as liquid instead of rising in. A tap on
 * its words takes it back into the field to edit (`queue.take`; one with pictures stays: the phone does
 * not hold their data). A take the desktop refuses (too long to send back) says so and leaves it queued.
 * A message whose delivery is not known (the desktop's `rowDelivery`: it will not send it by itself)
 * says the desktop's reason under its words, and its two keys are "Send again" and "Discard".
 */
function QueueRow({ sid, q }: { sid: string; q: QueuedMessage }) {
  const ref = useRef<HTMLDivElement>(null);
  const [liquid] = useState(() => inFlight(q.text));
  const [taking, setTaking] = useState(false);
  useLayoutEffect(() => {
    if (liquid && ref.current) claimFlight(q.text, ref.current, 'row');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const editable = !q.attachments?.length && !!q.text;
  const delivery = rowDelivery(q);
  const acts = rowActs(delivery, false);
  const words = delivery.reason ? (
    <>
      <span>{q.text || 'Photo'}</span>
      <span className="queued-why">{delivery.reason}</span>
    </>
  ) : (
    q.text || 'Photo'
  );
  const take = () => {
    if (taking) return;
    haptic('tap');
    setTaking(true);
    const e = epoch();
    // The words go into the chat's draft (and its field) as they are kept on the phone, before the
    // desktop lets the message go (lib/take.ts, lib/drafts.ts): nothing more to put here once it answers.
    void takeBack(takes, sid, q.id)
      .then(
        (r) => {
          if (!r.text || !still(e)) return;
          if (r.stillQueued) toast(STILL_QUEUED);
        },
        (err) => {
          if (!still(e)) return;
          haptic('deny');
          toast((err as Error).message, 'error');
        },
      )
      .finally(() => setTaking(false));
  };
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
            {editable ? (
              <button type="button" className="queued-text" aria-label={`Edit: ${q.text.slice(0, 80)}${delivery.reason ? `. ${delivery.reason}` : ''}`} data-why={delivery.reason ? '' : undefined} data-busy={taking || undefined} onClick={take}>
                {words}
              </button>
            ) : (
              <span className="queued-text" data-why={delivery.reason ? '' : undefined}>{words}</span>
            )}
            <button
              type="button"
              className="icon-btn sm"
              aria-label={acts.send}
              onClick={() => {
                haptic('send');
                sentHere(sid);
                // Refused (the desktop took the entry meanwhile) or failed: no message of this phone's is coming.
                void conn.call('queue.sendNow', { sessionId: sid, id: q.id }).then(
                  (r) => {
                    if (!(r as { ok?: boolean } | undefined)?.ok) notSentHere(sid);
                  },
                  () => notSentHere(sid),
                );
              }}
            >
              <Icon name="steer" size={18} />
            </button>
            <button
              type="button"
              className="icon-btn sm"
              aria-label={acts.remove}
              onClick={() => {
                haptic('tap');
                void conn.call('queue.remove', { sessionId: sid, id: q.id }).catch(() => {});
              }}
            >
              <Icon name="x" size={16} />
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
