import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createWebAccess } from '../src/app/web-access.js';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { validateSettings } from '../src/app/config.js';

const ADMIN = 'synthetic-admin-web-access-password';
const FAMILY = 'synthetic-family-web-access-password';
const ROTATED = 'synthetic-rotated-family-password';
const INITIAL = Date.parse('2026-09-25T12:00:00Z');
const MINUTE = 60_000;
const endpoint = server => `http://127.0.0.1:${server.address().port}`;
const headers = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const configuration = overrides => ({ addon: true, token: ADMIN, familyToken: FAMILY,
  host: '127.0.0.1', port: 0, ingressHost: '127.0.0.1', ingressPort: 0, ...overrides });

async function fixture(t, options = {}) {
  const calls = [];
  const record = name => (...args) => { calls.push({ name, args }); return { updated: true }; };
  const sensorView = { available: true, canRetryRebuild: true, events: [{ id: 1, canRevert: true }] };
  const engine = { clock: () => INITIAL, config: { input: 'providers' },
    status: () => ({ sensorChanges: sensorView }),
    fireplaceStatus: () => ({ available: true, entries: [] }), sensorChangesStatus: () => sensorView,
    contract: () => ({ periods: [] }),
    equipmentStatus: () => ({ devices: [
      { id: 'garage_door1', area: 'garage', kind: 'door', enabled: true, controls: { cover: { open: true, close: true, stop: true } } },
      { id: 'other_door', area: 'home', kind: 'door', enabled: true, controls: { cover: { open: true, close: true, stop: true } } },
      { id: 'garage_relay', area: 'garage', kind: 'switch', enabled: true, controls: { cover: { open: true, close: true, stop: true } } },
      { id: 'disabled_door', area: 'garage', kind: 'door', enabled: false, controls: { cover: { open: true, close: true, stop: true } } },
      { id: 'sensor_door', area: 'garage', kind: 'door', enabled: true, controls: { cover: false } },
    ] }),
    charging: Object.fromEntries(['setSettings', 'setChargerSettings', 'setControl', 'resume', 'chargeNow', 'identifyVehicle']
      .map(name => [name, record(`charging.${name}`)])),
    garage: Object.fromEntries(['release', 'setTemporary', 'setHeating', 'setNativeSettings']
      .map(name => [name, record(`garage.${name}`)])),
    ocppSetup: { adopt: record('ocppSetup.adopt') },
    ...Object.fromEntries(['setTemporary', 'testHeating', 'stopDhwr', 'coverEquipment', 'changeFireplace',
      'changeSensor', 'revertSensor', 'retrySensorRebuild', 'recheckEquipment', 'switchEquipment',
      'dehumidifierEquipment', 'setH66Setting', 'testEquipment', 'restoreEquipmentTest', 'testH66', 'setOverride']
      .map(name => [name, record(name)])),
  };
  const config = configuration(options.config);
  const access = createWebAccess({ config, engine,
    store: { events: () => [{ id: 1 }], observations: () => [], getState: () => null },
    chartService: { overview: async () => ({ rows: [] }), query: async () => ({ series: [] }) },
    reloadSettings: record('reloadSettings'),
    pairContext: { status: () => ({ enabled: true }), canControl: () => true,
      recovering: () => false, requestAction: record('pairing.requestAction') },
    ...options.server,
  });
  await access.start();
  t.after(() => access.close());
  const call = async (path, { token = FAMILY, method = 'GET', body, server = access.server, ...extra } = {}) => {
    const response = await fetch(`${endpoint(server)}${path}`, {
      method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
    });
    return { status: response.status, body: await response.json() };
  };
  return { access, engine, config, calls, call,
    post: (path, body = {}, extra) => call(path, { method: 'POST', body, ...extra }) };
}

test('both passwords identify their access role and family retains ordinary reads', async t => {
  const f = await fixture(t);
  const family = await f.call('/api/status');
  assert.equal(family.status, 200);
  assert.deepEqual(family.body.webAccess, { role: 'family', source: 'password' });
  const admin = await f.call('/api/status', { token: ADMIN });
  assert.deepEqual(admin.body.webAccess, { role: 'admin', source: 'password' });
  assert.equal((await f.call('/api/status', { token: 'synthetic-incorrect-password' })).status, 401);
  for (const path of ['/api/pair', '/api/fireplace', '/api/sensor-changes', '/api/events',
    '/api/history', '/api/contract', '/api/chart', '/api/recording-overview']) {
    assert.equal((await f.call(path)).status, 200, path);
  }
  assert.deepEqual(f.calls, []);
});

