import test from 'node:test';
import assert from 'node:assert/strict';
import { standbyCheckRows } from '../chart/provider-standby.js';
import { dashboardProviders } from '../chart/provider-status.js';

const now = Date.parse('2026-10-28T10:00:00Z'), HOUR = 3600_000;
const options = { now, formatTime: at => new Date(at).toISOString().slice(11, 16) };
const standby = (extra = {}) => ({ source: 'openmeteo', status: 'ok', lastCheckedAt: now - 42 * 60_000,
  nextAttemptAt: now + 18 * 60_000, ...extra });

test('standby rows distinguish last-checked availability, expected reading age, failures, partial coverage and overdue checks', () => {
  const providers = { outdoor: { source: 'fmi', standby: standby() },
    weather: { source: 'fmi', standby: standby({ status: 'partial', solarStatus: 'unavailable' }) },
    market: { source: 'entsoe', standby: standby({ source: 'elering', status: 'error', error: 'synthetic-private-body' }) } };
  const rows = standbyCheckRows(providers, ['outdoor', 'weather', 'market'], options);
  assert.equal(rows[0].state, 'Usable at last check'); assert.equal(rows[0].attention, false);
  assert.match(rows[0].evidence, /09:18.*42 min/);
  assert.match(rows[0].detail, /past check does not establish availability now/);
  assert.equal(rows[1].state, 'Partial coverage'); assert.equal(rows[1].attention, true);
  assert.match(rows[1].detail, /Solar radiation at last check: unavailable/);
  assert.equal(rows[2].state, 'Check failed'); assert(!rows[2].detail.includes('synthetic-private-body'));
  providers.outdoor.standby.nextAttemptAt = now - 2 * 60_000;
  assert.equal(standbyCheckRows(providers, ['outdoor'], options)[0].state, 'Check overdue');
  providers.outdoor.standby = standby({ status: 'waiting', lastCheckedAt: null });
  assert.equal(standbyCheckRows(providers, ['outdoor'], options)[0].state, 'Not checked yet');
  providers.outdoor.standby.lastCheckedAt = now + HOUR;
  assert.equal(standbyCheckRows(providers, ['outdoor'], options)[0].state, 'Not checked yet', 'future clocks cannot establish success');
});

test('a provider in normal use is labelled in use, including solar supplementation, with its check evidence retained', () => {
  const providers = { outdoor: { source: 'openmeteo', standby: standby() },
    weather: { source: 'fmi', acquisition: { solarSource: 'openmeteo' }, standby: standby() } };
  for (const row of standbyCheckRows(providers, ['outdoor', 'weather'], options)) {
    assert.equal(row.state, 'In use'); assert.equal(row.attention, false); assert.match(row.detail, /Ordinary acquisition/);
  }
});

test('a selected backup retains failed and partial check outcomes instead of claiming current availability', () => {
  const providers = { outdoor: { source: 'openmeteo', standby: standby({ status: 'error' }) },
    weather: { source: 'fmi', acquisition: { solarSource: 'openmeteo' }, standby: standby({ status: 'partial' }) },
    market: { source: 'elering', standby: standby({ source: 'elering', status: 'error' }) } };
  const rows = standbyCheckRows(providers, ['outdoor', 'weather', 'market'], options);
  assert.deepEqual(rows.map(row => row.state), ['Check failed', 'Partial coverage', 'Check failed']);
  assert(rows.every(row => row.attention));
  assert(rows.every(row => row.detail.includes('selected for the current feed')));
  assert(rows.every(row => !row.detail.includes('is contributing')));
});

test('malformed diagnostic metadata cannot enter the backup detail or format an invalid date', () => {
  const [row] = standbyCheckRows({ weather: { source: 'fmi', standby: standby({
    coverage: { knownUntil: 'private-invalid-date', gaps: false }, solarStatus: 'private-invalid-status',
  }) } }, ['weather'], options);
  assert.doesNotMatch(row.detail, /private-invalid/);
  assert.doesNotThrow(() => standbyCheckRows({ outdoor: { standby: standby({
    coverage: { knownUntil: Number.MAX_VALUE }, nextAttemptAt: Number.MAX_VALUE,
  }) } }, ['outdoor'], options));
});

test('recorded backup diagnostics remain neutral snapshots and preserve original check dates', () => {
  const providers = { market: { source: 'entsoe', standby: standby({ source: 'elering', status: 'error' }) } };
  const [row] = standbyCheckRows(providers, ['market'], { ...options, recorded: true });
  assert.equal(row.state, 'Recorded · Check failed'); assert.equal(row.attention, false); assert.equal(row.tone, 'pending');
  assert.match(row.evidence, /09:18/); assert.match(row.detail, /does not check live backup feeds/);
  assert(!row.detail.includes('Next standby check'));
});

test('backup checks join existing provider groups without changing active-feed status or unrelated groups', () => {
  const status = { input: 'providers', providers: { market: { source: 'entsoe', status: 'ok', standby: standby({ source: 'elering', status: 'error' }) },
    outdoor: { source: 'fmi', status: 'ok', standby: standby() }, weather: { source: 'fmi', status: 'ok', standby: standby() } } };
  const groups = dashboardProviders(status, options);
  assert.deepEqual(groups.find(row => row.key === 'market').standbyChecks.map(row => row.key), ['market']);
  assert.deepEqual(groups.find(row => row.key === 'main-temperatures').standbyChecks.map(row => row.key), ['outdoor', 'weather']);
  const market = groups.find(row => row.key === 'market');
  assert.equal(market.display.state, 'Available'); assert.equal(market.display.attention, false);
  assert.equal(market.standbyChecks[0].attention, true);
  status.readOnly = true;
  assert(groups.length > 0);
  assert(dashboardProviders(status, options).every(group => group.standbyChecks.every(row => row.state.startsWith('Recorded · '))));
});
