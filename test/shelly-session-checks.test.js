import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { newShellySessionCheckState, shellySessionReference, updateShellySessionChecks } from '../src/charging/shelly-session-checks.js';
import { chargingSessionCheckSummaries, comparableChargingSession } from '../src/app/charging-session-checks.js';

const START = 1800000000000, END = START + 10_000, MAX_AGE = 10_000;
const association = 'invented-shelly-association';
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function fixture(t, verified = true) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let recorder = new Recorder(store), state = newShellySessionCheckState(), connection = null;
  const config = { maxAgeMs: MAX_AGE, sessionEnergyVerified: verified,
    chargingStates: ['charging'], connectedStates: ['connected'], disconnectedStates: ['free'] };
  const run = (now, role, value, at = now, before = () => {}, correlated = false) => store.transaction(() => {
    const prior = structuredClone(state);
    try {
      before();
      updateShellySessionChecks({ state, connection, role, field: role ? { value, measuredAt: at, receivedAt: now, retained: false, correlated } : null,
        config, store, recorder, association, now });
      store.setState('test:shelly-session', state);
    } catch (cause) { state = prior; throw cause; }
  });
  return { store, config, state: () => state,
    checks: () => store.events().filter(row => row.type === 'charging-session-check').map(row => row.payload),
    connect(at = START, now = at) { connection = { connected: true, connectedAt: at, sessionId: `invented-session:${at}` }; run(now, 'work_state', 'connected', at); },
    end(at = END, now = at) { connection = { connected: false, lastDisconnectedAt: at }; run(now, 'work_state', 'free', at); },
    reference(value, at, now = at, correlated = false) { run(now, 'energy_charge', value, at, () => {}, correlated); },
    work(value, at, now = at) { run(now, 'work_state', value, at); },
    live: () => shellySessionReference(state),
    energy(start, end, amount, options = {}) { run(options.now ?? end, 'phase_info', {}, end, () => recorder.recordEnergy({
      source: options.source ?? 'shelly-evse', device: options.device ?? association, prefix: 'ev2', start, end,
      energies: [amount / 2, amount / 3, amount / 6], powers: [2, 2, 2], quality: ['native_counter', 'estimated'],
      receivedAt: options.now ?? end })); },
    gap(start, end) { run(end, 'phase_info', {}, end, () => recorder.energyGap({ source: 'shelly-evse', device: association,
      prefix: 'ev2', start, end, quality: ['unknown-phase-share'] })); },
    tick(now = END + MAX_AGE * 2) { run(now); },
    restart() { recorder = new Recorder(store); state = store.getState('test:shelly-session'); },
  };
}

test('Shelly checks sum actual stored phases, include the durable tail and compare the native session reference', t => {
  const f = fixture(t);
  f.connect(); f.reference(0, START);
  f.energy(START, START + 5000, .01);
  f.energy(START + 5000, END, .015);
  assert.equal(f.store.observations().length, 3, 'Second constant-power interval is still the compact durable tail');
  f.reference(.02, END); f.end();
  assert.deepEqual(f.checks(), [], 'A disconnect is pending while independently delivered references can still arrive');
  f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true);
  near(check.estimatedKwh, .025);
  assert.equal(check.referenceKwh, .02, 'The native session reference is not reconstructed from the lifetime delta');
  assert.equal(check.recordingBasis, 'native-meter-counter-phase-allocation');
  assert.equal(check.referenceBasis, 'native-session-energy');
  near(chargingSessionCheckSummaries(f.store)[1].summary.differencePercent, 25);
  assert.equal(f.store.observations().length, 6, 'Finalization commits the existing tail once');
  f.tick(END + 5000); f.reference(.02, END + 6000); f.restart(); f.tick(END + 7000);
  assert.equal(f.checks().length, 1);
});

test('all start and final role arrival orders produce the same comparison without early finalization', t => {
  for (const first of ['connection', 'reference']) for (const order of [
    ['connection', 'reference', 'phases'], ['connection', 'phases', 'reference'],
    ['reference', 'connection', 'phases'], ['reference', 'phases', 'connection'],
    ['phases', 'connection', 'reference'], ['phases', 'reference', 'connection'],
  ]) {
    const f = fixture(t);
    if (first === 'connection') { f.connect(); f.reference(0, START); }
    else { f.reference(0, START); f.connect(); }
    const actions = { connection: () => f.end(), reference: () => f.reference(.02, END), phases: () => f.energy(START, END, .02) };
    for (const role of order) { actions[role](); assert.equal(f.checks().length, 0); }
    f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, true, `${first}: ${order}`);
    near(check.estimatedKwh, .02); assert.equal(check.referenceKwh, .02);
  }
});

