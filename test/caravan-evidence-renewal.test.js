import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { chartCoverageRows } from '../src/app/chart-coverage.js';
import { createChartService } from '../src/app/chart-service.js';

const BASE = Date.parse('2026-10-20T12:00:00Z'), SIGNAL = 'caravan_dehumidifier_state';
function report(at = BASE, { power = BASE, fanSpeed = BASE, meter = at, meterAge = 60_000, value = 1 } = {}) {
  return { source: 'mqtt-equipment', device: 'caravan_dehumidifier', signal: SIGNAL, unit: 'state',
    value, sourceTime: value === 0 ? power : Math.max(power, fanSpeed), receivedAt: at, quality: [],
    raw: { timeBasis: 'mqtt-live-status', identity: 'a'.repeat(64), maxAgeMs: 180_000,
      reportIntervalMs: 180_000, reportGraceMs: 0, fieldTimestamps: { power, ...(value ? { fanSpeed } : {}) },
      locationEvidence: { method: 'native-power-cycle-v1', meterSignature: 'b'.repeat(64),
        startedAt: BASE - 60_000, completedAt: BASE - 10_000, meterObservedAt: meter, maxAgeMs: meterAge,
        powerRiseW: 5, powerFallW: 5, minimumChangeW: 3 } } };
}
function fixture(t, path = ':memory:') {
  const store = new Store(path), recorder = new Recorder(store, { clock: () => BASE + 300_000 });
  t.after(() => store.close());
  return { store, recorder, put: (at, options) => recorder.record(report(at, options)),
    rows: () => store.observations({ signal: SIGNAL }),
    spans: () => store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL) };
}
function points(store, now = BASE + 300_000) {
  return [...chartCoverageRows(store, { from: BASE, to: now, now, input: 'mqtt', signals: [SIGNAL] })];
}

test('healthy meter renewals share a bounded flush without policy, value or coverage-row churn', t => {
  const f = fixture(t);
  f.put(BASE);
  const initial = f.store.checkpoint(), original = f.rows()[0];
  for (let n = 1; n <= 20; n++) assert.equal(f.put(BASE + n * 1000).saved, false);
  assert.deepEqual(f.store.checkpoint(), initial, 'Renewals alone require no durable transaction before the batch');
  assert.equal(f.rows().length, 1); assert.equal(f.spans().length, 1);
  assert.equal(f.recorder.sourceStatus(BASE + 60_000).exactParameters[0].freshness.status, 'stale',
    'Status describes only committed evidence');
  f.recorder.flush(BASE + 30_000, { force: true });
  assert.equal(f.store.checkpoint().sequence, initial.sequence + 1);
  assert.deepEqual(f.rows(), [original], 'Original source and receipt clocks and physical proof remain immutable');
  const span = f.spans()[0];
  assert.equal(span.samples, 1, 'Supporting meter renewals are not new appliance measurements');
  assert.equal(span.source_time, BASE); assert.equal(span.end_at, BASE + 20_000);
  assert.equal(JSON.parse(span.evidence).meter.observedAt, BASE + 20_000);
  assert.equal(f.store.db.prepare('SELECT sum(polls) n FROM recorder_metrics').get().n, 21);
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 79_999).value, 1);
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 80_000).value, null);
  assert(points(f.store).some(p => p.source_time === BASE + 80_000 && p.value === null));
});

test('native fields keep independent deadlines and source clocks through unchanged renewals', t => {
  const f = fixture(t);
  f.put(BASE);
  f.put(BASE + 20_000, { fanSpeed: BASE + 20_000 });
  f.put(BASE + 25_000, { fanSpeed: BASE + 25_000 });
  f.recorder.flush(BASE + 30_000, { force: true });
  assert.equal(f.rows().length, 1);
  assert.equal(f.spans()[0].samples, 3);
  assert.equal(f.spans()[0].source_time, BASE + 25_000);
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 85_000).value, null, 'The supporting meter still expires first');
  const g = fixture(t);
  g.put(BASE, { meterAge: 300_000 });
  g.put(BASE + 25_000, { fanSpeed: BASE + 25_000, meterAge: 300_000 });
  g.recorder.flush(BASE + 30_000, { force: true });
  assert.equal(g.recorder.committedAt(SIGNAL, BASE + 179_999).value, 1);
  assert.equal(g.recorder.committedAt(SIGNAL, BASE + 180_000).value, null, 'Fan reports cannot renew the older power clock');
});

