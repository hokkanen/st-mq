import { Worker } from 'node:worker_threads';
import { LEARNING_ALGORITHM, validLearningCheckpoint } from './committed-learning.js';
import { fireplaceLearningContext } from './fireplace-inputs.js';
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
  'SELECT COALESCE(MAX(id),0) revision FROM fireplace_events WHERE input=?').get(validInput(input)).revision;

/** Removal retracts an erroneous load at every model timestamp. asOf selects
 * what was recorded by that time; revision fixes a reproducible source version. */
export function fireplaceEvents(store, input, { revision, asOf } = {}) {
  validInput(input);
  revision ??= fireplaceRevision(store, input);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Invalid fireplace revision');
  if (asOf !== undefined) instant(asOf);
  const bound = asOf ?? Number.MAX_SAFE_INTEGER;
  const rows = store.db.prepare(`SELECT * FROM fireplace_events WHERE input=? AND id<=? AND at<=? ORDER BY id`)
    .all(input, revision, bound);
  const removed = new Set(rows.filter(row => row.kind === 'remove').map(row => row.target_id));
  return { revision: rows.at(-1)?.id ?? 0,
    events: rows.filter(row => row.kind === 'load' && !removed.has(row.id)).map(loadEvent) };
}

function queueRevision(store, input, revision, at, affectedAt) {
  const previous = store.getState(jobKey(input));
  const affected = affectedAt !== null && Boolean(store.db.prepare(`SELECT 1 FROM learning_journal
    WHERE input=? AND kind='sample' AND algorithm_version=? AND at>? LIMIT 1`).get(input, LEARNING_ALGORITHM, affectedAt));
  const requiresRebuild = affected || ['pending', 'running', 'ready', 'failed'].includes(previous?.status);
  if (requiresRebuild) store.setState(jobKey(input), { status: 'pending', revision,
    requestedAt: at, affectedAt: affectedAt === null ? previous?.affectedAt ?? null
      : Math.min(affectedAt, previous?.affectedAt ?? affectedAt), requiresRebuild: true });
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

export function removeFireplace(store, input, payload, now = Date.now()) {
  validInput(input); request(payload, ['requestId', 'id']); instant(now);
  if (!Number.isSafeInteger(payload.id) || payload.id <= 0) throw new TypeError('Invalid fireplace load ID');
  return store.transaction(() => {
    const existing = store.db.prepare('SELECT * FROM fireplace_events WHERE input=? AND request_id=?').get(input, payload.requestId);
    if (existing) {
      if (existing.kind !== 'remove' || existing.target_id !== payload.id) throw Object.assign(new Error('Conflicting fireplace request ID'), { statusCode: 409 });
      const first = store.db.prepare("SELECT MIN(at) at FROM fireplace_events WHERE input=? AND target_id=? AND kind='remove'").get(input, payload.id);
      return { id: payload.id, removedAt: first.at, revision: fireplaceRevision(store, input), repeated: true };
    }
    const target = store.db.prepare("SELECT * FROM fireplace_events WHERE input=? AND id=? AND kind='load'").get(input, payload.id);
    if (!target) throw new TypeError('Fireplace load was not found for this input');
    const first = store.db.prepare("SELECT at FROM fireplace_events WHERE input=? AND target_id=? AND kind='remove' ORDER BY id LIMIT 1")
      .get(input, payload.id);
    const revision = Number(store.db.prepare(`INSERT INTO fireplace_events(input,request_id,at,kind,kg,target_id)
      VALUES(?,?,?,'remove',NULL,?)`).run(input, payload.requestId, now, payload.id).lastInsertRowid);
    const requiresRebuild = queueRevision(store, input, revision, now, first ? null : target.at);
    return { id: payload.id, removedAt: first?.at ?? now, revision, requiresRebuild, repeated: Boolean(first) };
  });
}

export function fireplaceView(store, input, { asOf = Date.now(), revision } = {}) {
  if (!INPUTS.has(input)) return { available: false, input, revision: 0, entries: [], active: [], requiresRebuild: false, rebuild: { status: 'idle' } };
  const source = fireplaceEvents(store, input, { revision, asOf });
  const removals = store.db.prepare(`SELECT target_id,MIN(at) removed_at FROM fireplace_events
    WHERE input=? AND kind='remove' AND id<=? AND at<=? GROUP BY target_id`).all(input, source.revision, asOf);
  const removed = new Map(removals.map(row => [row.target_id, row.removed_at]));
  const affected = store.db.prepare(`SELECT 1 FROM learning_journal WHERE input=? AND kind='sample'
    AND algorithm_version=? AND at>? LIMIT 1`);
  const events = store.db.prepare(`SELECT * FROM fireplace_events WHERE input=? AND kind='load'
    AND id<=? AND at<=? AND at>=? ORDER BY id DESC`).all(input, source.revision, asOf, Math.max(0, asOf - 48 * 3_600_000))
    .map(row => ({ ...loadEvent(row), removedAt: removed.get(row.id) ?? null,
      requiresRebuild: Boolean(affected.get(input, LEARNING_ALGORITHM, row.at)) }));
  const rebuild = store.getState(jobKey(input)) ?? { status: 'idle', revision: source.revision };
  return { available: true, input, revision: source.revision, entries: events, lastAt: events.find(event => event.removedAt === null)?.at ?? null,
    activeNow: fireplaceActive(source.events, asOf), releaseKgPerHour: fireplaceRate(source.events, asOf, asOf + 60_000),
    remainingKgEquivalent: fireplaceIntegral(source.events, asOf, asOf + FIREPLACE_HORIZON_MS),
    requiresRebuild: ['pending', 'running', 'ready', 'failed'].includes(rebuild.status),
    rebuild: { ...rebuild, status: rebuild.status === 'ready' ? 'running' : rebuild.status === 'current' ? 'idle' : rebuild.status } };
}

/** Workers build candidates only. The engine owns the atomic checkpoint swap.
 * Durable job intent survives restart without persisting a partial model. */
export class FireplaceRebuildManager {
  constructor({ store, input, workerFactory = options => new Worker(new URL('./fireplace-worker.js', import.meta.url), options) }) {
    this.store = store; this.input = validInput(input); this.workerFactory = workerFactory;
    this.worker = null; this.ready = null; this.generation = 0; this.closed = false;
  }
  status() { return this.store.getState(jobKey(this.input)) ?? { status: 'idle', revision: fireplaceRevision(this.store, this.input) }; }
  setStatus(value) { this.store.setState(jobKey(this.input), value); }
  head() { return this.store.db.prepare(`SELECT COALESCE(MAX(id),0) id FROM learning_journal WHERE input=?
    AND algorithm_version=?`)
    .get(this.input, LEARNING_ALGORITHM).id; }
  start(revision = fireplaceRevision(this.store, this.input)) {
    if (this.closed) return false;
    if (revision !== fireplaceRevision(this.store, this.input)) return false;
    if (this.worker && this.workerRevision === revision) return true;
    const previousWorker = this.worker;
    this.worker = null; this.ready = null;
    if (previousWorker) void previousWorker.terminate();
    const generation = ++this.generation;
    const old = this.status();
    this.setStatus({ ...old, status: 'running', revision, requiresRebuild: true, processed: 0, error: null });
    try {
      const worker = this.workerFactory({ workerData: { dbPath: this.store.path, input: this.input } });
      this.worker = worker; this.workerRevision = revision;
      const fail = () => {
        if (this.closed || generation !== this.generation) return;
        this.worker = null; this.ready = null; this.generation++;
        void worker.terminate();
        this.setStatus({ ...this.status(), status: 'failed', requiresRebuild: true,
          error: 'Fireplace model rebuild failed; the previous model remains active.' });
      };
      worker.on('error', fail);
      worker.on('exit', fail);
      worker.on('message', result => {
        if (this.closed || generation !== this.generation) return;
        if (revision !== fireplaceRevision(this.store, this.input)) { this.start(); return; }
        if (result.revision !== revision) return;
        if (result.type === 'stale') { this.start(); return; }
        if (result.error) { fail(); return; }
        if (result.type === 'progress') {
          this.setStatus({ ...this.status(), status: 'running', processed: result.processed, journalCursor: result.journalCursor });
          return;
        }
        if (result.type !== 'ready') return;
        const last = result.head ? this.store.learningJournal({ input: this.input, after: result.head - 1,
          limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0] : null;
        if (!Number.isSafeInteger(result.head) || result.head < 0
          || result.head > 0 && (!last || result.checkpoint?.journalCursor !== result.head
            || (result.checkpoint?.fireplaceRevision ?? 0) !== revision || !validLearningCheckpoint(result.checkpoint, last))
          || result.head === 0 && result.checkpoint !== null) { fail(); return; }
        this.ready = { checkpoint: result.checkpoint, revision, head: result.head };
        this.setStatus({ ...this.status(), status: 'ready', journalCursor: result.head, processed: result.processed });
      });
      this.send({ type: 'rebuild', revision, head: this.head() });
      return true;
    } catch {
      const worker = this.worker; this.worker = null; this.generation++;
      if (worker) void worker.terminate();
      this.setStatus({ ...this.status(), status: 'failed', error: 'Fireplace model rebuild could not start.', requiresRebuild: true });
      return false;
    }
  }
  send(message) {
    if (this.store.path === ':memory:') {
      const source = fireplaceLearningContext(this.store, this.input, message.revision);
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
    if (this.ready.revision !== fireplaceRevision(this.store, this.input)) { this.start(); return null; }
    const head = this.head();
    if (head !== this.ready.head) {
      const after = this.ready.head, revision = this.ready.revision;
      this.ready = null;
      this.setStatus({ ...this.status(), status: 'running' });
      this.send({ type: 'catchup', revision, head, after });
      return null;
    }
    return this.ready;
  }
  complete(checkpoint, { persist = true } = {}) {
    const candidate = this.takeReady();
    if (!candidate || candidate.checkpoint !== checkpoint) return false;
    if (persist) this.setStatus({ ...this.status(), status: 'current', revision: candidate.revision, requiresRebuild: false });
    this.ready = null;
    const worker = this.worker; this.worker = null; this.generation++;
    if (worker) void worker.terminate();
    return true;
  }
  async close() {
    this.closed = true; this.generation++; this.ready = null;
    const worker = this.worker; this.worker = null;
    if (worker) {
      this.setStatus({ ...this.status(), status: 'pending', requiresRebuild: true });
      await worker.terminate();
    }
  }
}
