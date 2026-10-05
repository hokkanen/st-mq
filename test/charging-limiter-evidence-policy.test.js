import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyCurrentLimiter, shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const triple = value => [value, value, value];
const config = { maximumCurrentA: 16, minimumCurrentA: 6, currentStepA: 1, fallbackCurrentA: 12,
  mainFuseA: triple(25), marginA: triple(1), maxAgeMs: 15_000, agreementToleranceA: 2 };
const held = (currents, epoch = '1:0') => ({ healthy: true, currents, times: triple(NOW - 3_600_000),
  evidence: { source: 'easee-stream', connected: true, online: true, synchronized: true, epoch,
    receivedAt: NOW - 3_600_000, activityAt: null, sourceAt: null } });
const native = currents => ({ healthy: true, currents, times: triple(NOW), evidence: {
  source: 'easee-ocpp', connected: true, online: true, synchronized: true, epoch: 'synthetic-connection',
  receivedAt: NOW, activityAt: NOW, sourceAt: NOW } });
const fixture = () => ({ config, now: NOW, priority: 'charger2', liveUnscheduled: true,
  property: held(triple(8)), easee: native(triple(0)), allowance: held(triple(17)),
  shelly: { healthy: true, currents: triple(0), times: triple(NOW) } });
const scope = () => ({ authorized: true, association: 'synthetic-shelly', generation: 1,
  connected: true, sessionId: 'synthetic-session', connectedAt: NOW - 60_000 });
const loaded = ({ household = 4, peer = 0, own = 12, allowance = 9 } = {}) => {
  const input = fixture(); input.property.currents = triple(household + peer + own);
  input.easee.currents = triple(peer); input.shelly.currents = triple(own); input.allowance.currents = triple(allowance);
  return input;
};
const atTime = (input, at, currentA = 14) => ({ ...input, now: at,
  easee: { ...input.easee, times: triple(at), evidence: { ...input.easee.evidence, activityAt: at } },
  shelly: { ...input.shelly, times: triple(at) },
  currentSetting: { confirmed: true, currentA, measuredAt: NOW + 1000, receivedAt: at } });
const settlingFixture = () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(loaded(), connection);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 1000, confirmedAt: NOW + 2000, previousCurrentA: 12, currentA: 14 }, connection);
  return { limiter, connection };
};

test('a confirmed own current change holds its readback while property arrives before Shelly measurements', () => {
  const { limiter, connection } = settlingFixture();
  const asynchronous = loaded({ household: 6.5, own: 12 });
  const result = limiter.evaluate(atTime(asynchronous, NOW + 5000), connection);
  assert.equal(result.currentA, 14); assert.equal(result.loadCurrentA, 14);
  assert.equal(result.settling, true); assert.equal(result.reason, 'measurement-settling');
  assert.equal(result.modelAvailable, false); assert.equal(result.fallback, false);
  assert.equal(result.fallbackReason, 'allowance-disagreement');
  assert.equal(result.settlingUntil, NOW + 61_000);
  const recovered = limiter.evaluate(atTime(loaded({ household: 4.5, own: 14 }), NOW + 15_000), connection);
  assert.equal(recovered.currentA, 16); assert.equal(recovered.fallback, false);
  assert.equal(recovered.settling, undefined);
});

test('Shelly-first and peer-delayed source arrivals retain the fixed reference and recover without lowering the pilot', () => {
  const { limiter, connection } = settlingFixture();
  const earlyShelly = loaded({ household: 1, own: 14 }); earlyShelly.property.currents = triple(13);
  const pending = limiter.evaluate(atTime(earlyShelly, NOW + 5000), connection);
  assert.equal(pending.currentA, 14); assert.equal(pending.settling, true);
  assert.equal(pending.fallbackReason, 'non-additive-currents');
  const recovered = limiter.evaluate(atTime(loaded({ own: 14 }), NOW + 15_000), connection);
  assert.equal(recovered.fallback, false); assert.equal(recovered.currentA, 16);
  assert.deepEqual(recovered.allowanceComparison.basis, triple('held-shelly-reference'));
  const earlyProperty = loaded({ own: 14, peer: 3 }); earlyProperty.easee.currents = triple(0);
  assert.equal(limiter.evaluate(atTime(earlyProperty, NOW + 20_000), connection).settling, true);
  assert.equal(limiter.evaluate(atTime(loaded({ own: 14, peer: 3 }), NOW + 35_000), connection).fallback, false);
});

