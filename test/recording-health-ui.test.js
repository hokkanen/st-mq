import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRecordingHealth, recordingHealthView, storageBytes } from '../chart/recording-health.js';

const now = Date.parse('2026-10-07T12:00:00Z');
const health = (overrides = {}) => ({ version: 2, checkedAt: now, scope: 'live',
  disk: { state: 'ok', totalBytes: 100e9, freeBytes: 60e9 },
  recording: { state: 'ok', lastSourceCheckAt: now - 60000 },
  backup: { state: 'available', latestKind: 'saved-copy', latestAt: now - 100 * 86400_000 }, attention: [], ...overrides });

test('backup age is factual, not an invented schedule or present verification', () => {
  const view = recordingHealthView(health(), undefined, now);
  assert.equal(view.backup.label, 'Copy available');
  assert.match(view.backup.evidence, /100 d ago/);
  assert.match(view.backup.verification, /not verified by this status check/);
  assert.deepEqual(view.attention, []);
  assert.doesNotMatch(JSON.stringify(view), /overdue|safe backup|verified copy/);
  const download = recordingHealthView(health({ backup: { state: 'available', latestKind: 'download', latestAt: now } }), undefined, now);
  assert.equal(download.backup.label, 'Download sent');
  assert.doesNotMatch(download.backup.evidence, /completed|saved/i);
  assert.match(download.backup.verification, /retention.*unknown/);
  const failed = recordingHealthView(health({ backup: { state: 'failed', latestAt: now - 86400_000, lastFailureAt: now } }), undefined, now);
  assert.equal(failed.backup.label, 'Last backup failed');
  assert.match(failed.backup.evidence, /1 d ago/);
  assert.match(failed.backup.activity, /Last failure/);
});

test('snapshot has local disk evidence and read-only recording without inferred stalls', () => {
  const view = recordingHealthView(health({ scope: 'snapshot', recording: { state: 'read-only', lastSourceCheckAt: now - 7 * 86400_000 } }), undefined, now);
  assert.match(view.scope, /Recorded snapshot.*this computer/);
  assert.equal(view.recording.label, 'Read-only history');
  assert.equal(view.disk.free, '60 GB');
  assert.equal(view.disk.fraction, .6);
  assert.deepEqual(view.attention, []);
});

test('unknown and malformed capacity do not become zero free space or a healthy status', () => {
  for (const disk of [undefined, { state: 'ok', totalBytes: 100, freeBytes: null }, { state: 'ok', totalBytes: 0, freeBytes: 0 },
    { state: 'ok', totalBytes: 100, freeBytes: 101 }, { state: 'unknown', totalBytes: 100, freeBytes: 80 }]) {
    const view = recordingHealthView(health({ disk }), undefined, now);
    assert.equal(view.disk.free, 'Unknown');
    assert.equal(view.disk.fraction, null);
  }
  assert.equal(storageBytes(0), '0 B');
  assert.equal(storageBytes(null), 'Unknown');
  const unsupported = recordingHealthView({ ...health(), version: 0 }, undefined, now);
  assert.equal(unsupported.recording.label, 'Recording unknown');
  assert.equal(unsupported.backup.label, 'Backup status unknown');
});

test('healthy startup summary expires once, stays hidden through polling, and returns only for attention', () => {
  const view = panelFixture();
  assert.equal(view.element('recording-status').hidden, true);
  view.panel.update({ recordingHealth: health() });
  assert.equal(view.element('recording-status').hidden, false);
  assert.equal(view.element('recording-status-free').textContent, '60 GB free');
  view.expireIntro();
  assert.equal(view.element('recording-status').hidden, true);
  view.panel.update({ recordingHealth: health() });
  assert.equal(view.element('recording-status').hidden, true, 'Ordinary health polling cannot restart the intro');
  view.panel.update({ recordingHealth: health({ recording: { state: 'source-unavailable' }, attention: [
    { id: 'recording', severity: 'warning', title: 'Recording sources are unavailable', detail: 'Check source connections.' },
  ] }) });
  assert.equal(view.element('recording-status').hidden, false);
  assert.equal(view.element('recording-status-state').textContent, 'Sources unavailable');
  view.panel.update({ recordingHealth: health() });
  assert.equal(view.element('recording-status').hidden, true, 'Recovered health returns to the quiet dashboard');
  view.panel.clear();
  assert.equal(view.element('recording-status').hidden, true);
  view.panel.update({ recordingHealth: health() });
  assert.equal(view.element('recording-status').hidden, false, 'A new authenticated session gets its own introduction');
});

