import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRecordingHealth, recordingHealthView, recordingEvidenceTime, backupCheckFailure, storageBytes } from '../chart/recording-health.js';
import { createStorageOperationHealth, STORAGE_OPERATION_KINDS } from '../src/storage/operation-health.js';
import { storagePerformanceView, storageDuration, storageOperationsView, storageProblemSummary, storageProblemDetails, storageSchedulingView } from '../chart/storage-health.js';
import { storageHealthFixture } from './helpers/storage-health-fixture.js';

const now = Date.parse('2026-10-07T12:00:00Z');
const health = (overrides = {}) => ({ version: 3, checkedAt: now, scope: 'live',
  disk: { state: 'ok', totalBytes: 100e9, freeBytes: 60e9 },
  backup: { state: 'available', count: 1, totalBytes: 1000, complete: true, latestKind: 'saved-copy', latestAt: now - 100 * 86400_000 }, attention: [], ...overrides,
  recording: { state: 'ok', writer: { state: 'ready' }, lastSourceCheckAt: now - 60000, lastLoopCompletedAt: now - 1000, ...overrides.recording } });

test('backup age is factual, not an invented schedule or present verification', () => {
  const view = recordingHealthView(health(), undefined, now);
  assert.equal(view.backup.label, '1 saved copy');
  assert.match(view.backup.evidence, /100 d ago/);
  assert.deepEqual(view.attention, []);
  assert.doesNotMatch(JSON.stringify(view), /overdue|safe backup|verified copy/);
  const incomplete = recordingHealthView(health({ backup: { state: 'available', count: 3, complete: false, latestAt: now } }), undefined, now);
  assert.equal(incomplete.backup.label, '3 saved copies listed');
  const failed = recordingHealthView(health({ backup: { state: 'failed', latestAt: now - 86400_000, lastFailureAt: now } }), undefined, now);
  assert.equal(failed.backup.label, 'Last backup failed');
  assert.match(failed.backup.evidence, /1 d ago/);
  assert.match(failed.backup.activity, /Last failure/);
});

test('snapshot has local disk evidence and read-only recording without inferred stalls', () => {
  const view = recordingHealthView(health({ scope: 'snapshot', recording: { state: 'read-only', lastSourceCheckAt: now - 7 * 86400_000 } }), undefined, now);
  assert.equal(view.scope, 'On this server · Read-only replica');
  assert.match(view.recording.coverage, /recorded history.*not acquiring/);
  assert.equal(view.recording.label, 'Read-only history');
  assert.equal(view.disk.free, '60 GB');
  assert.equal(view.disk.fraction, .6);
  assert.deepEqual(view.attention, []);
});

test('recording separates completed updates, attempted source checks, observed coverage and successful storage writes', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ scope: 'simulated', recording: {
    state: 'ok', lastLoopCompletedAt: now - 1000, lastSourceCheckAt: now - 60000, lastWriteAt: now - 120000,
    history: performanceHistory(), sources: { observedStreams: 5, usableStreams: 4, attentionStreams: 2, unknownStreams: 1,
      complete: false, truncated: false, issues: [{ id: 'synthetic-stream', label: 'Outdoor temperature', unit: '°C',
        status: 'stale', lastCheckedAt: now - 60000, sourceObservedAt: now - 900000 }] },
  } }) });
  assert.equal(view.element('recording-health-scope').textContent, 'On this server · Simulated recording');
  assert.match(view.element('recording-recording-evidence').textContent, /2 observed measurement streams need attention/);
  assert.match(view.element('recording-recording-loop').textContent, /just now/);
  assert.match(view.element('recording-recording-sourceCheck').textContent, /1 min ago/);
  assert.equal(view.element('recording-recording-observed').textContent, '5');
  assert.equal(view.element('recording-recording-usable').textContent, '4');
  assert.equal(view.element('recording-recording-attention').textContent, '2');
  assert.match(view.element('recording-recording-unknown').textContent, /1 stream has unknown status.*included in Needs attention/);
  assert.match(view.element('recording-recording-coverage').textContent, /never reported are outside.*held reading can be usable and still need attention/);
  assert.match(view.element('recording-performance-lastWrite').textContent, /2 min ago/);
  assert.equal(view.element('recording-recording-sources').children.length, 1);
  assert.match(view.element('recording-recording-sources').children[0].children[2].children[1].textContent, /15 min ago/);
  assert.equal(view.element('recording-performance-state').textContent, 'Caught up', 'Simulation monitors its own writer');
});

const savedCatalog = (overrides = {}) => ({ directory: '/synthetic/recording/backups', checkedAt: now - 60000,
  complete: true, limit: 100, reasons: [], copies: [{ id: 'backup:synthetic', kind: 'backup', filename: 'stmq-synthetic.sqlite',
    label: 'Saved copy', createdAt: now - 86400_000, fileModifiedAt: now - 120000, bytes: 2048,
    verification: { state: 'verified-when-created', at: null } }], ...overrides });

test('backup catalog loads only for an expanded visible admin view and retains dated inventory on failure', async () => {
  let calls = 0, fail = false;
  const view = panelFixture(async path => {
    assert.match(path, /^\/api\/recording-backups/); ++calls;
    if (fail) throw Error('Synthetic private error');
    return savedCatalog();
  });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'family' } });
  view.element('recording-details').open = view.element('recording-backup-card').open = true;
  await view.panel.refreshCopies(); assert.equal(calls, 0);
  view.document.visibilityState = 'hidden';
  view.panel.update({ webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true }); assert.equal(calls, 0);
  view.document.visibilityState = 'visible';
  await view.panel.refreshCopies(); assert.equal(calls, 1);
  assert.equal(view.element('recording-backup-folder').textContent, '/synthetic/recording/backups');
  assert.match(view.element('recording-backup-size').textContent, /1 copy listed.*2 kB/);
  const row = view.element('recording-backup-list').children[0];
  assert.match(row.children[2].textContent, /Export dated.*1 d ago/);
  assert.match(row.children[3].textContent, /Verified during creation.*verification time not recorded.*No later check is available/);
  fail = true; await view.panel.refreshCopies({ force: true, scan: true });
  assert.match(view.element('recording-backup-catalogStatus').textContent, /Could not refresh.*last successful list.*1 min ago/);
  assert.equal(view.element('recording-backup-list').children[0], row);
  assert.doesNotMatch(view.element('recording-backup-catalogStatus').textContent, /private/);
  view.panel.update({ webAccess: { role: 'family' } });
  assert.equal(view.element('recording-backup-list').children.length, 0);
  assert.doesNotMatch(view.element('recording-backup-folder').textContent, /synthetic/);
});

test('backup verification, incomplete metadata, file dates and history review keep separate evidence', async () => {
  let verifying = false, reviewed;
  const view = panelFixture(async (path, body) => {
    if (path.endsWith('/verify')) { assert.deepEqual(body, { sourceId: 'backup:synthetic' }); verifying = true; return { state: 'queued' }; }
    const result = savedCatalog({ complete: false, reasons: ['copy-limit'] });
    result.copies[0].createdAt = null;
    if (verifying) result.copies[0].recheck = { state: 'queued', startedAt: now };
    return result;
  }, { reviewBackup: value => { reviewed = value; } });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  view.element('recording-details').open = view.element('recording-backup-card').open = true;
  await view.panel.refreshCopies();
  const row = view.element('recording-backup-list').children[0];
  assert.match(view.element('recording-backup-catalogStatus').textContent, /Listing is incomplete.*limit of 100 copies/);
  assert.match(row.children[2].textContent, /Creation time not recorded.*file modified.*2 min ago/);
  await row.children[5].children[2].click();
  assert.equal(reviewed.sourceId, 'backup:synthetic');
  await row.children[5].children[1].click();
  assert.equal(row.children[5].children[1].disabled, true, 'The verification action stays unavailable while queued');
  assert.match(row.children[4].textContent, /Waiting for the full verifier/);
  assert.doesNotMatch(row.children[3].textContent, /Full check passed/);
});

test('logout fences late catalogs and download receipts, clearing private paths and filenames', async () => {
  let resolveCatalog, resolveDownload;
  const view = panelFixture(() => new Promise(resolve => { resolveCatalog = resolve; }),
    { downloadBackup: () => new Promise(resolve => { resolveDownload = resolve; }) });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  const pending = view.panel.refreshCopies({ force: true });
  view.panel.clear(); resolveCatalog(savedCatalog()); await pending;
  assert.equal(view.element('recording-backup-list').children.length, 0);
  assert.doesNotMatch(view.element('recording-backup-folder').textContent, /synthetic/);
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  const next = view.panel.refreshCopies({ force: true }); resolveCatalog(savedCatalog()); await next;
  const row = view.element('recording-backup-list').children[0], download = row.children[5].children[0].click();
  assert.equal(row.children[5].children[0].disabled, true);
  view.panel.clear(); resolveDownload('Saved synthetic copy'); await download;
  assert.equal(view.element('recording-backup-list').children.length, 0);
});

test('ordinary health polling cannot unlock an unconfirmed verification request', async () => {
  let resolveVerify, calls = 0;
  const view = panelFixture((path) => {
    if (path.endsWith('/verify')) { ++calls; return new Promise(resolve => { resolveVerify = resolve; }); }
    return Promise.resolve(savedCatalog());
  });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true });
  const verify = view.element('recording-backup-list').children[0].children[5].children[1];
  const pending = verify.click();
  view.panel.update({ recordingHealth: health() });
  assert.equal(verify.disabled, true);
  await verify.click(); assert.equal(calls, 1);
  resolveVerify({ state: 'queued' }); await pending;
});

