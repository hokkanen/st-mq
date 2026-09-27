import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';
import { SENSOR_SETTLING_MS } from '../src/domain/indoor-sensors.js';
import { sensorLearningContext, sensorRevision } from '../src/app/sensor-inputs.js';

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
  const revert = (value, options = {}) => call('/api/sensor-changes/revert', { method: 'POST', body: JSON.stringify(value), ...options });
  const retry = (value = {}, options = {}) => call('/api/sensor-changes/retry-rebuild', { method: 'POST', body: JSON.stringify(value), ...options });
  const count = () => store.db.prepare("SELECT COUNT(*) n FROM learning_journal WHERE json_type(payload,'$.value.sensorChange')='object'").get().n;
  return { store, engine, base, headers, call, post, revert, retry, count, advance: ms => { now += ms; } };
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
  assert.equal(engine.checkpoint.sensorEpochs.indoor_temperature, initial);
  engine.onTemporaryChange = undefined;
  advance(60_000);
  const retried = await post();
  assert.equal(retried.status, 200); assert.equal(count(), 1);
  assert.deepEqual(retried.body.events, saved.events);
  assert.equal(engine.checkpoint.sensorEpochs.indoor_temperature, initial);
});

test('offline, replica and protected controllers cannot record sensor changes through HTTP', async t => {
  for (const [name, options, code] of [
    ['offline', { input: 'offline' }, 400],
    ['slave', { role: 'slave' }, 405],
    ['another controller owns control', { controlAuthority: { canControl: () => false, status: () => ({ protected: true }) } }, 409],
    ['paired standby', { pairContext: { canControl: () => false, status: () => ({ role: 'standby' }) } }, 409],
    ['historical recovery', { pairContext: { canControl: () => true, recovering: () => true, status: () => ({ recovering: true }) } }, 409],
  ]) await t.test(name, async t => {
    const { call, post, revert, retry, count } = await fixture(t, options);
    const view = await call();
    assert.equal(view.status, 200);
    if (name === 'offline') assert.equal(view.body.available, false);
    assert.equal((await post()).status, code);
    assert.equal((await revert({ id: 1, requestId: 'invented-protected-revert' })).status, code);
    assert.equal((await retry()).status, code);
    assert.equal(count(), 0);
  });
});

test('sensor reversal and rebuild retry require authentication, same-origin JSON and bounded payloads', async t => {
  const { store, headers, post, revert, retry } = await fixture(t);
  const created = await post();
  const correction = { id: created.body.events[0].id, requestId: 'invented-authorized-revert' };
  for (const mutation of [options => revert(correction, options), options => retry({}, options)]) {
    assert.equal((await mutation({ headers: {} })).status, 401);
    assert.equal((await mutation({ headers: { ...headers, Origin: 'https://invented-other.invalid' } })).status, 403);
    assert.equal((await mutation({ headers: { Authorization: headers.Authorization } })).status, 400);
    assert.equal((await mutation({ body: '{invalid' })).status, 400);
  }
  for (const value of [null, [], {}, { ...correction, id: 0 }, { ...correction, id: '1' },
    { ...correction, id: 1.5 }, { ...correction, id: 999999 }, { ...correction, requestId: '' },
    { ...correction, at: initial }, { ...correction, notes: 'invented-sensitive-note' }]) {
    const response = await revert(value);
    assert.equal(response.status, 400);
    assert.equal(JSON.stringify(response.body).includes('invented-sensitive'), false);
  }
  for (const value of [null, [], { requestId: 'invented-retry' }, { at: initial }])
    assert.equal((await retry(value)).status, 400);
  assert.equal((await retry()).status, 409);
  assert.equal(sensorRevision(store, 'providers'), 0);
});

test('a durable HTTP reversal is retryable after follow-up failure without another reset or correction', async t => {
  const { store, engine, call, post, revert, count, advance } = await fixture(t);
  const created = await post();
  const event = created.body.events[0];
  const correction = { id: event.id, requestId: 'invented-durable-reversal' };
  engine.onTemporaryChange = () => { throw new Error('invented-sensitive-followup'); };
  advance(60_000);
  const failed = await revert(correction);
  assert.equal(failed.status, 503);
  assert.equal(JSON.stringify(failed.body).includes('invented-sensitive'), false);
  const revision = sensorRevision(store, 'providers');
  assert.ok(revision > event.id);
  assert.equal(engine.checkpoint.sensorRevision ?? 0, 0, 'Saving the correction does not synchronously rebuild');
  assert.equal(engine.checkpoint.sensorEpochs.indoor_temperature, initial);
  const saved = (await call()).body;
  assert.equal(saved.events[0].at, initial);
  assert.equal(saved.events[0].revertedAt, initial + 60_000);
  assert.equal(saved.events[0].canRevert, false);
  assert.equal(count(), 1);
  engine.onTemporaryChange = undefined;
  advance(60_000);
  const repeated = await revert(correction);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.events, saved.events);
  assert.equal(sensorRevision(store, 'providers'), revision);
  assert.deepEqual(sensorLearningContext(store, 'providers').revertedSensorChanges, [event.id]);
  assert.equal(count(), 1);
  const another = await post({ ...payload, requestId: 'invented-other-reset', signal: 'bedroom_temperature' });
  assert.equal((await revert({ ...correction, id: another.body.events[0].id })).status, 409);
  assert.equal(JSON.stringify(repeated.body).includes('requestId'), false);
  assert.equal(JSON.stringify(repeated.body).includes('invented-durable'), false);
});

test('failed sensor reconstruction can be retried without adding another source event', async t => {
  const { store, engine, post, revert, retry } = await fixture(t);
  const created = await post();
  const manager = engine.fireplaceManager();
  const workerFactory = manager.workerFactory;
  manager.workerFactory = () => { throw new Error('invented-sensitive-worker-error'); };
  const reversed = await revert({ id: created.body.events[0].id, requestId: 'invented-retry-reversal' });
  assert.equal(reversed.status, 200);
  assert.equal(reversed.body.rebuild.status, 'failed');
  const retained = engine.readAdaptive(engine.clock());
  assert.equal(retained.sensorRevision ?? 0, 0, 'A failed worker cannot trigger synchronous correction replay');
  assert.equal(retained.sensorEpochs.indoor_temperature, initial);
  const revision = sensorRevision(store, 'providers');
  const journal = structuredClone(store.learningJournal({ input: 'providers' }));
  manager.workerFactory = workerFactory;
  const retried = await retry();
  assert.equal(retried.status, 200);
  assert.equal(retried.body.rebuild.status, 'running');
  assert.equal(sensorRevision(store, 'providers'), revision);
  assert.deepEqual(store.learningJournal({ input: 'providers' }), journal);
  assert.equal((await retry()).status, 200, 'An HTTP retry of the retry operation is harmless');
});

test('protected status and history expose sensor reversal actions as disabled', async t => {
  let allowed = true;
  const { call, post } = await fixture(t, { controlAuthority: {
    canControl: () => allowed, status: () => ({ protected: !allowed }),
  } });
  assert.equal((await post()).status, 200);
  allowed = false;
  const history = (await call()).body;
  assert.equal(history.available, false);
  assert.equal(history.readOnly, true);
  assert.equal(history.events[0].canRevert, false);
  assert.equal((await call('/api/status')).body.sensorChanges.events[0].canRevert, false);
});
