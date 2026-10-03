import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = 1_800_000_000_000;

// Real runtime, Tesla MQTT capture, Shelly RPC adapter and controller. Charger 1
// supplies independent synthetic phase measurements and cannot issue commands.
async function fixture(t, { firstCurrentA = 16, firstAvailable = true, stepMetadata = true, currentWritable = true } = {}) {
  let now = START, runtime, adapter, meterAt = START;
  const data = new Map(), writes = [], client = new EventEmitter();
  const config = { input: 'mqtt', connections: {
    mqtt: { address: 'mqtt://minimum-current.invalid', user: 'synthetic' },
    easee: { charger_id: 'synthetic-minimum-first', equalizer_id: 'synthetic-minimum-equalizer' },
    teslamate: { enabled: true, carId: '1', namespace: 'minimum-current', homeGeofence: 'Home' },
  }, charging: { vehicles: { bmw: { mqttTopic: 'synthetic/minimum-current/bmw' } },
    chargers: { charger2: { enabled: true, deviceId: 'synthetic-minimum-second',
      topicPrefix: 'synthetic/minimum-current/evse', limiterEnabled: false } } } };
  const store = { getState: key => structuredClone(data.get(key)),
    setState: (key, value) => data.set(key, structuredClone(value)), transaction: fn => fn(), event: () => 1 };
  withReportDatabase(store, t);
  const components = { current_limit: ['Number', 200], start_charging: ['Boolean', 201],
    work_state: ['Enum', 202], phase_info: ['Object', 203] };
  const fields = { current_limit: { value: 12, at: START }, start_charging: { value: true, at: START },
    work_state: { value: 'charger_charging', at: START } };
  const phaseInfo = () => {
    const current = fields.start_charging.value ? fields.current_limit.value : 0;
    return { total_power: current * .69, total_act_energy: 0,
      ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
        { voltage: 230, current, power: current * .23 }])) };
  };
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, done) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: 'synthetic-minimum-second' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') result = { state: 'running' };
    else if (frame.method === 'Schedule.List') result = { rev: 1, jobs: [] };
    else if (frame.method.endsWith('.GetConfig')) result = { id: components[role][1], owner: 'service:0',
      access: role === 'current_limit' && !currentWritable ? 'r' : 'crw', min: 6, max: 16, meta: { ui: stepMetadata ? { step: 1 } : {} },
      options: ['charger_free', 'charger_charging', 'charger_pause'] };
    else if (frame.method.endsWith('.Set')) {
      writes.push({ method: frame.method, ...frame.params, at: now });
      now++; fields[role] = { value: frame.params.value, at: now };
      if (role === 'start_charging') fields.work_state = { value: frame.params.value ? 'charger_charging' : 'charger_pause', at: now };
      result = null;
    } else result = { value: role === 'phase_info' ? phaseInfo() : fields[role].value,
      last_update_ts: (role === 'phase_info' ? now : fields[role].at) / 1000,
      ...(['start_charging', 'current_limit'].includes(role) ? { source: 'rpc' } : {}) };
    done?.(); queueMicrotask(() => client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: 'synthetic-minimum-second', dst: frame.src, result })), {}));
  };
  const capture = createChargingTeslaCapture({ settings: config.connections.teslamate, clock: () => now,
    brokerIdentity: 'synthetic-minimum-broker' });
  capture.setConnected(true); t.after(() => capture.close());
  const publishTesla = values => {
    for (const [field, value] of Object.entries(values))
      assert.equal(capture.receive(`teslamate/minimum-current/cars/1/${field}`, String(value), {}, now), true);
  };
  const firstSnapshot = () => ({ transport: 'ocpp', online: true, readAt: now, pluggedIn: true,
    charging: true, connectorStatus: 'Charging', statusAt: START, transactionId: 17,
    transactionConfirmed: true, transactionStartedAt: START, powerKw: firstCurrentA * .69, powerAt: meterAt,
    limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] } });
  const attachFirst = target => {
    const first = target.chargers.charger1;
    first.controller = { supportsIdentification: true, status: () => ({ phase: 'off', manual: null, pending: null,
      owned: null, enabled: false, session: { connected: true, connectedAt: START, sessionId: 'synthetic-first-session',
        lastDisconnectedAt: START - 1000 }, snapshot: firstSnapshot() }),
      async update() { return this.status(); }, async close() {} };
    first.adapter = { capabilities: { scheduling: true }, normalize() {
      const signal = (value, measuredAt = meterAt, available = true) => ({ value, measuredAt, receivedAt: now,
        available, retained: false, source: 'synthetic-first-meter' });
      return { providerConnected: true, connected: signal(true, START), charging: signal(true, START),
        phaseCurrentA: signal([firstCurrentA, firstCurrentA, firstCurrentA], meterAt, firstAvailable),
        powerKw: signal(firstCurrentA * .69, meterAt, firstAvailable), maximumCurrentA: signal(16),
        phaseVoltageV: signal([230, 230, 230]) };
    } };
  };
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    const instance = runtime; t.after(() => instance.close());
    runtime.tick = () => {}; runtime.pricesInitialized = true;
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      for (const item of Object.values(runtime.chargers)) item.plan = { id: 'synthetic-normal-plan', feasible: true,
        deadlineAt: START + 8 * 3600_000, startAt: START, periods: [{ startAt: START, endAt: null }] };
    };
    attachFirst(runtime);
    if (!adapter) {
      adapter = createShellyEvseAdapter({ config: runtime.configuration.chargers.charger2,
        broker: config.connections.mqtt, client, store, clock: () => now, canControl: () => true,
        engine: { recorder: { recordEnergy() {}, energyGap() {}, flush() {} } } });
      t.after(() => adapter.close());
      client.emit('connect'); client.emit('message', 'synthetic/minimum-current/evse/online', Buffer.from('true'), {});
      await adapter.refresh();
    }
    await runtime.setAdapter('charger2', adapter);
    runtime.teslaCapture = capture;
  };
  await create();
  publishTesla({ healthy: true, geofence: 'Home', plugged_in: true, charging_state: 'Charging',
    charger_phases: 3, charger_power: 0, charger_actual_current: 0 });
  return { get runtime() { return runtime; }, get now() { return now; }, adapter, fields, writes, publishTesla, data, store, config,
    item: id => runtime.chargers[id],
    advance(ms) { now += ms; meterAt = now; },
    setFirst(value, available = true) { firstCurrentA = value; firstAvailable = available; meterAt = now; },
    observe() { return runtime.telemetry(now); },
    async update() { meterAt = now; await runtime.reconcile('charger2'); return runtime.chargers.charger2.controller.status(); },
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    async sampleTesla(current) { publishTesla({ charger_actual_current: current, charger_power: current * .69, healthy: true });
      await adapter.refresh(); return runtime.telemetry(now); },
  };
}

