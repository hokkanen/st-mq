export const REPLICA_CHECKPOINT_MISMATCH = Object.freeze({
  code: 'replica_checkpoint_mismatch',
  error: 'The read-only snapshot no longer matches its database checkpoint. Wait for verified synchronization, then refresh.',
});

const authored = new WeakSet(), phases = new WeakMap();
const phaseKeys = new Set(['attempt', 'rollbackConfirmed', 'closed', 'latestManifestState']);

/** Optional evidence cannot replace the original read refusal. Only the local
 * constructor and fixed own scalar fields acquire diagnostic provenance. */
export function captureReplicaReadRefusalPhase(error, input) {
  try {
    if (!authored.has(error) || phases.has(error) || !input
      || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).some(key => !phaseKeys.has(key))) return error;
    const fields = Object.getOwnPropertyDescriptors(input);
    if ([...phaseKeys].some(key => !fields[key] || !Object.hasOwn(fields[key], 'value'))) return error;
    const value = key => fields[key].value;
    if (![1, 2].includes(value('attempt')) || typeof value('rollbackConfirmed') !== 'boolean'
      || typeof value('closed') !== 'boolean'
      || !['not-checked', 'missing', 'unreadable', 'same', 'different'].includes(value('latestManifestState'))) return error;
    phases.set(error, Object.freeze(Object.fromEntries([...phaseKeys].map(key => [key, value(key)]))));
  } catch { /* Diagnostic failure retains the original exception and fence. */ }
  return error;
}

export function replicaReadRefusalPhase(error) {
  try { return phases.get(error) ?? null; }
  catch { return null; }
}

/** One attempted diagnostic per server per 30 seconds. Suppression changes no
 * response or read admission; failed sinks are bounded too. No timer is added. */
export function createReplicaReadRefusalReporter({
  report = diagnostic => console.error(JSON.stringify(diagnostic)), monotonic = () => performance.now(),
} = {}) {
  let lastAt = -Infinity, suppressed = 0, suppressedClipped = false;
  return (error, route) => {
    try {
      const phase = replicaReadRefusalPhase(error);
      if (!phase || !['status', 'recording-health'].includes(route)) return;
      const now = monotonic();
      if (!Number.isFinite(now) || now < 0) return;
      if (now - lastAt < 30000) {
        if (suppressed < 65535) suppressed++;
        else suppressedClipped = true;
        return;
      }
      lastAt = now;
      let reportedAt = null;
      try {
        const wall = Date.now();
        if (Number.isSafeInteger(wall) && wall >= 0 && wall <= 8640000000000000) reportedAt = wall;
      } catch { /* Unknown local clock evidence cannot alter the refusal or cap. */ }
      const diagnostic = Object.freeze({ event: 'replica-read-refused', route, ...phase,
        reportedAt, monotonicMs: now <= Number.MAX_SAFE_INTEGER ? now : null, suppressed, suppressedClipped });
      suppressed = 0; suppressedClipped = false;
      void Promise.resolve(report(diagnostic)).catch(() => {});
    } catch { /* Optional log evidence cannot change a 503 or its cleanup. */ }
  };
}

/** Only this locally authored refusal identifies a verified read-fence mismatch.
 * Native error codes or messages cannot acquire the same public explanation. */
export class ReplicaCheckpointMismatchError extends Error {
  constructor() {
    super(REPLICA_CHECKPOINT_MISMATCH.error);
    this.statusCode = 503;
    this.code = REPLICA_CHECKPOINT_MISMATCH.code;
    try { authored.add(this); } catch { /* Provenance failure only omits diagnostics. */ }
  }
}
