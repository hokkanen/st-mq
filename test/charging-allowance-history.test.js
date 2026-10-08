import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ChargingAllowanceHistory, readChargingAllowanceHistory, shellyLimiterStatus,
  shellyAllowanceStatus, easeeAllowanceStatus, CHARGING_ALLOWANCE_SIGNALS } from '../src/charging/allowance-history.js';
import { easeeChargerTelemetry, createEaseeScheduleAdapter } from '../src/charging/easee.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';

const association = 'a'.repeat(64), otherAssociation = 'b'.repeat(64);
const at = Date.parse('2026-10-05T06:00:00Z'), DAY = 86_400_000;
const limiter = (extra = {}) => shellyLimiterStatus({ enabled: true, connected: true, online: true,
  maximumCurrentA: 16, limit: { currentA: 16, loadCurrentA: 16, reason: 'property-headroom', loadReason: 'property-headroom' },
  appliedCurrentA: 16, applicationStatus: 'confirmed', ...extra });
const decision = (extra = {}, metadata = {}) => shellyAllowanceStatus({ limiter: limiter(extra), maximumCurrentA: 16, evaluatedAt: at, ...metadata });
const native = (values = [16, 16, 16], extra = {}) => easeeChargerTelemetry({ online: true, readAt: at,
  pluggedIn: true, externalLoadBalancing: true,
  observations: Object.fromEntries([230, 231, 232].map((id, index) => [id, { value: values[index], at: at - 3000 + index * 1000 }])),
  limits: { chargerA: 16, cableA: 32, circuitA: [25, 25, 25], dynamicChargerA: 8, equalizerAvailableA: values }, ...extra }, { now: at });
function fixture(t, input = 'providers') {
  const store = new Store(':memory:'); t.after(() => store.close());
  const history = new ChargingAllowanceHistory({ store, input });
  return { store, history,
    put: (status = decision(), time = at, identity = association, chargerId = 'charger2') => history.observe({ chargerId, association: identity, status }, time),
    read: (from = at, to = at + 60_000, maxSpans) => readChargingAllowanceHistory({ store, input, range: { from, to }, now: to, maxSpans }) };
}

test('shared Shelly allowance reports load entitlement independently of setting, fallback zero and connection', () => {
  const status = decision({ limit: { currentA: 8, loadCurrentA: 16, loadReason: 'property-headroom' }, appliedCurrentA: 8 });
  assert.equal(status.mode, 'unrestricted'); assert.equal(status.allowanceA, 16); assert.equal(status.limiter.allowanceA, 8);
  assert.equal(decision({ limit: { currentA: 8, loadCurrentA: 8, reason: 'charger1-priority' } }).mode, 'limited');
  const zero = { currentA: 0, loadCurrentA: 0, reason: 'below-minimum-current' };
  assert.equal(decision({ limit: zero, pausedByLimiter: true }).mode, 'limited');
  assert.equal(decision({ limit: { ...zero, fallback: true }, pausedByLimiter: true }).mode, 'fallback');
  assert.equal(decision({ limit: { ...zero, fallback: true } }).allowanceA, 0);
  const disconnected = decision({ connected: false });
  assert.equal(disconnected.mode, 'unrestricted'); assert.equal(disconnected.allowanceA, 16);
  assert.equal(disconnected.limiter.applicationStatus, 'inactive');
  assert.equal(decision({ connected: false, pausedByLimiter: true, limit: zero }).mode, 'limited');
  assert.equal(decision({ connected: false, limit: null }).mode, 'unknown');
  assert.equal(decision({ connected: undefined }).mode, 'unknown');
  assert.equal(decision({ connected: false, enabled: false }).mode, 'inactive');
  assert.equal(decision({ online: false, connected: false }).mode, 'unknown');
});

