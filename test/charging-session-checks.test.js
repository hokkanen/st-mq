import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordChargingSessionCheck, chargingSessionCheckSummaries } from '../src/app/charging-session-checks.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-session-checks-'));
  const path = join(directory, 'history.sqlite');
  const store = new Store(path);
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}
const session = (changes = {}) => ({ source: 'easee', sessionKey: 'invented-session', start: 1000, end: 61000,
  estimatedKwh: 1.1, referenceKwh: 1, complete: true, quality: [], ...changes });

test('empty summaries have no invented sessions or percentages and ignore cumulative audit periods', t => {
  const { store } = fixture(t);
  store.energyAudit({ source: 'easee', device: 'invented-property', signal: 'property_import_energy_counter',
    sourceTime: 1000, receivedAt: 1000, value: 10 });
  store.energyAudit({ source: 'easee', device: 'invented-property', signal: 'property_import_energy_counter',
    sourceTime: 2000, receivedAt: 2000, value: 11 });
  const rows = chargingSessionCheckSummaries(store);
  assert.deepEqual(rows.map(row => row.source), ['easee', 'shelly-evse']);
  assert.deepEqual(rows.map(row => row.summary.basis), ['electricity-meter', 'electricity-meter']);
  for (const { summary } of rows) {
    assert.equal(summary.recordedSessions, 0);
    assert.equal(summary.comparedSessions, 0);
    assert.equal(summary.excludedSessions, 0);
    assert.deepEqual(summary.exclusionReasons, {});
    assert.equal(summary.differenceKwh, null);
    assert.equal(summary.differencePercent, null);
    assert.equal(summary.start, null);
    assert.equal(summary.end, null);
  }
});

test('all-session comparison is energy weighted and excludes incomplete, zero-reference and uncertain checks', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ estimatedKwh: 12, referenceKwh: 10 }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-second', start: 71000, end: 131000,
    estimatedKwh: 81, referenceKwh: 90, quality: ['estimated-boundary'] }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-partial', complete: false }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-zero', referenceKwh: 0 }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-stale', quality: ['stale'] }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-no-estimate', estimatedKwh: null }));
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', estimatedKwh: 9, referenceKwh: 8 }));
  const before = { events: store.events().length, states: store.db.prepare('SELECT count(*) AS n FROM state').get().n };
  const [easee, tesla] = chargingSessionCheckSummaries(store);
  const { differencePercent, ...easeeTotals } = easee.summary;
  assert(Math.abs(differencePercent - -7) < 1e-10);
  assert.deepEqual(easeeTotals, { basis: 'electricity-meter', recordedSessions: 6, comparedSessions: 2,
    excludedSessions: 4, exclusionReasons: { 'comparison-incomplete': 1, 'zero-reference': 1, stale: 1, 'missing-estimate': 1 },
    estimatedKwh: 93, referenceKwh: 100, differenceKwh: -7,
    start: 1000, end: 131000, lastSessionEnd: 131000 });
  assert.equal(tesla.summary.comparedSessions, 1);
  assert.equal(tesla.summary.differencePercent, 12.5);
  assert.deepEqual({ events: store.events().length, states: store.db.prepare('SELECT count(*) AS n FROM state').get().n }, before);
  assert(!JSON.stringify([easee, tesla]).includes('invented-'));
});

test('exclusion reasons count affected sessions without implying their existing references are missing', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ complete: false, estimatedKwh: null, quality: ['estimated', 'incomplete-coverage'] }));
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-interrupted', complete: false,
    quality: ['missing-start', 'stale', 'disconnected', 'stale'] }));
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-uncertain', complete: false,
    quality: ['estimated-boundary', 'duplicate-suspected', 'missing-end', 'stale', 'disconnected'] }));
  const [easee, tesla] = chargingSessionCheckSummaries(store);
  assert.deepEqual(easee.summary.exclusionReasons, { 'incomplete-coverage': 1 });
  assert.deepEqual(tesla.summary.exclusionReasons, { disconnected: 2, 'missing-start': 1, stale: 2,
    'duplicate-suspected': 1, 'missing-end': 1 });
  assert.equal(tesla.summary.excludedSessions, 2);
  assert.equal(tesla.summary.comparedSessions, 0);
});

