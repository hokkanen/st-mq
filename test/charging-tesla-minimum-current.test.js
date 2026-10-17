import test from 'node:test';
import assert from 'node:assert/strict';
import { matchTeslaCurrent, measuredChargingCurrent } from '../src/charging/vehicle.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';

const START = Date.parse('2026-10-03T12:00:00Z'), NOW = START + 30_000;
const field = value => ({ value, available: true, measuredAt: NOW - 1000, retained: false });
const physical = (current, power, phases = 3) => ({ providerConnected: true,
  connected: field(true), charging: field(true), powerKw: field(power),
  phaseCurrentA: field(Array.from({ length: 3 }, (_, index) => index < phases ? current : 0)) });
function fixture({ current = 6, power = 4.1, teslaPower = 4, phases = 3 } = {}) {
  const minimumPhysical = physical(current, power, phases), first = physical(16, 11);
  const tesla = { association: 'synthetic-tesla', healthy: true, pluggedIn: true, atHome: true, charging: true,
    phases: 3, actualCurrentA: current, actualPowerKw: teslaPower,
    fields: { charger_actual_current: { value: current, receivedAt: NOW - 2000, retained: false },
      charger_power: { value: teslaPower, receivedAt: NOW - 2000, retained: false } } };
  const options = { physical: minimumPhysical, peers: [first], minimumPhysical,
    connectedAt: START, now: NOW, chargingAt: [START],
    currentTest: { id: 'synthetic-test', phase: 'active', connectedAt: START, sessionId: 'synthetic-session',
      startedAt: START + 5000, confirmedAt: START + 10_000, expiresAt: START + 90_000, appliedCurrentA: 6 } };
  return { tesla, options, first, minimumPhysical };
}

test('verified minimum on Charger 2 distinguishes the Tesla by measured current on either charger', () => {
  const { tesla, options, first, minimumPhysical } = fixture();
  assert.ok(matchTeslaCurrent(tesla, options), 'The 6 A Tesla matches the physical 6 A charger only');
  tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
  tesla.fields.charger_actual_current.value = 16; tesla.fields.charger_power.value = 11;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Tesla at 16 A is not assigned to the charger tested at 6 A');
  assert.ok(matchTeslaCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }),
    'Fresh affirmative Tesla current supports Charger 1 independently of Charger 2 having a different car');
});

test('a confirmed 6 A offer identifies uniquely matching Tesla draw below the offered current', () => {
  for (const [current, power, teslaPower] of [[2, 1.4, 1], [3, 2.1, 2], [4, 2.8, 3], [5, 3.5, 3]]) {
    const { tesla, options, first, minimumPhysical } = fixture({ current, power, teslaPower });
    assert.ok(matchTeslaCurrent(tesla, options), `${current} A of matching actual draw identifies Tesla on Charger 2`);
    assert.equal(options.currentTest.appliedCurrentA, 6, 'Lower vehicle draw does not change the confirmed offer');
    tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
    tesla.fields.charger_actual_current.value = 16; tesla.fields.charger_power.value = 11;
    assert.ok(matchTeslaCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }),
      'A positive unique match on Charger 1 also remains usable when Charger 2 draws below its offer');
  }
});

test('lower single-phase draw identifies Tesla with corroborating positive power', () => {
  const { tesla, options } = fixture({ current: 3, power: .69, teslaPower: 1, phases: 1 });
  assert.ok(matchTeslaCurrent(tesla, options),
    'Measured 3 A single-phase draw and independently reported 3 A agree despite a 6 A offer');
});

