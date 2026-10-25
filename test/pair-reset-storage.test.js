import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { archiveRoot, createResetArchive, listResetBackups, resumeResetArchive, scanResetBackups, selectResetDatabase, createLocalReset, resumeLocalReset, finishLocalReset } from '../src/pairing/reset-storage.js';

async function file(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600 });
}

async function fixture(t) {
  const root = await mkdtemp('/tmp/stmq-pair-reset-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { addon: false, dataDir: join(root, 'private'), databaseDir: join(root, 'public', 'st-mq'),
    pair: { directory: join(root, 'private', 'pairing'), snapshotDirectory: join(root, 'public', 'st-mq', 'pair-snapshots') } };
  config.dbPath = join(config.databaseDir, 'st-mq.sqlite');
  const state = { nodeId: randomUUID(), role: 'master', everWritten: true, activeDbPath: config.dbPath };
  await file(join(config.pair.directory, 'state.json'), JSON.stringify(state));
  await file(join(config.pair.directory, '.st-mq-pair'), '');
  await file(join(config.pair.directory, '.node-lock.sqlite'), 'stable lock');
  await file(join(config.pair.snapshotDirectory, '.st-mq-replica'), '');
  await file(join(config.pair.snapshotDirectory, '.st-mq-paired-receiver'), '');
  await file(config.dbPath, 'database bytes');
  const create = (mode, override = {}) => createResetArchive({ config, state, mode, requestId: randomUUID(),
    clock: () => 2000, ...override });
  return { root, config, state, create };
}

const absent = async path => { await assert.rejects(lstat(path), { code: 'ENOENT' }); };
const archived = (plan, source) => join(plan.archiveDirectory, plan.entries.find(entry => entry.source === source).destination);
const resume = (plan, config, source = plan) => resumeResetArchive(source, { config, requestId: plan.requestId, mode: plan.mode });

async function walFixture(root, destination, value) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root, 'synthetic-wal-'));
  const store = new Store(join(staging, 'source.sqlite'));
  try {
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    store.setState('synthetic-backup-evidence', value);
    for (const suffix of ['', '-wal', '-shm']) await copyFile(`${store.path}${suffix}`, `${destination}${suffix}`);
  } finally { store.close(); await rm(staging, { recursive: true, force: true }); }
}

