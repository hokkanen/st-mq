import { indoorWeights, SENSOR_SETTLING_MS } from '../domain/indoor-sensors.js';

/** Restore the compact temperature-only patch. All other resolved inputs and
 * recorded quality exclusions keep their original interpretation. */
export function originalSensorSample(sample) {
  if (!sample.measurementInputs) return sample;
  const { measurementInputs: saved, ...original } = sample;
  return { ...original, indoorC: saved.indoorC, indoorSensors: saved.indoorSensors,
    outdoorC: saved.outdoorC, quality: saved.quality,
    inputSegments: original.inputSegments.map((segment, index) => ({ ...segment, ...saved.outdoorSegments[index] })),
    intervalInputs: { ...original.intervalInputs, outdoorC: saved.outdoorC } };
}

/** Eligibility is derived from the selected event revision. Keep the original
 * temperature inputs even during settling so correction replay needs no device
 * polls, mutable coverage queries or copies of complete sample histories. */
export function withSensorMeasurements(sample, checkpoint = {}, configuration = {}) {
  if (sample.sensorInputVersion !== 1) return sample;
  checkpoint ??= {};
  const original = originalSensorSample(sample), from = original.windowStart;
  const epochs = checkpoint.sensorEpochs ?? {};
  const weights = indoorWeights(configuration);
  const epoch = Math.max(checkpoint.measurementEpochAt ?? 0, ...Object.entries(epochs)
    .filter(([signal]) => signal === 'outdoor_temperature' || Object.hasOwn(weights, signal)).map(([, at]) => at));
  const settling = epoch > 0 && from < epoch + SENSOR_SETTLING_MS;
  const indoorSensors = Object.fromEntries(Object.entries(original.indoorSensors).map(([signal, sensor]) => {
    const boundary = Math.max(epoch, epochs[signal] ?? 0);
    let value = sensor.value, coverage = null;
    if (boundary && Array.isArray(sensor.reportIntervals)) {
      let through = from, endpoint = false;
      for (const span of sensor.reportIntervals) if (span.observedAt >= boundary) {
        if (span.start <= through) through = Math.max(through, Math.min(original.windowEnd, span.end));
        endpoint ||= span.endpoint;
      }
      coverage = { reportCoverageComplete: through >= original.windowEnd && endpoint, reportCoveredThrough: through };
      if (!coverage.reportCoverageComplete) value = null;
    }
    if (settling || boundary && (!Number.isFinite(sensor.observedAt) || sensor.observedAt < boundary)) value = null;
    return [signal, { ...sensor, ...coverage, value }];
  }));
  const indoorC = Object.values(indoorSensors).every(sensor => Number.isFinite(sensor.value))
    ? Object.values(indoorSensors).reduce((sum, sensor) => sum + sensor.value * sensor.weight, 0) : null;
  const outdoorEpoch = epochs.outdoor_temperature;
  const inputSegments = original.inputSegments.map(segment => {
    // Outdoor freshness is at most 30 minutes. Once this settling period
    // ends, the neutral trajectory already excludes pre-change measurements.
    if (!Number.isFinite(outdoorEpoch) || from >= outdoorEpoch + SENSOR_SETTLING_MS) return segment;
    return { ...segment, outdoorC: null, quality: [...new Set([...segment.quality, 'missing'])] };
  });
  const outdoorMasked = inputSegments.some((segment, index) => segment.outdoorC !== original.inputSegments[index].outdoorC);
  const outdoorC = !outdoorMasked ? original.outdoorC : inputSegments.every(segment => Number.isFinite(segment.outdoorC))
    ? inputSegments.reduce((sum, segment) => sum + segment.outdoorC * (segment.end - segment.start), 0)
      / (original.windowEnd - from) : null;
  const quality = [...new Set([...original.quality, ...inputSegments.flatMap(segment => segment.quality),
    ...(!Number.isFinite(indoorC) || !Number.isFinite(outdoorC) ? ['missing'] : []),
    ...(settling ? ['sensor-change-settling'] : [])])];
  const changed = indoorC !== original.indoorC || outdoorC !== original.outdoorC
    || JSON.stringify(indoorSensors) !== JSON.stringify(original.indoorSensors)
    || JSON.stringify(quality) !== JSON.stringify(original.quality)
    || inputSegments.some((segment, index) => segment.outdoorC !== original.inputSegments[index].outdoorC);
  return { ...original, indoorC, indoorSensors, outdoorC, quality, inputSegments, measurementEpochAt: epoch || null,
    intervalInputs: { ...original.intervalInputs, outdoorC },
    ...(changed ? { measurementInputs: { indoorC: original.indoorC, indoorSensors: original.indoorSensors,
      outdoorC: original.outdoorC, quality: original.quality,
      outdoorSegments: original.inputSegments.map(({ outdoorC, quality }) => ({ outdoorC, quality })) } } : {}) };
}
