import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { AnimatePresence, Reorder, useDragControls, useReducedMotion } from 'motion/react';
import type { SavedPrompt } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { removePrompt, reorderPrompts, savePrompt, updatePrompt, usePromptsLoaded, useSavedPrompts } from '@/features/saved/prompts-store';
import { IconButton } from '@/ui';
import { Empty, Skeleton } from './parts';
import './saved-prompts.css';

/**
 * Settings › Prompts: the prompts saved from the palette (or written here), in the order the palette
 * and the `/` menu list them. A row opens in place: its name becomes a field and its text unfolds
 * below (saved as a field is left, and when it closes); rows are dragged into order (or moved with
 * Alt+Up and Alt+Down); deleting asks once, in the row.
 */

/** Rows making room and settling after a drag. */
const ROW = { type: 'spring' as const, stiffness: 520, damping: 38 };

const firstLine = (t: string) => (t.split('\n').find((l) => l.trim()) ?? '').trim();

export function SavedPrompts() {
  const prompts = useSavedPrompts();
  const loaded = usePromptsLoaded();
  const reduced = !!useReducedMotion();
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // While a row is dragged the order is local; it goes to the bridge when the row is dropped.
  const [order, setOrder] = useState(prompts);
  const dragging = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!dragging.current) setOrder(prompts);
  }, [prompts]);

  const live = new Map(prompts.map((p) => [p.id, p]));
  const rows = order.filter((p) => live.has(p.id)).map((p) => live.get(p.id)!);
  for (const p of prompts) if (!rows.some((r) => r.id === p.id)) rows.push(p);
  const shown = useRef(rows);
  shown.current = rows;

  const commit = (next: SavedPrompt[]) => {
    const ids = next.map((p) => p.id);
    if (ids.join() !== prompts.map((p) => p.id).join()) void reorderPrompts(ids);
  };

  const focusRow = (i: number) =>
    requestAnimationFrame(() => {
      const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-sp-row]') ?? [])];
      els[Math.max(0, Math.min(i, els.length - 1))]?.focus();
    });

  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
    commit(next);
    focusRow(j);
  };

  return (
    <div className="set-stack sp">
      <div className="set-toolbar">
        {loaded && prompts.length > 0 && <span className="set-context num">{plural(prompts.length, 'prompt')}</span>}
        <span className="grow" />
        <button
          type="button"
          className="btn btn-sm"
          disabled={creating}
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
        >
          <Icon name="plus" size={14} />
          New prompt
        </button>
      </div>

      <div className="card set-card sp-card" data-spot>
        <Collapse open={creating}>
          <NewPrompt onDone={() => setCreating(false)} />
        </Collapse>
        {!loaded ? (
          <Skeleton rows={2} />
        ) : !rows.length ? (
          !creating && <Empty>Prompts you save show here.</Empty>
        ) : (
          <Reorder.Group as="ul" axis="y" values={rows} onReorder={setOrder} className="sp-list" ref={listRef} role="list" aria-label="Saved prompts" data-after-new={creating || undefined}>
            <AnimatePresence initial={false}>
              {rows.map((p, i) => (
                <PromptRow
                  key={p.id}
                  prompt={p}
                  index={i}
                  count={rows.length}
                  open={editing === p.id}
                  reduced={reduced}
                  onOpen={() => {
                    setCreating(false);
                    setEditing(p.id);
                  }}
                  onClose={() => {
                    setEditing(null);
                    focusRow(i);
                  }}
                  onDragStart={() => (dragging.current = true)}
                  onDragEnd={() => {
                    dragging.current = false;
                    commit(shown.current);
                  }}
                  onMove={(by) => move(i, by)}
                  onFocusRow={(by) => focusRow(i + by)}
                  onRemoved={() => {
                    setEditing(null);
                    focusRow(i);
                  }}
                />
              ))}
            </AnimatePresence>
          </Reorder.Group>
        )}
      </div>
    </div>
  );
}

