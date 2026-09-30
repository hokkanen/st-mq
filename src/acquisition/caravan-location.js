// A session-local electrical response test. The caller owns command authority,
// source freshness, physical identity and durable restoration of native power.
export const CARAVAN_PROBE_PHASE_TIMEOUT_MS = 180_000;
export const CARAVAN_PROBE_SAMPLE_SPAN_MS = 5_000;
export const CARAVAN_PROBE_MIN_CHANGE_W = 3;
export const CARAVAN_PROBE_MAX_SAMPLES = 6;

const finite = value => typeof value === 'number' && Number.isFinite(value);
const median = values => {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const outcome = (state, command = null) => ({ command, status: state.status, phase: state.phase,
  reason: state.reason, evidence: state.evidence, requestedAt: command ? state.commandAt : null });

export function createCaravanProbe({ now, initialPower }) {
  if (!Number.isSafeInteger(now) || now < 0 || !['off', 'on'].includes(initialPower))
    throw new Error('Caravan power check requires a valid time and observed native power.');
  return { status: 'testing', phase: 'baseline', reason: 'checking-baseline', startedAt: now,
    phaseStartedAt: now, deadlineAt: now + CARAVAN_PROBE_PHASE_TIMEOUT_MS,
    initialPower, pendingCommand: initialPower === 'on' ? 'off' : null,
    commandAt: null, lastCommandAt: null, lastMeterAt: null, confirmedPowerAt: null, samples: [],
    phaseEvidence: { baseline: { commandAt: null, firstPowerObservedAt: null, lastPowerObservedAt: null } },
    baseline: null, powered: null, evidence: null };
}

export function abortCaravanProbe(state, reason = 'power-check-interrupted', now = state.startedAt) {
  if (state.status !== 'testing') return outcome(state);
  state.status = 'failed'; state.reason = reason; state.pendingCommand = null;
  state.evidence = { startedAt: state.startedAt, completedAt: now, failedPhase: state.phase,
    phases: structuredClone(state.phaseEvidence),
    ...(state.baseline ? { baselineW: state.baseline.watts, baselineSamples: state.baseline.samples } : {}),
    ...(state.powered ? { onW: state.powered.watts, onSamples: state.powered.samples } : {}) };
  return outcome(state);
}

function commandIntent(state, now) {
  // Native bridge replay fencing requires strictly advancing request clocks.
  if (!state.pendingCommand || state.lastCommandAt !== null && now <= state.lastCommandAt) return null;
  const command = state.pendingCommand;
  state.pendingCommand = null; state.commandAt = now; state.lastCommandAt = now;
  state.phaseEvidence[state.phase].commandAt = now;
  state.phaseStartedAt = now; state.deadlineAt = now + CARAVAN_PROBE_PHASE_TIMEOUT_MS;
  return command;
}

function nextPhase(state, phase, now) {
  state.phase = phase; state.reason = phase === 'on' ? 'checking-power-rise' : 'checking-power-fall';
  state.pendingCommand = phase; state.commandAt = null; state.samples = [];
  state.confirmedPowerAt = null;
  state.phaseEvidence[phase] = { commandAt: null, firstPowerObservedAt: null, lastPowerObservedAt: null };
  state.phaseStartedAt = now; state.deadlineAt = now + CARAVAN_PROBE_PHASE_TIMEOUT_MS;
  return outcome(state, commandIntent(state, now));
}

function stableWindow(samples) {
  let selected = null;
  // Prefer the longest recent plateau. Earlier startup or cooling readings fall
  // out of this bounded window, allowing a delayed fan response to settle.
  for (let count = 2; count <= samples.length; count++) {
    const window = samples.slice(-count);
    if (window.at(-1).at - window[0].at < CARAVAN_PROBE_SAMPLE_SPAN_MS) continue;
    const watts = median(window.map(sample => sample.watts));
    const noiseW = Math.max(...window.map(sample => sample.watts)) - Math.min(...window.map(sample => sample.watts));
    if (noiseW <= Math.max(2, Math.abs(watts) * 0.01)) selected = { watts, noiseW, samples: window.map(sample => ({ ...sample })) };
  }
  return selected;
}

/** Mutates only the serializable probe state and emits each command once.
 * The caller must supply actual, fresh received observations (never cached polls
 * with renewed clocks), dispatch after durable state commit, and abort on loss
 * of authority/connection/identity. Passing no measurement advances deadlines.
 */
export function advanceCaravanProbe(state, input) {
  const { now, power, powerObservedAt, meterPowerW, meterObservedAt } = input;
  if (state.status !== 'testing') return outcome(state);
  if (!Number.isSafeInteger(now) || now < state.phaseStartedAt) return outcome(state);
  if (now >= state.deadlineAt) return abortCaravanProbe(state,
    state.phase === 'baseline' ? 'baseline-unavailable' : state.phase === 'on' ? 'no-power-rise' : 'no-matching-power-fall', now);
  if (state.pendingCommand) return outcome(state, commandIntent(state, now));
  const expectedPower = state.phase === 'on' ? 'on' : 'off';
  if (['off', 'on'].includes(power) && power !== expectedPower && state.confirmedPowerAt !== null
    && finite(powerObservedAt) && powerObservedAt > state.confirmedPowerAt && powerObservedAt <= now)
    return abortCaravanProbe(state, 'power-changed-externally', now);
  if (power !== expectedPower || !finite(powerObservedAt) || powerObservedAt > now
    || powerObservedAt < 0 || state.commandAt !== null && powerObservedAt < state.commandAt) {
    state.samples = []; return outcome(state);
  }
  state.confirmedPowerAt = powerObservedAt;
  const phaseEvidence = state.phaseEvidence[state.phase];
  phaseEvidence.firstPowerObservedAt ??= powerObservedAt;
  phaseEvidence.lastPowerObservedAt = powerObservedAt;
  if (!finite(meterPowerW) || meterPowerW < 0 || !finite(meterObservedAt)
    || meterObservedAt > now || meterObservedAt < state.phaseStartedAt
    || state.commandAt !== null && (meterObservedAt <= state.commandAt || meterObservedAt < phaseEvidence.firstPowerObservedAt)
    || state.lastMeterAt !== null && meterObservedAt <= state.lastMeterAt) return outcome(state);
  state.lastMeterAt = meterObservedAt;
  state.samples.push({ at: meterObservedAt, watts: meterPowerW, powerObservedAt });
  if (state.samples.length > CARAVAN_PROBE_MAX_SAMPLES) state.samples.shift();
  const window = stableWindow(state.samples);
  if (!window) return outcome(state);
  if (state.phase === 'baseline') {
    state.baseline = window; return nextPhase(state, 'on', now);
  }
  const baseline = state.baseline;
  const thresholdW = Math.max(CARAVAN_PROBE_MIN_CHANGE_W, 2 * Math.max(baseline.noiseW, window.noiseW));
  if (state.phase === 'on') {
    if (window.watts - baseline.watts < thresholdW) return outcome(state);
    state.powered = window; return nextPhase(state, 'off', now);
  }
  const powered = state.powered, powerRiseW = powered.watts - baseline.watts, powerFallW = powered.watts - window.watts;
  const requiredChangeW = Math.max(thresholdW, 2 * powered.noiseW);
  const returnToleranceW = Math.max(2, powerRiseW * 0.25,
    2 * Math.max(baseline.noiseW, powered.noiseW, window.noiseW));
  if (powerFallW < requiredChangeW || Math.abs(window.watts - baseline.watts) > returnToleranceW) return outcome(state);
  state.status = 'passed'; state.reason = 'power-response-confirmed';
  state.evidence = { startedAt: state.startedAt, completedAt: now,
    phases: structuredClone(state.phaseEvidence),
    baselineW: baseline.watts, onW: powered.watts, offW: window.watts, powerRiseW, powerFallW,
    minimumChangeW: requiredChangeW, returnToleranceW,
    baselineSamples: baseline.samples, onSamples: powered.samples, offSamples: window.samples };
  return outcome(state);
}
