import { registerJournalFunctions } from '../src/storage/journal-codec.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { resetRestorationStatus } from '../src/pairing/reset-safety.js';

const ownership = (charger, ocpp = false, association = 'a') =>
  `charging:mqtt:charger${charger}:${association.repeat(64)}:ownership${ocpp ? ':ocpp' : ''}`;
const executorState = extra => ({ version: 2, targetBindings: {
  tariff: { identity: 'a'.repeat(64), generation: 'tariff-generation' },
  dhwr: { identity: 'b'.repeat(64), generation: 'dhwr-generation' },
}, phase: 'normal', legacyOutstanding: false, pulseUntil: 0, expiresAt: null, ...extra });
const nativeState = extra => ({ version: 1, phase: 'normal', baseline: {}, obligations: {}, requested: {}, expiresAt: null, ...extra });
const nativeOverride = () => nativeState({ phase: 'preheat', baseline: { '0203': 20 }, requested: { '0203': 25 },
  obligations: { '0203': { baseline: 20, expected: 25, previousValue: 20,
    originalAt: 1000, requestedAt: 1000, requestedRevision: 1, confirmed: false, restoring: false } }, expiresAt: 2000 });

async function fixture(t, states = [], malformed = []) {
  const root = await mkdtemp('/tmp/stmq-reset-safety-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'history.sqlite'), store = new Store(path);
  for (const [key, value] of states) store.setState(key, value);
  for (const [key, value] of malformed) store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,1)').run(key, value);
  store.close();
  return path;
}

test('empty current history has no restoration duty and the read-only inspection preserves database bytes', async t => {
  const path = await fixture(t);
  const before = await readFile(path);
  assert.equal(resetRestorationStatus(path), 'clear');
  assert.deepEqual(await readFile(path), before);
  assert.equal(resetRestorationStatus(null), 'clear');
  assert.equal(resetRestorationStatus(`${path}.missing`), 'unknown');
  await assert.rejects(readFile(`${path}.missing`), { code: 'ENOENT' });
});

test('each current Home heating obligation prevents a fresh reset', async t => {
  const baseline = { phase: 'normal', expiresAt: null, legacyOutstanding: false, at: 1000 };
  for (const [key, patch] of [
    ['legacyOutstanding', { legacyOutstanding: true }], ['dhwrOutstanding', { dhwrOutstanding: true }],
    ['manualPause', { manualBaseline: baseline, manualPause: { id: 'fixture-pause', expiresAt: null } }],
    ['manualTemporary', { manualBaseline: baseline, manualTemporary: { expiresAt: 2000 } }],
    ['manualBaseline', { manualBaseline: baseline, manualTemporary: { expiresAt: 2000 } }],
    ['manualRequested', { manualBaseline: baseline, manualTemporary: { expiresAt: 2000 },
      manualRequested: { phase: 'preheat', at: 1000, expiresAt: 2000, floorOwner: 'fixture-lease', roomBoostC: 5, confirmed: false } }],
  ]) await t.test(key, async t => {
    const path = await fixture(t, [['executor:home', executorState(patch)]]);
    assert.equal(resetRestorationStatus(path), 'pending');
  });
});

test('native pump overrides, manual equipment tests, and floor leases remain physical obligations', async t => {
  const cases = [
    ['native setting', 'h66:control:fixture-pump', nativeOverride()],
    ['native manual mode', 'h66:control:fixture-pump', nativeState({ manualMode: 'reduction' })],
    ['equipment test', 'equipment-tests:v1', { version: 1, active: { status: 'restoration-pending' } }],
    ['floor lease', 'floor-override:v1', { version: 1, outstanding: { owner: 'fixture-lease' } }],
  ];
  for (const [name, key, value] of cases) await t.test(name, async t => {
    const path = await fixture(t, [[key, value]]);
    assert.equal(resetRestorationStatus(path), 'pending');
  });
});

test('resolved current control records and ordinary charging ownership do not count as restoration leases', async t => {
  const path = await fixture(t, [
    ['executor:home', executorState({ legacyOutstanding: false, dhwrOutstanding: false,
      manualPause: null, manualTemporary: null, manualBaseline: null, manualRequested: null })],
    ['h66:control:fixture-pump', nativeState({ baseline: { '0203': 20 } })],
    ['equipment-tests:v1', { version: 1, active: null }],
    ['floor-override:v1', { version: 1, outstanding: null }],
    [ownership(1), { version: 5, owned: { planId: 'fixture-plan' }, pending: { stage: 'scheduling' },
      takeoverPending: { stage: 'schedule-disable' } }],
    [ownership(2), { version: 1, ownedPause: true, owned: null, pending: { role: 'current_limit', value: 6 } }],
    [ownership(2, true), { version: 2, kind: 'ocpp-tx-pause', owned: { profileId: 17 }, pending: { profileId: 18 } }],
  ]);
  assert.equal(resetRestorationStatus(path), 'clear');
});

test('charger identification ownership and uncertain identification writes cannot be discarded', async t => {
  const cases = [
    ['Easee owned', ownership(1), { version: 5, owned: { purpose: 'identification' } }],
    ['Easee pending', ownership(1), { version: 5, pending: { purpose: 'identification' } }],
    ['Shelly owned', ownership(2), { version: 1, owned: { purpose: 'identification' } }],
    ['Shelly pending', ownership(2), { version: 1, pending: { owned: { purpose: 'identification' } } }],
    ['OCPP owned', ownership(2, true), { version: 2, owned: { purpose: 'identification' } }],
    ['OCPP pending', ownership(2, true), { version: 2, pending: { purpose: 'identification' } }],
  ];
  for (const [name, key, value] of cases) await t.test(name, async t => {
    const path = await fixture(t, [[key, value]]);
    assert.equal(resetRestorationStatus(path), 'pending');
  });
});

