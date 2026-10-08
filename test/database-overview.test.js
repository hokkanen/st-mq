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
import { LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';

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
    assert.equal(overview.database.adaptiveEstimatedBytes, 0);
    assert.equal(overview.database.adaptiveObservationCount, 0);
    const { available, ...physical } = overview.database.physical;
    assert(available);
    assert.equal(Object.values(physical).reduce((sum, value) => sum + value, 0), overview.database.allocatedBytes);
    assert(physical.journalBytes > 0);
    assert(physical.indexBytes > 0);
    const actual = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(overview.accounting.tables.map(table => table.name), actual.map(table => table.name));
    for (const table of overview.accounting.tables) assert.equal(table.rows,
      store.db.prepare(`SELECT COUNT(*) count FROM ${table.name}`).get().count, table.name);
    const actualViews = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(overview.accounting.views.map(view => view.name), actualViews.map(view => view.name));
    assert(overview.accounting.views.every(view => view.description));
    assert.equal(overview.accounting.totalRows, 2, 'fresh databases contain the history selection and durable transaction checkpoint');
    assert.equal(overview.accounting.selection.retainedSourceRows, 0);
    assert.equal(overview.accounting.selection.selectedSourceRows, 0);
    assert.equal(overview.accounting.selection.excludedSourceRows, 0);
    assert(!overview.accounting.tables.some(table => table.name.startsWith('chart_rollup')));
    assert(!items(overview).has('chart-rollups'));
    assert(!items(overview).has('rollup-metadata'));
    assert.match(overview.groups.find(group => group.id === 'support').description, /original committed records/);
    assert.match(overview.groups.find(group => group.id === 'support').description, /cached chart responses stay in memory/);
    for (const [id, item] of items(overview)) {
      assert(item.description && item.retentionDescription, id);
      assert.equal(item.status, ['history-selection','journal_meta'].includes(id) ? 'present' : 'empty', id);
    }
  } finally { store.close(); }
});

test('physical inventory distinguishes retained observations, disposable journal pages and reusable allocation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-storage-allocation-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const recorder = new Recorder(store);
  recorder.record({ source: 'synthetic', device: 'synthetic', signal: 'supply_temperature', value: 20,
    unit: 'degC', sourceTime: at, receivedAt: at, quality: [] });
  store.setState('synthetic-large-current-state', { value: 'x'.repeat(128 * 1024) });
  store.setState('synthetic-large-current-state', { value: 'small' });
  store.event('synthetic', {}, at + 1);
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = getDatabaseOverview({ store, now: at + 1 }).database;
  const adaptive = store.getState('recorder:adaptive-budget:v1');
  store.compactJournal({ maxBytes: 1, maxCommits: 1 });
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = getDatabaseOverview({ store, now: at + 1 }).database;
  assert(after.physical.journalBytes < before.physical.journalBytes);
  assert(after.reusableBytes > before.reusableBytes);
  assert.equal(after.allocatedBytes, before.allocatedBytes);
  assert.equal(after.fileBytes, before.fileBytes, 'compaction reuses space without claiming file shrinkage');
  assert.equal(after.adaptiveEstimatedBytes, before.adaptiveEstimatedBytes);
  assert.equal(after.adaptiveObservationCount, before.adaptiveObservationCount);
  assert.deepEqual(store.getState('recorder:adaptive-budget:v1'), adaptive);
  assert.equal(after.journalRetention.commits, 1);
  assert(after.journalRetention.baseSequence > before.journalRetention.baseSequence);
});

