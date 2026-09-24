import { createHash } from 'node:crypto';

// Identical numeric coordinates and current query definitions have one identity.
// The digest avoids putting household coordinates in status and observations.
export function weatherAcquisitionIdentity(connections = {}) {
  const { latitude, longitude } = connections.geoloc ?? {};
  if ([latitude, longitude].some(value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)))) return null;
  const lat = Number(latitude), lon = Number(longitude);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return createHash('sha256').update(JSON.stringify({ latitude: lat, longitude: lon,
    query: 'fmi-harmonie-t2m-radiation-station-50km+openmeteo-icon-seamless-v1' })).digest('hex');
}
