import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { createShellyController, createShellyEvseAdapter } from '../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { chargerDisplay } from '../chart/charging.js';

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
async function fixture(t, { limiter = true, budgetA = 16, notifyRuntime = false, feedsSynchronized = true } = {}) {
  let now = START, runtime, heldOcppWrite = null, heldShellyCurrentWrite = null, heldShellyRoleRead = null,
    revokedOcppWrites = 0, rejectShellyWrites = false;
  const store = new Store(':memory:'), client = new EventEmitter();
  const commands = [], profiles = new Map(), reads = { charger1: 0, charger2: 0 };
  const household = { currentA: 0, sourceAt: null, feedsSynchronized };
  const cars = { charger1: { connected: false, allows: true, demandA: 8, connectedAt: null },
    charger2: { connected: false, allows: true, demandA: 8, connectedAt: null } };
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-joint-easee', equalizer_id: 'synthetic-joint-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-joint' }, teslamate: { enabled: true },
  }, charging: { defaults: { capacityKwh: 10 }, vehicles: {
    bmw: { mqttTopic: 'synthetic/joint/bmw', defaults: { capacityKwh: 10 } },
    tesla: { defaults: { capacityKwh: 10 } },
  }, chargers: { charger2: { enabled: true, deviceId: 'synthetic-joint-evse', topicPrefix: 'synthetic/joint/evse',
    limiterEnabled: limiter, mainFuseA: triple(budgetA), marginA: triple(0), dwellMs: 0, rampA: 16 } } } };
  const fields = { current_limit: { value: 16, at: now }, start_charging: { value: true, at: now },
    work_state: { value: 'charger_free', at: now } };
  const schedules = { jobs: [] };
  const paused = () => [...profiles.values()].some(profile => Date.parse(profile.validFrom) <= now
    && Date.parse(profile.validTo) > now && profile.transactionId === cars.charger1.connectedAt / 1000);
  const amps2 = () => cars.charger2.connected && cars.charger2.allows && fields.start_charging.value
    ? Math.min(cars.charger2.demandA, fields.current_limit.value) : 0;
  const amps1 = () => cars.charger1.connected && cars.charger1.allows && !paused()
    ? Math.max(0, Math.min(cars.charger1.demandA, budgetA - household.currentA - amps2())) : 0;
  const physical2 = () => {
    const state = !cars.charger2.connected ? 'charger_free' : amps2() > 0 ? 'charger_charging'
      : !fields.start_charging.value ? 'charger_pause' : 'charger_wait';
    if (fields.work_state.value !== state) fields.work_state = { value: state, at: now };
    return { total_power: amps2() * .69, total_act_energy: 0,
      ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
        { voltage: 230, current: amps2(), power: amps2() * .23 }])) };
  };
  const roles = ['current_limit', 'start_charging', 'work_state', 'phase_info'];
  client.subscribe = (topics, _options, cb) => cb(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, cb) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    if (frame.method === 'Object.GetStatus' && role === 'phase_info' && heldShellyRoleRead?.armed) {
      const held = heldShellyRoleRead; heldShellyRoleRead = null; held.entered();
      held.wait.then(() => client.publish(_topic, payload, _options, cb));
      return;
    }
    if (frame.method === 'Number.Set' && role === 'current_limit' && heldShellyCurrentWrite) {
      const held = heldShellyCurrentWrite; heldShellyCurrentWrite = null; held.entered();
      held.wait.then(() => client.publish(_topic, payload, _options, cb));
      return;
    }
    let result, error;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: 'synthetic-joint-evse', model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') { reads.charger2++; result = { state: 'running' }; }
    else if (frame.method === 'Schedule.List') result = schedules;
    else if (frame.method.endsWith('.GetConfig')) result = { id: 200 + roles.indexOf(role), owner: 'service:0', access: 'crw',
      options: ['charger_free', 'charger_charging', 'charger_pause', 'charger_wait', 'charger_end'], min: 6, max: 16, meta: { ui: { step: 1 } } };
    else if (frame.method.endsWith('.Set')) {
      if (frame.method === 'Number.Set' && role === 'current_limit' && heldShellyRoleRead) heldShellyRoleRead.armed = true;
      commands.push({ chargerId: 'charger2', method: frame.method, role, value: frame.params.value, at: now });
      if (rejectShellyWrites) error = { code: -1, message: 'Synthetic command rejection' };
      else { now += 1000; fields[role] = { value: frame.params.value, at: now }; physical2(); result = null; }
    } else {
      const meter = physical2();
      result = { value: role === 'phase_info' ? meter : fields[role].value,
        last_update_ts: (role === 'phase_info' ? now : fields[role].at) / 1000,
        ...(fields[role]?.source ? { source: fields[role].source } : {}) };
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
    const supply = () => ({ availableCurrentA: triple(Math.max(0, budgetA - household.currentA - amps2())),
      propertyCurrentA: triple(household.currentA + amps1() + amps2()), chargerCurrentA: triple(amps1()),
      feedEvidence: Object.fromEntries(['property','charger','allowance'].map(key => [key,
        {connected:true,online:true,synchronized:household.feedsSynchronized,epoch:'fixture-epoch'}])),
      voltageV: triple(230), observationTimes: { allowance: triple(now), property: triple(household.sourceAt ?? now), charger: triple(now), voltage: triple(now) } });
    const snapshot = () => {
      reads.charger1++;
      return { transport: 'ocpp', scope, connectionId: 'synthetic-joint-socket', readAt: now, online: true,
        connectorStatus: !cars.charger1.connected ? 'Available' : paused() ? 'SuspendedEVSE' : amps1() > 0 ? 'Charging' : 'SuspendedEV', statusAt: now,
        transactionId: cars.charger1.connected ? cars.charger1.connectedAt / 1000 : null,
        transactionStartedAt: cars.charger1.connectedAt, transactionConfirmed: cars.charger1.connected,
        pluggedIn: cars.charger1.connected, powerKw: amps1() * .69, powerAt: now,
        appControl: null, limits: { chargerA: 16, cableA: 16, circuitA: triple(16), allocationA: 32, equalizerAvailableA: triple(Math.max(0, budgetA - amps2())) },
        supply: supply() };
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
    ocpp.readCurrentSupply = () => ({ online: true, supply: supply() });
    if (!shelly) {
      shelly = createShellyEvseAdapter({ config: runtime.configuration.chargers.charger2, broker: config.connections.mqtt,
        client, store, engine: { get charging() { return notifyRuntime ? runtime : null; },
          recorder: { recordEnergy() {}, energyGap() {}, flush() {} } }, clock: () => now, canControl: () => true });
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
  return { get runtime() { return runtime; }, get now() { return now; }, store, cars, household, commands, fields, schedules, reads, view, automatic, scope, settle,
    closeAdapter() { shelly.close(); },
    get revokedOcppWrites() { return revokedOcppWrites; },
    rejectShellyWrites(value) { rejectShellyWrites = value; },
    holdNextShellyCurrentWrite() {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      heldShellyCurrentWrite = { entered, wait };
      return { started, release };
    },
    holdShellyReadAfterCurrentWrite() {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      heldShellyRoleRead = { entered, wait, armed: false };
      return { started, release };
    },
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

test('Shelly schedules, takes over and starts with no TeslaMate or BMW evidence', async t => {
  const f = await fixture(t);
  await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
  let view = f.view('charger2');
  assert.equal(view.vehicle.id, null);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, false);
  assert.equal(view.control.reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false);
  assert.ok(view.plan.periods.length > 0);
  assert.ok(chargerDisplay(view, { now: f.now }).periodRows.length > 0, 'Missing vehicle feeds must not hide the plan');
  f.advance(1000);
  f.fields.start_charging = { value: false, at: f.now };
  await f.settle();
  view = f.view('charger2');
  assert.equal(view.control.manual.kind, 'stop');
  await f.runtime.useAutomatic('charger2', { ...f.scope('charger2'), controlRevision: view.controls.revision,
    takeoverToken: view.control.takeover.token });
  view = f.view('charger2');
  assert.equal(view.control.manual, null);
  assert.equal(view.control.reason, 'economic-wait');
  assert.equal(view.vehicle.id, null);
  f.advance(view.plan.periods[0].startAt - f.now);
  await f.settle();
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.view('charger2').vehicle.id, null, 'Charging permission must not fabricate a vehicle match');
});

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

for (const mode of ['native', 'charge-now', 'automatic'])
  test(`live Shelly priority ignores conservative forecast caps during ${mode} charging`, async t => {
    const f = await fixture(t, { budgetA: 25 });
    await f.connect('charger1'); await f.connect('charger2'); await f.priority('charger2');
    if (mode === 'charge-now') await f.runtime.chargeNow('charger2', f.scope('charger2'));
    if (mode === 'automatic') {
      await f.automatic('charger2', true); await f.plan();
      const starts = f.view('charger2').plan.periods[0].startAt;
      if (starts > f.now) f.advance(starts - f.now);
      await f.settle();
    }
    await f.plan();
    f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
    f.household.currentA = 9;
    // A forecast can reserve capacity for a secondary deadline or assume a
    // higher household scenario. It is deliberately distinct from the live
    // property/peer/meter inputs above.
    f.runtime.coordination.allocations = [{ start: f.now, end: f.now + MINUTE,
      chargers: { charger1: { currentA: 8 }, charger2: { currentA: 8, currentLimitA: 8 } } }];
    f.advance(5000);
    await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.current_limit.value, 16);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.currentA, 16);
    assert.equal(f.runtime.allocationContext().allocationA, null);
    assert.equal(f.runtime.allocationContext().reservationA, 0);
  });

