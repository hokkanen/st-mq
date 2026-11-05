import { MAX_SOURCE_AHEAD_MS } from './time-evidence.js';

export const OCPP_TRANSACTION_MAX_AGE_MS = 60_000;
export const OCPP_NO_TRANSACTION_STATUSES = new Set(['Available', 'Finishing']);
export const OCPP_EXTERNAL_STOP_REASONS = new Set(['Remote', 'Local', 'DeAuthorized']);
export const OCPP_RECOVERY_ATTEMPT_LIMIT = 256;
const MAX_AGE_MS = OCPP_TRANSACTION_MAX_AGE_MS, MAX_FUTURE_MS = MAX_SOURCE_AHEAD_MS;
const NO_TRANSACTION_STATUSES = OCPP_NO_TRANSACTION_STATUSES, EXTERNAL_STOP_REASONS = OCPP_EXTERNAL_STOP_REASONS;

function validStartRecoveries(value) {
  return value && Object.keys(value).sort().join(',') === 'attempts,connectedAt'
    && Number.isSafeInteger(value.connectedAt) && value.connectedAt >= 0
    && Array.isArray(value.attempts) && value.attempts.length > 0 && value.attempts.length <= OCPP_RECOVERY_ATTEMPT_LIMIT
    && new Set(value.attempts.map(row => row?.key)).size === value.attempts.length
    && value.attempts.every((row, index) => row && Object.keys(row).sort().join(',') === 'at,key'
      && typeof row.key === 'string' && /^[a-f0-9]{64}$/.test(row.key)
      && Number.isSafeInteger(row.at) && row.at >= value.connectedAt
      && (!index || row.at >= value.attempts[index - 1].at));
}

