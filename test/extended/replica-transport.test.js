import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { synchronizeReplica } from '../../src/replication/transport.js';
import { readReplicaPublication, verifyReplicaPublication } from '../../src/replication/publication.js';

const rsync = process.env.STMQ_TEST_RSYNC ?? 'sqlite3_rsync';
const available = spawnSync(rsync, ['--version'], { stdio: 'ignore' }).status === 0;
const skipRsync = !available && !process.env.STMQ_REQUIRE_RSYNC_TESTS;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-transport-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.sqlite');
  const db = new DatabaseSync(source);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE records(id INTEGER PRIMARY KEY, text_value TEXT, blob_value BLOB, int_value INTEGER);
    CREATE INDEX text_index ON records(text_value);
    CREATE TABLE pairs(key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    INSERT INTO pairs VALUES ('synthetic key','synthetic value'); PRAGMA user_version=10;`);
  t.after(() => db.close());
  const insert = db.prepare('INSERT INTO records VALUES(?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let id = 1; id <= 2000; id++) insert.run(id, `synthetic row ${id}`, Buffer.alloc(1024, id % 255), BigInt(id) * 100000000000n);
  db.exec('COMMIT');
  const bin = join(directory, 'bin'); await mkdir(bin, { mode: 0o700 });
  // This harness emulates SSH process plumbing only. The production wrapper's
  // host authentication options are separately asserted; the real rsync protocol
  // and remote receiver run unmodified against real SQLite files here.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "test-peer" ]; do shift; done\n[ "$#" -gt 0 ] || exit 2\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o700 });
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  const config = { sshHost: 'test-peer', remoteDirectory: join(directory, 'replica'),
    receiverPath: resolve('scripts/replica-receiver.js'), sourceDirectory: join(directory, 'work'),
    nodePath: process.execPath, rsyncPath: rsync, remoteRsyncPath: rsync, intervalMs: 10, timeoutMs: 30000 };
  return { directory, source, db, config };
}

test('real sqlite3_rsync protocol catches up inserts, deletes, schema changes and freelists identically', { skip: skipRsync, timeout: 60_000 }, async t => {
  assert.ok(available, 'STMQ_REQUIRE_RSYNC_TESTS requires a working sqlite3_rsync on PATH or STMQ_TEST_RSYNC');
  const { directory, source, db, config } = await fixture(t);
  const commands = [];
  const spawnProcess = (command, args, options) => { commands.push({ command, args }); return spawn(command, args, options); };
  const first = await synchronizeReplica({ signal: t.signal, dbPath: source, config, spawnProcess });
  let publication = await verifyReplicaPublication(config.remoteDirectory);
  assert.equal(publication.digest, first.digest);
  assert.equal(publication.bytes, first.bytes);
  const immutable = await readFile(publication.dbPath);
  // A crashed source worker can leave a complete backup and SQLite sidecars.
  // The next online attempt must reclaim these before making its new backup.
  const interrupted = join(config.sourceDirectory, 'source-00000000-0000-0000-0000-000000000001.sqlite');
  await writeFile(interrupted, immutable);
  await writeFile(`${interrupted}-journal`, 'synthetic unfinished backup journal');
  let inspectedWorkDirectory = false;
  const observeSnapshot = phase => {
    if (phase !== 'snapshotting') return;
    inspectedWorkDirectory = true;
    assert.deepEqual(readdirSync(config.sourceDirectory).filter(name => name.startsWith('source-')), []);
  };
  // Represents a long standby outage; no transfer history is kept or replayed.
  db.exec(`BEGIN; DELETE FROM records WHERE id % 3 <> 0; UPDATE records SET text_value='corrected synthetic history';
    DROP INDEX text_index; CREATE INDEX int_index ON records(int_value); CREATE TABLE extra(value TEXT);
    INSERT INTO extra VALUES ('new schema'); DELETE FROM pairs; COMMIT`);
  assert.ok(db.prepare('PRAGMA freelist_count').get().freelist_count > 0);
  const second = await synchronizeReplica({ signal: t.signal, dbPath: source, config, spawnProcess, onPhase: observeSnapshot });
  assert.equal(inspectedWorkDirectory, true);
  publication = await verifyReplicaPublication(config.remoteDirectory);
  assert.equal(publication.digest, second.digest);
  assert.notEqual(second.digest, first.digest);
  const replica = new DatabaseSync(publication.dbPath, { readOnly: true });
  try {
    const sourceRows = db.prepare('SELECT id,text_value,hex(blob_value) blob_value,CAST(int_value AS TEXT) int_value FROM records ORDER BY id').all();
    assert.deepEqual(replica.prepare('SELECT id,text_value,hex(blob_value) blob_value,CAST(int_value AS TEXT) int_value FROM records ORDER BY id').all(), sourceRows);
    assert.deepEqual(replica.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all());
    assert.equal(replica.prepare('SELECT COUNT(*) n FROM pairs').get().n, 0);
  } finally { replica.close(); }
  assert.deepEqual(await readFile(join(config.remoteDirectory, `snapshot-${first.generation}.sqlite`)), immutable);
  db.exec('VACUUM');
  const third = await synchronizeReplica({ signal: t.signal, dbPath: source, config });
  assert.equal((await verifyReplicaPublication(config.remoteDirectory)).digest, third.digest);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=8192; VACUUM; PRAGMA journal_mode=WAL');
  const fourth = await synchronizeReplica({ signal: t.signal, dbPath: source, config });
  assert.equal((await verifyReplicaPublication(config.remoteDirectory)).digest, fourth.digest);
  assert.equal((await readdir(config.remoteDirectory)).filter(name => name.startsWith('snapshot-')).length, 2);
  assert.deepEqual((await readdir(config.sourceDirectory)).filter(name => name.endsWith('.sqlite')), []);
  assert.equal((await readdir(config.sourceDirectory)).some(name => name.endsWith('-journal')), false);
  const ssh = commands.find(command => command.command === 'ssh');
  assert.ok(ssh.args.includes('BatchMode=yes'));
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(ssh.args.includes('ServerAliveCountMax=3'));
});

test('private SSH config is selected on both channels without changing the parent environment', { skip: skipRsync, timeout: 60_000 }, async t => {
  assert.ok(available);
  const { directory, source, config } = await fixture(t);
  const sshConfigPath = join(directory, 'private ssh config'), capture = join(directory, 'ssh-arguments.jsonl');
  await writeFile(sshConfigPath, '# synthetic SSH config\n', { mode: 0o600 });
  const previous = process.env.STMQ_REPLICATION_SSH_CONFIG;
  await writeFile(join(directory, 'bin/ssh'), `#!${process.execPath}\nimport fs from 'node:fs'; import {spawn} from 'node:child_process';\nconst args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');\nconst index=args.indexOf('test-peer'); const child=spawn('/bin/sh',['-c',args.slice(index+1).join(' ')],{stdio:'inherit'}); child.on('exit',code=>process.exitCode=code??1);\n`, { mode: 0o700 });
  await synchronizeReplica({ signal: t.signal, dbPath: source, config: { ...config, sshConfigPath } });
  const invocations = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(invocations.length >= 2);
  for (const args of invocations) assert.equal(args[args.indexOf('-F') + 1], sshConfigPath);
  assert.equal(process.env.STMQ_REPLICATION_SSH_CONFIG, previous);
});

