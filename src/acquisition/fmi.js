import { weatherAcquisitionIdentity } from './weather-identity.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { instantMs } from '../domain/prices.js';

export const FMI_SOURCES = Object.freeze({
  forecast: 'https://en.ilmatieteenlaitos.fi/open-data-manual-forecast-models',
  observations: 'https://en.ilmatieteenlaitos.fi/open-data-manual-wfs-examples-and-guidelines',
  temperature: 'https://opendata.fmi.fi/meta?observableProperty=forecast&param=temperature&language=eng',
  radiation: 'https://opendata.fmi.fi/meta?observableProperty=forecast&param=radiationglobal&language=eng',
  observedTemperature: 'https://opendata.fmi.fi/meta?observableProperty=observation&param=t2m&language=eng',
  inspectedAt: '2026-09-07',
});
const HOUR = 3_600_000, MINUTE = 60_000;
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => typeof value === 'object' && value !== null ? value['#text'] : value;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true,
  parseTagValue: false, parseAttributeValue: false, processEntities: false });

export function weatherCoordinates(connections) {
  const raw = [connections?.geoloc?.latitude, connections?.geoloc?.longitude];
  const [latitude, longitude] = raw.map(Number);
  if (raw.some(value => !['number', 'string'].includes(typeof value) || String(value).trim() === '')
    || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Valid weather coordinates are required');
  return { latitude, longitude };
}

export function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const value = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2
    + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
}

function collection(xml, maximumMembers) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)
    || XMLValidator.validate(xml) !== true) throw new Error('Invalid FMI XML');
  const parsed = parser.parse(xml);
  if (parsed.ExceptionReport) throw new Error('FMI returned an exception');
  const members = array(parsed.FeatureCollection?.member);
  if (!members.length || members.length > maximumMembers) throw new Error('Invalid FMI feature collection');
  const references = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value['@_id'] === 'string') {
      if (references.has(value['@_id'])) throw new Error('Duplicate FMI XML identifier');
      references.set(value['@_id'], value);
    }
    for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
  };
  visit(parsed);
  const result = members.map(member => {
    if (!member?.PointTimeSeriesObservation) throw new Error('Expected FMI temperature time series');
    return member.PointTimeSeriesObservation;
  });
  Object.defineProperty(result, 'references', { value: references });
  return result;
}

// FMI shares publication instants between parameter series using local xlink references.
// Resolve only identifiers in this already bounded document; never fetch a reference URL.
function typed(node, type, references) {
  if (node?.[type]) return node[type];
  const href = node?.['@_href'];
  if (typeof href !== 'string' || !href.startsWith('#') || !references.has(href.slice(1)))
    throw new Error('Missing or unresolved FMI metadata');
  const target = references.get(href.slice(1));
  return target[type] ?? target;
}

function property(observation, kind, parameter) {
  let url;
  try { url = new URL(observation.observedProperty?.['@_href']?.replaceAll('&amp;', '&')); }
  catch { throw new Error('Missing FMI parameter identity'); }
  if (url.hostname !== 'opendata.fmi.fi' || url.pathname !== '/meta'
    || url.searchParams.get('observableProperty') !== kind
    || (parameter != null && url.searchParams.get('param')?.toLowerCase() !== parameter.toLowerCase()))
    throw new Error('Unexpected FMI parameter');
  return url.searchParams.get('param')?.toLowerCase();
}

function position(observation, references = new Map()) {
  const feature = typed(observation.featureOfInterest, 'SF_SpatialSamplingFeature', references);
  const points = array(feature?.shape?.Point ?? feature?.shape?.MultiPoint?.pointMembers?.Point);
  const locations = array(feature?.sampledFeature?.LocationCollection?.member);
  if (points.length !== 1 || locations.length !== 1) throw new Error('Expected one FMI location per series');
  const point = points[0], location = locations[0]?.Location;
  if (!/\/EPSG\/0\/(4326|4258)$/.test(point?.['@_srsName'] ?? '')) throw new Error('Unsupported FMI coordinate reference');
  const coordinates = String(point.pos).trim().split(/\s+/);
  if (coordinates.length !== 2) throw new Error('Invalid FMI station coordinates');
  const coords = weatherCoordinates({ geoloc: { latitude: coordinates[0], longitude: coordinates[1] } });
  return { ...coords, id: text(location?.identifier), codeSpace: location?.identifier?.['@_codeSpace'],
    name: text(array(location?.name).find(name => name?.['@_codeSpace']?.endsWith('/name'))) ?? text(point.name) ?? null };
}

