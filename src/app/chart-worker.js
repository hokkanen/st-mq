import { DEFAULT_CHART_CACHE } from '../domain/chart-cache.js';
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { readCheckpoint, matchingCheckpoint } from '../storage/journal.js';
import { getChartData, chartRequestRange } from './chart-data.js';
import { getDatabaseOverview, OVERVIEW_REFRESH_MS } from './database-overview.js';
import { energyCheckSummaries } from './energy-checks.js';
import { getHeatingBenefit } from './chart-heating-benefit.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { CHART_VIEW_BY_KEY } from '../domain/chart-views.js';
import { CHARGING_ALLOWANCE_SIGNALS } from '../charging/allowance-history.js';
import { CHARGING_ALLOWANCE_SERIES } from './chart-charging-allowances.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';
import { ENERGY_SIGNALS } from '../domain/history-series.js';
import { createChartQueryContext } from './chart-query-context.js';
import { buildHeatingSavings } from './garage-reporting.js';
import { ChartSourceCache } from './chart-source-cache.js';
import { storageStep, admittedReader, setStorageMaintenance, releaseStorageLease, setStorageRequestActive, checkStorageRequest } from '../storage/worker-admission.js';

// A separate read-only SQLite connection keeps reconstruction off the control
// loop. HTTP callers also transfer worker-encoded bytes instead of cloning and
// serializing the chart object on the main thread.
const db = admittedReader(storageStep(() => new DatabaseSync(workerData.dbPath, { readOnly: true })));
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
const store = { db, path: workerData.dbPath };
const contexts = new Map();
const cache = new Map(); let cacheBytes = 0, version = null;
let settings = workerData.settings ?? DEFAULT_CHART_CACHE;
let cacheLimitBytes;
const sourceCache = workerData.resident ? new ChartSourceCache(db) : null;
store.chartSource = sourceCache;
function configure(value) {
  settings = value; cacheLimitBytes = Math.floor(value.cacheBytes * (workerData.resident ? 0.32 : 0.1));
  sourceCache?.configure({ days: value.cacheDays, maxBytes: Math.floor(value.cacheBytes * 0.45) });
  cache.clear(); contexts.clear(); cacheBytes = 0;
}
configure(settings);
let observationHead = null, journalHead = null;
const heads = db.prepare(`SELECT (SELECT MAX(id) FROM observations) observations,
  (SELECT MAX(id) FROM learning_journal_entries) journal,
  (SELECT generation FROM history_selection WHERE id=1) selection,
  (SELECT COUNT(*) FROM active_imports WHERE status='complete') imports`);
const changes = db.prepare(`SELECT id,source_time,received_at,signal,
  CASE WHEN signal IN ('property_energy_l1','property_energy_l2','property_energy_l3',
    'ev1_energy_l1','ev1_energy_l2','ev1_energy_l3','ev2_energy_l1','ev2_energy_l2','ev2_energy_l3','caravan_energy')
    THEN json_extract(raw,'$.intervalStart') END AS interval_start FROM observations WHERE id>? ORDER BY id LIMIT 4097`);
const journalChanges = db.prepare('SELECT id,at FROM learning_journal_entries WHERE id>? ORDER BY id LIMIT 4097');
function invalidateChangedRanges() {
  const current = heads.get(); store.chartHead = current.observations ?? 0;
  store.chartRevision = JSON.stringify([current.selection, current.imports]);
  const rows = observationHead === null ? [] : changes.all(observationHead);
  const journals = journalHead === null ? [] : journalChanges.all(journalHead);
  if (rows.length > 4096 || journals.length > 4096) { cache.clear(); contexts.clear(); cacheBytes = 0; }
  else {
    const affected = entry => rows.some(row => row.signal.startsWith('voltage_estimate_')
      || row.source_time < entry.range.to + (entry.detail ? 3 * 3_600_000 : 0)
      || row.interval_start !== null && row.interval_start < entry.range.to)
      || journals.some(row => row.at < entry.range.to);
    for (const [key, entry] of cache) if (affected(entry)) { cache.delete(key); cacheBytes -= entry.bytes; }
    for (const [key, entry] of contexts) if (rows.some(row => row.signal.startsWith('voltage_estimate_')
      || ENERGY_SIGNALS.includes(row.signal) && (row.source_time < entry.range.to
        || row.interval_start !== null && row.interval_start < entry.range.to))) contexts.delete(key);
  }
  observationHead = current.observations ?? 0; journalHead = current.journal ?? 0;
}
const heatingFingerprint = ({ generatedAt, ...summary }) => JSON.stringify(summary);
const pendingEnergyFingerprint = (args,range) => JSON.stringify(pendingEnergyObservations(store,args)
  .filter(row=>row.source_time>range.from&&JSON.parse(row.raw).intervalStart<range.to));