test('starting, unknown, failed refresh and stale checks remain visible without claiming current healthy evidence', async () => {
  const view = panelFixture(async () => { throw Error('Synthetic refresh failure'); });
  view.panel.update({ recordingHealth: health({ recording: { state: 'starting' } }) });
  view.expireIntro();
  assert.equal(view.element('recording-status').hidden, false);
  assert.equal(view.element('recording-status').dataset.tone, 'neutral');
  view.panel.update({ recordingHealth: health({ disk: { state: 'unknown' } }) });
  assert.equal(view.element('recording-status').hidden, false);
  assert.equal(view.element('recording-status-free').textContent, 'Space unknown');
  view.panel.update({ recordingHealth: health() });
  view.advance(181_000);
  view.panel.update({});
  assert.equal(view.element('recording-status').hidden, false);
  assert.match(view.element('recording-status-state').textContent, /^Last known:/);
  assert.match(view.element('recording-status-freshness').textContent, /out of date/);
  await view.panel.refresh();
  assert.match(view.element('recording-status-freshness').textContent, /Refresh failed/);
  assert.match(view.element('recording-status-free').textContent, /^Last known:/);
  view.panel.update({ recordingHealth: health({ checkedAt: now + 181_000 }) });
  assert.equal(view.element('recording-status').hidden, true);
});

test('small server clock leads do not label healthy checks as outdated or keep the banner visible', () => {
  for (const lead of [1, 1000, 30_000, 180_000]) {
    const view = panelFixture();
    const response = health({ checkedAt: now + lead });
    view.panel.update({ recordingHealth: response });
    view.expireIntro();
    assert.equal(view.element('recording-status').hidden, true);
    assert.equal(view.element('recording-status-state').textContent, 'Monitoring active');
    assert.equal(view.element('recording-status-free').textContent, '60 GB free');
    assert.equal(view.element('recording-status-freshness').textContent, '');
    assert.equal(response.checkedAt, now + lead, 'The original server timestamp stays intact');
    view.advance(lead + 180_001);
    view.panel.update({});
    assert.equal(view.element('recording-status').hidden, false);
    assert.match(view.element('recording-status-freshness').textContent, /out of date.*3 min ago/);
  }
});

test('large future dates explain clock mismatch without calling a just-now check outdated', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ checkedAt: now + 180_001 }) });
  view.expireIntro();
  assert.equal(view.element('recording-status').hidden, false);
  assert.match(view.element('recording-status-state').textContent, /^Last known:/);
  assert.match(view.element('recording-status-freshness').textContent, /server and browser clocks differ/);
  assert.match(view.element('recording-health-checked').textContent, /ahead of browser clock/);
  assert.doesNotMatch(view.element('recording-status-freshness').textContent, /just now|out of date/);
  view.panel.update({ recordingHealth: health() });
  assert.equal(view.element('recording-status').hidden, true);
  assert.equal(view.element('recording-health-checked').dataset.tone, 'neutral');
});

test('clock tolerance does not extend old checks or hide invalid dates and failed refreshes', async () => {
  assert.equal(recordingHealthView(health({ checkedAt: now - 180_000 }), undefined, now).outdated, false);
  for (const checkedAt of [now - 180_001, null, undefined, NaN, Infinity, -1, String(now)]) {
    const result = recordingHealthView(health({ checkedAt }), undefined, now);
    assert.equal(result.outdated, true);
    assert.equal(result.clockMismatch, false);
  }
  const view = panelFixture(async () => { throw Error('Synthetic refresh failure'); });
  view.panel.update({ recordingHealth: health({ checkedAt: now + 1000 }) });
  view.expireIntro();
  await view.panel.refresh();
  assert.equal(view.element('recording-status').hidden, false);
  assert.match(view.element('recording-status-state').textContent, /^Last known:/);
  assert.match(view.element('recording-status-freshness').textContent, /Refresh failed/);
});