test('a stale catalog preserves its original check date and explicitly dates the failed refresh attempt', async () => {
  const view = panelFixture(async () => savedCatalog({ stale: true, lastAttemptAt: now, complete: false, reasons: ['folder-unavailable'] }));
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true });
  assert.equal(view.element('recording-backup-state').textContent, 'Last listed: 1 saved copy listed');
  assert.match(view.element('recording-backup-catalogStatus').textContent, /last successful list.*List checked.*1 min ago.*Last list refresh failed.*just now.*backup folder could not be read/);
  assert.doesNotMatch(view.element('recording-backup-catalogStatus').textContent, /limit of 100/);
});

test('a rejected verification keeps its safe receipt through health and catalog refreshes until a newer action', async () => {
  let fail = true;
  const view = panelFixture(async path => {
    if (path.endsWith('/verify')) {
      if (fail) throw Error('Synthetic private verifier detail');
      return { sourceId: 'backup:synthetic', state: 'queued', startedAt: now };
    }
    return savedCatalog();
  });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true });
  const row = view.element('recording-backup-list').children[0], verify = row.children[5].children[1];
  await verify.click();
  const text = row.children[4].textContent;
  assert.match(text, /check could not be started or confirmed/);
  assert.doesNotMatch(text, /private/);
  view.advance(3600_000); view.panel.update({ recordingHealth: health() });
  await view.panel.refreshCopies({ force: true });
  assert.equal(row.children[4].textContent, text);
  fail = false; await verify.click();
  assert.notEqual(row.children[4].textContent, text);
});

test('accepted verification survives an older held catalog and triggers an immediate follow-up request', async () => {
  let calls = 0, releaseCatalog;
  const view = panelFixture(path => {
    if (path.endsWith('/verify')) return Promise.resolve({ sourceId: 'backup:synthetic', state: 'queued', startedAt: now });
    ++calls;
    if (calls === 2) return new Promise(resolve => { releaseCatalog = resolve; });
    const result = savedCatalog();
    if (calls > 2) result.copies[0].recheck = { sourceId: 'backup:synthetic', state: 'running', startedAt: now };
    return Promise.resolve(result);
  });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  view.element('recording-details').open = view.element('recording-backup-card').open = true;
  await view.panel.refreshCopies({ force: true });
  const row = view.element('recording-backup-list').children[0], verify = row.children[5].children[1];
  const earlier = view.panel.refreshCopies({ force: true });
  await verify.click();
  assert.match(row.children[4].textContent, /Waiting for the full verifier/);
  assert.equal(verify.disabled, true);
  const old = savedCatalog(); old.copies[0].recheck = { state: 'complete', startedAt: now - 1000, finishedAt: now - 500 };
  releaseCatalog(old); await earlier;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 3, 'The held response dispatches the requested follow-up immediately');
  assert.match(row.children[4].textContent, /Checking the complete copy/);
  assert.doesNotMatch(row.children[3].textContent, /Full check passed/);
});

test('a vanished verification row keeps polling its top-level active operation until a terminal result', async () => {
  let state = 'running', calls = 0;
  const view = panelFixture(async () => { ++calls; return savedCatalog({ copies: [],
    recheck: { sourceId: 'backup:synthetic', state, startedAt: now, finishedAt: state === 'changed' ? now : null } }); });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  view.element('recording-details').open = view.element('recording-backup-card').open = true;
  await view.panel.refreshCopies({ force: true });
  assert.match(view.element('recording-backup-catalogStatus').textContent, /no longer listed.*full check is still in progress/);
  assert([...view.timers.values()].some(timer => timer.ms === 2000));
  state = 'changed'; view.fireTimer(2000); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 2);
  assert(![...view.timers.values()].some(timer => timer.ms === 2000));
});

test('fresh server changed or missing rechecks withdraw an older local verification result', async () => {
  let check = null;
  const view = panelFixture(async path => {
    if (path.endsWith('/verify')) { check = { sourceId: 'backup:synthetic', state: 'complete', startedAt: now - 1000, finishedAt: now }; return check; }
    const result = savedCatalog(); if (check) result.copies[0].recheck = check;
    return result;
  });
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true });
  const row = view.element('recording-backup-list').children[0];
  await row.children[5].children[1].click();
  assert.match(row.children[3].textContent, /Full check passed/);
  check = { ...check, state: 'changed' }; await view.panel.refreshCopies({ force: true });
  assert.doesNotMatch(row.children[3].textContent, /Full check passed/);
  assert.match(row.children[4].textContent, /file changed/);
  check = null; await view.panel.refreshCopies({ force: true });
  assert.equal(row.children[4].textContent, '');
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

test('both summary and a retained recording issue follow source and storage transitions', () => {
  const view = panelFixture();
  const recordingIssue = [{ id: 'recording', severity: 'warning', title: 'Recording needs attention', detail: 'Synthetic reason.' }];
  let originalIssue;
  for (const [state, target] of [['source-unavailable', 'recording-recording-card'], ['write-waiting', 'recording-performance-details'],
    ['write-failed', 'recording-performance-details'], ['stalled', 'recording-recording-card'], ['source-unavailable', 'recording-recording-card']]) {
    view.panel.update({ recordingHealth: health({ recording: { state }, attention: recordingIssue }) });
    const issue = view.element('recording-status-issues').children[0];
    if (!originalIssue) originalIssue = issue;
    assert.equal(issue, originalIssue, 'Updating the target does not replace the focusable issue');
    assert.equal(issue.firstElementChild.dataset.recordingOpen, target);
    assert.equal(issue.firstElementChild.href, `#${target}`);
    assert.equal(view.element('recording-status-recording').dataset.recordingOpen, target);
    assert.equal(view.element('recording-status-recording').href, `#${target}`);
  }
});

