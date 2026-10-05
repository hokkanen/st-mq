import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingLimiterHistory, readShellyLimiterHistory, shellyLimiterStatus, SHELLY_LIMITER_SIGNAL } from '../src/charging/limiter-history.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';

const association = 'a'.repeat(64), otherAssociation = 'b'.repeat(64);
const at = Date.parse('2026-10-05T06:00:00Z'), DAY = 86_400_000;
const decision = (extra = {}) => shellyLimiterStatus({ enabled: true, connected: true, online: true,
  maximumCurrentA: 16, limit: { currentA: 16, loadCurrentA: 16, reason: 'property-headroom', loadReason: 'property-headroom' },
  appliedCurrentA: 16, applicationStatus: 'confirmed', ...extra });
function fixture(t, input = 'providers') {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = new ChargingLimiterHistory({ store, input });
  return { store, history, put: (status = decision(), time = at, identity = association) => history.observe({ association: identity, status }, time),
    read: (from = at, to = at + 60_000, maxSpans) => readShellyLimiterHistory({ store, input, range: { from, to }, now: to, maxSpans }) };
}

test('modes describe balancing entitlement separately from native setting and charging state', () => {
  assert.equal(decision().mode, 'unrestricted');
  assert.deepEqual(decision({ limit: { currentA: 8, loadCurrentA: 16, loadReason: 'property-headroom' }, appliedCurrentA: 8 }),
    { mode: 'unrestricted', allowanceA: 8, loadAllowanceA: 16, reason: 'property-headroom', appliedCurrentA: 8, applicationStatus: 'confirmed' });
  assert.equal(decision({ limit: { currentA: 8, loadCurrentA: 8, loadReason: 'charger1-priority' } }).mode, 'limited');
  assert.equal(decision({ limit: { currentA: 0, loadCurrentA: 0, reason: 'below-minimum-current' } }).mode, 'limited', 'a zero request does not prove an owned pause');
  assert.equal(decision({ limit: { currentA: 0, loadCurrentA: 0, reason: 'below-minimum-current' }, pausedByLimiter: true }).mode, 'paused-by-balancing');
  assert.equal(decision({ limit: { currentA: 0, loadCurrentA: 0, reason: 'telemetry-fallback', fallback: true }, pausedByLimiter: true }).mode, 'fallback');
  assert.equal(decision({ limit: { currentA: 6, loadCurrentA: 12, reason: 'telemetry-fallback', fallback: true } }).allowanceA, 6);
  assert.equal(decision({ connected: false }).mode, 'inactive');
  assert.equal(decision({ enabled: false }).reason, 'limiter-disabled');
  assert.equal(decision({ online: false, connected: false }).mode, 'unknown', 'cached unplug state cannot repair offline evidence');
  assert.equal(decision({ limit: null }).mode, 'unknown');
  assert.equal(decision({ connected: null }).mode, 'unknown');
  assert.equal(decision({ limit: { currentA: 16, reason: 'property-headroom' } }).mode, 'unknown', 'missing distinct load allowance cannot classify a native limit');
});

test('fallback preserves the separate load cap and binding native restriction', t => {
  const { put, read } = fixture(t);
  const limited = decision({ limit: { currentA: 9, loadCurrentA: 12, reason: 'native-current-limit',
    loadReason: 'telemetry-fallback', fallback: true, fallbackReason: 'feed-unavailable' }, appliedCurrentA: 9 });
  assert.deepEqual(limited, { mode: 'fallback', allowanceA: 9, loadAllowanceA: 12,
    reason: 'native-current-limit', appliedCurrentA: 9, applicationStatus: 'confirmed' });
  put(limited, at); put(limited, at + 5000);
  assert.deepEqual(read(at, at + 5000).spans.map(({ mode, allowanceA, loadAllowanceA, reason }) =>
    [mode, allowanceA, loadAllowanceA, reason]), [['fallback', 9, 12, 'native-current-limit']]);
});

