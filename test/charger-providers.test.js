import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSnapshot, createEaseeScheduleAdapter, easeeChargerTelemetry, manualScheduleWindow, nextScheduleOccurrence,
  normalizeScheduleState } from '../src/charging/easee.js';
import { createChargingTeslaCapture, decodeChargingTeslaField, teslamateChargerTelemetry,
  teslamateChargerAssignment } from '../src/charging/teslamate.js';

const now = Date.parse('2026-09-15T18:00:00Z');
const hour = 3_600_000;
const schedule = normalizeScheduleState({ enabled: 'none' });
const easeeRows = (values = {}) => Object.entries({ 22: 32, 23: 32, 24: 32, 31: true,
  47: 32, 48: 32, 96: 0, 100: 'B', 104: 20, 109: 2, 110: 30, 111: 32, 112: 32,
  113: 32, 120: 0, 230: 16, 231: 13, 232: 15, 250: true, ...values })
  .map(([id, value]) => ({ id: Number(id), value, timestamp: new Date(now - 1000).toISOString() }));
const capture = () => {
  const result = createChargingTeslaCapture({ settings: { carId: '1', homeGeofence: 'Home', chargerAssignment: 'bmw' } });
  result.setConnected(true);
  return result;
};
const send = (capture, field, value, receivedAt = now - 1000, packet = {}) =>
  capture.receive(`teslamate/cars/1/${field}`, String(value), packet, receivedAt);

test('provider adapters expose the same canonical signals with distinct control capabilities', () => {
  const easee = easeeChargerTelemetry(chargingSnapshot(easeeRows(), schedule, now), { now });
  const tesla = teslamateChargerTelemetry(capture().snapshot(), { now });
  for (const key of ['capacityKwh', 'soc', 'minimumSoc', 'connected', 'currentA', 'actualCurrentA',
    'phases', 'voltageV', 'powerKw', 'charging', 'scheduledStartAt', 'scheduledEndAt']) {
    assert.equal(typeof easee[key], 'object', key);
    assert.equal(typeof tesla[key], 'object', key);
    assert.ok(Object.hasOwn(easee[key], 'available'), key);
    assert.ok(Object.hasOwn(tesla[key], 'available'), key);
  }
  assert.equal(easee.capabilities.scheduling, true);
  assert.equal(tesla.capabilities.scheduling, false);
  assert.equal(easee.capabilities.externalLoadBalancing, true);
  assert.equal(easee.capabilities.currentControl, false, 'The current schedule adapter never writes dynamic current');
  assert.equal(tesla.capabilities.currentControl, false);
});

test('Easee current estimate uses the smallest charger, cable and Equalizer allowance', () => {
  let telemetry = easeeChargerTelemetry(chargingSnapshot(easeeRows(), schedule, now), { now });
  assert.equal(telemetry.currentA.value, 13);
  assert.equal(telemetry.maxCurrentA.value, 20, 'Native schedules use the fixed ceiling, not instantaneous Equalizer headroom');
  assert.equal(telemetry.currentA.source, 'easee-equalizer');
  assert.equal(telemetry.phases.value, 3);
  assert.equal(telemetry.powerKw.value, 0, 'An idle charger still has a current allowance');
  telemetry = easeeChargerTelemetry(chargingSnapshot(easeeRows({ 231: 0 }), schedule, now), { now });
  assert.equal(telemetry.currentA.value, 0, 'An Equalizer pause is valid automatic evidence');
  telemetry = easeeChargerTelemetry(chargingSnapshot(easeeRows({ 231: null }), schedule, now), { now });
  assert.equal(telemetry.currentA.available, false, 'Missing allowance cannot silently become the charger maximum');
  telemetry = easeeChargerTelemetry(chargingSnapshot(easeeRows({ 231: null }), schedule, now, null,
    { externalLoadBalancing: false }), { now });
  assert.equal(telemetry.currentA.value, 20);
  assert.equal(telemetry.currentA.source, 'easee');
});

test('Easee preserves observation provenance and withdraws stale or offline state', () => {
  const snapshot = chargingSnapshot(easeeRows(), schedule, now);
  const telemetry = easeeChargerTelemetry(snapshot, { now });
  assert.equal(telemetry.powerKw.measuredAt, now - 1000);
  assert.equal(telemetry.powerKw.receivedAt, now);
  assert.equal(telemetry.currentA.measuredAt, null, 'A combined estimate has no fabricated single measurement time');
  assert.ok(telemetry.currentA.inputs.every(row => row.measuredAt === now - 1000));
  assert.equal(easeeChargerTelemetry(snapshot, { now: now + 6 * 60_000 }).connected.available, false);
  assert.equal(easeeChargerTelemetry({ ...snapshot, online: false }, { now }).connected.value, null);
});

