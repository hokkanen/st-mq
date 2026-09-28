import { garageLearningCalculation } from './garage-learning-math.js';
import { confirmAction } from './confirmation.js';
import { isReadOnlyReplica } from './replica-status.js';
import { mitsubishiReadings, createMitsubishiReadingView, mitsubishiRoomTemperature, mitsubishiCompressor, mitsubishiValue, renderMitsubishiReadings } from './mitsubishi.js';
import { outdoorSourceLabel } from './provider-status.js';
import { equipmentReadingRows } from './equipment.js';
import { garageDoorDevices } from './garage-doors.js';
import { setStatusDetail } from './status-details.js';
import { renderCurrentPrice } from './current-price.js';
import { garageHeatingConfirmation, setHeatingStatusDetail } from './heating-status.js';
import { finnishDateTime, priceControlState } from './home-controls.js';
import { garageHeatingWarning } from './heating-warning.js';
import { GARAGE_HEAT_TRANSFER_SAFETY_FACTOR, garageSavingsPreference } from '../src/garage/settings.js';
import { renderLearningRows } from './learning-rows.js';
import { HEATING_STRATEGIES, heatingStrategy } from '../src/domain/heating-strategy.js';
const finite = Number.isFinite;
const text = value => typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ') : 'Unknown';
const number = (value, unit = '') => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
const benefit = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(value);
const native = value => value && typeof value === 'object' ? value.value : value;
const temperature = reading => finite(reading?.value) ? `${number(reading.value, '°C')}${reading.stale ? ' · stale' : ''}` : 'Unavailable';
const state = value => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
const clock = value => finite(value) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) : 'Unknown';
const temperatureHolding = (garage, now) => garage.temperatureHold?.active === true
  && finite(garage.temperatureHold.expiresAt) && garage.temperatureHold.expiresAt > now;