test('lower draw preserves positive, unique, fresh current and power requirements', () => {
  const cases = [
    ['zero draw', f => {
      f.options.physical.phaseCurrentA = field([0, 0, 0]); f.options.physical.powerKw = field(0);
      f.tesla.actualCurrentA = 0; f.tesla.actualPowerKw = 0;
    }],
    ['equal peer draw', f => { f.options.peers = [physical(3, 2.1)]; }],
    ['overlapping peer draw', f => { f.options.peers = [physical(3.8, 2.6)]; }],
    ['missing peer measurements', f => { f.options.peers = [{ connected: field(true) }]; }],
    ['different Tesla current', f => { f.tesla.actualCurrentA = 5; }],
    ['different Tesla power', f => { f.tesla.actualPowerKw = 4; }],
    ['retained Tesla current', f => { f.tesla.fields.charger_actual_current.retained = true; }],
    ['pre-test Tesla current', f => { f.tesla.fields.charger_actual_current.receivedAt = START; }],
    ['pre-test physical current', f => { f.options.physical.phaseCurrentA.measuredAt = START; }],
    ['stale physical current', f => { f.options.physical.phaseCurrentA.measuredAt = NOW - 61_000; }],
  ];
  for (const [reason, change] of cases) {
    const f = fixture({ current: 3, power: 2.1, teslaPower: 2 });
    assert.ok(matchTeslaCurrent(f.tesla, f.options), 'The unchanged lower-draw fixture supplies a valid match');
    change(f);
    assert.equal(matchTeslaCurrent(f.tesla, f.options), null, reason);
  }
});

test('every measured phase must respect the confirmed current ceiling', () => {
  const { tesla, options } = fixture();
  options.minimumPhysical.phaseCurrentA = field([6.5, 6, 6]);
  assert.ok(matchTeslaCurrent(tesla, options), 'The existing 0.5 A measurement tolerance remains available');
  options.minimumPhysical.phaseCurrentA = field([6.51, 6, 6]);
  assert.equal(matchTeslaCurrent(tesla, options), null,
    'A phase above the confirmed ceiling and tolerance cannot hide in the average');
});

test('minimum-current matching rejects an absent or invalid offered-current ceiling', () => {
  for (const appliedCurrentA of [undefined, null, NaN, Infinity, -1, 0, 5, 7, '6']) {
    const { tesla, options } = fixture(); options.currentTest.appliedCurrentA = appliedCurrentA;
    assert.equal(matchTeslaCurrent(tesla, options), null, `Invalid ceiling: ${String(appliedCurrentA)}`);
  }
});

test('Tesla phase metadata does not veto corroborated measured current and power', () => {
  for (const phases of [2, 1, null, undefined]) {
    const { tesla, options, first, minimumPhysical } = fixture();
    if (phases === undefined) delete tesla.phases;
    else tesla.phases = phases;
    assert.ok(matchTeslaCurrent(tesla, options),
      'A three-phase charger at 6 A and 4.1 kW matches the independent Tesla 6 A and 4 kW reports');
    tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
    tesla.fields.charger_actual_current.value = 16; tesla.fields.charger_power.value = 11;
    assert.ok(matchTeslaCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }),
      'The same electrical comparison also identifies Tesla on Charger 1');
  }
});

test('ignoring Tesla phase metadata still requires current and power to agree with physical measurements', () => {
  const { tesla, options } = fixture();
  tesla.phases = 2;
  tesla.actualPowerKw = 1.4;
  assert.equal(matchTeslaCurrent(tesla, options), null,
    'Equal current cannot corroborate single-phase Tesla power against measured three-phase power');
  tesla.actualPowerKw = 4;
  tesla.actualCurrentA = 8;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Matching power alone cannot replace matching actual current');
  tesla.actualCurrentA = 6;
  options.physical.phaseCurrentA = field([6, 8, 6]);
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Uneven measured phases remain inconclusive');
});

test('confirmed limit without physical response never identifies Tesla', () => {
  for (const phase of ['proposed', 'applying', 'restoring', 'uncertain', 'restored', 'superseded']) {
    const { tesla, options } = fixture(); options.currentTest.phase = phase;
    assert.equal(matchTeslaCurrent(tesla, options), null, phase);
  }
  const { tesla, options } = fixture(); options.minimumPhysical = physical(16, 11);
  assert.equal(matchTeslaCurrent(tesla, options), null, 'A 6 A request with 16 A measured draw has not taken effect');
  options.minimumPhysical = physical(6, 4.1); options.currentTest.confirmedAt = NOW - 1000;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'A response must settle before matching');
});