test('Equalizer allowance remains observable without a connected vehicle, retaining zero and source loss', () => {
  const status = (values, extra = {}) => easeeAllowanceStatus({ telemetry: native(values, { pluggedIn: false, ...extra }), now: at });
  assert.equal(status([16, 14, 15]).allowanceA, 14);
  assert.equal(status([16, 0, 15]).allowanceA, 0);
  const noCable = status([20, 22, 21], { limits: { chargerA: 16, cableA: null,
    circuitA: [25, 25, 25], equalizerAvailableA: [20, 22, 21] } });
  assert.equal(noCable.maximumCurrentA, 16, 'An absent cable leaves known fixed equipment limits intact');
  assert.equal(noCable.allowanceA, 16);
  assert.equal(status([16, 14, 15], { online: false }).mode, 'unknown');
  assert.equal(status([16, 14, 15], { externalLoadBalancing: false }).mode, 'inactive');
});

test('Equalizer allowance uses every phase including zero and decimals, with only fixed equipment ceilings', () => {
  const status = values => easeeAllowanceStatus({ telemetry: native(values), now: at });
  assert.equal(status([23, 22, 25]).allowanceA, 16); assert.equal(status([23, 22, 25]).reportedAllowanceA, 22);
  assert.equal(status([8.75, 12, 10]).allowanceA, 8.75); assert.equal(status([8.75, 12, 10]).mode, 'limited');
  assert.equal(status([16, 0, 12]).allowanceA, 0); assert.equal(status([16, 0, 12]).mode, 'limited');
  for (const values of [[16, null, 12], [16, -1, 12], [16, NaN, 12], [16, 12]]) assert.equal(status(values).mode, 'unknown');
  const full = status([23, 22, 25]);
  assert.deepEqual(full.sourceTimes, [at - 3000, at - 2000, at - 1000]);
  assert.equal(full.measuredAt, at - 3000); assert.equal(full.receivedAt, at); assert.equal(full.source, 'easee-equalizer');
});

test('OCPP status cannot manufacture cloud allowance clocks or availability', () => {
  const adapter = createOcppScheduleAdapter({ scope: association, request: async () => ({}), readSnapshot: () => ({}), clock: () => at });
  const cloud = native([12, 14, 16]);
  const snapshot = { online: true, readAt: at, statusAt: at, connectorStatus: 'Charging', pluggedIn: true,
    limits: cloud.limits, allowanceTelemetry: { availableCurrentA: cloud.availableCurrentA, maxCurrentA: cloud.maxCurrentA } };
  const normalized = adapter.normalize(snapshot, { now: at });
  assert.deepEqual(normalized.availableCurrentA, cloud.availableCurrentA);
  assert.equal(easeeAllowanceStatus({ telemetry: normalized, now: at }).allowanceA, 12);
  const zeroCeiling = native([12, 14, 16], { limits: { chargerA: 0, cableA: 32, circuitA: [25, 25, 25], equalizerAvailableA: [12, 14, 16] } });
  const zeroNative = adapter.normalize({ ...snapshot, limits: zeroCeiling.limits,
    allowanceTelemetry: { availableCurrentA: zeroCeiling.availableCurrentA, maxCurrentA: zeroCeiling.maxCurrentA } }, { now: at });
  const zeroAllowance = easeeAllowanceStatus({ telemetry: zeroNative, now: at });
  assert.equal(zeroAllowance.maximumCurrentA, 0); assert.equal(zeroAllowance.allowanceA, 0); assert.equal(zeroAllowance.mode, 'limited');
  assert.equal(easeeAllowanceStatus({ telemetry: adapter.normalize({ ...snapshot, readAt: at + 301_000,
    statusAt: at + 301_000 }, { now: at + 301_000 }), now: at + 301_000 }).mode, 'unknown');
  assert.equal(adapter.normalize({ ...snapshot, allowanceTelemetry: undefined }, { now: at }).availableCurrentA.available, false);
});

test('healthy source evidence can confirm held clocks while lost source health cannot', () => {
  const telemetry = native([12, 14, 16]);
  telemetry.availableCurrentA.receivedAt = at - DAY;
  telemetry.availableCurrentA.sourceEvidence = { source: 'easee-stream', connected: true, online: true, synchronized: true, epoch: '1:0' };
  assert.equal(easeeAllowanceStatus({ telemetry, now: at }).allowanceA, 12);
  telemetry.availableCurrentA.sourceEvidence.connected = false;
  assert.equal(easeeAllowanceStatus({ telemetry, now: at }).mode, 'unknown');
});

