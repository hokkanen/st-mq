/** Action receipts are history for one day; active control and restoration have
 * their own lifetimes and must never be inferred from a visible receipt. */
export const ACTION_RECEIPT_MS = 24 * 60 * 60 * 1000;
export const actionReceiptRecent = (at, now = Date.now()) => Number.isFinite(at)
  && Number.isFinite(now) && at <= now && now - at < ACTION_RECEIPT_MS;

/** Keep the last resolved evidence for this receipt when later polls lose it.
 * Each control owns one tracker; a new request key starts a new history entry. */
export function createReceiptTracker() {
  let previousKey, previous;
  return (key, receipt, now = Date.now()) => {
    if (!receipt || !actionReceiptRecent(receipt.at ?? receipt.requestedAt, now)) {
      previousKey = key; previous = null; return null;
    }
    if (key !== previousKey) { previousKey = key; previous = null; }
    const next = { ...receipt };
    if (previous) {
      if (previous.confirmed && !next.superseded) next.confirmed = true;
      if (previous.evidenceAt != null && (next.evidenceAt == null || next.evidenceAt < previous.evidenceAt)) {
        for (const field of ['observedPhase', 'observedValue', 'evidenceAt', 'confirmed', 'superseded'])
          if (Object.hasOwn(previous, field)) next[field] = previous[field];
      }
      if (previous.superseded && !(next.evidenceAt > previous.evidenceAt)) { next.superseded = true; next.active = false; next.lifecycle = 'superseded'; }
      else if (previous.active === false && next.active === true && previous.lifecycle !== 'failed'
        && !(next.evidenceAt > previous.evidenceAt)) { next.active = false; next.lifecycle = previous.lifecycle; }
    }
    previous = next;
    return next;
  };
}