test('missing phases, real gaps, overlap and another physical association cannot pass a Shelly check', t => {
  for (const scenario of ['missing-phase', 'gap', 'wrong-device', 'wrong-source', 'overlap', 'missing-start', 'missing-end']) {
    const f = fixture(t); f.connect(); f.reference(0, START);
    if (scenario === 'gap') { f.energy(START, START + 4000, .01); f.gap(START + 4000, START + 6000); f.energy(START + 6000, END, .01); }
    else f.energy(scenario === 'missing-start' ? START + 1000 : START, scenario === 'missing-end' ? END - 1000 : END, .02,
      scenario === 'wrong-device' ? { device: 'other-physical-charger' } : scenario === 'wrong-source' ? { source: 'easee' } : {});
    if (scenario === 'missing-phase') f.store.db.prepare("UPDATE observations SET value=NULL WHERE signal='ev2_energy_l2'").run();
    if (scenario === 'overlap') f.store.observation({ source: 'shelly-evse', device: association, signal: 'ev2_energy_l1', value: .01,
      unit: 'kWh', sourceTime: END, receivedAt: END, quality: [], raw: { intervalStart: START, intervalEnd: END } });
    f.reference(.02, END); f.end(); f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, false, scenario);
    assert.equal(check.estimatedKwh, null, scenario);
    assert(check.quality.includes('incomplete-coverage'), scenario);
    assert.equal(chargingSessionCheckSummaries(f.store)[1].summary.comparedSessions, 0);
  }
});

test('matching totals cannot grant verification, manufacture the start, or promote a running sample to final', t => {
  for (const scenario of ['unverified', 'no-zero-baseline', 'running-only', 'zero-reset-at-stop']) {
    const f = fixture(t, scenario !== 'unverified'); f.connect();
    if (scenario !== 'no-zero-baseline') f.reference(0, START);
    f.energy(START, END, .02);
    if (scenario === 'running-only' || scenario === 'zero-reset-at-stop') f.reference(.02, END - 1, END);
    else f.reference(.02, END);
    f.end();
    if (scenario === 'zero-reset-at-stop') f.reference(0, END + 100);
    f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, false, scenario);
    assert(check.quality.includes(scenario === 'unverified' ? 'session-reference-unverified'
      : scenario === 'no-zero-baseline' ? 'missing-start' : 'missing-final-reference'), scenario);
    if (scenario === 'running-only' || scenario === 'zero-reset-at-stop') assert.equal(check.referenceKwh, null);
  }
});

test('native session resets within a physical connection remain excluded across pause/resume', t => {
  const f = fixture(t); f.connect(); f.reference(0, START);
  f.energy(START, START + 5000, .01); f.reference(.01, START + 5000);
  f.reference(0, START + 6000);
  f.energy(START + 5000, END, .01); f.reference(.01, END); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, false);
  assert(check.quality.includes('missing-final-reference'));
  near(check.estimatedKwh, .02); assert.equal(check.referenceKwh, null, 'A pre-reset running reference is not a completed session');
});

test('a witnessed noncharging native zero establishes the start independently of recorded consumption', t => {
  for (const before of [0, .001, null]) {
    const f = fixture(t); f.connect();
    if (before !== null) f.energy(START, START + 500, before);
    f.reference(0, START + 500);
    f.energy(START + 500, END, .02); f.reference(.02, END); f.end(); f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, before !== null);
    assert.equal(check.quality.includes('missing-start'), false);
    assert.equal(check.referenceKwh, .02);
  }
});

test('the next connection owns its reset regardless of its work-state/reference delivery order', t => {
  for (const resetFirst of [true, false]) {
    const f = fixture(t); f.connect(); f.reference(0, START); f.energy(START, END, .02);
    f.reference(.02, END); f.end();
    if (resetFirst) { f.reference(0, END + 100); f.connect(END + 100); }
    else { f.connect(END + 100); f.reference(0, END + 100); }
    assert.equal(f.checks().length, 1);
    assert.equal(f.checks()[0].complete, true);
    assert.equal(f.checks()[0].referenceKwh, .02);
    assert.equal(f.state().active.zeroAt, END + 100);
  }
});

