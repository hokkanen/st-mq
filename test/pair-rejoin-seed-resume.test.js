import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { PairManager } from '../src/pairing/manager.js';
import { readReplicaPublication } from '../src/replication/publication.js';
import { JOURNAL_DIGEST } from '../src/replication/incremental.js';

function createDatabase(path) {
  const db = new Store(path).db;
  db.exec("INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality) VALUES('fixture','fixture','temperature',20,'degC',100,100,'[]')");
  db.close();
}

async function manager(t, root, name, { role = 'master', platform = 'ubuntu', create = role === 'master', hooks = {} } = {}) {
  const path = join(root, `${name}.sqlite`);
  if (create) createDatabase(path);
  const config = { directory: join(root, name), snapshotDirectory: join(root, `${name}-replica`),
    databasePath: path, pairId: 'fixture-pair', token: 'synthetic-authority-token-0123456789abcdef',
    platform, listenHost: '127.0.0.1', port: 0, peerUrl: 'http://127.0.0.1:1',
    timeoutMs: 30000, intervalMs: 60000, vip: {} };
  let owned = false;
  const calls = [];
  const result = new PairManager({ config, announcements: () => null,
    vip: { acquire: async () => { owned = true; }, release: async () => { owned = false; }, status: () => ({ owned, ready: owned }) },
    hooks: { startPrimary: async value => calls.push(['master', value.dbPath]), startReplica: async value => calls.push(['slave', value.role]),
      stopControl: async value => calls.push(['stop', value.restore, result.canControl()]), closeReplica: async () => {}, ...hooks } });
  const fresh = await access(join(config.directory, 'state.json')).then(() => false, () => true);
  t.after(() => result.close());
  await result.init(); await result.start(); clearTimeout(result.timer);
  if (fresh && role === 'master') {
    try { await result.promote(); }
    catch (error) { if (result.state.value.role !== 'protected' || !result.state.value.activationError) throw error; }
  }
  result.calls = calls;
  return result;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const command = () => ({ requestId: randomUUID(), confirmed: true });
function connect(left, right) {
  left.peer.peerUrl = `http://127.0.0.1:${right.peer.server.address().port}`;
  right.peer.peerUrl = `http://127.0.0.1:${left.peer.server.address().port}`;
}


async function interruptedSeed(t, { error = 'peer_unavailable', acknowledged = false } = {}) {
  const root = await fixture(t);
  const primary = await manager(t, root, 'master', { platform: 'hassio', hooks: {
    recoveryPreview: async () => ({ previewId: randomBytes(32).toString('hex'), status: 'checked', model: { status: 'not-assessed' } }),
  } });
  let donor = await manager(t, root, 'donor'); connect(primary, donor);
  const originalPath = donor.state.value.activeDbPath, original = new Store(originalPath);
  original.event('synthetic-donor-retained', {}, 100);
  original.setState('synthetic-excluded-control', { enabled: true }); original.close();
  await donor.observeClaim(primary.state.claim());
  await primary.action('check-recovery', command());
  const body = { ...command(), discardUnrecovered: true, previewId: primary.status().recovery.preview.previewId };
  const request = donor.peer.request.bind(donor.peer); let first = true;
  donor.peer.request = async (operation, input, options) => {
    if (operation === 'peer-ack' && first) {
      first = false;
      if (acknowledged) await request(operation, input, options);
      throw Object.assign(Error('synthetic interrupted acknowledgement'), { code: error });
    }
    return request(operation, input, options);
  };
  await assert.rejects(primary.action('rejoin', body), { code: error });
  const operation = structuredClone(primary.state.value.recovery.releaseOperation);
  const publication = await readReplicaPublication(donor.config.snapshotDirectory);
  assert.notEqual(operation.metadata.digestAlgorithm, JOURNAL_DIGEST);
  assert.equal(publication.digestAlgorithm, JOURNAL_DIGEST);
  assert.equal(publication.generation, operation.metadata.generation);
  assert.deepEqual(publication.checkpoint, operation.metadata.checkpoint);
  assert.equal(donor.state.value.role, 'protected'); assert.equal(donor.canControl(), false);
  assert.equal(donor.state.value.releaseReceipt, undefined);
  const manifestPath = join(donor.config.snapshotDirectory, 'publication.json');
  const saved = { manifest: await readFile(manifestPath), accepted: await readFile(publication.dbPath),
    original: await readFile(originalPath), release: structuredClone(donor.state.value.release) };
  return { root, primary, donor, body, operation, publication, manifestPath, originalPath, saved,
    restart: async () => {
      await donor.close();
      donor = await manager(t, root, 'donor', { role: 'slave', create: false }); connect(primary, donor);
      return donor;
    } };
}

for (const outcome of ['expired', 'rejected', 'lost-reply', 'restart'])
  test(`accepted independent seed resumes exact ${outcome} acknowledgement without republishing`, async t => {
    const f = await interruptedSeed(t, { error: outcome === 'rejected' ? 'journal_peer_conflict' : 'peer_unavailable',
      acknowledged: outcome === 'lost-reply' });
    if (outcome === 'restart') f.donor = await f.restart();
    const source = new Store(f.primary.state.value.activeDbPath);
    source.setState('synthetic-later-source', { retained: true }); source.close();
    await assert.rejects(f.primary.action('rejoin', { ...f.body, requestId: randomUUID() }), { code: 'invalid_transition' });
    assert.deepEqual(f.donor.state.value.release, f.saved.release);
    assert.equal((await f.primary.action('rejoin', f.body)).ok, true);
    assert.equal(f.donor.state.value.role, 'slave'); assert.equal(f.donor.canControl(), false);
    assert.equal(f.primary.canControl(), true); assert.equal(f.donor.state.value.release, null);
    assert.equal(f.donor.state.value.releaseReceipt.requestId, f.body.requestId);
    assert.deepEqual(f.donor.state.value.accepted.checkpoint, f.operation.metadata.checkpoint);
    assert.deepEqual(await readFile(f.manifestPath), f.saved.manifest, 'accepted publication is never republished');
    assert.deepEqual(await readFile(f.publication.dbPath), f.saved.accepted, 'accepted SQLite seed bytes remain unchanged');
    assert.deepEqual(await readFile(f.originalPath), f.saved.original, 'original donor evidence remains intact');
    const selected = new Store(f.publication.dbPath, { readOnly: true });
    assert.equal(selected.getState('synthetic-excluded-control'), null);
    assert.equal(selected.getState('synthetic-later-source'), null, 'frozen target is not replaced with later source data');
    assert.equal(selected.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); selected.close();
    const current = new Store(f.primary.state.value.activeDbPath, { readOnly: true });
    assert.deepEqual(current.getState('synthetic-later-source'), { retained: true }); current.close();
  });

for (const changed of ['source-clock', 'source-bytes', 'source-claim', 'accepted-generation', 'accepted-digest', 'accepted-scope', 'peer-authority', 'guard-boundary-publication', 'verification-publication', 'acknowledgement-publication', 'later-local-write'])
  test(`accepted seed retry stays protected after ${changed} changes`, async t => {
    const f = await interruptedSeed(t);
    if (['source-clock', 'source-bytes', 'source-claim'].includes(changed)) {
      const metadata = JSON.parse(f.saved.manifest);
      if (changed === 'source-clock') metadata.sourceAt++;
      else if (changed === 'source-bytes') metadata.bytes++;
      else metadata.claim.ancestors.push({ epoch: randomUUID(), sequence: 0 });
      await writeFile(f.manifestPath, JSON.stringify(metadata));
    } else if (changed === 'accepted-generation') {
      await f.donor.state.update({ accepted: { ...f.donor.state.value.accepted, generation: randomUUID() } });
    } else if (changed === 'accepted-digest') {
      await f.donor.state.update({ accepted: { ...f.donor.state.value.accepted, digest: randomBytes(32).toString('hex') } });
    } else if (changed === 'accepted-scope') {
      await f.donor.state.update({ accepted: { ...f.donor.state.value.accepted, epoch: randomUUID() } });
    } else if (changed === 'peer-authority') {
      const request = f.donor.peer.request.bind(f.donor.peer);
      f.donor.peer.request = async (operation, ...args) => {
        const value = await request(operation, ...args);
        return operation === 'status' ? { ...value, claim: { ...value.claim, epoch: randomUUID() } } : value;
      };
    } else if (changed === 'guard-boundary-publication') {
      const guard = f.donor.replicaPublicationGuard.bind(f.donor);
      f.donor.replicaPublicationGuard = async (...args) => {
        const metadata = JSON.parse(f.saved.manifest); metadata.sourceAt++;
        await writeFile(f.manifestPath, JSON.stringify(metadata));
        return guard(...args);
      };
    } else if (changed === 'verification-publication') {
      const verify = f.donor.fullVerification.bind(f.donor);
      f.donor.fullVerification = async (...args) => {
        const result = await verify(...args);
        const metadata = JSON.parse(f.saved.manifest); metadata.verifiedAt++;
        await writeFile(f.manifestPath, JSON.stringify(metadata));
        return result;
      };
    } else {
      const request = f.donor.peer.request.bind(f.donor.peer);
      f.donor.peer.request = async (operation, ...args) => {
        const value = await request(operation, ...args);
        if (operation === 'peer-ack') {
          if (changed === 'acknowledgement-publication') {
            const metadata = JSON.parse(f.saved.manifest); metadata.verifiedAt++;
            await writeFile(f.manifestPath, JSON.stringify(metadata));
          } else {
            const changed = new Store(f.publication.dbPath); changed.setState('synthetic-unexpected-local-write', true); changed.close();
          }
        }
        return value;
      };
    }
    await assert.rejects(f.primary.action('rejoin', f.body), { code: changed === 'peer-authority' ? 'authority_changed' : 'verification_failed' });
    assert.equal(f.donor.state.value.role, 'protected'); assert.equal(f.donor.canControl(), false);
    assert.equal(f.donor.state.value.releaseReceipt, undefined);
    assert.deepEqual(f.donor.state.value.release, f.saved.release);
    assert.deepEqual(f.primary.state.value.recovery.releaseOperation, f.operation);
    assert.deepEqual(await readFile(f.originalPath), f.saved.original);
  });
