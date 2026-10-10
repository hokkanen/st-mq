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
    enabled: true,
    clock: () => now, publish: async (topic, payload, settings) => { settings.beforePublish(); publications.push({ topic, ...JSON.parse(payload), settings }); },
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

test('loaded configuration reconciles on fresh status and only matching readback confirms it', async () => {
  const desired = { ...garageSettings().protection, approved: true, marginC: 1.5 };
  const f = fixture({ protection: desired });
  assert.deepEqual(f.sender.status().configuredSettings, desired);
  assert.equal(f.sender.status().configuration.status, 'unknown');
  assert.equal(f.publications.length, 0);
  assert.equal(f.sender.setConfiguration, undefined, 'There is no dashboard settings mutation entrypoint');
  f.receive();
  assert.equal(f.sender.status().settings.approved, false);
  assert.equal(f.sender.status().result.status, 'published');
  assert.equal(f.sender.status().configuration.status, 'pending');
  assert.deepEqual(f.publications[0].config, desired);
  const { beforePublish, signal, ...wireSettings } = f.publications[0].settings;
  assert.equal(typeof beforePublish, 'function'); assert(signal instanceof AbortSignal);
  assert.deepEqual(wireSettings, { qos: 0, retain: false, noReplay: true });
  await f.sender.reconcile();
  assert.equal(f.publications.length, 1);
  f.receive({ result: { commandId: f.publications[0].commandId, status: 'applied' } });
  assert.equal(f.sender.status().result.status, 'applied');
  assert.equal(f.sender.status().configuration.status, 'pending', 'An applied result without matching values is insufficient');
  f.receive({ config: desired, result: { commandId: f.publications[0].commandId, status: 'applied' } });
  assert.equal(f.sender.status().settings.approved, true);
  assert.equal(f.sender.status().result.status, 'applied');
  assert.equal(f.sender.status().configuration.status, 'confirmed');
  assert.equal(f.publications.length, 1);
});

test('future sender status cannot configure protection until admitted and cannot cross reconnect', async () => {
  const f = fixture({ protection: { ...garageSettings().protection, approved: true } });
  f.receive({ observedAt: base + 400 });
  assert.equal(f.publications.length, 0); assert.equal(f.sender.status().available, false);
  f.at(base + 400); f.sender.tick();
  assert.equal(f.publications.length, 1); assert.equal(f.sender.status().available, true);
  assert.equal(f.sender.snapshot().state.receivedAt, base);
  assert.equal(f.sender.snapshot().state.admittedAt, base + 400);
  f.receive({ observedAt: base + 800 });
  f.sender.setConnected(false); f.sender.setConnected(true);
  f.at(base + 800); f.sender.tick();
  assert.equal(f.sender.status().available, false);
  await f.sender.close();
});

test('expired pending sender state revokes earlier protection status until fresh readback', async () => {
  let elapsed = 0;
  const f = fixture({ monotonicClock: () => elapsed }); f.receive();
  assert.equal(f.sender.status().available, true);
  f.receive({ observedAt: base + 400 });
  elapsed = 5000; f.sender.tick();
  assert.equal(f.sender.status().available, false);
  assert.equal(f.sender.status().configuration.status, 'unknown');
  f.at(base + 1000); f.receive(); assert.equal(f.sender.status().available, true);
  assert.equal(f.publications.length, 0); await f.sender.close();
});

