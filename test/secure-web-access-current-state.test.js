// Actual current HTTPS manager + UI formatter, with synthetic runtime and
// certificate adapters only. No vendor request, helper process or equipment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpsManager } from '../src/https/manager.js';
import { BOOTSTRAP_VERSION } from '../src/https/official-roots.js';
import { architecture } from '../src/https/distribution.js';
import { atomicJson, privateDirectory } from '../src/https/storage.js';
import { secureWebAccessView } from '../chart/secure-web-access.js';

const hostname = 'fixture.test-tailnet.ts.net';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Controlled HTTPS operation settles');
    await pause(5);
  }
}
async function fixture(t, createHelper) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-web-access-current-'));
  let now = Date.parse('2026-10-14T12:00:00Z');
  const config = { dataDir: directory, token: 'synthetic-admin-password-long-enough', topology: 'standalone',
    web: { httpsHost: '127.0.0.1', httpsPort: 8443, lanResolver: '' } };
  const observation = () => ({ Version: `${BOOTSTRAP_VERSION}-fixture`, BackendState: 'Running', CertDomains: [hostname], AuthURL: '' });
  const certificate = { hostname, fingerprint: createHash('sha256').update('synthetic-certificate').digest('hex'),
    notBefore: now - 86400000, expiresAt: now + 60 * 86400000, renewalWindowMs: 30 * 86400000 };
  const manager = createHttpsManager({ getConfig: () => config,
    onCertificate: async () => ({ listening: true }),
    dependencies: {
      now: () => now,
      runtimeTask: async (name, input) => {
        if (name === 'integrity') return true;
        if (name === 'discover') return { metadata: { TarballsVersion: BOOTSTRAP_VERSION,
          Tarballs: { [architecture()]: `tailscale_${BOOTSTRAP_VERSION}_${architecture()}.tgz` } }, etag: 'fixture' };
        assert.equal(name, 'install', 'Fixture never delegates work to a real runtime worker');
        const staging = join(input.directory, 'staged');
        await mkdir(staging, { mode: 0o700 });
        const evidence = { version: 1, vendor: 'tailscale', runtimeVersion: input.candidate.version, arch: architecture(),
          artifactUrl: input.candidate.url, archiveSha256: 'a'.repeat(64), archiveLength: 1, blake2s256: 'b'.repeat(64),
          signingBundleSha256: 'c'.repeat(64), signature: Buffer.alloc(64).toString('base64'), verifierRevision: 'f'.repeat(40),
          verifiedAt: now, files: { tailscale: 'd'.repeat(64), tailscaled: 'e'.repeat(64) } };
        await atomicJson(join(staging, 'accepted.json'), evidence);
        return { staging, evidence };
      },
      helperLocations: async () => {
        const identity = join(directory, 'https', 'identity'); await privateDirectory(identity);
        return { identity, socketDirectory: identity, socket: join(identity, 'fixture.sock'),
          uid: process.getuid(), gid: process.getgid(), root: false };
      },
      preflightRuntime: async () => {},
      validateCertificate: async () => structuredClone(certificate),
      inspectCertificate: () => structuredClone(certificate),
      createHelper: ({ locations }) => ({
        start: async () => writeFile(join(locations.identity, 'tailscaled.state'), '{}', { mode: 0o600 }),
        stop: async () => {}, restrictions: async () => {}, status: async () => observation(), authorize: async () => observation(),
        certificate: async () => ({ cert: 'synthetic-certificate', key: 'synthetic-key' }),
        ...createHelper?.(observation),
      }),
    },
  });
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  return { manager, now: () => now, setNow: value => { now = value; } };
}

const failedAuthorization = () => { throw Object.assign(Error('Synthetic authorization command rejected.'), { code: 'helper_authorization_start_failed' }); };

