import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingSnapshot, createEaseeScheduleAdapter, easeeChargerTelemetry, manualScheduleWindow, nextScheduleOccurrence,
  normalizeScheduleState } from '../src/charging/easee.js';
import { updateSupplyEstimate } from '../src/charging/supply.js';

const now = Date.parse('2026-09-15T18:00:00Z');
const hour = 3_600_000;
const schedule = normalizeScheduleState({ enabled: 'none' });
const easeeRows = (values = {}) => Object.entries({ 22: 32, 23: 32, 24: 32, 31: true,
  47: 32, 48: 32, 96: 0, 100: 'B', 104: 20, 109: 2, 110: 30, 111: 32, 112: 32,
  113: 32, 120: 0, 230: 16, 231: 13, 232: 15, 250: true, ...values })
  .map(([id, value]) => ({ id: Number(id), value, timestamp: new Date(now - 1000).toISOString() }));
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

test('Easee disconnect boundaries use only timestamped negative source observations', () => {
  const mode = { id: 109, value: 1, timestamp: new Date(now - 60_000).toISOString() };
  const pilot = { id: 100, value: 'A', timestamp: new Date(now - 30_000).toISOString() };
  for (const at of [now, now + 120_000]) {
    const snapshot = chargingSnapshot([mode, pilot], schedule, at);
    assert.equal(snapshot.pluggedIn, false);
    assert.equal(snapshot.disconnectedAt, now - 30_000, 'Repeated polls preserve the source event time');
  }
  assert.equal(chargingSnapshot([mode], schedule, now).disconnectedAt, now - 60_000);
  assert.equal(chargingSnapshot([pilot], schedule, now).disconnectedAt, now - 30_000);
  assert.equal(chargingSnapshot([mode, { ...pilot, timestamp: new Date(now + 1).toISOString() }], schedule, now).disconnectedAt, now - 60_000);
  assert.equal(chargingSnapshot([{ ...mode, timestamp: new Date(now + 1).toISOString() }], schedule, now).disconnectedAt, null);
  assert.equal(chargingSnapshot([{ ...pilot, timestamp: null }], schedule, now).disconnectedAt, null);
  assert.equal(chargingSnapshot([{ ...mode, value: 3 }, { ...pilot, value: 'C' }], schedule, now).disconnectedAt, null);
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
  assert.equal(manualScheduleWindow(daily, now), null, 'Multiple periods require explicit resumption');
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

const supplySnapshot = ({ allowance = [6, 8, 7], property = [19, 17, 18], charger = [0, 0, 0], at = now - 10 * 60_000,
  allocation = 27, online = true, ...extra } = {}) => ({
  online, readAt: now, mode: charger.some(value => value > 0) ? 3 : 2, externalLoadBalancing: true,
  limits: { allocationA: allocation, circuitA: [16, 16, 16] },
  supply: { availableCurrentA: allowance, reportedPropertyCurrentA: property, propertyCurrentA: null,
    chargerCurrentA: charger, allocationA: allocation,
    observationTimes: { allowance: [at, at, at], property: [at, at, at], charger: [at, at, at] } }, ...extra,
});

test('sparse ten-minute meter events establish a nighttime budget independently of the momentary allowance', () => {
  const estimate = updateSupplyEstimate(null, supplySnapshot(), now);
  assert.equal(estimate.available, true);
  assert.equal(estimate.quality, 'observed-budget');
  assert.deepEqual(estimate.budgetCurrentA, [25, 25, 25]);
  assert.equal(estimate.measuredAt, now - 10 * 60_000);
  const charging = updateSupplyEstimate(null, supplySnapshot({ allowance: [20, 20, 20],
    property: [21, 21, 21], charger: [16, 16, 16] }), now);
  assert.deepEqual(charging.budgetCurrentA, [25, 25, 25], 'The controlled charger is subtracted exactly once');
});

test('supply evidence survives short sparse-event gaps without pretending polling measured a new budget', () => {
  const snapshot = supplySnapshot(), estimate = updateSupplyEstimate(null, snapshot, now);
  const later = now + hour;
  const held = updateSupplyEstimate(estimate, { ...snapshot, readAt: later }, later);
  assert.equal(held.available, true);
  assert.equal(held.samples.length, 1);
  assert.equal(held.measuredAt, estimate.measuredAt);
  assert.deepEqual(held.budgetCurrentA, [25, 25, 25]);
  assert.equal(updateSupplyEstimate(held, { ...snapshot, readAt: later, online: false }, later).available, false);
  assert.equal(updateSupplyEstimate(held, { ...snapshot, readAt: later + 24 * hour }, later + 24 * hour).budgetCurrentA, null);
  const changed = { ...snapshot, limits: { ...snapshot.limits, allocationA: 20 },
    supply: { ...snapshot.supply, reportedPropertyCurrentA: null } };
  assert.equal(updateSupplyEstimate(held, changed, now).budgetCurrentA, null, 'A changed installation config invalidates old capacity evidence');
});

for (const transport of ['cloud', 'ocpp']) test(`${transport} idle charger meter reports cannot reweight held property capacity evidence after restart`, () => {
  const provider = transport === 'ocpp' ? { transport, mode: undefined, connectorStatus: 'SuspendedEVSE' } : { mode: 2 };
  let estimate = null;
  for (const at of [now - 12 * 60_000, now - 11 * 60_000]) estimate = updateSupplyEstimate(estimate,
    supplySnapshot({ allowance: [10, 10, 10], property: [15, 15, 15], at, ...provider }), now);
  const snapshot = supplySnapshot({ allowance: [10, 10, 10], property: [7, 7, 7],
    charger: [.01, .01, .01], ...provider });
  estimate = updateSupplyEstimate(estimate, snapshot, now);
  assert.equal(estimate.samples.length, 3);
  assert.deepEqual(estimate.samples.at(-1).budgetCurrentA.map(value => Number(value.toFixed(2))), [16.99, 16.99, 16.99],
    'The accepted sample retains the measured idle-current subtraction');
  assert.deepEqual(estimate.budgetCurrentA, [25, 25, 25]);
  const original = structuredClone(snapshot), sourceAt = estimate.measuredAt;
  for (let report = 1; report <= 15; report++) {
    // A current-version restart must not turn the same capacity observation
    // into a new vote each time an otherwise idle charger reports its meter.
    if (report === 8) estimate = JSON.parse(JSON.stringify(estimate));
    const at = now + report * 1000;
    const held = { ...snapshot, readAt: at, supply: { ...snapshot.supply,
      chargerCurrentA: report % 2 ? [.009, .011, .01] : [0, 0, 0],
      observationTimes: { ...snapshot.supply.observationTimes, charger: [at, at, at] } } };
    estimate = updateSupplyEstimate(estimate, held, at);
    assert.deepEqual(estimate.budgetCurrentA, [25, 25, 25], 'Repeated low held capacity cannot displace the other measurements');
    assert.equal(estimate.samples.length, 3, 'Idle meter chatter is not independent supply evidence');
    assert.equal(estimate.measuredAt, sourceAt);
  }
  assert.deepEqual(snapshot, original, 'Deduplication never rewrites the source readings');
});

test('new property or allowance source observations still contribute while the charger is idle', () => {
  const snapshot = supplySnapshot({ at: now - 1000 });
  let estimate = updateSupplyEstimate(null, snapshot, now);
  const propertyReport = structuredClone(snapshot);
  propertyReport.supply.observationTimes.property = [now, now, now];
  estimate = updateSupplyEstimate(estimate, propertyReport, now);
  assert.equal(estimate.samples.length, 2, 'A fresh property measurement remains independent even with unchanged values');
  const allowanceReport = structuredClone(propertyReport);
  allowanceReport.supply.availableCurrentA = [5, 7, 6];
  allowanceReport.supply.observationTimes.allowance = [now, now, now];
  estimate = updateSupplyEstimate(estimate, allowanceReport, now);
  assert.equal(estimate.samples.length, 3);
  assert.deepEqual(estimate.samples.at(-1).budgetCurrentA, [24, 24, 24]);
  assert.equal(estimate.measuredAt, now, 'Only the genuine capacity contributors determine idle sample age');
  assert.equal(updateSupplyEstimate(estimate, allowanceReport, now).samples.length, 3, 'Polling the same new report remains idempotent');
});

test('active or non-idle charger measurements retain their contribution to supply evidence', () => {
  const snapshot = supplySnapshot({ allowance: [10, 10, 10], property: [21, 21, 21],
    charger: [6, 6, 6], at: now - 1000 });
  let estimate = updateSupplyEstimate(null, snapshot, now);
  const charging = structuredClone(snapshot);
  charging.supply.chargerCurrentA = [8, 8, 8];
  charging.supply.observationTimes.charger = [now, now, now];
  estimate = updateSupplyEstimate(estimate, charging, now);
  assert.equal(estimate.samples.length, 2);
  assert.deepEqual(estimate.samples.at(-1).budgetCurrentA, [23, 23, 23], 'A genuine change in draw still changes the inferred household share');
  const freshSameDraw = structuredClone(charging);
  freshSameDraw.supply.observationTimes.charger = [now + 1, now + 1, now + 1];
  assert.equal(updateSupplyEstimate(estimate, freshSameDraw, now + 1).samples.length, 3);
  for (const extra of [{ mode: 3, charger: [.01, .01, .01] }, { mode: 2, charger: [.1, 0, 0] },
    ...['Charging', 'Faulted', 'Unavailable', undefined].map(connectorStatus => ({ transport: 'ocpp',
      connectorStatus, mode: 2, charger: [.01, .01, .01] }))]) {
    const before = supplySnapshot({ ...extra, at: now - 1000 });
    const after = structuredClone(before);
    after.supply.observationTimes.charger = [now, now, now];
    assert.equal(updateSupplyEstimate(updateSupplyEstimate(null, before, now), after, now).samples.length, 2,
      'Only confirmed idle readings qualify for deduplication of charger reports');
  }
});

test('allocation is only a charging ceiling and clipped or absent readings cannot identify property capacity', () => {
  const clipped = updateSupplyEstimate(null, supplySnapshot({ allowance: [27, 27, 27], property: [3, 4, 5] }), now);
  assert.equal(clipped.quality, 'observed-lower-bound');
  assert.deepEqual(clipped.budgetCurrentA, [30, 31, 32]);
  const missing = supplySnapshot({ property: null });
  assert.equal(updateSupplyEstimate(null, missing, now).available, false, 'Allocation alone never becomes the property budget');
  assert.equal(updateSupplyEstimate(null, supplySnapshot({ allowance: [0, 0, 0], property: [40, 40, 40] }), now).available, false,
    'A clipped zero may indicate overload, not a 40 A property supply');
  assert.equal(updateSupplyEstimate(null, supplySnapshot({ at: now - hour }), now).available, false);
  assert.equal(updateSupplyEstimate(null, supplySnapshot({ at: now + 1 }), now).available, false);
});
