import { voltageInput, validVoltageProvenance } from '../domain/voltage-provenance.js';

// One slow planning estimate per installation phase. Candidate readings are
// bounded restart state, never a second raw-observation history.
export const VOLTAGE_VERSION = 'voltage-ewma-v3';
export const VOLTAGE_HALF_LIFE_MS = 6 * 3600000;
export const VOLTAGE_MAX_GAP_MS = 5 * 60000;
export const VOLTAGE_PREFERENCE_MS = 5 * 60000;
export const VOLTAGE_RECORDING_FLOOR_V = 0.5;
export const VOLTAGE_SIGNALS = Object.freeze([1, 2, 3].map(phase => `voltage_estimate_l${phase}`));
const validVoltage = value => Number.isFinite(value) && value >= 200 && value <= 250;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const stateKey = input => `voltage:estimate:${input}`;
const slots = ['property', 'ev1'];
const priorities = [1, 2, 4, 8];
const slotOf = input => input === 4 || input === 8 ? 'property' : 'ev1';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validPolicy = policy => object(policy) && Object.keys(policy).length === 2 && slots.every(slot =>
  policy[slot] === null || fields(policy[slot], ['source', 'device', 'mapping'])
    && ['source', 'device', 'mapping'].every(key => typeof policy[slot][key] === 'string'));
const identity = observation => JSON.stringify([observation.source, observation.device, observation.input]);
const phaseEmpty = () => ({ mean: null, coverageMs: 0, selected: null, lastUpdatedAt: null,
  lastObservedAt: null, input: 0, inputs: 0, source: null, device: null, evidenceBasis: null });