export const validOcppTransactionState = (value, scope = value?.scope) => value && value.version === 5
  && typeof scope === 'string' && /^[a-f0-9]{64}$/.test(scope) && value.scope === scope
  && Object.keys(value).every(key => ['version', 'scope', 'nextId', 'latestStartAt', 'activeId', 'transactions', 'recovered', 'automaticStartRecoveries'].includes(key))
  && Object.hasOwn(value, 'automaticStartRecoveries')
  && (value.automaticStartRecoveries === null || validStartRecoveries(value.automaticStartRecoveries))
  && Number.isSafeInteger(value.nextId) && value.nextId > 0 && value.nextId < 2147483647
  && Number.isSafeInteger(value.latestStartAt) && value.latestStartAt >= 0
  && (value.activeId === null || Number.isSafeInteger(value.activeId))
  && Array.isArray(value.transactions) && value.transactions.length <= 128
  && new Set(value.transactions.map(row => row.id)).size === value.transactions.length
  && value.transactions.every(row => row && Object.keys(row).every(key => ['id', 'fingerprint', 'tagHash', 'status', 'startedAt', 'startReceivedAt', 'lastEvidenceAt', 'meterStart', 'stopFingerprint', 'stoppedAt', 'stopReason', 'stopReceivedAt', 'meterStop', 'endedByStatus', 'modeDisableIntent', 'endedByNewStart'].includes(key))
    && Number.isSafeInteger(row.id) && row.id > 0 && row.id < value.nextId
    && /^[a-f0-9]{64}$/.test(row.fingerprint) && /^[a-f0-9]{64}$/.test(row.tagHash) && ['Accepted', 'Blocked', 'Invalid'].includes(row.status)
    && Number.isSafeInteger(row.startedAt) && row.startedAt >= 0 && row.startedAt <= value.latestStartAt
    && (row.startReceivedAt === undefined || Number.isSafeInteger(row.startReceivedAt) && row.startReceivedAt >= 0
      && row.startedAt - row.startReceivedAt <= MAX_FUTURE_MS)
    && Number.isSafeInteger(row.lastEvidenceAt) && row.lastEvidenceAt >= row.startedAt
    && Number.isSafeInteger(row.meterStart) && row.meterStart >= 0
    && (row.stopReason === undefined && row.stopReceivedAt === undefined || EXTERNAL_STOP_REASONS.has(row.stopReason)
      && Number.isSafeInteger(row.stopReceivedAt) && row.stopReceivedAt >= 0 && row.stoppedAt - row.stopReceivedAt <= MAX_FUTURE_MS)
    && (row.modeDisableIntent === undefined || row.status === 'Accepted' && row.modeDisableIntent
      && Object.keys(row.modeDisableIntent).every(key => ['requestedAt', 'connectionId', 'attemptedAt'].includes(key))
      && Number.isSafeInteger(row.modeDisableIntent.requestedAt) && row.modeDisableIntent.requestedAt >= row.startedAt
      && (row.modeDisableIntent.connectionId === null || typeof row.modeDisableIntent.connectionId === 'string'
        && row.modeDisableIntent.connectionId.length > 0 && row.modeDisableIntent.connectionId.length <= 100)
      && (row.modeDisableIntent.attemptedAt === undefined || Number.isSafeInteger(row.modeDisableIntent.attemptedAt)
        && row.modeDisableIntent.attemptedAt >= row.modeDisableIntent.requestedAt))
    && (row.endedByNewStart === undefined || row.status === 'Accepted' && row.modeDisableIntent && row.endedByNewStart
      && Object.keys(row.endedByNewStart).length === 2
      && Object.keys(row.endedByNewStart).every(key => ['transactionId', 'startedAt'].includes(key))
      && Number.isSafeInteger(row.endedByNewStart.transactionId) && row.endedByNewStart.transactionId > row.id
      && row.endedByNewStart.transactionId < value.nextId
      && Number.isSafeInteger(row.endedByNewStart.startedAt)
      && row.endedByNewStart.startedAt > Math.max(row.lastEvidenceAt, row.modeDisableIntent.requestedAt)
      && value.transactions.some(next => next.id === row.endedByNewStart.transactionId && next.status === 'Accepted'
        && next.startedAt === row.endedByNewStart.startedAt))
    && (row.endedByStatus === undefined || row.status === 'Accepted' && row.endedByStatus
      && row.endedByNewStart === undefined
      && Object.keys(row.endedByStatus).length === 3
      && Object.keys(row.endedByStatus).every(key => ['status', 'at', 'receivedAt'].includes(key))
      && NO_TRANSACTION_STATUSES.has(row.endedByStatus.status)
      && Number.isSafeInteger(row.endedByStatus.at) && row.endedByStatus.at > row.lastEvidenceAt
      && Number.isSafeInteger(row.endedByStatus.receivedAt) && row.endedByStatus.receivedAt >= 0
      && row.endedByStatus.at - row.endedByStatus.receivedAt <= MAX_FUTURE_MS
      && row.endedByStatus.receivedAt - row.endedByStatus.at <= MAX_AGE_MS)
    && (row.stopFingerprint === undefined && row.stoppedAt === undefined && row.meterStop === undefined
      || /^[a-f0-9]{64}$/.test(row.stopFingerprint) && Number.isSafeInteger(row.stoppedAt) && row.stoppedAt >= row.startedAt
        && (!row.endedByStatus || row.stoppedAt <= row.endedByStatus.at)
        && Number.isSafeInteger(row.meterStop) && row.meterStop >= 0))
  && value.transactions.filter(row => row.status === 'Accepted' && row.stoppedAt === undefined && !row.endedByStatus && !row.endedByNewStart).every(row => row.id === value.activeId)
  && (value.activeId === null || value.transactions.some(row => row.id === value.activeId && row.status === 'Accepted'
    && row.stoppedAt === undefined && !row.endedByStatus && !row.endedByNewStart))
  && (value.recovered === undefined || validRecovered(value));
