import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { pushBack } from '@m/lib/back';
import { haptic } from '@m/lib/native';
import { Icon } from '@m/ui/icons';
import { SNAP } from '@m/ui/motion';

/**
 * The camera, looking for a Sable pairing code (decoded on the phone with jsQR, a few times a
 * second): the picture dims around a clear window with four corners; a code found closes the
 * window on it. Without a camera, one calm card offers the link instead.
 */
export function Scanner({ onCode, onClose, onPaste }: { onCode: (text: string) => void; onClose: () => void; onPaste: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string>();
  const [live, setLive] = useState(false);
  const [found, setFound] = useState(false);

  useEffect(() => pushBack(() => (onClose(), true)), [onClose]);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      const v = video.current;
      if (stopped || !v || !ctx) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const w = 480;
        const h = Math.round((v.videoHeight / v.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const code = jsQR?.(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code?.data && /^sable:\/\/pair\?/i.test(code.data)) {
          stopped = true;
          haptic('success');
          setFound(true);
          // The window closes on the code, then pairing takes over.
          window.setTimeout(() => onCode(code.data), 220);
          return;
        }
      }
      timer = window.setTimeout(tick, 140);
    };
    let jsQR: typeof import('jsqr').default | undefined;
    (async () => {
      try {
        jsQR = (await import('jsqr')).default;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        if (stopped) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
          setLive(true);
        }
        tick();
      } catch {
        setError('Sable cannot use the camera');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);

  return (
    <motion.div className="scanner" data-live={live || undefined} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <video ref={video} className="scanner-video" playsInline muted />
      <AnimatePresence mode="wait" initial={false}>
        {error ? (
          <motion.div key="err" className="scanner-card" initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={SNAP} role="alert">
            <span className="scanner-card-glyph">
              <Icon name="camera" size={22} />
            </span>
            <p className="scanner-card-title">{error}</p>
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => (haptic('tap'), onPaste())}>
              <Icon name="clipboard" size={20} /> Paste link
            </button>
            <button type="button" className="btn btn-lg btn-block btn-ghost" onClick={onClose}>
              Close
            </button>
          </motion.div>
        ) : (
          <motion.div key="frame" className="scanner-frame" data-found={found || undefined} initial={{ opacity: 0, scale: 1.06 }} animate={{ opacity: 1, scale: found ? 0.94 : 1 }} transition={SNAP} aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </motion.div>
        )}
      </AnimatePresence>
      {!error && (
        <div className="scanner-foot">
          <p className="scanner-hint">The code is in Settings › Phone on your computer</p>
          <button type="button" className="btn btn-lg scanner-paste" onClick={() => (haptic('tap'), onPaste())}>
            <Icon name="clipboard" size={20} /> Paste link
          </button>
        </div>
      )}
      <button type="button" className="scanner-close icon-btn" onClick={onClose} aria-label="Close the camera">
        <Icon name="x" size={20} />
      </button>
    </motion.div>
  );
}
