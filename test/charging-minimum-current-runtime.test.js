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
async function fixture(t, { firstCurrentA = 16, firstAvailable = true, stepMetadata = true, currentWritable = true,
  teslaPluggedIn = true, initialCurrentA = 12, economicStartAt = START } = {}) {
  let now = START, runtime, adapter, meterAt = START, acceptCurrentWrite = true, measuredCurrentA = null, currentWriteHook = null,
    phaseMeasuredAt = null, statusReadHook = null, currentReadbackHook = null, dropCurrentReply = false, firstStopped = false, firstStatusAt = START,
    firstSourceAt = null, firstNative = {};
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
  const fields = { current_limit: { value: initialCurrentA, at: START }, start_charging: { value: true, at: START },
    work_state: { value: 'charger_charging', at: START } };
  const phaseInfo = () => {
    const current = measuredCurrentA ?? (fields.start_charging.value ? fields.current_limit.value : 0);
    return { total_power: current * .69, total_act_energy: 0,
      ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
        { voltage: 230, current, power: current * .23 }])) };
  };
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, done) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result, respond = true;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: 'synthetic-minimum-second' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') result = { state: 'running' };
    else if (frame.method === 'Schedule.List') result = { rev: 1, jobs: [] };
    else if (frame.method.endsWith('.GetConfig')) result = { id: components[role][1], owner: 'service:0',
      access: role === 'current_limit' && !currentWritable ? 'r' : 'crw', min: 6, max: 16, meta: { ui: stepMetadata ? { step: 1 } : {} },
      options: ['charger_free', 'charger_charging', 'charger_pause'] };
    else if (frame.method.endsWith('.Set')) {
      writes.push({ method: frame.method, ...frame.params, at: now });
      now++; if (role !== 'current_limit' || acceptCurrentWrite) fields[role] = { value: frame.params.value, at: now };
      if (role === 'current_limit' && dropCurrentReply) { dropCurrentReply = false; respond = false; }
      if (role === 'current_limit' && currentWriteHook) { const hook = currentWriteHook; currentWriteHook = null; hook(); }
      if (role === 'start_charging') fields.work_state = { value: frame.params.value ? 'charger_charging' : 'charger_pause', at: now };
      result = null;
    } else {
      if (statusReadHook) { const hook = statusReadHook; statusReadHook = null; hook(); }
      result = { value: role === 'phase_info' ? phaseInfo() : fields[role].value,
        last_update_ts: (role === 'phase_info' ? phaseMeasuredAt ?? now : fields[role].at) / 1000,
        ...(['start_charging', 'current_limit'].includes(role) ? { source: 'rpc' } : {}) };
    }
    done?.(); if (respond) queueMicrotask(() => {
      client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
        id: frame.id, src: 'synthetic-minimum-second', dst: frame.src, result })), {});
      // Real correlated readback is visible before Promise.all refresh and the
      // controller's durable completion run, just as on the live adapter.
      if (role === 'current_limit' && frame.method.endsWith('.GetStatus') && currentReadbackHook
        && currentReadbackHook() !== false) currentReadbackHook = null;
    });
  };
  const capture = createChargingTeslaCapture({ settings: config.connections.teslamate, clock: () => now,
    brokerIdentity: 'synthetic-minimum-broker' });
  capture.setConnected(true); t.after(() => capture.close());
  const publishTesla = (values, { retained = false, at = now } = {}) => {
    for (const [field, value] of Object.entries(values))
      assert.equal(capture.receive(`teslamate/minimum-current/cars/1/${field}`, String(value), { retain: retained }, at), true);
  };
  const firstSnapshot = () => ({ transport: 'ocpp', online: true, readAt: now, pluggedIn: true,
    charging: !firstStopped, connectorStatus: firstStopped ? 'SuspendedEVSE' : 'Charging', statusAt: firstStatusAt, transactionId: 17,
    transactionConfirmed: true, transactionStartedAt: START, powerKw: firstCurrentA * .69, powerAt: firstSourceAt ?? meterAt,
    appControl: { controlKnown: true, stopped: firstStopped, readAt: now, faulted: false,
      authorizationBlocked: false, schedule: { enabled: 'none' }, ...firstNative },
    limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] } });
  const attachFirst = target => {
    const first = target.chargers.charger1;
    first.controller = { supportsIdentification: true, status: () => ({ phase: firstStopped ? 'manual' : 'off',
      manual: firstStopped ? { kind: 'stop' } : null, pending: null,
      owned: null, enabled: false, session: { connected: true, connectedAt: START, sessionId: 'synthetic-first-session',
        lastDisconnectedAt: START - 1000 }, snapshot: firstSnapshot() }),
      async update() { return this.status(); }, async close() {} };
    first.adapter = { capabilities: { scheduling: true }, normalize() {
      const signal = (value, measuredAt = meterAt, available = true) => ({ value, measuredAt, receivedAt: now,
        available, retained: false, source: 'synthetic-first-meter' });
      return { providerConnected: true, connected: signal(true, START), charging: signal(!firstStopped, firstStatusAt),
        phaseCurrentA: signal([firstCurrentA, firstCurrentA, firstCurrentA], firstSourceAt ?? meterAt, firstAvailable),
        powerKw: signal(firstCurrentA * .69, firstSourceAt ?? meterAt, firstAvailable), maximumCurrentA: signal(16),
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
        deadlineAt: START + 8 * 3600_000, startAt: economicStartAt, periods: [{ startAt: economicStartAt, endAt: null }] };
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
  publishTesla({ plugged_in: teslaPluggedIn }, { retained: !teslaPluggedIn, at: teslaPluggedIn ? now : START - 1000 });
  publishTesla({ healthy: true, geofence: 'Home', charging_state: 'Charging',
    charger_phases: 3, charger_power: 0, charger_actual_current: 0 });
  return { get runtime() { return runtime; }, get now() { return now; }, adapter, fields, writes, publishTesla, data, store, config,
    item: id => runtime.chargers[id],
    setCurrentWriteAccepted(value) { acceptCurrentWrite = value; },
    setMeasuredCurrent(value) { measuredCurrentA = value; },
    setPhysicalSourceTime(value) { phaseMeasuredAt = value; },
    onCurrentWrite(hook) { currentWriteHook = hook; },
    onStatusRead(hook) { statusReadHook = hook; },
    onCurrentReadback(hook) { currentReadbackHook = hook; },
    dropCurrentReply() { dropCurrentReply = true; },
    notifyCurrent(value, { at = now, source = 'rpc' } = {}) {
      fields.current_limit = { value, at };
      client.emit('message', 'synthetic/minimum-current/evse/events/rpc', Buffer.from(JSON.stringify({
        src: 'synthetic-minimum-second', method: 'NotifyStatus', params: {
          'number:200': { value, last_update_ts: at / 1000, source },
        },
      })), {});
    },
    advance(ms) { now += ms; meterAt = now; },
    setFirst(value, available = true) { firstCurrentA = value; firstAvailable = available; meterAt = now; },
    stopFirst() { firstStopped = true; firstCurrentA = 0; firstStatusAt = meterAt = now; },
    setFirstSourceTime(value) { firstSourceAt = value; },
    setFirstNative(value) { firstNative = value; },
    observe() { return runtime.telemetry(now); },
    async update() { meterAt = now; await runtime.reconcile('charger2'); return runtime.chargers.charger2.controller.status(); },
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    async sampleTesla(current) { publishTesla({ charger_actual_current: current, charger_power: current * .69, healthy: true });
      await adapter.refresh(); return runtime.telemetry(now); },
  };
}

async function pausedColdFixture(t) {
  const f = await fixture(t, { teslaPluggedIn: false, initialCurrentA: 16, economicStartAt: START + 3600_000 });
  f.item('charger2').controls.enabled = true; f.runtime.refreshSettings();
  f.publishTesla({ healthy: false });
  await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item('charger2').controller.status().reason, 'economic-wait');
  f.advance(1000); f.publishTesla({ healthy: true, charging_state: 'Stopped' });
  await f.adapter.refresh();
  return f;
}

function publishBmw(f, values, measuredAt = f.now) {
  f.runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  f.runtime.receiveSoc('synthetic/minimum-current/bmw', JSON.stringify({
    provider: 'bmw-cardata', ...values,
    fields: Object.fromEntries(Object.keys(values).map(key => [key,
      { measuredAt, readingId: `synthetic-swapped-${key}-${measuredAt}` }])),
  }), { retain: false }, f.now);
}

async function stoppedTeslaPeerFixture(t, { heldMinimumSource = false } = {}) {
  const f = await fixture(t, { initialCurrentA: 16 });
  await f.update(); f.advance(6000); await f.sampleTesla(16);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla', 'The peer identity comes from the real settled current matcher');
  const earlierTest = f.item('charger2').controller.status().currentTest.id;
  f.advance(1000); f.stopFirst();
  f.publishTesla({ charging_state: 'Stopped', charger_actual_current: 0, charger_power: 0 });
  f.observe(); f.advance(61_000); await f.update();
  f.setMeasuredCurrent(0); f.fields.work_state = { value: 'charger_free', at: f.now };
  await f.adapter.refresh(); await f.update();
  f.advance(1000); f.fields.work_state = { value: 'charger_charging', at: f.now }; f.setMeasuredCurrent(null);
  if (heldMinimumSource) f.setPhysicalSourceTime(f.now);
  await f.adapter.refresh(); await f.update();
  assert.notEqual(f.item('charger2').controller.status().currentTest.id, earlierTest);
  assert.equal(f.fields.current_limit.value, 6, 'The new physical connection begins its own confirmed minimum-current test');
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla', 'The unchanged peer connection retains its positive identity');
  return f;
}

async function bmwPauseRestorationFixture(t) {
  const f = await stoppedTeslaPeerFixture(t);
  f.setMeasuredCurrent(6); f.advance(10_000); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'pausing');
  const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
  await f.runtime.chargeNow('charger2', { association: card.association,
    sessionId: card.request.sessionId, revision: card.request.revision });
  assert.equal(f.fields.current_limit.value, 6, 'Keep the reduced pilot until the physical stop completes');
  assert.equal(f.fields.start_charging.value, false);
  return f;
}