test('polls, intermediate agreement and further commands cannot renew the first absolute settling deadline', () => {
  const { limiter, connection } = settlingFixture(), mismatch = loaded({ household: 8, own: 14 });
  assert.equal(limiter.evaluate(atTime(mismatch, NOW + 5000), connection).currentA, 14);
  limiter.evaluate(atTime(loaded({ own: 14 }), NOW + 20_000), connection);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 25_000, confirmedAt: NOW + 26_000, previousCurrentA: 14, currentA: 16 }, connection);
  const before = limiter.evaluate(atTime(mismatch, NOW + 60_999, 16), connection);
  assert.equal(before.settlingUntil, NOW + 61_000); assert.equal(before.currentA, 16);
  const expired = limiter.evaluate(atTime(mismatch, NOW + 61_000, 16), connection);
  assert.equal(expired.settling, undefined); assert.equal(expired.fallback, true); assert.equal(expired.currentA, 12);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 61_500, confirmedAt: NOW + 62_000, previousCurrentA: 16, currentA: 12 }, connection);
  assert.equal(limiter.evaluate(atTime(mismatch, NOW + 63_000, 12), connection).settling, undefined,
    'The fallback decrease cannot grant a replacement window for the persistent contradiction');
});

test('a command dispatched inside the original window cannot renew it through a later acknowledgement', () => {
  const { limiter, connection } = settlingFixture();
  limiter.evaluate(atTime(loaded({ own: 14 }), NOW + 59_000), connection);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 60_500, confirmedAt: NOW + 62_000,
    previousCurrentA: 14, currentA: 16 }, connection);
  const result = limiter.evaluate(atTime(loaded({ household: 8, own: 14 }), NOW + 63_000, 16), connection);
  assert.equal(result.settling, undefined); assert.equal(result.fallback, true); assert.equal(result.currentA, 12);
});

test('settling requires a changed acknowledged own command, prior agreement and matching fresh readback', () => {
  const mismatch = loaded({ household: 8, own: 14 });
  for (const command of [null, { previousCurrentA: 14, currentA: 14 }, { confirmedAt: NOW }, { confirmedAt: NOW + 61_000 }]) {
    const limiter = createShellyCurrentLimiter(), connection = scope(); limiter.evaluate(loaded(), connection);
    if (command) limiter.confirmCurrentCommand({ dispatchedAt: NOW + 1000, confirmedAt: NOW + 2000,
      previousCurrentA: 12, currentA: 14, ...command }, connection);
    assert.equal(limiter.evaluate(atTime(mismatch, NOW + 5000), connection).settling, undefined);
  }
  for (const change of [input => { input.currentSetting.confirmed = false; },
    input => { input.currentSetting.receivedAt = NOW - config.maxAgeMs; },
    input => { input.currentSetting.currentA = 16; }, input => { input.currentSetting.measuredAt = NOW + 6000; }]) {
    const { limiter, connection } = settlingFixture(), input = atTime(mismatch, NOW + 5000); change(input);
    assert.equal(limiter.evaluate(input, connection).settling, undefined);
  }
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(mismatch, connection);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 1000, confirmedAt: NOW + 2000, previousCurrentA: 12, currentA: 14 }, connection);
  assert.equal(limiter.evaluate(atTime(mismatch, NOW + 5000), connection).settling, undefined);
});

test('true feed loss and physical/control scope changes immediately withdraw settling', () => {
  for (const change of [
    (input) => { input.property.evidence.connected = false; },
    (input) => { input.allowance.evidence.synchronized = false; },
    (input) => { input.easee.evidence.activityAt = input.now - 120_001; },
    (input) => { input.shelly.healthy = false; },
    (input) => { input.property.evidence.epoch = 'replacement-epoch'; },
    (_input, connection) => { connection.authorized = false; },
    (_input, connection) => { connection.sessionId = 'new-session'; },
    (_input, connection) => { connection.generation++; }
  ]) {
    const { limiter, connection } = settlingFixture(), input = atTime(loaded({ household: 8, own: 14 }), NOW + 5000);
    change(input, connection);
    const result = limiter.evaluate(input, connection);
    assert.equal(result.settling, undefined); assert.equal(result.fallback, true); assert.equal(result.currentA, 12);
    assert.equal(limiter.evaluate(atTime(loaded({ household: 8, own: 14 }), NOW + 6000), scope()).settling, undefined);
  }
});

