import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '../storage/store.js';
import { admittedReader, storageStep } from '../storage/worker-admission.js';
import { committedLearningSample, replayLearningJournalSteps } from './committed-learning.js';
import { evaluateThermalModel, restoreAdaptiveCheckpoint } from '../control/adaptive-learning.js';
import { withFireplaceInputs } from './fireplace-inputs.js';
import { takeImmutableValue } from '../domain/immutable.js';
import { coefficientProjectionAt, readCoefficientCoverage } from '../storage/coefficient-history.js';
import { emptyCoefficientProjection } from '../domain/coefficient-projection.js';

const PAGE = 128;
let store, checkpoint = null, sequence = 0, messages = Promise.resolve();
const acknowledgements = new Map();
const stage = (id, fields) => new Promise((resolve, reject) => {
  const requestId = ++sequence; acknowledgements.set(requestId, { resolve, reject });
  parentPort.postMessage({ ...fields, id, requestId });
});
async function replay(message) {
  if (message.checkpoint !== undefined) checkpoint = message.checkpoint;
  if ((checkpoint?.checkpointDigest ?? null) !== message.digest) throw new Error('Checkpoint ownership changed');
  if (!checkpoint) {
    try { checkpoint = store.getState(`adaptive:${workerData.input}`); }
    catch { checkpoint = null; }
  }
  checkpoint = takeImmutableValue(checkpoint);
  const through = store.learningJournalHead(workerData.input);
  if (!through) return { result: checkpoint = takeImmutableValue(restoreAdaptiveCheckpoint(null, message.options.config)) };
  const correction = store.getState(`fireplace:rebuild:${workerData.input}`), options = { ...message.options };
  if (checkpoint && ['pending', 'running', 'ready', 'failed'].includes(correction?.status)) {
    options.fireplaceRevision = checkpoint.fireplaceRevision ?? 0;
    options.sensorRevision = checkpoint.sensorRevision ?? 0;
  }
  const coverage = readCoefficientCoverage(store, { input: workerData.input });
  let source, batch, events = [], generation = null, stageProjection, same = false, reuseCursor = 0;
  const steps = replayLearningJournalSteps(store, workerData.input, checkpoint,
    { ...options, through, persistCheckpoint: false, pageSize: PAGE });
  for (;;) {
    const step = steps.next();
    if (step.done) { checkpoint = takeImmutableValue(step.value); break; }
    const page = step.value;
    if (!source) {
      source = { epoch: page.epoch, selection: page.selection,
        fireplaceRevision: page.fireplaceRevision, sensorRevision: page.sensorRevision,
        ...(page.reusedPrefixCursor === undefined ? {} : { reusedPrefixCursor: page.reusedPrefixCursor }) };
      same = Boolean(coverage && coverage.epoch === source.epoch
        && coverage.fireplaceRevision === source.fireplaceRevision && coverage.sensorRevision === source.sensorRevision);
      reuseCursor = same ? coverage.cursor : coverage && Number.isSafeInteger(page.reusedPrefixCursor)
        && page.reusedPrefixCursor <= coverage.cursor ? page.reusedPrefixCursor : 0;
      stageProjection = reuseCursor ? coefficientProjectionAt(store, { input: workerData.input,
        epoch: source.epoch, generation: coverage.generation, cursor: reuseCursor }) : emptyCoefficientProjection();
    }
    // Reconstructing the numerical checkpoint does not rewrite an already
    // committed coefficient prefix of the same interpretation.
    if (same && page.cursor <= coverage.cursor) continue;
    const added = reuseCursor ? page.events.filter(event => event.cursor > reuseCursor) : page.events;
    batch = { ...source, baseCursor: reuseCursor,
      cursor: page.cursor, throughAt: page.throughAt, projection: page.projection };
    if (!generation && events.length + added.length > PAGE) {
      generation = await stage(message.id, { type: 'coefficient-start', ...source,
        baseGeneration: coverage?.generation ?? null, prefixCursor: coverage?.cursor ?? 0,
        stagePrefixCursor: reuseCursor, projection: stageProjection });
      if (events.length) await stage(message.id, { type: 'coefficient-page', coefficientGeneration: generation,
        events, projection: events.at(-1).projection });
      events = [];
    }
    if (generation) await stage(message.id, { type: 'coefficient-page', coefficientGeneration: generation,
      events: added, projection: page.projection });
    else events.push(...added);
  }
  if (!batch) return { result: checkpoint };
  const coefficientBatch = generation ? { ...source, coefficientGeneration: generation,
    baseGeneration: coverage?.generation ?? null, prefixCursor: coverage?.cursor ?? 0, cursor: batch.cursor }
    : { ...batch, events };
  return { result: checkpoint, coefficientBatch };
}
async function calculate(message) {
  try {
    let answer;
    if (message.operation === 'replay') answer = await replay(message);
    else if (message.operation === 'sample') {
      store.db.exec('BEGIN');
      try { answer = { result: committedLearningSample({ ...message.options, store, input: workerData.input }) }; }
      finally { store.db.exec('ROLLBACK'); }
    } else if (message.operation === 'reserve') {
      const { checkpoint: value, context } = message.options;
      answer = { result: evaluateThermalModel(value.model, value.samples.map(row => withFireplaceInputs(row, context)),
        { rollout: false, observedOnly: false }).state?.reserveC ?? null };
    } else throw new Error('Unknown live learning operation');
    parentPort.postMessage({ type: 'result', id: message.id, ok: true, ...answer });
  } catch { parentPort.postMessage({ type: 'result', id: message.id, ok: false }); }
}
try {
  store = storageStep(() => new Store(workerData.dbPath, { readOnly: true }));
  store.db = admittedReader(store.db);
  if (store.checkpoint().databaseId !== workerData.databaseId) throw new Error('Database identity changed');
  parentPort.on('message', message => {
    if (message?.type === 'coefficient-ack') {
      const pending = acknowledgements.get(message.requestId); acknowledgements.delete(message.requestId);
      if (message.error) pending?.reject(new Error('Coefficient history staging failed'));
      else pending?.resolve(message.generation);
    } else if (message?.type === 'calculate') messages = messages.then(() => calculate(message));
  });
  parentPort.on('close', () => { try { store.close(); } catch {} });
  parentPort.postMessage({ type: 'ready' });
} catch {
  try { store?.close(); } catch {}
  parentPort.postMessage({ type: 'failed' }); parentPort.close();
}
