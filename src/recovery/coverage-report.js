import { ENERGY_SIGNALS, SIGNAL_INFO } from '../domain/history-series.js';
import { pendingEnergyObservations, pendingEnergyObservationsFromStates } from '../storage/pending-energy.js';
import { isRecordedEnergyGap, validEnergyQuality } from '../storage/energy-history.js';
import { observationTimeAdmitted } from '../domain/time-evidence.js';

export const RECOVERY_OUTAGE_LIMIT = 100;
const allowanceSignals = ['charger1_current_allowance', 'charger2_current_allowance'];
const publicSignal = signal => Object.hasOwn(SIGNAL_INFO,signal) || allowanceSignals.includes(signal);
const publicSignals = [...Object.keys(SIGNAL_INFO), ...allowanceSignals];
const publicSignalSql = publicSignals.map(signal => `'${signal}'`).join(',');
const evidenceKind = row => row.basis === 'energy-interval' ? 'energyIntervals'
  : row.to > row.from ? 'reportPeriods' : 'pointEvents';
const energySignals = [...ENERGY_SIGNALS, 'garage_energy'];
const energySql = energySignals.map(signal => `'${signal}'`).join(',');
const raw = "CASE WHEN json_valid(raw) THEN raw ELSE '{}' END";
const intervalStart = `CASE WHEN json_type(${raw},'$.intervalStart')='integer'
  AND json_extract(${raw},'$.intervalStart')<source_time THEN json_extract(${raw},'$.intervalStart') END`;
const observedStart = `COALESCE(${intervalStart},source_time,received_at)`;
const observedEnd = 'COALESCE(source_time,received_at)';
const categories = [
  { name: 'energy', sql: `SELECT ${observedStart} start,${observedEnd} finish FROM active_observations WHERE signal IN (${energySql})` },
  { name: 'temperatures', sql: `SELECT ${observedStart} start,${observedEnd} finish FROM active_observations WHERE unit='degC' AND signal NOT IN (${energySql})` },
  { name: 'other_observations', sql: `SELECT ${observedStart} start,${observedEnd} finish FROM active_observations WHERE unit<>'degC' AND signal NOT IN (${energySql})` },
  { name: 'recorder_coverage', sql: 'SELECT start_at start,end_at finish FROM active_recorder_coverage' },
  { name: 'provider_snapshot_fetches', sql: 'SELECT fetched_at start,fetched_at finish FROM active_provider_snapshot_fetches' },
  { name: 'annotations', sql: 'SELECT start_at start,COALESCE(end_at,start_at) finish FROM active_annotations' },
  { name: 'counters', sql: 'SELECT source_time start,source_time finish FROM active_counters' },
  { name: 'fireplace_events', sql: 'SELECT at start,at finish FROM active_fireplace_events WHERE input=?', input: true },
  { name: 'learning_cycles', sql: 'SELECT started_at start,COALESCE(ended_at,started_at) finish FROM active_learning_cycles WHERE input=?', input: true },
  { name: 'events', sql: 'SELECT at start,at finish FROM active_events' },
  { name: 'energy_audits', sql: 'SELECT source_time start,source_time finish FROM active_energy_audits' },
  { name: 'import_rows', sql: 'SELECT source_time start,source_time finish FROM active_import_rows' },
  { name: 'learning_journal', sql: 'SELECT at start,at finish FROM learning_journal WHERE input=?', input: true },
  { name: 'charging_reports', sql: 'SELECT started_at start,COALESCE(ended_at,started_at) finish FROM charging_reports' },
  { name: 'charging_report_events', sql: 'SELECT at start,at finish FROM charging_report_events' },
];
// Scoped TEMP rows have no column affinity: SQLite can store a JavaScript
// integer timestamp as REAL there. Accept exactly integral numeric clocks.
const validDates = "typeof(start) IN ('integer','real') AND typeof(finish) IN ('integer','real') AND start=CAST(start AS INTEGER) AND finish=CAST(finish AS INTEGER) AND start>0 AND finish>=start AND finish<=8640000000000000";
function range(store, category, input, master) {
  // Fixed SQL projections expose no paths, equipment IDs or source payloads.
  const outside = master ? `,
    SUM(CASE WHEN ${validDates} AND start<? THEN 1 ELSE 0 END) before_count,
    MIN(CASE WHEN ${validDates} AND start<? THEN start END) before_from,
    MAX(CASE WHEN ${validDates} AND start<? THEN finish END) before_to,
    SUM(CASE WHEN ${validDates} AND finish>? THEN 1 ELSE 0 END) after_count,
    MIN(CASE WHEN ${validDates} AND finish>? THEN start END) after_from,
    MAX(CASE WHEN ${validDates} AND finish>? THEN finish END) after_to` : '';
  const row = store.db.prepare(`WITH records AS (${category.sql}) SELECT COUNT(*) count,
    MIN(CASE WHEN ${validDates} THEN start END) "from",MAX(CASE WHEN ${validDates} THEN finish END) "to",
    SUM(CASE WHEN ${validDates} THEN 0 ELSE 1 END) undated ${outside} FROM records`)
    .get(...(category.input ? [input] : []), ...(master ? [master.from,master.from,master.from,master.to,master.to,master.to] : []));
  const summary = { count: row.count, from: row.from, to: row.to, undated: row.undated ?? 0 };
  return master ? { ...summary, outsideMaster: master.from === null ? { withoutMasterRange: summary }
    : { before: { count: row.before_count ?? 0, from: row.before_from, to: row.before_to },
      after: { count: row.after_count ?? 0, from: row.after_from, to: row.after_to } } } : summary;
}
const usable = alias => `${alias}.value IS NOT NULL AND recovery_report_usable(${alias}.quality)=1`;
const scope = alias => `(${alias}.source='simulation' OR ${alias}.source='controller' AND ${alias}.device='simulated')`;
const pendingUsable = row => validEnergyQuality(JSON.parse(row.quality));
function pendingRange(rows, master) {
  const summarize = values => ({ count: values.length,
    from: values.length ? Math.min(...values.map(row => JSON.parse(row.raw).intervalStart)) : null,
    to: values.length ? Math.max(...values.map(row => row.source_time)) : null, undated: 0 });
  const result = summarize(rows);
  if (master) result.outsideMaster = master.from === null ? { withoutMasterRange: { ...result } }
    : { before: summarize(rows.filter(row => JSON.parse(row.raw).intervalStart < master.from)),
      after: summarize(rows.filter(row => row.source_time > master.to)) };
  return result;
}

