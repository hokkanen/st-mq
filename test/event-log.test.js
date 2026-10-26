import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { readCheckpoint } from '../src/storage/journal.js';
import { eventLogQuery, readEventLog } from '../src/app/event-log.js';
import { createEventLogService } from '../src/app/event-log-service.js';
import { createAppServer } from '../src/app/server.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { presentGeneral, presentCharging } from '../src/app/event-log-presentation.js';
import { Worker } from 'node:worker_threads';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const query = search => eventLogQuery(new URL(`http://fixture/api/events${search ? `?${search}` : ''}`));
const id = (kind, value) => `${kind}:${String(value).padStart(16, '0')}`;
function fixture(t, { disk = false } = {}) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'event-log-test-')) : null;
  const store = new Store(directory ? join(directory, 'history.sqlite') : ':memory:');
  t.after(() => { store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { store, read: search => readEventLog({ db: store.db, input: 'mqtt', now: NOW, query: query(search) }) };
}
function chargingRecord(store, { charger = 'charger2', report = 'a'.repeat(64), at = NOW - 5000, kind = 'physical', code = 'charging-stopped', powerKw = 0, privateText = '' } = {}) {
  const namespace = 'charging:mqtt:session-diagnostics';
  store.write(() => {
    store.db.prepare(`INSERT OR IGNORE INTO charging_reports(namespace,charger_id,report_id,association,started_at,summary,checkpoint)
      VALUES(?,?,?,?,?,'{}','{}')`).run(namespace, charger, report, 'synthetic-association', NOW - 10000);
    store.db.prepare(`INSERT INTO charging_report_events(namespace,charger_id,report_id,at,category,payload)
      VALUES(?,?,?,?,?,?)`).run(namespace, charger, report, at, ['finding', 'finding-update', 'recovery'].includes(kind) ? 'findings'
        : ['physical', 'charger-status', 'outcome', 'session', 'check'].includes(kind) ? 'charging'
          : ['vehicle', 'identification'].includes(kind) ? 'vehicle' : kind === 'shared' || kind === 'plan' ? 'plans' : kind,
      JSON.stringify({ kind, code, powerKw, measuredAt: at - 1000, receivedAt: at, privateText }));
  });
  return Number(store.db.prepare('SELECT MAX(id) id FROM charging_report_events').get().id);
}

test('timeline is sanitized, readable and scoped while Important omits routine decisions', t => {
  const { store, read } = fixture(t);
  store.event('controller-error', { input: 'mqtt', message: 'synthetic-sensitive-password broker://private.invalid', path: '/private/fixture' }, NOW - 1000);
  store.event('decision', { input: 'mqtt', phase: 'normal', commands: ['synthetic-secret'], reasons: ['synthetic-private-reason'] }, NOW - 2000);
  store.event('settings-reloaded', { input: 'simulated', token: 'synthetic-sensitive-password' }, NOW - 3000);
  const important = read();
  assert.equal(important.events.length, 1);
  assert.equal(important.events[0].title, 'Controller update failed');
  assert.equal(important.events[0].severity, 'error');
  assert.equal(important.events[0].evidence, 'Recorded application event');
  assert.doesNotMatch(JSON.stringify(important), /synthetic-sensitive|private\.invalid|\/private\/fixture|synthetic-secret|synthetic-private-reason/);
  assert.equal(read('view=all').events.length, 2);
  assert.equal(read('area=charging').events.length, 0);
  assert.match(important.coverage, /history may be incomplete/);
});

test('occurrence-time paging retains recovered old timestamps and exact same-time ties', t => {
  const { store, read } = fixture(t);
  for (let n = 0; n < 15; n++) store.event('occupancy-changed', { input: 'mqtt', occupancy: { mode: 'away' } }, NOW - (n % 3) * 1000);
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 86400000);
  store.write(() => store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','synthetic-load',?,'load',4)").run(NOW));
  const all = read('limit=200').events, collected = [];
  let cursor;
  do {
    const page = read(`limit=3${cursor ? `&before=${cursor}` : ''}`);
    collected.push(...page.events); cursor = page.nextBefore;
  } while (cursor);
  assert.deepEqual(collected, all);
  assert.equal(new Set(collected.map(row => row.id)).size, collected.length);
  assert.equal(collected[0].id.startsWith('firewood:'), true);
  assert.equal(collected.at(-1).title, 'Configuration applied');
  assert.equal(collected.at(-1).at, NOW - 86400000);
});

test('older operational and firewood pages seek an indexed time range rather than scanning the type or input prefix', t => {
  const { store, read } = fixture(t);
  for (let n = 0; n < 8; n++) store.event('settings-reloaded', { input: 'mqtt' }, NOW - n * 1000);
  const context = read().context, plans = [];
  const db = new Proxy(store.db, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (!/FROM (events|fireplace_events)\s+WHERE/.test(sql)) return statement;
      return { all(...args) {
        plans.push({ sql, details: target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join(' ') });
        return statement.all(...args);
      } };
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  for (const source of ['event', 'firewood']) {
    plans.length = 0;
    const before = Buffer.from(JSON.stringify({ context, view: 'all', area: 'home', at: NOW - 3000, id: id(source, 4) })).toString('base64url');
    readEventLog({ db, input: 'mqtt', now: NOW, query: query(`view=all&area=home&before=${before}`) });
    assert(plans.length > 0);
    for (const plan of plans) assert.match(plan.details, /at[<=>]/, plan.details);
  }
});

test('Important selects charging instructions, incidents and transitions without altering stored reports', t => {
  const { store, read } = fixture(t);
  const retained = [
    ['session', 'connected'], ['physical', 'charging-started'], ['physical', 'charging-stopped'],
    ['evidence', 'physical-evidence-lost'], ['evidence', 'physical-evidence-restored'], ['evidence', 'observation-gap'],
    ['vehicle', 'identified'], ['identification', 'failed'], ['outcome', 'target-confirmed'],
    ['finding', 'control-unconfirmed'], ['recovery', 'control-unconfirmed'],
  ];
  const routine = [['evidence', 'shared-charging-evidence'], ['shared', 'shared-charging-context'],
    ['physical', 'not-charging-observed'], ['physical', 'physical-unknown'], ['charger-status', 'charger-reports-not-charging'],
    ['control', 'waiting'], ['check', 'pause'], ['identification', 'completed']];
  for (const [kind, code] of [...retained, ...routine]) chargingRecord(store, { kind, code });
  store.event('charging-control-changed', { input: 'mqtt', chargerId: 'charger2', action: 'pause' }, NOW);
  const checkpoint = readCheckpoint(store.db);
  const important = read('area=charging'), all = read('area=charging&view=all');
  assert.equal(important.events.length, retained.length + 1);
  assert.equal(all.events.length, retained.length + routine.length, 'Full planning snapshots stay in the session report');
  assert(important.events.some(row => row.title.includes('Pause requested')));
  assert(!important.events.some(row => row.title.includes('Shared current evidence')));
  assert(all.events.some(row => row.title.includes('Shared current evidence changed')));
  assert.equal(store.db.prepare('SELECT count(*) n FROM charging_report_events').get().n, retained.length + routine.length);
  assert.deepEqual(readCheckpoint(store.db), checkpoint);
  const detailed = presentCharging({ namespace: 'charging:mqtt:session-diagnostics', charger_id: 'charger2' }, {
    kind: 'evidence', code: 'shared-charging-evidence', shared: { execution: { expectedCurrentA: 0, reportedCurrentA: 6, commandReady: false } },
  });
  assert.deepEqual(detailed.details.slice(-3), [
    { label: 'Assessed current allowance', value: '0 A' }, { label: 'Reported current setting', value: '6 A' },
    { label: 'Adjustment readiness', value: 'Not ready' },
  ]);
});

test('dataset and selected-history context invalidates cursors but ordinary commits retain it', t => {
  const { store, read } = fixture(t);
  for (let n = 0; n < 3; n++) store.event('settings-reloaded', { input: 'mqtt' }, NOW - n);
  const first = read('limit=1');
  store.event('occupancy-expired', { input: 'mqtt' }, NOW);
  assert.equal(read().context, first.context);
  store.write(() => store.db.prepare("UPDATE history_selection SET generation='synthetic-selection' WHERE id=1").run());
  assert.notEqual(read().context, first.context);
  assert.throws(() => read(`limit=1&before=${first.nextBefore}`), { code: 'event_log_context_changed' });
  const other = new Store(':memory:');
  try { assert.notEqual(readEventLog({ db: other.db, input: 'mqtt', now: NOW }).context, read().context); } finally { other.close(); }
});

test('visible membership removes excluded or expired records without confusing an older row with a pushed-out row', t => {
  const { store, read } = fixture(t);
  const oldId = store.event('settings-reloaded', { input: 'mqtt' }, NOW - 30000);
  const goneId = store.event('occupancy-expired', { input: 'mqtt' }, NOW - 20000);
  const reportId = chargingRecord(store);
  const visible = [id('event', oldId), id('event', goneId), id('charging', reportId)];
  store.write(() => {
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','events',?)").run(String(goneId));
    store.db.prepare('DELETE FROM charging_reports').run();
  });
  for (let n = 0; n < 20; n++) store.event('settings-reloaded', { input: 'mqtt' }, NOW - n);
  const head = read(`limit=1&visible=${visible.join(',')}`);
  assert.equal(head.events.some(row => row.id === visible[0]), false);
  assert.deepEqual(head.retainedIds, [visible[0]]);
});

test('charging milestones preserve measured-zero and unknown evidence and link the canonical report', t => {
  const { store, read } = fixture(t);
  chargingRecord(store, { privateText: 'synthetic-private-device-identifier' });
  chargingRecord(store, { kind: 'physical', code: 'physical-unknown', powerKw: null, at: NOW - 2000 });
  const events = read('view=all&area=charging').events;
  assert.equal(events.length, 2);
  assert.equal(events[0].evidence, 'Physical evidence unavailable');
  assert.match(events[0].summary, /does not establish that charging stopped/);
  assert.equal(events[1].evidence, 'Measured power evidence');
  assert.deepEqual(events[1].details.find(row => row.label === 'Measured power'), { label: 'Measured power', value: '0 kW' });
  assert.deepEqual(events[1].related, { kind: 'charging-report', chargerId: 'charger2', reportId: 'a'.repeat(64) });
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private/);
});

test('saved phase, waiting receipts, diagnostic recovery and threshold changes preserve their actual evidence', () => {
  const first = presentGeneral('heating-phase-changed', { phase: 'normal', previousPhase: null, input: 'mqtt' });
  assert.equal(first.title, 'Normal heating first recorded'); assert.equal(first.evidence, 'Recorded controller phase');
  const waiting = presentGeneral('heating-test-sent', { sent: false, status: 'waiting', command: 'preheat' });
  assert.equal(waiting.title, 'Heating action waiting'); assert.doesNotMatch(waiting.evidence, /dispatch/);
  const unchanged = presentGeneral('heating-test-sent', { sent: false, status: 'confirmed', command: 'preheat' });
  assert.equal(unchanged.evidence, 'Recorded command receipt');
  const recovered = presentGeneral('garage-external-temperature-diagnostic', { status: 'normal' });
  assert.equal(recovered.severity, 'info'); assert.match(recovered.title, /recovered/);
  const thresholds = presentGeneral('caravan-control-changed', { enabled: true, offAtC: 5, onAtC: 8, previous: { enabled: true, offAtC: 4, onAtC: 7 } });
  assert.equal(thresholds.title, 'Caravan power thresholds changed');
  const simulated = presentCharging({ namespace: 'charging:simulated:session-diagnostics', charger_id: 'charger1', report_id: 'a'.repeat(64) }, { kind: 'physical', code: 'charging-started', powerKw: 7 });
  assert.equal(simulated.evidence, 'Simulation'); assert.match(simulated.summary, /not physical device evidence/);
});

test('missing and unreadable current payload details never manufacture a definite choice or indefinite Pause', t => {
  const { store, read } = fixture(t);
  store.event('heating-automation-changed', {}, NOW - 1000);
  store.event('occupancy-changed', { occupancy: { mode: 'synthetic-unknown' } }, NOW - 2000);
  store.event('heating-pause-changed', { pause: {} }, NOW - 3000);
  store.event('heating-automation-changed', { oversized: 'x'.repeat(10000) }, NOW - 4000);
  const events = read().events;
  assert.equal(events[0].title, 'Heating permission recorded');
  assert.equal(events[1].title, 'Occupancy selection recorded');
  assert.equal(events[2].details.find(row => row.label === 'Resume at').value, 'Not recorded');
  assert.equal(events[3].title, 'Heating permission recorded');
  assert.doesNotMatch(JSON.stringify(events), /Automatic heating paused|No scheduled end|synthetic-unknown|xxxx/);
  assert.equal(presentGeneral('heating-pause-changed', { pause: { expiresAt: null } }).details.find(row => row.label === 'Resume at').value, 'No scheduled end');
});

test('unsupported prototype property names remain neutral public explanations', () => {
  for (const value of ['constructor', '__proto__', 'toString']) {
    const rows = [presentGeneral(value, {}), presentGeneral('heating-phase-changed', { phase: value, reasons: [value], reason: value }),
      presentGeneral('charging-control-changed', { action: value, priority: value }), presentGeneral('garage-intent', { selection: { mode: value } }),
      presentCharging({ namespace: 'charging:mqtt:session-diagnostics', charger_id: 'charger1', report_id: 'a'.repeat(64) }, { code: value, kind: 'finding', source: value })];
    assert.doesNotMatch(JSON.stringify(rows), /native code|function Object|function toString|__proto__/);
  }
  const bad = { toString: 'private-value', valueOf: 'private-value' };
  assert.doesNotThrow(() => presentGeneral('occupancy-changed', { occupancy: { returnAt: bad } }));
  assert.doesNotThrow(() => presentGeneral('garage-native-setting-requested', { setting: bad }));
  assert.doesNotThrow(() => presentGeneral('charging-control-changed', { changes: { readyBy: bad } }));
});

test('heat-pump native fields retain their current labels, units and valid zero', () => {
  for (const [index, label, value, display] of [['0203', 'ROOM temperature', 20, '20 °C'], ['0208', 'Hot-water stop temperature', 55, '55 °C'],
    ['0212', 'Hot-water start temperature', 45, '45 °C'], ['2201', 'Operating mode', 0, '0']]) {
    const record = presentGeneral('h66-native-setting-confirmed', { register: index, value, previousValue: 0, dispatchedAt: NOW - 2000, receivedAt: NOW - 1000 });
    assert.deepEqual(record.details.find(row => row.label === 'Setting'), { label: 'Setting', value: label });
    assert.deepEqual(record.details.find(row => row.label === 'Confirmed value'), { label: 'Confirmed value', value: display });
    assert.equal(record.details.find(row => row.label === 'Previous value').value, index === '2201' ? '0' : '0 °C');
    assert.equal(record.details.find(row => row.label === 'Original dispatch').value, new Date(NOW - 2000).toISOString());
    assert.equal(record.details.find(row => row.label === 'Native report received').value, new Date(NOW - 1000).toISOString());
    assert.equal(record.details.find(row => row.label === 'Source measurement clock').value, 'Not recorded');
  }
  const several = presentGeneral('h66-settings-confirmed', { registers: ['0203', '0212', 'private-unknown'] });
  assert.equal(several.details.find(row => row.label === 'Confirmed settings').value, 'ROOM temperature, Hot-water start temperature');
  assert.doesNotMatch(JSON.stringify(several), /private-unknown/);
});

test('Garage one-shot settings identify the exact current allowlisted choice', () => {
  for (const [setting, value, title, shown] of [['power', 'off', 'Power', 'Off'], ['mode', 'heat', 'Operating mode', 'Heating'],
    ['targetC', 20.5, 'Temperature target', '20.5 °C'], ['fan', 2, 'Fan speed', 'Speed 2'], ['vane', 'swing', 'Vertical vane', 'Swing'], ['wideVane', 'far-left', 'Horizontal vane', 'Far left']]) {
    const record = presentGeneral('garage-native-setting-requested', { setting, value });
    assert.equal(record.title, `Garage · ${title} requested`);
    assert.equal(record.details.find(row => row.label === 'Requested value').value, shown);
  }
  assert.doesNotMatch(JSON.stringify(presentGeneral('garage-native-setting-requested', { setting: 'mode', value: 'synthetic-private-error' })), /synthetic-private/);
});

test('firewood and selected sensor source/recovery references remain distinct immutable timeline entries', t => {
  const { store, read } = fixture(t);
  store.write(() => {
    store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','synthetic-wood',?,'load',4)").run(NOW - 1000);
    const original = store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload)
      VALUES('original','mqtt','synthetic-sensor','context',?,?,?)`).run(NOW - 3000, LEARNING_ALGORITHM, JSON.stringify({ value: { sensorChange: { signal: 'bedroom_temperature', reason: 'moved', requestId: 'synthetic-private-request' } } }));
    const source = Number(original.lastInsertRowid);
    store.db.prepare("INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','synthetic-selected')").run();
    store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload,source_entry_id)
      VALUES('synthetic-selected','mqtt','synthetic-recovered','context',?,?,NULL,?)`).run(NOW - 2000, LEARNING_ALGORITHM, source);
  });
  const events = read().events;
  assert.deepEqual(events.map(row => row.title), ['Firewood added', 'Sensor change recorded']);
  assert.equal(events[1].details.find(row => row.label === 'Sensor').value, 'Bedroom temperature');
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private-request/);
});