test('unpaired load transitions retain an unknown held ceiling without extending verified history', t => {
  const { put, read } = fixture(t);
  const pending = decision({ limit: { currentA: 12, loadCurrentA: 12, measurementPending: true,
    reason: 'measurement-pair-pending', modelAvailable: false }, appliedCurrentA: 12 });
  assert.deepEqual(pending, { mode: 'unknown', allowanceA: 12, loadAllowanceA: 12,
    reason: 'measurement-pair-pending', appliedCurrentA: 12, applicationStatus: 'confirmed' });
  put(decision(), at); put(decision(), at + 5000);
  put(pending, at + 10000); put(pending, at + 15000);
  assert.deepEqual(read(at, at + 15000).spans.map(({ start, end, mode, reason }) =>
    [start - at, end - at, mode, reason]), [
    [0, 5000, 'unrestricted', 'property-headroom'], [5000, 10000, 'unknown', 'unobserved'],
    [10000, 15000, 'unknown', 'measurement-pair-pending'],
  ]);
  assert.equal(decision({ limit: { currentA: 12, loadCurrentA: 12, measurementPending: true,
    fallback: true, fallbackReason: 'feed-unavailable' } }).mode, 'fallback', 'A real outage takes precedence');
});

test('every changed allowance, reason and application status is retained; identical observations only extend coverage', t => {
  const { store, put, read } = fixture(t);
  const states = [decision(), decision({ applicationStatus: 'pending' }), decision({ appliedCurrentA: 14 }),
    decision({ limit: { currentA: 14, loadCurrentA: 16, loadReason: 'property-headroom' } }),
    decision({ limit: { currentA: 14, loadCurrentA: 14, loadReason: 'charger1-priority' } })];
  states.forEach((status, index) => { put(status, at + index * 10_000); put(status, at + index * 10_000 + 5000); });
  assert.equal(store.observations({ signal: SHELLY_LIMITER_SIGNAL }).length, states.length);
  assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, states.length);
  const spans = read().spans;
  assert.deepEqual(spans.filter(row => row.mode !== 'unknown').map(({ start, end, equipment, ...status }) => status), states);
  assert.deepEqual(spans.at(-1), { start: at + 45_000, end: at + 60_000, ...shellyLimiterStatus(), reason: 'unobserved', equipment: null });
});

test('offline transitions and recovery preserve the last confirmed endpoint', t => {
  const { put, read } = fixture(t);
  put(decision(), at); put(decision(), at + 5000);
  put(decision({ online: false }), at + 10_000); put(decision({ online: false }), at + 15_000);
  put(decision(), at + 20_000); put(decision(), at + 25_000);
  assert.deepEqual(read(at, at + 25_000).spans.map(({ start, end, mode, reason }) => [start - at, end - at, mode, reason]), [
    [0, 5000, 'unrestricted', 'property-headroom'], [5000, 10_000, 'unknown', 'unobserved'],
    [10_000, 20_000, 'unknown', 'charger-unavailable'], [20_000, 25_000, 'unrestricted', 'property-headroom'],
  ]);
});

test('restart, long tick gap and equipment replacement never renew earlier coverage', t => {
  const { store, put, read } = fixture(t);
  put(); put(decision(), at + 5000);
  const restarted = new ChargingLimiterHistory({ store, input: 'providers' });
  restarted.observe({ association, status: decision() }, at + 10_000);
  restarted.observe({ association, status: decision() }, at + 15_000);
  restarted.observe({ association, status: decision() }, at + 50_000);
  restarted.observe({ association, status: decision() }, at + 55_000);
  restarted.observe({ association: otherAssociation, status: decision() }, at + 60_000);
  restarted.observe({ association: otherAssociation, status: decision() }, at + 65_000);
  assert.deepEqual(read(at, at + 65_000).spans.filter(row => row.mode === 'unknown').map(row => [row.start - at, row.end - at]),
    [[5000, 10_000], [15_000, 50_000], [55_000, 60_000]]);
  assert.equal(read(at, at + 65_000).spans.at(-1).equipment, otherAssociation);
  assert.equal(restarted.observe({ association: otherAssociation, status: decision() }, at + 20_000).reason, 'out-of-order');
});

