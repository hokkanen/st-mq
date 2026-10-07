import { predictThermalStep } from '../control/adaptive-learning.js';
import { goodQuality } from '../control/learning.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
/** Runtime prediction only: this state never enters the learning checkpoint. */
export function indoorControlState({ previous, checkpoint, sample, observation, identity, now }) {
  if (!observation || observation.stale || !finite(observation.value)) return null;
  const signature = JSON.stringify([identity, checkpoint.model.parameters, checkpoint.model.floor]);
  let state, cursor, measuredStateAt;
  if (!observation.estimated) {
    const observedAt = Date.parse(checkpoint.state?.observedAt);
    if (!checkpoint.state || !finite(checkpoint.state.reserveC) || !finite(checkpoint.state.indoorC)
      || !finite(observedAt) || observedAt > now || now - observedAt > HOUR / 2) return null;
    // A committed checkpoint describes its own boundary. Catch its reserve up
    // through actual covered inputs before attaching today's measured room value.
    state = { ...checkpoint.state }; cursor = observedAt; measuredStateAt = observedAt;
  } else {
    if (!previous || previous.signature !== signature || !finite(previous.at) || previous.at > now
      || now - previous.at > HOUR / 2 || !finite(previous.state?.reserveC) || !finite(previous.state?.indoorC)) return null;
    state = { ...previous.state }; cursor = previous.at; measuredStateAt = previous.measuredStateAt;
  }
  for (const segment of sample.inputSegments ?? []) {
    if (!finite(segment.start) || !finite(segment.end) || segment.end <= segment.start) return null;
    if (segment.end <= cursor || segment.start >= now) continue;
    if (segment.start > cursor || ![segment.outdoorC, segment.thermalCompressorDuty, segment.thermalAuxKw].every(finite)
      || !goodQuality(segment.quality) || segment.outdoorC < -60 || segment.outdoorC > 50
      || segment.thermalCompressorDuty < 0 || segment.thermalCompressorDuty > 1
      || segment.thermalAuxKw < 0 || segment.thermalAuxKw > 20
      || ['partial', 'unknown'].includes(segment.floorOverrideMode)
      || checkpoint.model.floor?.enabled && !['on', 'off'].includes(segment.floorOverrideMode)) return null;
    const end = Math.min(now, segment.end);
    state = predictThermalStep(checkpoint.model, state, { ...segment,
      compressorDuty: segment.thermalCompressorDuty, auxKw: segment.thermalAuxKw }, (end - cursor) / HOUR);
    cursor = end;
  }
  if (cursor !== now || !finite(state.reserveC)) return null;
  return { signature, at: now, measuredStateAt, estimated: observation.estimated === true,
    state: { indoorC: observation.value, reserveC: state.reserveC, slabC: state.slabC ?? null } };
}
