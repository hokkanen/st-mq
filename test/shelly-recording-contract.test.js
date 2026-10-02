import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';
import { newShellySessionCheckState, updateShellySessionChecks } from '../src/charging/shelly-session-checks.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-contract-'));
  const path = join(directory, 'history.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path, store: new Store(path) };
}
const check = { source: 'shelly-evse', sessionKey: 'synthetic-session', start: 1000, end: 2000,
  estimatedKwh: 1, referenceKwh: 1, complete: true, quality: [],
  recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy' };

test('current native Shelly session evidence reopens without migration', t => {
  const { path, store } = fixture(t);
  recordChargingSessionCheck(store, check);
  store.close();
  const reopened = new Store(path);
  try { assert.equal(reopened.events({ type: 'charging-session-check' }).length, 1); }
  finally { reopened.close(); }
});

test('retired Shelly session events and checkpoints reject database open without mutation', t => {
  for (const kind of ['event', 'state', 'idle-counter']) {
    const { path, store } = fixture(t);
    if (kind === 'event') {
      const { recordingBasis, referenceBasis, ...retired } = check;
      store.event('charging-session-check', { ...retired, version: 1 }, retired.end);
    } else store.setState('charging:shelly:synthetic-association', kind === 'state'
      ? { version: 1, checkSession: null } : { version: 1, counter: { at: 1000, value: 1, powerW: 0 } });
    store.close();
    const before = readFileSync(path);
    for (const readOnly of [false, true]) {
      assert.throws(() => new Store(path, { readOnly }), /Unsupported Shelly session-check.*fresh development database/);
      assert.deepEqual(readFileSync(path), before, `${kind} rejection must preserve source bytes`);
    }
  }
});

test('absent optional native accumulation evidence is not backfilled when an existing plug session reopens', t => {
  const { path, store } = fixture(t);
  const state = { version: 1, sessionCheck: { version: 1, active: { sessionKey: 'synthetic-plug',
    start: 1000, end: null, deadline: null, zeroAt: 1000, reference: { value: 1, measuredAt: 2000, receivedAt: 2000 },
    reset: null, quality: [] }, pending: null, reference: null, zero: null } };
  const key = 'charging:shelly:synthetic-association';
  store.setState(key, state); store.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.getState(key), state);
    assert(!Object.hasOwn(reopened.getState(key).sessionCheck.active, 'nativeRuns'));
  } finally { reopened.close(); }
});

test('current native accumulator state reopens with its observed evidence unchanged', t => {
  const { path, store } = fixture(t);
  const sessionCheck = newShellySessionCheckState();
  const connection = { connected: true, connectedAt: 1000, sessionId: 'synthetic-plug' };
  const config = { maxAgeMs: 1000, sessionEnergyVerified: false,
    chargingStates: ['charging'], connectedStates: ['connected'], disconnectedStates: ['free'] };
  for (const [role, value, at] of [['work_state', 'charging', 1000], ['energy_charge', 0, 1000], ['energy_charge', 1, 2000]])
    updateShellySessionChecks({ state: sessionCheck, connection, role,
      field: { value, measuredAt: at, receivedAt: at, retained: false }, config, now: at });
  const key = 'charging:shelly:synthetic-association', state = { version: 1, sessionCheck };
  store.setState(key, state); store.close();
  const reopened = new Store(path);
  try { assert.deepEqual(reopened.getState(key), state); }
  finally { reopened.close(); }
});

test('unsupported or unversioned native accumulators reject database open before mutation', t => {
  for (const position of ['active', 'pending']) for (const nativeRuns of [null, {}, { version: 0 }, { version: 2 }, { version: '1' }]) {
    const { path, store } = fixture(t);
    store.setState('charging:shelly:synthetic-association', { version: 1,
      sessionCheck: { version: 1, active: null, pending: null, [position]: { nativeRuns } } });
    store.close();
    const before = readFileSync(path);
    for (const readOnly of [false, true]) {
      assert.throws(() => new Store(path, { readOnly }), /Unsupported Shelly native session accumulator.*fresh development database/);
      assert.deepEqual(readFileSync(path), before, `${position} invalid accumulator rejection must preserve source bytes`);
    }
  }
});
