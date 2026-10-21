import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, chown, cp, symlink, rename, stat, open, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as waitForPoll } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createHttpsManager } from '../src/https/manager.js';
import { verifySigningBundle, verifyArtifactHash, releaseCandidate, architecture } from '../src/https/distribution.js';
import { validateCertificate, renewalMinimumValidity } from '../src/https/certificates.js';
import { privateDirectory, atomicJson, outsideCheckout } from '../src/https/storage.js';
import { CertificateHelper, effectiveRestrictions, restrictedEnvironment, helperLocations, installationBinding } from '../src/https/helper.js';
import { runtimeTask } from '../src/https/worker.js';
import { secureWebAccessView } from '../chart/secure-web-access.js';

const hostname = 'fixture.test-tailnet.ts.net';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function settled(t, manager) {
  const originalId = manager.status().operation?.id;
  while (manager.status().operation?.state === 'running') {
    // The node:test deadline owns cancellation. Publication has no independent
    // one-second deadline; the actual operation must finish its durable work.
    await waitForPoll(5, undefined, { signal: t.signal });
    assert.equal(manager.status().operation?.id, originalId, 'Wait for the original accepted operation');
  }
  t.signal.throwIfAborted();
  const observed = manager.status();
  assert.notEqual(observed.operation?.state, 'running'); return observed;
}
function heldFixtureWork(t) {
  let release;
  const promise = new Promise(done => { release = done; });
  // A fake SDK may ignore cancellation. Release its owned gate before manager
  // cleanup waits for the real operation, including whole-test cancellation.
  t.signal.addEventListener('abort', release, { once: true });
  if (t.signal.aborted) release();
  t.after(() => { t.signal.removeEventListener('abort', release); release(); });
  return { promise, release };
}
async function fixtureBoundary(t, promise) {
  let abort;
  const cancelled = new Promise((_resolve, reject) => {
    abort = () => reject(t.signal.reason);
    t.signal.addEventListener('abort', abort, { once: true });
  });
  try { t.signal.throwIfAborted(); return await Promise.race([promise, cancelled]); }
  finally { t.signal.removeEventListener('abort', abort); }
}
// Filesystem publication completes under the test deadline, independently of
// host scheduling. These waits do not change any application operation limit.
async function fixtureCondition(t, predicate) {
  while (!predicate()) await waitForPoll(5, undefined, { signal: t.signal });
  t.signal.throwIfAborted();
}
async function diagnosed(t, manager) {
  await fixtureCondition(t, () => Boolean(manager.status().error));
  assert.ok(manager.status().error); return manager.status();
}
async function actionWhenIdle(t, manager, input) {
  while (true) {
    t.signal.throwIfAborted();
    try { return await manager.action(input); }
    catch (error) {
      if (error.code !== 'https_manager_busy') throw error;
      await waitForPoll(5, undefined, { signal: t.signal });
    }
  }
}
function restart(t, context, { pair = null, dependencies = {}, onCertificate } = {}) {
  const manager = createHttpsManager({ getConfig: () => context.config, pair,
    onCertificate: onCertificate ?? (async ({ certificate }) => ({ listening: true, fingerprint: certificate.metadata.fingerprint })),
    dependencies: { ...context.dependencies, ...dependencies } });
  t.after(() => manager.close()); return manager;
}
async function setup(t, changes = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { dataDir: directory, token: 'synthetic-admin-password-long-enough', topology: 'standalone', web: { httpsHost: '127.0.0.1', httpsPort: 8443, lanResolver: '' } };
  const calls = { install: 0, discover: 0, helperStart: 0, helperStop: 0, certificate: 0, certificateNames: [], activations: [], activationNames: [], remoteAccess: [], disabled: 0, preflight: 0 };
  let installNotify; const installStarted = new Promise(ready => { installNotify = ready; });
  let running = true; let certificateId = 1; let reportedHostname = hostname;
  const metadataByCertificate = new Map();
  const metadata = (material, expectedHostname = hostname) => {
    if (!metadataByCertificate.has(material.cert)) metadataByCertificate.set(material.cert, { hostname: expectedHostname, fingerprint: createHash('sha256').update(material.cert).digest('hex'), notBefore: Date.now() - 86400000, expiresAt: Date.now() + 60 * 86400000, renewalWindowMs: 30 * 86400000 });
    if (metadataByCertificate.get(material.cert).hostname !== expectedHostname) throw Object.assign(Error(), { code: 'certificate_hostname_mismatch' });
    return cloneMetadata(metadataByCertificate.get(material.cert));
  };
  const cloneMetadata = value => structuredClone(value);
  const dependencies = {
    runtimeTask: async (name, data) => {
      if (name === 'discover') { calls.discover++; return { metadata: { TarballsVersion: '1.104.1', Tarballs: { [architecture()]: `tailscale_1.104.1_${architecture()}.tgz` } }, etag: 'fixture' }; }
      if (name === 'integrity') return true;
      calls.install++;
      installNotify();
      if (calls.install <= (changes.downloadFailures ?? 0)) throw Object.assign(Error(), { code: 'vendor_download_unavailable' });
      if (changes.holdInstall) await changes.holdInstall;
      const staging = resolve(data.directory, 'staged'); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { mode: 0o700 });
      const evidence = { version: 1, vendor: 'tailscale', runtimeVersion: data.candidate.version, arch: architecture(), artifactUrl: data.candidate.url,
        archiveSha256: 'a'.repeat(64), archiveLength: 1, blake2s256: 'b'.repeat(64), signingBundleSha256: 'c'.repeat(64), signature: Buffer.alloc(64).toString('base64'), verifierRevision: 'f'.repeat(40), verifiedAt: Date.now(), files: { tailscale: 'd'.repeat(64), tailscaled: 'e'.repeat(64) } };
      await atomicJson(resolve(staging, 'accepted.json'), evidence); return { staging, evidence };
    },
    helperLocations: async () => {
      const identity = resolve(directory, 'https', 'identity'); await privateDirectory(identity);
      return { identity, socketDirectory: identity, socket: resolve(identity, 's'), uid: process.getuid(), gid: process.getgid(), root: false };
    },
    preflightRuntime: async () => { calls.preflight++; if (calls.preflight <= (changes.preflightFailures ?? 0)) throw Object.assign(Error(), { code: 'helper_command_failed' }); },
    validateCertificate: async (material, expectedHostname) => { if (material.cert === 'invalid') throw Object.assign(Error(), { code: 'certificate_chain_untrusted' }); return metadata(material, expectedHostname); },
    inspectCertificate: (material, expectedHostname) => metadata(material, expectedHostname),
    createHelper: ({ locations }) => ({
      start: async () => { calls.helperStart++; await writeFile(resolve(locations.identity, 'tailscaled.state'), '{}', { mode: 0o600 }); },
      remoteAccess: async remote => { calls.remoteAccess.push(remote); },
      restrictions: async () => {}, status: async () => ({ Version: '1.104.1-fixture', BackendState: running ? 'Running' : 'NeedsLogin', CertDomains: running ? [reportedHostname] : [], AuthURL: running ? '' : 'https://login.tailscale.com/a/synthetic' }),
      authorize: async () => ({ Version: '1.104.1-fixture', BackendState: running ? 'Running' : 'NeedsLogin', CertDomains: running ? [reportedHostname] : [], AuthURL: running ? '' : 'https://login.tailscale.com/a/synthetic' }),
      certificate: async name => { calls.certificate++; calls.certificateNames.push(name); return { cert: `fixture-cert-${certificateId}`, key: `fixture-key-${certificateId}` }; },
      stop: async () => { calls.helperStop++; },
    }), ...changes.dependencies,
  };
  const manager = createHttpsManager({ getConfig: () => config,
    onCertificate: async ({ certificate, generation, hostname: name }) => { calls.activations.push(generation); calls.activationNames.push(name); return changes.activationError ? { listening: false, error: 'tls_port_unavailable' } : { listening: true, fingerprint: certificate.metadata.fingerprint }; },
    onDisable: async () => { calls.disabled++; }, pair: changes.pair ?? null, dependencies });
  t.after(() => manager.close());
  return { directory, config, calls, manager, dependencies, metadata, installStarted, setRunning: value => { running = value; }, setCertificateId: value => { certificateId = value; }, setReportedHostname: value => { reportedHostname = value; } };
}

test('optional HTTPS starts with no files, downloads, network checks or helper when unconfigured', async t => {
  const { directory, calls, manager } = await setup(t);
  manager.start(); await wait(20);
  assert.equal(manager.status().phase, 'disabled'); assert.equal(calls.install, 0); assert.equal(calls.discover, 0); assert.equal(calls.helperStart, 0);
  await assert.rejects(lstat(resolve(directory, 'https')), { code: 'ENOENT' });
  const record = await manager.action({ action: 'update-now' }); assert.ok(record.id); await settled(t, manager);
  assert.equal(manager.status().operation.error, 'https_setup_required'); assert.equal(calls.install, 0);
});