const validRecovered = value => {
  const recovered = value.recovered;
  return recovered && Object.keys(recovered).length === 2
    && Object.keys(recovered).every(key => ['activeId', 'transactions'].includes(key))
    && (recovered.activeId === null || Number.isSafeInteger(recovered.activeId))
    && !(recovered.activeId !== null && value.activeId !== null)
    && Array.isArray(recovered.transactions) && recovered.transactions.length <= 128
    && new Set(recovered.transactions.map(row => row?.id)).size === recovered.transactions.length
    && recovered.transactions.every(row => row && Object.keys(row).every(key => ['id', 'observedAt', 'confirmedAt', 'lastEvidenceAt',
      'endedByStatus', 'endedByNewStart', 'stoppedAt', 'stopReason', 'stopReceivedAt', 'meterStop', 'stopFingerprint', 'modeDisableIntent'].includes(key))
      && Number.isSafeInteger(row.id) && row.id > 0 && row.id < 2147483647
      && !value.transactions.some(known => known.id === row.id)
      && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0
      && Number.isSafeInteger(row.confirmedAt) && row.confirmedAt - row.observedAt >= 1000
      && Number.isSafeInteger(row.lastEvidenceAt) && row.lastEvidenceAt >= row.confirmedAt
      && (row.stopReason === undefined && row.stopReceivedAt === undefined || EXTERNAL_STOP_REASONS.has(row.stopReason)
        && Number.isSafeInteger(row.stopReceivedAt) && row.stopReceivedAt >= 0 && row.stoppedAt - row.stopReceivedAt <= MAX_FUTURE_MS)
      && (row.endedByStatus === undefined || row.endedByStatus
        && row.endedByNewStart === undefined
        && Object.keys(row.endedByStatus).length === 3
        && Object.keys(row.endedByStatus).every(key => ['status', 'at', 'receivedAt'].includes(key))
        && NO_TRANSACTION_STATUSES.has(row.endedByStatus.status)
        && Number.isSafeInteger(row.endedByStatus.at) && row.endedByStatus.at > row.lastEvidenceAt
        && Number.isSafeInteger(row.endedByStatus.receivedAt) && row.endedByStatus.receivedAt >= 0
        && row.endedByStatus.at - row.endedByStatus.receivedAt <= MAX_FUTURE_MS
        && row.endedByStatus.receivedAt - row.endedByStatus.at <= MAX_AGE_MS)
      && (row.endedByNewStart === undefined || row.endedByNewStart
        && Object.keys(row.endedByNewStart).length === 2
        && Object.keys(row.endedByNewStart).every(key => ['transactionId', 'startedAt'].includes(key))
        && Number.isSafeInteger(row.endedByNewStart.startedAt) && row.endedByNewStart.startedAt > row.lastEvidenceAt
        && row.endedByNewStart.startedAt > (row.modeDisableIntent?.requestedAt ?? 0)
        && row.endedByNewStart.startedAt <= value.latestStartAt
        && Number.isSafeInteger(row.endedByNewStart.transactionId) && row.endedByNewStart.transactionId > 0
        && row.endedByNewStart.transactionId < value.nextId
        && value.transactions.filter(next => next.id === row.endedByNewStart.transactionId)
          .every(next => next.status === 'Accepted' && next.startedAt === row.endedByNewStart.startedAt))
      && (row.modeDisableIntent === undefined || row.modeDisableIntent
        && Object.keys(row.modeDisableIntent).every(key => ['requestedAt', 'connectionId', 'attemptedAt'].includes(key))
        && Number.isSafeInteger(row.modeDisableIntent.requestedAt) && row.modeDisableIntent.requestedAt >= row.observedAt
        && (row.modeDisableIntent.connectionId === null || typeof row.modeDisableIntent.connectionId === 'string'
          && row.modeDisableIntent.connectionId.length > 0 && row.modeDisableIntent.connectionId.length <= 100)
        && (row.modeDisableIntent.attemptedAt === undefined || Number.isSafeInteger(row.modeDisableIntent.attemptedAt)
          && row.modeDisableIntent.attemptedAt >= row.modeDisableIntent.requestedAt))
      && (row.stopFingerprint === undefined && row.stoppedAt === undefined && row.meterStop === undefined
        || /^[a-f0-9]{64}$/.test(row.stopFingerprint) && Number.isSafeInteger(row.stoppedAt)
          && row.stoppedAt >= row.observedAt && Number.isSafeInteger(row.meterStop) && row.meterStop >= 0
          && (!row.endedByStatus || row.stoppedAt <= row.endedByStatus.at)))
    && recovered.transactions.filter(row => !row.endedByStatus && !row.endedByNewStart && row.stoppedAt === undefined)
      .every(row => row.id === recovered.activeId)
    && (recovered.activeId === null || recovered.transactions.some(row => row.id === recovered.activeId
      && !row.endedByStatus && !row.endedByNewStart && row.stoppedAt === undefined));
};

export function validateOcppTransactionState(value, scope = value?.scope) {
  if (value != null && !validOcppTransactionState(value, scope))
    throw new Error('Unsupported native transaction state. Preserve this database and use matching software or an intact current-format backup.');
}
