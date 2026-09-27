import { GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO } from '../domain/history-series.js';
import { applyGarageEntry, garageCorrectionContext, garageInput, garageDigest } from '../garage/learning.js';
import { GARAGE_ALGORITHM_VERSION, garageModelSummary } from '../garage/model.js';

const finite = Number.isFinite, caches = new WeakMap(), MAX_EVENTS = 25_000;
const validC = value => finite(value) && value >= -60 && value <= 65;
const source = input => input === 'simulated' ? 'Garage simulation' : input === 'offline' ? 'Imported garage history' : 'Recorded garage inputs';
function decode(row) {
  return { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
    configVersion: JSON.parse(row.config_version), forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version),
    payload: JSON.parse(row.payload) };
}

/** Original normalized inputs, not today's readings or corrected model values. */
function inputs({ store, range, now, input, envelopes, selected, stats }) {
  const previous = new Map();
  for (const row of store.db.prepare(`SELECT * FROM learning_journal WHERE input=? AND kind='sample'
    AND at>=? AND at<=? ORDER BY at,id`).iterate(garageInput(input), range.from - 600_000, Math.min(range.to, now))) {
    const reject = reason => { stats[reason]++; for (const key of selected) envelopes[key].add(row.at, null); };
    let entry;
    try { entry = decode(row); } catch { reject('invalidRecords'); continue; }
    if (entry.algorithmVersion !== GARAGE_ALGORITHM_VERSION) { reject('unsupportedRecords'); continue; }
    const value = entry.payload?.value, settings = entry.payload?.settings;
    if (!value || !settings || entry.configVersion !== garageDigest(settings) || !finite(value.at) || value.at > now) { reject('invalidRecords'); continue; }
    stats.inputRecords++;
    for (const key of selected) {
      const info = GARAGE_INPUT_INFO[key], field = info.field;
      // The normalized runtime contract accepts ambient weather for 30 minutes;
      // its age is independent of the two fast protection-sensor deadlines.
      const maxAge = info.location === 'outdoor' ? 30 * 60_000 : settings.maxSensorAgeMs ?? 120_000;
      const fresh = location => finite(value[`${location}At`]) && value[`${location}At`] <= value.at
        && value.at - value[`${location}At`] < (location === 'outdoor' ? 30 * 60_000 : settings.maxSensorAgeMs ?? 120_000)
        && value[`${location}Usable`] !== false && value[`${location}Retained`] !== true;
      let y = value[field];
      if (info.location && (!fresh(info.location) || !validC(y))) y = null;
      if (field === 'differenceC') y = fresh('front') && fresh('rear') && validC(value.frontC) && validC(value.rearC)
        ? value.frontC - value.rearC : null;
      if (field === 'available' || field === 'activity' || field.endsWith('Active')) y = typeof y === 'boolean' ? Number(y) : y;
      if ((field === 'activity' || field.endsWith('Active')) && !(finite(y) && y >= 0 && y <= 1)) y = null;
      if (field === 'powerKw' && (!['verified', 'provisional', 'simulated'].includes(value.powerQuality)
        || !(finite(y) && y >= 0 && y <= 8))) y = null;
      if (/^ev[12]Kw$/.test(field) && !(finite(y) && y >= 0 && y <= 50)) y = null;
      const before = previous.get(key), at = Math.max(range.from, row.at);
      if (before && row.at - before.at > maxAge) envelopes[key].add(before.at + 1, null);
      if (row.at >= range.from) envelopes[key].add(at, finite(y) ? y : null, { modelInput: true, garageModelInput: true,
        inputQualified: finite(y), algorithmVersion: row.algorithm_version,
        inputSource: source(input), observedAt: info.location ? value[`${info.location}At`] : value.at,
        ...(field === 'outdoorC' ? { outdoorSource: ['husdata-h66', 'fmi', 'openmeteo', 'mqtt-temperature', 'shelly-mqtt', 'simulation', 'garage-adapter'].includes(value.outdoorSource) ? value.outdoorSource : 'unknown' } : {}) });
      previous.set(key, { at: row.at });
    }
  }
}

/** Incremental shared replay, bounded to four source/correction checkpoints. The same
 * pure entry operation powers runtime rebuilding. Old prefixes require their
 * own seed and algorithm; invalid dependencies create explicit chart gaps. */
