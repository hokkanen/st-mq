import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageAdapter } from '../src/garage/adapter.js';
import { SHELLY_CN105_CONTRACT } from '../src/garage/contract.js';

const BASE = 1_800_000_000_000;
function fixture(source = 'none', options = {}) {
  let now = BASE, sequence = 0;
  const energy = [], observations = [];
  const adapter = createGarageAdapter({ clock: () => now,
    settings: { telemetryTopic: 'fixture/garage/telemetry', electricalSource: source },
    onEnergy: row => energy.push(row), onObservation: row => observations.push(row), ...options });
  adapter.setConnected(true);
  function field(value, unit, extra = {}) {
    return { value, unit, supported: true, decodeVerified: true, measuredAt: now,
      accuracyVerified: false, meterScope: 'garage-heat-pump-only', ...extra };
  }
  function receive(fields, packet = {}, extra = {}) {
    return adapter.receive('fixture/garage/telemetry', JSON.stringify({ schema: SHELLY_CN105_CONTRACT,
      deviceId: 'invented-fixture', bootId: 'fixture-boot', sequence: ++sequence, observedAt: now, fields, ...extra }), packet, now);
  }
  return { adapter, energy, observations, receive, field, at(value) { now = value; }, now: () => now,
    counter(value, extra = {}, packet = {}) { return receive({ energy: field(value, 'kWh', {
      updateIntervalMs: 60_000, resolution: 0.01, counterEpoch: 'fixture-epoch', ...extra }) }, packet); },
    power(value, extra = {}, packet = {}) { return receive({ power: field(value, 'W', extra) }, packet); } };
}

test('native indoor/outdoor, zero, negative, activity, unsupported and uncertain units retain separate identities', () => {
  const f = fixture();
  f.receive({ indoorTemperature: f.field(0, 'degC'), outdoorTemperature: f.field(-17.5, 'degC'),
    compressorActive: f.field(true, 'boolean'), defrost: f.field(false, 'boolean'),
    compressorFrequency: f.field(50, 'Hz') });
  let s = f.adapter.status();
  assert.equal(s.telemetry.indoorTemperature.value, 0);
  assert.equal(s.telemetry.outdoorTemperature.value, -17.5);
  assert.equal(s.native.compressorActive, true);
  assert.equal(s.native.defrost, false);
  assert.equal(s.telemetry.outdoorTemperature.usable, true);
  assert.equal(f.energy.length, 0);
  assert.deepEqual(f.observations.map(row => row.signal), ['garage_native_indoor_temperature', 'garage_compressor_frequency', 'garage_compressor_active', 'garage_native_defrost']);
  assert.equal(f.observations.find(row => row.signal === 'garage_compressor_active').value, 1);
  assert.equal(f.observations.at(-1).value, 0);
  assert.equal(f.observations.at(-1).unit, 'state');
  f.at(BASE + 1000); f.receive({ indoorTemperature: f.field(0, 'degC', { supported: false }),
    outdoorTemperature: f.field(4, 'raw') });
  s = f.adapter.status();
  assert.equal(s.telemetry.indoorTemperature.value, null);
  assert.equal(s.telemetry.indoorTemperature.supported, false);
  assert.equal(s.telemetry.outdoorTemperature.usable, false);
  assert.ok(s.telemetry.outdoorTemperature.quality.includes('units-unverified'));
});

test('cached field clocks, retained packets, stale and future measurements never become fresh evidence', () => {
  const f = fixture(); f.receive({ outdoorTemperature: f.field(-2, 'degC') });
  f.at(BASE + 119_999); f.receive({ outdoorTemperature: f.field(-2, 'degC', { measuredAt: BASE }) });
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.sourceTime, BASE);
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, true);
  f.at(BASE + 120_000);
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, false);
  f.receive({ outdoorTemperature: f.field(-3, 'degC') }, { retain: true });
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, false);
  f.receive({ outdoorTemperature: f.field(-3, 'degC', { measuredAt: f.now() + 1 }) });
  assert.ok(f.adapter.status().telemetry.outdoorTemperature.quality.includes('future-source-time'));
  f.receive({ outdoorTemperature: f.field(-4, 'degC') });
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, true,
    'an invalid future field must not poison the ordering watermark for valid sensor recovery');
});

