import { storageFailureCode } from './write-health.js';

const reasons = new Set(['recording-failed', 'recording-wait-expired', 'recording-pending']);

/** Passive evidence for one concrete device mutation. Callers own validation,
 * deadlines and authority; a diagnostic never changes the operation's outcome.
 * Queries and work already dispatched cannot become known unsent commands. */
export function createControlAttempt({ store, context, kind = 'mutation' } = {}) {
  let waiting = false, sent = false, finished = kind !== 'mutation', counted = false;
  const notSent = reason => {
    if (finished || sent || counted || !reasons.has(reason)) return;
    counted = true;
    try { store?.writeHealth?.commandNotSent?.(context, reason); } catch { /* Diagnostics are optional. */ }
  };
  return {
    storageWaiting(value) { if (!finished && !sent) waiting = value === true; },
    fail(error) {
      try { if (error?.committed !== true && storageFailureCode(error)) notSent('recording-failed'); }
      catch { /* Invalid failure metadata cannot affect a command. */ }
    },
    expire() { if (waiting) notSent('recording-wait-expired'); },
    notSent,
    dispatched() { sent = true; waiting = false; },
    finish() { finished = true; waiting = false; },
  };
}
