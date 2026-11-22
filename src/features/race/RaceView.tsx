import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { FileDiff, LaneForecast, ProviderId } from '@shared/protocol';
import { PROVIDER_NAME, ProviderMark, Tiles } from '@/art/Logo';
import { DiffView } from '@/components/DiffView';
import { CoveSkin } from '@/features/composer/Cove';
import { putBack } from '@/features/composer/restore';
import { SendKey } from '@/features/composer/SendKey';
import { PromptDock } from '@/features/prompts/PromptDock';
import { useLaneForecast } from '@/features/session/lane';
import { Timeline } from '@/features/timeline/Timeline';
import { shortDuration, useTick } from '@/features/timeline/util';
import { Icon } from '@/icons';
import { plural } from '@/lib/format';
import { modelName, modelNameById } from '@/lib/models';
import { interrupt, openSession, sendMessage } from '@/state/actions';
import { useStore, type Store } from '@/state/store';
import { IconButton, PathLabel, Segmented, Spinner, Tip, cx } from '@/ui';
import { compareRows, discardRace, keepRace, raceDraftKey, raceTarget, retryTarget, setRaceTarget, stepCount, totals, useRaceDiff, useRacePair, type RaceTarget } from './race';
import '@/features/composer/composer.css';
import './race.css';

type Side = 0 | 1;
type Target = RaceTarget;

/** How a side reads: its agent (or, when both sides are one agent, its model) and its mark. */
function useSideNames(ids: [string, string]): { provider: ProviderId; label: string; model: string }[] {
  const key = useStore((s) =>
    ids
      .map((id) => {
        const m = s.sessions[id];
        const models = s.data[id]?.caps?.models;
        const model = m?.model ? modelNameById(m.model, models) : modelName(models?.find((x) => x.isDefault));
        return `${m?.provider ?? 'demo'}\u0001${model ?? ''}`;
      })
      .join('\u0000'),
  );
  return useMemo(() => {
    const sides = key.split('\u0000').map((part) => {
      const [provider, model] = part.split('\u0001');
      return { provider: provider as ProviderId, model };
    });
    const same = sides[0].provider === sides[1].provider;
    return sides.map((s) => ({ ...s, label: same ? s.model || PROVIDER_NAME[s.provider] : PROVIDER_NAME[s.provider] }));
  }, [key]);
}

/**
 * Race: one task, two agents, side by side. Each column is its chat (the conversation as it reads
 * in the chat itself: the live line while it works, the summary and the answer after), with the
 * lane's changed files and "Keep this one" at its foot. "Changes" compares the two lanes file by
 * file. The composer sends a follow-up to both, or to one. Keeping one lands its lane and
 * discards the other; nothing is landed or discarded without that click and its confirmation.
 */
export function RaceView({ raceId }: { raceId: string }) {
  const pair = useRacePair(raceId);
  const [mode, setMode] = useState<'chats' | 'changes'>('chats');
  // The target is kept with the race (a retry aimed at the lane that refused survives leaving the view).
  const [target, setTargetState] = useState<Target>(() => raceTarget(raceId));
  const setTarget = useCallback(
    (t: Target) => {
      setRaceTarget(raceId, t);
      setTargetState(t);
    },
    [raceId],
  );
  if (!pair) return null;
  return <RaceBody key={raceId} raceId={raceId} pair={pair} mode={mode} setMode={setMode} target={target} setTarget={setTarget} />;
}

