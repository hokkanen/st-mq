import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { archiveRoot, createResetArchive, resumeResetArchive, selectResetDatabase } from '../src/pairing/reset-storage.js';

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
  const state = { role: 'master', everWritten: true, activeDbPath: config.dbPath };
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

test('keep history selects a promoted database and retains its SQLite companions while archiving the configured database separately', async t => {
  const { config, state, create } = await fixture(t);
  const promoted = join(config.pair.directory, `master-${randomUUID()}.sqlite`);
  state.activeDbPath = promoted;
  await file(promoted, 'promoted household history');
  await file(`${promoted}-wal`, 'promoted WAL bytes');
  await file(`${promoted}-shm`, 'promoted SHM bytes');
  assert.equal(await selectResetDatabase(config, state), promoted);
  const plan = await create('keep');
  const result = await resume(plan, config);
  assert.equal(result.keptDbPath, join(config.pair.directory, 'kept-history.sqlite'));
  assert.equal(await readFile(result.keptDbPath, 'utf8'), 'promoted household history');
  assert.equal(await readFile(`${result.keptDbPath}-wal`, 'utf8'), 'promoted WAL bytes');
  assert.equal(await readFile(`${result.keptDbPath}-shm`, 'utf8'), 'promoted SHM bytes');
  assert.equal(await readFile(archived(plan, config.dbPath), 'utf8'), 'database bytes');
  assert.equal(await readFile(archived(plan, promoted), 'utf8'), 'promoted household history');
  await absent(promoted);
});

test('a later reset archives the retained active database without touching the earlier archive', async t => {
  const { config, state, create } = await fixture(t);
  const first = await create('keep'), kept = await resume(first, config);
  state.activeDbPath = kept.keptDbPath;
  state.role = 'protected';
  await file(kept.keptDbPath, 'same history with later records');
  const second = await create('fresh');
  await resume(second, config);
  assert.equal(await readFile(archived(first, first.selectedDbPath), 'utf8'), 'database bytes');
  assert.equal(await readFile(archived(second, kept.keptDbPath), 'utf8'), 'same history with later records');
  await absent(kept.keptDbPath);
});

test('slave and protected replica keep the actual published history rather than an unrelated configured database', async t => {
  const { config, create } = await fixture(t);
  const generation = randomUUID(), snapshot = join(config.pair.snapshotDirectory, `snapshot-${generation}.sqlite`);
  await file(snapshot, 'accepted snapshot history');
  await file(join(config.pair.snapshotDirectory, 'publication.json'), JSON.stringify({ format: 1,
    digestAlgorithm: 'sha256-sqlite-pages-v1', generation, digest: 'a'.repeat(64), bytes: 512,
    sourceStartedAt: 1000, sourceAt: 1100, verifiedAt: 1200, previousGeneration: null }));
  for (const role of ['slave', 'protected']) assert.equal(await selectResetDatabase(config, { role, everWritten: false }), snapshot);
  const plan = await create('keep', { state: { role: 'slave', everWritten: false } });
  const result = await resume(plan, config);
  assert.equal(await readFile(result.keptDbPath, 'utf8'), 'accepted snapshot history');
  assert.equal(await readFile(archived(plan, config.dbPath), 'utf8'), 'database bytes');
});

test('fresh reset archives an invalid publication unchanged while keep refuses to guess the active history', async t => {
  const { config, create } = await fixture(t);
  const publication = join(config.pair.snapshotDirectory, 'publication.json');
  await file(publication, '{not a current publication}');
  const state = { role: 'slave', everWritten: false };
  await assert.rejects(create('keep', { state }), { code: 'pair_reset_history_unavailable' });
  const plan = await create('fresh', { state });
  assert.equal(plan.selectedDbPath, null);
  await resume(plan, config);
  assert.equal(await readFile(archived(plan, publication), 'utf8'), '{not a current publication}');
});

test('keep refuses a missing active database instead of silently archiving other history and returning empty', async t => {
  const { config, state, create } = await fixture(t);
  state.activeDbPath = join(config.pair.directory, 'missing-master.sqlite');
  await assert.rejects(create('keep'), { code: 'pair_reset_history_unavailable' });
  assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
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
    if (kind === 'archive-symlink') await symlink(outside, archiveRoot(config));
    if (kind === 'nested-roots') config.pair.snapshotDirectory = join(config.pair.directory, 'snapshots');
    if (kind === 'outside-active') state.activeDbPath = join(outside, 'untouched');
    await assert.rejects(create('fresh'), { code: 'pair_reset_unsafe_storage' });
    assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
    assert.equal(await readFile(join(outside, 'untouched'), 'utf8'), 'unrelated file');
  });
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
    if (kind === 'archive-config') expected.config.dataDir = join(root, 'different-data');
    const before = await readdir(plan.archiveDirectory);
    await assert.rejects(resumeResetArchive(plan.archiveDirectory, expected), { code: 'pair_reset_unsafe_storage' });
    assert.deepEqual(await readdir(plan.archiveDirectory), before);
    assert.equal(await readFile(config.dbPath, 'utf8'), 'database bytes');
  });
});

test('Home Assistant archives use the accessible app-config root', () => {
  assert.equal(archiveRoot({ addon: true, dataDir: '/data/st-mq', databaseDir: '/config/st-mq' }), '/config/reset-archives');
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
