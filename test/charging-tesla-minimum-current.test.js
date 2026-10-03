import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTeslaMinimumCurrent, measuredChargingCurrent } from '../src/charging/vehicle.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';

const START = Date.parse('2026-10-03T12:00:00Z'), NOW = START + 30_000;
const field = value => ({ value, available: true, measuredAt: NOW - 1000, retained: false });
const physical = (current, power, phases = 3) => ({ providerConnected: true,
  connected: field(true), charging: field(true), powerKw: field(power),
  phaseCurrentA: field(Array.from({ length: 3 }, (_, index) => index < phases ? current : 0)) });
function fixture() {
  const minimumPhysical = physical(6, 4.1), first = physical(16, 11);
  const tesla = { association: 'synthetic-tesla', healthy: true, pluggedIn: true, atHome: true, charging: true,
    phases: 3, actualCurrentA: 6, actualPowerKw: 4,
    fields: { charger_actual_current: { value: 6, receivedAt: NOW - 2000, retained: false },
      charger_power: { value: 4, receivedAt: NOW - 2000, retained: false } } };
  const options = { physical: minimumPhysical, peers: [first], minimumPhysical,
    connectedAt: START, now: NOW, chargingAt: [START],
    currentTest: { id: 'synthetic-test', phase: 'active', connectedAt: START, sessionId: 'synthetic-session',
      startedAt: START + 5000, confirmedAt: START + 10_000, expiresAt: START + 90_000, appliedCurrentA: 6 } };
  return { tesla, options, first, minimumPhysical };
}

test('verified minimum on Charger 2 distinguishes the Tesla by measured current on either charger', () => {
  const { tesla, options, first, minimumPhysical } = fixture();
  assert.ok(matchTeslaMinimumCurrent(tesla, options), 'The 6 A Tesla matches the physical 6 A charger only');
  tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
  tesla.fields.charger_actual_current.value = 16; tesla.fields.charger_power.value = 11;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Tesla at 16 A is not assigned to the charger tested at 6 A');
  assert.ok(matchTeslaMinimumCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }),
    'Fresh affirmative Tesla current supports Charger 1 independently of Charger 2 having a different car');
});

test('Tesla phase metadata does not veto corroborated measured current and power', () => {
  for (const phases of [2, 1, null, undefined]) {
    const { tesla, options, first, minimumPhysical } = fixture();
    if (phases === undefined) delete tesla.phases;
    else tesla.phases = phases;
    assert.ok(matchTeslaMinimumCurrent(tesla, options),
      'A three-phase charger at 6 A and 4.1 kW matches the independent Tesla 6 A and 4 kW reports');
    tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
    tesla.fields.charger_actual_current.value = 16; tesla.fields.charger_power.value = 11;
    assert.ok(matchTeslaMinimumCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }),
      'The same electrical comparison also identifies Tesla on Charger 1');
  }
});

test('ignoring Tesla phase metadata still requires current and power to agree with physical measurements', () => {
  const { tesla, options } = fixture();
  tesla.phases = 2;
  tesla.actualPowerKw = 1.4;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null,
    'Equal current cannot corroborate single-phase Tesla power against measured three-phase power');
  tesla.actualPowerKw = 4;
  tesla.actualCurrentA = 8;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Matching power alone cannot replace matching actual current');
  tesla.actualCurrentA = 6;
  options.physical.phaseCurrentA = field([6, 8, 6]);
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Uneven measured phases remain inconclusive');
});

test('confirmed limit without physical response never identifies Tesla', () => {
  for (const phase of ['proposed', 'applying', 'restoring', 'uncertain', 'restored', 'superseded']) {
    const { tesla, options } = fixture(); options.currentTest.phase = phase;
    assert.equal(matchTeslaMinimumCurrent(tesla, options), null, phase);
  }
  const { tesla, options } = fixture(); options.minimumPhysical = physical(16, 11);
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'A 6 A request with 16 A measured draw has not taken effect');
  options.minimumPhysical = physical(6, 4.1); options.currentTest.confirmedAt = NOW - 1000;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'A response must settle before matching');
});

test('equalizer overlap and missing peer measurements leave simultaneous identification unresolved', () => {
  const cases = [physical(6, 4.1), physical(6.8, 4.6), { connected: field(null) },
    { ...physical(16, 11), phaseCurrentA: { available: false, value: null } }];
  for (const peer of cases) {
    const { tesla, options } = fixture(); options.peers = [peer];
    assert.equal(matchTeslaMinimumCurrent(tesla, options), null);
  }
  const { tesla, options } = fixture(); options.peers = [{ connected: field(false) }];
  assert.ok(matchTeslaMinimumCurrent(tesla, options), 'A positively disconnected peer is not an alternative match');
});

test('a held pre-test Tesla current cannot place an unchanged high-current report on Charger 1', () => {
  const { tesla, options, first, minimumPhysical } = fixture();
  tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
  tesla.fields.charger_actual_current = { value: 16, receivedAt: START, retained: false };
  tesla.fields.charger_power = { value: 11, receivedAt: START, retained: false };
  assert.equal(matchTeslaMinimumCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }), null,
    'A healthy feed holding an earlier 16 A report could be a delayed Tesla on Charger 2 before its reduction');
  delete tesla.fields.charger_actual_current;
  assert.equal(matchTeslaMinimumCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }), null);
});

