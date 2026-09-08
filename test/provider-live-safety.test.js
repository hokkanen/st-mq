import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveHttp, selectedServices, readLiveState, writeLiveState, liveCooldowns, livePaths } from './live/support.js';

const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const smart = id => `https://api.smartthings.com/v1/devices/${id}/status`;

test('live transport serializes provider calls even when the device adapter is concurrent', async () => {
  let active = 0, peak = 0, requests = 0;
  const http = createLiveHttp({ fetchImpl: async () => {
    requests++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return ok();
  } });
  try {
    await Promise.all([1, 2, 3].map(id => http.json(smart(id))));
    assert.equal(requests, 3); assert.equal(peak, 1);
    await assert.rejects(http.json(smart(4)), { code: 'live-request-budget-exhausted' });
    assert.equal(requests, 3);
  } finally { http.close(); }
});

test('live transport stops a denied SmartThings host before its next queued request', async () => {
  let requests = 0, saved = 0;
  const state = { attemptedAt: {}, blockedUntil: {} };
  const http = createLiveHttp({ now: () => 1_000_000, state, saveState: () => { saved++; },
    fetchImpl: async url => { requests++; return url.includes('smartthings') ? new Response('synthetic-secret', { status: 401 }) : ok(); } });
  try {
    const results = await Promise.allSettled([http.json(smart('one')), http.json(smart('two'))]);
    assert(results.every(row => row.status === 'rejected'));
    assert.equal(requests, 1); assert.equal(saved, 1);
    assert.equal(results[1].reason.code, 'live-provider-cooldown');
    await http.json('https://dashboard.elering.ee/api/nps/price');
    assert.equal(requests, 2);
    assert.deepEqual(http.summary().failures, { 'api.smartthings.com': 'HTTP 401' });
    assert(!JSON.stringify(http.summary()).includes('synthetic-secret'));
    assert.equal(state.blockedUntil['api.smartthings.com'], 2_800_000);
  } finally { http.close(); }
});

test('live Easee budget permits one authentication flow and never repeats denied login', async () => {
  const requests = [];
  const http = createLiveHttp({ fetchImpl: async url => {
    requests.push(new URL(url).pathname);
    return url.includes('accounts') ? new Response('{}', { status: 401 }) : ok();
  } });
  try {
    await assert.rejects(http.json('https://api.easee.com/api/accounts/refresh_token', { method: 'POST' }), { status: 401 });
    await assert.rejects(http.json('https://api.easee.com/api/accounts/refresh_token', { method: 'POST' }), { code: 'live-request-budget-exhausted' });
    await assert.rejects(http.json('https://api.easee.com/api/accounts/login', { method: 'POST' }), { status: 401 });
    await assert.rejects(http.json('https://api.easee.com/api/accounts/login', { method: 'POST' }), { code: 'live-provider-cooldown' });
    await assert.rejects(http.json('https://api.easee.com/state/example/observations'), { code: 'live-provider-cooldown' });
    assert.deepEqual(requests, ['/api/accounts/refresh_token', '/api/accounts/login']);
  } finally { http.close(); }
});

test('live rate limiting stops other requests to the same provider without exposing response content', async () => {
  let requests = 0;
  const http = createLiveHttp({ fetchImpl: async () => { requests++; return new Response('echoed synthetic-secret', { status: 429 }); } });
  try {
    await assert.rejects(http.json('https://api.open-meteo.com/v1/forecast?hourly=temperature_2m,shortwave_radiation'), error =>
      error.status === 429 && !error.message.includes('synthetic-secret'));
    await assert.rejects(http.json('https://api.open-meteo.com/v1/forecast?current=temperature_2m'), { code: 'live-provider-cooldown' });
    assert.equal(requests, 1);
  } finally { http.close(); }
});

test('live Open-Meteo budget allows one forecast and one current request without a key', async () => {
  let requests = 0;
  const http = createLiveHttp({ fetchImpl: async url => {
    requests++; assert.equal(new URL(url).searchParams.has('apikey'), false); return ok();
  } });
  const forecast = 'https://api.open-meteo.com/v1/forecast?hourly=temperature_2m,shortwave_radiation';
  const current = 'https://api.open-meteo.com/v1/forecast?current=temperature_2m';
  try {
    await http.json(forecast); await http.json(current);
    await assert.rejects(http.json(forecast), { code: 'live-request-budget-exhausted' });
    await assert.rejects(http.json(current), { code: 'live-request-budget-exhausted' });
    assert.equal(requests, 2);
    assert.deepEqual(http.summary().counts, { 'openmeteo-forecast': 1, 'openmeteo-current': 1 });
  } finally { http.close(); }
});

test('live transport cannot issue device commands, contact arbitrary endpoints or bypass HTTPS', async () => {
  let requests = 0;
  const http = createLiveHttp({ fetchImpl: async () => { requests++; return ok(); } });
  try {
    for (const [url, method] of [
      ['https://api.smartthings.com/v1/devices/device/commands', 'POST'],
      ['https://api.easee.com/api/chargers/charger/commands/start_charging', 'POST'],
      ['https://api.easee.com/api/chargers/charger/commands/start_charging', 'GET'],
      ['http://api.easee.com/state/device/observations', 'GET'],
      ['https://evil.example/api', 'GET'],
      ['https://secret@api.easee.com/state/device/observations', 'GET'],
    ]) await assert.rejects(http.json(url, { method }));
    assert.equal(requests, 0);
    http.close();
    await assert.rejects(http.json(smart('one')), { code: 'provider-client-closed' });
    assert.equal(requests, 0);
  } finally { http.close(); }
});

test('live service selection and private cooldown state retain only known safe fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'st-mq-live-safety-'));
  try {
    assert.throws(() => selectedServices('easee,easee'));
    assert.throws(() => selectedServices('device-command'));
    assert.deepEqual(selectedServices('smartthings,easee'), ['smartthings', 'easee']);
    assert.deepEqual(readLiveState(directory), { attemptedAt: {}, blockedUntil: {} });
    const state = { attemptedAt: { easee: 100_000 }, blockedUntil: { 'api.smartthings.com': 200_000 } };
    writeLiveState(directory, state);
    assert.equal(statSync(join(directory, 'state.json')).mode & 0o777, 0o600);
    assert.deepEqual(readLiveState(directory), state);
    assert.deepEqual(liveCooldowns(state, ['easee', 'smartthings', 'elering'], 110_000), [
      { service: 'easee', seconds: 50 }, { service: 'smartthings', seconds: 90 },
    ]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('live runner uses addon paths and honors explicit connection and cache overrides', () => {
  assert.deepEqual(livePaths({}, '/project'), {
    configPath: '/project/data/options.json', directory: '/project/var/live-test',
  });
  assert.deepEqual(livePaths({ STMQ_ADDON: '1' }, '/app'), {
    configPath: '/data/options.json', directory: '/data/st-mq/live-test',
  });
  assert.deepEqual(livePaths({ STMQ_ADDON: '1', STMQ_CONFIG: '/private/options.json', STMQ_DATA_DIR: '/private/controller' }, '/app'), {
    configPath: '/private/options.json', directory: '/private/controller/live-test',
  });
  assert.deepEqual(livePaths({ STMQ_CONFIG: 'connections.json', STMQ_DATA_DIR: 'state', STMQ_LIVE_DATA_DIR: 'checks' }, '/project'), {
    configPath: '/project/connections.json', directory: '/project/checks',
  });
});