test('a next-session reset before the delayed previous disconnect retains the preceding final reference', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.energy(START, END, .02);
  f.reference(.02, END); f.reference(0, END + 100);
  f.end(END, END + 200); f.connect(END + 100, END + 200);
  assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0].complete, true);
  assert.equal(f.checks()[0].referenceKwh, .02);
});

test('a next-session positive reference neither belongs to nor destroys the preceding final reference', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.energy(START, END, .02);
  f.reference(.02, END); f.end();
  f.reference(.03, END + 100); f.connect(END + 100);
  const [check] = f.checks();
  assert.equal(check.complete, true);
  assert.equal(check.referenceKwh, .02);
  assert.equal(f.live().observedKwh, 0, 'The new connection cannot borrow the prior native counter');
  assert(f.live().quality.includes('missing-start'));
});

test('pending completion, late native reference and durable energy survive restart and rollback atomically', t => {
  const f = fixture(t); f.connect(); f.reference(0, START);
  f.energy(START, START + 5000, .01); f.energy(START + 5000, END, .01); f.end();
  f.restart(); f.reference(.02, END, END + 500);
  const before = f.store.getState('test:shelly-session'), save = f.store.setState;
  f.store.setState = function (key, value) {
    if (key === 'test:shelly-session') throw new Error('synthetic finalization failure');
    return save.call(this, key, value);
  };
  assert.throws(() => f.tick(), /synthetic finalization failure/);
  assert.deepEqual(f.checks(), []);
  assert.deepEqual(f.store.getState('test:shelly-session'), before);
  assert.equal(f.store.observations().length, 3);
  f.store.setState = save; f.restart(); f.tick();
  assert.equal(f.checks()[0].complete, true);
  near(f.checks()[0].estimatedKwh, .02);
});

test('obsolete Shelly power-versus-lifetime checks fail closed instead of receiving the new meaning', t => {
  const f = fixture(t);
  const obsolete = { version: 1, source: 'shelly-evse', start: START, end: END, estimatedKwh: .02,
    referenceKwh: .02, complete: true, quality: [] };
  assert.throws(() => comparableChargingSession(obsolete), /Unsupported Shelly session-check format/);
  f.store.event('charging-session-check', obsolete, END);
  assert.throws(() => chargingSessionCheckSummaries(f.store), /fresh development database/);
});

test('native cumulative readings add deltas across pauses and resets throughout one plug connection', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.reference(.003, START + 1000); f.reference(.003, START + 1000, START + 1200);
  f.reference(.008, START + 2000); f.work('connected', START + 3000);
  f.reference(.01, START + 3000); f.reference(0, START + 3100);
  near(f.live().observedKwh, .01); assert.equal(f.live().runCount, 1);
  f.restart(); f.work('charging', START + 4000); f.reference(.005, START + 5000);
  f.reference(.015, END); f.energy(START, END, .026); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true);
  near(check.estimatedKwh, .026); near(check.referenceKwh, .025);
  near(check.referenceAggregation.observedKwh, .025);
  assert.deepEqual({ ...check.referenceAggregation, observedKwh: .025 }, { kind: 'plug-period-native-runs', observedKwh: .025,
    runCount: 2, complete: true, quality: [] });
  near(chargingSessionCheckSummaries(f.store)[1].summary.differencePercent, 4);
});

test('uncertified pause reset retains every observed native run subtotal without inventing a final', t => {
  const f = fixture(t, false); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.reference(.003, START + 1000);
  f.work('connected', START + 8000); f.reference(0, START + 8000);
  assert.equal(f.live().observedKwh, .003, 'The last sample seven seconds before stop remains observed energy');
  assert(f.live().quality.includes('missing-final-reference'));
  f.restart(); f.work('charging', START + 8100); f.reference(.005, START + 9000);
  f.reference(.008, END); f.energy(START, END, .02); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, false); assert.equal(check.referenceKwh, null);
  near(check.referenceAggregation.observedKwh, .011);
  assert.equal(check.referenceAggregation.runCount, 2);
  assert(check.referenceAggregation.quality.includes('missing-final-reference'));
  assert(check.referenceAggregation.quality.includes('session-reference-unverified'));
  near(check.estimatedKwh, .02, 'The actual stored phases remain a separate quantity');
});