for (const chargeNow of [false, true])
  test(`directional priority changes real current allocation with Automatic off and Charge now ${chargeNow}`, async t => {
    const f = await fixture(t);
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
    if (chargeNow) await f.runtime.chargeNow('charger2', f.scope('charger2'));
    await f.priority('charger1'); await f.plan();
    assert.equal(f.fields.start_charging.value, false);
    assert.equal(f.view('charger1').values.actualCurrentA.value, 16);
    await f.priority('charger2'); await f.plan();
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.fields.current_limit.value, 16);
    assert.equal(f.view('charger1').values.actualCurrentA.value, 0, 'Native Equalizer yields the peer current');
    assert.equal(f.view('charger2').request.chargeNow === true, chargeNow);
  });

test('balanced live allocation resumes a priority-owned native pause without enabling Automatic', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.priority('charger1'); await f.plan();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.view('charger2').control.ownedPause, true);
  const stoppedAt = f.now;
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.fields.start_charging.value, true);
  assert.deepEqual(f.runtime.allocationContext().easee.currents, [8, 8, 8], 'Fresh source phases confirm Equalizer recovery');
  assert.equal(f.view('charger2').settings.enabled, false);
  assert.ok(f.commands.some(row => row.role === 'start_charging' && row.value === true && row.at > stoppedAt));
  f.advance(5000); f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  await f.settle();
  await f.priority('charger1'); f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.start_charging.value, false, 'A later native Stop revokes the previous owned resume duty');
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
});

