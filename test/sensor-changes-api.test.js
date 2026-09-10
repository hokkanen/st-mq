import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';
import { SENSOR_SETTLING_MS } from '../src/domain/indoor-sensors.js';

const initial = Date.parse('2026-09-10T12:00:00Z');
const payload = { requestId: 'invented-api-change', signal: 'indoor_temperature', reason: 'replacement' };
async function fixture(t, { input = 'providers', ...serverOptions } = {}) {
  const store = new Store(':memory:');
  let now = initial;
  const engine = new Engine({ store, config: { input, settings: validateSettings({ mode: 'monitoring' }) }, clock: () => now });
  const token = 'synthetic-sensor-api-access-token';
  const server = createAppServer({ engine, store, token, ...serverOptions });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer); store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = async (path = '/api/sensor-changes', options = {}) => {
    const response = await fetch(`${base}${path}`, { headers, ...options });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const post = (value = payload, options = {}) => call('/api/sensor-changes', { method: 'POST', body: JSON.stringify(value), ...options });
  const count = () => store.db.prepare("SELECT COUNT(*) n FROM learning_journal WHERE json_type(payload,'$.value.sensorChange')='object'").get().n;
  return { store, engine, base, headers, call, post, count, advance: ms => { now += ms; } };
}

test('sensor-change HTTP routes require authentication and same-origin JSON before recording a change', async t => {
  const { base, headers, call, post, count } = await fixture(t);
  assert.equal((await call('/api/sensor-changes', { headers: {} })).status, 401);
  assert.equal((await post(payload, { headers: {} })).status, 401);
  assert.equal((await post(payload, { headers: { ...headers, Origin: 'https://invented-other.invalid' } })).status, 403);
  assert.equal((await post(payload, { headers: { Authorization: headers.Authorization } })).status, 400);
  assert.equal((await post(payload, { body: '{invalid' })).status, 400);
  assert.equal(count(), 0);
  const result = await post(payload, { headers: { ...headers, Origin: base } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.events[0].at, initial);
  assert.equal(result.body.events[0].settleUntil, initial + SENSOR_SETTLING_MS);
  assert.equal(count(), 1);
});

test('sensor-change HTTP validation rejects backdating, arbitrary notes and invalid logical sensors without exposing them', async t => {
  const { post, count } = await fixture(t);
  for (const value of [null, [], {}, { ...payload, signal: 'heating_integral' }, { ...payload, reason: 'unknown' },
    { ...payload, requestId: '' }, { ...payload, requestId: 'contains spaces' }, { ...payload, at: initial - 1 },
    { ...payload, settleUntil: initial }, { ...payload, input: 'simulated' },
    { ...payload, device: 'invented-sensitive-device' }, { ...payload, notes: 'invented-sensitive-note' }]) {
    const result = await post(value);
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.body).includes('invented-sensitive'), false);
  }
  assert.equal(count(), 0);
});

test('HTTP retries retain the original server timestamp, reject conflicting identities and keep source IDs out of public status', async t => {
  const { call, post, count, advance } = await fixture(t);
  const first = await post();
  advance(60_000);
  const repeated = await post();
  assert.equal(first.status, 200); assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.events, first.body.events);
  assert.equal((await post({ ...payload, reason: 'moved' })).status, 409);
  assert.equal((await post({ ...payload, signal: 'bedroom_temperature' })).status, 409);
  assert.equal(count(), 1);
  const second = await post({ ...payload, requestId: 'invented-api-next-change', signal: 'bedroom_temperature', reason: 'moved' });
  assert.equal(second.status, 200); assert.equal(count(), 2);
  assert.equal(second.body.events[0].at, initial + 60_000);
  assert.equal(second.body.events[1].at, initial);
  assert.equal(JSON.stringify(second.body).includes('requestId'), false);
  assert.equal(JSON.stringify(second.body).includes('invented-api'), false);
  assert.deepEqual((await call()).body.events, second.body.events);
  assert.deepEqual((await call('/api/status')).body.sensorChanges.events, second.body.events);
});

test('a durable sensor change survives follow-up failure and the same retry creates no duplicate event or new boundary', async t => {
  const { engine, call, post, count, advance } = await fixture(t);
  engine.onTemporaryChange = () => { throw new Error('invented-internal-sensitive-details'); };
  const failed = await post();
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes('invented-internal'), false);
  assert.equal(count(), 1);
  const saved = (await call()).body;
  assert.equal(saved.events[0].at, initial);
  assert.equal(engine.checkpoint.measurementEpochAt, initial);
  engine.onTemporaryChange = undefined;
  advance(60_000);
  const retried = await post();
  assert.equal(retried.status, 200); assert.equal(count(), 1);
  assert.deepEqual(retried.body.events, saved.events);
  assert.equal(engine.checkpoint.measurementEpochAt, initial);
});

test('offline, replica and protected controllers cannot record sensor changes through HTTP', async t => {
  for (const [name, options, code] of [
    ['offline', { input: 'offline' }, 400],
    ['replica', { role: 'replica' }, 405],
    ['another controller owns control', { controlAuthority: { canControl: () => false, status: () => ({ protected: true }) } }, 409],
    ['paired standby', { pairContext: { canControl: () => false, status: () => ({ role: 'standby' }) } }, 409],
    ['historical recovery', { pairContext: { canControl: () => true, recovering: () => true, status: () => ({ recovering: true }) } }, 409],
  ]) await t.test(name, async t => {
    const { call, post, count } = await fixture(t, options);
    const view = await call();
    assert.equal(view.status, 200);
    if (name === 'offline') assert.equal(view.body.available, false);
    assert.equal((await post()).status, code);
    assert.equal(count(), 0);
  });
});
