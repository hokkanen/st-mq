import test from 'node:test';
import assert from 'node:assert/strict';
import { learningDisplay, h66Control, h66ReadingValue } from '../chart/learning-status.js';

test('learning explanations distinguish missing evidence, genuine zero and unfavorable completed cycles', () => {
  const display = learningDisplay({ metrics: { profit: { value: -1.5, count: 2 }, auxProfit: { value: 0, count: 0 },
    recoveryError: { value: 0, count: 2 } }, adaptive: { baselineC: 21.3, health: { status: 'prior-estimates' } } });
  assert.equal(display.metrics[0].value, '-1.50 €/cycle');
  assert.equal(display.metrics[1].value, 'Not available yet');
  assert.equal(display.metrics[2].value, '0.00 €/cycle');
  assert.equal(display.metrics[3].value, '21.3 °C');
  assert.match(display.title, /initial estimates/);
  assert.match(display.metrics[1].detail, /Unknown auxiliary history is excluded/);
  assert.match(display.history, /later model updates do not rewrite/);
});

test('temperature validation does not imply validated cycle savings or measured equipment parameters', () => {
  const display = learningDisplay({ adaptive: { health: { usableSamples: 100, phaseSamples: { normal: 100, reduction: 0 }, evidence: 'includes-requested-modes' },
    model: { validation: { accepted: true, samples: 10, maeCPerHour: 0.1, persistenceMaeCPerHour: 0.2 },
      parameters: { lossPerHour: 0.02, reserveTimeHours: 12 }, energy: { compressorKw: 3, auxiliaryKw: 9, basis: 'estimated' } } } });
  const text = display.evidence.join(' ');
  assert.match(text, /does not validate full-cycle cost/);
  assert.match(text, /not a measured floor temperature/);
  assert.match(text, /0.20 °C\/h before heating/);
  assert.match(text, /FMI radiation forecasts with Open-Meteo as backup/);
  assert.match(text, /modeled radiation/);
  assert.match(text, /requested operation/);
});

test('H66 controls require a connected writable register and mode readbacks remain categorical', () => {
  assert.equal(h66Control({ connected: false, controls: { '0208': { available: true } } }, '0208').available, false);
  assert.equal(h66Control({ connected: true, controls: { '0208': { available: false } } }, '0208').available, false);
  assert.equal(h66Control({ connected: true, controls: { '0208': { available: true, max: 60 } } }, '0208').max, 60);
  assert.equal(h66ReadingValue('2201', { value: 4 }), 'Hot water only');
  assert.equal(h66ReadingValue('1A07', { value: 0 }), 'Space heating');
  assert.equal(h66ReadingValue('3104', { value: null }), 'Unavailable');
  assert.equal(h66ReadingValue('0001', { value: 32, unit: '°C' }), '32 °C');
});
