import { GARAGE_INTENT_EVENT, validateGarageIntent } from '../garage/intent-history.js';

/** One indexed predecessor and the selected event window. Readback freshness
 * never participates: these intervals describe saved identity-bound intent. */
export function addGarageIntent({ store, input, range, now, envelope, activity }) {
  if (!envelope) return;
  const until = Math.min(range.to, now);
  if (until <= range.from) return;
  const seed = store.db.prepare(`SELECT id,at,payload FROM active_events WHERE type=? AND at<?
    AND json_extract(payload,'$.input')=? ORDER BY at DESC,id DESC LIMIT 1`).get(GARAGE_INTENT_EVENT, range.from, input);
  const rows = store.db.prepare(`SELECT id,at,payload FROM active_events WHERE type=? AND at>=? AND at<=?
    AND json_extract(payload,'$.input')=? ORDER BY at,id`).iterate(GARAGE_INTENT_EVENT, range.from, until, input);
  let previous = seed;
  function interval(row, end) {
    const state = validateGarageIntent(JSON.parse(row.payload)), start = Math.max(range.from, row.at);
    if (end < start) return;
    if (!state.selection || state.selection.selectedAt > row.at) { envelope.add(start, null); return; }
    const value = state.selection.mode === 'away' ? 1 : 0;
    const metadata = { savedIntent: true, requested: true, observedAt: state.selection.selectedAt,
      selectedAt: state.selection.selectedAt, intentRecordedAt: row.at, intentBasis: state.selection.basis,
      scopeRevision: row.id, intervalStart: start, intervalEnd: end };
    if (start === end) {
      if (row.at === end) { envelope.add(start, value, metadata); activity?.point(start, value, metadata); }
      return;
    }
    envelope.add(start, value, metadata); envelope.add(end - 1, value, { ...metadata, displayBoundary: true });
    envelope.add(end, null, { displayBoundary: true });
    activity?.add(start, end, value, metadata);
  }
  for (const row of rows) {
    if (previous) interval(previous, row.at);
    previous = row;
  }
  if (previous) interval(previous, until);
}