test('remote HTTPS follows the configured pair VIP, retains the origin and closes with its enabled scope', async t => {
  const context = await setup(t); await context.manager.close();
  context.config.topology = 'pair'; context.config.web.httpsPort = 9443;
  let peerEnabled = false;
  const pair = { configuration: () => ({ pairId: 'remote-pair', localId: 'local-node', peerId: 'peer-node', vipAddress: '192.0.2.100' }),
    request: async () => ({ nodeId: 'peer-node', pairId: 'remote-pair', ownerId: 'local-node', enabled: peerEnabled, generation: 1 }) };
  let manager = restart(t, context, { pair });
  await manager.action({ action: 'enable', owner: 'local' }); await settled(t, manager);
  assert.deepEqual(context.calls.remoteAccess.at(-1), { address: '192.0.2.100', port: 9443 });
  assert.equal(manager.status().remoteAccess.state, 'configured');
  assert.equal(manager.status().url, `https://${hostname}:9443`);
  assert.equal('remoteAccess' in manager.status({ admin: false }), false);
  await manager.close();
  manager = restart(t, context, { pair });
  await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'configured', 'Current restart reuses the same identity and route');
  peerEnabled = true;
  await manager.action({ action: 'disable' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'configured', 'An enabled peer retains the pair remote entrance and renewal duty');
  peerEnabled = false;
  await manager.action({ action: 'disable' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'disabled');
});

test('remote forwarding failure leaves validated local TLS available and Retry recovers without reenrollment', async t => {
  const context = await setup(t); await context.manager.close();
  let fail = true;
  const disabledBefore = context.calls.disabled;
  const base = context.dependencies.createHelper;
  const manager = restart(t, context, { dependencies: { createHelper: options => ({ ...base(options),
    remoteAccess: async remote => { if (remote && fail) throw Object.assign(Error(), { code: 'helper_remote_forwarding_unavailable' }); },
  }) } });
  await manager.action({ action: 'enable' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'unavailable');
  assert.equal(manager.status().error, 'helper_remote_forwarding_unavailable');
  assert.ok(manager.status().certificate);
  assert.equal(context.calls.disabled, disabledBefore, 'Remote failure cannot close the local TLS listener');
  fail = false;
  await manager.action({ action: 'retry' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'configured');
  assert.equal(context.calls.install, 1); assert.equal(context.calls.certificate, 1);
});

test('a dead helper is replaced without losing identity and an earlier exit cannot invalidate its replacement', async t => {
  const context = await setup(t); await context.manager.close();
  const exits = [], base = context.dependencies.createHelper;
  const manager = restart(t, context, { dependencies: { createHelper: options => { exits.push(options.onExit); return base(options); } } });
  await manager.action({ action: 'enable' }); await settled(t, manager);
  exits[0](); assert.equal(manager.status().remoteAccess.state, 'unavailable');
  await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(exits.length, 2); assert.equal(context.calls.install, 1); assert.equal(context.calls.certificate, 1);
  assert.equal(manager.status().remoteAccess.state, 'configured');
  exits[0](); assert.equal(manager.status().remoteAccess.state, 'configured');
});

test('expired certificate scope removes forwarding even when renewal cannot recover it', async t => {
  const context = await setup(t); await context.manager.close();
  let now = Date.now();
  const manager = restart(t, context, { dependencies: { now: () => now } });
  await manager.action({ action: 'enable' }); await settled(t, manager);
  now = manager.status().certificate.expiresAt + 1;
  context.setRunning(false);
  await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(context.calls.remoteAccess.at(-1), null);
  assert.equal(manager.status().remoteAccess.state, 'disabled');
});

test('retained peer forwarding closes at certificate expiry before a failed renewal', async t => {
  const context = await setup(t); await context.manager.close(); context.config.topology = 'pair';
  let now = Date.now(), fail = false;
  const base = context.dependencies.createHelper;
  const pair = { configuration: () => ({ pairId: 'expiry-pair', localId: 'local-node', peerId: 'peer-node', vipAddress: '192.0.2.100' }),
    request: async () => ({ nodeId: 'peer-node', pairId: 'expiry-pair', ownerId: 'local-node', enabled: true, generation: 1 }) };
  const manager = restart(t, context, { pair, dependencies: { now: () => now, createHelper: options => ({ ...base(options),
    certificate: async name => { if (fail) throw Object.assign(Error(), { code: 'helper_command_failed' }); return base(options).certificate(name); },
  }) } });
  await manager.action({ action: 'enable', owner: 'local' }); await settled(t, manager);
  await manager.action({ action: 'disable' }); await settled(t, manager);
  assert.equal(manager.status().remoteAccess.state, 'configured');
  now = manager.status().certificate.expiresAt + 1; fail = true;
  await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(manager.status().operation.error, 'helper_command_failed');
  assert.equal(context.calls.remoteAccess.at(-1), null);
  assert.equal(manager.status().remoteAccess.state, 'disabled');
});

test('explicit setup installs only its helper, activates validated certificate, redacts family state and is resumable', async t => {
  const { manager, calls } = await setup(t);
  const operation = await manager.action({ action: 'enable' }); assert.ok(operation.id);
  const view = await settled(t, manager);
  assert.equal(view.phase, 'ready'); assert.equal(view.hostname, hostname); assert.equal(view.certificate.generation, 1);
  assert.equal(calls.install, 1); assert.equal(calls.helperStart, 1); assert.equal(calls.certificate, 1);
  await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(calls.install, 1); assert.equal(calls.certificate, 1, 'Rechecks do not force issuance');
  const family = manager.status({ admin: false }); assert.equal(family.enabled, true); assert.equal('hostname' in family, false); assert.equal('helper' in family, false); assert.equal('operation' in family, false);
  for (const field of ['environment', 'setup', 'dns']) assert.equal(field in family, false);
  await manager.action({ action: 'disable' }); await settled(t, manager);
  assert.equal(manager.status().enabled, false); assert.equal(calls.helperStop, 1); assert.ok(manager.status().certificate.expiresAt);
});

test('completion waiting follows the current operation past the former local poll budget', { timeout: 15000 }, async t => {
  let crossed;
  const { promise: held, release } = heldFixtureWork(t);
  const observedFormerLimit = new Promise(done => { crossed = done; });
  const { manager, installStarted } = await setup(t, { holdInstall: held });
  const accepted = await manager.action({ action: 'enable' }); await fixtureBoundary(t, installStarted);
  let pollTurns = 0, readThisTurn = false, result = null;
  const observed = { status: () => {
    const value = manager.status();
    // Identity checks may reread status synchronously. Count each yielding
    // polling turn once so extra reads cannot shorten the controlled hold.
    if (!readThisTurn) {
      readThisTurn = true; queueMicrotask(() => { readThisTurn = false; });
      if (++pollTurns === 201) crossed();
    }
    return value;
  } };
  const completion = settled(t, observed).then(value => { result = { value }; }, error => { result = { error }; });
  try {
    await fixtureBoundary(t, observedFormerLimit);
    await new Promise(done => setImmediate(done));
    assert.equal(result, null, 'An accepted operation stays pending until its actual fixture work completes');
    assert.equal(manager.status().operation.id, accepted.id);
    assert.equal(manager.status().operation.state, 'running');
    release(); await completion;
    assert.equal(result.error, undefined);
    assert.equal(result.value.operation.id, accepted.id);
    assert.equal(result.value.operation.state, 'completed');
    assert.equal(result.value.phase, 'ready');
  } finally { release(); await completion; }
});

test('completion waiting obeys test cancellation without completing or replacing the operation', { timeout: 15000 }, async t => {
  let entered;
  const { promise: held, release } = heldFixtureWork(t);
  const observedWait = new Promise(done => { entered = done; });
  const { manager, installStarted } = await setup(t, { holdInstall: held });
  const accepted = await manager.action({ action: 'enable' }); await fixtureBoundary(t, installStarted);
  let reads = 0;
  const observed = { status: () => {
    const value = manager.status();
    if (++reads === 2) entered();
    return value;
  } };
  const cancellation = new AbortController();
  const waiting = settled({ signal: AbortSignal.any([t.signal, cancellation.signal]) }, observed);
  try {
    await fixtureBoundary(t, observedWait); cancellation.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    assert.equal(manager.status().operation.id, accepted.id);
    assert.equal(manager.status().operation.state, 'running', 'Cancelling a test wait grants no completion or reset');
    release(); const completed = await settled(t, manager);
    assert.equal(completed.operation.id, accepted.id); assert.equal(completed.operation.state, 'completed');
  } finally { release(); await settled(t, manager); }
});

test('test cancellation releases held fixture work before actual manager cleanup', { timeout: 15000 }, async t => {
  const cancellation = new AbortController();
  const scope = { signal: AbortSignal.any([t.signal, cancellation.signal]), after: t.after.bind(t) };
  const { promise: held, release } = heldFixtureWork(scope);
  const { manager, calls, installStarted } = await setup(t, { holdInstall: held });
  await manager.action({ action: 'enable' }); await fixtureBoundary(t, installStarted);
  const waiting = settled(scope, manager);
  try {
    cancellation.abort(); await assert.rejects(waiting, { name: 'AbortError' });
    await manager.close();
    assert.equal(calls.helperStart, 0, 'The cancelled held SDK cannot resurrect the helper during cleanup');
    assert.equal(calls.activations.length, 0);
  } finally { release(); await manager.close(); }
});

test('missing add-on host identity blocks downloads and Retry resumes without resetting saved state', async t => {
  let available = false; const contexts = [];
  const context = await setup(t, { dependencies: { helperLocations: async (_dataDir, _directory, options) => {
    contexts.push(options);
    if (!available) throw Object.assign(Error(), { code: 'helper_installation_binding_unavailable' });
    const identity = resolve(context.directory, 'https', 'identity'); await privateDirectory(identity);
    return { identity, socketDirectory: identity, socket: resolve(identity, 's'), uid: process.getuid(), gid: process.getgid(), root: false };
  } } });
  context.config.addon = true;
  await context.manager.action({ action: 'enable' }); const failed = await settled(t, context.manager);
  assert.equal(failed.operation.error, 'helper_installation_binding_unavailable');
  assert.equal(context.calls.install, 0); assert.equal(context.calls.preflight, 0); assert.equal(context.calls.helperStart, 0);
  assert.equal(contexts[0].addon, true); assert.equal(contexts[0].restoreFenced, false);
  assert.ok(contexts[0].signal instanceof AbortSignal);
  const saved = JSON.parse(await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8'));
  assert.deepEqual(saved.quarantined, {}); assert.equal(saved.transaction, null);
  await context.manager.close();
  available = true;
  const resumed = restart(t, context); await resumed.action({ action: 'retry' });
  assert.equal((await settled(t, resumed)).phase, 'ready'); assert.equal(context.calls.install, 1);
  assert.equal(JSON.parse(await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8')).machineName, saved.machineName);
});

test('closing during an in-flight Supervisor identity request cancels it before helper installation', async t => {
  let notify; const entered = new Promise(done => { notify = done; }); let cancelled = false;
  const { manager, config, calls } = await setup(t, { dependencies: { helperLocations: (_dataDir, _directory, options) =>
    installationBinding({ ...options, environment: { SUPERVISOR_TOKEN: 'synthetic-supervisor-cancellation' },
      readIdentity: async () => null, fetchImpl: (_url, request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { cancelled = true; reject(Error('Synthetic aborted request')); }, { once: true });
        notify();
      }) }) } });
  config.addon = true;
  await manager.action({ action: 'enable' }); await entered;
  await manager.close();
  assert.equal(cancelled, true); assert.equal(calls.install, 0); assert.equal(calls.preflight, 0); assert.equal(calls.helperStart, 0);
});

test('admin setup readiness and DNS wiring are configuration evidence independent of DNS checks', async t => {
  const { manager, config } = await setup(t);
  config.addon = true;
  let view = manager.status();
  assert.equal(view.environment, 'home-assistant'); assert.equal(view.setup.credentialsReady, true);
  assert.equal(view.dns.expectedAddress, '127.0.0.1'); assert.equal(view.dns.resolver, null);
  config.web.httpsHost = '0.0.0.0'; config.web.lanResolver = '192.0.2.53'; config.familyToken = 'short';
  view = manager.status();
  assert.equal(view.setup.credentialsReady, false); assert.equal(view.dns.expectedAddress, null);
  assert.equal(view.dns.resolver, '192.0.2.53'); assert.equal(view.dns.state, 'not_configured');
  config.familyToken = config.token; assert.equal(manager.status().setup.credentialsReady, false);
  config.familyToken = 'synthetic-distinct-family-password'; assert.equal(manager.status().setup.credentialsReady, true);
});

test('LAN DNS checks retain address evidence and do not conflate TLS readiness with client DNS', async t => {
  const unavailable = Object.assign(Error(), { code: 'ETIMEOUT' }); const absent = Object.assign(Error(), { code: 'ENODATA' });
  const cases = [
    { name: 'intended IPv4', a: ['192.0.2.44'], aaaa: [], expected: 'ready' },
    { name: 'different IPv4', a: ['192.0.2.45'], aaaa: [], expected: 'mismatch' },
    { name: 'competing IPv6', a: ['192.0.2.44'], aaaa: ['2001:db8::44'], expected: 'mismatch' },
    { name: 'missing AAAA', a: ['192.0.2.44'], aaaa: absent, expected: 'ready' },
    { name: 'missing IPv4', a: absent, aaaa: [], expected: 'mismatch' },
    { name: 'unavailable IPv4 query', a: unavailable, aaaa: ['2001:db8::44'], expected: 'unavailable' },
    { name: 'unavailable IPv6 query', a: ['192.0.2.44'], aaaa: unavailable, expected: 'unavailable' },
    { name: 'wildcard binding has no confirmed target', a: ['192.0.2.44'], aaaa: [], host: '0.0.0.0', expected: 'address_confirmation_required' },
  ];
  for (const scenario of cases) await t.test(scenario.name, async t => {
    const queries = [];
    const { manager, config } = await setup(t, { dependencies: { createResolver: options => {
      assert.equal(options.timeout, 3000); assert.equal(options.tries, 1);
      return { setServers: servers => assert.deepEqual(servers, ['192.0.2.53']),
        resolve4: async name => { queries.push(['A', name]); if (scenario.a instanceof Error) throw scenario.a; return scenario.a; },
        resolve6: async name => { queries.push(['AAAA', name]); if (scenario.aaaa instanceof Error) throw scenario.aaaa; return scenario.aaaa; } };
    } } });
    config.web.httpsHost = scenario.host ?? '192.0.2.44'; config.web.lanResolver = '192.0.2.53';
    await manager.action({ action: 'enable' }); const view = await settled(t, manager);
    assert.equal(view.phase, 'ready'); assert.equal(view.dns.state, scenario.expected);
    assert.deepEqual(view.dns.a, scenario.a instanceof Error ? [] : scenario.a);
    assert.deepEqual(view.dns.aaaa, scenario.aaaa instanceof Error ? [] : scenario.aaaa);
    assert.deepEqual(queries, [['A', hostname], ['AAAA', hostname]]);
  });
});

test('duplicate setup clicks share one durable operation and cannot install concurrently', async t => {
  let release; const held = new Promise(resolveHeld => { release = resolveHeld; });
  const { manager, calls, installStarted } = await setup(t, { holdInstall: held });
  t.after(() => release());
  const operations = await Promise.all(Array.from({ length: 30 }, () => manager.action({ action: 'enable' })));
  assert.equal(new Set(operations.map(operation => operation.id)).size, 1);
  await installStarted; assert.equal(calls.install, 1); release(); await settled(t, manager); assert.equal(calls.helperStart, 1);
});

test('initial operation journal failure is rejected synchronously without a detached rejection', async t => {
  const { manager, directory } = await setup(t);
  manager.start(); await wait(20); await privateDirectory(resolve(directory, 'https')); await mkdir(resolve(directory, 'https', 'state.json'), { mode: 0o700 });
  await assert.rejects(manager.action({ action: 'set-update-policy', policy: 'manual' }), { code: 'https_state_write_failed' });
  assert.equal(manager.status().operation.state, 'failed');
});

test('closing during an outstanding install cannot resurrect a helper or listener', async t => {
  let release; const held = new Promise(resolveHeld => { release = resolveHeld; });
  const { manager, calls, installStarted } = await setup(t, { holdInstall: held });
  t.after(() => release());
  await manager.action({ action: 'enable' }); await installStarted;
  const closed = manager.close(); release(); await closed;
  assert.equal(calls.helperStart, 0); assert.equal(calls.activations.length, 0); assert.equal(manager.status().helper.state, 'stopped');
});

test('network outages do not quarantine a valid candidate and explicit Retry recovers initial setup', async t => {
  const { manager, calls } = await setup(t, { downloadFailures: 1 });
  await manager.action({ action: 'enable' }); await settled(t, manager);
  assert.equal(manager.status().operation.error, 'vendor_download_unavailable');
  await manager.action({ action: 'retry' }); await settled(t, manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 2);
});

test('explicit Retry permits a previously quarantined failed preflight without silently restoring an old identity', async t => {
  const { manager, calls } = await setup(t, { preflightFailures: 1 });
  await manager.action({ action: 'enable' }); await settled(t, manager);
  assert.equal(manager.status().operation.error, 'helper_command_failed');
  await manager.action({ action: 'retry' }); await settled(t, manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 2); assert.equal(calls.helperStart, 1);
});

test('invalid/obsolete state and path traversal fail closed before mutations', async t => {
  const { directory, manager } = await setup(t);
  await privateDirectory(resolve(directory, 'https')); const path = resolve(directory, 'https', 'state.json');
  const value = { version: 0, enabled: true, runtime: { name: '../../../other' } };
  await atomicJson(path, value); manager.start(); await wait(20);
  await assert.rejects(manager.action({ action: 'enable' }), { code: 'https_state_invalid' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), value);
});

test('pending authorization stays resumable and its private link is admin only', async t => {
  const { manager, setRunning, calls } = await setup(t); setRunning(false);
  await manager.action({ action: 'enable' }); await settled(t, manager);
  assert.equal(manager.status().phase, 'authorization_required'); assert.equal(manager.status().helper.authorizationUrl, 'https://login.tailscale.com/a/synthetic');
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes('login.tailscale.com'), false);
  setRunning(true); await manager.action({ action: 'recheck' }); await settled(t, manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 1);
});

for (const action of ['recheck', 'enable']) test(`an explicit ${action} adopts a same-helper rename only after a matching new certificate is published`, async t => {
  const context = await setup(t); const { manager, calls } = context;
  await manager.action({ action: 'enable' }); const original = await settled(t, manager);
  const renamed = 'renamed.test-tailnet.ts.net'; context.setReportedHostname(renamed); context.setCertificateId(2);
  await manager.configure(); await diagnosed(t, manager); await wait(10);
  const waiting = manager.status();
  assert.equal(waiting.error, 'helper_hostname_changed'); assert.equal(waiting.hostname, hostname);
  assert.equal(waiting.certificate.generation, original.certificate.generation); assert.equal(calls.certificate, 1);
  await manager.action({ action }); const adopted = await settled(t, manager);
  assert.equal(adopted.operation.state, 'completed');
  assert.equal(adopted.hostname, renamed); assert.equal(adopted.url, `https://${renamed}:8443`);
  assert.equal(adopted.certificate.hostname, renamed); assert.equal(adopted.certificate.generation, 2);
  assert.equal(calls.certificateNames.at(-1), renamed); assert.equal(calls.activationNames.at(-1), renamed);
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes(renamed), false);
  await manager.close(); const current = restart(t, context); current.start();
  await fixtureCondition(t, () => current.status().phase === 'ready');
  assert.equal(current.status().hostname, renamed); assert.equal(current.status().certificate.generation, 2);
  await current.close();
});

for (const failure of ['validation', 'activation', 'durable-write', 'pair-binding']) test(`a renamed certificate ${failure} failure keeps the old durable address and published peer generation`, async t => {
  let peerGeneration = 0; let currentPairId = 'rename-publication'; const delivered = [];
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: currentPairId, localId: 'local-node', peerId: 'peer-node' }),
    request: async (operation, envelope) => {
      if (operation === 'status') return { nodeId: 'peer-node', pairId: 'rename-publication', ownerId: 'local-node', enabled: true, generation: peerGeneration };
      assert.equal(operation, 'receive'); delivered.push(structuredClone(envelope)); peerGeneration = envelope.generation;
    } };
  const context = await setup(t, { pair }); context.config.topology = 'pair';
  await context.manager.action({ action: 'enable', owner: 'local' }); const old = await settled(t, context.manager); await context.manager.close();
  let notify, release; const entered = new Promise(done => { notify = done; }), held = new Promise(done => { release = done; });
  const renamed = 'renamed.test-tailnet.ts.net'; const activated = [];
  const current = restart(t, context, { pair,
    dependencies: { validateCertificate: async (material, name) => {
      if (name === renamed && failure === 'validation') { notify(); await held; throw Object.assign(Error('Synthetic private validation detail'), { code: 'certificate_chain_untrusted' }); }
      return context.dependencies.validateCertificate(material, name);
    } },
    onCertificate: async ({ certificate, generation, hostname: name }) => {
      activated.push({ generation, name });
      if (generation === 2) {
        notify(); await held;
        if (failure === 'activation') return { listening: false, error: 'tls_port_unavailable' };
      }
      return { listening: true, fingerprint: certificate.metadata.fingerprint };
    } });
  current.start(); await fixtureCondition(t, () => current.status().phase === 'ready'); await wait(10);
  context.setReportedHostname(renamed); context.setCertificateId(2);
  await actionWhenIdle(t, current, { action: 'recheck' }); await entered;
  assert.equal(current.status().hostname, hostname); assert.equal(current.status().url, old.url);
  assert.equal(current.status().certificate.generation, 1);
  const exported = await current.exportCertificate(); assert.equal(exported.hostname, hostname); assert.equal(exported.generation, 1);
  const statePath = resolve(context.directory, 'https', 'state.json'), backupPath = resolve(context.directory, 'https', 'state-before-failed-rename.json');
  if (failure === 'durable-write') { await rename(statePath, backupPath); await mkdir(statePath); }
  if (failure === 'pair-binding') currentPairId = 'changed-pair';
  release(); const failed = await settled(t, current);
  assert.equal(failed.operation.state, 'failed'); assert.equal(failed.hostname, hostname); assert.equal(failed.url, old.url);
  assert.equal(failed.certificate.generation, 1); assert.equal(failed.certificate.fingerprint, old.certificate.fingerprint);
  assert.equal(delivered.some(envelope => envelope.generation === 2), false);
  assert.equal(JSON.stringify(failed).includes('private validation detail'), false);
  if (failure === 'durable-write') { await rm(statePath, { recursive: true }); await rename(backupPath, statePath); }
  if (failure === 'pair-binding') currentPairId = 'rename-publication';
  const saved = JSON.parse(await readFile(statePath, 'utf8')); assert.equal(saved.hostname, hostname); assert.equal(saved.certificate.generation, 1);
  if (failure !== 'validation') assert.deepEqual(activated.at(-1), { generation: 1, name: hostname }, 'Rollback reactivates the old certificate with its original hostname');
  await current.close(); const recovered = restart(t, context, { pair }); recovered.start();
  await fixtureCondition(t, () => recovered.status().error === 'helper_hostname_changed');
  assert.equal(recovered.status().hostname, hostname); assert.equal(recovered.status().certificate.generation, 1);
  await recovered.close();
});

