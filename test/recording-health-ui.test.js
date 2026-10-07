import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingHealth, recordingHealthView, storageBytes } from '../chart/recording-health.js';

const now = Date.parse('2026-10-07T12:00:00Z');
const health = (overrides = {}) => ({ version: 1, checkedAt: now, scope: 'live',
  disk: { state: 'ok', totalBytes: 100e9, freeBytes: 60e9 },
  recording: { state: 'ok', lastRecordedAt: now - 60000 },
  backup: { state: 'available', latestKind: 'saved-copy', latestAt: now - 100 * 86400_000 }, attention: [], ...overrides });

test('backup age is factual, not an invented schedule or present verification', () => {
  const view = recordingHealthView(health(), undefined, now);
  assert.equal(view.backup.label, 'Copy available');
  assert.match(view.backup.evidence, /100 d ago/);
  assert.match(view.backup.verification, /not verified by this status check/);
  assert.deepEqual(view.attention, []);
  assert.doesNotMatch(JSON.stringify(view), /overdue|safe backup|verified copy/);
  const download = recordingHealthView(health({ backup: { state: 'available', latestKind: 'download', latestAt: now } }), undefined, now);
  assert.match(download.backup.verification, /retention.*unknown/);
  const failed = recordingHealthView(health({ backup: { state: 'failed', latestAt: now - 86400_000, lastFailureAt: now } }), undefined, now);
  assert.equal(failed.backup.label, 'Last backup failed');
  assert.match(failed.backup.evidence, /1 d ago/);
  assert.match(failed.backup.activity, /Last failure/);
});

test('snapshot has local disk evidence and read-only recording without inferred stalls', () => {
  const view = recordingHealthView(health({ scope: 'snapshot', recording: { state: 'read-only', lastRecordedAt: now - 7 * 86400_000 } }), undefined, now);
  assert.match(view.scope, /Recorded snapshot.*this computer/);
  assert.equal(view.recording.label, 'Read-only history');
  assert.equal(view.disk.free, '60 GB');
  assert.equal(view.disk.fraction, .6);
  assert.deepEqual(view.attention, []);
});

test('unknown and malformed capacity do not become zero free space or a healthy status', () => {
  for (const disk of [undefined, { totalBytes: 100, freeBytes: null }, { totalBytes: 0, freeBytes: 0 }, { totalBytes: 100, freeBytes: 101 }]) {
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
  const missing = recordingHealthView(health(), { annualBudgetBytes: 10e9, adaptiveMeasurementHours: 0, adaptiveProjectedAnnualBytes: 0 }, now);
  assert.equal(missing.growth.adaptive, 'Collecting evidence');
  assert.equal(missing.growth.database, 'Unknown');
  assert.equal(missing.growth.adaptiveStored, 'Not measured yet');
});


function panelFixture(request = async () => health()) {
  const elements = new Map();
  const document = {
    body: { dataset: {} }, querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, hidden: false,
        style: { setProperty() {} }, setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    },
  };
  let at = now;
  return { document, element: id => document.getElementById(id), advance: ms => { at += ms; },
    panel: createRecordingHealth({ document, request, now: () => at }) };
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
  assert.equal(view.element('recording-health-attention').hidden, false);
  assert.equal(view.element('recording-attention-title').textContent, 'Critically low disk space');
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
  assert.equal(view.element('recording-health-attention').hidden, false);
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  assert.equal(view.element('recording-growth-retained').textContent, '6 GB');
  assert.equal(view.document.body.dataset.recordingHealth, 'true');
  view.panel.update({ recordingHealth: health({ checkedAt: now + 3600_000, scope: 'snapshot' }) });
  assert.doesNotMatch(view.element('recording-health-checked').textContent, /Refresh failed/);
  assert.match(view.element('recording-health-checked').textContent, /just now/);
  assert.equal(view.element('recording-health-attention').hidden, true);
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
  const view=recordingHealthView(health({checkedAt:0,recording:{state:'ok',lastRecordedAt:0},
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
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Refresh overview to retry/);
  view.panel.inventory({generatedAt:0,database:{adaptiveEstimatedBytes:0}});
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/1 Jan 1970/);
  view.panel.inventoryStatus('failed');
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Could not measure.*checked.*1 Jan 1970/);
});
