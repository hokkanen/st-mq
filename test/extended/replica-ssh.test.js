import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store } from '../../src/storage/store.js';
import { readReplicaPublication, snapshotDigest } from '../../src/replication/publication.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const executable = async path => { try { await access(path, constants.X_OK); return path; } catch { return null; } };

async function prerequisites() {
  const rsyncCandidates = process.env.STMQ_SQLITE_RSYNC_PATH ? [process.env.STMQ_SQLITE_RSYNC_PATH]
    : [...(process.env.PATH ?? '').split(':').filter(Boolean).map(path => join(path, 'sqlite3_rsync')),
      '/tmp/stmq-replica-build/sqlite3_rsync'];
  const rsync = (await Promise.all(rsyncCandidates.map(executable))).find(Boolean);
  const sshd = await executable('/usr/sbin/sshd'), ssh = await executable('/usr/bin/ssh');
  const keygen = await executable('/usr/bin/ssh-keygen');
  return { rsync, sshd, ssh, keygen, missing: [!rsync && 'sqlite3_rsync', !sshd && 'sshd',
    !ssh && 'ssh', !keygen && 'ssh-keygen'].filter(Boolean) };
}

function processResult(command, args, { input, env = process.env, detached = false } = {}) {
  const child = spawn(command, args, { env, detached, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16384); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const done = new Promise(resolveResult => {
    child.once('error', () => resolveResult({ code: -1, stdout: '', stderr: '' }));
    child.once('close', code => resolveResult({ code, stdout, stderr }));
  });
  return { child, done };
}

async function availablePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

function portReady(port) {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
    socket.setTimeout(100, () => { socket.destroy(); done(false); });
  });
}

