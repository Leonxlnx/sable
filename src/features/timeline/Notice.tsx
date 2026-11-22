import { Fragment, memo, useRef, useState } from 'react';
import type { NoticeItem } from '@shared/protocol';
import { Collapse } from '@/components/Collapse';
import { Icon, type IconName } from '@/icons';
import { onLinkClick } from '@/lib/links';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { LimitNotice } from '@/features/accounts';
import { AuthNotice } from '@/features/accounts/AuthNotice';
import { AgentSwitchLine } from './AgentSwitch';
import { CommandOutput } from './Synthetic';
import { useTimeline } from './ctx';
import { readErrorDetail } from './error-detail';
import { firstSentence, linkParts, noticeLevel, repeatRun, standsAsCard, type NoticeLevel } from './notice-read';

const ICON: Record<NoticeItem['variant'], IconName> = {
  info: 'info',
  error: 'error',
  interrupted: 'hand',
  compact: 'collapse',
  retry: 'refresh',
  mode: 'shield',
  model: 'cube',
  command: 'prompt',
  rewind: 'rewind',
};

/** The card's mark: the one thing that says its level. */
const MARK: Record<NoticeLevel, IconName> = { info: 'info', warn: 'warning', error: 'error' };

/**
 * A notice's words with the addresses in them as links (notice-read.ts: http and https only). They
 * open outside; a page of this machine opens in the Browser tab, as a link in an answer does.
 */
function Linked({ text }: { text: string }) {
  return linkParts(text).map((p, i) =>
    'href' in p ? (
      // `dir` isolates the label: a direction override in the words before it cannot reorder the host it shows.
      <a key={i} className="notice-link" dir="ltr" href={p.href} title={p.href} target="_blank" rel="noopener noreferrer" onClick={onLinkClick}>
        {/* In a narrow column the address breaks after a slash, not inside a word. */}
        {p.label.split('/').map((part, j) => (
          <Fragment key={j}>
            {j > 0 && (
              <>
                /<wbr />
              </>
            )}
            {part}
          </Fragment>
        ))}
      </a>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
}

/** An error's second line: what the service said and its status when the line is an API failure (error-detail.ts), else the line as it came. */
function ErrorDetailLine({ detail }: { detail: string }) {
  const d = readErrorDetail(detail);
  if (!d.raw)
    return (
      <div className="notice-error-detail">
        <Linked text={d.text} />
      </div>
    );
  return (
    <div className="notice-error-detail" data-read title={d.raw}>
      <Linked text={d.text} />
      {d.status && <span className="notice-error-status num">{d.status}</span>}
    </div>
  );
}

/**
 * A notice that stands in the conversation as a card: one hairline, a small mark for its level
 * (it informs, warns or reports a failure), its first sentence; the rest of a long one opens on
 * demand. `count`: how often it came in a row.
 */
export const NoticeCard = memo(function NoticeCard({ item, count = 1 }: { item: NoticeItem; count?: number }) {
  const level = noticeLevel(item);
  const { head, rest } = firstSentence(item.text);
  const [open, setOpen] = useState(false);
  return (
    <div className="notice-error" data-level={level} role={level === 'error' ? 'alert' : 'note'}>
      <Icon name={MARK[level]} size={16} />
      <div className="notice-error-body">
        <div className="notice-error-head">
          <div className="notice-error-text">
            <Linked text={head} />
            {count > 1 && (
              <span className="notice-count num">
                <span aria-hidden> · {count}</span>
                <span className="sr-only">, {count} times</span>
              </span>
            )}
          </div>
          {rest && <IconButton icon={open ? 'caret-up' : 'caret-down'} size={11} label={open ? 'Less' : 'More'} className="icon-btn-xs notice-more" aria-expanded={open} onClick={() => setOpen((o) => !o)} />}
        </div>
        {rest && (
          <Collapse open={open}>
            <div className="notice-error-rest">
              <Linked text={rest} />
            </div>
          </Collapse>
        )}
        {item.detail && <ErrorDetailLine detail={item.detail} />}
      </div>
    </div>
  );
});

/**
 * How often this notice stands in a row, among its siblings: 0 when the one right before it is the
 * same (that one counts them). The place found last is kept, so a store write costs one look.
 */
function useRepeat(item: NoticeItem): number {
  const { sessionId } = useTimeline();
  const place = useRef(-1);
  return useStore((s) => {
    const d = s.data[sessionId];
    const list = d && (item.parentId ? d.children[item.parentId] : d.roots);
    if (!list) return 1;
    if (list[place.current] !== item.id) place.current = list.indexOf(item.id);
    return place.current < 0 ? 1 : repeatRun(list, d.items, place.current);
  });
}

/** The same notice right after itself is not a second card: the first one says how many came. */
const CountedCard = memo(function CountedCard({ item }: { item: NoticeItem }) {
  const count = useRepeat(item);
  return count ? <NoticeCard item={item} count={count} /> : null;
});

/** Things that happened to the conversation rather than in it: dividers, errors, command output. */
export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  // A turn refused at a plan limit: the accounts feature says when it resets and offers another account.
  if (item.limit) return <LimitNotice item={item} />;
  // Refused for the sign-in: one line with "Sign in" once the CLI says the account is signed out (AuthNotice.tsx).
  if (item.auth) return <AuthNotice item={item} />;
  // The chat switched agents here (AgentSwitch.tsx).
  if (item.agentSwitch) return <AgentSwitchLine item={item} />;

  // An error, or anything the bridge gave a level: the card with that level's mark.
  if (standsAsCard(item)) return <CountedCard item={item} />;

  // What a command printed: one of the quiet lines, as Claude Code's own commands are (Synthetic.tsx).
  if (item.variant === 'command') return <CommandOutput item={item} />;

  return (
    <div className="notice" data-variant={item.variant}>
      <div className="notice-line">
        <span className="notice-rule" />
        <span className="notice-label">
          <Icon name={ICON[item.variant] ?? 'info'} size={13} />
          <span className="notice-words">
            <Linked text={item.text} />
          </span>
        </span>
        <span className="notice-rule" />
      </div>
      {item.detail && (
        <div className="notice-detail">
          <Linked text={item.detail} />
        </div>
      )}
    </div>
  );
});
