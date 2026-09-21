import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateHeatPumpPerformance, estimateHydronicHeat } from '../src/domain/heat-pump-performance.js';
import { initialAdaptiveModel, predictThermalStep, evaluateThermalModel, thermalObservationIntervals,
  fitAdaptiveModel, restoreAdaptiveCheckpoint, updateAdaptiveLearningBatch, updateAdaptiveEpisode,
  actionEvidenceReady, thermalUncertaintyC } from '../src/control/adaptive-learning.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z');
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected}`);
const row = (i, extra = {}) => ({ timestamp: start + i * HOUR / 4, indoorC: 21, outdoorC: 0,
  phase: 'normal', regime: 'occupied', quality: [], solarRadiationWm2: 0,
  compressorDuty: 0.504, auxKw: 0, ...extra });

test('published source points and midpoint separate thermal output from electrical input', () => {
  const low = estimateHeatPumpPerformance({ supplyC: 35, brineC: 0, modelConfirmed: true });
  const high = estimateHeatPumpPerformance({ supplyC: 45, brineC: 0, modelConfirmed: true });
  const mid = estimateHeatPumpPerformance({ supplyC: 40, brineC: 0, modelConfirmed: true });
  near(low.heatKw, 9.4); near(high.heatKw, 9.24); near(low.cop, 4.24); near(high.cop, 3.51);
  near(mid.heatKw, (low.heatKw + high.heatKw) / 2);
  near(mid.electricalKw, (low.electricalKw + high.electricalKw) / 2);
  assert.equal(mid.pumpsIncluded, true);
  near(estimateHydronicHeat({ supplyC: 40, brineC: 0, compressorDuty: 0.5, auxKw: 3 }).hydronicKw, 7.66);
  assert.equal(estimateHydronicHeat({ compressorDuty: null, auxKw: 0 }).hydronicKw, null);
});

test('unsupported brine slope is not invented and missing/extrapolated source points widen uncertainty', () => {
  const known = estimateHeatPumpPerformance({ supplyC: 40, brineC: 0, modelConfirmed: true });
  const warmBrine = estimateHeatPumpPerformance({ supplyC: 40, brineC: 8, modelConfirmed: true });
  assert.equal(warmBrine.heatKw, known.heatKw);
  assert.ok(warmBrine.relativeUncertainty > known.relativeUncertainty);
  assert.equal(warmBrine.brineCorrectionKnown, false);
  assert.ok(estimateHeatPumpPerformance().relativeUncertainty > known.relativeUncertainty);
  const outside = estimateHeatPumpPerformance({ supplyC: 60, brineC: 0 });
  assert.equal(outside.withinPlanningRange, false); assert.equal(outside.evaluatedSupplyC, 50);
  assert.equal(outside.supplyC, 60);
  assert.ok(outside.electricalKw > known.electricalKw);
});

test('compressor and resistance heat use the identical downstream coefficient', () => {
  const model = initialAdaptiveModel(), state = { indoorC: 21, reserveC: 23 };
  const common = { outdoorC: 0, solarRadiationWm2: 0, supplyC: 35, brineC: 0, phase: 'normal' };
  const compressor = predictThermalStep(model, state, { ...common, compressorDuty: 1, auxKw: 0 }, 2);
  const auxiliary = predictThermalStep(model, state, { ...common, compressorDuty: 0, auxKw: 9.4 }, 2);
  near(compressor.indoorC, auxiliary.indoorC); near(compressor.reserveC, auxiliary.reserveC);
  assert.equal(Object.hasOwn(model.parameters, 'normalHeatCPerHour'), false);
  assert.equal(Object.hasOwn(model.parameters, 'auxiliaryCPerKwh'), false);
});

test('selected slab conserves source heat, exchanges and ground losses and remains after valve OFF', () => {
  const model = initialAdaptiveModel({ floorThermalPriors: { capacityKwhPerC: 2,
    exchangeKwPerC: 0.4, groundLossKwPerC: 0.02, groundC: 8 } });
  const capacity = 1 / model.parameters.hydronicCPerKwh;
  near(model.floor.nativeCapacityKwhPerC + model.floor.capacityKwhPerC,
    model.parameters.memoryExchangePerHour * model.parameters.reserveTimeHours * capacity);
  const state = { indoorC: 21, reserveC: 23, slabC: 24 };
  const energy = value => value.indoorC * capacity + value.reserveC * model.floor.nativeCapacityKwhPerC
    + value.slabC * model.floor.capacityKwhPerC;
  const input = { outdoorC: 0, solarRadiationWm2: 0, supplyC: 35, brineC: 0,
    compressorDuty: 1, auxKw: 3, floorOverrideMode: 'on' };
  const charged = predictThermalStep(model, state, input, 3);
  near(charged.slabInputKwh + charged.nativeInputKwh, charged.hydronicKwh);
  near(energy(charged) - energy(state), charged.hydronicKwh + charged.otherHeatKwh
    - charged.groundLossKwh - charged.envelopeLossKwh);
  const stopped = predictThermalStep(model, charged, { ...input, compressorDuty: 0, auxKw: 0, floorOverrideMode: 'off' }, 0.25);
  assert.equal(stopped.slabInputKwh, 0); assert.equal(stopped.hydronicKwh, 0);
  assert.ok(stopped.slabC > state.indoorC, 'Valve OFF retains previously stored heat');
  const relayOnly = predictThermalStep(model, state, { ...input, compressorDuty: 0, auxKw: 0 }, 1);
  assert.equal(relayOnly.hydronicKwh, 0); assert.equal(relayOnly.slabInputKwh, 0);
});

test('held indoor endpoints integrate input windows without multiplying independent observations', () => {
  const rows = Array.from({ length: 11 }, (_, i) => row(i, { indoorSensors: {
    room: { weight: 1, value: 21, observedAt: start + Math.floor(i / 5) * 5 * HOUR / 4 },
  } }));
  const intervals = thermalObservationIntervals(rows);
  assert.equal(intervals.length, 3);
  assert.equal(intervals[1].inputSegments.length, 5);
  near(intervals[1].observationIntervalHours, 1.25);
  const score = evaluateThermalModel(initialAdaptiveModel(), rows, { rollout: false });
  assert.equal(score.predictions.length, 2);
  const heldTail = row(11, { indoorSensors: rows.at(-1).indoorSensors });
  const extended = evaluateThermalModel(initialAdaptiveModel(), [...rows, heldTail], { rollout: false });
  assert.equal(extended.predictions.length, 2, 'The held tail supplies no fitting target');
  assert.equal(extended.lastEndpointFresh, false);
  assert.notEqual(extended.state.reserveC, score.state.reserveC, 'Committed heat after the last report still updates the reserve');
});

test('a fixed uncertain solar peer cannot make proportional hydronic forcing independently identified', () => {
  const model = initialAdaptiveModel();
  let state = { indoorC: 21, reserveC: 23 };
  const rows = [];
  for (let i = 0; i < 14 * 96; i++) {
    const duty = i % 24 < 12 ? 0.8 : 0.1;
    const inputs = { outdoorC: 5 * Math.sin(i / 90), solarRadiationWm2: duty * 40,
      compressorDuty: duty, auxKw: 0, phase: 'normal' };
    rows.push(row(i, { ...inputs, indoorC: state.indoorC }));
    state = predictThermalStep(model, state, inputs, 0.25);
  }
  const fit = fitAdaptiveModel({ samples: rows, model, episodeArchive: [], baselineC: 21 });
  const evidence = fit.parameterEvidence ?? fit.model.validation.parameterEvidence;
  assert.equal(evidence.solarCPerHourPerKwM2.status, 'fixed');
  assert.equal(evidence.hydronicCPerKwh.status, 'fixed');
  assert.equal(evidence.hydronicCPerKwh.reason, 'confounded-with-other-heat-inputs');
});

test('isolated episodes cannot qualify from an invented room-temperature reserve and archives retain warmup', () => {
  const model = initialAdaptiveModel(), id = 'invented-sparse-cycle';
  const rows = Array.from({ length: 7 * 96 + 1 }, (_, i) => row(i, { episodeId: i >= 6 * 96 ? id : null }));
  const episode = { id, startedAt: start + 6 * 24 * HOUR, endedAt: start + 7 * 24 * HOUR,
    phases: ['normal'], complete: true, recoveryComplete: true, energyBasis: 'estimated', recoveryHours: 1 };
  let cp = null;
  for (let i = 0; i < rows.length; i += 512)
    cp = updateAdaptiveLearningBatch(cp, rows.slice(i, i + 512), { now: rows.at(-1).timestamp });
  cp = updateAdaptiveEpisode(cp, episode);
  assert.ok(Date.parse(cp.episodeArchive[0].samples[0].timestamp) <= episode.startedAt - 48 * HOUR);
  const isolated = rows.filter(row => row.timestamp >= episode.startedAt);
  const unqualified = evaluateThermalModel(model, isolated, { completeEpisodes: [episode], requireWarmup: true });
  assert.equal(unqualified.samples, 0);
  assert.ok(unqualified.excluded.some(row => row.reason === 'insufficient-causal-thermal-warmup'));
  assert.deepEqual(restoreAdaptiveCheckpoint(JSON.stringify(cp)), restoreAdaptiveCheckpoint(cp));
});

test('old separate-gain checkpoints and other treatment validation cannot qualify the new regime', () => {
  const cp = restoreAdaptiveCheckpoint({ version: 1, samples: [row(0)], model: { version: 2,
    parameters: { normalHeatCPerHour: 0.75, auxiliaryCPerKwh: 0.15 } } });
  assert.equal(cp.model.version, 3); assert.deepEqual(cp.samples, []); assert.equal(cp.model.validation, null);
  const model = initialAdaptiveModel();
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 3,
    parameterEvidence: { lossPerHour: { status: 'identified' }, hydronicCPerKwh: { status: 'identified' } } };
  model.equipmentResponse = { phases: { preheat: { trainingEpisodes: 3 } },
    validation: { phases: { preheat: { accepted: true, episodes: 3, maxDurationHours: 2, treatmentKey: 'room-boost-v1' } } } };
  assert.equal(actionEvidenceReady(model, 'preheat', 1, 'room-boost-v1'), true);
  assert.equal(actionEvidenceReady(model, 'preheat', 1, 'room-boost-floor-v1'), false);
});


test('configured slab uncertainty remains after override release throughout recovery', () => {
  const configured = initialAdaptiveModel({ floorThermalPriors: { capacityKwhPerC: 2 } });
  const unconfigured = initialAdaptiveModel();
  const inputs = { supplyC: 35, brineC: 0, compressorDuty: 0.5, solarRadiationWm2: 0 };
  const base = thermalUncertaintyC(unconfigured, 4, inputs);
  for (const [phase, floorOverrideMode] of [['preheat', 'on'], ['reduction', 'off'], ['recovery', 'off'], ['normal', 'off']]) {
    near(thermalUncertaintyC(configured, 4, { ...inputs, phase, floorOverrideMode }), base + 0.3);
  }
});