test('unsupported health updates preserve the last known warning instead of clearing it', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ recording: { state: 'write-failed' }, attention: [
    { id: 'recording', severity: 'critical', title: 'Database writes are failing', detail: 'Check storage access.' },
  ] }) });
  view.expireIntro();
  for (const recordingHealth of [null, { version: 0 }, { version: 1 }, { version: 2 }]) {
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
  assert.equal(Object.hasOwn(view.growth, 'database'), false, 'Retained allocation belongs to the inventory snapshot');
  assert.equal(view.growth.total, '32 GB/year');
  assert.match(view.growth.totalWindow, /240 h.*allocation/);
  assert.match(view.growth.totalWindow, /7-day smoothing/);
  const missing = recordingHealthView(health(), { annualBudgetBytes: 10e9, adaptiveMeasurementHours: 0, adaptiveProjectedAnnualBytes: 0 }, now);
  assert.equal(missing.growth.adaptive, 'Collecting evidence');
  assert.equal(Object.hasOwn(missing.growth, 'database'), false);
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


function panelFixture(request = async () => health(), options = {}) {
  const elements = new Map(), documentListeners = new Map();
  function node() {
    const listeners = new Map(), attributes = new Map();
    return {
      textContent: '', dataset: {}, hidden: false, children: [],
      style: { setProperty() {} }, setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      addEventListener(name, callback) { listeners.set(name, callback); },
      click() { return listeners.get('click')?.({ button: 0, preventDefault() {} }); },
      emit(name) { return listeners.get(name)?.(); },
      focus() { document.activeElement = this; },
      querySelector() { return this.children[0] ?? null; },
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
    body: { dataset: { authenticated: 'true' } }, visibilityState: 'visible', querySelectorAll: () => [], createElement: node,
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
  };
  let at = now, expire, introId, timerSequence = 0;
  const timers = new Map();
  return { document, element: id => document.getElementById(id), advance: ms => { at += ms; }, documentListeners,
    expireIntro: () => expire?.(),
    timers,
    fireTimer(ms) {
      const [id, timer] = [...timers].reverse().find(([, item]) => item.ms === ms) ?? [];
      if (timer) { timers.delete(id); return timer.callback(); }
    },
    panel: createRecordingHealth({ document, request, ...options, now: () => at,
      setTimer(callback, ms) { const id = ++timerSequence; timers.set(id, { callback, ms }); if (ms === 15000) { expire = callback; introId = id; } return id; },
      clearTimer(id) { timers.delete(id); if (id === introId) expire = undefined; } }) };
}

test('new chart reconstruction links open all enclosing history folds without changing chart state', () => {
  const view = panelFixture();
  const outer = view.element('recording-details'), target = view.element('model-reconstruction-details');
  target.parentElement = { closest: () => outer };
  outer.parentElement = { closest: () => null };
  let scrolled = false;
  target.scrollIntoView = () => { scrolled = true; };
  const summary = { focus() { view.document.activeElement = this; } };
  target.querySelector = () => summary;
  const link = { dataset: { recordingOpen: 'model-reconstruction-details' } };
  const event = { button: 0, target: { closest: () => link }, preventDefault() { this.prevented = true; } };
  view.documentListeners.get('click')(event);
  assert.equal(target.open, true); assert.equal(outer.open, true);
  assert.equal(view.document.activeElement, summary); assert.equal(scrolled, true); assert.equal(event.prevented, true);
  const modified = { ...event, ctrlKey: true, prevented: false };
  view.documentListeners.get('click')(modified); assert.equal(modified.prevented, false, 'Modified navigation retains browser behavior');
});

function performanceHistory(overrides = {}) {
  const timing = { count: 820, meanMs: 8.5, p95Ms: 20, maxMs: 540 };
  const day = { requestedMs: 86400_000, monitoredMs: 6 * 3600_000, coveredMs: 6 * 3600_000, complete: false,
    queueDelay: timing, transactionDuration: { ...timing, count: 640, meanMs: 18, maxMs: 780 },
    commitDuration: { ...timing, count: 640, meanMs: 12, maxMs: 520 },
    journalSealDuration: { ...timing, count: 639, meanMs: 3, p95Ms: 8, maxMs: 120 },
    nativeCommitDuration: { ...timing, count: 639, meanMs: 9, p95Ms: 12, maxMs: 400 },
    controlQueueDelay: { ...timing, count: 60 }, normalQueueDelay: { ...timing, count: 760 },
    contention: { episodes: 3, totalMs: 925, maxMs: 600, active: false },
    peakPending: 8, failedWrites: 0, queueRejected: 0, commandsNotSent: 0, controlRequestsBlocked: 0, incidents: [], committedTransactions: 640,
    beginDuration: { ...timing, count: 640, meanMs: 1 }, bodyDuration: { ...timing, count: 640, meanMs: 5 },
    backgroundQueueDelay: timing, backgroundRunDuration: timing, checkpointDuration: { ...timing, count: 12, meanMs: 60, maxMs: 900 },
    backgroundFailedJobs: 0, backgroundQueueRejected: 0, backgroundCancelledJobs: 0, checkpointFailures: 0,
    transactionAttempts: 645, failedJobs: 1, cancelledJobs: 2, postCommitFailures: 1 };
  return { version: 3, retentionMs: 7 * 86400_000, resolutionMs: 300_000,
    startedAt: now - 6 * 3600_000, checkedAt: now, elapsedMs: 6 * 3600_000,
    current: { pending: 0, oldestPendingMs: null, waitingMs: null, activeJobs: 0 },
    windows: { day, week: { ...day, requestedMs: 7 * 86400_000, failedWrites: 2, peakPending: 18 } }, ...overrides };
}

test('storage scheduling renders actual policy, background ownership and separate checkpoint timings', () => {
  const storage = storageHealthFixture(now);
  storage.configuration.checkpoint.triggerFrames = 37;
  storage.configuration.checkpoint.maxDirtyMs = 7200;
  storage.queue.active = { priority: 'background', kind: 'checkpoint', phase: 'exclusive', elapsedMs: 1200 };
  storage.queue.lanes.control.queued = 1; storage.queue.lanes.normal.queued = 2;
  storage.queue.lanes.background.running = 1; storage.checkpoint.state = 'running';
  const value = health({ recording: { history: performanceHistory(), storage } });
  const view = storageSchedulingView(value, { now });
  assert.match(view.checkpointPolicy, /37 outstanding frames.*7.2 s.*not a frame cap/);
  assert.doesNotMatch(view.checkpointPolicy, /50 outstanding frames/);
  assert.match(view.policy, /Chart cache waits for all other work/);
  assert.equal(view.execution, 'Dedicated worker'); assert.equal(view.durability, 'WAL · synchronous FULL');
  assert.equal(view.active, 'WAL checkpoint · 1.2 s elapsed');
  assert.match(view.checkpointFrames, /12 outstanding of 82 WAL frames/);
  assert.equal(storagePerformanceView(value, 'day', { now }).state, '3 saves waiting');
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-checkpoint-worst').textContent, '900 ms');
  assert.equal(dashboard.element('recording-performance-commit-worst').textContent, '520 ms');
  assert.equal(dashboard.element('recording-performance-body-mean').textContent, '5 ms');
  assert.equal(dashboard.element('recording-performance-checkpoint-history').hidden, false);
  const disclosure = dashboard.element('recording-performance-scheduling'); disclosure.open = true;
  disclosure.append(dashboard.document.createElement('summary'));
  disclosure.querySelector('summary').focus(); dashboard.panel.update({ recordingHealth: value });
  assert.equal(disclosure.open, true); assert.equal(dashboard.document.activeElement, disclosure.querySelector('summary'));
  storage.queue.active = null; storage.queue.lanes.control.queued = storage.queue.lanes.normal.queued = 0;
  storage.queue.lanes.background.queued = 1; storage.queue.lanes.background.running = 0; storage.checkpoint.state = 'queued';
  value.recording.history.current.pending = 1;
  assert.equal(storagePerformanceView(value, 'day', { now }).state, 'Background storage queued');
});

test('periodic, automatic and read-only storage describe their own policy without an invented frame trigger', () => {
  const storage = storageHealthFixture(now), value = health({ recording: { storage } });
  storage.configuration.checkpoint = { mode: 'periodic-passive', autoCheckpointFrames: 0,
    pollMs: 250, triggerFrames: null, maxDirtyMs: null, fallbackPollMs: 1000 };
  let view = storageSchedulingView(value, { now });
  assert.match(view.checkpointPolicy, /every 1 s; no frame-count trigger/);
  assert.doesNotMatch(view.checkpointPolicy, /50|5 s/);
  storage.configuration.checkpoint = { mode: 'automatic', autoCheckpointFrames: 1234 };
  view = storageSchedulingView(value, { now });
  assert.equal(view.separate, false); assert.match(view.checkpointPolicy, /within a commit at 1,234/);
  storage.configuration.execution = 'read-only'; storage.configuration.checkpoint.mode = 'not-owned';
  storage.writer.state = 'read-only'; value.scope = 'snapshot';
  view = storageSchedulingView(value, { now });
  assert.match(view.checkpointPolicy, /does not own checkpoint scheduling/);
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-state').textContent, 'Read-only storage');
  assert.equal(dashboard.element('recording-performance-storage-current').hidden, false);
  assert.equal(dashboard.element('recording-performance-data').hidden, true);
  assert.equal(dashboard.element('recording-performance-background-history').hidden, true);
});

test('checkpoint failures stay distinct from confirmed saves, and stale or missing policy remains explicit', () => {
  const storage = storageHealthFixture(now), history = performanceHistory();
  history.windows.day.failedJobs = history.windows.day.postCommitFailures = 0;
  const value = health({ recording: { storage, history } });
  storage.checkpoint.state = 'failed'; storage.checkpoint.lastFailureAt = now - 100;
  history.windows.day.checkpointFailures = 1; history.windows.day.backgroundFailedJobs = 1;
  let view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.state, 'Checkpoint needs attention'); assert.equal(view.failed, '0');
  assert.equal(view.problemsObserved, true);
  assert.match(storageSchedulingView(value, { now }).checkpointFailure, /does not undo a confirmed save/);
  const dashboard = panelFixture();
  dashboard.panel.update({ recordingHealth: { ...value, attention: [{ id: 'storage-checkpoint', severity: 'warning',
    title: 'WAL checkpoint needs attention', detail: 'The last background checkpoint request failed.' }] } });
  assert.equal(dashboard.element('recording-status-issues').children[0].firstElementChild.dataset.recordingOpen, 'recording-performance-details');
  storage.checkpoint.state = 'idle';
  view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.state, 'Caught up'); assert.equal(view.problemsObserved, true);
  assert.match(storageSchedulingView(value, { now, unavailable: true }).active, /^Last known:/);
  value.recording.storage = { version: 2, scope: 'local-store' };
  assert.equal(storageSchedulingView(value, { now }).execution, 'Unknown');
  assert.match(storageSchedulingView(value, { now }).checkpointPolicy, /unavailable/);
});

test('storage performance names run coverage and separates queue, transaction, commit and unsuccessful operations', () => {
  const value = health({ recording: { history: performanceHistory() } });
  const view = storagePerformanceView(value, 'day', { now });
  assert.match(view.coverage, /Past day.*6 h monitored.*partial run/);
  assert.match(view.scope, /This storage run started.*Earlier time is not monitored/);
  assert.equal(view.current, 'No queued operations');
  assert.equal(view.queue.mean, '8.5 ms');
  assert.equal(view.queue.p95, '20 ms');
  assert.equal(view.queue.worst, '540 ms');
  assert.equal(view.transaction.worst, '780 ms');
  assert.equal(view.commit.worst, '520 ms');
  assert.equal(view.journalSeal.worst, '120 ms');
  assert.equal(view.nativeCommit.worst, '400 ms');
  assert.equal(view.journalSeal.samples, '639 measured seals');
  assert.equal(view.nativeCommit.samples, '639 measured SQLite commits');
  assert.equal(view.queue.samples, '820 completed queued operations');
  assert.equal(view.transaction.samples, '640 committed transactions');
  assert.equal(view.contention, '3');
  assert.equal(view.contentionDetail, '925 ms total · 600 ms worst');
  assert.equal(view.failed, '0');
  assert.equal(view.postCommit, '1');
  assert.equal(storagePerformanceView(value, 'week', { now }).failed, '2');
  value.recording.history.current.waitingMs = 0;
  assert.equal(storagePerformanceView(value, 'day', { now }).waiting, 'Waiting for the writer lock · 0 ms so far');
  assert.equal(storageDuration(0), '0 ms');
  assert.equal(storageDuration(null), 'Unknown');
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(([row]) => row);
  const timingRow = name => rows.find(row => row.includes(`id="recording-performance-${name}-samples"`));
  assert.match(timingRow('transaction'), /Transaction[\s\S]*Whole successful attempt/);
  assert.match(timingRow('commit'), /Commit &amp; confirmation[\s\S]*Within the transaction/);
  assert.match(timingRow('journalSeal'), /Journal sealing[\s\S]*Within commit &amp; confirmation/);
  assert.match(timingRow('nativeCommit'), /SQLite COMMIT[\s\S]*Within commit &amp; confirmation/);
  assert.match(html, /do not add them/);
  assert.match(html, /SQLite COMMIT includes its native synchronization; with separate checkpoint scheduling it excludes the later checkpoint/);
  assert.match(html, /None of these timings isolates fsync/);
});

