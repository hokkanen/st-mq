const QUARTER_HOUR = 15 * 60_000;
const INVALID_PRICE = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'invalid_value', 'invalid-value',
  'invalid-payload', 'conflicting_duplicate', 'future_source_time', 'future-source-time',
  'unverified-scaling', 'provider_error']);

function validPrice(row) {
  if (!Number.isFinite(row.value) || !['c/kWh_ex_vat', 'c/kWh'].includes(row.unit)) return false;
  try {
    const quality = JSON.parse(row.quality);
    return Array.isArray(quality) && quality.every(flag => typeof flag === 'string' && !INVALID_PRICE.has(flag));
  } catch { return false; }
}

function supersedes(row, previous) {
  if (!previous) return true;
  const native = row.import_id === null, previousNative = previous.import_id === null;
  if (native !== previousNative) return native;
  if (row.source_time !== previous.source_time) return row.source_time > previous.source_time;
  if (!native) {
    if (row.import_id !== previous.import_id) return row.import_id > previous.import_id;
    if (row.row_number !== previous.row_number) return row.row_number > previous.row_number;
  }
  return row.id > previous.id;
}

/** The legacy logger records the current spot price every quarter hour, with
 * processing delay in its timestamp. Treat each scalar as that containing UTC
 * quarter-hour's price for historical estimates, never as an indefinite hold.
 * These reconstructed intervals are subordinate to explicit provider intervals.
 */
export function historicalSpotIntervals(store, range, now) {
  const result = [];
  let slot = null, winner = null;
  const flush = () => {
    // Resolve precedence before rejecting values: a newer missing reading must
    // not resurrect an older value from the same slot or an imported copy.
    if (!winner || !validPrice(winner)) return;
    result.push({ start: Math.max(range.from, slot), end: Math.min(range.to, slot + QUARTER_HOUR),
      spotCtPerKwh: winner.value, unit: 'c/kWh', vatIncluded: false,
      source: 'historical-spot', intervalBasis: 'recorded-quarter-hour' });
  };
  const rows = store.db.prepare(`SELECT o.id,o.value,o.unit,o.source_time,o.quality,o.import_id,o.row_number
    FROM observations o INDEXED BY observations_signal_time LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.signal='spot_price' AND o.source_time>=? AND o.source_time<? AND o.source_time<=?
    AND o.source<>'simulation'
    AND NOT(o.source IN ('controller-learning','controller-estimate','controller') AND o.device='simulated')
    AND (o.import_id IS NULL OR i.status='complete' AND i.kind='stmq')
    ORDER BY o.source_time,o.id`)
    .iterate(Math.floor(range.from / QUARTER_HOUR) * QUARTER_HOUR, range.to, now);
  for (const row of rows) {
    const nextSlot = Math.floor(row.source_time / QUARTER_HOUR) * QUARTER_HOUR;
    if (nextSlot !== slot) {
      flush();
      slot = nextSlot;
      winner = null;
    }
    if (supersedes(row, winner)) winner = row;
  }
  flush();
  return result;
}
