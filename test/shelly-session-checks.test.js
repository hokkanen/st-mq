import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { newShellySessionCheckState, updateShellySessionChecks } from '../src/charging/shelly-session-checks.js';
import { chargingSessionCheckSummaries, comparableChargingSession } from '../src/app/charging-session-checks.js';

const START = 1800000000000, END = START + 10_000, MAX_AGE = 1000;
const association = 'invented-shelly-association';
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function fixture(t, verified = true) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let recorder = new Recorder(store), state = newShellySessionCheckState(), connection = null;
  const config = { maxAgeMs: MAX_AGE, sessionEnergyVerified: verified };
  const run = (now, role, value, at = now, before = () => {}) => store.transaction(() => {
    const prior = structuredClone(state);
    try {
      before();
      updateShellySessionChecks({ state, connection, role, field: role ? { value, measuredAt: at, receivedAt: now, retained: false } : null,
        config, store, recorder, association, now });
      store.setState('test:shelly-session', state);
    } catch (cause) { state = prior; throw cause; }
  });
  return { store, config, state: () => state,
    checks: () => store.events().filter(row => row.type === 'charging-session-check').map(row => row.payload),
    connect(at = START, now = at) { connection = { connected: true, connectedAt: at, sessionId: `invented-session:${at}` }; run(now, 'work_state', 'connected', at); },
    end(at = END, now = at) { connection = { connected: false, lastDisconnectedAt: at }; run(now, 'work_state', 'free', at); },
    reference(value, at, now = at) { run(now, 'energy_charge', value, at); },
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
  assert(check.quality.includes('counter-reset'));
  near(check.estimatedKwh, .02); assert.equal(check.referenceKwh, null, 'A pre-reset running reference is not a completed session');
});

test('a delayed zero native baseline requires complete recorded zero consumption before it', t => {
  for (const before of [0, .001, null]) {
    const f = fixture(t); f.connect();
    if (before !== null) f.energy(START, START + 500, before);
    f.reference(0, START + 500);
    f.energy(START + 500, END, .02); f.reference(.02, END); f.end(); f.tick();
    const [check] = f.checks();
    assert.equal(check.complete, before === 0);
    assert.equal(check.quality.includes('missing-start'), before !== 0);
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

test('a next-session positive reference cannot finalize the previous connection when its zero reset was missed', t => {
  const f = fixture(t); f.connect(); f.reference(0, START); f.energy(START, END, .02);
  f.reference(.02, END); f.end();
  f.reference(.03, END + 100); f.connect(END + 100);
  const [check] = f.checks();
  assert.equal(check.complete, false);
  assert.equal(check.referenceKwh, null);
  assert(check.quality.includes('missing-final-reference'));
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
