import { createHash } from 'node:crypto';
import { recordChargingSessionCheck } from '../app/charging-session-checks.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const energy = value => Number.isFinite(value) && value >= 0;

export function compareEaseeSessionEnergy(store, { device, start, end }) {
  if (typeof device !== 'string' || !instant(start) || !instant(end) || end <= start) return null;
  let estimatedKwh = 0, edgeEstimated = false;
  for (let phase = 1; phase <= 3; phase++) {
    const rows = store.db.prepare(`SELECT value,raw,quality,source_time FROM observations WHERE source='easee'
      AND device=? AND signal=? AND source_time>?
      AND (source_time<=? OR json_extract(raw,'$.intervalStart')<?) ORDER BY source_time,id`)
      .iterate(device, `ev1_energy_l${phase}`, start, end, end);
    let cursor = start;
    for (const row of rows) {
      const raw = row.raw ? JSON.parse(row.raw) : null, quality = JSON.parse(row.quality);
      if (!raw || !instant(raw.intervalStart) || !instant(raw.intervalEnd) || raw.intervalEnd !== row.source_time || raw.intervalEnd <= raw.intervalStart
        || raw.intervalStart > cursor || raw.intervalStart < cursor && cursor !== start || raw.intervalEnd <= cursor
        || !energy(row.value) || quality.some(flag => /missing|stale|unavailable|gap|failed/.test(flag))) return null;
      const until = Math.min(end, raw.intervalEnd);
      edgeEstimated ||= cursor !== raw.intervalStart || until !== raw.intervalEnd;
      estimatedKwh += row.value * (until - cursor) / (raw.intervalEnd - raw.intervalStart);
      cursor = until;
    }
    if (cursor !== end) return null;
  }
  return { estimatedKwh, edgeEstimated };
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
    const compared = compareEaseeSessionEnergy(store, { device: row.device, start: session.start, end: session.end });
    const headKey = `easee:session-check-head:${digest(row.device)}`, head = store.getState(headKey);
    const quality = ['estimated', ...(session.quality ?? []).filter(flag => flag === 'counter-reset'),
      ...(!compared ? ['incomplete-coverage'] : compared.edgeEstimated ? ['estimated-boundary'] : []),
      ...(head && session.start < head.end ? ['out-of-order'] : [])];
    const eventId = recordChargingSessionCheck(store, { source: 'easee', sessionKey: session.sessionKey,
      start: session.start, end: session.end, estimatedKwh: compared?.estimatedKwh ?? null,
      referenceKwh: session.referenceKwh, complete: !!compared && !quality.includes('counter-reset') && !quality.includes('out-of-order'), quality });
    store.setState(stateKey, { eventId, fingerprint });
    store.setState(headKey, { end: Math.max(head?.end ?? session.end, session.end) });
    recorded++;
  }
  return recorded;
}
