import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';
import { webRequestAllowed } from '../chart/web-access.js';
import { chargingTestLocalTime, parseChargingTestTime } from '../chart/charging-test-time.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'charging-physical-api-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-09-30T17:00:00Z'), connected = false, primary = true;
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory),
    input: 'mqtt', deviceId: null, connections: { mqtt: { address: 'mqtt://example.invalid' } } };
  const engine = new Engine({ store, config, clock: () => now });
  const runtime = engine.charging, item = runtime.chargers.charger1;
  const reading = value => ({ value, available: true, measuredAt: now, source: 'easee' });
  item.adapter = { normalize: () => ({ connected: reading(connected), charging: reading(false),
    powerKw: reading(0), voltageV: reading(230), maximumCurrentA: reading(16) }) };
  item.controller = { status: () => ({ session: { connected, connectedAt: connected ? now : null },
    snapshot: { online: true, readAt: now, controlReady: true, schedule: { enabled: 'none' } }, phase: 'off' }),
    async update() { throw new Error('Assessment must not operate the charger'); }, close() {} };
  item.controls.enabled = true; runtime.refreshSettings();
  runtime.teslaCapture = { snapshot: () => ({ connected: true, healthy: true, pluggedIn: false }), reception: () => ({ connected: true }) };
  t.after(async () => { await runtime.close(); await engine.closeFireplace(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { engine, runtime, store, input: { chargerId: 'charger1', vehicleId: 'tesla', program: 'immediate',
    association: item.association, soc: 30, nativeTargetSoc: 80, prepared: true },
  primary: () => primary, demote: () => { primary = false; }, plug: () => { now += 1000; connected = true; } };
}

test('guided-test API uses real normalized charger readiness and keeps declarations out of production settings', async t => {
  const f = fixture(t), token = 'synthetic-physical-test-authorization';
  const server = createAppServer({ engine: f.engine, store: f.store, token,
    controlAuthority: { canControl: f.primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (action, input, authorized = true) => fetch(`http://127.0.0.1:${server.address().port}/api/charging/tests/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input),
  });
  const before = structuredClone(f.runtime.settings);
  assert.equal((await post('start', f.input, false)).status, 401);
  const preview = await post('preview', f.input);
  assert.equal(preview.status, 200);
  const preparation = await preview.json();
  assert.equal(preparation.eligible, true, JSON.stringify(preparation.gates));
  assert.equal(f.runtime.physicalTests.status().runs.length, 0, 'Preview never arms a run');
  assert.equal((await post('start', { ...f.input, association: 'stale-screen' })).status, 400);
  const response = await post('start', f.input); assert.equal(response.status, 200);
  const armed = (await response.json()).charging.physicalTests.runs[0];
  assert.equal(armed.phase, 'armed');
  assert.deepEqual(f.runtime.settings, before);
  assert.equal(f.runtime.chargers.charger1.request, null);
  f.plug(); f.runtime.persist();
  const view = f.runtime.status(), run = view.physicalTests.runs[0];
  assert.equal(run.phase, 'observing'); assert.ok(run.sessionId);
  assert.equal(view.chargers[0].values.soc.value, before.chargers.charger1.manualSoc);
  assert.notEqual(view.chargers[0].values.soc.value, f.input.soc);
  assert.notEqual(view.chargers[0].vehicle?.state, 'identified');
  assert.ok(view.diagnostics.chargers[0].current);
  assert.equal((await post('cancel', { id: armed.id, association: f.input.association })).status, 200);
  assert.equal(f.runtime.physicalTests.status().runs[0].phase, 'cancelled');
  assert.deepEqual(f.runtime.settings, before);
  f.demote();
  assert.equal((await post('preview', f.input)).status, 409);
});

test('assessment storage failure stays visible without preventing normal runtime persistence', t => {
  const f = fixture(t), setState = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key.endsWith(':session-diagnostics')) throw new Error('Synthetic diagnostic storage outage');
    return setState(key, value);
  };
  f.plug();
  assert.doesNotThrow(() => f.runtime.persist());
  assert.equal(f.runtime.status().diagnostics.available, false);
  assert.equal(f.store.getState('charging:mqtt').version, 6);
});

test('family assessment actions are explicitly scoped on both sides of the API', () => {
  for (const action of ['preview', 'start', 'schedule', 'cancel']) {
    const path = `/api/charging/tests/${action}`;
    assert.equal(familyRouteAllowed('POST', path), true);
    assert.equal(webRequestAllowed({ role: 'family' }, path, {}), true);
  }
  assert.equal(familyRouteAllowed('POST', '/api/charging/tests/force-start'), false);
  assert.equal(webRequestAllowed({ role: 'family' }, '/api/charging/tests/force-start', {}), false);
});

test('vehicle timer dates use installation time and reject both daylight-saving gaps and overlaps', () => {
  const at = Date.parse('2026-09-30T19:45:00Z');
  assert.equal(chargingTestLocalTime(at), '2026-09-30T22:45');
  assert.equal(parseChargingTestTime('2026-09-30T22:45'), at);
  assert.equal(parseChargingTestTime('2026-01-15T22:45'), Date.parse('2026-01-15T20:45:00Z'));
  assert.throws(() => parseChargingTestTime('2026-03-29T03:30'), /unambiguous/);
  assert.throws(() => parseChargingTestTime('2026-10-25T03:30'), /unambiguous/);
  assert.throws(() => parseChargingTestTime('2026-02-30T12:00'), /unambiguous/);
  assert.throws(() => parseChargingTestTime(''), /date and time/);
});