test('peer catch-up retains its original value separately when disposable transaction history expires', () => {
  const store = new Store(':memory:');
  try {
    store.setState('synthetic-peer-record', { value: 'x'.repeat(128 * 1024) });
    const initial = getDatabaseOverview({ store, now: at }).database;
    enrollJournalPeer(store.db);
    store.setState('synthetic-peer-record', { value: 'changed' });
    store.event('synthetic-after-change', {}, at);
    store.compactJournal({ maxBytes: 1, maxCommits: 1 });
    const result = getDatabaseOverview({ store, now: at }).database;
    assert(result.physical.peerBacklogBytes >= initial.physical.peerBacklogBytes + 128 * 1024,
      'unacknowledged original values remain outside the bounded disposable suffix');
    assert(result.physical.journalBytes < initial.physical.journalBytes);
    const { available, ...categories } = result.physical;
    assert(available);
    assert.equal(Object.values(categories).reduce((sum, value) => sum + value, 0), result.allocatedBytes);
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
    store.setState(`heating-explorer:trial:${privateMarker}`, { status: 'pending', binding: privateMarker });
    store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES(?,?,?,'load',?)")
      .run(privateMarker, privateMarker, at, 8);
    store.setState(`heat-pump-power-config:${privateMarker}`, { version: 1, heatPumpCompressorKw: 2, circulationKw: 0.1, auxRatedKw: 6 });
    store.setState(`contract:${privateMarker}`, { periods: [{ from: at - 86400000, marginCtPerKwh: 1 }, { from: at, marginCtPerKwh: 2 }] });
    store.event('heat-pump-power-config', { input: privateMarker, version: 1, heatPumpCompressorKw: 2, circulationKw: 0.1, auxRatedKw: 6 }, at);
    store.event('decision', { personal: privateMarker }, at);
    store.event('heating-scenario-approved', { binding: privateMarker }, at);
    store.event('charging-energy-unallocated', { source: 'shelly-evse', device: privateMarker,
      start: at - 1000, end: at, referenceKwh: 0.001, reason: 'unknown-phase-share' }, at);
    store.event(privateMarker, { personal: privateMarker }, at);
    for (const kind of ['sample', 'episode', 'context']) store.appendLearningJournal('providers', {
      kind, at, algorithmVersion: LEARNING_ALGORITHM, configVersion: { private: privateMarker },
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
    assert.equal(rows.get('events-charging-unallocated').count, 1);
    assert.match(rows.get('events-charging-unallocated').description, /diagnostic evidence/);
    assert.equal(rows.get('state-heating-scenarios').count, 1);
    assert.equal(rows.get('events-heating-scenarios').count, 1);
    assert.equal(rows.get('controller_phase').count, 2);
    assert.equal(rows.get('controller_phase').firstAt, at);
    assert.equal(rows.get('controller_phase').lastAt, at + 1000);
    assert.equal(rows.get('learning_profit').count, 2);
    assert.equal(rows.get('learning_profit').missingCount, 1);
    assert.equal(rows.get('csv-stmq').count, 5);
    assert.equal(rows.get('csv-easee').count, 6);
    assert.equal(rows.get('adaptive-observations').count, 0, 'room temperatures retain exact changes outside adaptive measurements');
    assert.equal(rows.get('garage_temperature').count, 1);
    assert.equal(rows.get('garage_temperature').recordingPolicy, 'change-only');
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
    assert.equal(overview.catalogueComplete, false, 'unknown writer identities are explicitly reported');
    assert(!encoded.includes(privateMarker));
    assert(!encoded.includes(directory));
    assert(!encoded.includes('invented-private-device'));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recording inventory partitions every current observation writer without conflating exact and adaptive streams', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => at });
  const exact = ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature',
    'garage_temperature_2', 'compressor_active', 'heating_pump_active', 'dhw_routing', 'room_setting', 'alarm_code',
    'auxiliary_output', 'compressor_hours', 'garage_native_energy', 'auxiliary_power', 'heat_savings_active',
    'garage_door1_open', 'garage_door2_open', ...[1, 2, 3, 4].map(id => `floor_groundfloor_${id}_active`)];
  for (const signal of exact) recorder.record({ source: 'mqtt-equipment', device: 'private-example-device', signal,
    value: 1, unit: /active|open|routing/.test(signal) ? 'state' : signal === 'alarm_code' ? 'code' : 'degC',
    sourceTime: at, receivedAt: at, quality: [] });
  const adaptive = ['outdoor_temperature', 'supply_temperature', 'heating_integral', 'garage_native_indoor_temperature',
    'garage_compressor_frequency', 'caravan_temperature', 'caravan_humidity'];
  for (const signal of adaptive) recorder.record({ source: 'mqtt-equipment', device: 'private-example-device', signal,
    value: 10, unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: { reportIntervalMs: 60_000 } });
  for (const prefix of ['property', 'ev1', 'ev2', 'caravan']) recorder.recordEnergy({ source: 'fixture-meter', device: 'private-meter',
    prefix, start: at - 60_000, end: at, powers: prefix === 'caravan' ? [1] : [1, 2, 3],
    energies: prefix === 'caravan' ? [1 / 60] : [1 / 60, 2 / 60, 3 / 60], receivedAt: at, quality: [] });
  for (const time of [at, at + 1000]) recorder.record({ source: 'mqtt-equipment', device: 'dhwr', signal: 'dhwr_active',
    value: 1, unit: 'state', sourceTime: time, receivedAt: time, quality: [], raw: { eventOnly: true, basis: 'measured-power' } });
  put(store, 'garage_energy', 0.1, at, { unit: 'kWh', raw: { intervalStart: at - 60_000, intervalEnd: at } });
  put(store, 'workshop_energy', 1, at, { unit: 'kWh', raw: { intervalStart: at - 3_600_000, intervalEnd: at, timeBasis: 'completed-hour' } });
  put(store, 'ev2_energy_l1', 1, at, { unit: 'kWh', raw: { intervalStart: at - 3_600_000, intervalEnd: at, timeBasis: 'completed-hour' } });
  for (const signal of ['controller_phase', 'dhwr_request', 'learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature'])
    put(store, signal);
  const overview = getDatabaseOverview({ store, now: at + 2000 }), rows = items(overview);
  assert.equal(overview.catalogueComplete, true);
  for (const signal of exact) {
    assert.equal(rows.get(signal).count, 1, signal);
    assert.equal(rows.get(signal).recordingPolicy, 'change-only', signal);
    assert(rows.get(signal).unit && rows.get(signal).writeBehavior && rows.get(signal).basis, signal);
  }
  assert.equal(rows.get('dhwr_active').count, 1);
  assert.equal(rows.get('dhwr_active').recordingPolicy, 'change-only');
  assert.match(rows.get('dhwr_active').writeBehavior, /unchanged reports extend coverage/);
  assert.equal(rows.get('garage_energy').recordingPolicy, 'interval');
  assert.equal(rows.get('workshop_energy').recordingPolicy, 'hourly-energy');
  assert.equal(rows.get('ev2_energy_l1').recordingPolicy, 'hourly-energy', 'A supported custom equipment ID cannot override its actual hourly writer policy');
  for (const signal of adaptive) assert(!rows.has(signal), signal);
  const actualAdaptive = store.db.prepare("SELECT COUNT(*) count FROM observations WHERE json_extract(raw,'$.recorder.policy') LIKE 'adaptive-%'").get().count;
  assert.equal(rows.get('adaptive-observations').count, actualAdaptive);
  assert.equal(rows.get('adaptive-observations').breakdown.reduce((count, row) => count + row.count, 0), actualAdaptive);
  const scalarCount = overview.groups.find(group => group.id === 'other_observations').items.reduce((n, row) => n + row.count, 0);
  assert.equal(scalarCount + actualAdaptive, store.db.prepare('SELECT COUNT(*) count FROM observations').get().count);
  assert(!JSON.stringify(overview).includes('private-example-device'));
});

test('saved adaptive datasets remain individually discoverable without recorder checkpoints', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const [unit, policy, value] of [['degC', 'adaptive-value', 12], ['%', 'adaptive-value', 45]])
    put(store, 'workshop_temperature', value, at, { unit, raw: { recorder: { policy } } });
  put(store, 'ev1_energy_l1', 0.25, at + 1000, { unit: 'kWh', raw: { recorder: { policy: 'adaptive-energy' } } });
  const recorder = new Recorder(store, { clock: () => at });
  assert.equal(recorder.status(at).parameters.length, 0, 'No live checkpoint is invented from recovered observations');
  const overview = getDatabaseOverview({ store, now: at + 2000 });
  const saved = items(overview).get('adaptive-observations');
  assert.equal(overview.catalogueComplete, true);
  assert.equal(saved.count, 3);
  assert.equal(overview.database.adaptiveObservationCount, 3);
  assert(overview.database.adaptiveEstimatedBytes > 300);
  assert.equal(recorder.status(at).adaptiveEstimatedBytes, 0, 'Retained size is separate from prospective budget accounting');
  assert.equal(saved.breakdown.length, 3);
  assert.deepEqual(saved.breakdown.filter(row => row.signal === 'workshop_temperature').map(row => row.unit).sort(), ['%', 'degC']);
  for (const entry of saved.breakdown) {
    assert.equal(entry.count, 1);
    assert(Number.isFinite(entry.firstAt) && Number.isFinite(entry.lastAt));
    assert.match(entry.recordingPolicy, /^adaptive-/);
    assert(entry.label.includes(entry.signal) && entry.label.includes(entry.unit));
  }
});

