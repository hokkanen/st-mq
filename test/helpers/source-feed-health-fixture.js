// Invented provider and measurement evidence shared by the warning regression
// tests and exact-section browser proof. This fixture never starts acquisition.
import { Store } from '../../src/storage/store.js';
import { Engine } from '../../src/app/engine.js';
import { createRecordingHealth } from '../../src/app/recording-health.js';
import { GARAGE_SENDER_CONTRACT } from '../../src/garage/sender.js';

export const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const NOW = Date.parse('2026-10-28T11:00:00Z');
export const SOURCE_STATES = ['fresh', 'stale', 'unavailable', 'failed', 'never'];
export const STATE_LABELS = { fresh: 'Available / fresh', stale: 'Stale', unavailable: 'Unavailable reading',
  failed: 'Request failed', never: 'Never reported' };
const garageRaw = { usableForControl: false, estimated: true, schema: GARAGE_SENDER_CONTRACT,
  reportIntervalMs: 30_000, reportGraceMs: 90_000 };

export function outdoorDefinitions() {
  return SOURCE_STATES.flatMap(fmi => SOURCE_STATES.map(openmeteo => ({ fmi, openmeteo,
    garage: 'unavailable', indoor: 'fresh', matrix: true,
    title: `FMI ${STATE_LABELS[fmi]} / Open-Meteo ${STATE_LABELS[openmeteo]}` })));
}