for (const boundary of ['accepted readback', 'whole-second readback', 'notification before acknowledgement'])
test(`BMW pause survives restoration ${boundary} before the controller saves completion`, async t => {
  const f = await bmwPauseRestorationFixture(t), before = f.writes.length;
  const original = structuredClone(f.item('charger2').identification);
  const deadline = f.item('charger2').controller.status().currentTest.expiresAt;
  let observed;
  const inspect = () => {
    const control = f.item('charger2').controller.status();
    if (control.currentTest.phase !== 'restoring' || control.snapshot.fields.current_limit.value !== 16) return false;
    f.observe(); observed = { control, identification: structuredClone(f.item('charger2').identification) };
  };
  if (boundary === 'notification before acknowledgement') f.onCurrentWrite(() => { f.notifyCurrent(16); inspect(); });
  else {
    if (boundary === 'whole-second readback') f.onCurrentWrite(() => {
      f.fields.current_limit.at = Math.floor(f.now / 1000) * 1000;
    });
    f.onCurrentReadback(inspect);
  }
  f.advance(5000); f.setMeasuredCurrent(0); await f.update();
  assert.ok(observed, 'The real adapter exposed the new current before controller completion');
  assert.equal(observed.control.currentTest.phase, 'restoring');
  assert.equal(observed.control.currentTest.pending.acceptedAt === null, boundary === 'notification before acknowledgement');
  assert.equal(observed.identification.phase, 'pausing', 'An in-flight owned restore cannot end BMW evidence collection');
  assert.equal(observed.identification.pauseUntil, original.pauseUntil);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, deadline);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.slice(before).filter(row => row.role === 'start_charging' && row.value).length, 0);
  f.advance(1000); publishBmw(f, { charging: false }); await f.update(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'bmw');
  assert.equal(f.item('charger2').identification.id, original.id);
  assert.equal(f.item('charger2').identification.phase, 'completed');
  assert.equal(f.fields.start_charging.value, true, 'Charge now resumes after independent BMW Stop evidence');
  assert.equal(f.writes.slice(before).filter(row => row.role === 'current_limit').length, 1);
});

