import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { createShellyController, createShellyEvseAdapter } from '../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';

const START = Date.parse('2026-01-15T00:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE;
const triple = value => [value, value, value];
const prices = [20, 1, 1, 20].map((price, index) => ({ start: START + index * HOUR,
  end: START + (index + 1) * HOUR, price }));

test('Shelly startup validates adopted execution before reading or writing device state', async () => {
  const effects = [];
  const adapter = { association: 'synthetic-execution-association',
    snapshot: () => effects.push('snapshot'), refresh: () => effects.push('refresh'),
    rpc: () => effects.push('command') };
  const execution = { planId: 'synthetic-execution-plan',
    periods: [{ startAt: START, endAt: START + MINUTE }, { startAt: START + HOUR, endAt: null }],
    finalStartAt: START + HOUR, deadlineAt: START + 2 * HOUR };
  const create = value => createShellyController({ adapter,
    initialState: { version: 1, association: adapter.association, execution: value },
    saveState: () => effects.push('save') });
  for (const [label, invalid] of [
    ['unknown execution field', { ...execution, oldPlan: true }],
    ['missing deadline', { planId: execution.planId, periods: execution.periods, finalStartAt: execution.finalStartAt }],
    ['invalid plan ID', { ...execution, planId: 3 }],
    ['incorrect final start', { ...execution, finalStartAt: START }],
    ['overlapping periods', { ...execution, periods: [{ startAt: START, endAt: START + HOUR + MINUTE }, execution.periods[1]] }],
    ['reversed periods', { ...execution, periods: [...execution.periods].reverse() }],
    ['unknown period field', { ...execution, periods: [{ ...execution.periods[0], currentA: 8 }, execution.periods[1]] }],
    ['noninteger timestamp', { ...execution, periods: [{ startAt: START + .5, endAt: START + MINUTE }, execution.periods[1]] }],
    ['no final release', { ...execution, periods: [{ startAt: START, endAt: START + MINUTE }] }],
  ]) assert.throws(() => create(invalid), { code: 'unsupported-shelly-ownership' }, label);
  assert.deepEqual(effects, [], 'Rejected durable state must not reach device reads, commands or persistence');

  const reordered = { deadlineAt: execution.deadlineAt, finalStartAt: execution.finalStartAt,
    periods: execution.periods.map(({ startAt, endAt }) => ({ endAt, startAt })), planId: execution.planId };
  for (const valid of [execution, reordered, null, undefined]) await create(valid).close();
  assert.deepEqual(effects, [], 'Current records are accepted independently of JSON property insertion order');
});

// Production runtime, planner, controllers, transport adapters and vehicle feeds.
// Only the physical devices/broker and acquisition clocks are simulated. Device
// settings keep their source clocks; reads do not manufacture native changes.
async function fixture(t, { limiter = true } = {}) {
  let now = START, runtime, heldOcppWrite = null, revokedOcppWrites = 0, rejectShellyWrites = false;
  const store = new Store(':memory:'), client = new EventEmitter();
  const commands = [], profiles = new Map(), reads = { charger1: 0, charger2: 0 };
  const cars = { charger1: { connected: false, allows: true, demandA: 8, connectedAt: null },
    charger2: { connected: false, allows: true, demandA: 8, connectedAt: null } };
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-joint-easee', equalizer_id: 'synthetic-joint-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-joint' }, teslamate: { enabled: true },
  }, charging: { defaults: { capacityKwh: 10 }, vehicles: {
    bmw: { mqttTopic: 'synthetic/joint/bmw', defaults: { capacityKwh: 10 } },
    tesla: { defaults: { capacityKwh: 10 } },
  }, chargers: { charger2: { enabled: true, deviceId: 'synthetic-joint-evse', topicPrefix: 'synthetic/joint/evse',
    limiterEnabled: limiter, additiveCurrentVerified: true, mainFuseA: triple(16), marginA: triple(0), dwellMs: 0, rampA: 16 } } } };
  const fields = { current_limit: { value: 16, at: now }, start_charging: { value: true, at: now },
    work_state: { value: 'charger_free', at: now } };
  const schedules = { jobs: [] };
  const paused = () => [...profiles.values()].some(profile => Date.parse(profile.validFrom) <= now
    && Date.parse(profile.validTo) > now && profile.transactionId === cars.charger1.connectedAt / 1000);
  const amps2 = () => cars.charger2.connected && cars.charger2.allows && fields.start_charging.value
    ? Math.min(cars.charger2.demandA, fields.current_limit.value) : 0;
  const amps1 = () => cars.charger1.connected && cars.charger1.allows && !paused()
    ? Math.min(cars.charger1.demandA, 16 - amps2()) : 0;
  const physical2 = () => {
    const state = !cars.charger2.connected ? 'charger_free' : amps2() > 0 ? 'charger_charging'
      : !fields.start_charging.value ? 'charger_pause' : 'charger_wait';
    if (fields.work_state.value !== state) fields.work_state = { value: state, at: now };
    return { total_power: amps2() * 690, total_act_energy: 0,
      ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
        { voltage: 230, current: amps2(), power: amps2() * 230 }])) };
  };
  const roles = ['current_limit', 'start_charging', 'work_state', 'phase_info'];
  client.subscribe = (topics, _options, cb) => cb(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, cb) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result, error;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: 'synthetic-joint-evse', model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') { reads.charger2++; result = { state: 'running' }; }
    else if (frame.method === 'Schedule.List') result = schedules;
    else if (frame.method.endsWith('.GetConfig')) result = { id: 200 + roles.indexOf(role), owner: 'service:0', access: 'crw',
      options: ['charger_free', 'charger_charging', 'charger_pause', 'charger_wait', 'charger_end'], min: 6, max: 16, meta: { ui: { step: 1 } } };
    else if (frame.method.endsWith('.Set')) {
      commands.push({ chargerId: 'charger2', method: frame.method, role, value: frame.params.value, at: now });
      if (rejectShellyWrites) error = { code: -1, message: 'Synthetic command rejection' };
      else { now += 1000; fields[role] = { value: frame.params.value, at: now }; physical2(); result = null; }
    } else {
      const meter = physical2();
      result = { value: role === 'phase_info' ? meter : fields[role].value,
        last_update_ts: (role === 'phase_info' ? now : fields[role].at) / 1000 };
    }
    cb?.(); queueMicrotask(() => client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: 'synthetic-joint-evse', dst: frame.src, ...(error ? { error } : { result }) })), {}));
  };
  const capture = createChargingTeslaCapture({ clock: () => now, brokerIdentity: 'synthetic-joint-broker' });
  capture.setConnected(true);
  let shelly, ocpp;
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    runtime.teslaCapture = capture;
    const scope = runtime.chargers.charger1.association;
    const snapshot = () => {
      reads.charger1++;
      return { transport: 'ocpp', scope, connectionId: 'synthetic-joint-socket', readAt: now, online: true,
        connectorStatus: !cars.charger1.connected ? 'Available' : paused() ? 'SuspendedEVSE' : amps1() > 0 ? 'Charging' : 'SuspendedEV', statusAt: now,
        transactionId: cars.charger1.connected ? cars.charger1.connectedAt / 1000 : null,
        transactionStartedAt: cars.charger1.connectedAt, transactionConfirmed: cars.charger1.connected,
        pluggedIn: cars.charger1.connected, powerKw: amps1() * .69, powerAt: now,
        appControl: null, limits: { chargerA: 16, cableA: 16, circuitA: triple(16), allocationA: 32, equalizerAvailableA: triple(16 - amps2()) },
        supply: { availableCurrentA: triple(16 - amps2()), propertyCurrentA: triple(amps1() + amps2()), chargerCurrentA: triple(amps1()),
          voltageV: triple(230), observationTimes: { allowance: triple(now), property: triple(now), charger: triple(now), voltage: triple(now) } } };
    };
    ocpp = createOcppScheduleAdapter({ scope, readSnapshot: snapshot, clock: () => now, canControl: () => true,
      isCurrent: value => value.transactionId === (cars.charger1.connected ? cars.charger1.connectedAt / 1000 : null),
      request: async (action, payload, options) => {
        if (action === 'SetChargingProfile' && heldOcppWrite) {
          const held = heldOcppWrite; heldOcppWrite = null; held.entered(); await held.wait;
        }
        if (!options.guard()) {
          revokedOcppWrites++;
          throw Object.assign(new Error('Synthetic transport discarded a revoked instruction'), { code: 'ocpp-request-revoked' });
        }
        assert.equal(options.guard(), true);
        assert.equal(options.beforeSend?.() ?? true, true);
        if (action === 'SetChargingProfile') {
          commands.push({ chargerId: 'charger1', method: action, at: now });
          profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles)); return { status: 'Accepted' };
        }
        if (action === 'ClearChargingProfile') {
          commands.push({ chargerId: 'charger1', method: action, at: now });
          return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
        }
        const ends = [...new Set([...profiles.values()].filter(profile => Date.parse(profile.validTo) > now
          && Date.parse(profile.validTo) < now + payload.duration * 1000).map(profile => Date.parse(profile.validTo)))].sort((a, b) => a - b);
        return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(), chargingSchedule: {
          chargingRateUnit: 'A', duration: payload.duration,
          chargingSchedulePeriod: [{ startPeriod: 0, limit: paused() ? 0 : 16 }, ...ends.map(end => ({ startPeriod: (end - now) / 1000, limit: 16 }))] } };
      } });
    if (!shelly) {
      shelly = createShellyEvseAdapter({ config: runtime.configuration.chargers.charger2, broker: config.connections.mqtt,
        client, store, engine: { recorder: { recordEnergy() {}, energyGap() {}, flush() {} } }, clock: () => now, canControl: () => true });
      client.emit('connect'); client.emit('message', 'synthetic/joint/evse/online', Buffer.from('true'), { retain: true });
      await shelly.refresh();
    }
    await runtime.setAdapter('charger1', ocpp); await runtime.setAdapter('charger2', shelly); await runtime.reconcile();
  };
  await create();
  const view = id => runtime.status().chargers.find(charger => charger.id === id);
  const automatic = (id, enabled) => runtime.setControl(id, { association: view(id).association, revision: view(id).controls.revision, enabled });
  const scope = id => ({ association: view(id).association, sessionId: view(id).request.sessionId, revision: view(id).request.revision });
  const settle = async () => {
    await runtime.reconcile(); await new Promise(resolve => setImmediate(resolve));
    for (const item of Object.values(runtime.chargers)) await item.reconcileFlight;
  };
  t.after(async () => { await runtime.close(); shelly.close(); capture.close(); store.close(); });
  return { get runtime() { return runtime; }, get now() { return now; }, cars, commands, fields, schedules, reads, view, automatic, scope, settle,
    get revokedOcppWrites() { return revokedOcppWrites; },
    rejectShellyWrites(value) { rejectShellyWrites = value; },
    holdNextOcppWrite() {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      heldOcppWrite = { entered, wait };
      return { started, release };
    },
    advance(ms) { now += ms; },
    async connect(id) { now += 1000; Object.assign(cars[id], { connected: true, connectedAt: now }); physical2(); await settle(); },
    async disconnect(id) { now += 1000; cars[id].connected = false; physical2(); await settle(); },
    async plan() { runtime.tick({ prices, force: true }); await settle(); },
    async priority(priority) { await runtime.setSettings({ priority, revision: runtime.status().controls.revision,
      associations: Object.fromEntries(runtime.status().chargers.map(charger => [charger.id, charger.association])) }); },
    edit(id, changes) { return runtime.setChargerSettings(id, { scope: 'session', ...scope(id), changes }); },
    async restart() { const priorPrices = structuredClone(runtime.prices); runtime.persist(); await runtime.close();
      await create(); runtime.tick({ prices: priorPrices }); await settle(); },
    bmw(values) { runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
      runtime.receiveSoc('synthetic/joint/bmw', JSON.stringify({ provider: 'bmw-cardata', ...values, measuredAt: now, readingId: `synthetic-soc-${now}`,
        fields: Object.fromEntries(Object.keys(values).map(key => [key, { measuredAt: now, readingId: `synthetic-${key}-${now}` }])) })); },
    tesla(values = {}) { for (const [key, value] of Object.entries({ healthy: true, geofence: 'Home', plugged_in: cars.charger2.connected,
      charging_state: amps2() > 0 ? 'Charging' : 'Stopped', charger_power: amps2() * .69, battery_level: 20, charge_limit_soc: 80, ...values }))
      capture.receive(capture.topic.replace('#', key), String(value), {}); runtime.persist(); },
  };
}