test('storage performance absence, zero samples, zero coverage and unsupported scope do not become healthy history', () => {
  const history = performanceHistory();
  const value = health({ recording: { history } });
  history.windows.day.coveredMs = 0;
  history.windows.day.monitoredMs = 0;
  history.windows.day.queueDelay = { count: 0, meanMs: null, p95Ms: null, maxMs: null };
  let view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.queue.mean, 'No samples');
  assert.equal(view.failed, 'Not monitored');
  assert.match(view.coverage, /0 ms monitored.*partial run/);
  history.windows.day.queueDelay = undefined;
  view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.queue.mean, 'Unknown');
  assert.equal(view.queue.samples, 'Sample count unknown');
  history.windows.day.journalSealDuration = { count: 0, meanMs: null, p95Ms: null, maxMs: null };
  history.windows.day.nativeCommitDuration = undefined;
  view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.journalSeal.mean, 'No samples');
  assert.equal(view.nativeCommit.mean, 'Unknown');
  for (const invalid of [undefined, null, { version: 0 }, { version: 1 }, { version: 2 }]) {
    assert.equal(storagePerformanceView(health({ recording: { history: invalid } }), 'day', { now }).available, false);
  }
  for (const scope of ['snapshot', 'history']) {
    view = storagePerformanceView(health({ scope, recording: { history } }), 'day', { now });
    assert.equal(view.available, false);
    assert.equal(view.activityTitle, 'Local activity');
    assert.equal(view.current, '');
    assert.match(view.notice, scope === 'snapshot' ? /live controller.*memory.*not included.*snapshot/ : /not monitored.*history viewer/);
  }
  assert.doesNotThrow(() => storagePerformanceView(health({ recording: { history: performanceHistory({ startedAt: Number.MAX_VALUE }) } }), 'day', { now }));
});

test('mature rolling storage coverage distinguishes a summarized boundary from an unmonitored pre-run period', () => {
  const history = performanceHistory({ elapsedMs: 3 * 86400_000 });
  history.windows.day.monitoredMs = 86400_000;
  history.windows.day.coveredMs = 86400_000 - 240_000;
  const view = storagePerformanceView(health({ recording: { history } }), 'day', { now });
  assert.equal(view.coverage, 'Past day · 24 h monitored');
  assert.equal(view.precision, '23 h 56 min summarized. The oldest partial five-minute interval is excluded.');
  assert.doesNotMatch(view.scope, /Earlier time is not monitored/);
  history.windows.week.monitoredMs = 7 * 86400_000;
  history.windows.week.coveredMs = 7 * 86400_000 - 240_000;
  const week = storagePerformanceView(health({ recording: { history } }), 'week', { now });
  assert.equal(week.coverage, 'Past week · 7 d monitored');
  assert.equal(week.precision, '6 d 23 h 56 min summarized. The oldest partial five-minute interval is excluded.');
});

test('storage performance period stays local across polling and failed refresh while restart replaces history and logout clears it', async () => {
  const view = panelFixture(async () => { throw Error('Private fixture failure'); });
  const value = health({ recording: { history: performanceHistory() } });
  view.panel.update({ recordingHealth: value });
  assert.equal(view.element('recording-performance-live-title').textContent, 'Current activity');
  assert.match(view.element('recording-performance-evidence').textContent, /^Checked /);
  assert.equal(view.element('recording-performance-coverage').textContent, 'Writer · Past day · 6 h monitored · partial run');
  assert.match(view.element('recording-performance-history-state').textContent, /^Earlier problems.*past day$/);
  assert.equal(view.element('recording-performance-history-state').dataset.tone, 'historical');
  assert.equal(view.element('recording-performance-details').dataset.tone, 'neutral', 'Historical problems do not label a caught-up writer as failed');
  assert.equal(view.element('recording-performance-outcome').textContent, 'Problems were observed in this period. Current activity is shown separately.');
  assert.equal(view.element('recording-performance-journalSeal-worst').textContent, '120 ms');
  assert.equal(view.element('recording-performance-nativeCommit-worst').textContent, '400 ms');
  view.element('recording-performance-week').click();
  assert.equal(view.element('recording-performance-week').getAttribute('aria-pressed'), 'true');
  assert.match(view.element('recording-performance-coverage').textContent, /Past week/);
  assert.equal(view.element('recording-performance-failed').textContent, '2');
  view.panel.update({ recordingHealth: value });
  assert.equal(view.element('recording-performance-week').getAttribute('aria-pressed'), 'true');
  await view.panel.refresh();
  assert.match(view.element('recording-performance-notice').textContent, /Refresh failed.*last known/);
  assert.equal(view.element('recording-performance-live-title').textContent, 'Last known activity');
  assert.match(view.element('recording-performance-current').textContent, /^Last known: No queued operations/);
  assert.equal(view.element('recording-performance-failed').textContent, '2');
  const reset = performanceHistory({ startedAt: now, elapsedMs: 0 });
  reset.windows.week = { ...reset.windows.week, coveredMs: 0, monitoredMs: 0, failedWrites: 0, queueDelay: { count: 0 } };
  view.panel.update({ recordingHealth: health({ recording: { history: reset } }) });
  assert.equal(view.element('recording-performance-failed').textContent, 'Not monitored');
  assert.equal(view.element('recording-performance-queue-mean').textContent, 'No samples');
  assert.equal(view.element('recording-performance-week').getAttribute('aria-pressed'), 'true');
  view.panel.clear();
  assert.equal(view.element('recording-performance-live-title').textContent, 'Local activity');
  assert.equal(view.element('recording-performance-data').hidden, true);
  assert.equal(view.element('recording-performance-day').getAttribute('aria-pressed'), 'true');
  assert.equal(view.element('recording-performance-history-state').textContent, '');
  assert.equal(view.element('recording-performance-history-state').hidden, true);
});

test('storage summary distinguishes current queue work from historical save and MQTT-command outcomes', () => {
  const history = performanceHistory();
  const value = health({ recording: { state: 'ok', history } });
  history.windows.day.postCommitFailures = 0; history.windows.day.failedJobs = 0;
  let view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.state, 'Caught up');
  assert.equal(view.evidence, 'Past day · 6 h monitored');
  assert.equal(view.historyState, 'No monitored failures observed');
  assert.equal(view.outcome, 'No monitored failures observed during this period.');
  assert.equal(view.stateTone, 'neutral');
  history.windows.day.failedJobs = 1;
  assert.equal(storagePerformanceView(value, 'day', { now }).historyState, 'Problems observed', 'A failed queued operation cannot coexist with a no-failures headline');
  history.windows.day.failedJobs = 0;
  history.windows.day.failedWrites = 2;
  history.windows.day.queueRejected = 1;
  history.windows.day.commandsNotSent = 3;
  view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.state, 'Caught up', 'A past failure does not imply current backlog');
  assert.equal(view.evidence, 'Past day · 6 h monitored');
  assert.equal(view.historyState, 'Problems observed');
  assert.equal(view.outcome, 'Problems observed during this period.');
  assert.equal(view.failed, '2'); assert.equal(view.rejected, '1'); assert.equal(view.commandsNotSent, '3');
  assert.equal(view.historyTone, 'warning');
  history.current = { pending: 6, oldestPendingMs: 850, waitingMs: 600, activeJobs: 1 };
  view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.state, 'Waiting for storage');
  assert.match(view.current, /6 queued.*oldest 850 ms.*1 running/);
  history.current.waitingMs = null;
  assert.equal(storagePerformanceView(value, 'day', { now }).state, '6 operations queued');
  history.current = { pending: 0, oldestPendingMs: null, waitingMs: null, activeJobs: 1 };
  assert.equal(storagePerformanceView(value, 'day', { now }).state, 'Writing');
  value.recording.state = 'write-failed';
  assert.equal(storagePerformanceView(value, 'day', { now }).state, 'Save failed');
  assert.equal(storagePerformanceView(value, 'day', { now, unavailable: true }).state, 'Last known: Save failed');
  history.windows.day.commandsNotSent = null;
  history.windows.day.failedWrites = 0; history.windows.day.queueRejected = 0;
  assert.doesNotMatch(storagePerformanceView(value, 'day', { now }).historyState, /no failures observed/i);
});