test('a confirmed stopped peer is excluded only by Tesla evidence received after that stop', () => {
  const { tesla, options } = fixture();
  const stoppedAt = NOW - 3000;
  const stoppedField = value => ({ ...field(value), measuredAt: stoppedAt });
  options.peers = [{ providerConnected: true, connected: stoppedField(true), charging: stoppedField(false),
    powerKw: stoppedField(0), phaseCurrentA: stoppedField([0, 0, 0]) }];
  assert.ok(matchTeslaMinimumCurrent(tesla, options), 'Live Tesla charging received after the peer stop excludes that peer');
  tesla.fields.charger_actual_current.receivedAt = stoppedAt - 1;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Older Tesla current cannot prove charging continued after the peer stopped');
  tesla.fields.charger_actual_current.receivedAt = NOW - 2000;
  options.peers[0].charging.available = false;
  assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Missing stopped-state evidence stays unknown');
});

test('retained, future, stale and consumed Tesla current cannot identify a connection', () => {
  for (const change of [
    f => { f.tesla.fields.charger_actual_current.retained = true; },
    f => { f.tesla.fields.charger_actual_current.receivedAt = NOW + 1; },
    f => { f.tesla.fields.charger_actual_current.receivedAt = START - 120_000; },
    f => { f.options.consumedCurrentAt = NOW - 2000; },
    f => { f.tesla.healthy = false; },
    f => { f.tesla.pluggedIn = false; },
    f => { f.tesla.atHome = false; },
    f => { f.options.currentTest.expiresAt = NOW; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(matchTeslaMinimumCurrent(f.tesla, f.options), null);
  }
});

test('Tesla unplug and departure boundaries fence minimum-current evidence from an earlier vehicle connection', () => {
  for (const boundary of [{ field: 'plugged_in', value: false }, { field: 'geofence', value: 'Away' }]) {
    const { tesla, options } = fixture();
    tesla.fields.geofence = { value: 'Home', receivedAt: NOW, retained: false };
    tesla.boundaries = [{ ...boundary, association: tesla.association, at: NOW - 1500 }];
    assert.equal(matchTeslaMinimumCurrent(tesla, options), null,
      'Returning home or replugging cannot reuse pre-boundary current while current context is positive again');
    tesla.fields.charger_actual_current.receivedAt = NOW - 1000;
    assert.equal(matchTeslaMinimumCurrent(tesla, options), null, 'Power from the earlier connection is also excluded');
    tesla.fields.charger_power.receivedAt = NOW - 1000;
    assert.ok(matchTeslaMinimumCurrent(tesla, options));
    tesla.fields.charger_actual_current.receivedAt = NOW - 2000;
    tesla.fields.charger_power.receivedAt = NOW - 2000;
    tesla.boundaries[0].association = 'another-synthetic-tesla';
    assert.ok(matchTeslaMinimumCurrent(tesla, options), 'An unrelated feed boundary cannot reinterpret this vehicle’s evidence');
  }
});

test('actual phase measurements exclude stale, inferred and uneven current instead of using charger ceilings', () => {
  for (const value of [
    { ...field([6, 6, 6]), measuredAt: NOW + 1 },
    { ...field([6, 6, 6]), measuredAt: NOW - 61_000 },
    { ...field([6, 6, 6]), retained: true },
    { ...field([6, 6, 6]), assumed: true },
    field([6, null, 6]), field([6, 8, 6]), field([0, 0, 0]),
  ]) {
    assert.equal(measuredChargingCurrent({ ...physical(6, 4.1), phaseCurrentA: value }, NOW), null);
  }
  assert.equal(measuredChargingCurrent({ currentA: field(6), availableCurrentA: field(6) }, NOW), null);
  const singlePhase = physical(6, 1.4, 1);
  assert.deepEqual(measuredChargingCurrent(singlePhase, NOW), { value: 6, phases: 1, measuredAt: NOW - 1000 });
  const { tesla, options } = fixture(); tesla.phases = 1; tesla.actualPowerKw = 1.4;
  options.physical = singlePhase; options.minimumPhysical = singlePhase;
  assert.ok(matchTeslaMinimumCurrent(tesla, options), 'Single-phase current is not divided by three');
  tesla.phases = 3;
  assert.ok(matchTeslaMinimumCurrent(tesla, options), 'Measured single-phase current and corroborating power suffice despite different Tesla phase metadata');
});

test('Tesla current duplicates and unknown gaps preserve original evidence and retained provenance', () => {
  for (const retained of [false, true]) {
    let now = START;
    const capture = createChargingTeslaCapture({ clock: () => now }); capture.setConnected(true);
    const receive = value => capture.receive(`${capture.topic.slice(0, -1)}charger_actual_current`, String(value), {}, now);
    capture.receive(`${capture.topic.slice(0, -1)}charger_actual_current`, '6', { retain: retained }, now);
    const original = capture.snapshot().fields.charger_actual_current;
    now += 10_000; receive(6);
    assert.deepEqual(capture.snapshot().fields.charger_actual_current, original);
    now += 10_000; receive('unknown');
    now += 10_000; receive(6);
    assert.deepEqual(capture.snapshot().fields.charger_actual_current, original);
    now += 10_000; receive(16);
    const changed = capture.snapshot().fields.charger_actual_current;
    assert.equal(changed.receivedAt, now); assert.equal(changed.retained, false);
    capture.close();
  }
});