test('new allowance observations wait only within the own-command deadline and still require raw agreement', () => {
  const { limiter, connection } = settlingFixture(), input = loaded({ own: 14, allowance: 10 });
  input.allowance.times = triple(NOW + 3000); input.property.currents = triple(20);
  const pending = limiter.evaluate(atTime(input, NOW + 5000), connection);
  assert.equal(pending.settling, true); assert.deepEqual(pending.allowanceComparison.basis, triple('raw'));
  input.property.currents = triple(18);
  const stillWaiting = limiter.evaluate(atTime(input, NOW + 10_000), connection);
  assert.equal(stillWaiting.settling, true); assert.deepEqual(stillWaiting.allowanceComparison.basis, triple('raw'));
  input.property.currents = triple(16);
  assert.equal(limiter.evaluate(atTime(input, NOW + 15_000), connection).fallback, false);
});

test('settling preserves native/vehicle/priority restrictions and independently matching tighter property phases', () => {
  for (const [restriction, expected] of [[{ nativeCurrentA: 6 }, 6], [{ vehicleCurrentA: 0 }, 0],
    [{ priority: 'charger1', peerDemandA: 16 }, 0], [{ priority: 'balanced', peerDemandA: 16 }, 10]]) {
    const { limiter, connection } = settlingFixture();
    const result = limiter.evaluate(atTime({ ...loaded({ household: 8, own: 14 }), ...restriction }, NOW + 5000), connection);
    assert.equal(result.currentA, expected); assert.equal(result.settling, true);
  }
  const { limiter, connection } = settlingFixture();
  const input = loaded({ household: 8, own: 14 });
  input.property.currents[1] = 34; input.allowance.currents[1] = 0; input.allowance.times[1]++;
  const result = limiter.evaluate(atTime(input, NOW + 5000), connection);
  assert.equal(result.currentA, 0, 'The matching clipped-zero phase establishes a real subminimum bound');
  assert.equal(result.pause, true);
});

test('a prior valid zero entitlement cannot become positive through settling or a current restoration report', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope(), input = loaded();
  input.priority = 'charger1'; input.peerDemandA = 16;
  assert.equal(limiter.evaluate(input, connection).currentA, 0);
  limiter.confirmCurrentCommand({ dispatchedAt: NOW + 1000, confirmedAt: NOW + 2000, previousCurrentA: 6, currentA: 14 }, connection);
  const pending = limiter.evaluate(atTime(loaded({ household: 8, own: 14 }), NOW + 5000), connection);
  assert.equal(pending.currentA, 0); assert.equal(pending.pause, true);
});

test('a frozen measured reference admits 12 to 14 to 16A with unchanged allowance clocks', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  for (const own of [12, 14, 16]) {
    const input = loaded({ own }), before = structuredClone(input), result = limiter.evaluate(input, connection);
    assert.equal(result.currentA, 16); assert.equal(result.fallback, false);
    assert.deepEqual(result.allowanceComparison.expectedCurrentA, triple(9));
    assert.deepEqual(result.allowanceComparison.basis, triple(own === 12 ? 'raw' : 'held-shelly-reference'));
    assert.deepEqual(input, before, 'Held source clocks and measured currents remain original');
  }
  assert.equal(shellyCurrentLimit(loaded({ own: 16 })).fallback, true, 'The pure one-shot calculation has no historical reference');
});

test('household changes cannot slide an existing reference through repeated raw matches or fallback reductions', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(loaded({ own: 14, allowance: 7.4 }), connection);
  for (const household of [5, 6, 7, 8]) {
    const result = limiter.evaluate(loaded({ household, own: 18 - household, allowance: 7.4 }), connection);
    assert.equal(result.fallback, household >= 6, 'Unrelated household load remains visible even when property total stays constant');
    assert.deepEqual(result.allowanceComparison.basis, triple('held-shelly-reference'));
    assert.deepEqual(result.allowanceComparison.expectedCurrentA, triple(11 - household));
  }
  const restored = limiter.evaluate(loaded({ household: 4, own: 10, allowance: 7.4 }), connection);
  assert.equal(restored.fallback, false, 'Recovery requires the household contradiction to resolve');
  assert.deepEqual(restored.allowanceComparison.expectedCurrentA, triple(7));
});

