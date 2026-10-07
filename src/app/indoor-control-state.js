import { predictThermalStep } from '../control/adaptive-learning.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
/** Runtime prediction only: this state never enters the learning checkpoint. */
export function indoorControlState({ previous, checkpoint, sample, observation, identity, now }) {
  if (!observation || observation.stale || !finite(observation.value)) return null;
  const signature = JSON.stringify([identity, checkpoint.model.parameters, checkpoint.model.floor]);
  if (!observation.estimated) {
    const state = checkpoint.state, observedAt = Date.parse(state?.observedAt);
    if (!state || !finite(state.reserveC) || !finite(observedAt) || observedAt > now || now - observedAt > HOUR / 2) return null;
    return { signature, at: now, measuredStateAt: observedAt, estimated: false,
      state: { ...state, indoorC: observation.value } };
  }
  if (!previous || previous.signature !== signature || !finite(previous.at) || previous.at > now
    || now - previous.at > HOUR / 2 || !finite(previous.state?.reserveC)) return null;
  let state = { ...previous.state }, cursor = previous.at;
  for (const segment of sample.inputSegments ?? []) {
    if (!finite(segment.start) || !finite(segment.end) || segment.end <= segment.start) return null;
    if (segment.end <= cursor || segment.start >= now) continue;
    if (segment.start > cursor || ![segment.outdoorC, segment.thermalCompressorDuty, segment.thermalAuxKw].every(finite)
      || segment.thermalCompressorDuty < 0 || segment.thermalCompressorDuty > 1 || segment.thermalAuxKw < 0
      || ['partial', 'unknown'].includes(segment.floorOverrideMode)
      || checkpoint.model.floor?.enabled && !['on', 'off'].includes(segment.floorOverrideMode)) return null;
    const end = Math.min(now, segment.end);
    state = predictThermalStep(checkpoint.model, state, { ...segment,
      compressorDuty: segment.thermalCompressorDuty, auxKw: segment.thermalAuxKw }, (end - cursor) / HOUR);
    cursor = end;
  }
  if (cursor !== now || !finite(state.reserveC)) return null;
  return { signature, at: now, measuredStateAt: previous.measuredStateAt, estimated: true,
    state: { indoorC: observation.value, reserveC: state.reserveC, slabC: state.slabC ?? null } };
}
