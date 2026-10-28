import test from 'node:test';
import assert from 'node:assert/strict';
import { startProviders } from '../src/acquisition/providers.js';
import { createSourceHealthFixture, outdoorDefinitions, providerProofDefinitions, NOW, MINUTE, HOUR } from './helpers/source-feed-health-fixture.js';

const issuesFor = (health, label) => health.recording.sources.issues.filter(issue => issue.label === label);
const providerIssues = health => health.recording.sources.issues.filter(issue => issue.kind === 'provider');
const changes = fixture => fixture.store.db.prepare('SELECT total_changes() n').get().n;
const failedAttempt = source => ({ source, status: 'error', error: 'HTTP-503', attemptedAt: NOW - 20_000, checkedAt: NOW - 20_000 });
const successfulAttempt = source => ({ source, status: 'ok', error: null, attemptedAt: NOW - 20_000, checkedAt: NOW - 20_000 });
const blocked = (at = NOW - 20_000) => ({ failures: 1, status: 'error', error: 'HTTP-503', lastAttemptAt: at,
  lastCheckedAt: at, nextAttemptAt: NOW + MINUTE });
const standby = (status, extra = {}) => ({ source: 'openmeteo', status, checking: false,
  lastAttemptAt: NOW - 20_000, lastCheckedAt: NOW - 20_000,
  lastSuccessAt: status === 'ok' ? NOW - 20_000 : null, nextAttemptAt: NOW + HOUR,
  sourceObservedAt: status === 'ok' ? NOW - MINUTE : null,
  coverage: null, solarStatus: null, error: status === 'error' ? 'HTTP-503' : null, ...extra });
const forecast = (source = 'openmeteo', extra = {}) => ({ source, issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE,
  forecast: [{ source, issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE, start: NOW - HOUR, end: NOW + 24 * HOUR,
    outdoorC: 0, solarRadiationWm2: 0 }], ...extra });
const market = (source = 'elering', extra = {}) => ({ source, issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE,
  coverage: { current: true, completeToday: true, gaps: false, knownUntil: NOW + 24 * HOUR },
  intervals: [{ source, start: NOW - HOUR, end: NOW + 24 * HOUR, fetchedAt: NOW - MINUTE, spotCtPerKwh: 0 }], ...extra });

test('outdoor warnings name the individual provider and current feed for every observed freshness combination', async t => {
  for (const definition of outdoorDefinitions()) await t.test(definition.title, async () => {
    const fixture = createSourceHealthFixture(definition);
    try {
      const before = changes(fixture), recordingBefore = fixture.engine.recorder.sourceStatus(NOW);
      const health = await fixture.status(), summary = health.recording.sources;
      const outdoor = issuesFor(health, 'Outdoor temperature');
      const expected = definition.fmi === 'fresh' ? [] : [
        ...(!['fresh', 'never'].includes(definition.fmi) ? [['FMI', 'primary', definition.fmi]] : []),
        ...(!['fresh', 'never'].includes(definition.openmeteo) ? [['Open-Meteo', 'backup', definition.openmeteo]] : [])];
      assert.deepEqual(outdoor.map(issue => [issue.sourceLabel, issue.sourceRole, issue.status]).sort(), expected.sort());
      assert(outdoor.every(issue => issue.kind === 'stream'), 'recorded source losses keep their stream identity');
      assert.equal(new Set(outdoor.map(issue => issue.id)).size, outdoor.length, 'provider warnings have independent keys');
      for (const issue of outdoor) {
        assert.equal(issue.feed.label, 'Outdoor temperature');
        assert.equal(issue.feed.status, fixture.selectedSource ? 'available' : 'unavailable');
        assert.equal(issue.feed.sourceLabel, fixture.selectedSource === 'fmi' ? 'FMI'
          : fixture.selectedSource === 'openmeteo' ? 'Open-Meteo' : null);
      }
      const garage = issuesFor(health, 'Garage front pipe estimate');
      assert.equal(garage.length, 1, 'independent Garage issue is not hidden by weather standby');
      assert.equal(garage[0].status, 'unavailable');
      assert.equal(garage[0].kind, 'stream');
      assert.equal(garage[0].feed, null);
      assert.equal(garage[0].sourceLabel, 'Garage protection sender');
      assert.equal(garage[0].sourceRole, null);
      assert.equal(summary.providerAttentionCount, 0);
      assert.equal(summary.attentionCount, expected.length + 1);
      assert.equal(summary.attentionStreams, expected.length + 1);
      assert.equal(summary.observedStreams, Number(definition.fmi !== 'never') + Number(definition.openmeteo !== 'never') + 2);
      assert.deepEqual(fixture.engine.recorder.sourceStatus(NOW), recordingBefore, 'presentation preserves original source evidence');
      assert.equal(changes(fixture), before, 'source health reads are read-only');
    } finally { await fixture.close(); }
  });
});