test('dense selections bound output, preserve exact recent states and expose omitted prefix', t => {
  const { put, read } = fixture(t);
  for (let i = 0; i < 100; i++) put(decision({ appliedCurrentA: i % 2 ? 16 : 14 }), at + i * 1000);
  const history = read(at, at + 100_000, 8);
  assert.equal(history.truncated, true);
  assert(history.spans.length <= 10);
  assert.equal(history.spans[0].reason, 'history-detail-required');
  assert.equal(history.spans.at(-1).reason, 'unobserved');
  const detail = read(at + 5000, at + 8000, 8);
  assert.equal(detail.truncated, false);
  assert.deepEqual(detail.spans.map(row => row.appliedCurrentA), [16, 14, 16]);
});

test('real and simulated history stay separate and query never extends beyond now', t => {
  const { store, put, read } = fixture(t);
  put(); put(decision(), at + 5000);
  const simulated = new ChargingLimiterHistory({ store, input: 'simulated' });
  simulated.observe({ association: otherAssociation, status: decision({ applicationStatus: 'pending' }) }, at);
  simulated.observe({ association: otherAssociation, status: decision({ applicationStatus: 'pending' }) }, at + 5000);
  assert.equal(read(at, at + 5000).spans[0].applicationStatus, 'confirmed');
  const queried = readShellyLimiterHistory({ store, input: 'simulated', range: { from: at, to: at + DAY }, now: at + 5000 });
  assert.equal(queried.spans.length, 1);
  assert.equal(queried.spans[0].applicationStatus, 'pending');
  assert.equal(queried.spans[0].end, at + 5000);
});