test('editing a request updates the other charger through the real OCPP and Shelly controllers', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  assert.equal(f.view('charger1').plan.state, 'waiting'); assert.equal(f.view('charger2').plan.state, 'waiting');
  const peerBefore = f.reads.charger2, previous = structuredClone(f.view('charger2').plan.periods);
  await f.edit('charger1', { capacityKwh: 25, readyBy: '04:00' });
  assert.notDeepEqual(f.view('charger2').plan.periods, previous, 'The changed shared demand moves the peer schedule');
  assert.ok(f.reads.charger2 > peerBefore, 'The edited joint plan must reach the peer controller before the action finishes');
  assert.equal(f.view('charger2').control.reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false);
});

test('prices arriving after both connections still install the first automatic programs', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  await f.connect('charger1'); await f.connect('charger2');
  await f.plan();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).plan?.state, 'waiting', `${id} must adopt its first plan after prices arrive`);
    assert.equal(f.view(id).plan?.feasible, true);
  }
  assert.equal(f.fields.start_charging.value, false);
});

test('Charge now and Automatic edits refresh peer control without changing its session request', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const request = structuredClone(f.view('charger2').request);
  for (const action of [() => f.runtime.chargeNow('charger1', f.scope('charger1')),
    () => f.automatic('charger1', false), () => f.automatic('charger1', true)]) {
    const reads = f.reads.charger2;
    await action();
    assert.ok(f.reads.charger2 > reads, 'A shared load/permission change immediately reaches the peer');
    assert.deepEqual(f.view('charger2').request, request, 'Peer reconciliation cannot rewrite its user request');
  }
});