test('an authenticated bound certificate owner can deliver a strictly newer same-tailnet renamed certificate', async t => {
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'rename-pair', localId: 'local-node', peerId: 'peer-node' }),
    request: async operation => operation === 'status'
      ? { nodeId: 'peer-node', ownerId: 'peer-node', pairId: 'rename-pair', enabled: true }
      : { pairId: 'rename-pair', ownerId: 'peer-node', hostname, generation: 1, certificate: { cert: 'fixture-peer-original', key: 'fixture-key-original' } } };
  const { manager, config, calls } = await setup(t, { pair }); config.topology = 'pair';
  await manager.action({ action: 'enable', owner: 'peer' }); const original = await settled(t, manager);
  assert.equal(original.hostname, hostname);
  const renamed = 'renamed.test-tailnet.ts.net';
  await manager.acceptCertificate({ pairId: 'rename-pair', ownerId: 'peer-node', hostname: renamed,
    generation: 2, certificate: { cert: 'fixture-peer-renamed', key: 'fixture-key-renamed' } });
  const accepted = manager.status(); assert.equal(accepted.hostname, renamed); assert.equal(accepted.certificate.generation, 2);
  assert.equal(calls.activationNames.at(-1), renamed); assert.equal(calls.install, 0); assert.equal(calls.helperStart, 0);
  const rejected = [
    { pairId: 'different-pair', ownerId: 'peer-node', hostname, generation: 3 },
    { pairId: 'rename-pair', ownerId: 'different-owner', hostname, generation: 3 },
    { pairId: 'rename-pair', ownerId: 'peer-node', hostname, generation: 2 },
    { pairId: 'rename-pair', ownerId: 'peer-node', hostname, generation: 1 },
    { pairId: 'rename-pair', ownerId: 'peer-node', hostname: 'renamed.other-tailnet.ts.net', generation: 3 },
  ];
  const before = await readFile(resolve(config.dataDir, 'https', 'state.json'));
  for (const envelope of rejected) {
    await assert.rejects(manager.acceptCertificate({ ...envelope, certificate: { cert: 'fixture-rejected', key: 'fixture-rejected' } }));
    assert.deepEqual(await readFile(resolve(config.dataDir, 'https', 'state.json')), before);
    assert.equal(manager.status().hostname, renamed); assert.equal(manager.status().certificate.generation, 2);
  }
  const stagedPath = resolve(config.dataDir, 'https', 'certificates', '3.json');
  await atomicJson(stagedPath, { version: 1, hostname: renamed, generation: 3, certificate: { cert: 'fixture-staged-third', key: 'fixture-staged-key' } });
  const stagedBytes = await readFile(stagedPath);
  await assert.rejects(manager.acceptCertificate({ pairId: 'rename-pair', ownerId: 'peer-node', hostname: renamed, generation: 3,
    certificate: { cert: 'fixture-different-third', key: 'fixture-different-key' } }), { code: 'certificate_generation_collision' });
  assert.deepEqual(await readFile(stagedPath), stagedBytes); assert.equal(manager.status().certificate.generation, 2);
});

test('explicit rename cannot adopt a different Tailscale network', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  context.setReportedHostname('renamed.other-tailnet.ts.net'); context.setCertificateId(2);
  await context.manager.action({ action: 'recheck' }); const blocked = await settled(t, context.manager);
  assert.equal(blocked.operation.error, 'helper_tailnet_changed'); assert.equal(blocked.hostname, hostname);
  assert.equal(blocked.certificate.generation, 1); assert.equal(context.calls.certificate, 1);
});