export function providerProofDefinitions() {
  const attempt = (source, status = 'ok', extra = {}) => ({ source, status, attemptedAt: NOW - 20_000,
    checkedAt: NOW - 20_000, error: status === 'error' ? 'HTTP-503' : null, ...extra });
  const check = (source, status = 'ok', extra = {}) => ({ source, status, checking: false,
    lastAttemptAt: NOW - 20_000, lastCheckedAt: NOW - 20_000,
    lastSuccessAt: status === 'ok' ? NOW - 20_000 : null, nextAttemptAt: NOW + HOUR,
    sourceObservedAt: status === 'ok' && source === 'openmeteo' ? NOW - MINUTE : null,
    coverage: { current: true, completeToday: true, gaps: false, knownUntil: NOW + 24 * HOUR },
    solarStatus: source === 'openmeteo' ? 'available' : null, error: status === 'error' ? 'HTTP-503' : null, ...extra });
  const blocked = source => [source, { status: 'error', failures: 1, error: 'HTTP-503',
    lastAttemptAt: NOW - 20_000, lastCheckedAt: NOW - 20_000, nextAttemptAt: NOW + MINUTE }];
  const snapshot = (name, source, extra = {}) => name === 'weather'
    ? { source, issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE, forecast: [{ source,
      issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE, start: NOW - HOUR, end: NOW + 24 * HOUR,
      outdoorC: 0, solarRadiationWm2: 0 }], ...extra }
    : { source, issuedAt: NOW - MINUTE, fetchedAt: NOW - MINUTE,
      coverage: { current: true, completeToday: true, gaps: false, knownUntil: NOW + 24 * HOUR },
      intervals: [{ source, start: NOW - HOUR, end: NOW + 24 * HOUR, fetchedAt: NOW - MINUTE, spotCtPerKwh: 0 }], ...extra };
  const definitions = [{ title: 'Outdoor backup check fails while FMI remains available', fmi: 'fresh', openmeteo: 'stale', garage: 'unavailable',
    providerHealth: { outdoor: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [attempt('fmi')] }, standby: check('openmeteo', 'error') } } },
  { title: 'FMI request failed before any FMI observation; Open-Meteo supplies outdoor temperature', fmi: 'never', openmeteo: 'fresh',
    providerHealth: { outdoor: { status: 'fallback', source: 'openmeteo', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'openmeteo', attempts: [attempt('fmi', 'error'), attempt('openmeteo')] },
      sourceBackoff: Object.fromEntries([blocked('fmi')]), standby: check('openmeteo') } } }];
  for (const [name, primary, backup, label] of [['weather', 'fmi', 'openmeteo', 'Weather forecast'],
    ['market', 'entsoe', 'elering', 'Published electricity prices']]) {
    for (const [primaryFailed, backupFailed] of [[false, false], [true, false], [false, true], [true, true]]) {
      const selected = primaryFailed ? backupFailed ? null : backup : primary;
      definitions.push({ title: `${label}: ${primary} ${primaryFailed ? 'failed' : 'available'}; ${backup} ${backupFailed ? 'failed' : 'available'}`,
        garage: 'unavailable', providerHealth: { [name]: { status: selected ? primaryFailed ? 'fallback' : 'ok' : 'error',
          source: selected, lastAttemptAt: NOW - 20_000,
          acquisition: { primary, selected, attempts: [attempt(primary, primaryFailed ? 'error' : 'ok'),
            ...(primaryFailed ? [attempt(backup, backupFailed ? 'error' : 'ok')] : [])] },
          sourceBackoff: Object.fromEntries([...(primaryFailed ? [blocked(primary)] : []), ...(backupFailed ? [blocked(backup)] : [])]),
          standby: check(backup, backupFailed ? 'error' : 'ok') } },
        snapshots: selected ? { [name]: snapshot(name, selected) } : {} });
    }
  }
  definitions.push({ title: 'Weather primary lacks solar; Open-Meteo completes the current forecast', garage: 'unavailable',
    providerHealth: { weather: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'fmi', solarSource: 'openmeteo', attempts: [
        attempt('fmi', 'ok', { healthStatus: 'partial', solarStatus: 'unavailable' }),
        attempt('openmeteo', 'ok', { healthStatus: 'ok', solarStatus: 'available' })] }, standby: check('openmeteo') } },
    snapshots: { weather: snapshot('weather', 'fmi') } },
  { title: 'Weather backup lacks solar while the current FMI forecast is complete', garage: 'unavailable',
    providerHealth: { weather: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [attempt('fmi')] },
      standby: check('openmeteo', 'partial', { solarStatus: 'unavailable' }) } },
    snapshots: { weather: snapshot('weather', 'fmi') } },
  { title: 'Elering backup has incomplete published coverage while ENTSO-E is available', garage: 'unavailable',
    providerHealth: { market: { status: 'ok', source: 'entsoe', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'entsoe', selected: 'entsoe', attempts: [attempt('entsoe')] },
      standby: check('elering', 'partial', { coverage: { current: true, completeToday: false, gaps: true, knownUntil: NOW + HOUR } }) } },
    snapshots: { market: snapshot('market', 'entsoe') } });
  const solar = snapshot('weather', 'fmi');
  solar.forecast[0].solar = { source: 'openmeteo', issuedAt: NOW - 7 * HOUR, fetchedAt: NOW - 7 * HOUR };
  definitions.push({ title: 'Current FMI temperatures with expired Open-Meteo solar evidence', garage: 'unavailable',
    providerHealth: { weather: { status: 'ok', source: 'fmi', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'fmi', selected: 'fmi', attempts: [attempt('fmi')] } } }, snapshots: { weather: solar } },
  { title: 'Elering-only installation with intentionally unconfigured ENTSO-E', garage: 'unavailable',
    providerHealth: { market: { status: 'fallback', source: 'elering', lastAttemptAt: NOW - 20_000,
      acquisition: { primary: 'entsoe', selected: 'elering', attempts: [
        { source: 'entsoe', status: 'not-configured', error: null }, attempt('elering')] }, standby: check('elering') } },
    snapshots: { market: snapshot('market', 'elering') } });
  for (const [name, primary, backup, label] of [['outdoor', 'fmi', 'openmeteo', 'Outdoor temperature'],
    ['weather', 'fmi', 'openmeteo', 'Weather forecast'], ['market', 'entsoe', 'elering', 'Published electricity prices']]) {
    const neverChecked = name === 'weather';
    definitions.push({ title: `${label}: backup health check overdue while primary is available`, garage: 'unavailable',
      ...(name === 'outdoor' ? { fmi: 'fresh', openmeteo: 'stale' } : {}),
      providerHealth: { [name]: { status: 'ok', source: primary, lastAttemptAt: NOW - 20_000,
        acquisition: { primary, selected: primary, attempts: [attempt(primary)] },
        standby: check(backup, neverChecked ? 'waiting' : 'ok', { lastAttemptAt: neverChecked ? null : NOW - 3 * HOUR,
          lastCheckedAt: neverChecked ? null : NOW - 3 * HOUR, lastSuccessAt: neverChecked ? null : NOW - 3 * HOUR,
          sourceObservedAt: null, nextAttemptAt: NOW - 2 * HOUR }) } },
      snapshots: name === 'outdoor' ? {} : { [name]: snapshot(name, primary) } });
  }
  return definitions;
}

