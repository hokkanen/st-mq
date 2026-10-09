import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../../src/storage/store.js';
import { ChargingRuntime } from '../../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../../src/charging/ocpp.js';
import { easeeChargerTelemetry } from '../../src/charging/easee.js';
import { createShellyEvseAdapter } from '../../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../../src/charging/teslamate.js';

export const START = Date.parse('2026-01-15T00:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE;
const triple = value => [value, value, value];
const prices = [20, 1, 1, 20].map((price, index) => ({ start: START + index * HOUR,
  end: START + (index + 1) * HOUR, price }));

// Production runtime, planner, controllers, transport adapters and vehicle feeds.
// Only the physical devices/broker and acquisition clocks are simulated. Device
// settings keep their source clocks; reads do not manufacture native changes.
export async function fixture(t, { limiter = true, budgetA = 16, notifyRuntime = false, feedsSynchronized = true } = {}) {
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
    ? Math.max(0, Math.min(cars.charger1.demandA, cars.charger1.equalizerResponds === false
      ? cars.charger1.demandA : budgetA - household.currentA - amps2())) : 0;
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
    if (store.getState(runtime.key) === null) {
      // Joint-control scenarios choose each charger's Automatic preference.
      for (const item of Object.values(runtime.chargers)) item.controls.enabled = false;
      runtime.refreshSettings();
    }
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
      readAllowanceTelemetry: () => easeeChargerTelemetry({ online: true, readAt: now,
        pluggedIn: cars.charger1.connected, externalLoadBalancing: true,
        limits: { chargerA: 16, cableA: 16, circuitA: triple(16), equalizerAvailableA: supply().availableCurrentA },
        observations: Object.fromEntries([230, 231, 232].map((id, index) => [id, { value: supply().availableCurrentA[index], at: now }])),
        allowanceEvidence: { source: 'easee-cloud', connected: true, synchronized: household.feedsSynchronized, receivedAt: now, epoch: 'fixture-epoch' },
      }, { now }),
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
    await runtime.planningFlight;
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
