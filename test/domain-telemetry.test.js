import test from 'node:test';
import assert from 'node:assert/strict';
import { createH66Decoder, H66_REGISTERS, H66_DOCUMENTATION } from '../src/domain/telemetry.js';
import { auxiliaryCounterDelta, assessPhaseCurrents } from '../src/domain/counters.js';

// Authored offline fixtures following Husdata MQTT topic documentation and C60.pdf revision
// 2025-10-03, consulted 2026-09-06. NOT captures from installed hardware. Scale is synthetic.
const at = '2026-09-06T12:00:00Z';
const ms = Date.parse(at);
const base = { topic: 'fixture-device/HP/0001', payload: Buffer.from('31.5'), receivedAt: at };
const verifiedRegisters = {
  '0001': { scale: 1, evidence: 'Synthetic test fixture only; not hardware verification' },
  '1A01': { scale: 1, evidence: 'Synthetic status fixture' },
  '3104': { scale: 1, evidence: 'Synthetic percentage fixture' },
  '6C63': { scale: 1, evidence: 'Synthetic counter fixture' },
};
const make = options => createH66Decoder({ deviceId: 'fixture-device', verifiedRegisters, ...options });

test('read-only topics are scoped exactly and never interpret settings, commands or other devices', () => {
  const decoder = make();
  assert.equal(decoder.subscriptionTopic, 'fixture-device/HP/+');
  for (const topic of ['other/HP/0001', 'fixture-device/HP/SET/0203', 'fixture-device/HP/CMD', 'fixture-device/HP/0001/extra']) {
    assert.equal(decoder.decode({ ...base, topic }), null);
  }
  assert.equal(decoder.publish, undefined);
  assert.throws(() => createH66Decoder({ deviceId: '+' }));
  assert.throws(() => createH66Decoder({ deviceId: 'a/b' }));
  assert.equal(H66_REGISTERS['6C66'].signal, 'auxiliary_6kw_hours');
  assert.match(H66_DOCUMENTATION.controller, /C60.pdf$/);
});

test('documented MQTT engineering units and receipt time work without installed overrides', () => {
  const unverified = createH66Decoder({ deviceId: 'fixture-device' }).decode({ ...base, sourceAt: at });
  assert.equal(unverified.value, 31.5);
  assert.equal(unverified.rawNumeric, 31.5);
  assert.equal(unverified.usableForControl, true);
  assert.equal(unverified.installationVerified, false);
  assert.equal(unverified.verification, 'documented-C60-MQTT-engineering-units');
  const noSource = make().decode(base);
  assert.equal(noSource.value, 31.5);
  assert.equal(noSource.sourceAt, null);
  assert.equal(noSource.freshness, 'fresh');
  assert.equal(noSource.observedAt, ms);
  assert.equal(noSource.timeBasis, 'mqtt-received');
  assert.equal(noSource.sensorMeasuredAt, null);
  assert.equal(noSource.usableForControl, true);
  const good = make().decode({ ...base, sourceAt: ms - 10_000 });
  assert.equal(good.quality, 'good');
  assert.equal(good.usableForControl, true);
  assert.throws(() => make({ verifiedRegisters: { '0001': { scale: 0.1 } } }), /verification/);
});

test('C60 settings and optional native pump readings are decoded distinctly', () => {
  const decoder = createH66Decoder({ deviceId: 'fixture-device' });
  for (const [register, value, signal] of [['0208', 60, 'dhw_stop_setting'], ['0212', 40, 'dhw_start_setting'],
    ['1A04', 1, 'brine_pump_active'], ['1A06', 0, 'heating_pump_active'], ['3109', 70, 'heating_pump_speed']]) {
    const reading = decoder.decode({ ...base, topic: `fixture-device/HP/${register}`, payload: String(value) });
    assert.equal(reading.signal, signal);
    assert.equal(reading.value, value);
    assert.equal(reading.usableForControl, true);
  }
  const unknown = decoder.decode({ ...base, topic: 'fixture-device/HP/FFFF', payload: '1' });
  assert.equal(unknown.usableForControl, false);
});

test('retained messages cannot become current plant state, and stale/future readings are explicit', () => {
  const decoder = make();
  const retained = decoder.decode({ ...base, retained: true });
  assert.equal(retained.freshness, 'unknown');
  assert.equal(retained.usableForControl, false);
  const retainedRecent = decoder.decode({ ...base, retained: true, sourceAt: ms - 1 });
  assert.equal(retainedRecent.usableForControl, false);
  const stale = decoder.decode({ ...base, sourceAt: ms - 300_001 });
  assert.equal(stale.freshness, 'stale');
  assert.equal(stale.usableForControl, false);
  const future = decoder.decode({ ...base, sourceAt: ms + 1 });
  assert.equal(future.freshness, 'invalid');
  assert.equal(future.usableForControl, false);
});

