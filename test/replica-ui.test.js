import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyReplica, replicaDisplay, primaryReplicationDisplay, replicaSnapshotKey, chartObservationTime, renderReplicaStatus } from '../chart/replica-status.js';
import { historySeriesAt } from '../chart/history-model.js';

const now = Date.parse('2026-09-10T12:00:00Z');
const ready = (overrides = {}) => ({ role: 'replica', now,
  replication: { state: 'ready', generation: 'first-generation', snapshotAt: now - 60_000,
    verifiedAt: now - 30_000, lastSuccessAt: now - 30_000, ...overrides } });

test('replica status distinguishes first sync, catch-up, failed verification, and a clock mismatch', () => {
  const waiting = replicaDisplay({ role: 'replica', now, replication: { state: 'waiting' } });
  assert.equal(waiting.available, false);
  assert.equal(waiting.state, 'waiting');
  assert.match(waiting.summary, /first verified database snapshot/);
  assert.match(waiting.success, /No successful synchronization/);
  assert.match(waiting.verification, /not reported/);
  const current = replicaDisplay(ready());
  assert.equal(current.state, 'ready');
  assert.match(current.snapshot, /1 minute ago/);
  assert.match(current.verification, /identity verified/);
  const catchingUp = replicaDisplay(ready({ snapshotAt: now - 3 * 86400_000 }));
  assert.equal(catchingUp.state, 'stale', 'a recently received old snapshot is still old history');
  assert.equal(catchingUp.available, true);
  assert.match(catchingUp.snapshot, /3 days ago/);
  assert.match(catchingUp.summary, /catch up automatically/);
  const failure = replicaDisplay(ready({ state: 'error', error: 'synthetic-private-transport-detail' }));
  assert.equal(failure.available, true);
  assert.match(failure.summary, /last verified history remains available/);
  assert.doesNotMatch(JSON.stringify(failure), /synthetic-private/);
  const future = replicaDisplay(ready({ snapshotAt: now + 120_000 }));
  assert.equal(future.state, 'clock-warning');
  assert.match(future.summary, /clocks/);
  assert.doesNotMatch(future.snapshot, /ago/);
});

test('staleness respects the configured replication interval and rejects malformed timestamps', () => {
  assert.equal(replicaDisplay(ready({ snapshotAt: now - 10 * 60_000, staleAfterMs: 20 * 60_000 })).state, 'ready');
  assert.equal(replicaDisplay(ready({ snapshotAt: now - 60_000, state: 'stale' })).state, 'stale');
  for (const snapshotAt of [null, undefined, '2026-09-10', NaN, Infinity, -1]) {
    assert.equal(replicaDisplay(ready({ snapshotAt })).available, false);
  }
});

test('replica observation tails stay at the copied snapshot while primary charts advance normally', () => {
  const status = ready(), snapshotAt = status.replication.snapshotAt;
  const payload = { range: { from: now - 86400_000, to: now + 86400_000 },
    series: { indoor_temperature: [{ x: snapshotAt - 60_000, y: 21 }] } };
  const copied = historySeriesAt(payload, chartObservationTime(status, now));
  assert.equal(copied.indoor_temperature.at(-1).x, snapshotAt);
  const disconnected = historySeriesAt(payload, chartObservationTime({ ...status, now: now + 86400_000 }, now));
  assert.deepEqual(disconnected, copied, 'a disconnected viewer cannot manufacture another day of readings');
  const primary = historySeriesAt(payload, chartObservationTime({ role: 'primary', now }, now));
  assert.equal(primary.indoor_temperature.at(-1).x, now);
  assert.equal(payload.series.indoor_temperature.length, 1, 'stored series are untouched');
  assert.equal(chartObservationTime(ready({ snapshotAt: now + 120_000 }), now), now);
});

function fixture() {
  class Element {
    constructor() { this.dataset = {}; this.disabled = false; this.hidden = false; this.controls = []; this.classes = new Set();
      this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) }; }
    querySelectorAll() { return this.controls; }
  }
  const ids = ['primary-replication-notice', 'primary-replication-summary', 'primary-replication-detail',
    'replica-notice', 'replica-summary', 'replica-snapshot', 'replica-success', 'replica-verification',
    'connection', 'context', 'recording-adaptive-details', 'indoor', 'outdoor', 'indoor-age', 'outdoor-age',
    'requested', 'requested-label', 'actual', 'price', 'price-label', 'price-unit', 'updated'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const controls = new Element(); controls.controls = Array.from({ length: 8 }, () => new Element());
  const sections = [new Element(), new Element(), new Element()];
  const document = { documentElement: new Element(), getElementById: id => nodes.get(id),
    querySelectorAll: selector => selector === '[data-controller-only]' ? [controls] : sections };
  return { document, controls, sections, $: id => nodes.get(id) };
}