const latestSourceCoverage=db.prepare(`SELECT c.*,o.raw,o.source_time AS observed_at FROM state s
  JOIN active_recorder_coverage c ON c.id=json_extract(s.value,'$.coverageId')
  JOIN active_observations o ON o.id=c.observation_id WHERE s.key LIKE 'recorder:signal:%' AND (
    json_extract(o.raw,'$.reportIntervalMs')>0 OR c.source IN ('husdata-h66','simulation') AND c.signal IN ('compressor_active','dhw_routing','operating_mode','auxiliary_output')
    OR c.source='controller-estimate' AND c.signal='auxiliary_power'
    OR c.source IN ('mqtt-equipment','shelly-mqtt') AND c.signal='dhwr_active') ORDER BY c.id`);
function sourceCoverageFingerprint(args,range) {
  const spans=[];
  for(const row of latestSourceCoverage.iterate()) {
    if ((args.input==='simulated')!==(row.source==='simulation'||row.source==='controller-estimate'&&row.device==='simulated')
      ||row.status!=='fresh'||row.start_at>=range.to||row.start_at>args.now) continue;
    const raw=JSON.parse(row.raw),age=temperatureReportMaxAge({raw})??(row.signal==='dhwr_active'
      ? raw.eventOnly===true ? Infinity : raw.maxAgeMs : H66_MAX_AGE_MS);
    const confirmed=row.end_at<=args.now?row.source_time:row.observed_at;
    const end=Math.min(range.to,confirmed+age);
    if(end>Math.max(range.from,row.start_at)) spans.push([row.id,end,row.end_at<=args.now]);
  }
  const selected = args.view !== undefined ? CHART_VIEW_BY_KEY[args.view]?.leftSignals.some(signal => CHARGING_ALLOWANCE_SERIES.includes(signal))
    : CHARGING_ALLOWANCE_SERIES.includes(args.left);
  if (selected) {
    // Allowances have no fresh-measurement tail. Their already-observed
    // coverage endpoints change on identical ticks independently per charger.
    // A clipped finished selection stays cached when later ticks extend beyond it.
    const query = db.prepare(`SELECT c.id,c.start_at,c.end_at FROM active_recorder_coverage c
      JOIN active_observations o ON o.id=c.observation_id WHERE c.signal=? AND c.source='charging-allowance'
        AND c.start_at<? AND c.end_at>? AND o.received_at<=?
        AND json_extract(o.raw,'$.input') ${args.input === 'simulated' ? '=' : '<>'} 'simulated'
      ORDER BY c.end_at DESC,c.id DESC LIMIT 1`);
    for (const signal of Object.values(CHARGING_ALLOWANCE_SIGNALS)) {
      const row = query.get(signal, range.to, range.from, args.now);
      if (row) spans.push([signal, row.id, Math.min(row.end_at, range.to, args.now)]);
    }
  }
  return JSON.stringify(spans);
}
let overview = null, overviewRevision = null;
const readOverviewRevision = db.prepare(`SELECT generation,
  (SELECT COUNT(*) FROM history_recoveries WHERE completed_at IS NOT NULL) completedRecoveries
  FROM history_selection WHERE id=1`);