test('issues retain their own explanation and destination, with critical failures first', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ attention: [
    { id: 'backup', severity: 'warning', title: 'The last backup failed', detail: 'Check the export destination.' },
    { id: 'disk-space', severity: 'critical', title: 'Disk space is critically low', detail: 'Make room on this disk.' },
  ] }) });
  const issues = view.element('recording-status-issues').children;
  assert.equal(issues.length, 2);
  assert.equal(issues[0].firstElementChild.dataset.recordingOpen, 'recording-disk-card');
  assert.equal(issues[1].firstElementChild.dataset.recordingOpen, 'recording-backup-card');
  assert.equal(issues[0].firstElementChild.children[1].textContent, ' · Make room on this disk.');
});

test('unsupported health updates preserve the last known warning instead of clearing it', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ recording: { state: 'write-failed' }, attention: [
    { id: 'recording', severity: 'critical', title: 'Database writes are failing', detail: 'Check storage access.' },
  ] }) });
  view.expireIntro();
  for (const recordingHealth of [null, { version: 0 }, { version: 1 }, { version: 3 }]) {
    view.panel.update({ recordingHealth });
    assert.equal(view.element('recording-status').hidden, false);
    assert.equal(view.element('recording-status-issues').children.length, 1);
    assert.match(view.element('recording-status-state').textContent, /Last known:.*write failed/);
    assert.match(view.element('recording-status-freshness').textContent, /Refresh failed/);
    assert.equal(view.document.body.dataset.recordingHealth, 'true');
  }
  view.panel.clear();
  view.panel.update({ recordingHealth: { version: 0 } });
  assert.equal(view.element('recording-status').hidden, true);
  assert.equal(view.document.body.dataset.recordingHealth, 'false');
});

test('adaptive payload target and prospective size remain separate from whole database allocation and growth', () => {
  const view = recordingHealthView(health(), {
    annualBudgetBytes: 10e9, measuredDatabaseBytes: 83e9,
    adaptiveMeasurementHours: 48, adaptiveProjectedAnnualBytes: 8e9,
    adaptiveEstimatedBytes: 40e6, adaptiveAccountingStartedAt: now - 2 * 86400_000,
    totalDatabaseMeasurementHours: 240, totalDatabaseProjectedAnnualBytes: 32e9,
  }, now);
  assert.equal(view.growth.target, '10 GB/year');
  assert.equal(view.growth.adaptive, '8 GB/year');
  assert.equal(view.growth.adaptiveStored, '40 MB');
  assert.match(view.growth.adaptiveSince, /recorded since/);
  assert.equal(view.growth.database, '83 GB');
  assert.equal(view.growth.total, '32 GB/year');
  assert.match(view.growth.totalWindow, /240 h.*allocation/);
  assert.match(view.growth.totalWindow, /7-day smoothing/);
  const missing = recordingHealthView(health(), { annualBudgetBytes: 10e9, adaptiveMeasurementHours: 0, adaptiveProjectedAnnualBytes: 0 }, now);
  assert.equal(missing.growth.adaptive, 'Collecting evidence');
  assert.equal(missing.growth.database, 'Unknown');
  assert.equal(missing.growth.adaptiveStored, 'Not measured yet');
});

test('annualized database growth names its settling period and does not claim a retention-aware size forecast', () => {
  const recording = { totalDatabaseMeasurementHours: 7, totalDatabaseProjectedAnnualBytes: 12e9 };
  const view = recordingHealthView(health(), recording, now);
  assert.equal(view.growth.total, '12 GB/year');
  assert.match(view.growth.totalWindow, /Still settling.*7 h.*allocation measurements/);
  for (const invalid of [null, NaN, Infinity, -1]) {
    const unknown = recordingHealthView(health(), { ...recording, totalDatabaseMeasurementHours: invalid }, now);
    assert.equal(unknown.growth.total, 'Collecting evidence');
  }
  const dashboard = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.match(dashboard, /Annualized recent growth/);
  assert.match(dashboard, /Does not forecast report expiry or database size next year/);
  assert.doesNotMatch(dashboard, /Projected growth/);
});


