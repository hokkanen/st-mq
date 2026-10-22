import { storageOperationHealth } from '../storage/operation-health.js';
import { createCoefficientGeneration, appendCoefficientEvents, publishCoefficientGeneration, discardCoefficientGeneration } from '../storage/coefficient-history.js';
import { Worker } from 'node:worker_threads';
import { learningJournalHead, hasLearningSampleAfter } from '../storage/store.js';
import { LEARNING_ALGORITHM, validLearningCheckpoint } from './committed-learning.js';
import { fireplaceLearningContext, fireplaceWindowContext } from './fireplace-inputs.js';
import { sensorLearningContext, sensorRevision } from './sensor-inputs.js';
import { publishLearning } from './learning-publication.js';
import { fireplaceActive, fireplaceIntegral, fireplaceRate, FIREPLACE_HORIZON_MS } from '../domain/fireplace.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated']);
const jobKey = input => `fireplace:rebuild:${input}`;
const validInput = input => {
  if (!INPUTS.has(input)) throw new TypeError('Fireplace logging is unavailable for this input');
  return input;
};
const instant = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('A valid server timestamp is required');
  return value;
};
function request(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !fields.includes(key))
    || typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.requestId))
    throw new TypeError('A bounded request ID and the expected fireplace fields are required');
}
const loadEvent = row => ({ id: row.id, at: row.at, litAt: row.at, kg: row.kg });
export const fireplaceRevision = (store, input) => store.db.prepare(
  'SELECT COALESCE(MAX(id),0) revision FROM active_fireplace_events AS fireplace_events WHERE input=?').get(validInput(input)).revision;

/** Removal retracts an erroneous load at every model timestamp. asOf selects
 * what was recorded by that time; revision fixes a reproducible source version. */
export function fireplaceEvents(store, input, { revision, asOf } = {}) {
  validInput(input);
  revision ??= fireplaceRevision(store, input);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid fireplace revision');
  if (asOf !== undefined) instant(asOf);
  const bound = asOf ?? Number.MAX_SAFE_INTEGER;
  const rows = store.db.prepare(`SELECT * FROM active_fireplace_events AS fireplace_events WHERE input=? AND id<=? AND at<=? ORDER BY id`)
    .all(input, revision, bound);
  const removed = new Set(rows.filter(row => row.kind === 'remove').map(row => row.target_id));
  return { revision: rows.at(-1)?.id ?? 0,
    events: rows.filter(row => row.kind === 'load' && !removed.has(row.id)).map(loadEvent) };
}

function queueRevision(store, input, revision, at, affectedAt) {
  const previous = store.getState(jobKey(input));
  const pending = ['pending', 'running', 'ready', 'failed'].includes(previous?.status);
  const previousAffectedAt = pending ? previous?.affectedAt ?? null : null;
  const affected = affectedAt !== null && hasLearningSampleAfter(store.db, input, affectedAt);
  const requiresRebuild = affected || pending && previous.requiresRebuild !== false;
  const hasModel=Boolean(store.db.prepare(`SELECT 1 FROM coefficient_selection s JOIN coefficient_generations g
    ON g.id=s.generation WHERE s.input=? AND g.cursor>0`).get(input)
    ||store.db.prepare("SELECT 1 FROM state WHERE key=? AND json_extract(value,'$.journalCursor')>0").get(`adaptive:${input}`));
  if (requiresRebuild || hasModel) store.setState(jobKey(input), { status: 'pending', revision,
    sensorRevision: sensorRevision(store, input), epoch: store.learningEpoch(input),
    requestedAt: at, affectedAt: affectedAt === null ? previousAffectedAt
      : Math.min(affectedAt, previousAffectedAt ?? affectedAt), requiresRebuild });
  return requiresRebuild;
}

