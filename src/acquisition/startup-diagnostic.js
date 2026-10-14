// Startup-only evidence, owned by the local acquisition producer. Arbitrary
// Error properties and provider payloads cannot acquire this provenance.
const details = new WeakMap();
const COUNT_LIMIT = 65535, QUEUE_LIMIT = 2048, AGE_LIMIT_MS = 60000;
const flags = ['connected', 'subscriptionsReady', 'readinessFailed', 'receptionFailed'];
const counts = ['observedConnections', 'subscriptionRequests', 'subscriptionCallbacks',
  'acceptedCallbacks', 'rejectedCallbacks', 'committedCallbacks', 'admissionFailures',
  'replayAdmissionsPending', 'recordingPending'];
const queueCounts = ['queuePending', 'queueQueued', 'queueActive'];
const keys = new Set(['stage', 'cause', ...flags, ...counts, ...queueCounts,
  'queueWaiting', 'queueOldestPendingMs', 'countsClipped']);

/** Preserve the original exception even if optional diagnostic input fails.
 * Only fixed scalar evidence survives; no raw errors, identities or clocks. */
export function attachMqttStartupDiagnostic(error, input) {
  try {
    if (!(error instanceof Error) || details.has(error) || !input || Object.getPrototypeOf(input) !== Object.prototype
      || Reflect.ownKeys(input).some(key => !keys.has(key))) return error;
    // Accessors cannot smuggle private values or throw during later logging.
    const values = Object.getOwnPropertyDescriptors(input);
    if ([...keys].some(key => !values[key] || !Object.hasOwn(values[key], 'value'))) return error;
    const value = key => values[key].value;
    if (!['primary-subscriptions', 'charger-subscriptions'].includes(value('stage'))
      || !['timeout', 'unavailable', 'closed'].includes(value('cause'))
      || flags.some(key => typeof value(key) !== 'boolean')
      || typeof value('countsClipped') !== 'boolean') return error;
    let clipped = value('countsClipped');
    const bound = (raw, limit) => {
      if (!Number.isSafeInteger(raw) || raw < 0) throw new TypeError('Invalid startup count');
      clipped ||= raw > limit;
      return Math.min(raw, limit);
    };
    const result = { stage: value('stage'), cause: value('cause'),
      ...Object.fromEntries(flags.map(key => [key, value(key)])),
      ...Object.fromEntries(counts.map(key => [key, bound(value(key), COUNT_LIMIT)])) };
    const unknownQueue = queueCounts.every(key => value(key) === null)
      && value('queueWaiting') === null && value('queueOldestPendingMs') === null;
    if (!unknownQueue && (queueCounts.some(key => value(key) === null)
      || typeof value('queueWaiting') !== 'boolean'
      || value('queuePending') !== value('queueQueued') + value('queueActive'))) return error;
    for (const key of queueCounts) result[key] = unknownQueue ? null : bound(value(key), QUEUE_LIMIT);
    result.queueWaiting = value('queueWaiting');
    const age = value('queueOldestPendingMs');
    if (age !== null && (!Number.isFinite(age) || age < 0)) return error;
    clipped ||= age !== null && age > AGE_LIMIT_MS;
    result.queueOldestPendingMs = age === null ? null : Math.min(Math.round(age), AGE_LIMIT_MS);
    result.countsClipped = clipped;
    if (Buffer.byteLength(JSON.stringify(result)) <= 1024) details.set(error, Object.freeze(result));
  } catch { /* Optional evidence cannot replace the startup failure. */ }
  return error;
}

export function mqttStartupDiagnostic(error) {
  // WeakMap access does not read arbitrary exception properties or getters.
  try { return details.get(error) ?? null; }
  catch { return null; }
}
