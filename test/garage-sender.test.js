import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageSender, GARAGE_SENDER_CONTRACT } from '../src/garage/sender.js';
import { garageSettings } from '../src/garage/settings.js';
const base = 1_800_000_000_000;
function fixture(options = {}) {
  let now = base, sequence = 0;
  const publications = [], observations = [], snapshots = [];
  const config = garageSettings().protection;
  const sender = createGarageSender({ settings: { stateTopic: 'test/sender/state', commandTopic: 'test/sender/command' },
    clock: () => now, publish: async (topic, payload, settings) => publications.push({ topic, ...JSON.parse(payload), settings }),
    onState: value => snapshots.push(value), onObservation: row => observations.push(row), ...options });
  sender.setConnected(true);
  const receive = (overrides = {}, packet = {}) => sender.receive('test/sender/state', JSON.stringify({
    schema: GARAGE_SENDER_CONTRACT, deviceId: 'test-sender', bootId: 'sender-boot', sequence: ++sequence,
    observedAt: now, challenge: `sender-challenge-${sequence}`, config,
    protection: { available: true, active: false, minTargetC: null, reason: null,
      locations: { rear: { airC: 8, estimatedC: 6, uncertain: false, remainingKjPerM: 7 },
        front: { airC: 7, estimatedC: 5, uncertain: false, remainingKjPerM: 5 } } }, ...overrides }), packet, now);
  return { sender, config, receive, publications, observations, snapshots, at: value => { now = value; } };
}

test('sender settings are readback-owned and command publication cannot masquerade as applied configuration', async () => {
  const f = fixture(); f.receive();
  const desired = { ...f.config, approved: true, marginC: 1.5 };
  await f.sender.setConfiguration(desired);
  assert.equal(f.sender.status().settings.approved, false);
  assert.equal(f.sender.status().result.status, 'published');
  assert.deepEqual(f.publications[0].config, desired);
  assert.deepEqual(f.publications[0].settings, { qos: 0, retain: false, noReplay: true });
  await assert.rejects(f.sender.setConfiguration(desired), /accept another command|confirmation/);
  f.receive({ config: desired, result: { commandId: f.publications[0].commandId, status: 'applied' } });
  assert.equal(f.sender.status().settings.approved, true);
  assert.equal(f.sender.status().result.status, 'applied');
});

test('retained status is recorded but does not authorize settings or provide current frost protection', async () => {
  const f = fixture(); assert.equal(f.receive({}, { retain: true }), true);
  assert.equal(f.snapshots.length, 1); assert.equal(f.observations.length, 0);
  assert.equal(f.sender.status().available, false); assert.equal(f.sender.status().protection, null);
  await assert.rejects(f.sender.setConfiguration(f.config), /fresh local frost-protection unit status/);
  f.receive(); assert.equal(f.sender.status().available, true);
  assert.equal(f.observations[0].signal, 'garage_pipe_rear_temperature');
  assert.deepEqual(f.observations[0].quality, ['estimated']);
  f.at(base + 180_000);
  assert.equal(f.sender.status().protection, null);
});

test('unapproved settings, unknown pipes and missing feed remain distinct from safe protection', () => {
  const f = fixture();
  assert.equal(f.sender.status().available, false);
  f.receive({ protection: { available: false, active: false, minTargetC: null, reason: 'pipe-estimate-unknown',
    locations: { rear: { airC: 7, estimatedC: null, uncertain: true, remainingKjPerM: 12 },
      front: { airC: 8, estimatedC: null, uncertain: true } } } });
  assert.equal(f.sender.status().settings.approved, false);
  assert.equal(f.sender.status().protection.available, false);
  assert.equal(f.sender.status().protection.locations.rear.remainingKjPerM, null);
  assert.deepEqual(f.observations[0].quality, ['unknown']);
});

test('sender cannot accept invalid geometry, partial settings, stale sequences or read-only edits', async () => {
  const f = fixture({ canControl: () => false }); f.receive();
  assert.equal(f.receive({ sequence: 1 }), false);
  assert.equal(f.receive({ config: { ...f.config, pipeWallMm: 20 } }), false);
  await assert.rejects(f.sender.setConfiguration({ marginC: 1 }), /complete current/);
  await assert.rejects(f.sender.setConfiguration(f.config), /read-only/);
  assert.equal(f.publications.length, 0);
});