test('local operations render actual collector outcomes in standby and preserve disclosure and focus across polls', () => {
  let tick = 0;
  const observer = createStorageOperationHealth({ clock: () => now - 1000 + tick, monotonic: () => tick });
  const operation = observer.begin('learning-publication', { queued: true, scope: 'standby' });
  tick = 20; operation.start(); tick = 80;
  operation.finish('failed', { reason: 'committed-followup-failed', committed: true });
  tick = 1000;
  const value = health({ scope: 'snapshot', operations: observer.status(), recording: { history: null } });
  const rendered = storageOperationsView(value, 'day', { now });
  assert.equal(rendered.available, true);
  assert.equal(rendered.rows.length, 1, 'Only task types with activity or outcomes occupy the main view');
  assert.equal(rendered.groups[0].label, 'Learning & recovery');
  const publication = rendered.rows.find(row => row.kind === 'learning-publication');
  assert.equal(publication.summary, 'Earlier problems');
  assert.match(publication.latest, /Local standby.*save committed; follow-up work failed.*commit was confirmed/i);
  assert.match(publication.duration, /Average 80 ms.*worst 80 ms.*1 finished task/);
  assert.equal(rendered.rows.some(row => row.kind === 'csv-import'), false);
  assert.equal(rendered.coverage.some(row => row.kind === 'csv-import'), false, 'Separate CLI processes are explained once, not rendered as missing app capabilities');
  assert.match(rendered.evidence, /On this computer.*application started/);
  assert.match(storageOperationsView(value, 'week', { now, unavailable: true }).evidence, /^Last known.*On this computer/);
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-data').hidden, true);
  assert.match(dashboard.element('recording-performance-history-state').textContent, /^Earlier problems.*past day$/);
  assert.equal(dashboard.element('recording-health-badge').textContent, 'Earlier problems');
  assert.equal(dashboard.element('recording-health-badge').dataset.tone, 'historical');
  const rows = dashboard.element('recording-performance-operation-list').children[0].children[1].children;
  const node = rows.find(row => row.dataset.kind === 'learning-publication');
  node.open = true; node.children[0].focus();
  dashboard.panel.update({ recordingHealth: value });
  assert.equal(rows.find(row => row.dataset.kind === 'learning-publication'), node);
  assert.equal(node.open, true); assert.equal(dashboard.document.activeElement, node.children[0]);
  dashboard.panel.clear(); assert.equal(dashboard.element('recording-performance-operation-list').children.length, 0);
  assert.equal(storageOperationsView({ ...value, version: 2 }, 'day', { now }).available, false);
});

test('every current task type has a UI label and a diagnostic group when work is observed', () => {
  const observer = createStorageOperationHealth({ clock: () => now, monotonic: () => 0 });
  for (const kind of STORAGE_OPERATION_KINDS) observer.begin(kind).finish('completed');
  const view = storageOperationsView(health({ operations: observer.status() }), 'day', { now });
  assert.deepEqual(new Set(view.rows.map(row => row.kind)), new Set(STORAGE_OPERATION_KINDS));
  assert.deepEqual(new Set(view.groups.flatMap(group => group.rows.map(row => row.kind))), new Set(STORAGE_OPERATION_KINDS));
  assert(view.rows.every(row => row.label && row.summary === '1 completed'));
  assert.equal(view.groups.length, 4);
});

test('local activity, dated failures and later results remain separate across period selection', () => {
  let tick = 0;
  const observer = createStorageOperationHealth({ clock: () => now - 2000 + tick, monotonic: () => tick });
  observer.register('backup-catalog');
  observer.begin('learning-rebuild').finish('failed', { reason: 'operation-failed' });
  tick = 1000;
  observer.begin('learning-rebuild').finish('completed');
  observer.begin('learning-rebuild');
  tick = 2000;
  const value = health({ operations: observer.status(), recording: { history: null } });
  const view = storageOperationsView(value, 'day', { now });
  const row = view.rows.find(row => row.kind === 'learning-rebuild');
  assert.equal(row.summary, '1 running');
  assert.match(row.latest, /^Completed/);
  assert.match(row.problemDetail, /^Failed/);
  assert.equal(view.rows.some(row => row.kind === 'backup-catalog'), false);
  assert.equal(view.coverage.find(row => row.kind === 'backup-catalog').known, true);
  assert.equal(storageProblemSummary(value, { now }).problems, true);
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  const summary = dashboard.element('recording-performance-history-state').textContent;
  dashboard.element('recording-performance-week').click();
  assert.equal(dashboard.element('recording-performance-history-state').textContent, summary);
  assert.match(dashboard.element('recording-performance-local-activity').textContent, /1 active task type/);
  assert.equal(recordingHealthView(value, undefined, now).attention.length, 0, 'Historical evidence does not invent a current fault');
  assert.equal(storageOperationsView({ ...value, operations: { ...value.operations, version: 1 } }, 'day', { now }).available, false);
});

test('writer availability is independent of queue emptiness and historical coverage', () => {
  for (const history of [performanceHistory(), null, { version: 1 }]) {
    const value = health({ recording: { state: 'writer-unavailable', writer: { state: 'unavailable' },
      lastWriteAt: now - 1000, history } });
    const view = storagePerformanceView(value, 'day', { now });
    assert.equal(view.state, 'Writer unavailable');
    assert.equal(view.stateTone, 'critical');
    assert.match(view.detail, /New changes cannot be saved/);
    assert.equal(view.currentVisible, true);
    assert.match(storagePerformanceView(value, 'day', { now, unavailable: true }).state, /^Last known: Writer unavailable$/);
    assert.equal(recordingHealthView(value, undefined, now).settled, false);
  }
  for (const writer of [undefined, null, {}, { state: 'retired-ready' }]) {
    const value = health({ recording: { writer, history: performanceHistory() } });
    const view = storagePerformanceView(value, 'day', { now });
    assert.equal(view.state, 'Storage status unknown', 'An empty queue cannot establish writer availability');
    const summary = recordingHealthView(value, undefined, now);
    assert.equal(summary.recording.summaryLabel, 'Storage status unknown');
    assert.equal(summary.recording.target, 'recording-performance-details');
  }
});

test('selecting an older problem does not change the past-day overview or current activity', () => {
  let tick = 0;
  const observer = createStorageOperationHealth({ clock: () => now - 2 * 86400_000 + tick, monotonic: () => tick });
  observer.begin('learning-rebuild').finish('failed');
  tick = 2 * 86400_000;
  observer.begin('history-query');
  const value = health({ operations: observer.status(), recording: { history: null } });
  assert.equal(storageOperationsView(value, 'day', { now }).problemsObserved, false);
  assert.equal(storageOperationsView(value, 'week', { now }).problemsObserved, true);
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  const activity = dashboard.element('recording-performance-local-activity').textContent;
  assert.equal(dashboard.element('recording-health-badge').hidden, true);
  dashboard.element('recording-performance-week').click();
  assert.match(dashboard.element('recording-performance-outcome').textContent, /Problems were observed/);
  assert.equal(dashboard.element('recording-performance-local-activity').textContent, activity);
  assert.equal(dashboard.element('recording-performance-history-state').hidden, true);
  assert.equal(dashboard.element('recording-health-badge').hidden, true);
});

test('missing selected-period history cannot conceal known running work or bounded active details', () => {
  const observer = createStorageOperationHealth({ clock: () => now, monotonic: () => 0 });
  for (let index = 0; index < 130; index++) observer.begin('history-query');
  const operations = observer.status();
  const query = operations.coverage.find(row => row.kind === 'history-query');
  query.week = null;
  const value = health({ operations });
  const day = storageOperationsView(value, 'day', { now });
  const week = storageOperationsView(value, 'week', { now });
  assert.equal(week.activity, day.activity);
  assert.equal(week.activeRows[0].summary, '130 running');
  assert.equal(week.activeRows[0].outcomes, 'Outcomes unknown');
  assert.match(week.activeRows[0].activeDetails, /127 more active tasks$/);
  assert.match(week.activeRows[0].coverage, /period coverage is unknown/);
});

test('ordinary saving is quiet while confirming and unavailable writers keep actionable attention', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health() }); view.expireIntro();
  const saving = health({ recording: { writer: { state: 'saving' }, history: performanceHistory({
    current: { pending: 0, activeJobs: 1, oldestPendingMs: null, waitingMs: null } }) } });
  view.panel.update({ recordingHealth: saving });
  assert.equal(view.element('recording-status').hidden, true, 'Normal asynchronous work does not revive the warning strip');
  assert.equal(view.element('recording-performance-state').textContent, 'Writing');
  assert.equal(view.element('recording-performance-details').dataset.tone, 'neutral');
  assert.equal(view.element('recording-performance-waiting').hidden, true, 'Saving does not invent writer-lock contention');
  for (const [writer, state, label] of [['confirming', 'writer-confirming', 'Confirming last save'],
    ['unavailable', 'writer-unavailable', 'Writer unavailable']]) {
    const value = health({ recording: { writer: { state: writer }, state, lastWriteAt: now - 1000, history: performanceHistory() },
      attention: [{ id: 'storage-writer', severity: writer === 'confirming' ? 'warning' : 'critical', title: label, detail: 'Check storage.' }] });
    view.panel.update({ recordingHealth: value });
    assert.equal(view.element('recording-status').hidden, false);
    assert.equal(view.element('recording-performance-state').textContent, label);
    assert.equal(view.element('recording-status-recording').dataset.recordingOpen, 'recording-performance-details');
    assert.match(view.element('recording-performance-lastWrite').textContent, /just now/);
    assert.equal(view.element('recording-performance-failed').textContent, '0', 'Writer availability cannot manufacture failed saves');
  }
});

test('application responsiveness has independent run coverage and preserves unknown samples', () => {
  const runtimeTiming = { basis: 'observed-event-loop-delay', hardRealtime: false, samples: 120,
    maxObservedDelayMs: 70, p99ObservedDelayMs: 24, warningThresholdMs: 1000 };
  const value = health({ recording: { runtimeTiming, history: performanceHistory() } });
  for (const period of ['day', 'week']) {
    const view = storagePerformanceView(value, period, { now });
    assert.equal(view.runtimeP99, '24 ms'); assert.equal(view.runtimeMax, '70 ms');
    assert.equal(view.runtimeSamples, '120 timer samples since application start');
  }
  assert.equal(storagePerformanceView(value, 'day', { now, unavailable: true }).runtimeTitle, 'Last known application responsiveness');
  for (const runtime of [undefined, { ...runtimeTiming, basis: 'old' }, { ...runtimeTiming, samples: null }]) {
    assert.equal(storagePerformanceView(health({ recording: { runtimeTiming: runtime } }), 'day', { now }).runtimeMax, 'Unknown');
  }
  value.recording.runtimeTiming = { ...runtimeTiming, samples: 0, maxObservedDelayMs: null, p99ObservedDelayMs: null };
  assert.equal(storagePerformanceView(value, 'day', { now }).runtimeMax, 'No samples');
  for (const scope of ['snapshot', 'history']) assert.equal(storagePerformanceView({ ...value, scope }, 'day', { now }).runtimeVisible, false);
});

