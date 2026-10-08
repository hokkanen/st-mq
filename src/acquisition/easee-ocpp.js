import { createServer } from 'node:http';
import { timingSafeEqual, randomInt, randomUUID, createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { chargingDeviceInfo } from '../charging/device-info.js';
import { MAX_SOURCE_AHEAD_MS } from '../domain/time-evidence.js';

const MAX_AGE_MS = 60_000;
const MAX_FUTURE_MS = MAX_SOURCE_AHEAD_MS;
const CALL_TIMEOUT_MS = 15_000;
const FIRST_MESSAGE_TIMEOUT_MS = 30_000;
const NO_TRANSACTION_STATUSES = new Set(['Available', 'Finishing']);
const RECOVERABLE_STATUSES = new Set(['Charging', 'SuspendedEVSE', 'SuspendedEV']);
const EXTERNAL_STOP_REASONS = new Set(['Remote', 'Local', 'DeAuthorized']);
const REQUEST_ACTIONS = new Set(['SetChargingProfile', 'ClearChargingProfile', 'GetCompositeSchedule', 'GetConfiguration', 'ChangeAvailability']);
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
      if (id) result.push({ id, value: normalized, unit, timestamp: new Date(at).toISOString() });
    }
  }
  return result;
}

/** Bounded OCPP 1.6J central-system endpoint. Plug-and-charge explicitly permits
 * remote authorization with a known private tag. This endpoint does not infer
 * charging-profile support or silently convert an existing cloud schedule. */
