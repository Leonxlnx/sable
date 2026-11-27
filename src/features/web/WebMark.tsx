import { IconButton } from '@/ui';
import { connectedWords } from './web-model';
import { openWebAccess, useWebState } from './web-state';

/**
 * The top bar's quiet mark while a browser is attached through web access: one plain icon beside the
 * capability switches, its tooltip saying who; a click opens Settings › Phone at the web section.
 * Nothing at all while none is connected (or web access is not built in).
 */
export function WebMark() {
  const clients = useWebState()?.clients;
  if (!clients?.length) return null;
  return <IconButton icon="tablet" label={connectedWords(clients.map((c) => c.label))} className="web-mark" onClick={openWebAccess} />;
}
