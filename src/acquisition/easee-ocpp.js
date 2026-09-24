import { createServer } from 'node:http';
import { timingSafeEqual, randomInt, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const MAX_AGE_MS = 60_000;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function localOcppConfiguration(input = {}) {
  const defaults = { enabled: true, host: '0.0.0.0', port: 9001, password: '', charge_point_id: '', authorization_tags: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new TypeError('Invalid easee.local_ocpp fields');
  const config = { ...defaults, ...input };
  if (typeof config.enabled !== 'boolean' || typeof config.host !== 'string' || !config.host.trim()
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || typeof config.password !== 'string' || config.password && config.password.length < 16
    || typeof config.charge_point_id !== 'string' || config.charge_point_id.length > 128
    || /[/:\s]/.test(config.charge_point_id) || !Array.isArray(config.authorization_tags)
    || config.authorization_tags.length > 100 || config.authorization_tags.some(tag => typeof tag !== 'string' || !tag.length || tag.length > 20))
    throw new TypeError('Invalid easee.local_ocpp configuration; use a password of at least 16 characters and explicit authorization tags');
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
      if (!sample || sample.format && sample.format !== 'Raw' || sample.location && sample.location !== 'Outlet') continue;
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

/** Bounded OCPP 1.6J central-system telemetry endpoint. Native Easee schedules
 * retain their existing cloud ownership/readback contract; no charging profile
 * or installer setting is silently translated into a different control model. */
export function createEaseeOcpp({ config: input, chargerId, clock = Date.now, canControl = () => false,
  onDisconnect = () => {}, state } = {}) {
  const config = localOcppConfiguration(input);
  const configured = Boolean(config.enabled && config.password && chargerId && config.authorization_tags.length);
  const identity = config.charge_point_id || chargerId;
  let server, sockets, socket, timer, booted = false, lastMessageAt = null, error = null, closed = false;
  const values = new Map(), replies = new Map(), pendingCalls = new Map();
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = digest({ chargerId, identity });
  let ledger = null, stateReady = false;
  const configurationFailures = new Set();
  const validLedger = value => value && value.version === 1 && value.scope === scope
    && Object.keys(value).every(key => ['version', 'scope', 'nextId', 'latestStartAt', 'activeId', 'transactions'].includes(key))
    && Number.isSafeInteger(value.nextId) && value.nextId > 0 && value.nextId < 2147483647
    && Number.isSafeInteger(value.latestStartAt) && value.latestStartAt >= 0
    && (value.activeId === null || Number.isSafeInteger(value.activeId))
    && Array.isArray(value.transactions) && value.transactions.length <= 128
    && new Set(value.transactions.map(row => row.id)).size === value.transactions.length
    && value.transactions.every(row => row && Object.keys(row).every(key => ['id', 'fingerprint', 'status', 'startedAt', 'meterStart', 'stopFingerprint', 'stoppedAt', 'meterStop'].includes(key))
      && Number.isSafeInteger(row.id) && row.id > 0 && row.id < value.nextId
      && /^[a-f0-9]{64}$/.test(row.fingerprint) && ['Accepted', 'Invalid'].includes(row.status)
      && Number.isSafeInteger(row.startedAt) && row.startedAt >= 0 && row.startedAt <= value.latestStartAt
      && Number.isSafeInteger(row.meterStart) && row.meterStart >= 0
      && (row.stopFingerprint === undefined && row.stoppedAt === undefined && row.meterStop === undefined
        || /^[a-f0-9]{64}$/.test(row.stopFingerprint) && Number.isSafeInteger(row.stoppedAt) && row.stoppedAt >= row.startedAt
          && Number.isSafeInteger(row.meterStop) && row.meterStop >= 0))
    && value.transactions.filter(row => row.status === 'Accepted' && row.stoppedAt === undefined).every(row => row.id === value.activeId)
    && (value.activeId === null || value.transactions.some(row => row.id === value.activeId && row.status === 'Accepted' && row.stoppedAt === undefined));
  const persist = next => {
    if (!stateReady || !state?.set) throw new Error('OCPP state unavailable');
    try { state.set(structuredClone(next)); ledger = next; }
    catch { stateReady = false; error = 'transaction-state-unavailable'; throw new Error('OCPP state unavailable'); }
  };
  let callId = 0;
  const currentTime = () => new Date(clock()).toISOString();
  function reset() {
    booted = false; values.clear(); replies.clear(); pendingCalls.clear(); lastMessageAt = null;
    onDisconnect();
  }
  function send(value) { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); }
  function call(action, payload) { const id = `stmq-${++callId}`; pendingCalls.set(id, { action, key: payload.key }); send([2, id, action, payload]); }
  const authorized = tag => typeof tag === 'string' && config.authorization_tags.some(value => equal(value, tag));
  function receive(data, binary) {
    if (binary || !canControl()) { socket.close(1008, 'Unavailable'); return; }
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { socket.close(1007, 'Invalid JSON'); return; }
    if (!Array.isArray(frame) || ![2, 3, 4].includes(frame[0])) { socket.close(1002, 'Invalid OCPP frame'); return; }
    if (frame[0] !== 2) {
      const pending = pendingCalls.get(frame[1]);
      if (!pending) return;
      pendingCalls.delete(frame[1]);
      if (pending.action === 'ChangeConfiguration') {
        const status = frame[0] === 3 ? frame[2]?.status : null;
        if (status === 'Accepted') configurationFailures.delete(pending.key);
        else configurationFailures.add(pending.key);
      }
      return;
    }
    const [, id, action, payload] = frame;
    if (frame.length !== 4 || typeof id !== 'string' || !id.length || id.length > 36 || typeof action !== 'string'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)) { socket.close(1002, 'Invalid OCPP call'); return; }
    lastMessageAt = clock();
    const requestHash = digest({ action, payload });
    if (replies.has(id)) {
      const prior = replies.get(id);
      if (['Authorize', 'StartTransaction'].includes(action)) {
        try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      }
      send(prior.requestHash === requestHash ? prior.reply : [4, id, 'ProtocolError', 'Conflicting message identifier', {}]); return;
    }
    let response;
    if (action === 'BootNotification') {
      if (typeof payload.chargePointVendor !== 'string' || typeof payload.chargePointModel !== 'string') {
        send([4, id, 'FormationViolation', 'Missing product fields', {}]); return;
      }
      values.clear(); pendingCalls.clear(); booted = true; onDisconnect();
      response = { status: 'Accepted', currentTime: currentTime(), interval: 30 };
    } else if (!booted) { send([4, id, 'SecurityError', 'Boot notification required', {}]); return; }
    else if (action === 'Heartbeat') response = { currentTime: currentTime() };
    else if (action === 'MeterValues') {
      for (const row of ocppMeterReadings(payload, clock())) {
        const before = values.get(row.id), at = instant(row.timestamp), priorAt = instant(before?.timestamp);
        if (!before || at > priorAt) values.set(row.id, row);
        else if (at === priorAt && row.value !== before.value) values.set(row.id, { ...row, value: null });
      }
      response = {};
    } else if (action === 'Authorize') {
      try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      response = { idTagInfo: { status: authorized(payload.idTag) ? 'Accepted' : 'Invalid' } };
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
        if (ledger.activeId !== null || startedAt <= ledger.latestStartAt || ledger.nextId >= 2147483646) {
          send([4, id, 'OccurrenceConstraintViolation', 'Transaction conflicts with recorded history', {}]); return;
        }
        transaction = { id: ledger.nextId, fingerprint, status: authorized(payload.idTag) ? 'Accepted' : 'Invalid', startedAt, meterStart: payload.meterStart };
        const next = { ...ledger, nextId: ledger.nextId + 1, latestStartAt: startedAt,
          activeId: transaction.status === 'Accepted' ? transaction.id : null,
          transactions: [...ledger.transactions, transaction].slice(-128) };
        try { persist(next); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      } else {
        // Reconfirm durable storage before replaying a charging authorization.
        try { persist(ledger); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      }
      response = { transactionId: transaction.id, idTagInfo: { status: transaction.status } };
    } else if (action === 'StopTransaction') {
      if (!stateReady) { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      const stoppedAt = instant(payload.timestamp), transaction = ledger.transactions.find(row => row.id === payload.transactionId);
      if (!transaction || transaction.status !== 'Accepted' || !Number.isSafeInteger(payload.meterStop)
        || payload.meterStop < 0 || !Number.isSafeInteger(stoppedAt)
        || stoppedAt < transaction.startedAt || stoppedAt > clock()) {
        send([4, id, 'PropertyConstraintViolation', 'Unknown or invalid transaction end', {}]); return;
      }
      const fingerprint = digest({ scope, id: transaction.id, stoppedAt, meterStop: payload.meterStop });
      if (transaction.stopFingerprint && transaction.stopFingerprint !== fingerprint) {
        send([4, id, 'ProtocolError', 'Conflicting transaction end', {}]); return;
      }
      const next = { ...ledger, activeId: ledger.activeId === transaction.id ? null : ledger.activeId,
        transactions: ledger.transactions.map(row => row.id === transaction.id
          ? { ...row, stoppedAt, meterStop: payload.meterStop, stopFingerprint: fingerprint } : row) };
      try { persist(next); } catch { send([4, id, 'InternalError', 'Transaction storage unavailable', {}]); return; }
      response = {};
    } else if (['StatusNotification', 'DiagnosticsStatusNotification', 'FirmwareStatusNotification'].includes(action)) response = {};
    else { send([4, id, 'NotSupported', 'Unsupported action', {}]); return; }
    const reply = [3, id, response];
    replies.set(id, { requestHash, reply }); if (replies.size > 128) replies.delete(replies.keys().next().value);
    send(reply);
    if (action === 'BootNotification') {
      configurationFailures.clear();
      call('ChangeConfiguration', { key: 'MeterValuesSampledData', value: 'Power.Active.Import,Current.Import,Voltage' });
      call('ChangeConfiguration', { key: 'MeterValuesAlignedData', value: 'Power.Active.Import,Current.Import,Voltage' });
      call('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '30' });
      call('ChangeConfiguration', { key: 'ClockAlignedDataInterval', value: '30' });
      call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 });
    }
  }
  return {
    async start() {
      if (!configured || closed || server) return;
      if (!state?.get || !state?.set) { error = 'transaction-state-unavailable'; return; }
      try {
        const saved = state.get();
        if (saved !== null && saved !== undefined && !validLedger(saved)) { error = 'incompatible-transaction-state'; return; }
        ledger = saved ?? { version: 1, scope, nextId: randomInt(1, 1000000000), latestStartAt: 0, activeId: null, transactions: [] };
        stateReady = true; persist(ledger);
      } catch { error = 'transaction-state-unavailable'; return; }
      server = createServer((_request, response) => { response.writeHead(404); response.end(); });
      sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024,
        handleProtocols: protocols => protocols.has('ocpp1.6') ? 'ocpp1.6' : false });
      server.on('upgrade', (request, stream, head) => {
        const expected = `Basic ${Buffer.from(`${identity}:${config.password}`).toString('base64')}`;
        if (closed || !canControl() || request.url !== `/ocpp/${encodeURIComponent(identity)}`
          || !equal(String(request.headers.authorization ?? ''), expected)
          || !String(request.headers['sec-websocket-protocol'] ?? '').split(',').some(value => value.trim() === 'ocpp1.6')
          || socket?.readyState === 1) { stream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
        sockets.handleUpgrade(request, stream, head, connection => {
          reset(); socket = connection; error = null;
          socket.on('message', (data, binary) => { if (socket === connection) receive(data, binary); });
          socket.on('error', () => {});
          socket.on('close', () => { if (socket === connection) { socket = null; reset(); } });
        });
      });
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
        server.on('error', () => { error = 'listener-unavailable'; });
        timer = setInterval(() => {
          if (!canControl() || lastMessageAt !== null && clock() - lastMessageAt > MAX_AGE_MS * 2) socket?.terminate();
        }, 15_000); timer.unref();
      } catch { error = 'listener-unavailable'; }
    },
    snapshot() {
      if (!canControl() || !booted || socket?.readyState !== 1 || lastMessageAt === null || clock() - lastMessageAt > MAX_AGE_MS) return null;
      const rows = [...values.values()].filter(row => row.value !== null && clock() - instant(row.timestamp) <= MAX_AGE_MS && instant(row.timestamp) <= clock());
      const power = rows.find(row => row.id === 120);
      if (!power || power.value > 0 && ![183, 184, 185].every(id => rows.some(row => row.id === id))) return null;
      return [...rows, { id: 250, value: true, timestamp: new Date(lastMessageAt).toISOString() }];
    },
    status() { return { configured, connected: booted && socket?.readyState === 1, available: Boolean(this.snapshot()),
      error, lastMessageAt, configurationFailures: [...configurationFailures],
      pendingConfiguration: [...pendingCalls.values()].filter(call => call.action === 'ChangeConfiguration').map(call => call.key),
      controlTransport: 'cloud' }; },
    async close() {
      closed = true; clearInterval(timer); socket?.terminate();
      for (const client of sockets?.clients ?? []) client.terminate();
      if (server?.listening) await new Promise(resolve => server.close(resolve));
      sockets?.close(); reset();
    },
  };
}
