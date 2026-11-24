// Child of the opt-in memory test. The parent owns the scratch lock and the temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../../server/core/store.ts');
const { isLight } = require('../../server/core/trim.ts');

async function run() {
  const home = process.argv[2];
  const store = new Store(home);
  const file = path.join(home, 'sessions', 'long.json');
  const image = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(32728);
  const output = ('command output, passed ✓ →\n' + 'abcdef0123456789'.repeat(256) + '\n').repeat(22);
  const content = 'a file read, another line\n'.repeat(2400);
  const fd = fs.openSync(file, 'wx');
  let size = 0, count = 0, turns = 0;
  const put = s => { size += fs.writeSync(fd, s); };
  const item = o => {
    put((count ? ',\n' : '') + JSON.stringify({ id: 'item-' + count, ts: ++count, ...o }));
  };
  try {
    put('{"gen":1,"items":[\n');
    while (size < (200 << 20)) {
      item({ type: 'user', text: 'Please continue ' + ++turns });
      for (let k = 0; k < 12; k++) {
        const result = k % 3 === 0 ? { images: [image] } : k % 3 === 1 ? { text: output, exitCode: 0 } : { file: { path: 'src/a.ts', content } };
        item({ type: 'tool', name: k % 3 === 1 ? 'Bash' : 'Read', kind: k % 3 === 1 ? 'bash' : 'read', status: 'done', title: 'Check', detail: {}, result });
      }
      item({ type: 'text', text: 'Done', streaming: false });
      item({ type: 'turn', durationMs: 500 });
    }
    put('\n],"todos":[]}');
  } finally { fs.closeSync(fd); }

  const start = performance.now(), rssAtLoad = process.memoryUsage.rss();
  const data = await store.loadSessionAsync('long');
  const loaded = performance.now();
  assert.equal(data.unreadable, undefined);
  assert.equal(data.items.length, count);
  assert.ok(isLight(data.items[1]));
  assert.equal(data.items[1].result.images, undefined);
  assert.deepEqual(store.wholeItem('long', data.items[1]).result.images, [image]);
  assert.ok(isLight(data.items[1]));
  store.saveSession('long', () => ({ ...data, dirty: 'all' }));
  await store.flush();
  const rewritten = performance.now();
  assert.deepEqual(store.wholeItem('long', data.items[1]).result.images, [image]);
  const head = Buffer.alloc(64);
  const check = fs.openSync(file, 'r');
  try { fs.readSync(check, head, 0, head.length, 0); }
  finally { fs.closeSync(check); }
  assert.match(head.toString(), /^\{"gen":\d{10,},"items":\[/);
  const peak = process.resourceUsage().maxRSS * 1024;
  const mib = n => Math.round(n / 1048576 * 10) / 10;
  const metrics = { baseMiB: mib(size), turns, items: count, lightItems: data.items.filter(isLight).length,
    rssAtLoadMiB: mib(rssAtLoad), peakRssMiB: mib(peak), loadMs: Math.round(loaded - start),
    rewriteMs: Math.round(rewritten - loaded), totalMs: Math.round(rewritten - start) };
  fs.writeFileSync(path.join(home, 'metrics.json'), JSON.stringify(metrics));
  assert.ok(peak > 0 && peak - rssAtLoad < size, JSON.stringify(metrics));
}
run().catch(err => { console.error(err); process.exitCode = 1; });
