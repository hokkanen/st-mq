import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { readConfigurationOptions, validateOptionFields } from '../src/app/configuration-source.js';
import { configurationSource, loadConfig } from '../src/app/config.js';
import { garageSettings, GARAGE_POLICY_VERSION } from '../src/garage/settings.js';
import { GARAGE_SENDER_CONTRACT } from '../src/garage/sender.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { Store } from '../src/storage/store.js';
import { isolatedGarageAdapter } from './helpers/garage-mqtt.js';

const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const oldPolicy = { approved: true, version: 'garage-exposure-v2', floorC: 2, hardMinimumC: -1,
  budgetDegreeMinutes: 90, recoveryAboveC: 4, recoveryDwellMinutes: 20, recoveryDegreeMinutesPerMinute: 1 };

test('Garage room intent has no duplicate configured baseline', () => {
  assert.equal(Object.hasOwn(document.options.garage, 'baselineC'), false);
  assert.equal(Object.hasOwn(document.schema.garage, 'baselineC'), false);
  assert.equal(Object.hasOwn(garageSettings(), 'baselineC'), false);
  assert.throws(() => garageSettings({ baselineC: 10 }), /Unknown garage setting: baselineC/);
  assert.throws(() => validateOptionFields({ garage: { baselineC: 10 } }, document.schema), /Unknown configuration field in garage: \[unsupported field\]/);
});

test('sparse owner approval inherits public adapter settings and can be withdrawn on reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-garage-approval-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.json');
  const initial = JSON.stringify({ garage: { enabled: true, protection: { approved: true } } });
  writeFileSync(path, initial);
  const config = loadConfig({ HOME: directory, STMQ_CONFIG: path }, directory);
  assert.equal(document.options.garage.enabled, false);
  assert.equal(document.options.garage.protection.approved, false);
  assert.equal(config.garage.enabled, true);
  assert.equal(config.garage.protection.approved, true);
  assert.deepEqual(config.garage.adapter, document.options.garage.adapter);
  assert.deepEqual(config.garage.protection, { ...document.options.garage.protection, approved: true });
  assert.equal(readFileSync(path, 'utf8'), initial, 'Loading must not expand a sparse private file');

  const withdrawn = JSON.stringify({ garage: { enabled: true, protection: { approved: false } } });
  writeFileSync(path, withdrawn);
  const reloaded = (await configurationSource(config).prepare()).config;
  assert.equal(reloaded.garage.enabled, true);
  assert.equal(reloaded.garage.protection.approved, false);
  assert.deepEqual(reloaded.garage.adapter, config.garage.adapter);
  assert.equal(readFileSync(path, 'utf8'), withdrawn);

  writeFileSync(path, '{}');
  const defaults = (await configurationSource(reloaded).prepare()).config;
  assert.equal(defaults.garage.enabled, false);
  assert.equal(defaults.garage.protection.approved, false);
  assert.deepEqual(defaults.garage.adapter, config.garage.adapter);
});

test('retired private protection is rejected without editing its source', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-protection-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = { defaultsPath: new URL('../config.json', import.meta.url).pathname, privatePath: join(directory, 'fixture.json') };
  for (const versioned of [true, false]) {
    const protection = structuredClone(oldPolicy);
    if (!versioned) delete protection.version;
    const original = JSON.stringify({ garage: { protection } });
    writeFileSync(paths.privatePath, original);
    assert.throws(() => readConfigurationOptions({}, directory, paths), /Unknown|Unsupported|Invalid/);
    assert.equal(readFileSync(paths.privatePath, 'utf8'), original);
  }
});

test('new protection rejects retired knobs and invalid geometry', () => {
  assert.throws(() => validateOptionFields({ garage: { protection: { version: GARAGE_POLICY_VERSION, hardMinimumC: -1 } } }, document.schema), /Unknown configuration/);
  assert.throws(() => garageSettings({ protection: { pipeOutsideDiameterMm: 6, pipeWallMm: 3 } }), /positive water diameter/);
  assert.throws(() => garageSettings({ protection: { version: 'garage-thermal-reserve-v99' } }), /Unsupported/);
});

