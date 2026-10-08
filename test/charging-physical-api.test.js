import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';
import { webRequestAllowed } from '../chart/web-access.js';
import { chargingTestLocalTime, parseChargingTestTime } from '../chart/charging-test-time.js';

function fixture(t, vehicleId = 'tesla') {
  const directory = mkdtempSync(join(tmpdir(), 'charging-physical-api-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-09-30T17:00:00Z'), connected = false, connectedAt = null, primary = true;
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory),
    input: 'mqtt', deviceId: null, connections: { mqtt: { address: 'mqtt://example.invalid' } } };
  const engine = new Engine({ store, config, clock: () => now });
  const runtime = engine.charging, item = runtime.chargers.charger1;
  runtime.canControl = () => primary;
  const reading = value => ({ value, available: true, measuredAt: now, source: 'easee' });
  item.adapter = { normalize: () => ({ connected: reading(connected), charging: reading(false),
    powerKw: reading(0), voltageV: reading(230), maximumCurrentA: reading(16) }) };
  item.controller = { status: () => ({ session: { connected, connectedAt },
    snapshot: { online: true, readAt: now, controlReady: true, schedule: { enabled: 'none' } }, phase: 'off' }),
    async update() { throw new Error('Assessment must not operate the charger'); }, close() {} };
  item.controls.enabled = true; runtime.refreshSettings();
  runtime.teslaCapture = { snapshot: () => ({ connected: true, healthy: true, pluggedIn: false }), reception: () => ({ connected: true }) };
  Object.assign(runtime.vehicleFeeds.bmw.mqtt, { connected: true, subscribed: true, lastValidLiveAt: now });
  t.after(async () => { await runtime.close(); await engine.closeFireplace(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { engine, runtime, store, config, clock: () => now, input: { chargerId: 'charger1', vehicleId, program: 'immediate',
    association: item.association, soc: 30.25, nativeTargetSoc: 85, capacityKwh: 72.43, prepared: true },
  primary: () => primary, demote: () => { primary = false; }, plug: () => { now += 1000; connected = true; connectedAt = now; },
    unplug: () => { now += 1000; connected = false; connectedAt = null; } };
}

function production(runtime) {
  const status = runtime.status();
  return structuredClone({ settings: status.settings, chargers: status.chargers,
    vehicleFeeds: status.vehicleFeeds, revision: status.revision, coordination: status.coordination });
}

test('guided-test API uses real normalized charger readiness and keeps declarations out of production settings', async t => {
  const f = fixture(t), token = 'synthetic-physical-test-authorization';
  // Keep background household preparation out of the action comparison.
  // The numerical charging worker is settled after the synthetic connection.
  await f.runtime.historyService.close(); f.runtime.historyService = null;
  f.engine.status();
  const server = createAppServer({ engine: f.engine, store: f.store, token,
    controlAuthority: { canControl: f.primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (action, input, authorized = true) => fetch(`http://127.0.0.1:${server.address().port}/api/charging/tests/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input),
  });
  const before = structuredClone(f.runtime.settings);
  assert.equal((await post('start', f.input, false)).status, 401);
  for (const [changes, expected] of [
    [{ capacityKwh: 0 }, /capacity.*1.*300/i],
    [{ capacityKwh: '72.43' }, /capacity/i],
    [{ soc: -1 }, /battery.*0.*100/i],
    [{ nativeTargetSoc: 101 }, /target.*100/i],
    [{ prepared: false }, /verif|confirm/i],
    [{ chargerId: '' }, /charger/i],
    [{ arbitraryTarget: 67 }, /unsupported|unknown/i],
  ]) {
    const rejected = await post('start', { ...f.input, ...changes });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, expected);
    assert.equal(f.runtime.physicalTests.status().runs.length, 0);
    assert.deepEqual(f.runtime.settings, before);
  }
  const preview = await post('preview', f.input);
  assert.equal(preview.status, 200);
  const preparation = await preview.json();
  assert.equal(preparation.eligible, true, JSON.stringify(preparation.gates));
  assert.equal(f.runtime.physicalTests.status().runs.length, 0, 'Preview never arms a run');
  assert.equal((await post('start', { ...f.input, association: 'stale-screen' })).status, 400);
  const response = await post('start', f.input); assert.equal(response.status, 200);
  const armed = (await response.json()).charging.physicalTests.runs[0];
  assert.equal(armed.phase, 'armed');
  assert.equal(armed.expectations.capacityKwh, 72.43);
  assert.equal(armed.expectations.soc, 30.25);
  assert.deepEqual(f.runtime.settings, before);
  assert.equal(f.runtime.chargers.charger1.request, null);
  f.plug(); f.runtime.persist();
  await f.runtime.updatePlan();
  const view = f.runtime.status(), run = view.physicalTests.runs[0];
  assert.equal(run.phase, 'observing'); assert.ok(run.sessionId);
  assert.equal(view.chargers[0].values.soc.value, before.chargers.charger1.manualSoc);
  assert.notEqual(view.chargers[0].values.soc.value, f.input.soc);
  assert.equal(view.chargers[0].values.minimumSoc.value, before.chargers.charger1.minimumSoc);
  assert.notEqual(view.chargers[0].values.minimumSoc.value, f.input.nativeTargetSoc);
  assert.equal(view.chargers[0].values.capacityKwh.value, before.chargers.charger1.capacityKwh);
  assert.notEqual(view.chargers[0].values.capacityKwh.value, f.input.capacityKwh);
  assert.deepEqual(view.chargers[0].request.overrides, {});
  assert.notEqual(view.chargers[0].vehicle?.state, 'identified');
  assert.ok(view.diagnostics.chargers[0].current);
  const actual = production(f.runtime);
  const targetInput = { id: run.id, association: run.association, sessionId: run.sessionId,
    targetRevision: run.target.revision, nativeTargetSoc: 90 };
  const unseenReport = await post('target', { ...targetInput,
    verification: { reportedSoc: 100, source: 'teslamate' } });
  assert.equal(unseenReport.status, 400, 'A client cannot invent telemetry to acknowledge');
  assert.deepEqual(production(f.runtime), actual);
  assert.equal(f.runtime.physicalTests.status().runs[0].target.revision, run.target.revision);
  const targetResponse = await post('target', targetInput);
  assert.equal(targetResponse.status, 200);
  const assessed = (await targetResponse.json()).charging.physicalTests.runs[0];
  assert.equal(assessed.expectations.nativeTargetSoc, 90);
  assert.deepEqual(production(f.runtime), actual, 'Recording the assumed car target cannot alter any production knowledge');
  assert.equal((await post('target', { ...targetInput, nativeTargetSoc: 95 })).status, 400, 'Stale assessment revision is rejected');
  assert.equal((await post('cancel', { id: armed.id, association: f.input.association })).status, 200);
  assert.equal(f.runtime.physicalTests.status().runs[0].phase, 'cancelled');
  assert.deepEqual(f.runtime.settings, before);
  assert.deepEqual(production(f.runtime), actual, 'Ending the assessment leaves actual charging unchanged');
  f.demote();
  assert.equal((await post('preview', f.input)).status, 409);
});

for (const vehicleId of ['bmw', 'tesla']) test(`${vehicleId} guide assumptions survive restart without becoming production inputs or identity`, async t => {
  const f = fixture(t, vehicleId), before = production(f.runtime);
  f.runtime.chargingTestAction('preview', f.input);
  f.runtime.chargingTestAction('start', f.input);
  assert.deepEqual(production(f.runtime), before);
  f.plug(); f.runtime.persist();
  const actual = production(f.runtime), run = f.runtime.physicalTests.status().runs[0];
  assert.deepEqual(actual.chargers[0].request.overrides, {});
  const targetAction = { id: run.id, association: run.association, sessionId: run.sessionId,
    targetRevision: run.target.revision, nativeTargetSoc: 90 };
  f.runtime.chargingTestAction('target', targetAction);
  assert.deepEqual(production(f.runtime), actual);
  f.runtime.persist();

  const restarted = new ChargingRuntime({ engine: {}, store: f.store, config: f.config, clock: f.clock, canControl: f.primary });
  t.after(() => restarted.close());
  restarted.chargers.charger1.adapter = f.runtime.chargers.charger1.adapter;
  restarted.chargers.charger1.controller = f.runtime.chargers.charger1.controller;
  restarted.teslaCapture = f.runtime.teslaCapture;
  const restored = restarted.status(), current = restored.chargers[0];
  assert.equal(restored.physicalTests.runs[0].expectations.nativeTargetSoc, 90);
  assert.equal(restored.physicalTests.runs[0].expectations.soc, f.input.soc);
  assert.equal(restored.physicalTests.runs[0].expectations.capacityKwh, f.input.capacityKwh);
  assert.deepEqual(current.request, actual.chargers[0].request);
  for (const key of ['soc', 'minimumSoc', 'capacityKwh']) assert.deepEqual(current.values[key], actual.chargers[0].values[key]);
  assert.notEqual(current.vehicle.state, 'identified');
  assert.deepEqual(restarted.settings, f.runtime.settings);
  f.unplug(); restarted.persist();
  assert.equal(restarted.status().physicalTests.runs[0].phase, 'finished');
  f.plug(); restarted.persist();
  assert.deepEqual(restarted.status().chargers[0].request.overrides, {});
  assert.equal(restarted.status().physicalTests.runs[0].sessionId, run.sessionId);
});

test('failed assessment target save rolls back only its declaration and never changes production charging', async t => {
  const f = fixture(t);
  f.runtime.chargingTestAction('start', f.input);
  f.plug(); f.runtime.persist();
  const before = production(f.runtime), assessments = f.runtime.physicalTests.status(), run = assessments.runs[0];
  const setState = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key.endsWith(':physical-tests')) throw new Error('Synthetic assessment storage failure');
    return setState(key, value);
  };
  assert.throws(() => f.runtime.chargingTestAction('target', { id: run.id, association: run.association,
    sessionId: run.sessionId, targetRevision: run.target.revision, nativeTargetSoc: 95 }), /Synthetic assessment storage failure/);
  assert.deepEqual(f.runtime.physicalTests.status(), assessments);
  assert.deepEqual(f.store.getState('charging:mqtt:physical-tests'), assessments);
  assert.deepEqual(production(f.runtime), before);
});

test('assessment storage failure stays visible without preventing normal runtime persistence', t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER reject_report_event BEFORE INSERT ON charging_report_events BEGIN SELECT RAISE(ABORT, 'Synthetic diagnostic storage outage'); END");
  f.plug();
  assert.doesNotThrow(() => f.runtime.persist());
  assert.equal(f.runtime.status().diagnostics.available, false);
  assert.equal(f.store.getState('charging:mqtt').version, 6);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) count FROM charging_reports').get().count, 0, 'A failed event append rolls the report back');
  f.store.db.exec('DROP TRIGGER reject_report_event');
  f.runtime.persist();
  assert.notEqual(f.runtime.status().diagnostics.available, false);
  assert.ok(f.store.db.prepare('SELECT COUNT(*) count FROM charging_report_events').get().count > 0);
});

test('family assessment actions are explicitly scoped on both sides of the API', () => {
  for (const action of ['preview', 'start', 'schedule', 'target', 'cancel']) {
    const path = `/api/charging/tests/${action}`;
    assert.equal(familyRouteAllowed('POST', path), true);
    assert.equal(webRequestAllowed({ role: 'family' }, path, {}), true);
  }
  assert.equal(familyRouteAllowed('POST', '/api/charging/tests/force-start'), false);
  assert.equal(webRequestAllowed({ role: 'family' }, '/api/charging/tests/force-start', {}), false);
});

test('vehicle timer dates use installation time and reject both daylight-saving gaps and overlaps', () => {
  const at = Date.parse('2026-09-30T19:45:00Z');
  assert.equal(chargingTestLocalTime(at), '2026-09-30T22:45');
  assert.equal(parseChargingTestTime('2026-09-30T22:45'), at);
  assert.equal(parseChargingTestTime('2026-01-15T22:45'), Date.parse('2026-01-15T20:45:00Z'));
  assert.throws(() => parseChargingTestTime('2026-03-29T03:30'), /unambiguous/);
  assert.throws(() => parseChargingTestTime('2026-10-25T03:30'), /unambiguous/);
  assert.throws(() => parseChargingTestTime('2026-02-30T12:00'), /unambiguous/);
  assert.throws(() => parseChargingTestTime(''), /date and time/);
});