test('relative telemetry preserves reconstructed time provenance and cannot supply electricity timing', () => {
  const f = fixture('native-power');
  f.receive({ outdoorTemperature: f.field(-5, 'degC', { measuredAt: null, ageMs: 20_000 }),
    power: f.field(500, 'W', { measuredAt: null, ageMs: 1000 }) }, {}, { observedAt: null, observedAgeMs: 0 });
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.sourceTime, BASE - 20_000);
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.timeBasis, 'receipt-minus-source-age');
  assert.equal(f.adapter.status().telemetry.outdoorTemperature.usable, true);
  f.at(BASE + 60_000); f.power(500, { measuredAt: null, ageMs: 1000 });
  assert.equal(f.energy.length, 0);
  assert.equal(f.adapter.status().electrical.lastIssue, 'electrical-source-clock-unqualified');
});

test('qualified counter updates produce one dedicated interval, retaining accuracy and timing qualification', () => {
  const f = fixture('native-counter');
  f.counter(10); f.at(BASE + 60_000); f.counter(10);
  assert.equal(f.energy.length, 0, 'cached totals do not fabricate zero-energy minutes');
  f.at(BASE + 120_000); f.counter(10.02);
  assert.equal(f.energy.length, 1);
  const row = f.energy[0];
  assert.ok(Math.abs(row.value - 0.02) < 1e-10);
  assert.equal(row.raw.intervalStart, BASE);
  assert.equal(row.raw.intervalEnd, BASE + 120_000);
  assert.equal(row.raw.coveredMs, 120_000);
  assert.equal(row.raw.energyBasis, 'counter-delta');
  assert.equal(row.raw.meterScope, 'garage-heat-pump-only');
  assert.equal(row.raw.provisional, false);
  assert.equal(row.raw.accuracyVerified, false);
  assert.equal(row.raw.timingEligible, true);
  f.counter(10.02);
  assert.equal(f.energy.length, 1, 'same field clock never counts twice');
});

test('unknown units, resolution, cadence and coarse counter updates never fabricate timing', () => {
  for (const metadata of [{ unit: 'raw' }, { decodeVerified: false }, { resolution: null },
    { updateIntervalMs: null }, { updateIntervalMs: 3_600_000 }, { meterScope: 'whole-property' }]) {
    const f = fixture('native-counter');
    f.counter(10, metadata); f.at(BASE + 60_000); f.counter(10.02, metadata);
    assert.equal(f.energy.length, 0, JSON.stringify(metadata));
  }
});

test('counter reset, unproven rollover, boot change and source gaps never bridge energy', () => {
  const f = fixture('native-counter'); f.counter(10);
  f.at(BASE + 60_000); f.counter(0);
  assert.equal(f.adapter.status().electrical.lastIssue, 'counter-reset-or-unproven-rollover');
  assert.equal(f.energy.length, 0);
  f.at(BASE + 120_000); f.counter(0.01); assert.equal(f.energy.length, 1);
  f.at(BASE + 600_000); f.counter(0.02); assert.equal(f.energy.length, 1);
  assert.equal(f.adapter.status().electrical.lastIssue, 'electrical-observation-gap');
  f.at(BASE + 660_000); f.receive({ energy: f.field(0.03, 'kWh', {
    resolution: 0.01, updateIntervalMs: 60_000, counterEpoch: 'fixture-new-epoch' }) }, {}, { bootId: 'fixture-new-boot' });
  assert.equal(f.energy.length, 1);
});

test('selected power integrates acquisitions before chart decimation without double-counting counter input', () => {
  const f = fixture('native-power');
  const fields = watts => ({ power: f.field(watts, 'W'), energy: f.field(20, 'kWh', { resolution: 0.01, updateIntervalMs: 60_000 }) });
  f.receive(fields(0)); f.at(BASE + 60_000); f.receive(fields(1000));
  assert.equal(f.energy.length, 1);
  assert.ok(Math.abs(f.energy[0].value - 1 / 120) < 1e-10);
  assert.equal(f.energy[0].raw.energyBasis, 'power-trapezoid');
  assert.ok(f.energy[0].quality.includes('integrated-power-estimate'));
  f.at(BASE + 600_000); f.power(1000); assert.equal(f.energy.length, 1);
  const none = fixture('none'); none.power(1000); none.at(BASE + 60_000); none.power(1000);
  assert.equal(none.energy.length, 0);
});

