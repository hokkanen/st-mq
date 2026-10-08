import { registerJournalFunctions } from '../src/storage/journal-codec.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, chmod, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { runReceiver } from '../src/replication/receiver.js';
import { snapshotDigest, normalizeSnapshot, readReplicaPublication, verifyReplicaPublication, ownedDirectory } from '../src/replication/publication.js';
import { createSourceSnapshot, synchronizeReplica } from '../src/replication/transport.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-replica-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.sqlite'), replica = join(directory, 'slave');
  const db = new Store(source).db;
  db.exec("INSERT INTO events(id,type,payload,at) VALUES(1,'fixture',json_object('value','invented observation'),0)");
  t.after(() => db.close());
  return { directory, source, replica, db };
}

function session(directory) {
  const input = new PassThrough(), output = new PassThrough(), generation = randomUUID();
  const result = runReceiver({ directory, input, output });
  void result.catch(() => {});
  const send = async message => {
    const response = once(output, 'data').then(([data]) => JSON.parse(String(data)));
    input.write(`${JSON.stringify(message)}\n`);
    return Promise.race([response, result]);
  };
  return { input, result, generation, incoming: join(directory, `incoming-${generation}.sqlite`),
    prepare: () => send({ type: 'prepare', version: 2, repair: true, generation }),
    publish: metadata => send({ type: 'publish', generation, ...metadata }) };
}

async function transferFixture(source, replica, scratch) {
  const receiver = session(replica);
  assert.equal((await receiver.prepare()).type, 'ready');
  const destination = join(scratch, `copy-${randomUUID()}.sqlite`);
  const metadata = await createSourceSnapshot({ dbPath: source, destination });
  await copyFile(destination, receiver.incoming);
  await receiver.publish(metadata);
  await receiver.result;
  await rm(destination);
  return readReplicaPublication(replica);
}

test('source backup pins a consistent live WAL snapshot while the writer keeps recording', async t => {
  const { directory, source, db } = await fixture(t);
  const insert = db.prepare("INSERT INTO events(type,payload,at) VALUES ('fixture',json_object('value',?),0)");
  for (let start = 0; start < 16000; start += 256) {
    db.exec('BEGIN');
    for (let i = start; i < Math.min(start + 256,16000); i++) insert.run('synthetic snapshot fixture '.repeat(40));
    db.exec('COMMIT');
  }
  const destination = join(directory, 'pinned.sqlite');
  let writes = 0;
  const timer = setInterval(() => { insert.run(`synthetic live row ${++writes}`); }, 1);
  t.after(() => clearInterval(timer));
  const metadata = await createSourceSnapshot({ dbPath: source, destination });
  clearInterval(timer);
  insert.run('after the selected snapshot');
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.ok(writes > 0, 'background snapshot must leave the main event loop free');
    assert.ok(snapshot.prepare('SELECT COUNT(*) n FROM events').get().n < db.prepare('SELECT COUNT(*) n FROM events').get().n);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(snapshot.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.ok(metadata.sourceStartedAt <= metadata.sourceAt && metadata.sourceAt <= Date.now());
    assert.deepEqual(await snapshotDigest(destination), { digest: metadata.digest, bytes: metadata.bytes, digestAlgorithm: metadata.digestAlgorithm });
  } finally { snapshot.close(); }
});

