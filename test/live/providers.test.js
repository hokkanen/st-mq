import test from 'node:test';
import { readConfigurationOptions } from '../../src/app/configuration-source.js';
import { join } from 'node:path';
import * as market from '../../src/acquisition/market.js';
import * as weather from '../../src/acquisition/weather.js';
import { createDeviceProviders } from '../../src/acquisition/devices.js';
import { fileTokenStore } from '../../src/acquisition/token-store.js';
import { selectedServices, readLiveState, writeLiveState, createLiveHttp, SERVICE_HOSTS, livePaths } from './support.js';

const enabled = process.env.STMQ_LIVE_TEST === '1';
const supplied = value => typeof value === 'string' && value.trim().length > 0;
class LiveValidationError extends Error {}
function requireResult(condition, message) { if (!condition) throw new LiveValidationError(message); }

function readConnections() {
  try {
    const { options: connections } = readConfigurationOptions(process.env, process.cwd());
    return connections;
  } catch { throw new Error('Cannot load live connection settings; check STMQ_CONFIG or the documented secrets.json location'); }
}

function checkPrices(result, source, now, t) {
  requireResult(result?.source === source && Array.isArray(result.intervals) && result.intervals.length > 0,
    'Provider did not return its own price intervals');
  requireResult(result.intervals.every(row => Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) &&
    row.end > row.start && Number.isFinite(row.spotCtPerKwh) && row.unit === 'c/kWh' && row.vatIncluded === false), 'Provider returned invalid price intervals');
  requireResult(result.intervals.some(row => row.start <= now && row.end > now), 'Provider prices do not cover the present');
  t.diagnostic(`${result.intervals.length} price intervals; known through ${new Date(Math.max(...result.intervals.map(row => row.end))).toISOString()}`);
}

function checkForecast(result, source, now, t) {
  requireResult(result?.source === source && Array.isArray(result.forecast) && result.forecast.length > 0,
    'Provider did not return its own forecast');
  requireResult(result.forecast.every(row => Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) &&
    row.end > row.start && Number.isFinite(row.outdoorC) && row.outdoorC >= -90 && row.outdoorC <= 65),
  'Provider returned invalid forecast points');
  requireResult(result.forecast.some(row => Number.isFinite(row.solarRadiationWm2) && row.solarRadiationWm2 >= 0),
    'Provider returned no usable solar radiation forecast');
  const until = Math.max(...result.forecast.map(row => row.end));
  requireResult(until > now + 6 * 3_600_000, 'Provider forecast does not cover the next six hours');
  t.diagnostic(`${result.forecast.length} forecast intervals; known through ${new Date(until).toISOString()}`);
}

function checkObservations(rows, { expected, source, outdoor = false, now }, t) {
  requireResult(Array.isArray(rows) && rows.length === expected, 'Configured devices did not return the expected readings');
  const fatal = new Set(['provider_error', 'missing_configuration', 'missing', 'source_time_unknown',
    'invalid_numeric', 'invalid_unit', 'conflicting_duplicate', 'future_source_time',
    'implausible_temperature', 'implausible_current', 'negative_current', 'suspect_zero_indoor']);
  const flags = [...fatal, 'stale', 'asynchronous_snapshot', 'all_zero_property_current', 'ev_exceeds_property_current']
    .filter(flag => rows.some(row => Array.isArray(row.quality) && row.quality.includes(flag)));
  if (flags.length) t.diagnostic(`Reported quality flags: ${flags.join(', ')}`);
  if (source === 'easee' && flags.length) {
    for (const row of rows) if (/^(?:property|ev1)_current_l[123]$/.test(row.signal)) {
      const age = Number.isSafeInteger(row.sourceTime) ? `${Math.max(0, Math.floor((now - row.sourceTime) / 60_000))} minutes` : 'unknown';
      t.diagnostic(`${row.signal}: source age ${age}`);
    }
  }
  requireResult(rows.every(row => row.source === source && Number.isFinite(row.value) &&
    Number.isSafeInteger(row.sourceTime) && Array.isArray(row.quality) && !row.quality.some(flag => fatal.has(flag))),
  'At least one configured reading is unavailable or invalid');
  if (outdoor) requireResult(rows.every(row => row.signal === 'outdoor_temperature' && row.unit === 'degC' &&
    !row.quality.includes('stale')), 'Outdoor observation is missing or stale');
  const stale = rows.filter(row => row.quality.includes('stale')).length;
  const oldestMinutes = Math.max(0, Math.floor((now - Math.min(...rows.map(row => row.sourceTime))) / 60_000));
  t.diagnostic(`${rows.length} valid readings; ${stale} marked stale; oldest source timestamp ${oldestMinutes} minutes ago`);
  const beyondControlAge = rows.filter(row => row.unit === 'degC' && now - row.sourceTime > 30 * 60_000).length;
  if (beyondControlAge) t.diagnostic(`${beyondControlAge} temperature reading(s) exceed the controller's 30-minute age limit, regardless of provider quality flags.`);
  if (stale || beyondControlAge) t.diagnostic('API access works, but old device state is not fresh evidence for control.');
}