test('a lost restoration acknowledgement preserves Stop across Charge now and restart without replay', async t => {
  const f = await bmwPauseRestorationFixture(t), before = f.writes.length;
  const pauseUntil = f.item('charger2').identification.pauseUntil;
  f.onCurrentWrite(() => { f.notifyCurrent(16); f.observe(); }); f.dropCurrentReply();
  f.advance(5000); f.setMeasuredCurrent(0); await f.update();
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'uncertain');
  await f.update();
  assert.equal(f.fields.start_charging.value, false, 'Unconfirmed restoration cannot release the owned Stop');
  assert.equal(f.item('charger2').controller.status().reason, 'evse-command-unconfirmed');
  f.advance(1000); publishBmw(f, { charging: false }); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'bmw', 'Independent BMW evidence can still establish identity');
  assert.equal(f.fields.start_charging.value, false, 'Identity cannot confirm a lost native current reply');
  f.advance(pauseUntil - f.now + 1000); await f.restart(); await f.update();
  assert.equal(f.fields.start_charging.value, false, 'Pause expiry and restart cannot resolve the lost reply');
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'uncertain');
  assert.equal(f.item('charger2').controller.status().reason, 'evse-command-unconfirmed');
  assert.equal(f.writes.slice(before).filter(row => row.role === 'current_limit').length, 1);
  assert.equal(f.writes.slice(before).filter(row => row.role === 'start_charging' && row.value).length, 0);
});

for (const boundary of ['different current', 'new same-value current', 'different current before acknowledgement'])
test(`an external ${boundary} supersedes the pending BMW restoration`, async t => {
  const f = await bmwPauseRestorationFixture(t), before = f.writes.length;
  const externalValue = boundary === 'new same-value current' ? 16 : 8;
  let observed;
  const external = () => {
    const control = f.item('charger2').controller.status();
    if (control.currentTest.phase !== 'restoring'
      || boundary !== 'different current before acknowledgement' && !control.currentTest.pending.acceptedAt) return false;
    f.advance(1000); f.notifyCurrent(externalValue);
    f.observe(); observed = structuredClone(f.item('charger2').identification);
  };
  if (boundary === 'different current before acknowledgement') f.onCurrentWrite(external);
  else f.onCurrentReadback(external);
  f.advance(5000); f.setMeasuredCurrent(0); await f.update();
  assert.ok(observed); assert.equal(observed.phase, 'inconclusive');
  assert.equal(observed.reason, 'interrupted');
  assert.equal(f.item('charger2').vehicleMatch, null);
  await f.update();
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'superseded');
  assert.equal(f.fields.current_limit.value, externalValue, 'The newer native setting owns the result');
  assert.equal(f.writes.slice(before).filter(row => row.role === 'current_limit').length, 1,
    'Supersession never repeats the restoration write');
});

for (const delayed of [false, true])
test(`new BMW connection obtains its own pause beside an already identified stopped Tesla${delayed ? ' across Charge now and restart' : ''}`, async t => {
  const f = await stoppedTeslaPeerFixture(t), before = f.writes.length;
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  const attempt = f.item('charger2').identification.id;
  f.advance(10_000); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000); await f.update();
  const state = structuredClone(f.item('charger2').identification);
  assert.equal(state.phase, 'pausing', 'A stopped proven Tesla peer cannot monopolize the BMW comparison window');
  assert.ok(state.candidate, 'Independent BMW charging evidence is required to start the pause');
  assert.equal(state.id, attempt); assert.ok(state.candidate.measuredAt >= test.connectedAt);
  assert.equal(f.item('charger2').vehicleMatch, null, 'The peer identity and Stop command cannot identify BMW by elimination');
  assert.equal(f.item('charger2').vehicleEvidence.teslaCurrentResolvedTestId, undefined,
    'A retained peer assignment does not manufacture a fresh Tesla current match');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item('charger1').controller.status().manual.kind, 'stop');
  assert.equal(f.item('charger1').controller.status().snapshot.powerKw, 0);
  f.advance(5000); await f.update();
  const stopAt = f.now;
  if (delayed) {
    const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
    await f.runtime.chargeNow('charger2', { association: card.association,
      sessionId: card.request.sessionId, revision: card.request.revision });
    f.advance(test.expiresAt - f.now + 1000); await f.restart(); await f.update();
    assert.equal(f.item('charger2').identification.phase, 'pausing');
    assert.equal(f.fields.start_charging.value, false);
  }
  assert.equal(f.item('charger2').identification.pauseUntil, state.pauseUntil);
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  publishBmw(f, { charging: false }, stopAt); await f.update(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'bmw', 'BMW must independently report the matching physical stop');
  assert.equal(f.item('charger2').identification.phase, 'completed');
  assert.equal(f.item('charger2').identification.id, attempt);
  assert.equal(f.fields.current_limit.value, 16); assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.writes.slice(before).filter(row => row.role === 'current_limit' && row.value === 6).length, 0,
    'The handoff never begins another current comparison');
  assert.equal(f.writes.slice(before).filter(row => row.role === 'start_charging' && row.value === false).length, 1);
});

