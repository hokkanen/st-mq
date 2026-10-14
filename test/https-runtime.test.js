import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, chown, cp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHttpsManager } from '../src/https/manager.js';
import { verifySigningBundle, verifyArtifactHash, releaseCandidate, architecture } from '../src/https/distribution.js';
import { validateCertificate, renewalMinimumValidity } from '../src/https/certificates.js';
import { privateDirectory, atomicJson, lockDirectory, outsideCheckout } from '../src/https/storage.js';
import { CertificateHelper, effectiveRestrictions, restrictedEnvironment, helperLocations, installationBinding } from '../src/https/helper.js';
import { runtimeTask } from '../src/https/worker.js';

const hostname = 'fixture.test-tailnet.ts.net';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function settled(manager) {
  for (let i = 0; i < 200 && manager.status().operation?.state === 'running'; i++) await wait(5);
  assert.notEqual(manager.status().operation?.state, 'running'); return manager.status();
}
async function diagnosed(manager) { for (let i = 0; i < 200 && !manager.status().error; i++) await wait(5); assert.ok(manager.status().error); return manager.status(); }
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
  const calls = { install: 0, discover: 0, helperStart: 0, helperStop: 0, certificate: 0, activations: [], disabled: 0, preflight: 0 };
  let installNotify; const installStarted = new Promise(ready => { installNotify = ready; });
  let running = true; let certificateId = 1;
  const metadataByCertificate = new Map();
  const metadata = material => {
    if (!metadataByCertificate.has(material.cert)) metadataByCertificate.set(material.cert, { hostname, fingerprint: createHash('sha256').update(material.cert).digest('hex'), notBefore: Date.now() - 86400000, expiresAt: Date.now() + 60 * 86400000, renewalWindowMs: 30 * 86400000 });
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
    validateCertificate: async material => { if (material.cert === 'invalid') throw Object.assign(Error(), { code: 'certificate_chain_untrusted' }); return metadata(material); },
    inspectCertificate: material => metadata(material),
    createHelper: ({ locations }) => ({
      start: async () => { calls.helperStart++; await writeFile(resolve(locations.identity, 'tailscaled.state'), '{}', { mode: 0o600 }); },
      restrictions: async () => {}, status: async () => ({ Version: '1.104.1-fixture', BackendState: running ? 'Running' : 'NeedsLogin', CertDomains: running ? [hostname] : [], AuthURL: running ? '' : 'https://login.tailscale.com/a/synthetic' }),
      authorize: async () => ({ Version: '1.104.1-fixture', BackendState: running ? 'Running' : 'NeedsLogin', CertDomains: running ? [hostname] : [], AuthURL: running ? '' : 'https://login.tailscale.com/a/synthetic' }),
      certificate: async () => { calls.certificate++; return { cert: `fixture-cert-${certificateId}`, key: `fixture-key-${certificateId}` }; },
      stop: async () => { calls.helperStop++; },
    }), ...changes.dependencies,
  };
  const manager = createHttpsManager({ getConfig: () => config,
    onCertificate: async ({ certificate, generation }) => { calls.activations.push(generation); return changes.activationError ? { listening: false, error: 'tls_port_unavailable' } : { listening: true, fingerprint: certificate.metadata.fingerprint }; },
    onDisable: async () => { calls.disabled++; }, pair: changes.pair ?? null, dependencies });
  t.after(() => manager.close());
  return { directory, config, calls, manager, dependencies, metadata, installStarted, setRunning: value => { running = value; }, setCertificateId: value => { certificateId = value; } };
}

test('optional HTTPS starts with no files, downloads, network checks or helper when unconfigured', async t => {
  const { directory, calls, manager } = await setup(t);
  manager.start(); await wait(20);
  assert.equal(manager.status().phase, 'disabled'); assert.equal(calls.install, 0); assert.equal(calls.discover, 0); assert.equal(calls.helperStart, 0);
  await assert.rejects(lstat(resolve(directory, 'https')), { code: 'ENOENT' });
  const record = await manager.action({ action: 'update-now' }); assert.ok(record.id); await settled(manager);
  assert.equal(manager.status().operation.error, 'https_setup_required'); assert.equal(calls.install, 0);
});

