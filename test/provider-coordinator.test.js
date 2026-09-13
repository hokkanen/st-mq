import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { startProviders } from '../src/acquisition/providers.js';
import { start } from '../src/main.js';
import { assembleOutlook } from '../src/app/contract.js';
import { describeProvider } from '../chart/provider-status.js';
import { ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';

const initial = Date.parse('2026-09-06T09:00:00Z'), MINUTE = 60_000;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-providers-'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: dir, STMQ_DATA_DIR: dir, STMQ_PORT: '0' }, dir), input: 'providers',
    acquisition: { easeeIntervalMs: 5 * MINUTE, weatherIntervalMs: 60 * MINUTE, outdoorIntervalMs: 10 * MINUTE },
    connections: { easee: { charger_id: 'fixture-ev' },
      entsoe: { token: 'fixture-not-a-real-token' }, geoloc: { latitude: 60, longitude: 25 } } };
  const store = new Store(config.dbPath);
  let now = initial;
  const clock = () => now, engine = new Engine({ store, config, clock });
  const temperature = () => [{ source: 'mqtt-temperature', device: 'fixture-room', signal: 'indoor_temperature',
    value: 21.1, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const current = () => [{ source: 'easee', device: 'fixture-ev', signal: 'ev1_current_l1',
    value: 0, unit: 'A', sourceTime: now, receivedAt: now, quality: ['current_snapshot_not_energy'] }];
  const market = async () => ({ source: 'fixture-market', issuedAt: now - MINUTE, fetchedAt: now,
    intervals: [{ start: now, end: now + 24 * 60 * MINUTE, spotCtPerKwh: -2, unit: 'c/kWh', vatIncluded: false }] });
  const weather = async () => ({ source: 'fixture-weather', issuedAt: null, fetchedAt: now,
    forecast: [{ start: now, end: now + 24 * 60 * MINUTE, outdoorC: 5, issuedAt: null, fetchedAt: now, issuedAtBasis: 'fetched-snapshot' }] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const outdoor = async () => [{ source: 'fmi', device: 'fixture-weather-station', signal: 'outdoor_temperature',
    value: 10, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const options = { config, store, engine, clock, http: { json() { throw new Error('Unexpected HTTP request'); }, close() {} },
    devices: { temperatures: async () => temperature(), easee: async () => current() }, market, weather, outdoor, automatic: false };
  return { options, store, engine, config, temperature, setTime(at) { now = at; } };
}
test('unchanged forecast downloads share content and preserve unknown-issuance age',async t=>{
  const f=fixture(t);f.config.acquisition.weatherIntervalMs=30*MINUTE;
  f.options.weather=async({now})=>({source:'openmeteo',fetchedAt:now,issuedAt:null,
    forecast:[{start:initial,end:initial+24*60*MINUTE,outdoorC:5,solarRadiationWm2:120,
      source:'openmeteo',issuedAt:null,fetchedAt:now,issuedAtBasis:'fetched-snapshot'}]});
  const providers=startProviders(f.options);
  try {
    await providers.runDue();const first=f.store.getState('provider:weather');
    f.setTime(initial+30*MINUTE);await providers.runDue();
    const latest=f.store.getState('provider:weather');
    assert.notEqual(latest.snapshotId,first.snapshotId);assert.equal(latest.fetchedAt,initial);
    assert.equal(latest.forecast[0].fetchedAt,initial);assert.equal(latest.lastCheckedAt,initial+30*MINUTE);
    assert.equal(f.store.snapshotById(latest.snapshotId).contentId,f.store.snapshotById(first.snapshotId).contentId);
  }finally{await providers.close();}
});

test('normal configuration acquires electricity every fifteen seconds with audit-only counters', async t => {
  const f = fixture(t);
  f.config.acquisition = {};
  f.config.connections = { easee: { equalizer_id: 'invented-property' } };
  let calls = 0;
  f.options.devices.electricity = async ({ now }) => {
    calls++;
    return ELECTRICITY_FIELDS.property.map(([id, name, unit]) => ({ source: 'easee', device: 'invented-property',
      signal: `property_${name}`, unit, value: unit === 'A' ? 10 : unit === 'V' ? 230 : unit === 'kW' ? 6.9 : 100 + calls,
      sourceTime: now, receivedAt: now, quality: [], raw: { acquisitionOnly: true, auditOnly: unit === 'kWh', observationId: id } }));
  };
  delete f.options.devices.temperatures;
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').temperatures.status, 'not-configured');
    assert.equal(f.store.getState('providers:health').easee.nextAttemptAt, initial + 15_000);
    assert.equal(f.store.observations().length, 0);
    f.setTime(initial + 14_999); await providers.runDue(); assert.equal(calls, 1);
    f.setTime(initial + 15_000); await providers.runDue(); assert.equal(calls, 2);
    const rows = f.store.observations();
    assert.deepEqual(rows.map(row => row.signal).sort(), ['property_energy_l1', 'property_energy_l2', 'property_energy_l3']);
    assert(Math.abs(rows.reduce((sum, row) => sum + row.value, 0) - 6.9 * 15 / 3600) < 1e-12);
    assert.equal(f.store.energyAudits().length, 2);
    assert.equal(f.store.observations({ signal: 'property_import_energy_counter' }).length, 0);
    assert.equal(f.engine.latest.property_current_l1.value, 10);
  } finally { await providers.close(); }
});

test('an injected temperature provider remains usable without temperature connection configuration', async t => {
  const f = fixture(t);
  f.config.connections = {};
  f.options.devices.temperatures = () => { throw new Error('The injected temperature provider takes precedence'); };
  f.options.temperatureProvider = async () => f.temperature();
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').temperatures.status, 'ok');
    assert.equal(f.engine.status().observations.indoor.value, 21.1);
  } finally { await providers.close(); }
});

test('independent polls stay nonblocking, do not overlap and preserve snapshot provenance', async t => {
  const f = fixture(t), held = deferred(); let calls = 0;
  f.options.devices.temperatures = async () => { calls++; await held.promise; return f.temperature(); };
  const providers = startProviders(f.options);
  try {
    const first = providers.runDue();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.getState('providers:health').temperatures.status, 'running');
    assert.equal(f.store.getState('providers:health').market.status, 'ok');
    const second = providers.runDue();
    assert.equal(calls, 1);
    const status = f.engine.tick();
    assert.equal(status.liveWrites, false);
    assert.equal(status.decision.action, 'normal');
    assert.equal(status.priceStatus, 'configured');
    assert.ok(status.prices.length > 0);
    assert.equal(status.observations.indoor.value, null);
    held.resolve(); await first; await second;
    assert.equal(f.engine.status().observations.indoor.value, 21.1);
    const snapshots = f.store.snapshots();
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots.find(row => row.kind === 'weather').issuedAt, null);
    assert.equal(snapshots.find(row => row.kind === 'market').issuedAt, initial - MINUTE);
    assert.equal(f.store.getState('provider:weather').forecast[0].issuedAt, null);
    assert.equal(f.store.getState('provider:observations').length, 2);
    assert(f.store.getState('provider:observations').every(row => row.source !== 'mqtt-temperature'));
  } finally { held.resolve(); await providers.close(); }
});

test('outages retain dated cache, sanitize failures, back off and automatically recover', async t => {
  const f = fixture(t); let marketCalls = 0, fail = false;
  const good = f.options.market;
  f.options.market = async args => { marketCalls++; if (fail) throw Object.assign(new Error('secret URL and body'), { status: 429 }); return good(args); };
  let providers = startProviders(f.options);
  try {
    await providers.runDue();
    fail = true; f.setTime(initial + 60 * MINUTE);
    await providers.runDue();
    let health = f.store.getState('providers:health').market;
    assert.equal(health.status, 'error');
    assert.equal(health.error, 'HTTP-429');
    assert.equal(health.lastSuccessAt, initial);
    assert.equal(health.nextAttemptAt, initial + 65 * MINUTE);
    assert.equal(f.store.getState('provider:market').fetchedAt, initial);
    assert.equal(f.store.snapshots({ kind: 'market' }).length, 1);
    assert.equal(JSON.stringify(f.store.getState('providers:health')).includes('secret'), false);
    await providers.close();
    providers = startProviders(f.options);
    await providers.runDue();
    assert.equal(marketCalls, 2, 'restart must not defeat rate-limit backoff');
    f.setTime(initial + 65 * MINUTE); await providers.runDue();
    health = f.store.getState('providers:health').market;
    assert.equal(health.nextAttemptAt, initial + 75 * MINUTE);
    fail = false; f.setTime(initial + 75 * MINUTE); await providers.runDue();
    assert.equal(f.store.getState('providers:health').market.status, 'ok');
    assert.equal(f.store.getState('providers:health').market.failures, 0);
    assert.equal(f.store.snapshots({ kind: 'market' }).length, 2);
  } finally { await providers.close(); }
});

test('missing temperatures report outage separately from old readings and cancellation drains requests', async t => {
  const f = fixture(t);
  const providers = startProviders(f.options);
  await providers.runDue();
  f.options.devices.temperatures = async () => f.temperature().map(row => ({ ...row, value: null, sourceTime: null,
    quality: ['missing', 'provider_error', 'http_status_503', 'source_time_unknown'] }));
  f.setTime(initial + 5 * MINUTE); await providers.runDue();
  assert.equal(f.engine.status().observations.indoor.value, 21.1);
  assert.equal(f.engine.status().observations.indoor.observedAt, initial);
  assert.equal(f.store.getState('providers:health').temperatures.status, 'degraded');
  assert.equal(f.store.getState('providers:health').temperatures.error, 'HTTP-503');
  let aborted = false;
  f.options.devices.temperatures = ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => {
    aborted = true; reject(new Error('cancelled'));
  }, { once: true }));
  f.setTime(initial + 10 * MINUTE);
  const pending = providers.runDue();
  await providers.close(); await pending;
  assert.equal(aborted, true);
  assert.deepEqual(await providers.runDue(), []);
});