for (const boundary of ['old BMW source', 'peer conflict', 'changed peer scope', 'peer readings unavailable', 'Tesla feed unavailable',
  'native Stop', 'readback only', 'unsettled current', 'old minimum source', 'old peer zero', 'unknown native permission', 'native peer schedule'])
test(`stopped-peer BMW pause preserves ${boundary}`, async t => {
  const f = await stoppedTeslaPeerFixture(t, { heldMinimumSource: boundary === 'old minimum source' }), before = f.writes.length;
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  f.advance(10_000); await f.adapter.refresh();
  if (boundary === 'native Stop') {
    f.fields.start_charging = { value: false, at: f.now };
    f.fields.work_state = { value: 'charger_pause', at: f.now }; await f.update();
  }
  if (boundary === 'readback only') f.setMeasuredCurrent(0);
  if (boundary === 'unsettled current') f.setMeasuredCurrent(16);
  if (boundary === 'old peer zero') f.setFirstSourceTime(test.confirmedAt - 1);
  if (boundary === 'unknown native permission') f.setFirstNative({ controlKnown: false });
  if (boundary === 'native peer schedule') f.setFirstNative({ schedule: { enabled: 'daily' } });
  await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true });
  publishBmw(f, { charging: true }, boundary === 'old BMW source' ? test.connectedAt - 60_000 : f.now);
  const peer = f.item('charger1');
  if (boundary === 'peer conflict') peer.vehicleConflict = { scope: peer.request.scope, ids: ['tesla', 'bmw'], at: f.now,
    vehicleAssociations: { tesla: f.runtime.teslaCapture.snapshot().association, bmw: f.runtime.vehicleFeeds.bmw.association } };
  if (boundary === 'changed peer scope') peer.vehicleMatch.scope = 'synthetic-old-connection';
  if (boundary === 'peer readings unavailable') f.setFirst(0, false);
  if (boundary === 'Tesla feed unavailable') f.publishTesla({ healthy: false });
  f.advance(1000);
  await f.update();
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  assert.equal(f.item('charger2').vehicleMatch, null);
  assert.equal(f.writes.slice(before).some(row => row.role === 'start_charging' && row.value === false), false);
  f.advance(test.expiresAt - f.now + 1000); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  if (boundary === 'native Stop') assert.equal(f.fields.start_charging.value, false);
});

for (const delayed of [false, true])
test(`BMW on Shelly obtains its own pause after identifying Tesla on Easee${delayed ? ' across Charge now, restart and the current deadline' : ''}`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  let control = await f.update();
  const test = structuredClone(control.currentTest), attempt = f.item('charger2').identification.id;
  f.advance(6000); await f.sampleTesla(16);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger2').vehicleMatch, null, 'Tesla on the peer does not identify BMW by elimination');
  f.advance(START + 61_000 - f.now); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000);
  control = await f.update();
  const state = f.item('charger2').identification;
  assert.equal(state.id, attempt, 'The comparison and BMW pause use the same attempt');
  assert.equal(state.phase, 'pausing', 'An independent BMW charging baseline starts its own bounded pause');
  assert.equal(state.candidate.kind, 'ongoing');
  assert.ok(state.candidate.capturedAt < test.expiresAt, 'The handoff begins within the original comparison window');
  assert.equal(control.currentTest.expiresAt, test.expiresAt);
  assert.equal(f.fields.start_charging.value, false, 'The real Shelly controller issues the BMW pause');
  assert.equal(f.item('charger2').vehicleMatch, null, 'A pause command alone is not BMW evidence');
  const pauseUntil = state.pauseUntil;
  f.advance(5000); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'pausing', 'Current restoration cannot cancel the owned BMW pause');
  assert.equal(f.item('charger2').identification.pauseUntil, pauseUntil);
  const bmwStopAt = f.now;
  if (delayed) {
    const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
    await f.runtime.chargeNow('charger2', { association: card.association,
      sessionId: card.request.sessionId, revision: card.request.revision });
    assert.equal(f.item('charger2').identification.phase, 'pausing');
    assert.equal(f.fields.start_charging.value, false, 'Charge now lets the BMW pause gather its independent stop');
    f.advance(test.expiresAt - f.now + 1000); await f.restart(); await f.update();
    assert.equal(f.item('charger2').identification.id, attempt);
    assert.equal(f.item('charger2').identification.phase, 'pausing', 'An already-owned BMW pause survives current-test expiry');
    assert.equal(f.item('charger2').identification.pauseUntil, pauseUntil);
    assert.equal(f.fields.start_charging.value, false);
  }
  publishBmw(f, { charging: false }, bmwStopAt);
  await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'bmw', 'Independent BMW stop evidence identifies the physically paused charger');
  assert.equal(f.item('charger2').identification.phase, 'completed');
  assert.equal(f.item('charger2').identification.id, attempt);
  assert.equal(f.item('charger2').identification.pauseUntil, pauseUntil);
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true, 'Ordinary charging resumes after positive BMW identification');
  assert.equal(f.writes.filter(row => row.role === 'current_limit' && row.value === 6).length, 1);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === false).length, 1);
});

