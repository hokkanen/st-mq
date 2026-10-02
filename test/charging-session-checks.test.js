import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recordChargingSessionCheck, chargingSessionCheckSummaries, comparableChargingSession,
  assertCurrentChargingSessionCheck } from '../src/app/charging-session-checks.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-session-checks-'));
  const path = join(directory, 'history.sqlite');
  const store = new Store(path);
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}
const session = (changes = {}) => ({ source: 'easee', sessionKey: 'invented-session', start: 1000, end: 61000,
  estimatedKwh: 1.1, referenceKwh: 1, complete: true, quality: [],
  ...(changes.source === 'shelly-evse' ? { recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy' } : {}),
  ...changes });

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
    assert.equal(summary.latestReferenceAggregation, null);
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
    start: 1000, end: 131000, lastSessionEnd: 131000, referenceTransports: ['unknown'], latestReferenceAggregation: null });
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
    assert.notEqual(recordChargingSessionCheck(reopened, { ...input, source: 'shelly-evse',
      recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy' }), eventId);
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

const aggregation = (changes = {}) => ({ kind: 'plug-period-native-runs', observedKwh: 3,
  runCount: 2, complete: true, quality: [], ...changes });

test('native run totals retain observed incomplete subtotals without adding them to comparison averages', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-two-runs',
    estimatedKwh: 2.7, referenceKwh: 3, referenceAggregation: aggregation() }));
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-other-runs',
    start: 71000, end: 131000, estimatedKwh: 6.3, referenceKwh: 7,
    referenceAggregation: aggregation({ observedKwh: 7, runCount: 3 }) }));
  const incomplete = aggregation({ observedKwh: 20, runCount: 4, complete: false,
    quality: ['missing-final-reference', 'reference-coverage-gap'] });
  const id = recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-incomplete-runs',
    start: 141000, end: 201000, estimatedKwh: 21, referenceKwh: null, complete: false,
    referenceAggregation: incomplete }));
  const check = store.events().find(row => row.id === id).payload;
  assert.deepEqual(check.referenceAggregation, incomplete);
  assert.equal(check.referenceKwh, null);
  assert.equal(comparableChargingSession(check), false);
  const { summary } = chargingSessionCheckSummaries(store)[1];
  assert.equal(summary.recordedSessions, 3);
  assert.equal(summary.comparedSessions, 2);
  assert.equal(summary.excludedSessions, 1);
  assert.equal(summary.estimatedKwh, 9);
  assert.equal(summary.referenceKwh, 10);
  assert.equal(summary.differencePercent, -10);
  assert.deepEqual(summary.exclusionReasons, { 'missing-final-reference': 1, 'reference-coverage-gap': 1, 'missing-reference': 1 });
  assert.deepEqual(summary.latestReferenceAggregation, { ...incomplete, start: 141000, end: 201000 });
});

test('the latest native aggregation remains available when later valid single-run checks omit new evidence', t => {
  const { store, path } = fixture(t);
  const input = session({ source: 'shelly-evse', referenceKwh: 3, referenceAggregation: aggregation() });
  const id = recordChargingSessionCheck(store, input);
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-later-single-run',
    start: 71000, end: 131000 }));
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(recordChargingSessionCheck(reopened, input), id);
    const { summary } = chargingSessionCheckSummaries(reopened)[1];
    assert.equal(summary.comparedSessions, 2);
    assert.equal(summary.lastSessionEnd, 131000);
    assert.deepEqual(summary.latestReferenceAggregation, { ...aggregation(), start: 1000, end: 61000 });
    assert.throws(() => recordChargingSessionCheck(reopened, { ...input,
      referenceAggregation: aggregation({ runCount: 3 }) }), /Conflicting finalized/);
  } finally { reopened.close(); }
});

test('a confirmed native run total still requires complete stored phase coverage', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', estimatedKwh: null,
    referenceKwh: 3, complete: false, quality: ['incomplete-coverage'], referenceAggregation: aggregation() }));
  const { summary } = chargingSessionCheckSummaries(store)[1];
  assert.equal(summary.comparedSessions, 0);
  assert.equal(summary.latestReferenceAggregation.complete, true);
  assert.deepEqual(summary.exclusionReasons, { 'incomplete-coverage': 1 });
});

test('malformed or contradictory native aggregation evidence is rejected at write and persisted read boundaries', t => {
  const { store } = fixture(t);
  const valid = session({ source: 'shelly-evse', referenceKwh: 3, referenceAggregation: aggregation() });
  for (const changes of [
    { source: 'easee' }, { referenceAggregation: null }, { referenceAggregation: [] },
    ...[{ kind: 'invented-other-kind' }, { observedKwh: NaN }, { observedKwh: -1 }, { observedKwh: null },
      { runCount: -1 }, { runCount: 1.5 }, { runCount: Number.MAX_SAFE_INTEGER + 1 },
      { complete: undefined }, { quality: ['invented-quality'] }, { quality: ['missing-final-reference'] },
      { extra: 'retired-field' }, { complete: false }].map(change => ({ referenceAggregation: aggregation(change) })),
    { referenceKwh: 2 },
    { complete: true, referenceKwh: null, referenceAggregation: aggregation({ complete: false }) },
    { complete: false, referenceKwh: 3, referenceAggregation: aggregation({ complete: false }) },
  ]) {
    const input = { ...valid, ...changes };
    assert.throws(() => recordChargingSessionCheck(store, input), /reference aggregation/);
    assert.throws(() => assertCurrentChargingSessionCheck({ version: 1, ...input }), /reference aggregation/);
  }
  assert.equal(store.events().length, 0);
  store.event('charging-session-check', { version: 1, ...valid,
    referenceAggregation: aggregation({ complete: false }) }, valid.end);
  assert.throws(() => chargingSessionCheckSummaries(store), /reference aggregation/);
});

test('absent new aggregation metadata remains absent and empty observed evidence never invents a total', t => {
  const { store } = fixture(t);
  recordChargingSessionCheck(store, session({ source: 'shelly-evse' }));
  assert(!Object.hasOwn(store.events()[0].payload, 'referenceAggregation'));
  recordChargingSessionCheck(store, session({ source: 'shelly-evse', sessionKey: 'invented-no-native-observations',
    referenceKwh: null, complete: false, referenceAggregation: aggregation({ observedKwh: null,
      runCount: 0, complete: false, quality: ['missing-start', 'missing-final-reference'] }) }));
  const { summary } = chargingSessionCheckSummaries(store)[1];
  assert.equal(summary.comparedSessions, 1);
  assert.equal(summary.latestReferenceAggregation.observedKwh, null);
  assert.equal(summary.latestReferenceAggregation.runCount, 0);
});