test('report expiry does not remove independent limiter history and inventory describes its actual writer', t => {
  const { store, put } = fixture(t);
  put(); put(decision(), at + 5000);
  store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,ended_at,summary,checkpoint)
    VALUES('test','charger2','old',?,?,?,'{}','{}')`).run(association, at - 32 * DAY, at - 31 * DAY);
  const reports = new ChargingSessionDiagnostics({ store, key: 'test' });
  reports.prune(at);
  assert.equal(store.db.prepare('SELECT count(*) n FROM charging_reports').get().n, 0);
  assert.equal(store.observations({ signal: SHELLY_LIMITER_SIGNAL }).length, 1);
  const overview = getDatabaseOverview({ store, now: at + 5000 });
  const entry = overview.groups.flatMap(group => group.items).find(item => item.id === SHELLY_LIMITER_SIGNAL);
  assert.equal(entry.retention, 'history');
  assert.equal(entry.count, 1);
  assert.match(entry.description, /independently of charging reports/);
  assert.match(entry.writeBehavior, /unchanged observations extend/);
  assert(!JSON.stringify(overview).includes(association));
});

test('five-second stable polling for a day keeps one state and one coverage row with constant database size', t => {
  const { store, put } = fixture(t);
  put();
  const before = store.databaseBytes();
  for (let offset = 5000; offset <= DAY; offset += 5000) put(decision(), at + offset);
  assert.equal(store.databaseBytes(), before);
  assert.equal(store.observations({ signal: SHELLY_LIMITER_SIGNAL }).length, 1);
  const coverage = store.db.prepare('SELECT * FROM recorder_coverage').all();
  assert.equal(coverage.length, 1); assert.equal(coverage[0].samples, 17_281); assert.equal(coverage[0].end_at, at + DAY);
});

test('chart history includes clipped limiter spans only for selected electrical views', t => {
  const { store, put } = fixture(t); put(); put(decision(), at + 5000);
  const options = { store, input: 'providers', now: at + 60_000, startDate: '2026-10-05', endDate: '2026-10-05' };
  const power = getChartData({ ...options, left: 'charger2_power' });
  assert(power.limiterHistory.spans.some(row => row.mode === 'unrestricted'));
  const detail = getChartData({ ...options, left: 'charger2_power', viewFrom: at + 1000, viewTo: at + 3000 });
  assert.equal(detail.limiterHistory.spans[0].start, at + 1000);
  assert.equal(detail.limiterHistory.spans[0].end, at + 3000);
  assert.equal(getChartData({ ...options, left: 'indoor_temperature' }).limiterHistory, undefined);
});

test('malformed status or identity fails before writing and recovery exclusions remain effective', t => {
  const { store, put, read } = fixture(t);
  assert.throws(() => put({ ...decision(), cachedSnapshot: {} }), /Invalid Shelly limiter/);
  assert.throws(() => put(decision(), at, 'raw-private-device'), /equipment identity/);
  assert.equal(store.observations().length, 0);
  put(); put(decision(), at + 5000);
  const id = store.observations()[0].id;
  store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)").run(String(id));
  assert.deepEqual(read().spans, []);
});

test('overlapping controller histories remain unknown rather than choosing an owner', t => {
  const { store, put, read } = fixture(t);
  put(); put(decision(), at + 25_000);
  const concurrent = new ChargingLimiterHistory({ store, input: 'providers' });
  concurrent.observe({ association, status: decision({ appliedCurrentA: 12 }) }, at + 10_000);
  concurrent.observe({ association, status: decision({ appliedCurrentA: 12 }) }, at + 20_000);
  const spans = read(at, at + 25_000).spans;
  assert.deepEqual(spans.map(row => [row.start - at, row.end - at, row.reason]),
    [[0, 10_000, 'property-headroom'], [10_000, 25_000, 'overlapping-history']]);
});

test('transition storage grows with changed states rather than time or complete telemetry snapshots', t => {
  const { store, put } = fixture(t), before = store.databaseBytes();
  for (let i = 0; i < 1000; i++) put(decision({ appliedCurrentA: i % 2 ? 16 : 14 }), at + i * 5000);
  const growth = store.databaseBytes() - before;
  assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 1000);
  assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, 1000);
  assert(growth < 1_500_000, `${growth} bytes for1000 compact transitions`);
  const row = store.observations()[0];
  assert.deepEqual(Object.keys(row.raw).sort(), ['input', 'limiter', 'recorder', 'timeBasis']);
  t.diagnostic(`Synthetic1000-transition allocated database growth: ${growth} bytes; ${(growth / 1000).toFixed(0)} bytes per transition including indexes.`);
});

test('suspension fences history coverage even when authority returns before the ordinary tick deadline', t => {
  const { history, put, read } = fixture(t);
  put(); put(decision(), at + 5000); history.suspend();
  put(decision(), at + 10_000); put(decision(), at + 15_000);
  assert.deepEqual(read(at, at + 15_000).spans.filter(row => row.mode === 'unknown').map(row => [row.start - at, row.end - at]), [[5000, 10_000]]);
});

test('worker cache refreshes extended limiter coverage without new transition rows and keeps completed detail cached', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'limiter-history-cache-'));
  const store = new Store(join(directory, 'history.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const history = new ChargingLimiterHistory({ store, input: 'providers' });
  const put = time => history.observe({ association, status: decision() }, time);
  const options = { input: 'providers', now: at + 20_000, left: 'charger2_power', startDate: '2026-10-05', endDate: '2026-10-05' };
  put(at); put(at + 5000);
  const first = await service.query(options);
  assert.equal(first.limiterHistory.spans.find(row => row.mode === 'unrestricted').end, at + 5000);
  assert.equal((await service.query(options)).meta.cacheHit, true);
  put(at + 10_000);
  assert.equal(store.observations({ signal: SHELLY_LIMITER_SIGNAL }).length, 1);
  const extended = await service.query(options);
  assert.notEqual(extended.meta.cacheHit, true);
  assert.equal(extended.limiterHistory.spans.find(row => row.mode === 'unrestricted').end, at + 10_000);
  const detail = { ...options, viewFrom: at + 1000, viewTo: at + 4000 };
  await service.query(detail);
  put(at + 15_000);
  assert.equal((await service.query(detail)).meta.cacheHit, true, 'Later coverage cannot invalidate an already complete selected interval');
});
