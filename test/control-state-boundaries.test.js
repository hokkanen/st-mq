import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { verifyDatabase } from '../src/storage/full-verifier.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { Executor } from '../src/app/executor.js';
import { createH66Controller } from '../src/control/h66.js';
import { createEquipmentTests } from '../src/app/equipment-tests.js';

const at = 1_800_000_000_000;
const executor = { version: 2, targetBindings: {}, phase: 'normal', legacyOutstanding: false, pulseUntil: 0, expiresAt: null };
const native = { version: 1, phase: 'normal', baseline: {}, obligations: {}, requested: {}, expiresAt: null };
const active = { deviceId: 'synthetic-switch', signature: 'a'.repeat(64), on: true, previousOn: false,
  requestedAt: at, until: at + 60_000, status: 'starting' };
const equipment = { version: 1, active, lastResult: null };
const preheat = { enabled: true, confirmed: true, baseValue: 20, roomSettingC: 25, roomBoostC: 5,
  expiresAt: at + 60_000, pauseId: null, at };
const recovery = { compressorOnly: true, temperatureValidUntil: at + 60_000, externalChangeRevision: 0 };
const cases = [
  ['executor:home', 'EXECUTOR_STATE_UNSUPPORTED', executor, [
    { unexpected: true }, { phase: 'retired-phase' },
    ...['acknowledgedAt', 'manualDhwrUntil', 'dhwrStoppedAt', 'recoveryStartedAt', 'recoveryHoldUntil', 'recoveryAuxReleasedAt']
      .flatMap(key => [false, '', [], {}, '1800000000000'].map(value => ({ [key]: value }))),
    ...[false, 0, '', [], {}, { commands: [], at }, { commands: ['retired-command'], at },
      { commands: ['normal'], at: null }, { commands: ['normal'], at, translated: true }].map(requested => ({ requested })),
    ...[{ on: 'false', at }, { on: false, at: 'today' }, { on: true, at, translated: true }].map(dhwrRequested => ({ dhwrRequested })),
    ...[{ mode: 'recovery', at }, { mode: 'normal', at: null }, { mode: 'normal', at, translated: true }].map(tariffRequested => ({ tariffRequested })),
    ...[false, [], {}, { ...recovery, owner: 1 }, { ...recovery, owner: '' }, { ...recovery, compressorOnly: 'false' },
      { ...recovery, temperatureValidUntil: null }, { ...recovery, temperatureValidUntil: '1800000000000' },
      { ...recovery, externalChangeRevision: -1 }, { ...recovery, externalChangeRevision: 0.5 },
      { ...recovery, externalChangeRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...recovery, translated: true }]
      .map(recoveryOnExpiry => ({ recoveryOnExpiry })),
    { recoveryOwner: false }, { recoveryOwner: '' }, { recoveryFallbackReason: 0 },
  ]],
  ['h66:control:synthetic-device', 'H66_STATE_UNSUPPORTED', native, [
    { unexpected: true }, { phase: 'retired-phase' }, { phase: null },
    ...[false, '', [], {}, '1800000000000'].map(expiresAt => ({ expiresAt })),
    ...[false, 0, '', [], {}, 'normal', 'manual-pause'].map(manualMode => ({ manualMode })),
    ...[false, 0, '', [], {}].map(pauseId => ({ manualMode: 'reduction', pauseId })),
    ...[false, [], {}, { ...preheat, enabled: 'true' }, { ...preheat, confirmed: false }, { ...preheat, baseValue: null },
      { ...preheat, roomSettingC: 26 }, { ...preheat, roomBoostC: -1 }, { ...preheat, roomBoostC: 6 },
      { ...preheat, expiresAt: null }, { ...preheat, expiresAt: '1800000000000' },
      { ...preheat, pauseId: false }, { ...preheat, at: null }, { ...preheat, translated: true }].map(manualPreheat => ({ manualPreheat })),
    ...[-1, 0.5, false, null, Number.MAX_SAFE_INTEGER + 1].map(externalChangeRevision => ({ externalChangeRevision })),
    { externalChangeAt: '1800000000000' },
  ]],
  ['equipment-tests:v1', 'EQUIPMENT_TEST_STATE_UNSUPPORTED', equipment, [
    { unexpected: true }, { version: 0 },
    ...[false, 0, '', [], {}, { ...active, unexpected: true }, { ...active, deviceId: '' },
      { ...active, signature: 'wrong' }, { ...active, on: 1 }, { ...active, previousOn: 'false' },
      { ...active, requestedAt: null }, { ...active, until: '1800000000000' }, { ...active, until: -1 },
      { ...active, until: 1.5 }, { ...active, status: 'active' }, { ...active, confirmedAt: null },
      { ...active, status: 'retired-status' }].map(active => ({ active })),
    { lastResult: [] }, { lastManual: false },
  ]],
];
const missing = (state, key) => Object.fromEntries(Object.entries(state).filter(([field]) => field !== key));

