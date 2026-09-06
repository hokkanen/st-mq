// Read-only API boundary. No charger or SmartThings device commands exist here.
// Protocol sources checked 2026-09-06:
// https://developer.smartthings.com/docs/service-integrations/query-and-list-devices
// https://developer.easee.com/reference/getobservations
// https://developer.easee.com/reference/account_refreshtoken
// https://developer.easee.com/docs/charger-observation-ids
const TEMPERATURES = [
  ['inside_temp_dev_id', 'indoor_temperature'],
  ['garage_temp_dev_id', 'garage_temperature'],
  ['outside_temp_dev_id', 'outdoor_temperature'],
];
const CURRENT_DEVICES = [
  ['charger_id', [183, 184, 185], 'ev1_current'],
  ['equalizer_id', [31, 32, 33], 'property_current'],
];
const API = 'https://api.easee.com';

function number(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null;
}
function supplied(value) { return typeof value === 'string' && value.trim().length > 0; }
function sourceTime(value) {
  // Never guess a timezone or substitute receipt time for an unknown source time.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null;
}
function timeQuality(at, now, maximumAge) {
  if (at === null) return ['source_time_unknown'];
  if (at > now + 60_000) return ['future_source_time'];
  return now - at > maximumAge ? ['stale'] : [];
}
function httpStatus(error) {
  return Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
}
function sanitized(error, provider) {
  const status = httpStatus(error);
  const clean = new Error(`${provider} request failed${status === null ? '' : ` (HTTP ${status})`}`);
  if (status !== null) clean.status = status;
  return clean;
}
function failureFlags(error) {
  const status = httpStatus(error);
  return ['provider_error', ...(status === null ? [] : [`http_status_${status}`])];
}
function validNow(now) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) throw new TypeError('now must be a UTC timestamp in milliseconds');
}
function baseObservation({ source, device, signal, unit, now, quality = [] }) {
  return { source, device, signal, value: null, unit, sourceTime: null, receivedAt: now,
    quality: [...quality, 'missing', 'source_time_unknown'], raw: null };
}

function temperatureObservation(payload, device, signal, now) {
  const attribute = payload?.components?.main?.temperatureMeasurement?.temperature;
  const input = number(attribute?.value); const unit = attribute?.unit;
  const at = sourceTime(attribute?.timestamp);
  const quality = timeQuality(at, now, 60 * 60_000);
  let value = input;
  if (!['C', 'F'].includes(unit)) { quality.push('invalid_unit'); value = null; }
  else if (unit === 'F' && value !== null) { value = (value - 32) * 5 / 9; quality.push('converted_fahrenheit'); }
  if (input === null) quality.push(attribute?.value === null || attribute?.value === undefined ? 'missing' : 'invalid_numeric');
  if (value === null) quality.push('missing');
  if (value !== null && (value < -60 || value > 70)) quality.push('implausible_temperature');
  if (value === 0 && signal === 'indoor_temperature') quality.push('suspect_zero_indoor');
  return { source: 'smartthings', device, signal, value, unit: 'degC', sourceTime: at, receivedAt: now,
    quality: [...new Set(quality)], raw: { attribute: 'temperature', reportedValue: input,
      reportedUnit: ['C', 'F'].includes(unit) ? unit : null, timestamp: at } };
}

