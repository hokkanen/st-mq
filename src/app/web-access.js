import { createAppServer } from './server.js';
import { createRecordingHealth } from './recording-health.js';
import { createDatabaseExport } from './database-export.js';
import { createDatabaseVerification } from './database-verification.js';
import { createBackupCatalog } from '../storage/backup-catalog.js';
import { backupDirectory } from '../storage/backup-directory.js';
import { createWebSessions } from './web-sessions.js';
import { createBackupInspection } from './backup-inspection.js';
import { createModelReconstruction } from './model-reconstruction.js';
import { resolve } from 'node:path';

import { createHttpsManager } from '../https/manager.js';
import { X509Certificate, randomBytes, createHash } from 'node:crypto';
import { connect as tlsConnect, createSecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';

const loopback = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
export const LAN_HTTP_WARNING = 'Unencrypted LAN access exposes passwords and household data to interception or modification.';
const webSettings = config => ({ httpsHost: '0.0.0.0', httpsPort: 8443,
  lanHttpEnabled: false, lanHttpHost: '0.0.0.0', lanHttpPort: 1236, lanResolver: '', ...config.web });
const TRANSPORT_LIMITS = Object.freeze({ requestTimeout: 3600000, bodyTimeoutMs: 15000, headersTimeout: 10000, connectionsCheckingInterval: 1000 });
const MAX_CONNECTIONS = 128;
const networkCredentials = config => config.token?.length >= 24 && (!config.familyToken || config.familyToken.length >= 24);

function validate(config) {
  if (!loopback(config.host)) throw new Error('STMQ_HOST must be loopback for recovery. Use web.lan_http_enabled for explicitly unencrypted LAN access.');
  if (typeof config.token !== 'string') throw new Error('Web access token must be text.');
  const family = config.familyToken === undefined ? '' : config.familyToken;
  if (typeof family !== 'string') throw new Error('Family web access token must be text.');
  if (family && !config.token) throw new Error('Family access requires an admin web token.');
  if (family && family === config.token) throw new Error('Admin and family web tokens must be different.');
  if ((config.addon || webSettings(config).lanHttpEnabled) && family && family.length < 24)
    throw new Error('Family network access requires a web token with at least 24 characters.');
  if ((config.addon || webSettings(config).lanHttpEnabled) && config.token && config.token.length < 24)
    throw new Error('Network access requires a web token with at least 24 characters.');
  if (webSettings(config).lanHttpEnabled && !networkCredentials(config))
    throw new Error('LAN HTTP access requires a web token with at least 24 characters.');
  const settings = webSettings(config);
  for (const name of ['httpsHost', 'lanHttpHost'])
    if (isIP(settings[name]) !== 4) throw new Error('HTTPS and LAN HTTP listening addresses must be IPv4.');
  for (const name of ['httpsPort', 'lanHttpPort'])
    if (!Number.isInteger(settings[name]) || settings[name] < 0 || settings[name] > 65535) throw new Error('Invalid web listener port.');
}

async function listen(server, port, host, setting = 'STMQ_PORT') {
  await new Promise((resolve, reject) => {
    const failed = error => {
      server.removeListener('listening', ready);
      if (error.code === 'EADDRINUSE') {
        const listenHost = error.address ?? host ?? '::';
        const address = listenHost.includes(':') ? `[${listenHost}]:${port}` : `${listenHost}:${port}`;
        error.message = `ST-MQ cannot listen on ${address} (EADDRINUSE): the port is already in use. `
          + 'Check the existing ST-MQ process or service and stop it before restarting. '
          + `If another application owns the port, configure ${setting}. See docs/startup.md.`;
      }
      reject(error);
    };
    const ready = () => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, host);
  });
}

/** Recovery reserves its port before controller initialization. Optional network
 * listeners and certificate enrollment never own controller availability. Every
 * listener shares the application handler, authorization and read-only fencing.
 */
