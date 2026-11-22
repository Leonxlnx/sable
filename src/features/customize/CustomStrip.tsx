import { useStore } from '@/state/store';
import { Spinner } from '@/ui';
import { customStep, useCustom, useOriginal } from './custom-store';
import './customize.css';

/**
 * Above the Customize chat's composer, after its agent changed the source of the person's build:
 * "Build and try it" (progress in place; on success the window reloads into the custom interface),
 * and "Use Sable's own" while a build of theirs runs. Nothing for a change of styles: those are
 * already on screen. Nothing where this bridge cannot serve a build (development).
 */
export function CustomStrip({ sessionId }: { sessionId: string }) {
  const custom = useStore((s) => !!s.sessions[sessionId]?.custom);
  const c = useCustom();
  if (!custom || !c || c.ignored || !c.build.supported || !c.build.workspace) return null;
  const b = c.build;
  const changed = (b.changedAt ?? 0) > (b.builtAt ?? 0);
  if (!b.step && !changed && !b.serving) return null;
  return (
    <div className="cz-strip" role="status">
      {b.step ? (
        <>
          <Spinner size={13} />
          <span className="cz-strip-text">{b.step === 'building' ? 'Building your interface' : 'Working on your build'}</span>
        </>
      ) : (
        <>
          <span className="cz-strip-text">{changed ? 'The interface changed' : 'Your build is running'}</span>
          {changed && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void customStep('build')}>
              Build and try it
            </button>
          )}
          {b.serving && (
            <button type="button" className="btn btn-sm" onClick={() => void useOriginal()}>
              Use Sable's own
            </button>
          )}
        </>
      )}
    </div>
  );
}
