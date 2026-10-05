import { readChargingAllowanceHistory } from '../charging/allowance-history.js';

export const CHARGING_ALLOWANCE_SERIES = Object.freeze(['ev1_current_allowance', 'ev2_current_allowance', 'ev2_current_fallback']);
const normal = span => ['unrestricted', 'limited'].includes(span.mode);

/** The reader bounds exact decision spans. Keep their original boundaries
 * rather than averaging states or joining normal allowance across fallback.
 * Equipment identifiers and native-setting diagnostics stay out of chart data. */
export function addChargingAllowanceHistory({ store, range, now, input, envelopes, maxSpans }) {
  if (!CHARGING_ALLOWANCE_SERIES.some(signal => envelopes[signal])) return null;
  const history = readChargingAllowanceHistory({ store, range, now, input, maxSpans });
  const metadata = {};
  for (const [id, signals] of [['charger1', ['ev1_current_allowance']], ['charger2', ['ev2_current_allowance', 'ev2_current_fallback']]]) {
    const record = history[id];
    metadata[id] = { records: record.spans.length, truncated: record.truncated };
    for (const signal of signals) {
      if (!envelopes[signal]) continue;
      const points = [], fallback = signal.endsWith('_fallback');
      const accepted = span => (fallback ? span?.mode === 'fallback' : span && normal(span))
        && Number.isFinite(span.allowanceA) && span.allowanceA >= 0;
      for (const [index, span] of record.spans.entries()) {
        const start = Math.max(range.from, span.start), end = Math.min(range.to, now, span.end);
        if (end <= start) continue;
        const y = accepted(span) ? span.allowanceA : null;
        const detail = { chargingAllowance: true, source: span.source, mode: span.mode, reason: span.reason,
          intervalStart: span.start, intervalEnd: span.end, measuredAt: span.measuredAt, receivedAt: span.receivedAt,
          ...(span.sourceTimes ? { sourceTimes: span.sourceTimes } : {}) };
        points.push({ ...detail, x: start, y }, { ...detail, x: end - 1, y });
        const next = record.spans[index + 1];
        if (y !== null && (next?.start !== end || !accepted(next))) points.push({ x: end, y: null });
      }
      // A gap-end marker and an explicit unknown start may coincide. Missing
      // evidence wins; identical known endpoints retain their source metadata.
      const ordered = [];
      for (const point of points) {
        const previous = ordered.at(-1);
        if (previous?.x === point.x) {
          if (previous.y !== null || point.y === null) ordered[ordered.length - 1] = point;
        } else ordered.push(point);
      }
      envelopes[signal] = { count: ordered.length, values: () => ordered };
    }
  }
  return metadata;
}