const empty = () => ({ version: VOLTAGE_VERSION, candidates: {}, phases: [phaseEmpty(), phaseEmpty(), phaseEmpty()], published: [null, null, null] });
const sourceFor = input => input === 8 ? 'simulation' : 'easee';
const reporting = (candidate, now) => candidate?.reporting === true && now <= candidate.validUntil;
function restored(store, input) {
  const state = store.getState(stateKey(input));
  if (state == null && store.db?.prepare('SELECT 1 FROM state WHERE key = ?').get(stateKey(input)))
    throw new Error('Unsupported voltage estimate state; start a fresh development database');
  if (state != null) {
    const validCandidate = (key, row) => /^(1|2|4|8):[012]$/.test(key)
      && fields(row, ['identity', 'source', 'device', 'input', 'sourceTime', 'receivedAt', 'reporting',
        'lastValue', 'validUntil', 'evidenceBasis', 'evidenceAt', 'healthyMs'])
      && row.input === Number(key.split(':')[0]) && row.source === sourceFor(row.input)
      && (input === 'simulated' ? row.input === 8 : row.input !== 8)
      && typeof row.device === 'string' && row.device.length > 0 && row.identity === identity(row)
      && (row.sourceTime === null || validTime(row.sourceTime) && row.sourceTime <= row.receivedAt)
      && validTime(row.receivedAt) && typeof row.reporting === 'boolean'
      && (row.lastValue === null || validVoltage(row.lastValue))
      && (row.validUntil === null || validTime(row.validUntil))
      && (row.evidenceAt === null || validTime(row.evidenceAt) && row.evidenceAt <= row.receivedAt)
      && Number.isSafeInteger(row.healthyMs) && row.healthyMs >= 0
      && [null, 'source-report', 'held-with-device-telemetry'].includes(row.evidenceBasis)
      && (row.sourceTime === null ? row.lastValue === null && row.evidenceAt === null && row.validUntil === null
        && row.evidenceBasis === null && row.healthyMs === 0
        : row.lastValue !== null && row.evidenceAt !== null && row.validUntil !== null && row.evidenceBasis !== null)
      && (!row.reporting || row.sourceTime !== null && row.validUntil >= row.receivedAt);
    const validPhase = (row, phase) => fields(row, Object.keys(phaseEmpty()))
      && (row.mean === null || validVoltage(row.mean)) && Number.isSafeInteger(row.coverageMs) && row.coverageMs >= 0
      && (row.selected === null || /^(1|2|4|8):[012]$/.test(row.selected)
        && row.selected.endsWith(`:${phase}`) && state.candidates[row.selected])
      && (row.lastUpdatedAt === null || validTime(row.lastUpdatedAt))
      && (row.lastObservedAt === null || validTime(row.lastObservedAt) && row.lastObservedAt <= row.lastUpdatedAt)
      && (row.mean === null ? row.coverageMs === 0 && row.input === 0 && row.inputs === 0
        && row.lastUpdatedAt === null && row.lastObservedAt === null && row.source === null && row.device === null && row.evidenceBasis === null
        : validVoltageProvenance(row) && (input === 'simulated' ? row.inputs === 8 : !(row.inputs & 8))
          && row.source === sourceFor(row.input) && typeof row.device === 'string' && row.device.length > 0
          && priorities.filter(code => row.inputs & code).every(code => state.candidates[`${code}:${phase}`])
          && state.candidates[`${row.input}:${phase}`]?.source === row.source
          && state.candidates[`${row.input}:${phase}`]?.device === row.device
          && row.lastUpdatedAt !== null && row.lastObservedAt !== null
          && ['source-report', 'held-with-device-telemetry'].includes(row.evidenceBasis));
    const validPublished = (row, phase) => row === null || object(row) && row.source === 'voltage-estimate'
      && row.device === input && row.signal === VOLTAGE_SIGNALS[phase] && row.unit === 'V'
      && validTime(row.sourceTime) && row.sourceTime === row.receivedAt && Array.isArray(row.quality)
      && row.quality.includes('estimated') && row.quality.every(flag => ['estimated', 'unavailable'].includes(flag))
      && fields(row.raw, ['basis', 'voltageSource', 'voltageAvailability', 'voltageEstimate', 'recorder'])
      && row.raw.basis === 'time-weighted-voltage-estimate' && row.raw.voltageEstimate?.version === VOLTAGE_VERSION
      && row.raw.voltageEstimate.phase === phase + 1
      && row.raw.voltageEstimate.halfLifeMs === VOLTAGE_HALF_LIFE_MS
      && Number.isSafeInteger(row.raw.voltageEstimate.coverageMs) && row.raw.voltageEstimate.coverageMs >= 0
      && (row.raw.voltageEstimate.lastObservedAt === null || validTime(row.raw.voltageEstimate.lastObservedAt)
        && row.raw.voltageEstimate.lastObservedAt <= row.receivedAt)
      && (row.raw.voltageEstimate.input === 0 && row.raw.voltageEstimate.inputs === 0 || validVoltageProvenance(row.raw.voltageEstimate))
      && typeof row.raw.voltageSource === 'string' && ['reporting', 'held'].includes(row.raw.voltageAvailability)
      && (row.value === null ? row.quality.includes('unavailable') && row.raw.voltageEstimate.input === 0
        && row.raw.voltageEstimate.inputs === 0 && row.raw.voltageEstimate.coverageMs === 0
        : validVoltage(row.value) && !row.quality.includes('unavailable') && validVoltageProvenance(row.raw.voltageEstimate));
    if (!object(state) || Object.keys(state).some(key => !['version', 'candidates', 'phases', 'published', 'sourcePolicy'].includes(key))
      || state.version !== VOLTAGE_VERSION || !object(state.candidates)
      || state.sourcePolicy !== undefined && !validPolicy(state.sourcePolicy)
      || !Object.entries(state.candidates).every(([key, row]) => validCandidate(key, row))
      || !Array.isArray(state.phases) || state.phases.length !== 3 || !state.phases.every(validPhase)
      || !Array.isArray(state.published) || state.published.length !== 3 || !state.published.every(validPublished))
      throw new Error('Unsupported voltage estimate state; start a fresh development database');
  }
  return state ?? empty();
}
export function validateVoltageState(store, input) { restored(store, input); }