test('retained adaptive payload size includes metadata and excluded history but never unrelated records or indexes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => at });
  recorder.record({ source:'synthetic', device:'private-device-ä', signal:'supply_temperature', value:21.25,
    unit:'degC', sourceTime:at, receivedAt:at, quality:[], raw:{basis:'fixture'} });
  const first=getDatabaseOverview({store,now:at});
  assert.equal(first.database.adaptiveObservationCount,1);
  assert(first.database.adaptiveEstimatedBytes>300,'Includes timestamps, quality and source metadata, not just numeric values');
  assert(Math.abs(first.database.adaptiveEstimatedBytes-recorder.status(at).adaptiveEstimatedBytes)<10,
    'Full-history SQL and prospective JavaScript estimates describe the same logical payload');
  put(store,'controller_phase',1,at,{raw:{padding:'x'.repeat(50_000)}});
  put(store,'supply_temperature',22,at,{source:'csv:stmq',unit:'degC',raw:{recorder:{policy:'adaptive-value'}}});
  put(store,'unregistered_fixture',22,at,{unit:'degC',raw:{padding:'x'.repeat(50_000)}});
  store.setState('synthetic-extra-state',{padding:'x'.repeat(50_000)});
  store.db.exec('CREATE INDEX synthetic_overview_index ON observations(raw,signal)');
  store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original',?,?)").run('observations','1');
  const states=store.db.prepare('SELECT * FROM state ORDER BY key').all();
  store.db.exec('PRAGMA query_only=ON');
  const expanded=getDatabaseOverview({store,now:at+1000});
  assert.equal(expanded.database.adaptiveEstimatedBytes,first.database.adaptiveEstimatedBytes);
  assert.equal(expanded.database.adaptiveObservationCount,1);
  assert(expanded.database.allocatedBytes>first.database.allocatedBytes+100_000);
  assert.equal(expanded.accounting.selection.excludedSourceRows,1,'Excluded source still occupies retained history');
  assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(),states);
  assert(!JSON.stringify(expanded).includes('private-device'));
});

