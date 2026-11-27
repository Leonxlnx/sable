import { Icon } from '@/icons';
import { useWebDeviceName } from './web-state';

/**
 * A message's mark when a browser sent it through web access: "From Test iPad", as the Claude app's
 * own sends read "From the Claude app". A device removed since is no longer known by name.
 */
export function WebOrigin({ deviceId }: { deviceId: string }) {
  const name = useWebDeviceName(deviceId);
  return (
    <span className="user-mark">
      <Icon name="tablet" size={11} />
      {name ? `From ${name}` : 'From a web browser'}
    </span>
  );
}
