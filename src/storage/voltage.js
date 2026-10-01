// Voltage is a slowly changing forecast input, never a substitute for a live
// electrical measurement. Raw acquisitions update bounded restart state; only
// the recorder's published approximation is exposed to historical consumers.
export const VOLTAGE_VERSION = 'voltage-ewma-v1';
export const VOLTAGE_HALF_LIFE_MS = 6 * 3600000;
export const VOLTAGE_MATURITY_MS = 3600000;
export const VOLTAGE_MAX_GAP_MS = 5 * 60000;
export const VOLTAGE_RECORDING_FLOOR_V = 0.5;
export const VOLTAGE_SIGNALS = Object.freeze([1, 2, 3].map(phase => `voltage_estimate_l${phase}`));
const validVoltage = value => Number.isFinite(value) && value >= 200 && value <= 250;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const stateKey = input => `voltage:estimate:${input}`;
const slots = ['property', 'ev1', 'ev2'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validPolicy = policy => object(policy) && Object.keys(policy).length === 3 && slots.every(slot =>
  policy[slot] === null || object(policy[slot]) && Object.keys(policy[slot]).sort().join(',') === 'device,mapping,source'
    && ['source', 'device', 'mapping'].every(key => typeof policy[slot][key] === 'string'));
const identity = observation => JSON.stringify([observation.source, observation.device]);
const empty = () => ({ version: VOLTAGE_VERSION, candidates: {}, published: [null, null, null] });
function restored(store, input) {
  const state = store.getState(stateKey(input));
  if (state != null) {
    const candidateFields = ['identity', 'source', 'device', 'mean', 'coverageMs', 'sourceTime', 'receivedAt',
      'reporting', 'lastValue', 'validUntil', 'evidenceBasis', 'evidenceAt'];
    const validCandidate = (key, row) => /^(property|ev1|ev2):[012]$/.test(key) && object(row)
      && Object.keys(row).every(field => candidateFields.includes(field))
      && typeof row.source === 'string' && typeof row.device === 'string' && row.device.length > 0
      && (input === 'simulated' ? row.source === 'simulation' : row.source === (key.startsWith('ev2:') ? 'shelly-evse' : 'easee'))
      && row.identity === identity(row) && (row.mean === null || validVoltage(row.mean))
      && Number.isSafeInteger(row.coverageMs) && row.coverageMs >= 0
      && (row.sourceTime === null || validTime(row.sourceTime)) && validTime(row.receivedAt)
      && (row.sourceTime === null || row.sourceTime <= row.receivedAt)
      && typeof row.reporting === 'boolean' && (row.lastValue === null || validVoltage(row.lastValue))
      && (row.validUntil === null || validTime(row.validUntil))
      && (row.evidenceAt === null || validTime(row.evidenceAt) && row.evidenceAt <= row.receivedAt)
      && [null, 'source-report', 'held-with-device-telemetry'].includes(row.evidenceBasis)
      && (row.mean === null ? row.sourceTime === null && row.lastValue === null && row.coverageMs === 0
        && row.evidenceAt === null && row.validUntil === null && row.evidenceBasis === null
        : row.sourceTime !== null && row.lastValue !== null && row.evidenceAt !== null && row.validUntil !== null && row.evidenceBasis !== null)
      && (!row.reporting || row.mean !== null && row.sourceTime !== null && row.validUntil >= row.receivedAt);
    const validPublished = (row, phase) => row === null || object(row) && row.source === 'voltage-estimate'
      && row.device === input && row.signal === VOLTAGE_SIGNALS[phase] && row.unit === 'V'
      && validTime(row.sourceTime) && row.sourceTime === row.receivedAt && Array.isArray(row.quality)
      && row.quality.includes('estimated') && row.quality.every(flag => ['estimated', 'insufficient-coverage', 'unavailable'].includes(flag))
      && object(row.raw) && row.raw.voltageEstimate?.version === VOLTAGE_VERSION
      && row.raw.voltageEstimate.phase === phase + 1 && typeof row.raw.voltageMature === 'boolean'
      && row.raw.voltageEstimate.halfLifeMs === VOLTAGE_HALF_LIFE_MS
      && Number.isSafeInteger(row.raw.voltageEstimate.coverageMs) && row.raw.voltageEstimate.coverageMs >= 0
      && (row.raw.voltageEstimate.lastObservedAt === null || validTime(row.raw.voltageEstimate.lastObservedAt)
        && row.raw.voltageEstimate.lastObservedAt <= row.receivedAt)
      && typeof row.raw.voltageSource === 'string' && ['reporting', 'held'].includes(row.raw.voltageAvailability)
      && (row.raw.voltageMature ? validVoltage(row.value) && row.raw.voltageEstimate.coverageMs >= VOLTAGE_MATURITY_MS : row.value === null);
    if (!object(state) || Object.keys(state).some(key => !['version', 'candidates', 'published', 'sourcePolicy'].includes(key))
      || state.version !== VOLTAGE_VERSION || !object(state.candidates)
      || state.sourcePolicy !== undefined && !validPolicy(state.sourcePolicy)
      || !Object.entries(state.candidates).every(([key, row]) => validCandidate(key, row))
      || !Array.isArray(state.published) || state.published.length !== 3 || !state.published.every(validPublished))
      throw new Error('Unsupported voltage estimate state; start a fresh development database');
  }
  return state ?? empty();
}
function inputSlot(observation, input) {
  const match = /^(property|ev1|ev2)_voltage_l([123])$/.exec(observation?.signal ?? '');
  if (!match) return null;
  if (input === 'simulated' ? observation.source !== 'simulation'
    : !(['property', 'ev1'].includes(match[1]) && observation.source === 'easee'
      || match[1] === 'ev2' && observation.source === 'shelly-evse')) return null;
  // Charger terminal-pair readings are not phase-to-neutral observations.
  const mapped = observation.raw?.voltageMapping === 'phase-neutral';
  if (!mapped && observation.value !== null) return null;
  return { slot: match[1], phase: Number(match[2]) - 1, mapped };
}
/** Only source measurement clocks establish continued device telemetry. HTTP
 * receipt, meter counters and another physical device cannot renew it. */
export function voltageTelemetryAt(rows, observation, now) {
  const times = rows.filter(row => row.source === observation.source && row.device === observation.device
    && /^(?:property|ev1)_(?:voltage_l[123]|current_l[123]|active_power)$/.test(row.signal)
    && row.unit === (row.signal.includes('_voltage_') ? 'V' : row.signal.includes('_current_') ? 'A' : 'kW')
    && Number.isFinite(row.value) && validTime(row.sourceTime) && row.sourceTime <= now
    && !row.raw?.retained && !row.raw?.cached && (row.quality ?? []).every(flag => ['good', 'stale', 'duplicate_observation', 'local_ocpp',
      'current_snapshot_not_energy', 'asynchronous_snapshot', 'all_zero_property_current', 'ev_exceeds_property_current'].includes(flag)))
    .map(row => row.sourceTime);
  if (validTime(observation.raw?.deviceTelemetryAt) && observation.raw.deviceTelemetryAt <= now) times.push(observation.raw.deviceTelemetryAt);
  return times.length ? Math.max(...times) : null;
}
function sourceEvidence(o, now, telemetryAt, telemetryMaxAgeMs) {
  const connection = o.raw?.deviceConnection;
  const confirmed = connection?.connected === true && validTime(connection.observedAt) && connection.observedAt <= now
    && validTime(telemetryAt) && telemetryAt <= now && now - telemetryAt <= telemetryMaxAgeMs;
  const fresh = now - o.sourceTime <= VOLTAGE_MAX_GAP_MS;
  const valid = o.unit === 'V' && validVoltage(o.value) && validTime(o.sourceTime) && validTime(o.receivedAt)
    && o.sourceTime <= o.receivedAt && o.receivedAt <= now && (fresh || confirmed)
    && !o.raw?.retained && !o.raw?.cached && o.raw?.deviceConnection?.connected !== false
    && (o.quality ?? []).every(flag => ['good', 'simulated', 'duplicate_observation', 'local_ocpp', ...(confirmed ? ['stale'] : [])].includes(flag));
  return valid ? { basis: fresh ? 'source-report' : 'held-with-device-telemetry',
    observedAt: Math.max(o.sourceTime, confirmed ? telemetryAt : 0),
    validUntil: Math.max(o.sourceTime + VOLTAGE_MAX_GAP_MS, confirmed ? telemetryAt + telemetryMaxAgeMs : 0) } : null;
}

export class VoltageEstimator {
  constructor(store, { recorder, input, clock = Date.now, telemetryMaxAgeMs = 17 * 60000, sourcePolicy }) {
    this.store = store; this.recorder = recorder; this.input = input; this.clock = clock;
    this.telemetryMaxAgeMs = telemetryMaxAgeMs;
    restored(store, input);
    this.sourcePolicy = sourcePolicy;
    if (sourcePolicy) this.reconcileSources(sourcePolicy);
  }
  reconcileSources(policy) {
    if (!validPolicy(policy)) throw new TypeError('Invalid voltage source policy');
    const state = restored(this.store, this.input), changed = new Set();
    for (const slot of slots) if (JSON.stringify(state.sourcePolicy?.[slot]) !== JSON.stringify(policy[slot])) {
      for (let phase = 0; phase < 3; phase++) {
        if (state.candidates[`${slot}:${phase}`]) { delete state.candidates[`${slot}:${phase}`]; changed.add(phase); }
      }
    }
    state.sourcePolicy = policy;
    this.store.transaction(() => {
      for (const phase of changed) this.publish(state, phase, this.clock());
      this.store.setState(stateKey(this.input), state);
    });
    this.sourcePolicy = policy;
  }
  ingest(observation, { telemetryAt = observation.raw?.deviceTelemetryAt } = {}) {
    const target = inputSlot(observation, this.input);
    if (!target) return false;
    if (this.sourcePolicy && (!this.sourcePolicy[target.slot]
      || identity(this.sourcePolicy[target.slot]) !== identity(observation))) return false;
    const now = this.clock(), o = { ...observation, receivedAt: observation.receivedAt ?? now };
    if (!validTime(o.receivedAt) || o.receivedAt > now) return false;
    return this.store.transaction(() => {
      const state = restored(this.store, this.input), key = `${target.slot}:${target.phase}`;
      let candidate = state.candidates[key];
      if (!target.mapped && (!candidate || candidate.identity !== identity(o))) return false;
      if (candidate && o.receivedAt < candidate.receivedAt) return false;
      if (!candidate || candidate.identity !== identity(o)) candidate = state.candidates[key] = {
        identity: identity(o), source: o.source, device: o.device, mean: null, coverageMs: 0,
        sourceTime: null, receivedAt: null, reporting: false, lastValue: null, validUntil: null, evidenceBasis: null, evidenceAt: null,
      };
      const evidence = sourceEvidence(o, now, telemetryAt, this.telemetryMaxAgeMs);
      // A genuinely confirmed unchanged value covers elapsed time, never one
      // extra sample per poll. Old/conflicting source clocks remain rejected.
      if (evidence && candidate.sourceTime !== null && (o.sourceTime < candidate.sourceTime
        || o.sourceTime === candidate.sourceTime && o.value !== candidate.lastValue
        || !candidate.reporting && (evidence.observedAt <= candidate.evidenceAt || evidence.observedAt < candidate.receivedAt)
        || o.receivedAt <= candidate.receivedAt)) return false;
      if (evidence) {
        const dt = candidate.reporting && o.receivedAt <= candidate.validUntil
          && o.receivedAt - candidate.receivedAt <= VOLTAGE_MAX_GAP_MS ? o.receivedAt - candidate.receivedAt : 0;
        if (candidate.mean === null) candidate.mean = o.value;
        else if (dt > 0) candidate.mean += -Math.expm1(-Math.LN2 * dt / VOLTAGE_HALF_LIFE_MS) * (o.value - candidate.mean);
        candidate.coverageMs += dt;
        candidate.sourceTime = o.sourceTime; candidate.lastValue = o.value;
        candidate.validUntil = evidence.validUntil; candidate.evidenceBasis = evidence.basis; candidate.evidenceAt = evidence.observedAt;
      }
      candidate.reporting = Boolean(evidence); candidate.receivedAt = o.receivedAt;
      this.publish(state, target.phase, now);
      this.store.setState(stateKey(this.input), state);
      return true;
    });
  }
  interrupt({ source, devices, now = this.clock() }) {
    const state = restored(this.store, this.input), phases = new Set();
    for (const [key, candidate] of Object.entries(state.candidates)) {
      if (candidate.source !== source || !devices.includes(candidate.device) || now < candidate.receivedAt) continue;
      candidate.reporting = false; candidate.receivedAt = now; phases.add(Number(key.at(-1)));
    }
    if (!phases.size) return;
    this.store.transaction(() => {
      for (const phase of phases) this.publish(state, phase, now);
      this.store.setState(stateKey(this.input), state);
    });
  }
  publish(state, phase, now) {
    const candidates = slots.map(slot => ({ ...state.candidates[`${slot}:${phase}`], slot }))
      .filter(candidate => candidate.identity);
    // Keep a formed estimate through outages. Prefer the supply meter once it
    // has sufficient coverage; do not switch locations for every missing poll.
    const chosen = candidates.find(candidate => candidate.coverageMs >= VOLTAGE_MATURITY_MS)
      ?? candidates[0];
    if (!chosen && !state.published[phase]) return;
    const mature = Boolean(chosen && chosen.coverageMs >= VOLTAGE_MATURITY_MS);
    const reporting = chosen?.reporting && now <= chosen.validUntil;
    const availability = reporting ? 'reporting' : 'held';
    const result = this.recorder.record({ source: 'voltage-estimate', device: this.input,
      signal: VOLTAGE_SIGNALS[phase], value: mature ? chosen.mean : null, unit: 'V',
      sourceTime: now, receivedAt: now, quality: mature ? ['estimated'] : ['estimated', 'insufficient-coverage'],
      raw: { basis: 'time-weighted-voltage-estimate', voltageSource: chosen?.identity ?? 'source-unconfigured',
        voltageMature: mature, voltageAvailability: availability,
        voltageEstimate: { version: VOLTAGE_VERSION, phase: phase + 1, source: chosen?.source ?? null,
          device: chosen?.device ?? null, halfLifeMs: VOLTAGE_HALF_LIFE_MS, coverageMs: chosen?.coverageMs ?? 0,
          lastObservedAt: chosen?.sourceTime ?? null, evidenceBasis: chosen?.evidenceBasis ?? null } } });
    if (result.saved) state.published[phase] = result.observation;
  }
  tick(now = this.clock()) {
    const state = restored(this.store, this.input);
    const expired = [0, 1, 2].filter(phase => {
      const published = state.published[phase];
      const candidate = slots.map(slot => state.candidates[`${slot}:${phase}`])
        .find(row => row?.identity === published?.raw?.voltageSource);
      return published?.raw?.voltageAvailability === 'reporting' && now > (candidate?.validUntil ?? 0);
    });
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const phase of expired) this.publish(state, phase, now);
      this.store.setState(stateKey(this.input), state);
    });
  }
}

