import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { importCsv } from '../src/storage/history.js';
import { getDatabaseOverview, OVERVIEW_REFRESH_MS } from '../src/app/database-overview.js';
import { createChartService } from '../src/app/chart-service.js';
import { createAppServer } from '../src/app/server.js';

const at = Date.parse('2026-01-10T10:00:00Z');
const items = overview => new Map(overview.groups.flatMap(group => group.items.map(item => [item.id, item])));
const put = (store, signal, value = 1, time = at, extras = {}) => store.observation({
  source: 'fixture-source', device: 'invented-private-device', signal, value, sourceTime: time,
  receivedAt: time, unit: 'state', quality: [], ...extras,
});

test('empty overview explains all physical tables without inventing historical presence', () => {
  const store = new Store(':memory:');
  try {
    const overview = getDatabaseOverview({ store, now: at });
    assert.equal(overview.generatedAt, at);
    assert.equal(overview.refreshAfterMs, OVERVIEW_REFRESH_MS);
    assert.equal(overview.database.fileBytes, null);
    assert(overview.database.allocatedBytes > 0);
    const actual = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.equal(actual.length, 16);
    assert.deepEqual(overview.accounting.tables.map(table => table.name), actual.map(table => table.name));
    for (const table of overview.accounting.tables) assert.equal(table.rows,
      store.db.prepare(`SELECT COUNT(*) count FROM ${table.name}`).get().count, table.name);
    assert.equal(overview.accounting.views[0].name, 'provider_snapshots');
    assert.equal(overview.accounting.totalRows, 0, 'fresh databases contain no synthetic chart bookkeeping records');
    assert(!overview.accounting.tables.some(table => table.name.startsWith('chart_rollup')));
    assert(!items(overview).has('chart-rollups'));
    assert(!items(overview).has('rollup-metadata'));
    assert.match(overview.groups.find(group => group.id === 'support').description, /original committed records/);
    assert.match(overview.groups.find(group => group.id === 'support').description, /cached chart responses stay in memory/);
    for (const [id, item] of items(overview)) {
      assert(item.description && item.retentionDescription, id);
      assert.equal(item.status, 'empty', id);
    }
  } finally { store.close(); }
});

