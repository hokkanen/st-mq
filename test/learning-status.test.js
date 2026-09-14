import test from 'node:test';
import assert from 'node:assert/strict';
import { learningDisplay, modelCoefficientDescriptions, h66Control, h66ReadingValue, h66ReadingStatus, h66HomeSummary, h66EquipmentSummary } from '../chart/learning-status.js';

test('heat-pump equipment shows observed run duration and sensor temperatures instead of setpoints', () => {
  const now = Date.parse('2026-09-14T12:00:00Z');
  const reading = value => ({ value, available: true, observedAt: now });
  const status = { now, h66: { connected: true,
    compressorState: { value: 1, since: now - 75 * 60_000, transitionObserved: true },
    readings: { '1A01': reading(1), '0009': reading(48), '0007': reading(-3),
      '0203': reading(21), '0212': reading(44), '0208': reading(60) } } };
  assert.deepEqual(h66EquipmentSummary(status).map(row => row.value), ['Running for 1 h 15 min', '48 °C', '-3 °C']);
  status.h66.compressorState.transitionObserved = false;
  assert.equal(h66EquipmentSummary(status)[0].value, 'Running for at least 1 h 15 min');
  status.h66.compressorState = null;
  assert.equal(h66EquipmentSummary(status)[0].value, 'Running');
  status.h66.readings['1A01'] = reading(0);
  status.h66.compressorState = { value: 0, since: now - 30_000, transitionObserved: true };
  assert.equal(h66EquipmentSummary(status)[0].value, 'Idle for <1 min');
  status.h66.readings['0009'].stale = true;
  assert.equal(h66EquipmentSummary(status)[1].available, false);
  status.h66.connected = false;
  assert(h66EquipmentSummary(status).every(row => row.available === false));
});

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
  const coefficients = display.coefficientEvidence.join(' ');
  assert.match(text, /does not validate full-cycle cost/);
  assert.match(coefficients, /not a measured floor temperature/);
  assert.match(coefficients, /0.20 °C\/h before heating/);
  assert.match(coefficients, /FMI radiation forecasts with Open-Meteo as backup/);
  assert.match(coefficients, /modeled radiation/);
  assert.match(text, /requested operation/);
  assert.doesNotMatch(text, /Current model:|Thermal coefficients:/);
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

test('learning status separates conditional temperature skill from action evidence and all attempted outcomes', () => {
  const display = learningDisplay({ readiness: { thermalValidated: true, responseValidated: true, advanceValidated: false, actionValidated: false, trialReady: false,
    reasons: ['collecting-independent-equipment-episodes'] },
    outcomes: { attempted: 5, completed: 2, incomplete: 2, inProgress: 1, assessed: 1, observedCostCents: 345, basis: 'estimated' },
    adaptive: { model: { parameters: { lossPerHour: 0.02, normalHeatCPerHour: 0.7, reserveTimeHours: 12 },
      validation: { accepted: true, kind: 'conditional-thermal', maeC: 0.25, maxErrorC: 0.8,
        persistenceMaeC: 0.6, samples: 4, horizonHours: 6, maximumHorizonHours: 12,
        fittedParameters: ['lossPerHour', 'normalHeatCPerHour'] },
      equipmentResponse: { validation: { phases: { reduction: { episodes: 1, accepted: false, maeDuty: 0.2 } } } },
      forecastValidation: { accepted: false, episodes: 2, temperatureMaeC: 0.35, energyRelativeError: 0.25, costRelativeError: 0.15 } } } });
  const text = display.evidence.join(' ');
  assert.match(text, /0.25 °C mean absolute trajectory error/);
  assert.match(text, /4 later blocks of 6.0–12.0 hours/);
  assert(!text.includes('one-hour'));
  assert.match(display.coefficientEvidence.join(' '), /2 fitted in the accepted update; 1 fixed/);
  assert.match(text, /Action prediction: awaiting independent episode evidence/);
  assert.match(text, /Equipment response: validated on later episodes/);
  assert.match(text, /Frozen advance forecast: awaiting independent outcome evidence/);
  assert.match(text, /Frozen advance forecast: not established over 2 completed episodes; temperature error 0.35 °C; energy error 25.0%/);
  assert.match(text, /space-heating cost error 15.0%/);
  assert.match(text, /All attempted cycles: 5; completed 2, incomplete 2, in progress 1/);
  assert.match(text, /€3.45/);
  assert.match(text, /20.0 percentage points/);
  assert.equal(display.inputs.length, 10);
  assert(display.inputs.every(row => row.sources && row.detail));
});

