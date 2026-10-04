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

test('later checks fence app identity, state, version and saved options', () => {
  assert.doesNotThrow(() => validateUnchangedApp(structuredClone(app), app));
  for (const patch of [{ state: 'started' }, { slug: 'other_st-mq' }, { repository: 'different' }, { version: '0.9.6' }, { options: { enabled: true } }]) {
    assert.throws(() => validateUnchangedApp({ ...app, ...patch }, app), /changed during deployment/);
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
