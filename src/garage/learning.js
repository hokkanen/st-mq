import { createHash } from 'node:crypto';
import { createGarageModel, updateGarageModel, GARAGE_ALGORITHM_VERSION } from './model.js';
import { garageSettings } from './settings.js';
import { sensorChangeEvents } from '../app/sensor-inputs.js';

export const garageInput = input => `garage:${input}`;
export function garageDigest(value) {
  const ordered = object => Array.isArray(object) ? object.map(ordered) : object && typeof object === 'object'
    ? Object.fromEntries(Object.keys(object).sort().map(key => [key, ordered(object[key])])) : object;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
export function garageCorrectionContext(store, input) {
  const changes = sensorChangeEvents(store, input).filter(row => ['garage_temperature', 'garage_temperature_2', 'outdoor_temperature'].includes(row.signal))
    .map(({ id, at, signal, settleUntil, revertedAt }) => ({ id, at, signal, settleUntil, revertedAt })).sort((a, b) => a.id - b.id);
  return { changes, revision: garageDigest(changes) };
}
export function garageCheckpointDigest(checkpoint) {
  const { digest, ...value } = checkpoint;
  return garageDigest(value);
}
export function garageJournalHead(store, input) {
  return store.db.prepare('SELECT MAX(id) id FROM learning_journal WHERE input=? AND algorithm_version=?')
    .get(garageInput(input), GARAGE_ALGORITHM_VERSION).id ?? 0;
}
export function validGarageCheckpoint(checkpoint, entry, context) {
  return checkpoint?.algorithmVersion === GARAGE_ALGORITHM_VERSION && checkpoint.correctionRevision === context.revision
    && checkpoint.digest === garageCheckpointDigest(checkpoint) && checkpoint.cursor === entry?.id
    && checkpoint.entryDigest === garageDigest(entry);
}

/** A resolved normalized sample is the source. Corrections project eligibility;
 * they never rewrite observations, journal payloads, or original forecasts. */
export function applyGarageEntry(checkpoint, entry, context = { changes: [], revision: garageDigest([]) }) {
  if (entry.algorithmVersion !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage learning algorithm');
  if (!['sample', 'context'].includes(entry.kind)) throw new Error('Unsupported Garage journal entry kind');
  const { settings, seed, value } = entry.payload;
  garageSettings(settings);
  if (seed && seed.algorithm !== GARAGE_ALGORITHM_VERSION) throw new Error('Unsupported garage seed algorithm');
  if (entry.configVersion !== garageDigest(settings)) throw new Error('Garage journal configuration checksum failed');
  if (checkpoint && entry.id <= checkpoint.cursor) throw new Error('Garage journal must be replayed in order');
  let model = structuredClone(checkpoint?.model ?? seed);
  if (!model) throw new Error('Garage journal has no initial seed');
  if (entry.kind === 'sample') {
    const observation = structuredClone(value);
    for (const [signal, key, timeKey] of [['garage_temperature', 'rearC', 'rearAt'],
      ['garage_temperature_2', 'frontC', 'frontAt'], ['outdoor_temperature', 'outdoorC', 'outdoorAt']]) {
      const boundary = context.changes.filter(change => change.signal === signal && change.revertedAt === null && change.at <= observation.at).at(-1);
      if (boundary && (observation.at < boundary.settleUntil || observation[timeKey] < boundary.at)) observation[key] = null;
    }
    model = updateGarageModel(model, observation, settings);
  } else if (entry.kind === 'context') {
    const change = context.changes.find(change => change.id === value.sensorChangeId);
    if (change && change.revertedAt === null || value.baselineChanged === true)
      model = createGarageModel({ seedAt: entry.at, baselineC: settings.baselineC });
    else if (value.normalReferenceReset === true) {
      const fresh = createGarageModel({ seedAt: entry.at, baselineC: settings.baselineC });
      model.normalReference = fresh.normalReference;
      model.native = fresh.native; model.nativeActivity = fresh.nativeActivity;
      model.heldOut.native = fresh.heldOut.native;
      model.previous = null; model.intervalDisturbed = false;
      const active = model.validation.active;
      if (active) model.validation.episodes = [...model.validation.episodes, {
        id: active.id, role: active.role, startedAt: active.startedAt, endedAt: entry.at,
        offHours: active.offHours, recoveryHours: active.recoveryHours, complete: false,
        clean: false, metered: active.metered, reason: 'normal-reference-reset',
      }].slice(-24);
      model.validation.active = null; model.validation.previousAvailable = null;
    }
  }
  const next = { algorithmVersion: GARAGE_ALGORITHM_VERSION, model, cursor: entry.id,
    configVersion: entry.configVersion, correctionRevision: context.revision,
    entryDigest: garageDigest(entry), journalDigest: garageDigest({ previous: checkpoint?.journalDigest ?? null, entry }),
    lastSampleAt: entry.kind === 'sample' ? value.at : checkpoint?.lastSampleAt ?? null };
  next.digest = garageCheckpointDigest(next);
  return next;
}

export function appendGarageEntry(store, input, kind, value, settings, at, { key, seed } = {}) {
  const configuration = garageSettings(settings);
  const first = !garageJournalHead(store, input);
  const id = store.appendLearningJournal(garageInput(input), { kind, at, key,
    algorithmVersion: GARAGE_ALGORITHM_VERSION, configVersion: garageDigest(configuration),
    payload: { settings: configuration, value, ...(first ? { seed: seed ?? createGarageModel({ seedAt: at, baselineC: configuration.baselineC }) } : {}) } });
  return store.learningJournal({ input: garageInput(input), after: id - 1, limit: 1, algorithmVersion: GARAGE_ALGORITHM_VERSION })[0];
}

export function replayGarageJournal(store, input, { checkpoint = null, context = garageCorrectionContext(store, input), limit = Infinity } = {}) {
  let next = checkpoint, processed = 0;
  while (processed < limit) {
    const rows = store.learningJournal({ input: garageInput(input), after: next?.cursor ?? 0,
      limit: Math.min(128, limit - processed), algorithmVersion: GARAGE_ALGORITHM_VERSION });
    for (const entry of rows) next = applyGarageEntry(next, entry, context);
    processed += rows.length;
    if (rows.length < Math.min(128, limit - processed + rows.length)) break;
  }
  return next;
}
