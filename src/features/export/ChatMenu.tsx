import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from '@/ui';
import { copyChatMarkdown, exportChat } from './export';

/** The open chat's menu in the session header: the chat as Markdown, copied or saved to a file. */
export function ChatMenu({ sessionId }: { sessionId: string }) {
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
      </MenuContent>
    </Menu>
  );
}