test('current coefficient values retain units and separate fitted values from fixed assumptions', () => {
  const learning = { adaptive: { health: { status: 'retained-previous', parameterEvidence: {
    lossPerHour: { status: 'fixed', reason: 'confounded-with-other-heat-inputs' } } },
  model: { parameters: { lossPerHour: 0.018, normalHeatCPerHour: 0.75, solarCPerHourPerKwM2: 0,
    auxiliaryCPerKwh: 0.15, memoryExchangePerHour: 0.08, reserveTimeHours: 12 },
  validation: { accepted: true, fittedParameters: ['lossPerHour', 'normalHeatCPerHour'], parameterEvidence: {
    lossPerHour: { status: 'identified' }, solarCPerHourPerKwM2: { status: 'fixed', reason: 'fewer-than-three-sunlit-days' } } } } } };
  const rows = Object.fromEntries(modelCoefficientDescriptions(learning).map(row => [row.key, row]));
  assert.equal(rows.lossPerHour.value, '0.0180 1/h');
  assert.equal(rows.lossPerHour.provenance, 'Fitted in the accepted model');
  assert.equal(rows.lossPerHour.evidence, 'identified');
  assert.equal(rows.normalHeatCPerHour.value, '0.750 °C/h');
  assert.equal(rows.solarCPerHourPerKwM2.value, '0.000 °C/h per kW/m²');
  assert.equal(rows.solarCPerHourPerKwM2.provenance, 'Retained value / awaiting evidence');
  assert.match(rows.solarCPerHourPerKwM2.evidence, /fewer than three sunlit days/);
  assert.equal(rows.auxiliaryCPerKwh.unit, '°C/kWh');
  assert.equal(rows.memoryExchangePerHour.provenance, 'Fixed building assumption');
  assert.equal(rows.reserveTimeHours.value, '12.0 h');
  const display = learningDisplay(learning);
  assert.equal(display.metrics.length, 4);
  assert.equal(display.inputs.length, 10);
  assert.equal(display.coefficients.length, 6);
  assert.match(display.coefficientHistory, /today’s values are not applied to earlier intervals/);
  assert.match(display.coefficientHistory, /five adjustable coefficients reconstructed from the learning journal/);
  assert.match(display.coefficientHistory, /creates no additional stored history/);
});

test('a fireplace-only fit preserves the visible validation of unchanged identified house coefficients', () => {
  const learning = { adaptive: { model: { parameters: { lossPerHour: 0.02, normalHeatCPerHour: 0.7,
    fireplaceCPerKg: 0.12, reserveTimeHours: 12 }, validation: { accepted: true,
    fittedParameters: ['fireplaceCPerKg'], parameterEvidence: {
      lossPerHour: { status: 'identified', fitStatus: 'retained-unchanged',
        currentWindowEvidence: { status: 'fixed', reason: 'insufficient-clean-intervals' } },
      normalHeatCPerHour: { status: 'identified', fitStatus: 'retained-unchanged' },
      fireplaceCPerKg: { status: 'identified' } } } } } };
  const display = learningDisplay(learning);
  const rows = Object.fromEntries(display.coefficients.map(row => [row.key, row]));
  assert.equal(rows.lossPerHour.provenance, 'Retained unchanged / previously validated');
  assert.equal(rows.normalHeatCPerHour.provenance, 'Retained unchanged / previously validated');
  assert.match(rows.lossPerHour.evidence, /identified · retained unchanged/);
  assert.equal(rows.fireplaceCPerKg.provenance, 'Fitted in the accepted model');
  assert.equal(rows.reserveTimeHours.provenance, 'Fixed building assumption');
  assert.match(display.coefficientEvidence.join(' '), /1 fitted in the accepted update; 2 retained unchanged with validated evidence; 1 fixed or awaiting evidence/);
  learning.adaptive.model.validation.accepted = false;
  assert.equal(modelCoefficientDescriptions(learning)[0].provenance, 'Initial estimate / awaiting evidence');
});

test('unavailable and rejected coefficients are never presented as learned values', () => {
  assert.deepEqual(modelCoefficientDescriptions({}), []);
  const rows = modelCoefficientDescriptions({ adaptive: { model: { parameters: { lossPerHour: null,
    normalHeatCPerHour: 0.7, reducedHeatCPerHour: 0.2, unrelatedValue: 1 },
  validation: { accepted: false, fittedParameters: ['lossPerHour', 'normalHeatCPerHour'] } } } });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].available, false);
  assert.equal(rows[0].value, 'Unavailable');
  assert.equal(rows[1].provenance, 'Initial estimate / awaiting evidence');
  assert.equal(rows[2].provenance, 'Legacy model value');
});