test('equalizer overlap and missing peer measurements leave simultaneous identification unresolved', () => {
  const cases = [physical(6, 4.1), physical(6.8, 4.6), { connected: field(null) },
    { ...physical(16, 11), phaseCurrentA: { available: false, value: null } }];
  for (const peer of cases) {
    const { tesla, options } = fixture(); options.peers = [peer];
    assert.equal(matchTeslaCurrent(tesla, options), null);
  }
  const { tesla, options } = fixture(); options.peers = [{ connected: field(false) }];
  assert.ok(matchTeslaCurrent(tesla, options), 'A positively disconnected peer is not an alternative match');
});

test('a held pre-test Tesla current cannot place an unchanged high-current report on Charger 1', () => {
  const { tesla, options, first, minimumPhysical } = fixture();
  tesla.actualCurrentA = 16; tesla.actualPowerKw = 11;
  tesla.fields.charger_actual_current = { value: 16, receivedAt: START, retained: false };
  tesla.fields.charger_power = { value: 11, receivedAt: START, retained: false };
  assert.equal(matchTeslaCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }), null,
    'A healthy feed holding an earlier 16 A report could be a delayed Tesla on Charger 2 before its reduction');
  delete tesla.fields.charger_actual_current;
  assert.equal(matchTeslaCurrent(tesla, { ...options, physical: first, peers: [minimumPhysical] }), null);
});

test('a confirmed stopped peer is excluded only by Tesla evidence received after that stop', () => {
  const { tesla, options } = fixture();
  const stoppedAt = NOW - 3000;
  const stoppedField = value => ({ ...field(value), measuredAt: stoppedAt });
  options.peers = [{ providerConnected: true, connected: stoppedField(true), charging: stoppedField(false),
    powerKw: stoppedField(0), phaseCurrentA: stoppedField([0, 0, 0]) }];
  assert.ok(matchTeslaCurrent(tesla, options), 'Live Tesla charging received after the peer stop excludes that peer');
  tesla.fields.charger_actual_current.receivedAt = stoppedAt - 1;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Older Tesla current cannot prove charging continued after the peer stopped');
  tesla.fields.charger_actual_current.receivedAt = NOW - 2000;
  options.peers[0].charging.available = false;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Missing stopped-state evidence stays unknown');
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
    assert.equal(matchTeslaCurrent(f.tesla, f.options), null);
  }
});

