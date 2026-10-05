import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { observe, projectStatus, mqttRoutes, validateObserverConfig } from '../scripts/charging-physical/observe.js';
import { observeIndependent, latestStatus, validateEaseeConfig } from '../scripts/charging-physical/independent.js';
import { readPrivateJson, openPrivateOutput, parseArgs, boundedJson } from '../scripts/charging-physical/io.js';

const status = () => ({ now: Date.now(), pair: { role: 'master', canControl: true, vip: { owned: true }, peer: { role: 'slave' } },
  charging: { chargers: ['charger1', 'charger2'].map(id => ({ id, association: `synthetic-${id}`,
    telemetry: { powerKw: { value: 0, measuredAt: 1000, available: true } } })) } });
const baseConfig = () => ({ status: { url: 'http://127.0.0.1:1/api/status' } });
const easeeConfig = () => ({ accessToken: 'synthetic-observer-token', chargerId: 'fixture-charger',
  equalizerId: 'fixture-equalizer', mainFuseA: [25, 25, 25], marginA: 1, toleranceA: 2 });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'charger-observer-test-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('observer makes only bounded GETs and preserves source clocks in private output', async t => {
  const directory = fixture(t), methods = [], input = status();
  const server = createServer((req, res) => { methods.push(req.method); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(input)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { status: { url: `http://127.0.0.1:${server.address().port}/api/status` } };
  const result = await observe({ config, directory, label: 'run', durationMs: 180 });
  assert.equal(result.samples, 1);
  assert.deepEqual(methods, ['GET']);
  assert.equal(result.stopReason, 'bounded-duration-complete');
  const [row] = rows(path.join(directory, 'run-status.jsonl'));
  assert.equal(row.charging.chargers[0].telemetry.powerKw.measuredAt, 1000);
  assert.equal(row.charging.chargers[0].telemetry.powerKw.value, 0);
  assert.ok(row.receivedAt >= input.now);
  for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  const original = fs.readFileSync(path.join(directory, 'run-status.jsonl'));
  const repeat = await observe({ config, directory, label: 'run', durationMs: 5 });
  assert.equal(repeat.stopReason, 'observation-failed');
  assert.deepEqual(fs.readFileSync(path.join(directory, 'run-status.jsonl')), original);
});

test('failed polls record an explicit evidence gap; cancellation is bounded', async t => {
  const directory = fixture(t), cancel = new AbortController();
  const result = await observe({ config: baseConfig(), directory, label: 'gap', durationMs: 100,
    fetchStatus: async () => { setTimeout(() => cancel.abort(), 10); throw Error('private provider error'); }, signal: cancel.signal });
  assert.equal(result.stopReason, 'operator-interruption');
  assert.equal(result.errors, 1);
  assert.deepEqual(Object.keys(rows(path.join(directory, 'gap-status.jsonl'))[0]), ['receivedAt', 'error']);
  assert.equal(latestStatus(path.join(directory, 'gap-status.jsonl')), null);
});

test('MQTT observer subscribes before polling, preserves retained flag, filters unrelated replies, never publishes', async t => {
  const directory = fixture(t), client = new EventEmitter();
  let subscriptions, ended = false;
  client.connected = true;
  client.publish = () => assert.fail('Observer must not publish MQTT commands');
  client.end = force => { ended = force; };
  client.subscribeAsync = async topics => {
    subscriptions = topics;
    for (const topic of ['fixture-shelly/rpc', 'stmq-evse-fixture/rpc', 'unrelated/rpc', 'fixture-bmw', 'fixture-tesla/current'])
      client.emit('message', topic, Buffer.from('{"value":0}'), { retain: true, qos: 0 });
    return topics.map(topic => ({ topic, qos: 0 }));
  };
  const result = await observe({ config: { ...baseConfig(), mqtt: { url: 'mqtt://127.0.0.1:1',
    shellyTopicPrefix: 'fixture-shelly', vehicles: { bmw: 'fixture-bmw', tesla: 'fixture-tesla/#' } } },
    directory, label: 'mqtt', durationMs: 40, connect: () => client,
    fetchStatus: async () => { assert.ok(subscriptions); return status(); } });
  assert.equal(result.mqttSubscribed, true);
  assert.equal(result.nativeMessages, 2);
  assert.equal(result.vehicleMessages, 2);
  assert.equal(ended, true);
  assert.ok(rows(path.join(directory, 'mqtt-native.jsonl')).every(row => row.retained === true));
  assert.deepEqual(rows(path.join(directory, 'mqtt-vehicle.jsonl')).map(row => row.feed), ['bmw', 'tesla']);
});

