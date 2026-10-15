import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { PairPeer, openEnvelope, sealEnvelope } from '../src/pairing/peer.js';
import { PairState } from '../src/pairing/state.js';
import { Store } from '../src/storage/store.js';
import { SCHEMA_VERSION } from '../src/storage/schema.js';
import { runReceiver } from '../src/replication/receiver.js';
import { synchronizeReplica } from '../src/replication/transport.js';

const options = { token: 'synthetic-schema-fence-token-0123456789abcdef', pairId: 'synthetic-schema-pair',
  listenHost: '127.0.0.1', port: 0 };
const key = createHash('sha256').update('st-mq paired transport\0').update(options.token).digest();
const oldContext = 'st-mq-pair-v2:POST:/v2/pair';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'stmq-schema-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Exercise the actual peer implementation compiled against another physical
// schema, without adding a runtime schema override to the production API.
async function anotherSchemaPeer() {
  const url = new URL('../src/pairing/peer.js', import.meta.url);
  let source = await readFile(url, 'utf8');
  const dependency = "import { SCHEMA_VERSION } from '../storage/schema.js';";
  assert.equal(source.split(dependency).length, 2);
  source = source.replace(dependency, `const SCHEMA_VERSION = ${SCHEMA_VERSION + 1};`)
    .replace(/from '(\.[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).PairPeer;
}

test('different physical schemas reject both peer directions before dispatch or saved-state mutation', async t => {
  const root = await fixture(t), dbPath = join(root, 'source.sqlite');
  const store = new Store(dbPath); store.setState('synthetic', { preserved: true }); store.close();
  const state = new PairState({ directory: join(root, 'pair'), pairId: options.pairId,
    platform: 'ubuntu', databasePath: dbPath });
  await state.open();
  t.after(() => state.close());
  const beforeDb = await readFile(dbPath), beforePair = await readFile(state.path);
  let handled = 0;
  const handler = async () => { handled++; await state.update({ reason: 'unexpected_dispatch' }); };
  const OtherPeer = await anotherSchemaPeer();
  const current = new PairPeer({ ...options, handler }), other = new OtherPeer({ ...options, handler });
  const currentAddress = await current.start(), otherAddress = await other.start();
  current.peerUrl = `http://127.0.0.1:${otherAddress.port}`;
  other.peerUrl = `http://127.0.0.1:${currentAddress.port}`;
  t.after(async () => { await current.close(); await other.close(); });
  for (const operation of ['status', 'checkpoint', 'peer-transfer', 'peer-ack', 'handover-prepare', 'release']) {
    await assert.rejects(current.request(operation), { code: 'peer_authentication_failed' });
    await assert.rejects(other.request(operation), { code: 'peer_authentication_failed' });
  }
  const oldBody = sealEnvelope({ id: randomUUID(), pairId: options.pairId, at: Date.now(), operation: 'status' }, key, oldContext);
  for (const schema of [undefined, SCHEMA_VERSION, SCHEMA_VERSION + 1]) {
    const tampered = JSON.stringify({ ...JSON.parse(oldBody), version: 2, ...(schema === undefined ? {} : { schema }) });
    const response = await fetch(`http://127.0.0.1:${currentAddress.port}/v2/pair`, { method: 'POST', body: tampered });
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
  assert.equal(handled, 0);
  assert.deepEqual(await readFile(dbPath), beforeDb);
  assert.deepEqual(await readFile(state.path), beforePair);
});

test('peer response authentication also binds the schema and ignores a spoofed outer schema', async t => {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = openEnvelope(Buffer.concat(chunks).toString(), key);
    const response = sealEnvelope({ id: request.id, pairId: options.pairId, ok: true, value: { accepted: true } },
      key, `${oldContext}:response:${request.id}`);
    res.writeHead(200); res.end(JSON.stringify({ ...JSON.parse(response), schema: SCHEMA_VERSION }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const peer = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => { await peer.close(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(peer.request('status'), { code: 'peer_authentication_failed' });
});

for (const prepare of [
  { version: 2 }, { version: 2, schema: SCHEMA_VERSION }, { version: 3 },
  { version: 3, schema: SCHEMA_VERSION - 1 }, { version: 3, schema: String(SCHEMA_VERSION) },
]) test(`receiver refuses incompatible prepare ${JSON.stringify(prepare)} before any directory work`, async t => {
  const root = await fixture(t), directory = join(root, 'receiver');
  const input = new PassThrough(), output = new PassThrough();
  let reply = ''; output.on('data', chunk => { reply += chunk; });
  const result = runReceiver({ directory, input, output });
  input.end(`${JSON.stringify({ type: 'prepare', generation: randomUUID(), ...prepare })}\n`);
  await assert.rejects(result, { code: 'invalid_protocol' });
  assert.equal(reply, '');
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('rejected SSH prepare preserves every existing publication and recovery file byte', async t => {
  const root = await fixture(t), directory = join(root, 'receiver'); await mkdir(directory);
  const files = { '.st-mq-replica': '', 'publication.json': '{synthetic untouched manifest}',
    'publication.json.tmp': 'unpublished metadata', 'journal-publication.json': 'pending publication',
    [`snapshot-${randomUUID()}.sqlite`]: 'synthetic database bytes',
    [`incoming-${randomUUID()}.sqlite`]: 'unclassified incoming bytes' };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  const input = new PassThrough(), output = new PassThrough();
  const result = runReceiver({ directory, input, output });
  input.end(`${JSON.stringify({ type: 'prepare', version: 2, schema: SCHEMA_VERSION, generation: randomUUID() })}\n`);
  await assert.rejects(result, { code: 'invalid_protocol' });
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(files).sort());
  for (const [name, bytes] of Object.entries(files)) assert.equal(await readFile(join(directory, name), 'utf8'), bytes);
});

for (const ready of [
  { version: 2 }, { version: 2, schema: SCHEMA_VERSION }, { version: 3 },
  { version: 3, schema: SCHEMA_VERSION + 1 }, { version: 3, schema: String(SCHEMA_VERSION) },
]) test(`sender refuses incompatible ready ${JSON.stringify(ready)} before source enrollment`, async t => {
  const root = await fixture(t), dbPath = join(root, 'source.sqlite'), capture = join(root, 'prepare.json');
  const store = new Store(dbPath); store.setState('synthetic', { preserved: true }); store.close();
  const before = await readFile(dbPath), sourceDirectory = join(root, 'work');
  const children = [];
  await assert.rejects(synchronizeReplica({ dbPath, config: { sshHost: 'test-peer',
    receiverPath: '/synthetic/receiver.js', remoteDirectory: '/synthetic/replica', sourceDirectory, timeoutMs: 5000 },
  snapshot: async () => assert.fail('No source snapshot before compatible ready'),
  spawnProcess: (command, args, options) => {
    assert.equal(command, 'ssh', 'No rsync or other child before compatible ready');
    const script = `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});
      rl.once('line',line=>{fs.writeFileSync(${JSON.stringify(capture)},line);process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: 'ready', ...ready })}\n`)});});`;
    const child = spawn(process.execPath, ['-e', script], options); children.push(child); return child;
  } }), { code: 'protocol_failed' });
  const prepare = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(prepare.type, 'prepare'); assert.equal(prepare.version, 3); assert.equal(prepare.schema, SCHEMA_VERSION);
  assert.equal(children.length, 1);
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'Owned SSH child reaped');
  assert.deepEqual(await readFile(dbPath), before, 'No durable journal enrollment mutation');
  await assert.rejects(readdir(sourceDirectory), { code: 'ENOENT' });
});