test('a compact future endpoint cannot lend evidence to an earlier historical query', t => {
  const f = fixture(t);
  f.put(BASE, { meterAge: 10_000 });
  f.put(BASE + 5000, { meterAge: 10_000 });
  f.put(BASE + 12_000, { meterAge: 10_000 });
  f.recorder.flush(BASE + 13_000, { force: true });
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 11_000).value, null);
  assert(points(f.store, BASE + 11_000).some(p => p.source_time === BASE + 10_000 && p.value === null));
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 12_000).value, 1);
});

test('renewal after meter expiry retains a real gap and starts a separate coverage span', t => {
  const f = fixture(t);
  f.put(BASE, { meterAge: 10_000 });
  f.put(BASE + 5000, { meterAge: 10_000 });
  f.put(BASE + 17_000, { meterAge: 10_000 });
  const spans = f.spans();
  assert.equal(spans.length, 2); assert.equal(spans[0].end_at, BASE + 5000);
  assert.equal(spans[1].start_at, BASE + 17_000); assert.equal(spans[1].samples, 0);
  const chart = points(f.store);
  assert(chart.some(p => p.source_time === BASE + 15_000 && p.value === null));
  assert(chart.some(p => p.source_time === BASE + 17_000 && p.value === 1));
  assert.equal(f.recorder.committedAt(SIGNAL, BASE + 16_000).value, null);
});

test('real withdrawals flush prior renewals immediately and remain separate from recovery', t => {
  const f = fixture(t);
  f.put(BASE); f.put(BASE + 1000);
  for (let n = 1; n <= 3; n++) {
    const at = BASE + n * 5000;
    f.recorder.record({ ...report(at), value: null, sourceTime: null, quality: ['state-evidence-unavailable'],
      raw: { timeBasis: 'availability-transition', reportIntervalMs: 180_000, reportGraceMs: 0 } });
    f.put(at + 1000, { power: at + 1000, fanSpeed: at + 1000 });
    f.put(at + 2000, { power: at + 1000, fanSpeed: at + 1000 });
  }
  f.recorder.flush(BASE + 30_000, { force: true });
  assert.equal(f.rows().filter(o => o.value === null).length, 3);
  assert.equal(f.spans().filter(s => s.status !== 'fresh').length, 3);
  assert(!f.rows().some(o => o.raw?.timeBasis === 'report-policy-change'));
});

test('rollback and failed flush preserve the previous renewal batch for exactly one retry', t => {
  const f = fixture(t);
  f.put(BASE); f.put(BASE + 1000);
  const pending = structuredClone(f.recorder.pendingSignals), head = f.store.checkpoint();
  assert.throws(() => f.store.transaction(() => { f.put(BASE + 2000); throw Error('synthetic rollback'); }));
  assert.deepEqual(f.recorder.pendingSignals, pending);
  assert.throws(() => f.store.transaction(() => { f.recorder.flush(BASE + 3000, { force: true }); throw Error('synthetic failed flush'); }));
  assert.deepEqual(f.store.checkpoint(), head); assert.deepEqual(f.recorder.pendingSignals, pending);
  f.recorder.flush(BASE + 3000, { force: true });
  assert.equal(f.spans()[0].end_at, BASE + 1000); assert.equal(f.spans()[0].samples, 1);
  assert.equal(f.store.db.prepare('SELECT sum(polls) n FROM recorder_metrics').get().n, 2);
});

test('restart cannot invent unsaved renewals and a committed endpoint retains its deadline', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-renewal-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recording.sqlite');
  const f = fixture(t, path); f.put(BASE); f.put(BASE + 1000);
  f.store.close();
  const g = fixture(t, path);
  assert.equal(g.recorder.committedAt(SIGNAL, BASE + 60_000).value, null);
  g.put(BASE + 2000); g.recorder.flush(BASE + 3000, { force: true });
  g.store.close();
  const h = fixture(t, path);
  assert.equal(h.recorder.committedAt(SIGNAL, BASE + 61_999).value, 1);
  assert.equal(h.recorder.committedAt(SIGNAL, BASE + 62_000).value, null);
});

test('recovery retains compact evidence continuations and meter-only gap boundaries idempotently', async t => {
  const donor = fixture(t), target = fixture(t);
  for (const f of [donor, target]) f.put(BASE, { meterAge: 10_000 });
  donor.put(BASE + 5000, { meterAge: 10_000 }); donor.recorder.flush(BASE + 6000, { force: true });
  donor.put(BASE + 17_000, { meterAge: 10_000 });
  const merge = () => new HistoryMerge({ target: target.store, donor: donor.store, donorDigest: 'c'.repeat(64),
    input: 'mqtt', now: BASE + 300_000 }).run();
  const first = await merge();
  assert.equal(first.counts.conflicts, 0);
  const meaning = rows => rows.map(({ source_time, value, observedAt, reportExpiresAt }) =>
    ({ source_time, value, observedAt, reportExpiresAt }));
  assert.deepEqual(meaning(points(target.store)), meaning(points(donor.store)));
  const again = await merge(); assert.equal(again.counts.missing, 0); assert.equal(again.counts.conflicts, 0);
});

