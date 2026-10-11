import { fullVerificationActivity, verifyDatabase } from '../storage/full-verifier.js';

const failure = () => Object.assign(new Error('Database verification is unavailable. Wait for storage to be ready.'),
  { statusCode: 409, code: 'full_verification_unavailable' });

/** Read-only maintenance has its own lifecycle; it never enters a recovery or
 * replication transaction. A completed run schedules the next optional check. */
export function createDatabaseVerification({ acquire, getIntervalMs = () => 0, available = () => true,
  verify = verifyDatabase, activity = fullVerificationActivity,
  clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = { state: 'idle', lastResult: null }, running, cancellation, timer, closed = false, started = false;
  let sourceStore = null, requestedStore = null;
  const evidence = new WeakMap();
  let interval = 0, nextAt = null;
  const idle = () => ({ state: 'idle', lastResult: null, lastFailure: null });
  const ownedState = store => store && (sourceStore === store || !sourceStore && requestedStore === store)
    ? state : store && evidence.get(store);
  const status = (options = {}) => ({ ...(Object.hasOwn(options, 'store') ? ownedState(options.store) ?? idle() : state),
    intervalMs: interval, nextAt, activity: activity() });
  const publish = next => {
    state = next;
    if (sourceStore) evidence.set(sourceStore, state);
  };
  function schedule() {
    clearTimer(timer); timer = null;
    if (!started || closed || !interval || running) return;
    nextAt ??= clock() + interval;
    timer = setTimer(() => {
      timer = null;
      if (clock() < nextAt) { schedule(); return; }
      if (!available()) { scheduleLater(); return; }
      try { start('scheduled'); } catch { scheduleLater(); }
    }, Math.max(1, Math.min(60_000, nextAt - clock())));
    timer?.unref?.();
  }
  function scheduleLater() {
    if (closed || !interval) return;
    timer = setTimer(schedule, 60_000); timer?.unref?.();
  }
  function configure() {
    const next = getIntervalMs();
    if (!Number.isSafeInteger(next) || next < 0) throw new TypeError('Invalid verification interval');
    if (next !== interval) { interval = next; nextAt = interval ? clock() + interval : null; }
    schedule();
  }
  function start(origin = 'manual', options = {}) {
    if (closed || !available()) throw failure();
    if (running) {
      if (Object.hasOwn(options, 'store') && (!options.store || options.store !== (sourceStore ?? requestedStore)))
        throw Object.assign(new Error('Another database verification is still running. Wait for it to finish before checking this database.'),
          { statusCode: 409, code: 'full_verification_busy' });
      return status(options);
    }
    if (Object.hasOwn(options, 'store') && !options.store) throw failure();
    clearTimer(timer); timer = null; nextAt = null;
    cancellation = new AbortController();
    sourceStore = null; requestedStore = options.store ?? null;
    state = { ...(requestedStore && evidence.get(requestedStore) || idle()), state: 'running', origin, startedAt: clock(), finishedAt: null, error: null,
      progress: { phase: 'preparing', processed: 0 } };
    const signal = cancellation.signal;
    let acquired = false;
    running = (async () => {
      const source = await acquire();
      try {
        signal.throwIfAborted();
        if (!source?.dbPath || source.dbPath === ':memory:') throw failure();
        if (requestedStore && source.store !== requestedStore) throw failure();
        // Runtime object identity fences a replaced database, including one
        // reopened at the same path. Paths and snapshot metadata stay private.
        sourceStore = source.store ?? null;
        const previous = sourceStore && evidence.get(sourceStore);
        publish({ ...state, lastResult: previous?.lastResult ?? null, lastFailure: previous?.lastFailure ?? null });
        acquired = true;
        const result = await verify({ dbPath: source.dbPath, signal, origin,
          onProgress: progress => { publish({ ...state, state: progress.phase === 'queued' ? 'queued' : 'running', progress }); } });
        publish({ ...state, state: 'complete', finishedAt: clock(), progress: null, lastResult: result, lastFailure: null });
      } finally { await source?.release?.(); }
    })().catch(error => {
      const code = !acquired && !signal.aborted ? 'full_verification_unavailable' : ['database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch', 'database_state_incompatible',
          'database_integrity_failed', 'database_journal_invalid', 'full_verification_checkpoint_mismatch', 'full_verification_content_mismatch',
          'full_verification_busy', 'full_verification_transport_mismatch', 'full_verification_unavailable'].includes(error?.code)
          ? error.code : 'full_verification_failed';
      const finishedAt = clock();
      publish({ ...state, state: signal.aborted ? 'interrupted' : 'error', finishedAt, progress: null, error: code,
        // An interrupted/busy retry cannot clear a known content failure.
        ...(acquired && !signal.aborted && (verificationFailureEvidence(code).category === 'integrity'
          || !state.lastFailure || verificationFailureEvidence(state.lastFailure.error).category !== 'integrity')
          ? { lastFailure: { error: code, finishedAt } } : {}) });
    }).finally(() => { running = null; cancellation = null; nextAt = interval ? clock() + interval : null; schedule(); });
    // Acquisition is asynchronous: no previous database result belongs to this
    // newly requested check until its source has been pinned.
    return { ...status(), lastResult: null, lastFailure: null };
  }
  return { status, start, configure,
    health(store) {
      const value = ownedState(store);
      if (!value) return null;
      return { scope: 'current-run', state: value.state, origin: value.origin, startedAt: value.startedAt,
        finishedAt: value.finishedAt, error: value.error, lastFailure: value.lastFailure ?? null,
        lastResult: value.lastResult ? { verifiedAt: value.lastResult.verifiedAt, rows: value.lastResult.rows } : null };
    },
    enable() { started = true; configure(); },
    async settled() { await running; },
    async close() { closed = true; clearTimer(timer); cancellation?.abort(); await running; },
  };
}

/** Fixed public categories; raw worker errors and filesystem paths stay private. */
export function verificationFailureEvidence(code) {
  const messages = {
    database_integrity_failed: ['integrity', 'critical', 'Database integrity needs attention', 'A full check found an integrity failure. Preserve this database and its companion files; review the verification result before replacing data.'],
    database_journal_invalid: ['integrity', 'critical', 'Database history verification failed', 'The transaction journal or saved record fingerprints did not pass a full check. Preserve the database and review the verification result.'],
    full_verification_content_mismatch: ['integrity', 'critical', 'Database contents differ', 'Databases had different contents at the same transaction checkpoint. Preserve both copies and review the verification result.'],
    database_schema_mismatch: ['format', 'warning', 'Database format is incompatible', 'The checked database schema does not match this application. Review the verification result and supported fresh-start guidance.'],
    database_schema_invalid: ['format', 'warning', 'Database structure is unsupported', 'The checked database structure does not satisfy the current contract. Review the verification result.'],
    database_algorithm_mismatch: ['format', 'warning', 'Database algorithm is incompatible', 'The checked database uses a different learning algorithm. Review the verification result.'],
    database_state_incompatible: ['format', 'warning', 'Saved database state is incompatible', 'The checked saved state does not satisfy the current contract. Review the verification result.'],
    full_verification_checkpoint_mismatch: ['checkpoint', 'warning', 'Database verification needs retrying', 'The transaction checkpoint changed before verification. Retry the check; this does not establish database damage.'],
    full_verification_transport_mismatch: ['transfer', 'warning', 'Snapshot transfer verification failed', 'The snapshot transfer did not match its expected contents. Keep the source intact and check a new export.'],
    full_verification_busy: ['unavailable', 'warning', 'Database verification is waiting', 'The verification queue was full. Retry after the pending checks finish.'],
    full_verification_unavailable: ['unavailable', 'warning', 'Database verification was unavailable', 'A current database could not be opened for verification. Wait for storage to be ready, then retry.'],
  };
  const [category, severity, title, detail] = messages[code]
    ?? ['unknown', 'warning', 'Database verification did not complete', 'The cause was not identified. Review the verification result and storage health before retrying.'];
  return { category, severity, title, detail };
}
