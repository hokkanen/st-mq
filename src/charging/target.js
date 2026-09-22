const WINDOW = 15 * 60_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const target = value => Number.isFinite(value) && value >= 0 && value <= 100;

function targetFact(reading) {
  if (!target(reading?.chargeLimitSoc)) return null;
  const metadata = reading.fields?.chargeLimitSoc ?? reading;
  return { value: reading.chargeLimitSoc,
    measuredAt: time(metadata.measuredAt) ? metadata.measuredAt : null,
    receivedAt: time(metadata.receivedAt) ? metadata.receivedAt : null,
    readingId: typeof metadata.readingId === 'string' && metadata.readingId.length ? metadata.readingId : null };
}

function newer(fact, previous) {
  if (!previous) return true;
  if (fact.readingId !== null && fact.readingId === previous.readingId) return false;
  if (time(previous.measuredAt)) return time(fact.measuredAt) && fact.measuredAt > previous.measuredAt;
  if (time(fact.measuredAt)) return true;
  return fact.value !== previous.value || fact.readingId !== previous.readingId
    || fact.receivedAt !== previous.receivedAt;
}

/** Observe accepted source readings without changing them. A single move to 100
 * can be intentional; only a live X -> 100 -> X cycle confirms the conflict.
 * Its transition clocks stay fixed when the same value is reported again. */
export function updateTargetState(previous, { connectedAt, reading, now = Date.now(), live = true,
  evidenceStart = connectedAt } = {}) {
  if (!time(connectedAt)) return null;
  const state = previous?.connectedAt === connectedAt ? previous
    : { connectedAt, history: [], conflict: false, lower: null, override: null, last: null };
  const fact = targetFact(reading);
  if (!fact || !newer(fact, state.last)) return state;
  const next = { ...state, last: fact, history: [...state.history],
    lower: fact.value < 100 ? fact : state.lower };
  const eligible = live && reading.fields?.chargeLimitSoc?.retained !== true
    && fact.readingId !== null && time(evidenceStart) && time(now)
    && time(fact.measuredAt) && time(fact.receivedAt)
    && fact.measuredAt >= evidenceStart && fact.receivedAt >= evidenceStart
    && fact.measuredAt <= now && fact.receivedAt <= now && now - fact.measuredAt <= WINDOW;
  if (!eligible) {
    // An unverified change cannot bridge otherwise valid observations. Keep the
    // watermark so repeating the same retained/cached fact live adds no evidence.
    next.history = [];
    return next;
  }
  if (next.history.at(-1)?.value !== fact.value) next.history = [...next.history, fact].slice(-3);
  const [first, middle, last] = next.history;
  if (next.history.length === 3 && first.value < 100 && middle.value === 100
    && last.value === first.value && last.measuredAt - first.measuredAt <= WINDOW) next.conflict = true;
  return next;
}

/** An explicit planning choice applies only to this connection. It does not
 * write the vehicle's own target or clear the observed source conflict. */
export function selectTargetMode(state, mode, now = Date.now()) {
  if (!time(state?.connectedAt)) throw new TypeError('A connected vehicle is required');
  if (!['automatic', 'full'].includes(mode)) throw new TypeError('Invalid target mode');
  if (!time(now)) throw new TypeError('Invalid selection time');
  return { ...state, override: mode === 'full' ? { value: 100, selectedAt: now } : null };
}

/** Keep the raw report and selected planning value separately visible, including
 * their original field clocks. A held lower value never borrows a newer clock. */
export function targetSelection(state, { reading } = {}) {
  const raw = targetFact(reading);
  if (!raw) return null;
  const full = state?.override?.value === 100;
  const lower = target(state?.lower?.value) && state.lower.value < 100 ? state.lower : null;
  const conflict = state?.conflict === true;
  const selected = full ? { value: 100, source: 'session-target', measuredAt: null, receivedAt: state.override.selectedAt }
    : conflict && lower ? { ...lower, source: 'bmw-target-filter' } : { ...raw, source: 'bmw-cardata' };
  return { connectedAt: state?.connectedAt ?? null, mode: full ? 'full' : 'automatic', conflict, raw, selected, lower };
}