test('explicit rename requires a fresh successful effective restriction readback from its current helper', async t => {
  let activeHelper, name = hostname, invalid = false, certificateId = 1;
  const prefs = { CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
    ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
    AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false };
  const server = createServer((request, response) => {
    if (activeHelper?.expectedStop) { response.writeHead(503); response.end(); return; }
    const body = request.url === '/localapi/v0/serve-config' ? {} : request.url === '/localapi/v0/prefs'
      ? { ...prefs, ShieldsUp: !invalid } : { Version: '1.104.1-fixture', BackendState: 'Running', CertDomains: [name], AuthURL: '' };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  const context = await setup(t, { dependencies: { createHelper: options => {
    const helper = new CertificateHelper(options);
    helper.remoteAccess = async () => {};
    helper.start = async () => {
      activeHelper = helper; helper.expectedStop = false;
      await writeFile(resolve(options.locations.identity, 'tailscaled.state'), '{}', { mode: 0o600 });
      if (!server.listening) await new Promise(done => server.listen(options.locations.socket, done));
    };
    helper.cli = async () => {};
    helper.certificate = async () => ({ cert: `fixture-restricted-cert-${certificateId}`, key: `fixture-restricted-key-${certificateId}` });
    return helper;
  } } });
  await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  name = 'renamed.test-tailnet.ts.net'; invalid = true; certificateId = 2;
  await context.manager.action({ action: 'recheck' }); const refused = await settled(t, context.manager);
  assert.equal(refused.operation.error, 'helper_restrictions_not_confirmed'); assert.equal(activeHelper.expectedStop, true);
  assert.equal(refused.helper.state, 'stopped'); assert.equal(refused.hostname, hostname); assert.equal(refused.certificate.generation, 1);
  assert.equal(refused.remoteAccess.state, 'unavailable', 'Stopped helper cannot retain a configured remote-access claim');
  await assert.rejects(lstat(resolve(context.directory, 'https', 'certificates', '2.json')), { code: 'ENOENT' });
  await context.manager.close();
});

for (const scenario of ['enable', 'retry', 'stale-pending-recheck', 'restriction-refusal', 'current-needs-login']) test(`fresh current Running ${scenario} preserves current authentication and restriction boundaries`, async t => {
  let activeHelper, upCalls = 0, restrictions = 0;
  let backend = scenario === 'stale-pending-recheck' ? 'NeedsLogin' : 'Running';
  const prefs = { Hostname: 'synthetic-initial-hostname', CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
    ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
    AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false };
  const server = createServer((request, response) => {
    if (activeHelper?.expectedStop) { response.writeHead(503); response.end(); return; }
    if (request.url === '/localapi/v0/prefs') restrictions++;
    const body = request.url === '/localapi/v0/serve-config' ? {} : request.url === '/localapi/v0/prefs' ? prefs
      : { Version: '1.104.1-fixture', BackendState: backend, CertDomains: backend === 'Running' ? [hostname] : [],
        AuthURL: backend === 'NeedsLogin' ? 'https://login.tailscale.com/a/currentfixture' : '' };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  const context = await setup(t, { dependencies: { createHelper: options => {
    const helper = new CertificateHelper(options);
    helper.remoteAccess = async () => {};
    helper.start = async () => {
      activeHelper = helper; helper.expectedStop = false;
      await writeFile(resolve(options.locations.identity, 'tailscaled.state'), '{}', { mode: 0o600 });
      if (!server.listening) await new Promise(done => server.listen(options.locations.socket, done));
    };
    helper.cli = async args => {
      if (args[0] === 'up') {
        upCalls++;
        // Pinned vendor up.go assigns its explicit hostname to prefs.Hostname;
        // this does not claim that a console-selected DNS name is reset.
        prefs.Hostname = args.find(value => value.startsWith('--hostname=')).slice('--hostname='.length);
      }
    };
    helper.certificate = async () => ({ cert: 'fixture-authenticated-cert', key: 'fixture-authenticated-key' });
    return helper;
  } } });
  await context.manager.action({ action: 'enable' }); const original = await settled(t, context.manager);
  if (scenario === 'stale-pending-recheck') assert.equal(original.helper.state, 'authorization_required');
  const before = upCalls, beforeRestrictions = restrictions;
  backend = 'Running'; prefs.Hostname = 'synthetic-owner-chosen-hostname';
  if (scenario === 'restriction-refusal') prefs.ShieldsUp = false;
  if (scenario === 'current-needs-login') backend = 'NeedsLogin';
  const action = ['restriction-refusal', 'current-needs-login'].includes(scenario) ? 'retry' : scenario === 'stale-pending-recheck' ? 'recheck' : scenario;
  await context.manager.action({ action }); const observed = await settled(t, context.manager);
  if (scenario === 'restriction-refusal') {
    assert.equal(observed.operation.error, 'helper_restrictions_not_confirmed'); assert.equal(observed.helper.state, 'stopped');
    assert.equal(activeHelper.expectedStop, true); assert.equal(upCalls, before);
    assert.equal(observed.certificate.generation, 1); await context.manager.close(); return;
  }
  if (scenario === 'current-needs-login') {
    assert.equal(observed.operation.state, 'completed'); assert.equal(observed.helper.state, 'authorization_required');
    assert.equal(upCalls, before + 1, 'Cached Running does not bypass a current login-needed observation');
    assert.equal(Boolean(observed.helper.authorizationUrl), true); assert.equal(observed.certificate.generation, 1);
    await context.manager.close(); return;
  }
  assert.equal(observed.operation.state, 'completed'); assert.equal(observed.phase, 'ready');
  assert.equal(upCalls, before, 'Fresh authenticated status does not dispatch up with an obsolete bootstrap hostname');
  assert.equal(prefs.Hostname, 'synthetic-owner-chosen-hostname');
  assert(restrictions > beforeRestrictions, 'Full effective restrictions remain freshly confirmed');
  assert.equal(observed.helper.restrictionsVerified, true); await context.manager.close();
});

for (const boundary of ['closed', 'changed-pair', 'wrong-version']) test(`a current Running refresh respects the ${boundary} fence before native writes`, async t => {
  let currentPairId = 'authentication-pair', hold = false, upCalls = 0, restrictions = 0, notify, release;
  const entered = new Promise(done => { notify = done; }), held = new Promise(done => { release = done; });
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: currentPairId, localId: 'local-node', peerId: 'peer-node' }),
    request: async () => ({ nodeId: 'peer-node', pairId: 'authentication-pair', ownerId: 'local-node', enabled: false }) };
  const context = await setup(t); await context.manager.close(); context.config.topology = 'pair';
  const baseHelper = context.dependencies.createHelper;
  context.dependencies.createHelper = options => { const base = baseHelper(options); return { ...base,
    status: async () => { if (hold) { notify(); await held; } return { ...await base.status(), Version: hold && boundary === 'wrong-version' ? '1.106.0-fixture' : '1.104.1-fixture' }; },
    restrictions: async () => { restrictions++; },
    authorize: async () => { upCalls++; return base.authorize(); },
  }; };
  const current = restart(t, context, { pair });
  await current.action({ action: 'enable', owner: 'local' }); await settled(t, current);
  const beforeUp = upCalls, beforeRestrictions = restrictions; hold = true;
  await current.action({ action: 'retry' }); await entered;
  let closing;
  if (boundary === 'closed') closing = current.close();
  if (boundary === 'changed-pair') currentPairId = 'changed-authentication-pair';
  release(); const failed = await settled(t, current);
  assert.equal(failed.operation.error, { closed: 'https_manager_closed', 'changed-pair': 'https_pair_identity_changed', 'wrong-version': 'helper_running_version_mismatch' }[boundary]);
  assert.equal(upCalls, beforeUp); assert.equal(restrictions, beforeRestrictions); assert.equal(failed.certificate.generation, 1);
  if (closing) await closing;
  currentPairId = 'authentication-pair'; await current.close();
});

for (const comparison of ['matching', 'older']) test(`current admitted ${comparison} release state with an unknown check clock cannot claim a last checked release`, async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  await context.manager.action({ action: 'check-updates' }); await settled(t, context.manager); await context.manager.close();
  const path = resolve(context.directory, 'https', 'state.json'); const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.updates.lastSuccessfulCheck = null;
  if (comparison === 'older') saved.updates.latest = '1.104.0';
  await atomicJson(path, saved);
  const current = restart(t, context); current.start();
  await fixtureCondition(t, () => current.status().phase === 'ready');
  const status = current.status(); assert.equal(status.error, null, 'The actual current strict state reader admits the null observation clock');
  assert.equal(status.updates.latest, comparison === 'older' ? '1.104.0' : status.updates.installed);
  assert.equal(status.updates.lastSuccessfulCheck, null);
  const view = secureWebAccessView(status, { admin: true }); assert.equal(view.checked, 'Not checked');
  assert.doesNotMatch(view.releaseSummary, /last checked|Up to date/, 'A missing source clock cannot become a claim that a timed release check exists');
  await current.close();
});

for (const recovery of ['interrupted-restart', 'forward-retry']) test(`a state rename followed by failed directory sync retains complete certificate material for ${recovery}`, { timeout: 15000 }, async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  const renamed = 'renamed.test-tailnet.ts.net'; context.setReportedHostname(renamed); context.setCertificateId(2);
  const directory = resolve(context.directory, 'https'), statePath = resolve(directory, 'state.json');
  const scratch = await open(resolve(context.directory, 'file-handle-prototype'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(scratch), originalSync = prototype.sync; await scratch.close();
  let notify, release, injected = false, paused = false, timer;
  const entered = new Promise(done => { notify = done; }), held = new Promise(done => { release = done; });
  prototype.sync = async function (...args) {
    const path = await readlink(`/proc/self/fd/${this.fd}`).catch(() => null);
    if (!injected && path === directory && JSON.parse(await readFile(statePath, 'utf8')).certificate?.generation === 2) {
      injected = true; throw Object.assign(Error('Synthetic parent directory sync failed after rename'), { code: 'synthetic_parent_sync_failed' });
    }
    if (injected && !paused && path?.startsWith(resolve(directory, '.write-'))
        && JSON.parse(await readFile(path, 'utf8')).operation?.state === 'failed') {
      paused = true; notify(); await held;
    }
    return originalSync.apply(this, args);
  };
  let selectedBytes;
  try {
    await context.manager.action({ action: 'recheck' });
    await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The current failed-operation write boundary is reached')), 5000); })]);
    clearTimeout(timer); assert.equal(injected, true); assert.equal(paused, true);
    selectedBytes = await readFile(statePath); const selected = JSON.parse(selectedBytes);
    assert.equal(selected.hostname, renamed); assert.equal(selected.certificate.generation, 2);
    const material = JSON.parse(await readFile(resolve(directory, 'certificates', '2.json'), 'utf8'));
    assert.equal(material.hostname, selected.hostname); assert.equal(material.generation, selected.certificate.generation);
    assert.equal(context.manager.status().hostname, hostname); assert.equal(context.manager.status().certificate.generation, 1);
    await lstat(resolve(directory, 'certificates', '1.json'));
  } finally {
    clearTimeout(timer); prototype.sync = originalSync; release(); await settled(t, context.manager);
  }
  if (recovery === 'forward-retry') {
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).certificate.generation, 1);
    context.setCertificateId(3);
    await context.manager.action({ action: 'recheck' }); const recovered = await settled(t, context.manager);
    assert.equal(recovered.operation.state, 'completed'); assert.equal(recovered.hostname, renamed);
    assert.equal(recovered.certificate.generation, 3, 'Different new issuer material advances beyond the uncertain immutable orphan');
    await assert.rejects(lstat(resolve(directory, 'certificates', '2.json')), { code: 'ENOENT' });
    await context.manager.close();
  } else {
    await context.manager.close();
    // Simulate interruption at the exact captured filesystem boundary, using
    // the same fixture installation and complete current generation bytes.
    await atomicJson(statePath, JSON.parse(selectedBytes));
    const recovered = restart(t, context); recovered.start();
    await fixtureCondition(t, () => recovered.status().phase === 'ready');
    assert.equal(recovered.status().hostname, renamed); assert.equal(recovered.status().certificate.generation, 2);
    assert.equal(recovered.status().operation.state, 'interrupted'); assert.equal(context.calls.certificate, 2);
    await recovered.close();
  }
});

test('owner generation allocation rejects safe-integer exhaustion without replacing an accepted generation', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  await atomicJson(resolve(context.directory, 'https', 'certificates', `${Number.MAX_SAFE_INTEGER}.json`),
    { version: 1, hostname, generation: Number.MAX_SAFE_INTEGER, certificate: { cert: 'fixture-orphan', key: 'fixture-orphan' } });
  context.setReportedHostname('renamed.test-tailnet.ts.net'); context.setCertificateId(2);
  await context.manager.action({ action: 'recheck' }); const blocked = await settled(t, context.manager);
  assert.equal(blocked.operation.error, 'certificate_generation_invalid'); assert.equal(blocked.hostname, hostname);
  assert.equal(blocked.certificate.generation, 1); await lstat(resolve(context.directory, 'https', 'certificates', '1.json'));
  await assert.rejects(lstat(resolve(context.directory, 'https', 'certificates', '2.json')), { code: 'ENOENT' });
});

