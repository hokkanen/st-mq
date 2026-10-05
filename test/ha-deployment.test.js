import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellQuote, DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';
import { validateConnection, selectApp, validateDeploymentState, validateUnchangedApp, createSupervisorAPI } from '../scripts/deploy-ha.js';

test('deployment accepts SSH destinations and rejects retired or unknown connection fields', () => {
  const valid = { ssh_host: 'synthetic-ha', app_slug: 'synthetic_st-mq' };
  assert.deepEqual(validateConnection(valid), valid);
  assert.deepEqual(validateConnection({ ssh_host: 'root@home-assistant.invalid' }), { ssh_host: 'root@home-assistant.invalid' });
  for (const patch of [{ url: 'http://home-assistant.invalid:8123' }, { token_path: '/private/token' }, { terminal_slug: 'synthetic_ssh' }, { ssh_host: '-oProxyCommand=false' }, { ssh_host: 'root@host;false' }, { ssh_host: 'host\nother' }, { app_slug: 'app;false' }]) {
    assert.throws(() => validateConnection({ ...valid, ...patch }));
  }
  for (const value of [null, [], {}, { url: 'http://home-assistant.invalid', token_path: '/private/token' }]) assert.throws(() => validateConnection(value));
});

test('deployment refuses ambiguous or missing apps and accepts explicit selection', () => {
  const apps = [{ slug: 'one_st-mq' }, { slug: 'two_st-mq' }];
  assert.throws(() => selectApp(apps), /exactly one/);
  assert.throws(() => selectApp(apps, 'missing'), /exactly one/);
  assert.equal(selectApp(apps, 'two_st-mq').slug, 'two_st-mq');
});

test('shell quoting preserves substitution syntax and apostrophes literally', () => {
  const value = "it's $(printf unsafe) `printf unsafe`\nnext";
  const output = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(output, value);
});

const app = { slug: 'synthetic_st-mq', state: 'stopped', version: '0.9.5-dev.3', repository: 'synthetic', options: { enabled: false } };

test('deployment requires a stopped app with valid identity and matching manifest version', () => {
  const manifest = { version: app.version };
  assert.doesNotThrow(() => validateDeploymentState(app, manifest));
  for (const state of ['started', 'starting', 'unknown', undefined]) assert.throws(() => validateDeploymentState({ ...app, state }, manifest), /Stop Home Energy/);
  assert.throws(() => validateDeploymentState(app, { version: '0.9.6' }), /versions differ/);
  assert.throws(() => validateDeploymentState({ ...app, repository: undefined }, manifest), /Git-backed/);
  assert.throws(() => validateDeploymentState({ ...app, slug: "invalid'; false" }, manifest), /identity/);
});

test('deployment requires saved options to be an available object at every check', () => {
  assert.doesNotThrow(() => validateDeploymentState({ ...app, options: {} }, { version: app.version }));
  for (const options of [undefined, null, [], 'synthetic-private-value', false, 0]) {
    const invalid = { ...app, options };
    for (const validate of [
      () => validateDeploymentState(invalid, { version: app.version }),
      () => validateUnchangedApp(invalid, app),
      () => validateUnchangedApp(app, invalid),
      () => validateUnchangedApp(invalid, invalid),
    ]) {
      assert.throws(validate, error => {
        assert.match(error.message, /options|configuration/i);
        assert.match(error.message, /invalid|unavailable/i);
        assert.doesNotMatch(error.message, /synthetic-private-value/);
        return true;
      });
    }
  }
});

test('later checks identify changed app state, identity, repository, version and saved options without private values', () => {
  assert.doesNotThrow(() => validateUnchangedApp(structuredClone(app), app));
  for (const [field, pattern] of [
    ['state', /state/i], ['slug', /identity|slug/i], ['repository', /repository/i],
    ['version', /version/i], ['options', /options|configuration/i],
  ]) {
    const value = field === 'options' ? { 'synthetic-private-key': 'synthetic-private-value' } : 'synthetic-private-value';
    assert.throws(() => validateUnchangedApp({ ...app, [field]: value }, app), error => {
      assert.match(error.message, pattern);
      assert.match(error.message, /changed during deployment/);
      assert.doesNotMatch(error.message, /synthetic-private-key|synthetic-private-value/);
      return true;
    });
  }
});