parentPort.on('message', ({ id, args, operation, wire, checkpoint, configure: configuration }) => {
  if (configuration) { configure(configuration); return; }
  setStorageMaintenance(operation === 'maintain');
  setStorageRequestActive(operation !== 'maintain');
  const onProgress = progress => { checkStorageRequest(); parentPort.postMessage({ id, progress }); };
  let observationFailed = false, observationCacheHit = false;
  try {
    if (operation === 'maintain') {
      // Admission precedes BEGIN and the whole bounded batch releases its
      // snapshot before yielding the turn. Idle warming cannot pin the WAL
      // while it waits behind later requested work.
      const status = storageStep(() => {
        db.exec('BEGIN');
        try {
          if (checkpoint && !matchingCheckpoint(readCheckpoint(db), checkpoint))
            throw new Error('The replica checkpoint advanced. Retry the request.');
          return sourceCache?.maintain(args.now, 256);
        } finally { db.exec('ROLLBACK'); }
      });
      parentPort.postMessage({ id, cacheStatus: { ...sourceCache?.status(), complete: status?.complete === true } });
      parentPort.postMessage({ id, result: { ready: sourceCache?.ready ?? false } }); return;
    }
    db.exec('BEGIN');
    if (checkpoint && !matchingCheckpoint(readCheckpoint(db), checkpoint))
      throw new Error('The replica checkpoint advanced. Retry the request.');
    if (['pin', 'pin-archive'].includes(operation)) {
      parentPort.postMessage({ id, result: { ready: true } }); return;
    }
    if (operation === 'energy-checks') {
      onProgress({ stage: 'reading-energy-checks' });
      const result = energyCheckSummaries(store, args);
      parentPort.postMessage({ id, result });
      return;
    }
    if (operation === 'overview') {
      const at = Date.now();
      const currentOverviewRevision = JSON.stringify(readOverviewRevision.get());
      const hit = !args.force && overview && overviewRevision === currentOverviewRevision
        && at - overview.generatedAt >= 0 && at - overview.generatedAt < OVERVIEW_REFRESH_MS;
      observationCacheHit = Boolean(hit);
      if (!hit) {
        overview = getDatabaseOverview({ store, now: at });
        overviewRevision = JSON.stringify(readOverviewRevision.get());
      }
      parentPort.postMessage({ id, result: { ...overview,
        cache: { hit: Boolean(hit), ageMs: at - overview.generatedAt, maxAgeMs: OVERVIEW_REFRESH_MS } } });
      return;
    }
    // Acquisition checkpoints and rolling recorder metrics update frequently.
    // They do not invalidate a completed historical plot. New observations,
    // availability spans, forecast fetches and completed imports do.
    invalidateChangedRanges();
    // A requested view may catch up one small tail batch instead of discarding
    // an otherwise complete resident week for a few just-committed readings.
    if (sourceCache?.ready && sourceCache.head !== store.chartHead
      && store.chartHead - sourceCache.head <= 256) sourceCache.maintain(args.now, 256);
    const currentVersion = JSON.stringify(db.prepare(`SELECT
      (SELECT generation FROM history_selection WHERE id=1) recoverySelection,
      (SELECT MIN(received_at) FROM active_observations AS observations WHERE received_at>?) nextReceipt,
      (SELECT MIN(completed_at) FROM active_imports AS imports WHERE status='complete' AND completed_at>?) nextImportPublication,
      (SELECT MIN(fetched_at) FROM active_provider_snapshot_fetches AS provider_snapshot_fetches WHERE fetched_at>?) nextProviderReceipt,
      (SELECT MAX(id) FROM active_provider_snapshot_fetches AS provider_snapshot_fetches) snapshots,
      (SELECT MAX(id) FROM active_fireplace_events AS fireplace_events) fireplaceRevision,
      (SELECT group_concat(CASE WHEN json_valid(value) THEN json_extract(value,'$.checkpointDigest') ELSE 'invalid' END)
        FROM state WHERE key IN ('adaptive:mqtt','adaptive:providers','adaptive:simulated')) adaptiveModels,
      (SELECT group_concat(value) FROM state WHERE key IN ('fireplace:rebuild:mqtt','fireplace:rebuild:providers','fireplace:rebuild:simulated')) fireplaceRebuilds,
      (SELECT MAX(id) FROM active_events AS events WHERE type='heat-pump-power-config') heatPowerConfig,
      (SELECT MAX(id) FROM active_energy_audits AS energy_audits) energyAudits,
      (SELECT MAX(id) FROM active_events AS events WHERE type='charging-session-check') chargingSessionChecks,
      (SELECT COUNT(*) FROM active_imports AS imports WHERE status='complete') imports`).get(args.now,args.now,args.now));
    if (currentVersion !== version) { cache.clear(); contexts.clear(); cacheBytes = 0; version = currentVersion; }
    // Historical views survive second-by-second clock movement. Current/future
    // views renew within fifteen seconds, preserving acquisition timestamps.
    const {range}=chartRequestRange(args);
    const bucket = range.to <= args.now ? 0 : Math.floor(args.now / 15_000);
    // One version per selection: rolling clock buckets replace their earlier
    // response instead of filling RAM with obsolete copies of the same view.
    const key = JSON.stringify({ ...args, now: 0 });
    let entry = cache.get(key), result, prepared;
    // Constant readings extend bounded energy tails and confirmation spans.
    // Renew only affected plots, preserving unrelated historical caches and the
    // live clock bucket when source evidence itself has not changed.
    if(entry&&(entry.bucket !== bucket || entry.pendingEnergyFingerprint!==pendingEnergyFingerprint(args,range)
      ||entry.sourceCoverageFingerprint!==sourceCoverageFingerprint(args,range))) {
      cache.delete(key);cacheBytes-=entry.bytes;entry=null;
    }
    // Cycle records can be corrected without a new telemetry or journal row.
    // Recheck their compact selected-period aggregate, retaining history cache
    // hits for unrelated recorder/checkpoint writes and active observation tapes.
    if (entry && !entry.result.meta.detail) {
      const benefit = getHeatingBenefit({ ...args, store, range: entry.result.range });
      if (heatingFingerprint(entry.result.heatingBenefit) !== heatingFingerprint(benefit)) {
        entry.result = { ...entry.result, heatingBenefit: benefit, heatingSavings: buildHeatingSavings({
          range: entry.result.range, now: args.now, homeModel: benefit,
          homeTiming: entry.result.timingBenefit?.heatPump, garageTiming: entry.result.heatingSavings?.garage?.timing }) };
        const before = entry.bytes;
        releaseStorageLease();
        entry.prepared = prepareChartResponse(entry.result); entry.bytes = entry.prepared.bytes * 3;
        cacheBytes += entry.bytes - before;
        while (cacheBytes > cacheLimitBytes && cache.size) {
          const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
        }
      }
    }
    if (entry) {
      observationCacheHit = true;
      cache.delete(key); cache.set(key, entry);
      result = { ...entry.result, now: args.now, meta: { ...entry.result.meta, cacheHit: true } };
      prepared = entry.prepared;
    } else {
      // Replay and source handovers must see one committed journal prefix.
      const contextKey = JSON.stringify([args.input, range.from, range.to, bucket]);
      let context = contexts.get(contextKey);
      const pendingFingerprint = pendingEnergyFingerprint(args, range);
      if (context?.pending !== pendingFingerprint) { contexts.delete(contextKey); context = null; }
      if (!context) {
        const contextBytes = Math.min(64 * 1024 * 1024, Math.floor(settings.cacheBytes * 0.065));
        context = { range, pending: pendingFingerprint,
          value: createChartQueryContext({ store, range, now: args.now, input: args.input, maxEnergyBytes: contextBytes, maxEnergyGroups: Math.ceil(contextBytes / 512) }) };
        if (workerData.resident && settings.cacheDays) {
          while (contexts.size >= 2) contexts.delete(contexts.keys().next().value);
          contexts.set(contextKey, context);
        }
      }
      result = getChartData({ ...args, store, onProgress, _queryContext: context.value });
      const sourceFingerprint=sourceCoverageFingerprint(args,range);
      releaseStorageLease();
      onProgress({ stage: 'preparing-response' });
      prepared = prepareChartResponse(result);
      // Account for the cached JS objects as well as their encoded strings.
      const bytes = prepared.bytes * 3;
      while (cache.size && (cache.size >= 128 || cacheBytes + bytes > cacheLimitBytes)) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
      if (bytes <= cacheLimitBytes) { entry = { result, prepared, bytes, range, bucket, detail: result.meta.detail, pendingEnergyFingerprint:pendingFingerprint,
        sourceCoverageFingerprint:sourceFingerprint }; cache.set(key, entry); cacheBytes += bytes; }
    }
    releaseStorageLease();
    if (wire) {
      const bytes = encodeChartResponse(result, prepared, wire);
      parentPort.postMessage({ id, result: bytes }, [bytes.buffer]);
    } else parentPort.postMessage({ id, result });
  } catch (error) { contexts.clear(); observationFailed = true; parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
  finally {
    setStorageRequestActive(false);
    if (operation !== 'maintain' && db.isTransaction) try { db.exec('ROLLBACK'); } catch { observationFailed = true; }
    setStorageMaintenance(false); releaseStorageLease();
    parentPort.postMessage({ id, storageOperationComplete: true, failed: observationFailed, cacheHit: observationCacheHit && !observationFailed });
  }
});
