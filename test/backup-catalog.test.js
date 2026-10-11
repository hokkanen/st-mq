import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { createBackupCatalog, listBackupCatalog, publicBackupCatalog } from '../src/storage/backup-catalog.js';
import { createResetArchive, resumeResetArchive } from '../src/pairing/reset-storage.js';
import { SnapshotRepository } from '../src/pairing/snapshots.js';
import { PairManager } from '../src/pairing/manager.js';
import { backupLocation } from '../src/storage/backup-directory.js';

const time = Date.parse('2026-10-11T06:00:00Z');
const name = n => `stmq-2026-10-11T06-00-00-00${n}Z.sqlite`;

test('backup locations distinguish the verified Home Assistant host folder from the app mount', () => {
  const config = { addon: true, configuration: { environment: 'home-assistant', importPath: '/config/secrets.json',
    externalImportPath: '/addon_configs/synthetic_st-mq/secrets.json' }, recording: { backupDirectory: '/config/history/backups' } };
  assert.deepEqual(backupLocation(config), { environment: 'home-assistant', folder: '/addon_configs/synthetic_st-mq/history/backups',
    insideApp: '/config/history/backups', hostMappingKnown: true });
  assert.equal(backupLocation({ ...config, recording: { backupDirectory: '/config' } }).folder, '/addon_configs/synthetic_st-mq');
  for (const directory of ['/data/backups', '/config-other/backups', '/config/../private/backups']) {
    const location = backupLocation({ ...config, recording: { backupDirectory: directory } });
    assert.equal(location.folder, null); assert.equal(location.hostMappingKnown, false);
  }
  assert.equal(backupLocation({ ...config, configuration: { environment: 'home-assistant' } }).folder, null);
  assert.equal(backupLocation({ ...config, configuration: { ...config.configuration, externalImportPath: '/addon_configs/../secrets.json' } }).folder, null);
  assert.deepEqual(backupLocation({ recording: { backupDirectory: '/srv/history/backups' } }),
    { environment: 'standalone', folder: '/srv/history/backups', insideApp: null, hostMappingKnown: true });
});
async function fixture(t) {
  const root = await mkdtemp('/tmp/stmq-backup-catalog-');
  const databaseDir = join(root, 'data'), directory = join(databaseDir, 'backups');
  const config = { dataDir: databaseDir, databaseDir, dbPath: join(databaseDir, 'live.sqlite'),
    recording: { backupDirectory: directory }, pair: { directory: join(root, 'pairing'), snapshotDirectory: join(root, 'snapshots') } };
  const store = new Store(config.dbPath);
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(async () => { close(); await rm(root, { recursive: true, force: true }); });
  const save = async (n = 1, exportedAt = time) => {
    const path = join(directory, name(n));
    await createDatabaseBackup({ sourcePath: store.path, destination: path, exportedAt });
    return path;
  };
  return { root, config, directory, store, save, close, clock: () => time + 3_600_000 };
}

test('catalog reads actual export time off-thread and preserves separately changed file time without claiming a recheck', async t => {
  const f = await fixture(t), path = await f.save();
  await utimes(path, new Date(time + 20_000), new Date(time + 20_000));
  const before = await readFile(path), catalog = await listBackupCatalog(f.config, { clock: f.clock });
  assert.equal(catalog.complete, true);
  assert.equal(catalog.directory, f.directory);
  assert.equal(catalog.copies.length, 1);
  const row = catalog.copies[0];
  assert.equal(row.createdAt, time);
  assert.equal(row.fileModifiedAt, time + 20_000);
  assert.deepEqual(row.verification, { state: 'verified-when-created', at: null });
  assert.match(row.id, /^[a-f0-9]{64}$/);
  assert.equal(row.bytes, before.length);
  const publicRow = publicBackupCatalog(catalog).copies[0];
  for (const key of ['path', 'fingerprint', 'digest', 'checkpoint']) assert.equal(Object.hasOwn(publicRow, key), false);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(f.directory), [name(1)]);
});

