import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-contract-'));
  const path = join(directory, 'history.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { path, store: new Store(path) };
}

test('Shelly native meter recording reopens without session-check state or history', t => {
  const { path, store } = fixture(t);
  const key = 'charging:shelly:synthetic-association';
  const state = { version: 1, fields: { phase_info: { measuredAt: 2000 } },
    counter: { at: 2000, value: 10, phasePowers: [1, 1, 1] } };
  store.setState(key, state);
  for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'shelly-evse', device: 'synthetic-association',
    signal: `ev2_energy_l${phase}`, value: .01, unit: 'kWh', sourceTime: 2000, receivedAt: 2000,
    quality: ['estimated'], raw: { intervalStart: 1000, intervalEnd: 2000 } });
  store.close();
  const reopened = new Store(path);
  try {
    assert.deepEqual(reopened.getState(key), state);
    assert.equal(reopened.observations().length, 3);
    assert.equal(reopened.events({ type: 'charging-session-check' }).length, 0);
  } finally { reopened.close(); }
});

test('removed Shelly checks and accumulator state reject database open without changing source bytes', t => {
  const retiredStates = [{ checkSession: null }, { sessionCheck: null },
    { sessionCheck: { version: 1, active: { nativeRuns: { version: 1 } } } },
    { counter: { at: 1000, value: 1, powerW: 0 } },
    { fields: { energy_charge: { value: 1 } } }, { fields: { time_charge: { value: 1 } } }];
  for (const state of [null, ...retiredStates]) {
    const { path, store } = fixture(t);
    if (state) store.setState('charging:shelly:synthetic-association', { version: 1, ...state });
    else store.event('charging-session-check', { version: 1, source: 'shelly-evse', start: 1000, end: 2000,
      estimatedKwh: 1, referenceKwh: 1, complete: true, quality: [],
      recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy' }, 2000);
    store.close();
    const before = readFileSync(path);
    for (const readOnly of [false, true]) {
      assert.throws(() => new Store(path, { readOnly }), /Unsupported .*session-check.*fresh development database/);
      assert.deepEqual(readFileSync(path), before);
    }
  }
});
