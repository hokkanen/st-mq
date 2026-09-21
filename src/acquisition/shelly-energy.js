import moment from 'moment-timezone';
import { Recorder } from '../storage/recorder.js';
const HOUR = 3_600_000;
const KEY = 'shelly:caravan-energy:v2';
const hour = at => Math.floor(at / HOUR) * HOUR;
const day = at => moment.tz(at, 'Europe/Helsinki').format('YYYY-MM-DD');

/** Measured counter increments use the shared adaptive recorder. Daily display
 * totals update at acquisition cadence, independently of archive spacing. */
export function createCaravanEnergy({ store, recorder, device, maxGapMs, signal = 'caravan_energy',
  recordDevice = 'caravan', stateKey = KEY, source = 'shelly-mqtt' }) {
  // Other explicitly mapped meter types keep their existing archive contract.
  if (signal !== 'caravan_energy') return createHourlyMeterEnergy({ store, device, maxGapMs, signal, recordDevice, stateKey, source });
  recorder ??= new Recorder(store);
  let state = store.getState(stateKey);
  if (state?.version !== 2 || state.device !== device) state = null;
  state ??= { version: 2, device, previous: null, day: null, dailyKwh: 0, dailyCoveredMs: 0, reset: false, gap: false };
  const save = () => store.setState(stateKey, state);
  const transaction = update => {
    const before = structuredClone(state);
    try { return store.transaction(update); }
    catch (error) { state = before; throw error; }
  };
  function setDay(at) {
    if (state.day !== day(at)) {
      state.day = day(at); state.dailyKwh = 0; state.dailyCoveredMs = 0; state.reset = false;
    }
  }
  function gap(now, reason) {
    if (!state.previous || state.gap || now < state.previous.at) return;
    recorder.energyGap({ source, device: recordDevice, prefix: 'caravan', start: state.previous.at, end: now, quality: [reason] });
    state.gap = true;
  }
  return {
    receive(counterKwh, at) {
      if (!Number.isFinite(counterKwh) || counterKwh < 0 || !Number.isSafeInteger(at) || at < 0) return;
      if (state.previous && at <= state.previous.at) return;
      transaction(() => {
        const prior = state.previous, duration = prior ? at - prior.at : 0;
        const delta = prior ? counterKwh - prior.counterKwh : 0;
        if (prior && !state.gap && duration <= maxGapMs && delta >= 0 && delta <= 25 * duration / HOUR + 0.001) {
          recorder.recordEnergy({ source, device: recordDevice, prefix: 'caravan', start: prior.at, end: at,
            energies: [delta], powers: [delta * HOUR / duration], quality: [], receivedAt: at });
          // Split only the live daily total at local midnight; recorded energy
          // retains the full measured interval and its exact meter delta.
          for (let cursor = prior.at; cursor < at;) {
            const midnight = moment.tz(cursor, 'Europe/Helsinki').startOf('day').add(1, 'day').valueOf();
            const end = Math.min(at, midnight);
            setDay(cursor);
            state.dailyKwh += delta * (end - cursor) / duration;
            state.dailyCoveredMs += end - cursor;
            cursor = end;
          }
        } else if (prior) {
          gap(at, delta < 0 ? 'meter-counter-reset' : duration > maxGapMs ? 'meter-report-gap' : 'invalid-meter-delta');
        }
        setDay(at);
        if (prior && delta < 0) state.reset = true;
        state.previous = { counterKwh, at }; state.gap = false; save();
      });
    },
    unavailable(now, reason = 'meter-unavailable') {
      if (!state.previous || state.gap || now < state.previous.at) return;
      transaction(() => { gap(now, reason); save(); });
    },
    tick(now) {
      const expired = state.previous && !state.gap && now - state.previous.at >= maxGapMs;
      if (!expired && state.day === day(now)) return;
      transaction(() => { if (expired) gap(now, 'meter-report-gap'); setDay(now); save(); });
    },
    status(now) {
      const today = day(now), midnight = moment.tz(now, 'Europe/Helsinki').startOf('day').valueOf();
      return { dailyKwh: state.day === today ? state.dailyKwh : 0, day: today,
        partial: state.day !== today || state.gap || now - (state.previous?.at ?? -Infinity) >= maxGapMs
          || state.dailyCoveredMs < (state.previous?.at ?? now) - midnight - 1,
        coveredMs: state.day === today ? state.dailyCoveredMs : 0, counterReset: state.reset,
        observedAt: state.previous?.at ?? null, timeZone: 'Europe/Helsinki' };
    },
  };
}