test('reset archives produce separate verified portable backups including committed WAL and preserve every original byte', async t => {
  const { root, config, state, create } = await fixture(t);
  await walFixture(root, config.dbPath, 'configured');
  const active = join(config.pair.directory, 'promoted.sqlite');
  await walFixture(root, active, 'active');
  state.activeDbPath = active;
  const plan = await create('fresh');
  const originals = new Map();
  for (const entry of plan.entries) originals.set(entry.source, await readFile(entry.source));
  const result = await resume(plan, config);
  assert.equal(result.recoveryBackups.length, 2);
  assert.equal(result.recoveryBackupUnavailable, null);
  const values = [];
  for (const item of result.recoveryBackups) {
    assert.equal(item.status, 'complete');
    assert.equal((await stat(item.path)).mode & 0o777, 0o600);
    const db = new DatabaseSync(item.path, { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
      values.push(JSON.parse(db.prepare("SELECT value FROM state WHERE key='synthetic-backup-evidence'").get().value));
    } finally { db.close(); }
    await absent(`${item.path}-wal`); await absent(`${item.path}-shm`);
  }
  assert.deepEqual(values.sort(), ['active', 'configured']);
  for (const entry of plan.entries) assert.deepEqual(await readFile(archived(plan, entry.source)), originals.get(entry.source));
  assert.deepEqual(await resume(plan, config, plan.archiveDirectory), result);
  const available = await listResetBackups(config);
  assert.deepEqual(available.map(item => item.path).sort(), result.recoveryBackups.map(item => item.path).sort());
  assert(available.every(item => /^[a-f0-9]{64}$/.test(item.id) && item.kind === 'reset'));
  assert.equal(new Set(available.map(item => item.id)).size, 2);
  const limited = await scanResetBackups(config, { maxCopies: 1 });
  assert.equal(limited.copies.length, 1); assert.equal(limited.complete, false);
  assert(limited.reasons.includes('copy-limit'));
  assert.deepEqual(await listResetBackups({ ...config, pair: {} }), available,
    'standalone can select completed reset backups after changing topology');
});

test('incompatible and corrupt databases remain intact with explicit unavailable backup reasons', async t => {
  const { config, create } = await fixture(t);
  const retired = join(config.pair.directory, 'retired.sqlite');
  const db = new DatabaseSync(retired);
  db.exec('CREATE TABLE old_records (value); INSERT INTO old_records VALUES (17); PRAGMA user_version=1'); db.close();
  const original = await readFile(retired);
  const plan = await create('fresh'), result = await resume(plan, config);
  assert.deepEqual(result.recoveryBackups.map(item => item.reason).sort(), ['incompatible-database', 'invalid-database']);
  assert(result.recoveryBackups.every(item => item.status === 'unavailable' && item.path === null));
  assert.deepEqual(await readFile(archived(plan, retired)), original);
  assert.equal(await readFile(archived(plan, config.dbPath), 'utf8'), 'database bytes');
  assert.deepEqual(await listResetBackups(config), []);
});

async function relocateArchive(config, plan, root) {
  const relocated = { ...config, recording: { backupDirectory: join(root, 'relocated-backups') } };
  await mkdir(relocated.recording.backupDirectory, { recursive: true });
  await rename(plan.archiveRoot, archiveRoot(relocated));
  return { config: relocated, directory: join(archiveRoot(relocated), plan.archiveDirectory.split('/').at(-1)) };
}

test('read-only discovery recognizes relocated preserved history without opening incompatible databases or permitting reset resume', async t => {
  const { root, config, create } = await fixture(t);
  const retired = join(config.pair.directory, 'retired.sqlite');
  const db = new DatabaseSync(retired);
  db.exec('CREATE TABLE unsupported_records (value); PRAGMA user_version=1'); db.close();
  const original = await readFile(retired);
  const plan = await create('fresh'); await resume(plan, config);
  const manifest = await readFile(join(plan.archiveDirectory, 'reset.json'));
  const moved = await relocateArchive(config, plan, root);
  const result = await scanResetBackups(moved.config);
  assert.equal(result.complete, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.copies, []);
  assert.deepEqual(result.preservedArchives, [{ createdAt: plan.createdAt, relocated: true,
    reasons: ['incompatible-database', 'invalid-database'] }]);
  assert.deepEqual(await readFile(join(moved.directory, 'reset.json')), manifest);
  const retiredEntry = plan.entries.find(entry => entry.source === retired);
  assert.deepEqual(await readFile(join(moved.directory, retiredEntry.destination)), original);
  await assert.rejects(resumeResetArchive(moved.directory, { config: moved.config, requestId: plan.requestId, mode: plan.mode }),
    { code: 'pair_reset_unsafe_storage' });
  assert.deepEqual(await readFile(join(moved.directory, 'reset.json')), manifest, 'A refused resume never rewrites provenance');
});

test('relocated completed current-format copies remain discoverable with current physical paths and unchanged manifests', async t => {
  const { root, config, create } = await fixture(t);
  await walFixture(root, config.dbPath, 'relocated-current-copy');
  const plan = await create('fresh'), saved = await resume(plan, config);
  const manifest = await readFile(join(plan.archiveDirectory, 'reset.json'));
  const bytes = await readFile(saved.recoveryBackups[0].path);
  const moved = await relocateArchive(config, plan, root);
  const result = await scanResetBackups(moved.config);
  assert.equal(result.complete, true); assert.deepEqual(result.reasons, []);
  assert.equal(result.copies.length, 1); assert.deepEqual(result.preservedArchives, []);
  assert.equal(result.copies[0].path, join(moved.directory, plan.recoveryBackups[0].destination));
  assert.deepEqual(await readFile(result.copies[0].path), bytes);
  assert.deepEqual(await readFile(join(moved.directory, 'reset.json')), manifest);
  await assert.rejects(resumeResetArchive(moved.directory, { config: moved.config, requestId: plan.requestId, mode: plan.mode }),
    { code: 'pair_reset_unsafe_storage' });
  const renamed = join(dirname(moved.directory), `${new Date(plan.createdAt).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
  await rename(moved.directory, renamed);
  const renamedResult = await scanResetBackups(moved.config);
  assert.equal(renamedResult.complete, false); assert.deepEqual(renamedResult.copies, []);
  await rename(renamed, moved.directory);
  for (const change of [value => { value.complete = false; }, value => { value.version = 1; },
    value => { value.unrecognizedField = true; }, value => { value.recoveryBackups[0].destination = '../escape.sqlite'; }]) {
    const edited = JSON.parse(manifest); change(edited);
    await writeFile(join(moved.directory, 'reset.json'), JSON.stringify(edited));
    const refused = await scanResetBackups(moved.config);
    assert.equal(refused.complete, false); assert(refused.reasons.includes('unavailable-archives'));
    assert.deepEqual(refused.copies, []); assert.deepEqual(refused.preservedArchives, []);
  }
});

test('a missing portable sibling cannot leave a partial archive advertised as a donor', async t => {
  const { root, config, state, create } = await fixture(t);
  await walFixture(root, config.dbPath, 'configured');
  const active = join(config.pair.directory, 'active.sqlite');
  await walFixture(root, active, 'active'); state.activeDbPath = active;
  const plan = await create('fresh'), result = await resume(plan, config);
  assert.equal(result.recoveryBackups.length, 2);
  const manifest = await readFile(join(plan.archiveDirectory, 'reset.json'));
  const missing = result.recoveryBackups[1].path;
  await rename(missing, `${missing}.retained`);
  const scan = await scanResetBackups(config);
  assert.equal(scan.complete, false); assert(scan.reasons.includes('unavailable-archives'));
  assert.deepEqual(scan.copies, []); assert.deepEqual(scan.preservedArchives, []);
  assert.deepEqual(await readFile(join(plan.archiveDirectory, 'reset.json')), manifest);
});

test('retry verifies a published backup left before its manifest acknowledgement and refuses a changed copy', async t => {
  const { root, config, create } = await fixture(t);
  await walFixture(root, config.dbPath, 42);
  const plan = await create('fresh'), result = await resume(plan, config);
  const manifestPath = join(plan.archiveDirectory, 'reset.json');
  const interrupted = JSON.parse(await readFile(manifestPath, 'utf8'));
  interrupted.complete = false;
  interrupted.recoveryBackups[0] = { ...interrupted.recoveryBackups[0], status: 'pending', bytes: null, digest: null, reason: null };
  await writeFile(manifestPath, JSON.stringify(interrupted));
  assert.deepEqual(await resume(plan, config), result);
  await writeFile(manifestPath, JSON.stringify(interrupted));
  await writeFile(result.recoveryBackups[0].path, 'unrelated existing contents');
  await assert.rejects(resume(plan, config), { code: 'pair_reset_storage_failed' });
  assert.equal(await readFile(result.recoveryBackups[0].path, 'utf8'), 'unrelated existing contents');
  assert.equal(await readFile(archived(plan, config.dbPath), 'utf8').then(value => value.startsWith('SQLite format 3')), true);
});

test('reset backup discovery excludes malformed manifests, unfinished archives and replaced file links', async t => {
  const { root, config, create } = await fixture(t);
  await walFixture(root, config.dbPath, 42);
  const plan = await create('fresh');
  assert.deepEqual(await listResetBackups(config), []);
  const result = await resume(plan, config), backup = result.recoveryBackups[0].path;
  const saved = `${backup}.saved`;
  await rename(backup, saved); await symlink(saved, backup);
  assert.deepEqual(await listResetBackups(config), []);
  await rm(backup); await rename(saved, backup);
  const manifestPath = join(plan.archiveDirectory, 'reset.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.recoveryBackups[0].destination = '../outside.sqlite';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(await listResetBackups(config), []);
  await assert.rejects(resume(plan, config), { code: 'pair_reset_unsafe_storage' });
});

test('fresh reset archives exact database sidecars and pairing state without touching credentials or the node lock', async t => {
  const { config, create } = await fixture(t);
  const originalState = Buffer.from('{invalid state, retained byte for byte}\n');
  await file(join(config.pair.directory, 'state.json'), originalState);
  const privateToken = join(config.dataDir, 'provider-token.json');
  await file(privateToken, 'synthetic private token');
  for (const suffix of ['-wal', '-shm', '-journal']) await file(`${config.dbPath}${suffix}`, suffix);
  await file(join(config.pair.directory, 'exports', 'fixture.sqlite'), 'export');
  const plan = await create('fresh');
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes', 'planning never moves source files');
  assert.deepEqual(await readFile(join(plan.archiveDirectory, 'pairing', 'state.json')), originalState);
  // The lifecycle writes the protected pending-reset state after archiving the old bytes.
  await file(join(config.pair.directory, 'state.json'), 'protected reset in progress');
  const result = await resume(plan, config);
  assert.equal(result.keptDbPath, null);
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    assert.equal(await readFile(archived(plan, `${config.dbPath}${suffix}`), 'utf8'), suffix || 'database bytes');
    await absent(`${config.dbPath}${suffix}`);
  }
  assert.equal(await readFile(privateToken, 'utf8'), 'synthetic private token');
  assert.equal(await readFile(join(config.pair.directory, '.node-lock.sqlite'), 'utf8'), 'stable lock');
  assert.equal(await readFile(join(config.pair.directory, 'state.json'), 'utf8'), 'protected reset in progress');
  await absent(join(config.pair.directory, 'exports'));
  assert.deepEqual((await readdir(config.pair.snapshotDirectory)).sort(), ['.st-mq-paired-receiver', '.st-mq-replica']);
  assert.equal((await stat(plan.archiveDirectory)).mode & 0o777, 0o700);
  for (const entry of plan.entries) assert.equal((await stat(archived(plan, entry.source))).mode & 0o777, 0o600);
  assert.deepEqual(await resume(plan, config, plan.archiveDirectory), result, 'completed archive is idempotent');
});

for (const mode of ['fresh']) test(`${mode} reset archives only recognized database peer companions byte for byte`, async t => {
  const { config, create } = await fixture(t), id = randomUUID();
  const suffixes = [`.peer-${id}.sqlite`, `.peer-${id}.sqlite-journal`, `.peer-${id}.sqlite-wal`,
    `.peer-${id}.sqlite-shm`, `.peer-${id}.sqlite.partial`, `.peer-${id}.sqlite.partial-journal`,
    '.peer-lock', '.peer-lock-journal'];
  for (const suffix of suffixes) await file(`${config.dbPath}${suffix}`, `synthetic retained bytes ${suffix}`);
  const unrelated = [`${config.dbPath}.peer-${id}.sqlite.extra`, `${config.dbPath}.peer-not-a-uuid.sqlite`,
    `${config.dbPath}.peer-lock.extra`, `${config.dbPath}.other.peer-${id}.sqlite`];
  for (const path of unrelated) await file(path, 'unrelated sibling');
  const plan = await create(mode);
  assert.equal(plan.recoveryBackups.length, 1, 'transfer spools are evidence, not standalone application backups');
  for (const suffix of suffixes) {
    assert(plan.entries.some(entry => entry.source === `${config.dbPath}${suffix}`));
    assert.equal(await readFile(`${config.dbPath}${suffix}`, 'utf8'), `synthetic retained bytes ${suffix}`, 'planning is read only');
  }
  const first = plan.entries.find(entry => entry.source === `${config.dbPath}${suffixes[0]}`);
  const moved = archived(plan, first.source);
  await mkdir(dirname(moved), { recursive: true });
  await rename(first.source, moved); // Crash after moving a peer spool, before acknowledging that archive entry.
  const result = await resume(plan, config, plan.archiveDirectory);
  for (const suffix of suffixes) {
    assert.equal(await readFile(archived(plan, `${config.dbPath}${suffix}`), 'utf8'), `synthetic retained bytes ${suffix}`);
    await absent(`${config.dbPath}${suffix}`);
  }
  for (const path of unrelated) assert.equal(await readFile(path, 'utf8'), 'unrelated sibling');
  assert.equal(await readFile(join(config.pair.directory, '.node-lock.sqlite'), 'utf8'), 'stable lock');
  assert.deepEqual(await resume(plan, config, plan.archiveDirectory), result);
});

test('peer companion discovery rejects matching symlinks without following unrelated sibling links', async t => {
  const { root, config, create } = await fixture(t), target = join(root, 'unrelated', 'evidence');
  await file(target, 'unrelated evidence');
  const unrelated = `${config.dbPath}.peer-not-a-uuid.sqlite`;
  await symlink(target, unrelated);
  const recognized = `${config.dbPath}.peer-${randomUUID()}.sqlite`;
  await symlink(target, recognized);
  await assert.rejects(create('fresh'), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(target, 'utf8'), 'unrelated evidence');
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  await rm(recognized);
  const plan = await create('fresh');
  assert(!plan.entries.some(entry => entry.source === unrelated));
});

test('an edited reset manifest cannot expand a peer companion into an unrelated sibling', async t => {
  const { config, create } = await fixture(t);
  const companion = `${config.dbPath}.peer-${randomUUID()}.sqlite`, unrelated = `${companion}.extra`;
  await file(companion, 'retained spool'); await file(unrelated, 'retained spool');
  const plan = await create('fresh'), manifestPath = join(plan.archiveDirectory, 'reset.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.entries.find(entry => entry.source === companion).source = unrelated;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(resume(plan, config), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(unrelated, 'utf8'), 'retained spool');
  assert.equal(await readFile(companion, 'utf8'), 'retained spool');
});

async function local(config, state, mode) {
  const requestId = randomUUID();
  const prepared = await createLocalReset({ config, state, mode, requestId });
  const journal = { requestId, mode, backup: false, originalNodeId: state.nodeId, archiveDirectory: null, storagePlan: prepared.storagePlan };
  return { journal, result: await resumeLocalReset({ config, journal }) };
}

test('keep preserves the selected promoted database and SQLite companions in place without reading history', async t => {
  const { config, state } = await fixture(t);
  const promoted = join(config.pair.directory, `master-${randomUUID()}.sqlite`);
  state.activeDbPath = promoted;
  await file(promoted, 'promoted household history');
  await file(`${promoted}-wal`, 'promoted WAL bytes');
  await file(`${promoted}-shm`, 'promoted SHM bytes');
  const before = await stat(promoted);
  const { result } = await local(config, state, 'keep');
  assert.equal(result.keptDbPath, promoted);
  assert.equal((await stat(promoted)).ino, before.ino);
  assert.equal(await readFile(promoted, 'utf8'), 'promoted household history');
  assert.equal(await readFile(`${promoted}-wal`, 'utf8'), 'promoted WAL bytes');
  assert.equal(await readFile(`${promoted}-shm`, 'utf8'), 'promoted SHM bytes');
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  await absent(archiveRoot(config));
});

test('fresh discard removes active history and recognized spools but preserves old backups, credentials and lock', async t => {
  const { config, state } = await fixture(t);
  const previous = join(archiveRoot(config), 'existing', 'original.sqlite');
  await file(previous, 'old independent backup');
  const unrelated = join(dirname(config.dbPath), 'provider-secret.json');
  await file(unrelated, 'synthetic unrelated file');
  const spool = `${config.dbPath}.peer-${randomUUID()}.sqlite`;
  await file(spool, 'pending delivery');
  const { journal, result } = await local(config, state, 'fresh');
  assert.equal(result.keptDbPath, null); assert.deepEqual(result.recoveryBackups, []);
  await absent(config.dbPath); await absent(spool);
  assert.equal(await readFile(previous, 'utf8'), 'old independent backup');
  assert.equal(await readFile(unrelated, 'utf8'), 'synthetic unrelated file');
  assert.equal(await readFile(join(config.pair.directory, '.node-lock.sqlite'), 'utf8'), 'stable lock');
  assert.deepEqual(await resumeLocalReset({ config, journal }), result, 'missing already-discarded files are safe on explicit retry');
  await finishLocalReset({ config, storagePlan: journal.storagePlan });
  await absent(journal.storagePlan);
});

test('slave and protected replica keep actual published history without copying an unrelated configured database', async t => {
  const { config, state } = await fixture(t);
  const generation = randomUUID(), snapshot = join(config.pair.snapshotDirectory, `snapshot-${generation}.sqlite`);
  await file(snapshot, 'accepted snapshot history');
  await file(join(config.pair.snapshotDirectory, 'publication.json'), JSON.stringify({ format: 2, fileGeneration: generation, checkpoint: { databaseId: randomUUID(), sequence: 0, hash: 'b'.repeat(64) },
    digestAlgorithm: 'sha256-sqlite-pages-v1', generation, digest: 'a'.repeat(64), bytes: 512,
    sourceStartedAt: 1000, sourceAt: 1100, verifiedAt: 1200, previousGeneration: null }));
  for (const role of ['slave', 'protected']) {
    const { result } = await local(config, { ...state, role, everWritten: false }, 'keep');
    assert.equal(result.keptDbPath, snapshot);
    assert.equal(await readFile(result.keptDbPath, 'utf8'), 'accepted snapshot history');
  }
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
});

test('fresh can preserve an invalid publication unchanged while keep refuses to guess history', async t => {
  const { config, state, create } = await fixture(t);
  const publication = join(config.pair.snapshotDirectory, 'publication.json');
  await file(publication, '{not a current publication}');
  const localState = { ...state, role: 'slave', everWritten: false };
  await assert.rejects(local(config, localState, 'keep'), { code: 'pair_reset_history_unavailable' });
  const plan = await create('fresh', { state: localState }); await resume(plan, config);
  assert.equal(await readFile(archived(plan, publication), 'utf8'), '{not a current publication}');
});

test('keep refuses missing active history instead of silently returning empty', async t => {
  const { config, state } = await fixture(t);
  await assert.rejects(local(config, { ...state, activeDbPath: join(config.pair.directory, 'missing-master.sqlite') }, 'keep'), { code: 'pair_reset_history_unavailable' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
});

test('discard rejects replaced files, expanded manifests, symlinks, and retargeted config before erasing evidence', async t => {
  const { root, config, state } = await fixture(t);
  const requestId = randomUUID(), prepared = await createLocalReset({ config, state, mode: 'fresh', requestId });
  const journal = { requestId, mode: 'fresh', backup: false, originalNodeId: state.nodeId, archiveDirectory: null, storagePlan: prepared.storagePlan };
  const saved = await readFile(journal.storagePlan);
  const wrong = JSON.parse(saved); wrong.entries[0].source = join(root, 'unrelated');
  await file(wrong.entries[0].source, 'unrelated bytes');
  await writeFile(journal.storagePlan, JSON.stringify(wrong));
  await assert.rejects(resumeLocalReset({ config, journal }), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  await writeFile(journal.storagePlan, saved);
  await rename(config.dbPath, `${config.dbPath}.original`);
  await file(config.dbPath, 'new history must not be deleted');
  await assert.rejects(resumeLocalReset({ config, journal }), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'new history must not be deleted');
  await rm(config.dbPath); await symlink(`${config.dbPath}.original`, config.dbPath);
  await assert.rejects(resumeLocalReset({ config, journal }), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(`${config.dbPath}.original`, 'utf8'), 'database bytes');
  await assert.rejects(resumeLocalReset({ config: { ...config, dbPath: join(root, 'elsewhere.sqlite') }, journal }), { code: 'pair_reset_unsafe_storage' });
});

test('explicit retry finishes an interrupted move before its manifest acknowledgement', async t => {
  const { config, create } = await fixture(t);
  await file(`${config.dbPath}-wal`, 'outstanding committed pages');
  const plan = await create('fresh');
  const entry = plan.entries.find(value => value.source === config.dbPath);
  const target = archived(plan, config.dbPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rename(entry.source, target); // Simulated crash between rename and journal acknowledgement.
  await resume(plan, config, plan.archiveDirectory);
  assert.equal(await readFile(target, 'utf8'), 'database bytes');
  assert.equal(await readFile(archived(plan, `${config.dbPath}-wal`), 'utf8'), 'outstanding committed pages');
});

test('partial archive failure preserves committed copies and can be retried without repeating finished moves', async t => {
  const { config, create } = await fixture(t);
  await file(join(config.pair.directory, 'old.sqlite'), 'other retained history');
  const plan = await create('fresh');
  const target = archived(plan, config.dbPath);
  await file(target, 'unexpected conflicting file');
  await assert.rejects(resume(plan, config), { code: 'pair_reset_storage_failed' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  assert.equal(await readFile(archived(plan, join(config.pair.directory, 'old.sqlite')), 'utf8'), 'other retained history');
  await rm(target);
  await resume(plan, config);
  assert.equal(await readFile(target, 'utf8'), 'database bytes');
});

test('changed source bytes fail closed without replacing or deleting either copy', async t => {
  const { config, create } = await fixture(t);
  const plan = await create('fresh');
  await file(config.dbPath, 'new writes after preflight');
  await assert.rejects(resume(plan, config), { code: 'pair_reset_storage_failed' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'new writes after preflight');
  await absent(archived(plan, config.dbPath));
});

test('reset storage rejects symlinks, unsafe nesting and active paths outside configured storage', async t => {
  for (const kind of ['file-symlink', 'directory-symlink', 'archive-symlink', 'nested-roots', 'outside-active']) await t.test(kind, async t => {
    const { root, config, state, create } = await fixture(t);
    const outside = join(root, 'unrelated');
    await file(join(outside, 'untouched'), 'unrelated file');
    if (kind === 'file-symlink') await symlink(join(outside, 'untouched'), join(config.pair.directory, 'suspicious.sqlite'));
    if (kind === 'directory-symlink') await symlink(outside, join(config.pair.directory, 'nested'));
    if (kind === 'archive-symlink') { await mkdir(dirname(archiveRoot(config)), { recursive: true }); await symlink(outside, archiveRoot(config)); }
    if (kind === 'nested-roots') config.pair.snapshotDirectory = join(config.pair.directory, 'snapshots');
    if (kind === 'outside-active') state.activeDbPath = join(outside, 'untouched');
    await assert.rejects(create('fresh'), { code: 'pair_reset_unsafe_storage' });
    assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
    assert.equal(await readFile(join(outside, 'untouched'), 'utf8'), 'unrelated file');
  });
});

async function configuredAlias(t) {
  const f = await fixture(t);
  const physical = join(f.root, 'physical-var'), alias = join(f.root, 'var');
  await mkdir(physical, { mode: 0o700 });
  await symlink(physical, alias);
  Object.assign(f.config, { dataDir: alias, databaseDir: alias, dbPath: join(alias, 'st-mq.sqlite') });
  f.config.pair = { directory: join(alias, 'pairing'), snapshotDirectory: join(alias, 'pair-snapshots') };
  f.state.activeDbPath = f.config.dbPath;
  await file(join(f.config.pair.directory, 'state.json'), JSON.stringify(f.state));
  await file(join(f.config.pair.directory, '.st-mq-pair'), '');
  await file(join(f.config.pair.directory, '.node-lock.sqlite'), 'stable lock');
  await file(join(f.config.pair.snapshotDirectory, '.st-mq-replica'), '');
  await file(join(f.config.pair.snapshotDirectory, '.st-mq-paired-receiver'), '');
  await file(f.config.dbPath, 'history behind configured alias');
  return { ...f, physical, alias };
}

test('explicit configured storage ancestors may be symlinks for both reset choices', async t => {
  for (const mode of ['keep', 'fresh']) await t.test(mode, async t => {
    const { config, state, physical, alias, create } = await configuredAlias(t);
    if (mode === 'keep') {
      const { result } = await local(config, state, 'keep');
      assert.equal(result.keptDbPath, join(physical, 'st-mq.sqlite'));
      assert.equal(await readFile(result.keptDbPath, 'utf8'), 'history behind configured alias');
      assert.equal((await lstat(alias)).isSymbolicLink(), true);
      return;
    }
    const actualDatabase = join(physical, 'st-mq.sqlite');
    const plan = await create(mode);
    assert.equal(plan.databasePath, actualDatabase);
    assert.equal(plan.pairDirectory, join(physical, 'pairing'));
    assert.equal(plan.snapshotDirectory, join(physical, 'pair-snapshots'));
    assert.equal(plan.archiveRoot, join(physical, 'backups', 'reset-archives'));
    assert.equal(plan.selectedDbPath, actualDatabase);
    const result = await resume(plan, config);
    assert.equal(await readFile(archived(plan, actualDatabase), 'utf8'), 'history behind configured alias');
    if (mode === 'keep') {
      assert.equal(result.keptDbPath, join(physical, 'pairing', 'kept-history.sqlite'));
      assert.equal(await readFile(result.keptDbPath, 'utf8'), 'history behind configured alias');
    } else {
      assert.equal(result.keptDbPath, null);
      await absent(actualDatabase);
    }
    assert.equal((await lstat(alias)).isSymbolicLink(), true, 'the configured alias itself remains intact');
    assert.equal(await readFile(join(physical, 'pairing', '.node-lock.sqlite'), 'utf8'), 'stable lock');
  });
});

test('an explicitly configured pairing directory alias is canonicalized without moving the alias', async t => {
  const { root, config, state } = await fixture(t);
  const actualPair = config.pair.directory, alias = join(root, 'configured-pairing');
  await symlink(actualPair, alias);
  config.pair.directory = alias;
  const { result } = await local(config, state, 'keep');
  assert.equal(result.keptDbPath, config.dbPath);
  assert.equal(await readFile(result.keptDbPath, 'utf8'), 'database bytes');
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});

test('fresh reset can clear saved pairing storage through an alias after the database was manually removed', async t => {
  const { config, physical, create } = await configuredAlias(t);
  await rm(config.dbPath);
  const plan = await create('fresh');
  assert.equal(plan.selectedDbPath, null);
  const result = await resume(plan, config);
  assert.equal(result.keptDbPath, null);
  await absent(join(physical, 'st-mq.sqlite'));
  assert.equal(await readFile(join(physical, 'pairing', '.node-lock.sqlite'), 'utf8'), 'stable lock');
  assert.ok((await readFile(join(plan.archiveDirectory, 'pairing', 'state.json'), 'utf8')).includes('activeDbPath'));
});

test('configured aliases do not permit symlinks inside pairing storage', async t => {
  const { root, config, physical, create } = await configuredAlias(t);
  const unrelated = join(root, 'unrelated', 'history.sqlite');
  await file(unrelated, 'unrelated history');
  await symlink(unrelated, join(config.pair.directory, 'linked-history.sqlite'));
  await assert.rejects(create('fresh'), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated history');
  assert.equal(await readFile(join(physical, 'st-mq.sqlite'), 'utf8'), 'history behind configured alias');
  await absent(join(physical, 'backups', 'reset-archives'));
});

test('different configured root spellings cannot resolve to the same physical storage', async t => {
  const { root, config, create } = await fixture(t);
  const alias = join(root, 'same-pairing-storage');
  await symlink(config.pair.directory, alias);
  config.pair.snapshotDirectory = alias;
  await assert.rejects(create('fresh'), { code: 'pair_reset_unsafe_storage' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  assert.equal(await readFile(join(config.pair.directory, '.node-lock.sqlite'), 'utf8'), 'stable lock');
  await absent(archiveRoot(config));
});

test('retargeting a configured root alias after review cannot redirect an archive retry', async t => {
  const { root, config, physical, alias, create } = await configuredAlias(t);
  const plan = await create('fresh');
  const replacement = join(root, 'replacement-var');
  await mkdir(replacement, { mode: 0o700 });
  await rm(alias);
  await symlink(replacement, alias);
  const before = await readdir(plan.archiveDirectory);
  await assert.rejects(resume(plan, config), { code: 'pair_reset_unsafe_storage' });
  assert.deepEqual(await readdir(plan.archiveDirectory), before);
  assert.deepEqual(await readdir(replacement), [], 'a changed alias is rejected before creating destination files');
  assert.equal(await readFile(join(physical, 'st-mq.sqlite'), 'utf8'), 'history behind configured alias');
  await rm(alias);
  await symlink(physical, alias);
  await resume(plan, config);
  assert.equal(await readFile(archived(plan, join(physical, 'st-mq.sqlite')), 'utf8'), 'history behind configured alias');
});

test('edited archive manifests cannot escape the archive or move the live state and lock', async t => {
  for (const kind of ['destination', 'source', 'lock']) await t.test(kind, async t => {
    const { config, create } = await fixture(t);
    const plan = await create('fresh');
    if (kind === 'destination') plan.entries[0].destination = '../../escaped.sqlite';
    else plan.entries[0].source = join(config.pair.directory, kind === 'lock' ? '.node-lock.sqlite' : 'state.json');
    await file(join(plan.archiveDirectory, 'reset.json'), JSON.stringify(plan));
    await assert.rejects(resume(plan, config), { code: 'pair_reset_unsafe_storage' });
    assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
    assert.equal(await readFile(join(config.pair.directory, '.node-lock.sqlite'), 'utf8'), 'stable lock');
  });
});

test('resume requires trusted scope and rejects internally consistent edits to manifest storage roots', async t => {
  const { root, config, create } = await fixture(t);
  const plan = await create('fresh');
  const trusted = { config, requestId: plan.requestId, mode: plan.mode };
  const unrelated = join(root, 'unrelated');
  const alternateDatabase = join(unrelated, 'history.sqlite');
  await file(alternateDatabase, 'database bytes');
  const edited = structuredClone(plan);
  edited.databasePath = alternateDatabase;
  edited.selectedDbPath = alternateDatabase;
  edited.entries = edited.entries.filter(entry => entry.source === plan.databasePath)
    .map(entry => ({ ...entry, source: alternateDatabase }));
  edited.pairDirectory = join(unrelated, 'pairing');
  edited.snapshotDirectory = join(unrelated, 'snapshots');
  edited.directories = [];
  await file(join(plan.archiveDirectory, 'reset.json'), JSON.stringify(edited));
  const before = await readdir(plan.archiveDirectory);
  await assert.rejects(resumeResetArchive(plan.archiveDirectory, trusted), { code: 'pair_reset_unsafe_storage' });
  assert.deepEqual(await readdir(plan.archiveDirectory), before, 'reject before creating archive destinations');
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  assert.equal(await readFile(alternateDatabase, 'utf8'), 'database bytes');
  await assert.rejects(resumeResetArchive(plan.archiveDirectory), { code: 'pair_reset_unsafe_storage' });
});

test('reset request identity, choice, and current configuration fence every retry', async t => {
  for (const kind of ['request', 'mode', 'database-config', 'pair-config', 'snapshot-config', 'archive-config']) await t.test(kind, async t => {
    const { root, config, create } = await fixture(t);
    const plan = await create('fresh');
    const expected = { config: structuredClone(config), requestId: plan.requestId, mode: plan.mode };
    if (kind === 'request') expected.requestId = randomUUID();
    if (kind === 'mode') expected.mode = 'keep';
    if (kind === 'database-config') expected.config.dbPath = join(root, 'different.sqlite');
    if (kind === 'pair-config') expected.config.pair.directory = join(root, 'different-pair');
    if (kind === 'snapshot-config') expected.config.pair.snapshotDirectory = join(root, 'different-snapshots');
    if (kind === 'archive-config') expected.config.recording = { backupDirectory: join(root, 'different-backups') };
    const before = await readdir(plan.archiveDirectory);
    await assert.rejects(resumeResetArchive(plan.archiveDirectory, expected), { code: 'pair_reset_unsafe_storage' });
    assert.deepEqual(await readdir(plan.archiveDirectory), before);
    assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  });
});

test('Home Assistant archives use the accessible app-config root', () => {
  assert.equal(archiveRoot({ addon: true, dataDir: '/data/st-mq', databaseDir: '/config/st-mq' }), '/config/st-mq/backups/reset-archives');
});

test('cross-filesystem archive verifies and commits the copy before retiring the source', async t => {
  const { config, create } = await fixture(t);
  const shared = await mkdtemp('/dev/shm/stmq-pair-reset-');
  t.after(() => rm(shared, { recursive: true, force: true }));
  assert.notEqual((await stat(shared)).dev, (await stat(config.dbPath)).dev, 'fixture requires two filesystems');
  config.dataDir = shared;
  const plan = await create('fresh');
  await resume(plan, config);
  assert.equal(await readFile(archived(plan, config.dbPath), 'utf8'), 'database bytes');
  await absent(config.dbPath);
});