for (const charger of ['charger1', 'charger2']) test(`minimum-current runtime identifies Tesla on ${charger} from two independent settled measurements`, async t => {
  const f = await fixture(t);
  f.publishTesla({ charger_phases: 2 }); // The vehicle can report 2 while all three physical phases carry current.
  let control = await f.update();
  assert.equal(control.currentTest.phase, 'active'); assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.writes.filter(row => row.method === 'Number.Set').length, 1);
  assert.equal(f.item('charger1').vehicleMatch, null); assert.equal(f.item('charger2').vehicleMatch, null);
  f.advance(6000); await f.sampleTesla(charger === 'charger1' ? 16 : 6);
  assert.equal(f.item(charger).vehicleMatch, null, 'One settling sample cannot identify a vehicle');
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item(charger).vehicleMatch?.id, 'tesla');
  assert.equal(f.item(charger === 'charger1' ? 'charger2' : 'charger1').vehicleMatch, null,
    'The other charger cannot become BMW by elimination');
  control = await f.update();
  assert.equal(control.currentTest.phase, 'restored'); assert.equal(f.fields.current_limit.value, 12);
  assert.ok(f.now < control.currentTest.expiresAt, 'Success ends the current test before its fixed deadline');
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['current_limit', 12]]);
});

test('minimum-current timeout restores once and cannot restart through polling, Use automatic or restart', async t => {
  const f = await fixture(t, { firstCurrentA: 6 });
  await f.update();
  const attempt = structuredClone(f.item('charger2').identification);
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  f.advance(91_000); await f.update();
  assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  for (let i = 0; i < 4; i++) {
    f.advance(60_000); await f.sampleTesla(6); await f.update();
  }
  const view = f.runtime.status().chargers.find(row => row.id === 'charger2');
  await f.runtime.useAutomatic('charger2', { association: view.association,
    sessionId: view.request.sessionId, revision: view.request.revision,
    controlRevision: view.controls.revision, takeoverToken: view.control.takeover.token });
  await f.restart(); await f.update();
  assert.equal(f.item('charger2').identification.id, attempt.id);
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['current_limit', 12]]);
});