test('family can operate home Away, Pause and heating, garage Pause and heating, and DHWR', async t => {
  const f = await fixture(t);
  const until = new Date(INITIAL + 2 * 60 * MINUTE).toISOString();
  const actions = [
    ['/api/temporary', { awayUntil: until }, 'setTemporary'],
    ['/api/temporary', { awayUntil: null }, 'setTemporary'],
    ['/api/temporary', { pauseUntil: until }, 'setTemporary'],
    ['/api/temporary', { pauseUntil: null }, 'setTemporary'],
    ['/api/temporary', { awayUntil: until, pauseUntil: until }, 'setTemporary'],
    ...['normal', 'reduction', 'preheat', 'circulation'].map(command => ['/api/heating-test', { command }, 'testHeating']),
    ['/api/dhwr/stop', {}, 'stopDhwr'],
    ['/api/garage/temporary', { pauseUntil: until }, 'garage.setTemporary'],
    ['/api/garage/temporary', { pauseUntil: null }, 'garage.setTemporary'],
    ['/api/garage/release', {}, 'garage.release'],
    ['/api/garage/heating', { mode: 'normal' }, 'garage.setHeating'],
    ['/api/garage/heating', { mode: 'off' }, 'garage.setHeating'],
  ];
  for (const [path, input, name] of actions) {
    assert.equal((await f.post(path, input)).status, 200, `${path} ${JSON.stringify(input)}`);
    assert.equal(f.calls.at(-1).name, name);
  }
  assert.equal(f.calls.length, actions.length);
});

test('family may use every charging card route but not charger commissioning', async t => {
  const f = await fixture(t);
  const actions = [
    ['/api/charging/settings', { priority: 'charger1', revision: 1, associations: { charger1: 'synthetic-identity' } }, 'charging.setSettings'],
    ['/api/charging/chargers/charger1/settings', { scope: 'session', association: 'synthetic-identity', sessionId: 'synthetic-session',
      revision: 1, changes: { readyBy: '18:00', minimumSoc: 90, capacityKwh: 75 } }, 'charging.setChargerSettings'],
    ['/api/charging/chargers/charger1/control', { enabled: false, association: 'synthetic-identity', revision: 1 }, 'charging.setControl'],
    ['/api/charging/chargers/charger1/control', { enabled: true, association: 'synthetic-identity', revision: 2 }, 'charging.setControl'],
    ['/api/charging/chargers/charger1/resume', {}, 'charging.resume'],
    ['/api/charging/chargers/charger1/charge-now', { association: 'synthetic-identity', sessionId: 'synthetic-session', revision: 1 }, 'charging.chargeNow'],
    ['/api/charging/chargers/charger1/identify', { association: 'synthetic-identity', sessionId: 'synthetic-session', revision: 1 }, 'charging.identifyVehicle'],
  ];
  for (const [path, input, name] of actions) {
    assert.equal((await f.post(path, input)).status, 200, path);
    assert.equal(f.calls.at(-1).name, name);
    if (name === 'charging.identifyVehicle') assert.deepEqual(f.calls.at(-1).args, ['charger1', input]);
  }
  assert.equal((await f.post('/api/charging/ocpp-setup', { action: 'adopt', revision: 'a'.repeat(64) })).status, 403);
  assert.equal(f.calls.length, actions.length);
});

test('family garage-door permission verifies the configured device and exact cover action', async t => {
  const f = await fixture(t);
  for (const action of ['open', 'close', 'stop']) {
    assert.equal((await f.post('/api/equipment/cover', { deviceId: 'garage_door1', action })).status, 200);
    assert.deepEqual(f.calls.at(-1), { name: 'coverEquipment', args: [{ deviceId: 'garage_door1', action }] });
  }
  for (const deviceId of ['unknown', 'other_door', 'garage_relay', 'disabled_door', 'sensor_door'])
    assert.equal((await f.post('/api/equipment/cover', { deviceId, action: 'open' })).status, 403, deviceId);
  for (const input of [null, [], {}, { deviceId: 'garage_door1', action: 'toggle' }]) {
    assert.equal((await f.post('/api/equipment/cover', input)).status, 403);
  }
  assert.equal(f.calls.length, 3);
});

