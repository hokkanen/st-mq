import { join } from 'node:path';
import { createHttp } from './http.js';
import { fileTokenStore } from './token-store.js';
import { createDeviceProviders } from './devices.js';
import { fetchMarket } from './market.js';
import { fetchWeather, fetchOutdoorTemperature } from './weather.js';
import { ElectricityAccumulator } from '../domain/electricity.js';
import { recordEaseeSessionChecks } from './easee-session-checks.js';
import { createChargerIdentification } from './charger-identification.js';

const MINUTE = 60_000;
const present = value => typeof value === 'string' && value.trim().length > 0;
const errorCode = error => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
  ? `HTTP-${error.status}` : 'provider-request-failed';
const SOURCES = new Set(['entsoe', 'elering', 'fmi', 'openmeteo']);
const OBSERVATION_SOURCES = ['smartthings', 'easee', 'fmi', 'openmeteo'];
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
    const maximumAge = /_current_l[123]$/.test(row.signal) ? 30 * MINUTE
      : /_temperature$/.test(row.signal) ? 120 * MINUTE : null;
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
const safeFailure = value => typeof value === 'string' && /^HTTP[-_][1-5]\d{2}$/i.test(value)
  ? value.toUpperCase().replace('_', '-') : 'provider-request-failed';
const currentError = value => value === 'missing-or-invalid-observations' ? value : value ? safeFailure(value) : null;
const currentIssues = (group, flags) => [...new Set((Array.isArray(flags) ? flags : [])
  .map(flag => flag === 'stale' ? `${group}_stale` : flag)
  .filter(flag => CURRENT_ISSUES.has(flag)
    && (flag !== 'charger_stale' || group === 'charger')
    && (!['property_stale', 'all_zero_property_current'].includes(flag) || group === 'property')))];