function coefficients({ store, range, now, input, envelopes, selected, stats }) {
  const through = Math.min(range.to, now), context = garageCorrectionContext(store, input);
  const bounds = store.db.prepare(`SELECT MAX(id) lastId, MIN(CASE WHEN at>? THEN id END) futureId
    FROM learning_journal WHERE input=?`).get(through, garageInput(input));
  const lastId = bounds.futureId === null ? bounds.lastId ?? 0 : bounds.futureId - 1;
  let cache = caches.get(store.db);
  if (!cache) { cache = new Map(); caches.set(store.db, cache); }
  const epoch = store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(garageInput(input))?.epoch ?? 'original';
  const keys = Object.keys(GARAGE_COEFFICIENT_INFO);
  const cacheKey = `${input}:${epoch}:${context.revision}`, old = cache.get(cacheKey);
  let state = old && old.lastId <= lastId && selected.every(key => !old.truncated[key] || old.events[key][0]?.at <= range.from) ? old
    : { checkpoint: null, lastId: 0, at: -Infinity, blocked: true,
      events: Object.fromEntries(keys.map(key => [key, []])), truncated: {},
      records: 0, unsupportedRecords: 0, invalidRecords: 0 };
  const projections = Object.fromEntries(selected.map(key => {
    let previous = null, started = false;
    const envelope = envelopes[key];
    const add = (at, event) => envelope.add(at, event?.value ?? null, event?.value === null || !event ? undefined : {
      modelCoefficient: true, coefficientStatus: event.status, modelUpdatedAt: event.updatedAt,
      inputSource: source(input), algorithmVersion: GARAGE_ALGORITHM_VERSION,
      coefficientBasis: event.basis, evidenceHours: event.evidence, correctionRevision: context.revision });
    const project = event => {
      if (event.at < range.from) { previous = event; return; }
      if (!started && event.at > range.from) add(range.from, previous);
      if (event.at > range.from) add(event.at - 1, previous);
      add(event.at, event); previous = event; started = true;
    };
    for (const event of state.events[key]) project(event);
    return [key, { project, finish() { if (previous) { if (!started) add(range.from, previous); add(through, previous); } } }];
  }));
  const emit = summary => {
    for (const key of keys) {
      const info = GARAGE_COEFFICIENT_INFO[key];
      const value = summary?.coefficients[info.location]?.find(coefficient => coefficient.name === info.parameter);
      const events = state.events[key], previous = events.at(-1);
      const status = value?.basis === 'observed-normal-power' ? 'observed' : value?.basis?.startsWith('fitted') ? 'fitted' : value?.basis?.startsWith('retained') ? 'retained'
        : value?.basis === 'fixed-prior' && info.fixed ? 'fixed-prior' : 'initial';
      if (previous && previous.value === (value?.value ?? null) && previous.status === status) continue;
      const event = { at: state.at, value: value?.value ?? null, status, basis: value?.basis,
        updatedAt: state.at, evidence: value?.evidence ?? 0 };
      events.push(event); projections[key]?.project(event);
      if (events.length > MAX_EVENTS) { events.splice(0, 1000); state.truncated[key] = true; }
    }
  };
  for (const row of store.db.prepare('SELECT * FROM learning_journal WHERE input=? AND id>? AND id<=? ORDER BY id')
    .iterate(garageInput(input), state.lastId, lastId)) {
    state.at = Math.max(state.at, row.at); state.records++; state.lastId = row.id;
    if (row.algorithm_version !== GARAGE_ALGORITHM_VERSION) {
      state.unsupportedRecords++; state.blocked = true; state.checkpoint = null; emit(null); continue;
    }
    try {
      const entry = decode(row);
      if (state.blocked && !entry.payload?.seed) { state.invalidRecords++; emit(null); continue; }
      state.checkpoint = applyGarageEntry(state.blocked ? null : state.checkpoint, entry, context); state.blocked = false;
      emit(garageModelSummary(state.checkpoint.model));
    } catch { state.invalidRecords++; state.blocked = true; state.checkpoint = null; emit(null); }
  }
  for (const projection of Object.values(projections)) projection.finish();
  stats.replayedRecords += state.records; stats.unsupportedRecords += state.unsupportedRecords; stats.invalidRecords += state.invalidRecords;
  cache.delete(cacheKey);
  while (cache.size >= 4) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, state);
}

export function addGarageHistory(args) {
  const { envelopes } = args;
  const inputKeys = Object.keys(GARAGE_INPUT_INFO).filter(key => envelopes[key]);
  const coefficientKeys = Object.keys(GARAGE_COEFFICIENT_INFO).filter(key => envelopes[key]);
  const stats = { inputRecords: 0, replayedRecords: 0, unsupportedRecords: 0, invalidRecords: 0,
    basis: 'original-garage-inputs-and-versioned-read-only-replay' };
  if (Math.min(args.now, args.range.to) < args.range.from) return stats;
  if (inputKeys.length) inputs({ ...args, selected: inputKeys, stats });
  if (coefficientKeys.length) coefficients({ ...args, selected: coefficientKeys, stats });
  return stats;
}
