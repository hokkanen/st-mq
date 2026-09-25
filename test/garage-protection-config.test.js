import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigurationOptions, validateOptionFields } from '../src/app/configuration-source.js';
import { configurationSource, loadConfig } from '../src/app/config.js';
import { garageSettings, GARAGE_POLICY_VERSION } from '../src/garage/settings.js';
import { createGarageModel } from '../src/garage/model.js';
import { applyGarageEntry, garageDigest } from '../src/garage/learning.js';

const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const oldPolicy = { approved: true, version: 'garage-exposure-v2', floorC: 2, hardMinimumC: -1,
  budgetDegreeMinutes: 90, recoveryAboveC: 4, recoveryDwellMinutes: 20, recoveryDegreeMinutesPerMinute: 1 };

test('Garage room intent has no duplicate configured baseline', () => {
  assert.equal(Object.hasOwn(document.options.garage, 'baselineC'), false);
  assert.equal(Object.hasOwn(document.schema.garage, 'baselineC'), false);
  assert.equal(Object.hasOwn(garageSettings(), 'baselineC'), false);
  assert.throws(() => garageSettings({ baselineC: 10 }), /Unknown garage setting: baselineC/);
  assert.throws(() => validateOptionFields({ garage: { baselineC: 10 } }, document.schema), /baselineC/);
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