function RaceBody({ raceId, pair, mode, setMode, target, setTarget }: { raceId: string; pair: [string, string]; mode: 'chats' | 'changes'; setMode: (m: 'chats' | 'changes') => void; target: Target; setTarget: (t: Target) => void }) {
  const names = useSideNames(pair);
  const outcomes = useStore((s) => pair.map((id) => s.sessions[id]?.race?.outcome ?? '').join('|'));
  const [a, b] = outcomes.split('|');
  const decided = !!a && !!b;
  const field = useRef<HTMLTextAreaElement>(null);
  const reply = useCallback(
    (side: Side) => {
      setTarget(String(side) as Target);
      requestAnimationFrame(() => field.current?.focus());
    },
    [setTarget],
  );
  return (
    <div className="race" data-mode={mode} data-decided={decided || undefined}>
      <RaceBar pair={pair} names={names} mode={mode} setMode={setMode} outcomes={[a, b]} />
      <div className="race-stage">
        {mode === 'chats' ? (
          <div className="race-cols">
            {pair.map((id, i) => (
              <RaceColumn key={id} id={id} rival={pair[1 - i]} side={i as Side} name={names[i]} rivalName={names[1 - i].label} onReply={decided ? undefined : reply} />
            ))}
          </div>
        ) : (
          <RaceCompare pair={pair} names={names} />
        )}
      </div>
      {!decided && <RaceDock raceId={raceId} pair={pair} names={names} target={target} setTarget={setTarget} field={field} />}
    </div>
  );
}

// ─────────────────────────────── the bar ───────────────────────────────

function RaceBar({ pair, names, mode, setMode, outcomes }: { pair: [string, string]; names: { label: string }[]; mode: 'chats' | 'changes'; setMode: (m: 'chats' | 'changes') => void; outcomes: string[] }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decided = !!outcomes[0] && !!outcomes[1];
  const kept = outcomes.indexOf('kept');
  const discard = async () => {
    setBusy(true);
    setError(null);
    const res = await discardRace(pair[0], pair[1]);
    setBusy(false);
    setConfirm(false);
    if (!res.ok) setError(res.error ?? 'Could not remove the lanes.');
  };
  return (
    <div className="race-bar">
      <Segmented
        id="race-mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'chats', label: 'Chats' },
          { value: 'changes', label: 'Changes' },
        ]}
      />
      <div className="race-bar-end">
        {error && (
          <span className="race-error" role="alert">
            <Icon name="warning" size={13} />
            <span className="truncate">{error}</span>
          </span>
        )}
        {decided ? (
          <span className="race-result" role="status">
            <Icon name={kept >= 0 ? 'check' : 'trash'} size={13} />
            {kept >= 0 ? `Landed ${names[kept].label}` : 'Lanes removed'}
            {kept >= 0 && (
              <button type="button" className="btn btn-sm" onClick={() => openSession(pair[kept])}>
                Open chat
              </button>
            )}
          </span>
        ) : confirm ? (
          <div className="race-confirm" role="group" aria-label="Discard both" data-escape-scope onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setConfirm(false))}>
            <span className="race-confirm-text">Discard both lanes and their work?</span>
            <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-danger" data-busy={busy || undefined} onClick={() => void discard()}>
              {busy ? <Spinner size={12} /> : <Icon name="trash" size={14} />}
              Discard both
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(true)}>
            Discard both
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────── a column ───────────────────────────────

/** What the column's head says about its side now: `${state}|${since}|${ended}` (a string, so streaming leaves it alone). */
function sideState(s: Store, id: string): string {
  const m = s.sessions[id];
  const d = s.data[id];
  if (!m) return '';
  if (m.race?.outcome) return `${m.race.outcome}|0|0`;
  let since = 0;
  let ended = 0;
  if (d)
    for (let i = d.roots.length - 1; i >= 0; i--) {
      const it = d.items[d.roots[i]];
      if (!it) continue;
      if (!ended && it.type === 'turn') ended = it.ts;
      if (it.type === 'user' && it.state !== 'queued') {
        since = it.ts;
        break;
      }
    }
  const waiting = m.status === 'awaiting' || !!d?.permissions.length || !!d?.questions.length;
  return `${waiting ? 'awaiting' : m.status}|${since}|${ended > since ? ended : 0}`;
}

