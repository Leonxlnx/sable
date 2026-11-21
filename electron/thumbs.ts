import { nativeImage } from 'electron';
import type { ThumbHost } from '../server/services/thumbs';

/**
 * Windows' own thumbnails for the file cards (`server/services/thumbs.ts` decides which file may be
 * asked for): what Explorer shows for a picture, a video, a PDF where a handler is installed. At most
 * `px` wide; a JPEG unless the picture has see-through parts (then a PNG). None for a file Windows
 * has no thumbnail for.
 */
export const windowsThumbs: ThumbHost = {
  async thumbnail(file, px) {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return null;
    let img = await nativeImage.createThumbnailFromPath(file, { width: px, height: px }).catch(() => null);
    if (!img || img.isEmpty()) return null;
    const { width } = img.getSize();
    if (width > px) img = img.resize({ width: px, quality: 'good' });
    // BGRA: any pixel that is not opaque keeps the picture a PNG.
    const bitmap = img.toBitmap();
    let clear = false;
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] < 250) {
        clear = true;
        break;
      }
    }
    return clear ? { mime: 'image/png', data: img.toPNG() } : { mime: 'image/jpeg', data: img.toJPEG(84) };
  },
};