test('an edit on Charger 2 revokes a queued Charger 1 native write before dispatch', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const held = f.holdNextOcppWrite();
  const firstEdit = f.edit('charger1', { capacityKwh: 25, readyBy: '04:00' });
  let secondEdit;
  try {
    await Promise.race([held.started, firstEdit.then(() => assert.fail('Expected a queued native schedule replacement'))]);
    secondEdit = f.edit('charger2', { capacityKwh: 15 });
    // Both request edits persist before awaiting controller reconciliation.
    assert.equal(f.view('charger2').request.overrides.capacityKwh, 15);
  } finally { held.release(); }
  await Promise.all([firstEdit, secondEdit]);
  assert.equal(f.revokedOcppWrites, 1, 'The previous joint intent loses transport authority');
  assert.equal(f.view('charger1').control.pending?.accepted, false, 'A rejected queued write cannot be presented as applied');
  f.advance(31_000); await f.settle();
  const first = f.view('charger1');
  assert.equal(first.control.owned.startAt, first.plan.startAt, 'Only the current program remains installed');
  assert.equal(first.control.pending, null);
});

test('switching the shared priority preserves both requests and uses valid joint currents', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const requests = ['charger1', 'charger2'].map(id => structuredClone(f.view(id).request));
  for (const priority of ['charger1', 'charger2', 'balanced']) {
    const before = { ...f.reads };
    await f.priority(priority);
    assert.equal(f.runtime.status().coordination.priority, priority);
    for (const id of ['charger1', 'charger2']) assert.ok(f.reads[id] > before[id], `${priority} must reach ${id}`);
    assert.deepEqual(['charger1', 'charger2'].map(id => f.view(id).request), requests);
    const allocations = f.runtime.status().coordination.allocations;
    assert.ok(allocations.some(row => row.chargers.charger1?.currentA > 0 || row.chargers.charger2?.currentA > 0));
    for (const row of allocations) {
      const currents = ['charger1', 'charger2'].map(id => row.chargers[id]?.currentA ?? 0);
      assert.ok(currents.every(current => current === 0 || current >= 6), 'No sub-minimum simultaneous current');
      assert.ok(currents[0] + currents[1] <= 16 + 1e-9, 'Both chargers share the same 16 A modeled budget');
    }
  }
  await f.restart();
  assert.equal(f.runtime.settings.priority, 'balanced');
  assert.deepEqual(['charger1', 'charger2'].map(id => f.view(id).request), requests);
});