test('balanced live allocation lets a confirmed open peer recover from zero Equalizer allowance', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.priority('charger2'); await f.plan();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.view('charger1').values.actualCurrentA.value, 0);
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.fields.start_charging.value, true);
  assert.deepEqual(f.runtime.allocationContext().easee.currents, [8, 8, 8]);
  assert.equal(f.view('charger1').request.chargeNow, true);
});

test('balanced live allocation retains a running turn below two valid pilots', async t => {
  const f = await fixture(t, { budgetA: 11 });
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.priority('charger2'); await f.plan();
  assert.equal(f.fields.current_limit.value, 11);
  f.advance(5000); await f.priority('balanced');
  const commands = f.commands.length;
  for (let sample = 0; sample < 3; sample++) {
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.current_limit.value, 11);
    assert.equal(f.fields.start_charging.value, true);
    assert.deepEqual(f.runtime.allocationContext().easee.currents, [0, 0, 0]);
  }
  assert.equal(f.commands.slice(commands).some(row => row.role === 'start_charging'), false);
});

test('balanced live allocation does not reserve an idle peer merely because it is connected', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
  await f.priority('charger2'); await f.plan();
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.runtime.allocationContext().peerDemandA, null);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true);
});

for (const feedsSynchronized of [false, true])
  test(`unscheduled Charger 1 priority ignores an economic cap with no peer demand; synchronized feeds ${feedsSynchronized}`, async t => {
    const f = await fixture(t, { budgetA: 25, feedsSynchronized });
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
    await f.runtime.chargeNow('charger2', f.scope('charger2'));
    await f.priority('charger1'); await f.plan();
    f.runtime.coordination.allocations = [{ start: f.now, end: f.now + MINUTE,
      chargers: { charger2: { currentA: 7, currentLimitA: 7 } } }];
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.runtime.allocationContext().peerDemandA, null);
    assert.equal(f.fields.current_limit.value, feedsSynchronized ? 16 : 12);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.fallback, !feedsSynchronized);
  });