test('unconfigured providers make no requests', async t => {
  const f = fixture(t);
  f.options.config.connections = {};
  delete f.options.temperatureProvider;
  delete f.options.devices.temperatures;
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.deepEqual(f.store.observations(), []);
    assert.deepEqual(f.store.snapshots(), []);
    assert.ok(Object.values(f.store.getState('providers:health')).every(row => row.status === 'not-configured'));
  } finally { await providers.close(); }
});

test('provider startup serves UI while a device request is pending and closes cleanly', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-provider-start-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory), input: 'providers',
    connections: {} };
  let pending = false, cancelled = false;
  const app = await start({ config, clock: () => initial, providerOptions: {
    temperatureProvider: ({ signal }) => new Promise((resolve, reject) => {
      pending = true; signal.addEventListener('abort', () => { cancelled = true; reject(new Error('closed')); }, { once: true });
    }), devices: { easee: async () => [] },
  } });
  try {
    assert.equal(pending, true);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.providers.temperatures.status, 'running');
    assert.equal(status.liveWrites, false);
    assert.equal(status.decision.action, 'normal');
  } finally { await app.close(); }
  assert.equal(cancelled, true);
});

test('device retry backoff longer than poll cadence survives restart', async t => {
  const f = fixture(t);
  f.options.config.connections = {};
  f.store.setState('providers:health', { temperatures: { failures: 3, nextAttemptAt: initial + 20 * MINUTE } });
  let calls = 0;
  f.options.devices.temperatures = async () => { calls++; return f.temperature(); };
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(calls, 0);
    assert.equal(f.store.getState('providers:health').temperatures.nextAttemptAt, initial + 20 * MINUTE);
    f.setTime(initial + 20 * MINUTE); await providers.runDue();
    assert.equal(calls, 1);
    assert.equal(f.store.getState('providers:health').temperatures.status, 'ok');
  } finally { await providers.close(); }
});

test('a failed observation-cache transaction restores both SQLite history and in-memory current state', async t => {
  const f = fixture(t);
  f.options.config.connections = {};
  f.engine.ingest(f.temperature()[0]);
  const before = structuredClone(f.engine.latest);
  const originalSetState = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key === 'provider:observations') throw new Error('Synthetic disk write failure');
    return originalSetState(key, value);
  };
  f.setTime(initial + 5 * MINUTE);
  f.options.devices.temperatures = async () => f.temperature().map(row => ({ ...row, value: 22 }));
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.deepEqual(structuredClone(f.engine.latest), before);
    assert.equal(f.store.observations().length, 1);
    assert.equal(f.store.getState('provider:observations'), null);
    assert.equal(f.store.getState('providers:health').temperatures.status, 'error');
    f.store.setState = originalSetState;
    f.setTime(initial + 10 * MINUTE); await providers.runDue();
    assert.equal(f.engine.latest.indoor_temperature.value, 22);
    assert.equal(f.store.observations().length, 2);
  } finally { await providers.close(); }
});