async function securityFixture(t, initialInfo) {
  const context = await setup(t); await context.manager.close();
  let info = initialInfo, now = Date.now(), reads = 0;
  const baseHelper = context.dependencies.createHelper;
  const observation = async base => {
    reads++; const value = await base.status();
    return info === undefined ? value : { ...value, ClientVersion: structuredClone(info) };
  };
  context.dependencies.now = () => now;
  context.dependencies.createHelper = options => { const base = baseHelper(options); return { ...base,
    status: async () => observation(base), authorize: async () => observation(base) };
  };
  const manager = restart(t, context);
  const poll = async () => {
    const before = reads; await manager.configure();
    await fixtureCondition(t, () => reads > before);
    assert(reads > before); await wait(20);
  };
  return { context, manager, poll, setInfo: value => { info = value; }, advance: ms => { now += ms; } };
}

test('current vendor urgent evidence is durable once, preserves its original clock and resolves on explicit RunningLatest', async t => {
  const fixture = await securityFixture(t, { UrgentSecurityUpdate: true, LatestVersion: '1.104.2' });
  const { manager, context } = fixture;
  await manager.action({ action: 'enable' }); await settled(t, manager);
  await manager.action({ action: 'check-updates' }); await settled(t, manager);
  const path = resolve(context.directory, 'https', 'state.json');
  const originalBytes = await readFile(path), originalStat = await stat(path, { bigint: true });
  const originalSignal = JSON.parse(originalBytes).updates.securitySignal;
  assert.equal(originalSignal.urgent, true); assert.equal(manager.status().helper.securityUpdate, true);
  fixture.advance(1000);
  for (let i = 0; i < 3; i++) await fixture.poll();
  assert.deepEqual(await readFile(path), originalBytes);
  const unchangedStat = await stat(path, { bigint: true });
  assert.equal(unchangedStat.ino, originalStat.ino); assert.equal(unchangedStat.mtimeNs, originalStat.mtimeNs, 'Identical positive reports do not rewrite or fsync state each poll');
  for (const unknown of [undefined, { UrgentSecurityUpdate: 'true', RunningLatest: true }, { UrgentSecurityUpdate: true, RunningLatest: 'true' }]) {
    fixture.setInfo(unknown); await fixture.poll();
    assert.equal(manager.status().helper.securityUpdate, true, 'Absent or malformed metadata cannot erase an unresolved real warning');
    assert.equal(manager.status().helper.securityObservedAt, originalSignal.observedAt);
  }
  fixture.setInfo({ RunningLatest: true }); fixture.advance(1000);
  await actionWhenIdle(t, manager, { action: 'recheck' }); const resolved = await settled(t, manager);
  assert.equal(resolved.helper.runningLatest, true); assert.equal(resolved.helper.securityUpdate, false);
  const saved = JSON.parse(await readFile(path, 'utf8')).updates.securitySignal;
  assert.equal(saved.urgent, false); assert.equal(saved.observedAt, originalSignal.observedAt); assert(saved.resolvedAt > saved.observedAt);
  const view = secureWebAccessView(resolved, { admin: true }); assert.equal(view.securityWarning, ''); assert.equal(view.securityStatus, 'No urgent update reported');
  fixture.setInfo(undefined); await fixture.poll();
  assert.equal(manager.status().helper.securityUpdate, null); assert.equal(manager.status().helper.runningLatest, null);
  assert.equal(secureWebAccessView(manager.status(), { admin: true }).securityStatus, 'Not reported');
  await manager.close();
});

test('failed urgent-signal persistence retries identical evidence and keeps the successfully saved warning across restart', async t => {
  const fixture = await securityFixture(t); const { context, manager } = fixture;
  await manager.action({ action: 'enable' }); await settled(t, manager);
  const directory = resolve(context.directory, 'https'), path = resolve(directory, 'state.json');
  const scratch = await open(resolve(context.directory, 'security-file-handle-prototype'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(scratch), originalSync = prototype.sync; await scratch.close(); let injected = false;
  prototype.sync = async function (...args) {
    const target = await readlink(`/proc/self/fd/${this.fd}`).catch(() => null);
    if (!injected && target === directory && JSON.parse(await readFile(path, 'utf8')).updates.securitySignal?.urgent === true) {
      injected = true; throw Object.assign(Error('Synthetic private warning persistence detail'), { code: 'synthetic_security_sync_failed' });
    }
    return originalSync.apply(this, args);
  };
  fixture.setInfo({ UrgentSecurityUpdate: true });
  try {
    await manager.action({ action: 'recheck' }); const failed = await settled(t, manager);
    assert.equal(injected, true); assert.equal(failed.operation.state, 'failed');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).updates.securitySignal, null);
    assert.equal(JSON.stringify(failed).includes('private warning persistence detail'), false);
  } finally { prototype.sync = originalSync; }
  await manager.action({ action: 'recheck' }); const saved = await settled(t, manager);
  assert.equal(saved.operation.state, 'completed'); assert.equal(saved.helper.securityUpdate, true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).updates.securitySignal.urgent, true);
  await manager.close(); const restarted = restart(t, context); restarted.start();
  await fixtureCondition(t, () => restarted.status().phase === 'ready');
  assert.equal(restarted.status().helper.securityUpdate, true); await restarted.close();
});

test('current package equality does not imply security metadata or an eligible update', async t => {
  const fixture = await securityFixture(t); const { manager, context } = fixture;
  await manager.action({ action: 'enable' }); await settled(t, manager);
  await manager.action({ action: 'check-updates' }); const checked = await settled(t, manager);
  assert.equal(checked.updates.installed, '1.104.1'); assert.equal(checked.updates.latest, '1.104.1'); assert.equal(checked.updates.candidate, null);
  assert.equal(checked.helper.securityUpdate, null); assert.equal(checked.helper.runningLatest, null);
  const view = secureWebAccessView(checked, { admin: true }); assert.equal(view.updateAvailable, false);
  assert.match(view.releaseSummary, /Up to date/); assert.equal(view.securityStatus, 'Not reported'); assert.equal(view.securityWarning, '');
  const installations = context.calls.install, starts = context.calls.helperStart;
  await manager.action({ action: 'update-now' }); const refused = await settled(t, manager);
  assert.equal(refused.operation.error, 'helper_update_not_available'); assert.equal(context.calls.install, installations); assert.equal(context.calls.helperStart, starts);
  await manager.close();
});

