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

const initial = Date.parse('2026-09-06T09:00:00Z'), MINUTE = 60_000;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-providers-'));
  const config = { ...loadConfig({ STMQ_DATA_DIR: dir, STMQ_PORT: '0' }), input: 'providers',
    connections: { smartthings: { inside_temp_dev_id: 'fixture-room' }, easee: { charger_id: 'fixture-ev' },
      entsoe: { token: 'fixture-not-a-real-token' }, openweathermap: { token: 'fixture-weather' } } };
  const store = new Store(config.dbPath);
  let now = initial;
  const clock = () => now, engine = new Engine({ store, config, clock });
  const temperature = () => [{ source: 'smartthings', device: 'fixture-room', signal: 'indoor_temperature',
    value: 21.1, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] }];
  const current = () => [{ source: 'easee', device: 'fixture-ev', signal: 'ev1_current_l1',
    value: 0, unit: 'A', sourceTime: now, receivedAt: now, quality: ['current_snapshot_not_energy'] }];
  const market = async () => ({ source: 'fixture-market', issuedAt: now - MINUTE, fetchedAt: now,
    intervals: [{ start: now, end: now + 24 * 60 * MINUTE, spotCtPerKwh: -2, unit: 'c/kWh', vatIncluded: false }] });
  const weather = async () => ({ source: 'fixture-weather', issuedAt: null, fetchedAt: now,
    forecast: [{ start: now, end: now + 24 * 60 * MINUTE, outdoorC: 5, issuedAt: null, fetchedAt: now, issuedAtBasis: 'fetched-snapshot' }] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const options = { config, store, engine, clock, http: { json() { throw new Error('Unexpected HTTP request'); }, close() {} },
    devices: { temperatures: async () => temperature(), easee: async () => current() }, market, weather, automatic: false };
  return { options, store, engine, config, temperature, setTime(at) { now = at; } };
}

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
    assert.equal(status.priceStatus, 'contract-not-configured');
    assert.equal(status.observations.indoor.value, null);
    held.resolve(); await first; await second;
    assert.equal(f.engine.status().observations.indoor.value, 21.1);
    const snapshots = f.store.snapshots();
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots.find(row => row.kind === 'weather').issuedAt, null);
    assert.equal(snapshots.find(row => row.kind === 'market').issuedAt, initial - MINUTE);
    assert.equal(f.store.getState('provider:weather').forecast[0].issuedAt, null);
    assert.equal(f.store.getState('provider:observations').length, 2);
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
  const config = { ...loadConfig({ STMQ_DATA_DIR: directory, STMQ_PORT: '0' }), input: 'providers',
    connections: { smartthings: { inside_temp_dev_id: 'fixture-room' } } };
  let pending = false, cancelled = false;
  const app = await start({ config, clock: () => initial, providerOptions: { devices: {
    temperatures: ({ signal }) => new Promise((resolve, reject) => {
      pending = true; signal.addEventListener('abort', () => { cancelled = true; reject(new Error('closed')); }, { once: true });
    }), easee: async () => [],
  } } });
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
  f.options.config.connections = { smartthings: { inside_temp_dev_id: 'fixture-room' } };
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
  f.options.config.connections = { smartthings: { inside_temp_dev_id: 'fixture-room' } };
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

test('rolling weather keeps a still-fresh current block with its original provenance and immutable raw snapshots', async t => {
  const f = fixture(t);
  f.options.config.connections = { openweathermap: { token: 'fixture-weather' } };
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

test('all-zero, impossible relative current and asynchronous snapshots report degraded provider quality', async t => {
  const f = fixture(t);
  f.options.config.connections = { easee: { charger_id: 'fixture-ev' } };
  let issue = 'all_zero_property_current';
  f.options.devices.easee = async ({ now }) => [{ source: 'easee', device: 'fixture-ev', signal: 'property_current_l1',
    value: 0, unit: 'A', sourceTime: now, receivedAt: now, quality: ['current_snapshot_not_energy', issue] }];
  const providers = startProviders(f.options);
  try {
    for (const [i, flag] of ['all_zero_property_current', 'ev_exceeds_property_current', 'asynchronous_snapshot'].entries()) {
      issue = flag; f.setTime(initial + i * 30 * MINUTE); await providers.runDue();
      assert.equal(f.store.getState('providers:health').easee.status, 'degraded');
      assert.equal(f.store.observations().at(-1).quality.includes(flag), true);
    }
  } finally { await providers.close(); }
});
