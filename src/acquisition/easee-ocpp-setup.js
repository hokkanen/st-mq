import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localOcppConfiguration } from './easee-ocpp.js';
import { detectLocalOcppAddress } from './local-ocpp-address.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const RECOVERY_GRACE_MS = 5 * 60_000;
const RECOVERY_RETRY_MS = [15 * 60_000, 60 * 60_000];
const MAX_RECOVERY_ATTEMPTS = 3;
const fail = (reason, statusCode = 409) => Object.assign(new Error(reason), { code: reason, statusCode });
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const version = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);

/** Secrets remain in private configuration/credential files. Paired installations
 * derive the same purpose-specific password without transferring it in history. */
export function ocppInstallation(config, { createCredential = false, detectAddress = detectLocalOcppAddress } = {}) {
  const easee = config.connections?.easee ?? {};
  const local = localOcppConfiguration(easee.local_ocpp);
  const identity = local.charge_point_id || easee.charger_id || '';
  const scope = digest([easee.charger_id ?? '', identity]);
  const paired = config.topology === 'pair';
  const virtualEndpoint = paired ? `ws://${config.pair.vip.address}:${local.port}/ocpp` : '';
  if (paired && (local.server_url && local.server_url !== virtualEndpoint
    || !['0.0.0.0', config.pair.vip.address].includes(local.host)))
    throw fail('Paired OCPP must listen on the shared virtual IPv4 address or all IPv4 interfaces and use the virtual address endpoint.');
  // Resolve once per provider lifetime. Applying configuration or restarting
  // redetects the address; a route change must not reprogram a charger mid-poll.
  const detectedAddress = !paired && !local.server_url ? detectAddress({ host: local.host }) : '';
  const endpoint = paired ? virtualEndpoint : local.server_url
    || (detectedAddress ? new URL(`ws://${detectedAddress}:${local.port}/ocpp`).href : '');
  let password = local.password;
  if (!password && paired) password = Buffer.from(hkdfSync('sha256', config.pair.token,
    scope, 'st-mq:easee-native-ocpp:basic-auth:v1', 15)).toString('base64url');
  if (!password && createCredential && easee.charger_id) {
    const path = join(config.dataDir, 'easee-ocpp-credentials.json');
    let saved;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || (info.mode & 0o077)) throw fail('credentials-unavailable');
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw fail('credentials-unavailable'); }
    if (saved !== undefined) {
      if (!fields(saved, ['version', 'scope', 'password']) || saved.version !== 1 || saved.scope !== scope
        || typeof saved.password !== 'string' || saved.password.length !== 20) throw fail('credentials-unavailable');
      password = saved.password;
    } else if (local.enabled && endpoint) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      password = randomBytes(15).toString('base64url');
      let fd;
      try {
        fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ version: 1, scope, password })); fsyncSync(fd);
      } catch { throw fail('credentials-unavailable'); }
      finally { if (fd !== undefined) closeSync(fd); }
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
  const virtualTag = password ? Buffer.from(hkdfSync('sha256', password, scope,
    'st-mq:easee-native-ocpp:virtual-tag:v1', 12)).toString('hex').slice(0, 20) : '';
  return { ...local, password, virtualTag, endpoint, identity, chargerId: easee.charger_id ?? '', scope,
    endpointSource: endpoint ? paired ? 'pair-vip' : local.server_url ? 'configured' : 'detected' : null };
}