test('offline peer fails before creating a source snapshot and resumes at the next attempt', { skip: skipRsync, timeout: 60_000 }, async t => {
  assert.ok(available);
  const { source, config } = await fixture(t);
  let snapshots = 0;
  await assert.rejects(synchronizeReplica({ signal: t.signal, dbPath: source, config,
    spawnProcess: (command, args, options) => command === 'ssh'
      ? spawn(process.execPath, ['-e', 'process.exit(1)'], options) : spawn(command, args, options),
    snapshot: async () => { snapshots++; throw new Error('should not run'); },
  }), /connection_failed/);
  assert.equal(snapshots, 0);
  const recovered = await synchronizeReplica({ signal: t.signal, dbPath: source, config });
  assert.equal((await readReplicaPublication(config.remoteDirectory)).generation, recovered.generation);
});

test('timed out sync leaves publication intact and the next real transfer recovers', { skip: skipRsync, timeout: 60_000 }, async t => {
  assert.ok(available);
  const { source, config } = await fixture(t);
  const first = await synchronizeReplica({ signal: t.signal, dbPath: source, config });
  await assert.rejects(synchronizeReplica({ signal: t.signal, dbPath: source, config: { ...config, timeoutMs: 500 },
    spawnProcess: (command, args, options) => command === rsync && !args.includes('--version')
      ? spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options) : spawn(command, args, options),
  }), /timed_out/);
  assert.equal((await readReplicaPublication(config.remoteDirectory)).generation, first.generation);
  const next = await synchronizeReplica({ signal: t.signal, dbPath: source, config });
  assert.equal((await verifyReplicaPublication(config.remoteDirectory)).generation, next.generation);
});
