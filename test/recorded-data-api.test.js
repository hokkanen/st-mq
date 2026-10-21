import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { assertDashboardWrite } from '../chart/dashboard-access.js';
import { webRequestAllowed } from '../chart/web-access.js';

const admin = 'synthetic-recorded-data-admin', family = 'synthetic-recorded-data-family';
async function fixture(t, options = {}) {
  const store = new Store(':memory:'), calls = [];
  const view = { catalogue: { groups: [] }, result: null, job: { state: 'idle' } };
  const chartService = {
    overview: async () => view, energyChecks: async () => ({ ...view, latest: null }),
    overviewAction: async input => { calls.push(input); return view; },
    energyChecksAction: async input => { calls.push(input); return view; },
  };
  const server = createAppServer({ store, engine: { clock: () => 1234 }, chartService,
    token: admin, familyToken: family, role: 'slave', ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const request = async (path, input, token = family) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, calls };
}

test('recorded-data jobs are authenticated read-only inspections on standby for either role', async t => {
  const { request, calls } = await fixture(t);
  for (const token of [admin, family]) {
    for (const [path, action] of [['/api/recording-overview', 'measure'], ['/api/energy-audits', 'refresh']]) {
      assert.equal((await request(path, undefined, token)).status, 200);
      assert.equal((await request(path, { action }, token)).status, 200);
      assert.equal((await request(path, { action: 'cancel' }, token)).status, 200);
    }
  }
  assert.equal(calls.length, 8);
  assert.equal((await request('/api/recording-overview', { action: 'measure' }, 'wrong')).status, 401);
  assert.equal(calls.length, 8);
});

test('inspection boundaries reject retired query and unsupported action shapes before starting work', async t => {
  const { request, calls } = await fixture(t);
  for (const path of ['/api/recording-overview', '/api/energy-audits']) {
    assert.equal((await request(`${path}?refresh=true`)).status, 400);
    for (const input of [null, [], {}, { action: 'erase' }, { action: 'cancel', path: '/synthetic/private' }])
      assert.equal((await request(path, input)).status, 400);
  }
  assert.deepEqual(calls, []);
});

test('inspection errors expose a safe retry reason without native paths or payloads', async t => {
  const { request } = await fixture(t, { chartService: { overview() { throw new Error('/synthetic/private/household.sqlite raw-secret'); } } });
  const response = await request('/api/recording-overview');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'recorded_data_unavailable');
  assert.doesNotMatch(JSON.stringify(response.body), /household|raw-secret/);
});

test('cancellation remains available during configuration work while new inspections wait', async t => {
  const { request, calls } = await fixture(t, { settingsReloadStatus: () => ({ busy: true }) });
  assert.equal((await request('/api/recording-overview', { action: 'measure' })).status, 503);
  assert.equal((await request('/api/energy-audits', { action: 'refresh' })).status, 503);
  assert.equal((await request('/api/recording-overview', { action: 'cancel' })).status, 200);
  assert.deepEqual(calls, [{ action: 'cancel' }]);
});

test('client permits only the current diagnostic actions without relaxing equipment or writer fences', () => {
  const status = { role: 'slave', recordingHealth: { recording: { writer: { state: 'unavailable' } } } };
  for (const [path, action] of [['/api/recording-overview', 'measure'], ['/api/energy-audits', 'refresh']]) {
    for (const choice of [action, 'cancel']) {
      assert.doesNotThrow(() => assertDashboardWrite(path, { action: choice }, status));
      assert.equal(webRequestAllowed({ role: 'family' }, path, { action: choice }, status), true);
    }
    for (const input of [{ action: 'erase' }, { action, path: '/synthetic' }]) {
      assert.throws(() => assertDashboardWrite(path, input, status));
      assert.equal(webRequestAllowed({ role: 'family' }, path, input, status), false);
    }
  }
  assert.throws(() => assertDashboardWrite('/api/equipment/switch', { on: true }, status));
});

test('energy dates are validated for both access roles and retained for read-only refresh actions', async t => {
  const seen = [];
  const { request } = await fixture(t, { chartService: {
    overview: async () => ({}),
    energyChecks: async args => { seen.push(args); return {}; },
    energyChecksAction: async (input, args) => { seen.push(args); return {}; },
  } });
  const path = '/api/energy-audits?start=2026-10-15&end=2026-10-21';
  for (const token of [admin, family]) {
    assert.equal((await request(path, undefined, token)).status, 200);
    assert.equal((await request(path, { action: 'refresh' }, token)).status, 200);
    assert.equal(webRequestAllowed({ role: token === admin ? 'admin' : 'family' }, path, { action: 'refresh' }), true);
    assert.doesNotThrow(() => assertDashboardWrite(path, { action: 'refresh' }, { replica: { role: 'slave' } }));
  }
  assert(seen.every(args => args.startDate === '2026-10-15' && args.endDate === '2026-10-21'));
  for (const query of ['start=2026-10-15', 'start=2026-10-15&end=2026-10-14', 'start=2026-02-30&end=2026-03-01',
    'start=2026-01-01&start=2026-02-01&end=2026-03-01', 'start=2026-01-01&end=2026-01-02&refresh=true'])
    assert.equal((await request(`/api/energy-audits?${query}`)).status, 400);
  assert.equal(seen.length, 4);
});
