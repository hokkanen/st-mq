import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { getChartData, chartRequestRange } from './chart-data.js';
import { getDatabaseOverview, OVERVIEW_REFRESH_MS } from './database-overview.js';
import { getGarageModelBenefit } from './garage-reporting.js';
import { getHeatingBenefit } from './chart-heating-benefit.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { H66_MAX_AGE_MS } from '../domain/reading-freshness.js';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';

// The chart worker owns a separate read-only SQLite connection. A large history
// view cannot block control decisions or the application's HTTP event loop.
const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
const store = { db, path: workerData.dbPath };
const cache = new Map(); let cacheBytes = 0, version = null;
const heatingFingerprint = ({ generatedAt, ...summary }) => JSON.stringify(summary);
const pendingEnergyFingerprint = (args,range) => JSON.stringify(pendingEnergyObservations(store,args)
  .filter(row=>row.source_time>range.from&&JSON.parse(row.raw).intervalStart<range.to));
const latestSourceCoverage=db.prepare(`SELECT c.*,o.raw,o.source_time AS observed_at FROM state s
  JOIN recorder_coverage c ON c.id=json_extract(s.value,'$.coverageId')
  JOIN observations o ON o.id=c.observation_id WHERE s.key LIKE 'recorder:signal:%' AND (
    c.source IN ('husdata-h66','simulation') AND c.signal IN ('compressor_active','dhw_routing','operating_mode','auxiliary_output')
    OR c.source='controller-estimate' AND c.signal='auxiliary_power'
    OR c.source='mqtt-equipment' AND c.signal='dhwr_active') ORDER BY c.id`);
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
  return JSON.stringify(spans);
}
let overview = null;
parentPort.on('message', ({ id, args, operation }) => {
  try {
    if (operation === 'overview') {
      const at = Date.now();
      const hit = overview && at - overview.generatedAt >= 0 && at - overview.generatedAt < OVERVIEW_REFRESH_MS;
      if (!hit) {
        // Consistent read snapshot across aggregate queries. WAL permits the
        // controller's writer to continue while the worker builds the overview.
        db.exec('BEGIN');
        try { overview = getDatabaseOverview({ store, now: at }); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      parentPort.postMessage({ id, result: { ...overview,
        cache: { hit: Boolean(hit), ageMs: at - overview.generatedAt, maxAgeMs: OVERVIEW_REFRESH_MS } } });
      return;
    }
    // Acquisition checkpoints and rolling recorder metrics update frequently.
    // They do not invalidate a completed historical plot. New observations,
    // availability spans, forecast fetches and completed imports do.
    const currentVersion = JSON.stringify(db.prepare(`SELECT
      (SELECT MAX(id) FROM observations) observations,
      (SELECT MIN(received_at) FROM observations WHERE received_at>?) nextReceipt,
      (SELECT MIN(completed_at) FROM imports WHERE status='complete' AND completed_at>?) nextImportPublication,
      (SELECT MIN(fetched_at) FROM provider_snapshot_fetches WHERE fetched_at>?) nextProviderReceipt,
      (SELECT MAX(id) FROM provider_snapshot_fetches) snapshots,
      (SELECT MAX(id) FROM recorder_coverage) coverage,
      (SELECT group_concat(json_extract(value,'$.lastSourceTime')||':'||json_extract(value,'$.coverageId'))
        FROM state WHERE key LIKE 'recorder:signal:%' AND json_extract(value,'$.reportPolicy.reportIntervalMs')>0
          AND json_extract(value,'$.signal')<>'dhwr_active') temperatureReports,
      (SELECT MAX(id) FROM learning_journal) learningJournal,
      (SELECT MAX(id) FROM fireplace_events) fireplaceRevision,
      (SELECT group_concat(CASE WHEN json_valid(value) THEN json_extract(value,'$.checkpointDigest') ELSE 'invalid' END) FROM state WHERE key IN ('adaptive:mqtt','adaptive:providers','adaptive:simulated')) adaptiveModels,
      (SELECT group_concat(value) FROM state WHERE key IN ('fireplace:rebuild:mqtt','fireplace:rebuild:providers','fireplace:rebuild:simulated')) fireplaceRebuilds,
      (SELECT MAX(id) FROM events WHERE type='heat-pump-power-config') heatPowerConfig,
      (SELECT MAX(id) FROM energy_audits) energyAudits,
      (SELECT MAX(id) FROM events WHERE type='charging-session-check') chargingSessionChecks,
      (SELECT COUNT(*) FROM imports WHERE status='complete') imports`).get(args.now,args.now,args.now));
    if (currentVersion !== version) { cache.clear(); cacheBytes = 0; version = currentVersion; }
    // Historical views survive second-by-second clock movement. Current/future
    // views renew within fifteen seconds, preserving acquisition timestamps.
    const {range}=chartRequestRange(args);
    const bucket = range.to <= args.now ? 0 : Math.floor(args.now / 15_000);
    const key = JSON.stringify({ ...args, now: bucket });
    let entry = cache.get(key), result;
    // Constant readings extend bounded energy tails and confirmation spans.
    // Renew only affected plots, preserving unrelated historical caches and the
    // live clock bucket when source evidence itself has not changed.
    if(entry&&(entry.pendingEnergyFingerprint!==pendingEnergyFingerprint(args,range)
      ||entry.sourceCoverageFingerprint!==sourceCoverageFingerprint(args,range))) {
      cache.delete(key);cacheBytes-=entry.bytes;entry=null;
    }
    // Cycle records can be corrected without a new telemetry or journal row.
    // Recheck their compact selected-period aggregate, retaining history cache
    // hits for unrelated recorder/checkpoint writes and active observation tapes.
    if (entry && !entry.result.meta.detail && (heatingFingerprint(entry.result.heatingBenefit) !== heatingFingerprint(
      getHeatingBenefit({ ...args, store, range: entry.result.range })) || entry.garageFingerprint !== heatingFingerprint(
      getGarageModelBenefit({ ...args, store, range: entry.result.range })))) {
      cache.delete(key); cacheBytes -= entry.bytes; entry = null;
    }
    if (entry) {
      cache.delete(key); cache.set(key, entry);
      result = { ...entry.result, now: args.now, meta: { ...entry.result.meta, cacheHit: true } };
    } else {
      // Replay and source handovers must see one committed journal prefix.
      let pendingFingerprint,sourceFingerprint;
      db.exec('BEGIN');
      try { result = getChartData({ ...args, store }); pendingFingerprint=pendingEnergyFingerprint(args,range);
        sourceFingerprint=sourceCoverageFingerprint(args,range); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      const bytes = Buffer.byteLength(JSON.stringify(result));
      while (cache.size && (cache.size >= 16 || cacheBytes + bytes > 32 * 1024 * 1024)) {
        const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first);
      }
      if (bytes <= 32 * 1024 * 1024) { entry = { result, bytes, pendingEnergyFingerprint:pendingFingerprint,
        sourceCoverageFingerprint:sourceFingerprint,
        garageFingerprint: heatingFingerprint(getGarageModelBenefit({ ...args, store, range: result.range })) }; cache.set(key, entry); cacheBytes += bytes; }
    }
    parentPort.postMessage({ id, result });
  } catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
});