test('a plausible BMW baseline on the peer cannot cut short a delayed Tesla response on Shelly', async t => {
  const f = await fixture(t, { initialCurrentA: 16 }); await f.update();
  f.advance(100_000); await f.update();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  await f.sampleTesla(16);
  const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
  await f.runtime.identifyVehicle('charger2', { association: card.association,
    sessionId: card.request.sessionId, revision: card.request.revision });
  await f.update();
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.fields.start_charging.value, true, 'An unassigned BMW baseline must not stop the Tesla comparison');
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  f.advance(20_000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger1').vehicleMatch, null, 'A negative BMW result cannot assign the peer by elimination');
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
});

test('loss of Tesla readiness cannot turn an unresolved comparison into a BMW pause', async t => {
  const f = await fixture(t, { initialCurrentA: 16 }); await f.update();
  f.advance(61_000); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.publishTesla({ healthy: false }); f.advance(1000); await f.update();
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  assert.equal(f.item('charger2').vehicleMatch, null);
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
});

test('a BMW handoff that crosses the current deadline before native pause ownership cannot dispatch a late Stop', async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  const initial = await f.update(), expiresAt = initial.currentTest.expiresAt;
  f.advance(81_000); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  await f.sampleTesla(16);
  f.advance(6000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger2').identification.phase, 'pausing');
  assert.equal(f.item('charger2').controller.status().owned, null);
  assert.equal(f.item('charger2').controller.status().pending, null);
  assert.equal(f.fields.current_limit.value, 6);
  f.onStatusRead(() => f.advance(expiresAt - f.now + 1000));
  await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true, 'An expired undispatched handoff grants no new Stop');
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
});

for (const ending of ['native Stop', 'pause timeout'])
test(`BMW pause after a resolved peer comparison respects ${ending}`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 }); await f.update();
  f.advance(6000); await f.sampleTesla(16);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  f.advance(START + 61_000 - f.now); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000); await f.update();
  const state = structuredClone(f.item('charger2').identification);
  assert.equal(state.phase, 'pausing');
  f.advance(1000); await f.update();
  if (ending === 'native Stop') {
    f.advance(1000); f.fields.start_charging = { value: false, at: f.now };
    f.fields.work_state = { value: 'charger_pause', at: f.now }; await f.update();
  }
  f.advance(state.pauseUntil - f.now + 1000); await f.restart(); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.item('charger2').identification.id, state.id);
  assert.equal(f.item('charger2').identification.pauseUntil, state.pauseUntil);
  assert.equal(f.item('charger2').vehicleMatch, null, 'No independent BMW stop means no BMW identity');
  assert.equal(f.fields.start_charging.value, ending !== 'native Stop');
  if (ending === 'native Stop') assert.equal(f.item('charger2').controller.status().manual.kind, 'stop');
  else assert.equal(f.item('charger2').identification.reason, 'pause-timeout');
  assert.equal(f.writes.filter(row => row.role === 'current_limit' && row.value === 6).length, 1);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === false).length, 1);
});

for (const peerIdentified of [false, true]) test(`BMW cannot begin a pause after the original current window${peerIdentified ? ' even after the peer Tesla match' : ''}`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  const initial = await f.update(), expiry = initial.currentTest.expiresAt;
  if (peerIdentified) {
    f.advance(6000); await f.sampleTesla(16);
    f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  }
  f.advance(expiry - f.now + 1000); await f.update();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000); await f.update(); await f.restart(); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  assert.equal(f.item('charger2').vehicleMatch, null);
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, expiry);
  assert.equal(f.writes.filter(row => row.role === 'current_limit' && row.value === 6).length, 1);
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
});

for (const context of ['away', 'old charging source', 'unsettled peer'])
test(`BMW ${context} cannot take over an active current comparison`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  const initial = await f.update(), expiry = initial.currentTest.expiresAt;
  f.advance((context === 'unsettled peer' ? 20_000 : 61_000)); await f.adapter.refresh();
  publishBmw(f, { atHome: context !== 'away', pluggedIn: true });
  publishBmw(f, { charging: true }, context === 'old charging source' ? START - 6 * 60_000 : f.now);
  f.advance(1000); await f.update();
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  assert.equal(f.item('charger2').vehicleMatch, null);
  f.advance(expiry - f.now + 1000); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
});

for (const instruction of ['native current', 'native Enable', 'native Stop'])
test(`${instruction} supersedes the remaining BMW handoff window after the peer Tesla match`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 }); await f.update();
  f.advance(6000); await f.sampleTesla(16);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  f.advance(1000);
  if (instruction === 'native current') f.fields.current_limit = { value: 8, at: f.now };
  else {
    f.fields.start_charging = { value: instruction === 'native Enable', at: f.now };
    f.fields.work_state = { value: instruction === 'native Enable' ? 'charger_charging' : 'charger_pause', at: f.now };
  }
  await f.update();
  f.advance(START + 61_000 - f.now); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.advance(1000); await f.update();
  assert.equal(f.item('charger2').identification.phase, 'inconclusive');
  assert.equal(f.item('charger2').identification.pauseUntil, null);
  assert.equal(f.writes.some(row => row.role === 'start_charging' && row.value === false), false);
  if (instruction === 'native current') assert.equal(f.fields.current_limit.value, 8);
  else assert.equal(f.item('charger2').controller.status().manual.kind, instruction === 'native Enable' ? 'enable' : 'stop');
});

