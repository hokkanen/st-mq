import { RECORDED_EVIDENCE_SIGNALS } from '../domain/history-series.js';

const stateSignals = new Set(RECORDED_EVIDENCE_SIGNALS.filter(signal => !['garage_native_energy', 'garage_energy'].includes(signal)));

/** Exact reported evidence with its original deadline. The application does
 * not turn an unqualified report into a command acknowledgement or water flow. */
export class RecordedEvidenceLine {
  constructor(envelope, range, now) {
    this.envelope = envelope; this.range = range; this.now = now; this.previous = null;
  }

  add(row, value) {
    const at = row.source_time;
    this.flush(at);
    let raw = {}, quality = [];
    try { raw = JSON.parse(row.raw ?? '{}') ?? {}; } catch { /* Absent provenance grants no hold. */ }
    try { quality = JSON.parse(row.quality ?? '[]'); } catch { quality = ['missing']; }
    if (!Array.isArray(quality)) quality = ['missing'];
    const categorical = stateSignals.has(row.signal);
    const unitValid = categorical ? row.unit === 'state' && [0, 1].includes(value)
      : row.unit === 'kWh' && Number.isFinite(value) && value >= 0;
    const interval = row.signal === 'garage_energy';
    const intervalValid = !interval || Number.isSafeInteger(raw.intervalStart) && raw.intervalEnd === at
      && raw.intervalEnd > raw.intervalStart && raw.intervalEnd - raw.intervalStart <= 900_000
      && at <= row.received_at && raw.coveredMs === raw.intervalEnd - raw.intervalStart
      && raw.timingEligible === true && raw.meterScope === 'garage-heat-pump-only'
      && ['counter-delta', 'power-trapezoid'].includes(raw.energyBasis);
    const valid = unitValid && intervalValid && !quality.some(flag => typeof flag !== 'string'
      || /^(missing|unavailable|invalid|unsupported|unverified|stale|retained|failed|future[-_]source[-_]time|out[-_]of[-_]order)/.test(flag))
      && (!categorical || raw.retained !== true) && raw.diagnosticAvailable !== false && raw.verified !== false;
    const observedAt = row.observedAt ?? raw.recorder?.originalSourceTime ?? at;
    const metadata = { source: row.source, quality, observedAt, recordedEvidence: true,
      ...(row.signal === 'garage_native_energy' ? { auditOnly: true } : {}),
      ...(raw.basis ? { basis: raw.basis } : {}),
      ...(raw.provisional === true ? { provisional: true } : {}),
      ...(interval ? { intervalStart: raw.intervalStart, intervalEnd: raw.intervalEnd,
        basis: raw.energyBasis, accuracyVerified: raw.accuracyVerified === true, fromEnergy: true } : {}),
      ...(row.periodicCoverage ? { periodicCoverage: true, coverageId: row.coverageId,
        displayBoundary: true, reportExpiresAt: row.reportExpiresAt } : {}),
    };
    this.envelope.add(at, valid ? value : null, metadata);
    let expiresAt = at;
    if (categorical) {
      if (row.periodicCoverage && Number.isFinite(row.reportExpiresAt)) expiresAt = row.reportExpiresAt;
      else if (raw.eventOnly === true) expiresAt = Infinity;
      else if (Number.isFinite(raw.maxAgeMs) && raw.maxAgeMs > 0) expiresAt = observedAt + raw.maxAgeMs;
    }
    this.previous = { at, value: valid ? value : null, expiresAt, metadata };
  }

  flush(until = Math.min(this.range.to, this.now)) {
    const previous = this.previous;
    if (!previous) return;
    const start = Math.max(this.range.from, previous.at);
    const end = Math.min(until, previous.expiresAt, this.range.to, this.now);
    if (end > start && previous.value !== null) {
      const metadata = { ...previous.metadata, displayBoundary: true };
      this.envelope.add(start, previous.value, metadata);
      this.envelope.add(end - 1, previous.value, metadata);
    }
    if (previous.expiresAt < until) this.envelope.add(Math.max(this.range.from, previous.expiresAt + (previous.expiresAt === previous.at ? 1 : 0)), null,
      { ...previous.metadata, displayBoundary: true, expired: true });
  }
}