function currentObservations(payload, device, ids, prefix, now) {
  const observations = Array.isArray(payload) ? payload : payload?.observations;
  if (!Array.isArray(observations) || observations.length > 1000) throw new Error('Invalid Easee observations');
  return ids.map((id, index) => {
    const matches = observations.filter(item => item && number(item.id) === id);
    const candidates = matches.map(item => ({ item, at: sourceTime(item.timestamp) }))
      .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
    const selected = candidates[0];
    const input = number(selected?.item.value); const at = selected?.at ?? null;
    let value = input;
    const quality = ['current_snapshot_not_energy', ...timeQuality(at, now, 15 * 60_000)];
    const unit = selected?.item.unit;
    if (unit !== undefined && unit !== null && unit !== 'A') { value = null; quality.push('invalid_unit'); }
    if (matches.length > 1) {
      quality.push('duplicate_observation');
      if (candidates.some(candidate => candidate.at === at && number(candidate.item.value) !== input)) {
        value = null; quality.push('conflicting_duplicate');
      }
    }
    if (value === null) quality.push('missing');
    if (input === null && selected?.item.value !== undefined && selected.item.value !== null) quality.push('invalid_numeric');
    if (value !== null && value < 0) quality.push('negative_current');
    if (value !== null && value > 1000) quality.push('implausible_current');
    return { source: 'easee', device, signal: `${prefix}_l${index + 1}`, value, unit: 'A',
      sourceTime: at, receivedAt: now, quality,
      raw: { observationId: id, reportedValue: input, timestamp: at } };
  });
}

/**
 * Inject bounded http.json(url, fetchOptions) and optional secret-only tokenStore.
 * Each call returns normalized observation arrays, including null error records for
 * configured devices. No provider is contacted until a returned method is invoked.
 */