function inputSlot(observation, scope) {
  const match = /^(property|ev1)_voltage_l([123])$/.exec(observation?.signal ?? '');
  if (!match) return null;
  const input = voltageInput(observation, scope);
  if (!input) return null;
  // Charger terminal-pair readings are not phase-to-neutral observations.
  const mapped = observation.raw?.voltageMapping === 'phase-neutral';
  if (!mapped && observation.value !== null) return null;
  return { slot: match[1], phase: Number(match[2]) - 1, mapped, input };
}
/** Only clocks from the same device AND transport establish continuing telemetry. */
export function voltageTelemetryAt(rows, observation, now) {
  const transport = observation.raw?.transport;
  const times = rows.filter(row => row.source === observation.source && row.device === observation.device
    && row.raw?.transport === transport
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
      const inputs = priorities.filter(code => slotOf(code) === slot);
      for (let phase = 0; phase < 3; phase++) {
        if (inputs.some(code => state.phases[phase].inputs & code || state.phases[phase].selected === `${code}:${phase}`)) {
          state.phases[phase] = phaseEmpty(); changed.add(phase);
        }
        for (const code of inputs) if (state.candidates[`${code}:${phase}`]) {
          delete state.candidates[`${code}:${phase}`]; changed.add(phase);
        }
      }
    }
    state.sourcePolicy = policy;
    this.store.transaction(() => {
      for (const phase of changed) {
        this.select(state, phase, this.clock()); this.publish(state, phase, this.clock());
      }
      this.store.setState(stateKey(this.input), state);
    });
    const previous = this.sourcePolicy;
    this.store.afterRollback(() => { this.sourcePolicy = previous; });
    this.sourcePolicy = policy;
  }
  ingest(observation, { telemetryAt = observation.raw?.deviceTelemetryAt } = {}) {
    const target = inputSlot(observation, this.input);
    if (!target) return false;
    if (this.sourcePolicy && (!this.sourcePolicy[target.slot]
      || this.sourcePolicy[target.slot].source !== observation.source || this.sourcePolicy[target.slot].device !== observation.device)) return false;
    const now = this.clock(), o = { ...observation, input: target.input, receivedAt: observation.receivedAt ?? now };
    if (!validTime(o.receivedAt) || o.receivedAt > now) return false;
    return this.store.transaction(() => {
      const state = restored(this.store, this.input), key = `${target.input}:${target.phase}`;
      let candidate = state.candidates[key];
      if (!target.mapped && (!candidate || candidate.identity !== identity(o))) return false;
      if (candidate && o.receivedAt < candidate.receivedAt) return false;
      if (!candidate || candidate.identity !== identity(o)) {
        if (candidate && state.phases[target.phase].inputs & target.input) state.phases[target.phase] = phaseEmpty();
        candidate = state.candidates[key] = { identity: identity(o), source: o.source, device: o.device, input: o.input,
          sourceTime: null, receivedAt: o.receivedAt, reporting: false, lastValue: null, validUntil: null,
          evidenceBasis: null, evidenceAt: null, healthyMs: 0 };
      }
      const evidence = sourceEvidence(o, now, telemetryAt, this.telemetryMaxAgeMs);
      // Duplicate source clocks can confirm elapsed coverage only inside their
      // original validity window or with genuine same-transport telemetry.
      if (evidence && candidate.sourceTime !== null && (o.sourceTime < candidate.sourceTime
        || o.sourceTime === candidate.sourceTime && o.value !== candidate.lastValue
        || !candidate.reporting && (evidence.observedAt <= candidate.evidenceAt || evidence.observedAt < candidate.receivedAt)
        || o.receivedAt <= candidate.receivedAt)) return false;
      const continuous = evidence && candidate.reporting && o.receivedAt <= candidate.validUntil
        && o.receivedAt - candidate.receivedAt <= VOLTAGE_MAX_GAP_MS;
      if (evidence) {
        candidate.healthyMs = continuous ? candidate.healthyMs + o.receivedAt - candidate.receivedAt : 0;
        candidate.sourceTime = o.sourceTime; candidate.lastValue = o.value;
        candidate.validUntil = evidence.validUntil; candidate.evidenceBasis = evidence.basis; candidate.evidenceAt = evidence.observedAt;
      } else candidate.healthyMs = 0;
      candidate.reporting = Boolean(evidence); candidate.receivedAt = o.receivedAt;
      const accumulator = state.phases[target.phase], selectedBefore = accumulator.selected;
      const replaceSeed = accumulator.coverageMs === 0 && accumulator.lastUpdatedAt === o.receivedAt
        && target.input < accumulator.input;
      this.select(state, target.phase, now);
      if (evidence && accumulator.selected === key) {
        const dt = selectedBefore === key && continuous && accumulator.lastUpdatedAt !== null
          && o.receivedAt >= accumulator.lastUpdatedAt ? o.receivedAt - accumulator.lastUpdatedAt : 0;
        if (accumulator.mean === null || dt > 0 || replaceSeed) {
          if (accumulator.mean === null || replaceSeed) accumulator.mean = o.value;
          else accumulator.mean += -Math.expm1(-Math.LN2 * dt / VOLTAGE_HALF_LIFE_MS) * (o.value - accumulator.mean);
          accumulator.coverageMs += dt; accumulator.inputs = replaceSeed ? target.input : accumulator.inputs | target.input; accumulator.input = target.input;
          accumulator.source = o.source; accumulator.device = o.device;
          accumulator.lastObservedAt = o.sourceTime; accumulator.evidenceBasis = evidence.basis;
        }
        accumulator.lastUpdatedAt = o.receivedAt;
      }
      this.publish(state, target.phase, now);
      this.store.setState(stateKey(this.input), state);
      return true;
    });
  }
  select(state, phase, now) {
    const accumulator = state.phases[phase];
    const candidates = priorities.map(input => `${input}:${phase}`).filter(key => reporting(state.candidates[key], now));
    const current = state.candidates[accumulator.selected], preferred = candidates[0];
    let selected = accumulator.selected;
    if (!reporting(current, now)) selected = preferred ?? selected;
    else if (preferred && state.candidates[preferred].input < current.input
      && (accumulator.coverageMs === 0 || state.candidates[preferred].healthyMs >= VOLTAGE_PREFERENCE_MS)) selected = preferred;
    if (selected !== accumulator.selected) {
      accumulator.selected = selected;
      if (accumulator.mean !== null) accumulator.lastUpdatedAt = now;
    }
  }
  interrupt({ source, devices, transport, now = this.clock() }) {
    const state = restored(this.store, this.input), phases = new Set();
    for (const [key, candidate] of Object.entries(state.candidates)) {
      if (candidate.source !== source || !devices.includes(candidate.device) || now < candidate.receivedAt
        || transport && (candidate.input === 1 ? 'ocpp' : 'cloud') !== transport) continue;
      candidate.reporting = false; candidate.receivedAt = now; candidate.healthyMs = 0; phases.add(Number(key.at(-1)));
    }
    if (!phases.size) return;
    this.store.transaction(() => {
      for (const phase of phases) { this.select(state, phase, now); this.publish(state, phase, now); }
      this.store.setState(stateKey(this.input), state);
    });
  }
  publish(state, phase, now) {
    const accumulator = state.phases[phase], chosen = state.candidates[accumulator.selected]
      ?? priorities.map(input => state.candidates[`${input}:${phase}`]).find(Boolean);
    if (!chosen && !state.published[phase]) return;
    const available = validVoltage(accumulator.mean);
    const result = this.recorder.record({ source: 'voltage-estimate', device: this.input,
      signal: VOLTAGE_SIGNALS[phase], value: accumulator.mean, unit: 'V',
      sourceTime: now, receivedAt: now, quality: available ? ['estimated'] : ['estimated', 'unavailable'],
      raw: { basis: 'time-weighted-voltage-estimate', voltageSource: chosen?.identity ?? 'source-unconfigured',
        voltageAvailability: reporting(chosen, now) ? 'reporting' : 'held',
        voltageEstimate: { version: VOLTAGE_VERSION, phase: phase + 1, source: accumulator.source,
          device: accumulator.device, halfLifeMs: VOLTAGE_HALF_LIFE_MS, coverageMs: accumulator.coverageMs,
          lastObservedAt: accumulator.lastObservedAt, lastUpdatedAt: accumulator.lastUpdatedAt,
          evidenceBasis: accumulator.evidenceBasis, input: accumulator.input, inputs: accumulator.inputs } } });
    if (result.saved) state.published[phase] = result.observation;
  }
  tick(now = this.clock()) {
    const state = restored(this.store, this.input);
    const changed = [0, 1, 2].filter(phase => {
      const published = state.published[phase], selected = state.phases[phase].selected;
      this.select(state, phase, now);
      return selected !== state.phases[phase].selected
        || published?.raw?.voltageAvailability === 'reporting' && !reporting(state.candidates[state.phases[phase].selected], now);
    });
    if (!changed.length) return;
    this.store.transaction(() => {
      for (const phase of changed) this.publish(state, phase, now);
      this.store.setState(stateKey(this.input), state);
    });
  }
}