test('a stale idle backup observation is distinct from its latest successful or failed readiness check', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'fresh', openmeteo: 'stale', garage: 'unavailable',
    providerHealth: { outdoor: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - MINUTE,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [successfulAttempt('fmi')] }, standby: standby('ok') } } });
  t.after(() => fixture.close());
  let health = await fixture.status();
  assert.deepEqual(issuesFor(health, 'Outdoor temperature'), [], 'old fallback observation does not override successful standby check');
  const state = fixture.store.getState('providers:health');
  state.outdoor.standby = standby('error'); fixture.store.setState('providers:health', state);
  const before = changes(fixture);
  health = await fixture.status();
  const outdoor = issuesFor(health, 'Outdoor temperature');
  assert.equal(outdoor.length, 1, 'one backup failure, without a second obsolete measurement warning');
  assert.equal(outdoor[0].kind, 'provider');
  assert.equal(outdoor[0].sourceLabel, 'Open-Meteo');
  assert.equal(outdoor[0].sourceRole, 'backup');
  assert.equal(outdoor[0].feed.status, 'available');
  assert.equal(outdoor[0].feed.sourceLabel, 'FMI');
  assert.equal(outdoor[0].lastCheckedAt, NOW - 20_000);
  assert.equal(health.recording.sources.attentionStreams, 1, 'provider failure does not become another observed stream');
  assert.equal(health.recording.sources.providerAttentionCount, 1);
  assert.equal(health.recording.sources.attentionCount, 2);
  assert.equal(changes(fixture), before);
});

test('overdue backup checks identify diagnostic delay without calling the working current feed stale', async t => {
  const definitions = [
    { name: 'exact grace boundary', status: 'ok', nextAttemptAt: NOW - MINUTE, expected: null },
    { name: 'one millisecond overdue', status: 'ok', nextAttemptAt: NOW - MINUTE - 1, expected: 'overdue' },
    { name: 'never completed and overdue', status: 'waiting', nextAttemptAt: NOW - HOUR, expected: 'overdue' },
    { name: 'retry deadline remains in future', status: 'ok', nextAttemptAt: NOW + HOUR, expected: null },
    { name: 'actual failure takes precedence', status: 'error', nextAttemptAt: NOW - HOUR, expected: 'failed' },
    { name: 'actual partial result takes precedence', status: 'partial', nextAttemptAt: NOW - HOUR, expected: 'partial' },
    { name: 'backup currently in use', status: 'ok', nextAttemptAt: NOW - HOUR, expected: null, inUse: true }];
  for (const definition of definitions) await t.test(definition.name, async () => {
    const waiting = definition.status === 'waiting';
    const fixture = createSourceHealthFixture({ fmi: definition.inUse ? 'never' : 'fresh', openmeteo: definition.inUse ? 'fresh' : 'stale',
      providerHealth: { outdoor: { status: 'ok', source: definition.inUse ? 'openmeteo' : 'fmi',
        acquisition: { primary: 'fmi', selected: definition.inUse ? 'openmeteo' : 'fmi', attempts: [successfulAttempt(definition.inUse ? 'openmeteo' : 'fmi')] },
        standby: standby(definition.status, { lastCheckedAt: waiting ? null : NOW - 3 * HOUR,
          lastAttemptAt: waiting ? null : NOW - 3 * HOUR, lastSuccessAt: waiting ? null : NOW - 3 * HOUR,
          nextAttemptAt: definition.nextAttemptAt }) } } });
    try {
      const warnings = issuesFor(await fixture.status(), 'Outdoor temperature');
      assert.equal(warnings.length, definition.expected ? 1 : 0);
      if (definition.expected) {
        assert.equal(warnings[0].sourceLabel, 'Open-Meteo'); assert.equal(warnings[0].sourceRole, 'backup');
        assert.equal(warnings[0].status, definition.expected); assert.equal(warnings[0].feed.status, 'available');
        assert.equal(warnings[0].feed.sourceLabel, 'FMI');
        assert.equal(warnings[0].lastCheckedAt, waiting ? null : NOW - 3 * HOUR);
        if (definition.expected === 'overdue') assert.match(warnings[0].reason.toLowerCase(), /check.*overdue|overdue.*check/);
      }
    } finally { await fixture.close(); }
  });
});

