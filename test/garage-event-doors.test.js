import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { GARAGE_ALGORITHM_VERSION, createGarageModel, updateGarageModel } from '../src/garage/model.js';
import { garagePlanningEvidence } from '../src/garage/planning-evidence.js';
import { appendGarageEntry, applyGarageEntry, replayGarageJournal, garageInput } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';
import { startGarageAssessment, updateGarageAssessment } from '../src/garage/episodes.js';

const START = Date.parse('2026-01-01T00:00:00Z'), MINUTE = 60_000;
const signal = 'garage_door1_open';
const device = { id: 'garage_door1', label: 'Invented garage door', area: 'garage', kind: 'door',
  connection: 'mqtt:invented/garage/contact', mqtt: { state_path: 'value', timestamp_path: 'timestamp',
    availability_topic: 'invented/garage/online', bridge_availability_topic: 'invented/bridge/status' } };

function setup(t) {
  let now = START;
  const store = new Store(':memory:');
  const equipment = equipmentConfiguration({ devices: [device] });
  const config = { input: 'mqtt', settings: { mode: 'shadow' }, connections: { equipment } };
  const engine = new Engine({ store, config, clock: () => now, canControl: () => false });
  const capture = createEquipmentCapture({ engine, store, settings: equipment, publish: async () => {}, canControl: () => false });
  capture.setConnected(true);
  const status = (value = 'closed', at = START) => capture.receive('invented/garage/contact', JSON.stringify({ value, timestamp: at }));
  const online = () => capture.receive('invented/garage/online', 'online');
  t.after(async () => { capture.close(); await engine.garage.close({ restore: false }); store.close(); });
  return { store, config, engine, capture, status, online, at: value => { now = value; } };
}

test('unchanged confirmed door remains a model input for days without renewing its source timestamp', t => {
  const f = setup(t); f.online(); f.status();
  f.at(START + 7 * 86400_000);
  const observation = f.engine.garage.read();
  assert.equal(observation.doors.door1.open, false);
  assert.equal(observation.doors.door1.observedAt, START);
  assert.equal(observation.doors.door1.closedSince, START);
  assert.equal(observation.doorFront, false);
  assert.equal(observation.doorEvidenceRequired, true);
});

test('live contact and availability recover old state in either order while preserving the outage boundary', async t => {
  for (const onlineFirst of [true, false]) await t.test(onlineFirst ? 'availability first' : 'contact first', t => {
    const f = setup(t); f.online(); f.status();
    f.at(START + 20 * MINUTE); f.capture.receive('invented/bridge/status', 'offline');
    assert.equal(f.engine.garage.read().doorFront, null);
    f.at(START + 21 * MINUTE); f.capture.receive('invented/bridge/status', 'online');
    if (onlineFirst) f.online(); else f.status();
    assert.equal(f.engine.garage.read().doorFront, null);
    f.at(START + 22 * MINUTE);
    if (onlineFirst) f.status(); else f.online();
    const observation = f.engine.garage.read();
    assert.equal(observation.doorFront, false);
    assert.equal(observation.doors.door1.observedAt, START);
    assert.equal(observation.doorClosedSince, START + 22 * MINUTE);
    assert.equal(observation.doors.door1.availableSince, START + 22 * MINUTE);
  });
});

test('unavailable, invalid and restarted door inputs remain unknown until live confirmation', t => {
  const f = setup(t); f.online(); f.status();
  f.at(START + MINUTE); f.status(null);
  assert.equal(f.engine.garage.read().doorFront, null);
  f.capture.receive('invented/garage/contact', JSON.stringify({ value: 'closed', timestamp: START }), { retain: true });
  assert.equal(f.engine.garage.read().doorFront, null);
  f.at(START + 2 * MINUTE); f.status();
  assert.equal(f.engine.garage.read().doorFront, false);
  f.capture.setConnected(false);
  assert.equal(f.engine.garage.read().doorFront, null);
  f.capture.setConnected(true); f.online();
  assert.equal(f.engine.garage.read().doorFront, null);
  f.status();
  const restarted = new Engine({ store: f.store, config: f.config, clock: () => START + 3 * MINUTE });
  assert.equal(restarted.garage.read().doorFront, null);
  t.after(() => restarted.garage.close({ restore: false }));
});

test('a brief opening between temperature samples ends known-closed continuity', t => {
  const f = setup(t); f.online(); f.status();
  f.at(START + 2 * MINUTE); f.status('open', START + 2 * MINUTE);
  f.at(START + 3 * MINUTE); f.status('closed', START + 3 * MINUTE);
  f.at(START + 10 * MINUTE);
  assert.equal(f.engine.garage.read().doorFront, false);
  assert.equal(f.engine.garage.read().doorClosedSince, START + 3 * MINUTE);
});

