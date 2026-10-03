import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { configurationLoader } from '../src/app/config.js';
import { launch } from '../src/main.js';

const defaultsPath = fileURLToPath(new URL('../config.json', import.meta.url));
const valid = () => ({ controller: { input: 'simulated' }, equipment: { devices: [] },
  garage: { enabled: false }, teslamate: { enabled: false } });
async function fixture(t, { addon = false, saved = valid(), upload } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-recovery-test-'));
  const paths = { defaultsPath, privatePath: join(directory, 'fixture-options.json'),
    importPath: addon ? join(directory, 'secrets.json') : null,
    receiptPath: addon ? join(directory, 'private', 'configuration-import.json') : null };
  const env = { STMQ_CONFIG: paths.privatePath, STMQ_DATA_DIR: join(directory, 'data'),
    STMQ_DATABASE_DIR: join(directory, 'db'), STMQ_HOST: '0.0.0.0', STMQ_PORT: '0',
    ...(addon ? { STMQ_ADDON: '1', SUPERVISOR_TOKEN: 'fixture-supervisor-token' } : {}) };
  let ingressPort, current = structuredClone(saved), writes = 0, app;
  if (addon) {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    ingressPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
  }
  const write = value => writeFileSync(paths.privatePath, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  write(saved);
  if (upload !== undefined) writeFileSync(paths.importPath, typeof upload === 'string' ? upload : JSON.stringify(upload), { mode: 0o600 });
  const source = configurationLoader(env, directory, { paths,
    fetchImpl: async (url, request) => {
      if (request.method === 'POST') { current = JSON.parse(request.body).options; writes++; }
      return { ok: true, json: async () => ({ result: 'ok', data: request.method === 'POST' ? {}
        : { options: structuredClone(current), ingress_port: ingressPort, slug: 'fixture_st-mq' } }) };
    } });
  t.after(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });
  let csrf, key;
  const root = () => `http://127.0.0.1:${app.server.address().port}`;
  const headers = () => ({ ...(addon ? { 'X-Forwarded-Host': 'ha.fixture.invalid' } : { Authorization: `Bearer ${key}` }),
    'Content-Type': 'application/json', 'X-Recovery-CSRF': csrf });
  return {
    directory, paths, env, source, write, root, headers,
    get current() { return current; }, get writes() { return writes; }, get app() { return app; },
    async boot() { app = await launch({ env, cwd: directory, source, installSignalHandlers: false }); return app; },
    async access() {
      if (addon) {
        app.server.closeAllConnections();
        app.server.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '172.30.32.2' }));
      }
      else key = readFileSync(app.keyPath, 'utf8').trim();
      const response = await fetch(root(), { headers: addon ? { 'X-Forwarded-Host': 'ha.fixture.invalid' } : {} });
      const html = await response.text();
      csrf = html.match(/name="recovery-csrf" content="([^"]+)"/)[1];
      return html;
    },
    async api(path = '', body) {
      return fetch(`${root()}/api/recovery${path}`, { method: body === undefined ? 'GET' : 'POST', headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    },
  };
}