/** Inventory only the admitted changed-key closure. Never scan the master's
 * historical ranges or interpret this partial source as complete coverage. */
export async function recoverySourceSummary({ donor, input, now = Date.now(), yieldControl = async () => {} }) {
  if (!donor.incremental || !donor.recoveryJournal || !donor.recoveryState)
    throw new TypeError('Changed source inventory requires a scoped source');
  const rows = [];
  for (const category of categories.filter(row => !['charging_reports', 'charging_report_events'].includes(row.name))) {
    const projection = category.name === 'learning_journal'
      ? { ...category, sql: `SELECT at start,at finish FROM ${donor.recoveryJournal} WHERE input=?` } : category;
    rows.push({ name: category.name, ...range(donor, projection, input) });
    await yieldControl();
  }
  const pending = pendingEnergyObservationsFromStates(donor.db.prepare(`SELECT key,value FROM ${donor.recoveryState}
    WHERE key LIKE 'recorder:energy:%'`).iterate(), { now, input }).filter(pendingUsable);
  rows.push({ name: 'recorder_pending_energy', ...pendingRange(pending) });
  return { checkedAt: now, categories: rows };
}

export function validRecoverySourceSummary(value) {
  const names = categories.filter(row => !['charging_reports', 'charging_report_events'].includes(row.name)).map(row => row.name)
    .concat('recorder_pending_energy');
  const fields = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => keys.includes(key));
  const count = number => Number.isSafeInteger(number) && number >= 0;
  const date = number => Number.isSafeInteger(number) && number > 0 && number <= 8640000000000000;
  return fields(value, ['checkedAt', 'categories']) && date(value.checkedAt)
    && Array.isArray(value.categories) && value.categories.length === names.length
    && new Set(value.categories.map(row => row?.name)).size === names.length
    && value.categories.every(row => fields(row, ['name', 'count', 'from', 'to', 'undated']) && names.includes(row.name)
      && count(row.count) && count(row.undated) && row.undated <= row.count
      && (row.from === null && row.to === null || date(row.from) && date(row.to) && row.to >= row.from));
}

