import { appendLearningRecord as appendRecord } from '../../src/app/committed-learning.js';

/** Synthetic current-contract journal fixture; never used by runtime readers. */
export function currentHomeSample(value) {
  const { intervalInputs, ...sample } = value;
  const end = typeof sample.timestamp === 'number' ? sample.timestamp : Date.parse(sample.timestamp);
  const start = sample.windowStart ?? end - 900_000;
  const input = intervalInputs ?? sample;
  return { ...sample, sensorInputVersion: 1, windowStart: start, windowEnd: end,
    indoorSensors: sample.indoorSensors ?? { indoor_temperature: { value: sample.indoorC, weight: 1, observedAt: end } },
    inputSegments: sample.inputSegments ?? [{ start, end, durationHours: (end - start) / 3_600_000,
      phase: input.phase, regime: sample.regime, outdoorC: input.outdoorC, solarRadiationWm2: input.solarRadiationWm2,
      thermalCompressorDuty: input.thermalCompressorDuty ?? input.compressorDuty ?? null,
      thermalAuxKw: input.thermalAuxKw ?? input.auxKw ?? null, roomBoostC: input.roomBoostC ?? 0,
      targetC: input.targetC ?? null, floorOverrideMode: input.floorOverrideMode ?? 'off',
      quality: sample.quality ?? [] }] };
}
export function appendLearningRecord(store, input, kind, value, options) {
  return appendRecord(store, input, kind, kind === 'sample' ? currentHomeSample(value) : value, options);
}
