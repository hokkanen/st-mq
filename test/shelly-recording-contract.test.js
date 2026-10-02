import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';

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