test('failed outdoor cache writes restore provider candidates while H66 remains the selected outdoor signal', async t => {
  const f = fixture(t);
  f.config.connections = { geoloc: { latitude: 60, longitude: 25 } };
  delete f.options.temperatureProvider;
  delete f.options.devices.temperatures;
  const h66 = at => ({ source: 'husdata-h66', device: 'fixture-h66', signal: 'outdoor_temperature',
    value: 0, unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: { usableForControl: true, retained: false } });
  f.engine.ingest(h66(initial));
  let source = 'fmi';
  f.options.outdoor = async ({ now }) => [{ source, device: `fixture-${source}`, signal: 'outdoor_temperature',
    value: source === 'fmi' ? 10 : 7, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const providers = startProviders(f.options);
  const setState = f.store.setState.bind(f.store);
  try {
    await providers.runDue();
    assert.equal(f.engine.status().observations.outdoor.source, 'husdata-h66');
    f.setTime(initial + 10 * MINUTE); f.engine.ingest(h66(initial + 10 * MINUTE));
    const before = {
      latest: structuredClone(f.engine.latest), candidates: structuredClone(f.engine.outdoorCandidates),
      providers: structuredClone(f.engine.providerObservations()), cached: f.store.getState('provider:observations'),
      history: f.store.observations({ signal: 'outdoor_temperature' }),
    };
    source = 'openmeteo';
    f.store.setState = (key, value) => {
      if (key === 'provider:observations') throw new Error('Synthetic disk write failure');
      return setState(key, value);
    };
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').outdoor.status, 'error');
    assert.deepEqual(structuredClone(f.engine.latest), before.latest);
    assert.deepEqual(structuredClone(f.engine.outdoorCandidates), before.candidates);
    assert.deepEqual(f.engine.providerObservations(), before.providers);
    assert.deepEqual(f.store.getState('provider:observations'), before.cached);
    assert.deepEqual(f.store.observations({ signal: 'outdoor_temperature' }), before.history);
    assert.equal(f.engine.status().observations.outdoor.source, 'husdata-h66');
    f.store.setState = setState;
    const nextAt = f.store.getState('providers:health').outdoor.nextAttemptAt;
    f.setTime(nextAt); f.engine.ingest(h66(nextAt)); await providers.runDue();
    assert.equal(f.store.getState('providers:health').outdoor.status, 'ok');
    assert.equal(f.engine.status().observations.outdoor.source, 'husdata-h66');
    assert.equal(f.engine.outdoorCandidates.openmeteo.value, 7);
    assert.deepEqual(f.store.getState('provider:observations').map(row => row.source).sort(), ['fmi', 'openmeteo']);
  } finally { f.store.setState = setState; await providers.close(); }
});

test('weather candidates survive polling and restart while live H66 publications stay outside the provider cache', async t => {
  const f = fixture(t);
  f.config.connections = { geoloc: { latitude: 60, longitude: 25 } };
  delete f.options.temperatureProvider;
  delete f.options.devices.temperatures;
  let source = 'fmi', now = initial;
  f.options.outdoor = async ({ now }) => [{ source, device: `fixture-${source}`, signal: 'outdoor_temperature',
    value: source === 'fmi' ? 12 : 13, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const h66 = () => ({ source: 'husdata-h66', device: 'fixture-h66', signal: 'outdoor_temperature',
    value: 0, unit: 'degC', sourceTime: now, receivedAt: now, quality: [], raw: { usableForControl: true, retained: false } });
  f.engine.ingest(h66());
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    now = initial + 10 * MINUTE; f.setTime(now); source = 'openmeteo'; f.engine.ingest(h66());
    await providers.runDue();
    assert.equal(f.engine.status().observations.outdoor.source, 'husdata-h66');
    assert.deepEqual(Object.keys(f.engine.outdoorCandidates).sort(), ['fmi', 'husdata-h66', 'openmeteo']);
    const cached = f.store.getState('provider:observations');
    assert.deepEqual(cached.map(row => row.source).sort(), ['fmi', 'openmeteo']);
    assert.deepEqual(f.engine.providerObservations(), cached);
    assert.equal(cached.find(row => row.source === 'fmi').sourceTime, initial);
    assert.equal(cached.find(row => row.source === 'openmeteo').sourceTime, now);
    const count = f.store.observations({ signal: 'outdoor_temperature' }).length;
    const restored = new Engine({ store: f.store, config: f.config, clock: () => now });
    assert.deepEqual(Object.keys(restored.outdoorCandidates).sort(), ['fmi', 'openmeteo']);
    assert.equal(restored.status().observations.outdoor.source, 'fmi');
    assert.equal(f.store.observations({ signal: 'outdoor_temperature' }).length, count, 'Restoring provider cache must not duplicate history');
    restored.ingest(h66());
    assert.equal(restored.status().observations.outdoor.source, 'husdata-h66');
    now = initial + 31 * MINUTE;
    assert.equal(restored.status().observations.outdoor.source, 'openmeteo', 'Persisted backup remains usable when H66 and FMI expire');
    assert.equal(restored.status().observations.outdoor.stale, false);
  } finally { await providers.close(); }
});

test('rolling weather keeps a still-fresh current block with its original provenance and immutable raw snapshots', async t => {
  const f = fixture(t);
  f.options.config.connections = { geoloc: { latitude: 60, longitude: 25 } };
  let calls = 0;
  f.options.weather = async ({ now }) => {
    const start = initial + (calls++ ? 3 * 60 * MINUTE : 0);
    return { source: 'fixture-weather', issuedAt: null, fetchedAt: now,
      forecast: [{ start, end: start + 3 * 60 * MINUTE, outdoorC: 5, issuedAt: null,
        issuedAtBasis: 'fetched-snapshot', fetchedAt: now }] };
  };
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    const first = f.store.snapshots({ kind: 'weather' })[0];
    f.setTime(initial + 60 * MINUTE); await providers.runDue();
    const cached = f.store.getState('provider:weather');
    assert.equal(cached.forecast.length, 2);
    assert.equal(cached.forecast[0].start, initial);
    assert.equal(cached.forecast[0].end, initial + 3 * 60 * MINUTE);
    assert.equal(cached.forecast[0].fetchedAt, initial);
    assert.equal(cached.forecast[0].issuedAt, null);
    assert.equal(cached.forecast[0].snapshotId, first.id);
    assert.equal(cached.cacheProvenance.kind, 'composite-forecast');
    assert.deepEqual(cached.cacheProvenance.retainedSnapshotIds, [first.id]);
    assert.equal(assembleOutlook(null, cached, null, initial + 60 * MINUTE).weatherStatus, 'available');
    const snapshots = f.store.snapshots({ kind: 'weather' });
    assert.deepEqual(snapshots[0], first);
    assert.equal(snapshots[1].payload.forecast.length, 1);
    assert.equal(snapshots[1].payload.forecast[0].start, initial + 3 * 60 * MINUTE);
    assert.equal(snapshots[1].payload.cacheProvenance, undefined);
  } finally { await providers.close(); }
});

test('all-zero and impossible relative currents need attention, while different measurement times do not', async t => {
  const f = fixture(t);
  f.options.config.connections = { easee: { equalizer_id: 'fixture-property' } };
  let issue = 'all_zero_property_current';
  f.options.devices.easee = async ({ now }) => [{ source: 'easee', device: 'fixture-ev', signal: 'property_current_l1',
    value: 0, unit: 'A', sourceTime: now, receivedAt: now, quality: ['current_snapshot_not_energy', issue] }];
  const providers = startProviders(f.options);
  try {
    for (const [i, flag] of ['all_zero_property_current', 'ev_exceeds_property_current', 'asynchronous_snapshot'].entries()) {
      issue = flag; f.setTime(initial + i * 30 * MINUTE); await providers.runDue();
      const health = f.store.getState('providers:health').easee;
      assert.equal(health.status, flag === 'asynchronous_snapshot' ? 'ok' : 'degraded');
      assert.deepEqual(health.qualityIssues, flag === 'asynchronous_snapshot' ? [] : [flag]);
      assert.deepEqual(health.currentReadings, { property: {
        qualityIssues: flag === 'asynchronous_snapshot' ? [] : [flag], error: null,
        lastSuccessAt: initial + i * 30 * MINUTE,
      } });
      assert.equal(health.lastSuccessAt, initial + i * 30 * MINUTE);
      assert.equal(health.nextAttemptAt, initial + (i * 30 + 5) * MINUTE);
      assert.equal(health.failures, 0);
      assert.equal(health.error, null);
      assert.equal(f.engine.latest.property_current_l1.quality.includes(flag), true);
      assert.equal(f.store.observations({ signal: 'property_current_l1' }).length, 0, 'acquired currents remain live-only');
    }
  } finally { await providers.close(); }
});

test('old unchanged temperatures and idle EV currents do not slow downloads of changing property currents', async t => {
  const f = fixture(t);
  f.options.config.connections = {
    easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  const sourceAt = initial - 2 * 24 * 60 * MINUTE;
  let easeeCalls = 0, temperatureCalls = 0;
  f.options.devices.temperatures = async ({ now }) => {
    temperatureCalls++;
    return [{ ...f.temperature()[0], sourceTime: sourceAt, receivedAt: now, quality: ['stale'] }];
  };
  f.options.devices.easee = async ({ now }) => {
    easeeCalls++;
    return ['ev1', 'property'].flatMap(prefix => [1, 2, 3].map(phase => ({
      source: 'easee', device: `fixture-${prefix}`, signal: `${prefix}_current_l${phase}`,
      value: prefix === 'ev1' ? 0 : 2 + easeeCalls + phase, unit: 'A',
      sourceTime: prefix === 'ev1' ? sourceAt : now, receivedAt: now,
      quality: ['current_snapshot_not_energy', 'asynchronous_snapshot', ...(prefix === 'ev1' ? ['stale'] : [])],
    })));
  };
  let providers = startProviders(f.options);
  try {
    for (let i = 0; i < 8; i++) {
      const now = initial + i * 5 * MINUTE;
      f.setTime(now); await providers.runDue();
      for (const job of ['temperatures', 'easee']) {
        const health = f.store.getState('providers:health')[job];
        assert.equal(health.status, job === 'easee' ? 'ok' : 'degraded');
        assert.equal(health.lastSuccessAt, now);
        assert.equal(health.nextAttemptAt, now + 5 * MINUTE);
        assert.equal(health.failures, 0);
        assert.equal(health.error, null);
        assert.deepEqual(health.qualityIssues, [job === 'easee' ? 'charger_stale' : 'stale']);
        if (job === 'easee') {
          const description = describeProvider('easee', health, { now, formatTime: at => String(at) });
          assert.equal(description.attention, false);
          assert.equal(description.state, 'Available');
          assert.match(description.detail, /Charger 1 current readings: oldest source reading is/);
          assert.ok(description.detail.startsWith(`Last successful download ${now}.`));
          assert.equal(description.detail.match(/successful download/g).length, 1);
          assert.doesNotMatch(description.detail, /different times/);
        }
      }
      assert.equal(f.engine.latest.property_current_l1.value, 4 + i);
      assert.equal(f.store.observations({ signal: 'property_current_l1' }).length, 0);
      assert.equal(f.engine.status().observations.indoor.stale, false);
      assert.equal(f.engine.status().observations.indoor.needsAttention, true);
      assert.equal(f.engine.status().observations.indoor.observedAt, sourceAt);
      if (i === 3) {
        await providers.close(); providers = startProviders(f.options);
        assert.equal(f.store.getState('providers:health').easee.status, 'ok');
        assert.deepEqual(f.store.getState('providers:health').easee.qualityIssues, ['charger_stale']);
        await providers.runDue();
        assert.equal(easeeCalls, 4, 'restart preserves the normal next poll');
      }
    }
    assert.equal(easeeCalls, 8); assert.equal(temperatureCalls, 8);
    assert(f.store.observations({ signal: 'ev1_current_l1' }).every(row => row.sourceTime === sourceAt));
    assert(f.store.observations({ signal: 'indoor_temperature' }).every(row => row.sourceTime === sourceAt));
  } finally { await providers.close(); }
});

test('old Easee voltages do not need attention or contaminate current source ages', async t => {
  const f = fixture(t);
  f.options.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  let oldPropertyCurrent = false;
  f.options.devices.easee = async ({ now }) => ['ev1', 'property'].flatMap(prefix =>
    ['current', 'voltage'].flatMap(kind => [1, 2, 3].map(phase => {
      const age = kind === 'voltage' ? 48 * 60 * MINUTE
        : prefix === 'property' && phase === 2 && oldPropertyCurrent ? 30 * MINUTE : 0;
      return { source: 'easee', device: `fixture-${prefix}`, signal: `${prefix}_${kind}_l${phase}`,
        value: kind === 'voltage' ? 230 : 5, unit: kind === 'voltage' ? 'V' : 'A',
        sourceTime: now - age, receivedAt: now, quality: age ? ['stale'] : [] };
    })));
  const providers = startProviders(f.options);
  try {
    for (const [i, stale] of [false, true, false].entries()) {
      oldPropertyCurrent = stale;
      const now = initial + i * 5 * MINUTE;
      f.setTime(now); await providers.runDue();
      const health = f.engine.status().providers.easee;
      assert.equal(health.status, stale ? 'degraded' : 'ok');
      assert.deepEqual(health.qualityIssues, stale ? ['property_stale'] : []);
      assert.deepEqual(health.staleSourceTimes, stale ? { property_stale: now - 30 * MINUTE } : {});
      assert.equal(health.lastSuccessAt, now);
      assert.equal(health.failures, 0);
      assert.equal(health.nextAttemptAt, now + 5 * MINUTE);
      const display = describeProvider('easee', health, { now, formatTime: String });
      assert.equal(display.attention, stale);
      if (stale) assert.match(display.detail, /Property current readings: oldest source reading is 30 min old\. Attention threshold 30 min/);
      else assert.doesNotMatch(display.detail, /old|voltage/);
    }
  } finally { await providers.close(); }
});

test('Easee property staleness needs attention and clears when property timestamps recover', async t => {
  const f = fixture(t);
  f.options.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  let oldCharger = false, oldProperty = true;
  f.options.devices.easee = async ({ now }) => ['ev1', 'property'].flatMap(prefix => [1, 2, 3].map(phase => {
    const stale = prefix === 'ev1' ? oldCharger : oldProperty;
    return { source: 'easee', device: `fixture-${prefix}`, signal: `${prefix}_current_l${phase}`,
      value: prefix === 'ev1' ? 0 : 5, unit: 'A', receivedAt: now,
      sourceTime: stale ? initial - 60 * MINUTE : now,
      quality: ['current_snapshot_not_energy', ...(stale ? ['stale'] : [])] };
  }));
  let providers = startProviders(f.options);
  try {
    for (const [i, [charger, property, issues]] of [
      [false, true, ['property_stale']],
      [true, true, ['charger_stale', 'property_stale']],
      [true, false, ['charger_stale']],
      [false, false, []],
    ].entries()) {
      oldCharger = charger; oldProperty = property;
      const now = initial + i * 5 * MINUTE;
      f.setTime(now); await providers.runDue();
      const health = f.engine.status().providers.easee;
      assert.equal(health.status, property ? 'degraded' : 'ok');
      assert.deepEqual(health.qualityIssues, issues);
      assert.deepEqual(health.staleSourceTimes, Object.fromEntries(issues.map(flag => [flag, initial - 60 * MINUTE])));
      assert.equal(health.lastSuccessAt, now);
      assert.equal(health.nextAttemptAt, now + 5 * MINUTE);
      assert.equal(health.failures, 0);
      assert.equal(health.error, null);
      if (i === 1) {
        await providers.close(); providers = startProviders(f.options);
        assert.equal(f.store.getState('providers:health').easee.status, 'degraded');
        assert.deepEqual(f.store.getState('providers:health').easee.qualityIssues, issues);
        assert.deepEqual(f.store.getState('providers:health').easee.staleSourceTimes, health.staleSourceTimes);
      }
    }
    assert(f.store.observations({ signal: 'property_current_l1' })
      .filter(row => row.sourceTime === initial - 60 * MINUTE).every(row => row.quality.includes('stale')));
  } finally { await providers.close(); }
});

test('Easee scopes partial errors and quality notes to the affected current readings across restart', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  let failed = null;
  f.options.devices.easee = async ({ now }) => ['ev1', 'property'].flatMap(prefix => [1, 2, 3].map(phase => ({
    source: 'easee', device: `fixture-${prefix}`, signal: `${prefix}_current_l${phase}`,
    value: prefix === failed ? null : 5, unit: 'A', receivedAt: now, sourceTime: prefix === failed ? null : now,
    quality: prefix === failed ? ['provider_error', 'http_status_503', 'missing', 'source_time_unknown']
      : ['asynchronous_snapshot', 'duplicate_observation', ...(prefix === 'property' ? ['negative_current'] : [])],
  })));
  let providers = startProviders(f.options);
  try {
    await providers.runDue();
    let health = f.engine.status().providers.easee;
    assert.deepEqual(health.currentReadings, {
      charger: { qualityIssues: [], error: null, lastSuccessAt: initial },
      property: { qualityIssues: ['negative_current'], error: null, lastSuccessAt: initial },
    });
    failed = 'ev1'; f.setTime(initial + 5 * MINUTE); await providers.runDue();
    health = f.engine.status().providers.easee;
    assert.equal(health.error, 'HTTP-503');
    assert.equal(health.status, 'degraded');
    assert.deepEqual(health.currentReadings.charger, {
      qualityIssues: ['provider_error', 'missing', 'source_time_unknown'], error: 'HTTP-503', lastSuccessAt: initial,
    });
    assert.deepEqual(health.currentReadings.property, {
      qualityIssues: ['negative_current'], error: null, lastSuccessAt: initial + 5 * MINUTE,
    });
    assert.equal(health.lastSuccessAt, initial);
    const description = describeProvider('easee', health, { now: initial + 5 * MINUTE, formatTime: at => String(at) });
    assert.ok(description.detail.startsWith(`Last successful download ${initial}.`));
    assert.equal(description.detail.match(/successful download/g).length, 1);
    assert.match(description.detail, /Charger 1 readings: Download failed \(HTTP 503\)/);
    assert.match(description.detail, /Property readings: Some current readings are negative/);
    await providers.close(); providers = startProviders(f.options);
    assert.deepEqual(f.engine.status().providers.easee.currentReadings, health.currentReadings);
    failed = 'property'; f.setTime(initial + 10 * MINUTE); await providers.runDue();
    health = f.engine.status().providers.easee;
    assert.equal(health.currentReadings.charger.error, null);
    assert.equal(health.currentReadings.charger.lastSuccessAt, initial + 10 * MINUTE);
    assert.equal(health.currentReadings.property.error, 'HTTP-503');
    assert.equal(health.currentReadings.property.lastSuccessAt, initial + 5 * MINUTE);
    assert.equal(JSON.stringify(health).includes('asynchronous_snapshot'), false);
  } finally { await providers.close(); }
});

test('charger age and asynchronous snapshots never restore an attention state, even with old failure counters', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { charger_id: 'fixture-ev' } };
  for (const flags of [['charger_stale', 'asynchronous_snapshot'], ['asynchronous_snapshot'], ['stale']]) {
    f.store.setState('providers:health', { easee: { status: 'degraded', failures: 2, error: null,
      lastSuccessAt: initial - MINUTE, nextAttemptAt: initial + 20 * MINUTE,
      qualityIssues: flags, staleSourceTimes: { charger_stale: initial - 60 * MINUTE } } });
    const providers = startProviders(f.options);
    try {
      const health = f.engine.status().providers.easee;
      assert.equal(health.status, 'ok');
      assert.equal(health.failures, 0);
      assert.equal(health.nextAttemptAt, initial + 20 * MINUTE);
      assert.equal(JSON.stringify(health).includes('asynchronous_snapshot'), false);
      assert.deepEqual(Object.keys(health.currentReadings), ['charger']);
      assert.equal(health.currentReadings.charger.error, null);
    } finally { await providers.close(); }
  }
});