test('restart resumes previously requested HTTPS enrollment when the helper lost its private sign-in URL', async t => {
  let activeHelper; let AuthURL = ''; let authorizations = 0; let starts = 0;
  const identities = [];
  const prefs = { CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
    ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
    AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false };
  const server = createServer((request, response) => {
    if (activeHelper?.expectedStop) { response.writeHead(503); response.end(); return; }
    const body = request.url === '/localapi/v0/serve-config' ? {} : request.url === '/localapi/v0/prefs' ? prefs
      : { Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL, CertDomains: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  const context = await setup(t, { dependencies: { createHelper: options => {
    const helper = new CertificateHelper(options);
    helper.remoteAccess = async () => {};
    helper.start = async () => {
      starts++; identities.push(options.locations.identity); activeHelper = helper; helper.expectedStop = false;
      AuthURL = '';
      const path = resolve(options.locations.identity, 'tailscaled.state');
      if (!(await lstat(path).catch(() => null))) await writeFile(path, 'synthetic unchanged managed identity', { mode: 0o600 });
      if (!server.listening) await new Promise(done => server.listen(options.locations.socket, done));
    };
    helper.cli = async args => {
      if (args[0] === 'up') { authorizations++; AuthURL = 'https://login.tailscale.com/a/syntheticrestart'; }
    };
    return helper;
  } } });
  await context.manager.action({ action: 'enable' }); const first = await settled(t, context.manager);
  assert.equal(first.phase, 'authorization_required'); assert.equal(Boolean(first.helper.authorizationUrl), true);
  const identity = await readFile(resolve(identities[0], 'tailscaled.state'));
  assert.equal(authorizations, 1); await context.manager.close();
  const current = restart(t, context); current.start();
  await fixtureCondition(t, () => current.status().phase === 'authorization_required');
  const view = current.status();
  assert.equal(view.enabled, true); assert.equal(view.phase, 'authorization_required');
  assert.equal(Boolean(view.helper.authorizationUrl), true, 'The current restarted helper must provide a new link without another setup click');
  assert.equal(authorizations, 2, 'Each explicitly requested helper lifecycle resumes enrollment once');
  assert.equal(starts, 2); assert.equal(identities[1], identities[0]); assert.equal(context.calls.install, 1);
  assert.deepEqual(await readFile(resolve(identities[1], 'tailscaled.state')), identity);
  assert.equal(JSON.stringify(current.status({ admin: false })).includes('login.tailscale.com'), false);
  await current.close();
});

for (const backend of ['Running', 'NeedsMachineAuth', 'NeedsLogin']) test(`restart observes ${backend} with existing authorization evidence without requesting another sign-in`, async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  await context.manager.close(); let authorizations = 0; let reads = 0;
  const observation = { Version: '1.104.1-fixture', BackendState: backend, CertDomains: backend === 'Running' ? [hostname] : [],
    AuthURL: backend === 'NeedsLogin' ? 'https://login.tailscale.com/a/currentfixture' : '' };
  const current = restart(t, context, { dependencies: { createHelper: options => ({
    ...context.dependencies.createHelper(options),
    status: async () => { reads++; return observation; },
    authorize: async () => { authorizations++; return observation; },
  }) } });
  current.start(); await fixtureCondition(t, () => reads >= 2);
  await current.close(); assert(reads >= 2); assert.equal(authorizations, 0);
  assert.equal(context.calls.install, 1); assert.equal(context.calls.helperStart, 2);
});

test('a disabled saved HTTPS installation does not resume authorization on restart', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  await context.manager.action({ action: 'disable' }); await settled(t, context.manager); await context.manager.close();
  const starts = context.calls.helperStart; let authorizations = 0;
  const current = restart(t, context, { dependencies: { createHelper: options => ({
    ...context.dependencies.createHelper(options), authorize: async () => { authorizations++; },
  }) } });
  current.start(); await wait(30); await current.close();
  assert.equal(current.status().enabled, false); assert.equal(current.status().phase, 'disabled');
  assert.equal(context.calls.helperStart, starts); assert.equal(authorizations, 0); assert.equal(context.calls.install, 1);
});

test('updating the runtime resumes pending enrollment on its newly started helper only once', async t => {
  let currentUrl = '', authorizations = 0;
  const context = await setup(t); context.setRunning(false);
  const existingTask = context.dependencies.runtimeTask;
  context.dependencies.runtimeTask = async (name, data) => name === 'discover'
    ? { metadata: { TarballsVersion: '1.104.2', Tarballs: { [architecture()]: `tailscale_1.104.2_${architecture()}.tgz` } }, etag: 'new-fixture' }
    : existingTask(name, data);
  const existingHelper = context.dependencies.createHelper;
  context.dependencies.createHelper = options => {
    const base = existingHelper(options);
    const version = /\/(\d+\.\d+\.\d+)-/.exec(options.directory)[1];
    const observation = () => ({ Version: `${version}-fixture`, BackendState: 'NeedsLogin', AuthURL: currentUrl });
    return { ...base,
      start: async () => { currentUrl = ''; await base.start(); },
      status: async () => observation(),
      authorize: async () => { authorizations++; currentUrl = 'https://login.tailscale.com/a/currentfixture'; return observation(); },
    };
  };
  // setup captures dependency values at construction; use the actual manager
  // with these current adapters before its first explicit setup.
  await context.manager.close(); const current = restart(t, context);
  await current.action({ action: 'enable' }); const first = await settled(t, current);
  assert.equal(first.phase, 'authorization_required'); assert.equal(authorizations, 1);
  await current.action({ action: 'update-now' }); const updated = await settled(t, current);
  assert.equal(updated.operation.state, 'completed'); assert.equal(updated.phase, 'authorization_required');
  assert.equal(updated.helper.version, '1.104.2'); assert.equal(Boolean(updated.helper.authorizationUrl), true);
  assert.equal(updated.updates.candidate, null);
  assert.equal(authorizations, 2); assert.equal(context.calls.install, 2); assert.equal(context.calls.helperStart, 2);
  await current.configure(); await wait(20); assert.equal(authorizations, 2, 'The new instance is not enrolled again by status polling');
  await current.close();
  const statePath = resolve(context.directory, 'https', 'state.json'), saved = JSON.parse(await readFile(statePath, 'utf8'));
  saved.updates.candidate = releaseCandidate({ TarballsVersion: '1.104.2', Tarballs: { [architecture()]: `tailscale_1.104.2_${architecture()}.tgz` } });
  await atomicJson(statePath, saved);
  const resumed = restart(t, context); resumed.start();
  await fixtureCondition(t, () => resumed.status().helper?.version === '1.104.2');
  assert.equal(resumed.status().updates.candidate, null, 'A current saved vendor candidate equal to installed grants no update availability after restart');
  assert.equal(secureWebAccessView(resumed.status(), { admin: true }).updateAvailable, false);
  assert.equal(context.calls.install, 2); await resumed.close();
});

test('resumed startup authorization still stops a helper whose effective restrictions fail readback', async t => {
  let activeHelper, starts = 0, authorizations = 0, currentUrl = '', invalidRestrictions = false;
  const prefs = { CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
    ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
    AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false };
  const server = createServer((request, response) => {
    if (activeHelper?.expectedStop) { response.writeHead(503); response.end(); return; }
    const body = request.url === '/localapi/v0/serve-config' ? {} : request.url === '/localapi/v0/prefs'
      ? { ...prefs, ShieldsUp: !invalidRestrictions }
      : { Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL: currentUrl };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  const context = await setup(t, { dependencies: { createHelper: options => {
    const helper = new CertificateHelper(options);
    helper.remoteAccess = async () => {};
    helper.start = async () => {
      starts++; currentUrl = ''; invalidRestrictions = false; activeHelper = helper; helper.expectedStop = false;
      if (!server.listening) await new Promise(done => server.listen(options.locations.socket, done));
    };
    helper.cli = async args => {
      if (args[0] === 'up') {
        authorizations++; currentUrl = 'https://login.tailscale.com/a/currentfixture';
        invalidRestrictions = starts === 2;
      }
    };
    return helper;
  } } });
  await context.manager.action({ action: 'enable' }); await settled(t, context.manager); await context.manager.close();
  const current = restart(t, context); current.start(); const failed = await diagnosed(t, current);
  assert.equal(failed.error, 'helper_restrictions_not_confirmed'); assert.equal(failed.phase, 'degraded');
  assert.equal(activeHelper.expectedStop, true); assert.equal(failed.helper.state, 'stopped');
  assert.equal(failed.helper.authorizationUrl ?? null, null, 'An unqualified helper cannot publish an enrollment URL');
  assert.equal(authorizations, 2); assert.equal(context.calls.install, 1);
  await current.close();
});

test('pending startup enrollment renders progress and an unavailable link keeps explicit Retry guidance after failure', async t => {
  const context = await setup(t); context.setRunning(false);
  await context.manager.action({ action: 'enable' }); await settled(t, context.manager); await context.manager.close();
  let release, notify, successful = false, authorizations = 0, reads = 0;
  const held = new Promise(done => { release = done; }), entered = new Promise(done => { notify = done; });
  const observation = () => ({ Version: '1.104.1-fixture', BackendState: 'NeedsLogin',
    AuthURL: successful ? 'https://login.tailscale.com/a/currentfixture' : '' });
  const current = restart(t, context, { dependencies: { createHelper: options => ({
    ...context.dependencies.createHelper(options), status: async () => { reads++; return observation(); },
    authorize: async () => {
      authorizations++;
      if (authorizations === 1) { notify(); await held; }
      if (!successful) throw Object.assign(Error('Synthetic private authorization detail'), { code: 'helper_authorization_start_failed' });
      return observation();
    },
  }) } });
  current.start(); await entered;
  const preparing = secureWebAccessView(current.status(), { admin: true });
  assert.equal(preparing.next.title, 'Setting up HTTPS'); assert.equal(preparing.busy, true);
  assert.equal(preparing.authorizationUrl, null, 'The old daemon link is not reused during restart');
  release(); await diagnosed(t, current); await wait(10);
  assert.equal(JSON.stringify(current.status()).includes('private authorization detail'), false);
  const failed = secureWebAccessView(current.status(), { admin: true });
  assert.equal(failed.busy, false); assert.equal(failed.authorizationUrl, null); assert.equal(failed.retryAvailable, true);
  assert.match(failed.error, /Retry setup/);
  const beforeReads = reads; await current.configure(); await wait(20);
  await current.configure(); await wait(20);
  assert(reads > beforeReads, 'Current status was polled after the failed startup attempt');
  assert.equal(authorizations, 1, 'Polling cannot repeatedly start interactive authorization');
  successful = true; await current.action({ action: 'retry' }); const retried = await settled(t, current);
  assert.equal(authorizations, 2); assert.equal(retried.error, null); assert.equal(retried.helper.restrictionsVerified, true);
  const resumed = secureWebAccessView(retried, { admin: true });
  assert.equal(resumed.next.title, 'Sign in to Tailscale'); assert.equal(Boolean(resumed.authorizationUrl), true);
  assert.equal(JSON.stringify(current.status({ admin: false })).includes('login.tailscale.com'), false);
  await current.close();
});

test('closing during a new helper observation cannot begin implicit startup enrollment afterward', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager);
  await context.manager.close(); let reads = 0, authorizations = 0, notify, release;
  const entered = new Promise(done => { notify = done; }), held = new Promise(done => { release = done; });
  const observation = { Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL: '' };
  const current = restart(t, context, { dependencies: { createHelper: options => ({
    ...context.dependencies.createHelper(options),
    status: async () => { if (++reads === 2) { notify(); await held; } return observation; },
    authorize: async () => { authorizations++; return observation; },
  }) } });
  current.start(); await entered; const closing = current.close(); release(); await closing;
  assert.equal(authorizations, 0); assert.equal(context.calls.install, 1);
});

test('a failed enrollment start is reported and Retry confirms restrictions before exposing its current link', async t => {
  let usable = false; let restrictions = 0;
  const pending = { Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/synthetic' };
  const { manager, calls } = await setup(t, { dependencies: { createHelper: () => ({
    start: async () => {}, stop: async () => {}, restrictions: async () => { restrictions++; },
    status: async () => ({ ...pending, AuthURL: '' }),
    authorize: async () => {
      if (!usable) throw Object.assign(Error('Synthetic private diagnostic'), { code: 'helper_authorization_start_failed' });
      return pending;
    },
  }) } });
  await manager.action({ action: 'enable' }); const failed = await settled(t, manager);
  assert.equal(failed.operation.state, 'failed');
  assert.equal(failed.operation.error, 'helper_authorization_start_failed');
  assert.equal(failed.phase, 'degraded');
  assert.equal(failed.helper.state, 'authorization_required', 'A running process does not establish an authenticated connection');
  assert.equal(failed.error, 'helper_authorization_start_failed');
  assert.equal(JSON.stringify(failed).includes('private diagnostic'), false);
  assert.equal(restrictions, 1, 'The initial helper restrictions remain enforced');
  usable = true;
  await manager.action({ action: 'retry' }); const retried = await settled(t, manager);
  assert.equal(retried.operation.state, 'completed');
  assert.equal(retried.phase, 'authorization_required');
  assert.equal(retried.helper.authorizationUrl, pending.AuthURL);
  assert.equal(retried.error, null, 'A confirmed new enrollment clears only the previous enrollment-start failure');
  assert.equal(restrictions, 2, 'Enrollment is followed by a complete restriction readback');
  assert.equal(calls.install, 1, 'Retry preserves the installed runtime and identity');
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes('login.tailscale.com'), false);
});

test('Retry through the real enrollment producer preserves a start failure until a usable current link exists', async t => {
  let AuthURL = ''; let restrictions = 0;
  const observation = () => ({ Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL });
  const { manager, calls } = await setup(t, { dependencies: { createHelper: () => {
    const helper = new CertificateHelper({ directory: '/synthetic-runtime', locations: {} });
    helper.start = async () => {}; helper.stop = async () => {};
    helper.restrictions = async () => { restrictions++; };
    helper.status = async () => observation();
    helper.cli = async () => { throw Object.assign(Error('Synthetic private CLI failure'), { code: 'helper_command_failed' }); };
    return helper;
  } } });
  await manager.action({ action: 'enable' });
  assert.equal((await settled(t, manager)).operation.error, 'helper_authorization_start_failed');
  for (const invalid of [' ', 'not-a-url', 'http://login.tailscale.com/a/synthetic', 'https://elsewhere.invalid/a/synthetic']) {
    AuthURL = invalid;
    await manager.action({ action: 'retry' }); const failed = await settled(t, manager);
    assert.equal(failed.operation.state, 'failed');
    assert.equal(failed.operation.error, 'helper_authorization_start_failed');
    assert.equal(failed.error, 'helper_authorization_start_failed');
    assert.equal(failed.phase, 'degraded');
    assert.equal(failed.helper.authorizationUrl ?? null, null);
    assert.equal(restrictions, 1, 'No rejected enrollment result is published or admitted as a usable authorization');
    assert.equal(JSON.stringify(failed).includes('private CLI failure'), false);
    assert.equal(JSON.stringify(failed).includes(invalid.trim()) && invalid.trim().length > 0, false);
  }
  AuthURL = 'https://login.tailscale.com/a/synthetic';
  await manager.action({ action: 'retry' }); const pending = await settled(t, manager);
  assert.equal(pending.operation.state, 'completed');
  assert.equal(pending.phase, 'authorization_required');
  assert.equal(pending.error, null);
  assert.equal(pending.helper.authorizationUrl, AuthURL);
  assert.equal(restrictions, 2);
  assert.equal(calls.install, 1, 'All retries retain the existing runtime and identity');
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes(AuthURL), false);
  AuthURL = '';
  await manager.action({ action: 'retry' }); const withdrawn = await settled(t, manager);
  assert.equal(withdrawn.operation.state, 'failed');
  assert.equal(withdrawn.error, 'helper_authorization_start_failed');
  assert.equal(withdrawn.helper.authorizationUrl, null, 'A later failed enrollment cannot republish an earlier authorization link');
  assert.equal(restrictions, 2);
  assert.equal(calls.install, 1);
});

test('Retry restarts a helper stopped by a failed post-enrollment restriction readback without replacing its identity', async t => {
  let activeHelper; let starts = 0; let recoveryAllowed = false; let invalidRestrictions = false; const identities = [];
  const prefs = { CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
    ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
    AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false };
  const server = createServer((request, response) => {
    if (activeHelper?.expectedStop) { response.writeHead(503); response.end(); return; }
    const body = request.url === '/localapi/v0/serve-config' ? {} : request.url === '/localapi/v0/prefs'
      ? { ...prefs, ShieldsUp: !invalidRestrictions }
      : { Version: '1.104.1-fixture', BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/synthetic' };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  t.after(() => new Promise(done => server.close(done)));
  const { manager, calls } = await setup(t, { dependencies: { createHelper: options => {
    const helper = new CertificateHelper(options);
    helper.remoteAccess = async () => {};
    helper.start = async () => {
      starts++; identities.push(options.locations.identity); activeHelper = helper; helper.expectedStop = false; invalidRestrictions = false;
      if (!server.listening) await new Promise(done => server.listen(options.locations.socket, done));
    };
    helper.cli = async args => {
      if (helper.expectedStop) throw Object.assign(Error('Synthetic stopped transport'), { code: 'helper_api_socket_refused' });
      if (args[0] === 'up') invalidRestrictions = !recoveryAllowed;
    };
    return helper;
  } } });
  await manager.action({ action: 'enable' }); const failed = await settled(t, manager);
  assert.equal(failed.operation.state, 'failed');
  assert.equal(failed.operation.error, 'helper_restrictions_not_confirmed');
  assert.equal(activeHelper.expectedStop, true, 'The real restriction producer stops the unqualified helper');
  assert.equal(failed.helper.state, 'stopped');
  assert.equal(failed.helper.authorizationUrl ?? null, null);
  recoveryAllowed = true;
  await manager.action({ action: 'retry' }); const recovered = await settled(t, manager);
  assert.equal(recovered.operation.state, 'completed');
  assert.equal(starts, 2, 'Retry starts a fresh helper object against the existing identity');
  assert.equal(identities[1], identities[0]);
  assert.equal(recovered.phase, 'authorization_required');
  assert.equal(recovered.helper.authorizationUrl, 'https://login.tailscale.com/a/synthetic');
  assert.equal(recovered.helper.restrictionsVerified, true);
  assert.equal(calls.install, 1, 'The validated runtime and identity remain in place');
});

test('a peer certificate recipient never installs or starts a certificate helper and rejects replay', async t => {
  const envelope = { pairId: 'fixture-pair', ownerId: 'peer-node', hostname, generation: 5, certificate: { cert: 'fixture-peer', key: 'fixture-key' } };
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'fixture-pair', localId: 'local-node', peerId: 'peer-node' }), request: async operation => operation === 'status' ?
    { nodeId: 'peer-node', ownerId: 'peer-node', pairId: 'fixture-pair', enabled: true } : envelope };
  const { manager, config, calls } = await setup(t, { pair, dependencies: {
    helperLocations: async () => assert.fail('Certificate recipients cannot look up or admit a helper identity'),
  } }); config.topology = 'pair'; config.addon = true;
  await manager.action({ action: 'enable', owner: 'peer' }); await settled(t, manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 0); assert.equal(calls.helperStart, 0);
  await manager.acceptCertificate(envelope);
  await assert.rejects(manager.acceptCertificate({ ...envelope, generation: 4 }), { code: 'certificate_generation_replayed' });
  await assert.rejects(manager.acceptCertificate({ ...envelope, ownerId: 'wrong-node' }), { code: 'https_certificate_owner_mismatch' });
  await assert.rejects(manager.exportCertificate(), { code: 'https_owner_certificate_unavailable' });
});