test('every supported standby chain exposes its own overdue health check', async t => {
  for (const definition of providerProofDefinitions().filter(row => row.title.includes('health check overdue'))) await t.test(definition.title, async () => {
    const fixture = createSourceHealthFixture(definition);
    try {
      const warnings = providerIssues(await fixture.status());
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].sourceRole, 'backup'); assert.equal(warnings[0].status, 'overdue');
      assert.equal(warnings[0].feed.status, 'available');
      assert.equal(warnings[0].lastCheckedAt, definition.providerHealth.weather ? null : NOW - 3 * HOUR);
    } finally { await fixture.close(); }
  });
});

test('a failed primary request without an observed stream is named while the outdoor backup supplies the current feed', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'never', openmeteo: 'fresh', providerHealth: { outdoor: {
    status: 'fallback', source: 'openmeteo', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'fmi', selected: 'openmeteo', attempts: [failedAttempt('fmi'), successfulAttempt('openmeteo')] },
    sourceBackoff: { fmi: blocked() }, standby: standby('ok') } } });
  t.after(() => fixture.close());
  const health = await fixture.status(), outdoor = issuesFor(health, 'Outdoor temperature');
  assert.equal(outdoor.length, 1);
  assert.equal(outdoor[0].kind, 'provider');
  assert.equal(outdoor[0].sourceLabel, 'FMI');
  assert.equal(outdoor[0].sourceRole, 'primary');
  assert.equal(outdoor[0].feed.status, 'available');
  assert.equal(outdoor[0].feed.sourceLabel, 'Open-Meteo');
  assert.equal(health.recording.sources.observedStreams, 2);
  assert.equal(health.recording.sources.attentionStreams, 0);
  assert.equal(health.recording.sources.providerAttentionCount, 1);
});

test('current outdoor feed identity follows Engine selection while a newer failed request is reported independently', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'fresh', openmeteo: 'fresh', providerHealth: { outdoor: {
    status: 'fallback', source: 'openmeteo', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'fmi', selected: 'openmeteo', attempts: [failedAttempt('fmi'), successfulAttempt('openmeteo')] },
    sourceBackoff: { fmi: blocked() }, standby: standby('ok') } } });
  t.after(() => fixture.close());
  assert.equal(fixture.engine.outdoorObservation(NOW).source, 'fmi', 'Engine retains primary until actual source expiry');
  const warning = issuesFor(await fixture.status(), 'Outdoor temperature')[0];
  assert.equal(warning.sourceLabel, 'FMI'); assert.equal(warning.kind, 'provider');
  assert.equal(warning.feed.status, 'available'); assert.equal(warning.feed.sourceLabel, 'FMI');
});