test('Easee restores sanitized device health without hiding real errors or property staleness', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  f.store.setState('providers:health', { easee: { status: 'degraded', error: null,
    nextAttemptAt: initial + 20 * MINUTE, qualityIssues: ['asynchronous_snapshot', 'charger_stale'],
    currentReadings: {
      charger: { qualityIssues: ['stale', 'asynchronous_snapshot', 'synthetic-private-response'], error: null,
        lastSuccessAt: initial, raw: 'synthetic-private-response' },
      property: { qualityIssues: ['stale', 'invalid_unit', 'missing'], error: 'HTTP_503',
        lastSuccessAt: 'synthetic-private-response' },
      'synthetic-private-response': { error: 'synthetic-private-response' },
    } } });
  let providers = startProviders(f.options);
  try {
    let health = f.engine.status().providers.easee;
    assert.equal(health.status, 'degraded');
    assert.deepEqual(health.qualityIssues, ['charger_stale', 'property_stale']);
    assert.deepEqual(health.currentReadings, {
      charger: { qualityIssues: ['charger_stale'], error: null, lastSuccessAt: initial },
      property: { qualityIssues: ['property_stale', 'invalid_unit', 'missing'], error: 'HTTP-503', lastSuccessAt: null },
    });
    assert.equal(JSON.stringify(health).includes('synthetic-private-response'), false);
    assert.equal(JSON.stringify(health).includes('asynchronous_snapshot'), false);
    await providers.close();
    health.currentReadings.property.error = 'synthetic-private-response';
    f.store.setState('providers:health', { easee: health });
    providers = startProviders(f.options);
    health = f.engine.status().providers.easee;
    assert.equal(health.currentReadings.property.error, 'provider-request-failed');
    assert.equal(health.status, 'degraded');
    assert.equal(JSON.stringify(health).includes('synthetic-private-response'), false);
  } finally { await providers.close(); }
});