test('ordinary load adjustment responds before the minute tick without cloud reads or economic replanning', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger1'); await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  f.cars.charger2.demandA = 16;
  const beforeReads = f.reads.charger1;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.household.currentA = 17; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.view('charger2').limiter.mode, 'limited');
  assert.equal(f.view('charger2').limiter.allowanceA, 8);
  assert.equal(f.reads.charger1, beforeReads);
  assert.equal(planning.mock.callCount(), 0, 'A live current correction reuses the still-valid same-session plan');
  f.household.currentA = 20; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.start_charging.value, false, 'Sub-minimum headroom pauses instead of writing an invalid current');
  assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
  assert.equal(f.view('charger2').limiter.allowanceA, 0);
  f.household.currentA = 0; f.advance(5000);
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true, 'Recovered headroom resumes only the controller-owned fuse pause');
  assert.equal(f.view('charger2').limiter.mode, 'unrestricted');
  assert.equal(f.view('charger2').limiter.applicationStatus, 'confirmed');
  assert.ok(f.commands.filter(row => row.role === 'current_limit').every(row => row.value >= 6));
  f.advance(5000); f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  const count = f.commands.length;
  await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
  assert.equal(f.commands.slice(count).some(row => row.role === 'start_charging' && row.value), false);
  assert.ok(planning.mock.callCount() > 0, 'A newer native instruction invalidates the cached plan basis');
});

test('ordinary current adjustment preserves held source age and falls back when the feed loses synchronization', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  f.household.sourceAt = f.now - MINUTE;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 16, 'Old unchanged values remain usable on synchronized matching feeds');
  assert.equal(f.view('charger2').control.limiter.fallback, false);
  assert.equal(f.runtime.allocationContext().property.times[0], f.household.sourceAt);
  f.household.feedsSynchronized = false;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.view('charger2').control.limiter.fallback, true);
  assert.equal(f.view('charger2').limiter.mode, 'fallback');
  assert.equal(f.view('charger2').limiter.reason, 'feed-unsynchronized');
  assert.equal(f.runtime.allocationContext().property.times[0], f.household.sourceAt);
});

test('limiter history reads the published snapshot without entering identification, planning or view updates', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const expected = f.view('charger2').limiter, item = f.runtime.chargers.charger2;
  const state = () => structuredClone({ identification: item.identification, request: item.request,
    plan: item.plan, revision: f.runtime.revision });
  const before = state(), commands = f.commands.length;
  const observers = ['views', 'telemetry', 'status', 'updatePlan', 'identificationControl'].map(name =>
    t.mock.method(f.runtime, name, () => { throw new Error(`History must not enter ${name}`); }));
  try {
    f.runtime.recordLimiterHistory();
    f.runtime.chargers.charger2.adapter.accept('current_limit', {
      value: f.fields.current_limit.value, last_update_ts: f.fields.current_limit.at / 1000 });
    assert.equal(f.runtime.limiterHistoryError, null);
    assert(observers.every(observer => observer.mock.callCount() === 0));
    assert.deepEqual(state(), before, 'Recording cannot advance a session, identification attempt or plan');
    assert.equal(f.commands.length, commands);
    const row = f.store.db.prepare("SELECT raw FROM observations WHERE signal='shelly_limiter_mode' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(row.raw).limiter, expected, 'The card and recorder share one snapshot projection');
  } finally { for (const observer of observers) observer.mock.restore(); }
});

