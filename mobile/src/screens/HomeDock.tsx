import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { matchModel, type ModelInfo } from '@shared/protocol';
import { baseName } from '@desk/lib/format';
import { pushBack } from '@m/lib/back';
import { conn } from '@m/lib/conn';
import { dropFlight, launchFlight } from '@m/lib/flight';
import { onKeyboard } from '@m/lib/keyboard';
import { fit } from '@m/lib/fit';
import { haptic, isNative } from '@m/lib/native';
import { nav } from '@m/lib/nav';
import { openFrom } from '@m/lib/open';
import { applySnapshot, setState, useStore } from '@m/lib/store';
import { Icon } from '@m/ui/icons';
import { PROVIDER_NAME, ProviderMark, SHORT_NAME } from '@m/ui/marks';
import { SNAP } from '@m/ui/motion';
import { effortName } from '@desk/lib/models';
import { AgentSheet, createChat, FolderSheet, useNewChat } from './NewChat';
import { MODE_ICON, SetupSheet, type SetupState } from './Setup';

const DRAFT = 'sable.newdraft';

/**
 * New chat, as on the desktop's home: the prompt bar itself. At rest one line of frosted glass over
 * the field; touched, it opens (the agent, the folder and the model as chips over the words) and
 * rides up with the keyboard. Send starts the chat on the desktop, and the bar becomes the chat:
 * the conversation opens out of it and the words fly to their place.
 */
