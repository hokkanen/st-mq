import { pendingEnergyObservationsFromStates } from '../storage/pending-energy.js';
import { validEnergyQuality } from '../storage/energy-history.js';
import { recoveryCoverageEvidence } from './ledger.js';
import { learningVersion } from '../app/committed-learning.js';

// A final publication may recheck only this many newly appended records while
// holding its writer lock. Larger or relevant changes return to normal catch-up.
// Proofs and current evidence each have a 256 KiB budget; stream/cursor sets
// have 128 entries. No record or proof is silently truncated to those bounds.
export const RESTORATION_PUBLICATION_TAIL = 64;
export const RESTORATION_PUBLICATION_STREAMS = 128;
export const RESTORATION_PUBLICATION_BYTES = 256 * 1024;

export const laterObservation = (row, maximumAt) => {
  if (!Number.isFinite(row.source_time) || !Number.isFinite(row.received_at)
    || row.source_time <= maximumAt || row.received_at <= maximumAt) return false;
  let raw; try { raw = row.raw === null ? null : JSON.parse(row.raw); } catch { return false; }
  return raw?.intervalStart === undefined || Number.isFinite(raw.intervalStart) && raw.intervalStart >= maximumAt;
};
function laterPending(value, maximumAt) {
  if (value === undefined) return true;
  let state; try { state = JSON.parse(value); } catch { return false; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.pending == null) return true;
  const pending = state.pending;
  return Number.isFinite(pending.start) && pending.start >= maximumAt && Number.isFinite(pending.end)
    && pending.end > pending.start && Number.isFinite(pending.receivedAt) && pending.receivedAt > maximumAt;
}
function unchangedEarlierPending(key, before, after, previous, now) {
  if (before === undefined || after === undefined) return false;
  const oldRows = pendingEnergyObservationsFromStates([{ key, value: before }], { now: previous.pendingAt });
  const newRows = pendingEnergyObservationsFromStates([{ key, value: after }], { now });
  if (!oldRows.length || oldRows.length !== newRows.length) return false;
  // Once a valid overlapping tail ends beyond every recovered interval, an
  // extension of that same stream cannot change the already checked overlap.
  return oldRows.every((old, index) => {
    const next = newRows[index];
    return ['source', 'device', 'signal', 'unit', 'quality'].every(key => old[key] === next[key])
      && validEnergyQuality(JSON.parse(old.quality))
      && JSON.parse(old.raw).intervalStart === JSON.parse(next.raw).intervalStart
      && old.source_time > previous.maximumAt && next.source_time >= old.source_time;
  });
}

export function compatiblePendingStates(previous, states, now) {
  const before = new Map(previous.pendingStates.map(row => [row.key, row.value])),
    after = new Map(states.map(row => [row.key, row.value]));
  const samePending = key => before.get(key) === after.get(key)
    && learningVersion(pendingEnergyObservationsFromStates([{ key, value: before.get(key) }], { now: previous.pendingAt }))
      === learningVersion(pendingEnergyObservationsFromStates([{ key, value: after.get(key) }], { now }));
  return [...new Set([...before.keys(), ...after.keys()])].every(key => samePending(key)
    || laterPending(before.get(key), previous.maximumAt) && laterPending(after.get(key), previous.maximumAt)
    || unchangedEarlierPending(key, before.get(key), after.get(key), previous, now));
}

export const coverageAfter = (row, maximumAt) => Number.isFinite(row.start_at) && Number.isFinite(row.end_at)
  && row.start_at > maximumAt && row.end_at >= row.start_at;
function unchangedEarlierCoverage(before, after, maximumAt) {
  if (!after || ![before, after].every(row => Number.isFinite(row.start_at) && Number.isFinite(row.end_at)
    && (row.source_time === null || Number.isFinite(row.source_time)))) return false;
  if (Object.keys(before).every(key => before[key] === after[key])) return true;
  if (coverageAfter(before, maximumAt) && coverageAfter(after, maximumAt)) return true;
  return ['id', 'source', 'device', 'signal', 'status', 'start_at', 'observation_id'].every(key => before[key] === after[key])
    && before.end_at > maximumAt && after.end_at >= before.end_at;
}
export function compatibleCoverage(current, previous, next, maximumAt) {
  const known = new Set(previous.rows.map(row => row.id));
  if (next.rows.some(row => !known.has(row.id) && !coverageAfter(row, maximumAt))) return false;
  return previous.rows.every(before => unchangedEarlierCoverage(before, current.db.prepare(`SELECT id,source,device,signal,status,start_at,end_at,source_time,observation_id
    FROM recorder_coverage WHERE id=?`).get(before.id), maximumAt));
}

const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const coverageColumns = ['id', 'source', 'device', 'signal', 'status', 'start_at', 'end_at', 'source_time', 'observation_id'];

/** Transient worker proof only. Refuse an oversized proof rather than truncating
 * it; exact-version publication and normal outside-lane verification still work. */