test('actual pending Retry does not display its retained previous error as the current next action', async t => {
  let attempt = 0, release, notify;
  const hold = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { notify = resolve; });
  const { manager, now } = await fixture(t, () => ({
    status: async () => ({ Version: `${BOOTSTRAP_VERSION}-fixture`, BackendState: 'NeedsLogin', AuthURL: '' }),
    authorize: async () => {
      if (++attempt === 1) failedAuthorization();
      notify(); await hold;
      return { Version: `${BOOTSTRAP_VERSION}-fixture`, BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/synthetic' };
    },
  }));
  await manager.action({ action: 'enable' }); await until(() => manager.status().operation.state !== 'running');
  await manager.action({ action: 'retry' }); await entered;
  try {
    const current = manager.status();
    assert.equal(current.operation.state, 'running'); assert.equal(current.operation.error, null);
    assert.equal(current.error, 'helper_authorization_start_failed');
    const view = secureWebAccessView(current, { admin: true, now: now() });
    assert.equal(view.next.title, 'Setting up HTTPS'); assert.equal(view.busy, true);
    assert.equal(view.receipt, null, 'A running operation does not become a completed receipt');
  } finally { release(); await until(() => manager.status().operation.state !== 'running'); }
});

test('actual background certificate recovery separates current readiness from the failed action receipt', async t => {
  let connected = false;
  const { manager, now } = await fixture(t, observation => ({ authorize: async () => failedAuthorization(),
    status: async () => connected ? observation() : { Version: `${BOOTSTRAP_VERSION}-fixture`, BackendState: 'NeedsLogin', AuthURL: '' } }));
  await manager.action({ action: 'enable' }); await until(() => manager.status().operation.state !== 'running');
  const failed = manager.status().operation;
  connected = true; await manager.configure();
  await until(() => manager.status().phase === 'ready' && manager.status().certificate);
  const current = manager.status();
  assert.equal(current.error, null); assert.equal(current.operation.id, failed.id); assert.equal(current.operation.state, 'failed');
  const view = secureWebAccessView({ ...current, transport: { https: { enabled: true, listening: true } } }, { admin: true, now: now() });
  assert.equal(view.next.title, 'Review the local-only destination'); assert.equal(view.error, '');
  assert.match(view.receipt.text, /Last action · Set up HTTPS request failed/);
  assert.equal(view.receipt.at, failed.completedAt, 'Background recovery never renews the old receipt clock');
});

test('an actual issued certificate selects renewal at expiry while listener loss has its own recovery', async t => {
  const { manager, now, setNow } = await fixture(t);
  await manager.action({ action: 'enable' }); await until(() => manager.status().operation.state !== 'running');
  const issued = manager.status(); assert.equal(issued.phase, 'ready'); assert(issued.certificate);
  const stopped = secureWebAccessView({ ...issued, transport: { https: { enabled: true, listening: false } } }, { admin: true, now: now() });
  assert.equal(stopped.next.title, 'Recover the HTTPS listener');
  setNow(issued.certificate.expiresAt + 1);
  const current = manager.status(); assert.equal(current.error, null, 'Expiry boundary is observed before a later timer tick');
  const expired = secureWebAccessView({ ...current, transport: { https: { enabled: true, listening: true } } }, { admin: true, now: now() });
  assert.equal(expired.label, 'HTTPS unavailable'); assert.equal(expired.next.title, 'Renew the certificate');
  assert.doesNotMatch(expired.next.help, /Complete Tailscale sign-in/);
});

test('a current configured loopback destination remains visible without household mapping examples', async t => {
  const { manager, now } = await fixture(t);
  await manager.action({ action: 'enable' }); await until(() => manager.status().operation.state !== 'running');
  const current = manager.status(); assert.equal(current.phase, 'ready'); assert.equal(current.dns.expectedAddress, '127.0.0.1');
  const view = secureWebAccessView(current, { admin: true, now: now() });
  assert.equal(view.expectedAddress, '127.0.0.1 · this computer only');
  assert.equal(view.hostsEntry, ''); assert.equal(view.curlCommand, '');
  assert.match(view.browserInstructions, /HTTPS for fixture\.test-tailnet\.ts\.net uses port 8443.*reaches only this computer/);
  assert.match(view.dnsInstructions, /loopback destination cannot provide household access/);
});
