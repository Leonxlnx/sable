import { useRef, type CSSProperties } from 'react';
import type { Todo } from '@shared/protocol';
import { Ring } from '@/art/Logo';
import { Icon } from '@/icons';
import { useStore } from '@/state/store';
import { LeaveList } from './leave';
import { useArrivals } from './util';

const NO_TODOS: Todo[] = [];

export function useOpenTaskCount(sessionId: string): number {
  return useStore((s) => (s.data[sessionId]?.todos ?? NO_TODOS).filter((t) => t.status !== 'completed').length);
}

/** The agent's task list for this session. Sub-agents have their own tab (Agents). */
export function TasksTab({ sessionId }: { sessionId: string }) {
  const todos = useStore((s) => s.data[sessionId]?.todos) ?? NO_TODOS;
  const keys = todos.map((t, i) => t.id ?? String(i));
  const arrived = useArrivals(keys);
  // Tasks finished while the list was on screen: their mark closes and the tick draws itself, once.
  const was = useRef<Map<string, string> | null>(null);
  const ticked = useRef(new Set<string>());
  if (was.current) todos.forEach((t, i) => t.status === 'completed' && was.current!.has(keys[i]) && was.current!.get(keys[i]) !== 'completed' && ticked.current.add(keys[i]));
  was.current = new Map(todos.map((t, i) => [keys[i], t.status]));

  if (!todos.length) {
    return (
      <div className="rail-scroll scroll">
        <p className="rail-empty">No tasks in this session yet.</p>
      </div>
    );
  }

  const done = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="rail-col">
      <div className="rail-bar">
        {/* The bar as on every list pane: what it is, then its figure. */}
        <span className="rail-bar-title">Tasks</span>
        <span className="rail-bar-meta num">
          {done} of {todos.length}
        </span>
        <span className="tk-progress meter" role="progressbar" aria-valuemin={0} aria-valuemax={todos.length} aria-valuenow={done} aria-label="Tasks done">
          <span className="meter-fill" style={{ '--p': done / todos.length } as CSSProperties} />
        </span>
      </div>
      <div className="rail-scroll scroll">
        <div className="rail-stack tk-stack">
          <section className="tk-section" aria-label="Tasks">
            <LeaveList className="tk-list" order={keys.join('|')}>
              {todos.map((t, i) => (
                <div role="listitem" data-flip={keys[i]} key={keys[i]} className="tk-item" data-status={t.status} data-new={arrived.has(keys[i]) || undefined}>
                  <span className="tk-mark" aria-hidden data-ai-play={(t.status === 'completed' && ticked.current.has(keys[i])) || undefined}>
                    {t.status === 'completed' ? <Icon name="check" size={10} /> : t.status === 'in_progress' ? <Ring size={10} /> : null}
                  </span>
                  <span className="tk-text">{t.status === 'in_progress' ? <span className="shimmer">{t.activeForm || t.content}</span> : t.content}</span>
                  <span className="sr-only">{t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in progress' : 'pending'}</span>
                </div>
              ))}
            </LeaveList>
          </section>
        </div>
      </div>
    </div>
  );
}
