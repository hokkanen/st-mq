import { MAX_SOURCE_AHEAD_MS } from './time-evidence.js';

// Native DESD8LW Off includes a drying cycle. This is a restart restriction,
// independent of transport freshness, recording qualification and On authority.
export const CARAVAN_NATIVE_RESTART_DELAY_MS = 300_000;
const clock = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validClocks = value => value && typeof value === 'object' && !Array.isArray(value)
  && ['sourceAt', 'receivedAt', 'admittedAt'].every(key => clock(value[key]))
  && value.sourceAt <= value.admittedAt && value.receivedAt <= value.admittedAt
  && value.sourceAt - value.receivedAt <= MAX_SOURCE_AHEAD_MS;
export const caravanPowerTimingKey = (id, identity, signature) =>
  `equipment:caravan-power-timing:v1:${id}:${identity}:${signature}`;

export function validateCaravanPowerTiming(value, { identity, signature }) {
  if (value === null || value === undefined) return null; // Genuinely absent new current state.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'admittedAt,identity,offConfirmation,power,receivedAt,signature,sourceAt'
    || !digest(value.identity) || !digest(value.signature) || value.identity !== identity || value.signature !== signature
    || !['on', 'off'].includes(value.power) || !validClocks(value)
    || value.offConfirmation !== null && (value.power !== 'off' || !validClocks(value.offConfirmation)
      || Object.keys(value.offConfirmation).sort().join(',') !== 'admittedAt,receivedAt,sourceAt'
      || value.offConfirmation.sourceAt < value.sourceAt))
    throw new Error('Equipment saved Caravan native power timing is invalid; preserve the database and use a deliberate fresh development start.');
  return value;
}

export function caravanPowerRestartAt(value) {
  return value?.power === 'off' ? Math.max(value.sourceAt, value.receivedAt,
    value.offConfirmation?.sourceAt ?? 0, value.offConfirmation?.receivedAt ?? 0) + CARAVAN_NATIVE_RESTART_DELAY_MS : null;
}

export function observeCaravanPower(previous, observation) {
  validateCaravanPowerTiming(observation, observation);
  if (previous?.power === observation.power) return previous;
  // A delayed cached opposite value cannot replace the last actual transition.
  if (previous && observation.sourceAt <= Math.max(previous.sourceAt, previous.offConfirmation?.sourceAt ?? 0)) return previous;
  return observation;
}

export function validateSavedCaravanPowerTiming(db) {
  for (const row of db.prepare("SELECT key,value FROM state WHERE key GLOB 'equipment:caravan-power-timing:*'").iterate()) {
    try {
      const match = /^equipment:caravan-power-timing:v1:([^:]+):([a-f0-9]{64}):([a-f0-9]{64})$/.exec(row.key);
      const saved = JSON.parse(row.value);
      if (!match || saved === null) throw new Error('invalid timing key or absent saved row');
      validateCaravanPowerTiming(saved, { identity: match[2], signature: match[3] });
    } catch {
      throw Object.assign(new Error('Unsupported or unreadable Caravan native power timing. Preserve this database and use an intact current-version backup or a deliberate fresh development start. The existing database was not changed.'),
        { code: 'database_state_incompatible' });
    }
  }
}