test('inactive journals, state families and individual event types have separate truthful counts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const input of ['providers', 'garage:providers']) for (const kind of ['sample', 'context'])
    store.appendLearningJournal(input, { kind, at, algorithmVersion: LEARNING_ALGORITHM, key: kind, payload: {} });
  for (const key of ['floor-override:v1', 'equipment-tests:v1', 'equipment:door:v1:private-door',
    'shelly:caravan-energy:v2', 'mqtt:equipment-energy:v1:private-meter', 'charging:providers',
    'charging:providers:charger1:private-association:ownership:ocpp', 'easee:ocpp', 'garage:mode:providers'])
    store.setState(key, { secret: 'private-synthetic-state-payload' });
  for (const type of ['garage-external-temperature-diagnostic', 'garage-external-temperature-diagnostic',
    'garage-room-target-changed', 'mqtt-connected', 'mqtt-disconnected', 'h66-native-setting-confirmed'])
    store.event(type, { secret: 'private-synthetic-event-payload' }, at);
  store.db.exec('PRAGMA query_only=ON');
  const overview = getDatabaseOverview({ store, now: at }), rows = items(overview);
  assert.equal(overview.catalogueComplete, true);
  assert.equal(rows.get('journal-sample').count, 1);
  assert.equal(rows.get('journal-inactive').count, 2);
  assert.equal(rows.get('state-floor').count, 1);
  assert.equal(rows.get('state-equipment-energy').count, 2);
  assert.equal(rows.get('state-charging-ownership').count, 1);
  assert.equal(rows.get('state-charging').count, 1);
  assert.equal(rows.get('events-garage-feed').count, 2);
  assert.equal(rows.get('events-garage').count, 1);
  assert.deepEqual(rows.get('events-garage').breakdown.map(row => row.label), ['garage-room-target-changed']);
  assert.deepEqual(rows.get('events-mqtt').breakdown.map(row => [row.label, row.count]), [['mqtt-connected', 1], ['mqtt-disconnected', 1]]);
  for (const row of overview.groups.find(group => group.id === 'events').items.filter(row => row.breakdown))
    assert.equal(row.breakdown.reduce((count, entry) => count + entry.count, 0), row.count, row.id);
  assert(!JSON.stringify(overview).includes('private-'));
});