test('an infeasible shared deadline follows the selected priority in forecasts and physical Charger 2 commands', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  // Each vehicle needs over 16 kWh; the shared 16 A supply can provide at most
  // 11.04 kWh before 01:00 UTC. These equal requests cannot both be fulfilled.
  for (const [priority, expected] of [['balanced', [8, 8]], ['charger1', [16, 0]], ['charger2', [0, 16]]]) {
    await f.priority(priority);
    const active = f.runtime.status().coordination.allocations.find(row => row.start <= f.now && row.end > f.now);
    assert.deepEqual(['charger1', 'charger2'].map(id => active.chargers[id].currentA), expected);
    const shortfalls = ['charger1', 'charger2'].map(id => f.view(id).forecast.shortfallGridKwh);
    assert.ok(shortfalls.every(value => value > 0), 'Neither impossible deadline is reported as assured');
    if (priority === 'balanced') assert.ok(Math.abs(shortfalls[0] - shortfalls[1]) < .01);
    else assert.ok(shortfalls[priority === 'charger1' ? 0 : 1] < shortfalls[priority === 'charger1' ? 1 : 0]);
    assert.equal(f.fields.start_charging.value, expected[1] > 0);
    if (expected[1] > 0) assert.equal(f.fields.current_limit.value, expected[1]);
  }
  assert.ok(f.commands.filter(command => command.role === 'current_limit').every(command => command.value >= 6),
    'A zero allocation pauses instead of sending an unsupported current');
});

