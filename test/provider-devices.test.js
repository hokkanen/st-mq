import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeviceProviders as createProviders } from '../src/acquisition/devices.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/provider-devices.json', import.meta.url), 'utf8'));
const now = Date.parse('2026-09-06T12:05:00Z');
const createDeviceProviders = options => createProviders({ clock: () => now, ...options });
const easee = { access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', charger_id: 'charger/device', equalizer_id: 'equalizer-device', user: 'synthetic-user', pw: 'synthetic-password' };
const httpError = (status, message = 'provider included a synthetic-secret in its error') => Object.assign(new Error(message), { status });

test('unconfigured device providers perform no HTTP requests', async () => {
  const providers = createDeviceProviders({ http: { json() { throw new Error('unexpected HTTP'); } } });
  assert.deepEqual(await providers.easee({ now }), []);
  assert.throws(() => createDeviceProviders({}), /HTTP JSON/);
  await assert.rejects(providers.easee({ now: NaN }), /timestamp/);
});

test('HTTP measurements made during the request retain the actual response receipt', async () => {
  let current = now;
  const provider = createDeviceProviders({ clock: () => current,
    connections: { easee: { access_token: 'synthetic-token', equalizer_id: 'synthetic-equalizer' } },
    http: { async json() {
      current = now + 100;
      return [31, 32, 33].map(id => ({ id, value: 5, timestamp: new Date(now + 50).toISOString() }));
    } } });
  const rows = await provider.easee({ now });
  assert(rows.every(row => row.receivedAt === now + 100 && row.sourceTime === now + 50));
  assert(rows.every(row => !row.quality.includes('future_source_time') && row.raw.requestStartedAt === now));
  await provider.close();
});

test('HTTP source lead waits once and preserves its original receipt and admission proof', async () => {
  let current = now;
  const provider = createDeviceProviders({ clock: () => current,
    connections: { easee: { access_token: 'synthetic-token', equalizer_id: 'synthetic-equalizer' } },
    http: { async json() {
      setTimeout(() => { current = now + 4; }, 0);
      return [31, 32, 33].map(id => ({ id, value: 5, timestamp: new Date(now + 4).toISOString() }));
    } } });
  const rows = await provider.easee({ now });
  assert(rows.every(row => row.receivedAt === now && row.sourceTime === now + 4));
  assert(rows.every(row => !row.quality.includes('future_source_time')));
  assert.deepEqual(rows[0].raw.timeAdmission, { sourceTime: now + 4, receivedAt: now, admittedAt: now + 4 });
  await provider.close();
});

test('Easee uses replacement observations endpoint and preserves every phase timestamp and null', async () => {
  const calls = [];
  const providers = createDeviceProviders({ connections: { easee }, http: { async json(url, options) {
    calls.push({ url, options }); return url.includes('ids=183') ? fixtures.charger : fixtures.equalizer;
  } } });
  const rows = await providers.easee({ now });
  assert.equal(rows.length, 6); assert.equal(rows[0].value, 10.5); assert.equal(rows[5].value, null);
  assert.equal(rows[0].sourceTime, Date.parse('2026-09-06T12:00:00Z'));
  assert.equal(rows[4].sourceTime, Date.parse('2026-09-06T11:58:00Z'));
  assert(rows.every(row => row.unit === 'A' && row.quality.includes('current_snapshot_not_energy')));
  assert(rows.slice(0, 3).every(row => !row.quality.includes('asynchronous_snapshot')));
  assert(rows.slice(3).every(row => row.quality.includes('asynchronous_snapshot')));
  assert.equal(calls[0].url, 'https://api.easee.com/state/charger%2Fdevice/observations?ids=183,184,185');
  assert.equal(calls[1].url, 'https://api.easee.com/state/equalizer-device/observations?ids=31,32,33');
  assert(calls.every(call => call.options.method === 'GET'));
  assert(!JSON.stringify(rows).includes('must-not-persist'));
});

test('an old idle charger does not mark fresh equalizer phases as asynchronous', async () => {
  let mismatchedEqualizer = false;
  const providers = createDeviceProviders({ connections: { easee }, http: { async json(url) {
    const charger = url.includes('ids=183');
    return (charger ? [183, 184, 185] : [31, 32, 33]).map((id, phase) => ({
      id, value: charger ? 0 : 5 + phase,
      timestamp: new Date(charger ? now - 2 * 86400_000 : now - (mismatchedEqualizer && phase === 1 ? 120_000 : 0)).toISOString(),
    }));
  } } });
  const rows = await providers.easee({ now });
  assert(rows.slice(0, 3).every(row => row.quality.includes('stale')));
  assert(rows.slice(3).every(row => !row.quality.includes('stale')));
  assert(rows.every(row => !row.quality.includes('asynchronous_snapshot')));
  mismatchedEqualizer = true;
  const mismatched = await providers.easee({ now });
  assert(mismatched.slice(3).every(row => row.quality.includes('asynchronous_snapshot')));
  assert(mismatched.slice(0, 3).every(row => !row.quality.includes('asynchronous_snapshot')));
});

test('concurrent Easee 401s share a single refresh and save only rotated token pair', async () => {
  let refreshes = 0; let gets = 0; let loads = 0; const saved = [];
  const connections = { easee: structuredClone(easee) }; const original = structuredClone(connections);
  const providers = createDeviceProviders({ connections, tokenStore: {
    async load() { loads++; return null; }, async save(pair) { saved.push(pair); },
  }, http: { async json(url, options) {
    if (url.endsWith('/refresh_token')) {
      refreshes++; await new Promise(resolve => setImmediate(resolve));
      assert.equal(JSON.parse(options.body).refreshToken, easee.refresh_token);
      return { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', secret: 'discarded' };
    }
    gets++;
    if (options.headers.Authorization === `Bearer ${easee.access_token}`) throw httpError(401);
    assert.equal(options.headers.Authorization, 'Bearer rotated-access');
    return url.includes('ids=183') ? fixtures.charger : fixtures.equalizer;
  } } });
  const rows = await providers.easee({ now });
  assert.equal(rows.length, 6); assert(!rows[0].quality.includes('provider_error'));
  assert.equal(refreshes, 1); assert.equal(gets, 4); assert.equal(loads, 1);
  assert.deepEqual(saved, [{ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }]);
  assert.deepEqual(connections, original);
});

test('saved token pair takes precedence over original connection and is loaded once', async () => {
  let loads = 0;
  const providers = createDeviceProviders({ connections: { easee }, tokenStore: {
    async load() { loads++; return { accessToken: 'saved-access', refreshToken: 'saved-refresh' }; },
  }, http: { async json(url, options) {
    assert.equal(options.headers.Authorization, 'Bearer saved-access');
    return url.includes('ids=183') ? fixtures.charger : fixtures.equalizer;
  } } });
  await providers.easee({ now }); await providers.easee({ now: now + 300_000 });
  assert.equal(loads, 1);
});

test('Easee login fallback is serialized and data reads retry at most once', async () => {
  const calls = [];
  const providers = createDeviceProviders({ connections: { easee }, http: { async json(url, options) {
    calls.push(url);
    if (url.endsWith('/refresh_token')) throw httpError(401);
    if (url.endsWith('/login')) {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(JSON.parse(options.body), { userName: easee.user, password: easee.pw });
      return { accessToken: 'still-rejected', refreshToken: 'new-refresh' };
    }
    throw httpError(401);
  } } });
  const rows = await providers.easee({ now });
  assert(rows.every(row => row.value === null && row.quality.includes('http_status_401')));
  assert.equal(calls.filter(url => url.endsWith('/refresh_token')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/login')).length, 1);
  assert.equal(calls.filter(url => url.includes('/state/')).length, 4);
});

test('rate limiting and server outages never trigger Easee authentication retries', async () => {
  for (const status of [429, 500, 503]) {
    const calls = [];
    const providers = createDeviceProviders({ connections: { easee }, http: { async json(url) { calls.push(url); throw httpError(status); } } });
    const rows = await providers.easee({ now });
    assert.equal(calls.length, 2); assert(calls.every(url => url.includes('/state/')));
    assert(rows.every(row => row.value === null && row.quality.includes(`http_status_${status}`)));
  }
});

test('Easee retains only allowlisted request diagnostics on failed observation placeholders', async () => {
  for (const code of ['provider-request-timeout', 'provider-network-error', 'invalid-provider-json',
    'synthetic-private-error']) {
    const providers = createDeviceProviders({ connections: { easee }, http: { async json() {
      throw Object.assign(new Error('synthetic-private-response'), { code });
    } } });
    for (const rows of [await providers.easee({ now }), await providers.electricity({ now })]) {
      assert(rows.every(row => row.value === null && row.quality.includes('provider_error')));
      assert(rows.every(row => row.raw.error === (code === 'synthetic-private-error' ? 'provider-request-failed' : code)));
      assert(!JSON.stringify(rows).includes('synthetic-private'));
    }
  }
});

test('Easee anomalies retain values, quality and unknown timestamps without energy inference', async () => {
  const providers = createDeviceProviders({ connections: { easee }, http: { async json(url) {
    return (url.includes('ids=183') ? [183, 184, 185] : [31, 32, 33]).map(id => ({ id, value: id > 100 ? 16 : 0 }));
  } } });
  const rows = await providers.easee({ now });
  assert(rows.every(row => row.sourceTime === null && row.quality.includes('source_time_unknown')));
  assert(rows.every(row => row.quality.includes('ev_exceeds_property_current')));
  assert(rows.slice(3).every(row => row.value === 0 && row.quality.includes('all_zero_property_current')));
  assert(rows.every(row => row.unit === 'A'));
});

test('Easee missing phases, units and conflicting duplicate readings are explicit', async () => {
  const providers = createDeviceProviders({ connections: { easee: { ...easee, equalizer_id: '' } }, http: { async json() {
    return [
      { id: 183, value: 1, timestamp: '2026-09-06T12:00:00Z' },
      { id: 183, value: 2, timestamp: '2026-09-06T12:00:00Z' },
      { id: 184, value: 200, unit: 'W', timestamp: '2026-09-06T12:00:00Z' },
    ];
  } } });
  const rows = await providers.easee({ now });
  assert.equal(rows[0].value, null); assert(rows[0].quality.includes('conflicting_duplicate'));
  assert.equal(rows[1].value, null); assert(rows[1].quality.includes('invalid_unit'));
  assert.equal(rows[2].value, null); assert(rows[2].quality.includes('missing'));
});

test('token storage and malformed API failures never leak tokens or response contents', async () => {
  for (const tokenStore of [{ async load() { throw new Error(easee.refresh_token); } }, { async load() { return { accessToken: easee.access_token }; } }]) {
    const providers = createDeviceProviders({ connections: { easee }, tokenStore, http: { async json() { throw new Error('should not run'); } } });
    const rows = await providers.easee({ now });
    assert(rows.every(row => row.quality.includes('provider_error')));
    assert(!JSON.stringify(rows).includes('synthetic'));
  }
});

test('token storage read outage recovers automatically on the next poll', async () => {
  let reads = 0;
  const providers = createDeviceProviders({ connections: { easee }, tokenStore: { async load() {
    reads++;
    if (reads === 1) throw new Error('temporary disk outage');
    return { accessToken: 'saved-access', refreshToken: 'saved-refresh' };
  } }, http: { async json(url) { return url.includes('ids=183') ? fixtures.charger : fixtures.equalizer; } } });
  assert((await providers.easee({ now })).every(row => row.quality.includes('provider_error')));
  const recovered = await providers.easee({ now: now + 300_000 });
  assert.equal(reads, 2); assert(!recovered[0].quality.includes('provider_error')); assert.equal(recovered[0].value, 10.5);
});

test('failed token persistence is retried without rotating tokens again', async () => {
  let saves = 0; let refreshes = 0;
  const providers = createDeviceProviders({ connections: { easee }, tokenStore: {
    async save() { saves++; if (saves === 1) throw new Error('temporary write outage'); },
  }, http: { async json(url, options) {
    if (url.endsWith('/refresh_token')) {
      refreshes++; await new Promise(resolve => setImmediate(resolve));
      return { accessToken: 'new-access', refreshToken: 'new-refresh' };
    }
    if (options.headers.Authorization === `Bearer ${easee.access_token}`) throw httpError(401);
    return url.includes('ids=183') ? fixtures.charger : fixtures.equalizer;
  } } });
  assert((await providers.easee({ now })).every(row => row.quality.includes('provider_error')));
  assert(!(await providers.easee({ now: now + 300_000 }))[0].quality.includes('provider_error'));
  assert.equal(saves, 2); assert.equal(refreshes, 1);
});
