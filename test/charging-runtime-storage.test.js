import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { Store } from '../src/storage/store.js';
import { encodeChange } from '../src/storage/journal-codec.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';
import { sharedChargingAssessment } from '../src/charging/shared-assessment.js';
import { fixture as jointFixture } from './helpers/charging-joint-fixture.js';

const key = 'charging:simulated', at = 1_800_000_000_000;
const plan = () => ({ id: 'synthetic-accepted-plan', at, deadlineAt: at + 86_400_000,
  targetAt: at + 86_400_000, periods: [{ startAt: at + 3600_000, endAt: at + 7200_000 }],
  allocations: [{ start: at, end: at + 3600_000, targetA: 16 }],
  intervals: Array.from({ length: 60 }, (_, i) => ({ start: at + i * 900_000, end: at + (i + 1) * 900_000,
    priceCtPerKwh: i % 10, powerKw: 11, scenarios: Array.from({ length: 24 }, (_, j) => ({
      source: `synthetic-scenario-${j}`, phaseCurrentA: [j / 3, j / 4, j / 5], weight: 1 / 24,
      reference: 'synthetic bounded planning context',
    })), reference: { method: 'synthetic-reference', oldestAt: at - 86_400_000, newestAt: at } })) });
function fixture() {
  const accepted = plan();
  return { version: 7, revision: 3, controls: { association: 'a'.repeat(64), priority: 'charger1', revision: 2 },
    chargers: { charger1: { association: 'b'.repeat(64), controls: { enabled: false, revision: 1 },
      supplyEstimate: { observedAt: at, voltageV: 230 }, plan: accepted, request: null },
    charger2: { association: 'c'.repeat(64), controls: { enabled: false, revision: 1 }, plan: null } },
    vehicleFeeds: {}, consumedTeslaPower: { association: 'synthetic-vehicle', receivedAt: at }, consumedTeslaCurrent: null,
    view: { settings: { synthetic: true }, reportRetentionDays: 30, chargers: [
      { id: 'charger1', plan: structuredClone(accepted), values: { powerKw: { value: 0, measuredAt: at, receivedAt: at } },
        telemetry: { readAt: at }, control: { phase: 'off' } },
      { id: 'charger2', plan: null, values: {}, telemetry: { readAt: at } },
    ] } };
}
const rows = store => store.db.prepare('SELECT key,value,updated_at FROM state ORDER BY key').all();
const rawReader = db => ({ db, getState: key => { const row = db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; } });
function disk(t) {
  const directory = mkdtempSync(join(tmpdir(), 'charging-runtime-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'state.sqlite');
}

test('charging plans and scenario context are single referenced records with lossless current-format restart', t => {
  const path = disk(t), store = new Store(path), saved = fixture();
  writeChargingRuntime(store, key, saved);
  assert.deepEqual(readChargingRuntime(store, key), saved);
  const manifest = store.getState(key);
  assert.equal(manifest.plans.length, 1);
  assert.equal(manifest.contexts.length, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
  const compact = store.getState(`${key}:runtime:plan/${manifest.plans[0]}`);
  assert.equal(compact.value.intervals[0].scenarios, undefined);
  assert.equal(compact.value.intervals[0].reference, undefined);
  store.close();
  const restarted = new Store(path);
  try { assert.deepEqual(readChargingRuntime(restarted, key), saved); }
  finally { restarted.close(); }
});

test('fresh evidence clocks leave plan/context rows untouched and reduce actual journal payload by at least 95.5 percent', t => {
  const store = new Store(':memory:');
  try {
    let saved = fixture(); writeChargingRuntime(store, key, saved);
    const baselinePlanRows = rows(store).filter(row => /runtime:(?:plan|context)\//.test(row.key));
    const sequence = store.checkpoint().sequence;
    let aggregateBytes = 0;
    for (let tick = 1; tick <= 80; tick++) {
      const next = structuredClone(saved);
      next.chargers.charger1.supplyEstimate.observedAt = at + tick * 1000;
      next.view.chargers[0].values.powerKw.receivedAt = at + tick * 1000;
      next.view.chargers[0].telemetry.readAt = at + tick * 1000;
      next.view.chargers[1].telemetry.readAt = at + tick * 1000;
      aggregateBytes += Buffer.byteLength(JSON.stringify(encodeChange('state', [key],
        { key, value: JSON.stringify(saved), updated_at: at + (tick - 1) * 1000 },
        { key, value: JSON.stringify(next), updated_at: at + tick * 1000 })));
      writeChargingRuntime(store, key, next); saved = next;
    }
    const changes = store.db.prepare('SELECT table_name,record_key,payload FROM journal_changes WHERE sequence>?').all(sequence);
    const actualBytes = changes.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
    t.diagnostic(JSON.stringify({ actualJournalBytes: actualBytes, aggregateJournalBytes: aggregateBytes, reductionPercent: 100 * (1 - actualBytes / aggregateBytes) }));
    assert.ok(actualBytes / aggregateBytes < .045, JSON.stringify({ actualBytes, aggregateBytes }));
    assert.equal(changes.length, 80 * 4, 'Only the four changed evidence fields are journaled');
    assert.ok(changes.every(row => row.table_name === 'state' && !/runtime:(?:plan|context)\//.test(row.record_key)));
    assert.deepEqual(rows(store).filter(row => /runtime:(?:plan|context)\//.test(row.key)), baselinePlanRows);
    assert.deepEqual(readChargingRuntime(store, key), saved);
  } finally { store.close(); }
});

test('runtime fragments, immutable context replacement and garbage collection roll back together', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved);
    const original = rows(store), checkpoint = store.checkpoint(), next = structuredClone(saved);
    next.chargers.charger1.plan.intervals[0].scenarios[0].weight = .5;
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    next.chargers.charger1.controls.enabled = true;
    const set = store.setState.bind(store);
    store.setState = (rowKey, value) => { if (rowKey === key) throw new Error('synthetic final save failure'); return set(rowKey, value); };
    assert.throws(() => writeChargingRuntime(store, key, next), /synthetic final save failure/);
    assert.deepEqual(rows(store), original);
    assert.deepEqual(store.checkpoint(), checkpoint);
    assert.deepEqual(readChargingRuntime(store, key), saved);
    store.setState = set;
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(store, key), next);
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:context/*'").get().n, 1);
  } finally { store.close(); }
});

test('an enclosing failed commit cannot publish new fragments or delete the prior plan', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved);
    const original = rows(store), next = structuredClone(saved);
    next.chargers.charger1.plan.id = 'replacement';
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    const exec = store.db.exec.bind(store.db);
    store.db.exec = sql => { if (sql === 'COMMIT') throw new Error('synthetic commit failure'); return exec(sql); };
    assert.throws(() => store.transaction(() => writeChargingRuntime(store, key, next)), /synthetic commit failure/);
    store.db.exec = exec;
    assert.deepEqual(rows(store), original);
    assert.deepEqual(readChargingRuntime(store, key), saved);
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(store, key), next);
  } finally { store.close(); }
});

test('dated charging views consolidate receipt clocks while every durable energy fragment commits immediately', t => {
  const store = new Store(':memory:'), unbatched = new Store(':memory:');
  try {
    const saved = fixture();
    saved.chargers.charger1.progress = { version: 2, reference: null, connected: false, creditKwh: 0 };
    writeChargingRuntime(store, key, saved, { at });
    writeChargingRuntime(unbatched, key, saved, { at, viewIntervalMs: 0 });
    const sequence = store.checkpoint().sequence, unbatchedSequence = unbatched.checkpoint().sequence;
    for (let tick = 1; tick <= 29; tick++) {
      saved.chargers.charger1.progress.creditKwh = tick / 100;
      saved.chargers.charger1.supplyEstimate.observedAt = at + tick * 1000;
      saved.view.chargers[0].progress = { creditedGridKwh: tick / 100 };
      saved.view.chargers[0].values.powerKw.receivedAt = at + tick * 1000;
      saved.view.chargers[0].telemetry.readAt = at + tick * 1000;
      saved.view.chargers[1].telemetry.readAt = at + tick * 1000;
      writeChargingRuntime(store, key, saved, { at: at + tick * 1000 });
      writeChargingRuntime(unbatched, key, saved, { at: at + tick * 1000, viewIntervalMs: 0 });
      const committed = readChargingRuntime(store, key);
      assert.deepEqual(committed.chargers, saved.chargers, 'Energy, anchor and supply persistence is never cadence-limited');
      assert.equal(committed.view.recordedAt, at);
      assert.equal(committed.view.chargers[0].values.powerKw.receivedAt, at);
    }
    const changes = store.db.prepare('SELECT record_key,payload FROM journal_changes WHERE sequence>?').all(sequence);
    const baseline = unbatched.db.prepare('SELECT record_key,payload FROM journal_changes WHERE sequence>?').all(unbatchedSequence);
    const bytes = changes.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
    const baselineBytes = baseline.reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0);
    assert.ok(changes.length < baseline.length * .3, 'At least 70% fewer actual journal row effects in this controlled window');
    assert.ok(bytes < baselineBytes * .4, 'At least 60% less actual journal payload in this controlled window');
    t.diagnostic(JSON.stringify({ changedRows: changes.length, unbatchedChangedRows: baseline.length,
      journalBytes: bytes, unbatchedJournalBytes: baselineBytes }));
    assert.equal(changes.length, 29 * 2);
    assert.ok(changes.every(row => !row.record_key.includes(':runtime:view/')),
      'No view fragments are journaled during unchanged receipt-clock/progress churn');
    writeChargingRuntime(store, key, saved, { at: at + 30_000 });
    assert.deepEqual(readChargingRuntime(store, key).view, { ...saved.view, recordedAt: at + 30_000 },
      'The deadline publishes the newest whole candidate, including unchanged fields');
  } finally { store.close(); unbatched.close(); }
});

test('production Shelly card metering waits for cadence while physical confirmation and native permission publish immediately', async t => {
  const live = await jointFixture(t), store = new Store(':memory:');
  t.after(() => store.close());
  await live.connect('charger2');
  const saved = readChargingRuntime(live.store, live.runtime.key);
  saved.view.chargers[1] = JSON.parse(JSON.stringify(live.view('charger2')));
  const projectedAt = live.now;
  writeChargingRuntime(store, key, saved, { at: projectedAt });
  const card = saved.view.chargers[1];
  assert.ok(card.control.snapshot.fields.phase_info.value.phase_a, 'Exercise the actual native nested metering representation');
  const phase = structuredClone(card.control.snapshot.fields.phase_info.value);
  phase.total_power += .03; phase.phase_a.current += .1; phase.phase_a.power += .03;
  live.advance(5000);
  assert.equal(live.runtime.chargers.charger2.adapter.accept('phase_info', {
    value: phase, last_update_ts: live.now / 1000 }), true);
  assert.equal(saved.chargers.charger2.progress.version, 2);
  saved.chargers.charger2.progress.creditKwh += .02;
  saved.view.chargers[1] = JSON.parse(JSON.stringify(live.view('charger2')));
  writeChargingRuntime(store, key, saved, { at: live.now });
  assert.equal(readChargingRuntime(store, key).chargers.charger2.progress.creditKwh,
    saved.chargers.charger2.progress.creditKwh, 'Durable progress can advance alongside the deferred production card');
  assert.equal(readChargingRuntime(store, key).view.recordedAt, projectedAt,
    'A changed meter receipt does not rewrite the complete projection');
  assert.equal(readChargingRuntime(store, key).view.chargers[1].control.snapshot.fields.phase_info.value.total_power,
    card.control.snapshot.fields.phase_info.value.total_power);
  // Status flags are physical assessments, independent of raw metering values.
  saved.view.chargers[1].control.pauseConfirmed = !card.control.pauseConfirmed;
  writeChargingRuntime(store, key, saved, { at: live.now + 1000 });
  assert.equal(readChargingRuntime(store, key).view.recordedAt, live.now + 1000);
  saved.view.chargers[1].control.snapshot.fields.start_charging.value = false;
  writeChargingRuntime(store, key, saved, { at: live.now + 2000 });
  assert.equal(readChargingRuntime(store, key).view.recordedAt, live.now + 2000);
  saved.view.chargers[1].control.currentAdjustment.stage = 'physical-response-pending';
  writeChargingRuntime(store, key, saved, { at: live.now + 3000 });
  assert.equal(readChargingRuntime(store, key).view.recordedAt, live.now + 3000);
});

test('production OCPP metering and vehicle reception clocks wait for a complete dated view without delaying durable state', async t => {
  const live = await jointFixture(t);
  await live.connect('charger1');
  live.runtime.persist();
  const saved = readChargingRuntime(live.store, live.runtime.key), projectedAt = live.now;
  // Vehicle assignment is independent of the cadence comparison. Use the
  // production reception object for the assigned-card representation too.
  saved.view.chargers[0].mqtt = structuredClone(saved.view.vehicleFeeds[0].reception);
  saved.view.chargers[0].vehicleMqtt = structuredClone(saved.view.vehicleFeeds[0].reception);
  saved.view.chargers[0].telemetry.supply.observedAt = projectedAt;
  saved.view.chargers[0].control.snapshot.supply.observedAt = projectedAt;
  const set = (next, path, value) => {
    const parts = path.split('.'), field = parts.pop();
    let owner = next.view;
    for (const part of parts) { assert.ok(owner?.[part] !== undefined, `Production parent exists: ${path}`); owner = owner[part]; }
    owner[field] = value;
  };
  const cases = [
    ['chargers.0.telemetry.powerAt', projectedAt + 5000],
    ['chargers.0.telemetry.powerReceivedAt', projectedAt + 5000],
    ['chargers.0.telemetry.statusReceivedAt', projectedAt + 5000],
    ['chargers.0.control.snapshot.powerReceivedAt', projectedAt + 5000],
    ['chargers.0.control.snapshot.statusReceivedAt', projectedAt + 5000],
    ['chargers.0.values.actualCurrentA.inputs.0.measuredAt', projectedAt + 5000],
    ['chargers.0.values.voltageV.inputs.0.measuredAt', projectedAt + 5000],
    ['chargers.0.telemetry.phaseCurrentA.inputs.0.measuredAt', projectedAt + 5000],
    ['chargers.0.telemetry.supply.observationTimes.charger.0', projectedAt + 5000],
    ['chargers.0.telemetry.supply.observationTimes.voltage.0', projectedAt + 5000],
    ['chargers.0.telemetry.supply.estimate.observedAt', projectedAt + 5000],
    ['chargers.0.telemetry.supply.observedAt', projectedAt + 5000],
    ['chargers.0.control.snapshot.supply.observedAt', projectedAt + 5000],
    ['chargers.0.control.snapshot.supply.propertyCurrentA.0', 2],
    ['chargers.0.control.snapshot.supply.chargerCurrentA.0', 2],
    ['chargers.0.control.snapshot.supply.voltageV.0', 231],
    ['chargers.0.telemetry.supply.propertyCurrentA.0', 2],
    ['chargers.0.mqtt.lastMessageAt', projectedAt + 5000],
    ['chargers.0.vehicleMqtt.lastValidLiveAt', projectedAt + 5000],
    ['vehicleFeeds.0.reception.lastMessageAt', projectedAt + 5000],
    ['vehicleFeeds.0.reception.lastRetainedAt', projectedAt + 5000],
    ['vehicleFeeds.0.reception.lastValidAt', projectedAt + 5000],
    ['vehicleFeeds.0.reception.lastValidLiveAt', projectedAt + 5000],
    ['chargers.1.values.connected.readback.requestedAt', projectedAt + 5000],
    ['chargers.1.telemetry.currentA.readback.requestedAt', projectedAt + 5000],
    ['chargers.1.telemetry.maximumCurrentA.measuredAt', projectedAt + 5000],
    ['chargers.1.values.maximumCurrentA.measuredAt', projectedAt + 5000],
  ];
  for (const [path, value] of cases) {
    const store = new Store(':memory:');
    try {
      writeChargingRuntime(store, key, saved, { at: projectedAt });
      const baseline = readChargingRuntime(store, key), sequence = store.checkpoint().sequence;
      const next = structuredClone(saved);
      set(next, path, value);
      next.chargers.charger1.progress.creditKwh += .01;
      writeChargingRuntime(store, key, next, { at: projectedAt + 5000 });
      const deferred = readChargingRuntime(store, key);
      assert.deepEqual(deferred.view, baseline.view, path);
      assert.deepEqual(deferred.chargers, next.chargers, `Durable state commits immediately: ${path}`);
      assert.equal(store.db.prepare("SELECT count(*) n FROM journal_changes WHERE sequence>? AND record_key LIKE '%:runtime:view/%'").get(sequence).n,
        0, `No view writes during metering/poll churn: ${path}`);
      writeChargingRuntime(store, key, next, { at: projectedAt + 30_000 });
      assert.deepEqual(readChargingRuntime(store, key).view, { ...next.view, recordedAt: projectedAt + 30_000 },
        `All original newest values and clocks publish together: ${path}`);
    } finally { store.close(); }
  }
});

test('production instruction clocks, metering provenance and feed health remain early-publication fences', async t => {
  const live = await jointFixture(t);
  await live.connect('charger1');
  live.runtime.persist();
  const saved = readChargingRuntime(live.store, live.runtime.key), projectedAt = live.now;
  saved.view.chargers[0].vehicleMqtt = structuredClone(saved.view.vehicleFeeds[0].reception);
  const cases = [
    next => { next.view.chargers[1].values.currentA.measuredAt += 1000; },
    next => { next.view.chargers[1].values.currentA.readback.measuredAt += 1000; },
    next => { next.view.chargers[1].telemetry.charging.measuredAt += 1000; },
    next => { next.view.chargers[1].control.snapshot.fields.start_charging.measuredAt += 1000; },
    next => { next.view.chargers[0].control.snapshot.statusAt += 1000; },
    next => { next.view.chargers[0].values.actualCurrentA.inputs[0].source = 'different-meter'; },
    next => { next.view.chargers[0].values.voltageV.quality = 'unavailable'; },
    next => { next.view.chargers[0].telemetry.supply.feedEvidence.property.epoch = 'different-connection'; },
    next => { next.view.chargers[0].telemetry.supply.provenance = { observedAt: projectedAt + 1000 }; },
    next => { next.view.chargers[0].telemetry.supply.estimate.available = !next.view.chargers[0].telemetry.supply.estimate.available; },
    next => { next.view.chargers[1].values.maximumCurrentA.value -= 1; },
    next => { next.view.chargers[0].vehicleMqtt.available = !next.view.chargers[0].vehicleMqtt.available; },
    next => { next.view.vehicleFeeds[0].reception.reason = 'vehicle-feed-stale'; },
    next => { next.view.chargers[0].control.identification = { powerReceivedAt: projectedAt + 1000 }; },
  ];
  for (const change of cases) {
    const store = new Store(':memory:');
    try {
      writeChargingRuntime(store, key, saved, { at: projectedAt });
      const next = structuredClone(saved); change(next);
      writeChargingRuntime(store, key, next, { at: projectedAt + 1000 });
      assert.deepEqual(readChargingRuntime(store, key).view, { ...next.view, recordedAt: projectedAt + 1000 });
    } finally { store.close(); }
  }
});

async function plannedProductionState(t) {
  const live = await jointFixture(t);
  await live.automatic('charger1', true); await live.automatic('charger2', true); await live.plan();
  await live.connect('charger1'); await live.connect('charger2'); await live.plan();
  live.runtime.persist();
  const saved = readChargingRuntime(live.store, live.runtime.key);
  assert.ok(saved.view.coordination?.proposed && saved.view.coordination?.adopted);
  assert.equal(saved.view.chargers[1].allowance.source, 'st-mq-load-balancing');
  assert.equal(saved.view.chargers[0].allowance.source, 'easee-equalizer');
  return { saved, projectedAt: live.now };
}

test('production calculation clock refreshes batch while original published clocks and durable progress survive restart', async t => {
  const { saved, projectedAt } = await plannedProductionState(t);
  const refreshes = [
    ['coordination', next => { next.view.coordination.at += 5000; }],
    ['proposed calculation', next => { next.view.coordination.proposed.at += 5000; }],
    ['adopted calculation', next => { next.view.coordination.adopted.at += 5000; }],
    ['controller allowance', next => { next.view.chargers[1].allowance.measuredAt += 5000;
      next.view.chargers[1].allowance.receivedAt += 5000; }],
  ];
  for (const [label, refresh] of refreshes) {
    const path = disk(t), store = new Store(path);
    let published;
    try {
      writeChargingRuntime(store, key, saved, { at: projectedAt });
      const before = readChargingRuntime(store, key), sequence = store.checkpoint().sequence;
      const next = structuredClone(saved); refresh(next);
      next.chargers.charger1.progress.creditKwh += .01;
      writeChargingRuntime(store, key, next, { at: projectedAt + 5000 });
      const deferred = readChargingRuntime(rawReader(store.db), key);
      assert.deepEqual(deferred.view, before.view, label);
      assert.deepEqual(deferred.chargers, next.chargers, `Durable progress remains immediate: ${label}`);
      assert.equal(store.db.prepare("SELECT count(*) n FROM journal_changes WHERE sequence>? AND record_key LIKE '%:runtime:view/%'").get(sequence).n,
        0, `No early view row effects for an unchanged calculation: ${label}`);
      writeChargingRuntime(store, key, next, { at: projectedAt + 30_000 });
      published = readChargingRuntime(store, key);
      assert.deepEqual(published.view, { ...next.view, recordedAt: projectedAt + 30_000 },
        `The complete payload preserves every original calculation and native clock: ${label}`);
    } finally { store.close(); }
    const restarted = new Store(path);
    try { assert.deepEqual(readChargingRuntime(restarted, key), published, `Current-format restart is lossless: ${label}`); }
    finally { restarted.close(); }
  }
});

test('calculation comparison exemptions retain production plan, allocation, provenance and native-clock fences', async t => {
  const { saved, projectedAt } = await plannedProductionState(t);
  const fences = [
    ['allocation boundary', next => { next.view.coordination.allocations[0].end += 1000; }],
    ['current limit', next => { next.view.coordination.currentLimits[0].currentA += 1; }],
    ['priority', next => { next.view.coordination.priority = 'charger2'; }],
    ['session', next => { next.view.coordination.sessions.charger1 += ':replacement'; }],
    ['request revision', next => { next.view.coordination.requests.charger1.revision += 1; }],
    ['proposed feasibility', next => { next.view.coordination.proposed.feasible = !next.view.coordination.proposed.feasible; }],
    ['adopted cost', next => { next.view.coordination.adopted.plans.charger1.costCents += 1; }],
    ['solver result', next => { next.view.coordination.proposed.solver.globalOptimalityProven = !next.view.coordination.proposed.solver.globalOptimalityProven; }],
    ['unknown nested clock', next => { next.view.coordination.proposed.solver.observedAt = projectedAt + 1000; }],
    ['allowance value', next => { next.view.chargers[1].allowance.allowanceA -= 1; }],
    ['allowance source epoch', next => { next.view.chargers[1].allowance.sourceEpoch = 'synthetic-replacement-epoch'; }],
    ['allowance availability', next => { next.view.chargers[1].allowance.mode = 'unknown'; }],
    ['native Equalizer source clock', next => { next.view.chargers[0].allowance.measuredAt += 1000; }],
    ['native current clock', next => { next.view.chargers[1].values.currentA.measuredAt += 1000; }],
    ['plan calculation clock', next => { next.chargers.charger1.plan.at += 1000; next.view.chargers[0].plan.at += 1000; }],
    ['plan interval boundary', next => { next.chargers.charger1.plan.intervals[0].start += 1000; next.view.chargers[0].plan.intervals[0].start += 1000; }],
  ];
  for (const [label, change] of fences) await t.test(label, () => {
    const store = new Store(':memory:');
    try {
      writeChargingRuntime(store, key, saved, { at: projectedAt });
      const next = structuredClone(saved);
      next.view.coordination.at += 1000;
      next.view.coordination.proposed.at += 1000;
      next.view.coordination.adopted.at += 1000;
      next.view.chargers[1].allowance.measuredAt += 1000;
      change(next);
      writeChargingRuntime(store, key, next, { at: projectedAt + 1000 });
      assert.deepEqual(readChargingRuntime(store, key).view, { ...next.view, recordedAt: projectedAt + 1000 }, label);
    } finally { store.close(); }
  });
});

test('a batched calculation refresh supplies no new freshness to a saved native execution assessment', async t => {
  const { saved, projectedAt } = await plannedProductionState(t), store = new Store(':memory:');
  try {
    writeChargingRuntime(store, key, saved, { at: projectedAt });
    const before = readChargingRuntime(store, key), next = structuredClone(saved);
    next.view.coordination.at = projectedAt + 20_000;
    next.view.coordination.adopted.at = projectedAt + 20_000;
    next.view.chargers[1].allowance.measuredAt = projectedAt + 20_000;
    writeChargingRuntime(store, key, next, { at: projectedAt + 20_000 });
    const persisted = readChargingRuntime(store, key);
    assert.deepEqual(persisted.view, before.view);
    const assessment = sharedChargingAssessment(persisted.view.chargers, persisted.view.coordination, projectedAt + 20_000);
    assert.equal(assessment.execution.expectedCurrentA, null, 'An old live-limiter assessment remains unknown after its freshness deadline');
    assert.equal(persisted.view.chargers[1].control.limiter.evaluatedAt, before.view.chargers[1].control.limiter.evaluatedAt);
    assert.equal(persisted.view.coordination.at, before.view.coordination.at);
  } finally { store.close(); }
});

for (const change of ['controls', 'session', 'plan', 'target', 'pending', 'fault', 'epoch', 'availability'])
  test(`a ${change} boundary publishes a complete dated charging view before its cadence`, () => {
    const store = new Store(':memory:');
    try {
      const saved = fixture(); writeChargingRuntime(store, key, saved, { at });
      const next = structuredClone(saved), card = next.view.chargers[0];
      next.view.chargers[1].telemetry.readAt = at + 1000;
      if (change === 'controls') next.chargers.charger1.controls.enabled = true;
      if (change === 'session') next.chargers.charger1.association = 'd'.repeat(64);
      if (change === 'plan') next.chargers.charger1.plan.periods[0].startAt += 60_000;
      if (change === 'target') card.values.minimumSoc = { value: 90, source: 'session-request', available: true };
      if (change === 'pending') card.control.pending = { role: 'start_charging', value: false, dispatchedAt: at + 1000 };
      if (change === 'fault') card.control.errorCode = 'native-fault';
      if (change === 'epoch') card.control.snapshot = { online: true, generation: 2 };
      if (change === 'availability') card.values.powerKw.available = false;
      writeChargingRuntime(store, key, next, { at: at + 1000 });
      assert.deepEqual(readChargingRuntime(store, key), { ...next, view: { ...next.view, recordedAt: at + 1000 } });
    } finally { store.close(); }
  });

test('outer and nested rollback retain the view cadence and retry the complete semantic boundary', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved, { at });
    const next = structuredClone(saved); next.chargers.charger1.controls.enabled = true;
    const original = rows(store);
    assert.throws(() => store.transaction(() => {
      writeChargingRuntime(store, key, next, { at: at + 1000 });
      throw new Error('synthetic outer failure');
    }), /synthetic outer failure/);
    assert.deepEqual(rows(store), original);
    store.transaction(() => {
      assert.throws(() => store.transaction(() => {
        writeChargingRuntime(store, key, next, { at: at + 2000 });
        throw new Error('synthetic nested failure');
      }), /synthetic nested failure/);
      assert.deepEqual(rows(store), original);
    });
    writeChargingRuntime(store, key, next, { at: at + 3000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 3000);
    const ordinary = structuredClone(next);
    ordinary.view.chargers[0].telemetry.readAt = at + 4000;
    writeChargingRuntime(store, key, ordinary, { at: at + 4000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 3000);
  } finally { store.close(); }
});

test('a deferred view keeps its immutable plan/context references until a complete replacement is committed', () => {
  const store = new Store(':memory:');
  try {
    const saved = fixture(); writeChargingRuntime(store, key, saved, { at });
    const original = store.getState(key);
    saved.view.chargers[0].telemetry.readAt = at + 1000;
    writeChargingRuntime(store, key, saved, { at: at + 1000 });
    assert.deepEqual(store.getState(key).plans, original.plans);
    assert.deepEqual(store.getState(key).contexts, original.contexts);
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at);
    saved.chargers.charger1.plan.intervals[0].scenarios[0].weight = .5;
    saved.view.chargers[0].plan = structuredClone(saved.chargers.charger1.plan);
    writeChargingRuntime(store, key, saved, { at: at + 2000 });
    assert.deepEqual(readChargingRuntime(store, key), { ...saved, view: { ...saved.view, recordedAt: at + 2000 } });
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:context/*'").get().n, 1);
    saved.view.chargers[1].telemetry.readAt = at + 3000;
    writeChargingRuntime(store, key, saved, { at: at + 3000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 2000);
  } finally { store.close(); }
});

test('restart publishes a new complete view; an explicit final view flush saves latest presentation', t => {
  const path = disk(t), saved = fixture(), store = new Store(path);
  writeChargingRuntime(store, key, saved, { at }); store.close();
  const restarted = new Store(path);
  try {
    saved.view.chargers[0].telemetry.readAt = at + 1000;
    writeChargingRuntime(restarted, key, saved, { at: at + 1000 });
    assert.equal(readChargingRuntime(restarted, key).view.recordedAt, at + 1000);
    saved.view.chargers[0].telemetry.readAt = at + 2000;
    writeChargingRuntime(restarted, key, saved, { at: at + 2000 });
    assert.equal(readChargingRuntime(restarted, key).view.recordedAt, at + 1000);
    writeChargingRuntime(restarted, key, saved, { at: at + 2000, forceView: true });
    assert.deepEqual(readChargingRuntime(restarted, key).view, { ...saved.view, recordedAt: at + 2000 });
  } finally { restarted.close(); }
});

for (const recordedAt of [null, -1, .5, '2026-10-13', Infinity])
  test(`invalid projection date ${recordedAt} rejects before changing storage`, () => {
    const store = new Store(':memory:');
    try {
      const saved = fixture(); writeChargingRuntime(store, key, saved);
      const original = rows(store), checkpoint = store.checkpoint();
      saved.view.recordedAt = recordedAt;
      assert.throws(() => writeChargingRuntime(store, key, saved, { at }), /Unsupported or incomplete charging state/);
      assert.deepEqual(rows(store), original); assert.deepEqual(store.checkpoint(), checkpoint);
    } finally { store.close(); }
  });

test('a read-only charging store rejects an explicit final view flush without changing bytes', t => {
  const path = disk(t), saved = fixture(), store = new Store(path);
  writeChargingRuntime(store, key, saved, { at }); store.close();
  const reader = new Store(path, { readOnly: true });
  try {
    const original = rows(reader);
    assert.throws(() => writeChargingRuntime(reader, key, saved, { at: at + 1000, forceView: true }), /read-only/);
    assert.deepEqual(rows(reader), original);
  } finally { reader.close(); }
});

test('a pinned reader keeps a complete old plan while current publication replaces and removes its rows', t => {
  const path = disk(t), store = new Store(path), saved = fixture();
  writeChargingRuntime(store, key, saved);
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec('BEGIN'); assert.deepEqual(readChargingRuntime(rawReader(reader), key), saved);
    const next = structuredClone(saved);
    next.chargers.charger1.plan.periods[0].startAt += 60_000;
    next.view.chargers[0].plan = structuredClone(next.chargers.charger1.plan);
    next.chargers.charger1.controls.enabled = true;
    writeChargingRuntime(store, key, next);
    assert.deepEqual(readChargingRuntime(rawReader(reader), key), saved);
    reader.exec('COMMIT');
    assert.deepEqual(readChargingRuntime(rawReader(reader), key), next);
  } finally { reader.close(); store.close(); }
});

for (const damage of ['missing-field', 'missing-plan', 'damaged-context', 'orphan', 'missing-root', 'old-aggregate', 'projection-date'])
  test(`startup rejects ${damage} on an inactive input without modifying the database`, t => {
    const path = disk(t), store = new Store(path), saved = fixture();
    writeChargingRuntime(store, key, saved);
    const manifest = store.getState(key);
    if (damage === 'missing-field') store.db.prepare('DELETE FROM state WHERE key=?').run(`${key}:runtime:charger/charger1/controls`);
    if (damage === 'missing-plan') store.db.prepare('DELETE FROM state WHERE key=?').run(`${key}:runtime:plan/${manifest.plans[0]}`);
    if (damage === 'damaged-context') store.setState(`${key}:runtime:context/${manifest.contexts[0]}`, []);
    if (damage === 'orphan') store.setState(`${key}:runtime:root/unknown`, { value: true });
    if (damage === 'missing-root') store.db.prepare('DELETE FROM state WHERE key=?').run(key);
    if (damage === 'old-aggregate') store.setState(key, { ...saved, version: 6 });
    if (damage === 'projection-date') {
      saved.view.recordedAt = at; writeChargingRuntime(store, key, saved);
      store.setState(`${key}:runtime:view/recordedAt`, { value: -1 });
    }
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    store.close();
    const before = readFileSync(path);
    assert.throws(() => new Store(path), { code: 'database_state_incompatible' });
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
  });


test('runtime publication failure restores report observers and allowance coverage before retry', async () => {
  const store = new Store(':memory:');
  const runtime = new ChargingRuntime({ engine: {}, store, config: { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-charger' } } }, clock: () => at });
  try {
    const diagnostics = structuredClone(runtime.sessionDiagnostics.state);
    const assessment = structuredClone(runtime.physicalTests.state);
    const set = store.setState.bind(store);
    store.setState = (rowKey, value) => { if (rowKey === runtime.key) throw new Error('synthetic publication failure'); return set(rowKey, value); };
    assert.throws(() => runtime.persistAcceptedState(at), /synthetic publication failure/);
    assert.deepEqual(runtime.sessionDiagnostics.state, diagnostics);
    assert.deepEqual(runtime.physicalTests.state, assessment);
    assert.equal(runtime.sessionDiagnostics.lastSavedAt, 0);
    assert.equal(runtime.sessionDiagnostics.lastPrunedAt, 0);
    assert.equal(runtime.limiterHistory.previous.size, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM observations').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) n FROM recorder_coverage').get().n, 0);
    store.setState = set;
    runtime.persistAcceptedState(at);
    assert.equal(runtime.limiterHistory.previous.size, 1);
    for (const previous of runtime.limiterHistory.previous.values()) {
      assert.ok(store.db.prepare('SELECT 1 FROM observations WHERE id=?').get(previous.id));
      assert.ok(store.db.prepare('SELECT 1 FROM recorder_coverage WHERE id=?').get(previous.coverageId));
    }
    assert.equal(readChargingRuntime(store, runtime.key).version, 7);
  } finally { await runtime.close(); store.close(); }
});