test('current operational checkpoints stay distinct from retained measurements and unregistered families remain visible', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const marker = 'private-synthetic-current-state';
  const registrations = [
    [`voltage:estimate:providers`, 'state-voltage'],
    [`equipment:caravan-probe-restoration:v1:${marker}:identity`, 'state-caravan-restoration'],
    [`equipment:dehumidifier-temperature-control:v1:${marker}`, 'state-caravan-temperature-control'],
    ['pair:mqtt-source-context', 'state-pair-mqtt'],
  ];
  for (const [key] of registrations) {
    store.setState(key, { value: marker });
    store.setState(key, { value: marker, revised: true });
  }
  store.setState(registrations[1][0], null);
  const overview = getDatabaseOverview({ store, now: at }), rows = items(overview);
  assert.equal(overview.catalogueComplete, true);
  for (const [, id] of registrations) {
    assert.equal(rows.get(id).count, 1, id);
    assert.equal(rows.get(id).retention, 'current', id);
    assert.equal(rows.get(id).countLabel, 'current entries', id);
    assert.equal(rows.get(id).dateBasis, 'last updates', id);
  }
  assert.equal(rows.get('state-caravan-restoration').missingCount, 1, 'Completed restoration remains an explicit null current entry');
  assert.equal(rows.get('adaptive-observations').count, 0, 'A checkpoint is not recorded voltage history');
  assert.match(rows.get('state-caravan-temperature-control').description, /dashboard choices/);
  assert.match(rows.get('state-pair-mqtt').description, /grants no control authority/);
  assert(!JSON.stringify(overview).includes(marker));

  for (const key of [`equipment:unregistered:${marker}`, `pair:unregistered:${marker}`,
    `voltage:unregistered:${marker}`, `learned:${marker}`, `shelly-evse:${marker}`,
    `equipment:caravan-probe-restoration:v0:${marker}`, `equipment:dehumidifier-temperature-control:v0:${marker}`])
    store.setState(key, { value: marker });
  for (const type of ['override-changed', 'override-expired', 'heating-automation-unregistered'])
    store.event(type, { value: marker }, at);
  store.db.exec('PRAGMA query_only=ON');
  const unsupported = getDatabaseOverview({ store, now: at });
  assert.equal(unsupported.catalogueComplete, false);
  assert.equal(items(unsupported).get('state-other').count, 7);
  assert.equal(items(unsupported).get('events-other').count, 3);
  assert.equal(unsupported.inventoryIssues.length, 2);
  assert(!JSON.stringify(unsupported).includes(marker));
});

