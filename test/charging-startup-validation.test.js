import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store, validateCurrentDatabase } from '../src/storage/store.js';
import { verifySnapshot } from '../src/pairing/snapshots.js';
import { initialOcppControllerState } from '../src/charging/ocpp.js';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const association = 'a'.repeat(64);
const withCharger = previous => ({ version: 6, chargers: { charger1: { association, ...previous } } });
const cases = [
  ['retired runtime', 'charging:simulated', { version: 5 }],
  ['unknown runtime field', 'charging:simulated', { version: 6, settings: {} }],
  ['invalid runtime type', 'charging:simulated', []],
  ['unreadable runtime', 'charging:simulated', '{private synthetic payload', true],
  ['shared controls', 'charging:simulated', { version: 6, controls: { association, priority: 'retired', revision: 1 } }],
  ['charger controls', 'charging:simulated', withCharger({ controls: { enabled: 'yes', revision: 1 } })],
  ['unknown charger field', 'charging:simulated', withCharger({ automaticAllowed: true })],
  ['invalid vehicle evidence', 'charging:simulated', withCharger({ vehicleEvidence: false })],
  ['unknown vehicle evidence field', 'charging:simulated', withCharger({ vehicleEvidence: {
    scope: `${association}:1000`, chargingTimes: [], stoppedTimes: [], previousIdentity: 'tesla' } })],
  ['unordered physical evidence', 'charging:simulated', withCharger({ vehicleEvidence: {
    scope: `${association}:1000`, chargingTimes: [2000, 1000], stoppedTimes: [] } })],
  ['invalid vehicle identity', 'charging:simulated', withCharger({ vehicleMatch: { id: 'tesla' } })],
  ['invalid vehicle conflict', 'charging:simulated', withCharger({ vehicleConflict: { ids: 'tesla' } })],
  ['unknown vehicle feed', 'charging:simulated', { version: 6, vehicleFeeds: { retired: {} } }],
  ['unknown vehicle feed field', 'charging:simulated', { version: 6, vehicleFeeds: { bmw: { lastIdentity: 'tesla' } } }],
  ['session scope', 'charging:simulated', withCharger({ request: { scope: 'old-device:1000', sessionId: 'old-device:1000', revision: 1, deadlineAt: 2000, overrides: {} } })],
  ['session override', 'charging:simulated', withCharger({ request: { scope: `${association}:1000`, sessionId: `${association}:1000`, revision: 1, deadlineAt: 2000, overrides: { enabled: true } } })],
  ['consumed evidence', 'charging:simulated', { version: 6, consumedTeslaCurrent: { association, receivedAt: -1 } }],
  ['identification', 'charging:simulated', withCharger({ identification: { version: -1 } })],
  ['identification evidence', 'charging:simulated', withCharger({ vehicleEvidence: { teslaCurrentCandidate: {} } })],
  ['target state', 'charging:simulated', withCharger({ targetState: { version: -1 } })],
  ['retired progress', 'charging:simulated', withCharger({ progress: { version: 1, reference: { key: 'old' } } })],
  ['invalid battery reference', 'charging:simulated', withCharger({ progress: { version: 2, reference: { key: 'current' },
    batteryInputs: { scope: 'tesla:synthetic-session', minimumSoc: { value: 101, source: 'teslamate', measuredAt: null, receivedAt: 1000 } } } })],
  ['diagnostic state', 'charging:simulated:session-diagnostics', { version: 2, chargers: {} }],
  ['missing active diagnostic report', 'charging:simulated:session-diagnostics', { version: 3, chargers: { charger1: { association, closedThrough: null, currentId: 'b'.repeat(64) } } }],
  ['physical test state', 'charging:simulated:physical-tests', { version: 2, runs: [] }],
  ['Easee ownership', `charging:simulated:charger1:${association}:ownership`, { version: 4 }],
  ['unknown Easee ownership field', `charging:simulated:charger1:${association}:ownership`, { version: 5, authority: true }],
  ['invalid Easee owned restriction', `charging:simulated:charger1:${association}:ownership`, { version: 5, owned: false }],
  ['invalid Easee pending restriction', `charging:simulated:charger1:${association}:ownership`, { version: 5, pending: false }],
  ['incomplete Easee manual instruction', `charging:simulated:charger1:${association}:ownership`, { version: 5,
    manual: { kind: 'stop', detectedAt: 1000, reason: 'synthetic', fingerprint: association, activeFingerprint: association } }],
  ['invalid Easee execution periods', `charging:simulated:charger1:${association}:ownership`, { version: 5,
    execution: { planId: 'synthetic', periods: [{ startAt: 2000, endAt: 1000 }], finalStartAt: 2000, deadlineAt: 3000 } }],
  ['Shelly ownership', `charging:simulated:charger2:${association}:ownership`, { version: 1, association, automaticPermission: { value: 'yes', measuredAt: 1 } }],
  ['OCPP ownership', `charging:simulated:charger1:${association}:ownership:ocpp`, { ...initialOcppControllerState(association), session: { connected: true } }],
  ['Shelly acquisition', `charging:shelly:${association}`, { version: 2, association, fields: {}, permissionSequence: -1 }],
  ['inactive input and equipment', 'charging:providers', withCharger({ request: { scope: 'old' } })],
];