test('concurrent Easee draw cancels in the comparison and never reduces Shelly priority entitlement', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(loaded(), connection);
  const result = limiter.evaluate(loaded({ own: 16, peer: 16 }), connection);
  assert.equal(result.currentA, 16); assert.equal(result.fallback, false);
  assert.deepEqual(result.baseCurrentA, triple(4));
  assert.deepEqual(result.allowanceComparison.expectedCurrentA, triple(9));
});

test('compensation is applied before zero clipping and does not hide a household increase', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(loaded({ household: 8, own: 12, allowance: 5 }), connection);
  const result = limiter.evaluate(loaded({ household: 11, own: 16, allowance: 5 }), connection);
  assert.equal(result.fallback, true); assert.equal(result.currentA, 12);
  assert.deepEqual(result.allowanceComparison.expectedCurrentA, triple(2), 'The raw -2A deficit must survive before adding the 4A own-current change');
});

test('zero allowance and clipped expected budgets remain raw comparisons and never seed offsets', () => {
  for (const initial of [loaded({ household: 8, peer: 16, own: 16, allowance: 0 }),
    loaded({ household: 10, own: 16, allowance: 1 })]) {
    const limiter = createShellyCurrentLimiter(), connection = scope();
    assert.equal(limiter.evaluate(initial, connection).fallback, false);
    const next = structuredClone(initial); next.shelly.currents = triple(10);
    next.property.currents = initial.property.currents.map(value => value - 6);
    const result = limiter.evaluate(next, connection);
    assert.equal(result.fallback, true);
    assert.deepEqual(result.allowanceComparison.basis, triple('raw'));
  }
});

test('an unbalanced transient cannot seed a common Shelly reference from its minimum phase', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  const initial = loaded(); initial.shelly.currents = [9.7, 0, 9.8];
  assert.equal(limiter.evaluate(initial, connection).fallback, false, 'The raw comparison remains valid');
  const next = limiter.evaluate(loaded({ own: 16 }), connection);
  assert.equal(next.fallback, true);
  assert.deepEqual(next.allowanceComparison.basis, triple('raw'));
  const established = createShellyCurrentLimiter(); established.evaluate(loaded(), connection);
  const transient = established.evaluate(initial, connection);
  assert.equal(transient.fallback, true); assert.equal(transient.currentA, 8);
  assert.deepEqual(transient.allowanceComparison.basis, triple('held-shelly-reference'));
  const recovered = established.evaluate(loaded({ own: 16 }), connection);
  assert.equal(recovered.fallback, false); assert.equal(recovered.currentA, 16);
  assert.deepEqual(recovered.allowanceComparison.expectedCurrentA, triple(9), 'The transient must not replace the frozen reference');
});

test('each allowance source observation owns a separate frozen phase reference', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  limiter.evaluate(loaded(), connection);
  const update = loaded({ own: 16 }); update.allowance.currents[0] = 5; update.allowance.times[0]++;
  const first = limiter.evaluate(update, connection);
  assert.equal(first.fallback, false);
  assert.deepEqual(first.allowanceComparison.basis, ['raw', 'held-shelly-reference', 'held-shelly-reference']);
  assert.deepEqual(first.allowanceComparison.expectedCurrentA, [5, 9, 9]);
  const next = structuredClone(update); next.shelly.currents = triple(14); next.property.currents = triple(18);
  const second = limiter.evaluate(next, connection);
  assert.equal(second.fallback, false);
  assert.deepEqual(second.allowanceComparison.basis, triple('held-shelly-reference'));
  assert.deepEqual(second.allowanceComparison.expectedCurrentA, [5, 9, 9]);
  for (const change of [feed => { feed.times[1]++; }, feed => { feed.currents[1] = 8; }]) {
    const changed = structuredClone(update); change(changed.allowance);
    const result = limiter.evaluate(changed, connection);
    assert.equal(result.fallback, true, 'A changed phase needs its own raw agreement');
    assert.equal(result.allowanceComparison.basis[1], 'raw');
  }
});

