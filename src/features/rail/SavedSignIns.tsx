import { useEffect, useState } from 'react';
import type { SignInInfo } from '@shared/protocol';
import { listSignIns, removeSignIn } from '@/state/actions';
import { useStore } from '@/state/store';
import { IconButton } from '@/ui';
import { Card, Empty } from '../settings/parts';
import { originParts } from './sign-in';
import './saved-sign-ins.css';

/**
 * Settings › Permissions: the sign-ins saved for the Browser tab, a row per site with its user name
 * (never the password), each removable. One calm sentence when there are none.
 */
export function SavedSignIns() {
  // undefined: still asking; null: sign-ins are off (they do not ship in this version): no section at all.
  const [list, setList] = useState<SignInInfo[] | null | undefined>(undefined);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    let live = true;
    listSignIns()
      .then((l) => live && setList(l))
      .catch(() => live && setList(null));
    return () => {
      live = false;
    };
  }, []);

  const remove = (s: SignInInfo) =>
    removeSignIn(s.id).then(
      () => setList((l) => (l ?? []).filter((x) => x.id !== s.id)),
      () => toast('Could not remove the sign-in', 'error'),
    );

  if (!list) return null;
  return (
    <Card title="Saved sign-ins">
      {!list.length ? (
        <Empty>No saved sign-ins.</Empty>
      ) : (
        <ul className="si-list" aria-label="Saved sign-ins">
          {list.map((s) => {
            const { scheme, host } = originParts(s.origin);
            return (
              <li key={s.id} className="si-row">
                <span className="si-site truncate" title={s.origin}>
                  <span className="si-scheme">{scheme}</span>
                  {host}
                </span>
                <span className="si-user truncate">{s.username}</span>
                <IconButton icon="trash" label={`Remove the sign-in for ${host}`} size={14} onClick={() => void remove(s)} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