test('explicit setup installs only its helper, activates validated certificate, redacts family state and is resumable', async t => {
  const { manager, calls } = await setup(t);
  const operation = await manager.action({ action: 'enable' }); assert.ok(operation.id);
  const view = await settled(manager);
  assert.equal(view.phase, 'ready'); assert.equal(view.hostname, hostname); assert.equal(view.certificate.generation, 1);
  assert.equal(calls.install, 1); assert.equal(calls.helperStart, 1); assert.equal(calls.certificate, 1);
  await manager.action({ action: 'recheck' }); await settled(manager);
  assert.equal(calls.install, 1); assert.equal(calls.certificate, 1, 'Rechecks do not force issuance');
  const family = manager.status({ admin: false }); assert.equal(family.enabled, true); assert.equal('hostname' in family, false); assert.equal('helper' in family, false); assert.equal('operation' in family, false);
  for (const field of ['environment', 'setup', 'dns']) assert.equal(field in family, false);
  await manager.action({ action: 'disable' }); await settled(manager);
  assert.equal(manager.status().enabled, false); assert.equal(calls.helperStop, 1); assert.ok(manager.status().certificate.expiresAt);
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
  await context.manager.action({ action: 'enable' }); const failed = await settled(context.manager);
  assert.equal(failed.operation.error, 'helper_installation_binding_unavailable');
  assert.equal(context.calls.install, 0); assert.equal(context.calls.preflight, 0); assert.equal(context.calls.helperStart, 0);
  assert.equal(contexts[0].addon, true); assert.equal(contexts[0].restoreFenced, false);
  assert.ok(contexts[0].signal instanceof AbortSignal);
  const saved = JSON.parse(await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8'));
  assert.deepEqual(saved.quarantined, {}); assert.equal(saved.transaction, null);
  await context.manager.close();
  available = true;
  const resumed = restart(t, context); await resumed.action({ action: 'retry' });
  assert.equal((await settled(resumed)).phase, 'ready'); assert.equal(context.calls.install, 1);
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
    await manager.action({ action: 'enable' }); const view = await settled(manager);
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
  await installStarted; assert.equal(calls.install, 1); release(); await settled(manager); assert.equal(calls.helperStart, 1);
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
  await manager.action({ action: 'enable' }); await settled(manager);
  assert.equal(manager.status().operation.error, 'vendor_download_unavailable');
  await manager.action({ action: 'retry' }); await settled(manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 2);
});

test('explicit Retry permits a previously quarantined failed preflight without silently restoring an old identity', async t => {
  const { manager, calls } = await setup(t, { preflightFailures: 1 });
  await manager.action({ action: 'enable' }); await settled(manager);
  assert.equal(manager.status().operation.error, 'helper_command_failed');
  await manager.action({ action: 'retry' }); await settled(manager);
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
  await manager.action({ action: 'enable' }); await settled(manager);
  assert.equal(manager.status().phase, 'authorization_required'); assert.equal(manager.status().helper.authorizationUrl, 'https://login.tailscale.com/a/synthetic');
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes('login.tailscale.com'), false);
  setRunning(true); await manager.action({ action: 'recheck' }); await settled(manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 1);
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
  await manager.action({ action: 'enable' }); const failed = await settled(manager);
  assert.equal(failed.operation.state, 'failed');
  assert.equal(failed.operation.error, 'helper_authorization_start_failed');
  assert.equal(failed.phase, 'degraded');
  assert.equal(failed.helper.state, 'authorization_required', 'A running process does not establish an authenticated connection');
  assert.equal(failed.error, 'helper_authorization_start_failed');
  assert.equal(JSON.stringify(failed).includes('private diagnostic'), false);
  assert.equal(restrictions, 1, 'The initial helper restrictions remain enforced');
  usable = true;
  await manager.action({ action: 'retry' }); const retried = await settled(manager);
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
  assert.equal((await settled(manager)).operation.error, 'helper_authorization_start_failed');
  for (const invalid of [' ', 'not-a-url', 'http://login.tailscale.com/a/synthetic', 'https://elsewhere.invalid/a/synthetic']) {
    AuthURL = invalid;
    await manager.action({ action: 'retry' }); const failed = await settled(manager);
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
  await manager.action({ action: 'retry' }); const pending = await settled(manager);
  assert.equal(pending.operation.state, 'completed');
  assert.equal(pending.phase, 'authorization_required');
  assert.equal(pending.error, null);
  assert.equal(pending.helper.authorizationUrl, AuthURL);
  assert.equal(restrictions, 2);
  assert.equal(calls.install, 1, 'All retries retain the existing runtime and identity');
  assert.equal(JSON.stringify(manager.status({ admin: false })).includes(AuthURL), false);
});

test('a peer certificate recipient never installs or starts a certificate helper and rejects replay', async t => {
  const envelope = { pairId: 'fixture-pair', ownerId: 'peer-node', hostname, generation: 5, certificate: { cert: 'fixture-peer', key: 'fixture-key' } };
  const pair = { configuration: () => ({ pairId: 'fixture-pair', localId: 'local-node', peerId: 'peer-node' }), request: async operation => operation === 'status' ?
    { nodeId: 'peer-node', ownerId: 'peer-node', pairId: 'fixture-pair', enabled: true } : envelope };
  const { manager, config, calls } = await setup(t, { pair, dependencies: {
    helperLocations: async () => assert.fail('Certificate recipients cannot look up or admit a helper identity'),
  } }); config.topology = 'pair'; config.addon = true;
  await manager.action({ action: 'enable', owner: 'peer' }); await settled(manager);
  assert.equal(manager.status().phase, 'ready'); assert.equal(calls.install, 0); assert.equal(calls.helperStart, 0);
  await manager.acceptCertificate(envelope);
  await assert.rejects(manager.acceptCertificate({ ...envelope, generation: 4 }), { code: 'certificate_generation_replayed' });
  await assert.rejects(manager.acceptCertificate({ ...envelope, ownerId: 'wrong-node' }), { code: 'https_certificate_owner_mismatch' });
  await assert.rejects(manager.exportCertificate(), { code: 'https_owner_certificate_unavailable' });
});

test('local owner retains renewal responsibility while its enabled peer is offline after local disable', async t => {
  let offline = false; let delivered = 0;
  const pair = { configuration: () => ({ pairId: 'fixture-pair', localId: 'local-node', peerId: 'peer-node' }), request: async operation => {
    if (offline) throw Object.assign(Error(), { code: 'https_peer_unavailable' });
    if (operation === 'status') return { nodeId: 'peer-node', pairId: 'fixture-pair', ownerId: 'local-node', enabled: true, generation: 0 };
    delivered++; return {};
  } };
  const { manager, config, calls } = await setup(t, { pair }); config.topology = 'pair';
  await manager.action({ action: 'enable', owner: 'local' }); await settled(manager); assert.ok(delivered > 0);
  offline = true; await manager.action({ action: 'disable' }); await settled(manager);
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
  const pairA = { configuration: () => ({ pairId: 'race-pair', localId: 'a', peerId: 'b' }), request: request('a', () => b, 'b') };
  const pairB = { configuration: () => ({ pairId: 'race-pair', localId: 'b', peerId: 'a' }), request: request('b', () => a, 'a') };
  const aa = await setup(t, { pair: pairA }); const bb = await setup(t, { pair: pairB }); a = aa.manager; b = bb.manager; aa.config.topology = bb.config.topology = 'pair';
  await Promise.all([a.action({ action: 'enable', owner: 'local' }), b.action({ action: 'enable', owner: 'local' })]);
  await Promise.all([settled(a), settled(b)]);
  assert.equal(aa.calls.install + bb.calls.install, 0); assert.equal(aa.calls.helperStart + bb.calls.helperStart, 0);
  assert.equal(a.pairStatus().ownerId, null); assert.equal(b.pairStatus().ownerId, null);
  await a.action({ action: 'enable', owner: 'local' }); await settled(a);
  assert.equal(a.status().phase, 'ready');
  await b.action({ action: 'enable', owner: 'peer' }); await settled(b);
  assert.equal(b.status().phase, 'ready'); assert.equal(bb.calls.install, 0);
});

test('a stored valid peer certificate restarts offline without depending on the renewal owner', async t => {
  let peerId = 'peer-node';
  const pair = { configuration: () => ({ pairId: 'offline-pair', localId: 'local-node', peerId }), request: async operation => operation === 'status' ?
    { nodeId: 'peer-node', pairId: 'offline-pair', ownerId: 'peer-node', enabled: true } :
    { pairId: 'offline-pair', ownerId: 'peer-node', hostname, generation: 3, certificate: { cert: 'peer-stored', key: 'peer-key' } } };
  const context = await setup(t, { pair }); context.config.topology = 'pair';
  await context.manager.action({ action: 'enable', owner: 'peer' }); await settled(context.manager); await context.manager.close();
  peerId = null; let activations = 0;
  const offlinePair = { configuration: pair.configuration, request: async () => { throw Object.assign(Error(), { code: 'https_peer_unavailable' }); } };
  const resumed = restart(t, context, { pair: offlinePair, onCertificate: async ({ certificate }) => { activations++; return { listening: true, fingerprint: certificate.metadata.fingerprint }; } });
  resumed.start(); for (let i = 0; i < 100 && !activations; i++) await wait(5);
  assert.equal(activations, 1); assert.equal(resumed.status().certificate.generation, 3); assert.equal(context.calls.helperStart, 0);
  await resumed.close();
  const before = await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8');
  const changed = restart(t, context, { pair: { ...offlinePair, configuration: () => ({ pairId: 'offline-pair', localId: 'new-local-node', peerId: null }) },
    onCertificate: async () => { throw Error('A changed node cannot activate the old identity'); } });
  changed.start(); assert.equal((await diagnosed(changed)).error, 'https_pair_identity_changed');
  assert.equal(await readFile(resolve(context.directory, 'https', 'state.json'), 'utf8'), before);
});

test('altered cached certificate metadata is rejected before lock or interrupted-operation mutation', async t => {
  const context = await setup(t); await context.manager.action({ action: 'enable' }); await settled(context.manager); await context.manager.close();
  const path = resolve(context.directory, 'https', 'state.json'); const value = JSON.parse(await readFile(path, 'utf8'));
  value.certificate.expiresAt += 90 * 86400000; value.operation.state = 'running'; await atomicJson(path, value);
  const before = await readFile(path, 'utf8'); let activated = 0;
  const resumed = restart(t, context, { onCertificate: async () => { activated++; return { listening: true }; } });
  resumed.start(); const view = await diagnosed(resumed);
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
  const context = await setup(t); await context.manager.action({ action: 'set-update-policy', policy: 'manual' }); await settled(context.manager); await context.manager.close();
  const path = resolve(context.directory, 'https', 'state.json'); const initial = JSON.parse(await readFile(path, 'utf8'));
  for (const [field, wrong] of [['certificate', false], ['runtime', 0], ['highestVersion', false], ['operation', []]]) {
    const value = structuredClone(initial); value[field] = wrong; await atomicJson(path, value); const before = await readFile(path, 'utf8');
    const resumed = restart(t, context); resumed.start(); assert.equal((await diagnosed(resumed)).error, 'https_state_invalid');
    assert.equal(await readFile(path, 'utf8'), before); await resumed.close();
  }
  const value = structuredClone(initial); value.updates.retiredPolicy = 'always'; await atomicJson(path, value);
  const resumed = restart(t, context); resumed.start(); assert.equal((await diagnosed(resumed)).error, 'https_state_invalid');
});

test('failed certificate activation never exports an uncommitted generation to a peer', async t => {
  let currentTime = Date.now(); let ready; let release;
  const entered = new Promise(notify => { ready = notify; }); const held = new Promise(done => { release = done; });
  const pair = { configuration: () => ({ pairId: 'publication-pair', localId: 'local-node', peerId: 'peer-node' }), request: async () =>
    ({ nodeId: 'peer-node', pairId: 'publication-pair', ownerId: 'local-node', enabled: true, generation: 1 }) };
  const context = await setup(t, { pair, dependencies: { now: () => currentTime } }); context.config.topology = 'pair';
  await context.manager.action({ action: 'enable', owner: 'local' }); await settled(context.manager); await context.manager.close();
  context.setCertificateId(2); currentTime += 31 * 86400000;
  const resumed = restart(t, context, { pair, onCertificate: async ({ certificate, generation }) => {
    if (generation === 2) { ready(); await held; return { listening: false, error: 'tls_port_unavailable' }; }
    return { listening: true, fingerprint: certificate.metadata.fingerprint };
  } });
  t.after(() => release());
  resumed.start(); await entered;
  assert.equal((await resumed.exportCertificate()).generation, 1); assert.equal(resumed.pairStatus().generation, 1);
  release(); for (let i = 0; i < 200 && !resumed.status().error; i++) await wait(5);
  assert.equal((await resumed.exportCertificate()).generation, 1);
});

test('copying or moving an identity requires fenced restoration and cannot translate retired marker fields', async t => {
  const directory = await mkdtemp(resolve('/var/tmp', 'stmq-https-binding-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = resolve(directory, 'controller'); const first = resolve(directory, 'first'); const second = resolve(directory, 'second');
  await privateDirectory(dataDir); await privateDirectory(first); await privateDirectory(second);
  const oldLocations = await helperLocations(dataDir, first);
  const target = process.getuid() === 0 ? resolve(directory, '.second-https-helper') : resolve(second, 'identity');
  await cp(oldLocations.identity, target, { recursive: true }); if (process.getuid() === 0) await chown(target, 65534, 65534);
  const marker = resolve(target, 'stmq-owner.json'); const before = await readFile(marker, 'utf8');
  await assert.rejects(helperLocations(dataDir, second), { code: 'identity_restore_required' }); assert.equal(await readFile(marker, 'utf8'), before);
  const restored = await helperLocations(dataDir, second, { restoreFenced: true }); assert.equal(restored.identity, target);
  const value = JSON.parse(await readFile(marker, 'utf8')); value.installationBinding = '0'.repeat(64); await atomicJson(marker, value);
  await assert.rejects(helperLocations(dataDir, second), { code: 'identity_restore_required' });
  value.retiredOwner = true; await atomicJson(marker, value);
  await assert.rejects(helperLocations(dataDir, second, { restoreFenced: true }), { code: 'helper_identity_marker_invalid' });
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

test('singleton stale lock reclamation has exactly one winner under concurrent starts', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'stmq-https-lock-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await atomicJson(resolve(directory, 'manager.lock'), { version: 1, pid: 2147483647, nonce: 'fixture-dead-process' });
  const outcomes = await Promise.allSettled(Array.from({ length: 50 }, () => lockDirectory(directory)));
  const accepted = outcomes.filter(outcome => outcome.status === 'fulfilled'); assert.equal(accepted.length, 1); await accepted[0].value();
  await mkdir(resolve(directory, 'manager.claim'), { mode: 0o700 });
  await atomicJson(resolve(directory, 'manager.claim', 'owner.json'), { version: 1, pid: 2147483647, nonce: 'interrupted' });
  await assert.rejects(lockDirectory(directory), { code: 'https_lock_recovery_required' });
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
