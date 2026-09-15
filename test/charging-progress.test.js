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
const charger = extra => ({ id: 'charger1', requiredGridKwh: 37, configuration: { efficiency: .9 }, telemetry: {},
  values: { connected: value(true), soc: value(40, { source: 'manual-fallback' }), capacityKwh: value(74),
    minimumSoc: value(85), ...extra } });
const energy = amount => () => ({ gridKwh: amount, coveredMs: HOUR, continuousSince: now, lastMeasuredAt: now + HOUR });

test('recorded energy advances a separate SoC estimate and applies grid losses once', () => {
  const initial = updateChargingProgress(null, charger(), now);
  const input = charger(), original = structuredClone(input);
  const next = updateChargingProgress(initial.state, input, now + HOUR, energy(10));
  assert.ok(Math.abs(next.estimatedSoc - 52.16216216216216) < 1e-9);
  assert.ok(Math.abs(next.remainingGridKwh - 27) < 1e-9);
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

test('changing target, capacity or efficiency preserves earned energy; natural final charging can exceed target', () => {
  const initial = updateChargingProgress(null, charger(), now);
  const next = updateChargingProgress(initial.state, charger(), now + HOUR, energy(40));
  assert.equal(next.remainingGridKwh, 0);
  assert.ok(next.estimatedSoc > 85);
  const changed = charger({ minimumSoc: value(100), capacityKwh: value(80) }); changed.configuration.efficiency = .8;
  const result = updateChargingProgress(next.state, changed, now + HOUR, energy(40));
  assert.equal(result.deliveredGridKwh, 40);
  assert.equal(result.estimatedSoc, 80);
  assert.equal(result.remainingGridKwh, 20);
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