/** Informational potential coverage only. Neither this report nor its date
 * ranges are an import plan, a physical-identity proof or continuous coverage.
 * Call in a worker with both read snapshots pinned. Query results and response
 * size stay bounded; no history-sized arrays, trial merge or model rebuild. */
export async function recoveryCoverageReport({ master, donor, input, now = Date.now(), yieldControl = async () => {}, progress = () => {} }) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('Invalid report time');
  donor.db.function('recovery_report_time', { deterministic: true }, (sourceTime, receivedAt, raw) => {
    try { return Number(observationTimeAdmitted({ sourceTime, receivedAt, raw: raw ? JSON.parse(raw) : null }, now)); }
    catch { return 0; }
  });
  donor.db.function('recovery_report_usable',{ deterministic: true },quality => {
    try { return Number(validEnergyQuality(JSON.parse(quality))); } catch { return 0; }
  });
  master.db.function('recovery_report_gap',{ deterministic: true },(value,unit,raw,quality,end,received) => {
    try {
      const payload = JSON.parse(raw), flags = JSON.parse(quality);
      return Number(isRecordedEnergyGap({ value,unit },payload,flags)
        && Number.isSafeInteger(payload.intervalStart) && payload.intervalStart > 0
        && Number.isSafeInteger(end) && payload.intervalEnd === end && end > payload.intervalStart
        && observationTimeAdmitted({ sourceTime: end, receivedAt: received, raw: payload }, now));
    } catch { return 0; }
  });
  const report = { checkedAt: now, categories: [], outages: { total: 0, limit: RECOVERY_OUTAGE_LIMIT, items: [] } };
  for (const category of categories) {
    const local = range(master, category, input);
    const source = range(donor, category, input, local);
    report.categories.push({ name: category.name, master: local, source });
    progress({ phase: 'checking', processed: report.categories.length }); await yieldControl();
  }
  const sourcePending = pendingEnergyObservations(donor, { now, input }).filter(pendingUsable);
  const localPending = pendingRange(pendingEnergyObservations(master, { now, input }).filter(pendingUsable));
  report.categories.push({ name: 'recorder_pending_energy', master: localPending, source: pendingRange(sourcePending, localPending) });
  const gap = alias => `recovery_report_gap(${alias}.value,${alias}.unit,${alias}.raw,${alias}.quality,${alias}.source_time,${alias}.received_at)=1`;
  const prefix = "CASE WHEN signal LIKE 'ev1_%' THEN 'ev1' WHEN signal LIKE 'ev2_%' THEN 'ev2' WHEN signal='caravan_energy' THEN 'caravan' ELSE 'property' END";
  const quality = "CASE WHEN json_valid(o.quality) AND json_type(o.quality)='array' THEN o.quality ELSE '[]' END";
  const receipts = `SELECT c.signal,c.source,c.start_at,c.end_at,c.status,${scope('c')} simulated,
      CASE WHEN EXISTS(SELECT 1 FROM json_each(${quality}) WHERE value='retained')
        THEN 'retained' ELSE c.status END reason
    FROM active_recorder_coverage c LEFT JOIN active_observations o ON o.id=c.observation_id
    WHERE c.status IN ('stale','failed','unavailable')
      AND typeof(c.start_at)='integer' AND typeof(c.end_at)='integer'
      AND c.start_at>0 AND c.end_at>=c.start_at AND c.end_at<=${now}
      AND NOT EXISTS(SELECT 1 FROM active_observations o
        WHERE o.id=c.observation_id AND o.signal IN (${energySql}) AND ${gap('o')})`;
  const energyRows = `
    SELECT NULL signal,json_extract(o.raw,'$.intervalStart') start_at,o.source_time end_at,'unavailable' status,
      ${scope('o')} simulated,${prefix} energy_prefix,'energy-interval' basis FROM active_observations o
    WHERE o.signal IN (${ENERGY_SIGNALS.map(signal => `'${signal}'`).join(',')}) AND o.import_id IS NULL AND ${gap('o')}
    GROUP BY o.source,o.device,energy_prefix,start_at,end_at`;
  const counts = master.db.prepare(`SELECT COALESCE(SUM(end_at>start_at),0) reportPeriods,
    COALESCE(SUM(end_at=start_at),0) pointEvents FROM (${receipts})`).get();
  counts.energyIntervals = master.db.prepare(`SELECT COUNT(*) count FROM (${energyRows})`).get().count;
  report.outages.counts = { energyIntervals: counts.energyIntervals, reportPeriods: counts.reportPeriods, pointEvents: counts.pointEvents };
  report.outages.total = counts.energyIntervals + counts.reportPeriods + counts.pointEvents;
  // Bound each evidence kind separately: reconnect notifications must never
  // displace recorded energy gaps. Group only exact source/bounds/status/reason matches;
  // this is display compression, not an inferred causal incident or outage.
  const outages = master.db.prepare(`SELECT * FROM (${energyRows}) ORDER BY start_at DESC,end_at DESC,energy_prefix LIMIT ?`).all(RECOVERY_OUTAGE_LIMIT);
  for (const relation of ['>', '=']) {
    outages.push(...master.db.prepare(`SELECT start_at,end_at,status,simulated,reason,
      NULL energy_prefix,'receipt-coverage' basis,COUNT(*) records,
      json_group_array(DISTINCT CASE WHEN signal IN (${publicSignalSql}) THEN signal END) signals
      FROM (${receipts}) WHERE end_at${relation}start_at
      GROUP BY source,start_at,end_at,status,simulated,reason
      ORDER BY start_at DESC,end_at DESC,source,status,reason LIMIT ?`).all(RECOVERY_OUTAGE_LIMIT));
  }
  outages.sort((a,b) => b.start_at - a.start_at || b.end_at - a.end_at);
  const observation = donor.db.prepare(`SELECT 1 FROM active_observations o WHERE signal=? AND source_time>=? AND source_time<=?
    AND recovery_report_time(source_time,received_at,raw)=1 AND received_at<=? AND ${scope('o')}=? AND ${usable('o')} LIMIT 1`);
  const energy = donor.db.prepare(`SELECT 1 FROM active_observations o WHERE signal=? AND source_time>?
    AND recovery_report_time(source_time,received_at,raw)=1 AND received_at<=? AND ${scope('o')}=? AND ${usable('o')}
    AND unit='kWh' AND import_id IS NULL AND ${intervalStart}<?
    AND json_extract(${raw},'$.intervalEnd')=source_time
    AND COALESCE(json_extract(${raw},'$.auditOnly'),0)=0 AND COALESCE(json_extract(${raw},'$.acquisitionOnly'),0)=0
    AND COALESCE(json_extract(${raw},'$.timeBasis'),'')<>'completed-hour' LIMIT 1`);
  const coverage = donor.db.prepare(`SELECT 1 FROM active_recorder_coverage c JOIN active_observations o ON o.id=c.observation_id
    WHERE c.signal=? AND c.end_at>=? AND c.start_at<=? AND c.status='fresh' AND c.samples>0
      AND c.end_at<=? AND recovery_report_time(o.source_time,o.received_at,o.raw)=1 AND o.received_at<=?
      AND ${scope('c')}=? AND ${usable('o')} LIMIT 1`);
  for (const row of outages) {
    const signals = row.energy_prefix ? row.energy_prefix === 'caravan' ? ['caravan_energy']
      : [1,2,3].map(phase => `${row.energy_prefix}_energy_l${phase}`)
      : JSON.parse(row.signals).filter(publicSignal).sort();
    // A point marker supplies no outage duration against which to assess
    // coverage. Do not turn an exact-instant lookup into recovery advice.
    const matches = row.end_at > row.start_at && signals.some(signal => Boolean((energySignals.includes(signal)
      ? energy.get(signal,row.start_at,now,row.simulated,row.end_at)
      : observation.get(signal,row.start_at,row.end_at,now,row.simulated)
        || coverage.get(signal,row.start_at,row.end_at,now,now,row.simulated))
      || sourcePending.some(item => item.signal === signal && Number(item.source === 'simulation') === row.simulated
        && JSON.parse(item.raw).intervalStart < row.end_at && item.source_time > row.start_at)));
    report.outages.items.push({ signal: signals.length === 1 && !row.energy_prefix ? signals[0] : null,
      energyPrefix: row.energy_prefix, basis: row.basis,
      from: row.start_at, to: row.end_at, status: row.status, potentialCoverage: matches,
      ...(row.basis === 'receipt-coverage' ? { records: row.records,signals,reason: row.reason } : {}) });
    if (report.outages.items.length % 10 === 0) await yieldControl();
  }
  report.outages.omitted = report.outages.total - report.outages.items.reduce((sum,row) => sum + (row.records ?? 1),0);
  return report;
}