test('outdoor current-feed validity uses the same range and retained-quality checks as Engine', async t => {
  for (const [value, quality] of [[55, []], [5, ['retained']]]) await t.test(`${value} C / ${quality.join(',') || 'normal quality'}`, async () => {
    const fixture = createSourceHealthFixture({ events: [{ source: 'fmi', device: 'synthetic-fmi', signal: 'outdoor_temperature',
      value, quality, unit: 'degC', sourceTime: NOW, receivedAt: NOW }], providerHealth: { outdoor: {
      status: 'error', source: 'fmi', lastAttemptAt: NOW,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [failedAttempt('fmi')] }, sourceBackoff: { fmi: blocked() } } } });
    try {
      assert.equal(fixture.engine.outdoorObservation(NOW).stale, true);
      const warning = issuesFor(await fixture.status(), 'Outdoor temperature')[0];
      assert(warning); assert.equal(warning.feed.status, 'unavailable'); assert.equal(warning.feed.sourceLabel, null);
    } finally { await fixture.close(); }
  });
});

test('never-observed and never-requested providers do not invent outages or usable feed evidence', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'never', openmeteo: 'never', indoor: 'never' });
  t.after(() => fixture.close());
  const health = await fixture.status();
  assert.equal(health.recording.sources.observedStreams, 0);
  assert.deepEqual(health.recording.sources.issues, []);
  assert.equal(health.recording.sources.attentionCount, 0);
  assert.equal(health.recording.state, 'source-unavailable');
});

test('weather and published prices report failed primary providers independently from their usable backups', async t => {
  const fixture = createSourceHealthFixture({
    providerHealth: Object.fromEntries([['weather', 'fmi', 'openmeteo'], ['market', 'entsoe', 'elering']].map(([name, primary, backup]) => [name, {
      status: 'fallback', source: backup, lastAttemptAt: NOW - 20_000, lastSuccessAt: NOW - 20_000,
      acquisition: { primary, selected: backup, attempts: [failedAttempt(primary), successfulAttempt(backup)] },
      sourceBackoff: { [primary]: blocked() }, standby: standby('ok', { source: backup,
        coverage: { current: true, completeToday: true, gaps: false, knownUntil: NOW + 24 * HOUR }, solarStatus: name === 'weather' ? 'available' : null }) }])),
    snapshots: { weather: forecast(), market: market() } });
  t.after(() => fixture.close());
  const before = changes(fixture), health = await fixture.status(), warnings = providerIssues(health);
  assert.equal(warnings.length, 2);
  for (const [label, sourceLabel, backupLabel] of [['Weather forecast', 'FMI', 'Open-Meteo'], ['Published electricity prices', 'ENTSO-E', 'Elering']]) {
    const issue = warnings.find(row => row.label === label);
    assert(issue, `${label} primary warning is visible`);
    assert.equal(issue.sourceLabel, sourceLabel); assert.equal(issue.sourceRole, 'primary');
    assert.equal(issue.feed.status, 'available'); assert.equal(issue.feed.sourceLabel, backupLabel);
  }
  assert.equal(health.recording.sources.attentionStreams, 0);
  assert.equal(health.recording.sources.providerAttentionCount, 2);
  assert.equal(health.recording.sources.attentionCount, 2);
  assert.equal(changes(fixture), before);
});

test('weather and prices can show both provider failures without borrowing unrelated observed-stream health', async t => {
  const fixture = createSourceHealthFixture({
    providerHealth: Object.fromEntries([['weather', 'fmi', 'openmeteo'], ['market', 'entsoe', 'elering']].map(([name, primary, backup]) => [name, {
      status: 'error', source: null, lastAttemptAt: NOW - 20_000,
      acquisition: { primary, selected: null, attempts: [failedAttempt(primary), failedAttempt(backup)] },
      sourceBackoff: { [primary]: blocked(), [backup]: blocked() }, standby: standby('error', { source: backup }) }])),
  });
  t.after(() => fixture.close());
  const health = await fixture.status(), warnings = providerIssues(health);
  assert.equal(warnings.length, 4);
  assert.deepEqual(warnings.map(issue => [issue.label, issue.sourceLabel, issue.sourceRole]).sort(), [
    ['Weather forecast', 'FMI', 'primary'], ['Weather forecast', 'Open-Meteo', 'backup'],
    ['Published electricity prices', 'ENTSO-E', 'primary'], ['Published electricity prices', 'Elering', 'backup']].sort());
  assert(warnings.every(issue => issue.feed.status === 'unavailable'));
  assert.equal(health.recording.sources.observedStreams, 1, 'provider checks are not invented measurements');
  assert.equal(health.recording.sources.usableStreams, 1);
});