function observationFailure(rows) {
  return !rows.length || rows.some(row => row.value === null || row.quality.some(flag => DOWNLOAD_ISSUES.has(flag)))
    ? rows.flatMap(row => row.quality).find(flag => /^http_status_[1-5]\d{2}$/.test(flag))
      ?.replace('http_status_', 'HTTP-') ?? 'missing-or-invalid-observations' : null;
}
function savedCurrentReadings(previous, configured) {
  const candidate = previous?.currentReadings;
  const saved = Object.keys(CURRENT_GROUPS).some(group => candidate?.[group]
    && typeof candidate[group] === 'object' && !Array.isArray(candidate[group])) ? candidate : null;
  const issues = qualityIssues(previous?.qualityIssues);
  // Older caches cannot identify which device had a generic quality/download
  // failure. Leave those descriptions unscoped until the next successful poll.
  if (!saved && (previous?.error || issues.some(flag => !['charger_stale', 'property_stale', 'all_zero_property_current'].includes(flag)))) return undefined;
  const groups = Object.keys(CURRENT_GROUPS).filter(group => configured.includes(group)
    || saved?.[group] && typeof saved[group] === 'object' && !Array.isArray(saved[group])
    || issues.includes(`${group}_stale`) || group === 'property' && issues.includes('all_zero_property_current'));
  return Object.fromEntries(groups.map(group => {
    const row = saved?.[group];
    return [group, { qualityIssues: currentIssues(group, row?.qualityIssues ?? issues),
      error: currentError(row?.error),
      lastSuccessAt: validSourceTime(row?.lastSuccessAt) ? row.lastSuccessAt
        : !row && !previous?.error && validSourceTime(previous?.lastSuccessAt) ? previous.lastSuccessAt : null }];
  }));
}
function currentReadings(rows, configured, previous, now) {
  const result = {};
  for (const [group, prefix] of Object.entries(CURRENT_GROUPS)) {
    const readings = rows.filter(row => new RegExp(`^${prefix}_current_l[123]$`).test(row.signal));
    if (!configured.includes(group) && !readings.length) continue;
    const error = observationFailure(readings);
    result[group] = { qualityIssues: currentIssues(group, [
      ...readings.flatMap(row => row.quality.filter(flag => !STALE_ISSUES.has(flag))),
      ...observationQuality('easee', readings, now).issues,
    ]), error, lastSuccessAt: error ? previous?.[group]?.lastSuccessAt ?? null : now };
  }
  return result;
}
const boundedDelay = value => Number.isFinite(value) ? Math.min(24 * 60 * MINUTE, Math.max(0, value)) : 0;
function backoff(failures, error, requested = 0) {
  return Math.max(boundedDelay(requested), /HTTP-(401|403)/.test(error ?? '') ? 30 * MINUTE
    : Math.min(30 * MINUTE, 5 * MINUTE * 2 ** (Math.max(1, failures) - 1)));
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
  temperatureProvider, automatic = true, canControl = () => true } = {}) {
  const connections = config.connections ?? {};
  const identifyCharger = connections.teslamate?.enabled === true
    && connections.teslamate?.chargerIdentification === true && connections.teslamate?.chargerAssignment === 'auto';
  http ??= createHttp({ allowChargerIdentification: identifyCharger, canControl });
  const location = configuredLocation(connections);
  // This poll supplies the FMI → Open-Meteo weather fallbacks. The engine
  // selects a usable H66 reading before either weather source.
  devices ??= createDeviceProviders({ connections, http, clock, canControl,
    tokenStore: fileTokenStore(join(config.dataDir, 'easee-tokens.json'), connections.easee ?? {}) });
  const identificationControl = identifyCharger && engine.teslamate && devices.chargerIdentificationControl
    ? devices.chargerIdentificationControl() : null;
  const identification = identificationControl ? createChargerIdentification({ clock, control: {
    read: args => identificationControl.read(args),
    limit: args => {
      if (!canControl() || args.signal?.aborted) throw new Error('Controller authority was revoked');
      return identificationControl.limit(args);
    },
  } }) : null;
  if (identification) engine.chargerIdentification = identification;
  let identificationTimer;
  const runIdentification = async () => {
    if (!identification) return;
    if (!canControl()) { identification.stop(); return; }
    try {
      await identification.tick({ tesla: engine.teslamate?.identificationSnapshot(),
        charger: engine.electricitySnapshot?.charger }, clock());
      engine.teslamate?.tick(clock());
    } catch { /* Only transient status, never a database experiment/error log. */ }
  };
  const smartthings = connections.smartthings ?? {}, easee = connections.easee ?? {}, cadence = config.acquisition ?? {};
  const readTemperatures = typeof temperatureProvider === 'function' ? temperatureProvider
    : args => devices.temperatures({ ...args, signals: ['indoor_temperature', 'garage_temperature'] });
  const integrationOptions = { maxAgeMs: cadence.electricityMaxAgeMs ?? 5 * MINUTE,
    maxTelemetryAgeMs: cadence.electricityTelemetryMaxAgeMs ?? 17 * MINUTE,
    maxGapMs: cadence.electricityMaxGapMs ?? MINUTE };
  let electricity = new ElectricityAccumulator({ ...integrationOptions, checkpoint: store.getState('electricity:acquisition') });
  const configuredCurrents = [['charger', 'charger_id'], ['property', 'equalizer_id']]
    .filter(([, key]) => present(easee[key])).map(([group]) => group);
  const definitions = {
    // SmartThings supplies indoor/garage readings alongside MQTT. Outdoor
    // acquisition keeps the H66 → FMI → Open-Meteo selection.
    temperatures: { enabled: typeof temperatureProvider === 'function'
        || ['inside_temp_dev_id', 'garage_temp_dev_id'].some(key => present(smartthings[key])),
      period: 5 * MINUTE, run: readTemperatures },
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
  const now = clock();
  for (const [name, job] of Object.entries(definitions)) {
    const previous = saved[name];
    // Honor bounded retry/cadence state on ordinary restarts, never stale running state.
    const due = Number.isFinite(previous?.nextAttemptAt) && previous.nextAttemptAt <= now + 24 * 60 * MINUTE
      ? Math.max(now, previous.nextAttemptAt) : now;
    health[name] = { status: job.enabled ? (COMPLETED_STATES.has(previous?.status) ? previous.status : 'waiting') : 'not-configured',
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
      if (configuredCurrents.length === 1 && state.qualityIssues.includes('stale')) {
        const flag = `${configuredCurrents[0]}_stale`;
        state.qualityIssues = [...new Set(state.qualityIssues.map(issue => issue === 'stale' ? flag : issue))];
        if (state.staleSourceTimes.stale) {
          state.staleSourceTimes[flag] = Math.min(state.staleSourceTimes[flag] ?? Infinity, state.staleSourceTimes.stale);
          delete state.staleSourceTimes.stale;
        }
      }
      const readings = savedCurrentReadings({ ...previous, qualityIssues: state.qualityIssues }, configuredCurrents);
      if (readings) {
        state.currentReadings = readings;
        if (previous?.currentReadings) state.qualityIssues = qualityIssues(Object.values(readings).flatMap(row => row.qualityIssues));
      }
      // Idle charger age and phase reporting times never require attention,
      // including while waiting for a scheduled poll after an upgrade/restart.
      if (health[name].status === 'degraded' && !health[name].error
        && !health[name].qualityIssues.some(flag => flag !== 'charger_stale')
        && !Object.values(readings ?? {}).some(row => row.error || row.qualityIssues.some(flag => flag !== 'charger_stale')))
        Object.assign(health[name], { status: 'ok', failures: 0 });
    }
  }
  store.setState('providers:health', health);
  let closed = false, timer;

  async function poll(name) {
    const job = definitions[name], state = health[name], at = clock();
    Object.assign(state, { status: 'running', lastAttemptAt: at });
    store.setState('providers:health', health);
    let failure = null, retryAfterMs = 0, issues = [], staleSourceTimes = {}, readings, missingTomorrow = false, electricityCommitted = false;
    try {
      // Forecast and current weather share provider hosts. A server's rate
      // limit or access denial applies to both routes, while a missing station
      // reading alone must not disable a working forecast.
      for (const other of Object.values(health)) for (const [source, blocked] of Object.entries(other.sourceBackoff)) {
        if (job.sources?.includes(source) && blocked.shared && blocked.nextAttemptAt > at
          && blocked.nextAttemptAt > (state.sourceBackoff[source]?.nextAttemptAt ?? 0)) state.sourceBackoff[source] = { ...blocked };
      }
      const skipSources = Object.entries(state.sourceBackoff).filter(([, value]) => value.nextAttemptAt > at).map(([source]) => source);
      const result = await job.run({ now: at, signal: cancellation.signal, skipSources });
      if (closed || !canControl()) return;
      noteAcquisition(state, result?.acquisition, clock());
      state.source = result?.acquisition?.selected ?? result?.source ?? (Array.isArray(result) ? result.find(row => row.value !== null)?.source : null) ?? state.source;
      // SQLite rollback must also restore the in-memory view used by decisions.
      const latestBefore = Object.assign(Object.create(Object.getPrototypeOf(engine.latest)), engine.latest);
      const outdoorBefore = Object.assign(Object.create(null), engine.outdoorCandidates);
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
          store.setState(`provider:${name}`, unchanged
            ? { ...previous, snapshotId, acquisition: result.acquisition, lastCheckedAt: result.fetchedAt }
            : name === 'weather' ? cacheWeather(previous, result, snapshotId, clock()) : { ...result, snapshotId });
          if (name === 'market' && result.coverage && (!result.coverage.completeToday || result.coverage.gaps)) failure = 'incomplete-market-coverage';
          if (name === 'market' && Array.isArray(result.intervals)) {
            missingTomorrow = Math.max(0, ...result.intervals.map(row => row.end)) < at + 24 * 60 * MINUTE;
          }
        } else {
          if (!Array.isArray(result) || result.length > 20) throw new Error('Invalid observation batch');
          if (name === 'easee') {
            const sampled = electricity.sample(result, clock());
            for (const interval of sampled.intervals) engine.ingestEnergy?.(interval);
            for (const audit of sampled.audits) store.energyAudit?.(audit);
            for (const gap of sampled.gaps) engine.recorder?.energyGap?.(gap);
            recordEaseeSessionChecks({ store, rows: result, now: clock(),
              flush: () => engine.recorder?.flush?.(clock(), { force: true }) });
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
        engine.latest = latestBefore; engine.outdoorCandidates = outdoorBefore;
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
          snapshot[group] = { device: row.device, powerKw: row.powers.reduce((sum, value) => sum + value, 0),
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
    let delay = failure ? backoff(state.failures, failure, retryAfterMs) : job.period;
    if (!failure && name === 'market' && missingTomorrow) delay = Math.min(delay, cadence.marketRetryIntervalMs ?? 15 * MINUTE);
    const sourceDelays = (state.acquisition?.attempts ?? []).filter(attempt => attempt.status !== 'not-configured')
      .map(attempt => state.sourceBackoff[attempt.source]?.nextAttemptAt - clock());
    if (failure && sourceDelays.length && sourceDelays.every(value => value > 0)) delay = Math.max(delay, Math.min(...sourceDelays));
    state.nextAttemptAt = clock() + delay;
    store.setState('providers:health', health);
    if (electricityCommitted) {
      try { engine.teslamate?.tick(clock()); }
      catch { store.event('teslamate-acquisition-error', { reason: 'property-check-failed' }, clock()); }
      void runIdentification();
    }
  }

  function runDue() {
    if (closed || !canControl()) return Promise.resolve([]);
    for (const [name, job] of Object.entries(definitions)) {
      if (!job.enabled || pending.has(name) || health[name].nextAttemptAt > clock()) continue;
      const flight = poll(name).finally(() => pending.delete(name));
      pending.set(name, flight);
    }
    return Promise.allSettled([...pending.values()]);
  }
  if (automatic) {
    // Ordinary acquisition stays read-only. The separately enabled, RAM-only
    // identification coordinator owns the bounded charger control capability.
    void runDue();
    timer = setInterval(() => { void runDue(); }, Math.min(1000, ...Object.values(definitions).filter(job => job.enabled).map(job => job.period)));
    timer.unref();
    if (identification) {
      identificationTimer = setInterval(() => { void runIdentification(); }, 5000);
      identificationTimer.unref();
    }
  }
  return {
    runDue,
    runIdentification,
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); clearInterval(identificationTimer);
      identification?.stop();
      if (engine.chargerIdentification === identification) engine.chargerIdentification = null;
      cancellation.abort(); http.close?.();
      await Promise.allSettled([...pending.values()]);
    },
  };
}
