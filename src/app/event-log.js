import { createHash } from 'node:crypto';
import { readCheckpoint, matchingCheckpoint, checkpointAt, journalBase } from '../storage/journal.js';
import { GENERAL_EVENT_TYPES, presentGeneral, presentCharging, presentFirewood, presentSensor, validTime } from './event-log-presentation.js';

export const EVENT_LOG_AREAS = Object.freeze(['all', 'home', 'charging', 'garage', 'caravan', 'system']);
const SOURCES = ['event', 'firewood', 'sensor', 'charging'];
const MAX_VISIBLE = 200, MAX_PAYLOAD = 8192, SENSOR_BOUND = 1024, REPORT_BOUND = 32, REPORT_SOURCE_BOUND = 256, CHARGING_ROW_BUDGET = 2048;
const invalid = () => Object.assign(new TypeError('Choose supported event filters and a valid history page.'), { code: 'event_log_query_invalid', statusCode: 400 });
export const changedEventLog = () => Object.assign(new Error('The recorded history changed. Refresh the event log before loading older entries.'), { code: 'event_log_context_changed', statusCode: 409 });
export const advancedEventLog = () => Object.assign(new Error('The event-log checkpoint is ahead of the requested snapshot. Refresh to use a current verified boundary.'), { code: 'event_log_checkpoint_advanced', statusCode: 503 });
const stableId = (source, id) => `${source}:${String(id).padStart(16, '0')}`;
const parseId = value => {
  if (typeof value !== 'string' || !/^(event|firewood|sensor|charging):\d{16}$/.test(value)) throw invalid();
  const [source, text] = value.split(':'), id = Number(text);
  if (!Number.isSafeInteger(id) || id < 1) throw invalid();
  return { source, id };
};
const parse = text => {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
};
export const compareEventLogEntries = (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
function decodeCursor(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw invalid();
  let result;
  try { result = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!result || Object.keys(result).sort().join(',') !== 'area,at,context,id,view'
    || !/^[a-f0-9]{64}$/.test(result.context) || !validTime(result.at)
    || !['important', 'all'].includes(result.view) || !EVENT_LOG_AREAS.includes(result.area)) throw invalid();
  parseId(result.id); return result;
}
export function eventLogQuery(url) {
  const accepted = ['view', 'area', 'before', 'limit', 'visible'];
  for (const key of url.searchParams.keys()) if (!accepted.includes(key) || url.searchParams.getAll(key).length !== 1) throw invalid();
  const view = url.searchParams.get('view') ?? 'important', area = url.searchParams.get('area') ?? 'all';
  const rawLimit = url.searchParams.get('limit'), limit = rawLimit === null ? 40 : Number(rawLimit);
  if (!['important', 'all'].includes(view) || !EVENT_LOG_AREAS.includes(area)
    || rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid();
  const beforeText = url.searchParams.get('before'), before = beforeText === null ? null : decodeCursor(beforeText);
  const visibleText = url.searchParams.get('visible');
  if (visibleText !== null && (visibleText.length > 8000 || !visibleText.length)) throw invalid();
  const visible = visibleText === null ? [] : visibleText.split(',');
  if (visible.length > MAX_VISIBLE || new Set(visible).size !== visible.length) throw invalid();
  visible.forEach(parseId);
  return { view, area, limit, before, visible };
}
function inputMatches(input, p, source = 'event') {
  if (input === 'offline') return true;
  if (source !== 'event') return true;
  // Older observations within this current schema sometimes have no input
  // field. Preserve that uncertainty instead of borrowing today's environment.
  return input === 'simulated' ? !['mqtt', 'providers'].includes(p.input) : p.input !== 'simulated';
}
function cursorBound(source, before, asOf) {
  const maximum = before ? Math.min(asOf, before.at) : asOf;
  if (!before || before.at > asOf) return { sql: 'at<=?', values: [maximum] };
  const old = parseId(before.id), order = source < old.source ? -1 : source > old.source ? 1 : 0;
  return order < 0 ? { sql: 'at<=?', values: [maximum] }
    : order > 0 ? { sql: 'at<?', values: [maximum] }
      : { sql: '(at<? OR (at=? AND id<?))', values: [maximum, maximum, old.id] };
}
function exclusions(db, generation, table, rows) {
  const excluded = new Set();
  for (let start = 0; start < rows.length; start += 128) {
    const ids = rows.slice(start, start + 128).map(row => String(row.id));
    if (!ids.length) continue;
    for (const row of db.prepare(`SELECT record_key FROM recovery_exclusions WHERE generation=? AND table_name=?
      AND record_key IN (${ids.map(() => '?').join(',')})`).all(generation, table, ...ids)) excluded.add(row.record_key);
  }
  return rows.filter(row => !excluded.has(String(row.id)));
}
function selectionMatches(row, epoch, segments) {
  return row.epoch === epoch || segments.some(segment => segment.source_epoch === row.epoch && row.id > segment.after_id && row.id <= segment.through_id);
}
function sourceInputs(input) { return input === 'offline' ? ['mqtt', 'providers', 'simulated'] : [input]; }
function reportNamespaces(input) { return sourceInputs(input).map(value => `charging:${value}:session-diagnostics`); }
function admitted(out, query) { return (query.area === 'all' || out.area === query.area) && (query.view === 'all' || out.important); }
function entry(source, row, out) {
  const { important, ...safe } = out;
  return { id: stableId(source, row.id), at: row.at, ...safe };
}

/** One immutable read boundary. The UI is a projection of canonical records,
 * never a new event journal. Indexed general/firewood time seeks are exact;
 * sparse sensor/report summaries have explicit scan bounds and coverage text. */
export function readEventLog({ db, input = 'mqtt', now = Date.now(), checkedAt = now, scope = 'live', snapshotAt = null,
  checkpoint, query = eventLogQuery(new URL('http://fixture/api/events')), work }) {
  if (!sourceInputs('offline').includes(input) && input !== 'offline' || !validTime(now) || !validTime(checkedAt)) throw invalid();
  const actual = readCheckpoint(db);
  if (checkpoint && !matchingCheckpoint(actual, checkpoint)) {
    // Receiver journals can compact an earlier operational checkpoint. A
    // same-identity forward sequence is only a retry hint, never accepted
    // evidence: the server must reacquire a freshly verified context and this
    // connection must still match that context exactly before returning rows.
    if (actual.databaseId === checkpoint.databaseId && actual.sequence > checkpoint.sequence) {
      const prior = checkpointAt(db, checkpoint.sequence);
      if (prior?.hash === checkpoint.hash || !prior && checkpoint.sequence < journalBase(db).sequence) throw advancedEventLog();
    }
    throw Object.assign(new Error('The event-log source no longer matches its verified snapshot.'), { code: 'event_log_unavailable', statusCode: 503 });
  }
  const generation = db.prepare('SELECT generation FROM history_selection WHERE id=1').get()?.generation;
  const inputs = sourceInputs(input), namespaces = reportNamespaces(input);
  const epochs = inputs.map(value => [value, db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(value)?.epoch ?? 'original']);
  const context = createHash('sha256').update(JSON.stringify([actual.databaseId, generation, input, epochs, namespaces])).digest('hex');
  if (query.before && (query.before.context !== context || query.before.view !== query.view || query.before.area !== query.area)) throw changedEventLog();
  const candidates = [], retained = new Map(), partial = new Set();
  if (work) Object.assign(work, { maximumCandidates: 0, chargingRows: 0, visibleChecks: query.visible.length });
  const push = (source, row, out, target = candidates) => {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !validTime(row.at) || row.at > now || !admitted(out, query)) return;
    const value = entry(source, row, out);
    if (target === candidates && query.before && compareEventLogEntries(value, query.before) <= 0) return;
    if (target === candidates) {
      // Keep the newest page and one continuation witness, rather than retaining
      // every decoded candidate from every source at once.
      const index = candidates.findIndex(existing => compareEventLogEntries(value, existing) < 0);
      const position = index < 0 ? candidates.length : index;
      if (position > query.limit) return;
      candidates.splice(position, 0, value);
      if (candidates.length > query.limit + 1) candidates.pop();
      if (work) work.maximumCandidates = Math.max(work.maximumCandidates, candidates.length);
    } else target.push(value);
  };
  const perType = Math.max(128, query.limit + 1), bound = cursorBound('event', query.before, now);
  const known = new Set(GENERAL_EVENT_TYPES);
  for (const type of GENERAL_EVENT_TYPES) {
    const preview = presentGeneral(type);
    if (!admitted(preview, query) && !['heating-phase-changed', 'heating-automation-changed', 'heating-pause-changed', 'occupancy-changed', 'charging-control-changed', 'caravan-control-changed'].includes(type)) continue;
    const rows = db.prepare(`SELECT id,at,type,substr(payload,1,?) payload FROM events
      WHERE type=? AND ${bound.sql} ORDER BY at DESC,id DESC LIMIT ?`).all(MAX_PAYLOAD, type, ...bound.values, perType);
    let accepted = 0;
    for (const row of exclusions(db, generation, 'events', rows)) {
      const p = parse(row.payload); if (!inputMatches(input, p)) continue;
      const out = presentGeneral(type, p); if (admitted(out, query)) accepted++;
      push('event', row, out);
    }
    if (rows.length === perType && accepted < Math.min(perType, query.limit + 1)) partial.add('selected operational history');
  }
  // Unrecognized current rows remain harmless and explicit. A bounded recent
  // diagnostic tail avoids a DISTINCT/full-history scan on every dashboard poll.
  if (query.view === 'all' && ['all', 'system'].includes(query.area)) {
    const rows = db.prepare('SELECT id,at,type,substr(payload,1,?) payload FROM events ORDER BY id DESC LIMIT 256').all(MAX_PAYLOAD);
    for (const row of exclusions(db, generation, 'events', rows)) if (!known.has(row.type) && inputMatches(input, parse(row.payload))) push('event', row, presentGeneral(row.type));
    if (rows.length === 256) partial.add('unrecognized diagnostic types');
  }
  if (['all', 'home'].includes(query.area)) {
    const fireBound = cursorBound('firewood', query.before, now);
    for (const value of inputs) {
      const rows = db.prepare(`SELECT id,input,at,kind,kg FROM fireplace_events WHERE input=? AND ${fireBound.sql}
        ORDER BY at DESC,id DESC LIMIT ?`).all(value, ...fireBound.values, perType);
      const selected = exclusions(db, generation, 'fireplace_events', rows);
      for (const row of selected) push('firewood', row, presentFirewood(row));
      if (rows.length === perType && selected.length < Math.min(perType, query.limit + 1)) partial.add('selected firewood history');
    }
    for (const [value, epoch] of epochs) {
      const segments = db.prepare('SELECT source_epoch,after_id,through_id FROM learning_epoch_segments WHERE epoch=? AND input=? LIMIT 257').all(epoch, value);
      if (segments.length > 256) partial.add('sensor recovery segments');
      const sources = db.prepare(`SELECT id,epoch,at,substr(payload,1,?) payload FROM learning_journal_entries INDEXED BY learning_sensor_contexts
        WHERE input=? AND kind='context' AND (json_type(payload,'$.value.sensorChange')='object' OR json_type(payload,'$.value.sensorRevert')='object')
        ORDER BY id DESC LIMIT ?`).all(MAX_PAYLOAD, value, SENSOR_BOUND + 1);
      if (sources.length > SENSOR_BOUND) partial.add('older sensor corrections');
      const body = new Map(sources.slice(0, SENSOR_BOUND).map(row => [row.id, row]));
      for (const row of body.values()) if (selectionMatches(row, epoch, segments)) push('sensor', row, presentSensor(parse(row.payload), value));
      const ids = [...body.keys()];
      for (let start = 0; start < ids.length; start += 128) {
        const part = ids.slice(start, start + 128);
        const rows = db.prepare(`SELECT id,epoch,at,source_entry_id FROM learning_journal_entries INDEXED BY recovery_learning_source
          WHERE source_entry_id IN (${part.map(() => '?').join(',')}) AND input=? AND payload IS NULL LIMIT ?`).all(...part, value, SENSOR_BOUND + 1);
        if (rows.length > SENSOR_BOUND) partial.add('older recovered sensor corrections');
        for (const row of rows.slice(0, SENSOR_BOUND)) if (selectionMatches(row, epoch, segments)) push('sensor', row, presentSensor(parse(body.get(row.source_entry_id)?.payload), value));
      }
    }
  }
  if (['all', 'charging'].includes(query.area)) {
    const groups = [];
    for (const namespace of namespaces) for (const chargerId of ['charger1', 'charger2']) {
      const reports = db.prepare(`SELECT report_id FROM charging_reports WHERE namespace=? AND charger_id=?
        ORDER BY started_at DESC,report_id DESC LIMIT ?`).all(namespace, chargerId, REPORT_BOUND + 1);
      if (reports.length > REPORT_BOUND) partial.add('older charging sessions');
      groups.push({ namespace, chargerId, reports: reports.slice(0, REPORT_BOUND) });
    }
    let remaining = CHARGING_ROW_BUDGET;
    const categories = query.view === 'all' ? ['findings', 'charging', 'vehicle', 'evidence', 'control'] : ['findings', 'charging', 'vehicle', 'evidence'];
    charging: for (let rank = 0; rank < REPORT_BOUND; rank++) for (const { namespace, chargerId, reports } of groups) {
      const report = reports[rank]; if (!report) continue;
      for (const category of categories) {
          if (!remaining) { partial.add('charging event summaries'); break charging; }
          // A fixed tail gives every page the same source coverage. Applying
          // before inside an unindexed SQL predicate could scan an arbitrarily
          // long session just to find its next matching row.
          const pageLimit = Math.min(REPORT_SOURCE_BOUND, remaining);
          // This index follows report-owned records. No price/model context,
          // planning vector or full report body is hydrated for this timeline.
          const rows = db.prepare(`SELECT id,namespace,at,charger_id,report_id,substr(payload,1,?) payload FROM charging_report_events
            WHERE namespace=? AND charger_id=? AND report_id=? AND category=? ORDER BY id DESC LIMIT ?`)
            .all(MAX_PAYLOAD, namespace, chargerId, report.report_id, category, pageLimit);
          remaining -= rows.length; if (work) work.chargingRows += rows.length;
          if (rows.length === pageLimit) partial.add('long charging-session timelines');
          for (const row of rows) {
            const position = { id: stableId('charging', row.id), at: row.at };
            if (candidates.length === query.limit + 1 && compareEventLogEntries(position, candidates.at(-1)) >= 0) continue;
            const p = parse(row.payload); push('charging', row, presentCharging(row, p));
          }
      }
    }
  }
  // Membership is checked separately from the newest page. New entries cannot
  // make an older visible row look deleted merely by pushing it below the head.
  for (const visible of query.visible) {
    const { source, id } = parseId(visible); let row, out;
    if (source === 'event') {
      row = db.prepare('SELECT id,at,type,substr(payload,1,?) payload FROM active_events WHERE id=?').get(MAX_PAYLOAD, id);
      if (row) { const p = parse(row.payload); if (inputMatches(input, p)) out = presentGeneral(row.type, p); }
    } else if (source === 'firewood') {
      row = db.prepare('SELECT id,input,at,kind,kg FROM active_fireplace_events WHERE id=?').get(id);
      if (row && inputs.includes(row.input)) out = presentFirewood(row);
    } else if (source === 'charging') {
      row = db.prepare('SELECT id,namespace,at,charger_id,report_id,substr(payload,1,?) payload FROM charging_report_events WHERE id=?').get(MAX_PAYLOAD, id);
      if (row && namespaces.includes(row.namespace) && ['charger1', 'charger2'].includes(row.charger_id)) out = presentCharging(row, parse(row.payload));
    } else {
      row = db.prepare(`SELECT e.id,e.at,e.input,e.epoch,substr(COALESCE(e.payload,s.payload),1,?) payload
        FROM learning_journal_entries e LEFT JOIN learning_journal_entries s ON s.id=e.source_entry_id WHERE e.id=? AND e.kind='context'`).get(MAX_PAYLOAD, id);
      if (row && inputs.includes(row.input)) {
        const epoch = epochs.find(([value]) => value === row.input)[1];
        const selected = row.epoch === epoch || db.prepare(`SELECT 1 FROM learning_epoch_segments WHERE epoch=? AND input=? AND source_epoch=? AND after_id<? AND through_id>=? LIMIT 1`).get(epoch, row.input, row.epoch, id, id);
        const p = parse(row.payload); if (selected && (p.value?.sensorChange || p.value?.sensorRevert)) out = presentSensor(p, row.input);
      }
    }
    if (row && out && admitted(out, query) && validTime(row.at) && row.at <= now) retained.set(visible, true);
  }
  const unique = [...new Map(candidates.map(value => [value.id, value])).values()].sort(compareEventLogEntries);
  const events = unique.slice(0, query.limit), last = events.at(-1);
  const nextBefore = unique.length > query.limit && last ? Buffer.from(JSON.stringify({ context, view: query.view, area: query.area, at: last.at, id: last.id })).toString('base64url') : null;
  const caveat = partial.size ? ' This overview shows only part of some available source history.' : '';
  return { context, checkedAt, scope, snapshotAt: scope === 'snapshot' && validTime(snapshotAt) ? snapshotAt : null, events,
    retainedIds: query.visible.filter(value => retained.has(value)), nextBefore,
    coverage: `Recorded history may be incomplete. Charging session reports contain further detail.${caveat}` };
}
