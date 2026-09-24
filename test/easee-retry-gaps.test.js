import {Engine} from '../src/app/engine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { startProviders } from '../src/acquisition/providers.js';
import { ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';
import { getChartData } from '../src/app/chart-data.js';
import { describeProvider } from '../chart/provider-status.js';

const start = Date.parse('2026-09-08T10:00:00Z'), SECOND = 1000, MINUTE = 60 * SECOND;

function fixture(t, failureAt) {
  const store = new Store(':memory:');
  const recorder = new Recorder(store);
  let now = start, calls = 0;
  const config = { dataDir: '/tmp', connections: { easee: {
    charger_id: 'invented-charger', equalizer_id: 'invented-equalizer',
  } } };
  const engine = { ingestionCheckpoint:Engine.prototype.ingestionCheckpoint, restoreIngestionCheckpoint:Engine.prototype.restoreIngestionCheckpoint, recorder, latest: {}, outdoorCandidates: {}, ingest() {}, providerObservations() { return []; },
    ingestEnergy(interval) { recorder.recordEnergy(interval); } };
  const options = { engine, store, config, automatic: false, clock: () => now,
    http: { close() {} }, devices: { async electricity() {
      calls++;
      return ['ev1', 'property'].flatMap(prefix => {
        const failure = failureAt(prefix, now);
        if (failure?.throws) throw Object.assign(new Error('Synthetic transport failure'), { status: failure.status, retryAfterMs: failure.retryAfterMs });
        return ELECTRICITY_FIELDS[prefix].map(([id, signal, unit]) => ({
          source: 'easee', device: `invented-${prefix}`, signal: `${prefix}_${signal}`, unit,
          value: failure ? null : unit === 'A' ? 10 : unit === 'V' ? 230 : unit === 'kW' ? 6.9 : 100,
          sourceTime: failure ? null : now, receivedAt: now,
          quality: failure ? ['provider_error', 'missing', ...(failure.status ? [`http_status_${failure.status}`] : [])] : [],
          raw: { observationId: id, error: failure?.code, retryAfterMs: failure?.retryAfterMs },
        }));
      });
    } } };
  let providers = startProviders(options);
  t.after(async () => { await providers.close(); store.close(); });
  return { store, recorder, get calls() { return calls; },
    health: () => store.getState('providers:health').easee,
    async poll(at) { now = at; await providers.runDue(); },
    async restart() { await providers.close(); providers = startProviders(options); },
  };
}

test('one transient Easee device failure recovers on its normal cadence and preserves the other device chart', async t => {
  const failedAt = start + MINUTE, recoveredAt = failedAt + 15 * SECOND;
  const f = fixture(t, (prefix, at) => prefix === 'ev1' && at === failedAt ? { status: 503 } : null);
  for (let at = start; at <= failedAt; at += 15 * SECOND) await f.poll(at);
  assert.equal(f.health().nextAttemptAt, recoveredAt, 'A transient error must not force a five-minute acquisition hole');
  await f.restart();
  await f.poll(recoveredAt - 1);
  assert.equal(f.calls, 5, 'Restart preserves the scheduled retry');
  for (let at = recoveredAt; at <= recoveredAt + MINUTE; at += 15 * SECOND) await f.poll(at);
  assert.equal(f.health().failures, 0);
  f.recorder.flush(recoveredAt + MINUTE, { force: true });
  const chart = getChartData({ store: f.store, input: 'providers', startDate: '2026-09-08',
    endDate: '2026-09-08', now: recoveredAt + MINUTE, left: 'power' });
  const property = chart.series.property_power.filter(point => point.x >= start && point.x < recoveredAt + MINUTE);
  assert(property.length > 0 && property.every(point => Number.isFinite(point.y)), 'The healthy Equalizer remains continuous');
  const charger = chart.series.charger_power;
  assert(charger.some(point => point.y === null && point.x >= failedAt - 15 * SECOND && point.x < recoveredAt));
  assert(!charger.some(point => Number.isFinite(point.y) && point.x >= failedAt - 15 * SECOND && point.x < recoveredAt),
    'The failed charger interval remains genuinely missing');
  assert(charger.some(point => Number.isFinite(point.y) && point.x === recoveredAt));
});

test('repeated transient Easee failures back off exponentially and remain bounded', async t => {
  const f = fixture(t, () => ({ status: 503 }));
  let at = start;
  for (const seconds of [15, 30, 60, 120, 240, 480, 960, 1800, 1800, 1800]) {
    await f.poll(at);
    assert.equal(f.health().nextAttemptAt - at, seconds * SECOND);
    at = f.health().nextAttemptAt;
  }
});

test('Easee timeout diagnostics survive restart and recovery without blaming absent response fields', async t => {
  const f = fixture(t, (prefix, at) => prefix === 'property' && at === start ? { code: 'provider-request-timeout' } : null);
  await f.poll(start);
  assert.equal(f.health().currentReadings.charger.error, null);
  assert.equal(f.health().currentReadings.property.error, 'provider-request-timeout');
  assert.deepEqual(f.health().currentReadings.property.qualityIssues, []);
  assert.deepEqual(f.health().qualityIssues, []);
  const display = describeProvider('easee', f.health(), { now: start, formatTime: String });
  assert.match(display.detail, /Property readings: Download timed out\./);
  assert.doesNotMatch(display.detail, /missing|no source timestamp|Charger 1 readings: Download/);
  await f.restart();
  assert.equal(f.health().currentReadings.property.error, 'provider-request-timeout');
  await f.poll(start + 15 * SECOND);
  assert.equal(f.health().currentReadings.property.error, null);
  assert.equal(f.health().lastSuccessAt, start + 15 * SECOND);
});

for (const [failure, expected] of [
  [{ status: 429 }, 5 * MINUTE],
  [{ status: 401 }, 30 * MINUTE],
  [{ status: 403 }, 30 * MINUTE],
  [{ status: 404 }, 5 * MINUTE],
  [{ status: 503, retryAfterMs: 2 * 60 * MINUTE }, 2 * 60 * MINUTE],
  [{ status: 429, retryAfterMs: 2 * 60 * MINUTE, throws: true }, 2 * 60 * MINUTE],
]) test(`Easee preserves rate/authentication/explicit retry cooldown for HTTP ${failure.status}${failure.retryAfterMs ? ' with Retry-After' : ''}`, async t => {
  const f = fixture(t, () => failure);
  await f.poll(start);
  assert.equal(f.health().nextAttemptAt, start + expected);
  await f.restart();
  await f.poll(start + expected - 1);
  assert.equal(f.calls, 1);
});

for (const status of [401, 403, 429]) test(`a transient charger error cannot hide an Equalizer HTTP ${status} cooldown`, async t => {
  const f = fixture(t, prefix => ({ status: prefix === 'ev1' ? 503 : status }));
  await f.poll(start);
  assert.equal(f.health().currentReadings.property.error, `HTTP-${status}`);
  assert.equal(f.health().nextAttemptAt, start + (status === 429 ? 5 : 30) * MINUTE);
});

test('recorder batching delays only the newest chart tail and creates no interior gap when committed', async t => {
  const f = fixture(t, () => null);
  const chart = now => getChartData({ store: f.store, input: 'providers', startDate: '2026-09-08',
    endDate: '2026-09-08', now, left: 'power' });
  for (let at = start; at <= start + 4 * MINUTE; at += 15 * SECOND) await f.poll(at);
  const before = f.store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  const pending = chart(start + 4 * MINUTE);
  const confirmedEnd = pending.series.charger_power.at(-1).x;
  assert.equal(pending.series.charger_power.at(-1).y, null);
  assert(confirmedEnd < start + 4 * MINUTE, 'An uncommitted recorder tail is not presented as recorded history');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, before, 'Chart reads cannot force recorder writes');
  for (let at = start + 4 * MINUTE + 15 * SECOND; at <= start + 7 * MINUTE; at += 15 * SECOND) await f.poll(at);
  const committed = chart(start + 7 * MINUTE).series.charger_power;
  assert(committed.at(-1).x > confirmedEnd, 'The normal recorder deadline publishes the completed pending interval');
  assert(committed.slice(0, -1).every(point => Number.isFinite(point.y)), 'Coalesced intervals have no artificial interior gaps');
});
