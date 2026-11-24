import { updateSession } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton, Menu, MenuContent, MenuItem, MenuSep, MenuTrigger } from '@/ui';
import { copyChatMarkdown, exportChat } from './export';

/** The open chat's menu in the session header: the chat as Markdown, copied or saved to a file, and its notifications muted or not. */
export function ChatMenu({ sessionId }: { sessionId: string }) {
  const muted = useStore((s) => !!s.sessions[sessionId]?.muted);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon="dots" label="Chat menu" />
      </MenuTrigger>
      <MenuContent align="end" width={210}>
        <MenuItem icon="copy" onSelect={() => void copyChatMarkdown(sessionId)}>
          Copy as Markdown
        </MenuItem>
        <MenuItem icon="export" onSelect={() => void exportChat(sessionId)}>
          Export chat
        </MenuItem>
        <MenuSep />
        <MenuItem icon={muted ? 'bell' : 'bell-off'} onSelect={() => void updateSession(sessionId, { muted: !muted })}>
          {muted ? 'Unmute' : 'Mute notifications'}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
