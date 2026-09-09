import { MODEL_COEFFICIENT_INFO } from '../domain/history-series.js';
import { applyLearningRecord, LEARNING_ALGORITHM } from './committed-learning.js';

const sources = { simulated: 'Simulation', history: 'Imported history', mqtt: 'Recorded MQTT inputs', providers: 'Recorded provider inputs' };
// Derived timelines and resumable replay state stay private to this connection.
// Neither configuration nor checkpoints enter chart responses or the database.
const caches = new WeakMap();
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

function replay(store, input, through) {
  const bounds = store.db.prepare(`SELECT MAX(id) lastId,
    MIN(CASE WHEN at>? THEN id END) futureId FROM learning_journal WHERE input=?`).get(through, input);
  const lastId = bounds.futureId === null ? bounds.lastId ?? 0 : bounds.futureId - 1;
  let cache = caches.get(store.db);
  if (!cache) { cache = new Map(); caches.set(store.db, cache); }
  const key = JSON.stringify([input, lastId, LEARNING_ALGORITHM]);
  if (cache.has(key)) {
    const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit.result;
  }
  // Advancing the clock does not change an immutable journal prefix. New
  // entries resume its cached state instead of refitting all earlier samples.
  const base = [...cache.values()].filter(entry => entry.input === input && entry.lastId < lastId)
    .sort((a, b) => b.lastId - a.lastId)[0];
  const result = base ? { ...base.result, events: [...base.result.events] }
    : { events: [], records: 0, replayedRecords: 0, unsupportedRecords: 0, invalidRecords: 0 };
  let checkpoint = base?.checkpoint ?? null, at = base?.at ?? -Infinity, blocked = base?.blocked ?? true;
  const learned = new Set(base?.learned), fitted = new Set(base?.fitted);
  let previous = result.events.at(-1)?.coefficients;
  const emit = coefficients => {
    if (JSON.stringify(coefficients) === JSON.stringify(previous)) return;
    const event = { at, coefficients };
    if (result.events.at(-1)?.at === at) result.events[result.events.length - 1] = event;
    else result.events.push(event);
    previous = coefficients;
  };
  // A chronological view must retain journal order, including late episodes.
  // A later ID can depend on earlier IDs whose event timestamps are newer.
  // Stop at the first future entry instead of skipping it and using its tail.
  for (const row of store.db.prepare('SELECT * FROM learning_journal WHERE input=? AND id>? AND id<=? ORDER BY id')
    .iterate(input, base?.lastId ?? 0, lastId)) {
    at = Math.max(at, row.at);
    result.records++;
    if (row.algorithm_version !== LEARNING_ALGORITHM) {
      result.unsupportedRecords++; blocked = true; checkpoint = null; learned.clear(); fitted.clear(); emit(null); continue;
    }
    try {
      const entry = { id: row.id, key: row.key, kind: row.kind, at: row.at,
        algorithmVersion: row.algorithm_version,
        configVersion: row.config_version === null ? null : JSON.parse(row.config_version),
        forecastVersion: row.forecast_version === null ? null : JSON.parse(row.forecast_version),
        payload: JSON.parse(row.payload) };
      // Never silently restart a damaged prefix with today's defaults. A new
      // algorithm's explicit journal seed can establish an independent start.
      if (blocked && !Object.hasOwn(entry.payload ?? {}, 'seed')) {
        if (!result.invalidRecords && !result.unsupportedRecords) result.invalidRecords++;
        emit(null); continue;
      }
      const priorCheckpoint = blocked ? null : checkpoint;
      const next = applyLearningRecord(priorCheckpoint, entry);
      const validation = next.model.validation;
      const seeded = !priorCheckpoint || Boolean(entry.payload.value.historySeed?.model);
      const accepted = next.health?.acceptedFits > (priorCheckpoint?.health?.acceptedFits ?? 0)
        || next.model.trainedAt !== priorCheckpoint?.model?.trainedAt;
      if (seeded) { learned.clear(); fitted.clear(); }
      // Equipment changes can reset a coefficient while the model still carries
      // the previous validation object. That default has no fitted evidence.
      if (seeded || accepted) {
        fitted.clear();
        for (const parameter of validation?.accepted === true ? validation.fittedParameters ?? [] : []) {
          fitted.add(parameter); learned.add(parameter);
        }
      }
      const initial = priorCheckpoint ?? entry.payload.seed;
      const resetAuxiliary = initial?.learningConfiguration?.auxRatedKw !== undefined
        && initial.learningConfiguration.auxRatedKw !== entry.payload.configuration.auxRatedKw;
      const fittedAgain = next.health?.acceptedFits > (initial?.health?.acceptedFits ?? 0)
        && validation?.accepted === true && validation.fittedParameters?.includes('auxiliaryCPerKwh');
      if (resetAuxiliary && !entry.payload.value.historySeed?.model && !fittedAgain) {
        learned.delete('auxiliaryCPerKwh'); fitted.delete('auxiliaryCPerKwh');
      }
      checkpoint = next; blocked = false; result.replayedRecords++;
      const coefficients = Object.fromEntries(Object.entries(MODEL_COEFFICIENT_INFO).map(([key, info]) => {
        const value = next.model.parameters[info.parameter];
        const status = fitted.has(info.parameter) && next.health?.status !== 'retained-previous' ? 'fitted'
          : learned.has(info.parameter) ? 'retained' : 'initial';
        const prior = previous?.[key];
        return [key, { value: Number.isFinite(value) ? value : null, status,
          updatedAt: prior?.value === value ? prior.updatedAt : at }];
      }));
      emit(coefficients);
    } catch {
      // Configuration and payload parsing errors can contain private content.
      // Return a gap and counts only, and do not replay a dependent tail.
      result.invalidRecords++; blocked = true; checkpoint = null; learned.clear(); fitted.clear(); emit(null);
    }
  }
  const cached = { input, lastId, result, checkpoint, at, blocked, learned: [...learned], fitted: [...fitted] };
  const bytes = Buffer.byteLength(JSON.stringify(cached));
  if (bytes <= MAX_CACHE_BYTES) {
    let used = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (cache.size && (cache.size >= 4 || used + bytes > MAX_CACHE_BYTES)) {
      const first = cache.keys().next().value; used -= cache.get(first).bytes; cache.delete(first);
    }
    cache.set(key, { ...cached, bytes });
  }
  return result;
}