test('query rejects retired fields, duplicate filters, malformed cursors and oversized membership', () => {
  for (const search of ['after=0', 'limit=0', 'limit=201', 'limit=01', 'area=all&area=home', 'view=raw', 'area=unknown', 'before=garbage',
    'visible=', 'visible=event:1', `visible=${id('event', 1)},${id('event', 1)}`, `visible=${Array.from({ length: 201 }, (_, n) => id('event', n + 1)).join(',')}`])
    assert.throws(() => query(search), { code: 'event_log_query_invalid' }, search);
});

test('sparse and charging source budgets are explicit rather than claiming complete history', t => {
  const { store, read } = fixture(t);
  store.write(() => {
    const insert = store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,summary,checkpoint)
      VALUES('charging:mqtt:session-diagnostics','charger1',?,'synthetic',?,'{}','{}')`);
    for (let n = 0; n < 33; n++) insert.run(n.toString(16).padStart(64, '0'), NOW - n * 1000);
  });
  assert.match(read('area=charging').coverage, /only part of some available source history/);
});

test('large charging histories inspect a fixed fair summary budget and retain only the requested page', t => {
  const { store } = fixture(t), namespace = 'charging:mqtt:session-diagnostics';
  store.write(() => {
    const report = store.db.prepare(`INSERT INTO charging_reports(namespace,charger_id,report_id,association,started_at,summary,checkpoint)
      VALUES(?,?,?,'synthetic',?,'{}','{}')`);
    const event = store.db.prepare(`INSERT INTO charging_report_events(namespace,charger_id,report_id,at,category,payload) VALUES(?,?,?,?,?,?)`);
    for (const charger of ['charger1', 'charger2']) for (let session = 0; session < 8; session++) {
      const reportId = `${charger === 'charger1' ? 'a' : 'b'}${session.toString(16).padStart(63, '0')}`;
      report.run(namespace, charger, reportId, NOW - session * 10000);
      for (const [category, kind] of [['findings', 'finding'], ['charging', 'physical'], ['vehicle', 'vehicle'], ['evidence', 'evidence']])
        for (let n = 0; n < 128; n++) event.run(namespace, charger, reportId, NOW - session * 10000 - 1000 + n, category,
          JSON.stringify({ kind, code: kind === 'physical' ? 'charging-observed' : kind === 'vehicle' ? 'identified' : 'control-unconfirmed', powerKw: 7 }));
    }
  });
  const work = {}, result = readEventLog({ db: store.db, input: 'mqtt', now: NOW, query: query('area=charging'), work });
  assert.equal(result.events.length, 40); assert.ok(work.maximumCandidates <= 41);
  assert.ok(work.chargingRows <= 2048); assert.ok(work.chargingRows > 0);
  assert.match(result.coverage, /only part/);
  assert.deepEqual(new Set(result.events.map(row => row.related.chargerId)), new Set(['charger1', 'charger2']));
  assert.deepEqual(result.events.map(row => row.at), result.events.map(row => row.at).sort((a, b) => b - a));
});

test('a long charging stream pages its fixed summary tail by occurrence time beyond two pages', t => {
  const { store, read } = fixture(t);
  for (let n = 0; n < 150; n++) chargingRecord(store, { at: NOW - 1000 - (n % 11) * 100, code: 'charging-started', powerKw: 7 });
  const expected = read('area=charging&limit=200').events, collected = [];
  let before;
  do {
    const page = read(`area=charging&limit=40${before ? `&before=${before}` : ''}`);
    collected.push(...page.events); before = page.nextBefore;
  } while (before);
  assert.equal(expected.length, 150); assert.deepEqual(collected, expected);
});

test('file worker pins the requested replica checkpoint, remains read-only and preserves original snapshot time', async t => {
  const { store } = fixture(t, { disk: true });
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 1000);
  const service = createEventLogService({ store }); t.after(() => service.close());
  const checkpoint = readCheckpoint(store.db);
  const args = { input: 'mqtt', now: NOW, checkedAt: NOW + 5000, scope: 'snapshot', snapshotAt: NOW, checkpoint, query: query('') };
  const result = await service.query(args);
  assert.equal(result.checkedAt, NOW + 5000); assert.equal(result.snapshotAt, NOW); assert.equal(result.scope, 'snapshot');
  assert.deepEqual(readCheckpoint(store.db), checkpoint);
  store.event('settings-reloaded', { input: 'mqtt' }, NOW);
  await assert.rejects(service.query(args), { code: 'event_log_checkpoint_advanced' });
});

test('a missing retained checkpoint boundary is unavailable rather than an advance retry hint', t => {
  const { store } = fixture(t);
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 1000); const checkpoint = readCheckpoint(store.db);
  store.event('settings-reloaded', { input: 'mqtt' }, NOW);
  const db = new Proxy(store.db, { get(target, property) {
    if (property === 'prepare') return sql => sql === 'SELECT hash FROM journal_commits WHERE sequence=?' ? { get: () => null } : target.prepare(sql);
    const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => readEventLog({ db, input: 'mqtt', now: NOW, checkpoint }), { code: 'event_log_unavailable' });
});

test('worker request settles only after its read transaction and final storage admission end', async t => {
  const { store } = fixture(t, { disk: true });
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 1000);
  const run = store.runStorageTask.bind(store); let settled = false, late = 0, active = 0;
  store.runStorageTask = (operation, options) => {
    if (settled) late++;
    return run(async () => { active++; try { return await operation(); } finally { active--; } }, options);
  };
  class UnleasedWorker extends Worker {
    constructor(url, options) { super(url, { ...options, workerData: { ...options.workerData, storageLeaseMs: 0 } }); }
  }
  const service = createEventLogService({ store, WorkerClass: UnleasedWorker }); t.after(() => service.close());
  const result = await service.query({ input: 'mqtt', now: NOW, query: query('') }); settled = true;
  assert.equal(result.events.length, 1); assert.equal(active, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(late, 0, 'No cleanup can request another Store turn after its owner receives completion');
});

test('closing an active worker joins its exit before its owner can release the read context', async t => {
  const { store } = fixture(t, { disk: true });
  let worker, exited = false, requested;
  const began = new Promise(resolve => { requested = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const run = store.runStorageTask.bind(store);
  store.runStorageTask = async (operation, options) => { requested(); await gate; return run(operation, options); };
  class ObservedWorker extends Worker {
    constructor(url, options) { super(url, options); worker = this; this.once('exit', () => { exited = true; }); }
  }
  const service = createEventLogService({ store, WorkerClass: ObservedWorker });
  const pending = service.query({ input: 'mqtt', now: NOW, query: query('') });
  const rejected = assert.rejects(pending, error => { assert.equal(exited, true); return error.code === 'event_log_unavailable'; });
  await began; assert(worker); const closing = service.close(); release(); await closing; await rejected;
});

test('cancelling the last file reader waits for rollback and reuses the healthy worker for the next read', async t => {
  const { store } = fixture(t, { disk: true });
  // The production HTTP socket keeps its request alive; this direct worker
  // fixture has no socket while waiting for its deliberately held SQL turn.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 1000);
  let calls = 0, workers = 0, completed = false, cancelledSettled = false, running = 0, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
  const run = store.runStorageTask.bind(store);
  store.runStorageTask = (operation, options) => run(async () => {
    running++;
    try { if (++calls === 10) { entered(); await gate; } return await operation(); }
    finally { running--; }
  }, options);
  class ObservedWorker extends Worker {
    constructor(url, options) {
      super(url, { ...options, workerData: { ...options.workerData, storageLeaseMs: 0 } }); workers++;
      this.on('message', message => { if (message.error || message.result) completed = true; });
    }
  }
  const service = createEventLogService({ store, WorkerClass: ObservedWorker }); t.after(() => service.close());
  const controller = new AbortController(), args = { input: 'mqtt', now: NOW, query: query('') };
  const pending = service.query(args, { signal: controller.signal }).finally(() => { cancelledSettled = true; });
  const checked = assert.rejects(pending, error => {
    assert.equal(completed, true); assert.equal(running, 0); return error.name === 'AbortError';
  });
  try {
    await began; controller.abort(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cancelledSettled, false);
  } finally { release(); }
  await checked;
  const next = await service.query(args);
  assert.equal(next.events.length, 1); assert.equal(workers, 1); assert.equal(running, 0);
});

test('current HTTP envelope is authenticated for admin and family and never exposes raw payloads', async t => {
  const { store } = fixture(t);
  store.event('controller-error', { message: 'synthetic-secret-message' }, NOW - 1000);
  const server = createAppServer({ store, engine: { config: { input: 'mqtt' }, clock: () => NOW }, token: 'synthetic-admin', familyToken: 'synthetic-family',
    chartService: { overview: async () => ({}), close: async () => {} }, clock: () => NOW });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = (token, search = '') => fetch(`http://127.0.0.1:${server.address().port}/api/events${search}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get()).status, 401);
  for (const token of ['synthetic-admin', 'synthetic-family']) {
    const response = await get(token); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.events[0].title, 'Controller update failed');
    assert.doesNotMatch(JSON.stringify(body), /synthetic-secret-message|payload/);
    assert.equal((await get(token, '?after=0')).status, 400);
  }
});