test('malformed earlier records cannot hide independent known restoration duties', async t => {
  const cases = [
    ['executor JSON before equipment', ['executor:home', '{invalid'],
      ['equipment-tests:v1', { version: 1, active: {} }]],
    ['executor JSON before native settings', ['executor:home', 'null invalid'],
      ['h66:control:fixture-pump', nativeOverride()]],
    ['native JSON before equipment', ['h66:control:fixture-pump', '{invalid'],
      ['equipment-tests:v1', { version: 1, active: {} }]],
    ['malformed native obligation before equipment', ['h66:control:fixture-pump', JSON.stringify(nativeState({ obligations: { '0203': {} } }))],
      ['equipment-tests:v1', { version: 1, active: {} }]],
    ['equipment JSON before floor', ['equipment-tests:v1', '{invalid'],
      ['floor-override:v1', { version: 1, outstanding: {} }]],
    ['ownership JSON before floor', [ownership(1), '{invalid'],
      ['floor-override:v1', { version: 1, outstanding: {} }]],
  ];
  for (const [name, malformed, pending] of cases) await t.test(name, async t => {
    const path = await fixture(t, [pending], [malformed]);
    const before = await readFile(path);
    if (malformed[0] === 'executor:home' || malformed[0].startsWith('h66:control:'))
      for (const readOnly of [false, true]) assert.throws(() => new Store(path, { readOnly }), /Unreadable heating control state|Unsupported native-setting state/);
    assert.equal(resetRestorationStatus(path), 'pending');
    assert.deepEqual(await readFile(path), before, 'Inspection cannot change rejected state or independent duties');
  });
  const path = await fixture(t, [
    ['executor:home', { version: 0, legacyOutstanding: true }],
    ['h66:control:fixture-pump', { version: 99, obligations: {} }],
    ['equipment-tests:v1', { version: 1, active: { status: 'active' } }],
  ]);
  assert.equal(resetRestorationStatus(path), 'pending');
});

test('unreadable and unsupported current-state records remain unknown when no independent pending duty is known', async t => {
  const cases = [
    ['executor:home', { version: 1, legacyOutstanding: true }],
    ['executor:home', executorState({ manualBaseline: { phase: 'reduction', expiresAt: 2000, legacyOutstanding: true } })],
    ['h66:control:fixture-pump', { version: 0, obligations: { '0203': {} } }],
    ['h66:control:fixture-pump', nativeState({ phase: 'manual-pause' })],
    ['h66:control:fixture-pump', { version: 1, obligations: null }],
    ['h66:control:fixture-pump', nativeState({ obligations: { '0203': {} } })],
    ['h66:control:fixture-pump', nativeState({ obligations: { '0203': null } })],
    ['h66:control:fixture-pump', nativeState({ requested: null })],
    ['equipment-tests:v1', { version: 0, active: {} }],
    ['floor-override:v1', { version: 0, outstanding: {} }],
    [ownership(1), { version: 4, owned: { purpose: 'identification' } }],
    [ownership(2), { version: 0, owned: { purpose: 'identification' } }],
    [ownership(2, true), { version: 1, owned: { purpose: 'identification' } }],
  ];
  for (const [index, state] of cases.entries()) await t.test(`unsupported current record ${index + 1}`, async t => {
    const path = await fixture(t, [state]);
    assert.equal(resetRestorationStatus(path), 'unknown');
  });
  for (const key of ['executor:home', 'h66:control:fixture-pump', 'equipment-tests:v1', ownership(1), 'floor-override:v1']) {
    const path = await fixture(t, [], [[key, '{invalid']]);
    assert.equal(resetRestorationStatus(path), 'unknown');
  }
});

test('old schemas remain opaque even if their rows resemble current obligations', async t => {
  const path = await fixture(t, [['equipment-tests:v1', { version: 1, active: {} }]]);
  const db = new DatabaseSync(path); registerJournalFunctions(db);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`);
  db.close();
  const before = await readFile(path);
  assert.equal(resetRestorationStatus(path), 'unknown', 'do not decode old database rows for a reset');
  assert.deepEqual(await readFile(path), before);
});

test('a malformed current schema is not reinterpreted as an empty history', async t => {
  const path = await fixture(t);
  const db = new DatabaseSync(path); registerJournalFunctions(db);
  db.exec('DROP TABLE state'); db.close();
  const before = await readFile(path);
  assert.equal(resetRestorationStatus(path), 'unknown');
  assert.deepEqual(await readFile(path), before);
});

test('an unsupported learning algorithm keeps reset inventory opaque despite a current schema', async t => {
  const path = await fixture(t, [['equipment-tests:v1', { version: 1, active: {} }]]);
  const db = new DatabaseSync(path); registerJournalFunctions(db);
  db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload)
    VALUES('original','mqtt','old-entry','context',1,'committed-house-v15-continuous-comfort','{}')`).run();
  db.close();
  const before = await readFile(path);
  assert.equal(resetRestorationStatus(path), 'unknown');
  assert.deepEqual(await readFile(path), before);
});
