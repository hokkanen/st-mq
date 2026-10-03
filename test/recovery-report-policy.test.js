import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { getChartData } from '../src/app/chart-data.js';

const BASE = Date.parse('2026-09-24T09:00:00Z'), SIGNAL = 'garage_compressor_active';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-report-policy-'));
  const donor = new Store(':memory:');
  let target = new Store(join(directory, 'target.sqlite'));
  t.after(() => { donor.close(); target.close(); rmSync(directory, { recursive: true, force: true }); });
  return { donor, get target() { return target; },
    merge(digest = 'a'.repeat(64)) {
      return new HistoryMerge({ target, donor, donorDigest: digest, input: 'mqtt', now: BASE + 240_000 }).run();
    },
    reopen() { target.close(); target = new Store(join(directory, 'target.sqlite')); } };
}
function record(store, receivedOffset, reportIntervalMs, { sourceOffset = 0, value = 1 } = {}) {
  return new Recorder(store).record({ source: 'garage-adapter', device: 'garage-heat-pump', signal: SIGNAL,
    value, unit: 'state', sourceTime: BASE + sourceOffset, receivedAt: BASE + receivedOffset,
    quality: ['observed-unverified'], raw: { usableForControl: false, diagnosticAvailable: true,
      timeBasis: 'source-measured', reportIntervalMs, reportGraceMs: 0 } });
}
function history(store, offset = 180_000) {
  return getChartData({ store, input: 'mqtt', startDate: '2026-09-24', endDate: '2026-09-24',
    now: BASE + offset, left: SIGNAL }).shading.compressorGarage;
}
function shortened(store) {
  record(store, 1000, 120_000);
  record(store, 51_000, 60_000);
}

test('recovery preserves a cached source deadline boundary without creating another measurement', async t => {
  const f = fixture(t); shortened(f.donor);
  const result = await f.merge();
  assert.deepEqual(result.counts, { missing: 4, conflicts: 0, duplicates: 0, skipped: 0 });
  f.reopen();
  const rows = f.target.observations({ signal: SIGNAL });
  assert.deepEqual(rows.map(row => row.sourceTime), [BASE, BASE]);
  assert.deepEqual(rows.map(row => row.receivedAt), [BASE + 1000, BASE + 51_000]);
  assert.equal(rows[1].raw.recorder.temporalBasis, 'policy-change');
  assert.equal(rows[1].raw.originalReportReceivedAt, BASE + 1000);
  assert.deepEqual(f.target.db.prepare('SELECT samples FROM recorder_coverage ORDER BY id').all().map(row => row.samples), [1, 0]);
  assert.deepEqual(history(f.target), [{ start: BASE + 1000, end: BASE + 60_000 }]);
  assert.deepEqual(history(f.target, 30_000), [{ start: BASE + 1000, end: BASE + 30_000 }]);
  const again = await f.merge('b'.repeat(64));
  assert.deepEqual(again.counts, { missing: 0, conflicts: 0, duplicates: 4, skipped: 0 });
  assert.equal(f.target.observations({ signal: SIGNAL }).length, 2);
});

test('a donor deadline boundary cannot replace contrary master measurements or reopen an outage', async t => {
  for (const scenario of ['conflicting-value', 'newer-measurement', 'newer-unchanged-report', 'explicit-outage']) await t.test(scenario, async t => {
    const f = fixture(t); shortened(f.donor);
    record(f.target, 1000, 120_000, { value: scenario === 'conflicting-value' ? 0 : 1 });
    if (scenario === 'newer-measurement') record(f.target, 20_000, 120_000, { sourceOffset: 20_000, value: 0 });
    if (scenario === 'newer-unchanged-report') record(f.target, 20_000, 120_000, { sourceOffset: 20_000 });
    if (scenario === 'explicit-outage') record(f.target, 30_000, 120_000, { sourceOffset: 30_000, value: null });
    const before = f.target.observations({ signal: SIGNAL }), chart = history(f.target);
    const result = await f.merge();
    assert(result.counts.conflicts > 0);
    assert.deepEqual(f.target.observations({ signal: SIGNAL }), before);
    assert.deepEqual(history(f.target), chart);
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage WHERE samples=0').get().n, 0);
  });
});

test('recovery rejects negative counts and zero-sample spans without matching policy-event provenance', async t => {
  for (const scenario of ['negative', 'extended', 'wrong-receipt', 'ordinary-observation']) await t.test(scenario, async t => {
    const f = fixture(t); shortened(f.donor);
    const last = f.donor.db.prepare('SELECT * FROM recorder_coverage ORDER BY id DESC LIMIT 1').get();
    if (scenario === 'negative') f.donor.db.prepare('UPDATE recorder_coverage SET samples=-1 WHERE id=?').run(last.id);
    if (scenario === 'extended') f.donor.db.prepare('UPDATE recorder_coverage SET end_at=end_at+1 WHERE id=?').run(last.id);
    if (scenario === 'wrong-receipt') f.donor.db.prepare('UPDATE recorder_coverage SET start_at=start_at+1,end_at=end_at+1 WHERE id=?').run(last.id);
    if (scenario === 'ordinary-observation') f.donor.db.prepare('UPDATE recorder_coverage SET observation_id=1 WHERE id=?').run(last.id);
    const result = await f.merge();
    assert.equal(result.tables.find(row => row.name === 'recorder_coverage').skipped, 1);
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage WHERE samples<=0').get().n, 0);
  });
});