test('both histories independently retain value/status changes without adding rows for advancing clocks', t => {
  const { store, put, read } = fixture(t);
  const first = easeeAllowanceStatus({ telemetry: native([12.5, 14, 16]), now: at });
  put(first, at, otherAssociation, 'charger1'); put(first, at + 5000, otherAssociation, 'charger1');
  const states = [decision(), decision({ applicationStatus: 'pending' }), decision({ appliedCurrentA: 14 }),
    decision({ limit: { currentA: 14, loadCurrentA: 14, reason: 'charger1-priority' } })];
  states.forEach((status, index) => { put(status, at + index * 10_000); put({ ...status, measuredAt: at + index * 10_000 + 5000 }, at + index * 10_000 + 5000); });
  assert.equal(store.observations({ signal: CHARGING_ALLOWANCE_SIGNALS.charger2 }).length, states.length);
  assert.equal(store.observations({ signal: CHARGING_ALLOWANCE_SIGNALS.charger1 }).length, 1);
  assert.equal(read().charger1.spans[0].allowanceA, 12.5);
  assert.equal(read().charger2.spans.filter(row => row.mode !== 'unknown').length, states.length);
  const row = store.observations({ signal: CHARGING_ALLOWANCE_SIGNALS.charger1 })[0];
  assert.equal(row.value, 12.5); assert.equal(row.unit, 'A'); assert.equal(row.sourceTime, at - 3000);
});

test('normal to fallback zero and back remain positive numeric observations and separate explicit modes', t => {
  const { store, put, read } = fixture(t);
  const fallback = decision({ limit: { currentA: 0, loadCurrentA: 0, reason: 'feed-unavailable', fallback: true } });
  put(); put(decision(), at + 5000); put(fallback, at + 10_000); put(fallback, at + 15_000);
  put(decision(), at + 20_000); put(decision(), at + 25_000);
  assert.deepEqual(read(at, at + 25_000).charger2.spans.map(row => [row.mode, row.allowanceA]),
    [['unrestricted', 16], ['fallback', 0], ['unrestricted', 16]]);
  assert.deepEqual(store.observations({ signal: CHARGING_ALLOWANCE_SIGNALS.charger2 }).map(row => row.value), [16, 0, 16]);
});

test('unavailable evidence never extends preceding known coverage', t => {
  const { put, read } = fixture(t);
  put(); put(decision(), at + 5000);
  const unavailable = decision({ online: false });
  put(unavailable, at + 10_000); put(unavailable, at + 15_000); put(decision(), at + 20_000); put(decision(), at + 25_000);
  assert.deepEqual(read(at, at + 25_000).charger2.spans.map(row => [row.start - at, row.end - at, row.mode]),
    [[0, 5000, 'unrestricted'], [5000, 10000, 'unknown'], [10000, 20000, 'unknown'], [20000, 25000, 'unrestricted']]);
});

test('restart, delayed tick, source epoch, suspension and equipment replacement preserve unknown gaps', t => {
  const { store, put, read } = fixture(t);
  put(); put(decision(), at + 5000);
  const restarted = new ChargingAllowanceHistory({ store, input: 'providers' });
  const next = (time, status = decision(), identity = association) => restarted.observe({ chargerId: 'charger2', association: identity, status }, at + time);
  next(10000); next(15000); next(50000); next(55000);
  next(60000, decision({}, { sourceEpoch: 'new-connection' })); next(65000, decision({}, { sourceEpoch: 'new-connection' }));
  next(70000, decision(), otherAssociation); next(75000, decision(), otherAssociation);
  restarted.suspend(); next(80000); next(85000);
  assert.deepEqual(read(at, at + 85000).charger2.spans.filter(row => row.mode === 'unknown').map(row => [row.start - at, row.end - at]),
    [[5000,10000], [15000,50000], [55000,60000], [65000,70000], [75000,80000]]);
  assert.equal(next(20000).reason, 'out-of-order');
});