test('native observed subtotal is independent of stored energy, allocation gaps and verification', t => {
  for (const amount of [0, .02, .08, null]) {
    const f = fixture(t, false); f.connect(); f.reference(0, START);
    f.reference(.01, START + 1000); f.reference(0, START + 2000);
    f.reference(.002, START + 3000); f.reference(.005, END);
    if (amount !== null) f.energy(START, END, amount); else f.gap(START, END);
    f.end(); f.tick();
    const [check] = f.checks();
    near(check.referenceAggregation.observedKwh, .015);
    assert.equal(check.referenceKwh, null); assert.equal(check.complete, false);
  }
});

test('late stop and final role delivery is replayed by source time within the settlement window', t => {
  for (const stopLast of [false, true]) {
    const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
    f.reference(.003, START + 1000);
    if (!stopLast) f.work('connected', START + 3000);
    f.reference(.01, START + 3000); f.reference(0, START + 3100);
    if (stopLast) f.work('connected', START + 3000, START + 3200);
    f.work('charging', START + 4000); f.reference(.015, END);
    f.energy(START, END, .025); f.end(); f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, true, `stopLast=${stopLast}`);
    near(check.referenceKwh, .025);
  }
});

test('a stopped completed native run remains usable through idle time until unplug', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.work('connected', START + 3000); f.reference(.01, START + 3000);
  f.energy(START, END, .01); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true); assert.equal(check.referenceKwh, .01);
});

test('new optional accumulation starts from fresh observations and never reconstructs discarded old runs', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.reference(.01, START + 1000);
  f.reference(0, START + 2000); f.reference(.02, START + 3000);
  delete f.state().active.nativeRuns;
  f.reference(.025, START + 4000);
  assert.equal(f.live().observedKwh, 0, 'The first fresh nonzero reading is only a baseline');
  assert(f.live().quality.includes('missing-start'));
  f.reference(.03, END); f.energy(START, END, .04); f.end(); f.tick();
  const [check] = f.checks();
  near(check.referenceAggregation.observedKwh, .005);
  assert.equal(check.complete, false); assert.equal(check.referenceKwh, null);
});

test('initial nonzero references do not lend energy from before the physical plug boundary', t => {
  const f = fixture(t); f.reference(9, START - 1000); f.connect();
  f.reference(10, START + 1000); f.reference(10.01, END);
  f.energy(START, END, .01); f.end(); f.tick();
  const [check] = f.checks();
  near(check.referenceAggregation.observedKwh, .01);
  assert.equal(check.complete, false); assert(check.quality.includes('missing-start'));
});

test('a read receipt gap excludes a hidden-reset reference while regular unchanged reads retain continuity', t => {
  for (const keepAlive of [true, false]) {
    const f = fixture(t); f.config.maxAgeMs = 1000;
    f.connect(); f.reference(0, START); f.reference(.005, START + 1000);
    if (keepAlive) for (let now = START + 2000; now < END; now += 1000) {
      f.reference(.005, START + 1000, now);
      if (now === START + 5000) f.restart();
    }
    f.reference(.01, END); f.energy(START, END, .01); f.end(); f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, keepAlive);
    near(check.referenceAggregation.observedKwh, .01);
    assert.equal(check.quality.includes('reference-coverage-gap'), !keepAlive);
  }
});

test('old native evidence compacts while keeping the sum, completed runs and current restart state', t => {
  const f = fixture(t); f.config.maxAgeMs = 1000;
  f.connect(); f.reference(0, START); f.work('charging', START + 100);
  for (let second = 1; second <= 100; second++) {
    const at = START + second * 1000;
    if (second === 50) f.work('connected', at);
    if (second === 51) f.reference(0, at);
    else f.reference((second <= 50 ? second : second - 51) / 1000, at);
    if (second === 52) f.work('charging', at + 100);
    if (second === 70) f.restart();
    assert(f.state().active.nativeRuns.events.length < 10, 'Native observations stay bounded');
  }
  const end = START + 100_000;
  near(f.live().observedKwh, .099); assert.equal(f.live().runCount, 2);
  f.energy(START, end, .1); f.end(end); f.tick(end + 2000);
  const [check] = f.checks();
  assert.equal(check.complete, true); near(check.referenceKwh, .099);
});

