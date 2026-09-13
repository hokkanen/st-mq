import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyReplica, replicaDisplay, primaryReplicationDisplay, replicaSnapshotKey, chartObservationTime,
  renderReplicaStatus, instanceRoleDisplay, renderInstanceRole, pairPanelView } from '../chart/replica-status.js';
import { historySeriesAt } from '../chart/history-model.js';

const now = Date.parse('2026-09-10T12:00:00Z');

test('a newer rejoin publication replaces old ordinary-sync timestamps without hiding an active transfer', () => {
  const status = { pairing: { enabled: true, role: 'replica', sync: {
    state: 'ready', sourceAt: now - 86400_000, verifiedAt: now - 86300_000, bytes: 1e6 } },
    replication: { state: 'ready', snapshotAt: now - 60000, verifiedAt: now - 30000, bytes: 2e6 } };
  const view = pairPanelView(status);
  assert.equal(view.sync.sourceAt, now - 60000);
  assert.equal(view.sync.verifiedAt, now - 30000);
  assert.equal(view.sync.bytes, 2e6);
  status.pairing.sync = { ...status.pairing.sync, state: 'syncing', phase: 'transferring', bytes: 3e6, completedBytes: 1e6 };
  const transfer = pairPanelView(status).sync;
  assert.equal(transfer.sourceAt, now - 60000);
  assert.equal(transfer.state, 'syncing');
  assert.equal(transfer.bytes, 3e6);
  assert.equal(transfer.completedBytes, 1e6);
});

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
  const document = {};
  class Element {
    constructor() {
      Object.assign(this, { ownerDocument: document, dataset: {}, disabled: false, hidden: false, controls: [], children: [],
        classes: new Set(), attributes: {}, listeners: new Map(), style: {}, ownText: '', className: '', scrollTop: 0 });
      this.classList = { toggle: (key, on) => on ? this.classes.add(key) : this.classes.delete(key) };
    }
    get isConnected() { return true; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.children = []; this.ownText = String(value); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.ownText = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, callback) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
    click() { for (const callback of this.listeners.get('click') ?? []) callback({ target: this }); }
    focus() { document.activeElement = this; }
    querySelectorAll() { return this.controls; }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.id === selector.slice(1)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    }
    getBoundingClientRect() { return { left: 20, top: 20, right: 300, bottom: 60, width: 280, height: 40 }; }
  }
  const ids = ['primary-replication-notice', 'primary-replication-summary', 'primary-replication-detail',
    'replica-notice', 'replica-summary', 'replica-snapshot', 'replica-success', 'replica-verification',
    'connection', 'instance-role', 'context', 'recording-adaptive-details', 'indoor', 'outdoor', 'indoor-age', 'outdoor-age',
    'requested', 'requested-label', 'actual', 'price', 'price-label', 'price-unit', 'updated'];
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const controls = new Element(); controls.controls = Array.from({ length: 8 }, () => new Element());
  const sections = [new Element(), new Element(), new Element()];
  Object.assign(document, { documentElement: new Element(), body: new Element(), createElement: () => new Element(),
    defaultView: { innerWidth: 390, innerHeight: 844, addEventListener() {} }, addEventListener() {},
    getElementById: id => nodes.get(id) ?? document.body.querySelector(`#${id}`),
    querySelectorAll: selector => selector === '[data-controller-only]' ? [controls] : sections });
  return { document, controls, sections, $: id => document.getElementById(id) };
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
  assert.equal($('outdoor').textContent, 'Unavailable');
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

test('replica renders the recorded indoor average and outdoor summary without room cards', () => {
  const { document, $ } = fixture();
  const observation = value => ({ value, source: 'mqtt-temperature', observedAt: now - 60_000, stale: false });
  renderReplicaStatus(document, { ...ready(), observations: {
    indoor: { ...observation(21), source: 'indoor-average' }, upstairs: observation(22),
    downstairs: observation(20), bedroom: observation(21), outdoor: observation(5),
  } });
  for (const [key, value] of [['indoor', '21.0'], ['outdoor', '5.0']]) {
    assert.equal($(key).textContent, `${value} °C`);
    assert.match($(`${key}-age`).textContent, /Recorded/);
  }
  renderReplicaStatus(document, { ...ready(), observations: { indoor: observation(21), upstairs: observation(22) } });
  assert.equal($('outdoor').textContent, 'Unavailable', 'a missing copied observation must not retain an old value');
  assert($('outdoor').classes.has('stale'));
});

