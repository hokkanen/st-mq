import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, extname } from 'node:path';
import { getChartData } from './chart-data.js';
import { simulatedOutlook } from './simulator.js';
import { createChartService } from './chart-service.js';
import { chargingSessionCheckSummaries } from './charging-session-checks.js';
import { propertyEnergyCheckSummary } from './property-energy-checks.js';
import { createDatabaseExport } from './database-export.js';
import { familyRouteAllowed, familyActionAllowed, fireplaceAccess, FAMILY_FIREWOOD_REMOVAL_MS } from './web-permissions.js';

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
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 8192) throw Object.assign(new Error('Request too large'), { statusCode: 400 });
  }
  return JSON.parse(data);
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

export function createAppServer({ engine, getEngine = () => engine, store, chartService, token = '', familyToken = '',
  getAccess, ingress = false, role = 'master', topology = 'standalone', getReadContext, syncStatus,
  pairContext, controlAuthority, getDatabaseExportDirectory = homedir,
  reloadSettings, settingsReloadStatus = () => ({ available: false, busy: false,
    reason: 'This instance has no reloadable configuration source.' }), staticDir = resolve('dist') }) {
  const overviewService = getReadContext ? null : chartService?.overview ? chartService : createChartService({ store });
  if (typeof familyToken !== 'string' || familyToken && (!token || token === familyToken))
    throw new Error('Family access requires a separate admin web token.');
  const fixedAccess = { enabled: true, token, familyToken, tokenRequired: false };
  const access = getAccess ?? (() => fixedAccess);
  const exportDatabase = createDatabaseExport({ getDirectory: getDatabaseExportDirectory });
  const writesBlocked = () => role === 'slave' || Boolean(pairContext && !pairContext.canControl())
    || Boolean(controlAuthority && !controlAuthority.canControl());
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
          '/api/downloads/floor-lease-script': ['../../scripts/shelly/floor-lease.js', 'floor-lease.js', 'text/javascript'],
        };
        if (req.method === 'GET' && downloads[url.pathname]) {
          const [source, filename, type] = downloads[url.pathname];
          const data = await readFile(new URL(source, import.meta.url));
          if (!stillAuthorized()) return;
          res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${filename}"`,
            'cache-control': 'no-store', 'content-length': data.length });
          return res.end(data);
        }
        if (url.pathname === '/api/pair' && req.method === 'GET')
          return json(200, pairContext?.status() ?? null);
        if (url.pathname === '/api/pair/action' && req.method === 'POST') {
          if (!pairContext) return json(409, { error: 'Paired operation is not configured.' });
          const input = await body(req);
          if (!stillAuthorized()) return;
          if (settingsReloadStatus().stopping) return json(503, { error: 'The application is shutting down.' });
          return json(202, pairContext.requestAction(input));
        }
        const saveDatabase = req.method === 'POST' && url.pathname === '/api/database-export';
        // Pair management above is the sole write exception on a standby. Even
        // saving a new database file on this host requires the active master;
        // downloading existing history remains available through GET.
        if (writesBlocked() && !['GET', 'HEAD'].includes(req.method))
          return json(role === 'slave' ? 405 : 409, { error: readOnlyMessage });
        const unavailable = () => {
          const state = settingsReloadStatus();
          if (state.unavailable) return state.reason;
          return state.busy ? 'Settings are being updated. Retry shortly.' : null;
        };
        if (unavailable()) return json(503, { error: unavailable() });
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
            || pairContext && (!pairContext.canControl() || pairContext.recovering());
          return readOnly ? { ...view, available: false, readOnly: true, canRetryRebuild: false,
            events: view.events.map(event => ({ ...event, canRevert: false })) } : view;
        };
        const fireplaceStatus = (view, now) => fireplaceAccess(writesBlocked() || pairContext?.recovering()
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
          if (pairContext?.recovering() && ['/api/fireplace', '/api/fireplace/remove', '/api/sensor-changes',
            '/api/sensor-changes/revert', '/api/sensor-changes/retry-rebuild', '/api/settings/reload', '/api/charging/ocpp-setup'].includes(url.pathname))
            return json(409, { error: 'Historical recovery is running. Wait before changing source corrections or configuration.' });
          const current = getEngine();
          if (webAccess.role === 'family' && !familyActionAllowed(url.pathname, input, current))
            return json(403, { error: 'Admin access is required for this action.' });
          return action(current, input);
        };
        if (req.method === 'GET' && url.pathname === '/api/status') return json(200, status());
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
          return await mutate((current, input) => {
            if (!current.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
            return json(200, current.heatingExplorer.apply(input));
          });
        if (req.method === 'POST' && url.pathname === '/api/heating/explorer/cancel')
          return await mutate((current, input) => {
            if (!current.heatingExplorer) return json(503, { error: 'Heating plan exploration is unavailable on this instance.' });
            return json(200, current.heatingExplorer.cancel(input));
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
            return json(503, { error: 'Could not save the database copy. Check that the configured export folder is writable and has enough free space.' });
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
          return await mutate((current, input) => json(200, current.changeSensor(input)));
        if (req.method === 'POST' && url.pathname === '/api/sensor-changes/revert')
          return await mutate((current, input) => json(200, current.revertSensor(input)));
        if (req.method === 'POST' && url.pathname === '/api/sensor-changes/retry-rebuild')
          return await mutate((current, input) => json(200, current.retrySensorRebuild(input)));
        if (req.method === 'POST' && url.pathname === '/api/fireplace')
          return await mutate((current, input) => json(200, fireplaceAccess(current.changeFireplace(input), webAccess, current.clock())));
        if (req.method === 'POST' && url.pathname === '/api/fireplace/remove')
          return await mutate((current, input) => json(200, fireplaceAccess(current.changeFireplace(input, true,
            webAccess.role === 'family' ? { maxAgeMs: FAMILY_FIREWOOD_REMOVAL_MS } : {}), webAccess, current.clock())));
        if (req.method === 'POST' && url.pathname === '/api/settings/reload') {
          return await mutate(async (_engine, input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
              throw new Error('Apply configuration reads saved settings; send an empty JSON object.');
            if (!reloadSettings) return json(409, { error: settingsReloadStatus().reason });
            completingReload = true;
            await reloadSettings();
            return json(200, status());
          });
        }
        if (req.method === 'POST' && url.pathname === '/api/automation')
          return await mutate(async (current, input) => { await current.setAutomation(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/charging/settings')
          return await mutate(async (current, input) => { await current.charging.setSettings(input); return json(200, status()); });
        const chargingTestAction = url.pathname.match(/^\/api\/charging\/tests\/(preview|start|schedule|cancel)$/);
        if (req.method === 'POST' && chargingTestAction)
          return await mutate((current, input) => {
            if (pairContext?.recovering()) return json(409, { error: 'Wait for recovery to finish before changing a charging assessment.' });
            const result = current.charging.chargingTestAction(chargingTestAction[1], input);
            return json(200, chargingTestAction[1] === 'preview' ? result : status());
          });
        const chargerAction = url.pathname.match(/^\/api\/charging\/chargers\/([^/]+)\/(settings|control|resume|charge-now|identify)$/);
        if (req.method === 'POST' && chargerAction)
          return await mutate(async (current, input) => {
            const [, id, action] = chargerAction;
            const method = { settings: 'setChargerSettings', control: 'setControl', resume: 'resume', 'charge-now': 'chargeNow', identify: 'identifyVehicle' }[action];
            await current.charging[method](id, input); return json(200, status());
          });
        if (req.method === 'POST' && url.pathname === '/api/garage/heating')
          return await mutate(async (current, input) => { await current.garage.setHeating(input); return json(200, status()); });
        if (req.method === 'POST' && url.pathname === '/api/garage/protection')
          return await mutate(async (current, input) => { await current.garage.setProtection(input); return json(200, status()); });
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
          return json(200, [propertyEnergyCheckSummary(readerStore,{now:engine.clock()}), ...chargingSessionCheckSummaries(readerStore)]);
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
          const cancellation = new AbortController();
          const cancel = () => cancellation.abort();
          res.once('close', cancel);
          try {
            const result = readerCharts ? await readerCharts.query(args, { signal: cancellation.signal }) : getChartData({ store: readerStore, ...args });
            if (!res.destroyed) return json(200, result);
          } finally { res.removeListener('close', cancel); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/contract') return json(200, engine.contract());
        if (req.method === 'POST' && ['/api/contract', '/api/settings'].includes(url.pathname)) return json(405, { error: 'Permanent settings and electricity rates come from configuration. Use Apply configuration after editing them.' });
        if (req.method === 'POST' && url.pathname === '/api/temporary') return await mutate((current, input) => {
          const result = current.setTemporary(input);
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
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(path)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'cache-control': name.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        json(404, { error: 'UI build not found. Run npm run build.' });
      }
    } catch (error) {
      if (!res.destroyed) {
        const fireplaceWrite = req.method === 'POST' && /^\/api\/(?:fireplace(?:\/remove)?|sensor-changes(?:\/(?:revert|retry-rebuild))?)(?:\?|$)/.test(req.url);
        const code = error.statusCode ?? (fireplaceWrite && !(error instanceof TypeError || error instanceof SyntaxError) ? 503 : 400);
        json(code, { error: code >= 500 ? 'Request could not be confirmed. Retry shortly.' : error.message });
      }
    } finally { readContext?.release?.(); }
  });
  if (overviewService && overviewService !== chartService) server.once('close', () => { void overviewService.close(); });
  return server;
}