test('scope, private files, and unsupported configuration fail closed', t => {
  const directory = fixture(t), file = path.join(directory, 'config.json');
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  assert.deepEqual(readPrivateJson(file), {});
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPrivateJson(file));
  fs.symlinkSync(file, path.join(directory, 'link.json'));
  assert.throws(() => readPrivateJson(path.join(directory, 'link.json')));
  assert.throws(() => openPrivateOutput(path.resolve('evidence.json')));
  assert.throws(() => validateObserverConfig({ ...baseConfig(), oldConfig: true }));
  assert.throws(() => validateObserverConfig({ status: { url: 'http://user:password@localhost/status' } }));
  assert.throws(() => validateObserverConfig({ ...baseConfig(), mqtt: { url: 'mqtt://localhost', shellyTopicPrefix: '#' } }));
  assert.throws(() => validateEaseeConfig({ ...easeeConfig(), toleranceA: null }));
  assert.throws(() => parseArgs(['--config', 'a', '--config', 'b'], ['config']));
  assert.throws(() => projectStatus({}, Date.now()));
  assert.deepEqual(mqttRoutes({ shellyTopicPrefix: 'fixture' }, 'unrelated/rpc'), { native: false, feed: null });
});

test('loss of MQTT coverage leaves a gap that prevents continuous-stop proof', async t => {
  const directory = fixture(t), client = new EventEmitter();
  client.connected = true;
  client.subscribeAsync = async topics => topics.map(topic => ({ topic, qos: 0 }));
  client.end = () => client.emit('close');
  const result = await observe({ config: { ...baseConfig(), mqtt: { url: 'mqtt://127.0.0.1:1', shellyTopicPrefix: 'fixture' } },
    directory, label: 'loss', durationMs: 80, connect: () => client,
    fetchStatus: async () => status(), onReady: () => client.emit('close') });
  assert.equal(result.stopReason, 'mqtt-observation-closed');
  const data = rows(path.join(directory, 'loss-status.jsonl'));
  assert.equal(data.length, 2);
  assert.equal(data[1].error, 'mqtt-observation-closed');
  assert.equal(latestStatus(path.join(directory, 'loss-status.jsonl')), null);
});

test('independent tail reader does not resurrect a cached status after a gap or partial write', t => {
  const directory = fixture(t), file = path.join(directory, 'status.jsonl');
  const row = { ...status(), receivedAt: Date.now() };
  fs.writeFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  assert.deepEqual(latestStatus(file), row);
  fs.appendFileSync(file, '{"error":"status-unavailable","receivedAt":1}\n{"partial":');
  assert.equal(latestStatus(file), null);
});

test('independent observer reads native budget once without commands or clock renewal', async t => {
  const directory = fixture(t), file = path.join(directory, 'run-status.jsonl');
  fs.writeFileSync(file, JSON.stringify({ ...status(), receivedAt: Date.now() }) + '\n', { mode: 0o600 });
  const sourceTime = Date.now() - 600000, requests = [], cancel = new AbortController();
  let closed = false;
  const result = await observeIndependent({ config: { easee: easeeConfig() }, statusFile: file,
    outputFile: path.join(directory, 'independent.jsonl'), duration: 1, signal: cancel.signal,
    request: async (url, options) => { requests.push(options.method); assert.equal(options.redirect, 'error'); return Response.json({ maxAllocatedCurrent: 27 }); },
    createStream: () => ({ start() { setTimeout(() => cancel.abort(), 40); },
      snapshot: () => [{ id: 31, value: 4, measuredAt: sourceTime }],
      evidence: () => ({ connected: false, online: false, synchronized: false, epoch: 1 }),
      close: async () => { closed = true; } }) });
  assert.deepEqual(requests, ['GET']);
  assert.equal(closed, true);
  assert.equal(result.count, 1);
  assert.equal(result.healthyComparableSamples, 0);
  const [row] = rows(path.join(directory, 'independent.jsonl'));
  assert.equal(row.property[0].measuredAt, sourceTime);
  const proof = readPrivateJson(path.join(directory, 'independent-budget-read.json'));
  assert.equal(proof.nativeBudget.currentA, 27);
  assert.equal(proof.httpStatus, 200);
  assert.ok(proof.nativeBudget.confirmedAt >= proof.requestedAt);
});

test('oversized or invalid read-only responses cannot become observations', async () => {
  await assert.rejects(boundedJson(Response.json({ oversized: 'x'.repeat(100) }), 20));
  await assert.rejects(boundedJson(new Response('not JSON')));
  await assert.rejects(boundedJson(new Response('{}', { status: 401 })));
});