test('Easee uses property AC voltage and assumes three phases before a vehicle is connected', () => {
  const snapshot = chargingSnapshot(easeeRows({ 100: 'A', 109: 1, 110: null }), schedule, now, null,
    { supply: { voltageV: [228, 230, 232], chargerCurrentA: [0, 0, 0] } });
  const telemetry = easeeChargerTelemetry(snapshot, { now });
  assert.equal(telemetry.connected.value, false);
  assert.equal(telemetry.phases.value, 3);
  assert.equal(telemetry.phases.assumed, true);
  assert.equal(telemetry.currentA.value, 13);
  assert.equal(telemetry.voltageV.value, 230);
  assert.equal(telemetry.voltageV.source, 'easee-equalizer');
  assert.equal(telemetry.actualCurrentA.value, 0);
  assert.equal(easeeChargerTelemetry({ ...snapshot, supply: { voltageV: [228, null, 232] } }, { now }).voltageV.available, false);
});

test('Easee adapter reads aligned Equalizer voltage and property/charger currents without a main-fuse setting', async () => {
  const requests = [];
  const property = Object.entries({ 31: 8, 32: 9, 33: 10, 34: 228, 35: 230, 36: 232 })
    .map(([id, value]) => ({ id: Number(id), value, timestamp: new Date(now - 1000).toISOString() }));
  let propertyUnavailable = false;
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-charger', equalizerId: 'synthetic-equalizer', clock: () => now,
    request: async (url, options) => {
      requests.push({ url, method: options.method });
      if (url.includes('/api/equalizers/')) return { maxAllocatedCurrent: 20 };
      if (url.endsWith('/schedules')) return schedule;
      if (url.includes('/state/synthetic-charger/')) return easeeRows({ 183: 2, 184: 3, 185: 4 });
      if (url.includes('/state/synthetic-equalizer/')) {
        if (propertyUnavailable) throw new Error('Synthetic property read failure');
        return property;
      }
      throw new Error('Unexpected synthetic endpoint');
    } });
  const snapshot = await adapter.read();
  assert.deepEqual(snapshot.supply.availableCurrentA, [16, 13, 15]);
  assert.deepEqual(snapshot.supply.propertyCurrentA, [8, 9, 10]);
  assert.deepEqual(snapshot.supply.chargerCurrentA, [2, 3, 4]);
  assert.deepEqual(snapshot.supply.voltageV, [228, 230, 232]);
  assert.equal(snapshot.supply.allocationA, 20);
  assert.equal(adapter.normalize(snapshot).voltageV.value, 230);
  assert.ok(requests.every(request => request.method === 'GET'));
  propertyUnavailable = true;
  const partial = await adapter.read();
  assert.deepEqual(partial.supply.availableCurrentA, [16, 13, 15]);
  assert.equal(partial.supply.propertyCurrentA, null);
  assert.equal(partial.supply.voltageV, null);
  assert.equal(adapter.normalize(partial).connected.value, true);
});

test('stale household currents cannot inflate headroom but unchanged charger event readings remain usable', async () => {
  let current = 0;
  const property = Object.entries({ 31: 8, 32: 9, 33: 10, 34: 228, 35: 230, 36: 232 })
    .map(([id, value]) => ({ id: Number(id), value, timestamp: new Date(now - 10 * 60_000).toISOString() }));
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-charger', equalizerId: 'synthetic-equalizer', clock: () => now,
    request: async url => {
      if (url.includes('/api/equalizers/')) return { maxAllocatedCurrent: 20 };
      if (url.endsWith('/schedules')) return schedule;
      if (url.includes('/state/synthetic-equalizer/')) return property;
      if (url.includes('/state/synthetic-charger/')) return easeeRows({ 183: current, 184: 0, 185: 0 })
        .map(row => [183, 184, 185].includes(row.id) ? { ...row, timestamp: new Date(now - 24 * hour).toISOString() } : row);
      throw new Error('Unexpected synthetic endpoint');
    } });
  let snapshot = await adapter.read();
  assert.equal(snapshot.supply.propertyCurrentA, null);
  assert.deepEqual(snapshot.supply.availableCurrentA, [16, 13, 15]);
  assert.deepEqual(snapshot.supply.chargerCurrentA, [0, 0, 0]);
  assert.deepEqual(snapshot.supply.voltageV, [228, 230, 232]);
  assert.deepEqual(snapshot.supply.observationTimes.voltage, [1, 2, 3].map(() => now - 10 * 60_000));
  for (current of [-1, 'invalid']) {
    snapshot = await adapter.read();
    assert.equal(snapshot.supply.chargerCurrentA, null);
    assert.equal(adapter.normalize(snapshot).actualCurrentA.available, false);
  }
  current = 0;
  for (const row of property) row.timestamp = new Date(now - 1000).toISOString();
  property.push({ ...property[0], value: 30 });
  snapshot = await adapter.read();
  assert.equal(snapshot.supply.propertyCurrentA, null, 'Conflicting same-time meter values cannot become a planning budget');
});

