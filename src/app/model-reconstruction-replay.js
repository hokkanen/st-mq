import { applyLearningRecord } from './committed-learning.js';
import { emptyCoefficientProjection, projectCoefficientTransition } from '../domain/coefficient-projection.js';
export const createCoefficientReplayState = () => ({ ...emptyCoefficientProjection(), checkpoint: null, records: 0, invalidRecords: 0, pendingEvents: [] });
export { projectCoefficientTransition };
export function applyCoefficientReplayEntry(state, entry, context) {
  const previous = state.coefficients;
  state.records++;
  if (state.blocked && !Object.hasOwn(entry.payload ?? {}, 'seed')) {
    if (!state.invalidRecords) state.invalidRecords++;
    state.at = Math.max(state.at ?? -Infinity, entry.at); state.cursor = entry.id; state.coefficients = null;
  } else try {
    const prior = state.blocked ? null : state.checkpoint;
    const next = applyLearningRecord(prior, entry, context);
    const event = projectCoefficientTransition(state, entry, prior, next);
    state.checkpoint = next;
    if (event) state.pendingEvents.push(event);
    return event;
  } catch {
    state.invalidRecords++; state.blocked = true; state.checkpoint = null; state.learned = []; state.fitted = []; state.coefficients = null;
    state.at = Math.max(state.at ?? -Infinity, entry.at); state.cursor = entry.id;
  }
  if (previous !== null || state.records === 1) {
    const event = { cursor: entry.id, at: state.at, coefficients: null }; state.pendingEvents.push(event); return event;
  }
  return null;
}