test('snapshot and verification workers accept process-only flags and inline module launchers', async t => {
  const { directory, source } = await fixture(t);
  for (const inline of [false, true]) {
    const destination = join(directory, `worker-flags-${inline}.sqlite`);
    const script = `import { createSourceSnapshot } from ${JSON.stringify(new URL('../src/replication/transport.js', import.meta.url).href)};
      import { verifySnapshot } from ${JSON.stringify(new URL('../src/pairing/snapshots.js', import.meta.url).href)};
      const path = ${JSON.stringify(destination)};
      const metadata = await createSourceSnapshot({ dbPath: ${JSON.stringify(source)}, destination: path });
      await verifySnapshot(path, metadata);`;
    const path = join(directory, 'worker-flags.mjs');
    await writeFile(path, script);
    const child = spawn(process.execPath, ['--stack-trace-limit=20',
      ...(inline ? ['--input-type=module', '--eval', script] : [path])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    const snapshot = new DatabaseSync(destination, { readOnly: true });
    try { assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM events').get().n, 1); }
    finally { snapshot.close(); }
  }
});

test('receiver publishes only matching snapshots, preserves old readers, and bounds retained generations', async t => {
  const { directory, source, replica, db } = await fixture(t);
  const first = await transferFixture(source, replica, directory);
  const oldReader = new DatabaseSync(first.dbPath, { readOnly: true });
  t.after(() => oldReader.close());
  const receiver = session(replica);
  await receiver.prepare();
  await copyFile(first.dbPath, receiver.incoming);
  const bad = new Store(receiver.incoming).db;
  bad.exec("UPDATE events SET payload=json_object('value','unexpected replica edit')"); bad.close();
  await assert.rejects(receiver.publish({ digest: first.digest, bytes: first.bytes,
    sourceStartedAt: first.sourceStartedAt, sourceAt: first.sourceAt }), /verification_failed/);
  assert.equal((await readReplicaPublication(replica)).generation, first.generation);
  assert.equal(oldReader.prepare("SELECT json_extract(payload,'$.value') AS value FROM events").get().value, 'invented observation');
  for (let i = 2; i <= 4; i++) {
    db.prepare("INSERT INTO events(id,type,payload,at) VALUES (?,'fixture',json_object('value',?),0)").run(i, `synthetic ${i}`);
    await transferFixture(source, replica, directory);
  }
  const names = await readdir(replica);
  assert.equal(names.filter(name => name.startsWith('snapshot-')).length, 2);
  assert.equal(names.filter(name => name.startsWith('incoming-')).length, 0);
  assert.equal(oldReader.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  for (const name of names) assert.equal((await stat(join(replica, name))).mode & 0o777, 0o600);
  assert.equal((await stat(replica)).mode & 0o777, 0o700);
  const current = await verifyReplicaPublication(replica);
  assert.equal(current.generation, (await readReplicaPublication(replica)).generation);
});

test('interrupted transfer and a busy receiver leave the last verified publication intact', async t => {
  const { directory, source, replica } = await fixture(t);
  const first = await transferFixture(source, replica, directory);
  const active = session(replica);
  await active.prepare();
  const competing = session(replica);
  await assert.rejects(competing.prepare(), /receiver_busy/);
  active.input.end();
  await assert.rejects(active.result, /transfer_interrupted/);
  assert.equal((await readReplicaPublication(replica)).generation, first.generation);
  const recovered = await transferFixture(source, replica, directory);
  assert.notEqual(recovered.generation, first.generation);
});

test('restart collects orphan final snapshots before allocating the next incoming copy', async t => {
  const { directory, source, replica, db } = await fixture(t);
  const first = await transferFixture(source, replica, directory);
  db.exec("INSERT INTO events(id,type,payload,at) VALUES(2,'fixture',json_object('value','synthetic second generation'),0)");
  const current = await transferFixture(source, replica, directory);
  assert.equal(current.previousGeneration, first.generation);
  const openCurrent = new DatabaseSync(current.dbPath, { readOnly: true });
  const openPrevious = new DatabaseSync(first.dbPath, { readOnly: true });
  t.after(() => { openCurrent.close(); openPrevious.close(); });
  // Simulate loss of power after the candidate acquired its final filename but
  // before publication.json was atomically replaced, plus another aborted copy.
  const orphan = join(replica, `snapshot-${randomUUID()}.sqlite`);
  const interrupted = join(replica, `incoming-${randomUUID()}.sqlite`);
  await copyFile(current.dbPath, orphan);
  await copyFile(current.dbPath, interrupted);
  await writeFile(`${interrupted}-journal`, 'synthetic incomplete journal');
  await writeFile(join(replica, 'publication.json.tmp'), '{unfinished manifest');
  const receiver = session(replica);
  await receiver.prepare();
  const names = await readdir(replica);
  assert.deepEqual(names.filter(name => name.startsWith('snapshot-')).sort(),
    [first.dbPath.split('/').at(-1), current.dbPath.split('/').at(-1)].sort());
  assert.deepEqual(names.filter(name => name.startsWith('incoming-')), [receiver.incoming.split('/').at(-1)]);
  assert.equal(names.includes('publication.json.tmp'), false);
  assert.equal((await readReplicaPublication(replica)).generation, current.generation);
  assert.equal(openCurrent.prepare('SELECT COUNT(*) n FROM events').get().n, 2);
  assert.equal(openPrevious.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  receiver.input.end(); await assert.rejects(receiver.result, /transfer_interrupted/);
  const recovered = await transferFixture(source, replica, directory);
  assert.equal(recovered.previousGeneration, current.generation);
  await verifyReplicaPublication(replica);
});

test('receiver lock automatically recovers after SIGKILL with an unfinished incoming copy', async t => {
  const { directory, source, replica } = await fixture(t);
  const receiver = spawn(process.execPath, [resolve('scripts/replica-receiver.js'), replica], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => receiver.kill('SIGKILL'));
  const ready = once(receiver.stdout, 'data');
  receiver.stdin.write(`${JSON.stringify({ type: 'prepare', version: 2, repair: true, generation: randomUUID() })}\n`);
  assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
  receiver.kill('SIGKILL');
  await once(receiver, 'close');
  await transferFixture(source, replica, directory);
  assert.equal((await verifyReplicaPublication(replica)).bytes > 0, true);
});

test('verification is read-only and catches changed data, while damaged replica base can be replaced', async t => {
  const { directory, source, replica } = await fixture(t);
  const first = await transferFixture(source, replica, directory);
  const original = await readFile(first.dbPath), manifest = await readFile(join(replica, 'publication.json'));
  await verifyReplicaPublication(replica);
  assert.deepEqual(await readFile(first.dbPath), original);
  assert.deepEqual(await readFile(join(replica, 'publication.json')), manifest);
  const corrupted = new DatabaseSync(first.dbPath); registerJournalFunctions(corrupted);
  corrupted.exec("UPDATE events SET payload=json_object('value','unexpected replica data')"); corrupted.close();
  await assert.rejects(verifyReplicaPublication(replica), error => ['database_journal_invalid', 'database_integrity_failed'].includes(error.code));
  const receiver = session(replica);
  await receiver.prepare();
  assert.equal((await stat(receiver.incoming)).size, 0, 'damaged base requires a full fresh transfer');
  receiver.input.end(); await assert.rejects(receiver.result);
  await transferFixture(source, replica, directory);
  await verifyReplicaPublication(replica);
  await writeFile(join(replica, 'publication.json'), '{interrupted synthetic metadata');
  const names = await readdir(replica);
  await assert.rejects(transferFixture(source, replica, directory), /invalid_publication/);
  assert.equal(await readFile(join(replica, 'publication.json'), 'utf8'), '{interrupted synthetic metadata');
  assert.deepEqual(await readdir(replica), names, 'invalid metadata cannot authorize deleting retained snapshots');
});

test('owned directory checks refuse unrelated nonempty folders without changing permissions', async t => {
  const { directory } = await fixture(t);
  const unrelated = join(directory, 'unrelated'); await mkdir(unrelated); await chmod(unrelated, 0o755);
  await writeFile(join(unrelated, 'existing.txt'), 'synthetic');
  await assert.rejects(ownedDirectory(unrelated, '.st-mq-replica'), /directory_not_empty/);
  assert.equal((await stat(unrelated)).mode & 0o777, 0o755);
});

for (const scenario of [
  { label: 'obsolete database', version: 7, code: 'database_schema_mismatch' },
  { label: 'malformed current database', version: SCHEMA_VERSION, code: 'database_schema_invalid' },
]) test(`${scenario.label} is rejected at export and CLI receipt with the last publication unchanged`, async t => {
  const { directory, source, replica } = await fixture(t);
  const first = await transferFixture(source, replica, directory);
  const publication = await readFile(first.dbPath), manifest = await readFile(join(replica, 'publication.json'));
  const path = join(directory, 'unsupported.sqlite'), db = new DatabaseSync(path);
  db.exec(`CREATE TABLE unsupported(id INTEGER); PRAGMA user_version=${scenario.version}`); db.close();
  const before = await readFile(path);
  const expected = { code: scenario.code, actualSchema: scenario.version, requiredSchema: SCHEMA_VERSION };
  await assert.rejects(createSourceSnapshot({ dbPath: path, destination: join(directory,'unsupported-copy.sqlite') }), expected);
  assert.deepEqual(await readFile(path), before);
  const receiver = spawn(process.execPath, [resolve('scripts/replica-receiver.js'), replica], { stdio: ['pipe', 'pipe', 'ignore'] });
  const completion = once(receiver, 'close');
  const lines = createInterface({ input: receiver.stdout }), messages = lines[Symbol.asyncIterator]();
  t.after(() => { lines.close(); receiver.kill('SIGKILL'); });
  const generation = randomUUID();
  receiver.stdin.write(`${JSON.stringify({ type: 'prepare', version: 2, repair: true, generation })}\n`);
  assert.equal(JSON.parse((await messages.next()).value).type, 'ready');
  await copyFile(path, join(replica, `incoming-${generation}.sqlite`));
  const metadata = await snapshotDigest(path);
  receiver.stdin.end(`${JSON.stringify({ type: 'publish', generation, ...metadata, sourceStartedAt: 1, sourceAt: 1 })}\n`);
  assert.deepEqual(JSON.parse((await messages.next()).value), { type: 'error', ...expected });
  assert.equal((await completion)[0], 1);
  assert.equal((await verifyReplicaPublication(replica)).generation, first.generation);
  assert.deepEqual(await readFile(first.dbPath), publication);
  assert.deepEqual(await readFile(join(replica, 'publication.json')), manifest);
});

test('SSH receiver errors retain only allowlisted database diagnostics through the transport', async t => {
  const { directory, source } = await fixture(t);
  const config = { sshHost: 'synthetic-peer', remoteDirectory: '/synthetic/replica',
    receiverPath: '/synthetic/receiver.js', sourceDirectory: join(directory, 'work') };
  for (const diagnostic of [
    { code: 'database_schema_mismatch', actualSchema: 7, requiredSchema: SCHEMA_VERSION },
    { code: 'database_schema_invalid', requiredSchema: SCHEMA_VERSION },
  ]) {
    const untrusted = { type: 'error', ...diagnostic, message: 'synthetic confidential details',
      path: '/synthetic/private/path', extra: 'private' };
    if (!Object.hasOwn(diagnostic, 'actualSchema')) untrusted.actualSchema = 'synthetic confidential details';
    const spawnProcess = (command, args, options) => spawn(process.execPath, command === 'ssh'
      ? ['--input-type=module', '--eval', `process.stdin.once('data', () => {
          process.stdout.write(${JSON.stringify(`${JSON.stringify(untrusted)}\n`)});
          process.stdin.pause();
        });`]
      : ['--eval', 'process.exit(0)'], options);
    await assert.rejects(synchronizeReplica({ dbPath: source, config, spawnProcess }), error => {
      assert.equal(error.message, diagnostic.code);
      assert.deepEqual({ ...error }, diagnostic);
      return true;
    });
  }
});

test('standalone mirror catches up after journal expiry using changed rows without another seed',async t=>{
  const {directory,source,replica,db}=await fixture(t);
  const config={sshHost:'synthetic-peer',remoteDirectory:replica,receiverPath:resolve('scripts/replica-receiver.js'),
    sourceDirectory:join(directory,'mirror-work')};
  let seeds=0;
  const spawnProcess=(command,args,options)=>{
    if(command==='ssh')return spawn(process.execPath,[config.receiverPath,replica],options);
    if(args[0]==='--version')return spawn(process.execPath,['--eval','process.exit(0)'],options);
    seeds++;
    return spawn(process.execPath,['--eval',"require('node:fs').copyFileSync(process.argv[1],process.argv[2])",
      args[0],args[1].slice(args[1].indexOf(':')+1)],options);
  };
  const initial=await synchronizeReplica({dbPath:source,config,spawnProcess});
  const before=await readReplicaPublication(replica);
  assert.equal(initial.digest,before.digest,'initial result names the normalized published checkpoint');
  assert.equal(initial.generation,before.generation);
  const unchanged=await synchronizeReplica({dbPath:source,config,spawnProcess});
  assert.equal(unchanged.generation,before.generation,'a no-change sync reports the existing publication');
  assert.equal(unchanged.digest,before.digest);
  assert.equal(unchanged.transferredBytes,0);
  for(let value=0;value<30;value++)db.prepare('UPDATE events SET payload=? WHERE id=1').run(JSON.stringify({value}));
  const sourceStore=new Store(source);
  sourceStore.compactJournal({maxBytes:1,maxCommits:1});
  assert(sourceStore.journalBase().sequence>before.checkpoint.sequence);
  const target=sourceStore.checkpoint();sourceStore.close();
  const result=await synchronizeReplica({dbPath:source,config,spawnProcess});
  assert.equal(seeds,1,'offline duration never requests a second complete seed');
  assert(result.transferredBytes<10000,'wire contains consolidated changes only');
  const after=await verifyReplicaPublication(replica);
  assert.equal(after.dbPath,before.dbPath);
  assert.deepEqual(after.checkpoint,target);
  const reader=new Store(after.dbPath,{readOnly:true});
  try{assert.equal(JSON.parse(reader.db.prepare('SELECT payload FROM events WHERE id=1').get().payload).value,29);}
  finally{reader.close();}
});

test('page digest excludes only documented volatile SQLite header fields', async t => {
  const { directory, source } = await fixture(t);
  const path = join(directory, 'digest.sqlite'); await createSourceSnapshot({ dbPath: source, destination: path });
  normalizeSnapshot(path); const original = await snapshotDigest(path), data = await readFile(path);
  data.fill(43, 24, 28); data.fill(71, 92, 100); await writeFile(path, data);
  assert.deepEqual(await snapshotDigest(path), original);
  data[data.length - 1] ^= 1; await writeFile(path, data);
  assert.notEqual((await snapshotDigest(path)).digest, original.digest);
});