for (const cancellation of ['revoked access', 'closed socket']) test(`queued replica retry stops after ${cancellation}`, async t => {
  const { store } = fixture(t, { disk: true });
  store.event('settings-reloaded', { input: 'mqtt' }, NOW - 1000);
  let access = { enabled: true, token: 'synthetic-admin', familyToken: '' }, contexts = 0, releases = 0;
  let entered, openGate, released;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { openGate = resolve; });
  const releaseSeen = new Promise(resolve => { released = resolve; });
  const server = createAppServer({ store, token: 'synthetic-admin', getAccess: () => access, clock: () => NOW,
    getReadContext: async () => {
      contexts++;
      const reader = new Store(store.path, { readOnly: true }); reader.db.exec('BEGIN'); reader.expectedCheckpoint = readCheckpoint(reader.db);
      const run = reader.runStorageTask.bind(reader);
      reader.runStorageTask = async (...args) => { entered(); await gate; return run(...args); };
      return { store: reader, engine: { config: { input: 'mqtt' }, clock: () => NOW }, release() {
        releases++; reader.db.exec('ROLLBACK'); reader.close(); released();
      } };
    }, chartService: { overview: async () => ({}), close: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/events`, { headers: { authorization: 'Bearer synthetic-admin' }, signal: controller.signal });
  const checked = cancellation === 'closed socket' ? assert.rejects(request, { name: 'AbortError' }) : request;
  try {
    await waiting; store.event('settings-reloaded', { input: 'mqtt' }, NOW);
    if (cancellation === 'closed socket') controller.abort();
    else access = { ...access, token: 'synthetic-rotated-admin' };
    openGate();
    const response = await checked;
    if (cancellation === 'revoked access') assert.equal(response.status, 401);
    await releaseSeen;
    assert.equal(contexts, 1); assert.equal(releases, 1);
  } finally { openGate(); await request.catch(() => {}); }
});