test('healthy weather and published-price primary and backup providers remain quiet', async t => {
  const fixture = createSourceHealthFixture({ providerHealth: Object.fromEntries([
    ['weather', 'fmi', 'openmeteo'], ['market', 'entsoe', 'elering']].map(([name, primary, backup]) => [name, {
    status: 'ok', source: primary, lastAttemptAt: NOW - 20_000,
    acquisition: { primary, selected: primary, attempts: [successfulAttempt(primary)] },
    standby: standby('ok', { source: backup, solarStatus: name === 'weather' ? 'available' : null,
      coverage: { current: true, completeToday: true, gaps: false, knownUntil: NOW + 24 * HOUR } }) }])),
    snapshots: { weather: forecast('fmi'), market: market('entsoe') } });
  t.after(() => fixture.close());
  assert.deepEqual((await fixture.status()).recording.sources.issues, []);
});

test('intentionally unconfigured ENTSO-E does not warn in a healthy Elering-only installation', async t => {
  const fixture = createSourceHealthFixture({ providerHealth: { market: {
    status: 'fallback', source: 'elering', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'entsoe', selected: 'elering', attempts: [
      { source: 'entsoe', status: 'not-configured', error: null }, successfulAttempt('elering')] },
    standby: standby('ok', { source: 'elering', coverage: { current: true, completeToday: true,
      gaps: false, knownUntil: NOW + 24 * HOUR } }) } }, snapshots: { market: market('elering') } });
  t.after(() => fixture.close());
  assert.deepEqual(issuesFor(await fixture.status(), 'Published electricity prices'), []);
});

test('FMI missing solar is a partial primary source even when Open-Meteo completes the current weather feed', async t => {
  const fixture = createSourceHealthFixture({ providerHealth: { weather: {
    status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'fmi', selected: 'fmi', solarSource: 'openmeteo', attempts: [
      { ...successfulAttempt('fmi'), healthStatus: 'partial', solarStatus: 'unavailable' },
      { ...successfulAttempt('openmeteo'), healthStatus: 'ok', solarStatus: 'available' }] },
    sourceBackoff: {}, standby: standby('ok', { solarStatus: 'available',
      coverage: { current: true, gaps: false, knownUntil: NOW + 24 * HOUR } }) } },
    snapshots: { weather: forecast('fmi') } });
  t.after(() => fixture.close());
  const health = await fixture.status(), warnings = issuesFor(health, 'Weather forecast');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].sourceLabel, 'FMI'); assert.equal(warnings[0].sourceRole, 'primary');
  assert.equal(warnings[0].status, 'partial');
  assert.equal(warnings[0].feed.status, 'available', 'combined usable feed is assessed independently of partial primary');
  assert.match(warnings[0].reason.toLowerCase(), /solar/);
});

test('expired supplemental Open-Meteo solar reports its own issue while fresh FMI temperature remains available', async t => {
  const current = forecast('fmi');
  current.forecast[0].solar = { source: 'openmeteo', issuedAt: NOW - 7 * HOUR, fetchedAt: NOW - 7 * HOUR };
  const fixture = createSourceHealthFixture({ providerHealth: { weather: {
    status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'fmi', selected: 'fmi', attempts: [successfulAttempt('fmi')] } } },
    snapshots: { weather: current } });
  t.after(() => fixture.close());
  const warnings = issuesFor(await fixture.status(), 'Weather forecast');
  assert.equal(warnings.length, 1); assert.equal(warnings[0].sourceLabel, 'Open-Meteo');
  assert.equal(warnings[0].sourceRole, 'backup'); assert.equal(warnings[0].status, 'stale');
  assert.equal(warnings[0].feed.status, 'partial'); assert.equal(warnings[0].feed.sourceLabel, 'FMI');
  assert.equal(warnings[0].lastCheckedAt, NOW - 7 * HOUR);
});

