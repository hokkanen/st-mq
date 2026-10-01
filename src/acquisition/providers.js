import { weatherAcquisitionIdentity } from './weather-identity.js';
import { voltageTelemetryAt } from '../storage/voltage.js';
import { PROVIDER_CURRENT_ATTENTION_MS, PROVIDER_TEMPERATURE_ATTENTION_MS } from '../domain/reading-freshness.js';
import { join } from 'node:path';
import { createHttp, providerFailureCode } from './http.js';
import { fileTokenStore } from './token-store.js';
import { ocppInstallation } from './easee-ocpp-setup.js';
import { createDeviceProviders } from './devices.js';
import { fetchMarket } from './market.js';
import { resolveMarketIntervals } from '../domain/market-authority.js';
import { fetchWeather, fetchOutdoorTemperature } from './weather.js';
import { ElectricityAccumulator } from '../domain/electricity.js';
import { recordEaseeSessionChecks } from './easee-session-checks.js';

const MINUTE = 60_000;
const present = value => typeof value === 'string' && value.trim().length > 0;
const errorCode = providerFailureCode;
const SOURCES = new Set(['entsoe', 'elering', 'fmi', 'openmeteo']);
const OBSERVATION_SOURCES = ['easee', 'fmi', 'openmeteo'];
const QUALITY_ISSUES = new Set(['future_source_time', 'source_time_unknown', 'stale', 'charger_stale', 'property_stale',
  'implausible_temperature', 'suspect_zero_indoor', 'implausible_current', 'negative_current',
  'all_zero_property_current', 'ev_exceeds_property_current']);
const DOWNLOAD_ISSUES = new Set(['provider_error', 'missing_configuration', 'invalid_unit',
  'invalid_numeric', 'conflicting_duplicate', 'missing']);
const CURRENT_ISSUES = new Set(['future_source_time', 'source_time_unknown', 'charger_stale', 'property_stale',
  'implausible_current', 'negative_current', 'all_zero_property_current', 'ev_exceeds_property_current',
  ...DOWNLOAD_ISSUES]);
const CURRENT_GROUPS = { charger: 'ev1', property: 'property' };
const COMPLETED_STATES = new Set(['ok', 'fallback', 'degraded', 'error']);
const qualityIssues = flags => Array.isArray(flags) ? [...new Set(flags.filter(flag => QUALITY_ISSUES.has(flag)))] : [];
const STALE_ISSUES = new Set(['stale', 'charger_stale', 'property_stale']);
const validSourceTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const savedStaleSourceTimes = times => Object.fromEntries(Object.entries(times ?? {})
  .filter(([flag, at]) => STALE_ISSUES.has(flag) && validSourceTime(at)));
// Attention thresholds are separate from the stricter freshness checks used for
// control. Preserve those observations, and keep idle charger age informational.
function observationQuality(name, rows, now) {
  const staleSourceTimes = {};
  const issues = rows.flatMap(row => {
    // Null placeholders following a failed request are not malformed readings
    // supplied by the device. Report the request failure separately.
    if (row.quality.includes('provider_error')) return [];
    const maximumAge = /_current_l[123]$/.test(row.signal) ? PROVIDER_CURRENT_ATTENTION_MS
      : /_temperature$/.test(row.signal) ? PROVIDER_TEMPERATURE_ATTENTION_MS : null;
    const stale = maximumAge === null ? row.quality.includes('stale')
      : validSourceTime(row.sourceTime) && now - row.sourceTime >= maximumAge;
    const flags = row.quality.filter(flag => !STALE_ISSUES.has(flag));
    if (stale) {
      const flag = name === 'easee' && /^ev1_current_l[123]$/.test(row.signal) ? 'charger_stale'
        : name === 'easee' && /^property_current_l[123]$/.test(row.signal) ? 'property_stale' : 'stale';
      flags.push(flag);
      if (validSourceTime(row.sourceTime)) staleSourceTimes[flag] = Math.min(staleSourceTimes[flag] ?? Infinity, row.sourceTime);
    }
    return flags;
  });
  return { issues: qualityIssues(issues), staleSourceTimes };
}
const savedError = error => ['incomplete-market-coverage', 'missing-or-invalid-observations', 'provider-request-failed'].includes(error)
  ? error : error ? safeFailure(error) : null;