test('Easee invalid downloads and thrown errors retain separately dated successes', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { equalizer_id: 'fixture-property' } };
  let kind = 'ok';
  f.options.devices.easee = async ({ now }) => {
    if (kind === 'throw') throw Object.assign(new Error('synthetic-private-response'), { status: 429 });
    if (kind === 'empty') return [];
    return [{ source: 'easee', device: 'fixture-property', signal: 'property_current_l1', unit: 'A',
      sourceTime: now, receivedAt: now, value: kind === 'ok' ? 5 : null,
      quality: kind === 'ok' ? [] : ['invalid_unit', 'invalid_numeric', 'conflicting_duplicate', 'missing', 'duplicate_observation'] }];
  };
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    for (const [index, failure] of ['invalid', 'empty', 'throw'].entries()) {
      kind = failure; f.setTime(initial + (index + 1) * 30 * MINUTE); await providers.runDue();
      const health = f.engine.status().providers.easee;
      assert.equal(health.status, failure === 'throw' ? 'error' : 'degraded');
      assert.equal(health.currentReadings.property.error, failure === 'throw' ? 'HTTP-429' : 'missing-or-invalid-observations');
      assert.equal(health.currentReadings.property.lastSuccessAt, initial);
      assert.deepEqual(Object.keys(health.currentReadings), ['property']);
      if (failure === 'invalid') assert.deepEqual(health.currentReadings.property.qualityIssues,
        ['invalid_unit', 'invalid_numeric', 'conflicting_duplicate', 'missing']);
      assert.equal(JSON.stringify(health).includes('synthetic-private-response'), false);
    }
  } finally { await providers.close(); }
});