test('actual startup and read-only preflight reject all saved charging readers before any database mutation', async t => {
  for (const [name, key, value, raw = false] of cases) await t.test(name, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-startup-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
    const fixtureStore = new Store(config.dbPath);
    fixtureStore.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run(key, raw ? value : JSON.stringify(value), 1000);
    fixtureStore.db.exec('PRAGMA journal_mode=DELETE');
    fixtureStore.close();
    const before = readFileSync(config.dbPath);
    let acquisitions = 0;
    await assert.rejects(start({ config, installSignalHandlers: false,
      mqttOptions: { connect() { acquisitions++; throw new Error('Unexpected acquisition'); } } }),
    { code: 'database_state_incompatible' });
    assert.equal(acquisitions, 0);
    assert.deepEqual(readFileSync(config.dbPath), before, 'startup preserves exact rejected database bytes');
    assert.equal(existsSync(`${config.dbPath}-wal`), false, 'rejection precedes writable journal setup');
    assert.throws(() => new Store(config.dbPath, { readOnly: true }), { code: 'database_state_incompatible' });
    const check = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      assert.throws(() => validateCurrentDatabase(check), { code: 'database_state_incompatible' });
      assert.equal(check.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'garage:configuration:%'").get().n, 0,
        'the formerly observed partial Garage configuration write never occurs');
      assert.equal(check.prepare('SELECT count(*) n FROM events').get().n, 0);
    } finally { check.close(); }
    assert.deepEqual(readFileSync(config.dbPath), before);
  });
});

test('receiver snapshot validation detects unsupported charging state before handover can stop a master', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.sqlite');
  const store = new Store(path);
  store.setState('charging:providers', withCharger({ controls: { enabled: 'unsupported', revision: 0 } }));
  store.close();
  const before = readFileSync(path);
  await assert.rejects(verifySnapshot(path, {}), { code: 'database_state_incompatible' });
  assert.deepEqual(readFileSync(path), before);
});

test('failed startup preserves committed WAL bytes left by an interrupted process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-wal-startup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  new Store(config.dbPath).close();
  // Deliberately bypass normal close in an isolated child to leave committed WAL
  // evidence, exactly as an interrupted application can leave it on disk.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { Store } from ${JSON.stringify(new URL('../src/storage/store.js', import.meta.url).href)};
    const store = new Store(process.argv[1]);
    store.db.exec('PRAGMA wal_autocheckpoint=0');
    store.setState('charging:simulated', {version:5});
    process.exit(0);
  `, config.dbPath], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const before = Object.fromEntries(['', '-wal', '-shm'].map(suffix => [suffix, readFileSync(`${config.dbPath}${suffix}`)]));
  assert(before['-wal'].length > 0);
  await assert.rejects(start({ config, installSignalHandlers: false }), { code: 'database_state_incompatible' });
  assert.deepEqual(readFileSync(config.dbPath), before[''], 'rejection must not checkpoint WAL into the main file');
  assert.deepEqual(readFileSync(`${config.dbPath}-wal`), before['-wal'], 'committed WAL remains intact');
  assert.equal(existsSync(`${config.dbPath}-shm`), true, 'rejection does not delete SQLite companions');
});

test('current valid restrictions and missing optional state survive writable and read-only restarts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-current-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.sqlite'), store = new Store(path);
  const saved = withCharger({ controls: { enabled: false, revision: 3 },
    request: { scope: `${association}:1000`, sessionId: `${association}:1000`, revision: 1,
      deadlineAt: 2000, overrides: { readyBy: '06:00' } } });
  const ownership = initialOcppControllerState(association);
  ownership.manual = { id: 'observed-stop', kind: 'stop', at: 1500, transactionId: null, resumeAt: null, cycleEndsAt: 2000 };
  const key = `charging:simulated:charger1:${association}:ownership:ocpp`;
  store.setState('charging:simulated', saved); store.setState(key, ownership); store.close();
  for (const readOnly of [true, false]) {
    const restarted = new Store(path, { readOnly });
    try { assert.deepEqual(restarted.getState('charging:simulated'), saved); assert.deepEqual(restarted.getState(key), ownership); }
    finally { restarted.close(); }
  }
});

test('worker startup accepts a live database while concurrent recording advances its WAL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-live-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.sqlite'), store = new Store(path);
  const boundary = new SharedArrayBuffer(4);
  const completed = new Int32Array(boundary);
  let writes = 0;
  const worker = new Worker(`
    import { parentPort, workerData } from 'node:worker_threads';
    import { DatabaseSync } from 'node:sqlite';
    const { Store } = await import(workerData.module);
    const originalClose = DatabaseSync.prototype.close;
    const completed = new Int32Array(workerData.boundary);
    let boundary = 0;
    // Force a concurrent writer opportunity exactly between validation and its
    // reopening fence; content clocks must not be mistaken for replacement.
    DatabaseSync.prototype.close = function () {
      originalClose.call(this);
      parentPort.postMessage({ boundary: ++boundary });
      while (Atomics.load(completed, 0) < boundary) {
        if (Atomics.wait(completed, 0, boundary - 1, 10_000) === 'timed-out')
          throw new Error('Concurrent recording did not acknowledge the validation boundary');
      }
    };
    for (let index = 0; index < 5; index++) {
      const store = new Store(workerData.path);
      store.close();
    }
    parentPort.postMessage({ ok: true });
  `, { eval: true, workerData: { path, boundary, module: new URL('../src/storage/store.js', import.meta.url).href } });
  let pending = Promise.resolve();
  try {
    await new Promise((resolve, reject) => {
      let result;
      worker.on('message', value => {
        if (value.boundary) {
          pending = store.runWrite(() => store.event('synthetic-concurrent-preflight-write', { sequence: ++writes }))
            .then(() => { Atomics.store(completed, 0, value.boundary); Atomics.notify(completed, 0); });
          void pending.catch(reject);
        } else result = value;
      });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && result?.ok ? resolve() : reject(new Error('Worker preflight failed')));
    });
    assert.equal(writes, 10, 'recording commits at every source validation and reopened store boundary');
  } finally {
    await worker.terminate(); await pending; store.close();
  }
});
