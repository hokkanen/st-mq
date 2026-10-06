import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createChartService } from '../src/app/chart-service.js';

const start = Date.parse('2026-10-06T09:00:00Z'), MINUTE = 60_000;

test('native circulation confirmations refresh cached chart coverage without adding state observations', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dhwr-native-chart-'));
  const store = new Store(join(directory, 'history.sqlite')), recorder = new Recorder(store);
  const service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const put = at => recorder.record({ source: 'shelly-mqtt', device: 'dhwr', signal: 'dhwr_active',
    value: 1, unit: 'state', sourceTime: at, receivedAt: at, quality: [],
    raw: { timeBasis: 'mqtt-live-status', basis: 'measured-power', verified: true,
      reportIntervalMs: 2 * MINUTE, reportGraceMs: 0, maxAgeMs: 2 * MINUTE } });
  const options = { input: 'mqtt', now: start + 4 * MINUTE, startDate: '2026-10-06', endDate: '2026-10-06',
    view: 'hot_water' };
  put(start);
  const first = await service.query(options);
  assert(first.series.dhwr_active.some(point => point.x === start + 2 * MINUTE && point.y === null));
  assert.equal((await service.query(options)).meta.cacheHit, true);

  put(start + MINUTE);
  assert.equal(store.observations().length, 1, 'Unchanged derived state extends coverage without another observation');
  const extended = await service.query(options);
  assert.notEqual(extended.meta.cacheHit, true, 'A native source confirmation invalidates the affected cached coverage');
  assert(extended.series.dhwr_active.some(point => point.x === start + 3 * MINUTE && point.y === null));
  assert(!extended.series.dhwr_active.some(point => point.x === start + 2 * MINUTE && point.y === null));

  const completed = { ...options, viewFrom: start + 1000, viewTo: start + 30_000 };
  await service.query(completed);
  put(start + 2 * MINUTE);
  assert.equal((await service.query(completed)).meta.cacheHit, true,
    'A later confirmation leaves an already complete historical interval cached');
});