test('family denies exports and every remaining write before any operation is dispatched', async t => {
  const f = await fixture(t);
  for (const path of ['/api/database-export', '/api/settings/reload', '/api/settings', '/api/contract',
    '/api/pair/action', '/api/sensor-changes', '/api/sensor-changes/revert', '/api/sensor-changes/retry-rebuild',
    '/api/garage/native', '/api/equipment/recheck', '/api/equipment/switch', '/api/equipment/dehumidifier',
    '/api/equipment/h66', '/api/equipment/test', '/api/equipment/test/restore', '/api/test/h66',
    '/api/charging/ocpp-setup', '/api/new-unrecognized-write']) {
    assert.equal((await f.post(path)).status, 403, path);
  }
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
    const response = await fetch(`${endpoint(f.access.server)}/api/database-export`, {
      method, headers: headers(FAMILY), ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.equal(response.status, 403, `database-export ${method}`);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal((await f.call('/api/temporary', { method, body: {} })).status, 403, method);
  }
  assert.deepEqual(f.calls, []);
});

test('documentation and device-script downloads require admin and preserve exact source bytes', async t => {
  const f = await fixture(t);
  for (const [path, source] of [
    ['/api/downloads/floor-preheat-guide', '../docs/floor-preheat.md'],
    ['/api/downloads/floor-lease-script', '../scripts/shelly/floor-lease.js'],
  ]) {
    const expected = await readFile(new URL(source, import.meta.url));
    const anonymous = await fetch(`${endpoint(f.access.server)}${path}`);
    assert.equal(anonymous.status, 401);
    assert.equal((await f.call(path)).status, 403);
    const response = await fetch(`${endpoint(f.access.server)}${path}`, { headers: headers(ADMIN) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
});

test('admin and trusted Home Assistant ingress retain administrative controls', async t => {
  const f = await fixture(t);
  const native = { setting: 'roomTemperatureC', value: 19 };
  assert.equal((await f.post('/api/garage/native', native, { token: ADMIN })).status, 200);
  assert.equal((await f.post('/api/pair/action', { action: 'take-control' }, { token: ADMIN })).status, 202);
  assert.equal((await f.post('/api/charging/ocpp-setup', { action: 'adopt', revision: 'a'.repeat(64) }, { token: ADMIN })).status, 200);
  f.access.ingressServer.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '172.30.32.2' }));
  const ingress = { server: f.access.ingressServer, headers: { 'Content-Type': 'application/json' } };
  const status = await f.call('/api/status', ingress);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.webAccess, { role: 'admin', source: 'ingress' });
  assert.equal((await f.post('/api/garage/native', native, ingress)).status, 200);
  assert.equal((await f.post('/api/settings/reload', {}, ingress)).status, 200);
  assert.equal(f.calls.length, 5);
});

test('family permissions preserve controller ownership protection', async t => {
  const f = await fixture(t, { server: { controlAuthority: { canControl: () => false, status: () => ({ protected: true }) } } });
  for (const [path, input] of [['/api/temporary', { pauseUntil: null }], ['/api/heating-test', { command: 'circulation' }],
    ['/api/garage/heating', { mode: 'off' }], ['/api/equipment/cover', { deviceId: 'garage_door1', action: 'open' }],
    ['/api/charging/chargers/charger1/charge-now', {}], ['/api/charging/chargers/charger1/identify', {}]]) {
    assert.equal((await f.post(path, input)).status, 409, path);
  }
  assert.deepEqual(f.calls, []);
});

test('family writes still require same-origin JSON and proxy headers cannot grant admin', async t => {
  const f = await fixture(t);
  const input = { pauseUntil: null };
  assert.equal((await f.post('/api/temporary', input, { headers: {} })).status, 401);
  assert.equal((await f.post('/api/temporary', input, { headers: { ...headers(FAMILY), Origin: 'https://invented-other.invalid' } })).status, 403);
  assert.equal((await f.post('/api/temporary', input, { headers: { Authorization: headers(FAMILY).Authorization } })).status, 400);
  const forgedProxy = { ...headers(FAMILY), 'X-Forwarded-For': '172.30.32.2', 'X-Real-IP': '172.30.32.2', 'X-Web-Role': 'admin' };
  assert.equal((await f.post('/api/settings/reload', {}, { headers: forgedProxy })).status, 403);
  assert.deepEqual(f.calls, []);
});

