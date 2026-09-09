// Reproducible incremental-storage measurement using invented data only.
// Every SQLite file is temporary and deleted. No application configuration,
// household database, raw observation, or control-status snapshot is loaded.
import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { appendLearningRecord, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { fireplaceLearningContext, withFireplaceInputs } from '../src/app/fireplace-inputs.js';
import { CycleTracker } from '../src/app/cycles.js';
import { FIREPLACE_HORIZON_MS } from '../src/domain/fireplace.js';
import { initialAdaptiveModel, updateAdaptiveLearningBatch, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';

const days = Number(process.argv[2] ?? 365);
if (!Number.isInteger(days) || days < 16 || days > 365) throw new Error('Use: node scripts/benchmark-fireplace-storage.js [16..365 days]');
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WINDOW = 15 * MINUTE;
const start = Date.UTC(2026, 0, 1), end = start + days * DAY;
const directory = mkdtempSync(join(tmpdir(), 'stmq-invented-fireplace-storage-'));
const paths = Object.fromEntries(['current', 'logged', 'legacy'].map(name => [name, join(directory, `${name}.sqlite`)]));
const stores = [];
const open = name => { const store = new Store(paths[name] ?? join(directory, `${name}.sqlite`)); stores.push(store); return store; };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function compact(store) {
  store.db.exec('VACUUM');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return statSync(store.path).size;
}
function journalSummary(store) {
  const hash = createHash('sha256'); let rows = 0, payloadBytes = 0, fireFields = 0;
  for (const row of store.db.prepare('SELECT * FROM learning_journal ORDER BY id').iterate()) {
    hash.update(JSON.stringify(row)); rows++; payloadBytes += Buffer.byteLength(row.payload);
    if (/"fireplace[A-Z]/.test(row.payload)) fireFields++;
  }
  return { rows, payloadBytes, fireFields, digest: hash.digest('hex') };
}
function sample(index) {
  const timestamp = start + (index + 1) * WINDOW, windowStart = timestamp - WINDOW;
  const input = { outdoorC: -5, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied', targetC: 21,
    roomBoostC: 0, compressorDuty: 0.5, thermalCompressorDuty: 0.5, auxKw: 0, thermalAuxKw: 0,
    powerKw: 1.54, actualModeKnown: true };
  return { timestamp, windowStart, windowEnd: timestamp, durationHours: 0.25, indoorC: 21,
    ...input, energyBasis: 'estimated', quality: [], intervalInputs: input,
    inputSegments: [0, 1, 2].map(part => ({ ...input, start: windowStart + part * 5 * MINUTE,
      end: windowStart + (part + 1) * 5 * MINUTE, durationHours: 1 / 12 })),
    provenance: { basis: 'committed-history', observations: [index * 3 + 1, index * 3 + 2, index * 3 + 3] } };
}
function checkpoint(samples) {
  let cp = null;
  for (let i = 0; i < samples.length; i += 512)
    cp = updateAdaptiveLearningBatch(cp, samples.slice(i, i + 512), { now: end });
  // One illustrative eight-hour completed cycle per day. Use the real archive
  // retention path; original five-minute segment boundaries remain intact.
  for (let day = days - 16; day < days; day++) cp = updateAdaptiveEpisode(cp, {
    id: `invented-cycle-${day}`, startedAt: start + day * DAY, endedAt: start + day * DAY + 8 * HOUR,
    complete: true, recoveryComplete: true, phases: ['normal', 'preheat', 'reduction', 'recovery'],
    energyBasis: 'estimated', recoveryHours: 2,
  });
  return cp;
}

// A real final CycleTracker payload gives the benchmark the actual observation
// and episode shapes. Annual copies change invented timestamps/IDs and the
// contemporaneous 120-hour event list; they do not simulate control accuracy.
function cycleTemplate(segmentMinutes, context) {
  const store = new Store(':memory:');
  try {
    const tracker = new CycleTracker({ store, input: 'mqtt' });
    tracker.fireplaceContext = context;
    const began = end - 12 * HOUR;
    const schedule = { preheatStart: began, preheatEnd: began, reductionStart: began,
      reductionEnd: began + 7 * HOUR, roomBoostC: 0 };
    const intervals = Array.from({ length: 32 }, (_, i) => ({ start: began + i * WINDOW, end: began + (i + 1) * WINDOW,
      outdoorC: 0, solarRadiationWm2: 0, price: 10 }));
    const plan = { model: initialAdaptiveModel(), initialState: { indoorC: 25, reserveC: 25 }, targetC: 21,
      schedule, reference: null, referenceLabel: 'continuous normal operation', occupancy: { mode: 'occupied' },
      maxDropC: 1, intervals, equipment: { fireplaceEvents: context.fireplaceEvents.filter(event =>
        event.at <= began && event.at + FIREPLACE_HORIZON_MS > began), fireplaceActive: true } };
    const reading = at => {
      const input = { outdoorC: 0, solarRadiationWm2: 0, phase: at <= schedule.reductionEnd ? 'reduction' : 'recovery',
        powerKw: 1.54, compressorDuty: 0.5, compressorPowerKw: 3, compressorActivityObserved: true,
        thermalCompressorDuty: 0.5, thermalAuxKw: 0, auxiliaryObserved: true, auxiliaryRouteKnown: true,
        auxKw: 0, auxRoute: null, energyBasis: 'estimated' };
      return withFireplaceInputs({ timestamp: at, windowStart: at - WINDOW, windowEnd: at,
        indoorC: 25, indoorTrendCPerHour: 0, ...input, intervalInputs: input,
        inputSegments: Array.from({ length: 15 / segmentMinutes }, (_, i) => ({ ...input,
          start: at - WINDOW + i * segmentMinutes * MINUTE, end: at - WINDOW + (i + 1) * segmentMinutes * MINUTE })),
        provenance: { basis: 'committed-history', observations: [1, 2, 3] } }, context);
    };
    tracker.start(plan, reading(began), began);
    let episode = null;
    for (let i = 1; i <= 32; i++) episode = tracker.record(reading(began + i * WINDOW), began + i * WINDOW) ?? episode;
    const cycle = store.cycles({ input: 'mqtt', limit: 1 })[0];
    if (cycle.status !== 'completed' || cycle.endedAt - cycle.startedAt !== 8 * HOUR || !episode)
      throw new Error('Invented cycle must finish at eight hours for storage measurement');
    return { cycle, episode };
  } finally { store.close(); }
}
const shiftDates = (value, delta) => Array.isArray(value) ? value.map(part => shiftDates(part, delta))
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, shiftDates(part, delta)]))
    : typeof value === 'number' && value > 1e12 && value < 2e12 ? value + delta : value;
