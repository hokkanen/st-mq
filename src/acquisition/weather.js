import { instantMs } from '../domain/prices.js';

export const WEATHER_SOURCE = 'https://openweathermap.org/forecast5';
const THREE_HOURS = 10_800_000;

/** OWM's JSON forecast has valid times but no documented provider-issued timestamp. */
export function decodeOpenWeather(body, { fetchedAt, units } = {}) {
  fetchedAt = instantMs(fetchedAt);
  if (units !== 'metric') throw new Error('OpenWeather forecast requires explicit metric units');
  if (String(body?.cod) !== '200' || !Array.isArray(body.list) || !body.list.length || body.list.length > 40) throw new Error('Invalid OpenWeather forecast response');
  const unique = new Map();
  for (const item of body.list) {
    if (!Number.isSafeInteger(item.dt) || !Number.isFinite(item.main?.temp) || item.main.temp < -90 || item.main.temp > 65) throw new Error('Invalid OpenWeather forecast point');
    const start = instantMs(item.dt * 1000);
    if (start % THREE_HOURS !== 0 || start < fetchedAt - THREE_HOURS || start > fetchedAt + 5 * 86_400_000) throw new Error('OpenWeather forecast timestamp outside expected current horizon');
    if (unique.has(start) && unique.get(start).outdoorC !== item.main.temp) throw new Error('Conflicting OpenWeather forecast duplicate');
    unique.set(start, { start, end: start + THREE_HOURS, outdoorC: item.main.temp,
      source: 'openweathermap', unit: 'degC', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
      quality: ['provider-issuance-unknown'], provenance: WEATHER_SOURCE });
  }
  return { source: 'openweathermap', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt,
    forecast: [...unique.values()].sort((a, b) => a.start - b.start), observations: [], provenance: WEATHER_SOURCE };
}

export async function fetchWeather({ connections, now, http, signal } = {}) {
  const latitude = Number(connections?.geoloc?.latitude), longitude = Number(connections?.geoloc?.longitude);
  if (connections?.geoloc?.latitude == null || connections?.geoloc?.longitude == null ||
    String(connections.geoloc.latitude).trim() === '' || String(connections.geoloc.longitude).trim() === '' ||
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Valid weather coordinates are required');
  if (!connections?.openweathermap?.token) throw new Error('OpenWeather token is required');
  const url = new URL('https://api.openweathermap.org/data/2.5/forecast');
  url.search = new URLSearchParams({ lat: String(latitude), lon: String(longitude), appid: connections.openweathermap.token, units: 'metric' });
  try { return decodeOpenWeather(await http.json(url.toString(), { method: 'GET', signal }), { fetchedAt: now, units: 'metric' }); }
  catch { throw new Error('Weather forecast acquisition failed'); }
}
