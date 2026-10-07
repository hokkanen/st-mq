import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';

const executor = { version: 2, targetBindings: {
  tariff: { identity: 'a'.repeat(64), generation: 'tariff-generation' }, dhwr: { identity: 'b'.repeat(64), generation: 'dhwr-generation' } },
  phase: 'reduction', expiresAt: 1_800_000_000_000, pulseUntil: 1_800_000_000_000,
  legacyOutstanding: true, dhwrOutstanding: true,
  manualPause: { id: 'current-synthetic-pause', expiresAt: 1_800_000_000_000 },
  manualBaseline: { phase: 'normal', expiresAt: null, legacyOutstanding: false, at: 1_799_999_000_000 } };
const native = { version: 1, phase: 'preheat', baseline: { '0203': 20 },
  obligations: { '0203': { baseline: 20, expected: 25, previousValue: 20,
    originalAt: 1_799_999_000_000, requestedAt: 1_799_999_000_000, requestedRevision: 1,
    confirmed: false, restoring: false } },
  requested: { '0203': 25 }, expiresAt: 1_800_000_000_000 };

function database(t, key, encoded) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-heating-state-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.sqlite');
  const store = new Store(path); store.close();
  if (key) {
    const raw = new DatabaseSync(path);
    raw.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run(key, encoded, 123);
    raw.close();
  }
  return { directory, path };
}

test('unreadable heating obligations reject both database opens before database mutation', t => {
  for (const key of ['executor:home', 'executor:simulated', 'h66:control:synthetic-device']) {
    const fixture = database(t, key, '{unreadable-private-payload');
    const bytes = readFileSync(fixture.path);
    for (const readOnly of [false, true]) {
      assert.throws(() => new Store(fixture.path, { readOnly }), error =>
        error.code === 'HEATING_CONTROL_STATE_UNREADABLE'
        && /existing database was not changed/.test(error.message)
        && !error.message.includes(key) && !error.message.includes('private-payload'));
      assert.deepEqual(readFileSync(fixture.path), bytes);
    }
  }
});

test('retired Home control formats and malformed ownership maps reject before writable setup', t => {
  const cases = [
    ['executor:home', { ...executor, version: 1 }],
    ['executor:home', { ...executor, targetBindings: {} }],
    ...['phase', 'expiresAt', 'legacyOutstanding'].map(field => ['executor:home', { ...executor,
      manualBaseline: { ...executor.manualBaseline, [field]: { phase: 'reduction', expiresAt: 1_800_000_000_000, legacyOutstanding: true }[field] } }]),
    ['h66:control:synthetic-device', { ...native, version: 0 }],
    ...['manual-pause', 'manual-temporary'].map(phase => ['h66:control:synthetic-device', { ...native, phase }]),
    ...[false, 1, 'invalid', []].flatMap(value => [
      ['executor:home', value], ['h66:control:synthetic-device', value],
      ['executor:home', { ...executor, targetBindings: value }],
      ['h66:control:synthetic-device', { ...native, baseline: value }],
      ['h66:control:synthetic-device', { ...native, obligations: value }],
    ]),
    ['executor:home', { ...executor, targetBindings: null }],
    ['executor:home', { ...executor, manualPause: { id: 'current-synthetic-pause', expiresAt: '1800000000000' } }],
    ['executor:home', { ...executor, dhwrOutstanding: 'false' }],
    ['executor:home', { ...executor, pulseUntil: '1800000000000' }],
    ['executor:home', { ...executor, manualRequested: { phase: 'reduction', at: 1_799_999_000_000,
      expiresAt: null, confirmed: 'false', roomBoostC: 0 } }],
    ['executor:home', { ...executor, legacyOutstanding: false, targetBindings: {}, dhwrOutstanding: false,
      manualRequested: { phase: 'reduction', at: 1_799_999_000_000, expiresAt: null, confirmed: true, roomBoostC: 0 } }],
    ['h66:control:synthetic-device', { ...native, baseline: null }],
    ['h66:control:synthetic-device', { ...native, obligations: null }],
    ['h66:control:synthetic-device', { ...native, requested: null }],
    ['h66:control:synthetic-device', { ...native, requested: { '0203': 24 } }],
    ['h66:control:synthetic-device', { ...native, baseline: { '0203': 19 } }],
    ['h66:control:synthetic-device', { ...native, baseline: { '0203': 50 } }],
    ['h66:control:synthetic-device', { ...native, requested: { '2201': 1.5 } }],
    ['h66:control:synthetic-device', { ...native, obligations: { '0203': null } }],
    ['h66:control:synthetic-device', { ...native, obligations: { '0203': {} } }],
    ['h66:control:synthetic-device', { ...native, obligations: { 'retired-register': native.obligations['0203'] } }],
    ...['requested', 'expiresAt'].map(key => ['h66:control:synthetic-device',
      Object.fromEntries(Object.entries(native).filter(([field]) => field !== key))]),
    ...Object.keys(native.obligations['0203']).map(key => ['h66:control:synthetic-device', { ...native,
      obligations: { '0203': Object.fromEntries(Object.entries(native.obligations['0203']).filter(([field]) => field !== key)) } }]),
    ...[{ expected: '25' }, { previousValue: null }, { confirmed: true }, { confirmed: 1 }, { restoring: 'false' },
      { requestedRevision: 1.5 }, { requestedRevision: -2 }, { requestedAt: null }, { originalAt: null },
      { confirmedAt: 'yesterday' }].map(patch => ['h66:control:synthetic-device', { ...native,
      obligations: { '0203': { ...native.obligations['0203'], ...patch } } }]),
  ];
  for (const [key, value] of cases) {
    const { path } = database(t, key, JSON.stringify(value)), before = readFileSync(path);
    for (const readOnly of [false, true]) {
      assert.throws(() => new Store(path, { readOnly }), error =>
        error.code === (key.startsWith('executor:') ? 'EXECUTOR_STATE_UNSUPPORTED' : 'H66_STATE_UNSUPPORTED')
        && /existing database was not changed/.test(error.message));
      assert.deepEqual(readFileSync(path), before);
    }
  }
});

test('absent and current same-version Home obligations remain readable without translation', t => {
  const { path } = database(t);
  let store = new Store(path);
  assert.equal(store.getState('executor:home'), null);
  assert.equal(store.getState('h66:control:synthetic-device'), null);
  store.setState('executor:home', executor);
  store.setState('executor:simulated', { version: 2, targetBindings: {}, phase: 'normal', legacyOutstanding: false,
    pulseUntil: 0, expiresAt: null });
  store.setState('h66:control:synthetic-device', native);
  store.setState('h66:control:absent-device', null);
  store.close();
  for (const readOnly of [true, false]) {
    store = new Store(path, { readOnly });
    assert.deepEqual(store.getState('executor:home'), executor);
    assert.deepEqual(store.getState('h66:control:synthetic-device'), native);
    assert.equal(store.getState('h66:control:absent-device'), null);
    store.close();
  }
});
