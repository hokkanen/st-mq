const MAX_OBSERVATION_AGE = 15 * 60_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const target = value => Number.isFinite(value) && value >= 0 && value <= 100;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const factKeys = ['value', 'measuredAt', 'receivedAt', 'readingId'];
const validFact = (value, selected = false) => exactKeys(value, [...factKeys, ...(selected ? ['source'] : []), ...(value?.admittedAt === undefined ? [] : ['admittedAt'])])
  && target(value.value) && ['measuredAt', 'receivedAt'].every(key => value[key] === null || time(value[key]))
  && (value.admittedAt === undefined && !(time(value.measuredAt) && time(value.receivedAt) && value.measuredAt > value.receivedAt)
    || validateAdmittedSourceTime({ sourceTime: value.measuredAt, receivedAt: value.receivedAt, admittedAt: value.admittedAt }))
  && (value.readingId === null || typeof value.readingId === 'string' && value.readingId.length > 0);

/** Only source evidence belongs here; explicit targets use the ordinary session request. */
export function validateTargetState(state) {
  if (state == null) return;
  if (!exactKeys(state, ['connectedAt', 'history', 'conflict', 'lower', 'last']) || !time(state.connectedAt)
    || !Array.isArray(state.history) || state.history.length > 2 || state.history.some(fact => !validFact(fact))
    || typeof state.conflict !== 'boolean' || state.conflict && state.lower === null
    || state.lower !== null && (!validFact(state.lower) || state.lower.value >= 100)
    || state.last !== null && !validFact(state.last))
    throw new Error('Unsupported saved charging target; start a fresh development database');
}

export function validateTargetSelection(selection) {
  if (selection == null) return;
  if (!exactKeys(selection, ['connectedAt', 'conflict', 'raw', 'selected', 'lower'])
    || selection.connectedAt !== null && !time(selection.connectedAt) || typeof selection.conflict !== 'boolean'
    || !validFact(selection.raw) || !validFact(selection.selected, true)
    || selection.lower !== null && (!validFact(selection.lower) || selection.lower.value >= 100)
    || selection.conflict && selection.lower === null)
    throw new Error('Unsupported saved charging target selection; start a fresh development database');
  const held = selection.conflict && selection.lower;
  if (selection.selected.source !== (held ? 'bmw-target-filter' : 'bmw-cardata')
    || factKeys.some(key => selection.selected[key] !== (held || selection.raw)[key]))
    throw new Error('Unsupported saved charging target selection; start a fresh development database');
}

function targetFact(reading) {
  if (!target(reading?.chargeLimitSoc)) return null;
  const metadata = reading.fields?.chargeLimitSoc ?? reading;
  return { value: reading.chargeLimitSoc,
    measuredAt: time(metadata.measuredAt) ? metadata.measuredAt : null,
    receivedAt: time(metadata.receivedAt) ? metadata.receivedAt : null,
    readingId: typeof metadata.readingId === 'string' && metadata.readingId.length ? metadata.readingId : null,
    ...(metadata.admittedAt === undefined ? {} : { admittedAt: metadata.admittedAt }) };
}

function newer(fact, previous) {
  if (!previous) return true;
  if (fact.readingId !== null && fact.readingId === previous.readingId) return false;
  if (time(previous.measuredAt)) return time(fact.measuredAt) && fact.measuredAt > previous.measuredAt;
  if (time(fact.measuredAt)) return true;
  return fact.value !== previous.value || fact.readingId !== previous.readingId
    || fact.receivedAt !== previous.receivedAt;
}

/** A live 100 -> X transition holds the latest target below 100 for this
 * connection. The transition can happen at any point in the session; each
 * observation must be fresh when received. Raw source readings stay intact. */
export function updateTargetState(previous, { connectedAt, reading, now = Date.now(), live = true,
  evidenceStart = connectedAt } = {}) {
  validateTargetState(previous);
  if (!time(connectedAt)) return null;
  const state = previous?.connectedAt === connectedAt ? previous
    : { connectedAt, history: [], conflict: false, lower: null, last: null };
  const fact = targetFact(reading);
  if (!fact || !newer(fact, state.last)) return state;
  // Admission waits before this update. A view or saved raw report that is
  // still in the future must not consume its ID or erase earlier evidence.
  if (fact.measuredAt > now || fact.receivedAt > now || fact.admittedAt > now) return state;
  if (time(fact.measuredAt) && time(fact.receivedAt)
    && !validateAdmittedSourceTime({ sourceTime: fact.measuredAt, receivedAt: fact.receivedAt, admittedAt: fact.admittedAt, now })) return state;
  const next = { ...state, last: fact, history: [...state.history] };
  const eligible = live && reading.fields?.chargeLimitSoc?.retained !== true
    && fact.readingId !== null && time(evidenceStart) && time(now)
    && time(fact.measuredAt) && time(fact.receivedAt)
    && fact.measuredAt >= evidenceStart && fact.receivedAt >= evidenceStart
    && validateAdmittedSourceTime({ sourceTime: fact.measuredAt, receivedAt: fact.receivedAt, admittedAt: fact.admittedAt, now })
    && now - Math.min(fact.measuredAt, fact.receivedAt) <= MAX_OBSERVATION_AGE;
  if (!eligible) {
    // An unverified change cannot bridge otherwise valid observations. Keep the
    // watermark so repeating the same retained/cached fact live adds no evidence.
    next.history = [];
    return next;
  }
  if (fact.value < 100) next.lower = fact;
  if (next.history.at(-1)?.value !== fact.value) next.history = [...next.history, fact].slice(-2);
  const [first, last] = next.history;
  if (first?.value === 100 && last?.value < 100) next.conflict = true;
  return next;
}

/** Keep the raw report and selected planning value separately visible, including
 * their original field clocks. A held lower value never borrows a newer clock. */
export function targetSelection(state, { reading, now = Date.now() } = {}) {
  validateTargetState(state);
  const raw = targetFact(reading);
  if (!raw) return null;
  if (raw.measuredAt > now || raw.receivedAt > now) return null;
  if (time(raw.measuredAt) && time(raw.receivedAt)
    && !validateAdmittedSourceTime({ sourceTime: raw.measuredAt, receivedAt: raw.receivedAt, admittedAt: raw.admittedAt, now })) return null;
  const lower = target(state?.lower?.value) && state.lower.value < 100 ? state.lower : null;
  if (lower && time(lower.measuredAt) && time(lower.receivedAt)
    && !validateAdmittedSourceTime({ sourceTime: lower.measuredAt, receivedAt: lower.receivedAt, admittedAt: lower.admittedAt, now })) return null;
  const conflict = state?.conflict === true;
  const selected = conflict && lower ? { ...lower, source: 'bmw-target-filter' } : { ...raw, source: 'bmw-cardata' };
  return { connectedAt: state?.connectedAt ?? null, conflict, raw, selected, lower };
}
import { validateAdmittedSourceTime } from '../domain/time-evidence.js';