test('rotating the family password revokes unfinished writes and the old login', async t => {
  const f = await fixture(t);
  const received = once(f.access.server, 'request');
  const outgoing = request(`${endpoint(f.access.server)}/api/temporary`, { method: 'POST',
    headers: { ...headers(FAMILY), 'Content-Length': '19' } });
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', incoming => { incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode)); });
    outgoing.on('error', reject);
  });
  outgoing.write('{');
  await received;
  await f.access.apply({ ...f.config, familyToken: ROTATED });
  outgoing.end('"pauseUntil":null}');
  assert.equal(await response, 401);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.call('/api/status')).status, 401);
  assert.equal((await f.call('/api/status', { token: ROTATED })).body.webAccess.role, 'family');
  assert.equal((await f.call('/api/status', { token: ADMIN })).body.webAccess.role, 'admin');
});

test('revoking the family password prevents delayed reads from returning data', async t => {
  let begin, finish;
  const began = new Promise(resolve => { begin = resolve; });
  const f = await fixture(t, { server: { chartService: {
    overview: () => { begin(); return new Promise(resolve => { finish = resolve; }); },
  } } });
  const result = f.call('/api/recording-overview');
  await began;
  await f.access.apply({ ...f.config, familyToken: '' });
  finish({ syntheticPrivateReading: 42 });
  const response = await result;
  assert.equal(response.status, 401);
  assert.doesNotMatch(JSON.stringify(response.body), /syntheticPrivateReading/);
  assert.equal((await f.call('/api/status', { token: ADMIN })).status, 200);
});

test('invalid family credentials fail before changing an active listener or its permissions', async t => {
  const f = await fixture(t);
  const direct = f.access.server;
  for (const [change, message] of [
    [{ token: '' }, /admin web token/i],
    [{ familyToken: ADMIN }, /different/i],
    [{ familyToken: 'synthetic-short' }, /at least 24/i],
    [{ familyToken: 123 }, /must be text/i],
    [{ familyToken: null }, /must be text/i],
  ]) {
    assert.throws(() => createWebAccess({ config: { ...f.config, ...change } }), message);
    await assert.rejects(f.access.apply({ ...f.config, ...change }), message);
    assert.equal(f.access.server, direct);
    assert.equal((await f.call('/api/status')).body.webAccess.role, 'family');
    assert.equal((await f.call('/api/status', { token: ADMIN })).body.webAccess.role, 'admin');
  }
});

test('live family disable revokes its reads and writes while admin remains available', async t => {
  const f = await fixture(t);
  const direct = f.access.server, ingress = f.access.ingressServer;
  await f.access.apply({ ...f.config, familyToken: '' });
  assert.equal(f.access.server, direct);
  assert.equal(f.access.ingressServer, ingress);
  assert.equal((await f.call('/api/status')).status, 401);
  assert.equal((await f.post('/api/temporary', { pauseUntil: null })).status, 401);
  assert.equal((await f.call('/api/status', { headers: {} })).status, 401);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.post('/api/temporary', { pauseUntil: null }, { token: ADMIN })).status, 200);
  assert.equal(f.calls.length, 1);
});

test('standalone loopback cannot become anonymous admin when family access is configured', async t => {
  const f = await fixture(t, { config: { addon: false } });
  assert.equal((await f.call('/api/status', { headers: {} })).status, 401);
  assert.equal((await f.post('/api/temporary', { pauseUntil: null }, { headers: {} })).status, 401);
  assert.equal((await f.call('/api/status')).body.webAccess.role, 'family');
  assert.equal((await f.call('/api/status', { token: ADMIN })).body.webAccess.role, 'admin');
  assert.throws(() => createWebAccess({ config: { ...f.config, token: '' } }), /admin web token/i);
  assert.deepEqual(f.calls, []);
});