function validSnapshot(previous) {
  if (!exactKeys(previous, ['token', 'version', 'observationHead', 'pendingStates', 'pendingAt', 'coverage', 'maximumAt'])
    || !(previous.token === null || digest(previous.token)) || !digest(previous.version)
    || !nonnegative(previous.observationHead) || !Number.isSafeInteger(previous.pendingAt)
    || !Array.isArray(previous.pendingStates) || previous.pendingStates.length > RESTORATION_PUBLICATION_STREAMS
    || !exactKeys(previous.coverage, ['head', 'rows']) || !nonnegative(previous.coverage.head)
    || !Array.isArray(previous.coverage.rows) || previous.coverage.rows.length > RESTORATION_PUBLICATION_STREAMS
    || !(Number.isFinite(previous.maximumAt) || previous.maximumAt === -Infinity)) return null;
  let bytes = 0;
  const pendingKeys = new Set(), coverageIds = new Set();
  for (const row of previous.pendingStates) {
    if (!exactKeys(row, ['key', 'value']) || typeof row.key !== 'string' || !row.key.startsWith('recorder:energy:')
      || typeof row.value !== 'string' || pendingKeys.has(row.key)) return null;
    pendingKeys.add(row.key);
    bytes += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
    if (bytes > RESTORATION_PUBLICATION_BYTES) return null;
  }
  for (const row of previous.coverage.rows) {
    if (!exactKeys(row, coverageColumns) || !nonnegative(row.id) || row.id > previous.coverage.head || coverageIds.has(row.id)) return null;
    coverageIds.add(row.id);
    for (const value of Object.values(row)) {
      if (typeof value === 'string') bytes += Buffer.byteLength(value);
      else if (value !== null && !Number.isFinite(value)) return null;
    }
    if (bytes > RESTORATION_PUBLICATION_BYTES) return null;
  }
  if (Buffer.byteLength(JSON.stringify(previous)) > RESTORATION_PUBLICATION_BYTES) return null;
  const version = learningVersion({ observations: previous.observationHead, energy: previous.pendingStates,
    pending: pendingEnergyObservationsFromStates(previous.pendingStates, { now: previous.pendingAt }), coverage: previous.coverage });
  return version === previous.version ? previous : null;
}

export function publicationRestorationProof(previous) {
  if (!validSnapshot(previous)) return null;
  const proof = { ...previous, digest: learningVersion(previous) };
  return Buffer.byteLength(JSON.stringify(proof)) <= RESTORATION_PUBLICATION_BYTES ? proof : null;
}

/** The caller holds one SQLite writer transaction. Only a previously verified
 * proof can extend across harmless current-stream changes and a bounded suffix;
 * overlap, unknown clocks and larger tails require normal outside-lane checking. */
export function compatibleRestorationTail(store, previous, { now }) {
  if (!exactKeys(previous, ['token', 'version', 'observationHead', 'pendingStates', 'pendingAt', 'coverage', 'maximumAt', 'digest'])
    || !digest(previous.digest)) return false;
  const { digest: expected, ...snapshot } = previous;
  if (!validSnapshot(snapshot) || learningVersion(snapshot) !== expected) return false;
  previous = snapshot;
  const observationHead = store.db.prepare('SELECT COALESCE(MAX(id),0) n FROM observations').get().n;
  if (observationHead < previous.observationHead) return false;
  const sizes = store.db.prepare(`SELECT length(CAST(key AS BLOB)) key_bytes,length(CAST(value AS BLOB)) value_bytes
    FROM state WHERE key GLOB 'recorder:energy:*' ORDER BY key LIMIT ?`).all(RESTORATION_PUBLICATION_STREAMS + 1);
  let bytes = sizes.reduce((total, row) => total + row.key_bytes + row.value_bytes, 0);
  if (sizes.length > RESTORATION_PUBLICATION_STREAMS || bytes > RESTORATION_PUBLICATION_BYTES) return false;
  const states = store.db.prepare("SELECT key,value FROM state WHERE key GLOB 'recorder:energy:*' ORDER BY key LIMIT ?")
    .all(RESTORATION_PUBLICATION_STREAMS + 1);
  if (!compatiblePendingStates(previous, states, now)) return false;
  const sizesCoverage = recoveryCoverageEvidence(store, { limit: RESTORATION_PUBLICATION_STREAMS + 1, sizesOnly: true });
  if (sizesCoverage.head < previous.coverage.head || sizesCoverage.rows.length > RESTORATION_PUBLICATION_STREAMS) return false;
  bytes += sizesCoverage.rows.reduce((total, row) => total + row.bytes, 0);
  if (previous.coverage.rows.length) {
    const ids = previous.coverage.rows.map(row => row.id), placeholders = ids.map(() => '?').join(',');
    const size = coverageColumns.map(name => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join('+');
    bytes += store.db.prepare(`SELECT COALESCE(SUM(${size}),0) bytes FROM recorder_coverage WHERE id IN (${placeholders})`).get(...ids).bytes;
  }
  if (bytes > RESTORATION_PUBLICATION_BYTES) return false;
  const coverage = recoveryCoverageEvidence(store, { limit: RESTORATION_PUBLICATION_STREAMS + 1 });
  if (!compatibleCoverage(store, previous.coverage, coverage, previous.maximumAt)) return false;
  const spans = store.db.prepare('SELECT id,start_at,end_at FROM recorder_coverage WHERE id>? AND id<=? ORDER BY id LIMIT ?')
    .all(previous.coverage.head, coverage.head, RESTORATION_PUBLICATION_TAIL + 1);
  if (spans.length > RESTORATION_PUBLICATION_TAIL || !spans.every(row => coverageAfter(row, previous.maximumAt))) return false;
  const observations = store.db.prepare('SELECT id,length(CAST(raw AS BLOB)) raw_bytes FROM observations WHERE id>? ORDER BY id LIMIT ?')
    .all(previous.observationHead, RESTORATION_PUBLICATION_TAIL + 1);
  bytes += observations.reduce((total, row) => total + (row.raw_bytes ?? 0), 0);
  if (observations.length > RESTORATION_PUBLICATION_TAIL || bytes > RESTORATION_PUBLICATION_BYTES) return false;
  const rows = store.db.prepare('SELECT id,source_time,received_at,raw FROM observations WHERE id>? ORDER BY id LIMIT ?')
    .all(previous.observationHead, RESTORATION_PUBLICATION_TAIL + 1);
  return rows.every(row => laterObservation(row, previous.maximumAt));
}