test('limiter observation rejects another connection, replica authority and replaced callbacks without blocking native reads', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const item = f.runtime.chargers.charger2, control = item.controller.status();
  assert.equal(f.runtime.limiterStatus(control, f.now).mode, 'unrestricted');
  for (const snapshot of [
    { ...control.snapshot, generation: control.snapshot.generation + 1 },
    { ...control.snapshot, session: { ...control.snapshot.session, sessionId: 'synthetic-reconnected', connectedAt: f.now + 1 } },
  ]) assert.equal(f.runtime.limiterStatus({ ...control, snapshot }, f.now).mode, 'unknown',
    'A prior decision cannot cross a native generation or physical connection boundary');
  const rows = () => f.store.db.prepare("SELECT id,raw FROM observations WHERE signal='shelly_limiter_mode' ORDER BY id").all();
  const initial = rows(), generation = item.adapterGeneration, authority = f.runtime.canControl;
  const accept = value => {
    f.advance(1000); f.fields.current_limit = { value, at: f.now };
    assert.equal(item.adapter.accept('current_limit', { value, last_update_ts: f.now / 1000 }), true);
    assert.equal(item.adapter.snapshot().fields.current_limit.value, value);
  };
  try {
    f.runtime.canControl = () => false; accept(14);
    assert.deepEqual(rows(), initial, 'Read-only replica observations cannot append authoritative limiter history');
    f.runtime.canControl = authority; item.adapterGeneration++;
    accept(13);
    assert.deepEqual(rows(), initial, 'A replaced controller callback cannot publish through its previous generation');
    item.adapterGeneration = generation;
    const failing = t.mock.method(f.runtime, 'recordLimiterHistory', () => { throw new Error('Synthetic history failure'); });
    try { accept(12); assert.equal(failing.mock.callCount(), 1); }
    finally { failing.mock.restore(); }
    assert.deepEqual(rows(), initial, 'Observer failure cannot partially append history or reject the accepted native reading');
    await item.controller.close(); accept(11);
    assert.deepEqual(rows(), initial, 'Closing the controller detaches its adapter publication observer');
    const restarted = createShellyController({ adapter: item.adapter,
      initialState: f.store.getState(f.runtime.ownershipKey('charger2')), clock: () => f.now, canControl: () => true });
    try { assert.equal(f.runtime.limiterStatus(restarted.status(), f.now).mode, 'unknown',
      'Restored diagnostics cannot publish a current decision even when native generation numbers repeat'); }
    finally { await restarted.close(); }
  } finally { f.runtime.canControl = authority; item.adapterGeneration = generation; }
});