test('an unconfirmed save outcome never claims rollback', () => {
  const history = performanceHistory();
  history.windows.day.incidents = [{ category: 'save-failed', at: now - 1000, context: 'storage',
    reason: 'database-unavailable', outcome: 'save-failed' }];
  const view = storagePerformanceView(health({ recording: { history } }), 'day', { now });
  assert.equal(view.incidents[0].outcome, 'The save was not confirmed.');
  assert.doesNotMatch(view.incidents[0].outcome, /did not commit|rolled back/);
});

test('storage problems use safe labels, preserve blocked commands and distinguish original recovery from resumed saving', () => {
  const history = performanceHistory();
  const value = health({ recording: { state: 'ok', lastWriteAt: now - 1000, history } });
  const incident = { category: 'save-failed', at: now - 60_000, context: 'mqtt-input',
    reason: 'database-io', outcome: 'not-retained-for-retry', recoveredAt: null };
  history.windows.day.incidents = [incident];
  let view = storagePerformanceView(value, 'day', { now });
  assert.equal(view.incidents[0].title, 'Save failed');
  assert.equal(view.incidents[0].context, 'Received MQTT update');
  assert.equal(view.incidents[0].dateTime, new Date(incident.at).toISOString());
  assert.equal(view.incidents[0].reason, 'Storage reported an input/output error.');
  assert.match(view.incidents[0].outcome, /not retained for retry/);
  assert.match(view.incidents[0].recovery, /Saving resumed.*does not establish recovery/);
  incident.context = 'charging-input'; incident.outcome = 'original-update-saved'; incident.recoveredAt = now - 10000;
  view = storagePerformanceView(value, 'day', { now });
  assert.match(view.incidents[0].outcome, /original update was saved on retry 7 Oct/);
  assert.equal(view.incidents[0].recovery, '');
  history.windows.day.incidents = [{ ...incident, category: 'command-not-sent', context: 'heat-pump-command',
    outcome: 'command-not-sent', reason: 'recording-wait-expired', recoveredAt: null }];
  view = storagePerformanceView(value, 'day', { now });
  assert.match(view.incidents[0].reason, /deadline expired while waiting for recording/);
  assert.equal(view.incidents[0].outcome, 'This command was not sent.');
  assert.equal(view.incidents[0].recovery, '');
  history.windows.day.incidents.push({ ...incident, context: 'private secret content' }, { ...incident, reason: '__proto__' });
  assert.equal(storagePerformanceView(value, 'day', { now }).incidents.length, 1);
  assert.equal(storagePerformanceView(value, 'week', { now }).incidents.length, 0, 'Use the selected monotonic window, not wall-clock filtering');
  const dashboard = panelFixture();
  dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-incident-list').children.length, 1);
  const row = dashboard.element('recording-performance-incident-list').children[0];
  assert.equal(row.children[0].children[0].textContent, 'Device command not sent');
  assert.equal(row.children[0].children[1].dateTime, new Date(incident.at).toISOString());
  assert.equal(row.children[1].textContent, 'Heat-pump command');
  assert.match(row.children[2].textContent, /deadline expired while waiting for recording.*command was not sent/);
  assert.equal(row.children[3].hidden, true);
  history.windows.day.incidents = [{ ...incident, context: 'mqtt-input', outcome: 'not-retained-for-retry' }];
  dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-incident-list').children[0], row, 'Polling retains the existing incident row');
  assert.equal(row.children[3].hidden, false);
  assert.match(row.children[3].textContent, /Saving resumed.*does not establish recovery/);
  history.windows.day.incidents = [];
  dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-incidents').hidden, false);
  assert.match(dashboard.element('recording-performance-undated-problems').children.map(node => node.textContent).join(' '), /failed queued operation/);
});

test('all four collapsed health areas explicitly label retained evidence after a failed or stale check', async () => {
  const view = panelFixture(async () => { throw Error('Synthetic unavailable health'); });
  view.panel.update({ recordingHealth: health({ recording: { state: 'ok', history: performanceHistory() } }) });
  await view.panel.refresh();
  for (const area of ['recording', 'disk', 'backup', 'performance'])
    assert.match(view.element(`recording-${area}-state`).textContent, /^Last known:/);
  view.panel.update({ recordingHealth: health({ recording: { state: 'ok', history: performanceHistory() } }) });
  for (const area of ['recording', 'disk', 'backup', 'performance'])
    assert.doesNotMatch(view.element(`recording-${area}-state`).textContent, /^Last known:/);
});

test('control responses without health preserve dated warnings, failed-refresh state and retained inventory', async () => {
  const view = panelFixture(async () => { throw Error('Synthetic unavailable health'); });
  view.panel.update({ recordingHealth: health({ attention: [
    { id: 'disk', severity: 'critical', title: 'Critically low disk space', detail: 'Make space for recording.' },
  ] }), recording: { measuredDatabaseBytes: 83e9 } });
  view.panel.inventory({ generatedAt: now, database: { allocatedBytes: 83e9, adaptiveEstimatedBytes: 6e9 } });
  const previousCheck = view.element('recording-health-checked').textContent;
  view.advance(3600_000);
  view.panel.update({ now: now + 3600_000, recording: { measuredDatabaseBytes: 84e9 } });
  assert.equal(view.element('recording-status-issues').hidden, false);
  assert.equal(view.element('recording-status-issues').children[0].firstElementChild.children[0].textContent, 'Critically low disk space');
  assert.match(view.element('recording-health-checked').textContent, /1 h ago/);
  assert.equal(view.element('recording-health-checked').textContent.split(' · ')[0], previousCheck.split(' · ')[0],
    'A control response does not renew the original health-check clock');
  assert.equal(view.element('recording-growth-retained').textContent, '6 GB');
  assert.equal(view.element('recording-growth-database').textContent, '83 GB');
  await view.panel.refresh();
  const failure = view.element('recording-health-checked').textContent;
  assert.match(failure, /Refresh failed/);
  view.panel.update({ now: now + 3600_000 });
  assert.equal(view.element('recording-health-checked').textContent, failure);
  assert.equal(view.element('recording-status-issues').hidden, false);
  assert.equal(view.element('recording-growth-database').textContent, '83 GB');
  assert.equal(view.element('recording-growth-retained').textContent, '6 GB');
  assert.equal(view.document.body.dataset.recordingHealth, 'true');
  view.panel.update({ recordingHealth: health({ checkedAt: now + 3600_000, scope: 'snapshot' }) });
  assert.doesNotMatch(view.element('recording-health-checked').textContent, /Refresh failed/);
  assert.match(view.element('recording-health-checked').textContent, /just now/);
  assert.equal(view.element('recording-status-issues').hidden, true);
  assert.equal(view.element('recording-growth-retained').textContent, 'Not checked');
  assert.equal(view.element('recording-growth-database').textContent, 'Not checked', 'Allocation belongs to the inventory scope');
  view.panel.clear();
  assert.equal(view.document.body.dataset.recordingHealth, 'false');
  assert.equal(view.element('recording-growth-database').textContent, 'Not checked');
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
  assert.equal(view.element('recording-growth-database').textContent, 'Not checked');
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
  const view=recordingHealthView(health({checkedAt:0,recording:{state:'ok',lastSourceCheckAt:0,lastLoopCompletedAt:0},
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
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Measure complete inventory to retry/);
  view.panel.inventory({generatedAt:0,database:{adaptiveEstimatedBytes:0}});
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/1 Jan 1970/);
  view.panel.inventoryStatus('failed');
  assert.equal(view.element('recording-growth-retained').textContent,'0 B');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/Could not measure.*checked.*1 Jan 1970/);
});

test('cheap catalogue metadata never claims that retained payload or page categories have been measured',()=>{
  const view=panelFixture();
  view.panel.inventory({generatedAt:now,catalogueComplete:false,database:{allocatedBytes:12000,fileBytes:10000,walBytes:0,totalFileBytes:10000}});
  assert.equal(view.element('recording-growth-retained').textContent,'Not checked');
  assert.equal(view.element('recording-growth-inventoryAt').textContent,'Retained adaptive size has not been measured.');
  assert.match(view.element('recording-growth-fileEvidence').textContent,/File sizes checked/);
  assert.doesNotMatch(view.element('recording-growth-fileEvidence').textContent,/Complete inventory/);
  assert.equal(view.element('recording-growth-observations').textContent,'Retained observation count is unknown.');
});

