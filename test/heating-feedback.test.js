import test from 'node:test';
import assert from 'node:assert/strict';
import { heatingFeedback } from '../src/app/heating-feedback.js';

const now = 1_000_000;
function fixture({ on = 0, at = now, available = true, reductionOn = true, phase = 'normal', requestedAt = now - 1000 } = {}) {
  return { now, configured: [{ id: 'tariff', stateSignal: 'tariff_active', reductionOn }],
    equipment: { devices: [{ id: 'tariff', controls: { tariff: true }, available,
      readings: { tariff_active: { value: on, observedAt: at, receivedAt: at, stale: !available } } }] },
    executor: { tariffRequested: { at: requestedAt } }, applied: { phase, at: now } };
}

test('tariff verification uses current post-request relay output even if PUBACK completed later', () => {
  const config = fixture({ at: now - 500 });
  const actual = heatingFeedback(config);
  assert.equal(actual.mode, 'normal'); assert.equal(actual.verified, true);
  assert.equal(actual.source, 'equipment-state-readback');
  assert.equal(actual.observedAt, now - 500); assert.equal(actual.requestedPhase, 'normal');
  assert.equal(heatingFeedback(fixture({ on: 1, phase: 'reduction' })).verified, true);
  assert.equal(heatingFeedback(fixture({ on: 0, phase: 'reduction', reductionOn: false })).mode, 'reduction');
});

test('old, unavailable or conflicting relay state never confirms heating', () => {
  assert.equal(heatingFeedback(fixture({ at: now - 2000 })).verified, false);
  assert.equal(heatingFeedback(fixture({ available: false })).verified, false);
  const mismatch = heatingFeedback(fixture({ on: 1 }));
  assert.equal(mismatch.mode, 'reduction'); assert.equal(mismatch.requestedPhase, 'normal');
  const config = fixture();
  config.equipment.devices.push({ id: 'second', controls: { tariff: true }, available: true,
    readings: { second_active: { value: 1, observedAt: now } } });
  assert.equal(heatingFeedback(config).verified, false);
});

test('preheating requires corresponding native settings, independent of tariff offset', () => {
  const config = fixture({ phase: 'preheat' });
  assert.equal(heatingFeedback(config).phase, 'normal');
  config.h66 = { connected: true, phase: 'preheat', requested: { '0203': 23 },
    readings: { '0203': { available: true, value: 23 }, '0233': { available: true, value: 3 } } };
  assert.equal(heatingFeedback(config).phase, 'preheat');
  config.h66.readings['0203'].value = 21;
  assert.equal(heatingFeedback(config).phase, 'normal');
});