const sentences = values => values.map(value => text(value).trim().replace(/[.\s]+$/, '')).filter(Boolean).map(value => `${value}.`).join(' ');
const opportunity = reason => ({
  'automatic-control-disabled': 'Automatic control is disabled',
  'protection-limited-learning-opportunity': 'Initial cooling estimates use extra uncertainty margins; pipe protection limits the pause',
  'continue-authorized-economic-episode': 'Continue the current pause within its original endpoint',
  'waiting-for-temperature-evidence': 'Waiting for fresh temperature evidence; hold only the existing pause within its original permission and protection margin',
  'garage-door-open-or-unknown-below-2c': 'An open or unknown door below 2°C outdoors prevents a new pause',
  'outdoor-temperature-unavailable': 'Waiting for a fresh outdoor temperature',
  'benefit-below-minimum-saving': 'Expected savings do not cover recovery, uncertainty and the minimum benefit',
  'flat-prices-preserve-normal-warmth': 'No useful price difference: keep normal heating',
  'daily-pause-limit': 'The configured daily pause limit has been reached',
  'price-control-paused': 'Price control is paused; normal heating remains available',
  'manual-heating-off': 'Heating is temporarily OFF by manual request',
  'normal-heating-recovery': 'Waiting for both locations and pipe reserves to recover',
  'minimum-normal-heating-time': 'Waiting for the minimum period of normal heating',
  'no-native-heating-demand': 'No current heating demand supports a savings pause',
  'insufficient-normal-heating-evidence': 'Waiting for a settled normal-heating reference and accepted pump state',
  'learning-episode-recovering': 'Waiting for the current learning episode to recover',
  'learning-trial-recovery-interval': 'Waiting between learning trials',
  'benefit-below-warmth-or-prediction-resolution': 'Expected timing benefit does not cover warmth and prediction uncertainty',
  'credible-price-timing-opportunity': 'Price savings and the forecast pipe reserve support this pause',
  'prepare-for-later-price-opportunity': 'Normal heating continues until a later price opportunity',
})[reason] ?? text(reason ?? 'Normal heating').replace(/^./, value => value.toUpperCase());
const opportunitySummary = reason => ({
  'automatic-control-disabled': 'Automatic control disabled',
  'insufficient-normal-heating-evidence': 'Awaiting normal-heating evidence',
  'learning-episode-recovering': 'Awaiting recovery',
  'learning-trial-recovery-interval': 'Between learning trials',
  'benefit-below-warmth-or-prediction-resolution': 'Insufficient timing benefit',
  'credible-price-timing-opportunity': 'Price-supported pause',
  'prepare-for-later-price-opportunity': 'Later price opportunity',
  'waiting-for-temperature-evidence': 'Pause held · awaiting temperature',
})[reason] ?? opportunity(reason);
const coefficientNumber = (value, unit) => finite(value)
  ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(value)} ${unit}` : 'Unavailable';
const learningRow = (key, title, value, group, provenance, detail, evidence) =>
  ({ key, title, value, group, provenance, detail, calculation: garageLearningCalculation(key), ...(evidence ? { evidence } : {}), available: value !== 'Unavailable' });

function garageCoefficientRows(learning) {
  const assumptions = learning.assumptions ?? {}, electricity = learning.electricity ?? {};
  const details = ['rear', 'front'].map(location => {
    const row = learning.coefficients?.[location]?.find(value => value.name === 'coolingPerHour');
    const title = `${location === 'rear' ? 'Rear' : 'Front'} cooling rate`;
    const fitted = row?.basis === 'fitted-effective-response';
    const result = learningRow(`${location}-cooling-rate`, title, coefficientNumber(row?.value, '1/h'), 'Cooling responses',
      !finite(row?.value) ? 'Unavailable' : fitted ? 'Learned' : 'Initial estimate',
      'Cooling per degree of local air-to-outdoor temperature difference while the pump is OFF. Each location has its own rate. Forecasts use the displayed value, including an initial estimate before enough clean observations allow fitting.',
      `${number(row?.evidence, 'h')} clean cooling observations. Door openings and charging exclude an interval from fitting. A fitted rate still needs episode validation.`);
    return result;
  });
  details.push(
    learningRow('normal-pump-power', 'Normal pump electricity', number(electricity.normalPowerKw ?? assumptions.normalPowerKw, 'kW'),
      'Electricity estimate', electricity.basis === 'observed-normal-power' ? 'Recorded average' : 'Assumed',
      'Average electrical input used to price heating avoided during a pause and the extra recovery allowance. A fixed estimate is used until two qualified hours establish an observed normal-heating average. Compressor frequency is not converted to watts.',
      electricity.basis === 'observed-normal-power' ? `${number(electricity.hours, 'h')} qualified normal-heating electricity.` : 'Estimated savings remain assumption-based until dedicated pump electricity is qualified.'),
    learningRow('charger-heat-fraction', 'Charging heat fraction', finite(assumptions.evHeatFraction) ? number(assumptions.evHeatFraction * 100, '%') : 'Unavailable',
      'Fixed assumptions', 'Assumed', '7.5% of recorded charging electricity is reported as estimated garage heat. It is not added to temperature forecasts. Charging observations instead identify disturbed intervals to exclude from cooling-rate learning.'),
    learningRow('recovery-time', 'Recovery temperature time scale', number(assumptions.recoveryTimeHours, 'h'), 'Fixed assumptions', 'Assumed',
      'Time scale used only for the illustrative temperature forecast after normal heating resumes. The electricity allowance uses a longer period for long pauses. Actual recovery at both locations and their pipe reserves determines readiness for another pause.'),
    learningRow('recovery-energy-factor', 'Recovery electricity allowance', number(assumptions.recoveryEnergyFactor, '×'), 'Fixed assumptions', 'Assumed',
      'Adds recovery electricity equal to 1.25 times the estimated electricity avoided while OFF, on top of normal heating after the pause. Its pricing period is at least three hours and at least 1.25 times the OFF duration, also respecting the minimum normal-heating time. This fixed allowance is priced before a pause can count as worthwhile.'));
  return { details, rows: details.map(row => [row.title, `${row.value} · ${row.provenance}. ${row.detail}${row.evidence ? ` ${row.evidence}` : ''}`]) };
}

function garageLearningRows(garage, now) {
  const learning = garage.learning ?? {}, validation = learning.validation;
  const reference = learning.normalReference;
  const thermal = learning.thermalReady, electrical = learning.electricalReady;
  const duration = finite(learning.validatedOffHours) && learning.validatedOffHours > 0 ? number(learning.validatedOffHours, 'h')
    : finite(learning.validatedOffHours) ? 'Not yet established' : 'Unavailable';
  const outcomes = [
    learningRow('temperature-prediction', 'Cooling prediction', thermal === true ? 'Validated' : thermal === false ? 'Awaiting validation' : 'Unavailable',
      'Cooling forecasts', 'Validation', 'Complete cooling and recovery episodes test the two local cooling forecasts. Initial and fitted estimates can support protection-limited planning before validation; this status does not itself permit a pause.'),
    learningRow('thermal-pause-duration', 'Validated OFF evidence', duration, 'Cooling forecasts', 'Episode checks',
      'OFF duration covered by retained clean cooling and recovery checks. Longer forecasts receive larger uncertainty margins; this evidence does not impose a maximum pause.'),
    learningRow('electricity-prediction', 'Savings estimate basis', electrical === true ? 'Qualified electricity' : learning.electricity ?
      learning.electricity.basis === 'observed-normal-power' ? 'Recorded average + recovery allowance' : 'Assumed electricity + recovery allowance' : 'Unavailable',
      'Savings estimate', electrical === true ? 'Recorded & estimated' : 'Estimated',
      'Forecast savings price the avoided normal-heating electricity and the recovery allowance. Assumed pump input is shown explicitly; forecast savings are not measured savings.'),
  ];
  for (const location of ['rear', 'front']) if (reference) outcomes.push(learningRow(`normal-${location}-warmth`,
    `Normal ${location} warmth`, number(reference[`${location}C`], '°C'), 'Normal-heating references',
    reference.initialized === true ? 'Learned' : finite(reference[`${location}C`]) ? 'From room setting' : 'Room setting unavailable',
    reference.initialized === true
      ? 'Air temperature learned from settled normal heating. It anchors the recovery forecast and helps the planner judge heating demand and recovery; it is separate from the pump thermostat setting.'
      : finite(reference.roomTargetC)
        ? `Starting estimate from the ${number(reference.roomTargetC, '°C')} room setting. Both locations start here until enough settled normal-heating observations establish their own achieved temperatures. Changing the room setting restarts this reference learning; an initial estimate does not qualify a new automatic pause.`
        : 'Choose a room setting in Heat-pump settings, or wait for a fresh pump setting. Without a known setting there is no initial normal-warmth estimate. Settled observations must establish both references before a new automatic pause is eligible.',
    `${number(reference.qualifiedHours, 'h')} qualified normal-heating observations.`));
  const reconstruction = ({ current: 'Up to date', snapshot: 'Recorded master snapshot', rebuilding: 'Rebuilding from recorded history', failed: 'Reconstruction unavailable' })[learning.reconstruction] ?? 'Unavailable';
  const evidenceDetails = [];
  if (validation) {
    evidenceDetails.push(learningRow('complete-clean-episodes', 'Complete clean episodes', number(validation.completedEpisodes), 'Episode evidence', 'Recorded',
      'Complete OFF and recovery periods test the cooling forecast over their observed duration. Disturbed periods do not qualify clean validation.',
      `${number(validation.trainingEpisodes)} training · ${number(validation.validationEpisodes)} validation episodes.`));
    for (const location of ['rear', 'front']) {
      const cap = location === 'rear' ? 'Rear' : 'Front';
      evidenceDetails.push(learningRow(`${location}-cooling-error`, `${cap} cooling forecast error`, number(validation[`off${cap}Rmse`], '°C'),
        'Forecast errors', 'Validation', 'Root mean square error during clean OFF periods, using the model frozen before the pause. Missing evidence stays unavailable.'));
    }
    if (validation.active) evidenceDetails.push(learningRow('active-episode', 'Episode being assessed',
      validation.active.phase === 'off' ? 'Cooling' : 'Recovery', 'Current episode', 'In progress', 'This episode is assigned to training or validation. A validation episode can extend forecast support only after cooling and recovery finish and the required checks pass.'));
  }
  evidenceDetails.push(learningRow('recorded-history-reconstruction', 'Recorded history reconstruction', reconstruction, 'Model record', 'Recorded history',
    'The current model is rebuilt from its recorded inputs and selected corrections. A master snapshot is historical evidence, not live pause eligibility.'));
  const version = learning.algorithm?.match(/^committed-garage-v(\d+)-/);
  if (version) evidenceDetails.push(learningRow('model-version', 'Model version', `Garage ${version[1]}`, 'Model record', 'Algorithm',
    'Version of the garage algorithm used for learning and replay.'));
  const observations = garage.observations ?? {};
  const pumpState = mitsubishiReadings(garage, now).find(row => row.key === 'native-power');
  const inputDetails = ['rear', 'front'].map(location => learningRow(`${location}-air-temperature`, `${location === 'rear' ? 'Rear' : 'Front'} air temperature`,
    temperature(observations[location]), 'Temperatures', 'Recorded',
    'External air reading beside the local pipe. Both locations need fresh readings for every automatic pause; pump indoor temperature is separate diagnostic context.'));
  inputDetails.push(
    learningRow('outdoor-temperature', 'Outdoor temperature', temperature(observations.outdoor), 'Temperatures',
      observations.outdoor?.source === 'openmeteo' ? 'Modeled' : ['husdata-h66', 'fmi', 'mqtt-temperature', 'shelly-mqtt'].includes(observations.outdoor?.source) ? 'Recorded' : 'Source varies',
      `${outdoorSourceLabel(observations.outdoor?.source) ?? 'Source unavailable'}. Learning uses the recorded outdoor input; planning uses the forecast available when deciding.`),
    learningRow('heating-availability', 'Heat-pump power setting', pumpState?.value ?? 'Unavailable', 'Heating inputs', 'Recorded',
      'Fresh native OFF identifies cooling intervals. Native ON makes normal heating available; it does not prove useful heat at the pipes. Compressor activity is diagnostic context, not thermal kW.'),
    learningRow('heat-pump-input', 'Pump electricity observations', number(learning.electricity?.hours, 'h qualified'),
      'Heating inputs', 'Recorded history',
      'Qualified normal-heating electricity observations build the average shown in Model coefficients; this is accumulated evidence, not current pump power. An unscaled native counter or compressor frequency supplies no measured watts, heat output or COP.'),
    ...[1, 2].map(id => {
      const charging = observations.charging?.[`ev${id}`];
      return learningRow(`charger-${id}-input`, `Charger ${id} electricity`,
        charging?.known === true ? number(charging.powerKw, 'kW') : charging?.required === false ? 'Not required' : 'Unavailable', 'Heating inputs', 'Recorded',
        `Charger ${id} power and activity identify charging-disturbed intervals, which are excluded from clean cooling learning. Multiplying recorded electricity by 0.075 also gives an illustrative heat estimate; this estimate adds no warmth to temperature forecasts or protection.`,
        charging?.known === true ? `${number(charging.heatKw, 'kW')} estimated heat contribution.`
          : charging?.required === false ? 'This charger is not required for clean learning evidence.'
            : typeof charging?.active === 'boolean' ? `${charging.active ? 'Charging' : 'Not charging'} is reported, but electrical power is unavailable. Unknown power is not treated as zero heat.`
              : 'No qualified current electrical input. Unknown is not treated as zero heat.');
    }),
    learningRow('doors-and-local-cooling', 'Garage doors', 'Opening events + local temperatures', 'Operating context', 'Recorded',
      'Door events identify disturbed cooling intervals to exclude from learning; door size and temperatures alone cannot establish air exchange. This row describes how the input is used; current door readings are in the Garage summary and equipment. Door changes also trigger a separate protection reassessment.'));
  return { outcomeRows: outcomes.map(row => [row.title, `${row.value}. ${row.detail}`]), inputRows: inputDetails.map(row => [row.title, row.detail]),
    outcomeDetails: outcomes, evidenceDetails, inputDetails,
    outcomeContext: 'These results show what observations have established: cooling forecast accuracy, the OFF duration tested, normal warmth and the basis of savings estimates. Complete cooling and recovery checks provide evidence for planning; they do not grant control permission.',
    inputContext: 'These are the source readings and observation history used for learning. Temperatures describe the response; pump, door and charger reports identify eligible intervals. Estimated outdoor values and charging heat are labeled separately. Missing readings remain unknown.',
    coefficientContext: 'These are the numbers used in forecasts and estimates. The rear and front cooling rates are fitted independently; a qualified electrical average can replace assumed pump power. Charging heat and recovery factors stay fixed. A learned value can be used before the complete forecast passes validation.' };
}

function garagePolicyRows(garage, policy) {
  const settings = garage.settings ?? {};
  const preference = garageSavingsPreference(settings);
  const configuredStrategy = settings.savingsStrategy == null ? null : heatingStrategy(settings.savingsStrategy);
  const plan = garage.plan ?? {};
  const planReason = plan.reason ?? plan.reasons?.[0] ?? garage.reason;
  const planningDetails = [
    learningRow('current-opportunity', 'Current decision', planReason ? opportunitySummary(planReason) : 'Unavailable', 'Decision', 'Current plan', planReason ? opportunity(planReason) : 'Waiting for a current planning assessment.'),
    learningRow('pause-window', 'Planned OFF window', finite(plan.pauseFrom) && finite(plan.plannedPauseUntil ?? plan.pauseUntil) ? `${clock(plan.pauseFrom)} – ${clock(plan.plannedPauseUntil ?? plan.pauseUntil)}` : garage.plan ? 'None' : 'Unavailable',
      'Decision', 'Current plan', 'One worthwhile price period is selected. Heating stays at its existing setting beforehand and returns to normal afterward; no preheating is requested.'),
    learningRow('door-policy', 'Door opening', 'Reassess local pipe reserve', 'Pause limits', 'Fixed policy',
      'Open and unknown configured doors both block a new pause only below 2°C outdoors. At 2°C or above, either state passes this rule. Outdoor temperature must be known. During a pause, door changes recheck protection using the local readings.'),
    learningRow('minimum-savings', 'Minimum estimated benefit', configuredStrategy && finite(settings.minSavingsEur) ? `€${benefit(preference.minimumBenefitEur)}` : 'Unavailable',
      'Pause limits', 'Savings preference', 'A pause must exceed this benefit after recovery electricity and prediction uncertainty allowances. Gentle requires 1.5 times the configured baseline benefit, Balanced uses that baseline and More savings requires half.'),
    learningRow('pause-duration-limits', 'Pause endpoint', 'Forecast and protection limited',
      'Pause limits', 'Configured', 'There is no fixed maximum pause. Temperatures, forecast pipe reserve, uncertainty, available price and weather data, and remaining savings determine the endpoint. Protection can always end a pause before the planned minimum.'),
    learningRow('daily-pause-limit', 'Maximum pauses per day', number(settings.maxPausesPerDay), 'Pause limits', 'Configured',
      'This cap limits additional pump starts independently of the savings preference.',
      finite(garage.planningLimits?.pausesToday) ? `${number(garage.planningLimits.pausesToday)} starts recorded today, including unconfirmed attempts.` : undefined),
    learningRow('minimum-normal-heating', 'Normal heating between pauses', number(finite(settings.minOnMs) ? settings.minOnMs / 3_600_000 : null, 'h minimum'),
      'Pause limits', 'Configured', 'Fresh normal-heating evidence is required for at least this long, including after startup or a reading gap. After a pause, both local temperatures and pipe reserves must also recover.',
      finite(garage.planningLimits?.normalHeatingReadyAt) ? `Current continuous normal-heating interval reaches its minimum at ${clock(garage.planningLimits.normalHeatingReadyAt)}. All other checks still apply.` : 'Waiting for a fresh continuous normal-heating interval.'),
    learningRow('charging-policy', 'Charging', 'No pause restriction or forecast credit', 'Pause limits', 'Fixed policy',
      'Charging status and power do not affect pause admission or the planned window. Any actual warmth is reflected in measured garage temperatures; expected charging heat adds no forecast credit. Charging-disturbed data remains separate from clean cooling and savings evidence.'),
    learningRow('protection-policy', 'Freezing protection', policy.approved === true ? 'Owner-approved' : policy.approved === false ? 'Not approved' : 'Approval unknown',
      'Safeguards', 'Configured', 'The rear and front reference pipes must retain their configured margin through the remaining permission and useful-heating delay. While waiting for fresh temperature evidence, existing permission may remain within its original deadline; invalid or expired evidence requires normal heating. Held readings cannot start or renew a pause.'),
    learningRow('restore-policy', 'Return to normal heat', 'Short local lease + recovery check', 'Safeguards', 'Device + observed temperatures',
      'The adapter restores native ON when its short renewable OFF permission expires, no later than two minutes after the older supporting temperature report. Reconnection does not extend it. Fresh renewals can maintain one continuous pause of any thermally permitted duration; this safeguard does not cap its total length. ON readback and useful warmth are separate checks. A failed adapter or serial path can prevent restoration.'),
  ];
  return planningDetails;
}

export function garageColdBudget(garage = {}, location) {
  const name = location === 'rear' ? 'Rear' : 'Front';
  const policy = garage.settings?.protection, protection = garage.protection;
  const local = protection?.locations?.[location];
  const title = `${name} cold allowance remaining`;
  const unavailable = (summary, detail) => ({ label: `${name} —`, value: '—', title, summary, detail, remaining: null, available: false, attention: false });
  if (policy?.approved !== true)
    return unavailable(policy?.approved === false ? 'Policy not approved' : 'Approval unknown', 'The garage freezing-protection policy has not been approved.');
  if (protection?.approved !== true)
    return unavailable('Assessment unavailable', 'No approved garage freezing-protection assessment is available.');
  if (!local || !finite(local.remainingKjPerM) || local.remainingKjPerM < 0 || !finite(local.estimatedC))
    return unavailable('Assessment unavailable', 'A valid thermal reserve estimate is not available for this location.');
  if (local.fresh !== true)
    return unavailable('Awaiting fresh temperature', 'A fresh, qualified temperature report is required to show this location’s allowance.');
  if (local.reason === 'initializing-reserve')
    return unavailable('Establishing reserve', 'Fresh local temperature reports are establishing the reference’s warmth. Allowance becomes available as it recovers.');
  if (local.uncertain)
    return unavailable('Temperature history uncertain', 'Missing temperature history makes this location’s reserve uncertain. Fresh local readings must establish its recovery before an allowance is shown.');
  const remaining = local.remainingKjPerM, exhausted = remaining === 0;
  // A small positive reserve must not be displayed as exhausted.
  const value = remaining > 0 && remaining < .01 ? '<0.01 kJ/m' : number(remaining, 'kJ/m');
  const limit = local.reason ?? (protection.limitingLocation === location
    && protection.reasons?.includes('restoration-margin-exhausted') ? 'restoration-margin-exhausted' : null);
  const reason = limit != null ? ` Current protection limit: ${text(limit)}.` : '';
  return { label: `${name} ${value}`, value, title, remaining, estimatedC: local.estimatedC, available: true,
    summary: exhausted ? 'Allowance exhausted' : limit != null ? 'Heating reserve required' : `Reference estimate ${number(local.estimatedC, '°C')}`,
    attention: exhausted || limit != null,
    detail: `${value} of estimated warmth above the ${number(policy.marginC, '°C')} protection margin, per metre of the water-filled copper reference. Reference temperature: ${number(local.estimatedC, '°C')}.${reason} Heating resumes while enough reserve remains to restore useful heat. The allowance changes continuously with local temperature history; it is not a measured pipe temperature or a countdown.` };
}

/** Public monitoring projection only. Never serialize raw adapter state, topics,
 * device identifiers, command payloads or private configuration into the DOM. */
export function garageDisplay(garage = {}, now = Date.now()) {
  const settings = garage.settings ?? {}, protection = garage.protection ?? {}, locations = protection.locations ?? {};
  const adapter = garage.adapter ?? {}, health = adapter.health ?? {};
  const plan = garage.plan ?? {}, learning = garage.learning ?? {};
  const episode = garage.episode ?? {};
  const room = mitsubishiRoomTemperature(garage);
  const temperatureHeld = temperatureHolding(garage, now);
  const rows = [];
  if (temperatureHeld) rows.push(['Temperature evidence', `Existing pause held until ${clock(garage.temperatureHold.expiresAt)} · no renewal`]);
  for (const location of ['rear', 'front']) {
    const label = location === 'rear' ? 'Rear air · near pipe' : 'Front air · near door';
    const local = locations[location] ?? {}, observation = garage.observations?.[location];
    rows.push([label, temperature(observation)]);
    rows.push([`${location === 'rear' ? 'Rear' : 'Front'} allowance remaining`, finite(local.remainingKjPerM)
      ? `${number(local.remainingKjPerM, 'kJ/m')}${local.uncertain ? ' · uncertain history' : ''}` : 'Unavailable']);
    rows.push([`${location === 'rear' ? 'Rear' : 'Front'} reference estimate`, finite(local.estimatedC)
      ? `${number(local.estimatedC, '°C')}${local.uncertain ? ' · uncertain history' : ''}` : 'Unavailable']);
    if (finite(local.interventionAt)) rows.push([`${location === 'rear' ? 'Rear' : 'Front'} intervention by`, clock(local.interventionAt)]);
  }
  rows.push(['Limiting protection location', text(protection.limitingLocation)],
    ['Normal heating setting basis', room ? `${room.value} · ${room.basis}` : adapter.baselineVerified === true ? 'Verified native baseline' : 'Native baseline not verified'],
    ['Device online', state(health.deviceOnline)], ['Driver progressing', state(health.driverProgressing)],
    ['Pump communicating', state(health.pumpCommunicating)],
    ['Local lease remaining', finite(adapter.episode?.leaseExpiresAt) ? number(Math.max(0, adapter.episode.leaseExpiresAt - now) / 60_000, 'min') : 'No accepted lease'],
    ['Recovery', episode.restorationPending || adapter.restorePending ? 'Restoration pending · awaiting evidence' : text(episode.phase ?? adapter.phase ?? 'No managed episode')],
    ['Adapter contract', `${adapter.contractVersion ?? 'Unavailable'} · ${text(adapter.contractStatus)}`],
    ['Native baseline accepted for control', state(adapter.baselineAccepted ?? adapter.baselineVerified)],
    ['Native baseline independently verified', state(adapter.baselineVerified)],
    ['Last heating request', adapter.lastCommand ? `${text(({ start: 'pause', renew: 'pause renewal', release: 'restore heating' })[adapter.lastCommand.action])} · ${text(adapter.lastCommand.status)}` : 'No request'],
    ['Native command confirmation', finite(adapter.lastCommand?.nativeConfirmedAt) ? clock(adapter.lastCommand.nativeConfirmedAt) : 'Not confirmed'],
    ['Heat response after restore', finite(adapter.lastCommand?.usefulHeatAt) ? clock(adapter.lastCommand.usefulHeatAt) : adapter.lastCommand?.action === 'release' ? 'Awaiting useful heat evidence' : 'No restore assessment'],
    ['Control capability', adapter.liveControlSupported ? 'Installed contract' : 'Monitoring · real contract unavailable'],
    ['Plan', text(plan.reason ?? garage.reason)], ['Planned pause endpoint', finite(plan.plannedPauseUntil ?? plan.pauseUntil) ? clock(plan.plannedPauseUntil ?? plan.pauseUntil) : 'No pause planned']);
  const policy = settings.protection ?? {};
  const preference = garageSavingsPreference(settings);
  const configuredStrategy = settings.savingsStrategy == null ? null : heatingStrategy(settings.savingsStrategy);
  const settingGroups = {
    economics: [
      ['Minimum estimated benefit', configuredStrategy && finite(settings.minSavingsEur) ? `More than €${benefit(preference.minimumBenefitEur)}` : 'Unavailable', 'A new pause must clear this threshold after estimated recovery electricity and prediction uncertainty. Gentle uses 1.5 times the configured baseline, Balanced uses the baseline, and More savings uses half.'],
      ['Benefit retained', configuredStrategy ? `${number(preference.retainedBenefitFraction * 100)}% of best opportunity` : 'Unavailable', 'Choose the shortest qualifying safe window retaining at least this share of the greatest estimated benefit. Equal lengths favour greater benefit, then an earlier start.'],
    ],
    heating: [
      ['Minimum planned off time', number(finite(settings.minOffMs) ? settings.minOffMs / 3_600_000 : null, 'h'), 'A selected pause must be planned for at least this long. Protection can restore heating sooner; there is no fixed maximum duration.'],
      ['Normal heating between pauses', number(finite(settings.minOnMs) ? settings.minOnMs / 3_600_000 : null, 'h minimum'), 'Fresh normal-heating evidence is required for at least this long. Both locations and their pipe reserves must also recover. The strategy does not relax these checks.'],
      ['Maximum pauses per day', number(settings.maxPausesPerDay), 'This cap limits additional pump starts independently of the strategy. Pause starts count even if device confirmation is missing; the count uses the Finnish calendar day.'],
    ],
    protection: [
      ['Normal room setting', room ? `${room.value} · ${room.basis}` : number(learning.normalReference?.roomTargetC, '°C'), 'Room setting used by the heat model, from your selection or an unambiguous pump report. It supplies the initial normal-warmth estimate; settled observations later establish each location’s achieved temperature. A new selection applies here while the pump command is pending; the last known setting remains during a reporting gap. Change it in Mitsubishi Heat-pump settings. Below 16 °C uses Garage rear with a native 17 °C target.'],
      ['Protection margin', number(policy.marginC, '°C'), 'The reference pipe must stay above this temperature, including the delay until useful heat returns. This is an estimated pipe-temperature boundary, not the pump thermostat or an air-temperature switch.'],
    ],
    recovery: [
      ['Reference pipe diameter', number(policy.pipeOutsideDiameterMm, 'mm'), 'Outside diameter of the bare, water-filled copper pipe used as the protection reference.'],
      ['Assumed wall thickness', number(policy.pipeWallMm, 'mm'), 'The copper wall thickness used to calculate the reference’s capacity to store warmth.'],
      ['Heat transfer', number(policy.heatTransferWPerM2K, 'W/m²K'), 'Fixed assumption for how readily the reference exchanges heat with the surrounding air. This value is not learned from the cooling forecast.'],
      ['Safety factor', `${GARAGE_HEAT_TRANSFER_SAFETY_FACTOR}×`, 'Counts cooling twice as quickly and warming half as quickly. Changing the savings strategy never changes this factor.'],
      ['Cold allowance', 'Calculated · kJ/m', 'The reference’s stored warmth above the protection margin determines each location’s allowance. A warmer starting point provides more reserve.'],
      ['Recovery', 'Continuous', 'Local air restores warmth gradually at each location. A warmer air reading alone does not refill its reserve; missing temperature history must first be resolved by fresh evidence.'],
    ],
  };
  const coefficients = garageCoefficientRows(learning);
  const learningRows = garageLearningRows(garage, now);
  return { status: text(garage.status ?? (settings.enabled ? 'commissioning' : 'monitoring')),
    reason: temperatureHeld ? `Waiting for fresh temperature evidence. Existing OFF permission is held until ${clock(garage.temperatureHold.expiresAt)} within its original deadline and protection margin; no renewal is issued`
      : text(garage.reason ?? 'Automatic control awaits the implemented adapter contract and installed commissioning')
      .trim().replace(/^./, value => value.toUpperCase()),
    strategy: configuredStrategy, planningDetails: garagePolicyRows(garage, policy),
    rows, settingGroups, coefficients: coefficients.rows, coefficientDetails: coefficients.details, ...learningRows, limitations: learning.limitations ?? [] };
}

/** Both summaries describe the same requested power, independently of confirmation. */
export function garageHeatingRequest(garage = {}) {
  const controls = garage.heatingControls ?? {}, adapter = garage.adapter ?? {}, action = garage.plan?.nextAction;
  return controls.requestedMode === 'off' ? 'Off'
    : controls.requestedMode === 'normal' ? 'Normal'
      : adapter.phase === 'paused' ? 'Reduction'
        : adapter.restorePending || garage.episode?.restorationPending || adapter.phase === 'restoring' ? 'Restoring'
          : ['pause', 'renew', 'hold'].includes(action) ? 'Reduction'
            : ['available', 'release'].includes(action) || garage.temporary?.pauseActive ? 'Normal' : 'No request';
}

export function garagePauseSummary(status = {}) {
  const garage = status.garage ?? {}, temporary = garage.temporary ?? {};
  if (isReadOnlyReplica(status)) return 'Recorded pause';
  if (temporary.pauseActive && temporary.pauseUntil > status.now) return `Paused until ${clock(temporary.pauseUntil)}`;
  if (garage.settings?.enabled === false) return 'Garage integration unavailable';
  if (status.input === 'offline') return 'Unavailable offline';
  if (garage.settings?.enabled !== true || !status.automation?.garage) return 'Status unavailable';
  if (!status.automation.garage.enabled) return 'Plan only';
  return 'Not paused';
}

const heatingStateViews = new WeakMap();
function renderGarageHeatingState(document, status, requested) {
  const root = document.getElementById('garage-heating-state');
  if (!root) return;
  if (!heatingStateViews.has(root)) heatingStateViews.set(root, createMitsubishiReadingView());
  const garage = status.garage ?? {}, now = status.now ?? Date.now();
  const readings = heatingStateViews.get(root)(garage, now);
  const mode = readings.find(row => row.key === 'native-mode');
  const room = mitsubishiRoomTemperature(garage), target = readings.find(row => row.key === 'native-targetC');
  for (const [key, reading] of [['mode', mode], ['room', room || target]]) {
    const row = document.getElementById(`garage-current-${key}-row`);
    if (row) row.hidden = !reading;
  }
  if (mode) {
    const node = document.getElementById('garage-current-mode');
    node?.classList.toggle('stale', !mode.available);
    setStatusDetail(node, { key: 'garage-current-mode', label: mode.value, title: 'Heat-pump mode', detail: mode.detail });
  }
  if (room || target) {
    const node = document.getElementById('garage-current-room');
    node?.classList.toggle('stale', !room && !target.available);
    setStatusDetail(node, { key: 'garage-current-room', title: 'Room setting',
      label: room ? `${room.value} · ${room.basis}` : `${target.value}${target.available ? ' · reported' : ''}`,
      detail: room?.detail ?? target.detail });
  }
  const confirmation = garageHeatingConfirmation(status, requested);
  const name = ({ Normal: 'Normal heating', Off: 'Off', Reduction: 'Heating pause', Restoring: 'Restoring heating' })[requested];
  setHeatingStatusDetail(document.getElementById('garage-current-control'), {
    key: 'garage-current-control', title: 'Garage heating control', confirmation,
    label: name ? `${name}${confirmation.state === 'confirmed' ? ' · confirmed' : ' requested · needs attention'}` : 'No current request',
    detail: 'Heating availability follows the requested pump power. Compressor activity is shown with the heat-pump readings.' });
}

export function renderGarage(document, status) {
  const display = garageDisplay(status?.garage, status?.now);
  const set = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  const detail = (id, label, title, description, stale = false) => {
    const node = document.getElementById(id); if (!node) return;
    node.classList.toggle('stale', stale);
    setStatusDetail(node, { label, title, detail: description, key: id });
  };
  const garage = status?.garage ?? {}, adapter = garage.adapter ?? {}, reported = adapter.native ?? adapter.readbacks ?? {};
  const now = status?.now ?? Date.now();
  const control = document.getElementById('garage-control-price');
  if (control) {
    const price = priceControlState(status, { feature: 'garage', enabled: garage.settings?.enabled ?? null, paused: Boolean(garage.temporary?.pauseActive) });
    control.textContent = price.label; control.parentElement.dataset.state = price.state;
  }
  const devices = status?.equipment?.devices ?? [];
  const temperatureDevice = devices.find(device => device.enabled !== false && device.readings?.garage_temperature);
  const rear = garage.observations?.rear;
  const main = finite(rear?.value) ? equipmentReadingRows({ kind: 'temperature', available: rear.stale === false,
    readings: { garage_temperature: { ...rear, unit: 'degC', label: 'Main garage temperature' } } })[0]
    : temperatureDevice ? equipmentReadingRows(temperatureDevice).find(row => row.signal === 'garage_temperature') : null;
  detail('garage-temperature', main?.value ?? 'Unavailable', 'Garage temperature',
    main?.detail ?? 'Waiting for a usable garage temperature.', main?.stale ?? true);
  document.getElementById('garage-temperature')?.classList.toggle('metric-unavailable', !main || main.stale);
  set('garage-temperature-age', !main || main.stale ? 'Waiting for current readings'
    : main.qualifier ?? 'Readings current');
  const temperatureNote = document.getElementById('garage-temperature-age');
  if (temperatureNote) temperatureNote.hidden = Boolean(main && !main.stale && !main.qualifier);
  for (const location of ['rear', 'front']) {
    const budget = garageColdBudget(garage, location);
    const settingId = `garage-settings-budget-${location}`;
    detail(settingId, budget.value, budget.title, budget.detail);
    const settingNode = document.getElementById(settingId);
    if (settingNode) settingNode.dataset.state = budget.attention ? 'attention' : 'muted';
    set(`${settingId}-remaining`, budget.summary);
  }
  const doors = garageDoorDevices(status).flatMap(device => {
    const rows = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
    return rows.length ? rows.map(row => ({ ...row, name: device.label ?? row.label }))
      : [{ name: device.label ?? 'Door', value: 'Unknown', stale: true, detail: 'No usable reading received' }];
  });
  const openDoors = doors.filter(row => row.value === 'Open'), closedDoors = doors.filter(row => row.value === 'Closed');
  const movingDoors = doors.filter(row => ['Opening', 'Closing'].includes(row.value));
  const unknownDoors = doors.filter(row => !['Open', 'Closed'].includes(row.value));
  const doorName = row => /^garage_door(\d+)_open$/.test(row.signal)
    ? `Door ${row.signal.match(/^garage_door(\d+)_open$/)[1]}` : row.name.replace(/^Garage\s+/i, '');
  let doorSummary = 'Unknown';
  if (doors.length === 1) doorSummary = doors[0].value;
  else if (movingDoors.length) {
    doorSummary = doors.length === 2 && movingDoors.length === 2 && movingDoors[0].value === movingDoors[1].value
      ? `Both ${movingDoors[0].value.toLowerCase()}`
      : movingDoors.map(row => `${doorName(row)} ${row.value.toLowerCase()}`).join(' · ');
  } else if (doors.length === 2) {
    if (openDoors.length === 2) doorSummary = 'Both open';
    else if (closedDoors.length === 2) doorSummary = 'Both closed';
    else if (openDoors.length === 1) doorSummary = `${doorName(openDoors[0])} open${unknownDoors.length ? ' · other unknown' : ''}`;
    else if (unknownDoors.length === 2) doorSummary = 'Both unknown';
    else doorSummary = `${doorName(unknownDoors[0])} unknown`;
  } else if (doors.length > 2) {
    doorSummary = [[openDoors.length, 'open'], [closedDoors.length, 'closed'], [unknownDoors.length, 'unknown']]
      .filter(([count]) => count).map(([count, state]) => `${count} ${state}`).join(' · ');
  }
  set('garage-doors-label', doorSummary);
  document.getElementById('garage-doors-shortcut')?.setAttribute('aria-label', `Garage doors: ${doorSummary}. Show controls`);
  const doorStatus = document.getElementById('garage-door-summary');
  doorStatus?.classList.toggle('stale', !doors.length || doors.some(row => row.stale));
  if (doorStatus) doorStatus.dataset.state = doors.length && closedDoors.length === doors.length && !doors.some(row => row.stale)
    ? 'confirmed' : 'attention';

  const pumpReadings = mitsubishiReadings(garage, now);
  const nativeReading = (field, title, format) => {
    const value = native(reported[field]), at = reported.readbacks?.[field]?.measuredAt
      ?? (field === 'power' ? reported.powerAt : null);
    const fresh = pumpReadings.find(reading => reading.key === `native-${field}`)?.available === true;
    const last = value === null || value === undefined ? 'Unknown' : format(value);
    const id = `garage-native-${field === 'targetC' ? 'target' : field}`;
    const available = fresh && last !== 'Unknown';
    const recorded = garage.readOnly === true && finite(at) && last !== 'Unknown';
    set(id, available ? last : recorded ? `${last} · recorded` : '—');
    const node = document.getElementById(id); node?.classList.toggle('stale', !available); node?.classList.toggle('muted', !available);
    return { value, fresh, detail: `${title}: ${last === 'Unknown' ? 'No usable native reading received.'
      : `Last reported ${last} · ${finite(at) ? clock(at) : 'freshness unknown'}${fresh ? '' : ' · current reading unavailable'}`}` };
  };
  const power = nativeReading('power', 'Mitsubishi power', value => mitsubishiValue('power', value));
  const mode = nativeReading('mode', 'Mitsubishi mode', value => mitsubishiValue('mode', value));
  const target = nativeReading('targetC', 'Native Mitsubishi target', value => number(value, '°C'));
  const compressor = mitsubishiCompressor(garage, now);
  set('garage-native-compressor', compressor.value);
  const compressorNode = document.getElementById('garage-native-compressor');
  compressorNode?.classList.toggle('stale', !compressor.available);
  compressorNode?.classList.toggle('muted', !compressor.available);
  const room = mitsubishiRoomTemperature(garage);
  if (room) {
    set('garage-native-target', room.value);
    const node = document.getElementById('garage-native-target');
    node?.classList.toggle('stale', false); node?.classList.toggle('muted', false);
    target.detail = `${room.detail}\n\n${target.detail}`;
  }
  set('garage-native-target-basis', room?.basis ?? '');
  const targetBasis = document.getElementById('garage-native-target-basis');
  if (targetBasis) targetBasis.hidden = !room;
  detail('garage-pump-reading-info', 'Reading details', 'Mitsubishi heat-pump readings', [power, mode, target, compressor].map(reading => reading.detail).join('\n\n'));
  const controls = garage.heatingControls ?? {};
  const held = controls.paused && controls.holdUntil > now;
  const temperatureHeld = temperatureHolding(garage, now);
  const requested = garageHeatingRequest(garage);
  set('garage-requested-label', isReadOnlyReplica(status) ? 'RECORDED HEATING REQUEST' : 'HEATING REQUEST');
  setHeatingStatusDetail(document.getElementById('garage-requested'), { key: 'garage-requested',
    label: isReadOnlyReplica(status) && requested === 'No request' ? 'Not recorded' : `${requested}${held || temperatureHeld ? ' · held' : ''}`, title: 'Garage heating request',
    confirmation: garageHeatingConfirmation(status, requested),
    detail: `${display.reason}.${held ? ` Manual heating selection is held until ${clock(controls.holdUntil)} or Resume now.` : ''} The request describes the heating plan.` });
  renderGarageHeatingState(document, status, requested);
  renderCurrentPrice(document, status, 'garage-');
  set('garage-pause-overview', garagePauseSummary(status));
  const list = (id, rows) => {
    const root = document.getElementById(id); if (!root) return;
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = value; fragment.append(dt, dd);
    }
    root.replaceChildren(fragment);
  };
  const connected = adapter.connected === true && adapter.health?.pumpCommunicating === true;
  set('garage-controller-state', isReadOnlyReplica(status) ? 'Recorded snapshot' : connected ? 'Connected' : adapter.connected ? 'Awaiting readings' : 'Not connected');
  const connection = document.getElementById('garage-controller-state');
  if (connection) connection.dataset.state = isReadOnlyReplica(status) ? 'pending' : connected ? 'available' : 'attention';
  set('garage-controller-reason', [garage.error, display.reason].filter(Boolean).join(' '));
  renderMitsubishiReadings(document, status);
  list('garage-controller-readings', display.rows);
  set('garage-strategy-overview', display.strategy?.label ?? 'Strategy unavailable');
  for (const strategy of HEATING_STRATEGIES) {
    const selected = strategy.id === display.strategy?.id;
    const option = document.getElementById(`garage-strategy-${strategy.id}`);
    if (option) option.dataset.selected = String(selected);
    const marker = document.getElementById(`garage-strategy-${strategy.id}-current`);
    if (marker) marker.hidden = !selected;
  }
  set('garage-policy-decision', display.planningDetails.find(row => row.key === 'current-opportunity')?.value ?? 'Unavailable');
  set('garage-policy-window', display.planningDetails.find(row => row.key === 'pause-window')?.value ?? 'Unavailable');
  const controlState = priceControlState(status, { feature: 'garage', enabled: garage.settings?.enabled ?? null, paused: Boolean(garage.temporary?.pauseActive) });
  set('garage-policy-context', status?.readOnly === true || isReadOnlyReplica(status)
    ? 'Read-only view: these settings and estimates do not authorize equipment control.'
    : controlState.state === 'paused'
    ? 'Price control is paused; the heating selection above applies. Freeze protection still limits off permission.'
    : garage.settings?.enabled === false ? 'Garage integration is disabled.'
      : status.input === 'offline' ? 'History viewer: automatic equipment control is unavailable.'
        : status.automation?.garage && !status.automation.garage.enabled ? 'Plan only: Garage plans do not send automatic commands. Manual heating controls remain independent.'
          : controlState.state === 'active' ? 'The plan remains subject to equipment and protection checks. Heating control above shows the current request and device feedback.'
            : 'Garage automation status is unavailable.');
  const approved = garage.settings?.protection?.approved;
  set('garage-protection-approval', approved === true ? 'Owner-approved' : approved === false ? 'Not approved' : 'Approval unknown');
  for (const [group, rows] of Object.entries(display.settingGroups)) {
    const root = document.getElementById(`garage-${group}-settings`); if (!root) continue;
    const fragment = document.createDocumentFragment();
    for (const [label, value, description] of rows) {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      const help = document.createElement('dd');
      row.className = 'garage-setting heating-policy-setting';
      dt.textContent = label; help.textContent = description; help.className = 'garage-setting-help heating-policy-setting-help';
      dd.textContent = value; row.append(dt, dd, help); fragment.append(row);
    }
    root.replaceChildren(fragment);
  }
  renderLearningRows(document.getElementById('garage-learning-outcomes'), display.outcomeDetails, { document });
  renderLearningRows(document.getElementById('garage-learning-evidence'), display.evidenceDetails, { document });
  renderLearningRows(document.getElementById('garage-learning-inputs'), display.inputDetails, { document });
  set('garage-learning-context', display.outcomeContext); set('garage-input-context', display.inputContext);
  set('garage-coefficient-context', display.coefficientContext);
  renderLearningRows(document.getElementById('garage-learning-coefficients'), display.coefficientDetails, { document });
  renderLearningRows(document.getElementById('garage-learning-planning'), display.planningDetails, { document });
  set('garage-learning-limitations', sentences(display.limitations));
}


export function garageReleaseAvailable(status) {
  const adapter = status?.garage?.adapter;
  return Boolean(status && status.readOnly !== true && !isReadOnlyReplica(status)
    && adapter?.restorePending === true && (adapter.liveControlSupported === true || adapter.simulation === true));
}

/** Ending an owned pause uses the safe release route. This never introduces a
 * generic switch capable of overriding an unmanaged or manual OFF state. */
export function createGarageControls({ document, request, onStatus = () => {}, onBusy = () => {},
  beforeRequest = () => {}, afterRequest = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id);
  const button = $('garage-release'), message = $('garage-release-message');
  const form = $('garage-pause-form'), until = $('garage-pause-until');
  let status = null, busy = false, closed = false, dirty = false;
  const notices = new Map();
  const restorationPending = value => Boolean(value?.garage?.adapter?.restorePending
    || value?.garage?.episode?.restorationPending || value?.garage?.adapter?.phase === 'restoring');
  const rememberNotice = (target, result, refresh) => notices.set(target, { result, refresh });
  const refreshControls = () => {
    const locked = closed || busy || blocked() || !status || isReadOnlyReplica(status);
    if (button) button.disabled = locked || !garageReleaseAvailable(status);
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    for (const mode of ['normal', 'off']) {
      const node = $(`garage-mode-${mode}`); if (!node) continue;
      node.disabled = locked || controls[`${mode}Available`] !== true;
      const selected = (controls.requestedMode ?? controls.selectedMode) === mode;
      node.setAttribute('aria-pressed', String(selected));
      node.setAttribute('aria-label', `${mode === 'normal' ? 'Normal heating' : 'Heating off'}${selected ? controls.confirmed ? ' · active' : ' · requested' : ''}`);
      node.querySelector('.heating-button-state').textContent = selected ? '✓' : '';
    }
    if ($('garage-pause-submit')) $('garage-pause-submit').disabled = locked || !temporary.available || !dirty;
    if ($('garage-resume-now')) $('garage-resume-now').disabled = locked || !temporary.available || !temporary.pauseActive;
    if (until) until.disabled = locked || !temporary.available;
  };
  const render = () => {
    const controls = status?.garage?.heatingControls ?? {}, temporary = status?.garage?.temporary ?? {};
    if (until && !dirty) until.value = temporary.pauseUntilLocal ?? finnishDateTime(temporary.pauseUntil);
    if ($('garage-pause-status')) $('garage-pause-status').textContent = temporary.pauseActive
      ? `Price control paused until ${clock(temporary.pauseUntil)}.` : 'Price control is not paused.';
    if ($('garage-heating-help')) $('garage-heating-help').textContent = isReadOnlyReplica(status)
      ? 'Device commands are disabled. Recorded history cannot confirm the current Garage heating state.' : `${temporary.pauseActive && temporary.pauseUntil > status?.now
      ? `Changes are held until ${clock(temporary.pauseUntil)} or Resume now, then normal heating returns.`
      : 'Changes reset on the next controller update, normally within 1 minute. Pause price control to hold them longer.'} Freeze protection can restore heating sooner.`;
    setStatusDetail($('garage-heating-status'), { key: 'garage-heating-availability', title: 'Garage heating control',
      label: controls.available ? 'Control available' : 'Control unavailable',
      detail: controls.available ? 'Manual heating requests are independent of automatic planning. Fresh pump readback confirms the request; equipment and freeze-protection checks still apply.'
        : controls.reason ?? 'Waiting for the garage heating connection.' });
    const normal = $('garage-mode-normal');
    if (normal) normal.title = controls.normalAvailable ? '' : controls.normalReason ?? controls.reason ?? 'Normal heating is unavailable.';
    const off = $('garage-mode-off');
    if (off) off.title = controls.offAvailable ? '' : controls.offReason ?? controls.reason ?? 'Heating off is unavailable.';
    const availability = $('garage-control-detail');
    if (availability) {
      const failure = controls.result?.reason;
      availability.textContent = [controls.activity, failure, !controls.normalAvailable && controls.normalReason,
        !controls.offAvailable && controls.offReason].filter(Boolean).filter((value, index, rows) => rows.indexOf(value) === index).join(' ');
    }
    const warning = garageHeatingWarning(status, clock), node = $('garage-hold-warning');
    if (node) { node.hidden = !warning; node.textContent = warning; }
    if (!busy) for (const [target, notice] of notices) {
      target.textContent = notice.refresh(status, notice.result);
      if (!target.textContent) { notices.delete(target); target.classList.remove('form-error'); }
    }
    refreshControls();
  };
  const send = async (path, input, target, pending, success, refresh) => {
    if (closed || busy || blocked() || !status || isReadOnlyReplica(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    notices.delete(target);
    target.classList.remove('form-error'); target.textContent = pending;
    try {
      const result = await request(path, input);
      if (path.endsWith('/temporary')) dirty = false;
      status = result; onStatus(result); render(); target.textContent = success(result);
      rememberNotice(target, result, refresh);
    } catch (error) { target.classList.add('form-error'); target.textContent = error.message; }
    finally { busy = false; onBusy(false); refreshControls(); }
    await afterRequest();
  };
  const heat = async mode => {
    const controls = status?.garage?.heatingControls;
    if (!controls?.[`${mode}Available`] || busy || blocked() || closed) return;
    if (status.garage.temporary?.pauseActive && !await confirmAction({ document,
      title: mode === 'off' ? 'Turn garage heating off during Pause?' : 'Change garage heating during Pause?',
      message: `${mode === 'off' ? 'Heating will stay off' : 'Normal heating will stay selected'} until ${clock(status.garage.temporary.pauseUntil)} or Resume now. ${mode === 'off'
        ? 'A cold garage can freeze pipes and stored equipment. Freeze protection may restore heating sooner.'
        : 'Automatic price control stays paused until then.'} Normal heating returns when the pause ends.`,
      action: mode === 'off' ? 'Turn heating off' : 'Apply normal heating' })) return;
    if (!status?.garage?.heatingControls?.[`${mode}Available`]) return;
    const heatingMessage = result => {
      const next = result.garage?.heatingControls;
      if (next?.result && ['failed', 'unconfirmed', 'uncertain', 'rejected'].includes(next.result.status))
        return next.result.reason || 'The heating request could not be confirmed. Check the current pump state.';
      const held = next?.paused && next.holdUntil > result.now;
      return `${next?.activity ? `${next.activity} ` : ''}${mode === 'off' ? 'Heating off' : 'Normal heating'} requested. ${held
        ? `Held until ${clock(next.holdUntil)} or Resume now.` : 'The temporary override ends on the next controller update, normally within 1 minute. Previous heating returns; automatic planning applies only if enabled.'} ${next?.confirmed ? 'Device confirmed.' : 'Check the reported pump state for confirmation.'}`;
    };
    await send('/api/garage/heating', { mode }, $('garage-heating-message'), 'Applying garage heating…', heatingMessage, (next, requested) => {
      const controls = next.garage?.heatingControls;
      if (controls?.requestedMode === mode && controls.holdUntil === requested.garage?.heatingControls?.holdUntil
        && controls.holdUntil > next.now) return heatingMessage(next);
      if (controls?.requestedMode && controls.holdUntil > next.now) return '';
      return restorationPending(next) ? 'Temporary heating request ended. Waiting for normal heating confirmation.'
        : controls?.result?.reason || '';
    });
  };
  const pauseMessage = (next, requested) => {
    const temporary = next.garage?.temporary;
    if (temporary?.pauseActive && temporary.pauseUntil > next.now) return temporary.pauseUntil === requested.garage?.temporary?.pauseUntil
      ? `Price control paused until ${clock(temporary.pauseUntil)}. Manual changes stay until the pause ends.` : '';
    return !next.garage?.heatingControls?.requestedMode && restorationPending(next)
      ? 'Price control resumed. Waiting for normal heating confirmation.' : '';
  };
  const pause = event => {
    event.preventDefault();
    if (!dirty || !status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntilLocal: until.value || null }, $('garage-pause-message'), 'Updating garage pause…',
      result => result.garage?.temporary?.pauseActive ? 'Pause saved. Normal heating is requested; later manual changes stay until the pause ends.' : 'Price control resumed.', pauseMessage);
  };
  const resume = () => {
    if (!status?.garage?.temporary?.available) return;
    void send('/api/garage/temporary', { pauseUntil: null }, $('garage-pause-message'), 'Resuming garage price control…',
      result => restorationPending(result) ? 'Price control resumed. Waiting for normal heating confirmation.' : 'Price control resumed.', pauseMessage);
  };
  const edit = () => { dirty = true; refreshControls(); };
  const normal = () => { void heat('normal'); }, off = () => { void heat('off'); };
  $('garage-mode-normal')?.addEventListener('click', normal);
  $('garage-mode-off')?.addEventListener('click', off);
  form?.addEventListener('submit', pause); until?.addEventListener('input', edit);
  $('garage-resume-now')?.addEventListener('click', resume);
  const release = async () => {
    if (closed || busy || blocked() || !garageReleaseAvailable(status)) return;
    busy = true; beforeRequest(); onBusy(true); refreshControls();
    notices.delete(message);
    button.setAttribute('aria-busy', 'true'); message.classList.remove('form-error');
    message.textContent = 'Ending garage pause; awaiting heating confirmation…';
    try {
      const result = await request('/api/garage/release', {});
      status = result; onStatus(result);
      message.textContent = result.garage?.adapter?.restorePending
        ? 'Restoration requested. Waiting for heating confirmation.' : 'Garage pause ended.';
      rememberNotice(message, result, next => next.garage?.heatingControls?.requestedMode === 'off' ? ''
        : restorationPending(next) ? 'Restoration requested. Waiting for heating confirmation.' : '');
    } catch (error) {
      message.classList.add('form-error'); message.textContent = error.message;
    } finally {
      busy = false; button.removeAttribute('aria-busy'); onBusy(false); refreshControls();
    }
    await afterRequest();
  };
  button?.addEventListener('click', release); refreshControls();
  return { update(value) { status = value; render(); }, refreshControls,
    close() {
      closed = true; button?.removeEventListener('click', release);
      $('garage-mode-normal')?.removeEventListener('click', normal); $('garage-mode-off')?.removeEventListener('click', off);
      form?.removeEventListener('submit', pause); until?.removeEventListener('input', edit);
      $('garage-resume-now')?.removeEventListener('click', resume); refreshControls();
    } };
}
