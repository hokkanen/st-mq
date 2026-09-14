const HOUR = 3_600_000;
const finite = Number.isFinite;

/** Duration support belongs to completed experiments, not sensor row counts.
 * Small worthwhile trials can collect the first evidence without granting a
 * long pause from an untested prior. The caller still enforces both budgets. */
export function garagePlanningEvidence(model, summary, { now, observation, stepMinutes = 15, activeEpisode = null } = {}) {
  const validation = summary.validation ?? {};
  const allEpisodes = model.validation?.episodes ?? [];
  const failureAt = Math.max(-Infinity, ...allEpisodes.filter(row => row.clean && row.thermalPassed === false)
    .map(row => row.endedAt).filter(finite));
  const episodes = allEpisodes.filter(row => row.complete && row.clean && row.thermalPassed !== false
    && (!finite(row.endedAt) || row.endedAt > failureAt));
  const durations = episodes.map(row => row.offHours).filter(value => finite(value) && value > 0).sort((a, b) => b - a);
  const repeatedHours = durations[1] ?? 0;
  const economicHours = summary.thermalReady && summary.electricalReady ? summary.maxPauseHours ?? 0 : 0;
  const stepHours = stepMinutes / 60;
  const trialCeilingHours = summary.electricalReady ? Math.min(8, Math.max(2, 1.5 * economicHours)) : 1;
  const trialHours = Math.min(trialCeilingHours,
    Math.max(.5, Math.ceil(repeatedHours * 1.5 / stepHours - 1e-9) * stepHours));
  const active = activeEpisode != null;
  const latest = allEpisodes.at(-1);
  const latestEnd = latest?.endedAt ?? latest?.endAt;
  const recovered = !model.validation?.active || active;
  const recent = finite(latestEnd) && now >= latestEnd && now - latestEnd < 6 * HOUR;
  const disturbance = observation?.doorFront === true || observation?.doorRear === true
    || [1, 2].some(id => observation?.[`ev${id}Kw`] > .1 || observation?.[`ev${id}Active`] === true);
  const doorBlocked = observation?.doorEvidenceRequired === true && observation.doorFront !== false;
  const trialEligible = model.normalReference?.initialized === true
    && model.rear.samples >= 24 && model.front.samples >= 12
    && observation?.baselineVerified === true && (active || observation?.available === true)
    && !doorBlocked && !disturbance && recovered && (!recent || active);
  const maxPauseHours = doorBlocked ? 0 : Math.max(economicHours, trialEligible ? trialHours : 0);
  return { thermalReady: summary.thermalReady === true, electricalReady: summary.electricalReady === true,
    economicHours, trialEligible, trialHours, maxPauseHours, trialCoolingLimitC: Math.min(3, 1 + .25 * economicHours),
    completedEpisodes: validation.completedEpisodes ?? episodes.length,
    reason: doorBlocked ? observation.doorFront === true ? 'garage-door-open' : 'garage-door-unavailable'
      : maxPauseHours > 0 ? economicHours >= maxPauseHours ? 'validated-episode-duration' : 'bounded-learning-trial'
      : !recovered ? 'learning-episode-recovering' : recent ? 'learning-trial-recovery-interval'
        : 'insufficient-validated-thermal-evidence' };
}

/** Whole-trajectory errors have units of degrees C at their observed horizon.
 * Do not reinterpret a one-minute error as a per-hour diffusion coefficient or
 * stop uncertainty growth merely because a forecast exceeds six hours. */
export function garagePlanningMargins(summary, horizonHours) {
  const validation = summary.validation ?? {};
  const horizon = Math.max(.25, validation.supportedOffHours ?? 0);
  const scale = Math.sqrt(Math.max(1, horizonHours / horizon));
  const extrapolation = Math.max(0, horizonHours / horizon - 1);
  const margin = (location, floor, priorRate) => {
    const rmse = validation[`${location}Rmse`], off = validation[`off${location[0].toUpperCase()}${location.slice(1)}Rmse`];
    const bias = Math.abs(validation[`${location}Bias`] ?? 0);
    if (!finite(rmse)) return Math.max(floor, priorRate * horizonHours);
    return Math.max(floor, 2 * rmse, finite(off) ? 2 * off : 0) * scale + bias * extrapolation;
  };
  return { rearC: margin('rear', .2, .2), frontC: margin('front', .3, .3) };
}

/** Energy prediction error scales in kWh, retaining systematic episode error.
 * A kW residual times hours has explicit units without assuming independent
 * hourly errors in a slow thermal recovery. */
export function garagePlanningEnergyUncertainty(model, summary, offHours) {
  const episodes = (model.validation?.episodes ?? []).filter(row => row.role === 'validation' && row.clean
    && row.metered && row.offHours > 0 && finite(row.predictedKwh) && finite(row.observedKwh));
  const rates = episodes.map(row => (row.predictedKwh - row.observedKwh) / row.offHours);
  const episodeRate = rates.length ? Math.sqrt(rates.reduce((sum, value) => sum + value * value, 0) / rates.length) : 0;
  const rateKw = Math.max(.03, summary.heldOut?.native?.rmse ?? .25, episodeRate);
  return { kwh: rateKw * offHours, basis: rates.length ? 'whole-episode-energy-error' : 'native-power-error-times-duration' };
}
