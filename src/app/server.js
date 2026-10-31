import { createGzip, constants as zlibConstants } from 'node:zlib';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { getChartData, chartRequestRange, chartRange } from './chart-data.js';
import { prepareChartResponse, encodeChartResponse } from './chart-wire.js';
import { simulatedOutlook } from './simulator.js';
import { createChartService } from './chart-service.js';
import { REPLICA_CHECKPOINT_ADVANCED } from './chart-read-errors.js';
import { createDatabaseExport, databaseExportErrorMessage } from './database-export.js';
import { createRecordingHealth } from './recording-health.js';
import { storageFailureCode } from '../storage/write-health.js';
import { createBackupCatalog } from '../storage/backup-catalog.js';
import { backupDirectory } from '../storage/backup-directory.js';
import { createBackupInspection } from './backup-inspection.js';
import { familyRouteAllowed, familyActionAllowed, fireplaceAccess, FAMILY_FIREWOOD_REMOVAL_MS } from './web-permissions.js';
import { ChargingSessionDiagnostics, recordedChargingReportNamespace } from '../charging/session-diagnostics.js';
import { electricityForecastView } from './electricity-forecast-view.js';
import { recoveryFailure } from '../recovery/errors.js';
import { EQUIPMENT_COMMAND_ERRORS } from '../domain/equipment-command-errors.js';
import { FLOOR_COMMAND_ERRORS } from '../domain/floor-command-errors.js';
import { ReplicaCheckpointMismatchError, REPLICA_CHECKPOINT_MISMATCH, createReplicaReadRefusalReporter } from './replica-errors.js';
import { createWebSessions, rememberedCookieDigest, rememberedCookie, clearRememberedCookie } from './web-sessions.js';
import { eventLogQuery } from './event-log.js';
import { createEventLogService } from './event-log-service.js';
import { isRecordedDataAction } from '../domain/recorded-data-action.js';

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
const controlRequestPath = path => ['/api/automation', '/api/charging/settings', '/api/garage/heating', '/api/garage/native',
  '/api/equipment/switch', '/api/equipment/floor', '/api/equipment/cover', '/api/equipment/dehumidifier',
  '/api/equipment/dehumidifier/temperature-control', '/api/equipment/dehumidifier/location-check', '/api/equipment/h66',
  '/api/equipment/test', '/api/equipment/test/restore', '/api/dhwr/stop', '/api/temporary', '/api/test/h66',
  '/api/heating-test', '/api/heating/explorer/apply', '/api/heating/explorer/cancel'].includes(path)
  || /^\/api\/charging\/tests\/(start|schedule|target|cancel)$/.test(path)
  || /^\/api\/charging\/chargers\/(charger1|charger2)\/(settings|control|pause|resume|use-automatic|charge-now|identify|flexibility)$/.test(path);

