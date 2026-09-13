import moment from 'moment-timezone';
const HOUR = 3_600_000;
const KEY = 'shelly:caravan-energy:v1';
const hour = at => Math.floor(at / HOUR) * HOUR;
const day = at => moment.tz(at, 'Europe/Helsinki').format('YYYY-MM-DD');

/** Immutable completed UTC-hour totals, measured from consecutive meter counter
 * readings. A short boundary-straddling delta is allocated by elapsed time.
 * Unknown outages/resets stay partial: no power extrapolation or invented zero. */
export function createCaravanEnergy({ store, device, maxGapMs }) {
  let state = store.getState(KEY);
  if (state?.device !== device) state = null;
  state ??= { device, previous: null, pending: null, day: null, dailyKwh: 0, dailyCoveredMs: 0, reset: false };
  const save = () => store.setState(KEY, state);
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
    store.observation({ source: 'shelly-mqtt', device: 'caravan', signal: 'caravan_energy', value: bucket.kwh,
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