test('ordinary identification observation preserves economic execution and emits no control request', async t => {
  const f = await fixture(t, { currentWritable: false });
  f.item('charger2').controls.enabled = true; f.runtime.refreshSettings();
  await f.update();
  for (let i = 0; i < 3; i++) {
    f.advance(10_000); await f.update();
    const item = f.item('charger2'), control = item.controller.status();
    assert.equal(item.identification.phase, 'charging');
    assert.equal(f.runtime.identificationControl(item, control.snapshot), null);
    assert.equal(control.identification, null);
    assert.equal(control.execution.planId, 'synthetic-normal-plan');
  }
  assert.deepEqual(f.writes, []);
});

for (const winner of ['charger1', 'charger2']) test(`a unique Tesla test on ${winner} retires one BMW episode shared by both chargers`, async t => {
  const f = await fixture(t); f.observe();
  f.runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  const publish = values => f.runtime.receiveSoc('synthetic/minimum-current/bmw', JSON.stringify({
    provider: 'bmw-cardata', ...values, fields: Object.fromEntries(Object.keys(values).map(key => [key,
      { measuredAt: key === 'pluggedIn' ? START - 120_000 : f.now, readingId: `synthetic-${key}-${f.now}` }])) }), { retain: false }, f.now);
  // The BMW inlet can remain CONNECTED across charger sessions; this older
  // context cannot supply a fresh plug edge that independently fences replay.
  f.advance(1000); publish({ atHome: true, pluggedIn: true, charging: true });
  const chargingId = f.runtime.vehicleFeeds.bmw.reading.fields.charging.readingId;
  f.advance(20_000); publish({ charging: false });
  assert.equal(f.runtime.vehicleFeeds.bmw.consumedChargingId, null, 'No physical stop has been supplied yet');
  // The same recorded simultaneous start/stop episode matched both chargers.
  for (const item of Object.values(f.runtime.chargers)) {
    item.vehicleEvidence.chargingTimes = [START + 1000];
    item.vehicleEvidence.stoppedTimes = [f.now];
  }
  await f.adapter.refresh(); f.observe();
  assert.ok(Object.values(f.runtime.chargers).every(item => item.vehicleConflict?.ids.includes('bmw')));
  await f.update(); f.advance(6000); await f.sampleTesla(winner === 'charger1' ? 16 : 6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item(winner).vehicleMatch?.id, 'tesla');
  const peer = winner === 'charger1' ? 'charger2' : 'charger1';
  assert.equal(f.item(peer).vehicleMatch, null, 'Discarding an ambiguous episode cannot identify BMW by elimination');
  assert.equal(f.runtime.vehicleFeeds.bmw.consumedChargingId, chargingId);
  await f.update(); await f.restart(); f.advance(10_000); await f.update();
  assert.equal(f.item(winner).vehicleMatch?.id, 'tesla', 'Restoration and restart must not revive the ambiguous BMW episode');
  assert.equal(f.item(peer).vehicleMatch, null);
  assert.equal(f.item(winner).vehicleConflict, null); assert.equal(f.item(peer).vehicleConflict, null);
  // A later, independent BMW episode identifies the peer. Consuming that new
  // episode must not make the earlier shared episode usable again.
  f.runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  f.advance(90_000); await f.adapter.refresh();
  f.item(peer).vehicleEvidence.chargingTimes.push(f.now);
  publish({ charging: true });
  const laterChargingId = f.runtime.vehicleFeeds.bmw.reading.fields.charging.readingId;
  f.advance(20_000); await f.adapter.refresh();
  f.item(peer).vehicleEvidence.stoppedTimes.push(f.now);
  publish({ charging: false });
  for (let sample = 0; sample < 3; sample++) {
    f.advance(1000); await f.adapter.refresh(); f.observe();
    assert.equal(f.item(winner).vehicleMatch?.id, 'tesla', 'A newer BMW match cannot revive the retired shared episode');
    assert.equal(f.item(peer).vehicleMatch?.id, 'bmw', 'The peer requires its own new BMW start and stop');
    assert.equal(f.item(winner).vehicleConflict, null); assert.equal(f.item(peer).vehicleConflict, null);
  }
  assert.equal(f.runtime.vehicleFeeds.bmw.consumedChargingId, laterChargingId);
  await f.restart();
  f.runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  f.advance(1000); await f.adapter.refresh(); publish({ charging: false }); f.observe();
  assert.equal(f.item(winner).vehicleMatch?.id, 'tesla');
  assert.equal(f.item(peer).vehicleMatch?.id, 'bmw');
  assert.equal(f.item(winner).vehicleConflict, null); assert.equal(f.item(peer).vehicleConflict, null);
});