test('missing power stays unavailable even with compressor Hz; reported zero power is meaningful', () => {
  const f = fixture('native-power');
  f.receive({ compressorFrequency: f.field(60, 'Hz'), power: f.field(null, 'W', { supported: false }) });
  assert.equal(f.adapter.status().telemetry.power.usable, false);
  f.at(BASE + 60_000); f.power(0); f.at(BASE + 120_000); f.power(0);
  assert.equal(f.energy.length, 1);
  assert.equal(f.energy[0].value, 0);
  assert.equal(f.adapter.status().telemetry.power.value, 0);
  assert(!f.observations.some(row => row.signal === 'garage_power'), 'live power and energy integration do not create power history');
});

test('native defrost and raw diagnostic bytes retain observed changes without unsupported placeholders', () => {
  const events = [], f = fixture('none', { onEquipmentDiagnostic: (row, at) => events.push({ ...row, at }) });
  f.receive({ defrost: f.field(null, 'boolean', { supported: false }),
    faultRaw: f.field(null, null, { supported: false }) });
  assert.deepEqual(f.observations, []);
  assert.deepEqual(events, []);
  f.at(BASE + 1000);
  f.receive({ defrost: f.field(false, 'boolean'), faultRaw: f.field('00000000', null) });
  assert.equal(f.observations.at(-1).signal, 'garage_native_defrost');
  assert.equal(f.observations.at(-1).value, 0);
  assert.equal(events[0].value, '00000000', 'raw bytes are not converted into an invented fault diagnosis');
  f.at(BASE + 2000); f.receive({ faultRaw: f.field('00000000', null) });
  assert.equal(events.length, 1);
  f.at(BASE + 3000); f.receive({ faultRaw: f.field('a1000000', null) });
  assert.equal(events.length, 2);
  f.at(BASE + 4000); f.adapter.setConnected(false);
  assert.equal(f.observations.at(-1).value, null);
  assert.equal(events.at(-1).value, null);
  assert.equal(events.at(-1).status, 'unavailable');
  assert(events.at(-1).quality.includes('mqtt-disconnected'));
  f.adapter.setConnected(true);
  f.at(BASE + 5000); f.receive({ faultRaw: f.field('a1000000', null) });
  assert.equal(events.at(-1).value, 'a1000000');
  assert.equal(events.length, 4);
});

test('restarts preserve deduplication watermark but never interpolate across offline time', () => {
  const first = fixture('native-power'); first.power(600); first.at(BASE + 60_000); first.power(600);
  const second = fixture('native-power', { persisted: first.adapter.snapshot() });
  second.power(600); second.at(BASE + 60_000); second.power(600);
  assert.equal(second.energy.length, 0);
  second.at(BASE + 600_000); second.power(600);
  assert.equal(second.energy.length, 0);
  second.at(BASE + 660_000); second.power(600);
  assert.equal(second.energy.length, 1);
  assert.equal(second.energy[0].raw.intervalStart, BASE + 600_000);
});

test('failed electrical storage can retry the same telemetry frame without losing its interval', () => {
  let fail = true; const recorded = [];
  const f = fixture('native-power', { onEnergy: row => { if (fail) throw new Error('fixture storage failure'); recorded.push(row); } });
  f.power(600); f.at(BASE + 60_000);
  const payload = JSON.stringify({ schema: SHELLY_CN105_CONTRACT, deviceId: 'invented-fixture', bootId: 'fixture-boot',
    sequence: 2, observedAt: f.now(), fields: { power: f.field(600, 'W') } });
  assert.throws(() => f.adapter.receive('fixture/garage/telemetry', payload, {}, f.now()), /storage failure/);
  fail = false; f.adapter.receive('fixture/garage/telemetry', payload, {}, f.now());
  assert.equal(recorded.length, 1);
  f.adapter.receive('fixture/garage/telemetry', payload, {}, f.now());
  assert.equal(recorded.length, 1);
});