test('limiter history records publication before a five-second current-command await without writing from status reads', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  assert.equal(f.view('charger2').limiter.mode, 'unrestricted');
  const history = () => f.store.db.prepare(`SELECT c.start_at,c.end_at,o.id,o.raw FROM recorder_coverage c
    JOIN observations o ON o.id=c.observation_id WHERE c.signal='shelly_limiter_mode' ORDER BY c.id`)
    .all().map(row => ({ ...row, status: JSON.parse(row.raw).limiter }));
  const held = f.holdNextShellyCurrentWrite();
  f.household.currentA = 17; f.advance(5000);
  const changedAt = f.now, flight = f.runtime.reconcileShellyObservation();
  await held.started;
  try {
    const live = f.view('charger2').limiter, rows = history(), last = rows.at(-1);
    assert.equal(live.mode, 'limited'); assert.equal(live.allowanceA, 8); assert.equal(live.applicationStatus, 'pending');
    assert.deepEqual(last.status, live, 'Published limiter decision must already be recorded while the command is waiting');
    assert.equal(last.start_at, changedAt, 'Use the actual publication clock, not a later poll or a backdated estimate');
    assert(rows.filter(row => row.status.mode === 'unrestricted').every(row => row.end_at <= changedAt));
    for (let i = 0; i < 10; i++) {
      f.advance(500);
      assert.deepEqual(f.runtime.status().chargers.find(charger => charger.id === 'charger2').limiter, live);
      assert.deepEqual(history(), rows, 'Half-second status observers cannot write or renew historical coverage');
    }
  } finally { held.release(); await flight; }
  const final = history().at(-1);
  assert.equal(final.status.mode, 'limited'); assert.equal(final.status.allowanceA, 8);
  assert.equal(final.status.applicationStatus, 'confirmed'); assert.equal(final.status.appliedCurrentA, 8);
  assert.equal(f.runtime.status().limiterHistoryError, null);
});

test('limiter history publishes native readback while another role refresh is still awaiting its reply', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const history = () => f.store.db.prepare(`SELECT c.start_at,c.end_at,o.id,o.raw FROM recorder_coverage c
    JOIN observations o ON o.id=c.observation_id WHERE c.signal='shelly_limiter_mode' ORDER BY c.id`)
    .all().map(row => ({ ...row, status: JSON.parse(row.raw).limiter }));
  const held = f.holdShellyReadAfterCurrentWrite();
  f.household.currentA = 17; f.advance(5000);
  const flight = f.runtime.reconcileShellyObservation();
  await held.started;
  try {
    const control = f.runtime.chargers.charger2.controller.status(), live = f.view('charger2').limiter;
    assert.equal(control.pending?.stage, 'accepted');
    assert.equal(control.snapshot.fields.current_limit.value, 8);
    assert.equal(live.allowanceA, 8); assert.equal(live.appliedCurrentA, 8); assert.equal(live.applicationStatus, 'pending');
    const rows = history(), last = rows.at(-1), readbackAt = control.snapshot.fields.current_limit.receivedAt;
    assert.deepEqual(last.status, live, 'Published native setting cannot wait for an unrelated outstanding role reply');
    assert.equal(last.start_at, readbackAt);
    assert(rows.filter(row => row.status.appliedCurrentA === 16).every(row => row.end_at <= readbackAt));
    for (let i = 0; i < 10; i++) {
      f.advance(500);
      assert.deepEqual(f.runtime.status().chargers.find(charger => charger.id === 'charger2').limiter, live);
      assert.deepEqual(history(), rows, 'Status GET cannot renew stale readback coverage or create historical rows');
    }
  } finally { held.release(); await flight; }
  assert.equal(history().at(-1).status.applicationStatus, 'confirmed');
  assert.equal(history().at(-1).status.appliedCurrentA, 8);
});

test('unchanged owned balancing pauses do not produce transient limiter-mode rows on each poll', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.priority('charger1'); await f.plan();
  assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
  const rows = () => f.store.db.prepare("SELECT id,raw FROM observations WHERE signal='shelly_limiter_mode' ORDER BY id").all();
  const initial = rows();
  for (let i = 0; i < 3; i++) {
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.view('charger2').limiter.mode, 'paused-by-balancing');
    assert.deepEqual(rows(), initial, 'Publishing an unchanged decision must preserve its complete mode before notifying history');
  }
});