function panelFixture(request = async () => health()) {
  const elements = new Map();
  function node() {
    return {
      textContent: '', dataset: {}, hidden: false, children: [],
      style: { setProperty() {} }, setAttribute() {}, addEventListener() {},
      get firstElementChild() { return this.children[0]; },
      contains(child) { return child === this || this.children.some(item => item.contains(child)); },
      append(...children) { for (const child of children) this.insertBefore(child, null); },
      insertBefore(child, before) {
        child.remove(); child.parent = this;
        this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
      },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    };
  }
  const document = {
    body: { dataset: {} }, querySelectorAll: () => [], createElement: node,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
  };
  let at = now, expire;
  return { document, element: id => document.getElementById(id), advance: ms => { at += ms; },
    expireIntro: () => expire?.(),
    panel: createRecordingHealth({ document, request, now: () => at,
      setTimer(callback) { expire = callback; return 1; }, clearTimer() { expire = undefined; } }) };
}

test('control responses without health preserve dated warnings, failed-refresh state and retained inventory', async () => {
  const view = panelFixture(async () => { throw Error('Synthetic unavailable health'); });
  view.panel.update({ recordingHealth: health({ attention: [
    { id: 'disk', severity: 'critical', title: 'Critically low disk space', detail: 'Make space for recording.' },
  ] }), recording: { measuredDatabaseBytes: 83e9 } });
  view.panel.inventory({ generatedAt: now, database: { adaptiveEstimatedBytes: 6e9 } });
  const previousCheck = view.element('recording-health-checked').textContent;
  view.advance(3600_000);
  view.panel.update({ now: now + 3600_000, recording: { measuredDatabaseBytes: 84e9 } });
  assert.equal(view.element('recording-status-issues').hidden, false);
  assert.equal(view.element('recording-status-issues').children[0].firstElementChild.children[0].textContent, 'Critically low disk space');
  assert.match(view.element('recording-health-checked').textContent, /1 h ago/);
  assert.equal(view.element('recording-health-checked').textContent.split(' · ')[0], previousCheck.split(' · ')[0],
    'A control response does not renew the original health-check clock');
  assert.equal(view.element('recording-growth-retained').textContent, '6 GB');
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  await view.panel.refresh();
  const failure = view.element('recording-health-checked').textContent;
  assert.match(failure, /Refresh failed/);
  view.panel.update({ now: now + 3600_000 });
  assert.equal(view.element('recording-health-checked').textContent, failure);
  assert.equal(view.element('recording-status-issues').hidden, false);
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  assert.equal(view.element('recording-growth-retained').textContent, '6 GB');
  assert.equal(view.document.body.dataset.recordingHealth, 'true');
  view.panel.update({ recordingHealth: health({ checkedAt: now + 3600_000, scope: 'snapshot' }) });
  assert.doesNotMatch(view.element('recording-health-checked').textContent, /Refresh failed/);
  assert.match(view.element('recording-health-checked').textContent, /just now/);
  assert.equal(view.element('recording-status-issues').hidden, true);
  assert.equal(view.element('recording-growth-retained').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-database').textContent, '84 GB', 'Omitted recording metrics are not replaced');
  view.panel.clear();
  assert.equal(view.document.body.dataset.recordingHealth, 'false');
  assert.equal(view.element('recording-growth-database').textContent, 'Unknown');
});

test('a control response does not supersede an independent pending health refresh', async () => {
  let resolve;
  const view = panelFixture(() => new Promise(done => { resolve = done; }));
  view.panel.update({ recordingHealth: health() });
  const pending = view.panel.refresh();
  view.panel.update({ recording: { measuredDatabaseBytes: 4e9 } });
  assert.equal(view.element('recording-health-refresh').disabled, true);
  resolve(health({ disk: { state: 'critical', totalBytes: 100e9, freeBytes: 1e8 } }));
  await pending;
  assert.equal(view.element('recording-disk-free').textContent, '100 MB');
  assert.equal(view.element('recording-health-refresh').disabled, false);
  assert.equal(view.element('recording-growth-database').textContent, '4 GB');
});

test('an independent health refresh clears inventory when its source scope changes', async () => {
  const view = panelFixture(async () => health({ scope: 'snapshot', recording: { state: 'read-only' } }));
  view.panel.update({ recordingHealth: health() });
  view.panel.inventory({ generatedAt: now, database: { adaptiveEstimatedBytes: 6e9 } });
  await view.panel.refresh();
  assert.equal(view.element('recording-growth-retained').textContent, 'Not checked');
  assert.equal(view.element('recording-recording-state').textContent, 'Read-only history');
});


test('epoch zero is a valid health, backup, recording and adaptive accounting timestamp', () => {
  const view=recordingHealthView(health({checkedAt:0,recording:{state:'ok',lastSourceCheckAt:0},
    backup:{state:'available',latestKind:'saved-copy',latestAt:0}}),
    {adaptiveEstimatedBytes:0,adaptiveAccountingStartedAt:0},0);
  assert.match(view.checked,/1 Jan 1970.*just now/);
  assert.match(view.recording.evidence,/1 Jan 1970.*just now/);
  assert.match(view.backup.evidence,/1 Jan 1970.*just now/);
  assert.equal(view.growth.adaptiveStored,'0 B');
  assert.match(view.growth.adaptiveSince,/1 Jan 1970/);
  assert.equal(recordingHealthView(health({checkedAt:null}),undefined,0).checked,'Health has not been checked yet.');
});

test('retained adaptive size reports loading and failure without inventing size or losing dated evidence', () => {
  const view=panelFixture();
  view.panel.inventoryStatus('loading');
  assert.equal(view.element('recording-growth-retained').textContent,'Measuring…');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Measuring retained adaptive data/);
  view.panel.inventoryStatus('failed');
  assert.equal(view.element('recording-growth-retained').textContent,'Unavailable');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Refresh inventory to retry/);
  view.panel.inventory({generatedAt:0,database:{adaptiveEstimatedBytes:0}});
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/1 Jan 1970/);
  view.panel.inventoryStatus('failed');
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Could not measure.*checked.*1 Jan 1970/);
});