export function createEaseeOcpp({ config: input, chargerId, clock = Date.now, canControl = () => false,
  canStart = () => false, onDisconnect = () => {}, state, virtualTag = '' } = {}) {
  const config = localOcppConfiguration(input);
  if (typeof virtualTag !== 'string' || virtualTag.length > 20) throw new TypeError('Invalid private OCPP virtual tag');
  const plugAndCharge = config.authorization_mode === 'plug-and-charge';
  const authorizationReady = !plugAndCharge || Boolean(virtualTag);
  const configured = Boolean(config.enabled && config.password && chargerId);
  const identity = config.charge_point_id || chargerId;
  let server, sockets, socket, timer, startPromise, booted = false, lastMessageAt = null, connectedAt = null, error = null, closed = false;
  let ownsConnection = false, telemetryConfigured = false;
  let connectorStatus = null, connectorStatusAt = null, connectorReceivedAt = null, connectorStatusExplicit = false;
  let preparingAttempted = false, remoteStartStatus = 'idle';
  let device = null;
  let observedTransaction = null, connectionId = null, authenticatedConnectionId = null, transactionEvidence = null;
  let recoveryCandidate = null, recoveryConflict = false, evidenceBoundaryAt = null;
  let currentSupplyBoundaryAt = null;
  const instanceId = randomUUID(); let connectionSequence = 0;
  let statusTransition = 0;
  const values = new Map(), replies = new Map(), pendingCalls = new Map();
  const deferredTransactions = new Map();
  const futureReadings = [];
  const callQueue = [];
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = digest({ chargerId, identity });
  let ledger = null, stateReady = false;
  let admitted = false;
  const cancellation = new AbortController(), maintenance = new Set();
  function storageFailed(connection) {
    if (connection !== socket) return;
    stateReady = false; error = 'transaction-state-unavailable';
    socket?.terminate(); reset();
  }
  function runState(operation, { connection, bytes = 0 } = {}) {
    const current = () => !closed && canControl() && (connection === undefined || socket === connection);
    const execute = () => {
      if (!current()) throw requestError('ocpp-request-revoked');
      const prior = admitted;
      admitted = true;
      state?.afterRollback?.(() => storageFailed(connection ?? socket));
      try { return operation(); } finally { admitted = prior; }
    };
    try { return state?.runWrite ? state.runWrite(execute, { signal: cancellation.signal, isCurrent: current, priority: 'control', bytes })
      : Promise.resolve(execute()); }
    catch (error) { return Promise.reject(error); }
  }
  function scheduleState(name, operation) {
    if (maintenance.has(name)) return;
    maintenance.add(name);
    const connection = socket;
    void runState(operation, { connection }).catch(error => {
      if (!['STORAGE_WRITE_STALE', 'STORAGE_WRITE_CANCELLED', 'ocpp-request-revoked'].includes(error?.code)) storageFailed(connection);
    }).finally(() => maintenance.delete(name));
  }
  const configurationFailures = new Set();
  const validLedger = value => value && value.version === 4 && value.scope === scope
    && Object.keys(value).every(key => ['version', 'scope', 'nextId', 'latestStartAt', 'activeId', 'transactions', 'recovered'].includes(key))
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
  const persist = next => {
    if (!stateReady || !state?.set) throw new Error('OCPP state unavailable');
    try { state.set(structuredClone(next)); ledger = next; }
    catch { stateReady = false; error = 'transaction-state-unavailable'; rejectRequests('ocpp-unavailable'); throw new Error('OCPP state unavailable'); }
  };
  let callId = 0;
  const currentTime = () => new Date(clock()).toISOString();
  function finishRequest(call, code, result) {
    if (!call?.resolve || call.settled) return;
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
    booted = false; values.clear(); futureReadings.length = 0; replies.clear();
    configurationFailures.clear(); lastMessageAt = null; connectedAt = null; telemetryConfigured = false;
    connectorStatus = null; connectorStatusAt = null; connectorReceivedAt = null; connectorStatusExplicit = false;
    observedTransaction = null; connectionId = null; authenticatedConnectionId = null; transactionEvidence = null;
    recoveryCandidate = null; recoveryConflict = false; evidenceBoundaryAt = null;
    currentSupplyBoundaryAt = null;
    preparingAttempted = false; remoteStartStatus = 'idle'; statusTransition++;
    onDisconnect();
  }
  function send(value) {
    const connection = socket;
    const effect = () => { if (!closed && canControl() && socket === connection && connection?.readyState === 1) connection.send(JSON.stringify(value)); };
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
  function sendNextCall() {
    if (state?.runWrite && !admitted) { scheduleState('send', sendNextCall); return; }
    if (pendingCalls.size || !callQueue.length || socket?.readyState !== 1 || !canControl()) return;
    const call = callQueue.shift(), { action, payload, transition } = call, id = `stmq-${++callId}`;
    if (call.resolve && (call.settled || call.connection !== socket || !transportFresh()
      || !permittedBy(call.guard) || !permittedBy(call.beforeSend))) {
      finishRequest(call, 'ocpp-request-revoked'); sendNextCall(); return;
    }
    if (action === 'RemoteStartTransaction') {
      if (!stateReady || !authorizationReady || !permittedBy(canStart) || !canRequestRemoteStart() || connectorStatus !== 'Preparing'
        || transition !== statusTransition || clock() < connectorStatusAt || !transportFresh()) {
        preparingAttempted = false; remoteStartStatus = 'cancelled'; sendNextCall(); return;
      }
      // A start permission must not outlive durable transaction storage.
      const active = activeTransaction();
      try { persist(active ? updateTransaction({ ...active, modeDisableIntent: { ...active.modeDisableIntent, attemptedAt: clock() } }) : ledger); }
      catch { remoteStartStatus = 'unavailable'; sendNextCall(); return; }
      remoteStartStatus = 'pending';
    }
    Object.assign(call, { key: payload.key, sentAt: clock() });
    pendingCalls.set(id, call); send([2, id, action, payload]);
  }
  function requestRemoteStart() {
    reconcileTransactionStatus();
    if (!plugAndCharge || !authorizationReady || !stateReady || !permittedBy(canStart) || preparingAttempted
      || connectorStatus !== 'Preparing' || !canRequestRemoteStart() || clock() < connectorStatusAt || !transportFresh()) return;
    preparingAttempted = true; remoteStartStatus = 'queued';
    callQueue.unshift({ action: 'RemoteStartTransaction', payload: { connectorId: 1, idTag: virtualTag }, transition: statusTransition });
    sendNextCall();
  }
  function configureTelemetry() {
    telemetryConfigured = true;
    configurationFailures.clear(); rejectRequests('ocpp-reconfigured');
    for (const [key, value] of [['MeterValuesSampledData', 'Power.Active.Import,Current.Import,Voltage'],
      ['MeterValuesAlignedData', 'Power.Active.Import,Current.Import,Voltage'], ['MeterValueSampleInterval', '30'],
      ['ClockAlignedDataInterval', '30']]) callQueue.push({ action: 'ChangeConfiguration', payload: { key, value } });
    callQueue.push({ action: 'TriggerMessage', payload: { requestedMessage: 'MeterValues', connectorId: 1 } });
    callQueue.push({ action: 'TriggerMessage', payload: { requestedMessage: 'StatusNotification', connectorId: 1 } });
    sendNextCall();
  }
  function recoverTransaction(readings, transactionId, receivedAt, messageId) {
    const validId = Number.isSafeInteger(transactionId) && transactionId > 0 && transactionId < 2147483647;
    const powerReadings = readings.filter(row => row.id === 120);
    const at = Math.max(...powerReadings.map(row => instant(row.timestamp)));
    const fresh = validId && Number.isSafeInteger(at) && at >= evidenceBoundaryAt && at - receivedAt <= MAX_FUTURE_MS
      && clock() >= at && clock() - at <= MAX_AGE_MS;
    if (!fresh) return true;
    const currentPower = powerReadings.filter(row => instant(row.timestamp) === at), priorPower = values.get(120);
    if (new Set(currentPower.map(row => row.value)).size !== 1
      || instant(priorPower?.timestamp) === at && priorPower.value !== currentPower[0].value) {
      recoveryConflict = true; observedTransaction = null; return true;
    }
    if (recoveryCandidate && at - recoveryCandidate.lastAt > MAX_AGE_MS) recoveryCandidate = null;
    const active = activeTransaction();
    // Two different current transaction identifiers on one connection cannot
    // establish ownership. Keep telemetry, but revoke control until a new
    // authenticated connection or an explicit transaction boundary resolves it.
    if (at < Math.max(active?.lastEvidenceAt ?? 0, recoveryCandidate?.lastAt ?? 0)) return true;
    if (active && active.id !== transactionId || recoveryCandidate && recoveryCandidate.id !== transactionId) {
      recoveryConflict = true; observedTransaction = null; return true;
    }
    if (recoveryConflict || active && !isRecovered(active) || !messageId || !connectorStatusExplicit
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
    if (readings.length && Number.isSafeInteger(transactionId) && transactionId > 0 && transactionId < 2147483647) {
      const at = Math.max(...readings.map(row => instant(row.timestamp)));
      if (!transactionEvidence || at >= transactionEvidence.at) transactionEvidence = { id: transactionId, at };
    }
    if (!recoverTransaction(readings, transactionId, receivedAt, messageId)) return false;
    const active = activeTransaction();
    if (readings.length && active && transactionId === active.id) {
      const at = Math.max(...readings.map(row => instant(row.timestamp)));
      if (at > active.lastEvidenceAt) {
        try { persist(updateTransaction({ ...active, lastEvidenceAt: at })); }
        catch { return false; }
      }
      if (!isRecovered(active) && !recoveryConflict && at >= active.startedAt
        && (!observedTransaction || at >= observedTransaction.at)) observedTransaction = { id: transactionId, at };
    }
    for (const row of readings) {
      const before = values.get(row.id), at = instant(row.timestamp), priorAt = instant(before?.timestamp);
      if (!before || at > priorAt) values.set(row.id, { ...row, receivedAt });
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
      if (saved !== null && saved !== undefined && !validLedger(saved)) { error = 'incompatible-transaction-state'; stateReady = false; return false; }
      ledger = saved ?? { version: 4, scope, nextId: randomInt(1, 1000000000), latestStartAt: 0, activeId: null, transactions: [] };
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
    && plugAndCharge && authorizationReady && equal(virtualTag, tag);
  const authorizationInfo = tag => automaticTag(tag)
    // This tag represents a live controller permission, never a reusable RFID
    // enrollment. OCPP expiryDate removes it from the authorization cache.
    ? { status: transportFresh() && permittedBy(canStart) ? 'Accepted' : 'Blocked', expiryDate: currentTime() }
    : { status: configuredTag(tag) ? transportFresh() ? 'Accepted' : 'Blocked' : 'Invalid' };
  function completeResponse(id, pending, frame, waited = false) {
    if (pendingCalls.get(id) !== pending) return;
    pendingCalls.delete(id);
    if (pending.resolve) {
      const expired = waited && (clock() < pending.queuedAt || clock() - pending.queuedAt >= CALL_TIMEOUT_MS);
      const revoked = !refreshAuthority() || pending.connection !== socket || !transportFresh()
        || waited && clock() < connectorStatusAt || !permittedBy(pending.guard);
      finishRequest(pending, expired ? 'ocpp-request-timeout' : revoked ? 'ocpp-request-revoked'
        : frame[0] === 4 ? 'ocpp-request-failed' : null, frame[2]);
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
        pending.replyTimer = setTimeout(() => completeResponse(frame[1], pending, frame, true), remaining);
        pending.replyTimer.unref();
      } else {
        completeResponse(frame[1], pending, frame);
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
      if (action === 'Authorize') send([3, id, { idTagInfo: authorizationInfo(payload.idTag) }]);
      else send(prior.reply);
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
      values.clear(); futureReadings.length = 0; rejectRequests('ocpp-reconfigured'); booted = true; onDisconnect();
      for (const pending of deferredTransactions.values()) clearTimeout(pending.timer);
      deferredTransactions.clear();
      connectionId = `${instanceId}:${++connectionSequence}`;
      device = chargingDeviceInfo({ model: payload.chargePointModel, firmware: payload.firmwareVersion,
        source: 'ocpp-boot', receivedAt: lastMessageAt });
      connectorStatus = null; connectorStatusAt = null; connectorReceivedAt = null; connectorStatusExplicit = false; observedTransaction = null;
      recoveryCandidate = null; recoveryConflict = false; evidenceBoundaryAt = receivedAt;
      currentSupplyBoundaryAt = receivedAt;
      preparingAttempted = false; remoteStartStatus = 'idle'; statusTransition++;
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
        transaction = { id: nextId, fingerprint, tagHash: digest({ scope, idTag: payload.idTag }),
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
      if (transaction.status === 'Blocked') preparingAttempted = false;
      response = { transactionId: transaction.id, idTagInfo: { status: transaction.status,
        ...(automaticTag(payload.idTag) ? { expiryDate: new Date(transaction.startedAt).toISOString() } : {}) } };
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
        if (connectorStatus !== status) { preparingAttempted = false; remoteStartStatus = 'idle'; statusTransition++; }
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
        if (canControl()) {
          try { await runState(() => { refreshAuthority(); if (!stateReady) prepareState(); }); }
          catch { if (closed || !canControl()) return; throw requestError('ocpp-unavailable'); }
          if (!stateReady) return;
        } else refreshAuthority();
        if (closed) return;
        server = createServer((_request, response) => { response.writeHead(404); response.end(); });
        sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
          handleProtocols: protocols => protocols.has('ocpp1.6') ? 'ocpp1.6' : false });
        server.on('upgrade', async (request, stream, head) => {
          const expected = `Basic ${Buffer.from(`${identity}:${config.password}`).toString('base64')}`;
          if (closed || !canControl() || request.url !== `/ocpp/${encodeURIComponent(identity)}`
            || !equal(String(request.headers.authorization ?? ''), expected)
            || !String(request.headers['sec-websocket-protocol'] ?? '').split(',').some(value => value.trim() === 'ocpp1.6')) {
            stream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
          }
          let ready = false;
          try { ready = await runState(() => { refreshAuthority(); return prepareState(); }); } catch { /* Admission did not grant this connection. */ }
          if (!ready || stream.destroyed || closed || !canControl()) {
            if (!stream.destroyed) stream.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
          }
          sockets.handleUpgrade(request, stream, head, connection => {
            // A freshly authenticated connection supersedes a half-open old
            // TCP connection. Its late events cannot clear the new socket.
            const previous = socket; socket = null; previous?.terminate();
            reset(); socket = connection; connectionId = `${instanceId}:${++connectionSequence}`;
            authenticatedConnectionId = connectionId; connectedAt = clock(); evidenceBoundaryAt = connectedAt; error = null;
            currentSupplyBoundaryAt = connectedAt;
            socket.on('message', (data, binary) => {
              if (socket !== connection) return;
              const receivedAt = clock();
              void runState(() => receive(data, binary, null, receivedAt), { connection, bytes: data.length })
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
            const listening = () => { server.off('error', failed); resolve(); };
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
              if (pending.action === 'ChangeConfiguration') configurationFailures.add(pending.key);
              else if (pending.action === 'RemoteStartTransaction' && pending.transition === statusTransition) remoteStartStatus = 'timed-out';
            }
            for (let index = callQueue.length - 1; index >= 0; index--) {
              const call = callQueue[index];
              if (call.resolve && (now < call.queuedAt || now - call.queuedAt >= CALL_TIMEOUT_MS)) {
                callQueue.splice(index, 1); finishRequest(call, 'ocpp-request-timeout');
              }
            }
            scheduleState('maintenance', () => { releaseFutureReadings(); requestRemoteStart(); sendNextCall(); });
          }, 1000); timer.unref();
        } catch {
          error = 'listener-unavailable'; sockets.close(); sockets = null; server = null;
        }
      })();
      try { await startPromise; } finally { startPromise = null; }
    },
    refreshAuthority,
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
    request(action, payload, { signal, guard = () => true, beforeSend = () => true } = {}) {
      if (!REQUEST_ACTIONS.has(action)) return Promise.reject(requestError('ocpp-action-not-allowed'));
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
        const call = { action, payload: JSON.parse(encoded), connection: socket, queuedAt: clock(), signal, guard, beforeSend, resolve, reject };
        call.abort = () => {
          const index = callQueue.indexOf(call);
          if (index >= 0) callQueue.splice(index, 1);
          finishRequest(call, 'ocpp-request-aborted');
          // An already sent request still occupies the wire until reply or
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
    controlSnapshot() {
      if (!refreshAuthority() || !transportFresh() || connectorStatusAt === null
        || clock() < connectorStatusAt) return null;
      if (releaseFutureReadings() === false || reconcileTransactionStatus() === false) return null;
      if (!stateReady) return null;
      const active = activeTransaction();
      const confirmed = !recoveryConflict && observedTransaction?.id === active?.id && clock() >= observedTransaction?.at
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
    snapshot() {
      if (!refreshAuthority() || socket?.readyState !== 1 || lastMessageAt === null
        || clock() < lastMessageAt || clock() - lastMessageAt > MAX_AGE_MS) return null;
      if (releaseFutureReadings() === false) return null;
      if (!stateReady) return null;
      const rows = [...values.values()].filter(row => row.value !== null && clock() - instant(row.timestamp) <= MAX_AGE_MS && instant(row.timestamp) <= clock());
      const power = rows.find(row => row.id === 120);
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
        connected: Boolean(canControl() && socket?.readyState === 1 && lastMessageAt !== null), hasBootReported: booted, available,
        error: error ?? (authorizationReady ? null : 'authorization-unavailable'), lastMessageAt, configurationFailures: [...configurationFailures],
        authorizationMode: config.authorization_mode, remoteStartStatus,
        pendingConfiguration: [...pendingCalls.values(), ...callQueue.map(call => ({ action: call.action, key: call.payload.key }))]
          .filter(call => call.action === 'ChangeConfiguration').map(call => call.key),
        controlTransport: configured ? 'ocpp' : null };
    },
    async close() {
      closed = true;
      cancellation.abort();
      await startPromise;
      clearInterval(timer); socket?.terminate();
      for (const client of sockets?.clients ?? []) client.terminate();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      sockets?.close(); reset(); stateReady = false; ownsConnection = false;
    },
  };
}