test('charging report inventory counts sessions and retained evidence without exposing report payloads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const marker = 'private-synthetic-report-payload';
  const insert = store.db.prepare(`INSERT INTO charging_reports
    (namespace,charger_id,report_id,association,started_at,ended_at,saved_at,summary,checkpoint)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run(marker, 'charger1', 'active', marker, at, null, null, JSON.stringify({ note: marker }), '{}');
  insert.run(marker, 'charger1', 'saved', marker, at - 10000, at - 1000, at, '{}', '{}');
  const event = store.db.prepare(`INSERT INTO charging_report_events
    (namespace,charger_id,report_id,at,category,payload) VALUES(?,?,?,?,?,?)`);
  event.run(marker, 'charger1', 'active', at, 'control', JSON.stringify({ note: marker }));
  event.run(marker, 'charger1', 'saved', at - 1000, 'plans', JSON.stringify({ note: marker }));
  store.db.exec('PRAGMA query_only=ON');
  const overview = getDatabaseOverview({ store, now: at }), rows = items(overview);
  assert.equal(overview.catalogueComplete, true);
  assert.equal(rows.get('charging-reports').count, 2);
  assert.deepEqual(rows.get('charging-reports').facts, [
    { label: 'Active reports', value: 1 }, { label: 'Saved reports', value: 1 },
  ]);
  assert.equal(rows.get('charging-report-events').count, 2);
  assert.match(rows.get('charging-report-events').retentionDescription, /Whole-report expiry or deletion/);
  assert.equal(overview.accounting.tables.find(row => row.name === 'charging_reports').rows, 2);
  assert.equal(overview.accounting.tables.find(row => row.name === 'charging_report_events').rows, 2);
  assert(!JSON.stringify(overview).includes(marker));
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
    const transactionRows = overview.accounting.tables.filter(row => row.name.startsWith('journal_')).reduce((sum,row)=>sum+row.rows,0);
    assert.equal(overview.accounting.totalRows-transactionRows, 7, 'six evidence/state records plus the initialized history selection');
    assert(!JSON.stringify(overview).includes('invented-private'));
  } finally { store.close(); }
});

test('overview separates retained source evidence, published exclusions and selected learning without exposing recovery details', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const privateMarker = 'private-recovery-source-marker';
  for (const index of [0, 1, 2]) put(store, 'controller_phase', index, at + index * 1000);
  const ids = store.db.prepare('SELECT id FROM observations ORDER BY id').all().map(row => row.id);
  const insert = store.db.prepare(`INSERT INTO history_recoveries
    (id,input,donor_digest,source,started_at,completed_at,status,active,report) VALUES(?,?,?,?,?,?,?,?,?)`);
  insert.run(privateMarker, 'providers', privateMarker, JSON.stringify({ kind: 'backup', label: privateMarker }),
    at - 1000, at, 'complete', 0, JSON.stringify({ private: privateMarker }));
  insert.run(`${privateMarker}-active`, 'providers', privateMarker, JSON.stringify({ kind: 'peer', label: privateMarker }),
    at, null, 'interrupted', 1, null);
  const member = store.db.prepare('INSERT INTO recovery_members(recovery_id,table_name,record_key,fingerprint) VALUES(?,?,?,?)');
  member.run(privateMarker, 'observations', String(ids[1]), privateMarker);
  member.run(`${privateMarker}-active`, 'observations', String(ids[2]), privateMarker);
  store.db.prepare('INSERT INTO recovery_decisions(recovery_id,active,at,report,generation,epoch) VALUES(?,?,?,?,?,?)')
    .run(privateMarker, 0, at + 2000, JSON.stringify({ private: privateMarker }), 'published', 'selected');
  const exclusion = store.db.prepare('INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,?,?)');
  exclusion.run('previous', 'observations', String(ids[0]));
  exclusion.run('published', 'observations', String(ids[1]));
  exclusion.run('published', 'observations', '999999');
  exclusion.run('unpublished', 'observations', String(ids[2]));
  const journal = store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,payload,source_entry_id) VALUES(?,?,?,?,?,?,?,?)`);
  const first = Number(journal.run('original', 'providers', 'first', 'sample', at, LEARNING_ALGORITHM, '{}', null).lastInsertRowid);
  const second = Number(journal.run('original', 'providers', 'second', 'sample', at + 1000, LEARNING_ALGORITHM, '{}', null).lastInsertRowid);
  journal.run('selected', 'providers', 'kept', 'sample', at + 1000, LEARNING_ALGORITHM, null, second);
  store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?)').run('providers', 'selected');
  exclusion.run('published', 'learning_journal', String(first));
  store.db.prepare("UPDATE history_selection SET generation='published' WHERE id=1").run();
  store.db.exec('PRAGMA query_only=ON');
  const overview = getDatabaseOverview({ store, now: at + 3000 }), rows = items(overview);
  assert.equal(overview.catalogueComplete, true);
  assert.equal(rows.get('controller_phase').count, 3, 'inventory retains the reverted record');
  assert.equal(rows.get('journal-sample').count, 1, 'model input counts identify the selected completed epoch');
  assert.equal(rows.get('learning-archive').count, 2);
  assert.equal(rows.get('history-recoveries').count, 2);
  assert.equal(rows.get('history-recoveries').firstAt, at - 1000);
  assert.equal(rows.get('recovery-members').count, 2);
  assert.equal(rows.get('recovery-decisions').count, 1);
  assert.equal(rows.get('recovery-exclusions').count, 5, 'retained exclusion references include previous and proposed generations');
  assert.deepEqual(overview.accounting.selection.tables.find(row => row.name === 'observations'),
    { name: 'observations', retainedRows: 3, selectedRows: 2, excludedRows: 1 });
  assert.equal(overview.accounting.selection.selectedSourceRows, 2);
  assert.equal(overview.accounting.selection.excludedSourceRows, 1, 'absent and unpublished rows are not excluded retained evidence');
  assert.equal(overview.accounting.selection.selectedLearningEntries, 1);
  assert.equal(overview.accounting.selection.excludedLearningEntries, 1);
  for (const table of overview.accounting.tables) assert.equal(table.rows,
    store.db.prepare(`SELECT COUNT(*) count FROM ${table.name}`).get().count, table.name);
  assert.equal(overview.accounting.totalRows, overview.accounting.tables.reduce((total, row) => total + row.rows, 0));
  assert.match(overview.database.description, /counts include evidence excluded/);
  assert(!JSON.stringify(overview).includes(privateMarker));
});

test('overview counts composite CSV source identities and avoids disclosing unknown SQL view names', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.db.prepare(`INSERT INTO imports(kind,sha256,path,status,started_at) VALUES('stmq','synthetic','/private/source','complete',?)`).run(at);
  store.db.prepare(`INSERT INTO import_rows(import_id,row_number,source_time,raw,quality,canonical)
    VALUES(1,2,?,'private-original-row','[]','{}')`).run(at);
  store.db.exec(`INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','import_rows','1:2');
    CREATE VIEW "private-view-identity" AS SELECT id FROM observations`);
  store.db.exec('PRAGMA query_only=ON');
  const overview = getDatabaseOverview({ store, now: at });
  assert.deepEqual(overview.accounting.selection.tables.find(row => row.name === 'import_rows'),
    { name: 'import_rows', retainedRows: 1, selectedRows: 0, excludedRows: 1 });
  assert.equal(overview.catalogueComplete, false);
  assert(overview.inventoryIssues.includes('An unregistered SQL view needs an interpretation description.'));
  assert(!JSON.stringify(overview).includes('private-'));
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
