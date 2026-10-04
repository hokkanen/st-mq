// Observation boundary and native charging schedule transport. The runtime owns
// economic scheduling and identification pauses; installation limits stay read-only.
// Protocol sources checked 2026-09-06:
// https://developer.easee.com/reference/getobservations
// https://developer.easee.com/reference/account_refreshtoken
// https://developer.easee.com/docs/charger-observation-ids
// https://developer.easee.com/docs/amqp-commands
// https://developer.easee.com/docs/enumerations
// https://developer.easee.com/docs/load-balancing
// https://developer.easee.com/changelog/ocpp-15
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CHARGING_OBSERVATION_IDS, chargingSnapshot, createEaseeScheduleAdapter, effectiveScheduleFingerprint, normalizeScheduleState } from '../charging/easee.js';
import { createEaseeStream } from './easee-stream.js';
import { createEaseeOcpp } from './easee-ocpp.js';
import { createOcppSetup, isOcppSetupState } from './easee-ocpp-setup.js';
import { createOcppScheduleAdapter } from '../charging/ocpp.js';
import { ProviderError, providerFailureCode } from './http.js';

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
  clean.code = providerFailureCode(error);
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

function currentObservations(payload, device, ids, prefix, now) {
  const observations = Array.isArray(payload) ? payload : payload?.observations;
  if (!Array.isArray(observations) || observations.length > 1000) throw new ProviderError('invalid-provider-observations');
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
      raw: { observationId: id, reportedValue: input, timestamp: at, transport: 'cloud' } };
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
  if (!Array.isArray(list) || list.length > 1000) throw new ProviderError('invalid-provider-observations');
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

/**
 * Inject bounded http.json(url, fetchOptions) and optional secret-only tokenStore.
 * Each call returns normalized observation arrays, including null error records for
 * configured devices. No provider is contacted until a returned method is invoked.
 */