test('Tesla unplug and departure boundaries fence minimum-current evidence from an earlier vehicle connection', () => {
  for (const boundary of [{ field: 'plugged_in', value: false }, { field: 'geofence', value: 'Away' }]) {
    const { tesla, options } = fixture();
    tesla.fields.plugged_in = { value: true, receivedAt: NOW - 1000, retained: false };
    tesla.fields.geofence = { value: 'Home', receivedAt: NOW, retained: false };
    tesla.boundaries = [{ ...boundary, association: tesla.association, at: NOW - 1500 }];
    assert.equal(matchTeslaCurrent(tesla, options), null,
      'Returning home or replugging cannot reuse pre-boundary current while current context is positive again');
    tesla.fields.charger_actual_current.receivedAt = NOW - 1000;
    assert.equal(matchTeslaCurrent(tesla, options), null, 'Power from the earlier connection is also excluded');
    tesla.fields.charger_power.receivedAt = NOW - 1000;
    assert.ok(matchTeslaCurrent(tesla, options));
    tesla.fields.charger_actual_current.receivedAt = NOW - 2000;
    tesla.fields.charger_power.receivedAt = NOW - 2000;
    tesla.boundaries[0].association = 'another-synthetic-tesla';
    assert.ok(matchTeslaCurrent(tesla, options), 'An unrelated feed boundary cannot reinterpret this vehicle’s evidence');
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
  assert.ok(matchTeslaCurrent(tesla, options), 'Single-phase current is not divided by three');
  tesla.phases = 3;
  assert.ok(matchTeslaCurrent(tesla, options), 'Measured single-phase current and corroborating power suffice despite different Tesla phase metadata');
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

test('minimum-current matching admits independently corroborated charging while the raw plug remains false', () => {
  let now = START - 1000;
  const capture = createChargingTeslaCapture({ clock: () => now }); capture.setConnected(true);
  const send = (field, value, packet = {}) => capture.receive(`${capture.topic.slice(0, -1)}${field}`, String(value), packet);
  for (const [field, value] of Object.entries({ plugged_in: false, geofence: 'Home',
    charging_state: 'Disconnected', charger_actual_current: 0, charger_power: 0 })) send(field, value, { retain: true });
  now = START;
  for (const [field, value] of Object.entries({ healthy: true, charging_state: 'Charging',
    charger_actual_current: 16, charger_power: 11 })) send(field, value);
  now = NOW - 2000; send('charger_actual_current', 6); send('charger_power', 4);
  const { options } = fixture(), snapshot = capture.snapshot();
  assert.equal(snapshot.pluggedIn, false);
  assert.equal(snapshot.connectionContext.source, 'live-charging');
  assert.ok(matchTeslaCurrent(snapshot, options));
  assert.equal(matchTeslaCurrent(snapshot, { ...options,
    minimumPhysical: physical(16, 11) }), null, 'Actual 16 A draw cannot pass a confirmed 6 A test');
  now = NOW - 1000; send('charging_state', 'Disconnected');
  assert.equal(matchTeslaCurrent(capture.snapshot(), options), null,
    'A real vehicle disconnect immediately fences the inferred connection');
  capture.close();
});


test('one Tesla comparison uses an own probe without a peer current test', () => {
  const f = fixture();
  const options = { ...f.options, currentTest: undefined, minimumPhysical: undefined,
    comparison: { id: 'synthetic-own-probe', startedAt: START + 10_000, deadlineAt: START + 90_000 } };
  const match = matchTeslaCurrent(f.tesla, options);
  assert.equal(match.kind, 'current'); assert.equal(match.minimumTest, false);
  assert.equal(match.minimumPhysicalAt, null); assert.equal(match.testId, options.comparison.id);
  f.tesla.actualCurrentA = 16; f.tesla.actualPowerKw = 11;
  f.tesla.fields.charger_actual_current.value = 16; f.tesla.fields.charger_power.value = 11;
  assert.equal(matchTeslaCurrent(f.tesla, { ...options, physical: f.first, peers: [f.minimumPhysical] }).minimumTest, false);
});

test('own-probe uniqueness requires affirmative physical peer evidence', () => {
  const stoppedAt = NOW - 3000;
  const zero = { providerConnected: true, connected: field(true), charging: { ...field(false), measuredAt: stoppedAt },
    powerKw: field(0), phaseCurrentA: field([0, 0, 0]) };
  for (const peer of [zero, { providerConnected: true, connected: field(false) }, physical(16, 11)]) {
    const f = fixture(), options = { ...f.options, currentTest: undefined, minimumPhysical: undefined, peers: [peer],
      comparison: { id: 'synthetic-own-probe', startedAt: START + 10_000, deadlineAt: START + 90_000 } };
    assert.ok(matchTeslaCurrent(f.tesla, options));
  }
  for (const peer of [{ connected: { value: false, available: false } }, physical(6, 4.1), physical(6.8, 4.6),
    { ...zero, phaseCurrentA: field([6, 6, 6]) }, { ...zero, phaseCurrentA: { ...field([0, 0, 0]), retained: true } },
    { ...physical(16, 11), providerConnected: false }]) {
    const f = fixture();
    assert.equal(matchTeslaCurrent(f.tesla, { ...f.options, currentTest: undefined, minimumPhysical: undefined, peers: [peer],
      comparison: { id: 'synthetic-own-probe', startedAt: START + 10_000, deadlineAt: START + 90_000 } }), null);
  }
});

test('own-probe comparison preserves clocks, consumption and the original deadline', () => {
  const changes = [
    f => { f.options.comparison.deadlineAt = NOW; },
    f => { f.tesla.fields.charger_actual_current.receivedAt = START; },
    f => { f.tesla.fields.charger_power.receivedAt = START; },
    f => { f.tesla.fields.charger_actual_current.retained = true; },
    f => { f.options.consumedCurrentAt = NOW - 2000; },
    f => { f.tesla.healthy = false; },
    f => { f.options.physical.phaseCurrentA.measuredAt = NOW + 1; },
  ];
  for (const change of changes) {
    const f = fixture(); f.options = { ...f.options, currentTest: undefined, minimumPhysical: undefined,
      comparison: { id: 'synthetic-own-probe', startedAt: START + 10_000, deadlineAt: START + 90_000 } };
    assert.ok(matchTeslaCurrent(f.tesla, f.options)); change(f);
    assert.equal(matchTeslaCurrent(f.tesla, f.options), null);
  }
});

for (const comparison of ['minimum-current', 'own-probe'])
test(`healthy change-only Tesla fields remain usable while fresh measurements settle (${comparison})`, () => {
  const { tesla, options } = fixture();
  if (comparison === 'own-probe') {
    delete options.currentTest;
    delete options.minimumPhysical;
    options.comparison = { id: 'synthetic-held-fields', startedAt: START + 10_000, deadlineAt: START + 90_000 };
  }
  assert.ok(matchTeslaCurrent(tesla, options));
  const clocks = structuredClone(tesla.fields);
  options.now = START + 89_000;
  options.physical.phaseCurrentA.measuredAt = options.now;
  options.physical.powerKw.measuredAt = options.now;
  if (options.minimumPhysical) {
    options.minimumPhysical.phaseCurrentA.measuredAt = options.now;
    options.minimumPhysical.powerKw.measuredAt = options.now;
  }
  for (const peer of options.peers) {
    peer.phaseCurrentA.measuredAt = options.now;
    peer.powerKw.measuredAt = options.now;
  }
  const match = matchTeslaCurrent(tesla, options);
  assert.ok(match, 'Held live values from this comparison do not expire while logger health and physical evidence remain current');
  assert.equal(match.receivedAt, clocks.charger_actual_current.receivedAt);
  assert.deepEqual(tesla.fields, clocks, 'A later comparison cannot renew source receipt clocks');
  tesla.healthy = false;
  assert.equal(matchTeslaCurrent(tesla, options), null);
  tesla.healthy = true;
  options.now = START + 90_000;
  assert.equal(matchTeslaCurrent(tesla, options), null, 'Held fields never extend the existing test deadline');
});

test('ordinary charging comparison requires its current scope and preserves evidence fences', () => {
  const f = fixture();
  delete f.options.currentTest; delete f.options.minimumPhysical;
  f.options.comparison = { id: 'synthetic-ordinary-comparison', startedAt: START + 10_000, deadlineAt: null };
  assert.equal(matchTeslaCurrent(f.tesla, f.options)?.kind, 'current');
  for (const change of [
    g => { delete g.options.comparison; },
    g => { g.options.comparison.deadlineAt = undefined; },
    g => { g.options.comparison.startedAt = NOW + 1; },
    g => { g.options.matchingSince = NOW; },
    g => { g.options.peers[0].phaseCurrentA.value = [6, 6, 6]; },
    g => { g.options.peers[0].connected.available = false; },
    g => { g.tesla.fields.charger_actual_current.retained = true; },
    g => { g.tesla.healthy = false; },
  ]) {
    const g = structuredClone(f); change(g);
    assert.equal(matchTeslaCurrent(g.tesla, g.options), null);
  }
});