test('BMW handoff holds 6 A until physical zero and preserves the original economic probe and return', async t => {
  const f = await pausedColdFixture(t); await f.update();
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  const probe = structuredClone(f.item('charger2').identification.probe);
  f.advance(START + 61_000 - f.now); f.setMeasuredCurrent(6); await f.adapter.refresh();
  publishBmw(f, { atHome: true, pluggedIn: true, charging: true });
  f.publishTesla({ charging_state: 'Charging' }); await f.sampleTesla(16);
  f.advance(6000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger1').vehicleMatch?.id, 'tesla');
  const before = f.writes.length; await f.update();
  assert.equal(f.item('charger2').identification.phase, 'pausing');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.fields.current_limit.value, 6, 'The stop acknowledgement cannot restore 16 A while the BMW still draws');
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]), [['start_charging', false]]);
  f.advance(5000); f.setMeasuredCurrent(0); await f.update(); await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').identification.phase, 'pausing');
  publishBmw(f, { charging: false }); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'bmw');
  const after = f.item('charger2').identification.probe;
  assert.equal(after.startedAt, probe.startedAt); assert.equal(after.deadlineAt, probe.deadlineAt);
  assert.equal(after.returnStartAt, probe.returnStartAt); assert.ok(after.endedAt <= f.now);
  f.advance(test.expiresAt - f.now + 1000); await f.restart(); await f.update();
  assert.equal(f.fields.start_charging.value, false, 'The completed BMW test returns to the accepted economic pause');
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  assert.equal(f.writes.filter(row => row.role === 'current_limit' && row.value === 6).length, 1);
});

test('paused cold-start identification confirms 6 A before starting and allows a delayed independent Tesla response', async t => {
  const f = await pausedColdFixture(t), before = f.writes.length;
  let control = await f.update();
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]), [['current_limit', 6], ['start_charging', true]]);
  assert.equal(control.currentTest.phase, 'active');
  const probe = structuredClone(f.item('charger2').identification.probe);
  assert.ok(probe.startedAt >= control.currentTest.confirmedAt);
  assert.ok(probe.deadlineAt - probe.startedAt > 60_000, 'Confirmed 6 A permits the first slower vehicle publication');
  assert.ok(probe.deadlineAt <= control.currentTest.expiresAt - 10_000);
  assert.equal(control.currentTest.probeDeadlineAt, probe.deadlineAt);
  assert.equal(f.runtime.teslaCapture.snapshot().pluggedIn, false);
  assert.equal(f.runtime.teslaCapture.snapshot().actualCurrentA, 0);
  assert.equal(f.item('charger2').vehicleMatch, null, 'Preparation supplies no identity evidence');
  f.advance(40_000); f.publishTesla({ charging_state: 'Charging' }); await f.sampleTesla(6); await f.update();
  assert.equal(f.item('charger2').vehicleMatch, null, 'One fresh vehicle response still needs a second physical sample');
  assert.deepEqual(f.item('charger2').identification.probe, probe, 'Neither readback nor feed arrival renews the original probe');
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.fields.current_limit.value, 6, 'The stop precedes restoration of the higher ceiling');
  await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]),
    [['current_limit', 6], ['start_charging', true], ['start_charging', false], ['current_limit', 16]]);
});

test('an unconfirmed cold-start current setting cannot release the economic pause', async t => {
  const f = await pausedColdFixture(t), before = f.writes.length;
  f.setCurrentWriteAccepted(false);
  const control = await f.update();
  assert.equal(control.currentTest.phase, 'uncertain');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').identification.probe, null, 'No probe budget is created from an unconfirmed request');
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]), [['current_limit', 6]]);
});

for (const nativeStop of [false, true]) test(`cold-start probe retains 6 A through delayed physical zero${nativeStop ? ' after native Stop' : ''} and restart`, async t => {
  const f = await pausedColdFixture(t); await f.update();
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  f.setMeasuredCurrent(6);
  f.advance(nativeStop ? 5000 : test.probeDeadlineAt - f.now + 1);
  if (nativeStop) {
    f.fields.start_charging = { value: false, at: f.now };
    f.fields.work_state = { value: 'charger_pause', at: f.now };
  }
  await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.fields.current_limit.value, 6, 'Stop permission is not physical zero');
  f.advance(test.expiresAt - f.now + 1000);
  await f.restart(); await f.update();
  assert.equal(f.fields.current_limit.value, 6, 'Expiry/restart cannot raise the cap while physical draw continues');
  f.setMeasuredCurrent(0); f.advance(1000); await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.equal(f.fields.start_charging.value, false);
});

