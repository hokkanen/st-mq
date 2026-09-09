// Observation boundary, with a separately opted-in, one-minute charger
// identification control. No circuit, permanent or SmartThings writes exist.
// Protocol sources checked 2026-09-06:
// https://developer.smartthings.com/docs/service-integrations/query-and-list-devices
// https://developer.easee.com/reference/getobservations
// https://developer.easee.com/reference/account_refreshtoken
// https://developer.easee.com/docs/charger-observation-ids
// Identification control checked 2026-09-09:
// https://developer.easee.com/reference/charger_set_dynamic_charger_current
// https://developer.easee.com/docs/amqp-commands
// https://developer.easee.com/docs/enumerations
// https://developer.easee.com/docs/load-balancing
// https://developer.easee.com/changelog/ocpp-15
import { createHash } from 'node:crypto';

const TEMPERATURES = [
  ['inside_temp_dev_id', 'indoor_temperature'],
  ['garage_temp_dev_id', 'garage_temperature'],
  ['outside_temp_dev_id', 'outdoor_temperature'],
];
const CURRENT_DEVICES = [
  ['charger_id', [183, 184, 185], 'ev1_current'],
  ['equalizer_id', [31, 32, 33], 'property_current'],
];
const CHARGER_TELEMETRY = [
  [130, -150, 0, ['dBm']], [132, -150, 0, ['dBm']], [136, -150, 0, ['dBm']],
  [150, -60, 150, ['C', '°C', 'degC']],
];
// Charger voltage IDs describe terminal pairs, not a guaranteed neutral/phase
// mapping. They are acquired for inspection but require a verified installation
// mapping before they can be used for phase weights or apparent-power fallback.
export const ELECTRICITY_FIELDS = Object.freeze({
  ev1: [[183, 'current_l1', 'A'], [184, 'current_l2', 'A'], [185, 'current_l3', 'A'],
    [194, 'voltage_l1', 'V'], [195, 'voltage_l2', 'V'], [196, 'voltage_l3', 'V'],
    [120, 'active_power', 'kW']],
  property: [[31, 'current_l1', 'A'], [32, 'current_l2', 'A'], [33, 'current_l3', 'A'],
    [34, 'voltage_l1', 'V'], [35, 'voltage_l2', 'V'], [36, 'voltage_l3', 'V'],
    [40, 'active_power', 'kW'], [45, 'import_energy_counter', 'kWh']],
});
const API = 'https://api.easee.com';
const IDENTIFICATION_IDS = [47, 48, 109, 111, 112, 113, 114, 120, 183, 184, 185, 230, 231, 232, 250,
  ...CHARGER_TELEMETRY.map(row => row[0])];

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
  if (Number.isFinite(error?.retryAfterMs)) clean.retryAfterMs = Math.min(86400_000, Math.max(0, error.retryAfterMs));
  return clean;
}
function failureFlags(error) {
  const status = httpStatus(error);
  return ['provider_error', ...(error?.code === 'EASEE_CONFIGURATION' ? ['missing_configuration'] : []), ...(status === null ? [] : [`http_status_${status}`])];
}
function validNow(now) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) throw new TypeError('now must be a UTC timestamp in milliseconds');
}
function baseObservation({ source, device, signal, unit, now, quality = [], retryAfterMs }) {
  return { source, device, signal, value: null, unit, sourceTime: null, receivedAt: now,
    quality: [...quality, 'missing', 'source_time_unknown'], raw: Number.isFinite(retryAfterMs) ? { retryAfterMs } : null };
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

function deviceConnection(list, now) {
  const unknown = { connected: null, observedAt: null };
  const matches = list.filter(row => number(row?.id) === 250).map(row => {
    const value = typeof row.value === 'string' ? row.value.trim().toLowerCase() : row.value;
    const connected = [true, 1, 'true', '1'].includes(value) ? true
      : [false, 0, 'false', '0'].includes(value) ? false : null;
    return { connected, observedAt: sourceTime(row.timestamp) };
  });
  if (!matches.length || matches.some(row => row.connected === null || row.observedAt === null
    || row.observedAt < 0 || row.observedAt > now)) return unknown;
  matches.sort((a, b) => b.observedAt - a.observedAt);
  const latest = matches[0];
  if (matches.some(row => row.observedAt === latest.observedAt && row.connected !== latest.connected)) return unknown;
  // Cloud connection is change-reported state, not a heartbeat. Its original
  // timestamp must never make unchanged electrical measurements appear newer.
  return latest;
}

function chargerTelemetryAt(list, now) {
  let latestAt = null;
  for (const [id, minimum, maximum, units] of CHARGER_TELEMETRY) {
    const matches = list.filter(row => number(row?.id) === id).map(row => ({
      value: number(row.value), at: sourceTime(row.timestamp), unit: row.unit,
    }));
    if (!matches.length || matches.some(row => row.value === null || row.value < minimum || row.value > maximum
      || row.at === null || row.at < 0 || row.at > now || row.unit != null && !units.includes(row.unit))) continue;
    matches.sort((a, b) => b.at - a.at);
    const latest = matches[0];
    if (matches.some(row => row.at === latest.at && row.value !== latest.value)) continue;
    latestAt = Math.max(latestAt ?? latest.at, latest.at);
  }
  // Keep evidence of device activity only, never diagnostic values or payloads.
  return latestAt;
}

// 129 is the finalized session; 223 announces its start. 121 is telemetry and
// has no reliable reset/end boundary, so it must not manufacture session checks.
// The payload schema is also implemented by the EVCC Easee adapter:
// https://github.com/evcc-io/evcc/blob/master/charger/easee/signalr.go
function chargerSession(list, id, device, now) {
  const candidates = list.filter(row => number(row?.id) === id)
    .map(row => ({ row, at: sourceTime(row.timestamp) }))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const picked = candidates[0];
  if (!picked || picked.at === null || picked.at < 0 || picked.at > now) return null;
  const parse = ({ row, at }) => {
    let payload = row.value;
    if (typeof payload === 'string') {
      if (payload.length > 16_384) return null;
      try { payload = JSON.parse(payload); } catch { return null; }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const sessionId = number(payload.Id), start = sourceTime(payload.Start);
    if (!Number.isSafeInteger(sessionId) || sessionId < 0 || start === null || start < 0 || start > at) return null;
    // Never retain the authorization token or the original JSON/device/session ID.
    const sessionKey = createHash('sha256').update(JSON.stringify([device, sessionId, start])).digest('hex');
    const result = { sessionKey, start, reportedAt: at };
    if (id === 223) return result;
    const end = sourceTime(payload.Stop), referenceKwh = number(payload.EnergyKwh);
    if (end === null || end <= start || end > at || referenceKwh === null || referenceKwh < 0) return null;
    const meterStart = number(payload.MeterValueStart), meterEnd = number(payload.MeterValueStop);
    return { ...result, end, referenceKwh, quality: meterStart !== null && meterEnd !== null && meterEnd < meterStart ? ['counter-reset'] : [] };
  };
  const result = parse(picked);
  if (!result || candidates.some(candidate => candidate.at === picked.at && JSON.stringify(parse(candidate)) !== JSON.stringify(result))) return null;
  return result;
}

function electricalObservations(payload, device, prefix, fields, now, voltageVerified = false) {
  const list = Array.isArray(payload) ? payload : payload?.observations;
  if (!Array.isArray(list) || list.length > 1000) throw new Error('Invalid Easee observations');
  const connection = deviceConnection(list, now);
  const telemetryAt = prefix === 'ev1' ? chargerTelemetryAt(list, now) : null;
  const sessions = prefix === 'ev1' ? { chargingSession: chargerSession(list, 129, device, now),
    chargingSessionStart: chargerSession(list, 223, device, now) } : null;
  return fields.map(([id, name, unit]) => {
    const matches = list.filter(row => number(row?.id) === id)
      .map(row => ({ row, at: sourceTime(row.timestamp) })).sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
    const picked = matches[0], at = picked?.at ?? null, input = number(picked?.row.value);
    let value = input;
    const counter = name.endsWith('_counter');
    const quality = counter ? [] : timeQuality(at, now, 5 * 60_000);
    if (at === null && counter) quality.push('source_time_unknown');
    if (at > now + 60_000 && counter) quality.push('future_source_time');
    if (matches.length > 1) {
      quality.push('duplicate_observation');
      if (matches.some(row => row.at === at && number(row.row.value) !== input)) {
        value = null; quality.push('conflicting_duplicate');
      }
    }
    if (picked?.row.unit != null && picked.row.unit !== unit) { value = null; quality.push('invalid_unit'); }
    if (value !== null && (value < 0 || (unit === 'A' && value > 1000) || (unit === 'V' && value > 500) || (unit === 'kW' && value > 1000))) {
      value = null; quality.push('invalid_numeric');
    }
    if (value === null) quality.push('missing');
    if (name.startsWith('current_')) quality.push('current_snapshot_not_energy');
    return { source: 'easee', device, signal: `${prefix}_${name}`, value, unit, sourceTime: at, receivedAt: now,
      quality, raw: { observationId: id, acquisitionOnly: true, auditOnly: counter, deviceConnection: { ...connection }, deviceTelemetryAt: telemetryAt,
        ...(prefix === 'ev1' && name === 'active_power' ? sessions : {}),
        ...(unit === 'V' ? { voltageMapping: prefix === 'property' || voltageVerified ? 'phase-neutral' : 'terminal-pair-unverified' } : {}) } };
  });
}

function annotateElectricalCurrents(rows) {
  const currents = rows.filter(row => /_current_l[123]$/.test(row.signal));
  const property = currents.filter(row => row.signal.startsWith('property_'));
  const charger = currents.filter(row => row.signal.startsWith('ev1_'));
  if (property.length === 3 && property.every(row => row.value === 0)) property.forEach(row => row.quality.push('all_zero_property_current'));
  for (const group of [property, charger]) {
    const times = group.map(row => row.sourceTime).filter(Number.isFinite);
    if (times.length > 1 && Math.max(...times) - Math.min(...times) > 30_000) group.forEach(row => row.quality.push('asynchronous_snapshot'));
  }
  if (property.length === 3 && charger.length === 3 && currents.every(row => row.value !== null)
    && charger.reduce((sum, row) => sum + row.value, 0) > property.reduce((sum, row) => sum + row.value, 0) + 0.5)
    currents.forEach(row => row.quality.push('ev_exceeds_property_current'));
  return rows;
}

// This projection is intentionally not an observation array: control metadata
// stays in RAM and can never enter ordinary acquisition/storage accidentally.
function identificationSnapshot(payload, now) {
  const list = Array.isArray(payload) ? payload : payload?.observations;
  if (!Array.isArray(list) || list.length > 1000) throw new Error('Invalid Easee control observations');
  const pick = (id, unit, maximum = 1000, integer = false) => {
    const matches = list.filter(row => number(row?.id) === id).map(row => ({
      value: number(row.value), at: sourceTime(row.timestamp), unit: row.unit,
    })).sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
    const row = matches[0];
    if (!row || row.value === null || row.value < 0 || row.value > maximum || integer && !Number.isInteger(row.value)
      || row.at === null || row.at < 0 || row.at > now || row.unit != null && row.unit !== unit
      || matches.some(candidate => candidate.at === row.at && (candidate.value !== row.value || candidate.unit != null && candidate.unit !== unit)))
      return { value: null, at: null };
    return { value: row.value, at: row.at };
  };
  const max = pick(47, 'A', 80), dynamic = pick(48, 'A', 80), mode = pick(109, undefined, 10, true);
  const output = pick(114, 'A', 80), power = pick(120, 'kW');
  const currents = [183, 184, 185].map(id => pick(id, 'A', 80));
  const circuit = [111, 112, 113].map(id => pick(id, 'A'));
  const equalizer = [230, 231, 232].map(id => pick(id, 'A'));
  const connection = deviceConnection(list, now);
  const telemetryAt = chargerTelemetryAt(list, now);
  // An old timestamp on a change-reported setting is valid state, not a fresh
  // electrical measurement. Missing limits must never be interpreted as clear.
  // Only an unrestricted per-charger cap may be replaced: after TTL expiry the
  // existing static, circuit, Equalizer and car limits still apply.
  const safeToProbe = connection.connected === true && max.value !== null && max.value >= 6 && max.value <= 32
    && dynamic.value !== null && dynamic.value >= 32;
  const recent = (at, maximumAge) => at !== null && now - at <= maximumAge;
  const electrical = [power, ...currents];
  const baselineHeld = electrical.some(row => !recent(row.at, 60_000));
  // The observations endpoint returns last reported values, not a new sample
  // on each GET. An unchanged charging baseline can be held within the same
  // 17-minute device-activity bound used by ordinary acquisition (Easee's
  // documented online detection also uses TempMax/RSSI within 17 minutes).
  // This only permits a bounded reduction; proving its effect/recovery still
  // requires NEW electrical source timestamps after the command/expiry.
  const baselineUsable = connection.connected === true && mode.value === 3 && power.value > 0
    && electrical.every(row => row.value !== null && recent(row.at, 17 * 60_000))
    && (!baselineHeld || recent(telemetryAt, 17 * 60_000));
  return {
    receivedAt: now, connected: connection.connected, connectedAt: connection.observedAt, telemetryAt,
    mode: mode.value, modeAt: mode.at, powerKw: power.value, powerAt: power.at,
    currents: currents.map(row => row.value), currentTimes: currents.map(row => row.at),
    dynamicChargerCurrent: dynamic.value, dynamicChargerCurrentAt: dynamic.at,
    maxChargerCurrent: max.value, maxChargerCurrentAt: max.at,
    outputCurrent: output.value, outputCurrentAt: output.at,
    dynamicCircuitCurrents: circuit.map(row => row.value), dynamicCircuitCurrentTimes: circuit.map(row => row.at),
    equalizerCurrents: equalizer.map(row => row.value), equalizerCurrentTimes: equalizer.map(row => row.at),
    safeToProbe, baselineUsable, baselineHeld, minCurrentA: 7,
  };
}

/**
 * Inject bounded http.json(url, fetchOptions) and optional secret-only tokenStore.
 * Each call returns normalized observation arrays, including null error records for
 * configured devices. No provider is contacted until a returned method is invoked.
 */
export function createDeviceProviders({ connections = {}, http, tokenStore, clock = Date.now } = {}) {
  if (typeof http?.json !== 'function') throw new TypeError('An HTTP JSON transport is required');
  const smartthings = { ...connections.smartthings }; const easee = { ...connections.easee };
  let tokens = { accessToken: easee.access_token ?? '', refreshToken: easee.refresh_token ?? '' };
  let loadFlight = null; let refreshFlight = null; let saveFlight = null; let dirtyTokens = false;
  const requestTimes = [];
  let blockedUntil = 0;

  function admitRequest() {
    const now = clock();
    while (requestTimes.length && requestTimes[0] <= now - 300_000) requestTimes.shift();
    const retryAt = Math.max(blockedUntil, requestTimes.length >= 90 ? requestTimes[0] + 300_000 : 0);
    if (retryAt > now) throw Object.assign(new Error('Easee rate limit'), { status: 429, retryAfterMs: retryAt - now });
    requestTimes.push(now); // Shared by devices and authentication retries, with margin below 100/5min.
  }

  async function request(url, options, provider, responseText = false) {
    try { return await (responseText ? http.text(url, options) : http.json(url, options)); }
    catch (error) { throw sanitized(error, provider); }
  }
  async function easeeTransport(url, options, responseText = false) {
    admitRequest();
    try { return await request(url, options, 'Easee', responseText); }
    catch (error) {
      if (httpStatus(error) === 429) blockedUntil = Math.max(blockedUntil, clock() + (error.retryAfterMs ?? 300_000));
      throw error;
    }
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
          const payload = await easeeTransport(`${API}/api/accounts/refresh_token`, {
            method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
            body: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }), signal,
          });
          await saveTokens(payload); return;
        } catch (error) {
          // Rate limiting/outages do not justify password retries or account pressure.
          if (![400, 401, 403].includes(httpStatus(error))) throw error;
        }
      }
      if (!supplied(easee.user) || !supplied(easee.pw)) throw Object.assign(new Error('Easee authentication requires credentials or a valid refresh token'), { code: 'EASEE_CONFIGURATION' });
      const payload = await easeeTransport(`${API}/api/accounts/login`, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ userName: easee.user, password: easee.pw }), signal,
      });
      await saveTokens(payload);
    })();
    try { await refreshFlight; } finally { refreshFlight = null; }
  }
  async function easeeAuthenticated(url, options, responseText = false) {
    const { signal } = options;
    await loadTokens();
    await persistTokens();
    if (!supplied(tokens.accessToken)) await refreshTokens({ attemptedToken: tokens.accessToken, signal });
    const attemptedToken = tokens.accessToken;
    const send = () => easeeTransport(url, { ...options,
      headers: { accept: 'application/json', ...options.headers, Authorization: `Bearer ${tokens.accessToken}` } }, responseText);
    try { return await send(); }
    catch (error) {
      if (httpStatus(error) !== 401) throw error;
      await refreshTokens({ attemptedToken, signal });
      return send(); // Only a known authentication rejection permits one retry.
    }
  }
  async function easeeRequest(device, ids, signal) {
    return easeeAuthenticated(`${API}/state/${encodeURIComponent(device)}/observations?ids=${ids.join(',')}`, { method: 'GET', signal });
  }
  let identificationFlight = false;
  let identificationUntil = 0;
  const identificationControl = {
    async read({ signal } = {}) {
      if (!supplied(easee.charger_id)) throw new Error('Easee charger identification is not configured');
      const payload = await easeeRequest(easee.charger_id, IDENTIFICATION_IDS, signal);
      return identificationSnapshot(payload, clock());
    },
    async limit({ amps, minutes, signal } = {}) {
      if (!Number.isInteger(amps) || !(amps === 0 || amps >= 6 && amps <= 32) || minutes !== 1)
        throw new TypeError('Charger identification requires 0 or 6..32 amps and a one-minute expiry');
      if (typeof http.text !== 'function') throw new Error('Easee charger identification transport is unavailable');
      if (identificationFlight || clock() < identificationUntil) throw new Error('Easee charger identification is already active');
      identificationFlight = true;
      let attempted = false;
      try {
        // Re-read immediately before mutation, so a competing controller's newly
        // applied cap is not knowingly replaced by an expiring diagnostic limit.
        const snapshot = await identificationControl.read({ signal });
        const active = snapshot.currents.filter(value => value !== null && value > 1);
        if (!snapshot.safeToProbe || !snapshot.baselineUsable || !active.length || amps >= Math.min(...active))
          throw new Error('Easee charger identification control is not currently safe');
        const requestedAt = clock();
        attempted = true;
        identificationUntil = requestedAt + 60_000;
        await easeeAuthenticated(`${API}/api/chargers/${encodeURIComponent(easee.charger_id)}/commands/set_dynamic_charger_current`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amps, minutes }), signal,
        }, true);
        // HTTP acceptance is not evidence the charger acted; callers must observe
        // actual current/power. No response bodies or remote identifiers escape.
        return { accepted: true, requestedAt, expiresAfterMs: 60_000 };
      } finally {
        // An ambiguous timeout must not trigger another write. Include request
        // duration because the device's TTL starts after delivery, not dispatch.
        if (attempted) identificationUntil = Math.max(identificationUntil, clock() + 60_000);
        identificationFlight = false;
      }
    },
  };

  return {
    chargerIdentificationControl() { return identificationControl; },
    async electricity({ now = Date.now(), signal } = {}) {
      validNow(now);
      const jobs = [['charger_id', 'ev1'], ['equalizer_id', 'property']].filter(([key]) => supplied(easee[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, prefix]) => {
        const voltageIds = easee.charger_voltage_ids;
        const verified = prefix === 'ev1' && Array.isArray(voltageIds) && voltageIds.length === 3
          && new Set(voltageIds).size === 3 && voltageIds.every(id => Number.isInteger(id) && id >= 190 && id <= 199);
        const fields = ELECTRICITY_FIELDS[prefix].map(([id, name, unit]) =>
          [verified && unit === 'V' ? voltageIds[Number(name.at(-1)) - 1] : id, name, unit]);
        const ids = [...fields.map(row => row[0]), 250, ...(prefix === 'ev1' ? [...CHARGER_TELEMETRY.map(row => row[0]), 129, 223] : [])];
        return electricalObservations(await easeeRequest(easee[key], ids, signal), easee[key], prefix, fields, now, verified);
      }));
      return annotateElectricalCurrents(results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : ELECTRICITY_FIELDS[jobs[index][1]].map(([id, name, unit]) => ({
        ...baseObservation({ source: 'easee', device: easee[jobs[index][0]], signal: `${jobs[index][1]}_${name}`, unit, now,
          quality: failureFlags(result.reason) }),
        raw: { observationId: id, acquisitionOnly: true, auditOnly: name.endsWith('_counter'), retryAfterMs: result.reason?.retryAfterMs },
      }))));
    },

    async temperatures({ now = Date.now(), signal, signals = TEMPERATURES.map(([, name]) => name) } = {}) {
      validNow(now);
      const jobs = TEMPERATURES.filter(([key, name]) => signals.includes(name) && supplied(smartthings[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, name]) => {
        if (!supplied(smartthings.token)) return baseObservation({ source: 'smartthings', device: smartthings[key], signal: name, unit: 'degC', now, quality: ['missing_configuration'] });
        const payload = await request(`https://api.smartthings.com/v1/devices/${encodeURIComponent(smartthings[key])}/status`, {
          method: 'GET', headers: { accept: 'application/json', Authorization: `Bearer ${smartthings.token}` }, signal,
        }, 'SmartThings');
        return temperatureObservation(payload, smartthings[key], name, now);
      }));
      return results.map((result, index) => result.status === 'fulfilled' ? result.value : baseObservation({
        source: 'smartthings', device: smartthings[jobs[index][0]], signal: jobs[index][1], unit: 'degC', now, quality: failureFlags(result.reason), retryAfterMs: result.reason?.retryAfterMs,
      }));
    },

    async easee({ now = Date.now(), signal } = {}) {
      validNow(now);
      const jobs = CURRENT_DEVICES.filter(([key]) => supplied(easee[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, ids, prefix]) =>
        currentObservations(await easeeRequest(easee[key], ids, signal), easee[key], ids, prefix, now)));
      const rows = results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : jobs[index][1].map((id, phase) => baseObservation({
        source: 'easee', device: easee[jobs[index][0]], signal: `${jobs[index][2]}_l${phase + 1}`, unit: 'A', now,
        quality: ['current_snapshot_not_energy', ...failureFlags(result.reason)], retryAfterMs: result.reason?.retryAfterMs,
      })));
      const property = rows.filter(row => row.signal.startsWith('property_'));
      const charger = rows.filter(row => row.signal.startsWith('ev1_'));
      if (property.length === 3 && property.every(row => row.value === 0)) property.forEach(row => row.quality.push('all_zero_property_current'));
      // Each device reports its own phase snapshot. An unused charger's old
      // event timestamps say nothing about the Equalizer's phase consistency.
      for (const group of [property, charger]) {
        const timestamps = group.map(row => row.sourceTime).filter(at => at !== null);
        if (timestamps.length > 1 && Math.max(...timestamps) - Math.min(...timestamps) > 30_000)
          group.forEach(row => row.quality.push('asynchronous_snapshot'));
      }
      if (property.length === 3 && charger.length === 3 && rows.every(row => row.value !== null)
        && charger.reduce((sum, row) => sum + row.value, 0) > property.reduce((sum, row) => sum + row.value, 0) + 0.5) rows.forEach(row => row.quality.push('ev_exceeds_property_current'));
      return rows;
    },
  };
}
