import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { getChartData } from '../src/app/chart-data.js';
import { EXPLORER_SERIES, explorerActivityTrack } from '../chart/series-explorer.js';
import { activityTracks, activityIntervals } from '../chart/chart-overlays.js';
import { seedChartActivityCatalogueFixture } from '../scripts/lib/chart-activity-fixture.js';

test('all 26 catalogue bars and all eight built-in tracks retain complete dense source coverage', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const evidence = seedChartActivityCatalogueFixture(store);
  const query = extra => getChartData({ store, input: 'providers', now: evidence.to,
    startDate: '2026-10-05', endDate: '2026-10-05', points: 100, ...extra });
  const duration = rows => rows.reduce((sum, row) => sum + (row.end - row.start) * (row.aggregated ? row.fraction : 1), 0);
  const check = (rows, expected, key) => assert(Math.abs(duration(rows) - expected) < 1e-4,
    `${key}: ${duration(rows)} ms shown, ${expected} ms recorded`);
  for (const row of EXPLORER_SERIES.filter(row => ['state', 'code'].includes(row.unit))) {
    const result = query({ left: row.requestKey });
    check(activityIntervals(explorerActivityTrack(row.key), result), evidence.knownMs, row.key);
    const detail = query({ left: row.requestKey, viewFrom: evidence.from + 20_000, viewTo: evidence.from + 30_000 });
    check(activityIntervals(explorerActivityTrack(row.key), detail), 9990, `${row.key} zoom`);
  }
  const control = query({ view: 'control' }), garage = query({ view: 'garage' }), charging = query({ view: 'charging_currents' });
  assert.equal(activityTracks.length, 8, 'New built-in tracks require a coverage expectation');
  for (const track of activityTracks) {
    const result = ['propertyHighestPhase', 'charger2Allowance'].includes(track.key) ? charging
      : track.key === 'compressorGarage' ? garage : control;
    check(activityIntervals(track, result), ['fireplace', 'charger2Allowance'].includes(track.key)
      ? evidence.to - evidence.from : evidence.knownMs, track.key);
  }
});
