import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, learningJournalRows } from '../src/storage/store.js';
import { reconstructionSource } from '../src/app/model-reconstruction-source.js';
import { createCoefficientGeneration, readCoefficientEvents, readCoefficientHistory } from '../src/storage/coefficient-history.js';
import { indoorReportCoverage } from '../src/app/indoor-readings.js';
import { pendingEnergyObservations } from '../src/storage/pending-energy.js';
import { Recorder } from '../src/storage/recorder.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { recordedChargingReportNamespace } from '../src/charging/session-diagnostics.js';

const at = Date.UTC(2026, 0, 1);

function tracked(store) {
  const plans = [];
  const reader = { db: { exec: store.db.exec.bind(store.db), prepare(sql) {
    const statement = store.db.prepare(sql);
    return Object.fromEntries(['get', 'all', 'iterate'].map(method => [method, (...params) => {
      plans.push({ sql, details: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail) });
      return statement[method](...params);
    }]));
  } } };
  return { reader, plans };
}

function entry(store, epoch, time, { input = 'mqtt', source = null } = {}) {
  return Number(store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,config_version,forecast_version,payload,source_entry_id)
    VALUES(?,?,?,'sample',?,?,?,?,?,?)`).run(epoch, input, `${epoch}:${time}`, time, LEARNING_ALGORITHM,
      source ? null : '{"synthetic":true}', source ? null : '{"version":1}', source ? null : '{"value":{}}', source).lastInsertRowid);
}

test('fixed-boundary journal pages preserve selected prefixes, inherited bodies and ingestion order with indexed seeks', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let first, second, projected, last;
  store.transaction(() => {
    first = entry(store, 'original', at + 40);
    entry(store, 'original', at + 20, { input: 'simulated' });
    second = entry(store, 'original', at + 10);
    entry(store, 'original', at + 50); // Unselected suffix of the old epoch.
    store.db.prepare("INSERT INTO learning_epochs VALUES('mqtt','corrected')").run();
    store.db.prepare("INSERT INTO learning_epoch_segments VALUES('corrected','mqtt','original',0,?)").run(second);
    projected = entry(store, 'corrected', at + 60, { source: first });
    last = entry(store, 'corrected', at + 30);
  });
  const { reader, plans } = tracked(store);
  const expected = store.db.prepare('SELECT * FROM learning_journal WHERE input=? ORDER BY id').all('mqtt');
  const read = options => learningJournalRows(reader.db, { input: 'mqtt', ...options });
  for (const through of [0, first, second, projected, last]) for (const after of [0, first, projected]) {
    const wanted = expected.filter(row => row.id > after && row.id <= through);
    assert.deepEqual(read({ after, through }).map(row => row.id), wanted.map(row => row.id));
    assert.deepEqual(read({ after, through, limit: 1 }).map(row => row.id), wanted.slice(0, 1).map(row => row.id));
  }
  assert.deepEqual(read({}).map(row => row.id), [first, second, projected, last]);
  assert.equal(read({ after: second, through: projected })[0].payload, expected.find(row => row.id === projected).payload);
  assert.equal(read({ after: second, through: projected })[0].config_version, '{"synthetic":true}');
  assert.deepEqual(read({ limit: 0 }), []);
  assert.throws(() => read({ through: -1 }), /through/);
  const pages = plans.filter(plan => plan.sql.includes('COALESCE(e.payload,s.payload)'));
  assert(pages.length > 0);
  for (const plan of pages) {
    assert(plan.details.some(detail => /learning_entries_epoch_input.*id>.*id</.test(detail)));
    assert(!plan.details.some(detail => /UNION|TEMP B-TREE/.test(detail)), 'Each source page seeks directly without sorting an inherited archive');
  }
});

test('reconstruction status seeks the selected head and preserves snapshot cutoffs before a nonmonotonic suffix', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let first, prefix, future, last;
  store.transaction(() => {
    first = entry(store, 'original', at + 10);
    prefix = entry(store, 'original', at + 20);
    entry(store, 'original', at + 1000);
    store.db.prepare("INSERT INTO learning_epochs VALUES('mqtt','corrected')").run();
    store.db.prepare("INSERT INTO learning_epoch_segments VALUES('corrected','mqtt','original',0,?)").run(prefix);
    future = entry(store, 'corrected', at + 40);
    last = entry(store, 'corrected', at + 15);
  });
  const { reader, plans } = tracked(store);
  const read = through => reconstructionSource(reader, 'mqtt', { through, includeModel: false,
    revisions: { fireplaceRevision: 0, sensorRevision: 0 } });
  assert.equal(read(Infinity).head, last);
  assert.equal(read(Infinity).throughAt, at + 40);
  assert.equal(read(at + 40).head, last);
  assert.equal(read(at + 20).head, prefix, 'The earlier future entry also fences a later-ingested older sample');
  assert.equal(read(at + 10).head, first);
  assert.equal(read(at).head, 0);
  assert.equal(read(at).throughAt, null);
  assert(future > prefix);
  assert(!plans.some(plan => /FROM learning_journal\b/.test(plan.sql)), 'Ordinary status must not sort the canonical union');
});

test('coefficient windows seek time while cursor pages retain selected generation boundaries and cursor ordering', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let source, selected, ids;
  store.transaction(() => {
    source = createCoefficientGeneration(store, 'mqtt');
    ids = [10, 30, 20, 40].map(offset => entry(store, 'original', at + offset));
    const insert = store.db.prepare('INSERT INTO coefficient_events VALUES(?,?,?,?,?)');
    for (const [index, id] of ids.entries()) insert.run(source, id, at + [10, 30, 20, 40][index], 'null',
      '{"learned":[],"fitted":[],"blocked":false}');
    store.db.prepare('UPDATE coefficient_generations SET cursor=? WHERE id=?').run(ids.at(-1), source);
    selected = createCoefficientGeneration(store, 'mqtt', { sourceGeneration: source, prefixCursor: ids[1] });
    insert.run(selected, ids[3], at + 25, 'null', '{"learned":[],"fitted":[],"blocked":false}');
    store.db.prepare('UPDATE coefficient_generations SET cursor=? WHERE id=?').run(ids[3], selected);
    store.db.prepare("INSERT INTO coefficient_selection VALUES('mqtt',?)").run(selected);
  });
  const { reader, plans } = tracked(store);
  const read = options => readCoefficientEvents(reader, { input: 'mqtt', ...options });
  assert.deepEqual(read({}).map(row => row.cursor), [ids[0], ids[1], ids[3]]);
  assert.deepEqual(read({ from: at + 20, to: at + 30 }).map(row => row.cursor), [ids[1], ids[3]],
    'Time selection keeps cursor order across inherited and current ranges, including nonmonotonic times');
  assert.deepEqual(read({ from: at + 20, to: at + 30, limit: 1 }).map(row => row.cursor), [ids[1]]);
  assert.deepEqual(read({ from: at + 20, to: at + 30, afterCursor: ids[1] }).map(row => row.cursor), [ids[3]]);
  assert.deepEqual(read({ from: at + 100 }), []);
  assert.deepEqual(read({ throughCursor: ids[1] }).map(row => row.cursor), ids.slice(0, 2));
  for (const plan of plans.filter(plan => plan.sql.includes('SELECT cursor,at,coefficients'))) {
    if (plan.sql.includes('AND +cursor>')) assert(plan.details.some(detail => /coefficient_events_time.*at>.*at</.test(detail)));
    else {
      assert(plan.details.some(detail => /PRIMARY KEY.*cursor>.*cursor</.test(detail)));
      assert(!plan.details.some(detail => /TEMP B-TREE/.test(detail)), 'Full verification remains cursor-paged');
    }
  }
});

test('indoor coverage seeks receipts and retains direct observations, selected history and coverage exclusions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = { reportIntervalMs: 60_000, reportGraceMs: 60_000 };
  const put = (sourceTime, extra = {}) => store.observation({ source: 'synthetic', device: 'room',
    signal: 'indoor_temperature', value: 21, unit: 'degC', quality: [], sourceTime, receivedAt: sourceTime, raw, ...extra });
  put(at - 10 * 60_000);
  const first = put(at), excluded = put(at + 1), retained = put(at + 2, { quality: ['retained'] });
  const covered = put(at + 3), last = put(at + 4);
  store.transaction(() => {
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)").run(String(excluded));
    store.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES('synthetic','room','indoor_temperature','missing-report',?,?,?,?,1)`).run(at + 3, at + 3, at + 3, covered);
  });
  const reading = { source: 'synthetic', device: 'room', signal: 'indoor_temperature', raw };
  const { reader, plans } = tracked(store);
  const result = indoorReportCoverage(reader, { reading, from: at, at: at + 5 });
  assert.equal(result.complete, false, 'The native reporting gap remains visible');
  assert.equal(result.available, true);
  assert.deepEqual(result.observations, [first, last]);
  assert(!result.observations.includes(excluded) && !result.observations.includes(retained) && !result.observations.includes(covered));
  const direct = plans.find(plan => plan.sql.includes('WHERE +o.source=?'));
  assert(direct.details.some(detail => /observations_receipt.*received_at>.*received_at</.test(detail)));
  assert(direct.details.some(detail => /recovery_coverage_parent.*observation_id=/.test(detail)));
  assert(!direct.details.some(detail => /TEMP B-TREE|SCAN /.test(detail)));
});