test('future exporter time stays unknown and a bounded list explicitly reports partial discovery', async t => {
  const f = await fixture(t);
  await f.save(1, time + 60_000);
  let catalog = await listBackupCatalog(f.config, { clock: () => time });
  assert.equal(catalog.complete, false);
  assert(catalog.reasons.includes('invalid-copy-time'));
  assert.equal(catalog.copies[0].createdAt, null);
  assert.equal(catalog.copies[0].verification.state, 'not-checked');
  await writeFile(join(f.directory, name(2)), 'synthetic corrupt copy');
  catalog = await listBackupCatalog(f.config, { clock: f.clock, maxCopies: 1 });
  assert.equal(catalog.copies.length, 1);
  assert.equal(catalog.complete, false);
  assert(catalog.reasons.includes('copy-limit'));
  const bounded = await listBackupCatalog(f.config, { clock: f.clock, maxEntries: 1 });
  assert.equal(bounded.complete, false);
  assert(bounded.reasons.includes('entry-limit'));
});

test('catalog rejects links and SQLite companions without mutating their source', async t => {
  const f = await fixture(t), path = await f.save();
  await symlink(path, join(f.directory, name(2)));
  await writeFile(`${path}-wal`, 'synthetic companion');
  const before = await readFile(path), catalog = await listBackupCatalog(f.config, { clock: f.clock });
  assert.equal(catalog.complete, false);
  assert.deepEqual(catalog.copies, []);
  assert.deepEqual(await readFile(path), before);
  assert.equal((await lstat(join(f.directory, name(2)))).isSymbolicLink(), true);
});

test('selected copy open is read-only and detects replacement or new companions before publication', async t => {
  const f = await fixture(t), path = await f.save();
  const catalog = createBackupCatalog({ getConfig: () => f.config, clock: f.clock });
  const id = (await catalog.list()).copies[0].id;
  const selected = await catalog.open(id);
  try {
    assert.equal(selected.row.path, path);
    await selected.assertCurrent();
    await rename(path, `${path}.retained`);
    await copyFile(`${path}.retained`, path);
    await assert.rejects(selected.assertCurrent(), { code: 'backup_copy_unavailable' });
  } finally { await selected.release(); }
  const reopened = await catalog.open(id);
  try {
    await writeFile(`${path}-journal`, 'unobserved companion');
    await assert.rejects(reopened.assertCurrent(), { code: 'backup_copy_unavailable' });
  } finally { await reopened.release(); }
  await assert.rejects(catalog.resolve('../arbitrary.sqlite'), { code: 'backup_copy_unavailable' });
});

test('coalesced cached catalog returns the catalog and retains dated unavailable results without resolving them', async t => {
  const f = await fixture(t);
  await f.save();
  let now = f.clock();
  const catalog = createBackupCatalog({ getConfig: () => f.config, clock: () => now });
  const [first, concurrent] = await Promise.all([catalog.list(), catalog.list()]);
  assert.deepEqual(concurrent, first);
  now += 600_001;
  catalog.invalidate();
  await rename(f.directory, `${f.directory}.retained`);
  await writeFile(f.directory, 'a folder is now unavailable');
  const stale = await catalog.list();
  assert.equal(stale.stale, true);
  assert.equal(stale.checkedAt, first.checkedAt);
  assert.equal(stale.lastAttemptAt, now);
  assert.equal(stale.copies.length, 1);
  assert.equal(await catalog.list(), stale, 'A recent failed attempt observes the same five-minute cache');
  assert.notEqual(await catalog.list({ force: true }), stale, 'An explicit refresh retries discovery');
  await assert.rejects(catalog.resolve(first.copies[0].id), { code: 'backup_copy_unavailable' });
});