const safeFailure = value => typeof value === 'string' && /^HTTP-[1-5]\d{2}$/.test(value)
  ? value : providerFailureCode({ code: value });
const currentError = value => value === 'missing-or-invalid-observations' ? value : value ? safeFailure(value) : null;
const currentIssues = (group, flags) => [...new Set((Array.isArray(flags) ? flags : [])
  .filter(flag => CURRENT_ISSUES.has(flag)
    && (flag !== 'charger_stale' || group === 'charger')
    && (!['property_stale', 'all_zero_property_current'].includes(flag) || group === 'property')))];
function observationFailure(rows) {
  if (rows.length && !rows.some(row => row.value === null || row.quality.some(flag => DOWNLOAD_ISSUES.has(flag)))) return null;
  const status = rows.flatMap(row => row.quality).find(flag => /^http_status_[1-5]\d{2}$/.test(flag));
  if (status) return status.replace('http_status_', 'HTTP-');
  const failedRequest = rows.find(row => row.quality.includes('provider_error'));
  return failedRequest ? safeFailure(failedRequest.raw?.error) : 'missing-or-invalid-observations';
}
function savedCurrentReadings(previous, configured) {
  const candidate = previous?.currentReadings;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const groups = Object.keys(CURRENT_GROUPS).filter(group => configured.includes(group)
    && candidate[group] && typeof candidate[group] === 'object' && !Array.isArray(candidate[group]));
  if (!groups.length) return undefined;
  return Object.fromEntries(groups.map(group => {
    const row = candidate[group];
    return [group, { qualityIssues: currentIssues(group, row.qualityIssues),
      error: currentError(row.error), lastSuccessAt: validSourceTime(row.lastSuccessAt) ? row.lastSuccessAt : null }];
  }));
}
function currentReadings(rows, configured, previous, now) {
  const result = {};
  for (const [group, prefix] of Object.entries(CURRENT_GROUPS)) {
    const readings = rows.filter(row => new RegExp(`^${prefix}_current_l[123]$`).test(row.signal));
    if (!configured.includes(group) && !readings.length) continue;
    const error = observationFailure(readings);
    result[group] = { qualityIssues: currentIssues(group, [
      ...readings.flatMap(row => row.quality.includes('provider_error') ? [] : row.quality.filter(flag => !STALE_ISSUES.has(flag))),
      ...observationQuality('easee', readings, now).issues,
    ]), error, lastSuccessAt: error ? previous?.[group]?.lastSuccessAt ?? null : now };
  }
  return result;
}
const boundedDelay = value => Number.isFinite(value) ? Math.min(24 * 60 * MINUTE, Math.max(0, value)) : 0;
function backoff(failures, error, requested = 0, initialDelay = 5 * MINUTE) {
  return Math.max(boundedDelay(requested), /HTTP-(401|403)/.test(error ?? '') ? 30 * MINUTE
    : Math.min(30 * MINUTE, initialDelay * 2 ** (Math.max(1, failures) - 1)));
}
function configuredLocation(connections) {
  const { latitude, longitude } = connections.geoloc ?? {};
  return [latitude, longitude].every(value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)))
    && Math.abs(Number(latitude)) <= 90 && Math.abs(Number(longitude)) <= 180;
}

function acquisitionInfo(raw) {
  if (!raw || !SOURCES.has(raw.primary) || !Array.isArray(raw.attempts)) return null;
  const info = { primary: raw.primary, selected: SOURCES.has(raw.selected) ? raw.selected : null,
    fallbackUsed: raw.fallbackUsed === true,
    attempts: raw.attempts.slice(0, 4).filter(row => SOURCES.has(row?.source)).map(row => ({
      source: row.source, status: ['ok', 'error', 'not-configured', 'incomplete', 'backoff'].includes(row.status) ? row.status : 'error',
      error: row.error ? safeFailure(row.error) : null, retryAfterMs: boundedDelay(row.retryAfterMs),
    })) };
  if (['fmi', 'openmeteo', 'mixed'].includes(raw.solarSource)) info.solarSource = raw.solarSource;
  if (raw.coverage) info.coverage = {
    current: raw.coverage.current === true, completeToday: raw.coverage.completeToday === true,
    gaps: raw.coverage.gaps === true,
    knownUntil: Number.isSafeInteger(raw.coverage.knownUntil) ? raw.coverage.knownUntil : null,
  };
  return info;
}