test('a new observation can seed after initial disagreement but never reseeds an existing reference', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope();
  assert.equal(limiter.evaluate(loaded({ own: 16 }), connection).fallback, true);
  assert.equal(limiter.evaluate(loaded(), connection).fallback, false);
  const result = limiter.evaluate(loaded({ own: 16 }), connection);
  assert.equal(result.fallback, false);
  assert.deepEqual(result.allowanceComparison.expectedCurrentA, triple(9));
});

test('feed epochs, source identity, physical session and controller lifetime fence reference reuse', () => {
  for (const change of [
    (_input, connection) => { connection.authorized = false; },
    (_input, connection) => { connection.connected = false; },
    (_input, connection) => { connection.sessionId = 'another-session'; },
    (_input, connection) => { connection.sessionId = null; },
    (_input, connection) => { connection.connectedAt++; },
    (_input, connection) => { connection.generation++; },
    (_input, connection) => { connection.association = 'another-equipment'; },
    ...['property', 'easee', 'allowance'].flatMap(role => [
      input => { input[role].evidence.epoch = 'new-epoch'; },
      input => { input[role].evidence.source = 'another-source'; },
      input => { input[role].evidence.connected = false; },
      input => { input[role].evidence.online = false; },
      input => { input[role].evidence.synchronized = false; }
    ]),
    input => { input.shelly.healthy = false; },
    input => { input.shelly.times = triple(NOW - config.maxAgeMs - 1); },
    input => { input.easee.evidence.activityAt = NOW - 120_001; }
  ]) {
    const limiter = createShellyCurrentLimiter(), connection = scope(); limiter.evaluate(loaded(), connection);
    const changed = loaded({ own: 16 }); change(changed, connection);
    assert.equal(limiter.evaluate(changed, connection).fallback, true);
    assert.equal(limiter.evaluate(loaded({ own: 16 }), scope()).fallback, true, 'Recovery cannot recover a retired in-memory reference');
  }
  const limiter = createShellyCurrentLimiter(); limiter.evaluate(loaded(), scope()); limiter.reset();
  assert.equal(limiter.evaluate(loaded({ own: 16 }), scope()).fallback, true);
  assert.equal(createShellyCurrentLimiter().evaluate(loaded({ own: 16 }), scope()).fallback, true);
});

test('a reference never overrides vehicle, native, current property or priority restrictions', () => {
  const limiter = createShellyCurrentLimiter(), connection = scope(); limiter.evaluate(loaded(), connection);
  for (const [restriction, expected] of [[{ vehicleCurrentA: 0 }, 0], [{ nativeCurrentA: 7 }, 7],
    [{ priority: 'charger1', peerDemandA: 16 }, 0], [{ priority: 'balanced', peerDemandA: 16 }, 10]]) {
    const result = limiter.evaluate({ ...loaded({ own: 16 }), ...restriction }, connection);
    assert.equal(result.currentA, expected); assert.equal(result.fallback, false);
  }
  const result = limiter.evaluate(loaded({ household: 20, own: 16 }), connection);
  assert.equal(result.fallback, true); assert.equal(result.currentA, 0, 'A known 4A property ceiling still stops despite fallback12');
});

test('synchronized online held values allow the full pilot without converting them into new measurements', () => {
  const input = fixture(), before = structuredClone(input);
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 16);
  assert.equal(result.fallback, false);
  assert.deepEqual(input, before, 'Evaluation must not renew timestamps or mutate observations');
});

test('Shelly priority retains 16A through Equalizer zero clipping, peer excess and stale forecast reservations', () => {
  const input = fixture();
  input.property = held(triple(40));
  input.easee = native(triple(16));
  input.shelly.currents = triple(16);
  input.allowance = held(triple(0));
  input.reservationA = 16;
  input.allocationA = 0;
  for (const liveUnscheduled of [true, false]) {
    const result = shellyCurrentLimit({ ...input, liveUnscheduled });
    assert.equal(result.currentA, 16, 'Household 8A plus Shelly 16A fits the 25A fuse with 1A reserve; Easee must yield');
    assert.equal(result.fallback, false, 'A clipped zero allowance does not disprove the property budget');
  }
});

test('a native Equalizer delay or reserve cannot double-subtract the configured margin from Shelly entitlement', () => {
  for (const lowerAllowance of [15, 16, 17]) {
    const input = fixture(); input.allowance = held(triple(lowerAllowance));
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 16);
    assert.equal(result.fallback, false);
  }
});