for (const choice of ['Automatic', 'Charge now', 'Automatic OFF', 'expired test'])
test(`native Stop retains a normal 6 A test until physical zero with ${choice}`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  f.item('charger2').controls.enabled = true; f.runtime.refreshSettings();
  f.advance(1000); await f.sampleTesla(16);
  await f.update(); await f.update();
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  assert.equal(test.phase, 'active');
  assert.equal(test.probeDeadlineAt, undefined, 'Normal charging has no economic probe deadline');
  assert.equal(f.item('charger2').identification.probe, null);
  f.setMeasuredCurrent(6); f.advance(5000);
  if (choice === 'Charge now') {
    const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
    await f.runtime.chargeNow('charger2', { association: card.association,
      sessionId: card.request.sessionId, revision: card.request.revision });
  } else if (choice === 'Automatic OFF') {
    const item = f.item('charger2');
    await f.runtime.setControl('charger2', { association: item.association, enabled: false, revision: item.controls.revision });
  } else if (choice === 'expired test') f.advance(test.expiresAt - f.now + 1);
  f.fields.start_charging = { value: false, at: f.now };
  f.fields.work_state = { value: 'charger_pause', at: f.now };
  const beforeStop = f.writes.length;
  await f.update();
  assert.equal(f.fields.current_limit.value, 6, 'Native stop readback cannot raise the pilot while 6 A still flows');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item('charger2').controller.status().manual.kind, 'stop');
  assert.equal(f.item('charger2').controller.status().execution, null);
  f.advance(Math.max(1000, test.expiresAt - f.now + 1000)); await f.restart(); await f.update();
  assert.equal(f.fields.current_limit.value, 6, 'Restart, test expiry and caller release choices preserve the stop obligation');
  assert.equal(f.writes.length, beforeStop);
  f.setMeasuredCurrent(0); f.advance(1000); await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.deepEqual(f.writes.slice(beforeStop).map(row => [row.role, row.value]), [['current_limit', 16]]);
});

test('native Stop restoration requires zero measured after its permission event', async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  f.advance(1000); await f.sampleTesla(16);
  await f.update(); await f.update(); f.advance(1000);
  f.setMeasuredCurrent(0); f.setPhysicalSourceTime(f.now);
  await f.adapter.refresh();
  f.advance(4000); f.fields.start_charging = { value: false, at: f.now };
  f.fields.work_state = { value: 'charger_pause', at: f.now };
  await f.update();
  assert.equal(f.fields.current_limit.value, 6, 'A renewed receipt of pre-stop zero cannot prove physical completion');
  f.advance(1000); f.setPhysicalSourceTime(f.now); await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, false);
});

for (const action of ['Enable', 'current setting']) test(`a later native ${action} supersedes the current-test stop hold`, async t => {
  const f = await fixture(t, { initialCurrentA: 16 });
  f.advance(1000); await f.sampleTesla(16); await f.update(); await f.update();
  f.setMeasuredCurrent(6); f.advance(5000);
  f.fields.start_charging = { value: false, at: f.now };
  f.fields.work_state = { value: 'charger_pause', at: f.now };
  await f.update(); assert.equal(f.fields.current_limit.value, 6);
  const before = f.writes.length;
  f.advance(1000);
  if (action === 'Enable') {
    f.fields.start_charging = { value: true, at: f.now };
    f.fields.work_state = { value: 'charger_charging', at: f.now };
  } else f.fields.current_limit = { value: 8, at: f.now };
  await f.update();
  const control = f.item('charger2').controller.status();
  assert.equal(control.currentTest.phase, action === 'Enable' ? 'restored' : 'superseded');
  assert.equal(f.fields.current_limit.value, action === 'Enable' ? 16 : 8);
  assert.equal(f.fields.start_charging.value, action === 'Enable');
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]),
    action === 'Enable' ? [['current_limit', 16]] : []);
});

test('Charge now lets cold-start identification finish at 6 A before continuing ordinary charging', async t => {
  const f = await pausedColdFixture(t); await f.update();
  const probe = structuredClone(f.item('charger2').identification.probe), test = structuredClone(f.item('charger2').controller.status().currentTest);
  f.advance(5000);
  const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
  await f.runtime.chargeNow('charger2', { association: card.association,
    sessionId: card.request.sessionId, revision: card.request.revision });
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.fields.current_limit.value, 6, 'Charge now preserves the active comparison');
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  assert.equal(f.item('charger2').controller.status().currentTest.id, test.id);
  f.advance(6000); f.publishTesla({ charging_state: 'Charging' }); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.equal(f.item('charger2').identification.probe.deadlineAt, probe.deadlineAt);
});

test('Charge now during cold-start preparation retains the 6 A comparison before any start', async t => {
  const f = await pausedColdFixture(t);
  let chargeNow, test;
  f.onCurrentWrite(() => {
    assert.equal(f.fields.start_charging.value, false);
    test = structuredClone(f.item('charger2').controller.status().currentTest);
    const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
    chargeNow = f.runtime.chargeNow('charger2', { association: card.association,
      sessionId: card.request.sessionId, revision: card.request.revision });
  });
  await f.update(); await chargeNow; await f.update();
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.item('charger2').controller.status().currentTest.id, test.id);
  assert.equal(f.item('charger2').controller.status().currentTest.expiresAt, test.expiresAt);
  f.advance(6000); f.publishTesla({ charging_state: 'Charging' }); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe(); await f.update();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true);
});

for (const choice of ['Automatic OFF', 'native Enable']) test(`explicit ${choice} does not pin an expired cold-start current test at 6 A`, async t => {
  const f = await pausedColdFixture(t); await f.update();
  const test = structuredClone(f.item('charger2').controller.status().currentTest);
  f.advance(5000);
  if (choice === 'Automatic OFF') {
    const item = f.item('charger2');
    await f.runtime.setControl('charger2', { association: item.association, enabled: false, revision: item.controls.revision });
  } else {
    f.fields.start_charging = { value: true, at: f.now }; await f.update();
  }
  f.advance(test.expiresAt - f.now + 1000); await f.update();
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
});

test('unplugging ends the cold-start energy scope and restores current without a start command', async t => {
  const f = await pausedColdFixture(t); await f.update();
  const before = f.writes.length;
  f.advance(5000); f.setMeasuredCurrent(0); f.fields.work_state = { value: 'charger_free', at: f.now };
  await f.update();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.item('charger2').controller.status().currentTest.phase, 'restored');
  assert.deepEqual(f.writes.slice(before).map(row => [row.role, row.value]), [['current_limit', 16]]);
});

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