function validState(value, scope) {
  return fields(value, ['version', 'scope', 'ownedFingerprint', 'appliedFingerprint', 'adoptionFingerprint',
    'intent', 'lastAppliedAt', 'lastSuccessAt', 'nextAttemptAt', 'failures', 'recovery']) && value.version === 1 && value.scope === scope
    && ['ownedFingerprint', 'appliedFingerprint', 'adoptionFingerprint'].every(key => value[key] === null || HASH.test(value[key]))
    && ['lastAppliedAt', 'lastSuccessAt', 'nextAttemptAt'].every(key => value[key] === null || Number.isSafeInteger(value[key]) && value[key] >= 0)
    && Number.isInteger(value.failures) && value.failures >= 0 && value.failures <= 10
    // Absent new state means no recovery has been attempted, not an old format.
    && (value.recovery === undefined || value.recovery === null || fields(value.recovery, ['attempts', 'lastAttemptAt'])
      && Number.isInteger(value.recovery.attempts) && value.recovery.attempts >= 1 && value.recovery.attempts <= MAX_RECOVERY_ATTEMPTS
      && Number.isSafeInteger(value.recovery.lastAttemptAt) && value.recovery.lastAttemptAt >= 0)
    && (value.intent === null || fields(value.intent, ['fingerprint', 'base', 'version']) && HASH.test(value.intent.fingerprint)
      && (value.intent.base === null || HASH.test(value.intent.base)) && (value.intent.version === null || version(value.intent.version)));
}

export function isOcppSetupState(value, scope) { return value == null || validState(value, scope); }

export function ocppHandoverRequirements(config, setupState = null, { restorationRequired = false } = {}) {
  const installation = ocppInstallation(config);
  if (setupState !== null && setupState !== undefined && !validState(setupState, installation.scope)) throw fail('ocpp-handover-incompatible');
  const needsListener = installation.enabled || restorationRequired || Boolean(setupState?.ownedFingerprint || setupState?.intent);
  if (!needsListener || !installation.chargerId) return null;
  if (config.topology !== 'pair' || !installation.endpoint || !installation.password) throw fail('ocpp-handover-incompatible');
  const compatibility = { enabled: installation.enabled, scope: installation.scope, endpoint: installation.endpoint,
    password: installation.password, port: installation.port,
    certificate: installation.ca_certificate, certificateDomain: installation.ca_certificate_domain,
    tags: [...installation.authorization_tags].sort(), authorizationMode: installation.authorization_mode };
  return { version: 1, digest: digest(compatibility) };
}

export function assertOcppHandoverReady(config, setupState, requirements) {
  // Preflight precedes transfer of the final setup journal. A disabled peer
  // still needs compatible listener settings for an incoming restoration duty.
  const expected = ocppHandoverRequirements(config, setupState, { restorationRequired: requirements !== null });
  if (requirements === null && expected === null) return;
  if (!fields(requirements, ['version', 'digest']) || requirements.version !== 1 || !HASH.test(requirements.digest)
    || expected?.digest !== requirements.digest) throw fail('ocpp-handover-incompatible');
}

/** Native OCPP's published ConnectionDetailsDto is a flat GET response, with
 * basicAuth {username,password}; it is not the POST request representation. */
export function ocppConnectionDetails(input) {
  if (!fields(input, ['version', 'connectivityMode', 'websocketConnectionArgs', 'basicAuth']) || !version(input.version)
    || !['OcppOff', 'DualProtocol'].includes(input.connectivityMode)
    || !fields(input.websocketConnectionArgs, ['url', 'caCertificate', 'caCertificateDomain'])
    || typeof input.websocketConnectionArgs.url !== 'string' || !input.websocketConnectionArgs.url
    || input.websocketConnectionArgs.url.length > 2048
    || !['caCertificate', 'caCertificateDomain'].every(key => input.websocketConnectionArgs[key] == null
      || typeof input.websocketConnectionArgs[key] === 'string')
    || input.basicAuth != null && (!fields(input.basicAuth, ['username', 'password'])
      || typeof input.basicAuth.username !== 'string' || typeof input.basicAuth.password !== 'string')) throw fail('invalid-cloud-response');
  return { version: input.version, connectivityMode: input.connectivityMode,
    websocketConnectionArgs: { url: input.websocketConnectionArgs.url,
      caCertificate: input.websocketConnectionArgs.caCertificate || null,
      caCertificateDomain: input.websocketConnectionArgs.caCertificateDomain || null },
    basicAuth: input.basicAuth == null ? null : { username: input.basicAuth.username, password: input.basicAuth.password } };
}
const connectionFingerprint = details => details === null ? null : digest({
  connectivityMode: details.connectivityMode, websocketConnectionArgs: details.websocketConnectionArgs, basicAuth: details.basicAuth });