export function addFireplace(store, input, payload, now = Date.now()) {
  validInput(input); request(payload, ['requestId', 'kg']); instant(now);
  if (!Number.isInteger(payload.kg) || payload.kg < 2 || payload.kg > 10)
    throw new TypeError('Fireplace load must be a whole number from 2 to 10 kg');
  return store.transaction(() => {
    const existing = store.db.prepare('SELECT * FROM fireplace_events WHERE input=? AND request_id=?').get(input, payload.requestId);
    if (existing) {
      if (existing.kind !== 'load' || existing.kg !== payload.kg) throw Object.assign(new Error('Conflicting fireplace request ID'), { statusCode: 409 });
      return { ...loadEvent(existing), revision: fireplaceRevision(store, input), repeated: true };
    }
    const id = Number(store.db.prepare(`INSERT INTO fireplace_events(input,request_id,at,kind,kg,target_id)
      VALUES(?,?,?,'load',?,NULL)`).run(input, payload.requestId, now, payload.kg).lastInsertRowid);
    const requiresRebuild = queueRevision(store, input, id, now, now);
    return { id, at: now, litAt: now, kg: payload.kg, revision: id, requiresRebuild, repeated: false };
  });
}

export function removeFireplace(store, input, payload, now = Date.now(), { maxAgeMs = Infinity } = {}) {
  validInput(input); request(payload, ['requestId', 'id']); instant(now);
  if (!Number.isSafeInteger(payload.id) || payload.id <= 0) throw new TypeError('Invalid fireplace load ID');
  return store.transaction(() => {
    const existing = store.db.prepare('SELECT * FROM fireplace_events WHERE input=? AND request_id=?').get(input, payload.requestId);
    if (existing) {
      if (existing.kind !== 'remove' || existing.target_id !== payload.id) throw Object.assign(new Error('Conflicting fireplace request ID'), { statusCode: 409 });
      const first = store.db.prepare("SELECT MIN(at) at FROM fireplace_events WHERE input=? AND target_id=? AND kind='remove'").get(input, payload.id);
      return { id: payload.id, removedAt: first.at, revision: fireplaceRevision(store, input), repeated: true };
    }
    const target = store.db.prepare("SELECT * FROM active_fireplace_events AS fireplace_events WHERE input=? AND id=? AND kind='load'").get(input, payload.id);
    if (!target) throw new TypeError('Fireplace load was not found for this input');
    // Check against the original server timestamp inside the write transaction.
    // An already committed request above remains retryable without another write.
    if (maxAgeMs !== Infinity && (target.at > now || now - target.at > maxAgeMs))
      throw Object.assign(new Error('Admin access is required to remove firewood recorded more than 15 minutes ago.'), { statusCode: 403 });
    const first = store.db.prepare("SELECT at FROM active_fireplace_events AS fireplace_events WHERE input=? AND target_id=? AND kind='remove' ORDER BY id LIMIT 1")
      .get(input, payload.id);
    const revision = Number(store.db.prepare(`INSERT INTO fireplace_events(input,request_id,at,kind,kg,target_id)
      VALUES(?,?,?,'remove',NULL,?)`).run(input, payload.requestId, now, payload.id).lastInsertRowid);
    const requiresRebuild = queueRevision(store, input, revision, now, first ? null : target.at);
    return { id: payload.id, removedAt: first?.at ?? now, revision, requiresRebuild, repeated: Boolean(first) };
  });
}

export function fireplaceView(store, input, { asOf = Date.now(), revision } = {}) {
  if (!INPUTS.has(input)) return { available: false, input, revision: 0, entries: [], active: [], requiresRebuild: false, rebuild: { status: 'idle' } };
  const context = fireplaceWindowContext(store,input,{from:asOf,to:asOf,asOf,revision});
  const source = { revision:context.fireplaceRevision, events:context.fireplaceEvents };
  const events = store.db.prepare(`SELECT l.*,
    (SELECT r.at FROM active_fireplace_events r WHERE r.input=l.input AND r.target_id=l.id
      AND r.id<=? AND r.at<=? ORDER BY r.at,r.id LIMIT 1) removed_at
    FROM active_fireplace_events l WHERE l.input=? AND l.kind='load'
    AND l.id<=? AND l.at<=? AND l.at>=? ORDER BY l.at DESC,l.id DESC`)
    .all(source.revision,asOf,input,source.revision,asOf,Math.max(0,asOf-48*3_600_000))
    .map(row => ({ ...loadEvent(row), removedAt: row.removed_at,
      requiresRebuild: hasLearningSampleAfter(store.db, input, row.at) }));
  const rebuild = store.getState(jobKey(input)) ?? { status: 'idle', revision: source.revision };
  return { available: true, input, revision: source.revision, entries: events, lastAt: events.find(event => event.removedAt === null)?.at ?? null,
    activeNow: fireplaceActive(source.events, asOf), releaseKgPerHour: fireplaceRate(source.events, asOf, asOf + 60_000),
    remainingKgEquivalent: fireplaceIntegral(source.events, asOf, asOf + FIREPLACE_HORIZON_MS),
    requiresRebuild: ['pending', 'running', 'ready', 'failed'].includes(rebuild.status) && rebuild.requiresRebuild !== false,
    rebuild: { ...rebuild, status: rebuild.status === 'ready' ? 'running' : rebuild.status === 'current' ? 'idle' : rebuild.status } };
}