test('invalid persisted Easee scopes cannot suppress a legacy current quality problem', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  for (const currentReadings of [{}, [], 'synthetic-private-response', { charger: [] }]) {
    f.store.setState('providers:health', { easee: { status: 'degraded', error: null,
      qualityIssues: ['negative_current'], nextAttemptAt: initial + 20 * MINUTE, currentReadings } });
    const providers = startProviders(f.options);
    try {
      const health = f.engine.status().providers.easee;
      assert.equal(health.status, 'degraded');
      assert.deepEqual(health.qualityIssues, ['negative_current']);
      assert.equal(health.currentReadings, undefined);
      assert.equal(describeProvider('easee', health, { now: initial, formatTime: at => String(at) }).attention, true);
    } finally { await providers.close(); }
  }
});

test('a missing configured Easee device is scoped as a failure while returned readings still succeed', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' } };
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    const health = f.engine.status().providers.easee;
    assert.equal(health.status, 'degraded');
    assert.equal(health.error, 'missing-or-invalid-observations');
    assert.deepEqual(health.currentReadings, {
      charger: { qualityIssues: [], error: null, lastSuccessAt: initial },
      property: { qualityIssues: [], error: 'missing-or-invalid-observations', lastSuccessAt: null },
    });
    const description = describeProvider('easee', health, { now: initial, formatTime: at => String(at) });
    assert.equal(description.attention, true);
    assert.match(description.detail, /Property readings: Readings are missing or invalid/);
    assert.ok(description.detail.startsWith('No successful download recorded.'));
    assert.equal(description.detail.match(/successful download/g).length, 1);
  } finally { await providers.close(); }
});