/** Derive accepted model states using only immutable journal entries. The
 * application's restart helper persists checkpoints; chart replay deliberately
 * calls its pure per-entry operation and never calls any store writer. */
export function addModelCoefficients({ store, range, now, input, envelopes }) {
  const selected = Object.keys(MODEL_COEFFICIENT_INFO).filter(key => envelopes[key]);
  const stats = { records: 0, replayedRecords: 0, unsupportedRecords: 0, invalidRecords: 0, basis: 'read-only-learning-replay' };
  const end = Math.min(range.to, now);
  if (!selected.length || end < range.from) return stats;
  const primary = input === 'offline' ? 'history' : input;
  const first = store.db.prepare('SELECT at FROM learning_journal WHERE input=? ORDER BY id LIMIT 1').get(primary);
  const streams = [];
  // Imported reconstruction precedes the selected live learner. Their states
  // remain independent: providers, MQTT and simulation never train one another.
  if (['providers', 'mqtt'].includes(primary) && (!first || first.at > range.from))
    streams.push({ input: 'history', through: Math.min(end, first ? first.at - 1 : end) });
  if (first && first.at <= end) streams.push({ input: primary, through: end, from: first.at });
  for (const stream of streams) {
    if (stream.through < range.from) continue;
    const replayed = replay(store, stream.input, stream.through);
    for (const key of ['records', 'replayedRecords', 'unsupportedRecords', 'invalidRecords']) stats[key] += replayed[key];
    const add = (at, event) => {
      for (const key of selected) {
        const coefficient = event?.coefficients?.[key];
        envelopes[key].add(at, coefficient?.value ?? null, coefficient ? {
          modelCoefficient: true, coefficientStatus: coefficient.status,
          modelUpdatedAt: coefficient.updatedAt, inputSource: sources[stream.input], algorithmVersion: LEARNING_ALGORITHM,
        } : undefined);
      }
    };
    let previous = null, started = false;
    const from = Math.max(range.from, stream.from ?? range.from);
    for (const event of replayed.events) {
      if (event.at < from) { previous = event; continue; }
      if (!started && event.at > from) add(from, previous);
      if (event.at > from) {
        // Preserve both sides of a change through display decimation.
        add(Math.max(from, event.at - 1), previous);
      }
      add(event.at, event); previous = event; started = true;
    }
    if (previous) {
      if (!started) add(from, previous);
      add(stream.through, previous);
    }
  }
  return stats;
}
