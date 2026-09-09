import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../src/main.js';
import { configurationSource, loadConfig } from '../src/app/config.js';
import { createConfigurationSource } from '../src/app/configuration-source.js';

const firstToken = 'synthetic-first-addon-web-token';
const secondToken = 'synthetic-second-addon-web-token';
const endpoint = server => `http://127.0.0.1:${server.address().port}`;
const authorization = token => ({ Authorization: `Bearer ${token}` });

function fixture(t, initial = { controller: { input: 'simulated', mode: 'shadow', web_token: '' } }) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-addon-configuration-'));
  const paths = { defaultsPath: fileURLToPath(new URL('../config.json', import.meta.url)),
    privatePath: join(directory, 'supervisor-export.json'), importPath: join(directory, 'secrets.json'),
    receiptPath: join(directory, 'configuration-import.json') };
  const candidatePath = join(directory, 'candidate.json');
  const env = { STMQ_ADDON: '1', STMQ_CONFIG: paths.privatePath,
    STMQ_DATA_DIR: join(directory, 'data'), STMQ_DATABASE_DIR: join(directory, 'database'),
    STMQ_HOST: '127.0.0.1', STMQ_PORT: '0', STMQ_INGRESS_HOST: '127.0.0.1', STMQ_INGRESS_PORT: '0',
    SUPERVISOR_TOKEN: 'synthetic-supervisor-session-token' };
  writeFileSync(paths.privatePath, JSON.stringify(initial));
  let app, saved = structuredClone(initial), posts = 0;
  const events = [], faults = {}, hooks = {};
  const config = loadConfig(env, directory);
  const source = createConfigurationSource({ env, cwd: directory, paths,
    buildConfig(options, information) {
      // Exercise the real config normalizer with entirely synthetic temp data.
      writeFileSync(candidatePath, JSON.stringify(options));
      const next = loadConfig({ ...env, STMQ_CONFIG: candidatePath }, directory);
      next.configuration = information;
      return next;
    },
    async fetchImpl(url, request) {
      assert.equal(url, `http://supervisor/addons/self/${request.method === 'POST' ? 'options' : 'info'}`);
      if (request.method === 'POST') {
        events.push('supervisor-save');
        posts++;
        if (faults.save) return { ok: false, json: async () => ({ result: 'error' }) };
        saved = JSON.parse(request.body).options;
      }
      return { ok: true, json: async () => ({ result: 'ok', data: request.method === 'POST' ? {}
        : { slug: 'synthetic_st-mq', options: structuredClone(saved) } }) };
    },
  });
  // Keep start()'s normal WeakMap source lookup, replacing only its I/O owner.
  configurationSource(config).prepare = async args => {
    events.push(args?.startup ? 'prepare-startup' : 'prepare-reload');
    const transaction = await source.prepare(args);
    return { ...transaction,
      async persist() {
        events.push('persist');
        await hooks.persist?.(transaction);
        await transaction.persist();
        events.push('persisted');
      },
      async complete() {
        events.push('complete');
        await hooks.complete?.(transaction);
        if (faults.cleanup) throw new Error('synthetic-cleanup-failure');
        return transaction.complete();
      },
    };
  };
  t.after(async () => { try { await app?.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  return {
    config, paths, directory, events, faults, hooks,
    get app() { return app; }, get saved() { return saved; }, get posts() { return posts; },
    writeImport: options => writeFileSync(paths.importPath, JSON.stringify(options)),
    async launch() {
      app = await start({ config });
      app.webAccess.ingressServer.on('connection', socket =>
        Object.defineProperty(socket, 'remoteAddress', { value: '172.30.32.2' }));
      return app;
    },
    async reload() {
      return fetch(`${endpoint(app.webAccess.ingressServer)}/api/settings/reload`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'ha.synthetic.invalid',
          Origin: 'https://ha.synthetic.invalid' }, body: '{}', signal: AbortSignal.timeout(5000) });
    },
  };
}

