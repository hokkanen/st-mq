import { HELD_TEMPERATURE_SIGNALS, INDOOR_ATTENTION_MS } from '../domain/indoor-sensors.js';

const ALLOWED = new Set(['good', 'simulated', 'historical', 'converted_fahrenheit', 'stale']);

/** Age is an attention condition, independent of whether a measurement is real.
 * Live acquisition-only values may serve control; the committed lookup below
 * additionally rejects them so the learner sees only recorded observations. */
export function indoorReadingUsable(observation, at) {
  if (!observation || !HELD_TEMPERATURE_SIGNALS.includes(observation.signal)
    || !Number.isFinite(observation.value) || !Number.isFinite(observation.sourceTime)
    || !Number.isFinite(observation.receivedAt) || observation.sourceTime > at
    || observation.receivedAt > at || observation.sourceTime > observation.receivedAt
    || !['degC', '°C'].includes(observation.unit) || observation.source === 'controller-estimate'
    || observation.raw?.auditOnly || observation.raw?.retained === true
    || observation.raw?.timeBasis === 'availability-transition'
    || (observation.quality ?? []).some(flag => !ALLOWED.has(flag))) return false;
  if (observation.source?.startsWith('husdata') && observation.raw?.usableForControl !== true
    && !(observation.quality?.includes('stale') && observation.raw?.verification)) return false;
  return observation.signal === 'garage_temperature'
    ? observation.value >= -60 && observation.value <= 70 : observation.value > 2 && observation.value < 40;
}

export function indoorReadingAttention(reading, at, { latest = reading } = {}) {
  const attentionReasons = [];
  if (reading && at - reading.sourceTime > INDOOR_ATTENTION_MS) attentionReasons.push('old-reading');
  if (latest && reading && latest !== reading && latest.receivedAt >= reading.receivedAt
    && latest.source === reading.source && latest.device === reading.device && latest.signal === reading.signal
    && latest.receivedAt <= at && latest.raw?.retained !== true && !latest.quality?.includes('retained')) {
    if (latest.quality?.some(flag => /disconnected|subscription-failed/.test(flag))) attentionReasons.push('disconnected');
    else if (!indoorReadingUsable(latest, at)) attentionReasons.push('invalid-reading');
  }
  return { needsAttention: attentionReasons.length > 0, attentionReasons, held: attentionReasons.length > 0 };
}

const decode = row => ({ id: row.id, source: row.source, device: row.device, signal: row.signal,
  value: row.value, unit: row.unit, sourceTime: row.source_time, receivedAt: row.received_at,
  quality: JSON.parse(row.quality), raw: row.raw ? JSON.parse(row.raw) : null,
  provenance: row.import_id === null ? null : { importId: row.import_id, rowNumber: row.row_number } });

/** Last genuine indoor measurement known at a causal boundary. Availability
 * events and age do not erase it, and no receipt/coverage span renews its time. */
export function lastIndoorReading(store, { signal, at, input, notBefore = -Infinity }) {
  const scope = input === 'simulated' ? "o.source='simulation'" : "o.source<>'simulation'";
  let newerCoverage;
  const withRecordedOrder = observation => {
    // Older recorder rows used "stale" for both age and source-time rollback.
    // A compressed fresh update can prove a rollback even when its actual value
    // was not saved. Only evidence already known on receipt may reject the row;
    // coverage never changes the retained measurement's original timestamp.
    if (observation.quality.includes('stale') && !observation.quality.includes('out-of-order-source-time')) {
      newerCoverage ??= store.db.prepare(`SELECT 1 FROM recorder_coverage
        WHERE source=? AND device=? AND signal=? AND status='fresh'
          AND source_time>? AND source_time<=? AND end_at<=? LIMIT 1`);
      if (newerCoverage.get(observation.source, observation.device, observation.signal,
        observation.sourceTime, observation.receivedAt, observation.receivedAt))
        return { ...observation, quality: [...observation.quality, 'out-of-order-source-time'] };
    }
    return observation;
  };
  const query = store.db.prepare(`SELECT o.* FROM observations o LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.signal=? AND o.source_time>=? AND o.source_time<=? AND o.received_at<=?
      AND o.value IS NOT NULL AND (o.import_id IS NULL OR i.status='complete') AND ${scope}
    ORDER BY o.source_time DESC,o.id DESC`);
  for (const row of query.iterate(signal, notBefore, at, at)) {
    const observation = withRecordedOrder(decode(row));
    if (!observation.raw?.acquisitionOnly && indoorReadingUsable(observation, at)) {
      const after = store.db.prepare(`SELECT * FROM observations WHERE signal=? AND source=? AND device=?
        AND received_at>=? AND received_at<=? AND (source_time IS NULL OR source_time>=? AND source_time<=?)
        ORDER BY received_at DESC,id DESC`);
      let latest = observation;
      for (const attempt of after.iterate(signal, observation.source, observation.device, observation.receivedAt, at, observation.sourceTime, at)) {
        const candidate = withRecordedOrder(decode(attempt));
        if (candidate.raw?.retained === true || candidate.quality?.includes('retained') || candidate.raw?.acquisitionOnly) continue;
        latest = candidate; break;
      }
      return { ...observation, ...indoorReadingAttention(observation, at, { latest }) };
    }
  }
  return null;
}
