import { readCoefficientHistory } from '../storage/coefficient-history.js';

/** Charts read committed model history and never start model reconstruction. */
export function addModelCoefficients({ store, range, now, input, envelopes }) {
  return readCoefficientHistory({ store, range, now, input, envelopes });
}