test('the existing Shelly poll drives one serialized local reconciliation and stops after close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t, { budgetA: 25, notifyRuntime: true });
  await f.connect('charger2'); await f.priority('charger2'); await f.plan();
  const controller = f.runtime.chargers.charger2.controller;
  const originalUpdate = controller.update;
  let release, entered = 0;
  const held = new Promise(resolve => { release = resolve; });
  controller.update = async input => { entered++; await held; return originalUpdate(input); };
  const readsBefore = f.reads.charger1;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.household.currentA = 17; f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1);
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1, 'A second poll cannot queue or revoke the in-flight current command');
  release(); await f.runtime.chargers.charger2.reconcileFlight;
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.reads.charger1, readsBefore);
  assert.equal(planning.mock.callCount(), 0);
  await f.runtime.close();
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered, 1, 'A closed runtime cannot receive more controller updates from the adapter poll');
  f.closeAdapter();
  const finalReads = f.reads.charger2;
  f.advance(5000); t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.reads.charger2, finalReads, 'Closing the adapter stops its existing poll timer');
});

test('current reconciliation replans at the original cache deadline and discards a disconnected Charge now scope', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2'); await f.priority('charger2'); await f.runtime.chargeNow('charger2', f.scope('charger2')); await f.plan();
  const originalSession = f.view('charger2').request.sessionId;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.advance(31_000); await f.runtime.reconcileShellyObservation();
  assert.ok(planning.mock.callCount() > 0, 'The faster limiter loop does not extend the accepted planning cache');
  f.cars.charger2.connected = false;
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(f.view('charger2').request, null);
  f.advance(5000); f.cars.charger2.connected = true; f.cars.charger2.connectedAt = f.now;
  await f.runtime.reconcileShellyObservation();
  assert.notEqual(f.view('charger2').request.sessionId, originalSession);
  assert.notEqual(f.view('charger2').request.chargeNow, true);
});

test('settled disconnected polling reuses its bounded empty plan without charging or replanning', async t => {
  const f = await fixture(t);
  await f.plan();
  const before = f.commands.length;
  const planning = t.mock.method(f.runtime, 'updatePlan');
  f.advance(5000); await f.runtime.reconcileShellyObservation();
  assert.equal(planning.mock.callCount(), 0);
  assert.equal(f.commands.length, before);
  assert.equal(f.view('charger2').request, null);
});

test('a failed local reconciliation retains its diagnostic without replaying a command', async t => {
  const f = await fixture(t);
  await f.connect('charger2'); await f.plan();
  const controller = f.runtime.chargers.charger2.controller;
  t.mock.method(controller, 'update', async () => { throw new Error('Synthetic state persistence unavailable'); });
  const commands = f.commands.length;
  f.advance(5000);
  await assert.rejects(f.runtime.reconcileShellyObservation(), /Synthetic state persistence unavailable/);
  assert.equal(f.view('charger2').error, 'charging-reconciliation-unavailable');
  assert.equal(f.runtime.chargers.charger2.reconcileFlight, null);
  assert.equal(f.commands.length, commands);
});

for (const limiter of [true, false]) for (const priority of ['balanced', 'charger1', 'charger2'])
  test(`economic permission stays stable through changing actual draw with ${priority} priority and limiter ${limiter}`, async t => {
    const f = await fixture(t, { limiter });
    await f.connect('charger1'); await f.connect('charger2');
    for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
    await f.automatic('charger1', true); await f.automatic('charger2', true); await f.priority(priority); await f.plan();
    const execution = () => ['charger1', 'charger2'].map(id => f.view(id).control.execution);
    const initial = structuredClone(execution()), before = f.commands.length;
    for (const [first, second] of [[16,16], [8,8], [16,6], [6,16], [8,8]]) {
      f.cars.charger1.demandA = first; f.cars.charger2.demandA = second;
      f.advance(30_000);
      for (const role of ['current_limit', 'start_charging']) f.fields[role] = { ...f.fields[role], at: f.now, source: 'sys' };
      await f.settle();
      assert.deepEqual(execution(), initial, 'Own load changes must not replace accepted charging periods');
      for (const id of ['charger1', 'charger2']) assert.notEqual(f.view(id).identification.phase, 'pausing');
    }
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), [], 'Routine draw readback must not alternate charging permissions');
  });