export function createDeviceProviders({ connections = {}, http, tokenStore } = {}) {
  if (typeof http?.json !== 'function') throw new TypeError('An HTTP JSON transport is required');
  const smartthings = { ...connections.smartthings }; const easee = { ...connections.easee };
  let tokens = { accessToken: easee.access_token ?? '', refreshToken: easee.refresh_token ?? '' };
  let loadFlight = null; let refreshFlight = null; let saveFlight = null; let dirtyTokens = false;

  async function request(url, options, provider) {
    try { return await http.json(url, options); }
    catch (error) { throw sanitized(error, provider); }
  }
  function loadTokens() {
    if (!loadFlight) {
      const attempt = (async () => {
        if (!tokenStore?.load) return;
        let saved;
        try { saved = await tokenStore.load(); } catch { throw new Error('Easee token storage unavailable'); }
        if (saved !== null && saved !== undefined) {
          if (!supplied(saved.accessToken) || !supplied(saved.refreshToken)) throw new Error('Easee token storage invalid');
          tokens = { accessToken: saved.accessToken, refreshToken: saved.refreshToken };
        }
      })();
      loadFlight = attempt;
      // A repaired secret file or temporary storage outage recovers on the next poll.
      attempt.catch(() => { if (loadFlight === attempt) loadFlight = null; });
    }
    return loadFlight;
  }
  async function persistTokens() {
    if (!dirtyTokens || !tokenStore?.save) return;
    if (saveFlight) return saveFlight;
    const pair = { ...tokens };
    saveFlight = (async () => {
      try { await tokenStore.save(pair); } catch { throw new Error('Easee token storage unavailable'); }
      if (tokens.accessToken === pair.accessToken && tokens.refreshToken === pair.refreshToken) dirtyTokens = false;
    })();
    try { await saveFlight; } finally { saveFlight = null; }
  }
  async function saveTokens(payload) {
    if (!supplied(payload?.accessToken) || !supplied(payload?.refreshToken)) throw new Error('Easee authentication returned invalid tokens');
    const next = { accessToken: payload.accessToken, refreshToken: payload.refreshToken };
    // Rotated tokens remain usable in this process even if durable persistence fails.
    tokens = next;
    dirtyTokens = Boolean(tokenStore?.save);
    await persistTokens();
  }
  async function refreshTokens({ attemptedToken, signal }) {
    if (refreshFlight) return refreshFlight;
    // Another concurrent request may already have replaced the token that failed.
    if (supplied(tokens.accessToken) && tokens.accessToken !== attemptedToken) return;
    refreshFlight = (async () => {
      if (supplied(tokens.refreshToken)) {
        try {
          const payload = await request(`${API}/api/accounts/refresh_token`, {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
            body: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }), signal,
          }, 'Easee');
          await saveTokens(payload); return;
        } catch (error) {
          // Rate limiting/outages do not justify password retries or account pressure.
          if (![400, 401, 403].includes(httpStatus(error))) throw error;
        }
      }
      if (!supplied(easee.user) || !supplied(easee.pw)) throw new Error('Easee authentication requires credentials or a valid refresh token');
      const payload = await request(`${API}/api/accounts/login`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ userName: easee.user, password: easee.pw }), signal,
      }, 'Easee');
      await saveTokens(payload);
    })();
    try { await refreshFlight; } finally { refreshFlight = null; }
  }
  async function easeeRequest(device, ids, signal) {
    await loadTokens();
    await persistTokens();
    if (!supplied(tokens.accessToken)) await refreshTokens({ attemptedToken: tokens.accessToken, signal });
    const url = `${API}/state/${encodeURIComponent(device)}/observations?ids=${ids.join(',')}`;
    const attemptedToken = tokens.accessToken;
    const get = () => request(url, { method: 'GET', headers: { accept: 'application/json', Authorization: `Bearer ${tokens.accessToken}` }, signal }, 'Easee');
    try { return await get(); }
    catch (error) {
      if (httpStatus(error) !== 401) throw error;
      await refreshTokens({ attemptedToken, signal });
      return get(); // Exactly one data retry after authentication; never a retry loop.
    }
  }

  return {
    async temperatures({ now = Date.now(), signal } = {}) {
      validNow(now);
      const jobs = TEMPERATURES.filter(([key]) => supplied(smartthings[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, name]) => {
        if (!supplied(smartthings.token)) return baseObservation({ source: 'smartthings', device: smartthings[key], signal: name, unit: 'degC', now, quality: ['missing_configuration'] });
        const payload = await request(`https://api.smartthings.com/v1/devices/${encodeURIComponent(smartthings[key])}/status`, {
          method: 'GET', headers: { accept: 'application/json', Authorization: `Bearer ${smartthings.token}` }, signal,
        }, 'SmartThings');
        return temperatureObservation(payload, smartthings[key], name, now);
      }));
      return results.map((result, index) => result.status === 'fulfilled' ? result.value : baseObservation({
        source: 'smartthings', device: smartthings[jobs[index][0]], signal: jobs[index][1], unit: 'degC', now, quality: failureFlags(result.reason),
      }));
    },

    async easee({ now = Date.now(), signal } = {}) {
      validNow(now);
      const jobs = CURRENT_DEVICES.filter(([key]) => supplied(easee[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, ids, prefix]) =>
        currentObservations(await easeeRequest(easee[key], ids, signal), easee[key], ids, prefix, now)));
      const rows = results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : jobs[index][1].map((id, phase) => baseObservation({
        source: 'easee', device: easee[jobs[index][0]], signal: `${jobs[index][2]}_l${phase + 1}`, unit: 'A', now,
        quality: ['current_snapshot_not_energy', ...failureFlags(result.reason)],
      })));
      const property = rows.filter(row => row.signal.startsWith('property_'));
      const charger = rows.filter(row => row.signal.startsWith('ev1_'));
      if (property.length === 3 && property.every(row => row.value === 0)) property.forEach(row => row.quality.push('all_zero_property_current'));
      const timestamps = rows.map(row => row.sourceTime).filter(at => at !== null);
      if (timestamps.length > 1 && Math.max(...timestamps) - Math.min(...timestamps) > 30_000) rows.forEach(row => row.quality.push('asynchronous_snapshot'));
      if (property.length === 3 && charger.length === 3 && rows.every(row => row.value !== null)
        && charger.reduce((sum, row) => sum + row.value, 0) > property.reduce((sum, row) => sum + row.value, 0) + 0.5) rows.forEach(row => row.quality.push('ev_exceeds_property_current'));
      return rows;
    },
  };
}