test('dense query bounds exact recent states, preserves independent charger history, and exposes omitted prefix', t => {
  const { put, read } = fixture(t);
  for (let i = 0; i < 100; i++) put(decision({ appliedCurrentA: i % 2 ? 16 : 14 }), at + i * 1000);
  const history = read(at, at + 100_000, 8).charger2;
  assert.equal(history.truncated, true); assert(history.spans.length <= 10); assert.equal(history.spans[0].reason, 'history-detail-required');
  const detail = read(at + 5000, at + 8000, 8).charger2;
  assert.deepEqual(detail.spans.map(row => row.limiter.appliedCurrentA), [16,14,16]);
});

test('report pruning cannot remove independent allowance history and public inventory describes compact coverage', t => {
  const { store, put } = fixture(t); put(); put(decision(), at + 5000);
  store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,ended_at,summary,checkpoint)
    VALUES('test','charger2','old',?,?,?,'{}','{}')`).run(association, at - 32 * DAY, at - 31 * DAY);
  new ChargingSessionDiagnostics({ store, key: 'test' }).prune(at);
  assert.equal(store.db.prepare('SELECT count(*) n FROM charging_reports').get().n, 0);
  const overview = getDatabaseOverview({ store, now: at + 5000 });
  const entry = overview.groups.flatMap(group => group.items).find(item => item.id === CHARGING_ALLOWANCE_SIGNALS.charger2);
  assert.equal(entry.count, 1); assert.equal(entry.retention, 'history');
  assert.match(entry.writeBehavior, /unchanged valid observations extend/); assert(!JSON.stringify(overview).includes(association));
});

test('five-second unchanged polling over a day updates one state and one coverage row with journaled continuity', t => {
  const { store, put } = fixture(t); put(); const before = store.checkpoint();
  for (let offset = 5000; offset <= DAY; offset += 5000) put(decision({}, { evaluatedAt: at + offset }), at + offset);
  assert(store.checkpoint().sequence>before.sequence, 'coverage extensions remain transferable committed changes');
  assert.equal(store.observations().length, 1);
  const rows = store.db.prepare('SELECT * FROM recorder_coverage').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].samples, 17_281); assert.equal(rows[0].end_at, at + DAY);
});

test('malformed status and identity fail before writing; recovery exclusions and overlaps stay unknown', t => {
  const { store, put, read } = fixture(t);
  assert.throws(() => put({ ...decision(), oldLimiter: {} }), /Invalid charging allowance/);
  assert.throws(() => put({ ...decision(), allowanceA: -12 }), /Invalid charging allowance/);
  assert.throws(() => put(decision(), at, 'raw-private-device'), /equipment identity/); assert.equal(store.observations().length, 0);
  put(); put(decision(), at + 25_000);
  const other = new ChargingAllowanceHistory({ store, input: 'providers' });
  other.observe({ chargerId: 'charger2', association, status: decision({ appliedCurrentA: 12 }) }, at + 10_000);
  other.observe({ chargerId: 'charger2', association, status: decision({ appliedCurrentA: 12 }) }, at + 20_000);
  assert.deepEqual(read(at, at + 25_000).charger2.spans.map(row => [row.start - at, row.end - at, row.reason]),
    [[0, 10000, 'property-headroom'], [10000, 25000, 'overlapping-history']]);
  for (const row of store.observations()) store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)").run(String(row.id));
  assert.deepEqual(read().charger2.spans, []);
});

test('real and simulated allowance streams stay separate and never extend beyond now', t => {
  const { store, put, read } = fixture(t); put(); put(decision(), at + 5000);
  const simulated = new ChargingAllowanceHistory({ store, input: 'simulated' });
  for (const time of [at, at + 5000]) simulated.observe({ chargerId: 'charger2', association: otherAssociation, status: decision({ appliedCurrentA: 12 }) }, time);
  assert.equal(read().charger2.spans[0].limiter.appliedCurrentA, 16);
  const result = readChargingAllowanceHistory({ store, input: 'simulated', range: { from: at, to: at + DAY }, now: at + 5000 });
  assert.equal(result.charger2.spans.length, 1); assert.equal(result.charger2.spans[0].limiter.appliedCurrentA, 12);
  assert.equal(result.charger2.spans[0].end, at + 5000);
});

test('currents chart and worker cache observe compact allowance coverage extensions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'allowance-history-cache-'));
  const store = new Store(join(directory, 'history.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const history = new ChargingAllowanceHistory({ store, input: 'providers' });
  const put = time => history.observe({ chargerId: 'charger2', association, status: decision() }, time);
  const options = { input: 'providers', now: at + 20_000, view: 'charging_currents', startDate: '2026-10-05', endDate: '2026-10-05' };
  put(at); put(at + 5000);
  const first = await service.query(options);
  assert(first.series.ev2_current_allowance.some(point => point.y === 16));
  assert.equal((await service.query(options)).meta.cacheHit, true);
  put(at + 10_000); assert.equal(store.observations().length, 1);
  const extended = await service.query(options); assert.notEqual(extended.meta.cacheHit, true);
  assert.notDeepEqual(extended.series.ev2_current_allowance, first.series.ev2_current_allowance);
  const detail = { ...options, viewFrom: at + 1000, viewTo: at + 4000 };
  await service.query(detail); put(at + 15_000);
  assert.equal((await service.query(detail)).meta.cacheHit, true);
  const indoor = getChartData({ ...options, store, view: 'temperatures' });
  assert.equal(indoor.series.ev2_current_allowance, undefined);
});


test('changed and reconnected stream allowance keeps current values paired with its original clocks', () => {
  const snapshot = { ...native().limits };
  let sourceAt = at - 1000, epoch = '1:0', currents = [16, 16, 16], online = true;
  const evidence = () => ({ source: 'easee-stream', connected: online, online, synchronized: online,
    epoch, receivedAt: at, observations: [230, 231, 232].map((id, index) => ({ id, value: currents[index], timestamp: new Date(sourceAt).toISOString() })) });
  const adapter = createEaseeScheduleAdapter({ chargerId: 'fixture', readAllowanceEvidence: evidence, clock: () => at });
  const oldSnapshot = { online: true, readAt: at - 5000, pluggedIn: true, limits: snapshot,
    observations: native().observations, allowanceEvidence: evidence() };
  const view = () => easeeAllowanceStatus({ telemetry: adapter.normalize(oldSnapshot), now: at });
  assert.equal(view().allowanceA, 16);
  currents = [12.5, 14, 16]; sourceAt = at - 500;
  assert.equal(view().allowanceA, 12.5); assert.equal(view().measuredAt, at - 500);
  epoch = '2:0'; currents = [16, 0, 16]; sourceAt = at;
  assert.equal(view().allowanceA, 0); assert.equal(view().sourceEpoch, 'easee-stream:2:0');
  assert.deepEqual(view().sourceTimes, [at, at, at]);
  online = false; assert.equal(view().mode, 'unknown');
  online = true; currents = [16, null, 16]; assert.equal(view().mode, 'unknown');
});


test('Charger 1 minute cadence preserves compact coverage without depending on Charger 2 polling', t => {
  const { store, put, read } = fixture(t);
  const status = easeeAllowanceStatus({ telemetry: native(), now: at });
  for (const offset of [0, 60_000, 120_000]) put(status, at + offset, association, 'charger1');
  assert.equal(store.observations().length, 1);
  assert.deepEqual(read(at, at + 120_000).charger1.spans.map(row => [row.start, row.end, row.allowanceA]), [[at, at + 120_000, 16]]);
  put(status, at + 220_000, association, 'charger1'); put(status, at + 280_000, association, 'charger1');
  assert.equal(read(at, at + 280_000).charger1.spans.find(row => row.mode === 'unknown').start, at + 120_000);
});
