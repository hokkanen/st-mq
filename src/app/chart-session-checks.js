import { SESSION_CHECK_INFO } from '../domain/history-series.js';
import { assertCurrentChargingSessionCheck, comparableChargingSession } from './charging-session-checks.js';

// Project the existing finalized checks. No second reference series or cumulative
// charger counter is recorded, and no value is held between unrelated sessions.
export function addChargingSessionChecks({ store, range, now, envelopes }) {
  const selected = Object.entries(SESSION_CHECK_INFO).filter(([signal]) => envelopes[signal]);
  if (!selected.length) return { records: 0 };
  const bySource = new Map(selected.map(([signal, info]) => [info.source, signal]));
  let records = 0;
  for (const row of store.db.prepare("SELECT payload FROM events WHERE type='charging-session-check' AND at>=? AND at<=? ORDER BY at,id")
    .iterate(range.from, Math.min(range.to, now))) {
    const check = JSON.parse(row.payload), signal = bySource.get(check.source);
    assertCurrentChargingSessionCheck(check);
    if (!signal || check.version !== 1 || !Number.isSafeInteger(check.end) || !Number.isSafeInteger(check.start)
      || check.end <= check.start || check.end < range.from || check.end > Math.min(range.to, now)) continue;
    const referenceKwh = Number.isFinite(check.referenceKwh) && check.referenceKwh >= 0 ? check.referenceKwh : null;
    envelopes[signal].add(check.end, referenceKwh, { auditOnly: true, sessionCheck: true,
      ...(check.source === 'easee' ? { source: check.source, transport: check.transport ?? null } : {}),
      sessionStart: check.start, sessionEnd: check.end, referenceKwh,
      estimatedKwh: Number.isFinite(check.estimatedKwh) && check.estimatedKwh >= 0 ? check.estimatedKwh : null,
      referenceBasis: 'electricity-meter',
      comparisonEligible: comparableChargingSession(check), quality: check.quality });
    records++;
  }
  return { records };
}