const withoutNewFields = value => Array.isArray(value) ? value.map(withoutNewFields)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !key.startsWith('fireplace') && !['measurementAt', 'indoorEndpoint'].includes(key))
    .map(([key, part]) => [key, withoutNewFields(part)])) : value;

function annualCycles(segmentMinutes, sourceStore, context) {
  const control = open(`cycles-${segmentMinutes}-baseline`), logged = open(`cycles-${segmentMinutes}-logged`);
  const template = cycleTemplate(segmentMinutes, context);
  let cycleJsonIncrease = 0, episodeJsonIncrease = 0, markerBytes = 0, frozenEventsBytes = 0, lastSampleBytes = 0;
  let observationRows = 0, intermediateEndpoints = 0, measurementAtFields = 0;
  control.transaction(() => logged.transaction(() => {
    for (let day = 0; day < days; day++) for (const hour of [0, 12]) {
      const began = start + day * DAY + hour * HOUR, delta = began - template.cycle.startedAt;
      const cycle = shiftDates(template.cycle, delta), episode = shiftDates(template.episode, delta);
      cycle.id = episode.id = `mqtt:00000000-0000-4000-8000-${String(day * 2 + hour / 12).padStart(12, '0')}`;
      const known = fireplaceLearningContext(sourceStore, 'mqtt', undefined, began);
      cycle.plan.equipment.fireplaceEvents = known.fireplaceEvents.filter(event => event.at + FIREPLACE_HORIZON_MS > began);
      cycle.plan.equipment.fireplaceActive = cycle.plan.equipment.fireplaceEvents.length > 0;
      cycle.lastSample = withFireplaceInputs(withoutNewFields(cycle.lastSample), fireplaceLearningContext(sourceStore, 'mqtt', undefined, cycle.endedAt));
      // Retractions annotate affected annual cycle records, but never copy a
      // replacement observation tape into the immutable episode journal.
      if (context.fireplaceExcludedRanges.some(range => began < range.end && cycle.endedAt > range.start))
        cycle.fireplaceCorrectionRevision = context.fireplaceRevision;
      const before = withoutNewFields(cycle), priorEpisode = withoutNewFields(episode);
      priorEpisode.complete = true;
      if (priorEpisode.forecastValidation) priorEpisode.forecastValidation.eligible = true;
      control.cycle('mqtt', before); logged.cycle('mqtt', cycle);
      appendLearningRecord(control, 'mqtt', 'episode', priorEpisode);
      appendLearningRecord(logged, 'mqtt', 'episode', episode);
      cycleJsonIncrease += bytes(cycle) - bytes(before);
      episodeJsonIncrease += bytes(episode) - bytes(priorEpisode);
      frozenEventsBytes += bytes(cycle.plan.equipment) - bytes(before.plan.equipment);
      lastSampleBytes += bytes(cycle.lastSample) - bytes(before.lastSample);
      for (const row of cycle.observations) {
        observationRows++;
        measurementAtFields += Number(Object.hasOwn(row, 'measurementAt'));
        intermediateEndpoints += Number(row.indoorEndpoint === false);
        markerBytes += bytes(row) - bytes(withoutNewFields(row));
      }
    }
  }));
  const currentAlgorithmControlBytes = compact(control);
  control.transaction(() => control.db.prepare(`UPDATE learning_journal SET key=replace(key,?,?),algorithm_version=?`)
    .run(LEARNING_ALGORITHM, 'committed-house-v3', 'committed-house-v3'));
  const legacyBytes = compact(control), loggedBytes = compact(logged);
  return { cycles: days * 2, cycleHours: 8, recordIntervalMinutes: 15, inputSegmentMinutes: segmentMinutes,
    observationRows, measurementAtFields, intermediateEndpoints, endpointMarkerJsonBytes: markerBytes,
    frozenFireplaceEquipmentJsonBytes: frozenEventsBytes, lastSampleFireplaceJsonBytes: lastSampleBytes,
    cyclePayloadJsonIncreaseBytes: cycleJsonIncrease, immutableEpisodePayloadJsonIncreaseBytes: episodeJsonIncrease,
    cycleAndEpisodeSqliteIncreaseBytes: loggedBytes - currentAlgorithmControlBytes,
    episodeAlgorithmTagSqliteIncreaseBytes: currentAlgorithmControlBytes - legacyBytes,
    totalAnnualCycleSqliteIncreaseBytes: loggedBytes - legacyBytes };
}