function noteAcquisition(state, raw, now) {
  const info = acquisitionInfo(raw);
  if (!info) return;
  for (const attempt of info.attempts) {
    if (attempt.status === 'ok') delete state.sourceBackoff[attempt.source];
    else if (['error', 'incomplete'].includes(attempt.status)) {
      const failures = Math.min(10, (state.sourceBackoff[attempt.source]?.failures ?? 0) + 1);
      state.sourceBackoff[attempt.source] = { failures, error: attempt.error ?? 'provider-request-failed',
        nextAttemptAt: now + backoff(failures, attempt.error, attempt.retryAfterMs),
        shared: /HTTP-(401|403|429)/.test(attempt.error ?? '') || attempt.retryAfterMs > 0 };
    }
  }
  state.acquisition = info;
}

function cacheWeather(previous, result, snapshotId, now) {
  const rows = result.forecast.map(row => ({ ...row, snapshotId }));
  const first = Math.min(...rows.map(row => row.start));
  const earlier = previous?.source === result.source && Array.isArray(previous.forecast)
    ? previous.forecast.slice(0, 80).filter(row => {
      const at = row.issuedAt == null && row.issuedAtBasis === 'fetched-snapshot' ? row.fetchedAt : row.issuedAt;
      return row.end > now && row.end <= first && row.start < row.end
        && Number.isFinite(at) && now >= at && now - at <= 360 * MINUTE
        && Number.isFinite(row.fetchedAt) && now >= row.fetchedAt && now - row.fetchedAt <= 360 * MINUTE;
    }) : [];
  return { ...result, snapshotId, forecast: [...earlier, ...rows].sort((a, b) => a.start - b.start),
    cacheProvenance: { kind: earlier.length ? 'composite-forecast' : 'single-snapshot', latestSnapshotId: snapshotId,
      retainedSnapshotIds: [...new Set(earlier.map(row => row.snapshotId ?? previous.snapshotId).filter(Number.isSafeInteger))] } };
}

/** Independent, read-only acquisition. A failed service retains the original age
 * of its last good data; it cannot postpone control or another provider's poll. */
