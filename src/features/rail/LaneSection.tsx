import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LaneForecast, SessionLane } from '@shared/protocol';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { useStore } from '@/state/store';
import { IconButton, PathLabel, Spinner, Tip } from '@/ui';
import { LaneGlyph } from '@/features/session/LaneMark';
import { discardLane, landLane, laneName, openLaneFolder, refreshLane, useLaneForecast } from '@/features/session/lane';
import { useRepo } from './git-state';

/** Unsent land messages by lane, so switching tabs or sessions keeps them. */
const drafts = new Map<string, string>();
const MAX_LIST = 6;
const MAX_LINES = 3;

/**
 * The Changes tab's foot for a chat in a lane: where the lane would land and whether it lands
 * cleanly there (a dry merge the bridge runs when the tree changes), the conflicting files when
 * it does not, and Land, Open lane folder and Discard lane. Land commits what the lane has
 * uncommitted first, with the message in the field.
 */
export function LaneSection({ sessionId, lane, cwd }: { sessionId: string; lane: SessionLane; cwd: string }) {
  const entry = useLaneForecast(sessionId, lane.path);
  const f = entry?.forecast;
  const working = useStore((s) => {
    const m = s.sessions[sessionId];
    return m?.status === 'running' || m?.status === 'starting' || m?.status === 'awaiting' || !!m?.background || !!m?.commands;
  });
  const title = useStore((s) => s.sessions[sessionId]?.title ?? '');
  const [message, setMessage] = useState(() => drafts.get(lane.path) ?? '');
  const [busy, setBusy] = useState<'land' | 'discard' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // The tree changed (a refresh of the Changes list): the forecast follows, a moment later.
  const rev = useRepo(cwd)?.rev ?? 0;
  useEffect(() => {
    if (!rev) return;
    const t = window.setTimeout(() => void refreshLane(sessionId), 300);
    return () => window.clearTimeout(t);
  }, [rev, sessionId]);

  // One line, growing to three, then scrolling.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const max = (parseFloat(cs.lineHeight) || 19) * MAX_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [message, f?.uncommitted]);

  const update = (text: string) => {
    setMessage(text);
    if (text) drafts.set(lane.path, text);
    else drafts.delete(lane.path);
    if (error) setError(null);
  };

  const canLand = f?.state === 'clean' && !working && !busy;
  const land = async () => {
    if (!canLand) return;
    setBusy('land');
    setError(null);
    const res = await landLane(sessionId, message.trim() || title);
    setBusy(null);
    // The conversation says where it landed; the header's mark folds back into the branch.
    if (res.ok) {
      drafts.delete(lane.path);
      if (useStore.getState().sessions[sessionId]?.lane?.path === lane.path) void refreshLane(sessionId);
    } else setError(res.error ?? 'Could not land the lane.');
  };
  const discard = async () => {
    if (working || busy) return;
    setBusy('discard');
    setError(null);
    const res = await discardLane(sessionId);
    setBusy(null);
    setConfirm(false);
    if (!res.ok) setError(res.error ?? 'Could not discard the lane.');
    else drafts.delete(lane.path);
  };

  const target = f?.target ?? lane.from ?? 'the branch';
  const list = f?.state === 'conflicts' ? f.conflicts : f?.state === 'blocked' ? f.blocked : [];
  return (
    <section className="lane-box" aria-label={`Lane ${lane.branch}`} data-state={f?.state}>
      <div className="lane-head">
        <LaneGlyph size={14} />
        <Tip label={lane.branch}>
          <span className="lane-branch truncate">{laneName(lane.branch)}</span>
        </Tip>
        {lane.from && <span className="lane-from truncate">from {lane.from}</span>}
        <span className="lane-head-end">
          {!!f?.ahead && (
            <Tip label={`${plural(f.ahead, 'commit')} not on ${target}`}>
              <span className="lane-ab num">
                <Icon name="arrow-up" size={10} />
                {f.ahead}
              </span>
            </Tip>
          )}
          {!!f?.behind && (
            <Tip label={`${plural(f.behind, 'commit')} on ${target} since the lane began`}>
              <span className="lane-ab num">
                <Icon name="arrow-down" size={10} />
                {f.behind}
              </span>
            </Tip>
          )}
          <IconButton icon="folder-open" label="Open lane folder" size={14} onClick={() => void openLaneFolder(sessionId)} />
        </span>
      </div>

      <LaneVerdict forecast={f} loading={!!entry?.loading} target={target} folder={lane.folder} />
      {list.length > 0 && (
        <ul className="lane-files">
          {list.slice(0, MAX_LIST).map((p) => (
            <li key={p}>
              <PathLabel path={p} />
            </li>
          ))}
          {list.length > MAX_LIST && <li className="lane-more">{plural(list.length - MAX_LIST, 'more file')}</li>}
        </ul>
      )}

      {confirm ? (
        <div className="lane-actions lane-confirm" data-escape-scope role="group" aria-label="Discard lane" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setConfirm(false))}>
          <span className="lane-confirm-text">Discard {laneName(lane.branch)} and its work?</span>
          <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={working || !!busy} onClick={() => void discard()}>
            {busy === 'discard' ? <Spinner size={12} /> : <Icon name="trash" size={14} />}
            Discard
          </button>
        </div>
      ) : (
        <form
          className="lane-land"
          onSubmit={(e) => {
            e.preventDefault();
            void land();
          }}
        >
          {!!f?.uncommitted && f.state === 'clean' && (
            <textarea
              ref={area}
              className="field ch-commit-field lane-message scroll"
              rows={1}
              value={message}
              placeholder={title || 'Commit message'}
              aria-label="Commit message for the uncommitted edits"
              spellCheck
              disabled={!!busy}
              onChange={(e) => update(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void land();
                }
              }}
            />
          )}
          <div className="lane-actions">
            <button type="button" className="btn btn-sm btn-ghost" disabled={working || !!busy} onClick={() => setConfirm(true)}>
              Discard lane
            </button>
            <Tip label={working ? 'Wait for the agent to finish before landing' : f?.uncommitted ? `Commits ${plural(f.uncommitted, 'file')}, then lands on ${target}` : `Lands on ${target}`} keys="mod+enter" side="top">
              <button type="submit" className="btn btn-sm btn-primary lane-land-btn" disabled={!canLand} aria-disabled={!canLand}>
                {busy === 'land' && <Spinner size={12} />}
                Land on {target}
              </button>
            </Tip>
          </div>
        </form>
      )}
      {error && (
        <p className="ch-commit-error" role="alert">
          <Icon name="warning" size={13} />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

/** One line: where the lane stands against the folder's branch. */
function LaneVerdict({ forecast: f, loading, target, folder }: { forecast?: LaneForecast; loading: boolean; target: string; folder: string }) {
  if (!f) {
    return (
      <p className="lane-verdict" data-state="loading">
        <Spinner size={12} />
        Checking against {target}
      </p>
    );
  }
  const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const [icon, text] =
    f.state === 'clean'
      ? (['check', `Lands cleanly on ${target}`] as const)
      : f.state === 'conflicts'
        ? (['warning', `${plural(f.conflicts.length, 'file')} ${f.conflicts.length === 1 ? 'conflicts' : 'conflict'} with ${target}`] as const)
        : f.state === 'blocked'
          ? (['warning', `${plural(f.blocked.length, 'file')} ${f.blocked.length === 1 ? 'has' : 'have'} uncommitted edits in ${name}`] as const)
          : f.state === 'nothing'
            ? (['circle', 'Nothing to land yet'] as const)
            : (['warning', f.reason ?? 'Could not check the lane'] as const);
  return (
    <p className="lane-verdict" data-state={f.state} data-loading={loading || undefined} aria-live="polite">
      <Icon name={icon} size={13} />
      <span className="truncate">{text}</span>
      {f.files > 0 && (
        <span className="lane-stat num">
          {f.additions > 0 && <span className="dv-add">+{f.additions.toLocaleString('en-US')}</span>}
          {f.deletions > 0 && <span className="dv-del">−{f.deletions.toLocaleString('en-US')}</span>}
          <span>{plural(f.files, 'file')}</span>
        </span>
      )}
    </p>
  );
}