test('real SSH transport verifies SQLite snapshots and catches up after receiver outage', { timeout: 60_000 }, async t => {
  const tools = await prerequisites();
  if (tools.missing.length) {
    const reason = `Real SSH replication test requires ${tools.missing.join(', ')}.`;
    if (process.env.STMQ_REQUIRE_SSH_TESTS === '1') assert.fail(reason);
    t.skip(reason); return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'stmq-replica-ssh-'));
  await chmod(directory, 0o700);
  let daemon, source;
  const helpers = new Set();
  async function stopDaemon() {
    if (!daemon) return;
    const previous = daemon; daemon = null;
    try { process.kill(-previous.child.pid, 'SIGTERM'); } catch { previous.child.kill('SIGTERM'); }
    await previous.done;
  }
  t.after(async () => {
    for (const operation of helpers) operation.child.kill('SIGTERM');
    const kill = setTimeout(() => { for (const operation of helpers) operation.child.kill('SIGKILL'); }, 2000);
    try { await Promise.allSettled([...helpers].map(operation => operation.done)); }
    finally { clearTimeout(kill); }
    await stopDaemon(); source?.close();
    await rm(directory, { recursive: true, force: true });
  });

  const hostKey = join(directory, 'host-key'), clientKey = join(directory, 'client-key');
  for (const path of [hostKey, clientKey]) {
    const result = await processResult(tools.keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'synthetic-replica-test', '-f', path]).done;
    assert.equal(result.code, 0, 'Synthetic SSH key generation succeeds');
    await chmod(path, 0o600); await chmod(`${path}.pub`, 0o600);
  }
  const port = await availablePort(), daemonConfig = join(directory, 'sshd_config');
  const user = userInfo().username;
  await writeFile(daemonConfig, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${hostKey}`, `PidFile ${join(directory, 'sshd.pid')}`,
    `AuthorizedKeysFile ${clientKey}.pub`, 'StrictModes no', 'PubkeyAuthentication yes',
    'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'AuthenticationMethods publickey',
    'UsePAM no', 'UseDNS no', 'PermitRootLogin prohibit-password', `AllowUsers ${user}`,
    'PrintMotd no', 'PrintLastLog no', 'LogLevel ERROR', 'AllowTcpForwarding no', 'X11Forwarding no',
    'PermitTunnel no', 'PermitTTY no', '',
  ].join('\n'), { mode: 0o600 });
  const configurationCheck = await processResult(tools.sshd, ['-t', '-f', daemonConfig]).done;
  if (configurationCheck.code !== 0 && /Missing privilege separation directory/.test(configurationCheck.stderr)) {
    const reason = 'Real SSH replication test requires the sshd privilege-separation directory.';
    if (process.env.STMQ_REQUIRE_SSH_TESTS === '1') assert.fail(reason);
    t.skip(reason); return;
  }
  assert.equal(configurationCheck.code, 0, 'Isolated SSH daemon configuration is valid');

  async function startDaemon() {
    daemon = processResult(tools.sshd, ['-D', '-e', '-f', daemonConfig], { detached: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await portReady(port)) return;
      if (daemon.child.exitCode !== null) assert.fail('Isolated SSH daemon exited before becoming ready');
      await delay(25);
    }
    assert.fail('Isolated SSH daemon did not become ready');
  }
  await startDaemon();

  const clientConfig = join(directory, 'ssh_config'), knownHosts = join(directory, 'known_hosts');
  const publicHostKey = (await readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  await writeFile(knownHosts, `synthetic-replica-host ${publicHostKey}\n`, { mode: 0o600 });
  await writeFile(clientConfig, [
    'Host synthetic-replica', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${user}`,
    `  IdentityFile ${clientKey}`, '  IdentitiesOnly yes', `  UserKnownHostsFile ${knownHosts}`,
    '  GlobalKnownHostsFile /dev/null', '  HostKeyAlias synthetic-replica-host',
    '  StrictHostKeyChecking yes', '  BatchMode yes', '  ControlMaster no', '  ControlPath none',
    '  LogLevel ERROR', '',
  ].join('\n'), { mode: 0o600 });

  // Production transports receive this isolated -F configuration on both SSH
  // channels. The test neither reads ~/.ssh nor changes its own process PATH.
  const helper = join(directory, 'synchronize.mjs');
  const transportUrl = pathToFileURL(join(root, 'src/replication/transport.js')).href;
  await writeFile(helper, `import { synchronizeReplica, publicReplicationError } from ${JSON.stringify(transportUrl)};\n` +
    `let input = ''; for await (const chunk of process.stdin) input += chunk;\n` +
    `const abort = new AbortController(); process.once('SIGTERM', () => abort.abort());\n` +
    `let ticks = 0; const timer = setInterval(() => ticks++, 2);\n` +
    `try { const result = await synchronizeReplica({ ...JSON.parse(input), signal: abort.signal }); process.stdout.write(JSON.stringify({ ok: true, result, ticks })); }\n` +
    `catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: publicReplicationError(error), ticks })); }\n` +
    `finally { clearInterval(timer); }\n`, { mode: 0o600 });
  const sourcePath = join(directory, 'primary.sqlite'), remoteDirectory = join(directory, 'replica');
  const config = { sshHost: 'synthetic-replica', remoteDirectory,
    sshConfigPath: clientConfig,
    sourceDirectory: join(directory, 'work'), receiverPath: join(root, 'scripts/replica-receiver.js'),
    nodePath: process.execPath, rsyncPath: tools.rsync, remoteRsyncPath: tools.rsync, timeoutMs: 15000 };
  async function synchronize() {
    const operation = processResult(process.execPath, [helper], {
      input: JSON.stringify({ dbPath: sourcePath, config }),
    });
    helpers.add(operation);
    const result = await operation.done;
    helpers.delete(operation);
    assert.equal(result.code, 0, 'Synchronization helper exits cleanly without exposing subprocess diagnostics');
    let reply;
    try { reply = JSON.parse(result.stdout); } catch { assert.fail('Synchronization helper returns a bounded result'); }
    return reply;
  }
  source = new Store(sourcePath);
  await chmod(sourcePath, 0o600);
  const statement = source.db.prepare('INSERT INTO events(id,type,payload,at) VALUES(?,?,?,0)');
  const insert = { run:(id,label,payload)=>statement.run(id,label,JSON.stringify({data:payload.toString('hex')})) };
  source.transaction(() => { for (let id = 1; id <= 64; id++) insert.run(id, `synthetic-${id}`, Buffer.alloc(4096, id)); });
  source.setState('replica-test', { revision: 1 });

  async function assertPublished(result) {
    assert.equal(result.ok, true, `Real SSH synchronization succeeds (${result.code ?? 'verified'})`);
    assert(result.ticks > 0, 'The synchronization event loop stays responsive');
    const publication = await readReplicaPublication(remoteDirectory);
    assert.equal(publication.digest, result.result.digest);
    assert.equal(publication.generation, result.result.generation);
    const actual = await snapshotDigest(publication.dbPath);
    assert.equal(actual.digest, publication.digest, 'Published pages independently match the primary snapshot digest');
    assert.equal(actual.bytes, result.result.bytes);
    const replica = new Store(publication.dbPath, { readOnly: true });
    try {
      assert.deepEqual(replica.getState('replica-test'), source.getState('replica-test'));
      const rowDigest = store => createHash('sha256').update(JSON.stringify(store.db.prepare(
        'SELECT id,type,payload FROM events ORDER BY id').all())).digest('hex');
      assert.equal(rowDigest(replica), rowDigest(source), 'All logical rows match without printing database contents');
    } finally { replica.close(); }
    return publication;
  }

  const first = await assertPublished(await synchronize());
  source.transaction(() => {
    source.db.prepare('UPDATE events SET type=?,payload=? WHERE id=2').run('changed', JSON.stringify({data:'7'.repeat(16000)}));
    source.db.exec('DELETE FROM events WHERE id=3');
    source.setState('replica-test', { revision: 2 });
  });
  const second = await assertPublished(await synchronize());
  assert.notEqual(second.generation, first.generation);

  await stopDaemon();
  source.transaction(() => {
    source.db.exec('DELETE FROM events WHERE id BETWEEN 10 AND 20');
    for (let id = 65; id <= 90; id++) insert.run(id, `after-outage-${id}`, Buffer.alloc(512, id));
    source.setState('replica-test', { revision: 3, outageCollected: true });
  });
  const unavailable = await synchronize();
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'connection_failed');
  assert.equal((await readReplicaPublication(remoteDirectory)).generation, second.generation,
    'An unreachable receiver leaves the previous publication intact');
  await startDaemon();
  const recovered = await assertPublished(await synchronize());
  assert.notEqual(recovered.generation, second.generation);
  const wrongHostKey = (await readFile(`${clientKey}.pub`, 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  await writeFile(knownHosts, `synthetic-replica-host ${wrongHostKey}\n`, { mode: 0o600 });
  const untrusted = await synchronize();
  assert.equal(untrusted.ok, false, 'An unexpected SSH host key fails closed');
  assert.equal(untrusted.code, 'connection_failed');
  assert.equal((await readReplicaPublication(remoteDirectory)).generation, recovered.generation);
});