test('saved options ignore object key order at every depth while preserving array order', () => {
  const original = { ...app, options: {
    enabled: false,
    charging: { limit: 0, name: 'synthetic', schedule: [
      { start: '01:00', details: { enabled: true, target: null } },
      { start: '02:00', details: { enabled: false, target: 80 } },
    ] },
  } };
  const reordered = { ...app, options: {
    charging: { schedule: [
      { details: { target: null, enabled: true }, start: '01:00' },
      { details: { target: 80, enabled: false }, start: '02:00' },
    ], name: 'synthetic', limit: 0 },
    enabled: false,
  } };
  assert.doesNotThrow(() => validateUnchangedApp(reordered, original));
  assert.doesNotThrow(() => validateUnchangedApp(original, reordered));
});

test('saved options still reject scalar, type, key and ordered-array changes', () => {
  const original = { ...app, options: {
    nested: { enabled: false, limit: 0, target: null, label: 'synthetic' },
    order: [1, 2],
    records: [{ name: 'first', enabled: false }, { name: 'second', enabled: true }],
  } };
  const changes = [
    options => { options.nested.enabled = true; },
    options => { options.nested.limit = 1; },
    options => { options.nested.limit = '0'; },
    options => { options.nested.enabled = 0; },
    options => { options.nested.target = ''; },
    options => { options.nested.label = 'changed'; },
    options => { delete options.nested.target; },
    options => { options.nested.extra = null; },
    options => { options.nested = []; },
    options => { options.order.reverse(); },
    options => { options.order.push(3); },
    options => { options.order = { 0: 1, 1: 2 }; },
    options => { options.records.reverse(); },
    options => { options.records[0].enabled = true; },
  ];
  for (const change of changes) {
    const current = structuredClone(original);
    change(current.options);
    assert.throws(() => validateUnchangedApp(current, original), error => {
      assert.match(error.message, /changed during deployment/i);
      assert.match(error.message, /options|configuration/i);
      return true;
    });
  }
});

test('Supervisor calls run over SSH with remote login environment and bounded deadlines', async () => {
  const calls = [];
  const api = createSupervisorAPI({ run: async (...args) => { calls.push(args); return { exitCode: 0, output: JSON.stringify({ result: 'ok', data: { state: 'stopped' } }) }; } });
  assert.deepEqual(await api('/addons/synthetic_st-mq/info'), { state: 'stopped' });
  await api('/addons/synthetic_st-mq/rebuild', 'post', 900);
  assert.equal(calls.length, 2);
  assert.match(calls[0][0], /^bash -lc /);
  assert.match(calls[0][0], /SUPERVISOR_TOKEN/);
  assert.match(calls[1][0], /POST/);
  assert.equal(calls[0][1].timeoutMs, 35000);
  assert.equal(calls[1][1].timeoutMs, 905000);
});

test('Supervisor rejects HTTP failures, malformed responses and error envelopes without exposing output', async () => {
  for (const result of [
    { exitCode: 1, output: 'private-response-fixture' },
    { exitCode: 0, output: 'private-response-fixture' },
    { exitCode: 0, output: JSON.stringify({ result: 'error', message: 'private-response-fixture' }) },
    { exitCode: 0, output: JSON.stringify({ result: 'ok', data: null }) },
  ]) {
    const api = createSupervisorAPI({ run: async () => result });
    await assert.rejects(api('/addons'), error => !error.message.includes('private-response-fixture'));
  }
});

test('Supervisor response stays separate from a login shell startup banner', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ha-deploy-login-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'bash'), '#!/bin/sh\nprintf "private login banner\\n"\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  writeFileSync(join(directory, 'python3'), '#!/bin/sh\nprintf \'{"result":"ok","data":{"state":"stopped"}}\\n\'\n', { mode: 0o700 });
  const api = createSupervisorAPI({ run: async script => ({
    exitCode: 0,
    output: execFileSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH } }),
  }) });
  assert.deepEqual(await api('/addons/synthetic_st-mq/info'), { state: 'stopped' });
});

test('Supervisor connection loss is uncertain and never retries a submitted rebuild', async () => {
  let calls = 0;
  const api = createSupervisorAPI({ run: async () => { calls++; throw new DeploymentTransportError('SSH connection lost; the operation may still be running'); } });
  await assert.rejects(api('/addons/synthetic_st-mq/rebuild', 'post', 900), /may still be running/);
  assert.equal(calls, 1);
});

test('invalid Supervisor requests fail before SSH execution', async () => {
  const api = createSupervisorAPI({ run: async () => assert.fail('invalid request must not execute') });
  for (const args of [['http://other.invalid'], ['/addons;false'], ['/addons', 'delete'], ['/addons', 'post', Infinity]]) await assert.rejects(api(...args), /Invalid Supervisor request/);
});
