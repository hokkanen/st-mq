import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { restoreChargingProgress, updateChargingProgress } from '../src/charging/progress.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';

const now = Date.parse('2026-09-15T00:00:00Z'), HOUR = 3_600_000;
const value = (number, extra = {}) => ({ value: number, available: true, source: 'test', ...extra });
const charger = extra => ({ id: 'charger1', requiredGridKwh: 36, configuration: { efficiency: .925 }, telemetry: {},
  values: { connected: value(true), soc: value(40, { source: 'manual-fallback' }), capacityKwh: value(74),
    minimumSoc: value(85), ...extra } });
const energy = amount => () => ({ gridKwh: amount, coveredMs: HOUR, continuousSince: now, lastMeasuredAt: now + HOUR });

test('recorded energy advances a separate SoC estimate and applies grid losses once', () => {
  const initial = updateChargingProgress(null, charger(), now);
  const input = charger(), original = structuredClone(input);
  const next = updateChargingProgress(initial.state, input, now + HOUR, energy(10));
  assert.ok(Math.abs(next.estimatedSoc - 52.5) < 1e-9);
  assert.ok(Math.abs(next.remainingGridKwh - 26) < 1e-9);
  assert.equal(next.hasEnergyEstimate, true);
  assert.equal(next.estimatedSocSource, 'starting-charge');
  assert.equal(next.basis.source, 'recorded-charger-energy');
  assert.deepEqual(input, original);
});

test('energy remains credited across restart and missing intervals without inventing outage energy', () => {
  const initial = updateChargingProgress(null, charger(), now);
  const next = updateChargingProgress(initial.state, charger(), now + HOUR, energy(10));
  const restored = restoreChargingProgress(JSON.parse(JSON.stringify(next.state)));
  const gap = updateChargingProgress(restored, charger(), now + 3 * HOUR);
  assert.equal(gap.deliveredGridKwh, 10);
  assert.equal(gap.estimatedSoc, next.estimatedSoc);
  assert.equal(updateChargingProgress(gap.state, charger(), now + 3 * HOUR, energy(10)).deliveredGridKwh, 10);
});

test('new measured SoC rebases at its original clock; retained unchanged receipt does not reset progress', () => {
  const soc = value(40, { source: 'teslamate', timeBasis: 'receipt-only', receivedAt: now });
  const initial = updateChargingProgress(null, charger({ soc }), now);
  const next = updateChargingProgress(initial.state, charger({ soc }), now + HOUR, energy(10));
  const replay = updateChargingProgress(next.state, charger({ soc: { ...soc, receivedAt: now + HOUR, retained: true } }), now + HOUR, energy(10));
  assert.equal(replay.deliveredGridKwh, 10);
  const updated = updateChargingProgress(replay.state, charger({ soc: value(55, { source: 'mqtt', measuredAt: now + HOUR }) }),
    now + 2 * HOUR, query => { assert.equal(query.start, now + HOUR); return energy(2)(); });
  assert.equal(updated.deliveredGridKwh, 2);
  assert.ok(updated.estimatedSoc > 55);
});

test('vehicle feed loss preserves the identified session anchor and credited energy across restart', () => {
  const vehicle = { state: 'identified', id: 'bmw', sessionId: 'physical-connection' };
  const current = charger({ soc: value(40, { source: 'bmw-cardata', measuredAt: now }) });
  current.settings = { manualSoc: 90 }; current.telemetry = { vehicle };
  const initial = updateChargingProgress(null, current, now);
  const charged = updateChargingProgress(initial.state, current, now + HOUR, energy(10));
  const offline = { ...current, values: { ...current.values, soc: value(90, { source: 'manual-fallback' }) } };
  const retained = updateChargingProgress(restoreChargingProgress(charged.state), offline, now + 2 * HOUR);
  assert.equal(retained.retainedVehicleReference, true);
  assert.equal(retained.estimatedSoc, charged.estimatedSoc);
  assert.equal(retained.remainingGridKwh, charged.remainingGridKwh);
  assert.equal(retained.deliveredGridKwh, 10);
  assert.equal(retained.estimatedSocSource, 'vehicle');
  assert.deepEqual(retained.referenceSoc, { value: 40, source: 'bmw-cardata', measuredAt: now, receivedAt: null });
  const restoredFeed = updateChargingProgress(retained.state, current, now + 2 * HOUR);
  assert.equal(restoredFeed.deliveredGridKwh, 10);
  assert.equal(restoredFeed.retainedVehicleReference, false);
  const changedDefault = { ...current, settings: { manualSoc: 20 } };
  const healthyEdit = updateChargingProgress(restoredFeed.state, changedDefault, now + 2 * HOUR);
  const nextOutage = updateChargingProgress(healthyEdit.state, { ...changedDefault,
    values: { ...changedDefault.values, soc: value(20, { source: 'manual-fallback' }) } }, now + 3 * HOUR);
  assert.equal(nextOutage.estimatedSoc, charged.estimatedSoc, 'Editing a default while live vehicle data applies cannot later discard its latest anchor');
});