test('overview distinguishes saved/null values, imports, shared forecasts, journal and overwritten state without leaking payloads', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-overview-'));
  const store = new Store(':memory:');
  const privateMarker = 'invented-private-marker-not-for-display';
  try {
    put(store, 'controller_phase', 1);
    put(store, 'controller_phase', 2, at + 1000);
    put(store, 'learning_profit', null);
    put(store, 'learning_profit', 0.12, at + 1000);
    put(store, privateMarker, 1, at, { raw: { note: privateMarker } });
    const recorder = new Recorder(store, { clock: () => at });
    recorder.record({ source: 'mqtt', device: privateMarker, signal: 'garage_temperature', value: 12,
      unit: 'degC', sourceTime: at, receivedAt: at, quality: [] });
    store.setState(`settings:${privateMarker}`, { credential: privateMarker });
    store.setState(`settings:${privateMarker}`, { credential: privateMarker, mode: 'observe' });
    store.setState(`fireplace:rebuild:${privateMarker}`, { status: 'running', error: privateMarker });
    store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES(?,?,?,'load',?)")
      .run(privateMarker, privateMarker, at, 8);
    store.setState(`heat-pump-power-config:${privateMarker}`, { version: 1, heatPumpCompressorKw: 2, circulationKw: 0.1, auxRatedKw: 6 });
    store.setState(`contract:${privateMarker}`, { periods: [{ from: at - 86400000, marginCtPerKwh: 1 }, { from: at, marginCtPerKwh: 2 }] });
    store.event('heat-pump-power-config', { input: privateMarker, version: 1, heatPumpCompressorKw: 2, circulationKw: 0.1, auxRatedKw: 6 }, at);
    store.event('decision', { personal: privateMarker }, at);
    store.event(privateMarker, { personal: privateMarker }, at);
    store.learningSample('fixture-input', { timestamp: at, note: privateMarker });
    for (const kind of ['sample', 'episode', 'context']) store.appendLearningJournal('fixture-input', {
      kind, at, algorithmVersion: 'fixture-algorithm', configVersion: { private: privateMarker },
      forecastVersion: { private: privateMarker }, key: kind, payload: { private: privateMarker },
    });
    store.db.prepare('INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload) VALUES(?,?,?,?,?,?)')
      .run('fixture-cycle', privateMarker, at, at + 1000, 'completed', JSON.stringify({ assessment: { private: privateMarker } }));
    for (const [kind, header, row] of [
      ['stmq', 'unix_time,price,heat_on,temp_in,temp_ga,temp_out', '3,15,20,10,-1'],
      ['easee', 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3', '1,2,3,4,5,6'],
    ]) {
      const path = join(directory, `${privateMarker}-${kind}.csv`);
      writeFileSync(path, `${header}\n${at / 1000},${row}\n`);
      await importCsv(store, path, { kind });
    }
    const weather = { forecast: [{ start: at, end: at + 3600000, outdoorC: -1, solarRadiationWm2: 12 }], private: privateMarker };
    store.snapshot({ kind: 'weather', source: privateMarker, fetchedAt: at, payload: { ...weather, fetchedAt: at } });
    store.snapshot({ kind: 'weather', source: privateMarker, fetchedAt: at + 1000, payload: { ...weather, fetchedAt: at + 1000 } });
    store.snapshot({ kind: 'market', source: privateMarker, fetchedAt: at, payload: { intervals: [], private: privateMarker } });
    store.energyAudit({ source: 'easee', device: privateMarker, signal: 'property_import_energy_counter',
      sourceTime: at, receivedAt: at, value: 100, quality: [] });
    store.annotation({ kind: 'fixture', startAt: at, note: privateMarker, boundaryConfidence: 'exact', excludeTraining: true, provenance: privateMarker });
    store.counter({ device: privateMarker, signal: 'compressor_runtime', value: 100, observedDate: '2026-01-10', note: privateMarker, provenance: privateMarker });
    const overview = getDatabaseOverview({ store, now: at + 2000 });
    const rows = items(overview);
    assert.equal(rows.get('controller_phase').count, 2);
    assert.equal(rows.get('controller_phase').firstAt, at);
    assert.equal(rows.get('controller_phase').lastAt, at + 1000);
    assert.equal(rows.get('learning_profit').count, 2);
    assert.equal(rows.get('learning_profit').missingCount, 1);
    assert.equal(rows.get('csv-stmq').count, 5);
    assert.equal(rows.get('csv-easee').count, 6);
    assert.equal(rows.get('adaptive-observations').count, 1, 'imported temperatures do not inflate adaptive observations');
    assert.equal(rows.get('weather-snapshots').count, 2);
    assert.deepEqual(rows.get('weather-snapshots').facts.map(fact => fact.value), [1, 1]);
    assert.equal(rows.get('snapshot-content').count, 2, 'shared content is counted once physically');
    assert.equal(rows.get('contract-periods').count, 2);
    assert.equal(rows.get('state-contract').count, 1);
    assert.equal(rows.get('state-settings').count, 1, 'overwritten settings are not extra history');
    assert.equal(rows.get('state-settings').retention, 'current');
    assert.equal(rows.get('fireplace-loads').count, 1);
    assert.equal(rows.get('fireplace-loads').firstAt, at);
    assert.equal(rows.get('fireplace-loads').lastAt, at);
    assert.equal(rows.get('state-fireplace').count, 1);
    assert.equal(rows.get('state-fireplace').retention, 'current');
    assert.equal(rows.get('events-heat-power-config').count, 1);
    for (const kind of ['sample', 'episode', 'context']) assert.equal(rows.get(`journal-${kind}`).count, 1);
    assert.equal(rows.get('learning-cycles').facts.find(fact => fact.label.includes('assessments')).value, 1);
    assert.equal(rows.get('manual-counters').count, 1);
    assert.equal(rows.get('manual-counters').datePrecision, 'date');
    assert.equal(rows.get('annotations').count, 1);
    for (const table of overview.accounting.tables) assert.equal(table.rows,
      store.db.prepare(`SELECT COUNT(*) count FROM ${table.name}`).get().count, table.name);
    const encoded = JSON.stringify(overview);
    assert(!encoded.includes(privateMarker));
    assert(!encoded.includes(directory));
    assert(!encoded.includes('invented-private-device'));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('fireplace inventory separates retained loads, correction actions and current rebuild state without exposing entries', () => {
  const store = new Store(':memory:');
  const old = at - 10 * 86_400_000;
  const insert = store.db.prepare('INSERT INTO fireplace_events(input,request_id,at,kind,kg,target_id) VALUES(?,?,?,?,?,?)');
  try {
    const first = Number(insert.run('providers', 'invented-private-old-load', old, 'load', 8, null).lastInsertRowid);
    insert.run('providers', 'invented-private-top-up', at, 'load', 2, null);
    insert.run('simulated', 'invented-private-simulation', at + 1_000, 'load', 10, null);
    insert.run('providers', 'invented-private-correction-one', at + 2_000, 'remove', null, first);
    insert.run('providers', 'invented-private-correction-two', at + 3_000, 'remove', null, first);
    store.setState('fireplace:rebuild:providers', { status: 'pending', revision: 5 });
    store.setState('fireplace:rebuild:providers', { status: 'running', revision: 5 });
    store.db.exec('PRAGMA query_only=ON');
    const overview = getDatabaseOverview({ store, now: at + 4_000 });
    const rows = items(overview), loads = rows.get('fireplace-loads'), corrections = rows.get('fireplace-corrections');
    assert.equal(loads.count, 3, 'full retained history includes additions older than the 48-hour UI window');
    assert.equal(loads.firstAt, old); assert.equal(loads.lastAt, at + 1_000);
    assert.equal(loads.retention, 'history');
    assert.deepEqual(loads.facts, [{ label: 'Unretracted additions', value: 2 }, { label: 'Retracted additions', value: 1 }]);
    assert.equal(corrections.count, 2, 'distinct correction actions are counted even when they target the same load');
    assert.equal(corrections.firstAt, at + 2_000); assert.equal(corrections.lastAt, at + 3_000);
    assert.equal(corrections.dateBasis, 'correction time');
    assert.equal(rows.get('state-fireplace').count, 1, 'updated worker progress is current state, not duplicated historical records');
    assert.equal(overview.accounting.tables.find(table => table.name === 'fireplace_events').rows, 5);
    assert.equal(overview.accounting.totalRows, 6);
    assert(!JSON.stringify(overview).includes('invented-private'));
  } finally { store.close(); }
});

test('overview API is authenticated, worker-backed, cached and read-only', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-overview-api-'));
  const store = new Store(join(directory, 'history.sqlite'));
  const service = createChartService({ store });
  const token = 'fixture-token';
  const server = createAppServer({ store, engine: {}, chartService: service, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.close(); await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/recording-overview`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  put(store, 'controller_phase', 1);
  const before = store.db.prepare('PRAGMA data_version').get().data_version;
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.cache.hit, false);
  assert(first.database.totalFileBytes > 0);
  assert.equal(items(first).get('controller_phase').count, 1);
  put(store, 'controller_phase', 2, at + 1000);
  const cached = await fetch(url, { headers }).then(result => result.json());
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.generatedAt, first.generatedAt);
  assert.equal(items(cached).get('controller_phase').count, 1, 'inventory explicitly reports cached snapshot counts');
  assert.equal(store.db.prepare('PRAGMA data_version').get().data_version, before, 'worker never writes the database');
  const cancellation = new AbortController(); cancellation.abort();
  await assert.rejects(service.overview({ signal: cancellation.signal }), { name: 'AbortError' });
});