test('retained status is recorded but does not authorize settings or provide current frost protection', async () => {
  const f = fixture({ protection: { ...garageSettings().protection, approved: true } });
  assert.equal(f.receive({}, { retain: true }), true);
  assert.equal(f.snapshots.length, 1); assert.equal(f.observations.length, 0);
  assert.equal(f.sender.status().available, false); assert.equal(f.sender.status().protection, null);
  await f.sender.reconcile(); assert.equal(f.publications.length, 0);
  f.receive(); assert.equal(f.sender.status().available, true);
  assert.equal(f.publications.length, 1);
  assert.equal(f.observations[0].signal, 'garage_pipe_rear_temperature');
  assert.deepEqual(f.observations[0].quality, ['estimated']);
  f.at(base + 180_000);
  assert.equal(f.sender.status().protection, null);
  assert.equal(f.sender.status().configuration.status, 'unknown');
  await f.sender.reconcile(); assert.equal(f.publications.length, 1);
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

test('sender rejects invalid configuration and telemetry without accepting dashboard edits', async () => {
  const f = fixture(); f.receive();
  assert.equal(f.receive({ sequence: 1 }), false);
  assert.equal(f.receive({ config: { ...f.config, pipeWallMm: 20 } }), false);
  assert.equal(f.receive({ observedAt: base - 180_000 }), false);
  assert.throws(() => fixture({ protection: { marginC: 1 } }), /complete current/);
  assert.throws(() => fixture({ protection: { ...f.config, pipeOutsideDiameterMm: 6, pipeWallMm: 3 } }), /positive water diameter/);
  assert.equal(f.publications.length, 0);
});

test('read-only and disabled instances never synchronize mismatching local settings', async () => {
  for (const options of [{ enabled: false }, { canControl: () => false }]) {
    const f = fixture({ protection: { ...garageSettings().protection, approved: true }, ...options });
    f.receive(); await f.sender.reconcile();
    assert.equal(f.sender.status().configuration.status, 'mismatch');
    assert.match(f.sender.status().configuration.reason, /disabled|read-only/);
    assert.equal(f.publications.length, 0);
  }
});

test('missing confirmation retries once with an unused challenge, then stops until configuration reload', async () => {
  const f = fixture({ protection: { ...garageSettings().protection, approved: true } });
  f.receive({ challenge: 'first-challenge' });
  f.at(base + 30_000); await f.sender.reconcile();
  assert.equal(f.publications.length, 1, 'A used challenge never authorizes another command');
  assert.equal(f.sender.status().configuration.status, 'mismatch');
  f.receive({ challenge: 'second-challenge' });
  assert.equal(f.publications.length, 2);
  assert.equal(f.sender.status().configuration.status, 'pending');
  f.at(base + 60_000);
  for (let index = 0; index < 10; index++) { f.receive(); await f.sender.reconcile(); }
  assert.equal(f.publications.length, 2);
  assert.equal(f.sender.status().configuration.status, 'mismatch');
  assert.match(f.sender.status().configuration.reason, /Apply configuration to retry/);
  f.sender.setConnected(false); f.sender.setConnected(true); f.receive({ bootId: 'new-boot' });
  assert.equal(f.publications.length, 2, 'Broker and sender restarts cannot restart an exhausted retry loop');
});

test('explicitly rejected or failed configuration is not retried on each new report', async () => {
  for (const status of ['rejected', 'failed']) {
    const f = fixture({ protection: { ...garageSettings().protection, approved: true } });
    f.receive();
    f.receive({ result: { commandId: f.publications[0].commandId, status } });
    f.at(base + 60_000);
    for (let index = 0; index < 5; index++) { f.receive(); await f.sender.reconcile(); }
    assert.equal(f.publications.length, 1);
    assert.equal(f.sender.status().configuration.status, 'mismatch');
    assert.equal(f.sender.status().settings.approved, false);
    assert.equal(f.sender.status().result.status, status);
  }
});

test('matching settings need no writes; later drift reconciles the same immutable loaded configuration', () => {
  const desired = { ...garageSettings().protection, approved: true };
  const f = fixture({ protection: desired });
  f.receive({ config: desired });
  assert.equal(f.sender.status().configuration.status, 'confirmed');
  assert.equal(f.publications.length, 0);
  desired.marginC = 2;
  f.receive();
  assert.equal(f.publications.length, 1);
  assert.equal(f.publications[0].config.marginC, 1, 'Mutating the caller object cannot change loaded parameters');
});

test('restart or reload takes desired settings from current configuration, never the saved sender readback', () => {
  const prior = fixture({ protection: { ...garageSettings().protection, approved: true } });
  prior.receive({ config: { ...prior.config, approved: true } });
  const f = fixture({ persisted: prior.sender.snapshot() });
  assert.equal(f.sender.status().configuration.status, 'unknown');
  assert.equal(f.publications.length, 0);
  f.receive({ config: { ...f.config, approved: true } });
  assert.equal(f.publications[0].config.approved, false, 'Withdrawn configuration approval is sent after fresh readback');
  assert.equal(f.sender.status().settings.approved, true, 'Reported approval remains actual until confirmed');
});

test('failed delivery remains pending and a delayed failure cannot overwrite confirming readback', async () => {
  let reject;
  const f = fixture({ protection: { ...garageSettings().protection, approved: true },
    publish: () => new Promise((_resolve, fail) => { reject = fail; }) });
  f.receive();
  f.receive({ config: { ...f.config, approved: true } });
  reject(new Error('synthetic delivery failure')); await Promise.resolve();
  assert.equal(f.sender.status().configuration.status, 'confirmed');
  assert.equal(f.sender.status().result.status, 'published');
});

test('closed sender cannot reconcile from late status or reconnect callbacks', async () => {
  const f = fixture({ protection: { ...garageSettings().protection, approved: true } });
  await f.sender.close();
  assert.equal(f.receive(), false);
  f.sender.setConnected(true);
  assert.equal(f.receive(), false);
  await f.sender.reconcile();
  assert.equal(f.publications.length, 0);
  assert.equal(f.sender.status().configuration.status, 'unknown');
});

test('sender configuration waits and revalidates identity, challenge and authority before dispatch', async () => {
  for (const scenario of ['success', 'challenge', 'reboot', 'disconnect', 'close', 'authority', 'expiry']) {
    let release, flags, sent = 0, allowed = true;
    const f = fixture({ protection: { ...garageSettings().protection, approved: true }, canControl: () => allowed,
      publish: (_topic, _payload, options) => new Promise((resolve, reject) => {
        flags = options; options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        release = () => { try { options.beforePublish(); sent++; resolve(); } catch (error) { reject(error); } };
      }) });
    f.receive(); assert.equal(sent, 0); assert(flags.signal instanceof AbortSignal);
    const releaseOriginal = release;
    if (scenario === 'challenge') f.receive();
    if (scenario === 'reboot') f.receive({ bootId: 'other-boot' });
    if (scenario === 'disconnect') { f.sender.setConnected(false); f.sender.setConnected(true); }
    if (scenario === 'close') await f.sender.close();
    if (scenario === 'authority') allowed = false;
    if (scenario === 'expiry') f.at(base + 30_000);
    releaseOriginal(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent, scenario === 'success' ? 1 : 0, scenario);
    await f.sender.close();
  }
});