export function voltageRecordingStatus(store, input, now = Date.now()) {
  const state = restored(store, input);
  return Object.fromEntries(VOLTAGE_SIGNALS.map((signal, phase) => {
    const row = state.phases[phase], selected = state.candidates[row.selected]
      ?? priorities.map(input => state.candidates[`${input}:${phase}`]).find(Boolean), active = reporting(selected, now);
    const available = validVoltage(row.mean);
    return [signal, { coverageMs: row.coverageMs, available, reporting: active, lastObservedAt: row.lastObservedAt,
      lastUpdatedAt: row.lastUpdatedAt, input: row.input, inputs: row.inputs,
      reason: !selected ? 'source-unconfigured' : !active ? 'source-unavailable' : 'reporting' }];
  }));
}

function decoded(row, retrospective = false) {
  if (!row) return null;
  const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
  const quality = typeof row.quality === 'string' ? JSON.parse(row.quality) : row.quality;
  const valid = raw?.voltageEstimate?.version === VOLTAGE_VERSION && !Object.hasOwn(raw, 'voltageMature')
    && validVoltageProvenance(raw.voltageEstimate)
    && Array.isArray(quality) && quality.every(flag => ['estimated', 'good', 'simulated'].includes(flag));
  return { value: valid && validVoltage(row.value) ? row.value : null,
    at: Math.max(row.source_time ?? row.sourceTime, row.received_at ?? row.receivedAt), receivedAt: row.received_at ?? row.receivedAt,
    source: raw?.voltageSource ?? null,
    availability: raw?.voltageAvailability ?? null, retrospective,
    coverageMs: raw?.voltageEstimate?.coverageMs ?? null,
    inputs: raw?.voltageEstimate?.inputs ?? null, input: raw?.voltageEstimate?.input ?? null,
    lastUpdatedAt: raw?.voltageEstimate?.lastUpdatedAt ?? null,
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
  const before = store.db.prepare(`SELECT *,${availableAt} AS available_at FROM active_observations AS observations WHERE ${where} AND signal=?
    AND source_time<=? ORDER BY available_at DESC,id DESC LIMIT 1`);
  const first = store.db.prepare(`SELECT * FROM active_observations AS observations WHERE ${where} AND signal=?
    AND source_time<=? AND value BETWEEN 200 AND 250 AND json_extract(raw,'$.voltageEstimate.version')='${VOLTAGE_VERSION}'
    AND json_type(raw,'$.voltageMature') IS NULL
    AND json_type(raw,'$.voltageEstimate.input')='integer' AND json_extract(raw,'$.voltageEstimate.input') IN (1,2,4,8)
    AND json_type(raw,'$.voltageEstimate.inputs')='integer' AND json_extract(raw,'$.voltageEstimate.inputs') BETWEEN 1 AND 15
    AND (json_extract(raw,'$.voltageEstimate.inputs') & json_extract(raw,'$.voltageEstimate.input'))=json_extract(raw,'$.voltageEstimate.input')
    AND (json_extract(raw,'$.voltageEstimate.inputs') & 8)=CASE WHEN json_extract(raw,'$.voltageEstimate.inputs')=8 THEN 8 ELSE 0 END
    AND NOT EXISTS (SELECT 1 FROM json_each(observations.quality) WHERE value NOT IN ('estimated','good','simulated'))
    ORDER BY ${availableAt},id LIMIT 1`);
  const next = store.db.prepare(`SELECT ${availableAt} AS available_at FROM active_observations AS observations WHERE ${where} AND signal=?
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
    const query = store.db.prepare(`SELECT DISTINCT ${availableAt} AS at FROM active_observations AS observations WHERE ${where}
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