/** The text field: it grows with what it holds, within bounds. */
function useGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(320, Math.max(92, ta.scrollHeight + 2))}px`;
  }, [ref, value]);
}

interface RowProps {
  prompt: SavedPrompt;
  index: number;
  count: number;
  open: boolean;
  reduced: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (by: -1 | 1) => void;
  onFocusRow: (by: -1 | 1) => void;
  onRemoved: () => void;
}

function PromptRow({ prompt: p, index, count, open, reduced, onOpen, onClose, onDragStart, onDragEnd, onMove, onFocusRow, onRemoved }: RowProps) {
  const controls = useDragControls();
  const [lifted, setLifted] = useState(false);
  /** Delete asks once: in the row, or in the open row's foot. */
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(p.name);
  const [text, setText] = useState(p.text);
  const nameRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useGrow(textRef, open ? text : '');

  // Closed, the fields follow the prompt (a change from elsewhere); opened, the name takes focus.
  useEffect(() => {
    if (!open) {
      setName(p.name);
      setText(p.text);
    }
  }, [open, p.name, p.text]);
  useLayoutEffect(() => {
    if (!open) return;
    setConfirm(false);
    nameRef.current?.focus({ preventScroll: true });
    nameRef.current?.select();
  }, [open]);

  /** Keeps what was typed (an emptied name keeps the old one; an emptied text is not saved). */
  const save = () => {
    const n = name.trim() || p.name;
    if (text.trim() && (n !== p.name || text !== p.text)) void updatePrompt(p.id, { name: n, text });
  };
  const close = () => {
    save();
    onClose();
  };
  const remove = () => {
    void removePrompt(p.id);
    onRemoved();
  };

  const grab = (e: ReactPointerEvent) => {
    if (e.button !== 0 || open || confirm || (e.target as HTMLElement).closest('button, input, textarea')) return;
    controls.start(e);
  };

  const onRowKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && confirm) {
      e.stopPropagation();
      setConfirm(false);
      return;
    }
    if (open || e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      onMove(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      onFocusRow(e.key === 'ArrowUp' ? -1 : 1);
    } else if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      onOpen();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setConfirm(true);
    }
  };

  return (
    <Reorder.Item
      as="li"
      value={p}
      dragListener={false}
      dragControls={controls}
      layout="position"
      className="sp-item"
      data-lifted={lifted || undefined}
      data-open={open || undefined}
      data-escape-scope={open || confirm ? '' : undefined}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, transition: { opacity: { duration: 0.08 }, height: ROW } }}
      transition={reduced ? { duration: 0.12, layout: { duration: 0 } } : { opacity: { duration: 0.12 }, y: ROW, layout: ROW }}
      whileDrag={reduced ? undefined : { scale: 1.01 }}
      onDragStart={() => {
        setLifted(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setLifted(false);
        onDragEnd();
      }}
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          e.stopPropagation();
          if (confirm) setConfirm(false);
          else close();
        } else if (open && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          close();
        }
      }}
    >
      <div
        className="sp-row"
        data-sp-row
        tabIndex={open ? -1 : 0}
        role={open ? undefined : 'button'}
        aria-label={open ? undefined : `${p.name}, prompt ${index + 1} of ${count}. Enter edits it, Alt+Arrow keys move it.`}
        data-confirm={(confirm && !open) || undefined}
        onPointerDown={grab}
        onClick={(e) => !open && !confirm && !(e.target as HTMLElement).closest('button') && onOpen()}
        onKeyDown={onRowKey}
      >
        {open ? (
          <input
            ref={nameRef}
            className="sp-name-field"
            value={name}
            placeholder={p.name}
            aria-label="Name"
            maxLength={80}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                textRef.current?.focus();
              }
            }}
          />
        ) : (
          <>
            <span className="sp-name truncate">{p.name}</span>
            <span className="sp-text truncate">{firstLine(p.text)}</span>
          </>
        )}
        {!open &&
          (confirm ? (
            <span className="sp-confirm">
              <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-sm btn-danger" onClick={remove}>
                <Icon name="trash" size={14} />
                Delete
              </button>
            </span>
          ) : (
            <span className="sp-actions">
              <IconButton icon="pencil" label="Edit" size={14} tabIndex={-1} onClick={onOpen} />
              <IconButton icon="trash" label="Delete" size={14} tabIndex={-1} onClick={() => setConfirm(true)} />
            </span>
          ))}
      </div>
      <Collapse open={open}>
        <div className="sp-body">
          <textarea ref={textRef} className="field sp-field-text scroll" value={text} placeholder="What the prompt says" aria-label="Text" spellCheck onChange={(e) => setText(e.target.value)} onBlur={save} />
          <div className="sp-foot">
            {confirm ? (
              <>
                <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={remove}>
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-sm btn-ghost sp-delete" onClick={() => setConfirm(true)}>
                Delete
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn btn-sm" onClick={close}>
              Done
            </button>
          </div>
        </div>
      </Collapse>
    </Reorder.Item>
  );
}

/** A prompt written here: its name (made from the text when left empty) and its text, saved with Save. */
function NewPrompt({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useGrow(textRef, text);
  useLayoutEffect(() => {
    textRef.current?.focus({ preventScroll: true });
  }, []);
  const canSave = !!text.trim() && !busy;
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    const p = await savePrompt(name.trim(), text);
    setBusy(false);
    if (p) onDone();
  };
  return (
    <div
      className="sp-new"
      data-escape-scope=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <div className="sp-row" data-new>
        <input
          className="sp-name-field"
          value={name}
          placeholder="Name"
          aria-label="Name"
          maxLength={80}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              textRef.current?.focus();
            }
          }}
        />
      </div>
      <div className="sp-body">
        <textarea ref={textRef} className="field sp-field-text scroll" value={text} placeholder="What the prompt says" aria-label="Text" spellCheck onChange={(e) => setText(e.target.value)} />
        <div className="sp-foot">
          <span className="grow" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!canSave} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
