import { GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO, GARAGE_OUTCOME_INFO } from '../domain/history-series.js';
import { applyGarageEntry, garageCorrectionContext, garageInput, garageDigest } from '../garage/learning.js';
import { GARAGE_ALGORITHM_VERSION, garageModelSummary } from '../garage/model.js';

const finite = Number.isFinite, caches = new WeakMap(), MAX_EVENTS = 25_000;
const validC = value => finite(value) && value >= -60 && value <= 65;
const source = input => input === 'simulated' ? 'Garage simulation' : input === 'offline' ? 'Imported garage history' : 'Recorded garage inputs';
const replayOutcomes = Object.keys(GARAGE_OUTCOME_INFO).filter(key => GARAGE_OUTCOME_INFO[key].outcome !== 'benefit');
const electricityBases = new Set(['qualified-recorded-electricity', 'recorded-and-modeled-electricity', 'modeled-native-electricity']);
function decode(row) {
  return { id: row.id, key: row.key, kind: row.kind, at: row.at, algorithmVersion: row.algorithm_version,
    configVersion: JSON.parse(row.config_version), forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version),
    payload: JSON.parse(row.payload) };
}

/** Original normalized inputs, not today's readings or corrected model values. */
function inputs({ store, range, now, input, envelopes, selected, stats }) {
  const previous = new Map();
  const queryFrom = Math.min(range.from - 600_000, ...selected.map(key => envelopes[key].contextFrom ?? range.from));
  const queryTo = Math.min(now, Math.max(range.to, ...selected.map(key => envelopes[key].contextTo ?? range.to)));
  for (const row of store.db.prepare(`SELECT * FROM learning_journal WHERE input=? AND kind='sample'
    AND at>=? AND at<=? ORDER BY at,id`).iterate(garageInput(input), queryFrom, queryTo)) {
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
      // These saved states are booleans. Missing or malformed state must not be
      // inferred from electrical input, compressor activity or recovery status.
      if (field === 'available' || field === 'managedPause') y = typeof y === 'boolean' ? Number(y) : null;
      if (field === 'activity' || field.endsWith('Active')) y = typeof y === 'boolean' ? Number(y) : y;
      if ((field === 'activity' || field.endsWith('Active')) && !(finite(y) && y >= 0 && y <= 1)) y = null;
      if (field === 'powerKw' && (!['verified', 'provisional', 'simulated'].includes(value.powerQuality)
        || !(finite(y) && y >= 0 && y <= 8))) y = null;
      if (/^ev[12]Kw$/.test(field) && !(finite(y) && y >= 0 && y <= 50)) y = null;
      const before = previous.get(key), from = envelopes[key].contextFrom ?? range.from;
      if (before && row.at - before.at > maxAge) envelopes[key].add(before.at + 1, null,
        { displayBoundary: true, sampleBoundary: true });
      if (row.at >= from) envelopes[key].add(row.at, finite(y) ? y : null, { modelInput: true, garageModelInput: true,
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
function replay({ store, range, referenceRange = range, now, input, envelopes, selected, stats }) {
  const references = selected.filter(key => GARAGE_OUTCOME_INFO[key]?.outcome === 'reference');
  // A fitted reference may stay unchanged much longer than a sensor freshness
  // window. Use the selected dates, not a three-hour cutoff, to find its real
  // neighbouring updates. TemperatureEnvelope retains at most eight knots per
  // side, and the shared replay/event cache keeps its existing size bound.
  for (const key of references) if (finite(envelopes[key].contextFrom)) {
    envelopes[key].contextFrom = referenceRange.from;
    envelopes[key].contextTo = Math.min(referenceRange.to, now);
  }
  const through = Math.min(now, references.length ? Math.max(range.to, referenceRange.to) : range.to);
  const context = garageCorrectionContext(store, input);
  const bounds = store.db.prepare(`SELECT MAX(id) lastId, MIN(CASE WHEN at>? THEN id END) futureId
    FROM learning_journal WHERE input=?`).get(through, garageInput(input));
  const lastId = bounds.futureId === null ? bounds.lastId ?? 0 : bounds.futureId - 1;
  let cache = caches.get(store.db);
  if (!cache) { cache = new Map(); caches.set(store.db, cache); }
  const epoch = store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(garageInput(input))?.epoch ?? 'original';
  const keys = [...Object.keys(GARAGE_COEFFICIENT_INFO), ...replayOutcomes];
  const cacheKey = `${input}:${epoch}:${context.revision}`, old = cache.get(cacheKey);
  let state = old && old.lastId <= lastId && selected.every(key => !old.truncated[key]
    || old.events[key][0]?.at <= (GARAGE_OUTCOME_INFO[key]?.outcome === 'reference' ? envelopes[key].contextFrom ?? range.from : range.from)) ? old
    : { checkpoint: null, lastId: 0, at: -Infinity, blocked: true,
      events: Object.fromEntries(keys.map(key => [key, []])), truncated: {},
      records: 0, unsupportedRecords: 0, invalidRecords: 0 };
  const projections = Object.fromEntries(selected.map(key => {
    let previous = null, started = false;
    const envelope = envelopes[key];
    const reference = GARAGE_OUTCOME_INFO[key]?.outcome === 'reference';
    const from = reference ? envelope.contextFrom ?? range.from : range.from;
    const to = Math.min(now, reference ? envelope.contextTo ?? range.to : range.to);
    const add = (at, event) => envelope.add(at, event?.value ?? null, event?.value === null || !event ? undefined : {
      ...(GARAGE_OUTCOME_INFO[key] ? { modelOutcome: true, outcomeBasis: event.basis, evidenceCount: event.count }
        : { modelCoefficient: true, coefficientStatus: event.status, coefficientBasis: event.basis }),
      modelUpdatedAt: event.updatedAt, inputSource: source(input), algorithmVersion: GARAGE_ALGORITHM_VERSION,
      evidenceHours: event.evidence, correctionRevision: context.revision });
    const project = event => {
      if (event.at > to) return;
      if (event.at < from) { previous = event; return; }
      if (!started && event.at > from) add(from, previous);
      // Temperature references use the original model-update knots. Only an
      // explicit reset/gap needs the preceding known endpoint; injecting old
      // values before every finite update would turn a cubic into stair steps.
      if (event.at > from && (!reference || event.value === null && previous?.value !== null)) add(event.at - 1, previous);
      add(event.at, event); previous = event; started = true;
    };
    for (const event of state.events[key]) project(event);
    return [key, { project, finish() { if (previous) { if (!started) add(from, previous); add(to, previous); } } }];
  }));
  const emit = summary => {
    const holdouts = state.checkpoint?.model.validation.episodes.filter(episode => episode.role === 'validation' && episode.clean) ?? [];
    for (const key of keys) {
      const info = GARAGE_COEFFICIENT_INFO[key], outcome = GARAGE_OUTCOME_INFO[key];
      let value = info ? summary?.coefficients[info.location]?.find(coefficient => coefficient.name === info.parameter) : null;
      if (outcome?.outcome === 'reference') {
        const reference = summary?.normalReference, temperature = reference?.[`${outcome.location}C`];
        value = { value: reference?.initialized === true && validC(temperature) ? temperature : null,
          basis: 'continuously-available-achieved-reference',
          count: Number.isSafeInteger(reference?.samples) && reference.samples >= 0 ? reference.samples : 0,
          evidence: finite(reference?.qualifiedHours) && reference.qualifiedHours >= 0 ? reference.qualifiedHours : 0 };
      } else if (outcome?.outcome === 'error') {
        const error = summary?.validation?.[outcome.location === 'rear' ? 'offRearRmse' : 'offFrontRmse'];
        value = { value: holdouts.length && finite(error) && error >= 0 ? error : null,
          basis: 'rolling-clean-held-out-off-episode-rmse', count: holdouts.length,
          evidence: holdouts.reduce((hours, episode) => hours + (finite(episode.offHours) && episode.offHours > 0 ? episode.offHours : 0), 0) };
      }
      const events = state.events[key], previous = events.at(-1);
      const status = value?.basis === 'observed-normal-power' ? 'observed' : value?.basis?.startsWith('fitted') ? 'fitted' : value?.basis?.startsWith('retained') ? 'retained'
        : value?.basis === 'fixed-prior' && info?.fixed ? 'fixed-prior' : 'initial';
      if (previous && previous.value === (value?.value ?? null) && previous.status === status
        && (!outcome || previous.basis === value?.basis && previous.count === value?.count && previous.evidence === value?.evidence)) continue;
      const event = { at: state.at, value: value?.value ?? null, status, basis: value?.basis,
        updatedAt: state.at, evidence: value?.evidence ?? 0, ...(outcome ? { count: value?.count ?? 0 } : {}) };
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

/** Frozen episode assessments are independent events, never a carried rolling
 * estimate. Extract only compact public fields; payloads contain private native
 * identities and frozen observation/model tapes that are not chart data. */
function benefits({ store, range, now, input, envelopes, stats }) {
  const numeric = field => `CASE WHEN json_type(data,'$.assessment.${field}') IN ('integer','real')
    THEN json_extract(data,'$.assessment.${field}') END`;
  const query = `WITH selected AS (
    SELECT started_at,ended_at,CASE WHEN json_valid(payload) THEN payload ELSE '{}' END data
    FROM learning_cycles WHERE input=? AND status='completed' AND ended_at>=? AND ended_at<? AND ended_at<=?
    ORDER BY ended_at,started_at
  ) SELECT started_at,ended_at,${numeric('profitCents')} profit,${numeric('uncertaintyCents')} uncertainty,
    ${numeric('referenceCostCents')} referenceCost,${numeric('actualCostCents')} actualCost,
    json_extract(data,'$.assessment.electricityBasis') electricityBasis
    FROM selected WHERE json_extract(data,'$.algorithmVersion')=?
      AND json_extract(data,'$.assessment.algorithmVersion')=?
      AND json_extract(data,'$.assessment.stage')='completed'
      AND json_extract(data,'$.assessment.basis')='garage-frozen-normal-reference'
      AND json_type(data,'$.assessment.includesGarageOnly')='true'
    ORDER BY ended_at,started_at`;
  for (const row of store.db.prepare(query).iterate(garageInput(input), range.from, range.to, now,
    GARAGE_ALGORITHM_VERSION, GARAGE_ALGORITHM_VERSION)) {
    if (!Number.isSafeInteger(row.started_at) || row.started_at < 0 || !Number.isSafeInteger(row.ended_at)
      || row.ended_at <= row.started_at || !finite(row.profit)) continue;
    envelopes.garage_outcome_benefit.add(row.ended_at, row.profit / 100, {
      modelOutcome: true, outcomeBasis: 'garage-frozen-normal-reference', provisional: true,
      algorithmVersion: GARAGE_ALGORITHM_VERSION, inputSource: source(input),
      intervalStart: row.started_at, intervalEnd: row.ended_at,
      ...(electricityBases.has(row.electricityBasis) ? { electricityBasis: row.electricityBasis } : {}),
      ...(finite(row.uncertainty) && row.uncertainty >= 0 ? { uncertaintyEuro: row.uncertainty / 100 } : {}),
      ...(finite(row.referenceCost) ? { referenceCostEuro: row.referenceCost / 100 } : {}),
      ...(finite(row.actualCost) ? { actualCostEuro: row.actualCost / 100 } : {}),
    });
    stats.assessmentRecords++;
  }
}

export function addGarageHistory(args) {
  const { envelopes } = args;
  const inputKeys = Object.keys(GARAGE_INPUT_INFO).filter(key => envelopes[key]);
  const replayKeys = [...Object.keys(GARAGE_COEFFICIENT_INFO), ...replayOutcomes].filter(key => envelopes[key]);
  const stats = { inputRecords: 0, replayedRecords: 0, assessmentRecords: 0, unsupportedRecords: 0, invalidRecords: 0,
    basis: 'original-garage-inputs-and-versioned-read-only-replay' };
  if (Math.min(args.now, args.range.to) < args.range.from) return stats;
  if (inputKeys.length) inputs({ ...args, selected: inputKeys, stats });
  if (replayKeys.length) replay({ ...args, selected: replayKeys, stats });
  if (envelopes.garage_outcome_benefit) benefits({ ...args, stats });
  return stats;
}