test('unconfirmed cached or delayed reports cannot recover an engine availability transition', t => {
  const f = setup(t); f.online(); f.status();
  f.at(START + 10 * MINUTE); f.capture.setConnected(false);
  const report = { source: 'mqtt-equipment', device: 'garage_door1', signal, value: 0, unit: 'state',
    sourceTime: START, receivedAt: START + 11 * MINUTE, quality: [], raw: { eventOnly: true } };
  f.at(START + 11 * MINUTE); f.engine.rememberObservation(report, START + 11 * MINUTE);
  assert.equal(f.engine.garage.read().doorFront, null);
  f.engine.rememberObservation({ ...report, receivedAt: START + 9 * MINUTE,
    raw: { eventOnly: true, availabilityConfirmed: true, confirmedAt: START + 11 * MINUTE } }, START + 11 * MINUTE);
  assert.equal(f.engine.garage.read().doorFront, null);
});

const sample = (minute, extra = {}) => ({ at: START + minute * MINUTE, rearAt: START + minute * MINUTE,
  frontAt: START + minute * MINUTE, rearC: 7, frontC: 6.7, outdoorC: 0, available: false,
  doorEvidenceRequired: true, doorFront: false, doorClosedSince: START, ...extra });

test('interrupted door evidence cannot train or validate and replay keeps the original interval decision', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const settings = garageSettings(), seed = createGarageModel({ seedAt: START });
  const observations = [sample(0), sample(10), sample(20, { doorClosedSince: START + 15 * MINUTE }),
    sample(30, { doorClosedSince: START + 15 * MINUTE }), sample(40, { doorFront: null, doorClosedSince: null })];
  let checkpoint = null;
  const checkpoints = [];
  for (const [index, observation] of observations.entries()) {
    const entry = appendGarageEntry(store, 'mqtt', 'sample', observation, settings, observation.at, { seed, key: `event-door-${index}` });
    checkpoint = applyGarageEntry(checkpoint, entry); checkpoints.push(checkpoint);
  }
  assert.equal(checkpoints[1].model.trainedIntervals, 1);
  assert.equal(checkpoints[2].model.trainedIntervals, 1, 'The recovered endpoint cannot erase an intervening outage/opening');
  assert.equal(checkpoints[2].model.validation.active.clean, false);
  assert.equal(checkpoints[3].model.trainedIntervals, 2, 'A later uninterrupted closed interval can train again');
  assert.equal(checkpoints[4].model.trainedIntervals, 2);
  assert.deepEqual(replayGarageJournal(store, 'mqtt'), checkpoint);
  assert.equal(checkpoint.algorithmVersion, GARAGE_ALGORITHM_VERSION);
});

test('configured unknown and open doors preserve recorded validation evidence', () => {
  const model = createGarageModel({ seedAt: START });
  model.normalReference.initialized = true;
  const summary = { thermalReady: true, electricalReady: true, validatedOffHours: 2 };
  for (const doorFront of [null, true]) {
    const evidence = garagePlanningEvidence(model, summary, { now: START,
      observation: sample(0, { doorFront, available: true, baselineAccepted: true }) });
    assert.equal(evidence.validatedOffHours, 2);
    assert.equal(evidence.eligible, true, 'Door admission is separate from recorded model evidence');
  }
  assert.equal(garagePlanningEvidence(model, summary, { now: START, observation: sample(0) }).validatedOffHours, 2);
});

test('a door gap with recovered endpoints preserves cost observations but ends the savings qualification', () => {
  const first = sample(0), model = updateGarageModel(null, first);
  const initial = startGarageAssessment(model, first);
  initial.previous.rearAt = START - MINUTE;
  assert.equal(updateGarageAssessment(initial, model, sample(10),
    { recordedKwh: .01, priceCtPerKwh: 10 }).qualified, true,
  'Accounting continuity starts at the assessment time, independently of temperature source age');
  const interrupted = updateGarageAssessment(initial, model, sample(10, { doorClosedSince: START + 5 * MINUTE }),
    { recordedKwh: .01, priceCtPerKwh: 10 });
  assert.equal(interrupted.qualified, false);
  assert.equal(interrupted.actualKwh, .01);
  assert.equal(interrupted.steps, 1);
  const recovered = updateGarageAssessment(interrupted, model, sample(20, { doorClosedSince: START + 5 * MINUTE }),
    { recordedKwh: .01, priceCtPerKwh: 10 });
  assert.equal(recovered.qualified, false);
  assert.equal(recovered.actualKwh, .02);
});

test('previous event-age algorithms are rejected without creating an archive continuation', () => {
  const store = new Store(':memory:');
  try {
    store.setState('garage:checkpoint:mqtt', { algorithmVersion: 'committed-garage-v2-sparse' });
    const config = { input: 'mqtt', connections: {}, settings: { mode: 'shadow' } };
    assert.throws(() => new Engine({ store, config, clock: () => START }), /Unsupported Garage saved algorithm/);
    assert.equal(store.getState('garage:checkpoint:mqtt').algorithmVersion, 'committed-garage-v2-sparse');
  } finally { store.close(); }
});
