import { learningCheckpointMaterial } from './committed-learning.js';

// Diagnostic names are schema fields, never arbitrary keys from source maps.
// A household identifier can itself look like a valid JavaScript identifier.
const fields = new Set(`version algorithmVersion journalCursor journalHash journalEntryHash configVersion
  fireplaceRevision sensorRevision baselineC cursor timestamp model parameters performance confidence validation
  samples inputSegments windowStart windowEnd start end durationHours state health status reason acceptedFits
  rejectedFits sinceFit lastFitAt lastAcceptedFitAt comfortLearning comfortReference comfortReferences
  episodeArchive episodeId phase regime targetC roomBoostC indoorC outdoorC reserveC slabC solarRadiationWm2
  fireplaceKgPerHour fireplaceActive fireplaceIgnitions lossPerHour heatCPerHour solarCPerWm2 fireplaceCPerKg
  compressorDuty thermalCompressorDuty auxKw thermalAuxKw compressorPowerKw energyKwh quality configuration
  parameterEvidence accepted observations evidence capacityKwhPerC enabled fittedAt updatedAt`.split(/\s+/));
const material = checkpoint => checkpoint === null ? null
  : JSON.parse(JSON.stringify(learningCheckpointMaterial(checkpoint)));

/** Explain an exact mismatch without publishing private sample values or map
 * keys. This never decides whether a model matches and introduces no tolerance. */
export function modelVerificationDifferences(expected, reconstructed) {
  const summary = { count: 0, numericCount: 0, otherCount: 0, maxAbsoluteDelta: 0,
    maxRelativeDelta: 0, paths: [], truncated: false };
  let maxScaledDelta = 0;
  const difference = (left, right, path) => {
    summary.count++;
    if (typeof left === 'number' && typeof right === 'number') {
      summary.numericCount++;
      const scale = Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE);
      summary.maxAbsoluteDelta = Math.max(summary.maxAbsoluteDelta, Math.min(Number.MAX_VALUE, Math.abs(left - right)));
      summary.maxRelativeDelta = Math.max(summary.maxRelativeDelta, Math.abs(left / scale - right / scale));
      maxScaledDelta = Math.max(maxScaledDelta, Math.abs(left / Math.max(1, scale) - right / Math.max(1, scale)));
    } else summary.otherCount++;
    if (summary.paths.length < 8) summary.paths.push(path.join('.').slice(0, 160) || '[model]');
    else summary.truncated = true;
  };
  const visit = (left, right, path) => {
    if (left === right) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let index = 0; index < Math.max(left.length, right.length); index++)
        visit(left[index], right[index], [...path, String(index)]);
    } else if (left && right && typeof left === 'object' && typeof right === 'object'
      && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
        visit(left[key], right[key], [...path, fields.has(key) ? key : '[field]']);
    } else difference(left, right, path);
  };
  visit(material(expected), material(reconstructed), []);
  // Diagnostic classification only. Exact verification still fails on every
  // differing bit; small deltas alone cannot establish their physical cause.
  summary.roundingConsistent = summary.count > 0 && summary.otherCount === 0
    && summary.maxAbsoluteDelta <= 1e-9 && maxScaledDelta <= 1e-12;
  return summary;
}