test('storage inventory keeps file sizes and dated retained evidence through failures and clears them on a scope change', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health(), recording: { measuredDatabaseBytes: 83e9 } });
  view.panel.inventoryStatus('loading');
  assert.equal(view.element('recording-growth-file').textContent, 'Measuring…');
  view.panel.inventory({ generatedAt: now, database: { fileBytes: 80e9, walBytes: 0,
    totalFileBytes: 80e9, reusableBytes: 12e9, adaptiveEstimatedBytes: 6e9, adaptiveObservationCount: 0,
    physical: { available: true, observationBytes: 20e9, historyBytes: 30e9, currentBytes: 1e9,
      journalBytes: 10e6, peerBacklogBytes: 5e6, branchBytes: 0, indexBytes: 10e9, internalBytes: 4096 },
    journalRetention: { commits: 1024, payloadBytes: 7e6, maxCommits: 2048, maxBytes: 8e6, baseSequence: 500 } } });
  assert.equal(view.element('recording-growth-database').textContent, '83 GB');
  assert.equal(view.element('recording-growth-file').textContent, '80 GB');
  assert.equal(view.element('recording-growth-wal').textContent, '0 B');
  assert.equal(view.element('recording-growth-files').textContent, '80 GB');
  assert.equal(view.element('recording-growth-reusable').textContent, '12 GB');
  assert.equal(view.element('recording-growth-journalPages').textContent, '10 MB');
  assert.equal(view.element('recording-growth-peerBacklogPages').textContent, '5 MB');
  assert.equal(view.element('recording-growth-branchPages').textContent, '0 B');
  assert.match(view.element('recording-growth-journalRetention').textContent, /1,024 transactions.*7 MB.*transaction 500/);
  assert.equal(view.element('recording-growth-observations').textContent, '0 retained observations.');
  assert.equal(view.element('recording-overview-notice').hidden, true);
  view.advance(3600_000);
  view.panel.inventoryStatus('failed');
  assert.equal(view.element('recording-growth-file').textContent, '80 GB');
  assert.equal(view.element('recording-growth-reusable').textContent, '12 GB');
  assert.match(view.element('recording-growth-fileEvidence').textContent, /Refresh failed.*1 h ago/);
  assert.equal(view.element('recording-overview-notice').hidden, false);
  assert.match(view.element('recording-overview-notice').textContent, /last successful inventory.*Storage & growth/);
  view.panel.update({ recordingHealth: health({ scope: 'snapshot' }) });
  assert.equal(view.element('recording-growth-file').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-wal').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-reusable').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-journalPages').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-peerBacklogPages').textContent, 'Not checked');
  assert.match(view.element('recording-growth-observations').textContent, /unknown/);
  view.panel.inventory({ generatedAt: now, database: { walBytes: null } });
  assert.equal(view.element('recording-growth-wal').textContent, 'Unknown');
  assert.equal(view.element('recording-growth-reusable').textContent, 'Unknown');
});