export function createSourceHealthFixture(definition = {}) {
  let at = NOW - 90 * MINUTE;
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'mqtt', connections: {}, settings: {} }, clock: () => at });
  const events = [];
  function source(source, signal, state, age, extra = {}) {
    if (!state || state === 'never') return;
    const first = state === 'fresh' ? NOW - (age ?? MINUTE) : state === 'stale' ? NOW - 45 * MINUTE : NOW - HOUR;
    const raw = source === 'garage-sender' ? garageRaw : undefined;
    const quality = ['openmeteo', 'garage-sender'].includes(source) ? ['estimated'] : [];
    events.push({ source, device: `synthetic-${source}`, signal, value: signal === 'indoor_temperature' ? 21 : 10,
      unit: 'degC', sourceTime: first, receivedAt: first, quality, raw, ...extra });
    if (['unavailable', 'failed'].includes(state)) events.push({ source, device: `synthetic-${source}`, signal,
      value: null, unit: 'degC', sourceTime: null, receivedAt: NOW - 20_000,
      quality: [state === 'failed' ? 'provider_error' : 'missing'], raw, ...extra });
  }
  source('fmi', 'outdoor_temperature', definition.fmi, definition.fmiAge);
  source('openmeteo', 'outdoor_temperature', definition.openmeteo, definition.openmeteoAge);
  source('mqtt-temperature', 'indoor_temperature', definition.indoor ?? 'fresh');
  if (definition.garage === 'unavailable') {
    events.push({ source: 'garage-sender', device: 'synthetic-garage', signal: 'garage_pipe_front_temperature',
      value: 15, unit: 'degC', sourceTime: NOW - 1000, receivedAt: NOW - 1000, quality: ['estimated'], raw: garageRaw });
    events.push({ source: 'garage-sender', device: 'synthetic-garage', signal: 'garage_pipe_front_temperature',
      value: null, unit: 'degC', sourceTime: NOW, receivedAt: NOW, quality: ['unknown'], raw: garageRaw });
  } else source('garage-sender', 'garage_pipe_front_temperature', definition.garage, 1000);
  for (const event of [...events, ...(definition.events ?? [])].sort((a, b) => a.receivedAt - b.receivedAt)) {
    at = event.receivedAt; engine.ingest(event);
  }
  at = NOW;
  const selected = engine.selectOutdoor(NOW), selectedSource = selected.observation?.source ?? null;
  const defaultOutdoor = { source: selectedSource, status: selected.stale ? 'error' : 'ok',
    acquisition: { primary: 'fmi', selected: selectedSource, attempts: [] } };
  store.setState('providers:health', { ...(definition.providerHealth ?? {}),
    ...(definition.fmi || definition.openmeteo ? { outdoor: definition.providerHealth?.outdoor ?? defaultOutdoor } : {}) });
  for (const [name, snapshot] of Object.entries(definition.snapshots ?? {})) store.setState(`provider:${name}`, snapshot);
  engine.latestStatus = { now: NOW };
  at = definition.startup ? NOW : NOW - 4 * MINUTE;
  const health = createRecordingHealth({ clock: () => at,
    backupCatalog: { async list() { return { copies: [], complete: true, reasons: [], checkedAt: at }; } } });
  at = NOW;
  return { store, engine, health, definition, selectedSource: selected.stale ? null : selectedSource,
    now: () => at, setTime: value => { at = value; },
    status: options => health.status({ store, engine, current: engine.latestStatus, ...options }),
    async close() {
      engine.beginShutdown({ restore: false }); await engine.charging.close();
      await engine.garage.close({ restore: false }); await engine.closeFireplace();
      await engine.executor.close({ restore: false }); store.close();
    } };
}
