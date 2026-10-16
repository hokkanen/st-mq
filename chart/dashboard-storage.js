import { isReadOnlyReplica } from './replica-status.js';

const writerStates = new Set(['ready', 'saving', 'confirming', 'unavailable', 'stopped', 'unknown']);
const observationFields = ['webAccess', 'topology', 'role', 'instance', 'controlAuthority', 'pair',
  'readOnly', 'recordingHealth', 'runtimeTiming', 'storagePending', 'storageContextPending'];

export function dashboardWriterState(status) {
  const health = status?.recordingHealth;
  const state = health?.version === 3 && ['live', 'simulated'].includes(health.scope)
    ? health.recording?.writer?.state : null;
  return writerStates.has(state) ? state : 'unknown';
}

export function dashboardWriterRestriction(status) {
  if (status?.storageContextPending === true)
    return 'Storage changed. Waiting for a complete dashboard refresh before making changes.';
  const state = dashboardWriterState(status);
  return state === 'confirming' ? 'Changes are paused while the last save is confirmed. Readings and history remain available.'
    : ['unavailable', 'stopped'].includes(state)
      ? 'Changes are unavailable because recording storage is not ready. Check Storage health. Readings and history remain available.' : '';
}

/** Action replies omit the separately checked health. Keep its original clock. */
export function retainDashboardHealth(previous, next) {
  if (!next || next.recordingHealth?.version === 3 || previous?.recordingHealth?.version !== 3
    || previous.input !== next.input || isReadOnlyReplica(previous) !== isReadOnlyReplica(next)) return next;
  return { ...next, recordingHealth: previous.recordingHealth,
    ...(previous.storageContextPending === true ? { storageContextPending: true } : {}) };
}

/** Observe availability during an action without replacing displayed controls. */
export function observeDashboardStatus(displayed, observed) {
  if (!displayed) return null;
  observed = retainDashboardHealth(displayed, observed);
  const result = { ...displayed };
  for (const key of ['webAccess', 'topology', 'role', 'instance', 'controlAuthority', 'pair', 'recordingHealth', 'runtimeTiming']) {
    if (Object.hasOwn(observed, key)) result[key] = observed[key];
  }
  result.readOnly = observed.readOnly === true;
  result.storagePending = observed.storagePending === true;
  if (displayed.storageContextPending === true || displayed.input !== observed.input
    || displayed.recordingHealth?.contextId !== observed.recordingHealth?.contextId)
    result.storageContextPending = true;
  return result;
}

/** A delayed reply cannot undo independently observed authority or health.
 * Compare immutable snapshots so unrelated pairing polls never renew health. */
export function retainNewerDashboardObservations(result, atRequest, latest) {
  if (!latest || latest === atRequest || !Number.isFinite(result?.now) || typeof result?.input !== 'string') return result;
  if (atRequest && (latest.input !== atRequest.input
    || latest.recordingHealth?.contextId !== atRequest.recordingHealth?.contextId)) return latest;
  const retained = { ...result };
  for (const key of observationFields) if (latest[key] !== atRequest?.[key]) {
    if (Object.hasOwn(latest, key)) retained[key] = latest[key];
    else delete retained[key];
  }
  return retained;
}

/** A health response cannot establish a role, dataset or authenticated session. */
export function observeDashboardHealth(displayed, health) {
  if (!displayed || health?.version !== 3) return displayed;
  const expected = isReadOnlyReplica(displayed) ? 'snapshot' : displayed.input === 'offline' ? 'history'
    : displayed.input === 'simulated' ? 'simulated' : 'live';
  if (health.scope !== expected || displayed.recordingHealth?.contextId !== health.contextId)
    return { ...displayed, storageContextPending: true };
  if (displayed.storageContextPending === true) return displayed;
  return { ...displayed, recordingHealth: health };
}

export function dashboardConnectionView(status) {
  const replica = isReadOnlyReplica(status);
  const history = replica || status?.input === 'offline';
  const simulation = status?.input === 'simulated';
  const scope = history ? 'History viewer' : simulation ? 'Simulation' : 'Live';
  const ordinary = simulation ? 'Simulated devices and example prices. This workspace sends no commands to your home.'
    : status?.input === 'offline' ? 'Imported household history. No live device connection is open.'
      : 'Live observations. Each feature shows its automation permission and current activity.';
  if (history) return { scope, context: replica
    ? 'Recorded snapshot view. Readings keep their original timestamps; current equipment readiness is unavailable here.' : ordinary, pending: false };
  const writer = dashboardWriterState(status);
  const pending = status?.storagePending === true;
  const detail = writer === 'confirming' ? 'Confirming the last save. Showing the last saved dashboard state.'
    : ['unavailable', 'stopped'].includes(writer) ? 'Displayed readings keep their original timestamps.'
      : pending ? 'Saving updates. Showing the last saved dashboard state.' : '';
  return { scope, context: detail ? `${simulation ? 'Simulated devices and example prices. ' : ''}${detail}` : ordinary,
    pending, detail };
}
