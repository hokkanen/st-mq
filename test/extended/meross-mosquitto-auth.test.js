import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, chmod, access, mkdir, copyFile, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';

test('prepared Mosquitto 2.0 account authenticates a MAC username and retains password-file account access', { timeout: 15000 }, async t => {
  const plugin = '/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so';
  const available = !spawnSync('mosquitto', ['-h']).error && await access(plugin).then(() => true, () => false);
  if (!available && process.env.STMQ_REQUIRE_MQTT_TESTS !== '1') { t.skip('Requires Mosquitto 2.0 Dynamic Security plugin'); return; }
  assert.ok(available);
  const directory = await mkdtemp(join(tmpdir(), 'stmq-meross-auth-')), clients = [];
  let child;
  t.after(async () => {
    await Promise.all(clients.map(c => c.endAsync(true)));
    if (child?.exitCode === null) { const done = once(child, 'close'); child.kill(); await done; }
    await rm(directory, { recursive: true, force: true });
  });
  const device = { uuid: '0123456789abcdef0123001122334455', key: 'abcdef0123456789abcdef0123456789', user_id: 17 };
  const input = join(directory, 'device.json'), passwords = join(directory, 'passwords'), output = join(directory, 'prepared');
  await writeFile(input, JSON.stringify(device), { mode: 0o600 }); await chmod(directory, 0o700);
  execFileSync('mosquitto_passwd', ['-b', '-c', passwords, 'fixture-app', 'fixture-app-password'], { stdio: 'ignore' });
  execFileSync('python3', [fileURLToPath(new URL('../../scripts/prepare-meross-mosquitto.py', import.meta.url)),
    '--device-file', input, '--password-file', passwords, '--output-dir', output], { stdio: 'ignore' });
  const login = JSON.parse(await readFile(join(output, 'device-login.json'), 'utf8'));
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const certificate = join(directory, 'server.crt'), key = join(directory, 'server.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', certificate, '-subj', '/CN=fixture-broker', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const config = join(directory, 'mosquitto.conf');
  await writeFile(config, `listener ${port} 127.0.0.1\ncertfile ${certificate}\nkeyfile ${key}\nallow_anonymous false\npassword_file ${passwords}\nplugin ${plugin}\nplugin_opt_config_file ${join(output, 'dynamic-security.json')}\n`);
  child = spawn('mosquitto', ['-c', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(Error(`Fixture broker exited (${code})`)));
    child.stderr.on('data', b => { if (b.toString().includes('running')) resolve(); });
  });
  async function connect(username, password) {
    const c = mqtt.connect(`mqtts://127.0.0.1:${port}`, { ca: await readFile(certificate), username, password, clean: true, reconnectPeriod: 0 }); clients.push(c);
    await new Promise((resolve, reject) => { c.once('connect', resolve); c.once('error', reject); }); return c;
  }
  const native = await connect(login.username, login.password), app = await connect('fixture-app', 'fixture-app-password');
  assert.equal((await native.subscribeAsync('/appliance/' + device.uuid + '/subscribe', { qos: 1 }))[0].qos, 1);
  let denied;
  try { denied = (await native.subscribeAsync('fixture/unrelated', { qos: 1 }))[0].qos === 128; } catch { denied = true; }
  assert.equal(denied, true);
  assert.equal((await app.subscribeAsync('fixture/unrelated', { qos: 1 }))[0].qos, 1);
  const topic = '/appliance/' + device.uuid + '/publish'; await app.subscribeAsync(topic, { qos: 1 });
  const message = once(app, 'message'); await native.publishAsync(topic, 'invented-contact', { qos: 1, retain: false });
  assert.equal((await message)[1].toString(), 'invented-contact');
  const check = join(directory, 'check.json');
  await writeFile(check, JSON.stringify({ address: `mqtts://127.0.0.1:${port}`, uuid: device.uuid,
    login_file: join(output, 'device-login.json'), server_certificate: certificate }), { mode: 0o600 });
  const result = await new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/verify-meross-broker.js', import.meta.url)), check, '--restricted']);
    let out = '', diagnostic = ''; verifier.stdout.on('data', b => { out += b; });
    verifier.stderr.on('data', b => { diagnostic += b; });
    verifier.once('exit', code => code === 0 ? resolve(JSON.parse(out)) : reject(Error('Pinned fixture verification failed: ' + diagnostic)));
  });
  assert.deepEqual(result, { authenticated: true, certificatePinned: true, nativeSubscription: true, unrelatedSubscriptionDenied: true });

  // Run the actual verifier from a disposable checkout so no private fixture
  // needs to be created in this repository. A leading '..' in a directory name
  // is still inside the checkout; it is not a parent-directory traversal.
  const checkout = join(directory, 'fixture-checkout'), scripts = join(checkout, 'scripts');
  await mkdir(scripts, { recursive: true });
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(checkout, 'node_modules'), 'dir');
  const verifier = join(scripts, 'verify-meross-broker.js');
  await copyFile(fileURLToPath(new URL('../../scripts/verify-meross-broker.js', import.meta.url)), verifier);
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of ['private', '..fixture-private']) {
    const folder = join(checkout, name); await mkdir(folder, { mode: 0o700 });
    const internal = join(folder, 'check.json'); await writeFile(internal, await readFile(check), { mode: 0o600 });
    const denied = spawnSync(process.execPath, [verifier, internal, '--restricted'], { encoding: 'utf8', timeout: 8000 });
    assert.equal(denied.status, 1, `Reject private input within checkout directory ${name}`);
    assert.match(denied.stderr, /failed at private configuration/);
    assert.equal(denied.stdout, '');
  }
});
