const HOUR = 3_600_000;
const finite = Number.isFinite;

/** Duration support belongs to completed experiments, not sensor row counts.
 * Small worthwhile trials can collect the first evidence without granting a
 * long pause from an untested prior. The caller still enforces both budgets. */
export function garagePlanningEvidence(model, summary, { observation, now = observation?.at ?? model.at, activeEpisode = null } = {}) {
  const economicHours = summary.thermalReady ? summary.maxPauseHours ?? 0 : 0;
  const active = activeEpisode != null;
  const recovering = !active && (Boolean(model.validation?.active) || observation?.recovering === true);
  const lastFailure = (model.validation?.episodes ?? []).filter(row => row.complete === false || row.clean === true && row.thermalPassed === false).at(-1);
  const retryCooldown = !active && lastFailure && (!finite(now) || !finite(lastFailure.endedAt) || now - lastFailure.endedAt < 6 * HOUR);
  const charging = [1, 2].some(id => observation?.[`ev${id}Kw`] > .1 || observation?.[`ev${id}Active`] === true);
  const trialEligible = model.normalReference?.initialized === true && !recovering && !charging && !retryCooldown
    && (observation?.baselineAccepted === true || observation?.baselineVerified === true)
    && (active || observation?.available === true);
  const trialHours = Math.min(2, Math.max(1, economicHours > 0 ? economicHours * 1.25 : 1));
  return { thermalReady: summary.thermalReady === true, electricalReady: summary.electricalReady === true,
    economicHours, trialEligible, trialHours, maxPauseHours: recovering || retryCooldown ? 0 : Math.max(economicHours, trialEligible ? trialHours : 0),
    completedEpisodes: summary.validation?.completedEpisodes ?? 0,
    reason: retryCooldown ? 'learning-retry-cooldown' : recovering ? 'learning-episode-recovering'
      : economicHours > 0 ? 'validated-episode-duration' : trialEligible ? 'bounded-learning-trial' : 'insufficient-validated-thermal-evidence' };
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

/** Separate uncertainty in avoided maintenance power from extra recovery energy.
 * Maintenance error is priced over the OFF opportunity. Only optimistic recovery
 * error adds a penalty, at the recovery tariff; already conservative extra-energy
 * assumptions must not count as a second peak-price loss. */
export function garagePlanningEnergyUncertainty(model, summary, offHours) {
  const episodes = (model.validation?.episodes ?? []).filter(row => row.role === 'validation' && row.clean
    && row.metered && row.offHours > 0 && finite(row.predictedKwh) && finite(row.observedKwh));
  const rates = episodes.map(row => Math.max(0, row.observedKwh - row.predictedKwh) / row.offHours);
  const recoveryRateKw = rates.length ? Math.sqrt(rates.reduce((sum, value) => sum + value * value, 0) / rates.length) : 0;
  const measured = model.native?.active?.[0] === true;
  const nativeRmse = summary.heldOut?.native?.rmse;
  const rateKw = Math.max(measured ? .1 : .25, finite(nativeRmse) ? nativeRmse : .25);
  const hours = finite(offHours) ? Math.max(0, offHours) : 0;
  return { kwh: rateKw * hours, recoveryKwh: recoveryRateKw * hours,
    basis: rates.length ? 'normal-power-error-and-optimistic-recovery-error' : 'normal-power-error-and-fixed-recovery-allowance' };
}