test('live configured providers (explicit opt-in)', { skip: !enabled, timeout: 240_000 }, async t => {
  const selected = selectedServices(process.env.STMQ_LIVE_SERVICES);
  const connections = readConnections();
  const { directory } = livePaths();
  const state = readLiveState(directory);
  const http = createLiveHttp({ state, saveState: next => writeLiveState(directory, next) });
  const devices = createDeviceProviders({ connections, http, tokenStore: fileTokenStore(join(directory, 'easee-tokens.json'), connections.easee ?? {}) });
  const currents = ['charger_id', 'equalizer_id'];
  const prices = new Map();
  const jobs = {
    entsoe: async child => {
      if (!supplied(connections.entsoe?.token)) return child.skip('No ENTSO-E token configured');
      const now = Date.now();
      const result = await market.fetchEntsoe({ connections, now, http });
      checkPrices(result, 'entsoe', now, child); prices.set('entsoe', result.intervals);
    },
    elering: async child => {
      const now = Date.now();
      const result = await market.fetchElering({ connections, now, http });
      checkPrices(result, 'elering', now, child); prices.set('elering', result.intervals);
    },
    'fmi-forecast': async child => {
      const now = Date.now();
      checkForecast(await weather.fetchFmiForecast({ connections, now, http }), 'fmi', now, child);
    },
    'fmi-observation': async child => {
      const now = Date.now();
      checkObservations(await weather.fetchFmiObservation({ connections, now, http }),
        { expected: 1, source: 'fmi', outdoor: true, now }, child);
    },
    'openmeteo-forecast': async child => {
      const now = Date.now();
      checkForecast(await weather.fetchOpenMeteoForecast({ connections, now, http }), 'openmeteo', now, child);
    },
    'openmeteo-current': async child => {
      const now = Date.now();
      checkObservations(await weather.fetchOpenMeteoCurrent({ connections, now, http }),
        { expected: 1, source: 'openmeteo', outdoor: true, now }, child);
    },
    easee: async child => {
      const expected = currents.filter(key => supplied(connections.easee?.[key])).length * 3;
      if (!expected) return child.skip('No Easee charger or equalizer configured');
      const now = Date.now();
      checkObservations(await devices.easee({ now }), { expected, source: 'easee', now }, child);
    },
  };
  try {
    for (const name of selected) await t.test(name, { timeout: 90_000 }, async child => {
      const before = http.summary().requests;
      try { await jobs[name](child); }
      catch (error) {
        const problem = http.summary().failures[SERVICE_HOSTS[name]];
        // Provider errors may contain URLs, device IDs or echoed keys: never print them.
        throw new Error(`${name} live check failed${problem ? ` (${problem})` : error instanceof LiveValidationError
          ? `: ${error.message}` : ': response or configuration did not pass validation'}`);
      } finally { child.diagnostic(`${http.summary().requests - before} HTTP request(s)`); }
    });
    if (prices.has('entsoe') && prices.has('elering')) await t.test('ENTSO-E and Elering overlapping prices agree', child => {
      const a = prices.get('entsoe'), b = prices.get('elering');
      let i = 0, j = 0, overlaps = 0, maximumDifference = 0;
      while (i < a.length && j < b.length) {
        if (Math.max(a[i].start, b[j].start) < Math.min(a[i].end, b[j].end)) {
          overlaps++; maximumDifference = Math.max(maximumDifference, Math.abs(a[i].spotCtPerKwh - b[j].spotCtPerKwh));
        }
        if (a[i].end <= b[j].end) i++; else j++;
      }
      requireResult(overlaps > 0, 'The two original price sources have no overlapping published intervals');
      requireResult(maximumDifference <= 1e-6, 'Original sources disagree on overlapping normalized ex-VAT prices');
      child.diagnostic(`${overlaps} overlapping intervals agree within 0.000001 c/kWh; no additional HTTP requests`);
    });
  } finally {
    http.close();
    t.diagnostic(`Total HTTP requests: ${http.summary().requests}. No MQTT or device commands were sent.`);
  }
});
