import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { containerProbe, readHARuntime } from '../scripts/lib/ha-deploy-runtime.js';
import { DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';

test('HA container probe reads authenticated synthetic status only from the expected application listener', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-runtime-probe-'));
  mkdirSync(join(directory, 'src/app'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'src/app/config.js'), "export function loadConfig(){return{port:Number(process.env.SYNTHETIC_PORT),token:process.env.SYNTHETIC_TOKEN,host:'127.0.0.1'}};\n");
  writeFileSync(join(directory, 'src/main.js'), `import{createServer}from'node:http';
const server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+process.env.SYNTHETIC_TOKEN){res.writeHead(401);res.end('{}');return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({role:'slave',nodeId:'synthetic-node',pairId:'synthetic-pair',canControl:false,busy:false,phase:null,vip:{owned:false},peer:{nodeId:'synthetic-master',role:'master',reachable:true,lastSeenAt:Date.now()},sync:{state:'ready',error:null},privateUnrelated:'synthetic-private-detail'}));});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  const env = { ...process.env, SYNTHETIC_TOKEN: 'synthetic-private-token' };
  const app = spawn(process.execPath, ['src/main.js'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { app.kill(); if (app.exitCode === null) await once(app, 'exit'); rmSync(directory, { recursive: true, force: true }); });
  let text = '';
  const port = await new Promise((resolve, reject) => { app.on('error', reject); app.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.trim()).port); }); });
  const probe = (patch = {}, parameters = {}) => execFileSync(process.execPath, ['--input-type=module'], {
    input: containerProbe({ pid: app.pid, directory, ...parameters }), encoding: 'utf8', cwd: directory,
    env: { ...env, SYNTHETIC_PORT: String(port), ...patch }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
  });
  // Keep the test's event loop serving the synthetic app in its separate process.
  const output = probe(); const value = JSON.parse(output);
  assert.equal(value.state, 'ready'); assert.equal(value.pair.role, 'slave');
  assert(Number.isFinite(value.observedAt)); assert(!output.includes('synthetic-private-token'));
  assert(!output.includes('synthetic-private-detail'));
  assert.equal(JSON.parse(probe({ SYNTHETIC_TOKEN: 'synthetic-wrong-token' })).state, 'error');
  assert.equal(JSON.parse(probe({ SYNTHETIC_PORT: '1' }, { allowWaiting: true })).state, 'waiting');
  assert.equal(JSON.parse(probe({}, { pid: process.pid })).state, 'error', 'Another process cannot qualify the application listener');
});

function observations({ metadata, status, fail } = {}) {
  const calls = [];
  return { calls, ssh: { run: async (script, options = {}) => {
    calls.push({ script, options });
    if (fail) throw new DeploymentTransportError('synthetic-uncertain-connection');
    if (script.startsWith('python3 -c ')) return { exitCode: 0, output: JSON.stringify(metadata ?? { state: 'running', id: 'a'.repeat(64), image: 'sha256:' + '1'.repeat(64) }) };
    assert.match(script, /^docker exec -i [a-f0-9]{64} node --input-type=module$/);
    assert(Buffer.isBuffer(options.input));
    return { exitCode: 0, output: JSON.stringify(status ?? { state: 'ready', pair: { nodeId: 'synthetic-node' }, observedAt: 1000 }) };
  } } };
}

test('HA runtime binds observations to one container and the verified image without exporting credentials', async () => {
  const f = observations(); const value = await readHARuntime(f.ssh, { slug: 'synthetic_st-mq' }, { expectedContainer: 'a'.repeat(64), expectedImage: 'sha256:' + '1'.repeat(64) });
  assert.equal(value.container, 'a'.repeat(64)); assert.equal(f.calls.length, 2);
  assert(f.calls[0].script.includes('app_synthetic_st-mq')); assert(f.calls[0].script.includes('subprocess.check_output'));
  assert(!f.calls[1].options.input.toString().includes('synthetic-private-token'));
});

test('HA runtime rejects wrong, missing or ambiguous container/image evidence before probing', async () => {
  for (const patch of [{ expectedContainer: 'b'.repeat(64) }, { expectedImage: 'sha256:' + '2'.repeat(64) }]) {
    const f = observations(); await assert.rejects(readHARuntime(f.ssh, { slug: 'synthetic_st-mq' }, patch), /container or running image/); assert.equal(f.calls.length, 1);
  }
  const ambiguous = { run: async () => ({ exitCode: 1, output: 'synthetic-private-docker-output' }) };
  await assert.rejects(readHARuntime(ambiguous, { slug: 'synthetic_st-mq' }), e => /unambiguously/.test(e.message) && !/synthetic-private/.test(e.message));
  const waiting = observations({ metadata: { state: 'waiting' } });
  assert.equal(await readHARuntime(waiting.ssh, { slug: 'synthetic_st-mq' }, { allowWaiting: true }), null);
});

test('HA runtime errors and malformed probe results fail closed without replay or leaking output', async () => {
  const f = observations({ fail: true }); await assert.rejects(readHARuntime(f.ssh, { slug: 'synthetic_st-mq' }), /uncertain-connection/); assert.equal(f.calls.length, 1);
  for (const status of [{ state: 'error' }, { state: 'ready', pair: {}, observedAt: 'bad' }, { state: 'waiting' }]) {
    const g = observations({ status }); await assert.rejects(readHARuntime(g.ssh, { slug: 'synthetic_st-mq' }), /could not be verified/);
  }
});

test('emitted Docker discovery runs against synthetic container metadata and refuses ambiguity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-docker-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'docker'), `#!/usr/bin/python3
import os,sys,json
if sys.argv[1:3]==['container','ls']:
 for row in json.loads(os.environ['SYNTHETIC_ROWS']):print(json.dumps(row))
elif sys.argv[1]=='inspect':print(os.environ['SYNTHETIC_INSPECT'])
else:sys.exit(1)
`, { mode: 0o700 });
  const row = { Names: 'app_synthetic_st-mq', State: 'running', ID: 'a'.repeat(64) };
  const info = { Name: '/app_synthetic_st-mq', Id: row.ID, Image: 'sha256:' + '1'.repeat(64), State: { Running: true }, Config: { Env: ['SYNTHETIC_PRIVATE=synthetic-private-detail'] } };
  const probe = async rows => {
    let nodeCalls = 0;
    const ssh = { run: async (script, options) => {
      if (script.startsWith('docker exec ')) { nodeCalls++; return { exitCode: 0, output: JSON.stringify({ state: 'ready', pair: { nodeId: 'synthetic-node' }, observedAt: 1000 }) }; }
      try {
        const output = execFileSync('sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: directory + ':' + process.env.PATH, SYNTHETIC_ROWS: JSON.stringify(rows), SYNTHETIC_INSPECT: JSON.stringify([info]) } });
        assert(!output.includes('synthetic-private-detail'));
        return { exitCode: 0, output };
      } catch { return { exitCode: 1, output: '' }; }
    } };
    const value = await readHARuntime(ssh, { slug: 'synthetic_st-mq' });
    return { value, nodeCalls };
  };
  const valid = await probe([row]); assert.equal(valid.nodeCalls, 1);
  await assert.rejects(probe([row, { ...row, Names: 'addon_synthetic_st-mq' }]), /unambiguously/);
  await assert.rejects(probe([{ ...row, Names: 'other-app' }]), /unambiguously/);
});
