import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShellyBoot, shellyBootInterval, shellyRebootBaseline,
  validShellyBootSample, validShellyBootState, validShellyRebootEvent, shellyRebootSettings } from '../src/charging/shelly-compatibility.js';

const T = 1_800_000_000_000;
const sample = (at, uptime, delay = 100) => ({ uptime, unixtime: Math.floor(at / 1000), requestedAt: at, receivedAt: at + delay });
const epoch = '12345678-1234-1234-1234-123456789abc';
const boot = () => ({ epoch, anchor: sample(T, 2), sequence: 0, events: [], incident: {
  id: epoch, detectedAt: T + 5100, phase: 'checking', reason: 'checking', samples: [sample(T, 2), sample(T + 5000, 7)],
  connectedAt: T - 100000, reconciledAt: null, issueObserved: false, controlRestoredAt: null,
} });
const fields = (at, source = 'sys') => Object.fromEntries(Object.entries({ start_charging: false, current_limit: 12, work_state: 'charger_insert' })
  .map(([role, value]) => [role, { value, measuredAt: at, receivedAt: T + 10000, commandSource: source, retained: false }]));
const policy = (after, before = fields(T - 10000)) => shellyRebootBaseline({ boot: boot(), before, after,
  connectedStates: ['charger_insert', 'charger_end'], disconnectedStates: ['charger_free'], now: T + 10000 });

test('uptime detects reset and a reboot whose new uptime exceeds the previous sample', () => {
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T + 5000, 1), elapsedMs: 5000 }), 'reboot');
  assert.equal(classifyShellyBoot({ previous: sample(T, 2), sample: sample(T + 60000, 10), elapsedMs: 60000 }), 'reboot');
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T + 5000, 105), elapsedMs: 5000 }), 'same');
});
test('clock steps and backward/invalid observations never establish a reboot', () => {
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T + 60000, 101), elapsedMs: 1000 }), 'unknown');
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T - 1000, 1), elapsedMs: 1000 }), 'unknown');
  for (const invalid of [{}, sample(T, -1), sample(T, 1, 5001), { ...sample(T, 1), unixtime: 0 }, { ...sample(T, 1), uptime: 1.5 }])
    assert.equal(validShellyBootSample(invalid), false);
});

test('a slightly early system clock requires its original admission proof', () => {
  const early = { ...sample(T, 2, 0), unixtime: T / 1000 + 1 };
  assert.equal(validShellyBootSample(early), false);
  assert.equal(validShellyBootSample({ ...early, admittedAt: T + 1000 }), true);
});
test('a persisted anchor needs both lower uptime and a later bounded boot without a monotonic reference', () => {
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T + 5000, 1) }), 'reboot');
  assert.equal(classifyShellyBoot({ previous: sample(T, 2), sample: sample(T + 60000, 10) }), 'unknown');
  assert.equal(classifyShellyBoot({ previous: sample(T, 100), sample: sample(T + 5000, 105) }), 'same');
});
test('bootstrap needs a successfully recorded read before the entire new boot interval', () => {
  assert.equal(classifyShellyBoot({ sample: sample(T, 2), lastReadAt: T - 10000 }), 'reboot');
  assert.equal(classifyShellyBoot({ sample: sample(T, 2), lastReadAt: T - 1000 }), 'initial');
  assert.equal(classifyShellyBoot({ sample: sample(T, 2) }), 'initial');
  assert.deepEqual(shellyBootInterval(sample(T, 2)), { lower: T - 3000, upper: T - 1900 });
});
test('only correlated SYS startup evidence receives backward-clock reconciliation', () => {
  const before = fields(T - 10000); before.work_state.value = 'charger_end';
  assert.equal(policy(fields(T - 20000), before).workaround, true);
  for (const source of ['rpc', null, 'unknown']) assert.equal(policy(fields(T - 20000, source), before).allowed, false);
  assert.equal(policy(fields(T - 1000), before).workaround, false, 'A newer SYS change uses ordinary permission policy');
  assert.equal(policy(fields(T + 1000, 'rpc'), before).allowed, true, 'Newer independent evidence uses ordinary precedence');
});
test('malformed, retained, future and unknown native states cannot establish a baseline', () => {
  for (const change of [row => { row.work_state.value = 'charger_fault'; }, row => { row.current_limit.value = NaN; },
    row => { row.start_charging.value = null; }, row => { row.work_state.retained = true; },
    row => { row.current_limit.measuredAt = T + 20000; }, row => { delete row.work_state; }]) {
    const after = fields(T - 20000); change(after); assert.equal(policy(after).allowed, false);
  }
});
test('boot state and report evidence reject unknown fields and private/unbounded metadata', () => {
  assert.equal(validShellyBootState(undefined), true);
  assert.equal(validShellyBootState(boot()), true);
  for (const change of [row => { row.secret = 'fixture-unrecognized'; }, row => { row.epoch = 'bad'; },
    row => { row.anchor.uptime = -1; }, row => { row.incident.issueObserved = 'yes'; }]) {
    const value = boot(); change(value); assert.equal(validShellyBootState(value), false);
  }
  const event = { sequence: 1, at: T + 10000, code: 'shelly-reboot-observed', incidentId: epoch,
    connectedAt: T - 100000, policy: 'reboot-state', firmware: 'synthetic-firmware', reboot: { samples: [sample(T, 2)] } };
  assert.equal(validShellyRebootEvent(event), true);
  assert.equal(validShellyRebootEvent({ ...event, deviceId: 'private' }), false);
  assert.equal(validShellyRebootEvent({ ...event, firmware: 'https://fixture.invalid/?token=fixture-not-a-secret' }), false);
  assert.equal(validShellyRebootEvent({ ...event, reboot: { samples: Array(4).fill(sample(T, 2)) } }), false);
});

test('zero native update clock represents unknown time only for an off default in confirmed recovery', () => {
  const after = fields(T - 20000);
  after.start_charging = { value: false, measuredAt: null, nativeUpdatedAt: 0, receivedAt: T + 10000, commandSource: '' };
  assert.equal(policy(after).allowed, true); assert.equal(policy(after).workaround, true);
  for (const change of [row => { row.value = true; }, row => { row.commandSource = 'rpc'; },
    row => { row.commandSource = null; }, row => { delete row.nativeUpdatedAt; },
    row => { row.nativeUpdatedAt = -1; }, row => { row.measuredAt = 0; },
    row => { row.admittedAt = T + 10000; }]) {
    const invalid = structuredClone(after); change(invalid.start_charging);
    assert.equal(policy(invalid).allowed, false);
  }
  after.start_charging.readback = { admittedAt: T + 11000 };
  assert.equal(policy(after).allowed, false);
  after.start_charging.readback.admittedAt = T + 10000;
  assert.equal(policy(after).allowed, true);
  const detail = shellyRebootSettings(after);
  assert.equal(detail.start_charging.measuredAt, null); assert.equal(detail.start_charging.nativeUpdatedAt, 0);
  const event = { sequence: 1, at: T + 10000, code: 'shelly-reboot-reconciliation', incidentId: epoch,
    connectedAt: T - 100000, policy: 'reboot-state', reboot: { after: detail } };
  assert.equal(validShellyRebootEvent(event), true);
});