test('re-enabling a peer certificate recipient activates its unchanged saved certificate', async t => {
  const envelope = { pairId: 'reenable-pair', ownerId: 'peer-node', hostname, generation: 5,
    certificate: { cert: 'fixture-peer', key: 'fixture-key' } };
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'reenable-pair', localId: 'local-node', peerId: 'peer-node' }),
    request: async operation => operation === 'status'
      ? { nodeId: 'peer-node', ownerId: 'peer-node', pairId: 'reenable-pair', enabled: true } : envelope };
  const changes = { pair };
  const { manager, config, calls, directory } = await setup(t, changes); config.topology = 'pair';
  await manager.action({ action: 'enable', owner: 'peer' }); await settled(t, manager);
  const certificate = manager.status().certificate;
  const path = resolve(directory, 'https', 'certificates', '5.json');
  const bytes = await readFile(path);
  for (let cycle = 0; cycle < 2; cycle++) {
    await manager.action({ action: 'disable' }); await settled(t, manager);
    assert.equal(manager.status().phase, 'disabled');
    const activations = calls.activations.length;
    await manager.action({ action: 'enable' }); const enabled = await settled(t, manager);
    assert.equal(enabled.operation.state, 'completed'); assert.equal(enabled.phase, 'ready');
    assert.equal(calls.activations.length, activations + 1, 'Enable must reopen the listener even when the peer sends the same generation');
    assert.deepEqual(enabled.certificate, certificate);
    assert.equal(enabled.pair.localOwner, false);
    assert.deepEqual(await readFile(path), bytes, 'The immutable certificate is reused without rewriting it');
  }
  await manager.action({ action: 'disable' }); await settled(t, manager);
  changes.activationError = true;
  await manager.action({ action: 'enable' }); const failed = await settled(t, manager);
  assert.equal(failed.operation.state, 'failed'); assert.equal(failed.operation.error, 'tls_port_unavailable');
  assert.notEqual(failed.phase, 'ready'); assert.deepEqual(failed.certificate, certificate);
  changes.activationError = false;
  await manager.action({ action: 'recheck' }); const recovered = await settled(t, manager);
  assert.equal(recovered.phase, 'ready'); assert.equal(recovered.operation.state, 'completed');
  assert.equal(calls.install, 0); assert.equal(calls.helperStart, 0);
});

test('local owner retains renewal responsibility while its enabled peer is offline after local disable', async t => {
  let offline = false; let delivered = 0;
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'fixture-pair', localId: 'local-node', peerId: 'peer-node' }), request: async operation => {
    if (offline) throw Object.assign(Error(), { code: 'https_peer_unavailable' });
    if (operation === 'status') return { nodeId: 'peer-node', pairId: 'fixture-pair', ownerId: 'local-node', enabled: true, generation: 0 };
    delivered++; return {};
  } };
  const { manager, config, calls } = await setup(t, { pair }); config.topology = 'pair';
  await manager.action({ action: 'enable', owner: 'local' }); await settled(t, manager); assert.ok(delivered > 0);
  offline = true; await manager.action({ action: 'disable' }); await settled(t, manager);
  assert.equal(manager.status().enabled, false); assert.equal(manager.status().pair.peerRenewalRequired, true); assert.equal(calls.helperStop, 0);
});

test('simultaneous conflicting pair-owner choices cannot both install and failed proposals remain resolvable', async t => {
  let a, b; let crossed = 0; let release;
  const barrier = new Promise(ready => { release = ready; });
  const first = { a: true, b: true };
  const request = (name, other, nodeId) => async (operation, body) => {
    if (operation === 'status') {
      if (first[name]) { first[name] = false; crossed++; if (crossed === 2) release(); await barrier; }
      return { ...other().pairStatus(), nodeId };
    }
    if (operation === 'get') return other().exportCertificate();
    return other().acceptCertificate(body);
  };
  const pairA = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'race-pair', localId: 'a', peerId: 'b' }), request: request('a', () => b, 'b') };
  const pairB = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'race-pair', localId: 'b', peerId: 'a' }), request: request('b', () => a, 'a') };
  const aa = await setup(t, { pair: pairA }); const bb = await setup(t, { pair: pairB }); a = aa.manager; b = bb.manager; aa.config.topology = bb.config.topology = 'pair';
  await Promise.all([a.action({ action: 'enable', owner: 'local' }), b.action({ action: 'enable', owner: 'local' })]);
  await Promise.all([settled(t, a), settled(t, b)]);
  assert.equal(aa.calls.install + bb.calls.install, 0); assert.equal(aa.calls.helperStart + bb.calls.helperStart, 0);
  assert.equal(a.pairStatus().ownerId, null); assert.equal(b.pairStatus().ownerId, null);
  await a.action({ action: 'enable', owner: 'local' }); await settled(t, a);
  assert.equal(a.status().phase, 'ready');
  await b.action({ action: 'enable', owner: 'peer' }); await settled(t, b);
  assert.equal(b.status().phase, 'ready'); assert.equal(bb.calls.install, 0);
});

test('a stored valid peer certificate restarts offline without depending on the renewal owner', async t => {
  let peerId = 'peer-node';
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'offline-pair', localId: 'local-node', peerId }), request: async operation => operation === 'status' ?
    { nodeId: 'peer-node', pairId: 'offline-pair', ownerId: 'peer-node', enabled: true } :
    { pairId: 'offline-pair', ownerId: 'peer-node', hostname, generation: 3, certificate: { cert: 'peer-stored', key: 'peer-key' } } };
  const context = await setup(t, { pair }); context.config.topology = 'pair';
  await context.manager.action({ action: 'enable', owner: 'peer' }); await settled(t, context.manager); await context.manager.close();
  peerId = null; let activations = 0;
  const offlinePair = { configuration: pair.configuration, request: async () => { throw Object.assign(Error(), { code: 'https_peer_unavailable' }); } };
  const resumed = restart(t, context, { pair: offlinePair, onCertificate: async ({ certificate }) => { activations++; return { listening: true, fingerprint: certificate.metadata.fingerprint }; } });
  resumed.start(); for (let i = 0; i < 100 && !activations; i++) await wait(5);
  assert.equal(activations, 1); assert.equal(resumed.status().certificate.generation, 3); assert.equal(context.calls.helperStart, 0);
  await resumed.close();
  const before = await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8');
  const changed = restart(t, context, { pair: { ...offlinePair, configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'offline-pair', localId: 'new-local-node', peerId: null }) },
    onCertificate: async () => { throw Error('A changed node cannot activate the old identity'); } });
  changed.start(); assert.equal((await diagnosed(t, changed)).error, 'https_pair_identity_changed');
  assert.equal(await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8'), before);
});

test('altered cached certificate metadata is rejected before lock or interrupted-operation mutation', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(t, context.manager); await context.manager.close();
  const path = resolve(context.directory, 'https', 'state.json'); const value = JSON.parse(await readFile(path, 'utf8'));
  value.certificate.expiresAt += 90 * 86400000; value.operation.state = 'running'; await atomicJson(path, value);
  const before = await readFile(path, 'utf8'); let activated = 0;
  const resumed = restart(t, context, { onCertificate: async () => { activated++; return { listening: true }; } });
  resumed.start(); const view = await diagnosed(t, resumed);
  assert.equal(view.error, 'certificate_integrity_failed'); assert.equal(view.certificate, null); assert.equal(activated, 0);
  assert.equal(await readFile(path, 'utf8'), before); await assert.rejects(lstat(resolve(context.directory, 'https', 'manager.lock')), { code: 'ENOENT' });
});

test('genuinely absent HTTPS state starts disabled without creating state or installing a helper', async t => {
  const context = await setup(t);
  context.manager.start(); await context.manager.close();
  assert.equal(context.manager.status().phase, 'disabled');
  assert.equal(context.manager.status().warning, null);
  await assert.rejects(lstat(resolve(context.directory, 'https')), { code: 'ENOENT' });
  for (const key of ['install', 'discover', 'helperStart', 'certificate', 'preflight']) assert.equal(context.calls[key], 0);
  assert.deepEqual(context.calls.activations, []);
});

test('explicit falsy HTTPS state is rejected before storage admission or installation', async t => {
  for (const value of [false, 0, '', null]) await t.test(JSON.stringify(value), async t => {
    const context = await setup(t), directory = resolve(context.directory, 'https'), path = resolve(directory, 'state.json');
    await mkdir(directory, { mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(value)); await writeFile(path, bytes, { mode: 0o600 });
    const beforeHash = createHash('sha256').update(bytes).digest('hex');
    const beforeCalls = structuredClone(context.calls);
    context.manager.start();
    await assert.rejects(context.manager.action({ action: 'set-update-policy', policy: 'manual' }), { code: 'https_state_invalid' });
    assert.equal(context.manager.status().phase, 'degraded');
    assert.equal(context.manager.status().warning, 'https_state_invalid');
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), beforeHash);
    assert.deepEqual(await readdir(directory), ['state.json'], 'No lock, claim, staging or operation journal is admitted');
    assert.deepEqual(context.calls, beforeCalls, 'No helper, download, certificate or listener activation occurs');
  });
});

test('null-like and retired nested records fail closed without rewriting current state', async t => {
  const context = await setup(t); await context.manager.action({ action: 'set-update-policy', policy: 'manual' }); await settled(t, context.manager); await context.manager.close();
  const path = resolve(context.directory, 'https', 'state.json'); const initial = JSON.parse(await readFile(path, 'utf8'));
  for (const [field, wrong] of [['certificate', false], ['runtime', 0], ['highestVersion', false], ['operation', []]]) {
    const value = structuredClone(initial); value[field] = wrong; await atomicJson(path, value); const before = await readFile(path, 'utf8');
    const resumed = restart(t, context); resumed.start(); assert.equal((await diagnosed(t, resumed)).error, 'https_state_invalid');
    assert.equal(await readFile(path, 'utf8'), before); await resumed.close();
  }
  const value = structuredClone(initial); value.updates.retiredPolicy = 'always'; await atomicJson(path, value);
  const resumed = restart(t, context); resumed.start(); assert.equal((await diagnosed(t, resumed)).error, 'https_state_invalid');
});