/** Saved report validation is also an output privacy boundary on restart. */
export function validRecoveryCoverageReport(value) {
  const fields = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => keys.includes(key));
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const date = n => Number.isSafeInteger(n) && n > 0;
  const range = row => fields(row,['count','from','to','undated']) && count(row.count)
    && (row.undated === undefined || count(row.undated) && row.undated <= row.count)
    && (row.from === null && row.to === null || date(row.from) && date(row.to) && row.to >= row.from);
  const sourceRange = row => {
    if (!fields(row,['count','from','to','undated','outsideMaster'])) return false;
    const { outsideMaster, ...base } = row;
    return range(base) && (fields(outsideMaster,['withoutMasterRange']) && range(outsideMaster.withoutMasterRange)
      || fields(outsideMaster,['before','after']) && range(outsideMaster.before) && range(outsideMaster.after));
  };
  const names = [...categories.map(row => row.name),'recorder_pending_energy'];
  if (!fields(value,['checkedAt','categories','outages']) || !date(value.checkedAt)
    || !Array.isArray(value.categories) || value.categories.length !== names.length
    || new Set(value.categories.map(row => row?.name)).size !== names.length
    || !value.categories.every(row => fields(row,['name','master','source']) && names.includes(row.name)
      && range(row.master) && sourceRange(row.source))) return false;
  const outages = value.outages;
  if (!fields(outages,['total','limit','items','omitted','counts']) || !count(outages.total)
    || outages.limit !== RECOVERY_OUTAGE_LIMIT || !Array.isArray(outages.items) || outages.items.length > outages.limit * 3
    || !count(outages.omitted)
    || !outages.items.every(row => fields(row,['signal','energyPrefix','basis','from','to','status','potentialCoverage','records','signals','reason'])
      && (row.signal === null || typeof row.signal === 'string' && publicSignal(row.signal))
      && (row.energyPrefix === null || ['ev1','ev2','property','caravan'].includes(row.energyPrefix))
      && ['receipt-coverage','energy-interval'].includes(row.basis)
      && date(row.from) && date(row.to) && row.to >= row.from && ['stale','failed','unavailable'].includes(row.status)
      && (row.basis === 'energy-interval' ? row.to > row.from && row.energyPrefix !== null
        && row.signal === null && row.status === 'unavailable' : row.energyPrefix === null)
      && typeof row.potentialCoverage === 'boolean'
      && (row.records === undefined && row.signals === undefined && row.reason === undefined
        || row.basis === 'receipt-coverage' && count(row.records) && row.records > 0
          && Array.isArray(row.signals) && row.signals.length <= Math.min(row.records,publicSignals.length)
          && new Set(row.signals).size === row.signals.length
          && row.signals.every(signal => typeof signal === 'string' && publicSignal(signal))
          && row.signal === (row.signals.length === 1 ? row.signals[0] : null)
          && (row.reason === 'retained' || row.reason === row.status)))) return false;
  const kinds = ['energyIntervals','reportPeriods','pointEvents'];
  const shown = Object.fromEntries(kinds.map(kind => [kind,outages.items.filter(row => evidenceKind(row) === kind)]));
  const shownRecords = kind => shown[kind].reduce((sum,row) => sum + (row.records ?? 1),0);
  return kinds.every(kind => shown[kind].length <= outages.limit)
    && outages.total === kinds.reduce((sum,kind) => sum + shownRecords(kind),0) + outages.omitted
    && (outages.counts === undefined || fields(outages.counts,kinds)
      && kinds.every(kind => count(outages.counts[kind]) && outages.counts[kind] >= shownRecords(kind))
      && outages.total === kinds.reduce((sum,kind) => sum + outages.counts[kind],0));
}
