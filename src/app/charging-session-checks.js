import { createHash } from 'node:crypto';

const EVENT_TYPE = 'charging-session-check';
const VERSION = 1;
const SOURCES = Object.freeze({
  easee: { signal: 'ev1_session_energy_check', basis: 'electricity-meter' },
  'shelly-evse': { signal: 'shelly_session_energy_check', basis: 'electricity-meter' },
});
const QUALITY = new Set(['estimated', 'estimated-boundary', 'incomplete-coverage', 'missing-start', 'missing-end',
  'counter-reset', 'out-of-order', 'stale', 'disconnected', 'assignment-uncertain', 'duplicate-suspected', 'missing-final-reference']);
const COMPARABLE_QUALITY = new Set(['estimated', 'estimated-boundary']);
const digest = value => createHash('sha256').update(value).digest('hex');
const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const energy = value => value === null || Number.isFinite(value) && value >= 0;

export function comparableChargingSession(check) {
  return check?.version === VERSION && check.complete === true
    && Number.isFinite(check.estimatedKwh) && check.estimatedKwh >= 0
    && Number.isFinite(check.referenceKwh) && check.referenceKwh > 0
    && Array.isArray(check.quality) && check.quality.every(flag => COMPARABLE_QUALITY.has(flag));
}

// Only public reason codes leave this summary. Count each reason once per
// session; a session can have several reasons, so the counts need not add up to
// excludedSessions. Old checks without a specific diagnosis remain honest.
function exclusionReasons(check) {
  const reasons = new Set((Array.isArray(check.quality) ? check.quality : [])
    .filter(flag => QUALITY.has(flag) && !COMPARABLE_QUALITY.has(flag)));
  if ((!Number.isFinite(check.estimatedKwh) || check.estimatedKwh < 0) && !reasons.has('incomplete-coverage')) reasons.add('missing-estimate');
  if (!Number.isFinite(check.referenceKwh) || check.referenceKwh < 0) reasons.add('missing-reference');
  else if (check.referenceKwh === 0) reasons.add('zero-reference');
  if (!reasons.size) reasons.add('comparison-incomplete');
  return reasons;
}

/** Finalized session checks only. The producer must establish actual session
 * boundaries and matching energy coverage; lifetime-counter periods are not
 * sessions. Complete describes coverage, not whether the session has ended.
 * Raw device/account identifiers and telemetry payloads are never copied here.
 */
export function recordChargingSessionCheck(store, input) {
  if (!input || typeof input.source !== 'string' || !Object.hasOwn(SOURCES, input.source)) throw new TypeError('Invalid charging check source');
  if (typeof input.sessionKey !== 'string' || !input.sessionKey.trim() || input.sessionKey.length > 512)
    throw new TypeError('Invalid charging session key');
  if (!instant(input.start) || !instant(input.end) || input.end <= input.start)
    throw new TypeError('Invalid charging session interval');
  if (!energy(input.estimatedKwh) || !energy(input.referenceKwh)) throw new TypeError('Invalid charging session energy');
  if (typeof input.complete !== 'boolean') throw new TypeError('Charging session coverage is required');
  const quality = input.quality ?? [];
  if (!Array.isArray(quality) || quality.some(flag => !QUALITY.has(flag))) throw new TypeError('Invalid charging session quality');
  if (input.transport !== undefined && !['cloud','ocpp'].includes(input.transport)) throw new TypeError('Invalid charging check transport');
  const check = { version: VERSION, source: input.source, start: input.start, end: input.end,
    estimatedKwh: input.estimatedKwh, referenceKwh: input.referenceKwh, complete: input.complete,
    quality: [...new Set(quality)].sort(), ...(input.transport ? {transport:input.transport} : {}) };
  // Hash identifiers before persistence; keep the source in the identity so the
  // two providers can use the same session key without colliding.
  const key = `${EVENT_TYPE}:${digest(JSON.stringify([input.source, input.sessionKey]))}`;
  const fingerprint = digest(JSON.stringify(check));
  return store.transaction(() => {
    const previous = store.getState(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Conflicting finalized charging session check');
      return previous.eventId;
    }
    const eventId = store.event(EVENT_TYPE, check, check.end);
    store.setState(key, { eventId, fingerprint });
    return eventId;
  });
}

/** Read-only aggregates over every stored check, independently for each source.
 * No counter readings are converted into sessions and no acquisition is started.
 */
export function chargingSessionCheckSummaries(store) {
  const rows = Object.entries(SOURCES).map(([source, descriptor]) => ({ kind: 'charging-session-summary', source,
    signal: descriptor.signal, summary: { basis: descriptor.basis, recordedSessions: 0, comparedSessions: 0,
      excludedSessions: 0, exclusionReasons: {}, estimatedKwh: 0, referenceKwh: 0, differenceKwh: null, differencePercent: null,
      start: null, end: null, lastSessionEnd: null, referenceTransports: [] } }));
  const bySource = new Map(rows.map(row => [row.source, row.summary]));
  // Store.events() has a page limit. Iteration deliberately includes all history
  // without loading every session into memory or silently averaging one page.
  for (const row of store.db.prepare('SELECT payload FROM events WHERE type=? ORDER BY at,id').iterate(EVENT_TYPE)) {
    const check = JSON.parse(row.payload), summary = bySource.get(check.source);
    if (!summary || check.version !== VERSION) continue;
    const transport = ['cloud','ocpp'].includes(check.transport) ? check.transport : 'unknown';
    if (!summary.referenceTransports.includes(transport)) summary.referenceTransports.push(transport);
    summary.recordedSessions++;
    summary.lastSessionEnd = Math.max(summary.lastSessionEnd ?? check.end, check.end);
    if (!comparableChargingSession(check)) {
      summary.excludedSessions++;
      for (const reason of exclusionReasons(check)) summary.exclusionReasons[reason] = (summary.exclusionReasons[reason] ?? 0) + 1;
      continue;
    }
    summary.comparedSessions++;
    summary.start = Math.min(summary.start ?? check.start, check.start);
    summary.end = Math.max(summary.end ?? check.end, check.end);
    summary.estimatedKwh += check.estimatedKwh;
    summary.referenceKwh += check.referenceKwh;
  }
  for (const { summary } of rows) {
    if (!summary.comparedSessions) continue;
    summary.differenceKwh = summary.estimatedKwh - summary.referenceKwh;
    summary.differencePercent = summary.differenceKwh / summary.referenceKwh * 100;
  }
  return rows;
}