test('MQTT applies loaded protection configuration and reload withdraws approval only after fresh sender evidence', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const now = 1_800_000_000_000, defaults = garageSettings().protection;
  const senderSettings = { stateTopic: 'fixture/sender/state', commandTopic: 'fixture/sender/command' };
  async function connect(protection, { enabled = true, canControl = () => true, input = 'mqtt' } = {}) {
    const config = { input, garage: { enabled, protection, sender: senderSettings, adapter: isolatedGarageAdapter() },
      connections: { mqtt: { address: 'mqtt://fixture.invalid' } } };
    const engine = { clock: () => now, latest: {}, ingest: () => {} };
    engine.garage = new GarageRuntime({ engine, store, config, clock: engine.clock, canControl });
    const client = new EventEmitter(), publications = [];
    client.subscribe = (_topic, _options, done) => done();
    client.publish = (topic, payload, options, done) => { publications.push({ topic, command: JSON.parse(payload), options }); done(); };
    client.end = (_force, _options, done) => done();
    const reader = await startMqtt({ engine, store, config, canControl, connect: () => client });
    client.emit('connect');
    let sequence = 0;
    const report = (config, { retained = false, observedAt = now } = {}) => client.emit('message', senderSettings.stateTopic,
      Buffer.from(JSON.stringify({ schema: GARAGE_SENDER_CONTRACT, deviceId: 'fixture-sender', bootId: 'fixture-boot',
        sequence: ++sequence, observedAt, challenge: `fixture-challenge-${sequence}`, config,
        protection: { available: false, active: false, minTargetC: null, reason: 'fixture-unknown',
          locations: { rear: { airC: null, estimatedC: null, uncertain: true }, front: { airC: null, estimatedC: null, uncertain: true } } } })),
      { retain: retained });
    return { engine, publications, report, close: () => reader.close({ restore: false }) };
  }
  const approved = { ...defaults, approved: true, marginC: 1.5 };
  const first = await connect(approved);
  try {
    assert.equal(first.publications.length, 0);
    first.report(defaults, { retained: true }); first.report(defaults, { observedAt: now - 180_000 });
    assert.equal(first.publications.length, 0);
    first.report(defaults);
    assert.deepEqual(first.publications[0].command.config, approved);
    assert.equal(first.publications[0].options.retain, false);
    assert.equal(first.engine.garage.status().protection.configuration.status, 'pending');
    first.report(approved);
    assert.equal(first.engine.garage.status().protection.configuration.status, 'confirmed');
  } finally { await first.close(); }
  const reloaded = await connect(defaults);
  try {
    assert.equal(reloaded.publications.length, 0, 'Persisted sender state cannot authorize a startup write');
    assert.equal(reloaded.engine.garage.status().protection.configuration.status, 'unknown');
    reloaded.report(approved);
    assert.deepEqual(reloaded.publications[0].command.config, defaults);
    assert.equal(reloaded.engine.garage.status().protection.settings.approved, true);
    reloaded.report(defaults);
    assert.equal(reloaded.engine.garage.status().protection.settings.approved, false);
    assert.equal(reloaded.engine.garage.status().protection.configuration.status, 'confirmed');
  } finally { await reloaded.close(); }
  for (const options of [{ enabled: false }, { canControl: () => false }, { input: 'offline' }]) {
    const blocked = await connect(approved, options);
    try { blocked.report(defaults); assert.equal(blocked.publications.length, 0); }
    finally { await blocked.close(); }
  }
  const closing = await connect(approved);
  try {
    await closing.engine.garage.close();
    closing.report(defaults);
    assert.equal(closing.publications.length, 0, 'Runtime closure fences automatic configuration before MQTT teardown');
  } finally { await closing.close(); }
});
