import { createServer } from 'node:http';
import { timingSafeEqual, randomInt, randomUUID, createHash, createHmac } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { chargingDeviceInfo } from '../charging/device-info.js';
import { MAX_SOURCE_AHEAD_MS } from '../domain/time-evidence.js';
import { createOcppStartupDiagnostics } from './ocpp-startup-diagnostics.js';
import { createControlAttempt } from '../storage/control-attempt.js';
import { validOcppTransactionState, OCPP_RECOVERY_ATTEMPT_LIMIT, OCPP_TRANSACTION_MAX_AGE_MS,
  OCPP_NO_TRANSACTION_STATUSES, OCPP_EXTERNAL_STOP_REASONS } from '../domain/ocpp-transaction-state.js';

const MAX_AGE_MS = OCPP_TRANSACTION_MAX_AGE_MS;
const MAX_FUTURE_MS = MAX_SOURCE_AHEAD_MS;
const CALL_TIMEOUT_MS = 15_000;
const SNAPSHOT_ADMISSION_MS = 1000;
const METER_REFRESH_MS = 30_000;
// Give a normal 30-second report time to arrive before requesting another
// instantaneous sample. Requests on the periodic boundary can share its
// whole-second timestamp while measuring slightly different values.
const METER_REFRESH_AGE_MS = 45_000;
const FIRST_MESSAGE_TIMEOUT_MS = 30_000;
const NO_TRANSACTION_STATUSES = OCPP_NO_TRANSACTION_STATUSES;
const RECOVERABLE_STATUSES = new Set(['Charging', 'SuspendedEVSE', 'SuspendedEV']);
const EXTERNAL_STOP_REASONS = OCPP_EXTERNAL_STOP_REASONS;
const METER_CONTEXTS = new Set(['Interruption.Begin', 'Interruption.End', 'Sample.Clock', 'Sample.Periodic',
  'Transaction.Begin', 'Transaction.End', 'Trigger', 'Other']);
const AUTHORIZATION_KEYS = Object.freeze(['AuthorizationCacheEnabled', 'AuthorizeRemoteTxRequests',
  'LocalPreAuthorize', 'LocalAuthorizeOffline', 'ExternalAuthorizationRequired', 'FreeCharging']);
