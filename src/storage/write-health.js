// Runtime evidence must remain readable when the database cannot accept writes.
// Never retain SQLite messages: they can contain private paths or input values.
import { createWriteHealthHistory } from './write-health-history.js';
import { JOURNALED_TABLES } from './schema.js';

const tableNames = new Set(JOURNALED_TABLES.map(table => table.name));
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
// Diagnostics are optional evidence. Malformed or private metadata becomes
// unknown, without rejecting the measured transaction or changing its outcome.
function journalEvidence(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'at,bytes,changeCount,sequence,tables'
    || !Number.isSafeInteger(value.changeCount) || value.changeCount < 0
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !Array.isArray(value.tables)
    || value.tables.length > tableNames.size || Array.from(value.tables).some(name => !tableNames.has(name))
    || new Set(value.tables).size !== value.tables.length) return null;
  if (value.changeCount === 0
    ? value.at !== null || value.sequence !== null || value.bytes !== 0 || value.tables.length !== 0
    : !timestamp(value.at) || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || value.bytes === 0 || value.tables.length === 0 || value.tables.length > value.changeCount) return null;
  return { at: value.at, sequence: value.sequence, changeCount: value.changeCount,
    bytes: value.bytes, tables: [...value.tables].sort() };
}

export function storageFailureCode(error) {
  if (error?.code === 'STORAGE_WRITE_ROLLED_BACK' && ['write-queue-full', 'disk-full', 'database-busy',
    'database-read-only', 'database-io', 'database-corrupt', 'database-unavailable'].includes(error.recordingFailureCode))
    return error.recordingFailureCode;
  if (['STORAGE_WRITER_FAILED', 'STORAGE_WRITER_UNAVAILABLE', 'STORAGE_WRITER_TIMEOUT'].includes(error?.code)) return 'database-unavailable';
  if (error?.code === 'STORAGE_QUEUE_FULL') return 'write-queue-full';
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return 'disk-full';
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return ({ 5: 'database-busy', 6: 'database-busy', 8: 'database-read-only',
    10: 'database-io', 11: 'database-corrupt', 13: 'disk-full', 14: 'database-unavailable',
    26: 'database-corrupt' })[code] ?? null;
}

export function createWriteHealth(clock = Date.now, queueStatus = null, { monotonic = () => performance.now() } = {}) {
  const seen = new WeakMap();
  const followupsSeen = new WeakMap();
  const history = createWriteHealthHistory({ clock, monotonic });
  function postCommitFailure(error) {
    if (error && typeof error === 'object') {
      if (followupsSeen.has(error)) return followupsSeen.get(error);
    }
    history.postCommitFailure();
    const token = history.incident({ category: 'follow-up-failed', context: 'storage',
      reason: 'follow-up-failed', outcome: 'saved-follow-up-failed' });
    if (error && typeof error === 'object') followupsSeen.set(error, token);
    return token;
  }
  const state = { startedAt: clock(), lastWriteAt: null, lastFailureAt: null,
    errorCode: null, failures: 0, failing: false };
  const recent = [], limit = 128;
  const slow = [], slowLimit = 16, slowThresholdMs = 1000;
  let slowCount = 0;
  const durations = ['beginMs', 'bodyMs', 'commitMs', 'totalMs'];
  const stages = ['journalSealMs', 'nativeCommitMs'];
  let transactionCount = 0, committedCount = 0, lastTransactionAt = null;
  const timings = () => ({ count: transactionCount, committed: committedCount, lastAt: lastTransactionAt,
    sampleCount: recent.length, sampleLimit: limit,
    slowAttempts: { thresholdMs: slowThresholdMs, sampleLimit: slowLimit, count: slowCount,
      samples: slow.map(row => ({ ...row, journal: row.journal && { ...row.journal, tables: [...row.journal.tables] } })) },
    ...Object.fromEntries([...durations, ...stages].map(key => {
      const values = recent.map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return [key, { last: recent.at(-1)?.[key] ?? null, max: values.at(-1) ?? null,
        p99: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] : null,
        ...(stages.includes(key) ? { sampleCount: values.length } : {}) }];
    })) });
  return {
    success() { state.lastWriteAt = clock(); state.failing = false; },
    failure(error, details) {
      if (error?.committed === true) return postCommitFailure(error);
      if (error?.code === 'STORAGE_WRITE_ROLLED_BACK') return;
      const code = storageFailureCode(error);
      if (!code) return;
      if (error && typeof error === 'object') {
        if (seen.has(error)) {
          const token = seen.get(error); history.describeFailure(token, details); return token;
        }
      }
      state.lastFailureAt = clock(); state.errorCode = code;
      state.failures++; state.failing = true;
      history.failure(code);
      const token = history.incident({ category: code === 'write-queue-full' ? 'queue-refused' : 'save-failed',
        context: 'storage', reason: code, outcome: code === 'write-queue-full' ? 'queue-refused' : 'save-failed' });
      history.describeFailure(token, details);
      if (error && typeof error === 'object') seen.set(error, token);
      return token;
    },
    transaction(value) {
      if (typeof value?.committed !== 'boolean'
        || durations.some(key => !Number.isFinite(value[key]) || value[key] < 0)
        || stages.some(key => value[key] !== null && (!Number.isFinite(value[key]) || value[key] < 0))) return;
      transactionCount++; committedCount += Number(value.committed); lastTransactionAt = clock();
      recent.push({ committed: value.committed,
        ...Object.fromEntries([...durations, ...stages].map(key => [key, value[key]])) });
      if (recent.length > limit) recent.shift();
      if (value.totalMs >= slowThresholdMs) {
        let journal = null;
        try { journal = journalEvidence(value.journal); } catch {}
        slowCount++;
        slow.push({ startedAt: timestamp(value.startedAt) ? value.startedAt : null,
          finishedAt: timestamp(lastTransactionAt) ? lastTransactionAt : null, ...recent.at(-1), journal });
        if (slow.length > slowLimit) slow.shift();
      }
      history.transaction(value);
    },
    queue(event) { history.queue(event); },
    postCommitFailure,
    recovered(token) { history.recovered(token); },
    commandNotSent(context, reason) { history.commandNotSent(context, reason); },
    monitorCommands(context, options) { history.monitorCommands(context, options); },
    controlRequestBlocked(reason) { history.controlRequestBlocked(reason); },
    status() {
      const queue = queueStatus?.();
      return { ...state, transactions: timings(), ...(queue ? { queue } : {}), history: history.status(queue) };
    },
  };
}
