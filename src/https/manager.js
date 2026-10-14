import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, lstat, cp, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Resolver } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { httpsError, errorCode, privateDirectory, atomicJson, readJson, lockDirectory, outsideCheckout } from './storage.js';
import { BOOTSTRAP_VERSION } from './official-roots.js';
import { runtimeTask } from './worker.js';
import { releaseCandidate, compareVersions, architecture, stableVersion } from './distribution.js';
import { CertificateHelper, helperLocations, preflightRuntime } from './helper.js';
import { helperAuthorizationUrl } from './authorization-url.js';
import { validateCertificate, inspectCertificate, certificateHostname, renewalMinimumValidity } from './certificates.js';

const HOUR = 3600000; const DAY = 24 * HOUR;
const ACTIONS = ['enable', 'disable', 'recheck', 'retry', 'check-updates', 'update-now', 'set-update-policy', 'restore-identity'];
const STATE_KEYS = ['version', 'enabled', 'hostname', 'ownerId', 'pairId', 'localId', 'peerId', 'peerRenewalRequired', 'machineName', 'certificate', 'runtime', 'previousRuntime', 'highestVersion', 'seen', 'updates', 'operation', 'transaction', 'quarantined'];
function initialState() {
  return { version: 1, enabled: false, hostname: null, ownerId: null, pairId: null, localId: null, peerId: null, peerRenewalRequired: false,
    machineName: `stmq-https-${randomUUID().replaceAll('-', '').slice(0, 10)}`, certificate: null, runtime: null, previousRuntime: null,
    highestVersion: null, seen: {}, updates: { policy: 'automatic', installed: null, latest: null, candidate: null,
      testedVersion: BOOTSTRAP_VERSION, lastAttempt: null, lastSuccessfulCheck: null, cache: null, error: null, securitySignal: null }, operation: null, transaction: null, quarantined: {} };
}
function validateState(value) {
  const known = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && !Object.keys(object).some(key => !keys.includes(key));
  const moment = number => number === null || Number.isFinite(number) && number >= 0;
  const digest = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
  if (!value || value.version !== 1 || Object.keys(value).some(key => !STATE_KEYS.includes(key)) || typeof value.enabled !== 'boolean' ||
      !['automatic', 'manual'].includes(value.updates?.policy) || typeof value.machineName !== 'string' || !/^stmq-https-[a-f0-9]{10}$/.test(value.machineName) ||
      !value.seen || !value.quarantined || typeof value.peerRenewalRequired !== 'boolean') throw httpsError('https_state_invalid');
  const identity = text => typeof text === 'string' && text.length > 0 && text.length <= 256;
  if (value.pairId === null ? value.localId !== null || value.peerId !== null || value.ownerId !== null || value.peerRenewalRequired :
    !identity(value.pairId) || !identity(value.localId) || !identity(value.peerId) || ![value.localId, value.peerId].includes(value.ownerId)) throw httpsError('https_state_invalid');
  if (value.hostname !== null) certificateHostname(value.hostname);
  for (const field of ['certificate', 'runtime', 'previousRuntime', 'operation', 'transaction']) if (value[field] !== null &&
      (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]))) throw httpsError('https_state_invalid');
  for (const field of ['candidate', 'cache', 'securitySignal']) if (value.updates[field] !== null &&
      (!value.updates[field] || typeof value.updates[field] !== 'object' || Array.isArray(value.updates[field]))) throw httpsError('https_state_invalid');
  for (const field of ['highestVersion']) if (value[field] !== null && typeof value[field] !== 'string') throw httpsError('https_state_invalid');
  for (const field of ['installed', 'latest']) if (value.updates[field] !== null && typeof value.updates[field] !== 'string') throw httpsError('https_state_invalid');
  if (!known(value.updates, ['policy', 'installed', 'latest', 'candidate', 'testedVersion', 'lastAttempt', 'lastSuccessfulCheck', 'cache', 'error', 'securitySignal']) ||
      !moment(value.updates.lastAttempt) || !moment(value.updates.lastSuccessfulCheck) || value.updates.testedVersion !== BOOTSTRAP_VERSION ||
      value.updates.error !== null && (typeof value.updates.error !== 'string' || !/^[a-z][a-z0-9_]{0,80}$/.test(value.updates.error))) throw httpsError('https_state_invalid');
  if (value.certificate && (!known(value.certificate, ['generation', 'hostname', 'notBefore', 'expiresAt', 'fingerprint', 'renewalWindowMs']) ||
      value.certificate.hostname !== value.hostname || !Number.isFinite(value.certificate.notBefore) || !Number.isFinite(value.certificate.expiresAt) ||
      value.certificate.expiresAt <= value.certificate.notBefore || !digest(value.certificate.fingerprint) || !Number.isFinite(value.certificate.renewalWindowMs) || value.certificate.renewalWindowMs <= 0)) throw httpsError('https_state_invalid');
  if (value.operation && (!known(value.operation, ['id', 'action', 'state', 'stage', 'startedAt', 'completedAt', 'error']) ||
      typeof value.operation.id !== 'string' || !ACTIONS.includes(value.operation.action) || !['running', 'completed', 'failed', 'interrupted'].includes(value.operation.state) ||
      typeof value.operation.stage !== 'string' || !moment(value.operation.startedAt) || !moment(value.operation.completedAt) ||
      value.operation.error !== null && !/^[a-z][a-z0-9_]{0,80}$/.test(value.operation.error))) throw httpsError('https_state_invalid');
  if (value.transaction && (!known(value.transaction, ['version', 'stage', 'startedAt']) ||
    !['downloaded', 'authenticated', 'preflight', 'prepared', 'production_state_opened'].includes(value.transaction.stage) || !moment(value.transaction.startedAt))) throw httpsError('https_state_invalid');
  if (value.updates.securitySignal && (!known(value.updates.securitySignal, ['urgent', 'observedAt', 'runningVersion', 'latestVersion', 'resolvedAt']) ||
      typeof value.updates.securitySignal.urgent !== 'boolean' || !moment(value.updates.securitySignal.observedAt) ||
      value.updates.securitySignal.resolvedAt !== undefined && !moment(value.updates.securitySignal.resolvedAt))) throw httpsError('https_state_invalid');
  if (value.updates.cache && (!known(value.updates.cache, ['metadata', 'etag']) || !known(value.updates.cache.metadata, ['TarballsVersion', 'Tarballs']) ||
      !known(value.updates.cache.metadata.Tarballs, ['amd64', 'arm64']) || value.updates.cache.etag !== null && (typeof value.updates.cache.etag !== 'string' || value.updates.cache.etag.length > 256))) throw httpsError('https_state_invalid');
  if (!known(value.seen, Object.keys(value.seen)) || !known(value.quarantined, Object.keys(value.quarantined)) || Object.entries(value.quarantined).some(([, result]) =>
      !known(result, ['error', 'at']) || !moment(result.at) || !/^[a-z][a-z0-9_]{0,80}$/.test(result.error))) throw httpsError('https_state_invalid');
  try {
    if (value.highestVersion !== null) stableVersion(value.highestVersion);
    if (value.transaction) stableVersion(value.transaction.version);
    for (const version of [value.updates.installed, value.updates.latest]) if (version !== null) stableVersion(version);
    if (value.updates.securitySignal) for (const version of [value.updates.securitySignal.runningVersion, value.updates.securitySignal.latestVersion]) if (version !== null) stableVersion(version);
    for (const [version, sha] of Object.entries(value.seen)) { stableVersion(version); if (!digest(sha)) throw httpsError('https_state_invalid'); }
    for (const version of Object.keys(value.quarantined)) stableVersion(version);
    if (value.updates.cache) releaseCandidate(value.updates.cache.metadata);
    if (value.updates.candidate) {
      if (!known(value.updates.candidate, ['version', 'arch', 'filename', 'eligible', 'url'])) throw httpsError('https_state_invalid');
      const expected = releaseCandidate({ TarballsVersion: value.updates.candidate.version, Tarballs: { [architecture()]: value.updates.candidate.filename } });
      if (Object.keys(expected).some(key => expected[key] !== value.updates.candidate[key])) throw httpsError('https_state_invalid');
    }
    for (const runtime of [value.runtime, value.previousRuntime]) if (runtime) {
      stableVersion(runtime.evidence?.runtimeVersion);
      if (Object.keys(runtime).some(key => !['name', 'evidence'].includes(key)) || !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(runtime.name ?? '') ||
          !/^[a-f0-9]{64}$/.test(runtime.evidence?.archiveSha256 ?? '') || runtime.name !== `${runtime.evidence.runtimeVersion}-${runtime.evidence.archiveSha256.slice(0, 16)}` ||
          runtime.evidence.vendor !== 'tailscale' || runtime.evidence.version !== 1 || runtime.evidence.arch !== architecture() ||
          runtime.evidence.artifactUrl !== `https://pkgs.tailscale.com/stable/tailscale_${runtime.evidence.runtimeVersion}_${runtime.evidence.arch}.tgz` ||
          !known(runtime.evidence, ['version', 'vendor', 'runtimeVersion', 'arch', 'artifactUrl', 'archiveSha256', 'archiveLength', 'blake2s256', 'signingBundleSha256', 'signature', 'verifierRevision', 'verifiedAt', 'files']) ||
          !known(runtime.evidence.files, ['tailscale', 'tailscaled']) || !digest(runtime.evidence.files.tailscale) || !digest(runtime.evidence.files.tailscaled) ||
          !digest(runtime.evidence.blake2s256) || !digest(runtime.evidence.signingBundleSha256) || !Number.isSafeInteger(runtime.evidence.archiveLength) || runtime.evidence.archiveLength < 1 ||
          !moment(runtime.evidence.verifiedAt) || typeof runtime.evidence.signature !== 'string' || Buffer.from(runtime.evidence.signature, 'base64').length !== 64 ||
          !/^[a-f0-9]{40}$/.test(runtime.evidence.verifierRevision))
        throw httpsError('https_state_invalid');
    }
  } catch { throw httpsError('https_state_invalid'); }
  if (value.certificate && (!Number.isSafeInteger(value.certificate.generation) || value.certificate.generation < 1)) throw httpsError('https_state_invalid');
  return value;
}
function clone(value) { return structuredClone(value); }
function nodeKeyExpiry(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : NaN;
  // A zero/default Go time is not evidence that an unattended key expired.
  // Missing/unsupported dates remain unknown; do not infer disabled expiry.
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

// This manager owns only optional web certificates and its private helper.
// Construction/start cannot delay or throw into controller startup. All runtime
// installation, stateful updates and issuance are serialized in the background.
export function createHttpsManager({ getConfig, onCertificate, onDisable = async () => {}, pair = null,
  dependencies = {} } = {}) {
  const cancellation = new AbortController();
  const task = (name, data, options) => (dependencies.runtimeTask ?? runtimeTask)(name, data, { ...options, signal: cancellation.signal });
  const certificateValidator = dependencies.validateCertificate ?? validateCertificate;
  const certificateInspector = dependencies.inspectCertificate ?? inspectCertificate;
  const createHelper = dependencies.createHelper ?? (options => new CertificateHelper(options));
  const locationsFactory = dependencies.helperLocations ?? helperLocations;
  const preflight = dependencies.preflightRuntime ?? preflightRuntime;
  const clock = dependencies.now ?? Date.now;
  let state = initialState(); let loaded = false; let invalid = false; let closed = false; let busy = null; let admission = null; let admissionKind = null; let initialization = null;
  let helper = null; let locations = null; let releaseLock = null; let timer = null; let expiryTimer = null; let certificate = null;
  let publishedCertificate = null;
  let certificateError = null;
  let phase = 'disabled'; let lastError = null; let helperStatus = { state: 'stopped', version: null }; let dns = { state: 'not_configured', a: [], aaaa: [], checkedAt: null };
  let peerStatus = null; let restartAfter = 0; let restartFailures = 0;
  const config = () => getConfig();
  let ownedDirectory = null;
  const configuredDirectory = () => resolve(config().web?.httpsDirectory ?? resolve(config().dataDir, 'https'));
  const directory = () => ownedDirectory ??= configuredDirectory();
  const statePath = () => resolve(directory(), 'state.json');
  const runtimeDirectory = record => resolve(directory(), 'runtime', record.name);
  const pairConfiguration = () => pair?.configuration?.() ?? null;
  const expectedDnsAddress = () => pairConfiguration()?.vipAddress ??
    (isIPv4(config().web?.httpsHost) && config().web.httpsHost !== '0.0.0.0' ? config().web.httpsHost : null);
  const localOwner = () => state.pairId ? state.ownerId === pairConfiguration()?.localId : config().topology !== 'pair';
  const responsible = () => localOwner() && (state.enabled || state.peerRenewalRequired);
  function assertOpen() { if (closed) throw httpsError('https_manager_closed'); if (ownedDirectory && configuredDirectory() !== ownedDirectory) throw httpsError('https_directory_restart_required'); }
  function background(operation) {
    busy = Promise.resolve().then(operation).catch(error => { lastError = errorCode(error); if (!closed) phase = 'degraded'; }).finally(() => { busy = null; schedule(); });
    // Contain every detached failure, including state-write and callback errors.
    busy.catch(() => {});
  }

  async function persist() { if (invalid) throw httpsError('https_state_invalid'); if (JSON.stringify(state).length > 512 * 1024) throw httpsError('https_state_size_exceeded'); await atomicJson(statePath(), state); }
  async function prepareStorage() {
    await outsideCheckout(directory());
    await privateDirectory(directory());
    if (!releaseLock) releaseLock = await lockDirectory(directory());
    for (const child of ['runtime', 'certificates', 'snapshots']) await privateDirectory(resolve(directory(), child));
  }
  async function load() {
    if (loaded) return;
    const missing = Symbol('missing HTTPS state');
    const saved = await readJson(statePath(), { missing });
    if (saved === missing) { loaded = true; return; }
    state = validateState(saved); validatePairBinding();
    const active = state.certificate;
    let acceptedMaterial = null;
    if (active) {
      const material = await readJson(resolve(directory(), 'certificates', `${active.generation}.json`), { limit: 96 * 1024 });
      if (!material || material.version !== 1 || Object.keys(material).some(key => !['version', 'hostname', 'generation', 'certificate'].includes(key)) ||
          material.hostname !== state.hostname || material.generation !== active.generation) throw httpsError('certificate_generation_invalid');
      const derived = certificateInspector(material.certificate, state.hostname);
      if (['hostname', 'notBefore', 'expiresAt', 'renewalWindowMs', 'fingerprint'].some(field => derived[field] !== active[field])) throw httpsError('certificate_integrity_failed');
      try {
        const metadata = await certificateValidator(material.certificate, state.hostname, { directory: directory(), now: clock() });
        acceptedMaterial = { ...material.certificate, metadata };
      } catch (error) {
        if (errorCode(error) !== 'certificate_not_current') throw error;
        certificateError = errorCode(error); lastError = certificateError; phase = 'degraded';
      }
    }
    // Schema, raw certificate shape and its complete derived metadata are
    // checked before lock/storage/operation-journal mutation. Genuine expiry is
    // a lifecycle condition; malformed cached state remains untouched.
    await prepareStorage(); loaded = true;
    if (state.operation?.state === 'running') { state.operation.state = 'interrupted'; state.operation.completedAt = clock(); state.operation.error = 'https_operation_interrupted'; await persist(); }
    if (acceptedMaterial) {
      certificate = acceptedMaterial;
      publishedCertificate = { record: clone(active), material: { cert: acceptedMaterial.cert, key: acceptedMaterial.key }, hostname: state.hostname };
      if (state.enabled) {
        try { await activate(certificate, active.generation); }
        catch (error) { lastError = errorCode(error); phase = 'degraded'; await onDisable().catch(() => {}); }
      }
    }
    if (state.transaction && !['downloaded', 'authenticated', 'preflight', 'prepared'].includes(state.transaction.stage)) {
      // Unknown production-state transitions are not undoable by restoring old
      // files. Preserve the state and snapshot, and require forward recovery.
      helperStatus = { state: 'repair_required', version: state.runtime?.evidence?.runtimeVersion ?? null };
      phase = 'repair_required'; lastError = 'helper_stateful_update_interrupted';
    }
  }
  async function initialize() {
    if (!initialization) initialization = load().catch(error => {
      invalid = true;
      lastError = errorCode(error); phase = 'degraded';
    });
    await initialization;
  }
  function expiryCheck() {
    clearTimeout(expiryTimer);
    const expiresAt = state.certificate?.expiresAt;
    if (!expiresAt || !state.enabled) return;
    const wait = Math.min(Math.max(expiresAt - clock(), 1), 2147483647);
    expiryTimer = setTimeout(async () => {
      if (state.certificate?.expiresAt <= clock()) { await onDisable().catch(() => {}); phase = 'degraded'; lastError = 'certificate_not_current'; }
      else expiryCheck();
    }, wait); expiryTimer.unref();
  }
  async function activate(material, generation) {
    assertOpen();
    const result = await onCertificate({ certificate: material, hostname: state.hostname, generation });
    if (!result?.listening) throw httpsError(result?.error ?? 'https_listener_activation_failed');
    if (result.fingerprint && result.fingerprint !== material.metadata.fingerprint) throw httpsError('certificate_served_fingerprint_mismatch');
    phase = 'ready'; lastError = null; expiryCheck(); return result;
  }
  async function installCertificate(material, { generation = (state.certificate?.generation ?? 0) + 1, hostname = state.hostname } = {}) {
    const metadata = await certificateValidator(material, hostname, { directory: directory(), now: clock() });
    assertOpen();
    if (!Number.isSafeInteger(generation) || generation < 1) throw httpsError('certificate_generation_invalid');
    if (state.certificate && generation <= state.certificate.generation) {
      if (generation === state.certificate.generation && metadata.fingerprint === state.certificate.fingerprint) return;
      throw httpsError('certificate_generation_replayed');
    }
    const oldCertificate = certificate; const oldRecord = state.certificate;
    const stored = { version: 1, hostname, generation, certificate: { cert: material.cert, key: material.key } };
    const path = resolve(directory(), 'certificates', `${generation}.json`);
    const staged = await readJson(path, { limit: 96 * 1024 });
    if (staged && (staged.version !== 1 || staged.hostname !== hostname || staged.generation !== generation || staged.certificate?.cert !== stored.certificate.cert || staged.certificate?.key !== stored.certificate.key)) throw httpsError('certificate_generation_collision');
    if (!staged) await atomicJson(path, stored);
    const candidate = { ...stored.certificate, metadata };
    const nextRecord = { generation, ...metadata };
    try {
      if (state.enabled) await activate(candidate, generation);
      assertOpen();
      await atomicJson(statePath(), { ...state, certificate: nextRecord });
      state.certificate = nextRecord; certificate = candidate;
      publishedCertificate = { record: clone(nextRecord), material: clone(stored.certificate), hostname };
      certificateError = null;
    } catch (error) {
      if (oldCertificate && state.enabled) await activate(oldCertificate, oldRecord.generation).catch(() => onDisable());
      else await onDisable().catch(() => {});
      await rm(path, { force: true }); throw error;
    }
    expiryCheck();
    // Keep the accepted current and previous generations only; cleanup never
    // deletes the selected record, even if the previous activation failed.
    for (const file of await readdir(resolve(directory(), 'certificates'))) {
      if (/^\d+\.json$/.test(file) && ![generation, oldRecord?.generation].includes(Number(file.slice(0, -5)))) await rm(resolve(directory(), 'certificates', file), { force: true });
    }
    if (localOwner()) await deliverPeer().catch(() => {});
  }
  async function checkDns() {
    const resolverAddress = config().web?.lanResolver;
    if (!state.hostname || !resolverAddress) { dns = { state: 'not_configured', a: [], aaaa: [], checkedAt: clock() }; return; }
    if (!isIPv4(resolverAddress)) throw httpsError('lan_resolver_invalid');
    const resolver = (dependencies.createResolver ?? (options => new Resolver(options)))({ timeout: 3000, tries: 1 }); resolver.setServers([resolverAddress]);
    const results = await Promise.allSettled([resolver.resolve4(state.hostname), resolver.resolve6(state.hostname)]);
    const answers = results.map(result => result.status === 'fulfilled' ? result.value : ['ENODATA', 'ENOTFOUND'].includes(result.reason?.code) ? [] : null);
    const expected = expectedDnsAddress();
    dns = { state: answers.some(value => value === null) ? 'unavailable' : !answers[0].length || answers[1].length || expected && answers[0].some(value => value !== expected) ? 'mismatch' : expected ? 'ready' : 'address_confirmation_required',
      a: answers[0] ?? [], aaaa: answers[1] ?? [], checkedAt: clock() };
  }
  async function checkUpdates() {
    state.updates.lastAttempt = clock();
    try {
      const result = await task('discover', { cache: state.updates.cache, arch: architecture() });
      const candidate = releaseCandidate(result.metadata);
      state.updates.cache = result; state.updates.latest = candidate.version; state.updates.candidate = candidate.eligible ? candidate : null;
      state.updates.lastSuccessfulCheck = clock(); state.updates.error = candidate.eligible ? null : 'helper_major_or_version_unsupported';
      await persist(); return candidate;
    } catch (error) { state.updates.error = errorCode(error); await persist(); throw error; }
  }
  async function integrity(record = state.runtime) {
    if (!record) throw httpsError('helper_runtime_missing');
    await task('integrity', { directory: runtimeDirectory(record), evidence: record.evidence, arch: architecture() });
  }
  async function resolveLocations({ restoreFenced = false } = {}) {
    locations = await locationsFactory(config().dataDir, directory(), { restoreFenced, addon: config().addon === true,
      signal: cancellation.signal }); return locations;
  }
  async function snapshotIdentity() {
    const destination = resolve(directory(), 'snapshots', 'before-update');
    await rm(destination, { recursive: true, force: true });
    // This protected stopped-state snapshot is evidence/recovery material, never
    // an automatically runnable rollback identity.
    await cp(locations.identity, destination, { recursive: true, dereference: false, preserveTimestamps: true, force: false, errorOnExist: true });
    await privateDirectory(destination);
    return destination;
  }
  async function installRuntime(candidate, { retry = false } = {}) {
    if (!candidate?.eligible || candidate.arch !== architecture()) throw httpsError('helper_update_ineligible');
    if (state.highestVersion && compareVersions(candidate.version, state.highestVersion) < 0) throw httpsError('helper_downgrade_rejected');
    if (state.quarantined[candidate.version] && !retry) throw httpsError('helper_candidate_quarantined');
    if (state.runtime?.evidence.runtimeVersion === candidate.version) { await integrity(); return; }
    // A missing host identity is a setup prerequisite, not a failed vendor
    // release. Preserve existing state and reject before downloading anything.
    await resolveLocations(); assertOpen();
    const runtimeRoot = resolve(directory(), 'runtime');
    state.transaction = { version: candidate.version, stage: 'downloaded', startedAt: clock() }; await persist();
    let verified;
    try {
      verified = await task('install', { candidate, directory: runtimeRoot, seen: state.seen, arch: architecture() }, { onProgress: progress => { if (state.operation) state.operation.stage = progress; } });
      assertOpen();
      state.transaction.stage = 'authenticated'; state.seen[candidate.version] = verified.evidence.archiveSha256; await persist();
      await preflight(verified.staging, candidate.version, locations);
      assertOpen();
      state.transaction.stage = 'preflight'; await persist();
      const name = `${candidate.version}-${verified.evidence.archiveSha256.slice(0, 16)}`;
      const record = { name, evidence: verified.evidence };
      const destination = runtimeDirectory(record);
      if (await lstat(destination).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) {
        const accepted = await readJson(resolve(destination, 'accepted.json'));
        if (!accepted || ['version', 'vendor', 'runtimeVersion', 'arch', 'artifactUrl', 'archiveSha256', 'archiveLength', 'blake2s256', 'signingBundleSha256', 'signature', 'verifierRevision'].some(key => accepted[key] !== verified.evidence[key]) ||
            JSON.stringify(accepted.files) !== JSON.stringify(verified.evidence.files)) throw httpsError('helper_generation_identity_changed');
        await task('integrity', { directory: destination, evidence: accepted, arch: architecture() });
        record.evidence = accepted; await rm(verified.staging, { recursive: true, force: true });
      } else await rename(verified.staging, destination);
      state.transaction.stage = 'prepared'; await persist();
      assertOpen();
      const previous = state.runtime;
      if (helper) { await helper.stop(); helper = null; }
      if (previous) await snapshotIdentity();
      state.previousRuntime = previous; state.runtime = record;
      state.transaction.stage = 'production_state_opened'; await persist();
      await startHelper();
      state.highestVersion = candidate.version; state.updates.installed = candidate.version; state.transaction = null;
      delete state.quarantined[candidate.version]; await persist();
      await collectRuntimes();
    } catch (error) {
      if (!['https_manager_closed', 'vendor_download_unavailable', 'vendor_rate_limited', 'vendor_download_timeout', 'helper_worker_timeout',
        'helper_storage_insufficient', 'identity_restore_required', 'helper_installation_binding_unavailable', 'helper_directory_unsafe', 'helper_socket_directory_unsafe'].includes(errorCode(error)))
        state.quarantined[candidate.version] = { error: errorCode(error), at: clock() };
      if (state.transaction?.stage === 'production_state_opened') {
        if (helper) await helper.stop(); helper = null; helperStatus = { state: 'repair_required', version: null };
        // No blind binary/state rollback after the candidate has opened the
        // installation's identity. A stopped helper does not stop valid TLS.
        phase = 'repair_required'; lastError = 'helper_stateful_update_requires_repair';
      } else { state.transaction = null; }
      await persist(); throw error;
    }
  }
  async function collectRuntimes() {
    const keep = [state.runtime?.name, state.previousRuntime?.name, 'staged'];
    for (const name of await readdir(resolve(directory(), 'runtime'))) {
      if (!keep.includes(name) && /^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(name)) await rm(resolve(directory(), 'runtime', name), { recursive: true, force: true });
    }
  }
  async function ensureRuntime() {
    if (state.runtime) { await integrity(); return; }
    const arch = architecture();
    const candidate = { version: BOOTSTRAP_VERSION, arch, filename: `tailscale_${BOOTSTRAP_VERSION}_${arch}.tgz`, eligible: true,
      url: `https://pkgs.tailscale.com/stable/tailscale_${BOOTSTRAP_VERSION}_${arch}.tgz` };
    await installRuntime(candidate);
  }
  async function startHelper() {
    assertOpen();
    await integrity(); if (!locations) await resolveLocations();
    assertOpen();
    if (state.hostname && !(await lstat(resolve(locations.identity, 'tailscaled.state')).catch(() => null))) throw httpsError('helper_identity_missing');
    const instance = createHelper({ directory: runtimeDirectory(state.runtime), locations, processRecordPath: resolve(directory(), 'helper-process.json'),
      onExit: () => { helperStatus.state = 'stopped'; helperStatus.version = null; restartFailures++; restartAfter = clock() + Math.min(HOUR, 1000 * 2 ** Math.min(restartFailures, 12)); lastError = 'helper_process_exited'; } });
    helper = instance;
    try {
      await instance.start(); await instance.restrictions(); assertOpen();
      const observed = await instance.status(); const expectedVersion = state.runtime.evidence.runtimeVersion;
      if (!(observed.Version === expectedVersion || observed.Version?.startsWith(`${expectedVersion}-`))) throw httpsError('helper_running_version_mismatch');
      helperStatus = { state: observed.BackendState === 'Running' ? 'running' : observed.BackendState === 'NeedsLogin' ? 'authorization_required' : 'approval_or_connection_pending',
        version: observed.Version.split('-')[0], runningVersion: observed.Version, restrictionsVerified: true };
    } catch (error) { await instance.stop(); if (helper === instance) helper = null; throw error; }
  }
  async function observeHelper({ authorize = false } = {}) {
    if (!helper) await startHelper();
    const observation = authorize ? await helper.authorize(state.machineName) : await helper.status();
    if (authorize) {
      await helper.restrictions();
      if (lastError === 'helper_authorization_start_failed' &&
          (observation.BackendState === 'Running' || observation.BackendState === 'NeedsMachineAuth' || helperAuthorizationUrl(observation.AuthURL))) lastError = null;
    }
    const expectedVersion = state.runtime.evidence.runtimeVersion;
    if (!(observation.Version === expectedVersion || observation.Version?.startsWith(`${expectedVersion}-`))) throw httpsError('helper_running_version_mismatch');
    const previousSecurity = state.updates.securitySignal;
    if (observation.ClientVersion?.UrgentSecurityUpdate === true) {
      let latest = null;
      try { stableVersion(observation.ClientVersion.LatestVersion); latest = observation.ClientVersion.LatestVersion; } catch { /* Positive urgent signal remains useful without an interpretable target. */ }
      state.updates.securitySignal = { urgent: true, observedAt: clock(), runningVersion: observation.Version?.split('-')[0] ?? null,
        latestVersion: latest };
      await persist();
    } else if (previousSecurity?.urgent && observation.ClientVersion?.UrgentSecurityUpdate === false && typeof observation.ClientVersion.LatestVersion === 'string') {
      try {
        if (compareVersions(observation.Version.split('-')[0], previousSecurity.latestVersion ?? observation.ClientVersion.LatestVersion) >= 0) {
          state.updates.securitySignal = { ...previousSecurity, urgent: false, resolvedAt: clock() }; await persist();
        }
      } catch { /* Unsupported vendor values cannot clear a known warning. */ }
    }
    helperStatus = { state: observation.BackendState === 'Running' ? 'running' : observation.BackendState === 'NeedsLogin' ? 'authorization_required' : 'approval_or_connection_pending',
      version: observation.Version?.split('-')[0] ?? null, runningVersion: observation.Version ?? null, authorizationUrl: helperAuthorizationUrl(observation.AuthURL),
      nodeKeyExpiresAt: nodeKeyExpiry(observation.Self?.KeyExpiry), nodeKeyExpired: observation.Self?.Expired === true ? true : null,
      securityUpdate: state.updates.securitySignal?.urgent === true ? true : null, securityObservedAt: state.updates.securitySignal?.observedAt ?? null, restrictionsVerified: true };
    const names = observation.CertDomains;
    if (observation.BackendState !== 'Running') { if (!certificate) phase = helperStatus.state; return null; }
    if (!Array.isArray(names) || names.length !== 1) { if (!certificate) phase = 'certificate_settings_required'; return null; }
    const hostname = certificateHostname(names[0]);
    if (state.hostname && state.hostname !== hostname) throw httpsError('helper_hostname_changed');
    if (!state.hostname) { state.hostname = hostname; await persist(); }
    restartFailures = 0; return hostname;
  }
  async function renew({ authorize = false } = {}) {
    if (!responsible()) return;
    await checkOwnerChoice();
    if (state.transaction?.stage === 'production_state_opened' && helperStatus.state === 'repair_required') throw httpsError('helper_stateful_update_requires_repair');
    await ensureRuntime();
    const hostname = await observeHelper({ authorize });
    if (!hostname) return;
    const due = !certificate || state.certificate.expiresAt - clock() <= certificate.metadata.renewalWindowMs;
    if (due) {
      if (!certificate) phase = 'renewal_pending';
      const material = await helper.certificate(hostname, renewalMinimumValidity(certificate?.metadata));
      await installCertificate(material);
    } else if (state.enabled) await activate(certificate, state.certificate.generation);
    await deliverPeer();
  }
  async function peerRequest(operation, body) {
    if (!pair?.request) throw httpsError('https_peer_unavailable');
    return pair.request(operation, body);
  }
  async function checkOwnerChoice() {
    if (!state.pairId || !localOwner()) return;
    let peer;
    try { peer = await peerRequest('status', {}); }
    catch (error) {
      // An established owner keeps renewal through peer outages; the saved
      // explicit ownership and identity are independent of controller roles.
      if (state.runtime) { peerStatus = { state: 'unavailable', error: errorCode(error) }; return; }
      throw error;
    }
    if (peer.nodeId !== state.peerId) throw httpsError('https_peer_identity_mismatch');
    if (peer.ownerId && peer.ownerId !== state.ownerId) throw httpsError('https_peer_owner_conflict');
  }
  async function deliverPeer() {
    if (!state.pairId || !localOwner()) return;
    try {
      const result = await peerRequest('status', {}); peerStatus = result;
      if (typeof result.enabled !== 'boolean' || result.nodeId !== pairConfiguration()?.peerId) throw httpsError('https_peer_identity_mismatch');
      if (result.enabled && result.ownerId === state.ownerId) {
        state.peerRenewalRequired = true; await persist();
        if (publishedCertificate && (result.generation ?? 0) < publishedCertificate.record.generation) await peerRequest('receive', certificateEnvelope());
      } else if (result.enabled === false) { state.peerRenewalRequired = false; await persist(); }
    } catch (error) { peerStatus = { state: 'unavailable', error: errorCode(error), renewalRequired: state.peerRenewalRequired }; }
  }
  async function pullPeer() {
    const result = await peerRequest('get', {}); await receive(result);
  }
  function validatePairBinding() {
    const current = pairConfiguration();
    if (!state.pairId && config().topology === 'pair' && (state.enabled || state.runtime || state.certificate)) throw httpsError('https_pair_owner_setup_required');
    if (state.pairId && (current?.pairId !== state.pairId || current.localId !== state.localId || current.peerId && current.peerId !== state.peerId)) throw httpsError('https_pair_identity_changed');
  }
  async function receive(envelope) {
    validatePairBinding();
    if (!state.pairId || localOwner() || !envelope || envelope.pairId !== state.pairId || envelope.ownerId !== state.ownerId ||
        Object.keys(envelope).some(key => !['pairId', 'ownerId', 'hostname', 'generation', 'certificate'].includes(key))) throw httpsError('https_certificate_owner_mismatch');
    const hostname = certificateHostname(envelope.hostname);
    if (state.hostname && state.hostname !== hostname) throw httpsError('https_peer_hostname_changed');
    const previous = state.hostname; state.hostname = hostname;
    try { await installCertificate(envelope.certificate, { generation: envelope.generation, hostname }); }
    catch (error) { state.hostname = previous; throw error; }
  }
  async function work(action, input) {
    validatePairBinding();
    if (action === 'enable') {
      if (typeof config().token !== 'string' || config().token.length < 24) throw httpsError('credentials_required');
      const current = pairConfiguration();
      const freshOwner = config().topology === 'pair' && !state.ownerId;
      if (config().topology === 'pair') {
        if (!current?.pairId || !current.localId || !current.peerId) throw httpsError('https_pair_not_ready');
        if (!state.ownerId) {
          if (!['local', 'peer'].includes(input.owner)) throw httpsError('https_certificate_owner_required');
          state.ownerId = input.owner === 'peer' ? current.peerId : current.localId;
          state.pairId = current.pairId; state.localId = current.localId; state.peerId = current.peerId;
          // Publish the tentative choice before reading the peer. Crossed local
          // choices cannot both observe an unconfigured peer and enroll twice.
          await persist();
        } else if (input.owner && state.ownerId !== (input.owner === 'local' ? current.localId : current.peerId)) {
          throw httpsError('https_certificate_owner_fixed');
        }
      }
      try {
        if (state.pairId) {
          const peerState = await peerRequest('status', {});
          if (peerState.nodeId !== state.peerId) throw httpsError('https_peer_identity_mismatch');
          if (localOwner() ? peerState.ownerId && peerState.ownerId !== state.ownerId : peerState.ownerId !== state.ownerId || peerState.pairId !== state.pairId)
            throw httpsError(localOwner() ? 'https_peer_owner_conflict' : 'https_peer_owner_not_configured');
        }
        state.enabled = true; phase = 'preparing'; await persist();
        if (localOwner()) await renew({ authorize: true }); else { phase = 'peer_certificate_pending'; await pullPeer(); }
        await checkDns(); return;
      } catch (error) {
        // Roll back only a new tentative choice that admitted no runtime or
        // certificate identity. An enrolled/established owner is never changed.
        if (freshOwner && !state.runtime && !state.certificate) {
          state.ownerId = null; state.pairId = null; state.localId = null; state.peerId = null; state.enabled = false; state.peerRenewalRequired = false; await persist();
        }
        throw error;
      }
    }
    if (action === 'disable') {
      state.enabled = false; await persist(); clearTimeout(expiryTimer); await onDisable(); phase = 'disabled';
      await deliverPeer(); if (!responsible() && helper) { await helper.stop(); helper = null; helperStatus.state = 'stopped'; }
      return;
    }
    if (action === 'set-update-policy') { state.updates.policy = input.policy; await persist(); return; }
    if (action === 'restore-identity') {
      if (input.confirmedPeerFenced !== true || !localOwner()) throw httpsError('identity_restore_fencing_confirmation_required');
      await resolveLocations({ restoreFenced: true }); helperStatus.state = 'stopped'; state.transaction = null; await persist();
      if (responsible()) await renew({ authorize: false }); return;
    }
    if (action === 'check-updates') { await checkUpdates(); return; }
    if (action === 'update-now') {
      if (!localOwner()) throw httpsError('https_helper_owner_required');
      if (!state.runtime && !state.enabled && !state.peerRenewalRequired) throw httpsError('https_setup_required');
      const candidate = await checkUpdates(); await installRuntime(candidate, { retry: input.retry === true });
      if (responsible()) await renew(); else if (helper) { await helper.stop(); helper = null; helperStatus.state = 'stopped'; } return;
    }
    if (action === 'retry') {
      if (state.transaction?.stage === 'production_state_opened') {
        // Retry is forward recovery using the exact accepted current candidate;
        // never restoring a previous runtime or an older identity snapshot.
        state.transaction = null; helperStatus.state = 'stopped'; await persist();
      }
      restartAfter = 0;
      const target = state.updates.candidate?.version ?? (state.runtime ? null : BOOTSTRAP_VERSION);
      if (target) delete state.quarantined[target];
      if (state.runtime && state.updates.candidate?.eligible && compareVersions(state.updates.candidate.version, state.runtime.evidence.runtimeVersion) > 0)
        await installRuntime(state.updates.candidate, { retry: true });
    }
    if (state.enabled && !localOwner()) await pullPeer();
    else if (responsible()) await renew({ authorize: action === 'retry' || helperStatus.state === 'authorization_required' });
    if (certificate && state.enabled) await activate(certificate, state.certificate.generation);
    await checkDns();
  }
  async function runOperation(record, input = {}) {
    const action = record.action;
    const complete = { ...record };
    try { await work(action, input); complete.state = 'completed'; complete.stage = 'complete'; }
    catch (error) { complete.state = 'failed'; complete.error = errorCode(error); lastError = complete.error; if (phase !== 'repair_required') phase = state.enabled || state.peerRenewalRequired ? 'degraded' : 'disabled'; }
    complete.completedAt = clock();
    try { await atomicJson(statePath(), { ...state, operation: complete }); }
    catch { complete.state = 'failed'; complete.error = 'https_state_write_failed'; lastError = complete.error; if (!closed) phase = 'degraded'; }
    state.operation = complete;
  }
  function schedule() {
    clearTimeout(timer); if (closed || !state.enabled && !state.peerRenewalRequired) return;
    const pending = ['authorization_required', 'approval_or_connection_pending', 'certificate_settings_required'].includes(helperStatus.state) || ['certificate_settings_required', 'peer_certificate_pending'].includes(phase);
    const delay = lastError === 'helper_already_running' ? 5000 : restartAfter > clock() ? Math.max(1000, Math.min(HOUR, restartAfter - clock())) : pending ? 15000 : HOUR;
    timer = setTimeout(() => {
      if (!busy && !admission) background(tick); else schedule();
    }, delay); timer.unref();
  }
  async function tick() {
    if (closed || invalid) return;
    try {
      validatePairBinding();
      if (state.certificate?.expiresAt <= clock()) { await onDisable(); phase = 'degraded'; lastError = 'certificate_not_current'; }
      if (state.enabled && !localOwner()) await pullPeer();
      else if (responsible() && clock() >= restartAfter) await renew();
      await checkDns();
      if (responsible() && clock() - (state.updates.lastAttempt ?? 0) > DAY + (parseInt(state.machineName.slice(-4), 16) % HOUR)) {
        const candidate = await checkUpdates();
        if (state.updates.policy === 'automatic' && candidate.eligible && (!state.runtime || compareVersions(candidate.version, state.runtime.evidence.runtimeVersion) > 0))
          await installRuntime(candidate);
      }
    } catch (error) { lastError = errorCode(error); if (phase !== 'ready' && phase !== 'repair_required') phase = 'degraded'; }
  }
  function status({ admin = true } = {}) {
    const common = { version: 1, enabled: state.enabled, phase, certificate: publishedCertificate ? { expiresAt: publishedCertificate.record.expiresAt } : null,
      warning: certificateError ?? lastError ?? (state.peerRenewalRequired && !state.enabled ? 'renewal_retained_for_peer' : null) };
    if (!admin) return common;
    return { ...common, environment: config().addon === true ? 'home-assistant' : 'linux',
      setup: { credentialsReady: typeof config().token === 'string' && config().token.length >= 24 &&
        (!config().familyToken || typeof config().familyToken === 'string' && config().familyToken.length >= 24 && config().familyToken !== config().token) },
      hostname: state.hostname, url: state.hostname ? `https://${state.hostname}:${config().web?.httpsPort ?? 8443}` : null,
      certificate: clone(publishedCertificate?.record ?? null), helper: { ...clone(helperStatus), securityUpdate: state.updates.securitySignal?.urgent === true ? true : null,
        securityObservedAt: state.updates.securitySignal?.observedAt ?? null },
      updates: { policy: state.updates.policy, installed: state.runtime?.evidence.runtimeVersion ?? null, latest: state.updates.latest,
        candidate: state.updates.candidate?.version ?? null, testedVersion: BOOTSTRAP_VERSION, lastAttempt: state.updates.lastAttempt,
        lastSuccessfulCheck: state.updates.lastSuccessfulCheck, error: state.updates.error,
        securityCoverage: 'incomplete', bulletinUrl: 'https://tailscale.com/security-bulletins' },
      dns: { ...clone(dns), resolver: config().web?.lanResolver || null, expectedAddress: expectedDnsAddress() },
      operation: clone(state.operation), error: certificateError ?? lastError, pair: state.pairId ? { paired: true, ownerId: state.ownerId,
        localOwner: localOwner(), peerRenewalRequired: state.peerRenewalRequired, peer: clone(peerStatus) } : { paired: config().topology === 'pair' } };
  }
  async function action(input) {
    const actionFields = { enable: ['owner'], disable: [], recheck: [], retry: [], 'check-updates': [], 'update-now': ['retry'], 'set-update-policy': ['policy'], 'restore-identity': ['confirmedPeerFenced'] };
    if (!input || !ACTIONS.includes(input.action) || Object.keys(input).some(key => !['action', ...actionFields[input.action]].includes(key)) ||
        input.retry !== undefined && typeof input.retry !== 'boolean') throw httpsError('https_action_invalid');
    if (input.action === 'set-update-policy' && !['automatic', 'manual'].includes(input.policy)) throw httpsError('https_update_policy_invalid');
    if (admission) { if (admissionKind === 'action') return admission; throw httpsError('https_manager_busy'); }
    admissionKind = 'action';
    admission = (async () => {
      await initialize(); assertOpen(); if (invalid) throw httpsError(lastError ?? 'https_state_invalid');
      if (busy) {
        if (state.operation?.state === 'running') return clone(state.operation);
        throw httpsError('https_manager_busy');
      }
      await prepareStorage(); assertOpen();
      const record = { id: randomUUID(), action: input.action, state: 'running', stage: 'starting', startedAt: clock(), completedAt: null, error: null };
      state.operation = record;
      // Acceptance requires the operation's initial journal to be durable. A
      // failed journal write rejects the action and cannot become a detached
      // unhandled rejection capable of killing the application.
      try { await persist(); } catch { record.state = 'failed'; record.error = 'https_state_write_failed'; lastError = record.error; throw httpsError(record.error); }
      assertOpen(); background(() => runOperation(record, input)); return clone(record);
    })();
    try { return await admission; } finally { admission = null; admissionKind = null; }
  }
  function certificateEnvelope() {
    if (!localOwner() || !state.pairId || !publishedCertificate || publishedCertificate.record.expiresAt <= clock()) throw httpsError('https_owner_certificate_unavailable');
    return { pairId: state.pairId, ownerId: state.ownerId, hostname: publishedCertificate.hostname, generation: publishedCertificate.record.generation,
      certificate: clone(publishedCertificate.material) };
  }
  async function exportCertificate() {
    // Called only by the authenticated pair transport. Peer use carries a
    // durable renewal duty even if the owner has disabled its local TLS. Do not
    // assume an offline peer disabled its entrance or erase this responsibility.
    await initialize(); assertOpen();
    certificateEnvelope();
    if (!state.peerRenewalRequired || admissionKind === 'export') {
      while (busy || admission) {
        if (state.peerRenewalRequired && admissionKind !== 'export') break;
        await (busy ?? admission);
      }
      assertOpen();
      if (!state.peerRenewalRequired) {
        admissionKind = 'export';
        admission = (async () => {
          await prepareStorage(); assertOpen(); state.peerRenewalRequired = true;
          try { await persist(); } catch (error) { state.peerRenewalRequired = false; throw error; }
        })();
        try { await admission; } finally { admission = null; admissionKind = null; }
        if (!busy && responsible()) background(tick); else schedule();
      }
    }
    return certificateEnvelope();
  }
  async function acceptCertificate(envelope) {
    if (admission) throw httpsError('https_manager_busy');
    admissionKind = 'certificate';
    admission = (async () => {
      await initialize(); if (closed || invalid) throw httpsError('https_manager_unavailable');
      if (busy) throw httpsError('https_manager_busy');
      await prepareStorage(); assertOpen(); busy = receive(envelope);
      try { await busy; return pairStatus(); } finally { busy = null; }
    })();
    try { return await admission; } finally { admission = null; admissionKind = null; schedule(); }
  }
  function pairStatus() { return { enabled: state.enabled, pairId: state.pairId, ownerId: state.ownerId, hostname: state.hostname,
    generation: publishedCertificate?.record.generation ?? 0, expiry: publishedCertificate?.record.expiresAt ?? null, ready: phase === 'ready' }; }
  function start() {
    initialize().then(() => {
      if (closed || invalid || !state.enabled && !state.peerRenewalRequired) return;
      expiryCheck(); if (!busy && !admission) background(tick); else schedule();
    }).catch(() => {});
  }
  async function configure() {
    if (closed) return;
    if (busy || admission) { schedule(); return; }
    try { validatePairBinding(); } catch (error) { lastError = errorCode(error); phase = 'degraded'; await onDisable().catch(() => {}); if (helper) await helper.stop(); helper = null; return; }
    if (state.enabled && certificate) { try { await activate(certificate, state.certificate.generation); } catch (error) { lastError = errorCode(error); phase = 'degraded'; } }
    if (!busy && (state.enabled || state.peerRenewalRequired)) background(tick);
    else schedule();
  }
  async function close() {
    closed = true; cancellation.abort(); clearTimeout(timer); clearTimeout(expiryTimer); await initialization?.catch(() => {});
    if (helper) await helper.stop(); helper = null;
    await admission?.catch(() => {}); await busy?.catch(() => {});
    if (helper) await helper.stop(); helper = null; helperStatus.state = 'stopped'; await onDisable().catch(() => {});
    await releaseLock?.(); releaseLock = null;
  }
  return { start, configure, status, action, close, acceptCertificate, exportCertificate, pairStatus };
}