export function startProviders({ engine, store, config, clock = Date.now, http,
  devices, market = fetchMarket, weather = fetchWeather, outdoor = fetchOutdoorTemperature,
  temperatureProvider, automatic = true, canControl = () => true, streamFactory, ocppFactory } = {}) {
  const connections = config.connections ?? {};
  http ??= createHttp({ allowChargerScheduling: true, allowOcppSetup: true, canControl });
  const location = configuredLocation(connections);
  const ownsDevices = !devices;
  let localInstallation;
  if (ownsDevices) {
    try { localInstallation = ocppInstallation(config, { createCredential: canControl() }); }
    catch { localInstallation = { ...ocppInstallation(config), password: '' }; }
  }
  // This poll supplies the FMI → Open-Meteo weather fallbacks. The engine
  // uses only these weather sources for outdoor temperature.
  devices ??= createDeviceProviders({ connections, http, clock, canControl, streamFactory, ocppFactory,
    retryState: store.getState('providers:health')?.easee,
    ocppState: { get: () => store.getState('easee:ocpp'), set: value => store.setState('easee:ocpp', value) },
    ocppSetupState: { get: () => store.getState('easee:ocpp-setup'), set: value => store.setState('easee:ocpp-setup', value) },
    ocppInstallation: localInstallation,
    onOcppControlTransition: async ({ phase, adapter }) => {
      const charging = engine.charging;
      if (!charging?.pauseForBackendChange || !charging?.finishBackendChange)
        throw Object.assign(new Error('Native charging control is unavailable'), { code: 'native-control-unavailable' });
      try {
        if (phase === 'prepare') return await charging.pauseForBackendChange('charger1');
        const item = charging.charger('charger1');
        if (item.backendTransition) return await charging.finishBackendChange('charger1', adapter);
        if (item.adapter !== adapter) {
          await charging.setAdapter('charger1', adapter);
          if (item.adapter !== adapter || item.error === 'charging-adapter-unavailable') throw new Error('Adapter unavailable');
        }
      } catch { throw Object.assign(new Error('Charging control transition remains pending'), { code: 'control-transition-pending' }); }
    },
    fallbackIntervalMs: config.acquisition?.easeeIntervalMs ?? 15_000,
    onStreamDisconnect: (ids, options) => interruptElectricity(ids, options),
    onChargerObservation: observation => engine.charging?.receiveEaseeObservation(observation),
    tokenStore: fileTokenStore(join(config.dataDir, 'easee-tokens.json'), connections.easee ?? {}) });
  engine.ocppSetup = {
    status: () => devices.localOcppStatus?.({ includeEndpoint: true }) ?? null,
    adopt: revision => devices.adoptOcpp?.(revision) ?? Promise.reject(Object.assign(new Error('Local charger setup is unavailable.'), { statusCode: 409 })),
  };
  if (connections.easee?.charger_id && devices.chargerScheduleControl)
    engine.charging?.setAdapter('charger1', devices.chargerScheduleControl());
  // The charging runtime owns bounded identification pauses and passive matching.
  const easee = connections.easee ?? {}, cadence = config.acquisition ?? {};
  const readTemperatures = typeof temperatureProvider === 'function' ? temperatureProvider
    : typeof devices.temperatures === 'function' ? args => devices.temperatures(args) : null;
  const integrationOptions = { maxAgeMs: cadence.electricityMaxAgeMs ?? 5 * MINUTE,
    maxTelemetryAgeMs: cadence.electricityTelemetryMaxAgeMs ?? 17 * MINUTE,
    maxGapMs: cadence.electricityMaxGapMs ?? MINUTE };
  let electricity = new ElectricityAccumulator({ ...integrationOptions, checkpoint: store.getState('electricity:acquisition') });
  const configuredCurrents = [['charger', 'charger_id'], ['property', 'equalizer_id']]
    .filter(([, key]) => present(easee[key])).map(([group]) => group);
  const definitions = {
    // Live temperatures arrive through MQTT. A supplied adapter supports
    // isolated simulations and alternative in-process acquisition.
    temperatures: { enabled: readTemperatures !== null, period: 5 * MINUTE, run: readTemperatures },
    easee: { enabled: ['charger_id', 'equalizer_id'].some(key => present(easee[key])),
      period: cadence.easeeIntervalMs ?? 15_000, run: args => (devices.electricity ?? devices.easee).call(devices, args) },
    market: { enabled: present(connections.entsoe?.token) || ['fi', 'ee', 'lv', 'lt'].includes(connections.geoloc?.country_code?.toLowerCase()) || Boolean(connections.elering),
      period: cadence.marketIntervalMs ?? 60 * MINUTE, run: args => market({ ...args, connections, http }), snapshot: true, sources: ['entsoe', 'elering'] },
    weather: { enabled: location,
      period: cadence.weatherIntervalMs ?? 30 * MINUTE, run: args => weather({ ...args, connections, http }), snapshot: true, sources: ['fmi', 'openmeteo'] },
    outdoor: { enabled: location, period: cadence.outdoorIntervalMs ?? 5 * MINUTE, run: args => outdoor({ ...args, connections, http }), sources: ['fmi', 'openmeteo'] },
  };
  const health = {}, pending = new Map(), cancellation = new AbortController();
  const saved = store.getState('providers:health') ?? {};
  const weatherIdentity = weatherAcquisitionIdentity(connections);
  const now = clock();
  for (const [name, job] of Object.entries(definitions)) {
    const weatherJob = ['weather', 'outdoor'].includes(name);
    const savedJob = saved[name];
    const previous = weatherJob && savedJob?.acquisitionIdentity !== weatherIdentity
      ? { sourceBackoff: Object.fromEntries(Object.entries(savedJob?.sourceBackoff ?? {}).filter(([, value]) => value.shared === true)) } : savedJob;
    // Honor bounded retry/cadence state on ordinary restarts, never stale running state.
    const due = Number.isFinite(previous?.nextAttemptAt) && previous.nextAttemptAt <= now + 24 * 60 * MINUTE
      ? Math.max(now, previous.nextAttemptAt) : now;
    health[name] = { ...(weatherJob ? { acquisitionIdentity: weatherIdentity } : {}), status: job.enabled ? (COMPLETED_STATES.has(previous?.status) ? previous.status : 'waiting') : 'not-configured',
      lastAttemptAt: previous?.lastAttemptAt ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null,
      nextAttemptAt: job.enabled ? due : null, failures: Math.min(10, Math.max(0, previous?.failures ?? 0)),
      error: job.enabled ? savedError(previous?.error) : null,
      qualityIssues: job.enabled ? qualityIssues(previous?.qualityIssues) : [],
      staleSourceTimes: job.enabled ? savedStaleSourceTimes(previous?.staleSourceTimes) : {},
      ...(job.enabled && acquisitionInfo(previous?.acquisition) ? { acquisition: acquisitionInfo(previous.acquisition) } : {}),
      source: typeof previous?.source === 'string' && OBSERVATION_SOURCES.concat([...SOURCES]).includes(previous.source) ? previous.source : null,
      sourceBackoff: Object.fromEntries(Object.entries(previous?.sourceBackoff ?? {}).filter(([source, state]) =>
        SOURCES.has(source) && Number.isFinite(state?.nextAttemptAt) && state.nextAttemptAt <= now + 24 * 60 * MINUTE)
        .map(([source, state]) => [source, { failures: Math.min(10, Math.max(0, state.failures ?? 0)),
          nextAttemptAt: state.nextAttemptAt, error: safeFailure(state.error),
          shared: state.shared === true || /HTTP-(401|403|429)/.test(safeFailure(state.error)) }])) };
    if (name === 'easee' && job.enabled) {
      const state = health[name];
      const readings = savedCurrentReadings(previous, configuredCurrents);
      if (readings) {
        state.currentReadings = readings;
        state.qualityIssues = qualityIssues(Object.values(readings).flatMap(row => row.qualityIssues));
      }
      // Idle charger age and phase reporting times never require attention,
      // including while waiting for a scheduled poll after restart.
      if (health[name].status === 'degraded' && !health[name].error
        && !health[name].qualityIssues.some(flag => flag !== 'charger_stale')
        && !Object.values(readings ?? {}).some(row => row.error || row.qualityIssues.some(flag => flag !== 'charger_stale')))
        Object.assign(health[name], { status: 'ok', failures: 0 });
    }
  }
  store.setState('providers:health', health);
  let closed = false, timer;
  const interruptedDevices = new Map();

  function streamHealth() {
    health.easee.localOcpp = devices.localOcppStatus?.() ?? null;
    health.easee.deviceTransports = devices.deviceTransports?.() ?? null;
    const stream = devices.streamStatus?.();
    if (stream) {
      health.easee.stream = stream;
      health.easee.transport = devices.acquisitionTransport?.() ?? null;
    }
  }

  function interruptElectricity(ids, { transport } = {}) {
    if (closed || !canControl()) return false;
    for (const id of ids) interruptedDevices.set(JSON.stringify([id, transport ?? null]), { id, transport });
    const interruptions = [...interruptedDevices.values()];
    const affected = row => row && interruptions.some(item => item.id === row.device
      && (item.transport === undefined || row.transport === item.transport));
    // This RAM projection must become unavailable even if the durable gap write
    // fails. The pending boundary is retried before any subsequent integration.
    if (engine.electricitySnapshot) for (const group of ['charger', 'property'])
      if (affected(engine.electricitySnapshot[group])) engine.electricitySnapshot[group] = null;
    const before = electricity.checkpoint(), checkpoint = structuredClone(before), at = clock();
    try { store.transaction(() => {
      for (const item of interruptions) engine.voltage?.interrupt?.({ source: 'easee', devices: [item.id], transport: item.transport, now: at });
      for (const [key, previous] of Object.entries(checkpoint.devices)) {
        if (!affected(previous)) continue;
        engine.recorder?.energyGap?.({ source: 'easee', device: previous.device, prefix: previous.prefix,
          transport: previous.transport, start: Math.min(previous.at, at), end: Math.max(previous.at, at), quality: ['acquisition-failed'] });
        delete checkpoint.devices[key];
        checkpoint.availability[key] = false;
      }
      electricity = new ElectricityAccumulator({ ...integrationOptions, checkpoint });
      store.setState('electricity:acquisition', checkpoint);
      streamHealth();
      store.setState('providers:health', health);
    }); } catch {
      electricity = new ElectricityAccumulator({ ...integrationOptions, checkpoint: before });
      engine.recorder?.reload?.();
      return false;
    }
    interruptedDevices.clear();
    return true;
  }

  if (ownsDevices && canControl()) {
    devices.startStreaming?.();
    if (devices.streamStatus?.()) {
      // A process restart interrupts an unobserved stream interval even when the
      // saved head is less than a minute old. Counter audit heads remain intact.
      interruptElectricity([easee.charger_id, easee.equalizer_id].filter(present));
    }
  }

  async function poll(name) {
    const job = definitions[name], state = health[name], at = clock();
    Object.assign(state, { status: 'running', lastAttemptAt: at });
    store.setState('providers:health', health);
    let failure = null, retryAfterMs = 0, issues = [], staleSourceTimes = {}, readings, missingTomorrow = false, electricityCommitted = false;
    try {
      if (name === 'easee' && interruptedDevices.size && !interruptElectricity([]))
        throw new Error('Electrical interruption could not be saved');
      // Forecast and current weather share provider hosts. A server's rate
      // limit or access denial applies to both routes, while a missing station
      // reading alone must not disable a working forecast.
      for (const other of Object.values(health)) for (const [source, blocked] of Object.entries(other.sourceBackoff)) {
        if (job.sources?.includes(source) && blocked.shared && blocked.nextAttemptAt > at
          && blocked.nextAttemptAt > (state.sourceBackoff[source]?.nextAttemptAt ?? 0)) state.sourceBackoff[source] = { ...blocked };
      }
      const skipSources = Object.entries(state.sourceBackoff).filter(([, value]) => value.nextAttemptAt > at).map(([source]) => source);
      const epoch = name === 'easee' ? devices.electricityEpoch?.() : undefined;
      const result = await job.run({ now: at, clock, signal: cancellation.signal, skipSources });
      if (closed || !canControl()) return;
      if (name === 'easee' && epoch !== devices.electricityEpoch?.())
        throw Object.assign(new Error('Electrical acquisition was interrupted'), { code: 'provider-request-aborted' });
      if (name === 'weather') result.acquisitionIdentity = weatherIdentity;
      if (name === 'outdoor') for (const row of result) row.raw = { ...row.raw, acquisitionIdentity: weatherIdentity };
      noteAcquisition(state, result?.acquisition, clock());
      state.source = result?.acquisition?.selected ?? result?.source ?? (Array.isArray(result) ? result.find(row => row.value !== null)?.source : null) ?? state.source;
      // SQLite rollback must also restore the in-memory view used by decisions.
      const ingestionBefore = engine.ingestionCheckpoint();
      const electricityBefore = electricity.checkpoint();
      try { store.transaction(() => {
        if (job.snapshot) {
          const previous = store.getState(`provider:${name}`);
          const snapshotId = store.snapshot({ kind: name, source: result.source, issuedAt: result.issuedAt,
            fetchedAt: result.fetchedAt, payload: result });
          const priorSnapshot = previous?.snapshotId ? store.snapshotById(previous.snapshotId) : null;
          const nextSnapshot = store.snapshotById(snapshotId);
          const unchanged = name === 'weather' && priorSnapshot?.contentId != null
            && priorSnapshot.contentId === nextSnapshot.contentId && priorSnapshot.source === nextSnapshot.source
            && priorSnapshot.issuedAt === nextSnapshot.issuedAt;
          // Successful re-download is availability evidence, not a new forecast
          // issue. An unchanged forecast keeps its original unknown-issue age.
          const marketRows = name === 'market' ? resolveMarketIntervals([
            ...(previous?.authorityIntervals ?? []), ...(result.intervals ?? []).map(row => ({ ...row,fetchedAt:result.fetchedAt }))].filter(row => row.fetchedAt <= clock()),
          { from: clock() - 24 * 60 * MINUTE, to: clock() + 7 * 24 * 60 * MINUTE }) : null;
          store.setState(`provider:${name}`, unchanged
            ? { ...previous, snapshotId, acquisition: result.acquisition, lastCheckedAt: result.fetchedAt }
            : name === 'weather' ? cacheWeather(previous, result, snapshotId, clock())
              : { ...result, snapshotId, authorityIntervals: marketRows, intervals: marketRows.filter(row => !row.authorityConflict),
                authorityConflict: marketRows.some(row => row.authorityConflict) });
          if (name === 'market' && result.coverage && (!result.coverage.completeToday || result.coverage.gaps)) failure = 'incomplete-market-coverage';
          if (name === 'market' && Array.isArray(result.intervals)) {
            missingTomorrow = Math.max(0, ...result.intervals.map(row => row.end)) < at + 24 * 60 * MINUTE;
          }
        } else {
          if (!Array.isArray(result) || result.length > (name === 'easee' ? 32 : 20)) throw new Error('Invalid observation batch');
          if (name === 'easee') {
            for (const observation of result.filter(row => /_voltage_l[123]$/.test(row.signal)))
              engine.voltage?.ingest(observation, { telemetryAt: voltageTelemetryAt(result, observation, clock()) });
            const sampled = electricity.sample(result, clock());
            for (const interval of sampled.intervals) engine.ingestEnergy?.(interval);
            for (const audit of sampled.audits) store.energyAudit?.(audit);
            for (const gap of sampled.gaps) engine.recorder?.energyGap?.(gap);
            recordEaseeSessionChecks({ store, rows: result, now: clock(),
              flush: device => engine.recorder?.flush?.(clock(), { force: true, source: 'easee', device, prefix: 'ev1' }) });
            store.setState('electricity:acquisition', electricity.checkpoint());
          }
          for (const observation of result) {
            if (name === 'temperatures' && location && observation.signal === 'outdoor_temperature') continue;
            if (name === 'easee' && !/_current_l[123]$/.test(observation.signal)) continue;
            engine.ingest(name === 'easee' ? { ...observation, raw: { ...observation.raw, acquisitionOnly: true } } : observation);
          }
          store.setState('provider:observations', engine.providerObservations()
            .filter(row => OBSERVATION_SOURCES.includes(row.source)));
          retryAfterMs = Math.max(0, ...result.map(row => boundedDelay(row.raw?.retryAfterMs)));
          // Last-reported values can stay unchanged while downloads succeed. Keep
          // their original source ages and warnings without slowing other devices.
          const requiredRows = name === 'easee' ? result.filter(row => /_current_l[123]$/.test(row.signal)) : result;
          ({ issues, staleSourceTimes } = observationQuality(name, requiredRows, clock()));
          failure = observationFailure(requiredRows);
          if (name === 'easee') {
            readings = currentReadings(result, configuredCurrents, state.currentReadings, clock());
            failure ??= Object.values(readings).find(row => row.error)?.error ?? null;
          }
        }
      }); } catch (error) {
        engine.restoreIngestionCheckpoint(ingestionBefore);
        electricity = new ElectricityAccumulator({ ...integrationOptions, checkpoint: electricityBefore });
        engine.recorder?.reload?.();
        throw error;
      }
      if (name === 'easee') {
        const snapshot = { property: null, charger: null };
        for (const row of Object.values(electricity.checkpoint().devices)) {
          if (!result.some(observation => observation.source === 'easee' && observation.device === row.device
            && observation.signal.startsWith(`${row.prefix}_`))) continue;
          const group = row.prefix === 'ev1' ? 'charger' : 'property';
          const sessionStart = result.find(observation => observation.device === row.device
            && observation.signal === 'ev1_active_power')?.raw?.chargingSessionStart?.start;
          const currents = [1, 2, 3].map(phase => result.find(observation => observation.device === row.device
            && observation.signal === `${row.prefix}_current_l${phase}`));
          const activeCurrents = currents.filter(observation => Number.isFinite(observation?.value) && observation.value > 1);
          snapshot[group] = { device: row.device, transport: row.transport, powerKw: row.powers.reduce((sum, value) => sum + value, 0),
            sourceTime: row.sourceTime, receivedAt: row.at, telemetryAt: row.telemetryAt,
            telemetryConfirmed: row.quality.includes('device_telemetry_confirmed'),
            currentA: currents.every(observation => Number.isFinite(observation?.value))
              ? activeCurrents.length ? Math.min(...activeCurrents.map(observation => observation.value)) : 0 : null,
            currentAt: activeCurrents.length ? Math.min(...activeCurrents.map(observation => observation.sourceTime)) : row.sourceTime,
            ...(Number.isSafeInteger(sessionStart) ? { sessionStart } : {}) };
          if (group === 'charger') snapshot[group].sessionKey = sessionStart ?? null;
        }
        // Publish availability only after the complete acquisition transaction.
        // Missing device samples clear prior snapshots instead of renewing them.
        engine.electricitySnapshot = snapshot;
        electricityCommitted = true;
      }
      state.qualityIssues = issues;
      state.staleSourceTimes = staleSourceTimes;
      if (readings) state.currentReadings = readings;
      state.status = failure || issues.some(flag => flag !== 'charger_stale') ? 'degraded' : state.acquisition?.fallbackUsed ? 'fallback' : 'ok';
    } catch (error) {
      if (closed || !canControl()) return;
      noteAcquisition(state, error?.acquisition, clock());
      retryAfterMs = boundedDelay(error?.retryAfterMs);
      state.status = 'error'; failure = errorCode(error);
      if (name === 'easee') {
        const groups = [...new Set([...configuredCurrents, ...Object.keys(state.currentReadings ?? {})])];
        state.currentReadings = Object.fromEntries(groups.map(group => [group, {
          qualityIssues: state.currentReadings?.[group]?.qualityIssues ?? [], error: failure,
          lastSuccessAt: state.currentReadings?.[group]?.lastSuccessAt ?? null,
        }]));
      }
    }
    if (closed || !canControl()) return;
    state.error = failure;
    state.failures = failure ? Math.min(10, state.failures + 1) : 0;
    if (!failure) state.lastSuccessAt = clock();
    // Only failed downloads back off. Successfully received older device state
    // stays on the normal cadence, including when an unused charger is stale.
    // A brief electrical download failure must not impose the five-minute
    // weather retry floor: the energy accumulator cannot bridge that outage.
    // Retry transient failures at the configured acquisition cadence, then
    // back off. Keep rate-limit/client-error cooldowns and every Retry-After.
    const electricalErrors = [failure, ...Object.values(readings ?? {}).map(row => row.error)].filter(Boolean);
    const retryBase = name === 'easee' && !electricalErrors.some(error => /^HTTP-[1-4]/.test(error))
      ? job.period : 5 * MINUTE;
    let delay = failure ? Math.max(...electricalErrors.map(error => backoff(state.failures, error, retryAfterMs, retryBase))) : job.period;
    if (!failure && name === 'market' && missingTomorrow) delay = Math.min(delay, cadence.marketRetryIntervalMs ?? 15 * MINUTE);
    const sourceDelays = (state.acquisition?.attempts ?? []).filter(attempt => attempt.status !== 'not-configured')
      .map(attempt => state.sourceBackoff[attempt.source]?.nextAttemptAt - clock());
    if (failure && sourceDelays.length && sourceDelays.every(value => value > 0)) delay = Math.max(delay, Math.min(...sourceDelays));
    state.nextAttemptAt = clock() + delay;
    if (name === 'easee') streamHealth();
    store.setState('providers:health', health);
    if (electricityCommitted) {
      engine.charging?.tick({now:clock(),force:true});
    }
  }

  function runDue() {
    if (closed || !canControl()) return Promise.resolve([]);
    if (ownsDevices && !pending.has('ocpp-setup')) {
      const flight = Promise.resolve(devices.reconcileOcpp?.()).catch(() => {}).finally(() => pending.delete('ocpp-setup'));
      pending.set('ocpp-setup', flight);
    }
    for (const [name, job] of Object.entries(definitions)) {
      const streamRecovered = name === 'easee' && health[name].error && devices.canSampleStream?.()
        && clock() - (health[name].lastAttemptAt ?? -Infinity) >= job.period;
      if (!job.enabled || pending.has(name) || health[name].nextAttemptAt > clock() && !streamRecovered) continue;
      const flight = poll(name).finally(() => pending.delete(name));
      pending.set(name, flight);
    }
    return Promise.allSettled([...pending.values()]);
  }
  if (automatic) {
    // Acquisition publishes durable readings before the passive charging observer runs.
    void runDue();
    timer = setInterval(() => { void runDue(); }, Math.min(1000, ...Object.values(definitions).filter(job => job.enabled).map(job => job.period)));
    timer.unref();

  }
  return {
    runDue,
    async restoreOcpp() {
      if (closed || !ownsDevices) return;
      clearInterval(timer);
      await devices.restoreOcpp?.();
    },
    async close() {
      if (closed) return;
      if (ownsDevices && devices.streamStatus?.())
        interruptElectricity([easee.charger_id, easee.equalizer_id].filter(present));
      closed = true; clearInterval(timer);
      engine.ocppSetup = null;
      cancellation.abort(); http.close?.();
      await Promise.allSettled([...pending.values(), ...(ownsDevices ? [devices.close?.()] : [])]);
    },
  };
}