test('duplicate messages are bounded while repeated legitimate equal values are observations', () => {
  const decoder = make({ maxDuplicates: 2 });
  assert.equal(decoder.decode({ ...base, messageId: 5 }).duplicate, false);
  assert.equal(decoder.decode({ ...base, messageId: 5, dup: true }).duplicate, true);
  assert.equal(decoder.decode({ ...base, messageId: 5, dup: false }).duplicate, false);
  assert.equal(decoder.decode({ ...base, sourceAt: ms - 5 }).duplicate, false);
  assert.equal(decoder.decode({ ...base, sourceAt: ms - 5 }).duplicate, true);
  assert.equal(decoder.decode({ ...base, sourceAt: ms - 4 }).duplicate, false);
  assert.equal(decoder.duplicateCacheSize, 2);
  decoder.decode({ ...base, sourceAt: ms - 3 });
  assert.equal(decoder.duplicateCacheSize, 2);
  assert.equal(decoder.decode({ ...base, sourceAt: ms - 5 }).duplicate, false); // bounded eviction
  const expiring = make({ duplicateWindowMs: 1000 });
  expiring.decode({ ...base, messageId: 1 });
  assert.equal(expiring.decode({ ...base, messageId: 1, dup: true, receivedAt: ms + 1001 }).duplicate, false);
});

test('invalid payloads are not zeros, scaling is explicit, and output percentages are not kW', () => {
  const decoder = make();
  for (const payload of ['', ' ', 'NaN', 'null', '{"value":31}', '42 C', '1'.repeat(513)]) {
    const decoded = decoder.decode({ ...base, payload, sourceAt: ms });
    assert.equal(decoded.value, null);
    assert.ok(decoded.issues.includes('invalid-payload'));
  }
  const scaled = make({ verifiedRegisters: { '0001': { scale: 0.1, evidence: 'Synthetic fixed-point fixture' } } });
  assert.equal(scaled.decode({ ...base, payload: '-305', sourceAt: ms }).value, -30.5);
  const auxiliary = decoder.decode({ ...base, topic: 'fixture-device/HP/3104', payload: '66', sourceAt: ms });
  assert.equal(auxiliary.value, 66);
  assert.equal(auxiliary.unit, '%');
  assert.equal(auxiliary.powerKw, undefined);
  assert.equal(decoder.decode({ ...base, topic: 'fixture-device/HP/3104', payload: '166' }).value, null);
  assert.equal(decoder.decode({ ...base, topic: 'fixture-device/HP/1A01', payload: '2' }).value, null);
  assert.equal(decoder.decode({ ...base, topic: 'fixture-device/HP/6C63', payload: '-1' }).value, null);
});

test('supplied summer counters yield nominal 60 kWh auxiliary; DHW is overlapping runtime', () => {
  const before = { at: '2026-05-27T00:00:00+03:00', compressorHours: 38129, auxiliary3kwHours: 195, auxiliary6kwHours: 437, dhwHours: 12048 };
  const after = { at: '2026-09-06T00:00:00+03:00', compressorHours: 38300, auxiliary3kwHours: 195, auxiliary6kwHours: 447, dhwHours: 12216 };
  const result = auxiliaryCounterDelta(before, after);
  assert.equal(result.elapsedHours, 102 * 24);
  assert.equal(result.deltas.compressorHours, 171);
  assert.equal(result.deltas.dhwHours, 168);
  assert.equal(result.auxiliaryKwh, 60);
  assert.equal(result.dhwKwh, null);
  assert.equal(result.compressorKwh, null);
  assert.equal(result.cause, 'unknown');
  assert.equal(result.quality, 'nominal-estimate');
  assert.equal(auxiliaryCounterDelta(before, { ...after, auxiliary6kwHours: 0 }).auxiliaryKwh, null);
  assert.equal(auxiliaryCounterDelta(before, { ...after, auxiliary6kwHours: null }).auxiliaryKwh, null);
  assert.equal(auxiliaryCounterDelta(before, { ...after, auxiliary6kwHours: 99999 }).auxiliaryKwh, null);
});

test('phase-current snapshots flag data problems and preserve uncertainty about energy and EV2', () => {
  const normal = { ch_curr1: 16, ch_curr2: 16, ch_curr3: 16, eq_curr1: 20, eq_curr2: 19, eq_curr3: 21 };
  const result = assessPhaseCurrents(normal);
  assert.equal(result.quality, 'snapshot-only');
  assert.equal(result.energyKwh, null);
  assert.equal(result.heatPumpPowerKw, null);
  assert.equal(result.activePowerKw, null);
  const missing = assessPhaseCurrents({ ...normal, eq_curr1: null });
  assert.ok(missing.issues.includes('missing-or-invalid-current'));
  const zero = assessPhaseCurrents({ ...normal, eq_curr1: 0, eq_curr2: 0, eq_curr3: 0 });
  assert.ok(zero.issues.includes('all-zero-property-snapshot'));
  assert.ok(zero.issues.includes('ev-exceeds-property-snapshot'));
  assert.deepEqual(assessPhaseCurrents({ ...normal, eq_curr2: 26 }).phasesAboveFuse, [2]);
});