test('current file metrics refresh independently of retained payload and a dated allocation partition',()=>{
  const view=panelFixture(),measuredAt=now-3600_000;
  const completed={generatedAt:measuredAt,database:{allocatedBytes:84e6,adaptiveEstimatedBytes:6e6,adaptiveObservationCount:100,
    physical:{available:true,observationBytes:20e6,historyBytes:30e6,indexBytes:10e6}}};
  view.panel.inventory(completed,{files:{generatedAt:now,database:{allocatedBytes:90e6,fileBytes:85e6,walBytes:8e6,totalFileBytes:93e6,reusableBytes:3e6}}});
  assert.equal(view.element('recording-growth-database').textContent,'90 MB');
  assert.equal(view.element('recording-growth-files').textContent,'93 MB');
  assert.equal(view.element('recording-growth-retained').textContent,'6 MB');
  assert.equal(view.element('recording-growth-measuredAllocation').textContent,'84 MB');
  assert.match(view.element('recording-growth-allocationAt').textContent,/1 h ago.*same measured total/);
  assert.match(view.element('recording-growth-fileEvidence').textContent,/just now/);
  const retainedDate=view.element('recording-growth-inventoryAt').textContent;
  view.advance(60_000);
  view.panel.inventory(completed,{files:{generatedAt:now+60_000,database:{allocatedBytes:92e6,fileBytes:90e6,walBytes:9e6,totalFileBytes:99e6,reusableBytes:1e6}}});
  assert.equal(view.element('recording-growth-files').textContent,'99 MB');
  assert.equal(view.element('recording-growth-reusable').textContent,'1 MB');
  assert.equal(view.element('recording-growth-measuredAllocation').textContent,'84 MB');
  assert.equal(view.element('recording-growth-observationPages').textContent,'20 MB');
  assert.match(view.element('recording-growth-inventoryAt').textContent,/1 h ago/);
  assert.match(retainedDate,/1 h ago/);
});

test('storage inventory keeps file sizes and dated retained evidence through failures and clears them on a scope change', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health(), recording: { measuredDatabaseBytes: 83e9 } });
  view.panel.inventoryStatus('loading');
  assert.equal(view.element('recording-growth-file').textContent, 'Measuring…');
  view.panel.inventory({ generatedAt: now, database: { allocatedBytes: 84e9, fileBytes: 80e9, walBytes: 0,
    totalFileBytes: 80e9, reusableBytes: 12e9, adaptiveEstimatedBytes: 6e9, adaptiveObservationCount: 0,
    physical: { available: true, observationBytes: 20e9, historyBytes: 30e9, currentBytes: 1e9,
      journalBytes: 10e6, peerBacklogBytes: 5e6, branchBytes: 0, indexBytes: 10e9, internalBytes: 4096 },
    journalRetention: { commits: 1024, payloadBytes: 7e6, maxCommits: 2048, maxBytes: 8e6, baseSequence: 500 } } });
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
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
  assert.match(view.element('recording-overview-notice').textContent, /last complete result.*Storage & growth/);
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


test('health freshness is visible when the outer section is collapsed and invalid dates stay unknown', async () => {
  const view = panelFixture(async () => { throw Error('offline'); });
  view.panel.update({ recordingHealth: health() }); view.expireIntro();
  assert.equal(view.element('recording-health-badge').hidden, true);
  await view.panel.refresh();
  assert.equal(view.element('recording-health-badge').textContent, 'Status unavailable');
  assert.equal(view.element('recording-health-badge').hidden, false);
  view.panel.update({ recordingHealth: health({ checkedAt: now - 180001 }) });
  assert.equal(view.element('recording-health-badge').textContent, 'Last known');
  for (const value of [1e20, 8_640_000_000_000_001, Infinity, -1]) {
    assert.equal(recordingEvidenceTime(value, now), 'Not known');
    assert.doesNotThrow(() => view.panel.update({ recordingHealth: health({ checkedAt: value }) }));
  }
});

test('source exceptions retain distinct evidence clocks and reach the matching recording policy', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ recording: { state: 'ok', sources: { attentionStreams: 2,
    issues: [{ label: 'Outdoor temperature', destination: 'adaptive', policy: 'adaptive-value', status: 'stale',
      sourceObservedAt: now - 900000, lastCheckedAt: now, reason: 'The latest source observation is out of date.' },
    { label: 'Bedroom temperature', destination: 'inventory', policy: 'change-only', status: 'failed', lastCheckedAt: now } ] } },
    attention: [{ id: 'recording-sources', severity: 'warning', title: '2 observed sources need attention' }] }) });
  view.expireIntro();
  assert.equal(view.element('recording-status').hidden, false);
  assert.equal(view.element('recording-health-badge').hidden, false);
  assert.equal(view.element('recording-recording-card').dataset.tone, 'warning');
  const [adaptive, exact] = view.element('recording-recording-sources').children;
  assert.equal(adaptive.children[3].dataset.recordingOpen, 'recording-adaptive-details');
  assert.equal(exact.children[3].dataset.recordingOpen, 'recording-overview-details');
  assert.equal(adaptive.children[0].children[0].textContent, 'Outdoor temperature');
  assert.equal(adaptive.children[0].children[1].textContent, 'Out of date');
  assert.match(adaptive.children[1].textContent, /out of date/);
  assert.equal(adaptive.children[2].children[0].textContent, 'Source observation');
  assert.match(adaptive.children[2].children[1].textContent, /15 min ago/);
  assert.equal(adaptive.children[2].children[2].textContent, 'Last polling attempt');
  assert.match(adaptive.children[2].children[3].textContent, /just now/);
  assert.equal(exact.children[0].children[1].textContent, 'Source check failed');
  assert.equal(exact.children[2].children[1].textContent, 'Not known', 'Missing source evidence stays explicit beside its own clock label');
});

test('source counts distinguish unknown, no observed streams, overlapping attention and recorded history', () => {
  const view = panelFixture();
  for (const invalid of [undefined, null, -1, NaN, 1.5, '2']) {
    view.panel.update({ recordingHealth: health({ recording: { state: 'unknown', sources: {
      observedStreams: invalid, usableStreams: invalid, attentionStreams: invalid, unknownStreams: invalid, issues: [],
    } } }) });
    for (const field of ['observed', 'usable', 'attention']) assert.equal(view.element(`recording-recording-${field}`).textContent, 'Unknown');
    assert.equal(view.element('recording-recording-sources-empty').textContent, 'Source attention status is not known.');
    assert.equal(view.element('recording-recording-unknown').hidden, false);
  }
  view.panel.update({ recordingHealth: health({ recording: { state: 'starting', sources: {
    observedStreams: 0, usableStreams: 0, attentionStreams: 0, unknownStreams: 0, issues: [],
  } } }) });
  assert.equal(view.element('recording-recording-observed').textContent, '0');
  assert.match(view.element('recording-recording-sources-empty').textContent, /No measurement streams have been observed/);
  assert.equal(view.element('recording-recording-unknown').hidden, true);
  view.panel.update({ recordingHealth: health({ recording: { state: 'ok', sources: {
    observedStreams: 2, usableStreams: 2, attentionStreams: 1, unknownStreams: 0, truncated: true,
    issues: [{ id: 'held-reading', label: 'Indoor temperature', status: 'held-attention', sourceObservedAt: now - 60000 }],
  } } }) });
  assert.equal(view.element('recording-recording-usable').textContent, '2');
  assert.equal(view.element('recording-recording-attention').textContent, '1', 'Held attention is not subtracted from usable evidence');
  assert.equal(view.element('recording-recording-sources-title').hidden, false);
  assert.equal(view.element('recording-recording-sources-empty').hidden, true);
  assert.equal(view.element('recording-recording-sources-note').hidden, false);
  assert.match(view.element('recording-recording-sources-note').textContent, /Additional observed stream exceptions are omitted/);
  view.panel.update({ recordingHealth: health({ scope: 'snapshot', recording: { state: 'read-only' } }) });
  assert.equal(view.element('recording-recording-counts').hidden, true);
  assert.equal(view.element('recording-recording-unknown').hidden, true);
  assert.equal(view.element('recording-recording-sources-title').textContent, 'Recorded source exceptions');
  assert.match(view.element('recording-recording-sources-empty').textContent, /recorded history/);
  assert.equal(view.element('recording-recording-sources-note').hidden, true);
});

test('structured source rows preserve focus and dated evidence through reorder, failed refresh and recovery', async () => {
  const view = panelFixture(async () => { throw Error('Synthetic refresh failure'); });
  const sources = { observedStreams: 3, usableStreams: 1, attentionStreams: 2, unknownStreams: 0, issues: [
    { id: 'outdoor', label: 'Outdoor temperature', unit: 'degC', status: 'stale', destination: 'adaptive',
      sourceObservedAt: now - 900000, lastCheckedAt: now - 60000, reason: 'The source is out of date.' },
    { id: 'bedroom', label: 'Bedroom temperature', status: 'unavailable', lastCheckedAt: now },
  ] };
  const detail = 'Writes have resumed after 2 failed writes in this run. Earlier gaps may remain.';
  const update = () => view.panel.update({ recordingHealth: health({ recording: { state: 'ok', detail, sources } }) });
  const summary = view.document.createElement('summary');
  view.element('recording-recording-card').append(summary);
  update();
  const [outdoor, bedroom] = view.element('recording-recording-sources').children;
  const focusedLink = outdoor.children[3]; focusedLink.focus();
  assert.equal(outdoor.children[0].children[0].textContent, 'Outdoor temperature (°C)');
  sources.issues.reverse(); update();
  assert.deepEqual(view.element('recording-recording-sources').children, [bedroom, outdoor]);
  assert.equal(view.document.activeElement, focusedLink);
  assert.equal(outdoor.children[3], focusedLink);
  const observed = outdoor.children[2].children[1].textContent;
  await view.panel.refresh();
  assert.equal(view.document.activeElement, focusedLink);
  assert.equal(outdoor.children[2].children[1].textContent, observed, 'A failed health request cannot renew source dates');
  assert.match(view.element('recording-recording-detail').textContent, /^Last known status\. Writes have resumed.*Earlier gaps may remain/);
  sources.issues = []; sources.attentionStreams = 0; sources.usableStreams = 3; update();
  assert.equal(view.document.activeElement, summary, 'A disappearing focused source returns to its recording fold');
  assert.equal(view.element('recording-recording-sources').hidden, true);
  assert.equal(view.element('recording-recording-sources-title').hidden, true);
  assert.equal(view.element('recording-recording-sources-empty').hidden, false);
  assert.equal(view.element('recording-recording-sources-empty').textContent, 'No attention flags among the observed streams.');
  assert.equal(view.element('recording-recording-detail').textContent, detail);
});

