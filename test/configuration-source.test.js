import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationPaths, createConfigurationSource, mergeOptions, parseOptions, validateOptionFields } from '../src/app/configuration-source.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-supervisor-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const defaults = { controller: { web_token: '', max_drop_c: 1.5, learning_trials: true, compressor_integral_a1: -100 },
    mqtt: { address: 'mqtt://synthetic.invalid', user: '', pw: '' },
    easee: { user: '', pw: '', charger_voltage_ids: [190, 191] } };
  const schema = { controller: { web_token: 'password', max_drop_c: 'float(0,2)', learning_trials: 'bool', compressor_integral_a1: 'int(-1000,-1)?' },
    mqtt: { address: 'str', user: 'str', pw: 'password' }, easee: { user: 'str?', pw: 'password?', charger_voltage_ids: ['int(190,199)'] } };
  const paths = { defaultsPath: join(directory, 'config.json'), privatePath: join(directory, 'supervisor-options.json'),
    importPath: join(directory, 'secrets.json'), receiptPath: join(directory, 'private/configuration-import.json') };
  writeFileSync(paths.defaultsPath, JSON.stringify({ options: defaults, schema }));
  writeFileSync(paths.privatePath, JSON.stringify({ controller: { max_drop_c: 0.5 } }));
  const state = { current: mergeOptions(defaults, { mqtt: { user: 'synthetic-existing-user', pw: 'synthetic-existing-password' } }),
    requests: [], failSave: false, failRead: false, changeReadback: false, failAfterSave: false, secretValues: {} };
  const resolveReferences = value => typeof value === 'string' && value.startsWith('!secret ')
    ? state.secretValues[value.slice(8)] : Array.isArray(value) ? value.map(resolveReferences)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item)])) : value;
  const fetchImpl = async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer synthetic-supervisor-token');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    state.requests.push({ method: request.method, url });
    if (request.method === 'GET') {
      if (state.failRead) throw new Error('synthetic-private-server-error');
      if (url === 'http://supervisor/addons/self/options/config')
        return { ok: true, json: async () => ({ result: 'ok', data: resolveReferences(state.current) }) };
      assert.equal(url, 'http://supervisor/addons/self/info');
      return { ok: true, json: async () => ({ result: 'ok', data: { slug: 'synthetic_st-mq', options: structuredClone(state.current) } }) };
    }
    assert.equal(url, 'http://supervisor/addons/self/options');
    if (state.failSave) return { ok: false, json: async () => ({ result: 'error', message: 'synthetic-private-validation-error' }) };
    state.lastSavedOptions = JSON.parse(request.body).options;
    assert.equal(JSON.stringify(state.lastSavedOptions).includes(':null'), false, 'Supervisor rejects explicit null, including optional fields');
    state.current = resolveReferences(state.lastSavedOptions);
    if (state.changeReadback) state.current.controller.max_drop_c = 1;
    if (state.failAfterSave) throw new Error('synthetic-network-timeout-after-save');
    return { ok: true, json: async () => ({ result: 'ok', data: {} }) };
  };
  const create = () => createConfigurationSource({ env: { STMQ_ADDON: '1', SUPERVISOR_TOKEN: 'synthetic-supervisor-token' }, cwd: directory, paths,
    fetchImpl, buildConfig: (options, configuration) => ({ options, configuration }) });
  return { paths, state, defaults, schema, source: create(), create,
    upload: options => writeFileSync(paths.importPath, JSON.stringify(options)),
    posts: () => state.requests.filter(request => request.method === 'POST').length };
}

test('sparse configuration merges objects, replaces arrays and preserves explicit false, zero, empty and null', () => {
  assert.deepEqual(mergeOptions({ nested: { keep: true, change: 8 }, array: [1, 2], empty: 'old', nullable: 1 },
    { nested: { change: 0, enabled: false }, array: [], empty: '', nullable: null }),
  { nested: { keep: true, change: 0, enabled: false }, array: [], empty: '', nullable: null });
  for (const input of ['{"pw":"synthetic-sensitive', '[]', 'null', '{"__proto__":{"polluted":true}}']) {
    assert.throws(() => parseOptions(input), error => !error.message.includes('synthetic-sensitive'));
  }
  assert.equal({}.polluted, undefined);
});