export function HomeDock({ covered }: { covered: boolean }) {
  const online = useStore((s) => s.conn === 'open');
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(DRAFT) ?? '';
    } catch {
      return '';
    }
  });
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<'agent' | 'folder' | 'setup' | null>(null);
  const [busy, setBusy] = useState(false);
  const c = useNewChat(focused || !!sheet || !!text);
  const dock = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const sendKey = useRef<HTMLButtonElement>(null);
  const open = focused || !!text.trim() || !!sheet;

  const size = () => fit(area.current, 150);
  useEffect(size, []);
  const update = (v: string) => {
    setText(v);
    try {
      if (v.trim()) localStorage.setItem(DRAFT, v);
      else localStorage.removeItem(DRAFT);
    } catch {
      /* private mode */
    }
    requestAnimationFrame(size);
  };

  // "New chat" from the app icon's shortcuts: the bar opens, focused, with the keyboard up.
  useEffect(() => {
    const go = () => {
      area.current?.focus();
      if (isNative) void import('@capacitor/keyboard').then((k) => k.Keyboard.show()).catch(() => {});
    };
    window.addEventListener('sable:newchat', go);
    return () => window.removeEventListener('sable:newchat', go);
  }, []);

  // The keyboard put away: the field lets go too.
  useEffect(() => onKeyboard((lift, prev) => lift === 0 && prev > 0 && document.activeElement === area.current && area.current?.blur()), []);
  useEffect(() => (focused ? pushBack(() => (area.current?.blur(), true)) : undefined), [focused]);

  const send = async () => {
    const t = text.trim();
    if (!t || !online || busy || !c.agent) return;
    // `/model <name>` picks the new chat's model (bare `/model` opens the choices): nothing starts.
    const cmd = /^\/model(?:\s+([\s\S]*))?$/i.exec(t);
    if (cmd) {
      const name = (cmd[1] ?? '').trim();
      update('');
      if (!name) return void (haptic('tap'), area.current?.blur(), setSheet('setup'));
      const m = matchModel(name, c.models as ModelInfo[]);
      if (m) {
        haptic('select');
        c.setModel(m.id);
        setState({ toast: { text: `Model set to ${m.name}`, level: 'success', at: Date.now() } });
      } else {
        haptic('deny');
        update(t);
        setState({ toast: { text: `No model called “${name}”`, level: 'error', at: Date.now() } });
      }
      return;
    }
    setBusy(true);
    // The words drain into the bar's corner and leave as a drop (lib/flight.ts); it waits above the
    // bar while the chat is made, then rises into the conversation that opens out of the bar.
    const el = area.current;
    const at = performance.now();
    if (el && dock.current) launchFlight(t, el, dock.current);
    else haptic('tap');
    update('');
    try {
      const snap = await createChat(c, t);
      applySnapshot(snap);
      openFrom(snap.session.id, dock.current, 26);
      // The bar holds still until the drop has left its edge.
      window.setTimeout(() => area.current?.blur(), Math.max(0, 200 - (performance.now() - at)));
      nav.chat(snap.session.id);
      // The message goes once the chat is there (it may have opened in a fresh folder named after it).
      await conn.call('session.send', { sessionId: snap.session.id, text: t });
    } catch (err) {
      dropFlight();
      haptic('deny');
      if (!area.current?.value) update(t);
      setState({ toast: { text: (err as Error).message, level: 'error', at: Date.now() } });
    } finally {
      setBusy(false);
    }
  };

  const folderLabel = c.folder === null ? 'No folder' : c.folder ? baseName(c.folder) : 'Folder';
  const modelLabel = c.models.find((m) => m.id === c.model)?.name;
  const mode = c.modes.find((m) => m.id === c.mode);
  const setup: SetupState = {
    agent: c.agent ?? undefined,
    models: c.models,
    model: c.model,
    onModel: c.setModel,
    efforts: c.efforts,
    effort: c.effort,
    onEffort: c.setEffort,
    speeds: c.speeds,
    speed: c.speed,
    onSpeed: c.setSpeed,
    modes: c.modes,
    mode: c.mode,
    onMode: c.setMode,
  };

  return (
    <>
      <AnimatePresence>
        {focused && (
          <motion.div
            className="dock-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onPointerDown={(e) => {
              e.preventDefault();
              area.current?.blur();
            }}
          />
        )}
      </AnimatePresence>
      {/* The words keep their place whether the bar is open or not, and the key stays in its corner: opening only grows the row of choices under the words. */}
      <div className="home-dock" ref={dock} data-open={open || undefined} data-focus={focused || undefined} data-covered={covered || undefined} onClick={() => area.current?.focus()}>
        <div className="dock-line">
          {c.agent && (
            <button
              type="button"
              className="dock-agent"
              aria-label={`Agent: ${PROVIDER_NAME[c.agent]}`}
              aria-expanded={sheet === 'agent'}
              tabIndex={open ? 0 : -1}
              onPointerDown={(e) => open && e.preventDefault()}
              onClick={(e) => {
                if (!open) return;
                e.stopPropagation();
                haptic('tap');
                setSheet('agent');
              }}
            >
              <ProviderMark provider={c.agent} size={17} />
            </button>
          )}
          <textarea
            ref={area}
            className="dock-input"
            rows={1}
            value={text}
            placeholder={open && c.agent ? `Ask ${SHORT_NAME[c.agent]}` : 'New chat'}
            disabled={!online && !text}
            onChange={(e) => update(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label="New chat"
            enterKeyHint="send"
          />
        </div>
        <AnimatePresence initial={false}>
          {open && c.agent && (
            <motion.div className="dock-bar-wrap" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={SNAP}>
              <div className="dock-bar no-drag">
                <button type="button" className="where-chip" aria-expanded={sheet === 'folder'} onPointerDown={(e) => e.preventDefault()} onClick={(e) => (e.stopPropagation(), haptic('tap'), setSheet('folder'))}>
                  <Icon name={c.folder === null ? 'chat' : 'folder'} size={15} />
                  <span>{folderLabel}</span>
                </button>
                {(modelLabel || mode) && (
                  <button
                    type="button"
                    className="setup-chip"
                    aria-expanded={sheet === 'setup'}
                    aria-label={`${modelLabel ?? ''}${c.effort && c.efforts.length > 1 ? `, ${effortName(c.effort)}` : ''}${mode ? `, ${mode.name}` : ''}`}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={(e) => (e.stopPropagation(), haptic('tap'), setSheet('setup'))}
                  >
                    {mode && <Icon name={MODE_ICON[mode.tone] ?? 'hand'} size={15} className="setup-chip-mode" />}
                    {modelLabel && <span className="setup-chip-model">{modelLabel}</span>}
                    {c.effort && c.efforts.length > 1 && <span className="setup-chip-dim">{effortName(c.effort)}</span>}
                    <Icon name="updown" size={12} weight="bold" className="setup-chip-caret" />
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <button
          ref={sendKey}
          type="button"
          className="send dock-send"
          aria-label={open ? 'Start chat' : 'New chat'}
          disabled={open && (!text.trim() || !online || busy || !c.agent)}
          data-busy={busy || undefined}
          data-rest={!open || undefined}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            if (!open) return area.current?.focus();
            void send();
          }}
        >
          {busy ? (
            <span className="send-wait" />
          ) : (
            <motion.span className="send-glyph" animate={{ rotate: open ? 0 : 90 }} transition={SNAP}>
              <Icon name={open ? 'up' : 'plus'} size={18} weight="bold" />
            </motion.span>
          )}
        </button>
      </div>
      <AgentSheet open={sheet === 'agent'} onClose={() => setSheet(null)} c={c} />
      <FolderSheet open={sheet === 'folder'} onClose={() => setSheet(null)} c={c} />
      <SetupSheet open={sheet === 'setup'} onClose={() => setSheet(null)} s={setup} />
    </>
  );
}
