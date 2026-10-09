import { createHash } from 'node:crypto';
import { validSharedAssessment } from './shared-assessment.js';

const invalid = () => new Error('Unsupported charging report context; start a fresh development database');
const digest = text => createHash('sha256').update(text).digest('hex');

/** Complete immutable contexts, scoped to one report. Events never reference
 * earlier events, so one bounded page needs no history replay or recursive reads.
 * The report transaction owns insertion, and its foreign keys own deletion. */
export function compactReportEvent(db, namespace, record, entry) {
  const payload = structuredClone(entry), scope = [namespace, record.chargerId, record.id];
  const intern = (kind, value) => {
    const text = JSON.stringify(value), hash = digest(text);
    const previous = db.prepare(`SELECT id,payload FROM charging_report_contexts
      WHERE namespace=? AND charger_id=? AND report_id=? AND kind=? AND digest=?`).get(...scope, kind, hash);
    if (previous) {
      if (previous.payload !== text) throw invalid();
      return previous.id;
    }
    return Number(db.prepare(`INSERT INTO charging_report_contexts(namespace,charger_id,report_id,kind,digest,payload)
      VALUES(?,?,?,?,?,?)`).run(...scope, kind, hash, text).lastInsertRowid);
  };
  let price = null, proposed = null, adopted = null;
  if (Array.isArray(payload.plan?.priceIntervals)) {
    price = intern('prices', payload.plan.priceIntervals);
    delete payload.plan.priceIntervals;
  }
  if (payload.shared) {
    proposed = intern('model', payload.shared.proposed);
    adopted = intern('model', payload.shared.adopted);
    delete payload.shared.proposed; delete payload.shared.adopted;
  }
  return { payload: JSON.stringify(payload), price, proposed, adopted };
}

export function expandReportEvents(db, namespace, chargerId, reportId, rows) {
  // At most three contexts per event; the caller already bounds pages at 100.
  const cache = new Map();
  const context = (id, kind) => {
    if (!Number.isSafeInteger(id) || id < 1) throw invalid();
    const key = `${kind}:${id}`;
    if (!cache.has(key)) {
      const row = db.prepare(`SELECT digest,payload FROM charging_report_contexts
        WHERE id=? AND namespace=? AND charger_id=? AND report_id=? AND kind=?`)
        .get(id, namespace, chargerId, reportId, kind);
      if (!row || digest(row.payload) !== row.digest) throw invalid();
      cache.set(key, JSON.parse(row.payload));
    }
    return structuredClone(cache.get(key));
  };
  return rows.map(row => {
    const entry = JSON.parse(row.payload);
    if (entry.plan && row.price_context_id === null && entry.plan.priceIntervals !== null) throw invalid();
    if (row.price_context_id !== null) {
      if (!entry.plan || Object.hasOwn(entry.plan, 'priceIntervals')) throw invalid();
      const prices = context(row.price_context_id, 'prices');
      const time = value => Number.isSafeInteger(value) && value >= 0;
      if (!time(entry.plan.at) || !time(entry.plan.deadlineAt) || !Array.isArray(prices)
        || prices.some((price, index) => !price || Object.keys(price).sort().join(',') !== 'endAt,priceCtPerKwh,startAt'
          || !time(price.startAt) || !time(price.endAt) || price.endAt <= price.startAt || !Number.isFinite(price.priceCtPerKwh)
          || index > 0 && price.startAt < prices[index - 1].endAt)) throw invalid();
      entry.plan.priceIntervals = prices
        .map(price => ({ ...price, startAt: Math.max(price.startAt, entry.plan.at),
          endAt: Math.min(price.endAt, entry.plan.deadlineAt) })).filter(price => price.endAt > price.startAt);
    }
    if (entry.shared) {
      if (Object.hasOwn(entry.shared, 'proposed') || Object.hasOwn(entry.shared, 'adopted')) throw invalid();
      entry.shared.proposed = context(row.proposed_context_id, 'model');
      entry.shared.adopted = context(row.adopted_context_id, 'model');
      if (!validSharedAssessment({ current: entry.shared, history: [], priorityChanges: 0,
        coverage: { overlap: 'not-exercised', priority: 'not-exercised', jointSchedule: 'not-exercised' } })) throw invalid();
    } else if (row.proposed_context_id !== null || row.adopted_context_id !== null) throw invalid();
    return { id: row.id, ...entry };
  });
}