function SideState({ id }: { id: string }) {
  const info = useStore((s) => sideState(s, id));
  const [state, sinceRaw, endedRaw] = info.split('|');
  const since = Number(sinceRaw);
  const ended = Number(endedRaw);
  const live = state === 'running' || state === 'starting';
  const now = useTick(live);
  if (state === 'kept')
    return (
      <span className="race-state" data-tone="done">
        <Icon name="check" size={12} />
        Landed
      </span>
    );
  if (state === 'dropped') return <span className="race-state">Lane removed</span>;
  if (state === 'awaiting')
    return (
      <span className="race-state" data-tone="wait">
        <Icon name="hourglass" size={12} />
        Waiting for you
      </span>
    );
  if (live)
    return (
      <span className="race-state" data-tone="live">
        <Tiles size={10} />
        <span className="num">{since && now - since >= 1000 ? shortDuration(now - since) : 'Working'}</span>
      </span>
    );
  if (state === 'error')
    return (
      <span className="race-state" data-tone="error">
        <Icon name="warning" size={12} />
        Stopped
      </span>
    );
  if (ended && since)
    return (
      <span className="race-state num">
        <Icon name="check" size={12} />
        {`Done in ${shortDuration(ended - since)}`}
      </span>
    );
  return null;
}

function RaceColumn({ id, rival, side, name, rivalName, onReply }: { id: string; rival: string; side: Side; name: { provider: ProviderId; label: string; model: string }; rivalName: string; onReply?: (side: Side) => void }) {
  const outcome = useStore((s) => s.sessions[id]?.race?.outcome);
  const same = name.label !== PROVIDER_NAME[name.provider];
  return (
    <section className="race-col" data-side={side} data-outcome={outcome} aria-label={name.label} data-spot>
      <header className="race-col-head">
        <ProviderMark provider={name.provider} size={16} />
        <span className="race-col-name truncate">{name.label}</span>
        {!same && name.model && <span className="race-col-model truncate">{name.model}</span>}
        <SideState id={id} />
        <span className="race-col-acts">
          {onReply && <IconButton icon="reply" size={14} label={`Message only ${name.label}`} onClick={() => onReply(side)} />}
          <IconButton icon="chat" size={14} label="Open chat" onClick={() => openSession(id)} />
        </span>
      </header>
      <div className="race-col-body">
        <Timeline sessionId={id} />
      </div>
      {/* A side whose lane was removed is stopped and archived: its task list or prompts would read as work still to come. */}
      {outcome !== 'dropped' && (
        <div className="race-col-prompts">
          <PromptDock sessionId={id} />
        </div>
      )}
      <RaceFoot id={id} rival={rival} label={name.label} rivalLabel={rivalName} />
    </section>
  );
}

const MAX_FILES = 4;