async function chargingBeforePriceRevision(t) {
  const f = await fixture(t);
  const rates = values => values.map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  f.runtime.tick({ prices: rates([5, 5, 50, 50]) }); await f.settle();
  await f.connect('charger1'); await f.connect('charger2');
  await f.edit('charger1', { capacityKwh: 5 }); await f.edit('charger2', { capacityKwh: 5 });
  f.advance(30 * MINUTE); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).values.charging.value, true);
    assert.ok(f.view(id).control.execution?.planId);
  }
  f.revise = () => f.runtime.tick({ prices: rates([5, 5, 50, 1]), force: true });
  return f;
}

test('new cheaper prices pause both adopted programs while preserving both deadlines and restart state', async t => {
  const f = await chargingBeforePriceRevision(t);
  const prior = ['charger1', 'charger2'].map(id => structuredClone(f.view(id).control.execution));
  f.revise(); await f.settle();
  for (const [index, id] of ['charger1', 'charger2'].entries()) {
    const charger = f.view(id);
    assert.notEqual(charger.control.execution.planId, prior[index].planId);
    assert.equal(charger.control.execution.finalStartAt, START + 3 * HOUR);
    assert.equal(charger.control.execution.deadlineAt, prior[index].deadlineAt);
    assert.equal(charger.forecast.feasible, true);
    assert.ok(charger.forecast.accounting.every(row => row.priceCtPerKwh === 1));
  }
  assert.equal(f.fields.start_charging.value, false, 'The adopted C2 economic pause is independently read back');
  assert.equal(f.runtime.status().coordination.adopted.feasible, true);
  const shellyExecution = structuredClone(f.view('charger2').control.execution);
  await f.restart();
  assert.deepEqual(f.view('charger2').control.execution, shellyExecution);
  assert.equal(f.fields.start_charging.value, false);
});

test('a failed Charger 2 replacement preserves the previously adopted program', async t => {
  const f = await chargingBeforePriceRevision(t);
  const prior = structuredClone(f.view('charger2').control.execution);
  f.rejectShellyWrites(true); f.revise(); await f.settle();
  assert.deepEqual(f.view('charger2').control.execution, prior);
  assert.equal(f.fields.start_charging.value, true, 'The rejected pause did not change native permission');
  assert.notEqual(f.view('charger2').control.execution.planId, f.view('charger2').plan.id);
  assert.equal(f.view('charger2').control.phase, 'uncertain');
});

test('a new peer program does not consume a pending price improvement before joint service is comparable', async t => {
  const f = await fixture(t);
  const rates = values => values.map((price, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price }));
  await f.automatic('charger1', true);
  f.runtime.tick({ prices: rates([5, 5, 50, 50]) }); await f.settle();
  await f.connect('charger1'); await f.edit('charger1', { capacityKwh: 5 });
  f.advance(30 * MINUTE);
  f.cars.charger2.allows = false;
  await f.connect('charger2'); await f.edit('charger2', { capacityKwh: 5 });
  assert.equal(f.view('charger2').control.execution, null);
  // A newly received price publication is assessed in the same reconciliation
  // that enables this peer, before it has any adopted application program.
  f.runtime.prices = rates([5, 5, 50, 1]);
  await f.automatic('charger2', true); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).control.execution.finalStartAt, START + 3 * HOUR);
    assert.equal(f.view(id).forecast.feasible, true);
  }
});

