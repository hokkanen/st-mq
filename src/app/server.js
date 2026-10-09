import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, extname } from 'node:path';
import { getChartData, chartRequestRange } from './chart-data.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';
import { simulatedOutlook } from './simulator.js';
import { createChartService } from './chart-service.js';
import { createDatabaseExport, databaseExportErrorMessage } from './database-export.js';
import { createRecordingHealth } from './recording-health.js';
import { familyRouteAllowed, familyActionAllowed, fireplaceAccess, FAMILY_FIREWOOD_REMOVAL_MS } from './web-permissions.js';
import { ChargingSessionDiagnostics } from '../charging/session-diagnostics.js';
import { electricityForecastView } from './electricity-forecast-view.js';
import { recoveryFailure } from '../recovery/errors.js';

function authorized(req, token) {
  if (!token) return false;
  const supplied = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
function webIdentity(req, access, ingress) {
  if (ingress) return { role: 'admin', source: 'ingress' };
  if (authorized(req, access.token)) return { role: 'admin', source: 'password' };
  if (access.token && authorized(req, access.familyToken)) return { role: 'family', source: 'password' };
  if (!access.token && !access.familyToken && !access.tokenRequired) return { role: 'admin', source: 'local' };
  return null;
}
const ingressProxy = address => address === '172.30.32.2' || address === '::ffff:172.30.32.2';

function requestHost(req, ingress) {
  // Forwarded identity is meaningful only on the dedicated, peer-restricted
  // ingress listener. Direct requests never gain trust from proxy headers.
  const host = ingress ? req.headers['x-forwarded-host'] ?? req.headers.host : req.headers.host;
  if (typeof host !== 'string' || !host || /[\s,/@\\]/.test(host)) return null;
  try { return new URL(`http://${host}`).host === host.toLowerCase() ? host.toLowerCase() : null; }
  catch { return null; }
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON content type required'), { statusCode: 400 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('Request too large'), { statusCode: 400 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function numberParam(url, key, fallback, max) {
  const n = Number(url.searchParams.get(key) ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(`Invalid ${key}`);
  return n;
}
function optionalTimestampParam(url, key) {
  const value = url.searchParams.get(key);
  if (value === null) return undefined;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError(`Invalid ${key}`);
  return Number(value);
}
function chargingReportQuery(url, kind) {
  const accepted = kind === 'list' ? ['chargerId', 'savedOnly', 'before', 'limit']
    : kind === 'events' ? ['chargerId', 'filter', 'before', 'limit'] : ['chargerId'];
  for (const key of url.searchParams.keys()) {
    if (!accepted.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new TypeError('Unsupported charging report query.');
  }
  const chargerId = url.searchParams.get('chargerId');
  if (!['charger1', 'charger2'].includes(chargerId)) throw new TypeError('Select a charging point for this report.');
  const query = { chargerId };
  if (kind === 'list' || kind === 'events') {
    query.limit = numberParam(url, 'limit', kind === 'list' ? 20 : 50, 100);
    if (!query.limit) throw new TypeError('Invalid limit');
    query.before = url.searchParams.get('before');
    if (query.before !== null && (!query.before || query.before.length > 256)) throw new TypeError('Invalid before');
  }
  if (kind === 'list') {
    const savedOnly = url.searchParams.get('savedOnly');
    if (savedOnly !== null && !['true', 'false'].includes(savedOnly)) throw new TypeError('Invalid savedOnly');
    query.savedOnly = savedOnly === 'true';
  }
  if (kind === 'events') {
    query.filter = url.searchParams.get('filter') ?? 'all';
    if (!['all', 'findings', 'plans', 'charging', 'control', 'vehicle', 'evidence'].includes(query.filter))
      throw new TypeError('Invalid event filter');
  }
  return query;
}

export function createAppServer({ engine, getEngine = () => engine, store, chartService, token = '', familyToken = '',
  getAccess, ingress = false, role = 'master', topology = 'standalone', getReadContext, syncStatus,
  pairContext, controlAuthority, historyRecovery, recordingHealth, databaseExport, databaseVerification, getDatabaseExportDirectory = homedir,
  reloadSettings, previewSettings, settingsReloadStatus = () => ({ available: false, busy: false,
    reason: 'This instance has no reloadable configuration source.' }), staticDir = resolve('dist') }) {
  const overviewService = getReadContext ? null : chartService?.overview ? chartService : createChartService({ store });
  if (typeof familyToken !== 'string' || familyToken && (!token || token === familyToken))
    throw new Error('Family access requires a separate admin web token.');
  const fixedAccess = { enabled: true, token, familyToken, tokenRequired: false };
  const access = getAccess ?? (() => fixedAccess);
  recordingHealth ??= createRecordingHealth({ getConfig: () => ({ dbPath: store?.path,
    recording: getEngine()?.config?.recording }) });
  const exportDatabase = databaseExport ?? createDatabaseExport({ getDirectory: getDatabaseExportDirectory,
    onBackupEvent: (event, sourceStore) => recordingHealth.backupEvent(event, sourceStore ?? store) });
  const writesBlocked = () => role === 'slave' || Boolean(pairContext && !pairContext.canControl())
    || Boolean(controlAuthority && !controlAuthority.canControl());
  const recovering = () => Boolean(historyRecovery?.busy() || pairContext?.recovering?.());
  const readOnlyMessage = 'This computer is read-only. Database edits, settings changes and device commands require the active master.';
  const server = createServer(async (req, res) => {
    let acceptedAccess, completingReload = false, readContext, webAccess;
    const json = (code, value) => {
      // Revocation also covers reads that were awaiting chart/database work.
      // An already authenticated reload may finish its own success response.
      if (acceptedAccess && !ingress && !completingReload) {
        const current = access();
        if (!current.enabled) { code = 503; value = { error: 'Direct web access is disabled' }; }
        else if (current !== acceptedAccess) { code = 401; value = { error: 'Authentication required' }; }
      }
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'");
    try {
      if (ingress && !ingressProxy(req.socket.remoteAddress)) return json(403, { error: 'Ingress proxy required' });
      acceptedAccess = access();
      if (!acceptedAccess.enabled) return json(503, { error: 'Direct web access is disabled' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        const host = requestHost(req, ingress);
        if (!host) return json(403, { error: 'Unrecognized request host' });
        if (!ingress && !acceptedAccess.token && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return json(403, { error: 'Unrecognized local host' });
        // Same-origin JSON writes prevent cross-site requests, including on a
        // loopback installation where no bearer token is configured.
        if (req.headers.origin && new URL(req.headers.origin).host !== host) return json(403, { error: 'Cross-origin request rejected' });
        const stillAuthorized = () => {
          const current = access();
          if (!current.enabled) { json(503, { error: 'Direct web access is disabled' }); return false; }
          const identity = webIdentity(req, current, ingress);
          if (!identity || !ingress && current !== acceptedAccess) {
            json(401, { error: 'Authentication required' }); return false;
          }
          webAccess = identity;
          return true;
        };
        if (!stillAuthorized()) return;
        if (webAccess.role === 'family' && !familyRouteAllowed(req.method, url.pathname))
          return json(403, { error: 'Admin access is required for this action.' });
        const downloads = {
          '/api/downloads/floor-preheat-guide': ['../../docs/floor-preheat.md', 'floor-preheat.md', 'text/markdown'],
        };
        if (req.method === 'GET' && downloads[url.pathname]) {
          const [source, filename, type] = downloads[url.pathname];
          const data = await readFile(new URL(source, import.meta.url));
          if (!stillAuthorized()) return;
          res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store', 'content-length': data.length });
          return res.end(data);
        }
        if (url.pathname === '/api/pair' && req.method === 'GET') {
          const pair = pairContext?.status();
          // Pair management must bootstrap even when database-backed dashboard
          // status fails. This is the same authenticated role as /api/status.
          return json(200, pair ? { ...pair, webAccess } : null);
        }
        if (url.pathname === '/api/pair/action' && req.method === 'POST') {
          if (!pairContext) return json(409, { error: 'Paired operation is not configured.' });
          const input = await body(req);
          if (!stillAuthorized()) return;
          if (settingsReloadStatus().stopping) return json(503, { error: 'The application is shutting down.' });
          return json(202, pairContext.requestAction(input));
        }
        if (url.pathname === '/api/database-verification' && ['GET', 'POST'].includes(req.method)) {
          if (!databaseVerification) return json(409, { error: 'Database verification is unavailable.' });
          if (req.method === 'GET') return json(200, databaseVerification.status());
          const input = await body(req);
          if (!stillAuthorized()) return;
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            return json(400, { error: 'Start database verification with an empty JSON object.' });
          return json(202, databaseVerification.start());
        }
        const saveDatabase = req.method === 'POST' && url.pathname === '/api/database-export';
        // Pair management and read-only verification above are explicit standby exceptions. Even
        // saving a new database file on this host requires the active master;
        // downloading existing history remains available through GET.
        if (writesBlocked() && !['GET', 'HEAD'].includes(req.method))
          return json(role === 'slave' ? 405 : 409, { error: readOnlyMessage });
        const unavailable = () => {
          const state = settingsReloadStatus();
          if (state.unavailable) return state.reason;
          return state.busy ? 'Settings are being updated. Retry shortly.' : null;
        };
        if (unavailable() && url.pathname !== '/api/recording-health') return json(503, { error: unavailable() });
        if (url.pathname === '/api/history-recovery' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'before') || url.searchParams.getAll('before').length > 1)
            return json(400, { error: 'Unsupported recovery history query.' });
          const before = url.searchParams.get('before') ?? undefined;
          if (before !== undefined && (before.length > 180 || !/^\d+:[a-f0-9-]+$/.test(before)))
            return json(400, { error: 'Invalid recovery history cursor.' });
          if (!historyRecovery) return json(200, { available: false, readOnly: true, busy: false,
            sources: [], operations: [], job: null, preview: null, peer: pairContext?.status() ?? null });
          const result = await historyRecovery.view({ before });
          if (!stillAuthorized()) return;
          return json(200, result);
        }
        if (url.pathname === '/api/history-recovery/upload' && req.method === 'POST') {
          if (!historyRecovery) return json(409, { error: readOnlyMessage });
          // Stream directly into a bounded private file; never buffer a database
          // in memory or accept a path from the browser.
          const result = await historyRecovery.upload(req, () => {
            const current = access();
            return current.enabled && (ingress || current === acceptedAccess)
              && webIdentity(req, current, ingress)?.role === 'admin' && !writesBlocked() && !unavailable();
          });
          if (!stillAuthorized()) return;
          return json(201, result);
        }
        if (url.pathname === '/api/history-recovery/action' && req.method === 'POST') {
          if (!historyRecovery) return json(409, { error: readOnlyMessage });
          const input = await body(req);
          if (!stillAuthorized()) return;
          if (unavailable()) return json(503, { error: unavailable() });
          if (writesBlocked()) return json(409, { error: readOnlyMessage });
          return json(202, await historyRecovery.action(input));
        }
        if (saveDatabase) {
          const input = await body(req);
          if (!stillAuthorized()) return;
          if (unavailable()) return json(503, { error: unavailable() });
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            return json(400, { error: 'Save a database copy with an empty JSON object.' });
        }
        readContext = await getReadContext?.();
        const engine = readContext?.engine ?? getEngine();
        const readerStore = readContext?.store ?? store;
        const readerCharts = readContext?.chartService ?? chartService;
        const sensorChangesStatus = (view = (readContext ? engine : getEngine()).sensorChangesStatus()) => {
          const readOnly = role === 'slave' || controlAuthority && !controlAuthority.canControl()
            || recovering() || pairContext && !pairContext.canControl();
          return readOnly ? { ...view, available: false, readOnly: true, canRetryRebuild: false,
            events: view.events.map(event => ({ ...event, canRevert: false })) } : view;
        };
        const fireplaceStatus = (view, now) => fireplaceAccess(writesBlocked() || recovering()
          ? { ...view, available: false, readOnly: true } : view, webAccess, now);
        const status = () => {
          const sync = syncStatus?.();
          const current = (readContext ? engine : getEngine()).status();
          return { ...current, topology, role, webAccess,
            ...(current.fireplace ? { fireplace: fireplaceStatus(current.fireplace, current.now ?? engine.clock()) } : {}),
            ...(current.sensorChanges ? { sensorChanges: sensorChangesStatus(current.sensorChanges) } : {}), settingsReload: settingsReloadStatus(),
            ...(sync ? { sync } : {}), ...(controlAuthority ? { controlAuthority: controlAuthority.status(),
              ...(!controlAuthority.canControl() ? { readOnly: true } : {}) } : {}),
            ...(pairContext ? { pair: pairContext.status(),
              readOnly: writesBlocked() } : {}) };
        };
        const mutate = async action => {
          const input = await body(req);
          // A credential can be rotated while a client slowly uploads a body.
          // Recheck before any control or configuration mutation is dispatched.
          if (!stillAuthorized()) return;
          // A slow JSON body can span a complete reload. Resolve the engine only
          // after parsing, and never dispatch while a replacement is in progress.
          if (unavailable()) return json(503, { error: unavailable() });
          if (writesBlocked()) return json(409, { error: readOnlyMessage });
          if (recovering() && ['/api/fireplace', '/api/fireplace/remove', '/api/sensor-changes',
            '/api/sensor-changes/revert', '/api/sensor-changes/retry-rebuild', '/api/settings/reload', '/api/settings/preview', '/api/charging/ocpp-setup'].includes(url.pathname))
            return json(409, { error: 'Historical recovery is running. Wait before changing source corrections or configuration.' });
          const current = getEngine();
          if (webAccess.role === 'family' && !familyActionAllowed(url.pathname, input, current))
            return json(403, { error: 'Admin access is required for this action.' });
          const commit = operation => store.runWrite(operation, {
            bytes: Buffer.byteLength(JSON.stringify(input)),
            isCurrent: () => !res.destroyed && !unavailable() && !writesBlocked()
              && current === getEngine() && stillAuthorized(),
          });
          return action(current, input, commit);
        };
        if (req.method === 'GET' && url.pathname === '/api/recording-health')
          return json(200, await recordingHealth.status({ store: readerStore, engine,
            current: engine?.latestStatus, readOnly: writesBlocked() }));
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const current = status();
          return json(200, { ...current, recordingHealth: await recordingHealth.status({ store: readerStore, engine,
            current, readOnly: writesBlocked() }) });
        }
        if (readContext && !readContext.store) return json(503, { error: 'Waiting for a verified master snapshot.' });
        if (req.method === 'GET' && url.pathname === '/api/heating/explorer') {
          if (!engine.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
          const result = await engine.heatingExplorer.view();
          if (!stillAuthorized()) return;
          if (unavailable() || !readContext && engine !== getEngine())
            return json(409, { error: 'Configuration changed during the comparison. Refresh the plan.' });
          return json(200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/heating/explorer/simulate')
          return await mutate(async (current, input) => {
            if (!current.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
            const result = await current.heatingExplorer.simulate(input);
            if (!stillAuthorized()) return;
            if (unavailable() || current !== getEngine())
              return json(409, { error: 'Configuration changed during the comparison. Refresh the plan.' });
            return json(200, result);
          });
        if (req.method === 'POST' && url.pathname === '/api/heating/explorer/apply')
          return await mutate(async (current, input, commit) => {
            if (!current.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
            return json(200, await commit(() => current.heatingExplorer.apply(input)));
          });
        if (req.method === 'POST' && url.pathname === '/api/heating/explorer/cancel')
          return await mutate(async (current, input, commit) => {
            if (!current.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
            return json(200, await commit(() => current.heatingExplorer.cancel(input)));
          });
        if (req.method === 'GET' && url.pathname === '/api/database-export')
          return await exportDatabase({ store: readerStore, response: res, authorized: stillAuthorized });
        if (saveDatabase) {
          if (writesBlocked()) return json(409, { error: readOnlyMessage });
          try {
            const result = await exportDatabase({ store: readerStore, response: res, authorized: () => {
              if (!stillAuthorized()) return false;
              if (writesBlocked()) { json(409, { error: readOnlyMessage }); return false; }
              return true;
            }, save: true });
            if (result) return json(200, result);
          } catch (error) {
            if (error.statusCode === 409) throw error;
            return json(503, { error: databaseExportErrorMessage(error.code)
              ?? 'Could not save the database copy. Check that the configured export folder is writable and has enough free space.' });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/charging/ocpp-setup')
          return await mutate(async (current, input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input)
              || Object.keys(input).sort().join(',') !== 'action,revision'
              || input.action !== 'adopt' || !/^[a-f0-9]{64}$/.test(input.revision))
              return json(400, { error: 'Invalid local charger setup request.' });
            if (!current.ocppSetup) return json(409, { error: 'Local charger setup is unavailable.' });
            try { return json(200, { setup: await current.ocppSetup.adopt(input.revision) }); }
            catch (error) {
              const message = error.code === 'ocpp-setup-changed'
                ? 'Charger setup changed. Review the current configuration before trying again.'
                : error.code === 'authority-revoked' ? 'This instance no longer owns charger setup.'
                  : 'Charger setup could not be confirmed. Review its status before trying again.';
              return json(error.statusCode ?? 503, { error: message });
            }
          });
        if (req.method === 'GET' && url.pathname === '/api/fireplace')
          return json(200, fireplaceStatus(engine.fireplaceStatus(), engine.clock()));
        if (req.method === 'GET' && url.pathname === '/api/sensor-changes') return json(200, sensorChangesStatus());
        if (req.method === 'POST' && url.pathname === '/api/sensor-changes')
          return await mutate(async (current, input, commit) => {
            await commit(() => current.commitSensorChange(input));
            return json(200, await commit(() => current.finishSensorChange()));
          });
        if (req.method === 'POST' && url.pathname === '/api/sensor-changes/revert')
          return await mutate(async (current, input, commit) => {
            await commit(() => current.commitSensorReversal(input));
            return json(200, await commit(() => current.finishSensorReversal()));
          });
        if (req.method === 'POST' && url.pathname === '/api/sensor-changes/retry-rebuild')
          return await mutate(async (current, input, commit) => json(200, await commit(() => current.retrySensorRebuild(input))));
        if (req.method === 'POST' && ['/api/fireplace', '/api/fireplace/remove'].includes(url.pathname))
          return await mutate(async (current, input, commit) => {
            const removing = url.pathname.endsWith('/remove');
            const removalAccess = webAccess.role === 'family' ? { maxAgeMs: FAMILY_FIREWOOD_REMOVAL_MS } : {};
            const source = await commit(() => current.commitFireplaceSource(input, removing, removalAccess));
            const result = await commit(() => current.finishFireplaceChange({ ...source, removing }));
            return json(200, fireplaceAccess(result, webAccess, current.clock()));
          });
        if (req.method === 'POST' && url.pathname === '/api/settings/preview') {
          return await mutate(async (_engine, input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
              throw new Error('Review configuration reads saved settings; send an empty JSON object.');
            if (!previewSettings) return json(409, { error: settingsReloadStatus().reason });
            const result = await previewSettings();
            if (!stillAuthorized()) return;
            return json(200, result);
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/reload') {
          return await mutate(async (_engine, input) => {
            if (!reloadSettings) return json(409, { error: settingsReloadStatus().reason });
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
              || typeof input.reviewId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.reviewId))
              throw new Error('Review the configuration first, then apply with its reviewId.');
            completingReload = true;
            await reloadSettings(input.reviewId);
            return json(200, status());
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/automation')
          return await mutate(async (current, input) => { await current.setAutomation(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/charging/settings')
          return await mutate(async (current, input) => { await current.charging.setSettings(input); return json(200, status()); });
        const reportRoute = url.pathname.match(/^\/api\/charging\/reports(?:\/([^/]+)(?:\/(events|save|delete))?)?$/);
        if (reportRoute && req.method === 'GET' && (!reportRoute[2] || reportRoute[2] === 'events')) {
          const [, reportId, action] = reportRoute;
          const kind = action === 'events' ? 'events' : reportId ? 'report' : 'list';
          const query = chargingReportQuery(url, kind);
          // A history viewer has its own offline runtime. Its reports belong to
          // the recorded producer; never use that empty runtime's status cache.
          const key = engine.config.input === 'offline'
            ? readerStore.db.prepare('SELECT namespace FROM charging_reports WHERE charger_id=? ORDER BY started_at DESC LIMIT 1').get(query.chargerId)?.namespace
              ?? 'charging:offline:session-diagnostics'
            : `charging:${engine.config.input}:session-diagnostics`;
          const readOnly = writesBlocked() || recovering() || engine.config.input === 'offline';
          const snapshotAt = readContext ? engine.clock() : null;
          const recordedRetention = readerStore.getState(key.slice(0, -':session-diagnostics'.length))?.view?.diagnostics?.retention?.days;
          const retentionDays = (engine.config.input === 'offline' || readContext ? recordedRetention
            : engine.charging?.configuration?.report_retention_days) ?? recordedRetention ?? 30;
          const reports = new ChargingSessionDiagnostics({ store: readerStore, key, clock: engine.clock, retentionDays });
          const metadata = { readOnly, retention: { days: retentionDays }, ...(readOnly ? { recorded: true, liveAvailable: false } : {}),
            ...(snapshotAt !== null ? { recorded: true, snapshotAt, liveAvailable: false } : {}) };
          const annotate = report => ({ ...report, ...metadata,
            ...(readOnly ? { liveAvailable: false, evidenceStale: report.endedAt === null || report.evidenceStale === true } : {}) });
          if (kind === 'list') {
            const result = reports.listReports(query);
            return json(200, { ...result, ...metadata, reports: result.reports.map(annotate) });
          }
          const report = reports.getReport({ ...query, reportId });
          if (!report) return json(404, { error: 'This charging report is no longer available.' });
          return json(200, kind === 'events'
            ? { ...reports.reportEvents({ ...query, reportId }), ...metadata } : annotate(report));
        }
        if (reportRoute && req.method === 'POST' && ['save', 'delete'].includes(reportRoute[2]))
          return await mutate(async (current, input, commit) => {
            if (current.config.input === 'offline' || recovering())
              return json(409, { error: 'Charging reports are read-only on this computer.' });
            const [, reportId, action] = reportRoute, query = { ...chargingReportQuery(url, 'report'), reportId };
            if (!input || typeof input !== 'object' || Array.isArray(input)
              || (action === 'save' ? Object.keys(input).join(',') !== 'saved' || typeof input.saved !== 'boolean' : Object.keys(input).length))
              throw new TypeError(action === 'save' ? 'Save a report with a boolean saved value.' : 'Delete a report with an empty JSON object.');
            const reports = current.charging.sessionDiagnostics;
            if (!reports.getReport(query)) return json(404, { error: 'This charging report is no longer available.' });
            if (action === 'save') return json(200, await commit(() => reports.saveReport({ ...query, saved: input.saved })) ?? { deleted: true });
            try { await commit(() => reports.deleteReport(query)); }
            catch (error) { if (error.code === 'active-report') error.statusCode = 409; throw error; }
            return json(200, { deleted: true });
          });
        const chargingTestAction = url.pathname.match(/^\/api\/charging\/tests\/(preview|start|schedule|target|cancel)$/);
        if (req.method === 'POST' && chargingTestAction)
          return await mutate(async (current, input, commit) => {
            if (recovering()) return json(409, { error: 'Wait for recovery to finish before changing a charging assessment.' });
            const result = await commit(() => current.charging.chargingTestAction(chargingTestAction[1], input));
            return json(200, chargingTestAction[1] === 'preview' ? result : status());
          });
        const chargerAction = url.pathname.match(/^\/api\/charging\/chargers\/([^/]+)\/(settings|control|resume|use-automatic|charge-now|identify|flexibility|flexibility-preview)$/);
        if (req.method === 'POST' && chargerAction)
          return await mutate(async (current, input) => {
            const [, id, action] = chargerAction;
            const method = { settings: 'setChargerSettings', control: 'setControl', resume: 'resume', 'use-automatic': 'useAutomatic', 'charge-now': 'chargeNow', identify: 'identifyVehicle',
              flexibility: 'setFlexibility', 'flexibility-preview': 'previewFlexibility' }[action];
            const result = await current.charging[method](id, input);
            return json(200, action === 'flexibility-preview' ? result : status());
          });
        if (req.method === 'POST' && url.pathname === '/api/garage/heating')
          return await mutate(async (current, input) => { await current.garage.setHeating(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/garage/native')
          return await mutate(async (current, input) => { await current.garage.setNativeSettings(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/recheck')
          return await mutate(async (current, input) => { await current.recheckEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/switch')
          return await mutate(async (current, input) => { await current.switchEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/cover')
          return await mutate(async (current, input) => { await current.coverEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/dehumidifier')
          return await mutate(async (current, input) => { await current.dehumidifierEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/dehumidifier/temperature-control')
          return await mutate(async (current, input) => { await current.dehumidifierTemperatureControl(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/h66')
          return await mutate(async (current, input) => { await current.setH66Setting(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/test')
          return await mutate(async (current, input) => { await current.testEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/test/restore')
          return await mutate(async (current, input) => { await current.restoreEquipmentTest(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/dhwr/stop')
          return await mutate(async (current, input) => { await current.stopDhwr(input); return json(200, status()); });
        if (req.method === 'GET' && url.pathname === '/api/recording-overview') {
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          try {
            const result = await (readerCharts?.overview ? readerCharts : overviewService).overview({ signal: cancellation.signal });
            if (!res.destroyed) return json(200, result);
          } finally { res.removeListener('close', cancel); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/energy-audits') {
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          let service, ownsService = false;
          try {
            service = readerCharts?.energyChecks ? readerCharts : overviewService?.energyChecks ? overviewService : null;
            if (!service) { service = createChartService({ store: readerStore }); ownsService = true; }
            const result = await service.energyChecks({ now: engine.clock() }, { signal: cancellation.signal });
            if (!res.destroyed) return json(200, result);
          } finally {
            res.removeListener('close', cancel);
            if (ownsService) await service.close();
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/electricity-forecast') {
          const now = engine.clock();
          return json(200, electricityForecastView({ now,
            forecast: engine.electricityForecast?.snapshot({ now }),
            official: readerStore.getState('provider:market')?.intervals ?? [], contract: engine.contract() }));
        }
        if (req.method === 'GET' && url.pathname === '/api/chart') {
          const now = engine.clock();
          const args = { input: engine.config.input, contract: engine.contract(),
            market: readerStore.getState('provider:market'), weather: readerStore.getState('provider:weather'),
            simulated: engine.plant ? simulatedOutlook(now) : null, now,
            startDate: url.searchParams.get('start') ?? undefined,
            endDate: url.searchParams.get('end') ?? undefined,
            left: url.searchParams.get('left') ?? undefined, view: url.searchParams.get('view') ?? undefined,
            points: numberParam(url, 'points', 800, 4096),
            viewFrom: optionalTimestampParam(url, 'viewFrom'), viewTo: optionalTimestampParam(url, 'viewTo') };
          const stream = req.headers.accept?.split(',').some(value => value.trim().split(';')[0] === 'application/x-ndjson');
          const prefetch = req.headers['x-chart-prefetch'];
          if (prefetch !== undefined && prefetch !== '1') throw new TypeError('Invalid chart prefetch header');
          const { selection } = chartRequestRange(args);
          if (prefetch && Date.parse(selection.endDate) - Date.parse(selection.startDate) >= 7 * 86_400_000)
            throw new RangeError('Chart prefetch is limited to seven calendar days');
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          // Recheck access after every asynchronous boundary, including streamed
          // progress. Revoked requests never receive a prepared history payload.
          const chartAuthorized = () => {
            if (res.destroyed || res.writableEnded) return false;
            const current = access();
            if (current.enabled && (ingress || current === acceptedAccess)) return true;
            const message = current.enabled ? 'Authentication required' : 'Direct web access is disabled';
            if (res.headersSent) res.end(JSON.stringify({ type: 'error', message, status: current.enabled ? 401 : 503 }) + '\n');
            else json(current.enabled ? 401 : 503, { error: message });
            cancellation.abort();
            return false;
          };
          const startStream = () => {
            if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson',
              'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          };
          const onProgress = stream ? progress => {
            if (!chartAuthorized() || res.writableNeedDrain) return;
            startStream();
            res.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
          } : undefined;
          try {
            const service = readerCharts ?? overviewService;
            const options = { signal: cancellation.signal, onProgress,
              priority: prefetch ? 'prefetch' : 'foreground', format: stream ? 'ndjson' : 'json' };
            let bytes;
            if (service?.queryWire) bytes = await service.queryWire(args, options);
            else {
              const result = service ? await service.query(args, options) : getChartData({ store: readerStore, ...args, onProgress });
              bytes = encodeChartResponse(result, prepareChartResponse(result), options.format);
            }
            if (chartAuthorized()) {
              if (stream) startStream();
              else res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
              res.end(bytes);
            }
          } catch (error) {
            if (!res.destroyed && !res.writableEnded) {
              if (res.headersSent) res.end(JSON.stringify({ type: 'error', message: error.message }) + '\n');
              else throw error;
            }
          } finally { res.removeListener('close', cancel); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/contract') return json(200, engine.contract());
        if (req.method === 'POST' && ['/api/contract', '/api/settings'].includes(url.pathname)) return json(405, { error: 'Permanent settings and electricity rates come from configuration. Use Apply configuration after editing them.' });
        if (req.method === 'POST' && url.pathname === '/api/temporary') return await mutate(async (current, input, commit) => {
          const result = await commit(() => current.setTemporary(input));
          return json(200, { ...result, webAccess, ...(result.fireplace
            ? { fireplace: fireplaceAccess(result.fireplace, webAccess, current.clock()) } : {}) });
        });
        if (req.method === 'POST' && url.pathname === '/api/test/h66') return await mutate(async (current, input) => json(200, await current.testH66(input)));
        if (req.method === 'POST' && url.pathname === '/api/heating-test') return await mutate(async (current, input) => json(200, await current.testHeating(input)));
        if (req.method === 'GET' && url.pathname === '/api/events') return json(200, readerStore.events({ after: numberParam(url, 'after', 0, Number.MAX_SAFE_INTEGER), limit: numberParam(url, 'limit', 100, 500) }));
        if (req.method === 'GET' && url.pathname === '/api/history') {
          const now = engine.clock();
          const from = numberParam(url, 'from', now - 86_400_000, Number.MAX_SAFE_INTEGER);
          const to = numberParam(url, 'to', now, Number.MAX_SAFE_INTEGER);
          if (to < from || to - from > 31 * 86_400_000) throw new Error('History range must be at most 31 days');
          const signal = url.searchParams.get('signal') ?? 'indoor_temperature';
          if (!/^[a-z0-9_]{1,64}$/.test(signal)) throw new Error('Invalid signal');
          return json(200, readerStore.observations({ signal, from, to, limit: numberParam(url, 'limit', 1000, 5000) }));
        }
        return json(404, { error: 'Unknown endpoint' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: 'Method not allowed' });
      const name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!/^\/[a-zA-Z0-9/_\-.]+$/.test(name) || name.includes('..')) return json(404, { error: 'Not found' });
      const path = resolve(staticDir, `.${name}`);
      if (!path.startsWith(`${resolve(staticDir)}/`)) return json(404, { error: 'Not found' });
      try {
        const data = await readFile(path);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
          '.webmanifest': 'application/manifest+json' }[extname(path)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': /\.(html|webmanifest)$/.test(name) ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        json(404, { error: 'UI build not found. Run npm run build.' });
      }
    } catch (error) {
      if (!res.destroyed) {
        if (/^\/api\/database-verification(?:\?|$)/.test(req.url))
          return json(error.statusCode ?? (error instanceof SyntaxError ? 400 : 503),
            error.code === 'full_verification_unavailable'
              ? { code: error.code, error: 'Verification cannot start until a current database is available.' }
              : { error: 'Database verification is unavailable or the request is invalid. Refresh its status before retrying.' });
        if (req.method === 'GET' && /^\/api\/database-export(?:\?|$)/.test(req.url)
          && databaseExportErrorMessage(error.code))
          return json(error.statusCode ?? 503, { error: databaseExportErrorMessage(error.code) });
        if (/^\/api\/history-recovery(?:\/(?:action|upload))?(?:\?|$)/.test(req.url)) {
          // Filesystem and SQLite failures can contain private paths or source
          // content. Only coordinator-authored explanations cross this boundary.
          const status = error.statusCode ?? (error instanceof SyntaxError ? 400 : 503);
          return json(status, recoveryFailure({ code: error.code, errcode: error.errcode },
            status >= 500 ? 'recovery_request_unconfirmed' : 'recovery_request_invalid'));
        }
        if (/^\/api\/pair\/action(?:\?|$)/.test(req.url)) {
          const status = error.statusCode ?? (error instanceof SyntaxError ? 400 : 503);
          // Only coordinator-authored refusals receive this marker. Native
          // errors and lost outcomes must not acquire a definitive explanation.
          const refused = Number.isInteger(status) && status >= 400 && status < 500 && ![408, 429].includes(status);
          return json(status, refused && typeof error.publicMessage === 'string' && error.publicMessage.length > 0
            ? { code: 'pair_action_rejected', error: error.publicMessage }
            : { error: refused ? 'The paired request was rejected. Review the action requirements and current status.'
              : 'The paired request could not be confirmed. Recheck its saved outcome before trying again.' });
        }
        const fireplaceWrite = req.method === 'POST' && /^\/api\/(?:fireplace(?:\/remove)?|sensor-changes(?:\/(?:revert|retry-rebuild))?)(?:\?|$)/.test(req.url);
        const code = error.statusCode ?? (fireplaceWrite && !(error instanceof TypeError || error instanceof SyntaxError) ? 503 : 400);
        json(code, { error: code >= 500 ? 'Request could not be confirmed. Retry shortly.'
          : error instanceof SyntaxError && /^\/api\/settings\//.test(req.url) ? 'The request must contain valid JSON.' : error.message });
      }
    } finally { readContext?.release?.(); }
  });
  if (overviewService && overviewService !== chartService) server.once('close', () => { void overviewService.close(); });
  return server;
}