/** The column's foot: whether its lane lands on the folder's branch, its files with their counts, and "Keep this one". */
function RaceFoot({ id, rival, label, rivalLabel }: { id: string; rival: string; label: string; rivalLabel: string }) {
  const lane = useStore((s) => s.sessions[id]?.lane ?? undefined);
  const outcome = useStore((s) => s.sessions[id]?.race?.outcome);
  const status = useStore((s) => s.sessions[id]?.status);
  const rivalOutcome = useStore((s) => s.sessions[rival]?.race?.outcome);
  const steps = useStore((s) => stepCount(s, id));
  const forecast = useLaneForecast(id, lane?.path)?.forecast;
  const diff = useRaceDiff(id, lane?.path, steps);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; files?: string[] } | null>(null);
  const working = status === 'running' || status === 'starting' || status === 'awaiting';
  const files = diff?.files;
  const t = totals(files);

  if (outcome) {
    return (
      <footer className="race-foot" data-outcome={outcome}>
        <p className="race-verdict" data-state={outcome === 'kept' ? 'clean' : undefined}>
          <Icon name={outcome === 'kept' ? 'check' : 'trash'} size={13} />
          {outcome === 'kept' ? 'Landed' : 'Lane removed'}
        </p>
      </footer>
    );
  }

  const target = forecast?.target ?? lane?.from ?? 'the branch';
  const canKeep = !!lane && !working && !busy && !rivalOutcome && (forecast ? forecast.state === 'clean' : t.files > 0);
  const why = working
    ? 'Can be kept when its turn has ended'
    : !lane
      ? 'This chat has no lane'
      : forecast?.state === 'conflicts'
        ? `Conflicts with ${target}`
        : forecast?.state === 'blocked'
          ? 'The folder has uncommitted edits in these files'
          : forecast?.state === 'nothing' || (!forecast && !t.files)
            ? 'Nothing to land yet'
            : undefined;
  const keep = async () => {
    setBusy(true);
    setError(null);
    const res = await keepRace(id, rival);
    setBusy(false);
    setConfirm(false);
    if (!res.ok) setError({ text: res.error ?? 'Could not land the lane.', files: res.conflicts ?? res.blocked });
  };

  return (
    <footer className="race-foot">
      <Verdict forecast={working ? undefined : forecast} working={working} target={target} total={t} />
      {!!files?.length && (
        <ul className="race-files" aria-label="Changed files">
          {files.slice(0, MAX_FILES).map((f) => (
            <li key={f.path} className="race-file">
              <PathLabel path={f.path} />
              <FileCounts f={f} />
            </li>
          ))}
          {files.length > MAX_FILES && <li className="race-file race-file-more">{plural(files.length - MAX_FILES, 'more file')}</li>}
        </ul>
      )}
      {error && (
        <div className="race-error race-error-block" role="alert">
          <Icon name="warning" size={13} />
          <span>
            {error.text}
            {error.files?.length ? <span className="race-error-files">{error.files.slice(0, 3).join(', ')}</span> : null}
          </span>
        </div>
      )}
      {confirm ? (
        <div className="race-actions race-confirm" role="group" aria-label="Keep this one" data-escape-scope onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setConfirm(false))}>
          <span className="race-confirm-text">
            Land on {target} and discard {rivalLabel}’s lane?
          </span>
          <button type="button" className="btn btn-sm btn-ghost" autoFocus onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button type="button" className="btn btn-sm btn-primary" data-busy={busy || undefined} onClick={() => void keep()}>
            {busy && <Spinner size={12} />}
            Keep this one
          </button>
        </div>
      ) : (
        <div className="race-actions">
          <Tip label={why ?? `Lands on ${target}, then discards ${rivalLabel}’s lane`} side="top">
            <button type="button" className="btn btn-sm race-keep" aria-disabled={!canKeep || undefined} aria-label={`Keep ${label}`} onClick={() => canKeep && setConfirm(true)}>
              Keep this one
            </button>
          </Tip>
        </div>
      )}
    </footer>
  );
}

function FileCounts({ f }: { f: FileDiff }) {
  return (
    <span className="race-counts num">
      {f.additions > 0 && <span className="t-add">+{f.additions}</span>}
      {f.deletions > 0 && <span className="t-del">−{f.deletions}</span>}
      {!f.additions && !f.deletions && <span>{f.binary ? 'binary' : f.status === 'renamed' ? 'renamed' : '0'}</span>}
    </span>
  );
}

/**
 * One line: where the lane stands against the folder's branch (checked once the side has settled),
 * and what it changed in all.
 */
function Verdict({ forecast: f, working, target, total }: { forecast?: LaneForecast; working: boolean; target: string; total: { files: number; add: number; del: number } }) {
  const [icon, text, state] = working
    ? (['diff', total.files ? 'Changes so far' : 'No changes yet', 'working'] as const)
    : !f
    ? (['circle-dashed', `Checking against ${target}`, 'loading'] as const)
    : f.state === 'clean'
      ? (['check', `Lands cleanly on ${target}`, 'clean'] as const)
      : f.state === 'conflicts'
        ? (['warning', `${plural(f.conflicts.length, 'file')} ${f.conflicts.length === 1 ? 'conflicts' : 'conflict'} with ${target}`, 'conflicts'] as const)
        : f.state === 'blocked'
          ? (['warning', 'Uncommitted edits in the folder', 'blocked'] as const)
          : f.state === 'nothing'
            ? (['circle', 'No changes yet', 'nothing'] as const)
            : (['warning', f.reason ?? 'Could not check the lane', 'unavailable'] as const);
  return (
    <p className="race-verdict" data-state={state}>
      <Icon name={icon} size={13} />
      <span className="truncate">{text}</span>
      {total.files > 0 && (
        <span className="race-counts num">
          <span className="race-counts-files">{plural(total.files, 'file')}</span>
          {total.add > 0 && <span className="t-add">+{total.add.toLocaleString('en-US')}</span>}
          {total.del > 0 && <span className="t-del">−{total.del.toLocaleString('en-US')}</span>}
        </span>
      )}
    </p>
  );
}

