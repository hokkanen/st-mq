import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PairManager } from '../src/pairing/manager.js';
import { JOURNAL_DIGEST } from '../src/replication/incremental.js';

async function fixture(t, journal = false) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-recovery-paths-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'pair'), owned = join(directory, journal ? 'peer-recovery' : 'recovery');
  await mkdir(owned, { recursive: true });
  await writeFile(join(owned, journal ? '.st-mq-peer-receive' : '.st-mq-recovery-download'), '');
  const generation = randomUUID(), requestId = randomUUID();
  const path = join(owned, journal ? `incoming-peer-${randomUUID()}.changes` : `incoming-${generation}.sqlite`);
  await writeFile(path, 'original recovery evidence');
  const metadata = { generation, digest: 'a'.repeat(64), digestAlgorithm: JOURNAL_DIGEST, claim: { role: 'protected' } };
  const operation = { requestId, skipRecovery: false, verifyWithFullSnapshot: false, metadata };
  const recovery = { state: 'complete', metadata, report: { status: 'complete' }, releaseOperation: operation,
    [journal ? 'donorJournalPath' : 'donorPath']: path };
  let releases = 0;
  const manager = Object.create(PairManager.prototype);
  manager.config = { directory };
  manager.canControl = () => true;
  manager.state = { value: { recovery }, update: async patch => Object.assign(manager.state.value, patch) };
  manager.peer = { request: async name => { assert.equal(name, 'release'); releases++; await manager.onRelease?.();
    return { role: 'slave', releaseReceipt: { digest: metadata.digest, generation, requestId } }; } };
  manager.recordPeerStatus = () => {};
  return { root, directory, owned, path, recovery, manager, body: { requestId }, releases: () => releases,
    key: journal ? 'donorJournalPath' : 'donorPath' };
}

for (const journal of [false, true]) {
  const label = journal ? 'journal' : 'snapshot';
  test(`successful rejoin deletes only its unchanged owned ${label} download`, async t => {
    const f = await fixture(t, journal);
    await f.manager.rejoin(f.body);
    assert.equal(f.releases(), 1);
    assert.equal(f.manager.state.value.recovery.state, 'resolved');
    await assert.rejects(access(f.path), { code: 'ENOENT' });
  });
  for (const kind of ['outside', 'traversal', 'wrong-name', 'symlink', 'hardlink', 'directory-symlink', 'missing-marker'])
    test(`rejoin rejects ${kind} ${label} paths before remote release and preserves evidence`, async t => {
      const f = await fixture(t, journal), unrelated = join(f.root, 'unrelated.sqlite');
      await writeFile(unrelated, 'unrelated database');
      const outsideBytes = await readFile(unrelated);
      if (kind === 'outside') f.recovery[f.key] = unrelated;
      if (kind === 'traversal') f.recovery[f.key] = join(f.directory, 'recovery') + '/../recovery/' + f.path.split('/').at(-1);
      if (kind === 'wrong-name') { const renamed = join(f.owned, 'other.sqlite'); await rename(f.path, renamed); f.recovery[f.key] = renamed; }
      if (kind === 'symlink' || kind === 'hardlink') { await rm(f.path); await (kind === 'symlink' ? symlink : link)(unrelated, f.path); }
      if (kind === 'directory-symlink') { await rename(f.owned, f.owned + '-preserved'); await symlink(f.owned + '-preserved', f.owned); }
      if (kind === 'missing-marker') await rm(join(f.owned, journal ? '.st-mq-peer-receive' : '.st-mq-recovery-download'));
      await assert.rejects(f.manager.rejoin(f.body));
      assert.equal(f.releases(), 0);
      assert.equal(f.manager.state.value.recovery, f.recovery);
      assert.deepEqual(await readFile(unrelated), outsideBytes);
      assert.equal(await readFile(kind === 'wrong-name' ? f.recovery[f.key] : f.path, 'utf8'),
        ['symlink', 'hardlink'].includes(kind) ? 'unrelated database' : 'original recovery evidence');
    });
  test(`rejoin preserves a ${label} file replaced while awaiting the peer`, async t => {
    const f = await fixture(t, journal);
    f.manager.onRelease = async () => { await rename(f.path, f.path + '.preserved'); await writeFile(f.path, 'replacement evidence'); };
    await assert.rejects(f.manager.rejoin(f.body), { code: 'unsafe_file' });
    assert.equal(f.releases(), 1);
    assert.equal(f.manager.state.value.recovery.state, 'resolved', 'the confirmed remote release is not rolled back');
    assert.equal(await readFile(f.path, 'utf8'), 'replacement evidence');
    assert.equal(await readFile(f.path + '.preserved', 'utf8'), 'original recovery evidence');
  });
  test(`an absent ${label} download gives no authority to delete a later file`, async t => {
    const f = await fixture(t, journal); await rm(f.path);
    f.manager.onRelease = () => writeFile(f.path, 'later evidence');
    await f.manager.rejoin(f.body);
    assert.equal(await readFile(f.path, 'utf8'), 'later evidence');
  });
  for (const owner of ['configured', 'active', 'alias']) test(`rejoin preserves a ${label} path owned by the ${owner} database`, async t => {
    const f = await fixture(t, journal);
    if (owner === 'configured') f.manager.config.databasePath = f.path;
    else if (owner === 'active') f.manager.state.value.activeDbPath = f.path;
    else { f.manager.config.databasePath = join(f.root, 'active.sqlite'); await symlink(f.path, f.manager.config.databasePath); }
    await assert.rejects(f.manager.rejoin(f.body), { code: 'unsafe_file' });
    assert.equal(f.releases(), 0);
    assert.equal(await readFile(f.path, 'utf8'), 'original recovery evidence');
  });
  test(`rejoin preserves a ${label} file that becomes active while awaiting the peer`, async t => {
    const f = await fixture(t, journal);
    f.manager.onRelease = async () => { f.manager.state.value.activeDbPath = f.path; };
    await assert.rejects(f.manager.rejoin(f.body), { code: 'unsafe_file' });
    assert.equal(f.releases(), 1);
    assert.equal(f.manager.state.value.recovery.state, 'resolved');
    assert.equal(await readFile(f.path, 'utf8'), 'original recovery evidence');
  });
}
