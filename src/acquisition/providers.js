import { join } from 'node:path';
import { createHttp } from './http.js';
import { fileTokenStore } from './token-store.js';
import { createDeviceProviders } from './devices.js';
import { fetchMarket } from './market.js';
import { fetchWeather, fetchOutdoorTemperature } from './weather.js';

const MINUTE = 60_000;
const present = value => typeof value === 'string' && value.trim().length > 0;
const errorCode = error => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
  ? `HTTP-${error.status}` : 'provider-request-failed';
const SOURCES = new Set(['entsoe', 'elering', 'fmi', 'openweathermap']);
const OBSERVATION_SOURCES = ['smartthings', 'easee', 'fmi', 'openweathermap'];
const safeFailure = value => typeof value === 'string' && /^HTTP[-_][1-5]\d{2}$/i.test(value)
  ? value.toUpperCase().replace('_', '-') : 'provider-request-failed';
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

function noteAcquisition(state, raw, now) {
  if (!raw || !SOURCES.has(raw.primary) || !Array.isArray(raw.attempts)) return;
  const attempts = raw.attempts.slice(0, 4).filter(row => SOURCES.has(row?.source)).map(row => ({
    source: row.source, status: ['ok', 'error', 'not-configured', 'incomplete', 'backoff'].includes(row.status) ? row.status : 'error',
    error: row.error ? safeFailure(row.error) : null, retryAfterMs: boundedDelay(row.retryAfterMs),
  }));
  for (const attempt of attempts) {
    if (attempt.status === 'ok') delete state.sourceBackoff[attempt.source];
    else if (['error', 'incomplete'].includes(attempt.status)) {
      const failures = Math.min(10, (state.sourceBackoff[attempt.source]?.failures ?? 0) + 1);
      state.sourceBackoff[attempt.source] = { failures, error: attempt.error ?? 'provider-request-failed',
        nextAttemptAt: now + backoff(failures, attempt.error, attempt.retryAfterMs),
        shared: /HTTP-(401|403|429)/.test(attempt.error ?? '') || attempt.retryAfterMs > 0 };
    }
  }
  state.acquisition = { primary: raw.primary, selected: SOURCES.has(raw.selected) ? raw.selected : null,
    fallbackUsed: raw.fallbackUsed === true, attempts };
  if (raw.coverage) state.acquisition.coverage = {
    current: raw.coverage.current === true, completeToday: raw.coverage.completeToday === true,
    gaps: raw.coverage.gaps === true,
    knownUntil: Number.isSafeInteger(raw.coverage.knownUntil) ? raw.coverage.knownUntil : null,
  };
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
export function startProviders({ engine, store, config, clock = Date.now, http = createHttp(),
  devices, market = fetchMarket, weather = fetchWeather, outdoor = fetchOutdoorTemperature, automatic = true } = {}) {
  const connections = config.connections ?? {};
  const location = configuredLocation(connections);
  // Outdoor acquisition has an explicit FMI → OpenWeather owner. An optional
  // SmartThings outdoor sensor must not race with and replace that selected source.
  const deviceConnections = location ? { ...connections, smartthings: { ...connections.smartthings, outside_temp_dev_id: '' } } : connections;
  devices ??= createDeviceProviders({ connections: deviceConnections, http, tokenStore: fileTokenStore(join(config.dataDir, 'easee-tokens.json')) });
  const smartthings = connections.smartthings ?? {}, easee = connections.easee ?? {};
  const definitions = {
    temperatures: { enabled: ['inside_temp_dev_id', 'garage_temp_dev_id', ...(!location ? ['outside_temp_dev_id'] : [])].some(key => present(smartthings[key])),
      period: 5 * MINUTE, run: args => devices.temperatures(args) },
    easee: { enabled: ['charger_id', 'equalizer_id'].some(key => present(easee[key])),
      period: 5 * MINUTE, run: args => devices.easee(args) },
    market: { enabled: present(connections.entsoe?.token) || ['fi', 'ee', 'lv', 'lt'].includes(connections.geoloc?.country_code?.toLowerCase()) || Boolean(connections.elering),
      period: 60 * MINUTE, run: args => market({ ...args, connections, http }), snapshot: true, sources: ['entsoe', 'elering'] },
    weather: { enabled: location || present(connections.openweathermap?.token),
      period: 60 * MINUTE, run: args => weather({ ...args, connections, http }), snapshot: true, sources: ['fmi', 'openweathermap'] },
    outdoor: { enabled: location, period: 10 * MINUTE, run: args => outdoor({ ...args, connections, http }), sources: ['fmi', 'openweathermap'] },
  };
  const health = {}, pending = new Map(), cancellation = new AbortController();
  const saved = store.getState('providers:health') ?? {};
  const now = clock();
  for (const [name, job] of Object.entries(definitions)) {
    const previous = saved[name];
    // Honor bounded retry/cadence state on ordinary restarts, never stale running state.
    const due = Number.isFinite(previous?.nextAttemptAt) && previous.nextAttemptAt <= now + 24 * 60 * MINUTE
      ? Math.max(now, previous.nextAttemptAt) : now;
    health[name] = { status: job.enabled ? 'waiting' : 'not-configured',
      lastAttemptAt: previous?.lastAttemptAt ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null,
      nextAttemptAt: job.enabled ? due : null, failures: Math.min(10, Math.max(0, previous?.failures ?? 0)), error: null,
      source: typeof previous?.source === 'string' && OBSERVATION_SOURCES.concat([...SOURCES]).includes(previous.source) ? previous.source : null,
      sourceBackoff: Object.fromEntries(Object.entries(previous?.sourceBackoff ?? {}).filter(([source, state]) =>
        SOURCES.has(source) && Number.isFinite(state?.nextAttemptAt) && state.nextAttemptAt <= now + 24 * 60 * MINUTE)
        .map(([source, state]) => [source, { failures: Math.min(10, Math.max(0, state.failures ?? 0)),
          nextAttemptAt: state.nextAttemptAt, error: safeFailure(state.error),
          shared: state.shared === true || /HTTP-(401|403|429)/.test(safeFailure(state.error)) }])) };
  }
  store.setState('providers:health', health);
  let closed = false, timer;

  async function poll(name) {
    const job = definitions[name], state = health[name], at = clock();
    Object.assign(state, { status: 'running', lastAttemptAt: at });
    store.setState('providers:health', health);
    let failure = null, retryAfterMs = 0;
    try {
      // Forecast and current weather share provider hosts/keys. A server's rate
      // limit or access denial applies to both routes, while a missing station
      // reading alone must not disable a working forecast.
      for (const other of Object.values(health)) for (const [source, blocked] of Object.entries(other.sourceBackoff)) {
        if (job.sources?.includes(source) && blocked.shared && blocked.nextAttemptAt > at
          && blocked.nextAttemptAt > (state.sourceBackoff[source]?.nextAttemptAt ?? 0)) state.sourceBackoff[source] = { ...blocked };
      }
      const skipSources = Object.entries(state.sourceBackoff).filter(([, value]) => value.nextAttemptAt > at).map(([source]) => source);
      const result = await job.run({ now: at, signal: cancellation.signal, skipSources });
      if (closed) return;
      noteAcquisition(state, result?.acquisition, clock());
      state.source = result?.acquisition?.selected ?? result?.source ?? (Array.isArray(result) ? result.find(row => row.value !== null)?.source : null) ?? state.source;
      // SQLite rollback must also restore the in-memory view used by decisions.
      const latestBefore = Object.assign(Object.create(Object.getPrototypeOf(engine.latest)), engine.latest);
      try { store.transaction(() => {
        if (job.snapshot) {
          const snapshotId = store.snapshot({ kind: name, source: result.source, issuedAt: result.issuedAt,
            fetchedAt: result.fetchedAt, payload: result });
          store.setState(`provider:${name}`, name === 'weather'
            ? cacheWeather(store.getState('provider:weather'), result, snapshotId, clock()) : { ...result, snapshotId });
          if (name === 'market' && result.coverage && (!result.coverage.completeToday || result.coverage.gaps)) failure = 'incomplete-market-coverage';
        } else {
          if (!Array.isArray(result) || result.length > 20) throw new Error('Invalid observation batch');
          for (const observation of result) {
            if (name === 'temperatures' && location && observation.signal === 'outdoor_temperature') continue;
            engine.ingest(observation, { selectedOutdoorSource: name === 'outdoor' });
          }
          store.setState('provider:observations', Object.values(engine.latest)
            .filter(row => OBSERVATION_SOURCES.includes(row.source)));
          retryAfterMs = Math.max(0, ...result.map(row => boundedDelay(row.raw?.retryAfterMs)));
          // Missing or erroneous data is visible even when an older reading remains usable.
          if (!result.length || result.some(row => row.value === null || row.quality.some(flag =>
            ['provider_error', 'missing_configuration', 'invalid_unit', 'invalid_numeric', 'future_source_time',
              'source_time_unknown', 'stale', 'implausible_temperature', 'suspect_zero_indoor',
              'conflicting_duplicate', 'implausible_current', 'negative_current', 'all_zero_property_current',
              'ev_exceeds_property_current', 'asynchronous_snapshot'].includes(flag)))) {
            failure = result.flatMap(row => row.quality).find(flag => /^http_status_\d{3}$/.test(flag))
              ?.replace('http_status_', 'HTTP-') ?? 'missing-or-invalid-observations';
          }
        }
      }); } catch (error) { engine.latest = latestBefore; throw error; }
      state.status = failure ? 'degraded' : state.acquisition?.fallbackUsed ? 'fallback' : 'ok';
    } catch (error) {
      if (closed) return;
      noteAcquisition(state, error?.acquisition, clock());
      retryAfterMs = boundedDelay(error?.retryAfterMs);
      state.status = 'error'; failure = errorCode(error);
    }
    if (closed) return;
    state.error = failure;
    state.failures = failure ? Math.min(10, state.failures + 1) : 0;
    if (!failure) state.lastSuccessAt = clock();
    // Five-minute minimum and bounded exponential backoff also cover HTTP 429.
    let delay = failure ? backoff(state.failures, failure, retryAfterMs) : job.period;
    const sourceDelays = (state.acquisition?.attempts ?? []).filter(attempt => attempt.status !== 'not-configured')
      .map(attempt => state.sourceBackoff[attempt.source]?.nextAttemptAt - clock());
    if (failure && sourceDelays.length && sourceDelays.every(value => value > 0)) delay = Math.max(delay, Math.min(...sourceDelays));
    state.nextAttemptAt = clock() + delay;
    store.setState('providers:health', health);
  }

  function runDue() {
    if (closed) return Promise.resolve([]);
    for (const [name, job] of Object.entries(definitions)) {
      if (!job.enabled || pending.has(name) || health[name].nextAttemptAt > clock()) continue;
      const flight = poll(name).finally(() => pending.delete(name));
      pending.set(name, flight);
    }
    return Promise.allSettled([...pending.values()]);
  }
  if (automatic) {
    // Start after the HTTP listener is ready. Polls never execute equipment intents.
    void runDue();
    timer = setInterval(() => { void runDue(); }, MINUTE);
    timer.unref();
  }
  return {
    runDue,
    async close() {
      if (closed) return;
      closed = true; clearInterval(timer); cancellation.abort(); http.close?.();
      await Promise.allSettled([...pending.values()]);
    },
  };
}