test('partial backup solar and published-price coverage warn about the backup while current feeds remain usable', async t => {
  const fixture = createSourceHealthFixture({ providerHealth: {
    weather: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [successfulAttempt('fmi')] },
      standby: standby('partial', { solarStatus: 'unavailable',
        coverage: { current: true, gaps: false, knownUntil: NOW + 24 * HOUR } }) },
    market: { status: 'ok', source: 'entsoe', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'entsoe', selected: 'entsoe', attempts: [successfulAttempt('entsoe')] },
      standby: standby('partial', { source: 'elering', coverage: { current: true,
        completeToday: false, gaps: true, knownUntil: NOW + HOUR } }) } },
    snapshots: { weather: forecast('fmi'), market: market('entsoe') } });
  t.after(() => fixture.close());
  const health = await fixture.status(), warnings = providerIssues(health);
  assert.equal(warnings.length, 2);
  for (const [label, source] of [['Weather forecast', 'Open-Meteo'], ['Published electricity prices', 'Elering']]) {
    const warning = warnings.find(issue => issue.label === label);
    assert.equal(warning.sourceLabel, source); assert.equal(warning.sourceRole, 'backup');
    assert.equal(warning.status, 'partial'); assert.equal(warning.feed.status, 'available');
  }
  assert.match(warnings.find(issue => issue.label === 'Weather forecast').reason.toLowerCase(), /solar/);
});

test('unpublished tomorrow prices do not manufacture a partial provider or current-feed outage', async t => {
  const endOfToday = NOW + 11 * HOUR;
  const fixture = createSourceHealthFixture({ providerHealth: { market: {
    status: 'ok', source: 'entsoe', lastAttemptAt: NOW - 20_000,
    acquisition: { primary: 'entsoe', selected: 'entsoe', attempts: [successfulAttempt('entsoe')],
      coverage: { current: true, completeToday: true, gaps: false, knownUntil: endOfToday } },
    standby: standby('ok', { source: 'elering', coverage: { current: true, completeToday: true,
      gaps: false, knownUntil: endOfToday } }) } }, snapshots: { market: market('entsoe', {
    coverage: { current: true, completeToday: true, gaps: false, knownUntil: endOfToday },
    intervals: [{ source: 'entsoe', start: NOW - HOUR, end: endOfToday, fetchedAt: NOW - MINUTE, spotCtPerKwh: 0 }] }) } });
  t.after(() => fixture.close());
  assert.deepEqual(issuesFor(await fixture.status(), 'Published electricity prices'), []);
});

test('backoff preserves the real failed request clock and a later success clears the same provider issue', async t => {
  const originalFailureAt = NOW - 10 * MINUTE;
  const fixture = createSourceHealthFixture({ fmi: 'never', openmeteo: 'fresh', providerHealth: { outdoor: {
    status: 'fallback', source: 'openmeteo', lastAttemptAt: NOW,
    acquisition: { primary: 'fmi', selected: 'openmeteo', attempts: [
      { source: 'fmi', status: 'backoff', error: 'HTTP-503' }, successfulAttempt('openmeteo')] },
    sourceBackoff: { fmi: blocked(originalFailureAt) }, standby: standby('ok') } } });
  t.after(() => fixture.close());
  const health = await fixture.status(), issue = issuesFor(health, 'Outdoor temperature')[0];
  assert.equal(issue.sourceLabel, 'FMI');
  assert.equal(issue.lastCheckedAt, originalFailureAt, 'skipping a request is not a new polling attempt');
  const state = fixture.store.getState('providers:health');
  state.outdoor.acquisition = { primary: 'fmi', selected: 'fmi', attempts: [successfulAttempt('fmi')] };
  state.outdoor.sourceBackoff = {}; state.outdoor.source = 'fmi';
  fixture.store.setState('providers:health', state);
  fixture.engine.ingest({ source: 'fmi', device: 'synthetic-fmi', signal: 'outdoor_temperature', value: 0,
    unit: 'degC', sourceTime: NOW, receivedAt: NOW, quality: [] });
  assert.deepEqual(issuesFor(await fixture.status(), 'Outdoor temperature'), []);
});