test('home H66 summary combines current DHW bounds without treating tariff requests as readback', () => {
  const reading = value => ({ value, available: true, stale: false, usableForControl: true });
  const status = { h66: { connected: true, readings: { '2201': reading(2), '0203': reading(21),
    '0212': reading(40), '0208': reading(50), '1A01': reading(1), '1A07': reading(0),
    '3104': reading(0), '1A20': reading(0), '0233': reading(2) } },
  observations: { actual: { mode: 'reduction', verified: false, source: 'mqtt-request' } } };
  const rows = Object.fromEntries(h66HomeSummary(status).map(row => [row.key, row]));
  assert.equal(rows.mode.value, 'Compressor only');
  assert.equal(rows.room.value, '21 °C');
  assert.equal(rows.dhw.value, '40–50 °C');
  assert.equal(rows.tariff.value, 'Reduction requested · unverified');
  assert.equal(rows.tariff.available, false);
  assert.equal(rows.tariffSetting.value, '2 °C');
  assert.equal(rows.compressor.value, 'On');
  assert.equal(rows.destination.value, 'Space heating');
  assert.equal(rows.aux.value, '0 %');
  assert.equal(rows.alarm.value, 'No active alarm');
  status.h66.readings['0208'].stale = true;
  assert.match(h66HomeSummary(status).find(row => row.key === 'dhw').value, /Unavailable · Stop setting: the readback timestamp is missing or invalid/);
  status.h66.connected = false;
  assert.equal(h66HomeSummary(status).find(row => row.key === 'mode').available, false);
  assert.match(h66HomeSummary(status).find(row => row.key === 'mode').value, /Unavailable · H66 disconnected/);
});

test('H66 age details use the exact limit and distinguish quiet telemetry from MQTT disconnection', () => {
  const now = Date.parse('2026-01-01T12:00:00Z'), limit = 5 * 60_000;
  const h66 = { connected: true, brokerConnected: true, maxAgeMs: limit };
  const reading = { value: 21, observedAt: now - limit, receivedAt: now - limit, available: true, usableForControl: true,
    timeBasis: 'mqtt-received' };
  assert.equal(h66ReadingStatus(h66, reading, { now }).usable, true);
  assert.match(h66ReadingStatus(h66, reading, { now }).detail, /Age 5 min; limit 5 min/);
  const expired = h66ReadingStatus({ ...h66, connected: false, lastPublicationAt: reading.receivedAt },
    { ...reading, stale: true, available: false }, { now: now + 1 });
  assert.equal(expired.usable, false);
  assert.match(expired.detail, /readback is 5 min 1 s old; limit 5 min/);
  assert.match(expired.detail, /MQTT receipt time/);
  assert.doesNotMatch(expired.detail, /disconnected/);
  const disconnected = h66ReadingStatus({ ...h66, connected: false, brokerConnected: false }, reading, { now });
  assert.match(disconnected.detail, /H66 disconnected/);
});

test('H66 invalid, retained, future and reconnect readbacks expose safe, distinct reasons', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const h66 = { connected: true, brokerConnected: true };
  const reading = { value: 21, observedAt: now, receivedAt: now, available: false, usableForControl: false, stale: true };
  assert.match(h66ReadingStatus(h66, { ...reading, retained: true }, { now }).detail, /retained; a live report is required/);
  assert.match(h66ReadingStatus(h66, { ...reading, value: null, issues: ['invalid-value'] }, { now }).detail,
    /outside the accepted register range/);
  assert.match(h66ReadingStatus(h66, { ...reading, value: null, issues: ['invalid-payload'] }, { now }).detail,
    /does not contain a valid numeric value/);
  assert.match(h66ReadingStatus(h66, { ...reading, unavailableReasons: ['awaiting-live-report'] }, { now }).detail,
    /waiting for a live report since reconnection/);
  const future = h66ReadingStatus(h66, { ...reading, observedAt: now + 1000, sourceAt: now + 1000, timeBasis: 'source-measured' }, { now });
  assert.match(future.detail, /measurement time is 1 s in the future/);
  assert.match(future.detail, /Age uses the source measurement time/);
  const unknown = h66ReadingStatus(h66, { ...reading, issues: ['invented-private-value'] }, { now });
  assert.match(unknown.detail, /without reporting a specific reason/);
  assert.doesNotMatch(unknown.detail, /invented-private-value/);
});

test('DHW range reports the failing bound and its actual reason', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const valid = { value: 50, observedAt: now, receivedAt: now, available: true, usableForControl: true };
  const status = { now, h66: { connected: true, brokerConnected: true,
    readings: { '0212': { ...valid, value: 40, available: false, unavailableReasons: ['awaiting-live-report'] }, '0208': valid } } };
  const row = h66HomeSummary(status).find(row => row.key === 'dhw');
  assert.equal(row.available, false);
  assert.match(row.value, /Start setting: waiting for a live report since reconnection/);
  assert.doesNotMatch(row.value, /Stop setting/);
});

test('missing, stale and invalid H66 summary readings remain unknown', () => {
  const status = { h66: { connected: true, readings: { '2201': { value: 1, available: false },
    '0203': { value: 21, available: true, usableForControl: false },
    '0212': { value: 40, available: true }, '0208': { value: null, available: true } } },
  observations: { actual: { mode: 'normal', verified: true, stale: true } } };
  const rows = Object.fromEntries(h66HomeSummary(status).map(row => [row.key, row]));
  for (const key of ['mode', 'room', 'dhw']) {
    assert.equal(rows[key].available, false);
    assert.match(rows[key].value, /Unavailable/);
  }
  assert.equal(rows.tariff.value, 'Unknown · no device readback');
  assert.equal(h66HomeSummary({}).find(row => row.key === 'tariff').value, 'Unknown · no device readback');
});
