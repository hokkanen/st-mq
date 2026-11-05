import { createHash } from 'node:crypto';
import { validateCycleEvaluationState } from './cycle-evaluation-state.js';

export const MAX_CYCLE_WORKING_BYTES = 16 * 1024;
const fields = ['version','id','count','observer','reference','revision','digest'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => Object.assign(new TypeError('Unsupported cycle working state. Preserve the database and use an intact current-format backup.'),
  { code: 'CYCLE_WORKING_STATE_INVALID' });

/** Only this format is accepted. The digest detects damaged derived contents;
 * source reconstruction replaces a bad cache without changing its evidence. */
export function validateCycleWorking(value, id) {
  if (value === null) return value;
  try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_CYCLE_WORKING_BYTES) throw invalid(); }
  catch { throw invalid(); }
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== fields.length
    || Object.keys(value).some(key => !fields.includes(key)) || typeof value.id !== 'string'
    || !value.id.trim() || value.id.length > 500 || id !== undefined && value.id !== id
    || !Number.isSafeInteger(value.count) || value.count < 0
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || value.observer !== null && !object(value.observer)
    || value.reference !== null && !object(value.reference) || !/^[a-f0-9]{64}$/.test(value.digest ?? '')) throw invalid();
  const reference = value.reference;
  if (reference === null) { if (value.count !== 0) throw invalid(); }
  else if (Object.keys(reference).join(',') === 'unavailable') { if (reference.unavailable !== true) throw invalid(); }
  else {
    if (Object.keys(reference).join(',') !== 'continuation') throw invalid();
    try { validateCycleEvaluationState(reference.continuation); } catch { throw invalid(); }
    if (value.count > 0 && reference.continuation.previousEnd === null) throw invalid();
  }
  return value;
}
export function sealCycleWorking({ id, count, observer, reference, revision }) {
  const body = { version: 1, id, count, observer, reference, revision };
  return validateCycleWorking({ ...body, digest: digest(body) },id);
}
export function cycleWorkingIntact(value) {
  if (!value) return false;
  const { digest: saved, ...body } = validateCycleWorking(value);
  return saved === digest(body);
}

export function decodeCycleWorking(text,id) {
  let value;
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CYCLE_WORKING_BYTES) throw invalid();
    value = JSON.parse(text);
  } catch { throw invalid(); }
  return validateCycleWorking(value,id);
}