test('a unique Tesla current match cannot retire an independent contradictory BMW episode', async t => {
  const f = await fixture(t); await f.update();
  f.runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  const publish = values => f.runtime.receiveSoc('synthetic/minimum-current/bmw', JSON.stringify({
    provider: 'bmw-cardata', ...values, fields: Object.fromEntries(Object.keys(values).map(key => [key,
      { measuredAt: f.now, readingId: `synthetic-independent-${key}-${f.now}` }])) }), { retain: false }, f.now);
  f.advance(1000); publish({ atHome: true, pluggedIn: true, charging: true });
  const startedAt = f.now;
  f.advance(20_000); publish({ charging: false });
  f.item('charger1').vehicleEvidence.chargingTimes = [startedAt];
  f.item('charger1').vehicleEvidence.stoppedTimes = [f.now];
  await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'bmw');
  assert.equal(f.item('charger2').vehicleMatch, null, 'The BMW episode does not match both chargers');
  f.advance(6000); await f.sampleTesla(16);
  for (let sample = 0; sample < 3; sample++) {
    f.advance(5000); await f.adapter.refresh(); f.observe();
    assert.deepEqual([...(f.item('charger1').vehicleConflict?.ids ?? [])].sort(), ['bmw', 'tesla'],
      `Current sample ${sample + 1} cannot discard an independent contradictory BMW identity`);
    assert.equal(f.item('charger1').vehicleMatch, null);
    assert.equal(f.item('charger2').vehicleMatch, null);
  }
});

for (const scenario of ['equal-current', 'missing-peer']) test(`minimum-current runtime leaves ${scenario} unresolved without power/start fallback`, async t => {
  const f = await fixture(t, scenario === 'equal-current' ? { firstCurrentA: 6 } : { firstAvailable: false });
  await f.update(); f.advance(6000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch, null); assert.equal(f.item('charger2').vehicleMatch, null);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'active');
  assert.ok(Object.values(f.runtime.chargers).every(item => item.identification.phase !== 'completed'));
});

test('minimum-current runtime gives Charger 2 the identification turn before a Charger 1 pause', async t => {
  const f = await fixture(t); f.observe();
  assert.equal(f.runtime.identificationTurn(f.item('charger1')), false);
  assert.equal(f.runtime.identificationTurn(f.item('charger2')), true);
  assert.equal(f.runtime.identificationControl(f.item('charger1'), f.item('charger1').controller.status().snapshot), null);
  const request = f.runtime.identificationControl(f.item('charger2'), f.adapter.snapshot());
  assert.equal(request.minimumCurrent, true); assert.notEqual(request.phase, 'pausing');
  await f.update(); assert.equal(f.writes.some(row => row.role === 'start_charging'), false);
});

for (const savedConflict of [false, true]) test(`minimum-current runtime replaces a saved wrong Tesla ${savedConflict ? 'conflict' : 'assignment'} only after positive unique evidence`, async t => {
  const f = await fixture(t); f.observe();
  const first = f.item('charger1');
  first.vehicleMatch = { id: 'tesla', scope: first.request.scope, association: first.association,
    vehicleAssociation: f.runtime.teslaCapture.snapshot().association, connectedAt: START, matchedAt: START, revision: 1 };
  await f.restart(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla');
  if (savedConflict) {
    for (const item of Object.values(f.runtime.chargers)) {
      item.vehicleMatch = null;
      item.vehicleConflict = { scope: item.request.scope, ids: ['tesla'], at: f.now,
        vehicleAssociations: { tesla: f.runtime.teslaCapture.snapshot().association } };
    }
    await f.restart(); f.observe();
    assert.ok(f.item('charger1').vehicleConflict?.ids.includes('tesla'));
  }
  const priorAttempt = structuredClone(f.item('charger1').identification);
  assert.equal(priorAttempt.phase, 'completed');
  await f.update(); f.advance(6000); await f.sampleTesla(6);
  if (savedConflict) assert.ok(f.item('charger1').vehicleConflict?.ids.includes('tesla'), 'One sample cannot clear a saved conflict');
  else assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla', 'A first tentative sample cannot replace saved identity');
  assert.equal(f.item('charger2').vehicleMatch, null);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch, null);
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger1').vehicleConflict, null); assert.equal(f.item('charger2').vehicleConflict, null);
  assert.notEqual(f.item('charger1').identification.phase, 'completed', 'Correcting the false match reopens observation for BMW evidence');
  assert.equal(f.item('charger1').identification.id, priorAttempt.id);
  assert.equal(f.item('charger1').identification.chargeUsedKwh, priorAttempt.chargeUsedKwh);
  assert.deepEqual(f.item('charger1').identification.probe, priorAttempt.probe, 'Correction never renews an extra charging allowance');
});