test('missing references and unconfirmed terminal references remain distinct from zero references', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-no-reference', referenceKwh: null }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-old-reference', complete: false, quality: ['missing-final-reference'] }));
  recordChargingSessionCheck(store, session({ sessionKey: 'invented-zero-reference', referenceKwh: 0 }));
  assert.deepEqual(chargingSessionCheckSummaries(store)[0].summary.exclusionReasons,
    { 'missing-reference': 1, 'missing-final-reference': 1, 'zero-reference': 1 });
});

test('finalized checks are durable, source-scoped, idempotent and reject conflicting retries without storing identifiers', t => {
  const { store, path } = fixture(t);
  const input = session({ sessionKey: 'invented-private-session-identity', device: 'invented-private-device',
    raw: { payload: 'must-never-be-copied' }, quality: ['estimated', 'estimated-boundary'] });
  const eventId = recordChargingSessionCheck(store, input);
  assert.equal(recordChargingSessionCheck(store, { ...input, quality: ['estimated-boundary', 'estimated', 'estimated'] }), eventId);
  const allPayloads = JSON.stringify(store.db.prepare('SELECT payload FROM events').all());
  const allStates = JSON.stringify(store.db.prepare('SELECT key,value FROM state').all());
  assert(!allPayloads.includes('invented-private'));
  assert(!allPayloads.includes('must-never-be-copied'));
  assert(!allStates.includes('invented-private'));
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(recordChargingSessionCheck(reopened, input), eventId);
    assert.throws(() => recordChargingSessionCheck(reopened, { ...input, referenceKwh: 2 }), /Conflicting finalized/);
    assert.equal(reopened.events().length, 1);
    assert.notEqual(recordChargingSessionCheck(reopened, { ...input, source: 'shelly-evse' }), eventId);
    assert.deepEqual(chargingSessionCheckSummaries(reopened).map(row => row.summary.recordedSessions), [1, 1]);
  } finally { reopened.close(); }
});

test('session publication is atomic when durable idempotency state fails', t => {
  const { store } = fixture(t);
  const setState = store.setState;
  store.setState = () => { throw new Error('Synthetic state failure'); };
  assert.throws(() => recordChargingSessionCheck(store, session()), /Synthetic state failure/);
  assert.equal(store.events().length, 0);
  store.setState = setState;
  recordChargingSessionCheck(store, session());
  assert.equal(store.events().length, 1);
});

test('summary includes history beyond store event page limits', t => {
  const { store } = fixture(t);
  store.transaction(() => {
    for (let i = 0; i < 5005; i++) recordChargingSessionCheck(store, session({ sessionKey: `invented-${i}`,
      start: 1000 + i * 1000, end: 2000 + i * 1000, estimatedKwh: i === 0 ? 2 : 1, referenceKwh: 1 }));
  });
  assert.equal(store.events().length, 100);
  const { summary } = chargingSessionCheckSummaries(store)[0];
  assert.equal(summary.recordedSessions, 5005);
  assert.equal(summary.comparedSessions, 5005);
  assert.equal(summary.referenceKwh, 5005);
  assert.equal(summary.estimatedKwh, 5006);
  assert.equal(summary.differenceKwh, 1);
  assert.equal(summary.differencePercent, 100 / 5005);
});

test('malformed sessions cannot create plausible averages', t => {
  const { store } = fixture(t);
  for (const change of [{ source: '__proto__' }, { source: 'unknown' }, { sessionKey: '' }, { start: -1 },
    { end: 1000 }, { end: Infinity }, { estimatedKwh: -1 }, { referenceKwh: NaN },
    { estimatedKwh: undefined }, { complete: undefined }, { quality: ['invented-arbitrary-payload'] }]) {
    assert.throws(() => recordChargingSessionCheck(store, session(change)), TypeError);
  }
  assert.equal(store.events().length, 0);
});