test('a long coefficient chart streams each selected source once instead of repeating its time-window sort per page', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.transaction(() => {
    const generation = createCoefficientGeneration(store, 'mqtt');
    const insert = store.db.prepare('INSERT INTO coefficient_events VALUES(?,?,?,?,?)');
    let cursor;
    for (let n = 1; n <= 300; n++) {
      cursor = entry(store, 'original', at + n);
      insert.run(generation, cursor, at + n, 'null', '{"learned":[],"fitted":[],"blocked":false}');
    }
    store.db.prepare('UPDATE coefficient_generations SET cursor=? WHERE id=?').run(cursor, generation);
    store.db.prepare("INSERT INTO coefficient_selection VALUES('mqtt',?)").run(generation);
  });
  const { reader, plans } = tracked(store), points = [];
  const result = readCoefficientHistory({ store: reader, input: 'mqtt', range: { from: at, to: at + 301 },
    now: at + 301, envelopes: { model_coefficient_heat_loss: { add: (...args) => points.push(args) } } });
  assert.equal(result.records, 300);
  assert.equal(result.replayedRecords, 0);
  assert(points.length >= 300);
  assert.equal(plans.filter(plan => plan.sql.includes('AND +cursor>')).length, 1,
    'One native time-window cursor supplies all drawing events without an archive-sized JavaScript array');
});