test('old timestamp attention starts at 30 minutes for currents and two hours for all temperatures', async t => {
  const f = fixture(t);
  f.config.connections = {
    easee: { charger_id: 'fixture-ev', equalizer_id: 'fixture-property' },
    geoloc: { latitude: '60.4', longitude: '25.6', country_code: 'fi' } };
  let age = 0;
  f.options.devices.temperatures = async ({ now }) => [{ ...f.temperature()[0],
    sourceTime: now - age, quality: ['stale'] }];
  f.options.outdoor = async ({ now }) => [{ source: 'fmi', device: 'fixture-station', signal: 'outdoor_temperature',
    value: 12, unit: 'degC', sourceTime: now - age, receivedAt: now, quality: ['stale'] }];
  f.options.devices.easee = async ({ now }) => ['ev1', 'property'].flatMap(prefix => [1, 2, 3].map(phase => ({
    source: 'easee', device: `fixture-${prefix}`, signal: `${prefix}_current_l${phase}`,
    value: prefix === 'ev1' ? 0 : 5, unit: 'A', receivedAt: now, sourceTime: now - age,
    quality: ['current_snapshot_not_energy', 'stale'],
  })));
  const providers = startProviders(f.options);
  try {
    for (const [i, minutes] of [20, 30 - 1 / MINUTE, 30, 90, 120 - 1 / MINUTE, 120, 150, 20].entries()) {
      age = Math.round(minutes * MINUTE);
      const now = initial + i * 10 * MINUTE;
      f.setTime(now); await providers.runDue();
      const health = f.engine.status().providers;
      const currentsOld = age >= 30 * MINUTE, temperaturesOld = age >= 120 * MINUTE;
      assert.equal(health.easee.status, currentsOld ? 'degraded' : 'ok', `current age ${age}`);
      assert.deepEqual(health.easee.qualityIssues, currentsOld ? ['charger_stale', 'property_stale'] : []);
      assert.deepEqual(health.easee.staleSourceTimes, currentsOld ? { charger_stale: now - age, property_stale: now - age } : {});
      for (const name of ['temperatures', 'outdoor']) {
        assert.equal(health[name].status, temperaturesOld ? 'degraded' : 'ok', `${name} age ${age}`);
        assert.deepEqual(health[name].qualityIssues, temperaturesOld ? ['stale'] : []);
        assert.deepEqual(health[name].staleSourceTimes, temperaturesOld ? { stale: now - age } : {});
      }
      assert.equal(f.engine.latest.property_current_l1.quality.includes('stale'), true,
        'attention thresholds must preserve control freshness flags');
      assert.equal(f.store.observations({ signal: 'indoor_temperature' }).at(-1).quality.includes('stale'), true);
    }
  } finally { await providers.close(); }
});

test('attention age uses oldest source timestamps independently of transport age and existing stale flags', async t => {
  const f = fixture(t);
  f.config.connections = { easee: { equalizer_id: 'fixture-property' } };
  f.options.devices.easee = async ({ now }) => [1, 2, 3].map(phase => ({
    source: 'easee', device: 'fixture-property', signal: `property_current_l${phase}`, value: 5, unit: 'A',
    sourceTime: now - phase * 35 * MINUTE, receivedAt: now, quality: ['current_snapshot_not_energy'],
  }));
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    const health = f.engine.status().providers.easee;
    assert.equal(health.status, 'degraded');
    assert.equal(health.lastSuccessAt, initial);
    assert.deepEqual(health.qualityIssues, ['property_stale']);
    assert.deepEqual(health.staleSourceTimes, { property_stale: initial - 105 * MINUTE });
  } finally { await providers.close(); }
});

test('restart preserves visible failures and fallback details during a scheduled wait', async t => {
  const f = fixture(t);
  f.store.setState('providers:health', {
    temperatures: { status: 'ok', lastAttemptAt: initial - MINUTE, lastSuccessAt: initial - MINUTE,
      nextAttemptAt: initial + 4 * MINUTE, failures: 0 },
    easee: { status: 'degraded', lastAttemptAt: initial - MINUTE, lastSuccessAt: null,
      nextAttemptAt: initial + 29 * MINUTE, failures: 3, error: 'HTTP-401',
      qualityIssues: ['stale', 'synthetic-private-response'],
      staleSourceTimes: { stale: initial - 60 * MINUTE, charger_stale: 'synthetic-private-response',
        property_stale: -1, 'synthetic-private-response': initial - 120 * MINUTE } },
    weather: { status: 'fallback', nextAttemptAt: initial + 30 * MINUTE,
      source: 'openmeteo', acquisition: { primary: 'fmi', selected: 'openmeteo', fallbackUsed: true,
        privateBody: 'synthetic-private-response', attempts: [{ source: 'fmi', status: 'error', error: 'HTTP-429' },
          { source: 'openmeteo', status: 'ok' }] },
      sourceBackoff: { fmi: { nextAttemptAt: initial + 30 * MINUTE, failures: 1, error: 'HTTP-429', shared: true } } },
    market: { status: 'running', nextAttemptAt: initial + 20 * MINUTE },
  });
  const providers = startProviders(f.options);
  try {
    const health = f.store.getState('providers:health');
    assert.equal(health.temperatures.status, 'ok');
    assert.equal(health.easee.status, 'degraded');
    assert.equal(health.easee.error, 'HTTP-401');
    assert.equal(health.easee.nextAttemptAt, initial + 29 * MINUTE);
    assert.deepEqual(health.easee.qualityIssues, ['charger_stale']);
    assert.deepEqual(health.easee.staleSourceTimes, { charger_stale: initial - 60 * MINUTE });
    assert.equal(health.easee.currentReadings, undefined, 'legacy generic errors must not acquire invented device scope');
    assert.equal(health.weather.status, 'fallback');
    assert.equal(health.weather.acquisition.attempts[0].error, 'HTTP-429');
    assert.equal(health.weather.sourceBackoff.fmi.failures, 1, 'restoration must not count a new failure');
    assert.equal(health.market.status, 'waiting', 'an interrupted request is no longer running');
    assert.equal(JSON.stringify(health).includes('synthetic-private-response'), false);
  } finally { await providers.close(); }
});