function storeConnectionArgs(details) {
  const suffix = `/${encodeURIComponent(details.basicAuth?.username ?? '')}`;
  const args = details.websocketConnectionArgs;
  if (!details.basicAuth?.username || !args.url.endsWith(suffix)) throw fail('invalid-cloud-response');
  // Native GET returns the complete URL, while POST appends the identity to a
  // base URL. Reusing GET verbatim would append the identity a second time.
  return { ...args, url: args.url.slice(0, -suffix.length) };
}

export function createOcppSetup({ installation, state, api, listener, clock = Date.now, canControl = () => false,
  prepareControl = async () => { throw fail('native-control-unavailable'); },
  beforeDisable = async () => {},
  commitControl = async () => { throw fail('native-control-unavailable'); } } = {}) {
  const desired = { connectivityMode: 'DualProtocol', websocketConnectionArgs: { url: `${installation.endpoint}/${encodeURIComponent(installation.identity)}`,
    caCertificate: installation.ca_certificate || null, caCertificateDomain: installation.ca_certificate_domain || null },
  basicAuth: { username: installation.identity, password: installation.password } };
  const wanted = connectionFingerprint(desired);
  let desiredEnabled = installation.enabled;
  let saved, invalid = false, flight = null, closed = false, foreign = null;
  const cancellation = new AbortController();
  let status = { state: 'checking', reason: null, endpointSource: installation.endpointSource,
    nextAttemptAt: null, lastSuccessAt: null, canAdopt: false, revision: null, busy: false };
  try {
    saved = state?.get?.();
    if (saved != null && !validState(saved, installation.scope)) invalid = true;
  } catch { invalid = true; }
  if (saved == null) saved = { version: 1, scope: installation.scope, ownedFingerprint: null,
    appliedFingerprint: null, adoptionFingerprint: null, intent: null, lastAppliedAt: null,
    lastSuccessAt: null, nextAttemptAt: null, failures: 0 };
  // A healthy polling deadline must not delay a newly requested configuration
  // (especially disable after the listener closes). Actual failure/rate-limit
  // backoff remains durable across configuration changes and restarts.
  let changedConfiguration = !invalid && saved.failures === 0 && (installation.enabled
    ? saved.appliedFingerprint !== wanted
    : Boolean(saved.ownedFingerprint || saved.intent));
  const active = () => !closed && canControl();
  const installed = () => !invalid && desiredEnabled && saved.ownedFingerprint === wanted
    && saved.appliedFingerprint === wanted && saved.intent === null && saved.adoptionFingerprint === null;
  let missingSince = clock(), connectionGeneration = listener.status().connectionGeneration;
  function observeTransport() {
    const local = listener.status(), now = clock();
    if (!local.ready || local.transportConnected || local.connected || local.available) missingSince = null;
    else if (missingSince === null || now < missingSince || local.connectionGeneration !== connectionGeneration) missingSince = now;
    connectionGeneration = local.connectionGeneration;
    return local;
  }
  function recoveryDueAt(local = observeTransport()) {
    if (!installed() || local.transportConnected !== false || local.connected || local.available
      || !Number.isSafeInteger(local.connectionGeneration) || missingSince === null
      || saved.recovery?.attempts >= MAX_RECOVERY_ATTEMPTS) return null;
    return Math.max(missingSince + RECOVERY_GRACE_MS, (saved.lastAppliedAt ?? 0) + RECOVERY_GRACE_MS,
      saved.recovery ? saved.recovery.lastAttemptAt + RECOVERY_RETRY_MS[saved.recovery.attempts - 1] : 0,
      saved.failures || ['foreign-configuration', 'missing-cloud-configuration'].includes(status.reason)
        ? saved.nextAttemptAt ?? 0 : 0);
  }
  function check() { if (!active()) throw fail('authority-revoked'); }
  function describeStatus(next, reason = null) {
    return { ...status, state: next, reason, nextAttemptAt: saved.nextAttemptAt, lastSuccessAt: saved.lastSuccessAt,
      canAdopt: desiredEnabled && active() && foreign !== null && next === 'blocked' && reason === 'foreign-configuration',
      revision: next === 'blocked' && reason === 'foreign-configuration' ? digest([foreign, wanted]) : null };
  }
  function publish(next, reason = null) { status = describeStatus(next, reason); }
  async function persist(changes) {
    check();
    const next = { ...saved, ...changes };
    try { await state.set(structuredClone(next)); } catch { throw fail('storage-unavailable'); }
    check(); saved = next;
  }
  async function call(method, ...args) {
    check(); const result = await api[method](...args, { signal: cancellation.signal }); check(); return result;
  }
  async function remote() {
    try { return ocppConnectionDetails(await call('get')); }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async function prerequisites() {
    const payload = await call('observations');
    const rows = payload?.observations;
    if (!Array.isArray(rows)) throw fail('invalid-cloud-response');
    const newest = new Map();
    for (const row of rows) {
      if (!row || ![80, 141, 250].includes(row.id) || typeof row.timestamp !== 'string'
        || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.timestamp)) continue;
      const at = Date.parse(row.timestamp), prior = newest.get(row.id);
      if (!Number.isFinite(at) || at < 0 || at > clock()) continue;
      if (!prior || at > prior.at) newest.set(row.id, { at, value: row.value });
      else if (at === prior.at && row.value !== prior.value) newest.set(row.id, { at, value: null });
    }
    // These are change-reported settings/status, not periodic measurements:
    // rereading their current cloud state must not invent a new source time.
    const values = new Map([...newest].map(([id, row]) => [id, row.value]));
    if (!Number.isInteger(values.get(80)) || values.get(80) < 344) throw fail('firmware-required');
    if (values.get(250) !== true) throw fail('charger-offline');
    if (values.get(141) !== 1) throw fail('wifi-required');
  }
  function prerequisiteReason() {
    if (invalid) return ['blocked', 'incompatible-setup-state'];
    if (!installation.chargerId || !desiredEnabled && !saved.ownedFingerprint && !saved.intent) return ['disabled', null];
    if (!active()) return ['blocked', 'authority-revoked'];
    if (!desiredEnabled) return null;
    if (!installation.endpoint) return ['needs-endpoint', 'endpoint-required'];
    if (!installation.password) return ['blocked', 'credentials-unavailable'];
    if (installation.authorization_mode === 'rfid' && !installation.authorization_tags.length) return ['blocked', 'authorization-tags-required'];
    if (installation.authorization_mode === 'plug-and-charge' && !installation.virtualTag) return ['blocked', 'credentials-unavailable'];
    const local = listener.status();
    if (!local.ready) {
      const reason = ['listener-unavailable', 'transaction-state-unavailable', 'incompatible-transaction-state',
        'authorization-unavailable'].includes(local.error) ? local.error
        : local.listening === false ? 'listener-unavailable' : 'listener-not-ready';
      return ['waiting-listener', reason];
    }
    return null;
  }
  async function disableOwned() {
    publish('checking');
    let current = await remote();
    const original = connectionFingerprint(current);
    if (current === null) {
      await prepareControl('cloud'); check();
      await commitControl('cloud'); check();
      await persist({ ownedFingerprint: null, appliedFingerprint: null, adoptionFingerprint: null, intent: null, recovery: null, nextAttemptAt: null });
      publish('disabled'); return;
    }
    if (original !== saved.ownedFingerprint && original !== saved.intent?.fingerprint) {
      foreign = original; await persist({ nextAttemptAt: clock() + 300_000 }); publish('blocked', 'foreign-configuration'); return;
    }
    await prerequisites();
    await prepareControl('cloud'); check();
    const off = { ...current, connectivityMode: 'OcppOff' }, fingerprint = connectionFingerprint(off);
    if (original !== fingerprint) {
      const beforeStore = await remote();
      if (connectionFingerprint(beforeStore) !== original || beforeStore?.version !== current.version) throw fail('foreign-configuration');
      if (!current.basicAuth) throw fail('invalid-cloud-response');
      await persist({ intent: { fingerprint, base: original, version: null } });
      const afterSave = await remote();
      if (connectionFingerprint(afterSave) !== original || afterSave?.version !== current.version) throw fail('foreign-configuration');
      publish('applying');
      const result = await call('store', { connectivityMode: 'OcppOff', chargePointId: current.basicAuth.username,
        basicAuthPassword: current.basicAuth.password, websocketConnectionArgs: storeConnectionArgs(current) });
      if (!fields(result, ['version']) || !version(result.version)) throw fail('invalid-cloud-response');
      await persist({ intent: { ...saved.intent, version: result.version } });
      current = await remote();
      if (connectionFingerprint(current) !== fingerprint || current?.version !== result.version) throw fail('foreign-configuration');
    } else await persist({ intent: { fingerprint, base: original, version: current.version } });
    const verified = await remote();
    if (connectionFingerprint(verified) !== fingerprint || verified?.version !== saved.intent.version) throw fail('foreign-configuration');
    publish('applying');
    // A lost apply reply still needs a durable protocol boundary. This records
    // an intended mode change, never a physical transaction end or energy value.
    await beforeDisable(); check();
    const afterDisableIntent = await remote();
    if (connectionFingerprint(afterDisableIntent) !== fingerprint || afterDisableIntent?.version !== verified.version)
      throw fail('foreign-configuration');
    await call('apply', { version: verified.version });
    await commitControl('cloud'); check();
    // Remember the settings we just disabled without retaining a restoration
    // duty. A later configuration reload can recognize this exact inactive
    // connection even when its newly detected address differs.
    await persist({ ownedFingerprint: null, appliedFingerprint: fingerprint, adoptionFingerprint: null, intent: null,
      recovery: null, nextAttemptAt: null, lastAppliedAt: clock(), failures: 0 });
    publish('disabled');
  }
  async function recoverConnection(current) {
    const generation = connectionGeneration;
    const isCurrent = () => {
      const local = observeTransport();
      return active() && installed() && !prerequisiteReason() && local.transportConnected === false
        && !local.connected && !local.available && local.connectionGeneration === generation;
    };
    // Recovery never hands charging control away, stores replacement settings,
    // disables OCPP or creates a commissioning intent. A lost cloud reply leaves
    // the current local installation usable and only consumes a bounded attempt.
    await prerequisites();
    if (!isCurrent()) return;
    await persist({ recovery: { attempts: (saved.recovery?.attempts ?? 0) + 1, lastAttemptAt: clock() } });
    if (!isCurrent()) return;
    const verified = await remote();
    if (!isCurrent()) return;
    if (connectionFingerprint(verified) !== wanted || verified?.version !== current.version) {
      foreign = connectionFingerprint(verified); throw fail('foreign-configuration');
    }
    publish('recovering', 'reapplying-connection');
    // The provider also checks this guard at actual dispatch after token loading
    // or refresh. A connection arriving during either operation cancels Apply.
    await api.apply({ version: verified.version }, { signal: cancellation.signal, isCurrent });
    check();
    await persist({ lastAppliedAt: clock(), failures: 0, nextAttemptAt: clock() + RECOVERY_GRACE_MS });
    publish('connecting', 'waiting-connection');
  }
  async function reconcile() {
    check();
    const blocked = prerequisiteReason();
    if (blocked) return;
    if (!desiredEnabled) return disableOwned();
    publish('checking');
    let current = await remote(), fingerprint = connectionFingerprint(current);
    if (installed()) {
      // Once commissioned, missing or changed cloud settings cannot silently
      // replace the installation or authorize a new commissioning transition.
      if (fingerprint !== wanted) {
        foreign = fingerprint; await persist({ nextAttemptAt: clock() + RECOVERY_GRACE_MS });
        publish('blocked', current === null ? 'missing-cloud-configuration' : 'foreign-configuration'); return;
      }
      foreign = null;
      const local = observeTransport(), dueAt = recoveryDueAt(local);
      if (dueAt !== null && dueAt <= clock()) return recoverConnection(current);
      await persist({ failures: 0, nextAttemptAt: clock() + (local.available ? 3600_000 : RECOVERY_GRACE_MS),
        ...(local.available ? { lastSuccessAt: clock() } : {}) });
      publish(local.available ? 'ready' : 'connecting', local.available ? null : 'waiting-connection'); return;
    }
    const ours = fingerprint === null || fingerprint === wanted || fingerprint === saved.ownedFingerprint
      || fingerprint === saved.adoptionFingerprint || saved.intent !== null && fingerprint === saved.intent.base
      || current?.connectivityMode === 'OcppOff' && (fingerprint === saved.appliedFingerprint
        || connectionFingerprint({ ...current, connectivityMode: 'DualProtocol' }) === wanted);
    if (!ours) {
      foreign = fingerprint; await persist({ nextAttemptAt: clock() + 300_000 }); publish('blocked', 'foreign-configuration'); return;
    }
    foreign = null;
    // An already applied setup survives an application restart. With genuinely
    // absent setup state, a matching readback plus fresh authenticated local
    // readings also establishes the installed connection without reapplying it.
    // An unfinished explicit apply still follows its durable intent below.
    if (fingerprint === wanted && saved.intent === null
      && (saved.appliedFingerprint === wanted || listener.status().available)) {
      if (saved.appliedFingerprint !== wanted) { await prepareControl('native'); check(); }
      await commitControl('native'); check();
      const available = listener.status().available;
      await persist({ ownedFingerprint: wanted, appliedFingerprint: wanted, adoptionFingerprint: null,
        recovery: null, failures: 0, nextAttemptAt: clock() + (available ? 3600_000 : 300_000),
        ...(available ? { lastSuccessAt: clock() } : {}) });
      publish(available ? 'ready' : 'connecting', available ? null : 'waiting-connection'); return;
    }
    await prerequisites();
    await prepareControl('native'); check();
    // Commit intent before either external mutation. A lost response is retried
    // by reading the current version; it never creates an unbounded setup loop.
    if (fingerprint !== wanted) {
      const beforeStore = await remote();
      if (connectionFingerprint(beforeStore) !== fingerprint || beforeStore?.version !== current?.version)
        throw fail('foreign-configuration');
      await persist({ intent: { fingerprint: wanted, base: fingerprint, version: null } });
      const afterSave = await remote();
      if (connectionFingerprint(afterSave) !== fingerprint || afterSave?.version !== current?.version) throw fail('foreign-configuration');
      publish('applying');
      const result = await call('store', { connectivityMode: 'DualProtocol', chargePointId: installation.identity,
        basicAuthPassword: installation.password, websocketConnectionArgs: storeConnectionArgs(desired) });
      if (!fields(result, ['version']) || !version(result.version)) throw fail('invalid-cloud-response');
      await persist({ intent: { ...saved.intent, version: result.version }, ownedFingerprint: wanted });
      current = await remote(); fingerprint = connectionFingerprint(current);
      if (fingerprint !== wanted || current.version !== result.version) throw fail('foreign-configuration');
    } else {
      await persist({ intent: { fingerprint: wanted, base: fingerprint, version: current.version }, ownedFingerprint: wanted });
    }
    // Recheck readback immediately before apply. A stored configuration is not
    // proof that the charger uses it; actual local readings establish readiness.
    const verified = await remote();
    if (connectionFingerprint(verified) !== wanted || verified.version !== saved.intent.version) throw fail('foreign-configuration');
    publish('applying');
    await call('apply', { version: verified.version });
    await commitControl('native'); check();
    await persist({ ownedFingerprint: wanted, appliedFingerprint: wanted, adoptionFingerprint: null, intent: null,
      recovery: null, lastAppliedAt: clock(), nextAttemptAt: clock() + 30_000, failures: 0 });
    publish('connecting', 'waiting-connection');
  }
  async function attempt() {
    try { await reconcile(); }
    catch (error) {
      if (!active()) { publish('blocked', 'authority-revoked'); return; }
      const known = ['firmware-required', 'wifi-required', 'charger-offline', 'foreign-configuration',
        'invalid-cloud-response', 'storage-unavailable', 'native-control-unavailable', 'cloud-schedule-active', 'control-transition-pending'];
      const reason = known.includes(error.code) ? error.code : [401, 403].includes(error.status) ? 'cloud-authentication'
        : error.status === 429 ? 'cloud-rate-limit' : 'cloud-unavailable';
      const failures = Math.min(10, saved.failures + 1);
      try { await persist({ failures, nextAttemptAt: clock() + Math.max(Math.min(3600_000, 30_000 * 2 ** (failures - 1)),
        Math.min(86400_000, Math.max(0, error.retryAfterMs ?? 0))) }); }
      catch { publish('blocked', 'storage-unavailable'); return; }
      publish('retrying', reason);
    }
  }
  return {
    status({ includeEndpoint = false } = {}) {
      const local = observeTransport();
      const blocked = prerequisiteReason();
      // Live prerequisites must not overwrite the reconciliation result: a
      // temporary listener outage can recover before the next cloud check.
      if (!blocked && saved.appliedFingerprint === wanted && saved.intent === null
        && status.state === 'connecting' && listener.status().available) publish('ready');
      let current = blocked ? describeStatus(...blocked) : status;
      if (!blocked && installed() && !flight && ['ready', 'connecting', 'recovering'].includes(current.state))
        current = describeStatus(local.available ? 'ready' : 'connecting', local.available ? null : 'waiting-connection');
      const recovery = installed() ? { attempts: saved.recovery?.attempts ?? 0,
        lastAttemptAt: saved.recovery?.lastAttemptAt ?? null, nextAttemptAt: recoveryDueAt(local),
        exhausted: !flight && !local.transportConnected && !local.connected && !local.available
          && saved.recovery?.attempts >= MAX_RECOVERY_ATTEMPTS
          && clock() >= saved.recovery.lastAttemptAt + RECOVERY_GRACE_MS } : null;
      // Only live dashboard reads request the base address. Persisted health,
      // setup history and adoption responses keep installation details out.
      return { ...current, recovery, canAdopt: current.canAdopt && active(), busy: flight !== null,
        ...(includeEndpoint ? { endpoint: installation.endpoint ? new URL(installation.endpoint).href : null } : {}) };
    },
    runDue() {
      const local = observeTransport();
      if (!active() || flight) return flight ?? Promise.resolve();
      // Authenticated local traffic ends the outage without a cloud reply.
      if (installed() && local.connected && saved.recovery) {
        flight = persist({ recovery: null }).then(() => {
          if (!['foreign-configuration', 'missing-cloud-configuration'].includes(status.reason))
            publish(local.available ? 'ready' : 'connecting', local.available ? null : 'waiting-connection');
        }).catch(() => publish('blocked', 'storage-unavailable'))
          .finally(() => { flight = null; });
        return flight;
      }
      const recoveryAt = recoveryDueAt(local);
      if (!changedConfiguration && saved.nextAttemptAt > clock() && !(recoveryAt !== null && recoveryAt <= clock()))
        return Promise.resolve();
      changedConfiguration = false;
      flight = attempt().finally(() => { flight = null; }); return flight;
    },
    async adopt(revision) {
      check();
      if (flight || !status.canAdopt || typeof revision !== 'string' || revision !== status.revision) throw fail('ocpp-setup-changed');
      flight = (async () => {
        const current = await remote();
        if (digest([connectionFingerprint(current), wanted]) !== revision) throw fail('ocpp-setup-changed');
        await persist({ adoptionFingerprint: connectionFingerprint(current), nextAttemptAt: null });
        await attempt();
      })().finally(() => { flight = null; });
      await flight; return this.status();
    },
    async deactivate() {
      check();
      desiredEnabled = false;
      await flight;
      check();
      // Preserve a real provider backoff; an explicit integration change must
      // report an unconfirmed restoration instead of bypassing rate limits.
      if ((saved.ownedFingerprint || saved.intent) && saved.failures && saved.nextAttemptAt > clock())
        throw fail('control-transition-pending');
      changedConfiguration = true;
      await this.runDue();
      if (this.status().state !== 'disabled') throw fail('control-transition-pending');
      return this.status();
    },
    async close() { closed = true; cancellation.abort(); await flight?.catch(() => {}); },
  };
}