test('a failed saved-copy recheck supersedes creation evidence and reaches collapsed warnings', async () => {
  const catalog = savedCatalog();
  catalog.copies[0].recheck = { state: 'error', error: 'database_schema_mismatch', finishedAt: now, scope: 'current-run' };
  const view = panelFixture(async () => catalog);
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } }); view.expireIntro();
  await view.panel.refreshCopies({ force: true });
  const row = view.element('recording-backup-list').children[0];
  assert.match(row.children[3].textContent, /Full check failed.*Verified during creation/);
  assert.doesNotMatch(row.children[3].textContent, /No later check is available/);
  assert.match(row.children[4].textContent, /schema does not match/);
  assert.equal(view.element('recording-health-badge').hidden, false);
  assert.match(view.element('recording-backup-state').textContent, /check needs attention/);
  assert.equal(view.element('recording-backup-card').dataset.tone, 'warning');
  assert.equal(view.element('recording-status-issues').children[0].firstElementChild.dataset.recordingOpen, 'recording-backup-card');
  assert.equal(row.children[5].children[0].getAttribute('aria-label'), 'Download stmq-synthetic.sqlite');
  assert.match(backupCheckFailure({ error: 'backup_verification_interrupted' }), /interruption alone does not show damage/);
  assert.doesNotMatch(backupCheckFailure({ error: '/private/arbitrary-error' }), /private/);
  catalog.copies[0].recheck = { state: 'complete', finishedAt: now };
  await view.panel.refreshCopies({ force: true });
  assert.equal(view.element('recording-health-badge').hidden, true);
  assert.match(row.children[3].textContent, /Full check passed.*current application run/);
});

test('database verification failure stays visible while a replacement check runs', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health({ verification: { scope: 'current-run', state: 'running',
    lastFailure: { error: 'database_integrity_failed', finishedAt: now - 60000 } }, attention: [
      { id: 'database-verification', severity: 'critical', title: 'Database integrity check failed' } ] }) });
  view.expireIntro();
  assert.equal(view.element('recording-health-badge').hidden, false);
  assert.match(view.element('database-verification-summary').textContent, /Check needs attention.*1 min ago/);
  assert.equal(view.element('recording-status-issues').children[0].firstElementChild.dataset.recordingOpen, 'database-verification-details');
});

test('backup paths separate the verified Home Assistant host folder from the app path and clear on logout', async () => {
  const catalog = savedCatalog({ directory: '/config/backups', location: { environment: 'home-assistant',
    folder: '/addon_configs/synthetic_addon/backups', insideApp: '/config/backups', hostMappingKnown: true } });
  const view = panelFixture(async () => catalog);
  view.panel.update({ recordingHealth: health(), webAccess: { role: 'admin' } });
  await view.panel.refreshCopies({ force: true });
  assert.equal(view.element('recording-backup-folder').textContent, '/addon_configs/synthetic_addon/backups');
  assert.equal(view.element('recording-backup-inside').textContent, '/config/backups');
  assert.equal(view.element('recording-backup-inside-label').hidden, false);
  assert.match(view.element('recording-backup-location-detail').textContent, /same folder/);
  catalog.location.folder = null; catalog.location.hostMappingKnown = false;
  await view.panel.refreshCopies({ force: true });
  assert.equal(view.element('recording-backup-folder').textContent, 'Host folder mapping unavailable');
  assert.match(view.element('recording-backup-location-detail').textContent, /host folder is not known/);
  view.panel.clear();
  assert.equal(view.element('recording-backup-inside-label').hidden, true);
  assert.equal(view.element('recording-backup-inside').textContent, '');
  assert.doesNotMatch(view.element('recording-backup-folder').textContent, /addon_configs/);
});

test('database allocation comes only from the dated inventory and never silently becomes main-file size', () => {
  const view = panelFixture();
  view.panel.update({ recordingHealth: health(), recording: { measuredDatabaseBytes: 80e9 } });
  assert.equal(view.element('recording-growth-database').textContent, 'Not checked');
  view.panel.inventory({ generatedAt: now, database: { allocatedBytes: 84e9, fileBytes: 82e9 } });
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  assert.equal(view.element('recording-disk-database').textContent, '84 GB');
  view.panel.update({ recording: { measuredDatabaseBytes: 85e9 } });
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  view.panel.inventory({ generatedAt: now, database: { allocatedBytes: null, fileBytes: 82e9 } });
  assert.equal(view.element('recording-growth-database').textContent, 'Unknown');
  assert.equal(view.element('recording-disk-database').textContent, 'Unknown');
  view.panel.inventoryReset();
  assert.equal(view.element('recording-disk-database').textContent, 'Not checked');
});


test('health context changes reset retained evidence and notify dependent loaders exactly once', () => {
  const changes = [];
  const view = panelFixture(undefined, { onContextChange: value => changes.push(value) });
  view.panel.update({ recordingHealth: health({ contextId: 'synthetic-a' }) });
  view.panel.inventory({ generatedAt: now, database: { allocatedBytes: 84e9 } });
  view.panel.update({ recordingHealth: health({ contextId: 'synthetic-a' }) });
  assert.equal(changes.length, 1);
  assert.equal(view.element('recording-growth-database').textContent, '84 GB');
  view.panel.update({ recordingHealth: health({ contextId: 'synthetic-b' }) });
  assert.deepEqual(changes, [{ contextId: 'synthetic-a', scope: 'live' }, { contextId: 'synthetic-b', scope: 'live' }]);
  assert.equal(view.element('recording-growth-database').textContent, 'Not checked');
});


test('server-save and browser-transfer failure receipts name their independent outcomes', () => {
  const backup = { state: 'failed', outcomes: { savedCopy: { failed: true, failedAt: now - 60000 },
    download: { failed: false, completedAt: now } }, downloadAt: now };
  const view = recordingHealthView(health({ backup }), undefined, now);
  assert.equal(view.backup.label, 'Server save failed');
  assert.match(view.backup.activity, /Server save failed.*1 min ago/);
  assert.match(view.backup.download, /Browser transfer sent.*just now/);
  backup.outcomes.download = { failed: true, failedAt: now };
  const both = recordingHealthView(health({ backup }), undefined, now);
  assert.equal(both.backup.label, 'Save and download failed');
  assert.match(both.backup.activity, /Server save failed.*Browser transfer failed/);
});

test('undated storage problems name each counter separately inside the existing fold', () => {
  const history = performanceHistory(), value = health({ recording: { history } });
  Object.assign(history.windows.day, { failedJobs: 1, postCommitFailures: 0, backgroundFailedJobs: 2, failedWrites: 1 });
  const view = storageProblemDetails(value, 'day', { now });
  assert.deepEqual(view.undatedProblems, [
    '1 failed save. Individual dates and causes are unavailable.',
    '1 failed queued operation. Individual dates and causes are unavailable.',
    '2 failed background operations. Individual dates and causes are unavailable.',
  ]);
  assert.equal(storagePerformanceView(value, 'day', { now }).state, 'Caught up');
  const dashboard = panelFixture(); dashboard.panel.update({ recordingHealth: value });
  assert.equal(dashboard.element('recording-performance-incidents').hidden, false);
  assert.equal(dashboard.element('recording-performance-undated-problems').children.length, 3);
  assert.match(dashboard.element('recording-performance-problem-period').textContent, /Past day/);
  assert.equal(storageProblemDetails(value, 'day', { now, unavailable: true }).undatedProblems.length, 3);
  delete history.windows.week;
  const fallback = storageProblemDetails(value, 'week', { now });
  assert.equal(fallback.period, 'day'); assert.match(fallback.explanation, /selected past week is unavailable/);
  history.windows.week = { ...history.windows.day, failedJobs: 3 };
  assert.match(storageProblemDetails(value, 'week', { now }).undatedProblems[1], /3 failed queued operations/);
});

test('local task counters without dated receipts remain visible and known zeroes do not invent problems', () => {
  let tick = 0;
  const observer = createStorageOperationHealth({ clock: () => now - 1000 + tick, monotonic: () => tick });
  const task = observer.begin('backup'); tick = 100; task.finish('failed'); tick = 1000;
  const operations = observer.status();
  const backup = operations.coverage.find(row => row.kind === 'backup');
  backup.day.lastProblem = null;
  const value = health({ operations });
  const view = storageProblemDetails(value, 'day', { now });
  assert.deepEqual(view.undatedProblems, ['Database copy creation: 1 failed task. Individual dates and causes are unavailable.']);
  backup.day.failed = 0;
  assert.deepEqual(storageProblemDetails(value, 'day', { now }).undatedProblems, []);
  backup.day.failed = null;
  assert.deepEqual(storageProblemDetails(value, 'day', { now }).undatedProblems, []);
});
