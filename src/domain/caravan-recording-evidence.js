import { observationAvailableAt } from './time-evidence.js';

// Native appliance and supporting meter clocks expire independently. A renewal
// of this evidence is neither a configured report-policy edit nor a new value.
export const caravanState = o => o?.source === 'mqtt-equipment' && o.device === 'caravan_dehumidifier'
  && o.signal === 'caravan_dehumidifier_state' && o.unit === 'state';
const time = n => Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000;
const age = n => Number.isSafeInteger(n) && n > 0;
const keys = (o, wanted) => o && typeof o === 'object' && !Array.isArray(o)
  && Object.keys(o).length === wanted.length && wanted.every(key => Object.hasOwn(o, key));

export const hasCaravanEvidence = o => caravanState(o) && o.raw?.maxAgeMs !== undefined;

export function caravanRecordingEvidence(o) {
  if (!hasCaravanEvidence(o) || ![0, 1, 2, 3].includes(o.value)) return null;
  const raw = o.raw;
  return { availableAt: observationAvailableAt(o) ?? o.receivedAt,
    maxAgeMs: raw.maxAgeMs, power: raw.fieldTimestamps?.power,
    ...(o.value !== 0 ? { fanSpeed: raw.fieldTimestamps?.fanSpeed } : {}),
    ...(raw.locationEvidence ? { meter: { observedAt: raw.locationEvidence.meterObservedAt,
      maxAgeMs: raw.locationEvidence.maxAgeMs } } : {}) };
}

export function caravanEvidenceDeadline(evidence) {
  const fields = ['availableAt', 'maxAgeMs', 'power', ...(Object.hasOwn(evidence ?? {}, 'fanSpeed') ? ['fanSpeed'] : []),
    ...(Object.hasOwn(evidence ?? {}, 'meter') ? ['meter'] : [])];
  if (!keys(evidence, fields) || !time(evidence.availableAt) || !age(evidence.maxAgeMs) || !time(evidence.power)
    || fields.includes('fanSpeed') && !time(evidence.fanSpeed)
    || fields.includes('meter') && (!keys(evidence.meter, ['observedAt', 'maxAgeMs'])
      || !time(evidence.meter.observedAt) || !age(evidence.meter.maxAgeMs))) return null;
  const deadline = Math.min(evidence.power + evidence.maxAgeMs,
    fields.includes('fanSpeed') ? evidence.fanSpeed + evidence.maxAgeMs : Infinity,
    evidence.meter ? evidence.meter.observedAt + evidence.meter.maxAgeMs : Infinity);
  return time(deadline) ? deadline : null;
}

export function caravanEvidenceContinues(previous, next, at) {
  const deadline = caravanEvidenceDeadline(previous), nextDeadline = caravanEvidenceDeadline(next);
  return deadline !== null && nextDeadline !== null && at < deadline && at < nextDeadline
    && previous.maxAgeMs === next.maxAgeMs && next.power >= previous.power
    && (previous.fanSpeed === undefined ? next.fanSpeed === undefined : next.fanSpeed >= previous.fanSpeed)
    && (previous.meter ? next.meter?.maxAgeMs === previous.meter.maxAgeMs
      && next.meter.observedAt >= previous.meter.observedAt : !next.meter);
}

/** Validate a compact endpoint against its original immutable observation.
 * Readers before that endpoint use only the original clocks, never the future. */
export function validCaravanCoverageEvidence(o, span) {
  const evidence = span.evidence === null ? null : JSON.parse(span.evidence);
  if (span.status !== 'fresh' || !hasCaravanEvidence(o)) return evidence === null;
  const original = caravanRecordingEvidence(o), deadline = caravanEvidenceDeadline(evidence);
  return deadline !== null && span.end_at < deadline && evidence.availableAt === span.end_at
    && evidence.maxAgeMs === original?.maxAgeMs && evidence.power >= original.power && evidence.power <= span.end_at
    && (o.value === 0 ? evidence.fanSpeed === undefined
      : time(evidence.fanSpeed) && evidence.fanSpeed >= original.fanSpeed && evidence.fanSpeed <= span.end_at)
    && span.source_time === Math.max(evidence.power, evidence.fanSpeed ?? evidence.power)
    && (original.meter ? evidence.meter?.maxAgeMs === original.meter.maxAgeMs
      && evidence.meter.observedAt >= original.meter.observedAt && evidence.meter.observedAt <= span.end_at : !evidence.meter);
}

export function caravanCoverageDeadline(o, span, at) {
  if (!hasCaravanEvidence(o)) return null;
  // Compact endpoints deliberately do not claim intermediate receipt clocks.
  return caravanEvidenceDeadline(span?.end_at <= at
    ? span.evidence ? JSON.parse(span.evidence) : null : caravanRecordingEvidence(o));
}
