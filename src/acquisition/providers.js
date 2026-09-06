import { join } from 'node:path';
import { createHttp } from './http.js';
import { fileTokenStore } from './token-store.js';
import { createDeviceProviders } from './devices.js';
import { fetchMarket } from './market.js';
import { fetchWeather } from './weather.js';

const MINUTE = 60_000;
const present = value => typeof value === 'string' && value.trim().length > 0;
const errorCode = error => Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599
  ? `HTTP-${error.status}` : 'provider-request-failed';

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
  devices, market = fetchMarket, weather = fetchWeather, automatic = true } = {}) {
  const connections = config.connections ?? {};
  devices ??= createDeviceProviders({ connections, http, tokenStore: fileTokenStore(join(config.dataDir, 'easee-tokens.json')) });
  const smartthings = connections.smartthings ?? {}, easee = connections.easee ?? {};
  const definitions = {
    temperatures: { enabled: ['inside_temp_dev_id', 'outside_temp_dev_id', 'garage_temp_dev_id'].some(key => present(smartthings[key])),
      period: 5 * MINUTE, run: args => devices.temperatures(args) },
    easee: { enabled: ['charger_id', 'equalizer_id'].some(key => present(easee[key])),
      period: 5 * MINUTE, run: args => devices.easee(args) },
    market: { enabled: present(connections.entsoe?.token) || Boolean(connections.elering),
      period: 60 * MINUTE, run: args => market({ ...args, connections, http }), snapshot: true },
    weather: { enabled: present(connections.openweathermap?.token),
      period: 60 * MINUTE, run: args => weather({ ...args, connections, http }), snapshot: true },
  };
  const health = {}, pending = new Map(), cancellation = new AbortController();
  const saved = store.getState('providers:health') ?? {};
  const now = clock();
  for (const [name, job] of Object.entries(definitions)) {
    const previous = saved[name];
    // Honor bounded retry/cadence state on ordinary restarts, never stale running state.
    const due = Number.isFinite(previous?.nextAttemptAt) && previous.nextAttemptAt <= now + Math.max(job.period, 30 * MINUTE)
      ? Math.max(now, previous.nextAttemptAt) : now;
    health[name] = { status: job.enabled ? 'waiting' : 'not-configured',
      lastAttemptAt: previous?.lastAttemptAt ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null,
      nextAttemptAt: job.enabled ? due : null, failures: Math.min(10, Math.max(0, previous?.failures ?? 0)), error: null };
  }
  store.setState('providers:health', health);
  let closed = false, timer;

  async function poll(name) {
    const job = definitions[name], state = health[name], at = clock();
    Object.assign(state, { status: 'running', lastAttemptAt: at });
    store.setState('providers:health', health);
    let failure = null;
    try {
      const result = await job.run({ now: at, signal: cancellation.signal });
      if (closed) return;
      // SQLite rollback must also restore the in-memory view used by decisions.
      const latestBefore = Object.assign(Object.create(Object.getPrototypeOf(engine.latest)), engine.latest);
      try { store.transaction(() => {
        if (job.snapshot) {
          const snapshotId = store.snapshot({ kind: name, source: result.source, issuedAt: result.issuedAt,
            fetchedAt: result.fetchedAt, payload: result });
          store.setState(`provider:${name}`, name === 'weather'
            ? cacheWeather(store.getState('provider:weather'), result, snapshotId, clock()) : { ...result, snapshotId });
        } else {
          if (!Array.isArray(result) || result.length > 20) throw new Error('Invalid observation batch');
          for (const observation of result) engine.ingest(observation);
          store.setState('provider:observations', Object.values(engine.latest)
            .filter(row => ['smartthings', 'easee'].includes(row.source)));
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
      state.status = failure ? 'degraded' : 'ok';
    } catch (error) {
      if (closed) return;
      state.status = 'error'; failure = errorCode(error);
    }
    if (closed) return;
    state.error = failure;
    state.failures = failure ? Math.min(10, state.failures + 1) : 0;
    if (!failure) state.lastSuccessAt = clock();
    // Five-minute minimum and bounded exponential backoff also cover HTTP 429.
    const delay = failure ? Math.min(30 * MINUTE, 5 * MINUTE * 2 ** (state.failures - 1)) : job.period;
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