try {
  const current = open('current');
  const sampleCount = days * 96;
  for (let day = 0; day < days; day++) current.transaction(() => {
    for (let i = day * 96; i < (day + 1) * 96; i++) appendLearningRecord(current, 'mqtt', 'sample', sample(i));
  });
  const currentJournalBytes = compact(current), journalBefore = journalSummary(current);
  // Closed WAL after checkpoint makes these synthetic copies self-contained.
  copyFileSync(paths.current, paths.logged); copyFileSync(paths.current, paths.legacy);
  const logged = open('logged'), legacy = open('legacy');
  // Counterfactual tag-length-only comparison. This temporary copy is neither
  // replayed nor published; genuine journal hashes are never rewritten.
  const priorAlgorithm = 'committed-house-v3';
  legacy.transaction(() => legacy.db.prepare(`UPDATE learning_journal
    SET key=replace(key,?,?),algorithm_version=?`).run(LEARNING_ALGORITHM, priorAlgorithm, priorAlgorithm));
  const legacyJournalBytes = compact(legacy);
  let loads = 0, removals = 0;
  logged.transaction(() => {
    for (let day = 0; day < days; day++) for (const hour of [6, 10, 16, 20]) {
      const at = start + day * DAY + hour * HOUR;
      // UUID-sized invented request IDs model browser-generated UUID storage.
      const requestId = `00000000-0000-4000-8000-${String(++loads).padStart(12, '0')}`;
      const added = addFireplace(logged, 'mqtt', { requestId, kg: 4 + loads % 5 }, at);
      if (loads % 10 === 0) {
        removeFireplace(logged, 'mqtt', { requestId: `00000000-0000-4000-9000-${String(loads).padStart(12, '0')}`, id: added.id }, at + MINUTE);
        removals++;
      }
    }
  });
  const eventAndJobBytes = compact(logged) - currentJournalBytes;
  const journalAfter = journalSummary(logged);
  if (JSON.stringify(journalBefore) !== JSON.stringify(journalAfter)) throw new Error('Synthetic fireplace edits changed the raw learning journal');
  const samples = Array.from({ length: 1536 }, (_, i) => sample(sampleCount - 1536 + i));
  const context = fireplaceLearningContext(logged, 'mqtt');
  const ordinary = checkpoint(samples), withFire = checkpoint(samples.map(value => withFireplaceInputs(value, context)));
  withFire.fireplaceRevision = context.fireplaceRevision;
  current.setState('adaptive:mqtt', ordinary); logged.setState('adaptive:mqtt', withFire);
  const noFireBytes = compact(current), withFireBytes = compact(logged);
  const checkpointIncrease = bytes(withFire) - bytes(ordinary);
  const archivedRows = withFire.episodeArchive.reduce((sum, episode) => sum + episode.samples.length, 0);
  const eventPayloadBytes = logged.db.prepare(`SELECT SUM(length(input)+length(request_id)+length(kind)) text_bytes,
    COUNT(*) rows FROM fireplace_events`).get();
  const cycleScenarios = [15, 5].map(minutes => annualCycles(minutes, logged, context));
  const existingIncrement = withFireBytes - noFireBytes + currentJournalBytes - legacyJournalBytes;
  console.log(JSON.stringify({ synthetic: true, days, assumptions: {
    inputStreams: 1, loadsPerDay: 4, removedFraction: 0.1, requestIdCharacters: 36,
    retainedJournalIntervalMinutes: 15, retainedInputSegmentMinutes: 5,
    checkpointSamples: 1536, illustrativeCycleHours: 8,
  }, observed: {
    loads, removals, eventRows: eventPayloadBytes.rows, retainedJournalRows: sampleCount,
    unchangedJournalPayloadBytes: journalAfter.payloadBytes, journalRowsWithFireplacePayloadFields: journalAfter.fireFields,
    rawJournalUnchanged: journalBefore.digest === journalAfter.digest,
    eventAndJobSqliteBytes: eventAndJobBytes,
    checkpointJsonBytesWithoutLoggedFires: bytes(ordinary), checkpointJsonBytesWithLoggedFires: bytes(withFire),
    checkpointJsonIncreaseBytes: checkpointIncrease, archivedCycles: withFire.episodeArchive.length, archivedSampleCopies: archivedRows,
    eventAndCheckpointSqliteIncreaseBytes: withFireBytes - noFireBytes,
    algorithmTagOnlySqliteIncreaseBytes: currentJournalBytes - legacyJournalBytes,
    subtotalBeforeAnnualCyclesBytes: existingIncrement,
  }, annualCycleScenarios: cycleScenarios.map(scenario => ({ ...scenario,
    totalFirstYearIncrementIncludingEventsCheckpointAndAllJournalTagsBytes: existingIncrement + scenario.totalAnnualCycleSqliteIncreaseBytes,
  })), retention: {
    events: 'Append-only loads and removal records; table and both indexes included in SQLite differences.',
    checkpoint: 'One overwritten adaptive state, not one snapshot per log or sample; rolling samples and episode archive retain full input segments.',
    chartCaches: 'RAM only: coefficient replay cache up to 16 MiB and 4 entries; outer chart cache up to 32 MiB and 16 entries. No annual disk growth.',
    worker: 'Candidate checkpoint remains in RAM until atomic replacement; durable rebuild intent is one overwritten state row.',
    annualCycles: 'All 730 completed cycle records and separate compact episode journal entries retained at original resolution. Cycle archive is distinct from the bounded checkpoint episode sample cache. Only the active cycle also occupies an overwritten state row.',
  }, limitations: 'Incremental synthetic disk allocation after VACUUM and WAL truncation, not live WAL size, write amplification, total household storage, or a worst-case bound. Existing raw observations/forecasts are unchanged and excluded. Annual cycles use the current CycleTracker serialized shape; comparison strips only new fields, preserving other content/numeric lengths. Episode boolean eligibility and algorithm tags are counted separately; neither episode carries a duplicate observation tape. Checkpoint fit outcomes and segment/cycle density change retained bytes. Algorithm tag comparison changes only tag text in a disposable copy, not a runnable legacy database.' }, null, 2));
} finally {
  for (const store of stores) store.close();
  rmSync(directory, { recursive: true, force: true });
}