test('TeslaMate keeps requested and measured current separate, with individual receipt times', () => {
  const vehicle = capture();
  send(vehicle, 'geofence', 'Home'); send(vehicle, 'plugged_in', true);
  send(vehicle, 'battery_level', 42, now - 4000, { retain: true });
  send(vehicle, 'charge_limit_soc', 85, now - 3500);
  send(vehicle, 'charge_current_request', 16, now - 3000);
  send(vehicle, 'charge_current_request_max', 13, now - 2000);
  send(vehicle, 'charger_actual_current', 0, now - 1000);
  send(vehicle, 'charger_power', 0, now - 500);
  send(vehicle, 'scheduled_charging_start_time', new Date(now + hour).toISOString(), now);
  const telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.soc.value, 42);
  assert.equal(telemetry.soc.receivedAt, now - 4000);
  assert.equal(telemetry.soc.measuredAt, null);
  assert.equal(telemetry.soc.retained, true);
  assert.equal(telemetry.minimumSoc.value, 85);
  assert.equal(telemetry.currentA.value, 13);
  assert.equal(telemetry.currentA.receivedAt, now - 3000);
  assert.equal(telemetry.actualCurrentA.value, 0);
  assert.equal(telemetry.powerKw.value, 0);
  assert.equal(telemetry.scheduledStartAt.value, now + hour);
  send(vehicle, 'charge_current_request', 'invalid');
  assert.equal(teslamateChargerTelemetry(vehicle.snapshot(), { now }).currentA.available, false);
});

test('a vehicle plugged in away from home is not connected to the household charger', () => {
  const vehicle = capture();
  send(vehicle, 'plugged_in', true);
  assert.equal(teslamateChargerTelemetry(vehicle.snapshot(), { now }).connected.value, null);
  send(vehicle, 'geofence', 'Elsewhere');
  assert.equal(teslamateChargerTelemetry(vehicle.snapshot(), { now }).connected.value, false);
  send(vehicle, 'geofence', 'Home');
  assert.equal(teslamateChargerTelemetry(vehicle.snapshot(), { now }).connected.value, true);
  vehicle.setConnected(false);
  assert.equal(teslamateChargerTelemetry(vehicle.snapshot(), { now }).connected.available, false);
});

test('vehicle charging power belongs to the household charger only after home connection is confirmed', () => {
  const vehicle = capture();
  send(vehicle, 'plugged_in', true); send(vehicle, 'charging_state', 'Charging');
  send(vehicle, 'charger_power', 11); send(vehicle, 'charger_actual_current', 16);
  let telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.charging.available, false);
  assert.equal(telemetry.powerKw.available, false);
  assert.equal(telemetry.actualCurrentA.available, false);
  send(vehicle, 'geofence', 'Elsewhere');
  telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.charging.value, false);
  assert.equal(telemetry.powerKw.available, false);
  assert.equal(telemetry.actualCurrentA.available, false);
  send(vehicle, 'geofence', 'Home');
  telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.charging.value, true);
  assert.equal(telemetry.powerKw.value, 11);
  assert.equal(telemetry.actualCurrentA.value, 16);
  send(vehicle, 'plugged_in', false);
  telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.charging.value, false);
  assert.equal(telemetry.powerKw.available, false);
});