test('location enables keyless weather jobs and fresh primary survives backup polls and restart', async t => {
  const f = fixture(t);
  f.config.connections = { geoloc: { latitude: '60.4', longitude: '25.6', country_code: 'fi' } };
  let source = 'fmi', at = initial - 10 * MINUTE;
  f.options.outdoor = async ({ now }) => {
    const rows = [{ source, device: 'fixture-weather-station', signal: 'outdoor_temperature', value: 12,
      unit: 'degC', sourceTime: at, receivedAt: now, quality: [], raw: { spatialBasis: 'nearby-weather-station' } }];
    rows.acquisition = { primary: 'fmi', selected: source, fallbackUsed: source !== 'fmi',
      attempts: source === 'fmi' ? [{ source, status: 'ok' }]
        : [{ source: 'fmi', status: 'error', error: 'HTTP-503' }, { source, status: 'ok' }] };
    return rows;
  };
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').market.status, 'ok');
    assert.equal(f.store.getState('providers:health').weather.status, 'ok');
    assert.equal(f.engine.status().observations.outdoor.source, 'fmi');
    source = 'openmeteo'; at = initial + 9 * MINUTE;
    f.setTime(initial + 10 * MINUTE); await providers.runDue();
    assert.equal(f.store.getState('providers:health').outdoor.status, 'fallback');
    assert.equal(f.engine.status().observations.outdoor.source, 'fmi', 'Fresh cached FMI stays ahead of the newer backup');
    at = initial + 20 * MINUTE;
    f.setTime(initial + 21 * MINUTE); await providers.runDue();
    assert.equal(f.engine.status().observations.outdoor.source, 'openmeteo', 'Backup takes over once cached FMI exceeds 30 minutes');
    source = 'fmi'; at = initial + 15 * MINUTE;
    f.setTime(initial + 31 * MINUTE); await providers.runDue();
    assert.equal(f.engine.status().observations.outdoor.source, 'fmi', 'Fresh primary replaces a newer backup calculation');
    assert.equal(f.engine.status().observations.outdoor.observedAt, at);
    const count = f.store.observations().filter(row => row.source !== 'controller-estimate').length;
    const restored = new Engine({ store: f.store, config: f.config, clock: () => initial + 31 * MINUTE });
    assert.equal(restored.status().observations.outdoor.source, 'fmi');
    assert.equal(restored.status().observations.outdoor.observedAt, at);
    assert.equal(f.store.observations().filter(row => row.source !== 'controller-estimate').length, count);
  } finally { await providers.close(); }
});

test('healthy backup respects primary Retry-After across polls and restart', async t => {
  const f = fixture(t); let calls = 0;
  f.options.weather = async ({ now, skipSources }) => {
    calls++;
    if (calls > 1) assert.deepEqual(skipSources, ['fmi']);
    const result = { source: 'openmeteo', fetchedAt: now, issuedAt: null,
      forecast: [{ start: now, end: now + 3 * 60 * MINUTE, outdoorC: 4, fetchedAt: now, issuedAt: null, issuedAtBasis: 'fetched-snapshot' }] };
    result.acquisition = { primary: 'fmi', selected: 'openmeteo', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: calls === 1 ? 'error' : 'backoff', error: calls === 1 ? 'HTTP-429' : null,
        retryAfterMs: calls === 1 ? 2 * 60 * MINUTE : undefined }, { source: 'openmeteo', status: 'ok' }] };
    return result;
  };
  let providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').weather.status, 'fallback');
    assert.equal(f.store.getState('providers:health').weather.sourceBackoff.fmi.nextAttemptAt, initial + 2 * 60 * MINUTE);
    await providers.close();
    f.setTime(initial + 60 * MINUTE); providers = startProviders(f.options);
    await providers.runDue();
    assert.equal(calls, 2);
    assert.equal(f.engine.status().weatherStatus, 'available');
    assert.equal(f.store.getState('providers:health').weather.source, 'openmeteo');
  } finally { await providers.close(); }
});

test('FMI outdoor selection cannot be overwritten by an optional injected outside sensor', async t => {
  const f = fixture(t);
  f.config.connections.geoloc = { latitude: 60.4, longitude: 25.6, country_code: 'fi' };
  f.options.devices.temperatures = async ({ now }) => [...f.temperature(), { source: 'mqtt-temperature', device: 'fixture-outside',
    signal: 'outdoor_temperature', value: 30, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  f.options.outdoor = async ({ now }) => [{ source: 'fmi', device: 'fixture-station', signal: 'outdoor_temperature',
    value: 12, unit: 'degC', sourceTime: now - 5 * MINUTE, receivedAt: now, quality: [] }];
  const providers = startProviders(f.options);
  try {
    await providers.runDue();
    f.setTime(initial + 5 * MINUTE); await providers.runDue();
    assert.equal(f.engine.status().observations.outdoor.value, 12);
    assert.equal(f.engine.status().observations.outdoor.source, 'fmi');
    assert.equal(f.store.observations({ signal: 'outdoor_temperature' }).some(row => row.source === 'mqtt-temperature'), false);
  } finally { await providers.close(); }
});

test('long device Retry-After and denied credentials survive restart without immediate retry', async t => {
  const f = fixture(t);
  f.options.devices.temperatures = async () => f.temperature().map(row => ({ ...row, value: null, sourceTime: null,
    quality: ['provider_error', 'http_status_429', 'missing'], raw: { retryAfterMs: 2 * 60 * MINUTE } }));
  let providers = startProviders(f.options);
  try {
    await providers.runDue();
    assert.equal(f.store.getState('providers:health').temperatures.nextAttemptAt, initial + 2 * 60 * MINUTE);
    await providers.close(); f.setTime(initial + 5 * MINUTE);
    let called = false; f.options.devices.temperatures = async () => { called = true; return f.temperature(); };
    providers = startProviders(f.options); await providers.runDue();
    assert.equal(called, false);
  } finally { await providers.close(); }
});

test('rate limits are shared between forecast and observation routes after restart', async t => {
  const f = fixture(t);
  f.config.connections.geoloc = { latitude: 60.4, longitude: 25.6, country_code: 'fi' };
  const original = f.options.weather;
  f.options.weather = async args => ({ ...await original(args), source: 'openmeteo',
    acquisition: { primary: 'fmi', selected: 'openmeteo', fallbackUsed: true,
      attempts: [{ source: 'fmi', status: 'error', error: 'HTTP-429', retryAfterMs: 120 * MINUTE },
        { source: 'openmeteo', status: 'ok' }] } });
  let count = 0;
  f.options.outdoor = async ({ now, skipSources }) => {
    if (count++) assert.ok(skipSources.includes('fmi'), 'A forecast rate limit also blocks the observation route');
    const source = skipSources.includes('fmi') ? 'openmeteo' : 'fmi';
    const rows = [{ source, device: 'fixture-station', signal: 'outdoor_temperature', value: 12,
      unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
    rows.acquisition = { primary: 'fmi', selected: source, fallbackUsed: source !== 'fmi',
      attempts: source === 'fmi' ? [{ source, status: 'ok' }]
        : [{ source: 'fmi', status: 'backoff' }, { source, status: 'ok' }] };
    return rows;
  };
  let providers = startProviders(f.options);
  try {
    await providers.runDue(); await providers.close();
    f.setTime(initial + 10 * MINUTE); providers = startProviders(f.options); await providers.runDue();
    const state = f.store.getState('providers:health').outdoor;
    assert.equal(state.source, 'openmeteo');
    assert.equal(state.status, 'fallback');
    assert.equal(state.sourceBackoff.fmi.nextAttemptAt, initial + 120 * MINUTE);
  } finally { await providers.close(); }
});
