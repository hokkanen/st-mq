const recordKeys = ['testId', 'confirmedAt', 'observedAt', 'receivedAt', 'physicalAt',
  'minimumPhysicalAt', 'teslaAssociation', 'bmwAssociation', 'connections'];
const chargerIds = ['charger1', 'charger2'];
const connectionKeys = ['association', 'sessionId', 'connectedAt', 'identificationId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const time = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const optionalId = value => value === null || id(value);

/** A confirmed comparison is historical identity evidence, never current draw
 * or control permission. Its original clocks and both connection scopes survive
 * a normal Stop, current restoration and restart without renewing the test. */
export function validateJointTeslaComparison(record) {
  // A genuinely absent optional current record grants no comparison evidence.
  if (record === undefined || record === null) return;
  if (!exactKeys(record, recordKeys) || !id(record.testId)
    || !id(record.teslaAssociation) || !id(record.bmwAssociation)
    || !exactKeys(record.connections, chargerIds)
    || !time(record.confirmedAt) || !time(record.observedAt)
    || record.observedAt - record.confirmedAt < 5000
    || ['receivedAt', 'physicalAt', 'minimumPhysicalAt'].some(key => !time(record[key])
      || record[key] < record.confirmedAt || record[key] > record.observedAt)
    || chargerIds.some(chargerId => {
      const connection = record.connections[chargerId];
      return !exactKeys(connection, connectionKeys) || !id(connection.association)
        || !optionalId(connection.sessionId) || !optionalId(connection.identificationId)
        || !time(connection.connectedAt) || connection.connectedAt > record.observedAt;
    })) throw new Error('Unsupported saved joint Tesla comparison; start a fresh development database');
}

/** Live connections contain the four saved scope fields plus `connected`.
 * Undefined fields and unknown connection observations are incomplete startup
 * evidence. Explicit null session/identification IDs mean known absence; they
 * are not a wildcard for a previously recorded ID. Known changes invalidate the
 * proof even if another observation remains unknown. Departure fencing belongs
 * to the caller, which owns those source events. */
export function jointTeslaComparisonScope(record, {
  connections, teslaAssociation, bmwAssociation, now,
} = {}) {
  if (record === undefined || record === null) return 'invalid';
  try { validateJointTeslaComparison(record); } catch { return 'invalid'; }
  if (!time(now) || record.observedAt > now) return 'invalid';
  let unknown = false;
  for (const [key, value] of Object.entries({ teslaAssociation, bmwAssociation })) {
    if (value === undefined || value === null) unknown = true;
    else if (!id(value) || value !== record[key]) return 'invalid';
  }
  if (connections === undefined || connections === null) return 'unknown';
  if (!object(connections) || Object.keys(connections).some(key => !chargerIds.includes(key))) return 'invalid';
  for (const chargerId of chargerIds) {
    const live = connections[chargerId], saved = record.connections[chargerId];
    if (live === undefined || live === null) { unknown = true; continue; }
    if (!object(live)) return 'invalid';
    if (live.connected === false) return 'invalid';
    if (live.connected === undefined || live.connected === null) unknown = true;
    else if (live.connected !== true) return 'invalid';
    for (const key of connectionKeys) {
      const value = live[key];
      if (value === undefined || value === null && ['association', 'connectedAt'].includes(key)) {
        unknown = true; continue;
      }
      const valid = key === 'connectedAt' ? time(value) && value <= now
        : key === 'association' ? id(value) : optionalId(value);
      if (!valid || value !== saved[key]) return 'invalid';
    }
  }
  return unknown ? 'unknown' : 'valid';
}
