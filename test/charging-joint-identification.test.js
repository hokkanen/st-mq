import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJointTeslaComparison, jointTeslaComparisonScope } from '../src/charging/joint-identification.js';

const START = Date.parse('2026-10-04T10:00:00Z');
function fixture() {
  const record = {
    testId: 'synthetic-minimum-test', confirmedAt: START + 10_000,
    observedAt: START + 16_000, receivedAt: START + 11_000,
    physicalAt: START + 15_000, minimumPhysicalAt: START + 15_000,
    teslaAssociation: 'synthetic-tesla-feed', bmwAssociation: 'synthetic-bmw-feed',
    connections: {
      charger1: { association: 'synthetic-first-charger', sessionId: null,
        connectedAt: START, identificationId: 'synthetic-first-attempt' },
      charger2: { association: 'synthetic-second-charger', sessionId: 'synthetic-second-connection',
        connectedAt: START + 1000, identificationId: 'synthetic-minimum-test' },
    },
  };
  const live = { now: START + 20_000, teslaAssociation: record.teslaAssociation,
    bmwAssociation: record.bmwAssociation,
    connections: Object.fromEntries(Object.entries(record.connections)
      .map(([id, connection]) => [id, { ...connection, connected: true }])),
  };
  return { record, live };
}

test('absent optional comparison evidence grants no joint assignment authority', () => {
  const { live } = fixture();
  for (const absent of [undefined, null]) {
    assert.doesNotThrow(() => validateJointTeslaComparison(absent));
    assert.equal(jointTeslaComparisonScope(absent, live), 'invalid');
    assert.equal(jointTeslaComparisonScope(absent), 'invalid');
  }
});

test('serialized comparison keeps its original clocks through Stop, restoration and elapsed test deadline', () => {
  const { record, live } = fixture();
  const saved = JSON.parse(JSON.stringify(record)), original = structuredClone(saved);
  validateJointTeslaComparison(saved);
  assert.equal(jointTeslaComparisonScope(saved, live), 'valid');
  // The record proves a past comparison. No expired current-test lease, held
  // current value or present charging permission is used as new evidence here.
  live.now += 24 * 60 * 60_000;
  live.connections.charger1.stopped = true;
  live.connections.charger2.stopped = true;
  live.connections.charger2.currentTest = { phase: 'restored', expiresAt: START + 90_000 };
  assert.equal(jointTeslaComparisonScope(saved, live), 'valid');
  assert.deepEqual(saved, original, 'Checking historical identity must not refresh its clocks or scope');
});

test('malformed persisted comparison rejects unsupported shapes and invalid source chronology', () => {
  const cases = [
    ['extra record field', r => { r.obsolete = true; }],
    ['missing test ID', r => { delete r.testId; }],
    ['empty feed association', r => { r.teslaAssociation = ''; }],
    ['oversize test ID', r => { r.testId = 'x'.repeat(129); }],
    ['missing charger scope', r => { delete r.connections.charger1; }],
    ['unsupported charger scope', r => { r.connections.charger3 = r.connections.charger1; }],
    ['extra saved connection field', r => { r.connections.charger1.connected = true; }],
    ['missing attempt ID', r => { delete r.connections.charger1.identificationId; }],
    ['invalid native session ID', r => { r.connections.charger2.sessionId = 42; }],
    ['unknown saved connection time', r => { r.connections.charger1.connectedAt = null; }],
    ['future saved connection time', r => { r.connections.charger1.connectedAt = r.observedAt + 1; }],
    ['unsettled comparison', r => { r.observedAt = r.confirmedAt + 4999; }],
    ['Tesla current predates readback', r => { r.receivedAt = r.confirmedAt - 1; }],
    ['physical current predates readback', r => { r.physicalAt = r.confirmedAt - 1; }],
    ['minimum current predates readback', r => { r.minimumPhysicalAt = r.confirmedAt - 1; }],
    ['source receipt after conclusion', r => { r.receivedAt = r.observedAt + 1; }],
    ['physical sample after conclusion', r => { r.physicalAt = r.observedAt + 1; }],
    ['minimum sample after conclusion', r => { r.minimumPhysicalAt = r.observedAt + 1; }],
  ];
  for (const key of ['confirmedAt', 'observedAt', 'receivedAt', 'physicalAt', 'minimumPhysicalAt']) {
    for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      cases.push([`${key} rejects ${value}`, r => { r[key] = value; }]);
  }
  for (const [label, mutate] of cases) {
    const { record, live } = fixture(); mutate(record);
    assert.throws(() => validateJointTeslaComparison(record),
      /Unsupported saved joint Tesla comparison; start a fresh development database/, label);
    assert.equal(jointTeslaComparisonScope(record, live), 'invalid', label);
  }
});

