import { memo } from 'react';
import type { NoticeItem } from '@shared/protocol';
import { Icon, type IconName } from '@/icons';
import { LimitNotice } from '@/features/accounts';
import { AgentSwitchLine } from './AgentSwitch';
import { CommandOutput } from './Synthetic';
import { readErrorDetail } from './error-detail';

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

/** An error's second line: what the service said and its status when the line is an API failure (error-detail.ts), else the line as it came. */
function ErrorDetailLine({ detail }: { detail: string }) {
  const d = readErrorDetail(detail);
  if (!d.raw) return <div className="notice-error-detail">{d.text}</div>;
  return (
    <div className="notice-error-detail" data-read title={d.raw}>
      {d.text}
      {d.status && <span className="notice-error-status num">{d.status}</span>}
    </div>
  );
}

/** Things that happened to the conversation rather than in it: dividers, errors, command output. */
export const Notice = memo(function Notice({ item }: { item: NoticeItem }) {
  // A turn refused at a plan limit: the accounts feature says when it resets and offers another account.
  if (item.limit) return <LimitNotice item={item} />;
  // The chat switched agents here (AgentSwitch.tsx).
  if (item.agentSwitch) return <AgentSwitchLine item={item} />;

  if (item.variant === 'error') {
    return (
      <div className="notice-error" role="alert">
        <Icon name="error" size={16} />
        <div className="notice-error-body">
          <div className="notice-error-text">{item.text}</div>
          {item.detail && <ErrorDetailLine detail={item.detail} />}
        </div>
      </div>
    );
  }

  // What a command printed: one of the quiet lines, as Claude Code's own commands are (Synthetic.tsx).
  if (item.variant === 'command') return <CommandOutput item={item} />;

  return (
    <div className="notice" data-variant={item.variant}>
      <div className="notice-line">
        <span className="notice-rule" />
        <span className="notice-label">
          <Icon name={ICON[item.variant] ?? 'info'} size={13} />
          {item.text}
        </span>
        <span className="notice-rule" />
      </div>
      {item.detail && <div className="notice-detail">{item.detail}</div>}
    </div>
  );
});