test('explicit relative private paths resolve against the supplied working directory', () => {
  assert.equal(configurationPaths({ STMQ_CONFIG: 'connections.json', HOME: '/synthetic-home' }, '/synthetic-workspace').privatePath,
    '/synthetic-workspace/connections.json');
});

test('imports accept only declared fields and valid shapes without reporting private values', t => {
  const f = fixture(t);
  for (const patch of [{ mqtt: { password_typo: 'synthetic-secret' } }, { mqtt: null }, { mqtt: { pw: { value: 'synthetic-secret' } } },
    { controller: { learning_trials: 'false' } }, { easee: { charger_voltage_ids: [999] } }, { easee: { access_token: 'synthetic-secret' } }]) {
    assert.throws(() => validateOptionFields(patch, f.schema), error => !error.message.includes('synthetic-secret'));
  }
  assert.doesNotThrow(() => validateOptionFields({ controller: { compressor_integral_a1: null } }, f.schema));
});

test('HA import validates before saving, merges current options and deletes only after runtime completion', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-new-password' }, controller: { learning_trials: false },
    easee: { charger_voltage_ids: [] } });
  const transaction = await f.source.prepare();
  assert.equal(f.posts(), 0);
  assert.equal(transaction.config.options.mqtt.user, 'synthetic-existing-user');
  assert.equal(transaction.config.options.mqtt.pw, 'synthetic-new-password');
  assert.equal(transaction.config.options.controller.learning_trials, false);
  assert.deepEqual(transaction.config.options.easee.charger_voltage_ids, []);
  assert.equal(transaction.config.configuration.externalImportPath, '/addon_configs/synthetic_st-mq/secrets.json');
  assert.equal(transaction.config.configuration.environment, 'home-assistant');
  assert.equal(JSON.stringify(transaction.config.configuration).includes('synthetic-new-password'), false);
  await transaction.persist();
  assert.equal(f.posts(), 1);
  assert.equal(existsSync(f.paths.importPath), true);
  assert.equal(statSync(f.paths.receiptPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(f.paths.receiptPath, 'utf8').includes('synthetic-new-password'), false);
  assert.deepEqual(await transaction.complete(), { cleanupPending: false });
  assert.equal(existsSync(f.paths.importPath), false);
});

test('HA reload with no import reads fresh Supervisor settings instead of stale options export', async t => {
  const f = fixture(t);
  f.state.current.controller.max_drop_c = 1;
  const transaction = await f.source.prepare();
  assert.equal(transaction.config.options.controller.max_drop_c, 1);
  assert.equal(transaction.imported, false);
  await transaction.persist();
  assert.deepEqual(await transaction.complete(), { cleanupPending: false });
  assert.equal(f.posts(), 0);
});

test('HA rejects retired native token fields without translating or saving settings', async t => {
  for (const field of ['access_token','refresh_token']) {
    const f = fixture(t);
    f.state.current.easee[field] = 'synthetic-retired-token';
    await assert.rejects(f.source.prepare(), error => error.message === `Unknown configuration field: easee.${field}.`);
    assert.equal(f.state.current.easee[field], 'synthetic-retired-token');
    assert.equal(f.posts(),0);
  }
});

test('HA rejects retired topology imports and preserves both settings and source files', async t => {
  for (const retired of [{ replication: {} }, { pairing: {} }, { mirror: { enabled: false } },
    { pair: { enabled: true } }, { controller: { role: 'primary' } }, { controller: { role: 'replica' } },
    { controller: { role: 'master' } }, { controller: { role: 'slave' } }, { pair: { role: 'master' } }]) {
    const f = fixture(t);
    const original = structuredClone(f.state.current);
    f.upload(retired);
    const bytes = readFileSync(f.paths.importPath);
    await assert.rejects(f.source.prepare(), /(Retired|Unsupported).*(controller\.(topology|role)|pair.role)/);
    assert.equal(f.posts(), 0);
    assert.deepEqual(f.state.current, original);
    assert.deepEqual(readFileSync(f.paths.importPath), bytes);
  }
});