function openOwner(key, saved, effect) {
  const store = { getState: () => saved, setState: effect, runWrite: async operation => operation() };
  if (key === 'executor:home') return new Executor({ input: 'mqtt', store, commandTransport: { publish: effect, publishDhwr: effect } });
  if (key.startsWith('h66:')) return createH66Controller({ deviceId: 'synthetic-device', store, publish: effect, requestSnapshot: effect });
  return createEquipmentTests({ store, canControl: () => true, getEquipment: effect });
}

test('malformed current authority fields reject before startup mutation or any owner command', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-control-state-boundaries-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let count = 0;
  for (const [key, code, base, patches] of cases) {
    const states = patches.map(patch => ({ ...base, ...patch }));
    states.push(missing(base, key === 'equipment-tests:v1' ? 'active' : 'expiresAt'));
    for (const saved of states) {
      const original = structuredClone(saved), path = join(directory, `${count++}.sqlite`);
      const store = new Store(path); store.setState(key, saved);
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); store.close();
      const before = readFileSync(path);
      for (const readOnly of [false, true]) {
        assert.throws(() => new Store(path, { readOnly }), { code }, JSON.stringify({ key, saved }));
        assert.deepEqual(readFileSync(path), before);
        assert.equal(existsSync(`${path}-wal`), false);
        assert.equal(existsSync(`${path}-shm`), false);
      }
      let effects = 0;
      assert.throws(() => openOwner(key, saved, () => { effects++; }), { code });
      assert.equal(effects, 0);
      assert.deepEqual(saved, original);
    }
  }
  t.diagnostic(`${count} malformed current saved states rejected at writable/read-only startup and control-owner construction`);
});

test('current interrupted states and optional scopes reopen exactly without restoration-duty translation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-control-current-states-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const states = [
    ['executor:home', { ...executor, requested: { commands: ['normal'], at }, acknowledgedAt: null,
      recoveryOnExpiry: recovery, recoveryOwner: null, recoveryStartedAt: at, recoveryHoldUntil: at + 60_000,
      recoveryAuxReleasedAt: null, recoveryFallbackReason: null }],
    ['executor:home', { ...executor, manualBaseline: { phase: 'normal', expiresAt: null, legacyOutstanding: false, at },
      manualPause: { id: 'synthetic-pause', expiresAt: null }, manualTemporary: null, manualRequested: null }],
    ...['normal', 'recovery', 'preheat', 'reduction', 'test', 'restoration-pending', 'external-change']
      .map(phase => ['h66:control:synthetic-device', { ...native, phase, baseline: { '0203': 20 }, requested: { '0203': 20 } }]),
    ...['preheat', 'reduction', 'recovery'].map(manualMode => ['h66:control:synthetic-device', {
      ...native, phase: 'restoration-pending', manualMode, pauseId: 'synthetic-pause', expiresAt: at + 60_000,
      ...(manualMode === 'preheat' ? { manualPreheat: preheat } : {}), externalChangeRevision: 2, externalChangeAt: at }]),
    ...['starting', 'restoration-pending'].map(status => ['equipment-tests:v1', { ...equipment, active: { ...active, status } }]),
    ['equipment-tests:v1', { ...equipment, active: { ...active, status: 'active', confirmedAt: at } }],
    ['equipment-tests:v1', { ...equipment, active: null, lastManual: { deviceId: 'synthetic-switch', on: true,
      previousOn: false, at, status: 'pending', confirmed: false } }],
  ];
  for (const [index, [key, saved]] of states.entries()) {
    const path = join(directory, `${index}.sqlite`);
    let store = new Store(path); store.setState(key, saved); store.close();
    for (const readOnly of [true, false]) {
      store = new Store(path, { readOnly }); assert.deepEqual(store.getState(key), saved); store.close();
    }
  }
});

test('equipment state rejection reaches full verification and backup while preserving source and destination', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-equipment-state-verification-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.sqlite'), destination = join(directory, 'backup.sqlite');
  const store = new Store(path); store.setState('equipment-tests:v1', { version: 1, active: false }); store.close();
  const before = readFileSync(path);
  await assert.rejects(verifyDatabase({ dbPath: path }), { code: 'database_state_incompatible' });
  await assert.rejects(createDatabaseBackup({ sourcePath: path, destination }), { code: 'backup_source_incompatible' });
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readFileSync(path), before);
});