test('duplicate and stale source readings never double-count observed native energy', t => {
  const f = fixture(t); f.connect(); f.reference(0, START);
  f.reference(.005, START + 1000); f.reference(.005, START + 1000, START + 1100);
  f.reference(.001, START + 500, START + 1200);
  f.reference(.01, END); f.energy(START, END, .01); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true); near(check.referenceKwh, .01);
  assert.equal(check.referenceAggregation.runCount, 1);
});

test('a delayed native final arriving after its reset is used without losing the next run', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.reference(.005, START + 1000); f.work('connected', START + 2000);
  f.reference(0, START + 2100); f.reference(.01, START + 2000, START + 2200);
  f.work('charging', START + 3000); f.reference(.02, END);
  f.energy(START, END, .03); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true); near(check.referenceKwh, .03);
  assert.equal(check.referenceAggregation.runCount, 2);
});

test('a new positive native run after unplug cannot inflate the previous connection', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.reference(.02, END); f.energy(START, END, .02); f.end();
  f.reference(0, END + 100); f.reference(.01, END + 200); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, true); near(check.referenceKwh, .02);
  assert.equal(check.referenceAggregation.runCount, 1);
});

test('pause and resume without its reset cannot certify a possibly missed native run', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.work('charging', START + 100);
  f.reference(.02, START + 1000); f.work('connected', START + 1000);
  f.work('charging', START + 2000); f.reference(.03, END);
  f.energy(START, END, .05); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, false); assert.equal(check.referenceKwh, null);
  assert(check.quality.includes('reference-coverage-gap'));
  near(check.referenceAggregation.observedKwh, .03);
});

test('unknown native accumulator versions fail closed in live projections and pending finalization', t => {
  const f = fixture(t); f.connect(); f.reference(0, START);
  f.state().active.nativeRuns.version = 2;
  assert.throws(() => f.live(), /Unsupported Shelly native session accumulator/);
  assert.throws(() => f.end(), /Unsupported Shelly native session accumulator/);
  assert.deepEqual(f.checks(), []);
});

test('a live unchanged zero from before plug-in establishes only a newly witnessed noncharging baseline', t => {
  for (const chargedBeforeZero of [false, true]) {
    const f = fixture(t); f.reference(0, START - 5000); f.connect();
    if (chargedBeforeZero) f.work('charging', START + 100);
    f.reference(0, START - 5000, START + 200, true);
    f.reference(.02, END); f.energy(START, END, .02); f.end(); f.tick();
    const [check] = f.checks();
    near(check.referenceAggregation.observedKwh, .02);
    assert.equal(check.complete, !chargedBeforeZero);
    assert.equal(check.quality.includes('missing-start'), chargedBeforeZero);
  }
});

test('an old zero delivered as a notification cannot establish the new plug baseline', t => {
  const f = fixture(t); f.reference(0, START - 5000); f.connect();
  f.reference(0, START - 5000, START + 200);
  f.reference(.02, END); f.energy(START, END, .02); f.end(); f.tick();
  const [check] = f.checks();
  assert.equal(check.complete, false); assert(check.quality.includes('missing-start'));
  assert.equal(check.referenceAggregation.observedKwh, 0, 'No contemporaneous native baseline was observed');
});

test('unchanged correlated zero reads preserve native continuity while a newly plugged car waits', t => {
  const f = fixture(t); f.config.maxAgeMs = 1000;
  f.reference(0, START - 5000); f.connect();
  f.reference(0, START - 5000, START + 200, true);
  for (let second = 1; second <= 15; second++) {
    f.reference(0, START - 5000, START + second * 1000, true);
    if (second === 10) f.restart();
  }
  f.work('charging', START + 15_000);
  const end = START + 16_000;
  f.reference(.02, end); f.energy(START, end, .02); f.end(end); f.tick(end + 2000);
  const [check] = f.checks();
  assert.equal(check.complete, true); near(check.referenceKwh, .02);
  assert(!check.quality.includes('reference-coverage-gap'));
});