test('invalid Linux configuration opens authenticated local recovery without storage or runtime', async t => {
  const f = await fixture(t, { saved: '{"easee":{"fixture-private-key":"fixture-private-value"' });
  const app = await f.boot();
  assert.equal(app.recovery, true);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.engine, undefined);
  assert.equal(existsSync(f.env.STMQ_DATABASE_DIR), false);
  assert.equal(statSync(app.keyPath).mode & 0o777, 0o600);
  assert.ok(app.keyPath.startsWith(`${f.env.STMQ_DATA_DIR}/configuration-recovery-`),
    'Service recovery key remains accessible outside a systemd PrivateTmp namespace');
  assert.equal((await fetch(`${f.root()}/api/recovery`)).status, 401);
  const html = await f.access();
  assert.doesNotMatch(html, /fixture-private|fixture-options/);
  assert.match((await (await f.api()).json()).error, /valid JSON/);
  for (const path of ['/api/settings/reload', '/api/charging/chargers/charger1/use-automatic'])
    assert.equal((await fetch(`${f.root()}${path}`, { method: 'POST', headers: f.headers(), body: '{}' })).status, 404);
  const hostileHost = await new Promise((resolve, reject) => {
    const req = request(`${f.root()}/api/recovery`, { headers: { ...f.headers(), Host: 'attacker.invalid' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHost, 403);
  assert.equal((await fetch(`${f.root()}/api/recovery`, { headers: { ...f.headers(), Origin: 'http://attacker.invalid' } })).status, 403);
  assert.equal((await fetch(`${f.root()}/api/recovery/preview`, { method: 'POST',
    headers: { ...f.headers(), 'X-Recovery-CSRF': 'fixture-wrong' }, body: '{"replacement":false}' })).status, 403);
  assert.equal((await f.api('/preview', { replacement: false })).status, 400);
  assert.equal((await f.api('/preview', { replacement: true })).status, 400);
  // Correct only the file; recovery never starts a controller after saving.
  f.write({ ...valid(), controller: { input: 'simulated', web_token: 'fixture-recovery-admin-password' } });
  const preview = await f.api('/preview', { replacement: false });
  assert.equal(preview.status, 200);
  const review = await preview.json();
  assert.equal(JSON.stringify(review).includes('fixture-recovery-admin-password'), false);
  f.write({ ...valid(), controller: { input: 'simulated', web_token: 'fixture-recovery-admin-password', max_drop_c: 0.5 } });
  assert.equal((await f.api('/apply', { reviewId: review.reviewId })).status, 409);
  const next = await (await f.api('/preview', { replacement: false })).json();
  const applied = await f.api('/apply', { reviewId: next.reviewId });
  assert.equal(applied.status, 200);
  assert.match((await applied.json()).message, /Restart/);
  assert.equal(existsSync(f.env.STMQ_DATABASE_DIR), false);
  assert.equal((await f.api('/apply', { reviewId: next.reviewId })).status, 409);
  const keyPath = app.keyPath;
  await app.close();
  assert.equal(existsSync(keyPath), false);
});

test('HA incompatible saved fields require reviewed replacement and normal restart completes the import', async t => {
  const f = await fixture(t, { addon: true,
    saved: { ...valid(), easee: { access_token: 'fixture-retired-secret' } }, upload: valid() });
  const app = await f.boot();
  assert.equal(app.recovery, true);
  assert.equal(f.writes, 0);
  assert.equal((await fetch(f.root())).status, 403, 'A direct peer cannot impersonate ingress');
  await f.access();
  const status = await (await f.api()).json();
  assert.equal(status.externalImportPath, '/app_configs/fixture_st-mq/secrets.json');
  assert.match(status.error, /Unknown configuration field in easee/);
  assert.equal((await f.api('/preview', { replacement: false })).status, 400);
  const preview = await f.api('/preview', { replacement: true });
  assert.equal(preview.status, 200);
  const review = await preview.json();
  assert.equal(JSON.stringify(review).includes('fixture-retired-secret'), false);
  assert.equal(f.writes, 0);
  const applied = await f.api('/apply', { reviewId: review.reviewId });
  assert.equal(applied.status, 200);
  const receipt = await applied.json();
  assert.ok(receipt.backupPath);
  assert.equal(statSync(receipt.backupPath).mode & 0o777, 0o700);
  assert.equal(f.writes, 1);
  assert.equal(Object.hasOwn(f.current.easee, 'access_token'), false);
  assert.equal(existsSync(f.paths.importPath), true, 'Import stays until normal runtime starts');
  assert.equal(existsSync(f.env.STMQ_DATABASE_DIR), false);
  await app.close();
  const running = await f.boot();
  assert.notEqual(running.recovery, true);
  assert.equal(running.engine.environment(), 'simulation');
  assert.equal(existsSync(f.paths.importPath), false);
});

test('malformed HA upload leaves saved options intact and recovery reachable', async t => {
  const f = await fixture(t, { addon: true, upload: '{"fixture-private":"fixture-secret"' });
  await f.boot();
  await f.access();
  assert.equal(f.app.recovery, true);
  assert.equal((await f.api('/preview', { replacement: true })).status, 400);
  assert.equal(f.writes, 0);
  assert.equal(existsSync(f.paths.importPath), true);
  assert.equal(existsSync(f.env.STMQ_DATABASE_DIR), false);
  assert.doesNotMatch(JSON.stringify(await (await f.api()).json()), /fixture-secret|fixture-private/);
});

test('a valid configuration with an incompatible database fails without recovery or database mutation', async t => {
  const f = await fixture(t);
  f.write({ ...valid(), controller: { input: 'simulated', web_token: 'fixture-recovery-admin-password' } });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(f.env.STMQ_DATABASE_DIR);
  const database = join(f.env.STMQ_DATABASE_DIR, 'simulation.sqlite');
  const bytes = Buffer.from('fixture-not-a-database');
  writeFileSync(database, bytes);
  await assert.rejects(f.boot());
  assert.deepEqual(readFileSync(database), bytes);
});

test('actual CLI entry serves recovery for malformed configuration and exits cleanly', async t => {
  const f = await fixture(t, { saved: '{"fixture-private":"fixture-secret"' });
  const child = spawn(process.execPath, ['src/main.js'], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, ...f.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Recovery CLI did not start')), 10000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Recovery CLI exited early: ${code}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n').filter(Boolean)) {
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        if (entry.event === 'configuration-recovery') { clearTimeout(timeout); resolve(entry); }
      }
    });
  });
  assert.doesNotMatch(output + errors, /fixture-secret|fixture-private/);
  assert.equal((await fetch(`http://127.0.0.1:${ready.address.port}/`)).status, 200);
  assert.equal(existsSync(f.env.STMQ_DATABASE_DIR), false);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.equal(existsSync(ready.accessKeyFile), false);
});