test('Shelly retains an intermediate open period, follows its pause, and releases the final period', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger2');
  const adapter = f.runtime.chargers.charger2.adapter;
  await f.runtime.close(); // Transfer this offline device to one test controller.
  const controller = adapter.createController({ clock: () => f.now, canControl: () => true });
  t.after(() => controller.close());
  const beginning = f.now;
  const plan = { id: 'synthetic-multiple-periods', deadlineAt: beginning + 2 * HOUR, feasible: true,
    periods: [{ startAt: beginning, endAt: beginning + 15 * MINUTE }, { startAt: beginning + HOUR, endAt: null }] };
  await controller.update({ enabled: true, plan });
  assert.equal(controller.status().phase, 'active');
  assert.equal(controller.status().released, false, 'An intermediate period does not discard its planned pause');
  assert.deepEqual(controller.status().execution.periods, plan.periods);
  f.advance(15 * MINUTE); await controller.update({ enabled: true, plan });
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(controller.status().phase, 'waiting');
  f.advance(HOUR); await controller.update({ enabled: true, plan });
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(controller.status().phase, 'released');
  assert.equal(controller.status().released, true);
});

test('a fractional current-allocation handoff still schedules an immediate boundary wakeup', async t => {
  const f = await fixture(t);
  const end = f.now + 15 * MINUTE + .125;
  // Exercise the timer interface with the continuous-time completion boundary
  // emitted by the allocator, independently of its schedule-search choices.
  f.runtime.coordination = { allocations: [{ start: f.now, end, chargers: {} }] };
  f.runtime.scheduleWakeup(f.now);
  assert.equal(f.runtime.boundaryAt, Math.ceil(end));
});

test('a native Charger 2 timer retains authority during peer priority and Charge now changes', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  f.advance(1000); f.schedules.jobs = [{ id: 1, enable: true, timespec: '0 0 4 * * *', calls: [] }];
  await f.settle();
  const baseline = f.commands.length;
  await f.priority('charger2');
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  assert.equal(f.view('charger2').control.snapshot.nativeScheduleActive, true);
  assert.ok(['schedule', 'native-schedule'].includes(f.view('charger2').control.manual?.kind));
  assert.equal(f.view('charger2').control.execution, null, 'Native takeover withdraws the old application execution');
  assert.equal(f.commands.slice(baseline).filter(command => command.chargerId === 'charger2'
    && command.role === 'start_charging' && command.value === true).length, 0, 'Peer changes never bypass the native timer');
});

test('BMW on Charger 1 and Tesla on Charger 2 keep independent identities through overlapping charging and unplug', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger1');
  f.bmw({ atHome: true, pluggedIn: true, charging: true, soc: 20, chargeLimitSoc: 80, usableCapacityKwh: 10 });
  await f.settle();
  f.advance(2000); f.cars.charger1.allows = false; await f.settle();
  f.advance(2000); f.bmw({ charging: false }); await f.settle();
  assert.equal(f.view('charger1').vehicle.id, 'bmw');
  const bmwRequest = structuredClone(f.view('charger1').request);

  f.advance(3 * MINUTE); await f.connect('charger2');
  f.tesla(); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  const teslaRequest = structuredClone(f.view('charger2').request);
  f.advance(1000); f.cars.charger1.allows = true; await f.settle();
  f.bmw({ charging: true }); await f.settle();
  assert.equal(f.view('charger1').vehicle.id, 'bmw');
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.equal(f.view('charger1').values.charging.value, true);
  assert.equal(f.view('charger2').values.charging.value, true);
  assert.deepEqual(f.view('charger1').request, bmwRequest);
  assert.deepEqual(f.view('charger2').request, teslaRequest);

  await f.disconnect('charger1');
  assert.equal(f.view('charger1').vehicle.state, 'disconnected');
  assert.equal(f.view('charger1').request, null);
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.deepEqual(f.view('charger2').request, teslaRequest);
});

test('simultaneous indistinguishable power cannot assign one Tesla to either physical charger', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger1'); await f.connect('charger2'); f.tesla(); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).vehicle.state, 'conflict');
    assert.equal(f.view(id).vehicle.id, null);
    assert.equal(f.view(id).values.connected.value, true, 'Ambiguous identity does not erase the real connection');
  }
});