test('add-on bootstrap with no token exposes ingress and leaves direct access disabled', async t => {
  const f = fixture(t);
  const app = await f.launch();
  assert.equal(app.webAccess.status().ingress.enabled, true);
  assert.equal(app.webAccess.status().direct.enabled, false);
  const response = await fetch(`${endpoint(app.webAccess.ingressServer)}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.settingsReload.configuration.externalImportPath, '/addon_configs/synthetic_st-mq/secrets.json');
  assert.equal(f.posts, 0);
});

test('startup import is saved before storage/runtime and removed only after successful startup', async t => {
  const f = fixture(t);
  f.writeImport({ controller: { mode: 'monitoring', web_token: firstToken } });
  f.hooks.persist = () => {
    assert.equal(existsSync(f.config.dbPath), false);
    assert.equal(existsSync(f.paths.importPath), true);
  };
  f.hooks.complete = () => {
    assert.equal(existsSync(f.config.dbPath), true);
    assert.equal(f.saved.controller.mode, 'monitoring');
    assert.equal(f.posts, 1);
  };
  const app = await f.launch();
  assert.equal(app.engine.settings.mode, 'monitoring');
  assert.equal(app.webAccess.status().direct.enabled, true);
  assert.equal(existsSync(f.paths.importPath), false);
  assert.deepEqual(f.events, ['prepare-startup', 'persist', 'supervisor-save', 'persisted', 'complete']);
  assert.equal((await fetch(`${endpoint(app.server)}/api/status`, { headers: authorization(firstToken) })).status, 200);
});

test('ingress import saves Supervisor, applies runtime/token, then cleans up; token rotates and removes live', async t => {
  const f = fixture(t);
  const app = await f.launch();
  const ingress = app.webAccess.ingressServer;
  const originalEngine = app.engine;
  const originalExport = readFileSync(f.paths.privatePath, 'utf8');
  f.events.length = 0;
  f.writeImport({ controller: { mode: 'monitoring', web_token: firstToken } });
  f.hooks.persist = () => {
    assert.equal(app.engine, originalEngine);
    assert.equal(app.webAccess.status().direct.enabled, false);
  };
  f.hooks.complete = () => {
    assert.equal(app.engine.settings.mode, 'monitoring');
    assert.notEqual(app.engine, originalEngine);
    assert.equal(app.webAccess.status().direct.enabled, true);
    assert.equal(f.saved.controller.web_token, firstToken);
  };
  assert.equal((await f.reload()).status, 200);
  assert.deepEqual(f.events, ['prepare-reload', 'persist', 'supervisor-save', 'persisted', 'complete']);
  assert.equal(existsSync(f.paths.importPath), false);
  assert.equal(readFileSync(f.paths.privatePath, 'utf8'), originalExport);
  assert.equal(f.saved.controller.input, 'simulated');
  const direct = app.server;
  const base = endpoint(direct);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(firstToken) })).status, 200);
  delete f.hooks.persist;
  delete f.hooks.complete;
  f.writeImport({ controller: { web_token: secondToken } });
  assert.equal((await f.reload()).status, 200);
  assert.equal(app.server, direct);
  assert.equal(app.engine.settings.mode, 'monitoring');
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(firstToken) })).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(secondToken) })).status, 200);
  f.writeImport({ controller: { web_token: '' } });
  assert.equal((await f.reload()).status, 200);
  assert.equal(app.webAccess.status().direct.enabled, false);
  assert.equal(direct.listening, false);
  assert.equal(app.webAccess.ingressServer, ingress);
  assert.equal((await fetch(`${endpoint(ingress)}/api/status`)).status, 200);
});

test('startup-only changes and pending equipment restoration reject before Supervisor persistence', async t => {
  const f = fixture(t);
  const app = await f.launch();
  const originalEngine = app.engine;
  f.writeImport({ controller: { input: 'offline' } });
  let response = await f.reload();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Restart/);
  assert.equal(f.posts, 0);
  assert.equal(app.engine, originalEngine);
  assert.equal(existsSync(f.paths.importPath), true);
  f.writeImport({ controller: { web_token: firstToken } });
  const restore = app.engine.executor.restore;
  app.engine.executor.restore = async () => ({ restorationPending: true });
  response = await f.reload();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /restoration is still pending/);
  assert.equal(f.posts, 0);
  assert.equal(app.engine, originalEngine);
  assert.equal(existsSync(f.paths.importPath), true);
  assert.equal(app.webAccess.status().direct.enabled, false);
  app.engine.executor.restore = restore;
  assert.equal((await f.reload()).status, 200);
  assert.equal(f.posts, 1);
});

test('Supervisor save failure retains import and previous runtime; retry enables direct access', async t => {
  const f = fixture(t);
  const app = await f.launch();
  const originalEngine = app.engine;
  f.writeImport({ controller: { mode: 'monitoring', web_token: firstToken } });
  f.faults.save = true;
  const response = await f.reload();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /could not be saved/);
  assert.equal(app.engine, originalEngine);
  assert.equal(app.engine.executor.closed, false);
  assert.equal(app.webAccess.status().direct.enabled, false);
  assert.equal(existsSync(f.paths.importPath), true);
  assert.equal(f.saved.controller.mode, 'shadow');
  f.faults.save = false;
  assert.equal((await f.reload()).status, 200);
  assert.equal(app.engine.settings.mode, 'monitoring');
  assert.equal(app.webAccess.status().direct.enabled, true);
  assert.equal(existsSync(f.paths.importPath), false);
});

test('runtime failure after Supervisor save retains import and restores old access for a retry', async t => {
  const f = fixture(t);
  const app = await f.launch();
  f.writeImport({ controller: { mode: 'monitoring', web_token: firstToken } });
  const setState = app.store.setState.bind(app.store);
  let fail = true;
  app.store.setState = (key, value) => {
    if (fail && key === 'providers:health') {
      fail = false;
      assert.equal(f.posts, 1);
      throw new Error('synthetic-runtime-application-failure');
    }
    return setState(key, value);
  };
  let response = await f.reload();
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /previous configuration was restored/);
  assert.equal(app.engine.settings.mode, 'shadow');
  assert.equal(f.saved.controller.mode, 'monitoring');
  assert.equal(app.webAccess.status().direct.enabled, false);
  assert.equal(existsSync(f.paths.importPath), true);
  response = await f.reload();
  assert.equal(response.status, 200);
  assert.equal(f.posts, 1);
  assert.equal(app.engine.settings.mode, 'monitoring');
  assert.equal(app.webAccess.status().direct.enabled, true);
  assert.equal(existsSync(f.paths.importPath), false);
});

test('cleanup failure keeps applied runtime and reports pending cleanup; retry does not save twice', async t => {
  const f = fixture(t);
  const app = await f.launch();
  f.writeImport({ controller: { mode: 'monitoring', web_token: firstToken } });
  f.faults.cleanup = true;
  let response = await f.reload();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settingsReload.result.cleanupPending, true);
  assert.equal(app.engine.settings.mode, 'monitoring');
  assert.equal(app.webAccess.status().direct.enabled, true);
  assert.equal(f.saved.controller.web_token, firstToken);
  assert.equal(existsSync(f.paths.importPath), true);
  f.faults.cleanup = false;
  response = await f.reload();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).settingsReload.result.cleanupPending, false);
  assert.equal(f.posts, 1);
  assert.equal(existsSync(f.paths.importPath), false);
});
