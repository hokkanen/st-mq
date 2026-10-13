import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { verifyDatabase } from '../../src/storage/full-verifier.js';
import { peerOperation } from '../../src/replication/coalesced.js';

const otherNode = process.env.STMQ_OTHER_NODE;
const required = process.env.STMQ_REQUIRE_CROSS_RUNTIME_TESTS === '1';
const storeURL = new URL('../../src/storage/store.js', import.meta.url).href;
const peerURL = new URL('../../src/storage/journal-peer.js', import.meta.url).href;
const transferURL = new URL('../../src/replication/coalesced.js', import.meta.url).href;
const verifierURL = new URL('../../src/storage/full-verifier.js', import.meta.url).href;
const fixtureURL = new URL('../helpers/home-learning-fixture.js', import.meta.url).href;
const learningURL = new URL('../../src/app/committed-learning.js', import.meta.url).href;
function run(source, directory, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(otherNode, ['--input-type=module', '-e', source, directory], { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`Synthetic peer runtime exited ${code}: ${stderr.slice(-4000)}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

test('compact learning checkpoints transfer and hydrate exactly across Node/SQLite runtimes',
  { skip: !otherNode && !required && 'Set STMQ_OTHER_NODE to another supported Node executable.', timeout: 60_000 }, async t => {
    assert.ok(otherNode, 'Set STMQ_OTHER_NODE for required cross-runtime validation.');
    const directory = await mkdtemp(join(tmpdir(), 'stmq-learning-cross-runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sourcePath = join(directory, 'source.sqlite'), targetPath = join(directory, 'target.sqlite');
    const window = `import {appendLearningRecord} from ${JSON.stringify(fixtureURL)};
      import {replayLearningJournal} from ${JSON.stringify(learningURL)};
      const append=(s,index)=>appendLearningRecord(s,'mqtt','sample',{
        timestamp:Date.parse('2026-01-01T00:00:00Z')+index*900000,
        indoorC:21+index/100,outdoorC:1/3,solarRadiationWm2:0,
        phase:'normal',regime:'occupied',thermalCompressorDuty:1,thermalAuxKw:0,quality:[],
      },{config:{indoorSensorWeights:{indoor_temperature:1}}});`;
    const seeded = await run(`import {Store} from ${JSON.stringify(storeURL)};
      import {enrollJournalPeer} from ${JSON.stringify(peerURL)};
      ${window}
      const dir=process.argv[1],s=new Store(dir+'/source.sqlite');
      for(let i=1;i<=4;i++)append(s,i);
      const checkpoint=replayLearningJournal(s,'mqtt');
      enrollJournalPeer(s.db);await s.backup(dir+'/target.sqlite');s.close();
      console.log(JSON.stringify({node:process.version,checkpoint}));`, directory, t.signal);
    assert.notEqual(seeded.node, process.version);
    const target = new Store(targetPath);
    let base;
    try { assert.deepEqual(target.getState('adaptive:mqtt'), seeded.checkpoint); base = target.checkpoint(); }
    finally { target.close(); }
    const exported = await run(`import {Store} from ${JSON.stringify(storeURL)};
      import {PeerTransfers} from ${JSON.stringify(transferURL)};
      ${window}
      const dir=process.argv[1],s=new Store(dir+'/source.sqlite');append(s,5);
      const checkpoint=replayLearningJournal(s,'mqtt');s.close();
      const metadata=await new PeerTransfers(dir+'/transfers').export({dbPath:dir+'/source.sqlite',after:${JSON.stringify(base)}});
      console.log(JSON.stringify({checkpoint,metadata}));`, directory, t.signal);
    await peerOperation('apply', { dbPath: targetPath, metadata: exported.metadata,
      path: join(directory, 'transfers', `peer-${exported.metadata.id}.changes`) });
    const receiver = new Store(targetPath);
    try {
      assert.deepEqual(receiver.getState('adaptive:mqtt'), exported.checkpoint);
      assert.equal(receiver.db.prepare('SELECT COUNT(*) n FROM learning_checkpoint_samples').get().n,
        exported.checkpoint.samples.length);
      assert.equal(receiver.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { receiver.close(); }
    const sourceVerification = await run(`import {verifyDatabase} from ${JSON.stringify(verifierURL)};
      const verification=await verifyDatabase({dbPath:process.argv[1]+'/source.sqlite'});
      console.log(JSON.stringify(verification));`, directory, t.signal);
    const receiverVerification = await verifyDatabase({ dbPath: targetPath });
    assert.equal(receiverVerification.digest, sourceVerification.digest);
    assert.deepEqual(receiverVerification.checkpoint, sourceVerification.checkpoint);
  });

test('different Node/SQLite runtimes seed, compact, catch up and reverse direction without losing stored precision',
  { skip: !otherNode && !required && 'Set STMQ_OTHER_NODE to another supported Node executable.', timeout: 60_000 }, async t => {
    assert.ok(otherNode, 'Cross-runtime validation is required: set STMQ_OTHER_NODE to another supported Node executable.');
    const directory = await mkdtemp(join(tmpdir(), 'stmq-cross-runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const sourcePath = join(directory, 'source.sqlite'), targetPath = join(directory, 'target.sqlite');
    const seeded = await run(`
      import {Store} from ${JSON.stringify(storeURL)};
      import {enrollJournalPeer} from ${JSON.stringify(peerURL)};
      import {verifyDatabase} from ${JSON.stringify(verifierURL)};
      const dir=process.argv[1], s=new Store(dir+'/source.sqlite');
      const put=s.db.prepare("INSERT INTO observations(source,device,signal,value,unit,source_time,received_at,quality,raw) VALUES('synthetic','fixture','precision',?,'test',1,1,'[]',?)");
      for(const value of [1/3,Math.PI,0.1+0.2,1+Number.EPSILON,Number.MIN_VALUE,Number.MAX_VALUE]) put.run(value,'Unicode 🧪 and JSON {"literal":1}');
      enrollJournalPeer(s.db);await s.backup(dir+'/target.sqlite');s.close();
      const verification=await verifyDatabase({dbPath:dir+'/source.sqlite'});
      const check=new Store(dir+'/source.sqlite',{readOnly:true});const sqlite=check.db.prepare('SELECT sqlite_version() version').get().version;check.close();
      console.log(JSON.stringify({node:process.version,sqlite,verification}));`, directory, t.signal);
    assert.notEqual(seeded.node, process.version, 'Select a different Node version for the cross-runtime test');
    const runtime = new DatabaseSync(':memory:');
    const sqlite = runtime.prepare('SELECT sqlite_version() version').get().version; runtime.close();
    const first = await verifyDatabase({ dbPath: targetPath });
    assert.equal(first.digest, seeded.verification.digest, 'Both runtimes independently agree on the seeded stored content');
    const inode = (await stat(targetPath)).ino;
    const transfer = await run(`
      import {Store} from ${JSON.stringify(storeURL)};
      import {PeerTransfers} from ${JSON.stringify(transferURL)};
      const dir=process.argv[1],s=new Store(dir+'/source.sqlite'),after=s.checkpoint();
      for(let i=0;i<256;i++) {s.db.prepare('UPDATE observations SET value=? WHERE id=1').run(1+(i+1)*Number.EPSILON);s.setState('bookkeeping',{counter:i});if(i%8===0)s.compactJournal({maxCommits:2});}
      s.db.prepare('DELETE FROM observations WHERE id=3').run();
      const base=s.journalBase();s.close();
      const metadata=await new PeerTransfers(dir+'/transfers').export({dbPath:dir+'/source.sqlite',after});
      console.log(JSON.stringify({metadata,base}));`, directory, t.signal);
    assert(transfer.base.sequence > first.checkpoint.sequence);
    assert(transfer.metadata.bytes < 8192, 'Repeated offline changes transfer only their net effect');
    await peerOperation('apply', { dbPath: targetPath, metadata: transfer.metadata,
      path: join(directory, 'transfers', `peer-${transfer.metadata.id}.changes`) });
    assert.equal((await stat(targetPath)).ino, inode, 'Expired transaction history does not replace the receiver file');
    await peerOperation('acknowledge', { dbPath: sourcePath, checkpoint: transfer.metadata.target });
    const replica = new Store(targetPath);
    try {
      assert.equal(replica.db.prepare('SELECT value FROM observations WHERE id=1').get().value, 1 + 256 * Number.EPSILON);
      assert.equal(replica.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 5);
      assert.equal(replica.getState('bookkeeping').counter, 255);
      replica.db.prepare('UPDATE observations SET value=? WHERE id=2').run(1 / 7);
    } finally { replica.close(); }
    const { PeerTransfers } = await import('../../src/replication/coalesced.js');
    const returning = await new PeerTransfers(join(directory, 'return')).export({ dbPath: targetPath, after: transfer.metadata.target });
    const back = await run(`
      import {peerOperation} from ${JSON.stringify(transferURL)};
      import {verifyDatabase} from ${JSON.stringify(verifierURL)};
      import {Store} from ${JSON.stringify(storeURL)};
      const dir=process.argv[1],metadata=${JSON.stringify(returning)};
      await peerOperation('apply',{dbPath:dir+'/source.sqlite',metadata,path:dir+'/return/peer-'+metadata.id+'.changes'});
      const s=new Store(dir+'/source.sqlite',{readOnly:true});const value=s.db.prepare('SELECT value FROM observations WHERE id=2').get().value;s.close();
      console.log(JSON.stringify({value,verification:await verifyDatabase({dbPath:dir+'/source.sqlite'})}));`, directory, t.signal);
    assert.equal(back.value, 1 / 7);
    const final = await verifyDatabase({ dbPath: targetPath });
    assert.equal(final.digest, back.verification.digest);
    assert.deepEqual(final.checkpoint, back.verification.checkpoint);
    t.diagnostic(JSON.stringify({ receiverNode: process.version, receiverSQLite: sqlite, sourceNode: seeded.node, sourceSQLite: seeded.sqlite,
      expiredWindowTransferBytes: transfer.metadata.bytes, reverseTransferBytes: returning.bytes }));
  });