test('failed certificate activation never exports an uncommitted generation to a peer', async t => {
  let currentTime = Date.now(); let ready; let release;
  const entered = new Promise(notify => { ready = notify; }); const held = new Promise(done => { release = done; });
  const pair = { configuration: () => ({ vipAddress: '192.0.2.100', pairId: 'publication-pair', localId: 'local-node', peerId: 'peer-node' }), request: async () =>
    ({ nodeId: 'peer-node', pairId: 'publication-pair', ownerId: 'local-node', enabled: true, generation: 1 }) };
  const context = await setup(t, { pair, dependencies: { now: () => currentTime } }); context.config.topology = 'pair';
  await context.manager.action({ action: 'enable', owner: 'local' }); await settled(t, context.manager); await context.manager.close();
  context.setCertificateId(2); currentTime += 31 * 86400000;
  const resumed = restart(t, context, { pair, onCertificate: async ({ certificate, generation }) => {
    if (generation === 2) { ready(); await held; return { listening: false, error: 'tls_port_unavailable' }; }
    return { listening: true, fingerprint: certificate.metadata.fingerprint };
  } });
  t.after(() => release());
  resumed.start(); await entered;
  assert.equal((await resumed.exportCertificate()).generation, 1); assert.equal(resumed.pairStatus().generation, 1);
  release(); await fixtureCondition(t, () => Boolean(resumed.status().error));
  assert.equal((await resumed.exportCertificate()).generation, 1);
});

test('copying or moving an identity requires fenced restoration and cannot translate retired marker fields', async t => {
  const directory = await mkdtemp(resolve('/var/tmp', 'stmq-https-binding-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = resolve(directory, 'controller'); const first = resolve(directory, 'first'); const second = resolve(directory, 'second');
  await privateDirectory(dataDir); await privateDirectory(first); await privateDirectory(second);
  // The ownership test supplies its own installation identity on every host.
  const binding = { getInstallationBinding: async () => '1'.repeat(64) };
  const oldLocations = await helperLocations(dataDir, first, binding);
  const target = process.getuid() === 0 ? resolve(directory, '.second-https-helper') : resolve(second, 'identity');
  await cp(oldLocations.identity, target, { recursive: true }); if (process.getuid() === 0) await chown(target, 65534, 65534);
  const marker = resolve(target, 'stmq-owner.json'); const before = await readFile(marker, 'utf8');
  await assert.rejects(helperLocations(dataDir, second, binding), { code: 'identity_restore_required' }); assert.equal(await readFile(marker, 'utf8'), before);
  const restored = await helperLocations(dataDir, second, { ...binding, restoreFenced: true }); assert.equal(restored.identity, target);
  const value = JSON.parse(await readFile(marker, 'utf8')); value.installationBinding = '0'.repeat(64); await atomicJson(marker, value);
  await assert.rejects(helperLocations(dataDir, second, binding), { code: 'identity_restore_required' });
  value.retiredOwner = true; await atomicJson(marker, value);
  await assert.rejects(helperLocations(dataDir, second, { ...binding, restoreFenced: true }), { code: 'helper_identity_marker_invalid' });
});

test('checkout storage is refused before downloads, including an external symlink into a checkout', async t => {
  const context = await setup(t);
  const repository = resolve(context.directory, 'synthetic-repository'); await mkdir(resolve(repository, '.git', 'objects'), { recursive: true });
  await writeFile(resolve(repository, '.git', 'HEAD'), 'ref: refs/heads/test\n');
  const alias = resolve(context.directory, 'alias'); await symlink(repository, alias);
  context.config.web.httpsDirectory = resolve(alias, 'private', 'https');
  await assert.rejects(outsideCheckout(context.config.web.httpsDirectory), { code: 'helper_storage_outside_checkout_required' });
  await assert.rejects(context.manager.action({ action: 'enable' }), { code: 'helper_storage_outside_checkout_required' });
  assert.equal(context.calls.install, 0); await assert.rejects(lstat(resolve(repository, 'private')), { code: 'ENOENT' });
});

test('vendor distribution signature binds the root-signed signing bundle, exact BLAKE2s digest and little endian length', () => {
  const root = generateKeyPairSync('ed25519'); const signing = generateKeyPairSync('ed25519');
  const raw = publicKey => publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const bundle = Buffer.from(`-----BEGIN SIGNING PUBLIC KEY-----\n${raw(signing.publicKey)}\n-----END SIGNING PUBLIC KEY-----\n`);
  const bundleSignature = sign(null, bundle, root.privateKey);
  const keys = verifySigningBundle(bundle, bundleSignature, [raw(root.publicKey)]);
  const bytes = Buffer.from('synthetic-distribution-not-executable'); const digest = createHash('blake2s256').update(bytes).digest();
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(bytes.length)); const signature = sign(null, Buffer.concat([digest, length]), signing.privateKey);
  verifyArtifactHash(digest, bytes.length, signature, keys);
  assert.throws(() => verifyArtifactHash(digest, bytes.length + 1, signature, keys), { code: 'vendor_artifact_signature_invalid' });
  const changed = Buffer.from(digest); changed[0] ^= 1; assert.throws(() => verifyArtifactHash(changed, bytes.length, signature, keys), { code: 'vendor_artifact_signature_invalid' });
  assert.throws(() => verifySigningBundle(bundle, bundleSignature), { code: 'vendor_signing_keys_untrusted' });
});

test('stable discovery selects tarball version, rejects arbitrary filenames and reports unsupported major separately', () => {
  const arch = architecture();
  assert.equal(releaseCandidate({ Version: '9.0.0', TarballsVersion: '1.104.1', Tarballs: { [arch]: `tailscale_1.104.1_${arch}.tgz` } }).eligible, true);
  assert.throws(() => releaseCandidate({ TarballsVersion: '1.104.1', Tarballs: { [arch]: 'https://other.invalid/payload' } }), { code: 'vendor_artifact_metadata_invalid' });
  assert.equal(releaseCandidate({ TarballsVersion: '2.0.0', Tarballs: { [arch]: `tailscale_2.0.0_${arch}.tgz` } }).eligible, false);
});

test('effective helper restrictions follow observed current nil slices and omit application secrets from environment', () => {
  const prefs = { CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false, ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false,
    AdvertiseRoutes: null, AdvertiseTags: null, AutoUpdate: { Apply: false, Check: true }, AppConnector: { Advertise: false }, RemoteConfig: false };
  assert.equal(effectiveRestrictions(prefs, null), true);
  assert.equal(effectiveRestrictions({ ...prefs, CorpDNS: true }, null), false);
  assert.equal(effectiveRestrictions(prefs, { TCP: { '443': {} } }), false);
  assert.equal('SUPERVISOR_TOKEN' in restrictedEnvironment('/fixture'), false);
  assert.equal('STMQ_API_TOKEN' in restrictedEnvironment('/fixture'), false);
  assert.equal(restrictedEnvironment('/fixture').TS_DISABLE_FEATURE, 'taildrop,wakeonlan');
});

test('runtime workers honor cancellation and finish before returning cancelled staging ownership', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtimeTask('discover', {}, { signal: controller.signal }), { code: 'https_manager_closed' });
});

test('an application crash reaps a TERM-ignoring owned helper without leaving a live identity process', { skip: process.platform !== 'linux' }, async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-parent-death-'));
  const root = process.getuid() === 0;
  if (root) await chown(directory, 65534, 65534);
  const locations = { identity: directory, uid: root ? 65534 : process.getuid(), gid: root ? 65534 : process.getgid(), root };
  // An opened /bin/sh is BusyBox on Alpine; executing its fd cannot select the
  // shell applet. Use the current Node executable on both supported platforms,
  // and prove its TERM handler is installed before killing the owning parent.
  const source = `import { launchRestricted } from ${JSON.stringify(new URL('../src/https/helper.js', import.meta.url).href)};
    let ready, output = ''; const running = new Promise(done => { ready = done; });
    const record = await launchRestricted(process.execPath, ['--input-type=module', '-e',
      'process.on("SIGTERM", () => {}); console.log("fixture-ready"); setInterval(() => {}, 1000);'],
      { foreground: true, locations: ${JSON.stringify(locations)}, onProcess: processRecord => processRecord.child.stdout.on('data', chunk => {
        output += chunk; if (output.includes('fixture-ready')) ready();
      }) });
    await running;
    console.log(JSON.stringify({ launcher: record.child.pid, child: record.ownedPid })); process.stdin.resume();`;
  const caller = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'ignore'] });
  let owned;
  t.after(async () => {
    caller.kill('SIGKILL');
    if (owned) { try { process.kill(-owned.launcher, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  });
  owned = await new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(Error('Fixture launcher failed to report an owned child')), 10000);
    let output = '';
    caller.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timeout); ready(JSON.parse(output.trim())); } });
    caller.once('exit', () => { clearTimeout(timeout); if (!output) reject(Error('Fixture caller exited before its child proof')); });
  });
  caller.kill('SIGKILL');
  const deadline = Date.now() + 8000;
  let live = true;
  while (Date.now() < deadline) {
    const status = await readFile(`/proc/${owned.child}/status`, 'utf8').catch(() => null);
    live = status && !/^State:[ \t]*Z/m.test(status);
    if (!live) break;
    await wait(50);
  }
  assert.equal(Boolean(live), false, 'Parent-pipe closure must trigger bounded escalation, including when TERM is ignored');
});

test('renewal minimum validity is greater than the derived threshold and bounded by actual lifetime', () => {
  const start = Date.now(); const expires = start + 45 * 86400000; const requested = Number(renewalMinimumValidity({ notBefore: start, expiresAt: expires }).slice(0, -1)) * 1000;
  assert.ok(requested > 15 * 86400000); assert.ok(requested < 45 * 86400000);
});

test('native TLS certificate validation checks ordinary trust, exact SAN, key, server usage and current validity', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-chain-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const openssl = promisify(execFile); const run = args => openssl('openssl', args, { cwd: directory });
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=Synthetic test root', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'root.key', '-out', 'root.pem']);
  await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${hostname}`, '-keyout', 'leaf.key', '-out', 'leaf.csr']);
  await writeFile(resolve(directory, 'server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`);
  await run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '2', '-extfile', 'server.ext', '-out', 'leaf.pem']);
  const material = { cert: await readFile(resolve(directory, 'leaf.pem'), 'utf8'), key: await readFile(resolve(directory, 'leaf.key'), 'utf8') };
  const roots = [await readFile(resolve(directory, 'root.pem'), 'utf8')];
  const result = await validateCertificate(material, hostname, { directory, trustedRoots: roots }); assert.equal(result.hostname, hostname);
  await assert.rejects(validateCertificate({ ...material, retiredField: true }, hostname, { directory, trustedRoots: roots }), { code: 'certificate_size_invalid' });
  await assert.rejects(validateCertificate(material, hostname, { directory }), { code: 'certificate_chain_untrusted' });
  await assert.rejects(validateCertificate(material, 'other.test-tailnet.ts.net', { directory, trustedRoots: roots }), { code: 'certificate_hostname_mismatch' });
  await assert.rejects(validateCertificate({ ...material, key: await readFile(resolve(directory, 'root.key'), 'utf8') }, hostname, { directory, trustedRoots: roots }), { code: 'certificate_key_mismatch' });
  await assert.rejects(validateCertificate(material, hostname, { directory, trustedRoots: roots, now: result.expiresAt + 1 }), { code: 'certificate_not_current' });
  await writeFile(resolve(directory, 'client.ext'), `basicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth\nsubjectAltName=DNS:${hostname}\n`);
  await run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-days', '2', '-extfile', 'client.ext', '-out', 'client.pem']);
  await assert.rejects(validateCertificate({ ...material, cert: await readFile(resolve(directory, 'client.pem'), 'utf8') }, hostname, { directory, trustedRoots: roots }), { code: 'certificate_server_usage_invalid' });
  // A real intermediate chain must be served, not just a trusted-looking leaf.
  await run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Synthetic intermediate', '-keyout', 'intermediate.key', '-out', 'intermediate.csr']);
  await writeFile(resolve(directory, 'intermediate.ext'), 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  await run(['x509', '-req', '-in', 'intermediate.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-days', '2', '-extfile', 'intermediate.ext', '-out', 'intermediate.pem']);
  await run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'intermediate.pem', '-CAkey', 'intermediate.key', '-CAcreateserial', '-days', '1', '-extfile', 'server.ext', '-out', 'chained-leaf.pem']);
  const leaf = await readFile(resolve(directory, 'chained-leaf.pem'), 'utf8'); const intermediate = await readFile(resolve(directory, 'intermediate.pem'), 'utf8');
  await assert.rejects(validateCertificate({ ...material, cert: leaf }, hostname, { directory, trustedRoots: roots }), { code: 'certificate_chain_untrusted' });
  const chained = await validateCertificate({ ...material, cert: `${leaf}\n${intermediate}` }, hostname, { directory, trustedRoots: roots });
  assert.equal(chained.hostname, hostname); assert.notEqual(chained.fingerprint, result.fingerprint);
});