test('HA rejects explicit null and new secret references before saving', async t => {
  const f = fixture(t);
  f.upload({ controller: { compressor_integral_a1: null } });
  await assert.rejects(f.source.prepare(), /Home Assistant does not support null: controller.compressor_integral_a1/);
  f.upload({ mqtt: { pw: '!secret synthetic_reference' } });
  await assert.rejects(f.source.prepare(), /actual value in secrets.json/);
  assert.equal(f.posts(), 0);
  assert.equal(existsSync(f.paths.importPath), true);
});

test('existing HA secret references resolve for runtime and follow Supervisor save semantics', async t => {
  const f = fixture(t);
  f.state.current.controller.web_token = '!secret synthetic_existing_web_token';
  f.state.secretValues.synthetic_existing_web_token = 'synthetic-resolved-web-token-value';
  const reload = await f.source.prepare();
  assert.equal(reload.config.options.controller.web_token, 'synthetic-resolved-web-token-value');
  assert.equal(f.posts(), 0);
  f.upload({ mqtt: { user: 'synthetic-imported-user' } });
  const imported = await f.source.prepare();
  assert.equal(imported.config.options.controller.web_token, 'synthetic-resolved-web-token-value');
  await imported.persist();
  assert.equal(f.state.lastSavedOptions.controller.web_token, '!secret synthetic_existing_web_token');
  assert.equal(f.state.current.controller.web_token, 'synthetic-resolved-web-token-value');
  await imported.complete();
  assert.equal(existsSync(f.paths.importPath), false);
});

test('receipt recognizes interrupted Supervisor save after existing references were resolved', async t => {
  const f = fixture(t);
  f.state.current.mqtt.pw = '!secret synthetic_existing_password';
  f.state.secretValues.synthetic_existing_password = 'synthetic-resolved-mqtt-password';
  f.upload({ mqtt: { user: 'synthetic-imported-user' } });
  const first = await f.source.prepare();
  f.state.failAfterSave = true;
  await assert.rejects(first.persist(), /could not be reached/);
  const retry = await f.create().prepare();
  assert.equal(retry.config.options.mqtt.pw, 'synthetic-resolved-mqtt-password');
  await retry.persist();
  await retry.complete();
  assert.equal(f.posts(), 1);
});

test('failed Supervisor save retains the import and keeps errors free of response credentials', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-new-password' } });
  const transaction = await f.source.prepare();
  f.state.failSave = true;
  await assert.rejects(transaction.persist(), error => /could not save/.test(error.message) && !error.message.includes('synthetic-private'));
  assert.equal(existsSync(f.paths.importPath), true);
  await assert.rejects(transaction.complete(), /must be saved/);
});

test('readback mismatch retains the import and never silently reapplies over changed HA settings', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-new-password' } });
  const transaction = await f.source.prepare();
  f.state.changeReadback = true;
  await assert.rejects(transaction.persist(), /could not be verified/);
  assert.equal(existsSync(f.paths.importPath), true);
  await assert.rejects(f.create().prepare(), /interrupted import/);
  assert.equal(f.posts(), 1);
});

test('retained import after saved but failed runtime application does not overwrite later HA changes', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-imported-password' } });
  const first = await f.source.prepare();
  await first.persist();
  // Simulate failed runtime apply or process exit before complete().
  f.state.current.mqtt.pw = 'synthetic-later-ha-password';
  const retry = await f.create().prepare();
  assert.equal(retry.config.options.mqtt.pw, 'synthetic-later-ha-password');
  await retry.persist();
  await retry.complete();
  assert.equal(f.posts(), 1);
  assert.equal(existsSync(f.paths.importPath), false);
});