async function fireplaceFixture(t) {
  const store = new Store(':memory:');
  let now = INITIAL;
  const engine = new Engine({ store, config: { input: 'providers', settings: validateSettings() }, clock: () => now });
  const f = await fixture(t, { server: { engine, store } });
  t.after(async () => { await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  return { ...f, engine, store, advance: ms => { now += ms; },
    count: () => store.db.prepare('SELECT COUNT(*) n FROM fireplace_events').get().n };
}

test('family firewood removal uses the server-recorded age including the 15-minute boundary', async t => {
  const f = await fireplaceFixture(t);
  const added = await f.post('/api/fireplace', { requestId: 'synthetic-family-load', kg: 8 });
  assert.equal(added.status, 200);
  const entry = added.body.entries[0];
  assert.equal(entry.at, INITIAL);
  assert.equal(entry.canRemove, true);
  assert.equal(entry.removalUntil, INITIAL + 15 * MINUTE);
  const adminAdded = await f.post('/api/fireplace', { requestId: 'synthetic-admin-load', kg: 4 }, { token: ADMIN });
  const adminEntry = adminAdded.body.entries.find(row => row.id !== entry.id);
  f.advance(15 * MINUTE);
  assert.equal((await f.post('/api/fireplace/remove', { requestId: 'synthetic-boundary-removal', id: entry.id })).status, 200);
  f.advance(1);
  const expired = await f.post('/api/fireplace/remove', { requestId: 'synthetic-expired-removal', id: adminEntry.id });
  assert.equal(expired.status, 403);
  assert.equal(f.count(), 3, 'expired removal must not append a source correction');
  const view = (await f.call('/api/fireplace')).body;
  assert.equal(view.entries.find(row => row.id === adminEntry.id).canRemove, false);
  const snapshot = (await f.call('/api/status')).body;
  assert.equal(snapshot.fireplace.entries.find(row => row.id === adminEntry.id).canRemove, false);
  assert.equal((await f.post('/api/fireplace/remove', { requestId: 'synthetic-expired-removal', id: adminEntry.id }, { token: ADMIN })).status, 200);
  assert.equal(f.count(), 4, 'admin retains removal of older entries');
});

test('family can remove another login\'s recent entry and retry a committed removal after its deadline', async t => {
  const f = await fireplaceFixture(t);
  const added = await f.post('/api/fireplace', { requestId: 'synthetic-shared-load', kg: 6 }, { token: ADMIN });
  const id = added.body.entries[0].id;
  const removal = { requestId: 'synthetic-shared-removal', id };
  f.advance(14 * MINUTE);
  assert.equal((await f.post('/api/fireplace/remove', removal)).status, 200);
  assert.equal(f.count(), 2);
  f.advance(2 * MINUTE);
  assert.equal((await f.post('/api/fireplace/remove', removal)).status, 200);
  assert.equal(f.count(), 2, 'a retry confirms the original correction without a new write');
  assert.equal((await f.post('/api/fireplace/remove', { ...removal, requestId: 'synthetic-new-removal' })).status, 403);
  assert.equal(f.count(), 2);
});

test('family cannot extend the firewood removal window using caller timestamps or options', async t => {
  const f = await fireplaceFixture(t);
  const added = await f.post('/api/fireplace', { requestId: 'synthetic-expiry-load', kg: 2 });
  const id = added.body.entries[0].id;
  f.advance(16 * MINUTE);
  for (const extra of [{ at: f.engine.clock() }, { now: INITIAL }, { maxAgeMs: 99_999_999 }, { role: 'admin' }]) {
    assert.equal((await f.post('/api/fireplace/remove', { requestId: 'synthetic-spoofed-removal', id, ...extra })).status, 400);
  }
  assert.equal(f.count(), 1);
});

test('a family firewood removal upload crossing the deadline is denied before recording a correction', async t => {
  const f = await fireplaceFixture(t);
  const added = await f.post('/api/fireplace', { requestId: 'synthetic-slow-load', kg: 2 });
  const payload = JSON.stringify({ requestId: 'synthetic-slow-removal', id: added.body.entries[0].id });
  f.advance(15 * MINUTE - 1);
  const received = once(f.access.server, 'request');
  const outgoing = request(`${endpoint(f.access.server)}/api/fireplace/remove`, { method: 'POST',
    headers: { ...headers(FAMILY), 'Content-Length': Buffer.byteLength(payload) } });
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', incoming => { incoming.resume(); incoming.on('end', () => resolve(incoming.statusCode)); });
    outgoing.on('error', reject);
  });
  outgoing.write(payload.slice(0, -1));
  await received;
  f.advance(2);
  outgoing.end('}');
  assert.equal(await response, 403);
  assert.equal(f.count(), 1);
});