test('an active history mutation keeps evidence renewals immediate, then ordinary batching resumes', t => {
  const f = fixture(t);
  f.put(BASE); f.put(BASE + 1000);
  f.recorder.flushMetadata(BASE + 1000, { force: true });
  const release = f.recorder.holdMetadata(), before = f.store.checkpoint();
  f.put(BASE + 2000); assert.equal(f.store.checkpoint().sequence, before.sequence + 1);
  assert.equal(f.spans()[0].end_at, BASE + 2000);
  release(); const after = f.store.checkpoint(); f.put(BASE + 3000);
  assert.deepEqual(f.store.checkpoint(), after);
});

test('a failed writer COMMIT preserves compact evidence for one exact retry and reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-renewal-writer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'recording.sqlite'), f = fixture(t, path);
  await f.store.startWriter();
  await f.store.runWrite(() => f.put(BASE));
  await f.store.runWrite(() => f.put(BASE + 1000));
  const before = f.store.checkpoint(), pending = structuredClone(f.recorder.pendingSignals);
  const request = f.store.writer.request;
  f.store.writer.request = function (op, args) {
    if (op === 'commit') throw Object.assign(Error('synthetic commit failure'), { code: 'STORAGE_TEST_FAILURE' });
    return request.call(this, op, args);
  };
  await assert.rejects(f.store.runWrite(() => f.recorder.flush(BASE + 2000, { force: true })));
  f.store.writer.request = request;
  assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(f.recorder.pendingSignals, pending);
  await f.store.runWrite(() => f.recorder.flush(BASE + 2000, { force: true }));
  await f.store.close();
  const g = fixture(t, path);
  assert.equal(g.spans()[0].samples, 1);
  assert.equal(g.recorder.committedAt(SIGNAL, BASE + 60_999).value, 1);
  assert.equal(g.recorder.committedAt(SIGNAL, BASE + 61_000).value, null);
});

test('changed evidence scope flushes immediately; malformed or expired evidence never extends recording', t => {
  const f = fixture(t); f.put(BASE); f.put(BASE + 1000);
  f.put(BASE + 2000, { meterAge: 30_000 });
  assert.equal(f.rows().length, 2); assert.equal(f.spans()[0].end_at, BASE + 1000);
  assert.equal(f.recorder.pendingSignals.size, 0);
  for (const corrupt of [o => { delete o.raw.locationEvidence.maxAgeMs; },
    o => { o.raw.fieldTimestamps.power = o.receivedAt + 1; },
    o => { o.raw.locationEvidence.meterObservedAt = o.receivedAt - 60_000; }]) {
    const g = fixture(t), o = report(BASE + 3000); corrupt(o);
    assert.notEqual(g.recorder.record(o).observation.raw.recorder.status, 'fresh');
    assert.equal(g.recorder.committedAt(SIGNAL, BASE + 3000).value, null);
  }
});

test('a committed meter-only renewal refreshes the real chart worker and browser revision in the same cache bucket', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-renewal-chart-'));
  const store = new Store(join(dir, 'recording.sqlite'));
  let now = BASE + 1000;
  const recorder = new Recorder(store, { clock: () => now });
  const service = createChartService({ store, clock: () => now, warmCache: false, cacheDays: 0 });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  recorder.record(report());
  const revision = recorder.status(now).temperatureReportRevision;
  const args = { input: 'mqtt', left: SIGNAL, startDate: '2026-10-20', endDate: '2026-10-20' };
  const first = await service.query({ ...args, now });
  assert(first.series[SIGNAL].some(p => p.y === 1 && p.reportExpiresAt === BASE + 60_000));
  assert.equal((await service.query({ ...args, now: now + 100 })).meta.cacheHit, true);
  recorder.record(report(BASE + 2000)); recorder.flushMetadata(BASE + 2000, { force: true });
  now = BASE + 3000;
  const next = await service.query({ ...args, now });
  assert.notEqual(next.meta.cacheHit, true);
  assert(next.series[SIGNAL].some(p => p.y === 1 && p.reportExpiresAt === BASE + 62_000));
  assert.notEqual(recorder.status(now).temperatureReportRevision, revision);
  assert.equal(store.observations({ signal: SIGNAL }).length, 1);
});
