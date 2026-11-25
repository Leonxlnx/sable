import { stripVTControlCharacters } from 'node:util';
import { lastDevUrl, mayHaveDevUrl, servingCommand } from '../../shared/dev-url';
import type { ToolItem } from '../../shared/protocol';

// A link is enough to open a page. Dropping work protection needs the
// server's own listen announcement, with the address on that line.
const listen = /(?:\b(?:local|loopback)\s*:|\b(?:listening\s+(?:at|on)|ready\s+(?:at|on)|running\s+(?:at|on)|started\s+server\s+on|starting\s+development\s+server\s+at)\s*:?|^\s*(?:https?\s+server|serving)(?:\s+(?:at|on))?\s*:?|^\s*serving http on \S+ port \d+\s*\(|➜)\s*https?:\/\//i;

export function taskServing(item: ToolItem, output = item.output, result = item.result): string | true | undefined {
  if (item.task?.kind !== 'command' || item.name === 'Monitor') return;
  const input = item.input as { command?: unknown } | undefined;
  const command = item.detail.command ?? (typeof input?.command === 'string' ? input.command : '');
  // The package's generic start script may also do a finite import or test.
  const known = servingCommand(command) && !/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?start\b/.test(command);
  for (const text of [output, result?.text, result?.stderr]) {
    if (!text || !mayHaveDevUrl(text)) continue;
    const banner = known ? text : stripVTControlCharacters(text).replace(/\r\n/g, '\n').split('\n')
      .map(line => line.slice(line.lastIndexOf('\r') + 1)).filter(line => listen.test(line)).join('\n');
    const url = lastDevUrl(banner, command);
    if (url) return url.label;
  }
  return item.task.serving ?? (known || undefined);
}