/** Replay workers build candidates; a publication worker commits the verified
 * replacement before the engine adopts it. Durable intent survives restart. */
export class FireplaceRebuildManager {
  constructor({ store, input, onReady, workerFactory = options => new Worker(new URL('./fireplace-worker.js', import.meta.url), options) }) {
    storageOperationHealth.register('learning-rebuild');
    this.observations = new WeakMap();
    this.store = store; this.input = validInput(input); this.workerFactory = workerFactory; this.onReady = onReady;
    this.worker = null; this.ready = null; this.generation = 0; this.closed = false;
  }
  retireWorker(worker, outcome, reason = null) {
    const operation = this.observations.get(worker);
    return Promise.resolve(worker.terminate()).finally(async () => {
      operation?.finish(outcome, { reason });
      await this.cleanupCoefficientGeneration(worker.coefficientGeneration);
    });
  }
  async cleanupCoefficientGeneration(generation) {
    if(!generation)return;
    try{for(;;){const result=await this.store.runWrite(()=>discardCoefficientGeneration(this.store,generation));
      if(result.complete||!result.removed)break;await new Promise(resolve=>setImmediate(resolve));}}
    catch{/* Interrupted cleanup remains named in the durable job for the next explicit rebuild. */}
  }
  status() { return this.store.getState(jobKey(this.input)) ?? { status: 'idle',
    revision: fireplaceRevision(this.store, this.input), sensorRevision: sensorRevision(this.store, this.input),
    epoch: this.store.learningEpoch(this.input) }; }
  setStatus(value) { this.store.setState(jobKey(this.input), value); }
  head() { return learningJournalHead(this.store.db,this.input); }
  current(selection) {
    return selection.revision === fireplaceRevision(this.store, this.input)
      && selection.sensorRevision === sensorRevision(this.store, this.input)
      && selection.epoch === this.store.learningEpoch(this.input)
      && selection.selection === this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
  }
  start(revision = fireplaceRevision(this.store, this.input), correctedSensors = sensorRevision(this.store, this.input), { force = false } = {}) {
    if (this.closed) return false;
    const selection = { revision, sensorRevision: correctedSensors, epoch: this.store.learningEpoch(this.input),
      selection: this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation };
    if (!this.current(selection)) return false;
    if (!force && this.worker && this.current(this.workerSelection)) return true;
    const previousWorker = this.worker;
    this.worker = null; this.ready = null;
    if (previousWorker) void this.retireWorker(previousWorker, 'superseded', 'superseded');
    const generation = ++this.generation;
    const old = this.status();
    if(old.coefficientGeneration&&old.coefficientGeneration!==previousWorker?.coefficientGeneration)
      void this.cleanupCoefficientGeneration(old.coefficientGeneration);
    this.setStatus({ ...old, ...selection, status: 'running', requiresRebuild: old.requiresRebuild ?? true, processed: 0, error: null });
    const operation = storageOperationHealth.begin('learning-rebuild');
    try {
      const worker = this.workerFactory({ workerData: { dbPath: this.store.path, input: this.input } });
      let coefficientGeneration;
      this.observations.set(worker, operation);
      this.worker = worker; this.workerSelection = selection;
      const fail = () => {
        if (this.closed || generation !== this.generation) return;
        this.worker = null; this.ready = null; this.generation++;
        void this.retireWorker(worker, 'failed', 'operation-failed');
        this.setStatus({ ...this.status(), status: 'failed',
          error: 'Model rebuild failed; the previous model remains active.' });
      };
      const admit = (operation, { priority = 'normal', onError } = {}) => {
        if (this.closed || generation !== this.generation) return;
        void this.store.runWrite(() => {
          if (this.closed || generation !== this.generation) return;
          const previousReady = this.ready;
          this.store.afterRollback(() => { this.ready = previousReady; });
          return operation();
        }, { priority, isCurrent: () => !this.closed && generation === this.generation })
          .catch(error => { this.store.writeHealth.failure(error); onError?.(); });
      };
      worker.on('error', () => admit(fail));
      worker.on('exit', () => admit(fail));
      worker.on('message', result => admit(() => {
        if (this.closed || generation !== this.generation) return;
        if (!this.current(selection)) { this.start(); return; }
        if (result.revision !== revision || result.sensorRevision !== correctedSensors || result.epoch !== selection.epoch) return;
        if (result.type === 'stale') { this.start(undefined, undefined, { force: true }); return; }
        if (result.error) { fail(); return; }
        if(result.type==='coefficient-start'||result.type==='coefficient-page'){
          if(result.type==='coefficient-start')coefficientGeneration=createCoefficientGeneration(this.store,this.input,{
            epoch:selection.epoch,selection:selection.selection,fireplaceRevision:revision,sensorRevision:correctedSensors,
            prefixCursor:result.prefixCursor,projection:result.projection});
          else{
            if(result.coefficientGeneration!==coefficientGeneration){fail();return;}
            appendCoefficientEvents(this.store,coefficientGeneration,{events:result.events,projection:result.projection});
          }
          worker.coefficientGeneration=coefficientGeneration;
          this.setStatus({...this.status(),coefficientGeneration});
          this.store.afterCommit(()=>worker.postMessage({type:'coefficient-ack',requestId:result.requestId,generation:coefficientGeneration}));
          return;
        }
        if (result.type === 'progress') {
          // READY has control priority and may overtake its older ordinary
          // progress report. That report cannot demote a complete candidate.
          if (this.ready && result.journalCursor <= this.ready.head) return;
          this.setStatus({ ...this.status(), status: 'running', processed: result.processed, journalCursor: result.journalCursor });
          return;
        }
        if (result.type !== 'ready') return;
        const last = result.head ? this.store.learningJournal({ input: this.input, after: result.head - 1,
          limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0] : null;
        if (!Number.isSafeInteger(result.head) || result.head < 0
          || result.head > 0 && (!last || result.checkpoint?.journalCursor !== result.head
            || (result.checkpoint?.fireplaceRevision ?? 0) !== revision
            || (result.checkpoint?.sensorRevision ?? 0) !== correctedSensors || !validLearningCheckpoint(result.checkpoint, last))
          || result.head === 0 && result.checkpoint !== null) { fail(); return; }
        if(result.coefficientGeneration!==coefficientGeneration||!coefficientGeneration){fail();return;}
        this.ready = { checkpoint: result.checkpoint, ...selection, head: result.head, coefficientGeneration };
        this.setStatus({ ...this.status(), status: 'ready', journalCursor: result.head, processed: result.processed });
        this.store.afterCommit(() => { if (!this.closed && generation === this.generation) this.onReady?.(); });
      }, { priority: result.type === 'ready' ? 'control' : 'normal', onError:()=>{
        if(['coefficient-start','coefficient-page'].includes(result.type)
          &&!this.closed&&generation===this.generation) {
          // A failed writer transaction must release a read-only worker waiting
          // for durable staging acknowledgement. Its failure reply then follows
          // the normal failed-job path while the selected model stays intact.
          try{worker.postMessage({type:'coefficient-ack',requestId:result.requestId,error:true});}catch{}
        }
      } }));
      this.store.afterCommit(() => { if (!this.closed && generation === this.generation)
        this.send({ type: 'rebuild', ...selection, head: this.head(), affectedAt: old.affectedAt }); });
      return true;
    } catch {
      const worker = this.worker; this.worker = null; this.generation++;
      if (worker) void this.retireWorker(worker, 'failed', 'operation-failed');
      else operation.finish('failed', { reason: 'operation-failed' });
      this.setStatus({ ...this.status(), status: 'failed', error: 'Model rebuild could not start.' });
      return false;
    }
  }
  send(message) {
    if (this.store.path === ':memory:') {
      const source = { ...fireplaceLearningContext(this.store, this.input, message.revision),
        ...sensorLearningContext(this.store, this.input, message.sensorRevision) };
      const entries = [];
      let after = message.after ?? 0;
      for (;;) {
        const batch = this.store.learningJournal({ input: this.input, after, limit: 256, algorithmVersion: LEARNING_ALGORITHM }).filter(entry => entry.id <= message.head);
        if (!batch.length) break;
        entries.push(...batch); after = batch.at(-1).id;
      }
      message = { ...message, source, entries };
    }
    this.worker.postMessage(message);
  }
  takeReady() {
    if (!this.ready || this.closed) return null;
    if (!this.current(this.ready)) { this.start(); return null; }
    const head = this.head();
    if (head !== this.ready.head) {
      const after = this.ready.head, { revision, sensorRevision, epoch } = this.ready;
      this.ready = null;
      this.setStatus({ ...this.status(), status: 'running' });
      this.send({ type: 'catchup', revision, sensorRevision, epoch, head, after });
      return null;
    }
    return this.ready;
  }
  complete(checkpoint, { persist = true } = {}) {
    const candidate = this.takeReady();
    if (!candidate || candidate.checkpoint !== checkpoint) return false;
    if (persist) this.store.transaction(()=>{
      this.store.setState(`adaptive:${this.input}`,checkpoint);
      publishCoefficientGeneration(this.store,this.input,candidate.coefficientGeneration,checkpoint);
      this.setStatus({ ...this.status(), status: 'current', revision: candidate.revision,
        sensorRevision: candidate.sensorRevision, epoch: candidate.epoch, requiresRebuild: false });
    });
    this.ready = null;
    const worker = this.worker; this.worker = null; this.generation++;
    if (worker) void this.retireWorker(worker, 'completed');
    return true;
  }
  publish(onPublish, isCurrent = () => true) {
    if (this.publication || this.closed) return this.publication;
    const candidate = this.takeReady();
    if (!candidate) return null;
    const generation = this.generation;
    let retry = false;
    const cancellation = this.publicationAbort = new AbortController();
    const current = () => !this.closed && !cancellation.signal.aborted && isCurrent();
    this.publication = publishLearning({ store: this.store, input: this.input, kind: 'correction',
      message: candidate, signal: cancellation.signal, isCurrent: current,
      onPublish: result => {
        // Adoption is required even when cancellation followed a successful
        // commit. Revoked runtimes gain no permission to command equipment.
        onPublish(result.checkpoint);
        this.ready = null;
        const worker = this.worker; this.worker = null; this.generation++;
        if (worker) void this.retireWorker(worker, 'completed');
      } }).then(result => { retry = !result; }).catch(async error => {
      if (!current() || error.code === 'STORAGE_WRITE_ROLLED_BACK') return;
      await this.store.runWrite(() => {
        if (!current() || generation !== this.generation || !this.current(candidate)) return;
        this.ready = null;
        const worker = this.worker; this.worker = null; this.generation++;
        if (worker) void this.retireWorker(worker, 'failed', 'operation-failed');
        this.setStatus({ ...this.status(), status: 'failed',
          error: 'Model publication failed; the previous model remains active.' });
      }, { signal: cancellation.signal, isCurrent: current });
    }).catch(error => this.store.writeHealth.failure(error)).finally(() => {
      this.publication = null; this.publicationAbort = null;
      if (retry && !this.closed) this.onReady?.();
    });
    return this.publication;
  }
  beginShutdown() {
    if (!this.closed) { this.closed = true; this.generation++; }
    this.ready = null;
    this.publicationAbort?.abort();
  }
  async close() {
    this.beginShutdown();
    await this.publication;
    const worker = this.worker; this.worker = null;
    if (worker) {
      const closing = new AbortController();
      try {
        const save = this.store.runWrite(() => this.setStatus({ ...this.status(), status: 'pending' }), { signal: closing.signal });
        // Saved running/ready intent also resumes on restart. Teardown must not
        // wait indefinitely merely to relabel that already durable obligation.
        closing.abort();
        await save;
      } catch (error) { if (error.code !== 'STORAGE_WRITE_CANCELLED') throw error; }
      finally { await this.retireWorker(worker, 'cancelled', 'cancelled'); }
    }
  }
}
