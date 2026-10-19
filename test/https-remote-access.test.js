import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { CertificateHelper, effectiveRestrictions, expectedRemoteServe, validRemoteTarget } from '../src/https/helper.js';

const prefs = () => ({ CorpDNS: false, RouteAll: false, ShieldsUp: true, RunSSH: false, RunWebClient: false,
  ExitNodeID: '', ExitNodeIP: '', ExitNodeAllowLANAccess: false, AdvertiseRoutes: null, AdvertiseTags: null,
  AppConnector: { Advertise: false }, AutoUpdate: { Apply: false, Check: true }, RemoteConfig: false });
const remote = { address: '192.0.2.100', port: 8443 };
const config = () => ({ Foreground: { syntheticSession: { TCP: { 8443: { TCPForward: '192.0.2.100:8443' } } } } });

test('only the exact foreground encrypted TCP path can open the dedicated helper', () => {
  assert.equal(expectedRemoteServe(config(), remote), true);
  assert.equal(effectiveRestrictions({ ...prefs(), ShieldsUp: false }, config(), remote), true);
  assert.equal(effectiveRestrictions(prefs(), config(), remote), false);
  const changes = [
    value => { value.AllowFunnel = { 'example.invalid:8443': true }; },
    value => { value.Web = {}; },
    value => { value.Services = {}; },
    value => { value.TCP = value.Foreground.syntheticSession.TCP; delete value.Foreground; },
    value => { value.Foreground.anotherSession = value.Foreground.syntheticSession; },
    value => { value.Foreground.syntheticSession.TCP[443] = { TCPForward: '127.0.0.1:1234' }; },
    value => { value.Foreground.syntheticSession.TCP[8443].TCPForward = '192.0.2.99:8443'; },
    value => { value.Foreground.syntheticSession.TCP[8443].TerminateTLS = 'example.invalid'; },
    value => { value.Foreground.syntheticSession.TCP[8443].ProxyProtocol = 2; },
    value => { value.Foreground.syntheticSession.TCP[8443].HTTP = true; },
  ];
  for (const change of changes) { const value = config(); change(value); assert.equal(expectedRemoteServe(value, remote), false); }
  for (const change of [{ CorpDNS: true }, { RouteAll: true }, { RunSSH: true }, { RemoteConfig: true },
    { AdvertiseRoutes: ['192.0.2.0/24'] }, { AdvertiseTags: ['tag:other'] }])
    assert.equal(effectiveRestrictions({ ...prefs(), ShieldsUp: false, ...change }, config(), remote), false);
  for (const invalid of [null, {}, { address: '0.0.0.0', port: 8443 }, { address: 'example.invalid', port: 8443 },
    { ...remote, port: 0 }, { ...remote, port: 65536 }, { ...remote, port: '8443' }, { ...remote, extra: true }])
    assert.throws(() => validRemoteTarget(invalid), { code: 'helper_remote_target_invalid' });
});

async function fixture(t) {
  const directory = await mkdtemp('/tmp/stmq-remote-helper-');
  let serve = {}, exits = 0;
  const observed = prefs(), children = [], commands = [];
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/serve-config') ? serve : observed));
  });
  const socket = `${directory}/s`;
  await new Promise(done => server.listen(socket, done));
  const helper = new CertificateHelper({ directory, locations: { socket }, onExit: () => { exits++; } });
  helper.cli = async args => {
    commands.push(args);
    if (args[0] === 'set') { observed.ShieldsUp = args.includes('--shields-up=true'); return; }
    if (args[1] === 'reset') { serve = {}; return; }
    assert.deepEqual(args, ['serve', '--tcp=8443', 'tcp://192.0.2.100:8443']);
    assert.equal(observed.ShieldsUp, true, 'No incoming traffic before exact foreground config readback');
    // A real owned process exercises crash/removal/join behavior; no network
    // identity is enrolled and all vendor API evidence here is synthetic.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const record = { child, completion: new Promise(done => child.once('close', () => { serve = {}; done(); })) };
    children.push(child); helper.commands.add(record);
    record.completion.finally(() => helper.commands.delete(record));
    serve = config(); return record;
  };
  t.after(async () => { await helper.stop(); await new Promise(done => server.close(done)); await rm(directory, { recursive: true, force: true }); });
  return { helper, children, commands, observed, serve: () => serve, exits: () => exits, tamper: () => { serve.AllowFunnel = { 'example.invalid:8443': true }; } };
}

test('forwarding is ephemeral, stable on refresh, and removed before returning to certificate-only scope', async t => {
  const f = await fixture(t);
  await f.helper.remoteAccess(remote);
  assert.equal(f.observed.ShieldsUp, false); assert.equal(f.children.length, 1);
  await f.helper.remoteAccess(remote); assert.equal(f.children.length, 1);
  await f.helper.remoteAccess(null);
  assert.equal(f.observed.ShieldsUp, true); assert.deepEqual(f.serve(), {});
  assert.notEqual(f.children[0].signalCode, null); assert.equal(f.exits(), 0);
});

test('unexpected foreground exit is observable and a fresh session restores the same scoped destination', async t => {
  const f = await fixture(t); await f.helper.remoteAccess(remote);
  const closed = new Promise(done => f.children[0].once('close', done));
  f.children[0].kill('SIGKILL'); await closed;
  await new Promise(done => setImmediate(done));
  assert.equal(f.exits(), 1); assert.deepEqual(f.serve(), {});
  await f.helper.remoteAccess(remote); assert.equal(f.children.length, 2);
});

test('an additional public exposure fails closed and joins the owned foreground process', async t => {
  const f = await fixture(t); await f.helper.remoteAccess(remote); f.tamper();
  await assert.rejects(f.helper.restrictions(), { code: 'helper_restrictions_not_confirmed' });
  assert.equal(f.helper.remote, null); assert.notEqual(f.children[0].signalCode, null);
});