function readings(observation, maximumPoints, from, to, { minimum = -60, maximum = 50, label = 'temperature' } = {}) {
  const points = array(observation.result?.MeasurementTimeseries?.point);
  if (!points.length || points.length > maximumPoints) throw new Error('Invalid FMI temperature point count');
  const unique = new Map();
  for (const point of points) {
    const at = instantMs(point.MeasurementTVP?.time), raw = text(point.MeasurementTVP?.value);
    if (at < from || at > to) throw new Error('FMI temperature timestamp outside expected horizon');
    // FMI uses NaN for missing observations or unavailable forecast slots. Keep a gap.
    let value = null;
    if (raw !== 'NaN' && raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error('Invalid FMI temperature value');
      value = Number(raw);
      if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Implausible FMI ${label}`);
    }
    if (unique.has(at) && unique.get(at) !== value) throw new Error('Conflicting FMI temperature duplicate');
    unique.set(at, value);
  }
  return [...unique].sort((a, b) => a[0] - b[0]);
}

/** FMI resultTime is publication time; analysisTime is the distinct nominal model run. */
export function decodeFmiForecast(xml, { fetchedAt, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  const observations = collection(xml, 2), series = new Map();
  for (const observation of observations) {
    const parameter = property(observation, 'forecast');
    if (!['temperature', 'radiationglobal'].includes(parameter) || series.has(parameter)) throw new Error('Unexpected or duplicate FMI parameter');
    if (!observation.procedure?.['@_href']?.endsWith('/harmonie_scandinavia_surface')) throw new Error('Unexpected FMI forecast model');
    const issuedAt = instantMs(typed(observation.resultTime, 'TimeInstant', observations.references).timePosition);
    const analysis = array(observation.parameter).map(parameter => parameter.NamedValue)
      .find(value => value?.name?.['@_href']?.endsWith('/analysisTime'));
    const analysisAt = instantMs(typed(analysis?.value, 'TimeInstant', observations.references).timePosition);
    if (issuedAt > fetchedAt + MINUTE || fetchedAt - issuedAt > 6 * HOUR || analysisAt > issuedAt || issuedAt - analysisAt > 12 * HOUR)
      throw new Error('Stale or inconsistent FMI forecast publication');
    const location = position(observation, observations.references);
    if (coordinates && distanceKm(coordinates, location) > 10) throw new Error('FMI forecast location mismatch');
    const period = typed(observation.phenomenonTime, 'TimePeriod', observations.references);
    const from = instantMs(period?.beginPosition), to = instantMs(period?.endPosition);
    if (from > to || from < fetchedAt - HOUR || to > fetchedAt + 72 * HOUR) throw new Error('Invalid FMI forecast horizon');
    const values = readings(observation, 73, from, to, parameter === 'radiationglobal'
      ? { minimum: 0, maximum: 2000, label: 'global radiation' } : {});
    if (values.some(([start]) => start % HOUR !== 0)) throw new Error('Expected hourly FMI forecast points');
    series.set(parameter, { issuedAt, analysisAt, location, from, to, values });
  }
  const temperature = series.get('temperature'), radiation = series.get('radiationglobal');
  if (!temperature) throw new Error('No FMI forecast temperature series');
  const { issuedAt, analysisAt, location, to, values } = temperature;
  if (radiation && (radiation.issuedAt !== issuedAt || radiation.analysisAt !== analysisAt
    || distanceKm(radiation.location, location) > 0.1)) throw new Error('Inconsistent FMI parameter metadata');
  const solarValues = new Map(radiation?.values ?? []);
  const forecast = [];
  for (const [start, outdoorC] of values) {
    if (start % HOUR !== 0) throw new Error('Expected hourly FMI forecast points');
    // The hourly point is held for one hour, bounded by the last valid-time endpoint.
    // We neither stretch across missing hours nor extrapolate beyond the published horizon.
    const end = Math.min(start + HOUR, to);
    if (outdoorC === null || end <= start || end <= fetchedAt) continue;
    const solarRadiationWm2 = radiation && start >= radiation.from && end <= radiation.to
      ? solarValues.get(start) ?? null : null;
    forecast.push({ start, end, outdoorC, solarRadiationWm2,
      solar: { parameter: 'RadiationGlobal', unit: 'W/m²', basis: 'forecast',
        quality: solarRadiationWm2 === null ? ['missing-solar-forecast'] : [],
        intervalBasis: 'hourly-point-held-within-published-horizon', provenance: FMI_SOURCES.radiation },
      source: 'fmi', unit: 'degC', issuedAt, analysisAt,
      issuedAtBasis: 'provider-result-time', fetchedAt, quality: [],
      intervalBasis: 'hourly-point-held-within-published-horizon', provenance: FMI_SOURCES.forecast });
  }
  if (!forecast.length) throw new Error('No usable FMI forecast temperatures');
  return { version: 2, source: 'fmi', issuedAt, issuedAtBasis: 'provider-result-time', analysisAt, fetchedAt,
    solarStatus: forecast.every(row => row.solarRadiationWm2 !== null) ? 'available'
      : forecast.some(row => row.solarRadiationWm2 !== null) ? 'partial' : 'unavailable',
    model: 'HARMONIE (MEPS)', forecast, observations: [], provenance: FMI_SOURCES.forecast };
}

/** Pick the nearest station with a fresh thermometer reading, never a forecast point. */
export function decodeFmiObservation(xml, { fetchedAt, coordinates } = {}) {
  fetchedAt = instantMs(fetchedAt);
  coordinates = weatherCoordinates({ geoloc: coordinates });
  const candidates = [];
  // A bounded bbox may contain several stations; maxlocations applies to named
  // location searches, not reliably to bbox queries. Response size is capped too.
  for (const observation of collection(xml, 64)) {
    property(observation, 'observation', 't2m');
    if (!observation.procedure?.['@_href']?.endsWith('/opendata')) throw new Error('Unexpected FMI observation process');
    const station = position(observation), distance = distanceKm(coordinates, station);
    if (station.codeSpace !== 'http://xml.fmi.fi/namespace/stationcode/fmisid' || !/^\d+$/.test(station.id ?? ''))
      throw new Error('Missing FMI observation station identifier');
    const values = readings(observation, 13, fetchedAt - 2 * HOUR, fetchedAt + MINUTE);
    const latest = values.filter(([at, value]) => value !== null && at <= fetchedAt && fetchedAt - at <= 30 * MINUTE).at(-1);
    if (!latest || distance > 50) continue;
    candidates.push({ distance, observation: { source: 'fmi', device: `fmisid:${station.id}`,
      signal: 'outdoor_temperature', value: latest[1], unit: 'degC', sourceTime: latest[0], receivedAt: fetchedAt,
      quality: [], raw: { provenance: FMI_SOURCES.observations, parameter: 't2m', reportedUnit: 'degC',
        spatialBasis: 'nearby-weather-station', timestampBasis: 'observation-time', stationId: station.id,
        stationName: typeof station.name === 'string' ? station.name.slice(0, 160) : null,
        distanceKm: Math.round(distance * 10) / 10 } } });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.observation.sourceTime - a.observation.sourceTime);
  if (!candidates.length) throw new Error('No fresh FMI temperature within 50 km');
  return [candidates[0].observation];
}

function requestUrl(connections, now, forecast) {
  const coordinates = weatherCoordinates(connections), at = instantMs(now);
  const start = Math.floor(at / HOUR) * HOUR - (forecast ? 0 : HOUR);
  const end = forecast ? start + 48 * HOUR : Math.floor(at / (10 * MINUTE)) * 10 * MINUTE;
  // FMI observation stored queries do not support latlon. They silently return
  // an empty collection for that argument. Use the documented lon/lat bbox;
  // a little geometric margin surrounds the exact 50 km acceptance circle.
  const latitudeSpan = 55 / 110.574;
  const longitudeSpan = Math.min(180, 55 / (111.32 * Math.max(0.01, Math.cos(coordinates.latitude * Math.PI / 180))));
  const bbox = [Math.max(-180, coordinates.longitude - longitudeSpan), Math.max(-90, coordinates.latitude - latitudeSpan),
    Math.min(180, coordinates.longitude + longitudeSpan), Math.min(90, coordinates.latitude + latitudeSpan), 'EPSG:4326'].join(',');
  const url = new URL('https://opendata.fmi.fi/wfs');
  url.search = new URLSearchParams({ service: 'WFS', version: '2.0.0', request: 'GetFeature',
    storedquery_id: forecast ? 'fmi::forecast::harmonie::surface::point::timevaluepair' : 'fmi::observations::weather::timevaluepair',
    ...(forecast ? { latlon: `${coordinates.latitude},${coordinates.longitude}` } : { bbox }), parameters: forecast ? 'Temperature,RadiationGlobal' : 't2m',
    timestep: forecast ? '60' : '10', starttime: new Date(start).toISOString(), endtime: new Date(end).toISOString(),
  });
  return { url: url.toString(), coordinates };
}

export function weatherError(error, message) {
  const clean = new Error(message);
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) clean.status = error.status;
  if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) clean.retryAfterMs = error.retryAfterMs;
  return clean;
}

export async function fetchFmiForecast({ connections, now, http, signal, clock = Date.now } = {}) {
  const { url, coordinates } = requestUrl(connections, now, true);
  try {
    const body = await http.text(url, { method: 'GET', signal });
    const result = decodeFmiForecast(body, { fetchedAt: clock(), coordinates });
    const acquisitionIdentity = weatherAcquisitionIdentity(connections);
    return { ...result, requestStartedAt: now, acquisitionIdentity };
  }
  catch (error) { throw weatherError(error, 'FMI forecast acquisition failed'); }
}

export async function fetchFmiObservation({ connections, now, http, signal, clock = Date.now } = {}) {
  const { url, coordinates } = requestUrl(connections, now, false);
  try {
    const body = await http.text(url, { method: 'GET', signal });
    const result = decodeFmiObservation(body, { fetchedAt: clock(), coordinates });
    const acquisitionIdentity = weatherAcquisitionIdentity(connections);
    return result.map(row => ({ ...row, raw: { ...row.raw, requestStartedAt: now, acquisitionIdentity } }));
  }
  catch (error) { throw weatherError(error, 'FMI observation acquisition failed'); }
}