test('a materially lower allowance contradicts held low property load and triggers fallback', () => {
  const input = fixture(); input.allowance = held(triple(0));
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 12);
  assert.equal(result.fallback, true);
  assert.equal(result.fallbackReason, 'allowance-disagreement');
});

test('valid insufficient property capacity pauses dynamically instead of selecting 12A fallback', () => {
  const input = fixture();
  input.property = held([22, 24, 25]); input.allowance = held([3, 1, 0]);
  const result = shellyCurrentLimit(input);
  assert.equal(result.currentA, 0);
  assert.equal(result.pause, true);
  assert.equal(result.fallback, false);
  assert.equal(result.reason, 'fuse-limit');
});

test('lost or contradictory allowance still preserves independently known tighter property and priority bounds', () => {
  for (const kind of ['disconnected', 'unsynchronized', 'optimistic-allowance']) {
    const input = fixture(); input.property = held(triple(20)); input.allowance = held(triple(5));
    if (kind === 'disconnected') input.allowance.evidence.connected = false;
    if (kind === 'unsynchronized') input.allowance.evidence.synchronized = false;
    if (kind === 'optimistic-allowance') input.allowance.currents = triple(25);
    let result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 0, `${kind}: the fallback cap cannot override a known 4A property ceiling`);
    assert.equal(result.fallback, true);
    input.property = held(triple(8));
    input.priority = 'charger1'; input.peerDemandA = 16;
    result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 0, `${kind}: Easee priority reserves demand even before actual current ramps`);
    assert.equal(result.fallback, true);
  }
});

test('held phase timestamps never authorize a disconnected, offline or unsynchronized stream generation', () => {
  for (const [field, value] of [['connected', false], ['online', false], ['synchronized', false], ['epoch', null]]) {
    const input = fixture(); input.property.evidence[field] = value;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 12, field);
    assert.equal(result.fallback, true, field);
  }
  const input = fixture(); input.property.evidence.epoch = '2:0';
  assert.equal(shellyCurrentLimit(input).currentA, 16, 'A newly synchronized product epoch can supply held state again');
});

test('Shelly contribution is conservative under every phase permutation', () => {
  const input = fixture(); input.property = held([20, 21, 24]); input.easee = native(triple(2));
  input.allowance = held([7, 6, 3]);
  for (const currents of [[14.5, 15, 16], [14.5, 16, 15], [15, 14.5, 16], [15, 16, 14.5], [16, 14.5, 15], [16, 15, 14.5]]) {
    input.shelly.currents = currents;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 16);
    assert.deepEqual(result.baseCurrentA, [3.5, 4.5, 7.5]);
    assert.equal(result.fallback, false);
  }
});

test('recent native meter receipts are separate from permissive held stream clocks', () => {
  for (const age of [120_001, -1]) {
    const input = fixture(); input.easee.evidence.receivedAt = NOW - age; input.easee.evidence.activityAt = NOW - age;
    const result = shellyCurrentLimit(input);
    assert.equal(result.currentA, 12);
    assert.equal(result.fallback, true);
  }
});

test('allocation context transfers independent field evidence without polling or writing Easee', () => {
  const input = fixture(); let reads = 0;
  const supply = { propertyCurrentA: input.property.currents, chargerCurrentA: input.easee.currents,
    availableCurrentA: input.allowance.currents, observationTimes: { property: input.property.times,
      charger: input.easee.times, allowance: input.allowance.times }, feedEvidence: {
      property: input.property.evidence, charger: input.easee.evidence, allowance: input.allowance.evidence } };
  const fake = { chargers: { charger1: { adapter: { readCurrentSupply() { reads++; return { online: true, supply }; } } } },
    clock: () => NOW, settings: { priority: 'charger2' }, coordination: { allocations: [] },
    views: () => [{ id: 'charger2', settings: { enabled: true }, values: {}, control: {} }] };
  const result = ChargingRuntime.prototype.allocationContext.call(fake);
  assert.equal(reads, 1);
  assert.deepEqual(result.property, input.property);
  assert.deepEqual(result.easee, input.easee);
  assert.deepEqual(result.allowance, input.allowance);
  assert.equal(result.allocationA, null);
  assert.equal(result.reservationA, 0);
});
