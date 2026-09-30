import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaravanProbe, advanceCaravanProbe, abortCaravanProbe,
  CARAVAN_PROBE_PHASE_TIMEOUT_MS, CARAVAN_PROBE_MAX_SAMPLES } from '../src/acquisition/caravan-location.js';

const START = 1_000_000;
function fixture(initialPower = 'off') {
  const state = createCaravanProbe({ now: START, initialPower });
  return { state, step: (offset, power, watts, overrides = {}) => advanceCaravanProbe(state,
    { now: START + offset, power, powerObservedAt: START + offset,
      meterPowerW: watts, meterObservedAt: START + offset, ...overrides }) };
}

test('small fan-only rise and matching fall establish electrical evidence without humidity', () => {
  const f = fixture();
  assert.equal(f.step(0, 'off', 100).command, null);
  assert.equal(f.step(5000, 'off', 100).command, 'on');
  assert.equal(f.step(6000, 'on', 106).command, null);
  assert.equal(f.step(11000, 'on', 106).command, 'off');
  assert.equal(f.step(12000, 'off', 100).status, 'testing');
  const result = f.step(17000, 'off', 100);
  assert.equal(result.status, 'passed');
  assert.deepEqual([result.evidence.baselineW, result.evidence.onW, result.evidence.offW], [100, 106, 100]);
  assert.equal(result.evidence.powerRiseW, 6); assert.equal(result.evidence.powerFallW, 6);
  assert.deepEqual(result.evidence.onSamples.map(row => row.at), [START + 6000, START + 11000]);
  assert.equal(result.evidence.startedAt, START); assert.equal(result.evidence.completedAt, START + 17000);
  assert.equal(f.step(18000, 'off', 100).command, null, 'A completed session never starts another check');
});

test('an initially powered appliance first shuts down natively and waits for cooling to finish', () => {
  const f = fixture('on');
  assert.equal(f.step(0, 'on', 550).command, 'off');
  assert.equal(f.step(1000, 'on', 550).command, null);
  assert.equal(f.step(5000, 'off', 400).command, null);
  assert.equal(f.step(10000, 'off', 300).command, null);
  assert.equal(f.step(15000, 'off', 50).command, null);
  assert.equal(f.step(20000, 'off', 50).command, 'on');
  assert.equal(f.state.baseline.watts, 50);
});

test('independent native confirmation and meter clocks are required after each command', () => {
  const f = fixture(); f.step(0, 'off', 0); f.step(5000, 'off', 0);
  assert.equal(f.step(10000, 'on', 10, { powerObservedAt: START + 4000 }).command, null);
  assert.equal(f.step(15000, 'off', 10).command, null);
  assert.equal(f.step(20000, 'on', 10, { meterObservedAt: START + 5000 }).command, null);
  assert.equal(f.step(25000, 'on', 10, { meterObservedAt: START + 19000 }).command, null,
    'Meter evidence before the matching native report cannot count');
  f.step(30000, 'on', 10);
  assert.equal(f.step(40000, 'on', 10, { powerObservedAt: START + 30000, meterObservedAt: START + 30000 }).command, null);
  assert.equal(f.step(45000, 'on', 10).command, 'off');
});

test('cached reports and elapsed time cannot create stable baseline evidence', () => {
  const f = fixture(); f.step(0, 'off', 1);
  for (const offset of [5000, 10000, 15000]) {
    assert.equal(f.step(offset, 'off', 1, { meterObservedAt: START }).command, null);
  }
  assert.equal(f.state.samples.length, 1);
  assert.equal(f.step(CARAVAN_PROBE_PHASE_TIMEOUT_MS, 'off', 1).status, 'failed');
});

test('an appliance elsewhere leaves a flat meter response and never authorizes recording', () => {
  const f = fixture(); f.step(0, 'off', 30); f.step(5000, 'off', 30);
  for (let offset = 6000; offset < 185000; offset += 5000) {
    assert.equal(f.step(offset, 'on', 30).status, 'testing');
    assert(f.state.samples.length <= CARAVAN_PROBE_MAX_SAMPLES);
  }
  const result = f.step(185000, 'on', 30);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'no-power-rise');
  assert.equal(f.step(190000, 'on', 500).command, null, 'Failure needs a new online session');
});

