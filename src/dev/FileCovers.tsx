import { useMemo, useState } from 'react';
import type { ToolItem } from '@shared/protocol';
import { FileShare } from '@/features/timeline/FileCard';
import { TimelineCtx, type TimelineCtxValue } from '@/features/timeline/ctx';

/**
 * File cards, one of each kind of cover (a document, a table, a picture, an archive, a video,
 * sound, code, a plain file), as an agent hands them over. "Share again" lays the row out anew as
 * a share that happens now, so the arrival plays; point at a card for its kind's motion, press it
 * for the opening beat (nothing opens: these files do not exist).
 */
const NAMES = ['report.pdf', 'figures.xlsx', 'photo.png', 'build.zip', 'demo.mp4', 'voice.mp3', 'app.wasm', 'data.xyz'];
const SIZES = [48_213, 18_400, 1_204_332, 9_815_002, 24_118_770, 3_402_118, 612_480, 2_048];

export function FileCovers() {
  const [round, setRound] = useState(0);
  // `live`: what is laid out counts as happening now (the arrival plays), but not on the first paint of the gallery.
  const ctx = useMemo<TimelineCtxValue>(() => ({ sessionId: '', cwd: 'C:/work/relay-api', home: 'C:/Users/me', live: { current: round > 0 }, stuck: { current: true }, scrolled: { current: 0 } }), [round]);
  const item = useMemo(
    () =>
      ({
        id: `gallery-share-${round}`,
        type: 'tool',
        ts: Date.now(),
        name: 'SendUserFile',
        kind: 'share',
        title: `${NAMES.length} files`,
        status: 'done',
        detail: { files: NAMES.map((name, i) => ({ name, path: `C:/work/relay-api/out/${name}`, size: SIZES[i] })) },
      }) as unknown as ToolItem,
    [round],
  );
  return (
    <div className="fcovers">
      <div className="isheet-bar">
        <button type="button" className="btn btn-sm" onClick={() => setRound((n) => n + 1)}>
          Share again
        </button>
        <span className="isheet-note">File cards, one of each cover. Point at a card for its kind's motion, press it for the opening beat.</span>
      </div>
      <TimelineCtx.Provider value={ctx}>
        <FileShare key={round} item={item} />
      </TimelineCtx.Provider>
    </div>
  );
}
