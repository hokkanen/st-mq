import { createHash } from 'node:crypto';
import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
import { compareRecordedChargingEnergy } from './recorded-charging-energy.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const energy = value => Number.isFinite(value) && value >= 0;

export function compareEaseeSessionEnergy(store, { device, start, end, now }) {
  return compareRecordedChargingEnergy(store, { source: 'easee', prefix: 'ev1', device, start, end, now });
}

/** Consume actual Easee finalized-session events (observation 129), never
 * lifetime-counter periods or inferred power/plug transitions. The caller has
 * already recorded this poll's integrated energy and owns the transaction.
 * A session boundary flushes compact pending energy once; pauses remain inside
 * that session. Missing samples, restarts and gaps cannot become measured zero.
 */
export function recordEaseeSessionChecks({ store, rows, now, flush = () => {} }) {
  let recorded = 0;
  for (const row of rows) {
    if (row.source !== 'easee' || row.signal !== 'ev1_active_power' || typeof row.device !== 'string') continue;
    const session = row.raw?.chargingSession;
    if (!session || !/^[a-f0-9]{64}$/.test(session.sessionKey) || !instant(session.start) || !instant(session.end)
      || session.end <= session.start || session.end > now || !instant(session.reportedAt)
      || session.reportedAt < session.end || session.reportedAt > now || !energy(session.referenceKwh)) continue;
    const stateKey = `easee:session-check:${session.sessionKey}`;
    const fingerprint = digest([session.start, session.end, session.referenceKwh, session.quality ?? []]);
    const previous = store.getState(stateKey);
    if (previous) {
      // A revised finalized provider event cannot silently rewrite the frozen
      // comparison or repeatedly force recorder writes.
      if (previous.fingerprint !== fingerprint && !previous.conflict) {
        store.event('charging-session-check-conflict', { source: 'easee' }, now);
        store.setState(stateKey, { ...previous, conflict: true });
      }
      continue;
    }
    flush(row.device);
    const compared = compareEaseeSessionEnergy(store, { device: row.device, start: session.start, end: session.end, now });
    const headKey = `easee:session-check-head:${digest(row.device)}`, head = store.getState(headKey);
    const quality = ['estimated', ...(session.quality ?? []).filter(flag => flag === 'counter-reset'),
      ...(!compared ? ['incomplete-coverage'] : compared.edgeEstimated ? ['estimated-boundary'] : []),
      ...(head && session.start < head.end ? ['out-of-order'] : [])];
    const eventId = recordChargingSessionCheck(store, { source: 'easee', sessionKey: session.sessionKey,
      ...(['cloud', 'ocpp'].includes(row.raw?.transport) ? { transport: row.raw.transport } : {}),
      start: session.start, end: session.end, estimatedKwh: compared?.estimatedKwh ?? null,
      referenceKwh: session.referenceKwh, complete: !!compared && !quality.includes('counter-reset') && !quality.includes('out-of-order'), quality });
    store.setState(stateKey, { eventId, fingerprint });
    store.setState(headKey, { end: Math.max(head?.end ?? session.end, session.end) });
    recorded++;
  }
  return recorded;
}