test('near-zero fluctuations do not qualify while startup delay may settle later', () => {
  const f = fixture(); f.step(0, 'off', 0); f.step(5000, 'off', 0);
  f.step(6000, 'on', 1); assert.equal(f.step(11000, 'on', 1).command, null);
  f.step(12000, 'on', 2); assert.equal(f.step(17000, 'on', 2).command, null);
  f.step(90000, 'on', 9); assert.equal(f.step(95000, 'on', 9).command, 'off');
});

test('native Off readback alone is insufficient and delayed cooldown can complete', () => {
  const f = fixture(); f.step(0, 'off', 20); f.step(5000, 'off', 20);
  f.step(6000, 'on', 220); f.step(11000, 'on', 220);
  f.step(12000, 'off', 210); assert.equal(f.step(17000, 'off', 210).status, 'testing');
  f.step(20000, 'off', 40); assert.equal(f.step(25000, 'off', 40).status, 'passed');
});

test('an unmatched fall or unrelated baseline shift cannot qualify', () => {
  const f = fixture(); f.step(0, 'off', 100); f.step(5000, 'off', 100);
  f.step(6000, 'on', 200); f.step(11000, 'on', 200);
  f.step(12000, 'off', 160); assert.equal(f.step(17000, 'off', 160).status, 'testing');
  f.step(22000, 'off', 0); assert.equal(f.step(27000, 'off', 0).status, 'testing');
  assert.equal(f.step(191000, 'off', 160).reason, 'no-matching-power-fall');
});

test('meter noise raises the required response and invalid evidence remains unknown', () => {
  const f = fixture();
  for (const watts of [null, undefined, NaN, Infinity, -1]) f.step(0, 'off', watts);
  assert.equal(f.state.samples.length, 0);
  f.step(0, 'off', 1000); f.step(5000, 'off', 1008);
  f.step(6000, 'on', 1013); assert.equal(f.step(11000, 'on', 1013).command, null);
  f.step(16000, 'on', 1025); assert.equal(f.step(21000, 'on', 1025).command, 'off');
});

test('probe state survives transaction cloning and explicit interruption is terminal', () => {
  const f = fixture('on'); f.step(0, 'on', 100);
  const cloned = structuredClone(f.state);
  assert.deepEqual(JSON.parse(JSON.stringify(cloned)), f.state);
  const result = abortCaravanProbe(cloned, 'authority-unavailable', START + 1000);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'authority-unavailable');
  assert.equal(result.evidence.completedAt, START + 1000);
  assert.equal(advanceCaravanProbe(cloned, { now: START + 10000 }).command, null);
});

test('a newer independently observed power change cancels a confirmed phase', () => {
  const f = fixture(); f.step(0, 'off', 0); f.step(5000, 'off', 0);
  assert.equal(f.step(6000, 'off', 0).status, 'testing', 'Before native On confirmation the original state may remain');
  f.step(7000, 'on', 10);
  const interrupted = f.step(8000, 'off', 0);
  assert.equal(interrupted.status, 'failed'); assert.equal(interrupted.reason, 'power-changed-externally');
  assert.equal(interrupted.command, null);
  assert.deepEqual(interrupted.evidence.phases.on, { commandAt: START + 5000,
    firstPowerObservedAt: START + 7000, lastPowerObservedAt: START + 7000 });
});

test('repeated native confirmations do not fence out slightly delayed fresh meter samples', () => {
  const f = fixture(); f.step(0, 'off', 0); f.step(5000, 'off', 0);
  f.step(6000, 'on', 10, { meterObservedAt: START + 5500 });
  assert.equal(f.state.samples.length, 0, 'The meter must still follow the first native phase confirmation');
  f.step(10000, 'on', 10, { meterObservedAt: START + 9000 });
  assert.equal(f.step(15000, 'on', 10, { meterObservedAt: START + 14000 }).command, 'off');
  f.step(16000, 'off', 0, { meterObservedAt: START + 15500 });
  assert.equal(f.state.samples.length, 0);
  f.step(20000, 'off', 0, { meterObservedAt: START + 19000 });
  const result = f.step(25000, 'off', 0, { meterObservedAt: START + 24000 });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.evidence.onSamples.map(sample => sample.at), [START + 9000, START + 14000]);
  assert.equal(result.evidence.phases.on.firstPowerObservedAt, START + 6000);
  assert.equal(result.evidence.phases.on.lastPowerObservedAt, START + 15000);
});
