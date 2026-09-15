import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigurationOptions, validateOptionFields } from '../src/app/configuration-source.js';
import { garageSettings, GARAGE_POLICY_VERSION } from '../src/garage/settings.js';
import { createGarageModel } from '../src/garage/model.js';
import { applyGarageEntry, garageDigest } from '../src/garage/learning.js';

const document = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const oldPolicy = { approved: true, version: 'garage-exposure-v2', floorC: 2, hardMinimumC: -1,
  budgetDegreeMinutes: 90, recoveryAboveC: 4, recoveryDwellMinutes: 20, recoveryDegreeMinutesPerMinute: 1 };

test('legacy private protection is normalized before new defaults are merged, without editing its source', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-protection-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const paths = { defaultsPath: new URL('../config.json', import.meta.url).pathname, privatePath: join(directory, 'fixture.json') };
  for (const versioned of [true, false]) {
    const protection = structuredClone(oldPolicy);
    if (!versioned) delete protection.version;
    const original = JSON.stringify({ garage: { enabled: true, aggressiveness: 75, protection } });
    writeFileSync(paths.privatePath, original);
    const { options } = readConfigurationOptions({}, directory, paths);
    assert.equal(options.garage.enabled, true);
    assert.equal(options.garage.aggressiveness, 75);
    assert.equal(options.garage.protection.version, GARAGE_POLICY_VERSION);
    assert.equal(options.garage.protection.approved, false);
    assert.equal(options.garage.protection.marginC, 1);
    assert.equal('budgetDegreeMinutes' in options.garage.protection, false);
    assert.equal(readFileSync(paths.privatePath, 'utf8'), original);
    assert.doesNotThrow(() => validateOptionFields(options, document.schema));
  }
});

test('old committed settings retain their original digest and produce the same learned state', () => {
  const current = garageSettings(), old = { ...current, protection: oldPolicy };
  const seed = createGarageModel({ seedAt: 1_800_000_000_000 });
  let legacyCheckpoint = null, currentCheckpoint = null;
  const oldBefore = structuredClone(old);
  for (let i = 0; i < 80; i++) {
    const at = seed.seedAt + i * 60_000;
    const value = { at, rearAt: at, frontAt: at, rearC: 7 - i / 100, frontC: 6.5 - i / 100,
      outdoorC: -5, available: false };
    const entry = settings => ({ id: i + 1, at, kind: 'sample', algorithmVersion: seed.algorithm,
      configVersion: garageDigest(settings), payload: { settings, value, ...(i === 0 ? { seed } : {}) } });
    legacyCheckpoint = applyGarageEntry(legacyCheckpoint, entry(old));
    currentCheckpoint = applyGarageEntry(currentCheckpoint, entry(current));
  }
  assert.deepEqual(legacyCheckpoint.model, currentCheckpoint.model);
  assert.equal(legacyCheckpoint.configVersion, garageDigest(oldBefore));
  assert.deepEqual(old, oldBefore);
});

test('new protection rejects retired knobs and invalid geometry', () => {
  assert.throws(() => validateOptionFields({ garage: { protection: { version: GARAGE_POLICY_VERSION, hardMinimumC: -1 } } }, document.schema), /Unknown configuration/);
  assert.throws(() => garageSettings({ protection: { pipeOutsideDiameterMm: 6, pipeWallMm: 3 } }), /positive water diameter/);
  assert.throws(() => garageSettings({ protection: { version: 'garage-thermal-reserve-v99' } }), /Unsupported/);
});