test('unsupported capacity, target and schedule end are never fabricated from other telemetry', () => {
  const vehicle = capture();
  send(vehicle, 'battery_level', 50);
  assert.equal(decodeChargingTeslaField('usable_battery_capacity', 75), undefined);
  assert.equal(decodeChargingTeslaField('time_to_full_charge', 2), undefined);
  const telemetry = teslamateChargerTelemetry({ ...vehicle.snapshot(), timeToFullCharge: 2,
    usableCapacityKwh: 75, scheduledEndAt: now + 2 * hour }, { now });
  assert.equal(telemetry.capacityKwh.available, false);
  assert.equal(telemetry.scheduledEndAt.available, false);
  assert.equal(telemetry.scheduledEndKind, null);
  const easee = easeeChargerTelemetry(chargingSnapshot(easeeRows(), schedule, now), { now });
  assert.equal(easee.soc.available, false);
  assert.equal(easee.minimumSoc.available, false);
  assert.equal(easee.capacityKwh.available, false);
});

test('native schedule display distinguishes a real stop from a delayed start with no stop', () => {
  const delayed = normalizeScheduleState({ enabled: 'delayed', delayed: {
    timezone: 'UTC', startTime: '19:00', maximumAmps: 16,
  } });
  assert.deepEqual(nextScheduleOccurrence(delayed, now), {
    startAt: now + hour, endAt: null, endKind: null, kind: 'delayed',
  });
  const daily = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [
    { startTime: '19:00', stopTime: '20:00', maximumAmps: 16 },
    { startTime: '20:00', stopTime: '22:00', maximumAmps: 10 },
  ] } });
  assert.deepEqual(nextScheduleOccurrence(daily, now), {
    startAt: now + hour, endAt: now + 4 * hour, endKind: 'scheduled-stop', kind: 'daily',
  });
  assert.equal(manualScheduleWindow(daily, now, now + 24 * hour).windowEndAt, now + 4 * hour, 'All periods in the readiness cycle retain manual priority until the last end');
});

test('past Tesla schedules do not roll forward into a new charging event', () => {
  const vehicle = capture();
  send(vehicle, 'scheduled_charging_start_time', new Date(now - hour).toISOString());
  const telemetry = teslamateChargerTelemetry(vehicle.snapshot(), { now });
  assert.equal(telemetry.scheduledStartAt.available, false);
  assert.equal(telemetry.scheduledStartAt.value, null);
});

test('a continuously open recurrence has no fabricated daily stop boundary', () => {
  const daily = normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC', periods: [
    { startTime: '00:00', stopTime: '12:00', maximumAmps: 16 },
    { startTime: '12:00', stopTime: '00:00', maximumAmps: 16 },
  ] } });
  assert.deepEqual(nextScheduleOccurrence(daily, now), {
    startAt: null, endAt: null, endKind: null, kind: 'daily', continuous: true,
  });
});

test('Tesla assignment separates confirmed vehicle routing from an uncertain external load', () => {
  assert.deepEqual(teslamateChargerAssignment({ assignment: 'auto' }), {
    chargerId: null, uncertain: true, reservationChargerId: 'charger2',
  });
  assert.equal(teslamateChargerAssignment({ assignment: 'auto' }, { identified: 'easee' }).chargerId, 'charger1');
  assert.equal(teslamateChargerAssignment({ assignment: 'auto' }, { identified: 'bmw' }).chargerId, 'charger2');
  assert.equal(teslamateChargerAssignment({ assignment: 'bmw' }, { identified: 'easee' }).chargerId, 'charger2',
    'An explicit assignment is the owner decision, not a hint for automatic attribution');
});


test('the reported Equalizer allowance stays distinct from a zero dynamic charging limit', () => {
  const telemetry = easeeChargerTelemetry(chargingSnapshot(easeeRows({ 47: 16, 48: 0, 230: 16, 231: 16, 232: 16 }), schedule, now), { now });
  assert.equal(telemetry.currentA.value, 0);
  assert.equal(telemetry.availableCurrentA.value, 16);
  assert.equal(telemetry.maxCurrentA.value, 16);
  assert.deepEqual(telemetry.availableCurrentA.inputs.map(input => input.id), [230, 231, 232]);
});

test('a charger observation arriving during the state request is not discarded as a future reading', async () => {
  let clock = now;
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-charger', clock: () => clock,
    request: async url => {
      if (url.endsWith('/schedules')) return schedule;
      clock += 25;
      return easeeRows().map(row => ({ ...row, timestamp: new Date(clock).toISOString() }));
    } });
  const reading = await adapter.read();
  assert.equal(reading.readAt, now + 25);
  assert.equal(reading.controlKnown, true);
  assert.equal(reading.limits.chargerA, 32);
});