test('future observations and an unknown evaluation clock cannot admit saved comparison evidence', () => {
  const { record, live } = fixture();
  for (const now of [undefined, null, NaN, record.observedAt - 1])
    assert.equal(jointTeslaComparisonScope(record, { ...live, now }), 'invalid');
  assert.equal(jointTeslaComparisonScope(record, { ...live, now: record.observedAt }), 'valid');
});

test('incomplete startup scope remains unknown without erasing or refreshing the saved record', () => {
  const cases = [
    state => { delete state.connections; },
    state => { state.connections = null; },
    state => { delete state.connections.charger1; },
    state => { state.connections.charger2 = null; },
    state => { state.teslaAssociation = null; },
    state => { delete state.bmwAssociation; },
  ];
  for (const chargerId of ['charger1', 'charger2']) {
    for (const key of ['connected', 'association', 'connectedAt', 'sessionId', 'identificationId'])
      cases.push(state => { delete state.connections[chargerId][key]; });
    for (const key of ['connected', 'association', 'connectedAt'])
      cases.push(state => { state.connections[chargerId][key] = null; });
  }
  for (const mutate of cases) {
    const { record, live } = fixture(), original = structuredClone(record); mutate(live);
    assert.equal(jointTeslaComparisonScope(record, live), 'unknown');
    assert.deepEqual(record, original);
  }
});

test('a known disconnect, scope change or retry invalidates proof despite other startup unknowns', () => {
  for (const chargerId of ['charger1', 'charger2']) {
    const peer = chargerId === 'charger1' ? 'charger2' : 'charger1';
    for (const [key, value] of [['connected', false], ['association', 'replacement-charger'],
      ['connectedAt', START + 2000], ['sessionId', 'replacement-connection'],
      ['identificationId', 'explicit-new-attempt']]) {
      const { record, live } = fixture();
      live.connections[peer] = null;
      live.connections[chargerId][key] = value;
      assert.equal(jointTeslaComparisonScope(record, live), 'invalid', `${chargerId} ${key}`);
    }
  }
  for (const key of ['teslaAssociation', 'bmwAssociation']) {
    const { record, live } = fixture();
    live.connections = null; live[key] = 'replacement-vehicle-feed';
    assert.equal(jointTeslaComparisonScope(record, live), 'invalid', key);
  }
});

test('explicit null IDs mean known absence and cannot stand in for an existing session or attempt', () => {
  const { record, live } = fixture();
  assert.equal(jointTeslaComparisonScope(record, live), 'valid', 'The first charger has no native session ID');
  const absentAttempt = structuredClone(record);
  absentAttempt.connections.charger1.identificationId = null;
  live.connections.charger1.identificationId = null;
  validateJointTeslaComparison(absentAttempt);
  assert.equal(jointTeslaComparisonScope(absentAttempt, live), 'valid');
  assert.equal(jointTeslaComparisonScope(record, live), 'invalid', 'Known absence cannot retain an old attempt');
  live.connections.charger1.identificationId = 'a-new-attempt';
  assert.equal(jointTeslaComparisonScope(absentAttempt, live), 'invalid', 'An absent saved attempt cannot cover a new retry');
  const other = fixture(); other.live.connections.charger2.sessionId = null;
  assert.equal(jointTeslaComparisonScope(other.record, other.live), 'invalid');
});

test('malformed live scope is rejected rather than treated as a matching or unknown connection', () => {
  const cases = [
    state => { state.connections = []; },
    state => { state.connections.charger3 = {}; },
    state => { state.connections.charger1 = []; },
    state => { state.connections.charger2.connected = 'true'; },
    state => { state.connections.charger2.association = ''; },
    state => { state.connections.charger2.connectedAt = state.now + 1; },
    state => { state.connections.charger2.identificationId = false; },
    state => { state.teslaAssociation = 42; },
  ];
  for (const mutate of cases) {
    const { record, live } = fixture(); mutate(live);
    assert.equal(jointTeslaComparisonScope(record, live), 'invalid');
  }
});