const REQUEST_ACTIONS = new Set(['SetChargingProfile', 'ClearChargingProfile', 'GetCompositeSchedule', 'GetConfiguration', 'ChangeAvailability', 'TriggerMessage']);
const READ_ONLY_REQUEST_ACTIONS = new Set(['GetCompositeSchedule', 'GetConfiguration', 'TriggerMessage']);
const requestError = code => Object.assign(new Error(code), { code });
const unreachableAddresses = new BlockList();
for (const [address, prefix, type] of [['0.0.0.0', 8, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['255.255.255.255', 32, 'ipv4'], ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'], ['ff00::', 8, 'ipv6']]) unreachableAddresses.addSubnet(address, prefix, type);
const unreachableHost = hostname => {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase(), family = isIP(host);
  return host === 'localhost' || host.endsWith('.localhost')
    || Boolean(family && unreachableAddresses.check(host, family === 6 ? 'ipv6' : 'ipv4'));
};
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function localOcppConfiguration(input = {}) {
  const defaults = { enabled: true, host: '0.0.0.0', port: 9001, password: '', charge_point_id: '', authorization_tags: [], authorization_mode: 'rfid',
    server_url: '', ca_certificate: '', ca_certificate_domain: '' };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new TypeError('Invalid easee.local_ocpp fields');
  const config = { ...defaults, ...input };
  if (typeof config.enabled !== 'boolean' || typeof config.host !== 'string' || !config.host.trim()
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || typeof config.password !== 'string' || config.password && config.password.length < 16 || config.password.length > 20
    || typeof config.charge_point_id !== 'string' || config.charge_point_id.length > 128
    || /[/:\s]/.test(config.charge_point_id) || !Array.isArray(config.authorization_tags)
    || config.authorization_tags.length > 100 || config.authorization_tags.some(tag => typeof tag !== 'string' || !tag.length || tag.length > 20)
    || !['rfid', 'plug-and-charge'].includes(config.authorization_mode)
    || typeof config.server_url !== 'string' || config.server_url.length > 2048
    || typeof config.ca_certificate !== 'string' || config.ca_certificate.length > 16384
    || typeof config.ca_certificate_domain !== 'string' || config.ca_certificate_domain.length > 253)
    throw new TypeError('Invalid easee.local_ocpp configuration; use a password of 16 to 20 characters and explicit authorization tags');
  if (config.server_url) {
    let url;
    try { url = new URL(config.server_url); } catch { throw new TypeError('Invalid easee.local_ocpp.server_url'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
      || url.pathname !== '/ocpp' || config.server_url !== url.href || unreachableHost(url.hostname))
      throw new TypeError('easee.local_ocpp.server_url must be a ws:// or wss:// base URL ending in /ocpp, without credentials or a charger identifier');
    if (url.protocol === 'wss:' && (!config.ca_certificate.includes('-----BEGIN CERTIFICATE-----') || config.ca_certificate_domain !== url.hostname))
      throw new TypeError('easee.local_ocpp wss requires a PEM ca_certificate and ca_certificate_domain matching the server hostname');
    if (url.protocol === 'ws:' && (config.ca_certificate || config.ca_certificate_domain))
      throw new TypeError('easee.local_ocpp certificate settings require a wss server_url');
  }
  if (!config.server_url && (config.ca_certificate || config.ca_certificate_domain))
    throw new TypeError('easee.local_ocpp certificate settings require a wss server_url');
  return config;
}

/** Parse only measured charger electricity. OCPP connector 0 is not an Equalizer.
 * Phase-neutral voltages have explicit phases; aggregate power never invents
 * phase shares or three-phase measurements from a single-phase reading. */
export function ocppMeterReadings(payload, now) {
  if (payload?.connectorId !== 1 || !Array.isArray(payload.meterValue) || payload.meterValue.length > 100) return [];
  const result = [];
  for (const meter of payload.meterValue) {
    const at = instant(meter?.timestamp);
    if (!Number.isFinite(at) || at < 0 || at > now || !Array.isArray(meter.sampledValue) || meter.sampledValue.length > 100) continue;
    for (const sample of meter.sampledValue) {
      // Easee native firmware reports its connector's measured electricity at
      // Inlet. Connector 1 is still the charger, never the property's meter.
      if (!sample || sample.format && sample.format !== 'Raw' || sample.location && !['Outlet', 'Inlet'].includes(sample.location)) continue;
      const context = sample.context === undefined ? 'Sample.Periodic' : sample.context;
      if (!METER_CONTEXTS.has(context)) continue;
      if (typeof sample.value !== 'string' || !/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(sample.value)) continue;
      const value = Number(sample.value);
      if (!Number.isFinite(value) || value < 0) continue;
      let id, unit, normalized = value;
      if (sample.measurand === 'Power.Active.Import' && !sample.phase && ['W', 'kW'].includes(sample.unit ?? 'W')) {
        id = 120; unit = 'kW'; normalized = sample.unit === 'kW' ? value : value / 1000;
        if (normalized > 1000) continue;
      } else if (sample.measurand === 'Current.Import' && /^L[123]$/.test(sample.phase) && (sample.unit ?? 'A') === 'A') {
        id = 182 + Number(sample.phase[1]); unit = 'A'; if (value > 1000) continue;
      } else if (sample.measurand === 'Voltage' && /^L[123]-N$/.test(sample.phase) && (sample.unit ?? 'V') === 'V') {
        id = 193 + Number(sample.phase[1]); unit = 'V'; if (value > 500) continue;
      }
      if (id) result.push({ id, value: normalized, unit, timestamp: new Date(at).toISOString(), context });
    }
  }
  return result;
}

/** Bounded OCPP 1.6J central-system endpoint. Plug-and-charge explicitly permits
 * remote authorization with a known private tag. This endpoint does not infer
 * charging-profile support or silently convert an existing cloud schedule. */
export function createEaseeOcpp({ config: input, chargerId, clock = Date.now, canControl = () => false,
  canStart = () => false, startRecoveryScope = () => null, onDisconnect = () => {}, state, virtualTag = '',
  controlAttempt = () => createControlAttempt(), monotonicClock = () => performance.now() } = {}) {
  const config = localOcppConfiguration(input);
  if (typeof virtualTag !== 'string' || virtualTag.length > 20) throw new TypeError('Invalid private OCPP virtual tag');
  const plugAndCharge = config.authorization_mode === 'plug-and-charge';
  const authorizationReady = !plugAndCharge || Boolean(virtualTag);
  const configured = Boolean(config.enabled && config.password && chargerId);
  const identity = config.charge_point_id || chargerId;
  let server, sockets, socket, timer, startPromise, booted = false, lastMessageAt = null, connectedAt = null, error = null, closed = false;
  const transportSockets = new Set();
  let ownsConnection = false, telemetryConfigured = false, meterTriggerUnsupported = false;
  let meterRequestedAt = null;
  let connectorStatus = null, connectorStatusAt = null, connectorReceivedAt = null, connectorStatusExplicit = false;
  let remoteStartStatus = 'idle';
  let dispatchedStart = null;
  // Process-local, current-connection evidence only. No tags, transaction IDs
  // or message bodies; observation never refreshes these original clocks.
  let startProgress = { remote: null, authorization: null, transaction: null, stop: null };
  let startReadiness = null;
  let authorizationConfiguration = null;
  function authorizationReadback(key, patch) {
    const reads = { ...authorizationConfiguration?.reads, [key]: {
      ...authorizationConfiguration?.reads?.[key], ...patch } };
    const rows = Object.values(reads);
    const values = Object.fromEntries(AUTHORIZATION_KEYS.map(name => [name, {
      value: reads[name]?.value ?? null, readOnly: reads[name]?.readOnly ?? null }]));
    const available = Object.values(values).filter(row => row.value !== null).length;
    const pending = AUTHORIZATION_KEYS.some(name => !reads[name] || reads[name].status === 'pending');
    const requested = rows.map(row => row.requestedAt).filter(Number.isSafeInteger);
    const responded = rows.map(row => row.respondedAt).filter(Number.isSafeInteger);
    const failed = rows.map(row => row.failedAt).filter(Number.isSafeInteger);
    authorizationConfiguration = {
      requestedAt: requested.length ? Math.min(...requested) : null,
      respondedAt: responded.length ? Math.max(...responded) : null,
      status: pending ? 'pending' : available === AUTHORIZATION_KEYS.length ? 'reported'
        : available ? 'partial' : rows.some(row => row.status === 'timed-out') ? 'timed-out'
          : rows.some(row => row.status === 'cancelled') ? 'cancelled' : 'unavailable',
      ...(failed.length ? { failedAt: Math.max(...failed) } : {}), values, reads };
  }
  const authorizationProgress = (info, receivedAt, replayed = false) => {
    startProgress.authorization = { receivedAt, decidedAt: clock(), status: info.status, replayed };
  };
  const transactionProgress = (payload, info, receivedAt, replayed = false) => {
    startProgress.transaction = { receivedAt, sourceAt: instant(payload.timestamp), status: info.status, replayed };
  };
  let device = null;
  let observedTransaction = null, connectionId = null, authenticatedConnectionId = null, transactionEvidence = null;
  let recoveryCandidate = null, recoveryConflict = false, evidenceBoundaryAt = null;
  let currentSupplyBoundaryAt = null;
  let phaseWeightBoundaryAt = null;
  const instanceId = randomUUID(); let connectionSequence = 0;
  let receivedFrameSequence = 0;
  let statusTransition = 0;
  const values = new Map(), replies = new Map(), pendingCalls = new Map();
  const previousPhaseValues = new Map();
  const deferredTransactions = new Map();
  const futureReadings = [];
  const callQueue = [];
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = digest({ chargerId, identity });
  let ledger = null, stateReady = false;
  let admitted = false;
  const cancellation = new AbortController(), maintenance = new Map();
  const diagnostics = createOcppStartupDiagnostics();
  let diagnosticFrame = null;
  function storageFailed(connection) {
    if (connection !== socket) return;
    stateReady = false; error = 'transaction-state-unavailable';
    socket?.terminate(); reset();
  }
  function runState(operation, { connection, bytes = 0, signal = cancellation.signal } = {}) {
    const current = () => !closed && !signal.aborted && canControl() && (connection === undefined || socket === connection);
    const execute = () => {
      if (!current()) throw requestError('ocpp-request-revoked');
      const prior = admitted;
      const admittedConnection = connection ?? socket;
      admitted = true;
      state?.afterRollback?.(cause => {
        for (const call of [...pendingCalls.values(), ...callQueue]) call.attempt?.fail(cause);
        storageFailed(admittedConnection);
      });
      try { return operation(); } finally { admitted = prior; }
    };
    try { return state?.runWrite ? state.runWrite(execute, { signal, isCurrent: current, priority: 'control', bytes })
      : Promise.resolve(execute()); }
    catch (error) { return Promise.reject(error); }
  }
  function scheduleState(name, operation) {
    if (maintenance.has(name)) return maintenance.get(name);
    const connection = socket;
    const waitingCall = name === 'send' && !pendingCalls.size ? callQueue[0] : null;
    waitingCall?.attempt?.storageWaiting(true);
    const pending = runState(operation, { connection }).catch(error => {
      waitingCall?.attempt?.fail(error);
      if (!['STORAGE_WRITE_STALE', 'STORAGE_WRITE_CANCELLED', 'ocpp-request-revoked'].includes(error?.code)) storageFailed(connection);
    }).finally(() => { waitingCall?.attempt?.storageWaiting(false); maintenance.delete(name); });
    maintenance.set(name, pending);
    return pending;
  }
  async function readAdmittedSnapshot(read, connection, generation, signal) {
    let deadline;
    for (;;) {
      signal?.throwIfAborted(); cancellation.signal.throwIfAborted();
      if (socket !== connection || connectionId !== generation || !refreshAuthority()) return null;
      const snapshot = read(), pending = maintenance.get('future-readings');
      if (!pending) return snapshot;
      // A queued admission is not a lost source. Join its existing durable
      // turn, then reread this connection with the original freshness clocks.
      // One monotonic budget bounds repeated arrivals and a stalled writer.
      deadline ??= performance.now() + SNAPSHOT_ADMISSION_MS;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      const ready = await new Promise(resolve => {
        const stop = AbortSignal.any([cancellation.signal, ...(signal ? [signal] : [])]);
        const finish = value => { clearTimeout(timer); stop.removeEventListener('abort', aborted); resolve(value); };
        const aborted = () => finish(false);
        const timer = setTimeout(() => finish(false), remaining); timer.unref?.();
        stop.addEventListener('abort', aborted, { once: true });
        pending.then(() => finish(true));
        if (stop.aborted) aborted();
      });
      if (!ready) {
        signal?.throwIfAborted(); cancellation.signal.throwIfAborted();
        return null;
      }
    }
  }
  const configurationFailures = new Set();
  const persist = (next, attempt) => {
    if (!stateReady || !state?.set) throw new Error('OCPP state unavailable');
    try { state.set(structuredClone(next)); ledger = next; }
    catch (cause) {
      attempt?.fail(cause);
      for (const call of [...pendingCalls.values(), ...callQueue]) call.attempt?.fail(cause);
      stateReady = false; error = 'transaction-state-unavailable'; rejectRequests('ocpp-unavailable'); throw new Error('OCPP state unavailable');
    }
  };
  let callId = 0;
  const currentTime = () => new Date(clock()).toISOString();
  function finishRequest(call, code, result) {
    if (!call || call.settled) return;
    if (code === 'ocpp-request-timeout' && call.connection === socket && canControl() && permittedBy(call.guard ?? (() => true)))
      call.attempt?.expire();
    call.attempt?.finish();
    if (!call.resolve) return;
    call.settled = true; clearTimeout(call.timeout); clearTimeout(call.replyTimer); call.signal?.removeEventListener('abort', call.abort);
    // A received reply no longer occupies the wire after abort/timeout, even
    // when its authority check was waiting for an admitted status clock.
    if (call.replyId && pendingCalls.get(call.replyId) === call) pendingCalls.delete(call.replyId);
    if (code) call.reject(requestError(code)); else call.resolve(result);
  }
  function rejectRequests(code) {
    for (const call of [...pendingCalls.values(), ...callQueue]) finishRequest(call, code);
    pendingCalls.clear(); callQueue.length = 0;
  }
  const permittedBy = guard => { try { return guard() === true; } catch { return false; } };
  const transportFresh = () => !closed && canControl() && stateReady && socket?.readyState === 1
    && lastMessageAt !== null && clock() >= lastMessageAt && clock() - lastMessageAt <= MAX_AGE_MS;
  function transportActivity(now = clock()) {
    diagnostics.valid(diagnosticFrame, state);
    // A heartbeat can keep held current evidence healthy, but cannot revive
    // measurements from before an actual feed outage on the same socket.
    if (lastMessageAt !== null && (now < lastMessageAt || now - lastMessageAt > MAX_AGE_MS))
      currentSupplyBoundaryAt = now;
    lastMessageAt = now;
  }
  function reset() {
    for (const pending of deferredTransactions.values()) clearTimeout(pending.timer);
    deferredTransactions.clear();
    rejectRequests('ocpp-disconnected');
    booted = false; values.clear(); previousPhaseValues.clear(); futureReadings.length = 0; replies.clear();
    configurationFailures.clear(); lastMessageAt = null; connectedAt = null; telemetryConfigured = false; meterTriggerUnsupported = false;
    meterRequestedAt = null;
    connectorStatus = null; connectorStatusAt = null; connectorReceivedAt = null; connectorStatusExplicit = false;
    observedTransaction = null; connectionId = null; authenticatedConnectionId = null; transactionEvidence = null;
    recoveryCandidate = null; recoveryConflict = false; evidenceBoundaryAt = null;
    currentSupplyBoundaryAt = null; phaseWeightBoundaryAt = null;
    remoteStartStatus = 'idle'; statusTransition++;
    dispatchedStart = null;
    startProgress = { remote: null, authorization: null, transaction: null, stop: null };
    startReadiness = null;
    authorizationConfiguration = null;
    onDisconnect();
  }
  function send(value, beforeSend = () => true, onDispatch = () => {}) {
    const connection = socket;
    const effect = () => {
      if (!closed && canControl() && socket === connection && connection?.readyState === 1 && beforeSend()) {
        connection.send(JSON.stringify(value)); onDispatch();
      }
    };
    if (state?.afterCommit) state.afterCommit(effect); else effect();
  }
  const activeTransaction = () => ledger?.transactions.find(row => row.id === ledger.activeId)
    ?? ledger?.recovered?.transactions.find(row => row.id === ledger.recovered.activeId);
  const isRecovered = row => row?.observedAt !== undefined;
  const updateTransaction = (row, retired = false, base = ledger) => isRecovered(row)
    ? { ...base, recovered: { ...base.recovered, activeId: retired && base.recovered.activeId === row.id ? null : base.recovered.activeId,
      transactions: base.recovered.transactions.map(known => known.id === row.id ? row : known) } }
    : { ...base, activeId: retired && base.activeId === row.id ? null : base.activeId,
      transactions: base.transactions.map(known => known.id === row.id ? row : known) };
  const afterModeDisable = active => active?.modeDisableIntent && authenticatedConnectionId
    && active.modeDisableIntent.connectionId !== authenticatedConnectionId;
  function canRequestRemoteStart() {
    const active = activeTransaction();
    if (recoveryConflict) return false;
    if (!active) return !transactionEvidence || transactionEvidence.at < evidenceBoundaryAt
      || NO_TRANSACTION_STATUSES.has(connectorStatus) && connectorStatusAt > transactionEvidence.at;
    const intent = active.modeDisableIntent, now = clock();
    // A mode change creates uncertainty, not proof that charging stopped.
    // Permit one recovery attempt only on a later authenticated connection,
    // with fresh Preparing and no report that a transaction still runs there.
    return afterModeDisable(active) && intent.attemptedAt === undefined && connectorStatusExplicit
      && connectorStatusAt > intent.requestedAt && connectorStatusAt <= now && now - connectorStatusAt <= MAX_AGE_MS
      && (!transactionEvidence || transactionEvidence.at < intent.requestedAt)
      && !futureReadings.some(pending => Number.isSafeInteger(pending.transactionId) && pending.transactionId > 0
        && instant(pending.row.timestamp) >= intent.requestedAt);
  }
  function recoveryAttempts(context) {
    if (!ledger || !context || !Number.isSafeInteger(context.connectedAt) || context.connectedAt < 0
      || context.connectedAt > clock() || typeof context.key !== 'string' || !/^[a-f0-9]{64}$/.test(context.key)) return null;
    const history = ledger?.automaticStartRecoveries;
    if (!history || history.connectedAt < context.connectedAt) return [];
    return history.connectedAt === context.connectedAt ? history.attempts : null;
  }
  const startCode = context => createHmac('sha256', virtualTag)
    .update(JSON.stringify(['automatic-start', scope, context.connectedAt, context.key])).digest('hex').slice(0, 20);
  const currentStartContext = call => {
    const context = startRecoveryScope();
    return recoveryAttempts(context) && context.key === call.startKey && context.connectedAt === call.connectedAt;
  };
  function blockedStartRecovery(allowedAttempt = null) {
    const context = startRecoveryScope(), now = clock();
    const attempts = recoveryAttempts(context);
    if (!attempts || activeTransaction() || recoveryConflict || attempts.at(-1)?.at > now) return null;
    const consumed = attempts.some(row => row.key === context.key);
    if (consumed && context.key !== allowedAttempt) return null;
    if (!consumed && attempts.length >= OCPP_RECOVERY_ATTEMPT_LIMIT) {
      remoteStartStatus = 'recovery-capacity'; return null;
    }
    const row = ledger.transactions.at(-1), power = values.get(120), powerAt = instant(power?.timestamp);
    // Recover only our own refused automatic start, never an accepted session's
    // external Stop or an unexplained native suspension. Original source clocks
    // and the controller's physical connection fence all of this evidence.
    if (row?.status !== 'Blocked' || row.automatic !== true
      || row.startedAt < context.connectedAt || row.stopReason !== 'DeAuthorized'
      || !Number.isSafeInteger(row.stoppedAt) || !Number.isSafeInteger(row.stopReceivedAt)
      || connectorStatus !== 'SuspendedEVSE' || !connectorStatusExplicit
      || connectorStatusAt < row.stoppedAt || connectorReceivedAt < row.stopReceivedAt
      || connectorStatusAt > now || power?.value !== 0 || powerAt < row.stoppedAt
      || !Number.isFinite(powerAt) || powerAt > now || now - powerAt > MAX_AGE_MS) return null;
    return { row, key: context.key, connectedAt: context.connectedAt, attempts };
  }
  const remoteStartStateReady = call => call.recoveryKey
    ? blockedStartRecovery(call.recoveryCommitted ? call.recoveryKey : null)?.key === call.recoveryKey
    : connectorStatus === 'Preparing';
  const homeRecoveryCurrent = (call, permission = true) => {
    const recovery = call.homeRecovery, now = clock(), active = activeTransaction();
    const confirmed = (recovery?.step === 'mode-verify' || recovery?.step === 'mode-enable' && Number.isSafeInteger(call.sentAt))
      && active?.status === 'Accepted'
      && active.startReceivedAt >= recovery.startedAt && active.startedAt >= call.connectedAt
      && active.tagHash === digest({ scope, idTag: virtualTag });
    return Boolean(recovery && Number.isSafeInteger(recovery.transactionId)
      && call.connection === socket && transportFresh() && currentStartContext(call)
      && recoveryAttempts(startRecoveryScope())?.some(row => row.key === call.startKey)
      && now >= recovery.startedAt && now - recovery.startedAt < CALL_TIMEOUT_MS
      && (!permission || permittedBy(canStart))
      && (confirmed || blockedStartRecovery(call.startKey)?.row.id === recovery.transactionId));
  };
  const noteHomeRecovery = (call, status, reason = null) => {
    startProgress.recovery = { requestedAt: call.homeRecovery.startedAt, checkedAt: clock(), status, reason };
  };
  function queueHomeRecovery(source, step) {
    const recovery = source.homeRecovery ?? { startedAt: clock(), transactionId: blockedStartRecovery(source.startKey)?.row.id };
    const writing = ['tag-write', 'mode-enable'].includes(step);
    const key = step.startsWith('tag-') ? 'FreeChargingIdTag' : 'FreeCharging';
    const call = { connection: source.connection, startKey: source.startKey, connectedAt: source.connectedAt,
      homeRecovery: { ...recovery, step }, action: writing ? 'ChangeConfiguration' : 'GetConfiguration',
      payload: writing ? { key, value: key === 'FreeCharging' ? 'True' : virtualTag } : { key: [key] },
      attempt: writing ? controlAttempt() : createControlAttempt({ kind: 'query' }) };
    if (!homeRecoveryCurrent(call, false)) { noteHomeRecovery(call, 'cancelled', 'start-context-changed'); return; }
    noteHomeRecovery(call, step); callQueue.unshift(call);
  }
  function homeRecoveryResponse(call, frame, receivedAt) {
    if (!homeRecoveryCurrent(call, false)) { noteHomeRecovery(call, 'cancelled', 'start-context-changed'); return; }
    if (!permittedBy(canStart)) {
      // Retain a received query's original clock while its input admission is
      // pending. Reusing this reply never replays a native request or mutation.
      call.homeRecoveryReply = { frame, receivedAt }; callQueue.push(call); return;
    }
    const step = call.homeRecovery.step, reply = frame[0] === 3 ? frame[2] : null;
    // Initialization is a separate explicit admin choice for this request.
    // An unreadable native value is not evidence that we own its old value.
    if (step === 'tag-read' && frame[0] === 4 && frame[2] === 'ProtocolError') {
      if (config.authorization_tags.length === 0 && startRecoveryScope()?.initializeNativeTag === true)
        queueHomeRecovery(call, 'tag-write');
      else noteHomeRecovery(call, 'unavailable', 'native-tag-initialization-required');
      return;
    }
    if (!reply) { noteHomeRecovery(call, 'unavailable', 'native-request-failed'); return; }
    if (call.action === 'ChangeConfiguration') {
      if (reply.status !== 'Accepted') { noteHomeRecovery(call, 'unavailable', 'native-setting-rejected'); return; }
      queueHomeRecovery(call, step === 'tag-write' ? 'tag-verify' : 'mode-verify'); return;
    }
    const key = call.payload.key[0];
    const rows = Array.isArray(reply.configurationKey) ? reply.configurationKey.filter(row => row?.key === key) : [];
    const row = rows.length === 1 && (reply.unknownKey === undefined || Array.isArray(reply.unknownKey))
      && !reply.unknownKey?.includes(key) ? rows[0] : null;
    if (key === 'FreeCharging') {
      const value = typeof row?.value === 'string' && /^(true|false)$/i.test(row.value) ? row.value.toLowerCase() === 'true' : null;
      authorizationReadback(key, { requestedAt: call.sentAt, respondedAt: receivedAt,
        status: value === null ? 'unavailable' : 'reported', value, readOnly: typeof row?.readonly === 'boolean' ? row.readonly : null });
      if (step === 'mode-verify') { noteHomeRecovery(call, value === true ? 'confirmed' : 'unavailable', value === true ? null : 'native-readback-unconfirmed'); return; }
      if (value === true) { noteHomeRecovery(call, 'not-required'); return; }
      if (value !== false || row.readonly !== false) { noteHomeRecovery(call, 'unavailable', 'native-mode-unavailable'); return; }
      queueHomeRecovery(call, 'tag-read'); return;
    }
    // The private native tag is inspected only in memory. An unrelated tag is
    // an independent native instruction, never permission to overwrite it.
    const refusal = ledger.transactions.find(value => value.id === call.homeRecovery.transactionId);
    const ownedTag = typeof row?.value === 'string' && row.value.length > 0 && row.value.length <= 20
      && (automaticTag(row.value) || refusal?.automatic === true && refusal.tagHash === digest({ scope, idTag: row.value }));
    const emptyTag = row?.value === '' && row.readonly === false;
    if (!ownedTag && !emptyTag) {
      noteHomeRecovery(call, 'unavailable', 'native-tag-not-owned'); return;
    }
    const matches = typeof row?.value === 'string' && equal(row.value, virtualTag);
    if (step === 'tag-verify' && !matches) { noteHomeRecovery(call, 'unavailable', 'native-readback-unconfirmed'); return; }
    if (!matches && (config.authorization_tags.length !== 0 || startRecoveryScope()?.initializeNativeTag !== true)) {
      noteHomeRecovery(call, 'unavailable', 'native-tag-initialization-required'); return;
    }
    if (!matches && row.readonly !== false) { noteHomeRecovery(call, 'unavailable', 'native-tag-read-only'); return; }
    queueHomeRecovery(call, matches ? 'mode-enable' : 'tag-write');
  }
  function sendNextCall(skipHomeRecovery = false) {
    if (state?.runWrite && !admitted) { scheduleState('send', sendNextCall); return; }
    // Background reads have no physical effect. A missing acknowledgement
    // must never keep a control action or an explicitly scoped read waiting.
    const background = call => !call.homeRecovery && (call.meterRefresh || call.authorizationRead || call.diagnosticRead);
    if (callQueue.some(call => !background(call))) for (const [id, call] of pendingCalls) {
      if (background(call)) {
        pendingCalls.delete(id); finishRequest(call, 'ocpp-request-revoked');
        if (call.authorizationRead && authorizationConfiguration?.reads[call.authorizationRead]?.requestedAt === call.sentAt)
          authorizationReadback(call.authorizationRead, { status: 'cancelled', failedAt: clock() });
      }
    }
    if (pendingCalls.size || !callQueue.length || socket?.readyState !== 1 || !canControl()) return;
    const eligible = call => !skipHomeRecovery || !call.homeRecovery;
    const control = callQueue.findIndex(call => eligible(call) && !call.homeRecovery && !background(call));
    const foreground = control < 0 ? callQueue.findIndex(call => eligible(call) && !background(call)) : control;
    const index = foreground < 0 ? callQueue.findIndex(eligible) : foreground;
    if (index < 0) return;
    const call = callQueue.splice(index, 1)[0];
    const { action, payload, transition } = call, id = `stmq-${++callId}`;
    const dispatchReceiptSequence = receivedFrameSequence;
    if (call.homeRecovery) {
      if (!homeRecoveryCurrent(call, false)) { noteHomeRecovery(call, 'cancelled', 'start-context-changed'); finishRequest(call); sendNextCall(); return; }
      if (call.homeRecovery.step === 'tag-write' && (config.authorization_tags.length !== 0
        || startRecoveryScope()?.initializeNativeTag !== true)) {
        noteHomeRecovery(call, 'cancelled', 'native-tag-initialization-required'); finishRequest(call); sendNextCall(); return;
      }
      // Pending input can temporarily withhold the original lease. Wait within
      // its original operation budget; no new attempt or expiry is granted.
      if (!permittedBy(canStart)) {
        callQueue.push(call);
        sendNextCall(true);
        return;
      }
      if (call.homeRecoveryReply) {
        const { frame, receivedAt } = call.homeRecoveryReply; delete call.homeRecoveryReply;
        homeRecoveryResponse(call, frame, receivedAt); sendNextCall(); return;
      }
    }
    if (call.resolve && (call.settled || call.connection !== socket || !transportFresh()
      || !permittedBy(call.guard))) {
      finishRequest(call, 'ocpp-request-revoked'); sendNextCall(); return;
    }
    if (action === 'RemoteStartTransaction') {
      if (!stateReady || !authorizationReady || !permittedBy(canStart) || !currentStartContext(call) || !canRequestRemoteStart() || !remoteStartStateReady(call)
        || transition !== statusTransition || clock() < connectorStatusAt || !transportFresh()) {
        remoteStartStatus = 'cancelled'; sendNextCall(); return;
      }
      // A start permission must not outlive durable transaction storage.
      const active = activeTransaction();
      try {
        const recovery = call.recoveryKey ? blockedStartRecovery() : null;
        const context = startRecoveryScope(), attempts = recoveryAttempts(context);
        if (!attempts || attempts.some(row => row.key === context.key) || attempts.length >= OCPP_RECOVERY_ATTEMPT_LIMIT)
          throw requestError('ocpp-request-revoked');
        const next = active ? updateTransaction({ ...active, modeDisableIntent: { ...active.modeDisableIntent, attemptedAt: clock() } }) : ledger;
        persist({ ...next, automaticStartRecoveries: { connectedAt: context.connectedAt,
          attempts: [...attempts, { key: context.key, at: clock() }] } }, call.attempt);
        if (recovery) call.recoveryCommitted = true;
      }
      catch { remoteStartStatus = 'unavailable'; sendNextCall(); return; }
      remoteStartStatus = 'pending';
    }
    Object.assign(call, { key: payload.key });
    pendingCalls.set(id, call);
    send([2, id, action, payload], () => {
      // Worker durability can take longer than a native command's original
      // deadline. Revalidate at actual dispatch, after the intent committed.
      const revoked = pendingCalls.get(id) !== call
        || call.meterRefresh && (call.connection !== socket || !transportFresh() || meterTriggerUnsupported
          || !needsMeterReadback())
        || (call.resolve && !['TriggerMessage', 'GetConfiguration'].includes(action) || action === 'RemoteStartTransaction'
          || call.homeRecovery && action === 'ChangeConfiguration')
          && dispatchReceiptSequence !== receivedFrameSequence
        || call.resolve && (call.settled
        || call.connection !== socket || !transportFresh() || !permittedBy(call.guard)
        || !permittedBy(call.beforeSend))
        || action === 'RemoteStartTransaction' && (!stateReady || !authorizationReady || !permittedBy(canStart) || !currentStartContext(call)
          || !remoteStartStateReady(call) || transition !== statusTransition || !transportFresh())
        || call.homeRecovery && !homeRecoveryCurrent(call);
      if (revoked) {
        if (pendingCalls.get(id) === call) pendingCalls.delete(id);
        if (action === 'RemoteStartTransaction') { remoteStartStatus = 'cancelled'; }
        if (call.homeRecovery) noteHomeRecovery(call, 'cancelled', 'dispatch-revoked');
        finishRequest(call, 'ocpp-request-revoked'); sendNextCall(); return false;
      }
      call.sentAt = clock();
      if (action === 'TriggerMessage' && payload.requestedMessage === 'MeterValues') meterRequestedAt = monotonicClock();
      return true;
    }, () => {
      if (action === 'RemoteStartTransaction') {
        dispatchedStart = { key: call.startKey, connectedAt: call.connectedAt };
        startProgress.remote = { requestedAt: call.sentAt, respondedAt: null, status: 'pending' };
      }
      if (call.authorizationRead) authorizationReadback(call.authorizationRead,
        { requestedAt: call.sentAt, respondedAt: null, status: 'pending', value: null, readOnly: null });
      call.attempt?.dispatched();
    });
  }
  function requestRemoteStart() {
    reconcileTransactionStatus();
    const context = startRecoveryScope();
    const checked = (blocked, reason, recoveryEligible = null) => {
      if (blocked) startReadiness = { checkedAt: clock(), allowed: false, reason,
        contextAvailable: Boolean(context), recoveryEligible };
      return blocked;
    };
    const attempts = recoveryAttempts(context);
    if (checked(!attempts, 'start-context-unavailable')) return;
    if (checked(attempts.some(row => row.key === context.key), 'context-already-consumed')) return;
    if (attempts.length >= OCPP_RECOVERY_ATTEMPT_LIMIT) {
      remoteStartStatus = 'recovery-capacity'; checked(true, 'context-capacity'); return;
    }
    const recovery = connectorStatus === 'SuspendedEVSE' && blockedStartRecovery();
    const blocked = (condition, reason) => checked(condition, reason, Boolean(recovery));
    if (blocked(!plugAndCharge, 'rfid-mode') || blocked(!authorizationReady, 'authorization-unavailable')
      || blocked(!stateReady, 'transaction-storage-unavailable') || blocked(!permittedBy(canStart), 'start-permission-unavailable')
      || blocked([...pendingCalls.values(), ...callQueue].some(call => call.action === 'RemoteStartTransaction'), 'start-already-pending')
      || blocked(connectorStatus !== 'Preparing' && !recovery, 'connector-not-ready')
      || blocked(!canRequestRemoteStart(), 'transaction-evidence-unresolved')
      || blocked(clock() < connectorStatusAt, 'future-connector-status') || blocked(!transportFresh(), 'transport-unavailable')) return;
    startReadiness = { checkedAt: clock(), allowed: true, reason: 'queued',
      contextAvailable: Boolean(context), recoveryEligible: Boolean(recovery) };
    remoteStartStatus = 'queued';
    callQueue.unshift({ action: 'RemoteStartTransaction', payload: { connectorId: 1, idTag: startCode(context) }, transition: statusTransition,
      startKey: context.key, connectedAt: context.connectedAt,
      ...(recovery ? { recoveryKey: recovery.key } : {}),
      connection: socket, attempt: controlAttempt() });
    sendNextCall();
  }
  function configureTelemetry() {
    telemetryConfigured = true;
    authorizationConfiguration = null;
    meterTriggerUnsupported = false;
    configurationFailures.clear(); rejectRequests('ocpp-reconfigured');
    for (const [key, value] of [['MeterValuesSampledData', 'Power.Active.Import,Current.Import,Voltage'],
      ['MeterValuesAlignedData', 'Power.Active.Import,Current.Import,Voltage'], ['MeterValueSampleInterval', '30'],
      ['ClockAlignedDataInterval', '30']]) callQueue.push({ action: 'ChangeConfiguration', payload: { key, value }, attempt: controlAttempt() });
    callQueue.push({ action: 'TriggerMessage', payload: { requestedMessage: 'MeterValues', connectorId: 1 } });
    callQueue.push({ action: 'TriggerMessage', payload: { requestedMessage: 'StatusNotification', connectorId: 1 } });
    // Read only the native flags needed to distinguish cached authorization
    // from a refused or unexecuted start. Never change RFID/offline policy.
    // Native Easee advertises GetConfigurationMaxKeys=1. Keep each requested
    // flag and its source receipt independent, including partial failures.
    if (plugAndCharge) for (const key of AUTHORIZATION_KEYS) callQueue.push({
      action: 'GetConfiguration', payload: { key: [key] },
      authorizationRead: key, attempt: createControlAttempt({ kind: 'query' }) });
    sendNextCall();
  }
  function needsMeterReadback() {
    const now = clock();
    return [120, 183, 184, 185, 194, 195, 196].some(id => {
      const row = values.get(id), at = instant(row?.timestamp);
      // A fresh contradiction remains unknown, but the next periodic report
      // gets the same opportunity to resolve it as an unchanged measurement.
      return !Number.isFinite(at) || at > now || now - at >= METER_REFRESH_AGE_MS;
    });
  }
  function refreshMeterReadback() {
    // Some native chargers publish only clock-aligned intervals while idle.
    // Obtain actual instantaneous reports instead of relabelling those values
    // or waiting for the next charging transaction. Reuse the existing wire,
    // admission and timeout paths; ordinary status/snapshot reads stay pure.
    if (!telemetryConfigured || meterTriggerUnsupported || !transportFresh() || pendingCalls.size || callQueue.length
      || meterRequestedAt !== null && monotonicClock() - meterRequestedAt < METER_REFRESH_MS || !needsMeterReadback()) return;
    callQueue.push({ action: 'TriggerMessage', payload: { requestedMessage: 'MeterValues', connectorId: 1 },
      meterRefresh: true, connection: socket, attempt: createControlAttempt({ kind: 'query' }) });
    sendNextCall();
  }
  function recoverTransaction({ at, conflicting, identityOnly = false }, transactionId, receivedAt, messageId) {
    const validId = Number.isSafeInteger(transactionId) && transactionId > 0 && transactionId < 2147483647;
    const fresh = validId && Number.isSafeInteger(at) && at >= evidenceBoundaryAt && at - receivedAt <= MAX_FUTURE_MS
      && clock() >= at && clock() - at <= MAX_AGE_MS;
    if (!fresh) return true;
    if (recoveryCandidate && at - recoveryCandidate.lastAt > MAX_AGE_MS) recoveryCandidate = null;
    const active = activeTransaction();
    // Two different current transaction identifiers on one connection cannot
    // establish ownership. Keep telemetry, but revoke control until a new
    // authenticated connection or an explicit transaction boundary resolves it.
    if (at < Math.max(active?.lastEvidenceAt ?? 0, recoveryCandidate?.lastAt ?? 0)) return true;
    if (active && active.id !== transactionId || recoveryCandidate && recoveryCandidate.id !== transactionId) {
      recoveryConflict = true; observedTransaction = null; return true;
    }
    if (identityOnly) return true;
    // An accepted StartTransaction already supplies identity. Its matching
    // non-power reports can confirm continuity even when power is unknown.
    if (active && !isRecovered(active)) return true;
    // Instantaneous samples can disagree at the same source timestamp.
    // That measurement stays unknown, but does not change transaction identity.
    // Later advancing clean evidence may confirm the same transaction again.
    if (conflicting) {
      observedTransaction = { id: transactionId, at, conflicting: true }; recoveryCandidate = null; return true;
    }
    if (recoveryConflict || !messageId || !connectorStatusExplicit
      || !RECOVERABLE_STATUSES.has(connectorStatus) || connectorStatusAt < evidenceBoundaryAt
      || connectorStatusAt > at || !recoveryCandidate && receivedAt - connectorStatusAt > MAX_AGE_MS) return true;
    const known = ledger.transactions.some(row => row.id === transactionId)
      || ledger.recovered?.transactions.some(row => row.id === transactionId && row.id !== ledger.recovered.activeId);
    if (known || !active && [...ledger.transactions, ...(ledger.recovered?.transactions ?? [])]
      .some(row => Math.max(row.lastEvidenceAt, row.endedByStatus?.at ?? 0, row.stoppedAt ?? 0,
        row.endedByNewStart?.startedAt ?? 0) >= at)) return true;
    if (!recoveryCandidate) {
      recoveryCandidate = { id: transactionId, firstAt: at, lastAt: at, messageId }; return true;
    }
    if (messageId === recoveryCandidate.messageId || at <= recoveryCandidate.lastAt) return true;
    recoveryCandidate.lastAt = at;
    if (at - recoveryCandidate.firstAt < 1000) return true;
    if (!active) {
      const recovered = ledger.recovered ?? { activeId: null, transactions: [] };
      const transaction = { id: transactionId, observedAt: recoveryCandidate.firstAt, confirmedAt: at, lastEvidenceAt: at };
      try { persist({ ...ledger, recovered: { activeId: transactionId,
        transactions: [...recovered.transactions, transaction].slice(-128) } }); }
      catch { return false; }
    }
    observedTransaction = { id: transactionId, at };
    return true;
  }
  function applyReadings(readings, transactionId, receivedAt, messageId) {
    const evidenceAt = Math.max(...readings.map(row => instant(row.timestamp)));
    if (readings.length && Number.isSafeInteger(transactionId) && transactionId > 0 && transactionId < 2147483647) {
      if (!transactionEvidence || evidenceAt >= transactionEvidence.at) transactionEvidence = { id: transactionId, at: evidenceAt };
    }
    // Clock-aligned interval data is not an instantaneous measurement. Keep
    // its transaction-identity fence, without overwriting live readings or
    // furnishing positive transaction confirmation from the interval values.
    if (!recoverTransaction({ at: evidenceAt, identityOnly: true }, transactionId, receivedAt, messageId)) return false;
    readings = readings.filter(row => row.context !== 'Sample.Clock');
    const powerReadings = readings.filter(row => row.id === 120);
    const powerAt = Math.max(...powerReadings.map(row => instant(row.timestamp)));
    const currentPower = powerReadings.filter(row => instant(row.timestamp) === powerAt), priorPower = values.get(120);
    const conflictingPower = currentPower.length > 0 && (new Set(currentPower.map(row => row.value)).size !== 1
      || instant(priorPower?.timestamp) === powerAt && priorPower.value !== currentPower[0].value);
    if (!recoverTransaction({ at: powerAt, conflicting: conflictingPower }, transactionId, receivedAt, messageId)) return false;
    const active = activeTransaction();
    if (readings.length && active && transactionId === active.id) {
      const at = Math.max(...readings.map(row => instant(row.timestamp)));
      if (at > active.lastEvidenceAt) {
        try { persist(updateTransaction({ ...active, lastEvidenceAt: at })); }
        catch { return false; }
      }
      const identityReadings = conflictingPower ? readings.filter(row => row.id !== 120) : readings;
      const identityAt = Math.max(...identityReadings.map(row => instant(row.timestamp)));
      if (!isRecovered(active) && !recoveryConflict && identityAt >= active.startedAt
        && (!observedTransaction || identityAt >= observedTransaction.at))
        observedTransaction = { id: transactionId, at: identityAt };
    }
    for (const row of readings) {
      const before = values.get(row.id), at = instant(row.timestamp), priorAt = instant(before?.timestamp);
      if (!before || at > priorAt) {
        if ([183, 184, 185].includes(row.id) && before?.value !== null && Number.isFinite(priorAt)
          && priorAt >= Math.max(connectedAt ?? 0, phaseWeightBoundaryAt ?? 0))
          previousPhaseValues.set(row.id, { ...before });
        values.set(row.id, { ...row, receivedAt });
      }
      else if (at === priorAt && row.value !== before.value) values.set(row.id, { ...row, value: null, receivedAt });
    }
    return true;
  }
  function reconcileTransactionStatus() {
    const active = activeTransaction(), now = clock();
    if (!active || !transportFresh() || !connectorStatusExplicit || !NO_TRANSACTION_STATUSES.has(connectorStatus)
      || connectorStatusAt > now || now - connectorStatusAt > MAX_AGE_MS
      || connectorStatusAt <= active.lastEvidenceAt
      || futureReadings.some(pending => pending.transactionId === active.id && instant(pending.row.timestamp) >= connectorStatusAt)) return;
    if (state?.runWrite && !admitted) { scheduleState('transaction-status', reconcileTransactionStatus); return false; }
    // Available/Finishing explicitly report that no transaction is ongoing.
    // Easee native firmware can report Preparing just after StartTransaction,
    // so Preparing must never retire an accepted transaction despite its usual
    // OCPP meaning. Preserve end evidence separately: a missing StopTransaction
    // remains missing, including its energy counter. An old status cannot end a
    // newer session, even across restart or a native/cloud/native transition.
    const endedByStatus = { status: connectorStatus, at: connectorStatusAt, receivedAt: connectorReceivedAt };
    try { persist(updateTransaction({ ...active, endedByStatus }, true)); }
    catch { return; }
    observedTransaction = null;
    if (transactionEvidence?.id === active.id) transactionEvidence = null;
    recoveryCandidate = null; recoveryConflict = false;
  }
  function releaseFutureReadings() {
    if (state?.runWrite && !admitted && futureReadings.some(pending => instant(pending.row.timestamp) <= clock())) {
      scheduleState('future-readings', releaseFutureReadings); return false;
    }
    // Only this authenticated connection owns this bounded buffer. Original
    // source and receipt times survive the short clock-skew wait unchanged.
    for (let index = 0; index < futureReadings.length;) {
      const pending = futureReadings[index];
      if (instant(pending.row.timestamp) > clock()) { index++; continue; }
      futureReadings.splice(index, 1);
      applyReadings([pending.row], pending.transactionId, pending.receivedAt, pending.messageId);
    }
  }
  function prepareState() {
    if (!canControl() || closed) return false;
    if (state?.runWrite && !admitted) { scheduleState('prepare', prepareState); return false; }
    if (!state?.get || !state?.set) { error = 'transaction-state-unavailable'; stateReady = false; return false; }
    try {
      const saved = state.get();
      if (saved !== null && saved !== undefined && !validOcppTransactionState(saved, scope)) { error = 'incompatible-transaction-state'; stateReady = false; return false; }
      ledger = saved ?? { version: 6, automaticStartRecoveries: null, scope, nextId: randomInt(1, 1000000000), latestStartAt: 0, activeId: null, transactions: [] };
      stateReady = true; persist(ledger); error = null; return true;
    } catch { error = 'transaction-state-unavailable'; stateReady = false; return false; }
  }
  function refreshAuthority() {
    if (!configured || !canControl() || closed) {
      if (ownsConnection) { ownsConnection = false; stateReady = false; socket?.terminate(); reset(); }
      return false;
    }
    if (!ownsConnection) { ownsConnection = true; return prepareState(); }
    return stateReady;
  }
  const configuredTag = tag => typeof tag === 'string' && config.authorization_tags.some(value => equal(value, tag));
  const automaticTag = tag => typeof tag === 'string' && !configuredTag(tag)
    && plugAndCharge && authorizationReady && (equal(virtualTag, tag)
      || ledger?.automaticStartRecoveries?.attempts.some(row => equal(startCode({
        connectedAt: ledger.automaticStartRecoveries.connectedAt, key: row.key }), tag)));
  const currentAutomaticTag = tag => {
    if (equal(virtualTag, tag)) return true;
    const context = startRecoveryScope();
    return Boolean(recoveryAttempts(context) && equal(startCode(context), tag));
  };
  const authorizationInfo = tag => automaticTag(tag)
    // This tag represents a live controller permission, never a reusable RFID
    // enrollment. Expiry cannot guarantee removal of a cached entry.
    ? { status: transportFresh() && permittedBy(canStart) && currentAutomaticTag(tag) ? 'Accepted' : 'Blocked', expiryDate: currentTime() }
    : { status: configuredTag(tag) ? transportFresh() ? 'Accepted' : 'Blocked' : 'Invalid' };
  function completeResponse(id, pending, frame, waited = false, receivedAt = clock()) {
    if (pendingCalls.get(id) !== pending) return;
    pendingCalls.delete(id);
    if (pending.action === 'TriggerMessage' && pending.payload.requestedMessage === 'MeterValues'
      && (frame[0] === 3 && ['Rejected', 'NotImplemented'].includes(frame[2]?.status)
        || frame[0] === 4 && ['NotImplemented', 'NotSupported'].includes(frame[2]))) meterTriggerUnsupported = true;
    if (pending.resolve) {
      const expired = waited && (clock() < pending.queuedAt || clock() - pending.queuedAt >= CALL_TIMEOUT_MS);
      const revoked = !refreshAuthority() || pending.connection !== socket || !transportFresh()
        || waited && clock() < connectorStatusAt || !permittedBy(pending.guard);
      finishRequest(pending, expired ? 'ocpp-request-timeout' : revoked ? 'ocpp-request-revoked'
        : frame[0] === 4 ? 'ocpp-request-failed' : null, frame[2]);
    }
    if (pending.action === 'RemoteStartTransaction' && startProgress.remote?.requestedAt === pending.sentAt)
      startProgress.remote = { ...startProgress.remote, respondedAt: receivedAt,
        status: frame[0] === 3 && frame[2]?.status === 'Accepted' ? 'accepted' : 'rejected' };
    if (pending.action === 'RemoteStartTransaction' && dispatchedStart?.key === pending.startKey
      && dispatchedStart.connectedAt === pending.connectedAt)
      dispatchedStart.rejected = frame[0] === 3 && frame[2]?.status === 'Rejected';
    if (pending.action === 'RemoteStartTransaction' && pending.recoveryKey
      && frame[0] === 3 && frame[2]?.status === 'Accepted') queueHomeRecovery(pending, 'mode-read');
    if (pending.homeRecovery) homeRecoveryResponse(pending, frame, receivedAt);
    if (pending.authorizationRead && authorizationConfiguration?.reads[pending.authorizationRead]?.requestedAt === pending.sentAt) {
      const rows = frame[0] === 3 && Array.isArray(frame[2]?.configurationKey) ? frame[2].configurationKey : [];
      const key = pending.authorizationRead;
      const unsupported = Array.isArray(frame[2]?.unknownKey) && frame[2].unknownKey.includes(key);
      const matching = unsupported ? [] : rows.filter(row => row?.key === key);
      const row = matching.length === 1 ? matching[0] : null;
      const value = typeof row?.value === 'string' && /^(true|false)$/i.test(row.value)
        ? row.value.toLowerCase() === 'true' : null;
      authorizationReadback(key, { respondedAt: receivedAt, status: value === null ? 'unavailable' : 'reported',
        value, readOnly: typeof row?.readonly === 'boolean' ? row.readonly : null });
    }
    if (pending.action === 'ChangeConfiguration') {
      const status = frame[0] === 3 ? frame[2]?.status : null;
      if (status === 'Accepted') configurationFailures.delete(pending.key);
      else configurationFailures.add(pending.key);
    } else if (pending.action === 'RemoteStartTransaction' && pending.transition === statusTransition) {
      remoteStartStatus = frame[0] === 3 && frame[2]?.status === 'Accepted' ? 'accepted' : 'rejected';
    }
    sendNextCall();
  }
  function receive(data, binary, deferred = null, arrival = clock()) {
    refreshAuthority();
    if (!canControl() || closed) { socket?.close(1008, 'Unavailable'); return; }
    if (binary) { socket.close(1008, 'Unavailable'); return; }
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (!Array.isArray(frame) || ![2, 3, 4].includes(frame[0])) { socket.close(1002, 'Invalid OCPP frame'); return; }
    if (frame[0] !== 2) {
      if (typeof frame[1] !== 'string' || !frame[1].length || frame[1].length > 36
        || (frame[0] === 3 ? frame.length !== 3 || !frame[2] || typeof frame[2] !== 'object' || Array.isArray(frame[2])
          : frame.length !== 5 || typeof frame[2] !== 'string' || typeof frame[3] !== 'string'
            || !frame[4] || typeof frame[4] !== 'object' || Array.isArray(frame[4]))) {
        socket.close(1002, 'Invalid OCPP response'); return;
      }
      const pending = pendingCalls.get(frame[1]);
      if (!pending || pending.replyId) return;
      transportActivity(arrival);
      const remaining = connectorStatusAt - clock();
      if (pending.resolve && !pending.settled && frame[0] === 3 && pending.connection === socket && transportFresh()
        && remaining > 0 && remaining <= MAX_FUTURE_MS) {
        // A command can produce its own status before its ACK. Keep that ACK
        // quarantined once, on the original pending request and deadline. No
        // command is replayed; every original fence is checked after the wait.
        pending.replyId = frame[1];
        pending.replyTimer = setTimeout(() => completeResponse(frame[1], pending, frame, true, arrival), remaining);
        pending.replyTimer.unref();
      } else {
        completeResponse(frame[1], pending, frame, false, arrival);
      }
      return;
    }
    const [, id, action, payload] = frame;
    if (frame.length !== 4 || typeof id !== 'string' || !id.length || id.length > 36 || typeof action !== 'string'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) { socket.close(1002, 'Invalid OCPP call'); return; }
    if (!deferred) transportActivity(arrival);
    const receivedAt = deferred?.receivedAt ?? arrival;
    const requestHash = digest({ action, payload });
    const waiting = deferredTransactions.get(id);
    if (waiting) {
      if (waiting.requestHash !== requestHash) send([4, id, 'ProtocolError', 'Conflicting message identifier', {}]);
      return;
    }
    if (replies.has(id)) {
      const prior = replies.get(id);
      if (prior.requestHash !== requestHash) { send([4, id, 'ProtocolError', 'Conflicting message identifier', {}]); return; }
      if (['Authorize', 'StartTransaction'].includes(action)) {
        try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      }
      // An Authorize retry asks about present permission. Transaction replies
      // are durable historical acknowledgements and must remain unchanged.
      if (action === 'Authorize') {
        const info = authorizationInfo(payload.idTag); authorizationProgress(info,arrival,true);
        send([3,id,{idTagInfo:info}]);
      } else {
        if (action === 'StartTransaction') transactionProgress(payload,prior.reply[2].idTagInfo,arrival,true);
        send(prior.reply);
      }
      return;
    }
    const sourceAt = ['StartTransaction', 'StopTransaction'].includes(action) ? instant(payload.timestamp) : NaN;
    const validFuture = Number.isSafeInteger(sourceAt) && sourceAt > clock() && sourceAt - receivedAt <= MAX_FUTURE_MS
      && (action === 'StartTransaction' ? payload.connectorId === 1 && Number.isSafeInteger(payload.meterStart) && payload.meterStart >= 0
        && typeof payload.idTag === 'string' && payload.idTag.length > 0 && payload.idTag.length <= 20
        : Number.isSafeInteger(payload.transactionId) && payload.transactionId > 0
          && Number.isSafeInteger(payload.meterStop) && payload.meterStop >= 0);
    if (!deferred && validFuture) {
      if (deferredTransactions.size >= 8) { send([4, id, 'OccurrenceConstraintViolation', 'Too many pending transaction messages', {}]); return; }
      const pending = { requestHash, receivedAt, connection: socket, connectionId };
      deferredTransactions.set(id, pending);
      pending.timer = setTimeout(() => {
        if (deferredTransactions.get(id) !== pending) return;
        deferredTransactions.delete(id);
        if (pending.connection !== socket || pending.connectionId !== connectionId || !refreshAuthority() || !transportFresh()) return;
        // One bounded wait only. Recheck payload, present authorization and
        // storage after the source time arrives, retaining the actual receipt.
        void runState(() => receive(data, false, pending), { connection: pending.connection, bytes: data.length })
          .catch(() => storageFailed(pending.connection));
      }, sourceAt - clock() + 1);
      pending.timer.unref();
      return;
    }
    let response;
    if (action === 'BootNotification') {
      if (typeof payload.chargePointVendor !== 'string' || typeof payload.chargePointModel !== 'string') {
        send([4, id, 'FormationViolation', 'Missing product fields', {}]); return;
      }
      values.clear(); previousPhaseValues.clear(); phaseWeightBoundaryAt = receivedAt;
      futureReadings.length = 0; rejectRequests('ocpp-reconfigured'); booted = true; onDisconnect();
      for (const pending of deferredTransactions.values()) clearTimeout(pending.timer);
      deferredTransactions.clear();
      connectionId = `${instanceId}:${++connectionSequence}`;
      device = chargingDeviceInfo({ model: payload.chargePointModel, firmware: payload.firmwareVersion,
        source: 'ocpp-boot', receivedAt: lastMessageAt });
      connectorStatus = null; connectorStatusAt = null; connectorReceivedAt = null; connectorStatusExplicit = false; observedTransaction = null;
      recoveryCandidate = null; recoveryConflict = false; evidenceBoundaryAt = receivedAt;
      currentSupplyBoundaryAt = receivedAt;
      remoteStartStatus = 'idle'; statusTransition++;
      response = { status: 'Accepted', currentTime: currentTime(), interval: 30 };
    } else if (action === 'Heartbeat') response = { currentTime: currentTime() };
    else if (action === 'MeterValues') {
      const readings = ocppMeterReadings(payload, receivedAt + MAX_FUTURE_MS);
      if (!applyReadings(readings.filter(row => instant(row.timestamp) <= receivedAt), payload.transactionId, receivedAt, id)) {
        send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return;
      }
      for (const row of readings.filter(row => instant(row.timestamp) > receivedAt)) {
        if (futureReadings.length === 32) futureReadings.shift();
        futureReadings.push({ row, transactionId: payload.transactionId, receivedAt, messageId: id });
      }
      response = {};
    } else if (action === 'Authorize') {
      if (typeof payload.idTag !== 'string' || !payload.idTag.length || payload.idTag.length > 20) {
        send([4, id, 'FormationViolation', 'Invalid authorization identifier', {}]); return;
      }
      try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      response = { idTagInfo: authorizationInfo(payload.idTag) };
      authorizationProgress(response.idTagInfo,receivedAt);
    }
    else if (action === 'StartTransaction') {
      const startedAt = instant(payload.timestamp);
      if (payload.connectorId !== 1 || !Number.isSafeInteger(payload.meterStart) || payload.meterStart < 0
        || !Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > clock()
        || typeof payload.idTag !== 'string' || !payload.idTag.length || payload.idTag.length > 20) {
        send([4, id, 'FormationViolation', 'Invalid transaction fields', {}]); return;
      }
      if (!stateReady) { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      const fingerprint = digest({ scope, connectorId: 1, startedAt, meterStart: payload.meterStart, idTag: payload.idTag });
      let transaction = ledger.transactions.find(row => row.fingerprint === fingerprint);
      const replayed = Boolean(transaction);
      if (!transaction) {
        const active = activeTransaction(), authorization = authorizationInfo(payload.idTag), accepted = authorization.status === 'Accepted';
        const supersedes = active && accepted && (isRecovered(active) || afterModeDisable(active))
          && startedAt > Math.max(active.lastEvidenceAt, active.modeDisableIntent?.requestedAt ?? 0)
          && !futureReadings.some(pending => pending.transactionId === active.id && instant(pending.row.timestamp) >= startedAt);
        if (active && !supersedes || startedAt <= ledger.latestStartAt || ledger.nextId >= 2147483646
          || [...ledger.transactions, ...(ledger.recovered?.transactions ?? [])]
            .some(row => row.endedByStatus && startedAt < row.endedByStatus.at)) {
          send([4, id, 'OccurrenceConstraintViolation', 'Transaction conflicts with recorded history', {}]); return;
        }
        let nextId = ledger.nextId;
        while (ledger.recovered?.transactions.some(row => row.id === nextId)) nextId++;
        if (nextId >= 2147483646) { send([4, id, 'OccurrenceConstraintViolation', 'Transaction identifier unavailable', {}]); return; }
        transaction = { id: nextId, fingerprint, tagHash: digest({ scope, idTag: payload.idTag }), automatic: Boolean(automaticTag(payload.idTag)),
          status: authorization.status, startedAt, startReceivedAt: receivedAt, lastEvidenceAt: startedAt, meterStart: payload.meterStart };
        const updated = supersedes ? updateTransaction({ ...active,
          endedByNewStart: { transactionId: transaction.id, startedAt } }, true) : ledger;
        const next = { ...updated, nextId: nextId + 1, latestStartAt: startedAt,
          activeId: transaction.status === 'Accepted' ? transaction.id : null,
          transactions: [...updated.transactions, transaction].slice(-128) };
        try { persist(next); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      } else {
        // Reconfirm durable storage before replaying a charging authorization.
        try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      }
      if (transaction.status === 'Accepted' && ledger.activeId === transaction.id) {
        observedTransaction = { id: transaction.id, at: startedAt }; recoveryCandidate = null; recoveryConflict = false;
      }
      response = { transactionId: transaction.id, idTagInfo: { status: transaction.status,
        ...(transaction.automatic ? { expiryDate: new Date(transaction.startedAt).toISOString() } : {}) } };
      transactionProgress(payload,response.idTagInfo,receivedAt,replayed);
    } else if (action === 'StopTransaction') {
      if (!stateReady) { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      const stoppedAt = instant(payload.timestamp), transaction = ledger.transactions.find(row => row.id === payload.transactionId)
        ?? ledger.recovered?.transactions.find(row => row.id === payload.transactionId);
      if (!transaction || !isRecovered(transaction) && !['Accepted', 'Blocked'].includes(transaction.status) || !Number.isSafeInteger(payload.meterStop)
        || payload.meterStop < 0 || !Number.isSafeInteger(stoppedAt)
        || stoppedAt < (transaction.startedAt ?? transaction.observedAt) || stoppedAt > clock()
        || transaction.endedByStatus && stoppedAt > transaction.endedByStatus.at) {
        send([4, id, 'PropertyConstraintViolation', 'Unknown or invalid transaction end', {}]); return;
      }
      const stopReason = EXTERNAL_STOP_REASONS.has(payload.reason) ? payload.reason : undefined;
      const fingerprint = digest({ scope, id: transaction.id, stoppedAt, meterStop: payload.meterStop,
        ...(stopReason ? { stopReason } : {}) });
      if (transaction.stopFingerprint && transaction.stopFingerprint !== fingerprint) {
        send([4, id, 'ProtocolError', 'Conflicting transaction end', {}]); return;
      }
      // Device timestamps may have second precision. Preserve the first actual
      // receipt separately, without letting retries manufacture a later event.
      const next = updateTransaction({ ...transaction, stoppedAt, meterStop: payload.meterStop, stopFingerprint: fingerprint,
        ...(stopReason ? { stopReason, stopReceivedAt: transaction.stopReceivedAt ?? receivedAt } : {}) }, true);
      try { persist(next); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      startProgress.stop = { receivedAt, sourceAt: stoppedAt, reason: stopReason ?? null };
      if (observedTransaction?.id === transaction.id) observedTransaction = null;
      if (transactionEvidence?.id === transaction.id) transactionEvidence = null;
      if (recoveryCandidate?.id === transaction.id) { recoveryCandidate = null; recoveryConflict = false; }
      response = {};
    } else if (action === 'StatusNotification') {
      const validStatuses = ['Available', 'Preparing', 'Charging', 'SuspendedEVSE', 'SuspendedEV', 'Finishing', 'Reserved', 'Unavailable', 'Faulted'];
      if (!Number.isInteger(payload.connectorId) || ![0, 1].includes(payload.connectorId)
        || !validStatuses.includes(payload.status) || typeof payload.errorCode !== 'string') {
        send([4, id, 'FormationViolation', 'Invalid connector status', {}]); return;
      }
      const at = payload.timestamp === undefined ? receivedAt : instant(payload.timestamp);
      if (payload.connectorId === 1 && Number.isSafeInteger(at) && at >= 0 && at <= receivedAt + MAX_FUTURE_MS
        && (connectorStatusAt === null || at >= connectorStatusAt)) {
        const status = payload.errorCode === 'NoError' ? payload.status : 'Faulted';
        if (connectorStatus !== status) { remoteStartStatus = 'idle'; statusTransition++; }
        if (NO_TRANSACTION_STATUSES.has(status) || status === 'Preparing' && connectorStatus !== status) {
          previousPhaseValues.clear(); phaseWeightBoundaryAt = at;
        }
        connectorStatus = status; connectorStatusAt = at; connectorReceivedAt = receivedAt; connectorStatusExplicit = payload.timestamp !== undefined;
        if (['Available', 'Reserved', 'Unavailable'].includes(status)) observedTransaction = null;
        if (!activeTransaction() && NO_TRANSACTION_STATUSES.has(status) && connectorStatusExplicit
          && at <= clock() && clock() - at <= MAX_AGE_MS && at > (transactionEvidence?.at ?? Infinity)) {
          transactionEvidence = null; recoveryCandidate = null; recoveryConflict = false;
        }
      }
      response = {};
    } else if (['DiagnosticsStatusNotification', 'FirmwareStatusNotification'].includes(action)) response = {};
    else { send([4, id, 'NotSupported', 'Unsupported action', {}]); return; }
    const reply = [3, id, response];
    replies.set(id, { requestHash, reply }); if (replies.size > 128) replies.delete(replies.keys().next().value);
    send(reply);
    // A transport reconnect (including pair transfer) need not reboot the
    // charger. The configured identity was authenticated during the upgrade;
    // current telemetry still requires fresh measurements on this connection.
    if (action === 'BootNotification' || !telemetryConfigured) configureTelemetry();
    if (action === 'StatusNotification') requestRemoteStart();
  }
  return {
    async start() {
      if (!configured || closed) return;
      if (startPromise) return startPromise;
      if (server?.listening) return;
      startPromise = (async () => {
        diagnostics.start();
        if (canControl()) {
          try { await runState(() => { refreshAuthority(); if (!stateReady) prepareState(); }); }
          catch { if (closed || !canControl()) return; throw requestError('ocpp-unavailable'); }
          if (!stateReady) return;
        } else refreshAuthority();
        if (closed) return;
        server = createServer((_request, response) => { response.writeHead(404); response.end(); });
        server.on('connection', connection => {
          if (closed) { connection.destroy(); return; }
          diagnostics.tcp(connection);
          transportSockets.add(connection);
          connection.once('close', () => { diagnostics.phase('transport-closed', connection); transportSockets.delete(connection); });
        });
        sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
          handleProtocols: protocols => protocols.has('ocpp1.6') ? 'ocpp1.6' : false });
        server.on('upgrade', async (request, stream, head) => {
          diagnostics.phase('upgrade-observed', stream);
          const expected = `Basic ${Buffer.from(`${identity}:${config.password}`).toString('base64')}`;
          if (closed || !canControl() || request.url !== `/ocpp/${encodeURIComponent(identity)}`
            || !equal(String(request.headers.authorization ?? ''), expected)
            || !String(request.headers['sec-websocket-protocol'] ?? '').split(',').some(value => value.trim() === 'ocpp1.6')) {
            stream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
          }
          diagnostics.phase('upgrade-validated', stream);
          let ready = false;
          const admission = new AbortController(), disconnected = () => admission.abort();
          // A client EOF can leave the server's writable half open while its
          // upgrade waits for SQLite. Retire that save without waiting for close.
          stream.once('end', disconnected);
          stream.once('close', disconnected);
          try {
            diagnostics.phase('upgrade-write-requested', stream);
            ready = await runState(() => {
              diagnostics.phase('upgrade-write-entered', stream);
              refreshAuthority(); const prepared = prepareState();
              diagnostics.commit('upgrade-write-committed', stream, state); return prepared;
            },
              { signal: AbortSignal.any([cancellation.signal, admission.signal]) });
            diagnostics.phase('upgrade-write-settled', stream);
          } catch { diagnostics.phase('admission-failed', stream); /* Admission did not grant this connection. */ }
          finally { stream.off('end', disconnected); stream.off('close', disconnected); }
          if (!ready || stream.destroyed || closed || !canControl()) {
            if (!stream.destroyed) stream.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
          }
          sockets.handleUpgrade(request, stream, head, connection => {
            // A freshly authenticated connection supersedes a half-open old
            // TCP connection. Its late events cannot clear the new socket.
            const previous = socket; socket = null; previous?.terminate();
            reset(); socket = connection; connectionId = `${instanceId}:${++connectionSequence}`;
            authenticatedConnectionId = connectionId; connectedAt = clock(); evidenceBoundaryAt = connectedAt; error = null;
            diagnostics.attached(stream, connection, connectionSequence);
            currentSupplyBoundaryAt = connectedAt;
            socket.on('message', (data, binary) => {
              if (socket !== connection) return;
              receivedFrameSequence++;
              const receivedAt = clock();
              const frame = diagnostics.received(connection, receivedAt);
              void runState(() => {
                diagnostics.entered(frame);
                const prior = diagnosticFrame; diagnosticFrame = frame;
                try { return receive(data, binary, null, receivedAt); } finally { diagnosticFrame = prior; }
              }, { connection, bytes: data.length })
                .catch(failure => {
                  if (!['STORAGE_WRITE_STALE', 'STORAGE_WRITE_CANCELLED', 'ocpp-request-revoked'].includes(failure?.code)) storageFailed(connection);
                });
            });
            socket.on('error', () => {});
            socket.on('close', () => { if (socket === connection) { socket = null; reset(); } });
          });
        });
        try {
          await new Promise((resolve, reject) => {
            const failed = err => { server.off('listening', listening); reject(err); };
            const listening = () => { diagnostics.listening(); server.off('error', failed); resolve(); };
            server.once('error', failed); server.once('listening', listening); server.listen(config.port, config.host);
          });
          error = null;
          server.on('error', () => { error = 'listener-unavailable'; });
          timer = setInterval(() => {
            if (!refreshAuthority()) return;
            const now = clock();
            if (socket && (lastMessageAt === null ? now < connectedAt || now - connectedAt > FIRST_MESSAGE_TIMEOUT_MS
              : now < lastMessageAt || now - lastMessageAt > MAX_AGE_MS * 2)) { socket.terminate(); return; }
            for (const [id, pending] of pendingCalls) if (now - pending.sentAt >= CALL_TIMEOUT_MS) {
              pendingCalls.delete(id);
              finishRequest(pending, 'ocpp-request-timeout');
              if (pending.homeRecovery) noteHomeRecovery(pending, 'timed-out', 'native-reply-missing');
              if (pending.authorizationRead && authorizationConfiguration?.reads[pending.authorizationRead]?.requestedAt === pending.sentAt)
                authorizationReadback(pending.authorizationRead, { status: 'timed-out', failedAt: now });
              if (pending.action === 'ChangeConfiguration') configurationFailures.add(pending.key);
              else if (pending.action === 'RemoteStartTransaction' && pending.transition === statusTransition) remoteStartStatus = 'timed-out';
            }
            for (let index = callQueue.length - 1; index >= 0; index--) {
              const call = callQueue[index];
              if (call.resolve && (now < call.queuedAt || now - call.queuedAt >= CALL_TIMEOUT_MS)) {
                callQueue.splice(index, 1); finishRequest(call, 'ocpp-request-timeout');
              }
            }
            scheduleState('maintenance', () => { releaseFutureReadings(); requestRemoteStart(); sendNextCall(); refreshMeterReadback(); });
          }, 1000); timer.unref();
        } catch {
          error = 'listener-unavailable'; sockets.close(); sockets = null; server = null;
        }
      })();
      try { await startPromise; } finally { startPromise = null; }
    },
    refreshAuthority,
    startOutcome(context) {
      // This is the outcome of one durably consumed instruction, never a new
      // retry allowance. Restart retains its original dispatch budget.
      if (!refreshAuthority() || !transportFresh() || activeTransaction()) return null;
      const attempt = recoveryAttempts(context)?.find(row => row.key === context.key);
      if (!attempt || clock() < attempt.at) return null;
      const matching = dispatchedStart?.key === context.key && dispatchedStart.connectedAt === context.connectedAt;
      const rejected = matching && dispatchedStart.rejected === true;
      return { requestedAt: attempt.at, status: rejected ? 'rejected'
        : clock() - attempt.at >= MAX_AGE_MS ? 'unconfirmed' : 'pending' };
    },
    noteModeDisableRequested() {
      if (state?.runWrite && !admitted) return runState(() => this.noteModeDisableRequested());
      // Local credentials or a live socket are not needed to record intent for
      // cloud handback. Durable current state and ownership remain mandatory.
      if (!canControl() || closed || !stateReady && !prepareState()) throw requestError('ocpp-unavailable');
      const active = activeTransaction(), now = clock();
      if (active && now < active.lastEvidenceAt) throw requestError('ocpp-unavailable');
      // The setup coordinator calls this after persisting and verifying its
      // owned OcppOff intent, immediately before apply. Retried applies keep
      // the original boundary and cannot replenish a used recovery attempt.
      const modeDisableIntent = { requestedAt: now, connectionId: authenticatedConnectionId };
      persist(active && !active.modeDisableIntent ? updateTransaction({ ...active, modeDisableIntent }) : ledger);
    },
    request(action, payload, { signal, guard = () => true, beforeSend = () => true, attempt, diagnosticRead = false } = {}) {
      if (!REQUEST_ACTIONS.has(action)) return Promise.reject(requestError('ocpp-action-not-allowed'));
      if (typeof diagnosticRead !== 'boolean' || diagnosticRead && action !== 'GetCompositeSchedule')
        return Promise.reject(requestError('ocpp-invalid-request'));
      if (action === 'TriggerMessage' && (!payload || payload.connectorId !== 1 || payload.requestedMessage !== 'MeterValues'
        || Object.keys(payload).some(key => !['connectorId', 'requestedMessage'].includes(key))))
        return Promise.reject(requestError('ocpp-invalid-payload'));
      if (action === 'TriggerMessage' && meterTriggerUnsupported) return Promise.reject(requestError('ocpp-meter-trigger-unsupported'));
      if (action === 'ChangeAvailability' && (!payload || payload.connectorId !== 0 || payload.type !== 'Operative'
        || Object.keys(payload).some(key => !['connectorId', 'type'].includes(key))))
        return Promise.reject(requestError('ocpp-invalid-payload'));
      let encoded;
      try { encoded = JSON.stringify(payload); } catch { return Promise.reject(requestError('ocpp-invalid-payload')); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !encoded || encoded.length > 16_384)
        return Promise.reject(requestError('ocpp-invalid-payload'));
      if (typeof guard !== 'function' || typeof beforeSend !== 'function'
        || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))
        return Promise.reject(requestError('ocpp-invalid-request'));
      if (signal?.aborted) return Promise.reject(requestError('ocpp-request-aborted'));
      if (!refreshAuthority() || !transportFresh()) return Promise.reject(requestError('ocpp-unavailable'));
      if (!permittedBy(guard)) return Promise.reject(requestError('ocpp-request-revoked'));
      if (callQueue.filter(call => call.resolve).length >= 8) return Promise.reject(requestError('ocpp-queue-full'));
      return new Promise((resolve, reject) => {
        const call = { action, payload: JSON.parse(encoded), connection: socket, queuedAt: clock(), signal, guard, beforeSend, resolve, reject, diagnosticRead,
          attempt: attempt ?? (['SetChargingProfile', 'ClearChargingProfile', 'ChangeAvailability'].includes(action)
            ? controlAttempt() : createControlAttempt({ kind: 'query' })) };
        call.abort = () => {
          const index = callQueue.indexOf(call);
          if (index >= 0) callQueue.splice(index, 1);
          finishRequest(call, 'ocpp-request-aborted');
          // Read-only requests have no physical effect to resolve.
          // A late sample/reply remains ordinary telemetry; it must not hold a
          // physical pause or restoration behind its acknowledgement timeout.
          if (READ_ONLY_REQUEST_ACTIONS.has(action)) for (const [id, pending] of pendingCalls)
            if (pending === call) pendingCalls.delete(id);
          // Mutations already sent still occupy the wire until reply or
          // timeout; cancelling a promise cannot cancel its physical effect.
          sendNextCall();
        };
        signal?.addEventListener('abort', call.abort, { once: true });
        call.timeout = setTimeout(() => {
          const index = callQueue.indexOf(call); if (index >= 0) callQueue.splice(index, 1);
          finishRequest(call, 'ocpp-request-timeout'); sendNextCall();
        }, CALL_TIMEOUT_MS); call.timeout.unref();
        callQueue.push(call); sendNextCall();
      });
    },
    deviceInfo() {
      return device ? { ...device, available: booted && transportFresh() } : null;
    },
    controlClockDelayMs() {
      if (!refreshAuthority() || !transportFresh() || connectorStatusAt === null) return 0;
      const remaining = connectorStatusAt - clock();
      // Ingress admits a small device clock skew, but that status cannot yet
      // authorize control. Callers may wait once, then read and fence normally.
      return remaining > 0 && remaining <= MAX_FUTURE_MS ? remaining : 0;
    },
    controlPending() {
      return [...pendingCalls.values(), ...callQueue].some(call =>
        !['GetCompositeSchedule', 'GetConfiguration', 'TriggerMessage'].includes(call.action));
    },
    controlSnapshot() {
      if (!refreshAuthority() || !transportFresh() || connectorStatusAt === null
        || clock() < connectorStatusAt) return null;
      if (releaseFutureReadings() === false || reconcileTransactionStatus() === false) return null;
      if (!stateReady) return null;
      const active = activeTransaction();
      const confirmed = !recoveryConflict && !observedTransaction?.conflicting
        && observedTransaction?.id === active?.id && clock() >= observedTransaction?.at
        && clock() - observedTransaction.at <= MAX_AGE_MS;
      const stopped = [...ledger.transactions, ...(ledger.recovered?.transactions ?? [])]
        .filter(row => row.stopReason && (isRecovered(row) || row.status === 'Accepted') && row.stoppedAt <= clock())
        .sort((left, right) => right.stoppedAt - left.stoppedAt || right.stopReceivedAt - left.stopReceivedAt || right.id - left.id)[0];
      return { connectionId, connectorStatus, timestamp: connectorStatusAt, receivedAt: connectorReceivedAt,
        nativeStop: stopped ? { transactionId: stopped.id, at: stopped.stoppedAt,
          receivedAt: stopped.stopReceivedAt, reason: stopped.stopReason } : null,
        transaction: active ? { id: active.id, startedAt: active.startedAt ?? null, tagHash: active.tagHash ?? null, confirmed,
          provenance: isRecovered(active) ? 'meter-values' : 'start-transaction', confirmedAt: active.confirmedAt ?? active.startedAt } : null,
        readings: [...values.values()].filter(row => row.value !== null && instant(row.timestamp) <= clock()
          && clock() - instant(row.timestamp) <= MAX_AGE_MS).map(row => ({ ...row })) };
    },
    currentSupplySnapshot() {
      // Load allocation admits the latest current on a healthy source epoch.
      // This separate view does not loosen command, transaction, recording or
      // identification freshness, and never updates a measurement's clocks.
      if (!refreshAuthority() || !transportFresh() || currentSupplyBoundaryAt === null) return null;
      if (releaseFutureReadings() === false) return null;
      if (!stateReady) return null;
      return { connectionId, epoch: `${connectionId}:${currentSupplyBoundaryAt}`,
        readings: [...values.values()].filter(row => [183, 184, 185].includes(row.id)
          && instant(row.timestamp) >= currentSupplyBoundaryAt && instant(row.timestamp) <= clock()
          && row.receivedAt >= currentSupplyBoundaryAt).map(row => ({ ...row })) };
    },
    readSnapshot({ signal } = {}) {
      signal?.throwIfAborted(); cancellation.signal.throwIfAborted();
      const connection = socket, generation = connectionId, snapshot = this.snapshot({ recording: true });
      return maintenance.has('future-readings')
        ? readAdmittedSnapshot(() => this.snapshot({ recording: true }), connection, generation, signal) : snapshot;
    },
    snapshot({ recording = false } = {}) {
      if (!refreshAuthority() || socket?.readyState !== 1 || lastMessageAt === null
        || clock() < lastMessageAt || clock() - lastMessageAt > MAX_AGE_MS) return null;
      if (releaseFutureReadings() === false) return null;
      if (!stateReady) return null;
      const rows = [...values.values()].filter(row => row.value !== null && clock() - instant(row.timestamp) <= MAX_AGE_MS && instant(row.timestamp) <= clock());
      const power = rows.find(row => row.id === 120);
      if (recording && power?.value > 0) for (const id of [183, 184, 185]) {
        const current = values.get(id), previous = previousPhaseValues.get(id);
        // Only a prior, unambiguous sample from this connection can estimate
        // phase allocation. Keep the conflicting current unknown everywhere
        // else, including control and live household headroom.
        if (current?.value === null && previous && instant(previous.timestamp) < instant(current.timestamp)
          && instant(previous.timestamp) <= clock() && clock() - instant(previous.timestamp) <= MAX_AGE_MS)
          rows.push({ ...previous, phaseWeightOnly: true });
      }
      if (!power || power.value > 0 && ![183, 184, 185].every(id => rows.some(row => row.id === id))) return null;
      return [...rows, { id: 250, value: true, timestamp: new Date(lastMessageAt).toISOString() }];
    },
    voltageSnapshot() {
      // Voltage forecasting needs only explicitly mapped fresh phase-neutral
      // values. It cannot grant current/power/control readiness to this socket.
      if (!refreshAuthority() || !transportFresh()) return null;
      if (releaseFutureReadings() === false) return null;
      if (!stateReady) return null;
      const rows = [...values.values()].filter(row => [194, 195, 196].includes(row.id)
        && row.value !== null && instant(row.timestamp) <= clock() && clock() - instant(row.timestamp) <= MAX_AGE_MS);
      return rows.length ? [...rows, { id: 250, value: true, timestamp: new Date(lastMessageAt).toISOString() }] : null;
    },
    status() {
      const available = Boolean(this.snapshot()), listening = Boolean(server?.listening && !closed);
      return { configured, listening, ready: listening && stateReady && authorizationReady && canControl() && !error,
        transportConnected: Boolean(canControl() && socket?.readyState === 1), connectionGeneration: connectionSequence,
        connected: Boolean(canControl() && socket?.readyState === 1 && lastMessageAt !== null), hasBootReported: booted, available,
        error: error ?? (authorizationReady ? null : 'authorization-unavailable'), lastMessageAt, configurationFailures: [...configurationFailures],
        authorizationMode: config.authorization_mode, remoteStartStatus, startProgress: structuredClone(startProgress),
        startReadiness: structuredClone(startReadiness),
        authorizationConfiguration: structuredClone(authorizationConfiguration),
        pendingConfiguration: [...pendingCalls.values(), ...callQueue.map(call => ({ action: call.action, key: call.payload.key }))]
          .filter(call => call.action === 'ChangeConfiguration').map(call => call.key),
        controlTransport: configured ? 'ocpp' : null };
    },
    async close() {
      diagnostics.closeRequested();
      closed = true;
      cancellation.abort();
      await startPromise;
      clearInterval(timer); socket?.terminate();
      for (const client of sockets?.clients ?? []) client.terminate();
      // Incomplete HTTP/WebSocket handshakes are not WebSocketServer clients.
      // They must not hold server.close(), controller release or VIP handover.
      for (const connection of transportSockets) connection.destroy();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      sockets?.close(); reset(); stateReady = false; ownsConnection = false;
      diagnostics.close();
    },
  };
}