export function createDeviceProviders({ connections = {}, http, tokenStore, clock = Date.now, canControl = () => true,
  streamFactory = createEaseeStream, ocppFactory = createEaseeOcpp, ocppState, ocppSetupState, ocppInstallation,
  onOcppControlTransition,
  onStreamDisconnect = () => {}, onChargerObservation = () => {}, retryState,
  fallbackIntervalMs = 15_000 } = {}) {
  if (typeof http?.json !== 'function') throw new TypeError('An HTTP JSON transport is required');
  const easee = { ...connections.easee };
  let tokens = { accessToken: easee.access_token ?? '', refreshToken: easee.refresh_token ?? '' };
  let loadFlight = null; let refreshFlight = null; let saveFlight = null; let dirtyTokens = false;
  const requestTimes = [];
  const savedRetryAt = Number.isFinite(retryState?.nextAttemptAt) && retryState.nextAttemptAt <= clock() + 86400_000
    ? Math.max(clock(), retryState.nextAttemptAt) : 0;
  let blockedUntil = retryState?.error === 'HTTP-429' ? savedRetryAt : 0;
  let authBlockedUntil = /^HTTP-(401|403|429)$/.test(retryState?.error ?? '') ? savedRetryAt : 0;
  let authFailure = authBlockedUntil ? { status: Number(retryState.error.slice(5)) } : null;
  const observationRetries = new Map();
  if (savedRetryAt > clock() && retryState?.error) {
    const status = /^HTTP-[1-5]\d{2}$/.test(retryState.error) ? Number(retryState.error.slice(5)) : null;
    for (const key of ['charger_id', 'equalizer_id']) if (supplied(easee[key]))
      observationRetries.set(easee[key], { until: savedRetryAt, failures: 1,
        code: providerFailureCode({ code: retryState.error, status }), status });
  }
  const lifetime = new AbortController();
  let closed = false, stream = null, streaming = false, electricityEpoch = 0, nativeStopped = false, restoringOcpp = false;
  let nativeStartPermission = null;
  const streamedElectricity = new Set(), streamedVoltage = new Set(), transports = new Map(), reconcileAt = new Map();
  const cloudVoltage = new Map();
  let savedOcppSetup, invalidOcppSetup = false;
  try {
    savedOcppSetup = ocppSetupState?.get?.();
    invalidOcppSetup = Boolean(ocppInstallation && !isOcppSetupState(savedOcppSetup, ocppInstallation.scope));
  } catch { invalidOcppSetup = true; }
  const restorationPending = !invalidOcppSetup && Boolean(savedOcppSetup?.ownedFingerprint || savedOcppSetup?.intent);
  let controlBackend = invalidOcppSetup ? 'transition' : restorationPending ? 'native' : 'cloud';
  const localConfig = ocppInstallation ? { ...easee.local_ocpp, password: ocppInstallation.password,
    enabled: !invalidOcppSetup && (ocppInstallation.enabled || restorationPending) } : easee.local_ocpp;
  const local = ocppFactory({ config: localConfig, chargerId: easee.charger_id, clock, virtualTag: ocppInstallation?.virtualTag,
    canControl: () => !closed && !nativeStopped && !invalidOcppSetup && canControl(), state: ocppState,
    canStart: () => {
      const permission = nativeStartPermission, current = local.controlSnapshot?.();
      const permitted = Boolean(permission && !closed && controlBackend === 'native' && canControl()
        && permission.until > clock() && permission.guard() && current?.connectionId === permission.connectionId
        && ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(current.connectorStatus)
        && startAppSignature(nativeAppControl()) === permission.appSignature);
      if (!permitted) nativeStartPermission = null;
      return permitted;
    },
    onDisconnect: () => {
      nativeStartPermission = null;
      if (!closed && supplied(easee.charger_id)) {
        electricityEpoch++; onStreamDisconnect([easee.charger_id], { transport: 'ocpp' });
      }
    } });
  const setupBase = `/local-ocpp/v1/connection-details/${encodeURIComponent(easee.charger_id ?? '')}`;
  const setup = ocppInstallation && ocppSetupState ? createOcppSetup({ installation: ocppInstallation,
    state: ocppSetupState, listener: local, clock, canControl: () => !closed && canControl(),
    beforeDisable: () => local.noteModeDisableRequested(),
    prepareControl: async target => {
      if (typeof onOcppControlTransition !== 'function') throw Object.assign(new Error('Native control is unavailable'), { code: 'native-control-unavailable' });
      const nativeScheduleClear = async () => {
        const current = await easeeAuthenticated(`${API}/api/chargers/${encodeURIComponent(easee.charger_id)}/schedules`, { method: 'GET' });
        return ['none', 'ocpp.direct'].includes(current?.enabled);
      };
      // Commissioning can replace the cloud schedule itself. Inspect it before
      // suspending the cloud controller: a blocked setup must not cancel that
      // controller's pending automatic takeover or release its economic wait.
      if (target === 'native' && !await nativeScheduleClear())
        throw Object.assign(new Error('Cloud schedule is active'), { code: 'cloud-schedule-active' });
      await onOcppControlTransition({ phase: 'prepare', target });
      controlBackend = 'transition';
      if (target === 'native') {
        // An external schedule can arrive while the old controller drains.
        if (!await nativeScheduleClear()) {
          controlBackend = 'cloud';
          await onOcppControlTransition({ phase: 'complete', target: 'cloud', adapter: scheduleControl });
          throw Object.assign(new Error('Cloud schedule is active'), { code: 'cloud-schedule-active' });
        }
      }
    },
    commitControl: async target => {
      if (typeof onOcppControlTransition !== 'function') throw Object.assign(new Error('Native control is unavailable'), { code: 'native-control-unavailable' });
      controlBackend = target;
      await onOcppControlTransition({ phase: 'complete', target, adapter: target === 'native' ? nativeScheduleControl : scheduleControl });
      if (target === 'cloud' && (!ocppInstallation.enabled || restoringOcpp)) {
        nativeStopped = true; local.refreshAuthority?.(); await local.close();
      }
    }, api: {
      get: ({ signal }) => easeeAuthenticated(`${API}${setupBase}`, { method: 'GET', signal }),
      observations: ({ signal }) => easeeRequest(easee.charger_id, [80, 141, 250], signal),
      store: (body, { signal }) => easeeAuthenticated(`${API}${setupBase}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }),
      apply: (body, { signal }) => easeeAuthenticated(`${API}/local-ocpp/v1/connections/chargers/${encodeURIComponent(easee.charger_id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }, true),
    } }) : null;
  let localStartFlight = null, nextLocalStartAt = 0;
  async function ensureLocalListener() {
    if (closed || nativeStopped || invalidOcppSetup || !canControl() || local.status().ready || nextLocalStartAt > clock()) return;
    if (localStartFlight) return localStartFlight;
    nextLocalStartAt = clock() + 30_000;
    localStartFlight = Promise.resolve().then(() => local.start()).finally(() => { localStartFlight = null; });
    await localStartFlight;
  }
  const electricalDevices = [['charger_id', 'ev1'], ['equalizer_id', 'property']]
    .filter(([key]) => supplied(easee[key])).map(([key, prefix]) => {
      const voltageIds = easee.charger_voltage_ids;
      const verified = prefix === 'ev1' && Array.isArray(voltageIds) && voltageIds.length === 3
        && new Set(voltageIds).size === 3 && voltageIds.every(id => Number.isInteger(id) && id >= 190 && id <= 199);
      const fields = ELECTRICITY_FIELDS[prefix].map(([id, name, unit]) =>
        [verified && unit === 'V' ? voltageIds[Number(name.at(-1)) - 1] : id, name, unit]);
      return { id: easee[key], prefix, fields, verified, requiredIds: [...fields.map(row => row[0]), 250],
        ids: [...fields.map(row => row[0]), 250, ...(prefix === 'ev1' ? [...CHARGER_TELEMETRY.map(row => row[0]), 129, 223] : [])] };
    });

  function disconnectStream() {
    electricityEpoch++;
    const affected = [...new Set([...streamedElectricity, ...streamedVoltage])];
    streamedElectricity.clear(); streamedVoltage.clear();
    for (const id of affected) if (cloudVoltage.has(id))
      cloudVoltage.set(id, { nextReadAt: cloudVoltage.get(id).nextReadAt });
    if (!closed && affected.length) onStreamDisconnect(affected, { transport: 'cloud' });
  }

  function openSignal(signal) {
    if (closed || signal?.aborted) throw new ProviderError('provider-request-aborted');
    return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  }

  async function streamAccessToken({ rejectedToken, signal } = {}) {
    if (!canControl()) throw new ProviderError('provider-request-aborted');
    signal = openSignal(signal);
    await loadTokens();
    await persistTokens();
    if (!supplied(tokens.accessToken) || rejectedToken !== undefined)
      await refreshTokens({ attemptedToken: rejectedToken ?? tokens.accessToken, signal });
    openSignal(signal);
    return tokens.accessToken;
  }

  function startStreaming() {
    if (!closed) void ensureLocalListener().then(() => setup?.runDue()).catch(() => {});
    if (closed || streaming || !electricalDevices.length || typeof streamFactory !== 'function') return;
    streaming = true;
    stream = streamFactory({ clock, getAccessToken: streamAccessToken, onDisconnect: disconnectStream,
      onObservation: (deviceId, observation) => {
        // Equalizer 31 is current, while charger 31 is enablement. Never route
        // electrical samples or private provider identifiers into session events.
        if (!closed && canControl() && deviceId === easee.charger_id
          && [31, 48, 96, 100, 109, 250].includes(observation.id)) {
          const { id, value, measuredAt } = observation;
          const restriction = [31, 250].includes(id) && [false, 0].includes(value)
            || id === 48 && value === 0 || id === 96 && [53, 56].includes(value)
            || id === 100 && value === 'A' || id === 109 && [0, 1, 5, 8].includes(value);
          // Preserve a live Stop/de-authorization edge even if its matching
          // recovery arrives before the next OCPP authorization check.
          if (restriction && Number.isSafeInteger(measuredAt) && measuredAt >= nativeStartPermission?.issuedAt
            && measuredAt <= clock()) nativeStartPermission = null;
          onChargerObservation(observation);
        }
      },
      products: electricalDevices.map(device => ({ id: device.id,
        ids: [...new Set([...device.ids, ...(device.prefix === 'ev1' ? CHARGING_OBSERVATION_IDS : [])])] })) });
    stream.start();
  }

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
    // Text responses are opted-in control writes. Check every
    // dispatch, including a retry after asynchronous authentication or storage.
    if ((responseText || url.startsWith(`${API}/local-ocpp/`) && options.method === 'POST') && !canControl())
      throw new Error('Controller authority was revoked');
    const nativeScheduleDisable = options.nativeTakeover === true && controlBackend === 'native'
      && /\/schedules\/(delayed|daily|weekly)\/disable$/.test(url) && options.method === 'POST';
    if (responseText && url.includes('/schedules') && controlBackend !== 'cloud' && !nativeScheduleDisable)
      throw new Error('Cloud charging control is inactive while native OCPP owns charging');
    if (responseText && options.controlGuard && !options.controlGuard()) throw new Error('Charging schedule authority was revoked');
    if (options.signal?.aborted) throw new Error('Provider request was aborted');
    admitRequest();
    const { controlGuard, nativeTakeover, ...transportOptions } = options;
    try { return await request(url, transportOptions, 'Easee', responseText); }
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
    if (authBlockedUntil > clock()) throw new ProviderError('provider-request-failed', authFailure?.status ?? null, authBlockedUntil - clock());
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
    try {
      await refreshFlight;
      authBlockedUntil = 0; authFailure = null;
    } catch (error) {
      authFailure = { status: httpStatus(error) };
      const delay = [400, 401, 403].includes(authFailure.status) || error?.code === 'EASEE_CONFIGURATION' ? 30 * 60_000 : 5 * 60_000;
      authBlockedUntil = clock() + Math.max(delay, Math.min(86400_000, error.retryAfterMs ?? 0));
      error.retryAfterMs = authBlockedUntil - clock();
      throw error;
    } finally { refreshFlight = null; }
  }
  async function easeeAuthenticated(url, options, responseText = false) {
    const signal = openSignal(options.signal);
    options = { ...options, signal };
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
  async function observationResult(device, ids, { signal, forceRest = false, requiredIds = ids, reconcile = false,
    validate = () => {} } = {}) {
    openSignal(signal);
    const epoch = electricityEpoch;
    const cached = forceRest ? null : stream?.snapshot(device, ids, { requiredIds });
    if (cached && (!reconcile || (reconcileAt.get(device) ?? 0) > clock())) return { payload: cached, transport: 'stream', usesStream: true };
    // A small periodic REST reconciliation detects a silently incomplete feed.
    // Healthy streaming remains usable if this optional check fails or is limited.
    if (reconcile) reconcileAt.set(device, clock() + 15 * 60_000);
    try {
      const retry = streaming ? observationRetries.get(device) : null;
      if (retry?.until > clock()) throw new ProviderError(retry.code, retry.status, retry.until - clock());
      const payload = await easeeRequest(device, ids, signal);
      openSignal(signal);
      validate(payload);
      if (epoch === electricityEpoch) stream?.reconcile?.(device, payload);
      reconcileAt.set(device, clock() + 15 * 60_000);
      observationRetries.delete(device);
      if (cached && epoch === electricityEpoch) {
        // REST and streaming can arrive in either order. A reconciliation must
        // not replace a newer streamed measurement with an older cloud snapshot.
        const latest = stream?.snapshot(device, ids, { requiredIds });
        const rows = Array.isArray(payload) ? payload : payload?.observations;
        if (latest && Array.isArray(rows)) {
          const seen = new Set(latest.map(row => row.id));
          return { payload: [...latest, ...rows.filter(row => !seen.has(number(row?.id)))], transport: 'rest', usesStream: true };
        }
        // A same-time conflict remains explicit for the existing field parsers.
        if (Array.isArray(rows)) return { payload: [...cached, ...rows], transport: 'rest', usesStream: true };
      }
      return { payload, transport: 'rest' };
    } catch (error) {
      const previous = observationRetries.get(device);
      if (streaming && (!previous || previous.until <= clock())) {
        const status = httpStatus(error), failures = Math.min(10, (previous?.failures ?? 0) + 1);
        const delay = status === 429 && error.retryAfterMs > 0 ? error.retryAfterMs
          : [401, 403].includes(status) ? 30 * 60_000
          : Math.min(30 * 60_000, (status && status < 500 ? 5 * 60_000 : fallbackIntervalMs) * 2 ** (failures - 1));
        observationRetries.set(device, { failures, status, code: providerFailureCode(error),
          until: clock() + Math.max(delay, Math.min(86400_000, error.retryAfterMs ?? 0)) });
      }
      if (!forceRest && cached && epoch === electricityEpoch) {
        openSignal(signal);
        const latest = stream?.snapshot(device, ids, { requiredIds });
        if (latest) return { payload: latest, transport: 'stream', usesStream: true };
      }
      throw error;
    }
  }
  async function readObservations(device, ids, options = {}) {
    // Optional firmware diagnostics and session events need not exist yet.
    const optional = new Set([110, 114, 129, 130, 132, 136, 150, 223,
      ...(!supplied(easee.equalizer_id) ? [230, 231, 232] : [])]);
    const requiredIds = ids.filter(id => !optional.has(id));
    return (await observationResult(device, ids, { requiredIds, ...options })).payload;
  }
  const scheduleControl = createEaseeScheduleAdapter({ request: easeeAuthenticated, readObservations,
    chargerId: easee.charger_id, equalizerId: easee.equalizer_id, clock, canControl: () => !invalidOcppSetup && canControl() });
  async function settleNativeClock({ signal } = {}) {
    const remaining = local.controlClockDelayMs?.() ?? 0;
    if (!(remaining > 0 && remaining <= 1000)) return false;
    await delay(remaining, undefined, { signal: openSignal(signal) });
    return true;
  }
  // Native OCPP still needs the vendor API to clear vendor Start/Stop and
  // schedules on an explicit handover. It never installs a cloud schedule.
  const nativeTakeoverControl = createEaseeScheduleAdapter({
    request: async (url, options, responseText) => {
      const result = await easeeAuthenticated(url, { ...options, nativeTakeover: true }, responseText);
      return options.method === 'GET' && url.endsWith('/schedules') && result?.enabled === 'ocpp.direct'
        ? { enabled: 'none' } : result;
    }, readObservations, chargerId: easee.charger_id, equalizerId: easee.equalizer_id, clock,
    canControl: () => !closed && !invalidOcppSetup && canControl() && controlBackend === 'native',
    settleReadback: settleNativeClock,
  });
  let nativeCloudSnapshot = null, nativeCloudSnapshotEpoch = null, nativeCloudSchedule = null, nativeCloudFlight = null, nextNativeCloudRead = 0;
  let nativeDynamicChargerAt = null;
  function refreshNativeCloudTelemetry({ force = false } = {}) {
    if (closed) return null;
    if (nativeCloudFlight) return force ? nativeCloudFlight.then(() => refreshNativeCloudTelemetry({ force: true })) : nativeCloudFlight;
    if (!force && nextNativeCloudRead > clock()) return null;
    nextNativeCloudRead = clock() + 60_000;
    const epoch = electricityEpoch;
    // Cloud evidence supplements the local connection; failures never grant app
    // priority or prevent exact-ID native cleanup. No cloud schedules are written.
    nativeCloudFlight = Promise.allSettled([
      scheduleControl.readTelemetry({ signal: lifetime.signal, forceRest: force }).then(snapshot => {
        nativeCloudSnapshot = snapshot; nativeCloudSnapshotEpoch = epoch;
      }),
      easeeAuthenticated(`${API}/api/chargers/${encodeURIComponent(easee.charger_id)}/schedules`,
        { method: 'GET', signal: lifetime.signal }).then(value => {
        nativeCloudSchedule = { readAt: clock(), schedule: normalizeScheduleState(value?.enabled === 'ocpp.direct' ? { enabled: 'none' } : value) };
      }),
    ]).finally(() => { nativeCloudFlight = null; });
    return nativeCloudFlight;
  }
  function nativeAppControl() {
    const now = clock();
    let cloud = nativeCloudSnapshot && now - nativeCloudSnapshot.readAt <= 60_000 ? nativeCloudSnapshot : null;
    // A streamed app change must fence a queued OCPP write immediately, without
    // waiting for the next periodic REST read. Source timestamps stay intact.
    const rows = stream?.snapshot(easee.charger_id, CHARGING_OBSERVATION_IDS, { requiredIds: [31, 96, 100, 109, 250] });
    if (rows) {
      try {
        const previous = Object.entries(cloud?.observations ?? {}).filter(([, row]) => Number.isSafeInteger(row.at))
          .map(([id, row]) => ({ id: Number(id), value: row.value, timestamp: new Date(row.at).toISOString() }));
        cloud = chargingSnapshot([...previous, ...rows], null, now);
      } catch {}
    }
    nativeDynamicChargerAt = cloud?.observations?.[48]?.at ?? null;
    const schedule = nativeCloudSchedule && now - nativeCloudSchedule.readAt <= 60_000 ? nativeCloudSchedule.schedule : null;
    if (!cloud && !schedule) return null;
    // In native plug-and-charge, pending authentication is the approval this
    // controller supplies. Treating it as an external refusal prevents the
    // permission needed to send RemoteStartTransaction. De-authentication and
    // other restrictions retain their independent authority.
    const pendingLocalApproval = controlBackend === 'native' && localConfig?.authorization_mode === 'plug-and-charge'
      && ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE'].includes(local.controlSnapshot?.()?.connectorStatus)
      && cloud?.mode !== 8 && (cloud?.mode === 7 || cloud?.reason === 55);
    return { readAt: Math.max(cloud?.readAt ?? 0, schedule ? nativeCloudSchedule.readAt : 0),
      enabled: cloud?.enabled ?? null, enabledAt: cloud?.observations?.[31]?.at ?? null,
      stopped: cloud?.stopped === true,
      stopAt: cloud ? Math.max(cloud.observations?.[31]?.at ?? 0, cloud.observations?.[48]?.at ?? 0, cloud.reasonAt ?? 0) : null,
      controlKnown: cloud?.controlKnown === true, faulted: cloud?.faulted === true,
      authorizationBlocked: cloud?.authorizationBlocked === true && !pendingLocalApproval, schedule };
  }
  const appSignature = value => value ? JSON.stringify([value.controlKnown, value.enabled, value.enabledAt, value.stopped, value.stopAt, value.faulted,
    value.authorizationBlocked, value.schedule ? effectiveScheduleFingerprint(value.schedule) : null]) : null;
  // Pending approval advances ReasonForNoCurrent's clock without creating a
  // Stop instruction. Keep startup permission through that transition; a real
  // stop, enablement change, fault or schedule still fences it immediately.
  // Keep the current-setting clock separately: a Stop/Resume between checks
  // cannot borrow a permission issued before those commands.
  const startAppSignature = value => JSON.stringify([appSignature(value ? { ...value,
    stopAt: value.stopped ? value.stopAt : null } : null), nativeDynamicChargerAt]);
  function readCurrentSupply() {
    const now = clock(), current = !closed && controlBackend === 'native' ? local.controlSnapshot?.() : null;
    const unavailableEvidence = source => ({ source, connected: false, online: null, synchronized: false,
      epoch: null, receivedAt: null, activityAt: null, sourceAt: null });
    const unknown = () => ({ currents: null, times: [null, null, null], source: null, evidence: unavailableEvidence(null) });
    const phases = (rows, ids, source) => {
      const values = ids.map(id => {
        const candidates = (rows ?? []).filter(row => row.id === id).map(row => ({
          value: number(row.value), at: sourceTime(row.timestamp), unit: row.unit,
        })).sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
        const selected = candidates[0];
        return selected && selected.at !== null && selected.at <= now && selected.value !== null
          && selected.value >= 0 && selected.value <= 1000 && (selected.unit == null || selected.unit === 'A')
          && !candidates.some(row => row.at === selected.at && (row.value !== selected.value || row.unit !== selected.unit))
          ? selected : { value: null, at: selected?.at ?? null };
      });
      return { currents: values.every(row => row.value !== null) ? values.map(row => row.value) : null,
        times: values.map(row => row.at), source };
    };
    const cloud = current && nativeCloudSnapshotEpoch === electricityEpoch && nativeCloudSnapshot?.online === true
      && now >= nativeCloudSnapshot.readAt && now - nativeCloudSnapshot.readAt <= 300_000 ? nativeCloudSnapshot.supply : null;
    const cached = (kind, field) => cloud ? {
      currents: Array.isArray(cloud[field]) ? [...cloud[field]] : null,
      times: [...(cloud.observationTimes?.[kind] ?? [null, null, null])], source: 'easee-cloud',
      evidence: unavailableEvidence('easee-cloud'),
    } : unknown();
    const streamed = (device, ids) => {
      if (!current || !supplied(device)) return null;
      const rows = stream?.snapshot(device, [...ids, 250], { requiredIds: [] });
      const suppliedEvidence = stream?.evidence?.(device, ids);
      const { observations, ...evidence } = suppliedEvidence ?? unavailableEvidence('easee-stream');
      const empty = { ...phases([], ids, 'easee-stream'), evidence };
      if (!rows) return stream?.status()?.connected === true ? empty : null;
      const online = rows.find(row => row.id === 250), at = sourceTime(online?.timestamp);
      if (at === null || at > now || ![true, 1, 'true', '1'].includes(online?.value)) return empty;
      // The live-only evidence view cannot borrow a newer REST cache entry or
      // measurements from before this device's most recent online boundary.
      return { ...phases(suppliedEvidence ? observations ?? [] : rows, ids, 'easee-stream'), evidence };
    };
    const propertyStream = streamed(easee.equalizer_id, [31, 32, 33]);
    const chargerStream = streamed(easee.charger_id, [183, 184, 185]);
    const allowance = streamed(easee.charger_id, [230, 231, 232]) ?? cached('allowance', 'availableCurrentA');
    const circuit = streamed(easee.charger_id, [22, 23, 24]) ?? { ...unknown(), source: 'easee-cloud',
      evidence: unavailableEvidence('easee-cloud'),
      currents: cloud && Array.isArray(nativeCloudSnapshot?.limits?.circuitA) ? [...nativeCloudSnapshot.limits.circuitA] : null,
      times: cloud ? [22, 23, 24].map(id => nativeCloudSnapshot.observations?.[id]?.at ?? null) : [null, null, null] };
    const nativeRows = current?.readings?.filter(row => [183, 184, 185].includes(row.id)) ?? [];
    const property = propertyStream ?? cached('property', 'propertyCurrentA');
    const charger = nativeRows.length ? phases(nativeRows, [183, 184, 185], 'easee-ocpp')
      : chargerStream ?? cached('charger', 'chargerCurrentA');
    if (nativeRows.length) {
      const receipts = nativeRows.map(row => row.receivedAt).filter(at => Number.isSafeInteger(at) && at <= now);
      charger.evidence = { source: 'easee-ocpp', connected: true, online: true, synchronized: charger.currents !== null,
        epoch: current.connectionId, receivedAt: receipts.length ? Math.max(...receipts) : null,
        activityAt: receipts.length ? Math.max(...receipts) : null,
        sourceAt: charger.currents !== null ? Math.max(...charger.times) : null };
    }
    // Reading this view performs no provider request and never renews a source
    // clock. Stream connection health and live activity are separate evidence.
    return { online: Boolean(current), supply: { propertyCurrentA: property.currents, chargerCurrentA: charger.currents,
      availableCurrentA: allowance.currents, circuitCurrentA: circuit.currents,
      allocationA: cloud ? cloud.allocationA ?? nativeCloudSnapshot.limits?.allocationA ?? null : null,
      observationTimes: { property: property.times, charger: charger.times, allowance: allowance.times, circuit: circuit.times },
      currentSources: { property: property.source, charger: charger.source },
      feedEvidence: { property: property.evidence, charger: charger.evidence, allowance: allowance.evidence, circuit: circuit.evidence } } };
  }
  const nativeScheduleControl = ocppInstallation ? createOcppScheduleAdapter({ scope: ocppInstallation.scope, clock,
    readCurrentSupply,
    canControl: () => !closed && canControl() && controlBackend === 'native',
    setStartPermission: (snapshot, options = {}) => {
      const current = snapshot ? nativeAppControl() : null;
      nativeStartPermission = snapshot && typeof options.guard === 'function' && Number.isSafeInteger(options.until)
        && appSignature(snapshot.appControl) === appSignature(current)
        ? { connectionId: snapshot.connectionId, appSignature: startAppSignature(snapshot.appControl),
          issuedAt: clock(), until: options.until, guard: options.guard } : null;
    },
    request: (...args) => local.request(...args),
    takeoverNative: async ({ expectedAppControl, signal, canMutate, beforeWrite }) => {
      const snapshot = await nativeTakeoverControl.read({ signal, forceRest: true });
      const remember = value => {
        nativeCloudSnapshot = value;
        nativeCloudSchedule = { readAt: value.readAt, schedule: value.schedule };
      };
      remember(snapshot);
      if (!canMutate() || appSignature(nativeAppControl()) !== appSignature(expectedAppControl))
        throw Object.assign(new Error('The charger instruction changed before automatic handover.'), { code: 'takeover-stale' });
      const result = await nativeTakeoverControl.takeover({ expectedSnapshot: snapshot, signal, canMutate, beforeWrite,
        afterWrite: ({ snapshot: confirmed }) => remember(confirmed) });
      remember(result);
      return nativeAppControl();
    },
    isCurrent: (snapshot, { requireTransaction = true, unchangedStatus = false } = {}) => {
      const current = local.controlSnapshot?.();
      return Boolean(current && current.connectionId === snapshot.connectionId && (!requireTransaction
        || (current.transaction?.id ?? null) === snapshot.transactionId
          && (snapshot.transactionId === null || current.transaction?.confirmed))
        && (!unchangedStatus || current.connectorStatus === snapshot.connectorStatus && current.timestamp === snapshot.statusAt
          && appSignature(nativeAppControl()) === appSignature(snapshot.appControl)));
    },
    readSnapshot: async ({ signal, forceAppRefresh = false } = {}) => {
      if (forceAppRefresh) await refreshNativeCloudTelemetry({ force: true });
      else refreshNativeCloudTelemetry();
      // Ordinary polling needs the same one-shot clock barrier as takeover.
      // Preserve unknown if another future status arrives during the wait.
      await settleNativeClock({ signal });
      const current = local.controlSnapshot?.(), now = clock();
      const power = current?.readings.find(row => row.id === 120);
      const cloud = nativeCloudSnapshot && now - nativeCloudSnapshot.readAt <= 300_000 ? nativeCloudSnapshot : null;
      const vector = ids => {
        const values = ids.map(id => current?.readings.find(row => row.id === id)?.value);
        return values.every(Number.isFinite) ? values : null;
      };
      const pluggedIn = current ? current.connectorStatus === 'Available' ? false
        : ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'].includes(current.connectorStatus) ? true : null : null;
      return { transport: 'ocpp', scope: ocppInstallation.scope, connectionId: current?.connectionId ?? null,
        readAt: now, online: Boolean(current), connectorStatus: current?.connectorStatus ?? null,
        statusAt: current?.timestamp ?? null, statusReceivedAt: current?.receivedAt ?? null, pluggedIn,
        transactionId: current?.transaction?.id ?? null, transactionStartedAt: current?.transaction?.startedAt ?? null,
        transactionProvenance: current?.transaction?.provenance ?? null,
        transactionConfirmedAt: current?.transaction?.confirmedAt ?? null,
        transactionConfirmed: current?.transaction?.confirmed === true,
        appControl: nativeAppControl(),
        externalLoadBalancing: cloud?.externalLoadBalancing ?? null,
        powerKw: power?.value ?? null, powerAt: power ? sourceTime(power.timestamp) : null, powerReceivedAt: power?.receivedAt ?? null,
        ...(cloud ? { limits: cloud.limits } : {}),
        supply: { ...cloud?.supply, chargerCurrentA: vector([183, 184, 185]), voltageV: vector([194, 195, 196]),
          observationTimes: { ...cloud?.supply?.observationTimes,
            charger: [183, 184, 185].map(id => sourceTime(current?.readings.find(row => row.id === id)?.timestamp)),
            voltage: [194, 195, 196].map(id => sourceTime(current?.readings.find(row => row.id === id)?.timestamp)) } } };
    } }) : null;

  async function supplementalCloudVoltage({ id, fields, verified }, now, signal, needed) {
    if (!verified) return [];
    const voltageFields = fields.filter(([, , unit]) => unit === 'V');
    const ids = [...voltageFields.map(([id]) => id), 250, ...CHARGER_TELEMETRY.map(([id]) => id)];
    let cached = cloudVoltage.get(id);
    const streamed = stream?.snapshot(id, ids, { requiredIds: [250] });
    let payload = streamed ?? cached?.payload;
    if (streamed) streamedVoltage.add(id);
    // Existing stream/cache evidence costs no provider request. Only an absent
    // local phase needs a bounded REST fallback; it shares normal provider backoff.
    if (needed && !streamed && (!cached || now >= cached.nextReadAt)) {
      cached = { ...cached, nextReadAt: now + Math.max(60_000, fallbackIntervalMs) };
      cloudVoltage.set(id, cached);
      try {
        const result = await observationResult(id, ids, { signal, requiredIds: [250] });
        payload = result.payload;
        cloudVoltage.set(id, { ...cached, payload });
        if (result.usesStream) streamedVoltage.add(id);
      } catch {
        // An optional voltage fallback cannot discard usable local power/current.
        // Its prior source clocks still bound any cached evidence.
      }
    }
    return payload ? electricalObservations(payload, id, 'ev1', voltageFields, now, true)
      .map(row => ({ ...row, raw: { ...row.raw, transport: 'cloud', voltageOnly: true } })) : [];
  }

  return {
    startStreaming,
    electricityEpoch() { return electricityEpoch; },
    canSampleStream() {
      return Boolean(local.snapshot() || local.voltageSnapshot?.() || stream && electricalDevices.length && electricalDevices.some(device =>
        stream.snapshot(device.id, device.ids, { requiredIds: device.requiredIds }) !== null));
    },
    streamStatus() { return stream?.status() ?? null; },
    localOcppStatus(options) { return { ...local.status(), controlTransport: controlBackend === 'native' ? 'ocpp' : controlBackend,
      ...(setup ? { setup: setup.status(options) } : {}) }; },
    async reconcileOcpp() {
      local.refreshAuthority?.();
      await ensureLocalListener();
      if (!closed && canControl()) await setup?.runDue();
    },
    adoptOcpp(revision) {
      if (!setup) throw Object.assign(new Error('Local charger setup is unavailable.'), { statusCode: 409 });
      return setup.adopt(revision);
    },
    async restoreOcpp() {
      if (!setup || closed) return;
      restoringOcpp = true;
      await setup.deactivate();
    },
    deviceTransports() { return Object.fromEntries(electricalDevices.map(device =>
      [device.prefix === 'ev1' ? 'charger' : 'property', transports.get(device.id) ?? null])); },
    acquisitionTransport() {
      if (!streaming || !transports.size) return null;
      const sources = new Set(transports.values());
      return sources.size > 1 ? 'mixed' : [...sources][0];
    },
    async close() {
      if (closed) return;
      disconnectStream();
      closed = true;
      lifetime.abort();
      local.refreshAuthority?.();
      await Promise.allSettled([setup?.close(), stream?.close(), local.close(), localStartFlight, nativeCloudFlight]);
    },
    chargerScheduleControl() { return controlBackend === 'native' ? nativeScheduleControl : scheduleControl; },
    async electricity({ now = Date.now(), signal } = {}) {
      validNow(now);
      const results = await Promise.allSettled(electricalDevices.map(async definition => {
        const { id, prefix, fields, verified, ids, requiredIds } = definition;
        const epoch = electricityEpoch;
        const direct = prefix === 'ev1' ? local.snapshot() : null;
        if (direct) {
          transports.set(id, 'ocpp'); streamedElectricity.delete(id);
          const rows = electricalObservations(direct, id, prefix, ELECTRICITY_FIELDS.ev1, now, true).map(row => ({ ...row,
            quality: [...row.quality, 'local_ocpp'], raw: { ...row.raw, transport: 'ocpp' } }));
          const missingPhase = rows.some(row => row.unit === 'V' && (row.value === null || row.value < 200 || row.value > 250
            || row.quality.some(flag => ['missing', 'stale', 'invalid_numeric', 'invalid_unit', 'future_source_time'].includes(flag))));
          const fallback = await supplementalCloudVoltage(definition, now, signal, missingPhase);
          if (epoch !== electricityEpoch) throw new ProviderError('provider-request-aborted');
          return [...rows, ...fallback];
        }
        const validate = payload => {
          const rows = electricalObservations(payload, id, prefix, fields, now, verified);
          if (stream?.snapshot(id, ids, { requiredIds }) && rows.some(row => row.value === null
            || row.sourceTime === null || row.sourceTime > now))
            throw new ProviderError('invalid-provider-observations');
        };
        const { payload, transport, usesStream } = await observationResult(id, ids, { signal, requiredIds, reconcile: streaming, validate });
        if (epoch !== electricityEpoch) throw new ProviderError('provider-request-aborted');
        const rows = electricalObservations(payload, id, prefix, fields, now, verified);
        if (prefix === 'ev1') cloudVoltage.set(id, { payload, nextReadAt: now + Math.max(60_000, fallbackIntervalMs) });
        transports.set(id, transport);
        if (usesStream) streamedElectricity.add(id);
        else streamedElectricity.delete(id);
        return rows.map(row => ({ ...row, raw: { ...row.raw, transport: 'cloud' } }));
      }));
      const observations = results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : electricalDevices[index].fields.map(([id, name, unit]) => ({
        ...baseObservation({ source: 'easee', device: electricalDevices[index].id, signal: `${electricalDevices[index].prefix}_${name}`, unit, now,
          quality: failureFlags(result.reason) }),
        raw: { observationId: id, acquisitionOnly: true, auditOnly: name.endsWith('_counter'), transport: 'cloud',
          error: providerFailureCode(result.reason), retryAfterMs: result.reason?.retryAfterMs },
      })));
      // A voltage-only native sample may coexist with cloud electrical evidence.
      // Keep it out of energy integration and live-current readiness.
      const voltage = local.voltageSnapshot?.();
      if (voltage && !observations.some(row => row.raw?.transport === 'ocpp'))
        observations.push(...electricalObservations(voltage, easee.charger_id, 'ev1', ELECTRICITY_FIELDS.ev1.filter(([, , unit]) => unit === 'V'), now, true)
          .map(row => ({ ...row, quality: [...row.quality, 'local_ocpp'], raw: { ...row.raw, transport: 'ocpp', voltageOnly: true } })));
      return annotateElectricalCurrents(observations);
    },

    async easee({ now = Date.now(), signal } = {}) {
      validNow(now);
      const jobs = CURRENT_DEVICES.filter(([key]) => supplied(easee[key]));
      const results = await Promise.allSettled(jobs.map(async ([key, ids, prefix]) =>
        currentObservations(await readObservations(easee[key], ids, { signal }), easee[key], ids, prefix, now)));
      const rows = results.flatMap((result, index) => result.status === 'fulfilled' ? result.value : jobs[index][1].map((id, phase) => ({ ...baseObservation({
        source: 'easee', device: easee[jobs[index][0]], signal: `${jobs[index][2]}_l${phase + 1}`, unit: 'A', now,
        quality: ['current_snapshot_not_energy', ...failureFlags(result.reason)], retryAfterMs: result.reason?.retryAfterMs,
      }), raw: { error: providerFailureCode(result.reason), retryAfterMs: result.reason?.retryAfterMs, transport: 'cloud' } })));
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