export function createWebAccess({ config: initialConfig, httpsManagerFactory = createHttpsManager, ...serverOptions }) {
  validate(initialConfig);
  let config = initialConfig, ingressServer, recovery, lanHttp, https, certificate,
    started = false, closed = false, pending, httpsError = null, lanHttpError = null, managerError = null;
  let certificatePending = Promise.resolve();
  const sessions = createWebSessions({ store: serverOptions.store,
    getAccess: () => ({ token: config.token, familyToken: config.familyToken ?? '' }),
    writable: () => serverOptions.role !== 'slave' && (!serverOptions.pairContext || serverOptions.pairContext.canControl()),
    peer: serverOptions.pairContext?.webSessions, clock: serverOptions.clock ?? Date.now });
  serverOptions.webSessions = sessions;
  const backupConfig = () => ({ ...config, recording: { ...config.recording,
    backupDirectory: serverOptions.getDatabaseExportDirectory?.() ?? backupDirectory(config) } });
  serverOptions.backupCatalog ??= createBackupCatalog({ getConfig: backupConfig, clock: serverOptions.clock ?? Date.now });
  serverOptions.recordingHealth ??= createRecordingHealth({
    clock: serverOptions.clock ?? Date.now, getConfig: backupConfig, backupCatalog: serverOptions.backupCatalog,
    getBackupChecks: copies => serverOptions.backupInspection?.health(copies),
  });
  serverOptions.databaseExport ??= createDatabaseExport({
    getDirectory: () => backupDirectory(backupConfig()),
    onBackupEvent: (event, store) => serverOptions.recordingHealth.backupEvent(event, store),
  });
  serverOptions.backupInspection ??= createBackupInspection({ catalog: serverOptions.backupCatalog,
    clock: serverOptions.clock ?? Date.now,
    onDownloadEvent: event => serverOptions.recordingHealth.backupEvent(event, serverOptions.store) });
  serverOptions.databaseVerification ??= createDatabaseVerification({
    clock: serverOptions.clock ?? Date.now,
    getIntervalMs: () => config.recording?.fullVerificationIntervalMs ?? 0,
    available: () => !closed && !serverOptions.settingsReloadStatus?.().busy && !serverOptions.settingsReloadStatus?.().unavailable,
    acquire: async () => {
      const context = await serverOptions.getReadContext?.();
      const store = context ? context.store : serverOptions.store;
      return { dbPath: store?.path, store, release: context?.release };
    },
  });
  if (config.dataDir) serverOptions.modelReconstruction ??= createModelReconstruction({
    directory: resolve(config.dataDir, 'temporary-model-verification'), clock: serverOptions.clock ?? Date.now,
    protectedPaths: [config.dbPath, serverOptions.store?.path],
    available: () => !closed && !serverOptions.settingsReloadStatus?.().busy && !serverOptions.settingsReloadStatus?.().unavailable,
    acquire: async () => {
      const context = await serverOptions.getReadContext?.();
      const store = context ? context.store : serverOptions.store;
      return { dbPath: store?.path, store, input: context?.engine.config.input ?? serverOptions.getEngine?.()?.config.input ?? config.input,
        checkpoint: context?.checkpoint ?? store?.expectedCheckpoint, snapshotAt: context?.snapshotAt, fileGeneration: context?.fileGeneration,
        role: serverOptions.role ?? config.role, release: context?.release };
    },
  });
  const draining = new Map();
  const rawSockets = new WeakMap();
  const ingressAccess = { enabled: true, token: '', tokenRequired: false };
  const binding = candidate => [candidate.addon, candidate.host, candidate.port,
    candidate.ingressHost ?? '0.0.0.0', candidate.ingressPort ?? 8099, webSettings(candidate)];
  const authentication = (network = false, hostname) => ({ enabled: true, token: config.token,
    familyToken: config.familyToken ?? '', tokenRequired: Boolean(network || config.addon || config.token),
    ...(hostname ? { hostname } : {}) });

  function forceConnectionsClosed(server) {
    // HTTPS closeAllConnections omits sockets that have not finished TLS. Own
    // the accepted TCP sockets too so expiry/shutdown cannot wait for a client.
    server.closeAllConnections();
    for (const socket of rawSockets.get(server) ?? []) socket.destroy();
  }
  function trackConnections(server, record, name) {
    const sockets = new Set();
    rawSockets.set(server, sockets);
    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (closed || draining.has(server)) socket.destroy();
    });
    if (name === 'https') server.on('tlsClientError', (_error, socket) => socket.destroy());
    if (['https', 'lanHttp'].includes(name)) server.on('error', () => {
      // Initial binding errors are still rejected by listen(); optional runtime
      // errors revoke only that listener and cannot become uncaught exceptions.
      if (!server.listening) return;
      record.state = { enabled: false, token: '', tokenRequired: true };
      if (name === 'https') { httpsError = 'tls_listener_failed'; if (https === record) https = null; }
      else { lanHttpError = 'http_listener_failed'; if (lanHttp === record) lanHttp = null; }
      void drain(server, true);
    });
  }
  function drain(server, force = false) {
    if (!server) return Promise.resolve();
    if (draining.has(server)) {
      if (force) forceConnectionsClosed(server);
      return draining.get(server);
    }
    if (!server.listening) {
      if (force) forceConnectionsClosed(server);
      return Promise.resolve();
    }
    const finished = new Promise(resolve => server.close(resolve));
    draining.set(server, finished);
    const timeout = setTimeout(() => forceConnectionsClosed(server), 5000);
    timeout.unref();
    server.closeIdleConnections();
    if (force) forceConnectionsClosed(server);
    void finished.finally(() => { clearTimeout(timeout); draining.delete(server); });
    return finished;
  }
  function listener(state, tls, name = 'recovery') {
    const record = { state };
    record.server = createAppServer({ ...serverOptions, ingress: false, tls,
      transportLimits: TRANSPORT_LIMITS, getAccess: () => record.state, webTransport });
    trackConnections(record.server, record, name);
    return record;
  }
  function revoke(record) {
    if (!record) return;
    record.state = { enabled: false, token: '', tokenRequired: true };
    void drain(record.server);
  }
  function status() {
    const view = record => ({ enabled: Boolean(record?.state.enabled && record.server.listening),
      listening: Boolean(record?.server.listening),
      address: record?.server.address() ?? null, tokenRequired: Boolean(record?.state.tokenRequired) });
    return {
      ingress: { enabled: Boolean(ingressServer?.listening), listening: Boolean(ingressServer?.listening), address: ingressServer?.address() ?? null },
      recovery: { ...view(recovery), secure: false, loopbackOnly: true },
      https: { ...view(https), secure: true, error: httpsError,
        hostname: certificate?.hostname ?? null, fingerprint: certificate?.fingerprint ?? null },
      lanHttp: { ...view(lanHttp), configured: webSettings(config).lanHttpEnabled, secure: false,
        error: lanHttpError, warning: webSettings(config).lanHttpEnabled ? LAN_HTTP_WARNING : null },
    };
  }
  const webTransport = {
    status({ admin = true } = {}) {
      let managed;
      try { managed = manager?.status({ admin }); } catch { managerError = 'https_management_unavailable'; }
      managed ??= { enabled: false, phase: 'unavailable' };
      if (!admin) return { enabled: Boolean(managed.enabled), phase: managed.phase ?? 'unavailable',
        certificate: certificate ? { expiresAt: certificate.expiresAt } : null,
        secure: Boolean(https?.server.listening), warning: status().lanHttp.warning };
      return { ...managed, transport: status(), ...(managerError ? { managementError: managerError } : {}) };
    },
    async action(input) {
      if (closed) throw Object.assign(new Error('Web access is closing.'), { statusCode: 503 });
      if (!manager) throw Object.assign(new Error('HTTPS management unavailable.'), { statusCode: 503 });
      if (input?.action === 'enable' && !networkCredentials(config))
        throw Object.assign(new Error('Set network credentials first.'), { statusCode: 409,
          publicMessage: 'Configure an admin password and any family password with at least 24 characters before enabling HTTPS.' });
      return manager.action(input);
    },
  };
  let manager;
  try {
    manager = httpsManagerFactory({ getConfig: () => config,
      onCertificate: material => installCertificate(material), onDisable: () => installCertificate(null),
      pair: serverOptions.pairContext?.webCertificates,
      clock: serverOptions.clock ?? Date.now });
  } catch { managerError = 'https_management_unavailable'; }

  async function probe(record, material) {
    await new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: webSettings(config).httpsHost === '0.0.0.0' ? '127.0.0.1' : webSettings(config).httpsHost,
        port: record.server.address().port, servername: material.hostname,
        rejectUnauthorized: false, minVersion: 'TLSv1.2' });
      const timeout = setTimeout(() => socket.destroy(new Error('TLS confirmation timed out.')), 1500);
      socket.once('error', reject);
      socket.once('secureConnect', () => {
        try {
          const served = new X509Certificate(socket.getPeerCertificate(true).raw);
          if (createHash('sha256').update(served.raw).digest('hex') !== material.fingerprint) throw new Error('TLS certificate confirmation failed.');
          resolve();
        } catch (error) { reject(error); }
        finally { socket.destroy(); }
      });
      socket.once('close', () => clearTimeout(timeout));
    });
  }
  async function replaceCertificate(input) {
    if (closed || !started) return { listening: false, error: 'https_not_running' };
    if (!input) {
      const previous = https;
      https = null; certificate = null; httpsError = null;
      revoke(previous);
      await drain(previous?.server, true);
      return { listening: false, disabled: true };
    }
    if (!networkCredentials(config)) {
      httpsError = 'credentials_required';
      revoke(https); https = null;
      return { listening: false, error: httpsError };
    }
    let material, candidate;
    const previousMaterial = certificate;
    try {
      const values = input.certificate ?? input;
      const hostname = input.hostname ?? values.hostname;
      const x509 = new X509Certificate(values.cert);
      if (typeof hostname !== 'string' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname)
        || x509.checkHost(hostname, { wildcards: false }) !== hostname
        || Date.parse(x509.validFrom) > Date.now() || Date.parse(x509.validTo) <= Date.now())
        throw new Error('Invalid certificate hostname or validity.');
      material = { key: values.key, cert: values.cert, hostname, generation: input.generation,
        fingerprint: createHash('sha256').update(x509.raw).digest('hex'), expiresAt: Date.parse(x509.validTo) };
      createSecureContext({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' });
      if (https) {
        https.server.setSecureContext({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' });
        https.server.setTicketKeys(randomBytes(48));
        const active = https;
        await probe(active, material);
        if (closed || https !== active || !networkCredentials(config))
          throw Object.assign(new Error('Certificate activation was superseded.'), { code: 'credentials_required' });
        if (https.state.hostname !== hostname) https.state = authentication(true, hostname);
      } else {
        candidate = listener(authentication(true, hostname), { key: material.key, cert: material.cert,
          minVersion: 'TLSv1.2', handshakeTimeout: 5000 }, 'https');
        await listen(candidate.server, webSettings(config).httpsPort, webSettings(config).httpsHost, 'web.https_port');
        await probe(candidate, material);
        if (closed || !networkCredentials(config)) {
          await drain(candidate.server, true);
          return { listening: false, error: closed ? 'https_not_running' : 'credentials_required' };
        }
        candidate.state = authentication(true, hostname);
        https = candidate;
      }
      certificate = material;
      httpsError = null;
      return { listening: true, address: https.server.address(), fingerprint: material.fingerprint };
    } catch (error) {
      if (candidate) await drain(candidate.server, true);
      if (https && previousMaterial) https.server.setSecureContext({ key: previousMaterial.key, cert: previousMaterial.cert,
        minVersion: 'TLSv1.2' });
      httpsError = error.code === 'EADDRINUSE' ? 'tls_port_unavailable'
        : error.code === 'credentials_required' ? 'credentials_required' : 'invalid_certificate';
      return { listening: false, error: httpsError };
    }
  }
  function installCertificate(material) {
    const operation = certificatePending.then(() => replaceCertificate(material));
    certificatePending = operation.catch(() => {});
    return operation;
  }
  async function configureOptional() {
    if (webSettings(config).lanHttpEnabled && networkCredentials(config)) {
      if (!lanHttp) {
        const candidate = listener(authentication(true), undefined, 'lanHttp');
        try {
          await listen(candidate.server, webSettings(config).lanHttpPort, webSettings(config).lanHttpHost, 'web.lan_http_port');
          lanHttp = candidate; lanHttpError = null;
        } catch { await drain(candidate.server, true); lanHttpError = 'http_port_unavailable'; }
      }
    } else { revoke(lanHttp); lanHttp = null; lanHttpError = null; }
    if (!networkCredentials(config) && https) { revoke(https); https = null; httpsError = 'credentials_required'; }
  }
  async function prepare(next) {
    if (!started || closed) throw new Error('Web access is not running.');
    if (pending) throw new Error('Web access is already being updated.');
    validate(next);
    if (!isDeepStrictEqual(binding(config), binding(next))) throw new Error('Network bindings changed. Restart to apply these changes.');
    const reservation = {};
    pending = reservation;
    let finished = false;
    return {
      async commit() {
        if (finished || closed || pending !== reservation) throw new Error('Web access update is no longer available.');
        await sessions.credentialsChanged({ token: next.token, familyToken: next.familyToken ?? '' });
        config = next;
        for (const [record, network] of [[recovery, false], [lanHttp, true], [https, true]])
          if (record && (record.state.token !== config.token || record.state.familyToken !== (config.familyToken ?? '')))
            record.state = authentication(network, record.state.hostname);
        await configureOptional();
        try { await manager?.configure(config); } catch { managerError = 'https_management_unavailable'; }
        serverOptions.databaseVerification.configure();
        finished = true; pending = null;
      },
      async rollback() { if (!finished) { finished = true; if (pending === reservation) pending = null; } },
    };
  }
  return {
    get server() { return recovery?.server; },
    get ingressServer() { return ingressServer; },
    get httpsServer() { return https?.server; },
    get lanHttpServer() { return lanHttp?.server; },
    get httpsManager() { return manager; },
    status, installCertificate, sessions,
    async start() {
      if (closed) throw new Error('Web access has been closed.');
      if (started) return;
      started = true;
      try {
        // Optional remembered access cannot prevent controller/recovery startup.
        // Invalid or unwritable state still fails closed when that login is used.
        await sessions.credentialsChanged({ token: config.token, familyToken: config.familyToken ?? '' }).catch(() => {});
        recovery = listener(authentication());
        await listen(recovery.server, config.port, config.host);
        if (config.addon) {
          ingressServer = createAppServer({ ...serverOptions, ingress: true,
            getAccess: () => ingressAccess, transportLimits: TRANSPORT_LIMITS, webTransport });
          trackConnections(ingressServer, null, 'ingress');
          await listen(ingressServer, config.ingressPort ?? 8099, config.ingressHost ?? '0.0.0.0', 'STMQ_INGRESS_PORT');
        }
        await configureOptional();
        serverOptions.databaseVerification.enable();
        serverOptions.modelReconstruction?.enable();
        try { Promise.resolve(manager?.start()).catch(() => { managerError = 'https_management_unavailable'; }); }
        catch { managerError = 'https_management_unavailable'; }
      } catch (error) {
        await Promise.all([drain(recovery?.server, true), drain(ingressServer, true)]);
        started = false;
        throw error;
      }
    },
    prepare,
    async apply(next) { const transaction = await prepare(next); try { await transaction.commit(); } catch (error) { await transaction.rollback(); throw error; } },
    async close() {
      if (closed) return;
      closed = true; ingressAccess.enabled = false;
      for (const record of [recovery, lanHttp, https]) if (record) record.state = { enabled: false, token: '', tokenRequired: true };
      try { await manager?.close(); } catch { /* HTTPS cleanup cannot prevent controller cleanup. */ }
      await certificatePending;
      await serverOptions.databaseVerification.close();
      await serverOptions.modelReconstruction?.close();
      await serverOptions.backupInspection.close();
      await Promise.all([...new Set([ingressServer, recovery?.server, lanHttp?.server, https?.server, ...draining.keys()])]
        .filter(Boolean).map(server => drain(server, true)));
    },
  };
}