for (const retainedDeparture of [false, true]) for (const departure of [{ charging_state: 'Disconnected' }, { state: 'driving' }])
test(`old false plug permits 6 A and durable identity until ${retainedDeparture ? 'retained' : 'live'} ${Object.values(departure)[0]}`, async t => {
  const f = await fixture(t, { teslaPluggedIn: false });
  f.advance(1000); await f.sampleTesla(12);
  let control = await f.update();
  assert.equal(f.runtime.teslaCapture.snapshot().pluggedIn, false, 'The contradictory raw report stays visible');
  assert.equal(control.currentTest.phase, 'active'); assert.equal(f.fields.current_limit.value, 6);
  f.advance(6000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  control = await f.update();
  assert.equal(control.currentTest.phase, 'restored'); assert.equal(f.fields.current_limit.value, 12);
  f.advance(1000); f.publishTesla({ charger_actual_current: 0, charger_power: 0, charging_state: 'Stopped' });
  f.fields.start_charging = { value: false, at: f.now }; f.fields.work_state = { value: 'charger_pause', at: f.now };
  await f.adapter.refresh(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla', 'An intentional zero-current pause preserves independently proven identity');
  await f.restart(); f.observe();
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla', 'Restart cannot reinterpret the original false report as a new unplug');
  if (retainedDeparture) {
    f.runtime.teslaCapture.setConnected(false); f.runtime.teslaCapture.setConnected(true);
    f.publishTesla({ healthy: true });
  }
  f.advance(1000); f.publishTesla(departure, { retained: retainedDeparture }); f.observe();
  assert.equal(f.item('charger2').vehicleMatch, null, 'A later native vehicle disconnect ends the match even if plugged_in stays false');
});

for (const restart of [false, true]) test(`explicit Identify after successful current restoration runs a new bounded test${restart ? ' after restart' : ''}`, async t => {
  const f = await fixture(t, { teslaPluggedIn: false });
  f.advance(1000); await f.sampleTesla(12); await f.update();
  f.advance(6000); await f.sampleTesla(6);
  f.advance(5000); await f.adapter.refresh(); f.observe();
  let control = await f.update();
  const firstTest = structuredClone(control.currentTest);
  assert.equal(firstTest.phase, 'restored');
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(f.item('charger2').vehicleEvidence.teslaCurrentResolvedTestId, firstTest.id);
  if (restart) await f.restart();
  f.advance(1000); await f.sampleTesla(12); await f.update();
  assert.equal(f.fields.current_limit.value, 12, 'Ordinary updates do not renew the successful test');
  const card = f.runtime.status().chargers.find(row => row.id === 'charger2');
  await f.runtime.identifyVehicle('charger2', { association: card.association,
    sessionId: card.request.sessionId, revision: card.request.revision });
  control = f.item('charger2').controller.status();
  assert.equal(control.currentTest.phase, 'active');
  assert.notEqual(control.currentTest.id, firstTest.id, 'Explicit Identify owns a new attempt');
  assert.equal(control.currentTest.id, f.item('charger2').identification.id);
  assert.ok(control.currentTest.confirmedAt > firstTest.confirmedAt);
  assert.equal(control.currentTest.expiresAt - control.currentTest.startedAt, 90_000);
  assert.equal(f.fields.current_limit.value, 6);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]),
    [['current_limit', 6], ['current_limit', 12], ['current_limit', 6]]);
  assert.notEqual(f.item('charger2').identification.phase, 'completed', 'The earlier 6 A evidence cannot finish the new attempt');
  f.advance(6000); await f.sampleTesla(6);
  assert.notEqual(f.item('charger2').identification.phase, 'completed', 'A second settled physical sample is still required');
  f.advance(5000); await f.adapter.refresh(); f.observe(); control = await f.update();
  assert.equal(f.item('charger2').identification.phase, 'completed');
  assert.equal(f.item('charger2').vehicleMatch?.id, 'tesla');
  assert.equal(control.currentTest.phase, 'restored');
  assert.equal(f.fields.current_limit.value, 12);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]),
    [['current_limit', 6], ['current_limit', 12], ['current_limit', 6], ['current_limit', 12]]);
});

test('restored current test from a prior connection is absent from the next identification attempt', async t => {
  const f = await fixture(t);
  await f.update(); f.advance(91_000); await f.update();
  const prior = structuredClone(f.item('charger2').controller.status().currentTest);
  assert.equal(prior.phase, 'restored');
  f.advance(1000); f.fields.work_state = { value: 'charger_free', at: f.now };
  await f.adapter.refresh(); await f.update();
  f.advance(1000); f.fields.work_state = { value: 'charger_charging', at: f.now };
  f.publishTesla({ healthy: false });
  await f.adapter.refresh(); await f.update();
  const item = f.runtime.status().chargers.find(row => row.id === 'charger2');
  assert.notEqual(item.identification.connectedAt, prior.connectedAt);
  assert.equal(item.identification.currentTest, null, 'Yesterday\'s restored 6 A result is not evidence of a new test');
  assert.equal(f.item('charger2').controller.status().currentTest.id, prior.id, 'Historical restoration is retained at its owner');
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
    const view = f.runtime.status().chargers.find(row => row.id === 'charger2');
    assert.equal(view.identification.reason, 'current-control-unavailable',
      'The status explains the blocked current test instead of claiming active charge observation');
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