function requestHost(req, ingress) {
  // Forwarded identity is meaningful only on the dedicated, peer-restricted
  // ingress listener. Direct requests never gain trust from proxy headers.
  const host = ingress ? req.headers['x-forwarded-host'] ?? req.headers.host : req.headers.host;
  if (typeof host !== 'string' || !host || /[\s,/@\\]/.test(host)) return null;
  try { return new URL(`http://${host}`).host === host.toLowerCase() ? host.toLowerCase() : null; }
  catch { return null; }
}
async function body(req, timeoutMs = 0) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON content type required'), { statusCode: 400 });
  // Small JSON commands have their own short input budget. Large authenticated
  // backup uploads use the recovery owner's separate bounded streaming budget.
  const deadline = timeoutMs > 0 ? setTimeout(() => req.destroy(Object.assign(new Error('Request body timed out'), { statusCode: 408 })), timeoutMs) : null;
  deadline?.unref();
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw Object.assign(new Error('Request too large'), { statusCode: 400 });
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(deadline); }
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
  const accepted = kind === 'list' ? ['chargerId', 'savedOnly', 'before', 'after', 'limit']
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
    query.after = url.searchParams.get('after');
    if (query.after !== null && (!query.after || query.after.length > 256)) throw new TypeError('Invalid after');
    if (query.before !== null && query.after !== null) throw new TypeError('Select one report paging direction');
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
  getAccess, ingress = false, tls, transportLimits, webTransport, webSessions, maintenance = () => false, acquireRequest, clock = Date.now, role = 'master', topology = 'standalone', getReadContext, syncStatus,
  pairContext, controlAuthority, historyRecovery, recordingHealth, databaseExport, databaseVerification, modelReconstruction,
  backupCatalog, backupInspection, getDatabaseExportDirectory,
  reloadSettings, previewSettings, settingsReloadStatus = () => ({ available: false, busy: false,
    reason: 'This instance has no reloadable configuration source.' }), staticDir = resolve('dist') }) {
  const reportReplicaReadRefusal = createReplicaReadRefusalReporter();
  let eventLogStore = null, eventLogService = null;
  const eventLog = reader => {
    if (eventLogStore !== reader) {
      void eventLogService?.close();
      eventLogStore = reader; eventLogService = createEventLogService({ store: reader });
    }
    return eventLogService;
  };
  const overviewService = getReadContext ? null : chartService?.overview ? chartService : createChartService({ store });
  if (typeof familyToken !== 'string' || familyToken && (!token || token === familyToken))
    throw new Error('Family access requires a separate admin web token.');
  const fixedAccess = { enabled: true, token, familyToken, tokenRequired: false };
  const access = getAccess ?? (() => fixedAccess);
  const backupConfig = () => ({ ...getEngine()?.config, dbPath: getEngine()?.config?.dbPath ?? store?.path,
    recording: { ...getEngine()?.config?.recording,
      backupDirectory: getDatabaseExportDirectory?.() ?? backupDirectory(getEngine()?.config ?? { dbPath: store?.path }) } });
  backupCatalog ??= createBackupCatalog({ getConfig: backupConfig });
  recordingHealth ??= createRecordingHealth({ getConfig: backupConfig, backupCatalog,
    getBackupChecks: copies => backupInspection?.health(copies) });
  const ownInspection = !backupInspection;
  backupInspection ??= createBackupInspection({ catalog: backupCatalog,
    onDownloadEvent: event => recordingHealth.backupEvent(event, store) });
  const exportDatabase = databaseExport ?? createDatabaseExport({ getDirectory: () => backupDirectory(backupConfig()),
    onBackupEvent: (event, sourceStore) => recordingHealth.backupEvent(event, sourceStore ?? store) });
  const writesBlocked = () => role === 'slave' || Boolean(pairContext && !pairContext.canControl())
    || Boolean(controlAuthority && !controlAuthority.canControl());
  webSessions ??= createWebSessions({ store, getAccess: access, writable: () => !writesBlocked(), peer: pairContext?.webSessions, clock });
  const recovering = () => Boolean(historyRecovery?.busy() || pairContext?.recovering?.());
  const readOnlyMessage = 'This computer is read-only. Database edits, settings changes and device commands require the active master.';
  const handler = async (req, res) => {
    const releaseRequest = acquireRequest?.();
    let acceptedAccess, completingReload = false, readContext, webAccess, cookieDigest, rememberedRecord;
    const identity = current => webIdentity(req, current, ingress)
      ?? (!ingress && !req.headers.authorization && webSessions.identity(cookieDigest, rememberedRecord));
    const json = (code, value) => {
      // Revocation also covers reads that were awaiting chart/database work.
      // An already authenticated reload may finish its own success response.
      if (acceptedAccess && !ingress && !completingReload) {
        const current = access();
        if (!current.enabled) { code = 503; value = { error: 'Direct web access is disabled' }; }
        else if (current !== acceptedAccess) { code = 401; value = { error: 'Authentication required' }; }
        else if (webAccess?.remembered && !identity(current)) { code = 401; value = { error: 'Authentication required' }; }
      }
      const unreadBody = !req.complete && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']);
      if (code >= 400 && unreadBody) {
        // A refusal does not own a long upload budget. Flush the error and
        // release clients that leave their declared body unfinished.
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.socket.destroySoon());
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
        if (acceptedAccess.hostname && ((host !== `${acceptedAccess.hostname}:${req.socket.localPort}`
          && !(req.socket.localPort === 443 && host === acceptedAccess.hostname))
          || req.socket.servername && req.socket.servername !== acceptedAccess.hostname))
          return json(403, { error: 'Use the configured HTTPS hostname' });
        if (!ingress && !acceptedAccess.token && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return json(403, { error: 'Unrecognized local host' });
        // Same-origin JSON writes prevent cross-site requests, including on a
        // loopback installation where no bearer token is configured.
        if (req.headers.origin && (new URL(req.headers.origin).host !== host
          || !ingress && new URL(req.headers.origin).protocol !== (req.socket.encrypted ? 'https:' : 'http:')))
          return json(403, { error: 'Cross-origin request rejected' });
        cookieDigest = !ingress ? rememberedCookieDigest(req) : null;
        const sessionAction = ['/api/session/remember', '/api/session/logout', '/api/session/revoke-all'].includes(url.pathname);
        if (sessionAction && maintenance()) return json(503, { error: 'Pairing reset is in progress. Sign in with your password to view progress.' });
        if (sessionAction) {
          if (req.method !== 'POST') return json(405, { error: 'Use an explicit sign-in or sign-out action.' });
          if (ingress || !req.socket.encrypted) return json(403, { error: 'Remembered login requires HTTPS.' });
          if (!req.headers.origin) return json(403, { error: 'A same-origin request is required.' });
        }
        if (url.pathname === '/api/session/logout') {
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            return json(400, { error: 'Sign out with an empty request.' });
          await webSessions.revoke(cookieDigest);
          res.setHeader('Set-Cookie', clearRememberedCookie());
          return json(200, { signedOut: true });
        }
        if (!ingress && !req.headers.authorization && cookieDigest) rememberedRecord = await webSessions.authenticate(cookieDigest);
        const stillAuthorized = () => {
          const current = access();
          if (!current.enabled) { json(503, { error: 'Direct web access is disabled' }); return false; }
          const identified = identity(current);
          if (!identified || !ingress && current !== acceptedAccess) {
            json(401, { error: 'Authentication required' }); return false;
          }
          webAccess = identified;
          return true;
        };
        if (!stillAuthorized()) return;
        if (sessionAction) {
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            return json(400, { error: 'Use an empty sign-in or sign-out request.' });
          if (!stillAuthorized()) return;
          if (url.pathname === '/api/session/remember') {
            if (!webIdentity(req, access(), false)) return json(401, { error: 'Enter your password to remember this browser.' });
            const issued = await webSessions.issue(webAccess.role);
            if (!stillAuthorized()) return;
            await webSessions.revoke(cookieDigest);
            if (!stillAuthorized()) return;
            res.setHeader('Set-Cookie', rememberedCookie(issued.token, issued.expiresAt));
            return json(200, { expiresAt: issued.expiresAt });
          }
          if (webAccess.role !== 'admin') return json(403, { error: 'Admin access is required for this action.' });
          await webSessions.revokeAll(webAccess.remembered ? cookieDigest : null);
          // Successful self-revocation is allowed to return its confirmation.
          webAccess = undefined;
          res.setHeader('Set-Cookie', clearRememberedCookie());
          return json(200, { signedOut: true });
        }
        if (webAccess.role === 'family' && !familyRouteAllowed(req.method, url.pathname))
          return json(403, { error: 'Admin access is required for this action.' });
        if (url.pathname === '/api/web-access' && ['GET', 'POST'].includes(req.method) && !maintenance()) {
          if (!webTransport) return json(409, { error: 'Web access management is unavailable.' });
          if (req.method === 'GET') return json(200, { ...webTransport.status({ admin: true }), webAccess });
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (settingsReloadStatus().stopping) return json(503, { error: 'The application is shutting down.' });
          if (input?.action === 'start-fresh' && req.socket.encrypted)
            return json(409, { error: 'Open Home Assistant ingress or local HTTP recovery before starting fresh HTTPS setup.', code: 'https_recovery_entrance_required' });
          return json(202, await webTransport.action(input));
        }
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
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (settingsReloadStatus().stopping) return json(503, { error: 'The application is shutting down.' });
          return json(202, pairContext.requestAction(input));
        }
        if (url.pathname === '/api/pair/action' && req.method === 'GET') {
          if (!pairContext) return json(409, { error: 'Paired operation is not configured.' });
          const input = Object.fromEntries(url.searchParams);
          const result = await pairContext.actionStatus(input);
          if (!stillAuthorized()) return;
          return json(200, result);
        }
        if (maintenance()) return json(503, { error: 'Pairing reset is in progress. Pairing status remains available.', pair: pairContext?.status(), webAccess });
        // These jobs write only this computer's disposable verification progress.
        // Slave operation has no main-database or device-command authority.
        if (url.pathname === '/api/model-reconstruction' && req.method === 'GET') {
          if ([...url.searchParams.keys()].length) return json(400, { error: 'Unsupported model reconstruction query.' });
          if (!modelReconstruction) return json(200, { available: false, state: 'unavailable' });
          const result = await modelReconstruction.status();
          if (!stillAuthorized()) return;
          return json(200, { ...result, canManage: webAccess.role === 'admin' });
        }
        if (url.pathname === '/api/model-reconstruction/action' && req.method === 'POST') {
          if (!modelReconstruction) return json(409, { error: 'Model reconstruction is unavailable on this computer.' });
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (webAccess.role !== 'admin') return json(403, { error: 'Admin access is required for this action.' });
          const transition = settingsReloadStatus();
          if (transition.stopping || (transition.busy || transition.unavailable) && !['pause', 'cancel', 'discard'].includes(input?.action))
            return json(503, { error: 'Wait for configuration work to finish before changing reconstruction.' });
          return json(202, { ...await modelReconstruction.action(input), canManage: true });
        }
        if (url.pathname === '/api/database-verification' && ['GET', 'POST'].includes(req.method)) {
          if (!databaseVerification) return json(409, { error: 'Database verification is unavailable.' });
          if (req.method === 'GET') {
            readContext = await getReadContext?.();
            return json(200, databaseVerification.status({ store: readContext ? readContext.store : store }));
          }
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
            return json(400, { error: 'Start database verification with an empty JSON object.' });
          readContext = await getReadContext?.();
          if (!stillAuthorized()) return;
          return json(202, databaseVerification.start('manual', { store: readContext ? readContext.store : store }));
        }
        if (url.pathname === '/api/recording-backups' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'refresh') || url.searchParams.getAll('refresh').length > 1
            || url.searchParams.has('refresh') && !['true', 'false'].includes(url.searchParams.get('refresh')))
            return json(400, { error: 'Refresh the backup list with a supported query.' });
          return json(200, await backupInspection.list({ force: url.searchParams.get('refresh') === 'true' }));
        }
        if (url.pathname === '/api/recording-backups/verify' && req.method === 'POST') {
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (settingsReloadStatus().busy || settingsReloadStatus().stopping)
            return json(409, { error: 'Wait for configuration work to finish before checking a saved copy.' });
          if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).join(',') !== 'sourceId') return json(400, { error: 'Select one saved copy to verify.' });
          return json(202, backupInspection.start(input.sourceId));
        }
        if (url.pathname === '/api/recording-backups/download' && req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'sourceId') || url.searchParams.getAll('sourceId').length !== 1)
            return json(400, { error: 'Select one saved copy to download.' });
          return await backupInspection.download({ sourceId: url.searchParams.get('sourceId'), response: res,
            authorized: () => {
              const current = access();
              return current.enabled && (ingress || current === acceptedAccess)
                && identity(current)?.role === 'admin';
            } });
        }
        if (['/api/recording-overview', '/api/energy-audits'].includes(url.pathname)
          && ['GET', 'POST'].includes(req.method)) {
          const energy = url.pathname === '/api/energy-audits';
          const dateArgs = {};
          if ([...url.searchParams.keys()].length && (!energy
            || [...url.searchParams.keys()].some(key => !['start', 'end'].includes(key))
            || ['start', 'end'].some(key => url.searchParams.getAll(key).length !== 1)))
            return json(400, { error: 'Unsupported recorded-data query. Use the panel actions to refresh or cancel a check.' });
          if (energy && url.searchParams.has('start')) {
            dateArgs.startDate = url.searchParams.get('start'); dateArgs.endDate = url.searchParams.get('end');
            try { chartRange(dateArgs); } catch { return json(400, { error: 'Choose valid energy-check dates, in order, within ten years.' }); }
          }
          const input = req.method === 'POST' ? await body(req, transportLimits?.bodyTimeoutMs) : undefined;
          if (!stillAuthorized()) return;
          if (input !== undefined && !isRecordedDataAction(url.pathname, input))
            return json(400, { error: 'Choose one supported recorded-data action.' });
          const transition = settingsReloadStatus();
          if (transition.stopping || (transition.busy || transition.unavailable) && input?.action !== 'cancel')
            return json(503, { error: 'Wait for configuration work to finish before inspecting recorded data.' });
          readContext = await getReadContext?.();
          if (!stillAuthorized()) return;
          if (readContext && !readContext.store)
            return json(503, { error: 'Waiting for a verified master snapshot.' });
          const reader = readContext?.chartService ?? overviewService;
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          try {
            const options = { signal: cancellation.signal };
            const args = { now: (readContext?.engine ?? getEngine())?.clock?.() ?? clock(), ...dateArgs };
            const result = energy
              ? input === undefined ? await reader.energyChecks(args, options) : await reader.energyChecksAction(input, args, options)
              : input === undefined ? await reader.overview(options) : await reader.overviewAction(input, options);
            if (!res.destroyed) return json(200, result);
          } finally { res.removeListener('close', cancel); }
          return;
        }
        const saveDatabase = req.method === 'POST' && url.pathname === '/api/database-export';
        // Pair management and read-only verification above are explicit exceptions for the slave. Even
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
              && identity(current)?.role === 'admin' && !writesBlocked() && !unavailable();
          });
          if (!stillAuthorized()) return;
          return json(201, result);
        }
        if (url.pathname === '/api/history-recovery/action' && req.method === 'POST') {
          if (!historyRecovery) return json(409, { error: readOnlyMessage });
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          if (!stillAuthorized()) return;
          if (unavailable()) return json(503, { error: unavailable() });
          if (writesBlocked()) return json(409, { error: readOnlyMessage });
          return json(202, await historyRecovery.action(input));
        }
        if (saveDatabase) {
          const input = await body(req, transportLimits?.bodyTimeoutMs);
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
            ...(webTransport ? { webTransport: webTransport.status({ admin: false }) } : {}),
            ...(current.fireplace ? { fireplace: fireplaceStatus(current.fireplace, current.now ?? engine.clock()) } : {}),
            ...(current.sensorChanges ? { sensorChanges: sensorChangesStatus(current.sensorChanges) } : {}), settingsReload: settingsReloadStatus(),
            ...(sync ? { sync } : {}), ...(controlAuthority ? { controlAuthority: controlAuthority.status(),
              ...(!controlAuthority.canControl() ? { readOnly: true } : {}) } : {}),
            ...(pairContext ? { pair: pairContext.status(),
              readOnly: writesBlocked() } : {}) };
        };
        const mutate = async action => {
          const input = await body(req, transportLimits?.bodyTimeoutMs);
          const liveDoor = url.pathname === '/api/equipment/cover';
          // Action prechecks can read live controller RAM before their own
          // transaction. Do not let them acknowledge another provisional edit.
          while (!liveDoor && store.writePending && !res.destroyed) await store.whenWritesSettled();
          if (res.destroyed) return;
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
          const storageRefusal = reason => {
            if (!controlRequestPath(url.pathname)) return;
            try { store.writeHealth?.controlRequestBlocked?.(reason); } catch {}
          };
          if (!liveDoor && (store.writerFailed || store.writer?.failed)) {
            storageRefusal('database-unavailable');
            return json(503, { error: 'Recording storage is unavailable. Check storage and restart the application.' });
          }
          const commit = operation => store.runWrite(operation, {
            bytes: Buffer.byteLength(JSON.stringify(input)),
            isCurrent: () => !res.destroyed && !unavailable() && !writesBlocked()
              && current === getEngine() && stillAuthorized(),
          });
          try { return await action(current, input, commit); }
          catch (error) {
            if (error?.committed !== true) {
              const reason = storageFailureCode(error);
              if (reason) storageRefusal(reason);
            }
            throw error;
          }
        };
        if (req.method === 'GET' && url.pathname === '/api/recording-health')
          return json(200, await recordingHealth.status({ store: readerStore, engine,
            current: engine?.store?.writePending ? engine.committedStatus : engine?.latestStatus, readOnly: writesBlocked(), verification: databaseVerification?.health(readerStore) }));
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const current = status();
          return json(200, { ...current, recordingHealth: await recordingHealth.status({ store: readerStore, engine,
            current, readOnly: writesBlocked(), verification: databaseVerification?.health(readerStore) }) });
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
              ?? 'Could not save the database copy. Check that the configured backup folder is writable and has enough free space.' });
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
            ? recordedChargingReportNamespace(readerStore, query.chargerId)
              ?? 'charging:offline:session-diagnostics'
            : `charging:${engine.config.input}:session-diagnostics`;
          const readOnly = writesBlocked() || recovering() || engine.config.input === 'offline';
          const snapshotAt = readContext ? engine.clock() : null;
          const recordedRetention = readerStore.getState(`${key.slice(0, -':session-diagnostics'.length)}:runtime:view/reportRetentionDays`)?.value;
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
        const chargerAction = url.pathname.match(/^\/api\/charging\/chargers\/([^/]+)\/(settings|control|pause|resume|use-automatic|charge-now|identify|flexibility|flexibility-preview)$/);
        if (req.method === 'POST' && chargerAction)
          return await mutate(async (current, input) => {
            const [, id, action] = chargerAction;
            const method = { settings: 'setChargerSettings', control: 'setControl', pause: 'pause', resume: 'resume', 'use-automatic': 'useAutomatic', 'charge-now': 'chargeNow', identify: 'identifyVehicle',
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
        if (req.method === 'POST' && url.pathname === '/api/equipment/floor')
          return await mutate(async (current, input) => { await current.controlFloor(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/cover')
          return await mutate(async (current, input) => { await current.coverEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/dehumidifier')
          return await mutate(async (current, input) => { await current.dehumidifierEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/dehumidifier/temperature-control')
          return await mutate(async (current, input) => { await current.dehumidifierTemperatureControl(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/dehumidifier/location-check')
          return await mutate(async (current, input) => { await current.recheckDehumidifierLocation(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/h66')
          return await mutate(async (current, input) => { await current.setH66Setting(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/test')
          return await mutate(async (current, input) => { await current.testEquipment(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/equipment/test/restore')
          return await mutate(async (current, input) => { await current.restoreEquipmentTest(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/dhwr/stop')
          return await mutate(async (current, input) => { await current.stopDhwr(input); return json(200, status()); });
        if (req.method === 'GET' && url.pathname === '/api/electricity-forecast') {
          const now = engine.clock();
          return json(200, electricityForecastView({ now,
            forecast: engine.electricityForecast?.snapshot({ now }),
            official: readerStore.getState('provider:market')?.intervals ?? [], contract: engine.contract() }));
        }
        if (req.method === 'GET' && url.pathname === '/api/chart') {
          const summaryOnly = url.searchParams.has('summary');
          if (summaryOnly && url.searchParams.get('summary') !== '1') throw new TypeError('Invalid comparison summary selection');
          const chartArgs = context => {
            const currentEngine = context?.engine ?? engine, currentStore = context?.store ?? readerStore;
            const now = currentEngine.clock();
            return { input: currentEngine.config.input, contract: currentEngine.contract(),
              market: currentStore.getState('provider:market'), weather: currentStore.getState('provider:weather'),
              simulated: currentEngine.plant ? simulatedOutlook(now) : null, now,
              startDate: url.searchParams.get('start') ?? undefined,
              endDate: url.searchParams.get('end') ?? undefined,
              left: url.searchParams.get('left') ?? undefined, view: url.searchParams.get('view') ?? undefined,
              points: numberParam(url, 'points', 800, 4096),
              summaryOnly,
              viewFrom: optionalTimestampParam(url, 'viewFrom'), viewTo: optionalTimestampParam(url, 'viewTo') };
          };
          let args = chartArgs(readContext);
          const stream = req.headers.accept?.split(',').some(value => value.trim().split(';')[0] === 'application/x-ndjson');
          if (req.headers['x-chart-prefetch'] !== undefined) throw new TypeError('Unsupported chart header');
          chartRequestRange(args);
          const cancellation = new AbortController();
          const compressed = req.headers['accept-encoding']?.split(',').some(value => {
            const [encoding, ...parameters] = value.trim().split(';');
            return encoding.toLowerCase() === 'gzip' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
          });
          let chartOutput = res;
          const startOutput = type => {
            if (res.headersSent) return;
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', vary: 'Accept-Encoding',
              'x-accel-buffering': 'no', ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
            if (compressed) {
              chartOutput = createGzip({ level: 1 }); chartOutput.on('error', () => { cancellation.abort(); res.destroy(); });
              chartOutput.pipe(res);
            }
          };
          const cancel = () => { cancellation.abort(); if (chartOutput !== res) chartOutput.destroy(); };
          res.once('close', cancel);
          // Recheck access after every asynchronous boundary, including streamed
          // progress. Revoked requests never receive a prepared history payload.
          const chartAuthorized = () => {
            if (res.destroyed || res.writableEnded || chartOutput.writableEnded) return false;
            const current = access();
            if (current.enabled && (ingress || current === acceptedAccess)) return true;
            const message = current.enabled ? 'Authentication required' : 'Direct web access is disabled';
            if (res.headersSent) chartOutput.end(JSON.stringify({ type: 'error', message, status: current.enabled ? 401 : 503 }) + '\n');
            else json(current.enabled ? 401 : 503, { error: message });
            cancellation.abort();
            return false;
          };
          const startStream = () => startOutput('application/x-ndjson');
          const onProgress = stream ? progress => {
            if (!chartAuthorized() || chartOutput.writableNeedDrain) return;
            startStream();
            chartOutput.write(JSON.stringify({ type: 'progress', ...progress }) + '\n');
            if (compressed) chartOutput.flush(zlibConstants.Z_SYNC_FLUSH);
          } : undefined;
          try {
            let service = readerCharts ?? overviewService;
            const options = { signal: cancellation.signal, onProgress,
              format: stream ? 'ndjson' : 'json' };
            let bytes;
            for (let attempt = 0; ; attempt++) {
              if (cancellation.signal.aborted || !chartAuthorized()) return;
              try {
                if (service?.queryWire) bytes = await service.queryWire(args, options);
                else {
                  const result = service ? await service.query(args, options) : getChartData({ store: readContext?.store ?? readerStore, ...args, onProgress });
                  bytes = encodeChartResponse(result, prepareChartResponse(result), options.format);
                }
                break;
              } catch (error) {
                if (attempt || !getReadContext || !readContext || error.code !== REPLICA_CHECKPOINT_ADVANCED) throw error;
                if (cancellation.signal.aborted || !chartAuthorized()) return;
                // The worker has released its refused snapshot. Release the
                // original lease before reacquiring, and rebuild every source
                // argument at the new verified boundary. Never relax its fence.
                const previousCheckpoint = readContext.checkpoint;
                readContext.release();
                readContext = null;
                readContext = await getReadContext();
                if (cancellation.signal.aborted || !chartAuthorized()) return;
                const nextCheckpoint = readContext?.checkpoint;
                if (!readContext?.chartService || !previousCheckpoint || !nextCheckpoint
                  || nextCheckpoint.databaseId !== previousCheckpoint.databaseId
                  || nextCheckpoint.sequence <= previousCheckpoint.sequence) throw error;
                service = readContext.chartService;
                args = chartArgs(readContext);
              }
            }
            if (chartAuthorized()) {
              if (stream) startStream();
              else startOutput('application/json');
              chartOutput.end(bytes);
            }
          } catch (error) {
            if (!res.destroyed && !res.writableEnded && !chartOutput.writableEnded) {
              if (res.headersSent) chartOutput.end(JSON.stringify({ type: 'error', message: error.message }) + '\n');
              else throw error;
            }
          } finally { if (res.writableEnded) res.removeListener('close', cancel); }
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
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const query = eventLogQuery(url);
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          try {
            for (let attempt = 0; ; attempt++) {
              if (res.destroyed || res.writableEnded || !stillAuthorized()) return;
              const currentEngine = readContext?.engine ?? engine, currentStore = readContext?.store ?? readerStore;
              const snapshot = Boolean(readContext) || currentEngine.config.input === 'offline';
              try {
                const result = await (readContext?.eventLogService ?? eventLog(currentStore)).query({ input: currentEngine.config.input, now: currentEngine.clock(), checkedAt: clock(),
                  query, scope: snapshot ? 'snapshot' : 'live', snapshotAt: readContext ? currentEngine.clock() : null,
                  checkpoint: readContext ? currentStore.expectedCheckpoint : undefined }, { signal: cancellation.signal });
                if (!res.destroyed && !res.writableEnded && stillAuthorized()) return json(200, result);
                return;
              } catch (error) {
                if (attempt || !getReadContext || !readContext || error.code !== 'event_log_checkpoint_advanced') throw error;
                if (res.destroyed || res.writableEnded || !stillAuthorized()) return;
                // A same-database forward-checkpoint hint gets one fresh verified
                // lease; the hint itself supplies no source or lineage proof.
                const previous = readContext.store?.expectedCheckpoint;
                readContext.release(); readContext = null;
                readContext = await getReadContext();
                if (res.destroyed || res.writableEnded || !stillAuthorized()) return;
                const next = readContext?.store?.expectedCheckpoint;
                if (!previous || !next || next.databaseId !== previous.databaseId || next.sequence <= previous.sequence) throw error;
              }
            }
          } finally { res.removeListener('close', cancel); }
        }
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
        if (/^\/api\/(?:recording-overview|energy-audits)(?:\?|$)/.test(req.url))
          return json(error instanceof TypeError || error instanceof SyntaxError ? 400 : 503, {
            code: 'recorded_data_unavailable',
            error: 'Recorded data could not be inspected. Refresh the panel to retry.' });
        if (/^\/api\/recording-backups(?:[/?]|$)/.test(req.url)) {
          if (res.headersSent) { res.destroy(); return; }
          return json(error.statusCode ?? (error instanceof SyntaxError ? 400 : 503), {
            code: /^backup_[a-z_]+$/.test(error.code ?? '') ? error.code : 'backup_inspection_unavailable',
            error: 'The saved copy or backup list is unavailable. Refresh the list and retry.' });
        }
        if (/^\/api\/model-reconstruction(?:\/action)?(?:\?|$)/.test(req.url))
          return json(error.statusCode ?? (error instanceof TypeError || error instanceof SyntaxError ? 400 : 503), {
            code: /^model_reconstruction_[a-z_]+$/.test(error.code ?? '') ? error.code : 'model_reconstruction_unavailable',
            error: 'Model reconstruction is unavailable or the request is invalid. Refresh its status before retrying.' });
        if (/^\/api\/database-verification(?:\?|$)/.test(req.url))
          return json(error.statusCode ?? (error instanceof SyntaxError ? 400 : 503),
            error.code === 'full_verification_unavailable'
              ? { code: error.code, error: 'Verification cannot start until a current database is available.' }
              : error.code === 'full_verification_busy'
                ? { code: error.code, error: 'Another database check is still running. Wait for it to finish, then retry.' }
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
        if (/^\/api\/web-access(?:\?|$)/.test(req.url) && error.code === 'https_manager_busy')
          return json(409, { code: 'https_manager_busy',
            error: 'Web access maintenance is running. Wait for it to finish, then retry.' });
        if (/^\/api\/web-access(?:\?|$)/.test(req.url))
          return json(error.statusCode ?? (error instanceof SyntaxError ? 400 : 503), {
            error: typeof error.publicMessage === 'string' ? error.publicMessage
              : 'Web access could not be updated. Refresh its status before retrying.' });
        if (Object.hasOwn(EQUIPMENT_COMMAND_ERRORS, error?.code))
          return json(409, { code: error.code, error: EQUIPMENT_COMMAND_ERRORS[error.code] });
        if (req.method === 'POST' && /^\/api\/equipment\/floor(?:\?|$)/.test(req.url)) {
          if (Object.hasOwn(FLOOR_COMMAND_ERRORS, error?.code))
            return json(error.code === 'FLOOR_COMMAND' ? 400 : 409, { code: error.code, error: FLOOR_COMMAND_ERRORS[error.code] });
          return json(error instanceof TypeError || error instanceof SyntaxError ? 400 : error.statusCode ?? 503,
            { error: error instanceof TypeError || error instanceof SyntaxError
              ? 'Choose a floor circuit, a bounded override time and its current control scope.'
              : 'The floor request could not be confirmed. Check the reported outputs before trying again.' });
        }
        if (req.method === 'GET' && /^\/api\/(?:status|recording-health)(?:\?|$)/.test(req.url)
          && error instanceof ReplicaCheckpointMismatchError) {
          reportReplicaReadRefusal(error, /^\/api\/status(?:\?|$)/.test(req.url) ? 'status' : 'recording-health');
          return json(503, REPLICA_CHECKPOINT_MISMATCH);
        }
        if (req.method === 'GET' && /^\/api\/events(?:\?|$)/.test(req.url)) {
          const code = ['event_log_query_invalid', 'event_log_context_changed', 'event_log_checkpoint_advanced'].includes(error?.code) ? error.code : 'event_log_unavailable';
          return json(code === 'event_log_query_invalid' ? 400 : code === 'event_log_context_changed' ? 409 : 503,
            { code, error: code === 'event_log_query_invalid' ? 'Choose supported event filters and a valid history page.'
              : code === 'event_log_context_changed' ? 'The recorded history changed. Refresh the event log before loading older entries.'
                : code === 'event_log_checkpoint_advanced' ? 'The event-log checkpoint is ahead of its requested snapshot. Previously fetched entries remain available; refresh to try again.'
                : 'The event log could not be refreshed. Previously fetched entries remain available.' });
        }
        const fireplaceWrite = req.method === 'POST' && /^\/api\/(?:fireplace(?:\/remove)?|sensor-changes(?:\/(?:revert|retry-rebuild))?)(?:\?|$)/.test(req.url);
        const code = error.statusCode ?? (fireplaceWrite && !(error instanceof TypeError || error instanceof SyntaxError) ? 503 : 400);
        json(code, { error: code >= 500 ? 'Request could not be confirmed. Retry shortly.'
          : error instanceof SyntaxError && /^\/api\/settings\//.test(req.url) ? 'The request must contain valid JSON.' : error.message });
      }
    } finally { try { readContext?.release?.(); } finally { releaseRequest?.(); } }
  };
  const { bodyTimeoutMs: _bodyTimeoutMs, ...limits } = transportLimits ?? {};
  const server = tls ? createHttpsServer({ ...limits, ...tls }, handler) : createServer(limits, handler);
  if (overviewService && overviewService !== chartService) server.once('close', () => { void overviewService.close(); });
  if (ownInspection) server.once('close', () => { void backupInspection.close(); });
  server.once('close', () => { void eventLogService?.close(); });
  return server;
}