test('one configured root holds manual copies and complete reset bundles; pending reset refuses root changes', async t => {
  const f = await fixture(t), manual = await f.save();
  await mkdir(f.config.pair.directory, { recursive: true });
  const state = { role: 'master', everWritten: true, activeDbPath: f.config.dbPath };
  await writeFile(join(f.config.pair.directory, 'state.json'), JSON.stringify(state));
  const plan = await createResetArchive({ config: f.config, state, mode: 'fresh', requestId: randomUUID(), clock: () => time });
  assert.equal(dirname(plan.archiveDirectory), join(f.directory, 'reset-archives'));
  const changed = { ...f.config, recording: { backupDirectory: join(f.root, 'another-folder') } };
  await assert.rejects(resumeResetArchive(plan.archiveDirectory, { config: changed, requestId: plan.requestId, mode: 'fresh' }),
    { code: 'pair_reset_unsafe_storage' });
  f.close();
  const result = await resumeResetArchive(plan.archiveDirectory, { config: f.config, requestId: plan.requestId, mode: 'fresh' });
  assert.equal(result.recoveryBackups.length, 1);
  const catalog = await listBackupCatalog(f.config, { clock: f.clock });
  assert.deepEqual(catalog.copies.map(copy => copy.kind).sort(), ['backup', 'reset']);
  assert.equal(catalog.complete, true);
  await access(manual);
  await access(join(plan.archiveDirectory, 'reset.json'));
  await access(join(plan.archiveDirectory, 'database', 'configured.sqlite'));
});

test('managed immutable pairing generations retain pins through restart and catalog excludes routine rolling snapshots', async t => {
  const f = await fixture(t), directory = join(f.directory, 'pair-exports');
  const manager = new PairManager({ config: { directory: f.config.pair.directory, snapshotDirectory: f.config.pair.snapshotDirectory,
    databasePath: f.config.dbPath, snapshotExportDirectory: directory, vip: {} }, vip: {}, peer: {} });
  assert.equal(manager.snapshots.directory, directory);
  const repository = manager.snapshots;
  await repository.init();
  const claim = { nodeId: randomUUID(), epoch: randomUUID(), role: 'protected', platform: 'ubuntu' };
  const pinned = await repository.create({ dbPath: f.store.path, claim, sequence: 1, force: true, pin: true });
  for (let sequence = 2; sequence < 5; sequence++) await repository.create({ dbPath: f.store.path, claim, sequence, force: true });
  const restarted = new SnapshotRepository({ directory });
  await restarted.init();
  await access(join(directory, `export-${pinned.generation}.pin`));
  const catalog = await listBackupCatalog({ ...f.config, pair: {} }, { clock: f.clock });
  assert.equal(catalog.complete, true);
  assert.equal(catalog.copies.length, 1);
  assert.equal(catalog.copies[0].kind, 'protected');
  assert.equal(catalog.copies[0].digest, pinned.digest);
  assert.deepEqual(catalog.copies[0].checkpoint, pinned.checkpoint);
  assert.equal(Object.hasOwn(publicBackupCatalog(catalog).copies[0], 'digest'), false);
  assert.equal(Object.hasOwn(publicBackupCatalog(catalog).copies[0], 'checkpoint'), false);
  const operational = await restarted.create({ dbPath: f.store.path, claim: { ...claim, role: 'master' }, sequence: 5,
    force: true, pin: true });
  assert.equal((await listBackupCatalog(f.config, { clock: f.clock })).copies.length, 1,
    'An active peer-transfer seed does not become a retained household backup');
  await access(join(directory, `export-${operational.generation}.pin`));
  assert.equal(catalog.copies[0].createdAt, pinned.sourceAt);
  assert.equal(catalog.copies[0].verification.state, 'not-checked');
  const changedDirectory = join(f.root, 'different-folder', 'pair-exports');
  const redirected = new PairManager({ config: { directory: f.config.pair.directory,
    snapshotDirectory: f.config.pair.snapshotDirectory, snapshotExportDirectory: changedDirectory, vip: {} }, vip: {}, peer: {},
    state: { invalid: false, value: { role: 'protected', nodeId: claim.nodeId, epoch: claim.epoch,
      release: { preservedSnapshot: pinned, identity: { donorDigest: pinned.digest, donorBytes: pinned.bytes } } } } });
  await assert.rejects(redirected.init({ stateOpen: true }), { code: 'snapshot_unavailable' });
  await assert.rejects(access(changedDirectory), { code: 'ENOENT' });
  await access(join(directory, `export-${pinned.generation}.pin`));
  await restarted.unpin(pinned.generation);
  await restarted.prune(null);
  assert.equal((await listBackupCatalog(f.config, { clock: f.clock })).copies.length, 0);
});