test('recorder health and pending-energy reads seek their state namespaces despite unrelated historical keys', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store);
  recorder.record({ source: 'synthetic', device: 'room', signal: 'indoor_temperature', value: 21,
    unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: {} });
  store.setState('recorder:energy:["synthetic","meter","property"]', { pending: {
    start: at, end: at + 1000, receivedAt: at + 1000, energies: [0.1, 0.2, 0.3], quality: [] } });
  for (let n = 0; n < 20; n++) store.setState(`charging-session-check:synthetic-${n}`, { eventId: n });
  const expected = recorder.sourceStatus(at + 1000);
  const { reader, plans } = tracked(store);
  recorder.store = reader;
  assert.deepEqual(recorder.sourceStatus(at + 1000), expected);
  assert.deepEqual(pendingEnergyObservations(reader, { now: at + 1000, input: 'providers' }).map(row => row.value), [0.1, 0.2, 0.3]);
  const namespaces = plans.filter(plan => plan.sql.includes('FROM state WHERE key GLOB'));
  assert.equal(namespaces.length, 2);
  for (const plan of namespaces) assert(plan.details.some(detail => /SEARCH state.*key>.*key</.test(detail)),
    'Binary prefix lookups must seek the key index rather than scan unrelated session identities');
});

test('offline report namespace discovery skips retained reports and keeps each charger independent', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(recordedChargingReportNamespace(store, 'charger1'), null);
  store.transaction(() => {
    const insert = store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,summary,checkpoint)
      VALUES(?,?,?,?,?,'{}','{}')`);
    for (const [namespace, chargerId, reportId, startedAt] of [
      ['a', 'charger1', 'one', at], ['a', 'charger1', 'two', at + 20],
      ['a:x', 'charger1', 'three', at + 30], ['a:x', 'charger2', 'four', at + 100],
      ['b', 'charger1', 'five', at + 10], ['c', 'charger1', 'six', at + 30],
    ]) insert.run(namespace, chargerId, reportId, 'synthetic-association', startedAt);
  });
  const { reader, plans } = tracked(store);
  assert.equal(recordedChargingReportNamespace(reader, 'charger1'), 'a:x', 'Equal clocks select the first namespace deterministically');
  assert.equal(recordedChargingReportNamespace(reader, 'charger2'), 'a:x');
  assert.equal(recordedChargingReportNamespace(reader, 'absent'), null);
  for (const plan of plans) {
    assert(!plan.details.some(detail => /TEMP B-TREE/.test(detail)));
    if (plan.sql.includes('WHERE namespace>?')) assert(plan.details.some(detail => /namespace>/.test(detail)));
    if (plan.sql.includes('charger_id=?')) assert(plan.details.some(detail => /charging_reports_history.*namespace=.*charger_id=/.test(detail)));
  }
});