test('minimum-current runtime does not reuse a settling sample from a replaced Tesla feed', async t => {
  const f = await fixture(t); await f.update(); f.advance(6000); await f.sampleTesla(6);
  assert.ok(f.item('charger2').vehicleEvidence.teslaCurrentCandidate);
  f.advance(5000);
  const replacement = createChargingTeslaCapture({ settings: { enabled: true, carId: '2',
    namespace: 'minimum-current', homeGeofence: 'Home' }, clock: () => f.now,
    brokerIdentity: 'synthetic-minimum-broker' });
  t.after(() => replacement.close()); replacement.setConnected(true);
  for (const [field, value] of Object.entries({ healthy: true, geofence: 'Home', plugged_in: true,
    charging_state: 'Charging', charger_phases: 3, charger_power: 4.14, charger_actual_current: 6 }))
    replacement.receive(`teslamate/minimum-current/cars/2/${field}`, String(value), {}, f.now);
  f.runtime.teslaCapture = replacement;
  await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch, null, 'A new feed has not supplied two physical settling samples');
  assert.equal(f.item('charger2').vehicleEvidence.teslaCurrentCandidate.vehicleAssociation, replacement.snapshot().association);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
});

test('minimum-current runtime rejects malformed saved settling evidence before it can become a match', async t => {
  const f = await fixture(t); await f.update(); f.advance(6000); await f.sampleTesla(6); f.runtime.persist();
  const saved = structuredClone(f.data.get('charging:mqtt'));
  assert.ok(saved.chargers.charger2.vehicleEvidence.teslaCurrentCandidate);
  for (const patch of [{ unknownField: true }, { vehicleAssociation: null }, { testId: '' },
    { physicalAt: -1 }, { observedAt: START }, { receivedAt: START + 1_000_000 }]) {
    const invalid = structuredClone(saved);
    Object.assign(invalid.chargers.charger2.vehicleEvidence.teslaCurrentCandidate, patch);
    const store = { ...f.store, getState: key => key === 'charging:mqtt' ? invalid : f.store.getState(key) };
    assert.throws(() => new ChargingRuntime({ engine: {}, store, config: f.config, clock: () => f.now }),
      /Unsupported saved current identification evidence/);
  }
});

test('a saved minimum-current restoration remains visible and blocks backend changes before the adapter attaches', async t => {
  const f = await fixture(t); await f.update(); f.runtime.persist();
  await f.runtime.close();
  const runtime = new ChargingRuntime({ engine: {}, store: f.store, config: f.config, clock: () => f.now });
  t.after(() => runtime.close()); runtime.tick = () => {};
  assert.equal(runtime.hasAutomaticControl(), true);
  const control = runtime.controlStatus('charger2');
  assert.equal(control.currentTest.phase, 'active');
  assert.equal(control.handoverConfirmed, false, 'Saved current restriction still needs confirmed restoration');
  const view = runtime.status().chargers.find(charger => charger.id === 'charger2');
  assert.equal(view.identification.currentTest.id, control.currentTest.id);
  await assert.rejects(runtime.pauseForBackendChange('charger2'), /current restriction is released/);
  assert.notEqual(runtime.chargers.charger2.backendTransition.ready, true);
});

test('minimum-current runtime waits for a configured peer whose adapter has not started', async t => {
  const f = await fixture(t); await f.update();
  f.item('charger1').adapter = null; f.item('charger1').controller = null;
  f.advance(6000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch, null,
    'Startup order cannot turn the missing configured charger into proof that Tesla is on Charger 2');
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'active');
});


test('minimum-current runtime identifies and restores with absent optional UI step metadata', async t => {
  const f = await fixture(t, { stepMetadata: false });
  assert.equal(f.adapter.snapshot().currentControlReady, false);
  assert.equal(f.adapter.snapshot().identificationCurrentReady, true);
  let control = await f.update(); assert.equal(control.currentTest.phase, 'active');
  f.advance(6000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger1').vehicleMatch, null);
  control = await f.update(); assert.equal(control.currentTest.phase, 'restored');
  assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.adapter.snapshot().currentControlReady, false);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['current_limit', 12]]);
});