test('shared provider cooldowns retain their owning job and never invent a failed outdoor polling attempt', async t => {
  const failureAt = NOW - 10 * MINUTE;
  const fixture = createSourceHealthFixture({ fmi: 'fresh', providerHealth: { weather: {
    status: 'error', source: null, lastAttemptAt: failureAt,
    acquisition: { primary: 'fmi', selected: null, attempts: [{ ...failedAttempt('fmi'), error: 'HTTP-429',
      attemptedAt: failureAt, checkedAt: failureAt }] },
    sourceBackoff: { fmi: { ...blocked(failureAt), error: 'HTTP-429', shared: true, job: 'weather', nextAttemptAt: NOW + HOUR } } } } });
  let runtime;
  t.after(async () => { await runtime?.close(); await fixture.close(); });
  let outdoorCalled = false;
  const resultAcquisition = { primary: 'fmi', selected: 'openmeteo', fallbackUsed: true,
    attempts: [{ source: 'fmi', status: 'backoff', error: null }, { ...successfulAttempt('openmeteo'), attemptedAt: NOW, checkedAt: NOW }] };
  runtime = startProviders({ engine: fixture.engine, store: fixture.store,
    config: { connections: { geoloc: { latitude: 60, longitude: 25 } }, settings: {}, acquisition: {
      weatherIntervalMs: 24 * HOUR, outdoorIntervalMs: 24 * HOUR } }, devices: {}, automatic: false,
    clock: fixture.now, canControl: () => true,
    http: { async json() { throw Error('Fixture attempted a service request'); }, async text() { throw Error('Fixture attempted a service request'); }, close() {} },
    weather: async args => { const result = { ...forecast(), acquisition: resultAcquisition };
      args.onSourceResult?.({ source: 'openmeteo', result, attemptedAt: NOW }); return result; },
    outdoor: async args => {
      outdoorCalled = true; assert(args.skipSources.includes('fmi'), 'weather rate limit correctly delays outdoor FMI request');
      const result = [{ source: 'openmeteo', device: 'synthetic-openmeteo', signal: 'outdoor_temperature',
        value: 0, unit: 'degC', sourceTime: NOW, receivedAt: NOW, quality: ['estimated'] }];
      result.acquisition = resultAcquisition;
      args.onSourceResult?.({ source: 'openmeteo', result, attemptedAt: NOW }); return result;
    } });
  const settled = await runtime.runDue(); assert(settled.every(row => row.status === 'fulfilled'));
  assert.equal(outdoorCalled, true);
  const saved = fixture.store.getState('providers:health');
  assert.equal(saved.outdoor.sourceBackoff.fmi.job, 'weather');
  assert.equal(saved.outdoor.sourceBackoff.fmi.lastCheckedAt, failureAt);
  assert.equal(saved.outdoor.acquisition.attempts[0].checkedAt, undefined, 'no clock is attached to skipped provider');
  assert.equal(saved.outdoor.acquisition.attempts[1].checkedAt, NOW);
  const before = changes(fixture), health = await fixture.status();
  assert.deepEqual(issuesFor(health, 'Outdoor temperature'), [], 'foreign cooldown is not a failed outdoor reading or request');
  const warning = issuesFor(health, 'Weather forecast').find(issue => issue.sourceLabel === 'FMI');
  assert(warning); assert.equal(warning.lastCheckedAt, failureAt);
  assert.equal(changes(fixture), before);
});

test('malformed provider metadata cannot leak raw values or prevent independent stream warnings', async t => {
  const privateDetail = 'synthetic-private-provider-response';
  const fixture = createSourceHealthFixture({ garage: 'unavailable', providerHealth: { weather: {
    status: 'error', source: 'fmi', lastAttemptAt: NOW + HOUR,
    acquisition: { primary: 'fmi', selected: 'fmi', attempts: [null, { source: 'fmi', status: privateDetail,
      attemptedAt: NOW + HOUR, checkedAt: privateDetail, error: privateDetail }] },
    standby: { source: 'openmeteo', status: 'error', lastCheckedAt: NOW + HOUR, error: privateDetail },
    sourceBackoff: { fmi: { lastAttemptAt: -1, lastCheckedAt: privateDetail, error: privateDetail } } } } });
  t.after(() => fixture.close());
  const before = changes(fixture), health = await fixture.status();
  assert.equal(issuesFor(health, 'Garage front pipe estimate').length, 1);
  assert(!JSON.stringify(health).includes(privateDetail));
  assert.equal(changes(fixture), before);
});