/** Immutable completed UTC-hour totals, measured from consecutive meter counter
 * readings. A short boundary-straddling delta is allocated by elapsed time.
 * Unknown outages/resets stay partial: no power extrapolation or invented zero. */
function createHourlyMeterEnergy({ store, device, maxGapMs, signal = 'caravan_energy',
  recordDevice = 'caravan', stateKey = KEY, source = 'shelly-mqtt' }) {
  let state = store.getState(stateKey);
  if (state?.device !== device) state = null;
  state ??= { device, previous: null, pending: null, day: null, dailyKwh: 0, dailyCoveredMs: 0, reset: false };
  const save = () => store.setState(stateKey, state);
  const transaction = update => {
    // SQLite rollback must also rewind this bounded accumulator. Otherwise an
    // identical retry can be mistaken for a duplicate after a failed commit.
    const before = structuredClone(state);
    try { return store.transaction(update); }
    catch (error) { state = before; throw error; }
  };
  function finish(now) {
    const bucket = state.pending;
    if (!bucket || bucket.start + HOUR > now) return;
    const quality = bucket.coveredMs < HOUR - 1 ? ['partial-coverage'] : [];
    if (bucket.allocated) quality.push('time-allocated');
    store.observation({ source, device: recordDevice, signal, value: bucket.kwh,
      unit: 'kWh', sourceTime: bucket.start + HOUR, receivedAt: now, quality,
      raw: { intervalStart: bucket.start, intervalEnd: bucket.start + HOUR, coveredMs: bucket.coveredMs,
        basis: 'meter-counter-delta', timeBasis: 'completed-hour', learningRole: 'history-only' } });
    state.pending = null;
  }
  function setDay(at) {
    if (state.day !== day(at)) {
      state.day = day(at); state.dailyKwh = 0; state.dailyCoveredMs = 0; state.reset = false;
    }
  }
  return {
    receive(counterKwh, at) {
      if (!Number.isFinite(counterKwh) || counterKwh < 0 || !Number.isSafeInteger(at)) return;
      if (state.previous && at <= state.previous.at) return;
      transaction(() => {
        const prior = state.previous;
        if (prior && at - prior.at <= maxGapMs && counterKwh >= prior.counterKwh
          && counterKwh - prior.counterKwh <= 25 * (at - prior.at) / HOUR + 0.001) {
          for (let cursor = prior.at; cursor < at;) {
            const end = Math.min(at, hour(cursor) + HOUR), fraction = (end - cursor) / (at - prior.at);
            finish(cursor); setDay(cursor);
            state.pending ??= { start: hour(cursor), kwh: 0, coveredMs: 0, allocated: false };
            const energy = (counterKwh - prior.counterKwh) * fraction;
            state.pending.kwh += energy; state.pending.coveredMs += end - cursor;
            state.pending.allocated ||= hour(prior.at) !== hour(at - 1);
            state.dailyKwh += energy; state.dailyCoveredMs += end - cursor;
            cursor = end;
          }
        } else if (prior && counterKwh < prior.counterKwh) state.reset = true;
        finish(at); setDay(at);
        state.previous = { counterKwh, at }; save();
      });
    },
    tick(now) {
      if ((!state.pending || state.pending.start + HOUR > now - maxGapMs) && state.day === day(now)) return;
      transaction(() => { finish(now - maxGapMs); setDay(now); save(); });
    },
    status(now) {
      const today = day(now), midnight = moment.tz(now, 'Europe/Helsinki').startOf('day').valueOf();
      return { dailyKwh: state.day === today ? state.dailyKwh : 0, day: today,
        partial: state.day !== today || now - (state.previous?.at ?? -Infinity) > maxGapMs || state.dailyCoveredMs < (state.previous?.at ?? now) - midnight - 1,
        coveredMs: state.day === today ? state.dailyCoveredMs : 0, counterReset: state.reset,
        observedAt: state.previous?.at ?? null, timeZone: 'Europe/Helsinki' };
    },
  };
}