test('interrupted HTTP save is recognized from verified settings on the next attempt', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-imported-password' } });
  const first = await f.source.prepare();
  f.state.failAfterSave = true;
  await assert.rejects(first.persist(), /could not be reached/);
  const retry = await f.create().prepare();
  await retry.persist();
  await retry.complete();
  assert.equal(f.posts(), 1);
  assert.equal(existsSync(f.paths.importPath), false);
});

test('a newly uploaded copy can intentionally import the same values again', async t => {
  const f = fixture(t);
  const patch = { mqtt: { pw: 'synthetic-imported-password' } };
  f.upload(patch);
  const first = await f.source.prepare();
  await first.persist();
  await first.complete();
  f.state.current.mqtt.pw = 'synthetic-later-ha-password';
  f.upload(patch);
  const next = await f.source.prepare();
  assert.equal(next.config.options.mqtt.pw, patch.mqtt.pw);
  await next.persist();
  await next.complete();
  assert.equal(f.posts(), 2);
});

test('concurrent settings edits and replacement uploads are preserved', async t => {
  const f = fixture(t);
  f.upload({ mqtt: { pw: 'synthetic-imported-password' } });
  const first = await f.source.prepare();
  f.state.current.controller.max_drop_c = 1;
  await assert.rejects(first.persist(), /settings changed/);
  assert.equal(f.posts(), 0);
  const second = await f.source.prepare();
  f.upload({ mqtt: { user: 'synthetic-replacement-user' } });
  await assert.rejects(second.persist(), /file changed/);
  assert.equal(f.posts(), 0);
  const third = await f.source.prepare();
  await third.persist();
  const replacement = `${f.paths.importPath}.upload`;
  writeFileSync(replacement, JSON.stringify({ controller: { max_drop_c: 0.5 } }));
  renameSync(replacement, f.paths.importPath);
  assert.deepEqual(await third.complete(), { cleanupPending: true });
  assert.equal(existsSync(f.paths.importPath), true);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.importPath, 'utf8')), { controller: { max_drop_c: 0.5 } });
});

test('startup can use Supervisor export during outage only if no pending import exists', async t => {
  const f = fixture(t);
  f.state.failRead = true;
  const startup = await f.source.prepare({ startup: true });
  assert.equal(startup.config.options.controller.max_drop_c, 0.5);
  await assert.rejects(f.source.prepare(), /could not be reached/);
  f.upload({ mqtt: { user: 'synthetic-imported-user' } });
  await assert.rejects(f.source.prepare({ startup: true }), /could not be reached/);
  assert.equal(existsSync(f.paths.importPath), true);
});

test('malformed and symbolic-link uploads fail without exposing their content', async t => {
  const f = fixture(t);
  writeFileSync(f.paths.importPath, '{"pw":"synthetic-private-value');
  await assert.rejects(f.source.prepare(), error => /valid JSON/.test(error.message) && !error.message.includes('synthetic-private'));
  rmSync(f.paths.importPath);
  symlinkSync(f.paths.privatePath, f.paths.importPath);
  await assert.rejects(f.source.prepare(), /regular secrets.json/);
  assert.equal(f.posts(), 0);
});

test('standalone validates defaults and private overrides, then retains its permanent file', async t => {
  const f = fixture(t);
  const source = createConfigurationSource({ env: {}, cwd: '.', paths: f.paths,
    buildConfig: (options, configuration) => ({ options, configuration }) });
  const transaction = await source.prepare();
  assert.equal(transaction.config.configuration.environment, 'ubuntu');
  assert.equal(transaction.config.options.controller.max_drop_c, 0.5);
  await transaction.persist();
  await transaction.complete();
  assert.equal(existsSync(f.paths.privatePath), true);
  const manifest = { options: { ...f.defaults, unexpected: 'synthetic-value' }, schema: f.schema };
  writeFileSync(f.paths.defaultsPath, JSON.stringify(manifest));
  await assert.rejects(source.prepare(), /Unknown configuration field: unexpected/);
});