test('explicit starting-charge edits and changed vehicle connections replace an unavailable vehicle anchor', () => {
  const current = charger({ soc: value(40, { source: 'teslamate', receivedAt: now }) });
  current.settings = { manualSoc: 90 };
  current.telemetry = { vehicle: { state: 'identified', id: 'tesla', sessionId: 'original-connection' } };
  const initial = updateChargingProgress(null, current, now);
  const charged = updateChargingProgress(initial.state, current, now + HOUR, energy(10));
  const offline = { ...current, values: { ...current.values, soc: value(90, { source: 'manual-fallback' }) } };
  const variants = [
    { ...offline, settings: { manualSoc: 30 }, values: { ...offline.values, soc: value(30, { source: 'manual-fallback' }) } },
    { ...offline, values: { ...offline.values, soc: value(30, { source: 'session-anchor', measuredAt: now + HOUR }) } },
    { ...offline, telemetry: { vehicle: { ...current.telemetry.vehicle, sessionId: 'next-connection' } } },
    { ...offline, telemetry: { vehicle: { state: 'unidentified' } } },
  ];
  for (const variant of variants) {
    const changed = updateChargingProgress(charged.state, variant, now + HOUR);
    assert.equal(changed.retainedVehicleReference, false);
    assert.equal(changed.deliveredGridKwh, 0);
    assert.equal(changed.estimatedSoc, variant.values.soc.value);
    assert.equal(changed.estimatedSocSource, 'starting-charge');
  }
});

test('a healthy unchanged observation supplies current vehicle context without rebasing earned energy', () => {
  const current = charger({ soc: value(40, { source: 'bmw-cardata', measuredAt: now }) });
  current.settings = { manualSoc: 90 };
  const initial = updateChargingProgress(null, current, now);
  const charged = updateChargingProgress(initial.state, current, now + HOUR, energy(10));
  current.telemetry.vehicle = { state: 'identified', id: 'bmw', sessionId: 'current-connection' };
  const identified = updateChargingProgress(charged.state, current, now + HOUR);
  assert.equal(identified.anchorAt, charged.anchorAt);
  assert.equal(identified.deliveredGridKwh, 10);
  const offline = updateChargingProgress(identified.state, { ...current,
    values: { ...current.values, soc: value(90, { source: 'manual-fallback' }) } }, now + 2 * HOUR);
  assert.equal(offline.retainedVehicleReference, true);
  assert.equal(offline.estimatedSoc, charged.estimatedSoc);
});

test('changing target or capacity preserves earned energy and cannot change the fixed loss; natural final charging can exceed target', () => {
  const initial = updateChargingProgress(null, charger(), now);
  const next = updateChargingProgress(initial.state, charger(), now + HOUR, energy(40));
  assert.equal(next.remainingGridKwh, 0);
  assert.ok(next.estimatedSoc > 85);
  const changed = charger({ minimumSoc: value(100), capacityKwh: value(80) }); changed.configuration.efficiency = .8;
  const result = updateChargingProgress(next.state, changed, now + HOUR, energy(40));
  assert.equal(result.deliveredGridKwh, 40);
  assert.equal(result.estimatedSoc, 86.25);
  assert.ok(Math.abs(result.remainingGridKwh - 11 / .925) < 1e-9);
  assert.equal(updateChargingProgress(result.state, changed, now + 2 * HOUR, energy(100)).estimatedSoc, 100);
});

test('disconnect discards the old connection estimate and an old vehicle report cannot credit a previous drive', () => {
  const soc = value(40, { source: 'mqtt', measuredAt: now - HOUR });
  const initial = updateChargingProgress(null, charger({ soc }), now, query => { assert.equal(query.start, now); return null; });
  const next = updateChargingProgress(initial.state, charger({ soc }), now + HOUR, energy(10));
  const off = updateChargingProgress(next.state, charger({ soc, connected: value(false) }), now + HOUR);
  assert.equal(off.deliveredGridKwh, 0);
  const on = updateChargingProgress(off.state, charger({ soc }), now + 2 * HOUR,
    query => { assert.equal(query.start, now + 2 * HOUR); return null; });
  assert.equal(on.estimatedSoc, 40);
});

test('progress reads recorder pending and committed energy once, clips anchor boundary, and preserves real gaps', t => {
  const directory = mkdtempSync(join(tmpdir(), 'charging-energy-'));
  const store = new Store(join(directory, 'test.sqlite')), recorder = new Recorder(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const interval = (start, end) => ({ source: 'easee', device: 'test-charger', prefix: 'ev1', start, end,
    energies: [1, 1, 1], powers: [3, 3, 3], quality: ['estimated'] });
  recorder.recordEnergy(interval(now, now + HOUR));
  recorder.recordEnergy(interval(now + HOUR, now + 2 * HOUR));
  const query = { id: 'charger1', start: now + HOUR / 2, end: now + 2 * HOUR };
  assert.equal(recordedChargingEnergy(store, query).gridKwh, 4.5);
  recorder.recordEnergy(interval(now + HOUR, now + 2 * HOUR));
  recorder.flush(now + 2 * HOUR, { force: true });
  assert.equal(recordedChargingEnergy(store, query).gridKwh, 4.5);
  recorder.energyGap({ source: 'easee', device: 'test-charger', prefix: 'ev1', start: now + 2 * HOUR, end: now + 3 * HOUR });
  recorder.recordEnergy(interval(now + 3 * HOUR, now + 4 * HOUR));
  const afterGap = recordedChargingEnergy(store, { ...query, end: now + 4 * HOUR });
  assert.equal(afterGap.gridKwh, 7.5);
  assert.equal(afterGap.incomplete, true);
  assert.equal(afterGap.continuousSince, now + 3 * HOUR);
});