// ─────────────────────────────── compare ───────────────────────────────

/** Both lanes file by file: the files on the left, the chosen file's change in each lane side by side. */
function RaceCompare({ pair, names }: { pair: [string, string]; names: { provider: ProviderId; label: string }[] }) {
  const lanes = useStore((s) => pair.map((id) => s.sessions[id]?.lane?.path ?? '').join('\u0000'));
  const steps = useStore((s) => pair.map((id) => stepCount(s, id)).join(','));
  const [la, lb] = lanes.split('\u0000');
  const [ea, eb] = steps.split(',').map(Number);
  const left = useRaceDiff(pair[0], la || undefined, ea);
  const right = useRaceDiff(pair[1], lb || undefined, eb);
  const rows = useMemo(() => compareRows(left?.files, right?.files), [left?.files, right?.files]);
  const [picked, setPicked] = useState<string | null>(null);
  const current = rows.find((r) => r.path === picked) ?? rows[0];
  const list = useRef<HTMLDivElement>(null);
  const loading = (!left && !!la) || (!right && !!lb);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.path === current?.path);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) setPicked(next.path);
  };
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [current?.path]);

  if (!rows.length)
    return <p className="race-empty">{loading ? 'Reading both lanes' : !la && !lb ? 'Both lanes have ended.' : 'Neither lane has changed a file yet.'}</p>;

  return (
    <div className="race-compare">
      <div className="race-cmp-list scroll" ref={list} role="listbox" aria-label="Files" tabIndex={0} onKeyDown={onKey}>
        <div className="race-cmp-legend" aria-hidden>
          <span />
          {names.map((n, i) => (
            <span key={i} className="race-cmp-who truncate" title={n.label}>
              {n.label}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <button key={r.path} type="button" role="option" aria-selected={r.path === current?.path} className={cx('race-cmp-row', r.path === current?.path && 'dither-sel')} tabIndex={-1} onClick={() => setPicked(r.path)}>
            <PathLabel path={r.path} />
            <CmpCount f={r.left} />
            <CmpCount f={r.right} />
          </button>
        ))}
      </div>
      {current && current.same ? (
        // One change, made alike by both: shown once.
        <div className="race-cmp-panes" data-same>
          <div className="race-cmp-pane" data-spot>
            <div className="race-cmp-head">
              <ProviderMark provider={names[0].provider} size={14} />
              <ProviderMark provider={names[1].provider} size={14} />
              <span className="truncate">Same change in both</span>
            </div>
            <div className="race-cmp-body scroll">
              <DiffView key={current.path} diff={current.left!} showHeader={false} />
            </div>
          </div>
        </div>
      ) : current ? (
        <div className="race-cmp-panes">
          {[current.left, current.right].map((f, i) => (
            <div key={i} className="race-cmp-pane" data-spot>
              <div className="race-cmp-head">
                <ProviderMark provider={names[i].provider} size={14} />
                <span className="truncate">{names[i].label}</span>
              </div>
              <div className="race-cmp-body scroll">{f ? <DiffView key={`${current.path}:${i}`} diff={f} showHeader={false} /> : <p className="race-empty">Not changed here.</p>}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CmpCount({ f }: { f?: FileDiff }) {
  if (!f)
    return (
      <span className="race-cmp-n race-cmp-none" aria-label="Not changed">
        ·
      </span>
    );
  return (
    <span className="race-cmp-n">
      <FileCounts f={f} />
    </span>
  );
}

// ─────────────────────────────── the composer ───────────────────────────────

/** A follow-up for both, or for one side: the same field and keys as the chat's composer, without its agent controls. */
function RaceDock({ raceId, pair, names, target, setTarget, field }: { raceId: string; pair: [string, string]; names: { provider: ProviderId; label: string }[]; target: Target; setTarget: (t: Target) => void; field: RefObject<HTMLTextAreaElement | null> }) {
  // The field's words are a draft of the race's own: leaving the view (or a refused lane's retry) keeps them.
  const draftKey = raceDraftKey(raceId);
  const text = useStore((s) => s.drafts[draftKey]?.text ?? '');
  const setText = useCallback((next: string | ((cur: string) => string)) => {
    const st = useStore.getState();
    const cur = st.drafts[draftKey]?.text ?? '';
    st.setDraft(draftKey, { text: typeof next === 'function' ? next(cur) : next });
  }, [draftKey]);
  const sendWithEnter = useStore((s) => s.settings.sendWithEnter);
  const busy = useStore((s) => pair.some((id) => ['running', 'starting', 'awaiting'].includes(s.sessions[id]?.status ?? '')));
  const dock = useRef<HTMLDivElement>(null);
  const sides: (0 | 1)[] = target === 'both' ? [0, 1] : [Number(target) as 0 | 1];
  const trimmed = text.trim();

  // The columns end a little above the dock, as a conversation ends above its composer.
  useEffect(() => {
    const el = dock.current;
    const host = el?.closest<HTMLElement>('.race');
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--race-dock-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One line, growing to eight, then scrolling.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22 + 10)}px`;
  }, [text, field]);

  const send = async () => {
    if (!trimmed) return;
    setText('');
    const results = await Promise.all(sides.map((i) => sendMessage(pair[i], trimmed)));
    // Refused by a lane: the words come back, before anything typed since, aimed only at the lanes
    // that refused (a lane that took it never gets it twice).
    const retry = retryTarget(sides, results.map((r) => r.ok));
    if (!retry) return;
    setText((cur) => putBack({ text: cur, attachments: [] }, { text: trimmed, attachments: [] }).text);
    setTarget(retry);
  };
  const stop = () => sides.forEach((i) => void interrupt(pair[i]));
  const placeholder = target === 'both' ? (busy ? 'Queue a follow-up for both' : 'Message both') : `Message ${names[Number(target)].label}`;

  return (
    <div className="race-dock" ref={dock}>
      <div className="composer" data-variant="session">
        <div className="cmp-card" data-spot data-empty={!text ? '' : undefined}>
          {/* The chat's own pane: the glass, its rim and shade, and the cove the key rests in. */}
          <CoveSkin />
          <div className="cmp-field">
            <textarea
              ref={field}
              className="cmp-input race-input"
              value={text}
              rows={1}
              placeholder={placeholder}
              aria-label={placeholder}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && target !== 'both') {
                  e.preventDefault();
                  setTarget('both');
                  return;
                }
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                const mod = e.metaKey || e.ctrlKey;
                if (sendWithEnter ? !e.shiftKey || mod : mod) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className="cmp-bar">
            <div className="cmp-side">
              <Segmented
                id="race-target"
                className="race-target"
                value={target}
                onChange={setTarget}
                options={[
                  { value: 'both', label: 'Both' },
                  ...names.map((n, i) => ({
                    value: String(i) as Target,
                    label: (
                      <span className="race-target-opt">
                        <ProviderMark provider={n.provider} size={12} />
                        <span className="truncate">{n.label}</span>
                      </span>
                    ),
                  })),
                ]}
              />
            </div>
          </div>
          {/* The key is no part of the pane: it rests in the cove the pane's corner makes for it. */}
          <SendKey canSend={!!trimmed} busy={false} showStop={busy && !trimmed} steerable={false} sendWithEnter={sendWithEnter} shell={false} stoppable onSend={() => void send()} onStop={stop} />
        </div>
      </div>
    </div>
  );
}