test('an unsupported standby outcome with a recent clock cannot suppress an actual stale outdoor stream', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'stale', openmeteo: 'stale', providerHealth: { outdoor: {
    status: 'error', source: 'fmi', acquisition: { primary: 'fmi', selected: 'fmi', attempts: [] },
    standby: standby('unsupported-synthetic-status', { lastCheckedAt: NOW, lastAttemptAt: NOW }) } } });
  t.after(() => fixture.close());
  const warnings = issuesFor(await fixture.status(), 'Outdoor temperature');
  assert.deepEqual(warnings.map(issue => [issue.sourceLabel, issue.kind, issue.status]).sort(), [
    ['FMI', 'stream', 'stale'], ['Open-Meteo', 'stream', 'stale']].sort());
});

test('exact fixed outdoor expiry and periodic Garage expiry agree with their production owners', async t => {
  for (const age of [30 * MINUTE - 1, 30 * MINUTE, 30 * MINUTE + 1]) {
    const fixture = createSourceHealthFixture({ fmi: 'fresh', fmiAge: age });
    try {
      const health = await fixture.status(), warnings = issuesFor(health, 'Outdoor temperature');
      assert.equal(warnings.length, Number(age > 30 * MINUTE));
      assert.equal(fixture.engine.outdoorObservation(NOW).stale, age > 30 * MINUTE);
    } finally { await fixture.close(); }
  }
  const fixture = createSourceHealthFixture({ garage: 'fresh' });
  t.after(() => fixture.close());
  fixture.setTime(NOW - 1000 + 120_000);
  fixture.engine.latestStatus = { now: fixture.now() };
  assert.equal(issuesFor(await fixture.status(), 'Garage front pipe estimate').length, 1,
    'periodic report expires at its exact promised reporting deadline');
});

test('unallowlisted source identities, devices and raw diagnostics never leak into source warnings', async t => {
  const secret = 'synthetic-private-publisher-address-and-token';
  const fixture = createSourceHealthFixture({ events: [{ source: secret, device: secret, signal: 'supply_temperature',
    value: null, unit: 'degC', sourceTime: null, receivedAt: NOW, quality: ['missing', secret], raw: { error: secret } }],
    providerHealth: { weather: { status: 'error', source: secret, lastAttemptAt: NOW,
      acquisition: { primary: secret, selected: secret, attempts: [failedAttempt(secret)] },
      sourceBackoff: { [secret]: { ...blocked(NOW), error: secret } } } } });
  t.after(() => fixture.close());
  const health = await fixture.status();
  assert(!JSON.stringify(health).includes(secret));
  const issue = issuesFor(health, 'Heating supply')[0];
  assert(issue); assert.equal(issue.kind, 'stream');
  assert.equal(issue.sourceLabel, null); assert.equal(issue.sourceRole, null); assert.equal(issue.feed, null);
});

test('replica health never inspects copied provider evidence or claims live source readiness', async t => {
  const fixture = createSourceHealthFixture({ fmi: 'fresh', openmeteo: 'failed' });
  t.after(() => fixture.close());
  t.mock.method(fixture.engine, 'recordingSourceStatus', () => { throw Error('Replica inspected live recording sources'); });
  const original = fixture.store.getState.bind(fixture.store);
  t.mock.method(fixture.store, 'getState', key => { assert(!key.startsWith('provider:') && key !== 'providers:health'); return original(key); });
  const before = changes(fixture), health = await fixture.status({ readOnly: true });
  assert.equal(health.recording.state, 'read-only'); assert.equal(health.recording.sources, null);
  assert.equal(changes(fixture), before);
});