test('a replica renders without Engine status and never presents copied active flags as a live controller', () => {
  const { document, controls, sections, $ } = fixture();
  const waiting = renderReplicaStatus(document, { role: 'replica', now, replication: { state: 'waiting' } });
  assert.equal(waiting.available, false);
  assert.equal(controls.hidden, true);
  assert(controls.controls.every(node => node.disabled));
  assert(sections.every(node => node.hidden));
  assert.match($('connection').textContent, /WAITING FOR SNAPSHOT/);
  assert.match($('actual').textContent, /unknown/);
  const status = { ...ready(), liveWrites: true, h66: { connected: true },
    observations: { indoor: { value: 21.3, observedAt: now - 90_000, source: 'husdata-h66' } },
    lastDecision: { phase: 'reduction' }, recording: { parameters: [] } };
  renderReplicaStatus(document, status);
  assert(sections.every(node => !node.hidden), 'history becomes available after initial publication');
  assert.equal(controls.hidden, true);
  assert(controls.controls.every(node => node.disabled));
  assert.equal($('indoor').textContent, '21.3 °C');
  assert.equal($('outdoor').textContent, '—');
  assert.match($('indoor-age').textContent, /Recorded/);
  assert.equal($('requested').textContent, 'reduction');
  assert.equal($('requested-label').textContent, 'RECORDED HEATING REQUEST');
  assert.match($('context').textContent, /primary’s current operating state is unknown/);
  assert.doesNotMatch($('connection').textContent, /LIVE CONTROL|LIVE OBSERVATION/);
  assert.equal($('recording-adaptive-details').hidden, true);
  renderReplicaStatus(document, { ...status, now: now + 3 * 86400_000 });
  assert.equal($('replica-notice').dataset.state, 'stale');
  assert($('indoor').classes.has('stale'));
  assert(sections.every(node => !node.hidden), 'outages leave the last verified history accessible');
});

test('the primary keeps its dashboard and snapshot identity changes on replacement', () => {
  const { document, controls, $ } = fixture();
  assert.equal(renderReplicaStatus(document, { role: 'primary' }), null);
  assert.equal($('replica-notice').hidden, true);
  assert.equal(controls.hidden, false);
  assert(controls.controls.every(node => !node.disabled));
  assert.equal(isReadOnlyReplica({ instance: { role: 'replica' } }), true);
  assert.equal(isReadOnlyReplica({ role: 'primary', readOnly: true }), false);
  assert.equal(replicaSnapshotKey({ role: 'primary' }), null);
  assert.notEqual(replicaSnapshotKey(ready()), replicaSnapshotKey(ready({ generation: 'second-generation' })));
});

test('primary sync notice reports progress and retries without exposing transport configuration', () => {
  assert.equal(primaryReplicationDisplay({ role: 'primary' }), null);
  assert.equal(primaryReplicationDisplay(ready({ enabled: true })), null);
  const status = { role: 'primary', replication: { enabled: true, state: 'syncing', phase: 'transferring' } };
  assert.match(primaryReplicationDisplay(status).summary, /Sending database changes/);
  assert.match(primaryReplicationDisplay(status).detail, /No successful synchronization/);
  status.replication = { ...status.replication, state: 'error', error: 'synthetic-private-error',
    target: 'synthetic-private-host', lastSuccessAt: now - 60000, sourceAt: now - 90000,
    verifiedAt: now - 61000, nextAttemptAt: now + 60000 };
  const display = primaryReplicationDisplay(status);
  assert.match(display.summary, /Home control continues/);
  assert.match(display.summary, /retry automatically/);
  for (const phrase of ['Last successful sync:', 'Primary snapshot:', 'Identity verified:', 'Next attempt:']) assert(display.detail.includes(phrase));
  assert.doesNotMatch(JSON.stringify(display), /synthetic-private/);
  const { document, $ } = fixture();
  renderReplicaStatus(document, status);
  assert.equal($('primary-replication-notice').hidden, false);
  assert.equal($('primary-replication-notice').dataset.state, 'error');
  assert.equal($('replica-notice').hidden, true);
});