function decoded(row, retrospective = false) {
  if (!row) return null;
  const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
  const quality = typeof row.quality === 'string' ? JSON.parse(row.quality) : row.quality;
  const valid = Array.isArray(quality) && quality.every(flag => ['estimated', 'good', 'simulated'].includes(flag));
  return { value: valid && raw?.voltageMature === true && validVoltage(row.value) ? row.value : null,
    at: Math.max(row.source_time ?? row.sourceTime, row.received_at ?? row.receivedAt), receivedAt: row.received_at ?? row.receivedAt,
    mature: raw?.voltageMature === true, source: raw?.voltageSource ?? null,
    availability: raw?.voltageAvailability ?? null, retrospective,
    coverageMs: raw?.voltageEstimate?.coverageMs ?? null,
    lastObservedAt: raw?.voltageEstimate?.lastObservedAt ?? null, evidenceBasis: raw?.voltageEstimate?.evidenceBasis ?? null };
}
function resultOf(phases) {
  const voltageV = phases.map(phase => phase?.value ?? null);
  return { voltageV, available: voltageV.every(validVoltage), phases,
    basis: phases.some(phase => phase?.retrospective) ? 'retrospective-voltage-estimate'
      : voltageV.some(validVoltage) ? 'recorded-voltage-estimate' : 'voltage-estimate-unavailable' };
}

