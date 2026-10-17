import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../src/storage/store.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { fixture } from './helpers/charging-joint-fixture.js';

// The real recorder query and worker-backed publication remain active. Only
// devices and source clocks come from the joint charging fixture.
test('one charging publication reads each charger history once and publishes fresh assessor results', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-publication-views-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const f = await fixture(t, { store });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.connect('charger1'); await f.connect('charger2');
  await store.startWriter();
  const start = f.now;
  f.advance(30_000); await f.settle();
  const devices = { charger1: 'synthetic-joint-easee', charger2: f.runtime.chargers.charger2.adapter.association };
  const energy = async (from, values) => store.runWrite(() => {
    for (const [id, value] of Object.entries(values)) for (const phase of [1, 2, 3]) store.observation({
      source: id === 'charger1' ? 'easee' : 'shelly-evse', device: devices[id],
      signal: `${id === 'charger1' ? 'ev1' : 'ev2'}_energy_l${phase}`, value, unit: 'kWh',
      sourceTime: f.now, receivedAt: f.now,
      raw: { intervalStart: from, intervalEnd: f.now, basis: 'synthetic-meter-interval' },
    });
  });
  await energy(start, { charger1: .1, charger2: .2 });
  const queries = [], read = f.runtime.readEnergy.bind(f.runtime);
  t.mock.method(f.runtime, 'readEnergy', query => { queries.push(query); return read(query); });
  const observe = f.runtime.sessionDiagnostics.observe.bind(f.runtime.sessionDiagnostics);
  const assess = f.runtime.physicalTests.update.bind(f.runtime.physicalTests);
  let diagnosticsInputUnchanged = true, assessmentInputUnchanged = true, assessmentDiagnostics;
  t.mock.method(f.runtime.sessionDiagnostics, 'observe', (...args) => {
    const before = structuredClone(args[0]), result = observe(...args);
    diagnosticsInputUnchanged &&= isDeepStrictEqual(args[0], before); return result;
  });
  t.mock.method(f.runtime.physicalTests, 'update', (...args) => {
    assessmentDiagnostics = structuredClone(args[0].diagnostics);
    const before = structuredClone(args[0]), result = assess(...args);
    assessmentInputUnchanged &&= isDeepStrictEqual(args[0], before); return result;
  });
  const publish = async expected => {
    // Progress-only projection changes retain their existing 30-second cadence.
    f.advance(30_001);
    queries.length = 0;
    await store.runWrite(() => f.runtime.persistAcceptedState(f.now));
    assert.deepEqual(queries.map(query => query.id).sort(), ['charger1', 'charger2'],
      'Diagnostics, physical assessments and the saved view share one history calculation per charger');
    const saved = readChargingRuntime(store, f.runtime.key).view;
    for (const [id, value] of Object.entries(expected)) {
      const charger = saved.chargers.find(charger => charger.id === id);
      assert.ok(Math.abs(charger.progress.deliveredGridKwh - value) < 1e-9,
        `${id}: ${charger.progress.deliveredGridKwh} versus ${value}; queries ${JSON.stringify(queries)}`);
    }
    assert.deepEqual(assessmentDiagnostics, { ...f.runtime.sessionDiagnostics.status(f.now), canManage: true });
    assert.deepEqual(saved.reportStatus, { available: true, error: null });
    assert.equal(saved.reportRetentionDays, f.runtime.sessionDiagnostics.status(f.now).retention.days);
    assert.deepEqual(saved.physicalTests, { ...f.runtime.physicalTests.status(), canManage: true });
    assert.equal(diagnosticsInputUnchanged, true); assert.equal(assessmentInputUnchanged, true);
  };
  await publish({ charger1: .3, charger2: .6 });
  const next = f.now; f.advance(30_000); await f.settle();
  await energy(next, { charger1: .2, charger2: .1 });
  await publish({ charger1: .9, charger2: .9 });
  const commandsBefore = f.commands.length;
  const diagnosticFailure = t.mock.method(f.runtime.sessionDiagnostics, 'observe', () => { throw new Error('Synthetic report save failure'); });
  const assessmentFailure = t.mock.method(f.runtime.physicalTests, 'update', () => { throw new Error('Synthetic assessment save failure'); });
  f.advance(1);
  await store.runWrite(() => f.runtime.persistAcceptedState(f.now));
  const failed = readChargingRuntime(store, f.runtime.key).view;
  assert.deepEqual(failed.reportStatus, { available: false, error: 'Session diagnostics could not be saved.' });
  assert.equal(failed.physicalTests.available, false);
  assert.equal(failed.physicalTests.error, 'The charging assessment could not be saved.');
  assert.equal(f.commands.length, commandsBefore, 'An assessor failure cannot send a device command');
  diagnosticFailure.mock.restore(); assessmentFailure.mock.restore();
  await publish({ charger1: .9, charger2: .9 });
});