test('economic current sharing still responds to actual peer stopping and returning', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.priority('charger1'); await f.plan();
  const before = f.commands.length;
  f.cars.charger1.demandA = 0; f.advance(30_000); await f.settle();
  assert.equal(f.fields.start_charging.value, true, 'A physically idle peer need not waste the remaining live capacity');
  f.cars.charger1.demandA = 16; f.advance(30_000); await f.settle();
  assert.equal(f.fields.start_charging.value, false, 'A returning preferred load must immediately regain its capacity');
  assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging').map(command => command.value), [true, false]);
});

for (const priority of ['balanced', 'charger1', 'charger2'])
  test(`economic waiting survives polling and restart with ${priority} priority`, async t => {
    const f = await fixture(t, { limiter: false });
    await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
    await f.connect('charger1'); await f.connect('charger2'); await f.priority(priority); await f.plan();
    const periods = () => ['charger1', 'charger2'].map(id => f.view(id).control.execution?.periods);
    const accepted = structuredClone(periods());
    assert.ok(accepted.every(rows => rows?.[0].startAt > f.now));
    let before = f.commands.length;
    for (let tick = 0; tick < 6; tick++) { f.advance(30_000); await f.settle(); }
    assert.deepEqual(periods(), accepted);
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), []);
    await f.restart();
    assert.deepEqual(periods(), accepted, 'Restart must preserve accepted economic waiting');
    before = f.commands.length;
    for (let tick = 0; tick < 6; tick++) { f.advance(30_000); await f.settle(); }
    assert.deepEqual(periods(), accepted);
    assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
      || command.chargerId === 'charger1'), []);
  });

test('balanced economic allocation keeps a short-capacity turn through repeated readback', async t => {
  const f = await fixture(t, { budgetA: 6 });
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  const active = () => f.runtime.status().coordination.allocations.find(row => row.start <= f.now && row.end > f.now);
  const winner = () => Object.entries(active().chargers).find(([, row]) => row.currentA >= 6)?.[0];
  const first = winner(), before = f.commands.length;
  assert.ok(first);
  for (let tick = 0; tick < 12; tick++) {
    f.advance(30_000); await f.settle();
    assert.equal(winner(), first, 'Polling must preserve the existing 15-minute allocation slice');
  }
  assert.deepEqual(f.commands.slice(before).filter(command => command.role === 'start_charging'
    || command.chargerId === 'charger1'), [], 'An unchanged economic allocation must not cause start/stop commands');
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

test('independent BMW evidence and a verified Tesla minimum-current response retain both identities through overlapping charging and unplug', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger1');
  f.bmw({ atHome: true, pluggedIn: true, charging: true, soc: 20, chargeLimitSoc: 80, usableCapacityKwh: 10 });
  await f.settle();
  f.advance(2000); f.cars.charger1.allows = false; await f.settle();
  f.advance(2000); f.bmw({ charging: false }); await f.settle();
  assert.equal(f.view('charger1').vehicle.id, 'bmw');
  const bmwRequest = structuredClone(f.view('charger1').request);

  f.advance(1000); f.cars.charger1.allows = true; await f.settle();
  f.bmw({ charging: true }); await f.settle();
  f.advance(3 * MINUTE); await f.connect('charger2');
  f.tesla({ charger_actual_current: 8, charger_phases: 3 }); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, null, 'Similar power and start timing cannot identify the second connected car');
  assert.equal(f.fields.current_limit.value, 6, 'The scoped comparison uses the verified minimum with economic limiting disabled');
  f.advance(6000); f.tesla({ charger_actual_current: 6, charger_phases: 3 }); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, null, 'A first current sample must settle and remain consistent');
  f.advance(6000); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.equal(f.fields.current_limit.value, 16, 'Identification restores the previous native current setting');
  const teslaRequest = structuredClone(f.view('charger2').request);
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
    assert.equal(f.view(id).vehicle.state, 'identifying');
    assert.equal(f.view(id).vehicle.id, null);
    assert.equal(f.runtime.chargers[id].vehicleConflict, null, 'Weak coincident power does not manufacture a saved identity conflict');
    assert.equal(f.view(id).values.connected.value, true, 'Ambiguous identity does not erase the real connection');
  }
});