/** Bounded point lookups, cached only for this reader. Source and receipt cutoffs
 * both apply, including to the explicit CSV retrospective fallback. */
export function createVoltageReader(store, { input = 'live', now = Date.now() } = {}) {
  const scope = input === 'simulated' ? "device='simulated'" : "device IN ('mqtt','providers','live')";
  const where = `source='voltage-estimate' AND ${scope} AND unit='V' AND received_at<=?`;
  const availableAt = 'MAX(source_time,received_at)';
  const before = store.db.prepare(`SELECT *,${availableAt} AS available_at FROM observations WHERE ${where} AND signal=?
    AND source_time<=? ORDER BY available_at DESC,id DESC LIMIT 1`);
  const first = store.db.prepare(`SELECT * FROM observations WHERE ${where} AND signal=?
    AND source_time<=? AND value BETWEEN 200 AND 250 AND json_extract(raw,'$.voltageMature')=1
    AND NOT EXISTS (SELECT 1 FROM json_each(observations.quality) WHERE value NOT IN ('estimated','good','simulated'))
    ORDER BY ${availableAt},id LIMIT 1`);
  const next = store.db.prepare(`SELECT ${availableAt} AS available_at FROM observations WHERE ${where} AND signal=?
    AND ${availableAt}>? AND source_time<=? ORDER BY available_at,id LIMIT 1`);
  const cached = [null, null, null], firstRows = [undefined, undefined, undefined];
  const lookup = (at, { allowFuture = false } = {}) => {
    if (!validTime(at) || at > now) return resultOf([null, null, null]);
    const phases = VOLTAGE_SIGNALS.map((signal, phase) => {
      let cachedPhase = cached[phase];
      if (!cachedPhase || at < cachedPhase.from || at >= cachedPhase.to) {
        const row = before.get(Math.min(now, at), signal, at);
        cachedPhase = cached[phase] = { from: row?.available_at ?? 0,
          to: next.get(now, signal, at, now)?.available_at ?? Infinity, row: decoded(row) };
      }
      if (cachedPhase.row?.value !== null && cachedPhase.row != null) return cachedPhase.row;
      if (!allowFuture) return cachedPhase.row;
      firstRows[phase] ??= { row: decoded(first.get(now, signal, now), true) };
      const future = firstRows[phase].row;
      return future && at < future.at ? future : cachedPhase.row;
    });
    return resultOf(phases);
  };
  lookup.boundaries = function* (from, to) {
    if (cached.every(phase => phase && phase.from <= from && phase.to >= to)) return;
    // Stream large exports in bounded pages. Most adjacent energy intervals
    // stay inside the cached flat estimate and require no additional SQL.
    const query = store.db.prepare(`SELECT DISTINCT ${availableAt} AS at FROM observations WHERE ${where}
      AND signal IN ('voltage_estimate_l1','voltage_estimate_l2','voltage_estimate_l3')
      AND ${availableAt}>? AND ${availableAt}<? ORDER BY at LIMIT 1024`);
    let cursor = from;
    while (cursor < Math.min(to, now + 1)) {
      const rows = query.all(now, cursor, Math.min(to, now + 1));
      for (const row of rows) yield row.at;
      if (rows.length < 1024) return;
      cursor = rows.at(-1).at;
    }
  };
  return lookup;
}

export function readPlanningVoltage(store, { input, now = Date.now() }) {
  const state = restored(store, input);
  if ((state.sourcePolicy || state.published.some(Boolean)) && state.published.every(row => row == null || row.receivedAt <= now))
    return resultOf(state.published.map(row => decoded(row)));
  return store.db ? createVoltageReader(store, { input, now })(now) : resultOf([null, null, null]);
}
