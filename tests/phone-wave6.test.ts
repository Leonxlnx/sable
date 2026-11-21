/**
 * The phone on the desktop's newer answers: a file request refused for now (`retry`,
 * `retryAfterMs`) is asked again after the wait it names, within a budget, and nothing else is
 * retried; a share's card on the phone carries the file's canonical name, the one the download
 * saves it under.
 */
import { describe, expect, it } from 'vitest';
import type { TimelineItem, ToolItem } from '@shared/protocol';
import { busyError, isBusy, isTransport, transportError, whileBusy } from '../mobile/src/lib/errors';
import { phoneDetail } from '../server/services/phone';

describe('a busy desktop (retry, retryAfterMs)', () => {
  it('is asked again after the wait it names, then the answer is the result', async () => {
    const waits: number[] = [];
    let n = 0;
    const got = await whileBusy(
      async () => {
        if (++n < 3) throw busyError('Another download is starting', n === 1 ? 10 : 99_000);
        return 'ok';
      },
      90_000,
      async (ms) => void waits.push(ms),
    );
    expect(got).toBe('ok');
    expect(n).toBe(3);
    // Within 50 ms and 5 s, whatever the desktop names.
    expect(waits).toEqual([50, 5000]);
  });

  it('gives up with the busy answer once the budget is spent', async () => {
    let n = 0;
    const err = await whileBusy(
      async () => {
        n++;
        throw busyError('Busy', 400);
      },
      1000,
      async () => {},
    ).catch((e) => e);
    expect(isBusy(err)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });

  it('never retries a refusal or a lost connection', async () => {
    let n = 0;
    const refused = await whileBusy(async () => {
      n++;
      throw new Error('That file is no longer shared');
    }).catch((e) => e);
    expect(refused.message).toBe('That file is no longer shared');
    expect(n).toBe(1);
    const lost = await whileBusy(async () => {
      n++;
      throw transportError('The connection to the desktop was lost', 'lost');
    }).catch((e) => e);
    expect(isTransport(lost)).toBe(true);
    expect(n).toBe(2);
  });
});

describe("a share's card on the phone", () => {
  it('carries the canonical name the download saves the file under', () => {
    const share: ToolItem = {
      id: 'sh',
      type: 'tool',
      name: 'SendUserFile',
      kind: 'share',
      title: 'Shared',
      status: 'done',
      ts: 1,
      detail: { files: [{ path: 'out/setup.apk ', name: 'setup.apk \u202e', size: 10 }] },
    };
    const items: TimelineItem[] = [share];
    const { item } = phoneDetail(items, 'sh');
    const files = (item as ToolItem).detail?.files ?? [];
    expect(files[0]?.name).toBe('setup.apk');
  });
});