test('replica explains held indoor contributions without confusing sensor age with snapshot freshness', () => {
  const { document, $ } = fixture();
  renderReplicaStatus(document, { ...ready(), observations: { indoor: {
    value: 21, source: 'indoor-average', observedAt: now - 3 * 3_600_000, stale: false, needsAttention: true, held: true,
    attentionSensors: [{ signal: 'bedroom_temperature', observedAt: now - 3 * 3_600_000, reasons: ['old-reading', 'disconnected'] }],
  } } });
  assert.equal($('indoor').textContent, '21.0 °C');
  assert($('indoor').classes.has('stale'));
  assert.equal($('indoor-age').textContent, 'Recorded · Needs attention');
  $('indoor').querySelector('.status-detail-trigger').click();
  assert.match($('status-detail-popover').textContent, /Recorded.*Needs attention.*Bedroom.*over 2 hours old.*sensor disconnected/);
  assert.doesNotMatch($('indoor-age').textContent, /Bedroom|sensor disconnected/);
  assert.equal($('replica-notice').dataset.state, 'ready', 'Sensor attention does not change the snapshot status');
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

test('the header separates paired authority from the master’s monitoring or active mode', () => {
  const { document, $ } = fixture();
  for (const liveWrites of [false, true]) {
    const operatingMode = liveWrites ? 'LIVE CONTROL · ACTIVE' : 'LIVE OBSERVATION · MONITORING';
    $('connection').textContent = operatingMode;
    renderInstanceRole(document, { liveWrites, pairing: { enabled: true, role: 'primary', canControl: true } });
    assert.equal($('instance-role').textContent, 'MASTER');
    assert.equal($('instance-role').dataset.state, 'primary');
    assert.equal($('connection').textContent, operatingMode, 'master authority must not imply active device control');
  }
  renderInstanceRole(document, { pairing: { enabled: false } });
  assert.equal($('instance-role').textContent, 'STANDALONE');
  assert.equal(instanceRoleDisplay({ role: 'replica' }).label, 'READ-ONLY REPLICA');
  assert.equal(instanceRoleDisplay({ controlAuthority: { state: 'protected' } }).label, 'CONTROL STOPPED');
});

test('paired slaves use the compact pair section while retaining snapshot and read-only safeguards', () => {
  const { document, controls, sections, $ } = fixture();
  const pairing = { enabled: true, role: 'replica', canControl: false };
  renderReplicaStatus(document, { ...ready(), pairing, liveWrites: true });
  assert.equal($('instance-role').textContent, 'SLAVE');
  assert.equal($('replica-notice').hidden, true, 'paired details replace the duplicate full-size replica notice');
  assert.match($('connection').textContent, /READ-ONLY HISTORY · HISTORY AVAILABLE/);
  assert(controls.hidden && controls.controls.every(node => node.disabled));
  assert(sections.every(node => !node.hidden));
  renderReplicaStatus(document, { role: 'replica', now, pairing, replication: { state: 'waiting' } });
  assert.match($('connection').textContent, /WAITING FOR SNAPSHOT/);
  assert(sections.every(node => node.hidden));
  renderReplicaStatus(document, { ...ready({ state: 'error' }), pairing });
  assert.match($('connection').textContent, /SYNC NEEDS ATTENTION/);
  assert(sections.every(node => !node.hidden), 'the last verified history stays visible after a failed catch-up');
  renderReplicaStatus(document, ready());
  assert.equal($('replica-notice').hidden, false, 'unpaired database replicas keep their existing notice');
});

test('fast role updates cannot present a stale promoted viewer as a ready master', () => {
  const { document, controls, $ } = fixture();
  const promoted = { ...ready(), pairing: { enabled: true, role: 'primary', canControl: true } };
  renderReplicaStatus(document, promoted);
  assert.equal($('instance-role').textContent, 'MASTER · WAITING');
  assert.equal($('instance-role').dataset.state, 'transition');
  assert.equal(controls.hidden, true);
  assert.doesNotMatch($('connection').textContent, /LIVE CONTROL/);
  renderReplicaStatus(document, { pairing: promoted.pairing });
  assert.equal($('instance-role').textContent, 'MASTER');
  assert.equal(controls.hidden, false, 'a fresh primary runtime status releases the viewer guard');
  renderReplicaStatus(document, { pairing: { ...promoted.pairing, transition: { kind: 'handover' } } });
  assert.equal($('instance-role').textContent, 'ROLE CHANGE');
  assert.equal(controls.hidden, true);
  renderReplicaStatus(document, { ...ready(), pairing: { enabled: true, role: 'protected', canControl: false } });
  assert.equal($('instance-role').textContent, 'PROTECTED');
  assert.match($('connection').textContent, /HOME CONTROL DISABLED/);
  assert.match($('context').textContent, /Local history is protected for recovery/);
  assert.doesNotMatch($('context').textContent, /Recorded history from the primary/);
  assert.equal($('replica-notice').hidden, true);
});

test('the compact slave panel preserves published verification across receiver restarts and live progress', () => {
  const status = { ...ready({ bytes: 2e6 }), pairing: { enabled: true, role: 'replica', sync: { state: 'waiting' } } };
  const restarted = pairPanelView(status);
  assert.equal(restarted.sync.state, 'ready');
  assert.equal(restarted.sync.sourceAt, status.replication.snapshotAt);
  assert.equal(restarted.sync.verifiedAt, status.replication.verifiedAt);
  assert.equal(restarted.sync.bytes, 2e6);
  assert.deepEqual(status.pairing.sync, { state: 'waiting' }, 'public UI projection does not rewrite polled state');
  for (const state of ['syncing', 'error']) {
    const syncing = pairPanelView({ ...status, pairing: { ...status.pairing, sync: { state, phase: 'verifying', processed: 10 } } });
    assert.equal(syncing.sync.state, state);
    assert.equal(syncing.sync.phase, 'verifying');
    assert.equal(syncing.sync.processed, 10);
    assert.equal(syncing.sync.verifiedAt, status.replication.verifiedAt);
  }
  const latest = { state: 'ready', sourceAt: now, verifiedAt: now, bytes: 3e6 };
  assert.equal(pairPanelView({ ...status, pairing: { ...status.pairing, sync: latest } }).sync.sourceAt, now);
  for (const role of ['primary', 'protected']) {
    const pairing = { ...status.pairing, role };
    assert.equal(pairPanelView({ ...status, pairing }), pairing, 'an old receipt cannot verify the primary or protected local history');
  }
  assert.deepEqual(pairPanelView({}), { enabled: false });
});
