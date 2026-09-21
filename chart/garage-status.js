import { isReadOnlyReplica } from './replica-status.js';
import { mitsubishiReadings, renderMitsubishiReadings } from './mitsubishi.js';
import { outdoorSourceLabel } from './provider-status.js';
import { equipmentReadingRows } from './equipment.js';
import { setStatusDetail } from './status-details.js';
import { renderCurrentPrice } from './current-price.js';
import { garageHeatingConfirmation, setHeatingStatusDetail } from './heating-status.js';
import { finnishDateTime } from './home-controls.js';
import { confirmPausedHeating, garageHeatingWarning } from './heating-warning.js';
import { GARAGE_HEAT_TRANSFER_SAFETY_FACTOR } from '../src/garage/settings.js';
import { renderLearningRows } from './learning-rows.js';
const finite = Number.isFinite;
const text = value => typeof value === 'string' ? value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ') : 'Unknown';
const number = (value, unit = '') => finite(value) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(value)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
const native = value => value && typeof value === 'object' ? value.value : value;
const temperature = reading => finite(reading?.value) ? `${number(reading.value, '°C')}${reading.stale ? ' · stale' : ''}` : 'Unavailable';
const state = value => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
const clock = value => finite(value) ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value) : 'Unknown';
const sentences = values => values.map(value => text(value).trim().replace(/[.\s]+$/, '')).filter(Boolean).map(value => `${value}.`).join(' ');
const opportunity = reason => ({
  'automatic-control-disabled': 'Automatic control is disabled',
  'normal-heating-preference': 'Normal heating selected',
  'protection-limited-learning-opportunity': 'Initial cooling estimates use extra uncertainty margins; pipe protection limits the pause',
  'continue-authorized-economic-episode': 'Continue the current pause within its original endpoint',
  'garage-door-open-below-2c': 'An open door below 2°C outdoors prevents a new pause',
  'garage-door-state-unknown': 'Waiting for fresh garage-door readings',
  'outdoor-temperature-unavailable': 'Waiting for a fresh outdoor temperature',
  'charging-heat-opportunity-uncertain': 'Waiting until charging ends before choosing a savings pause',
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
  'normal-heating-preference': 'Normal heating selected',
  'insufficient-normal-heating-evidence': 'Awaiting normal-heating evidence',
  'learning-episode-recovering': 'Awaiting recovery',
  'learning-trial-recovery-interval': 'Between learning trials',
  'benefit-below-warmth-or-prediction-resolution': 'Insufficient timing benefit',
  'credible-price-timing-opportunity': 'Price-supported pause',
  'prepare-for-later-price-opportunity': 'Later price opportunity',
})[reason] ?? opportunity(reason);
const coefficientNumber = (value, unit) => finite(value)
  ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 4 }).format(value)} ${unit}` : 'Unavailable';
const learningRow = (key, title, value, group, provenance, detail, evidence) =>
  ({ key, title, value, group, provenance, detail, ...(evidence ? { evidence } : {}), available: value !== 'Unavailable' });

function garageCoefficientRows(learning) {
  const assumptions = learning.assumptions ?? {}, electricity = learning.electricity ?? {};
  const details = ['rear', 'front'].map(location => {
    const row = learning.coefficients?.[location]?.find(value => value.name === 'coolingPerHour');
    const title = `${location === 'rear' ? 'Rear' : 'Front'} cooling rate`;
    const fitted = row?.basis === 'fitted-effective-response';
    const result = learningRow(`${location}-cooling-rate`, title, coefficientNumber(row?.value, '1/h'), 'Learned cooling',
      !finite(row?.value) ? 'Unavailable' : fitted ? 'Learned' : 'Initial estimate',
      'Cooling per degree of local air-to-outdoor temperature difference while the pump is OFF. The two locations are learned independently; there is no hidden building-temperature state.',
      `${number(row?.evidence, 'h')} clean cooling observations. Door openings and charging exclude an interval from fitting. A fitted rate still needs episode validation.`);
    result.calculation = { equations: [{ expression: 'T_next = T_out + (T_now − T_out) × exp(−k × hours)',
      legend: 'k is this location’s cooling rate in 1/h. T_now and T_out are local and outdoor air temperatures in °C.' }],
      paragraphs: ['The forecast is checked against complete OFF episodes. Extra prediction margins and the independent pipe model shorten a pause when evidence is uncertain.'] };
    return result;
  });
  details.push(
    learningRow('normal-pump-power', 'Normal pump electricity', number(electricity.normalPowerKw ?? assumptions.normalPowerKw, 'kW'),
      'Electricity estimate', electricity.basis === 'observed-normal-power' ? 'Recorded average' : 'Assumed',
      'Average electrical input used to estimate the value of moving heating to a cheaper period. A fixed estimate is used without a qualified meter. Compressor frequency is not converted to watts.',
      electricity.basis === 'observed-normal-power' ? `${number(electricity.hours, 'h')} qualified normal-heating electricity.` : 'Estimated savings remain assumption-based until dedicated pump electricity is qualified.'),
    learningRow('charger-heat-fraction', 'Charging heat fraction', finite(assumptions.evHeatFraction) ? number(assumptions.evHeatFraction * 100, '%') : 'Unavailable',
      'Fixed assumptions', 'Assumed', '7.5% of recorded charging electricity is attributed to garage heat. This is an estimate, not measured vehicle heat. Expected charging never extends a safe pause.'),
    learningRow('recovery-time', 'Recovery temperature time scale', number(assumptions.recoveryTimeHours, 'h'), 'Fixed assumptions', 'Assumed',
      'Time scale used only for the illustrative temperature forecast after normal heating resumes. The electricity allowance uses a longer period for long pauses. Actual recovery at both locations and their pipe reserves determines readiness for another pause.'),
    learningRow('recovery-energy-factor', 'Recovery electricity allowance', number(assumptions.recoveryEnergyFactor, '×'), 'Fixed assumptions', 'Assumed',
      'Allows for additional electricity when heat is restored. Its pricing period is at least three hours and at least 1.25 times the OFF duration, also respecting the configured minimum normal-heating time. The full allowance is priced before a pause can count as worthwhile. Recovery is not assumed complete when the temperature forecast’s three-hour time scale elapses.'));
  return { details, rows: details.map(row => [row.title, `${row.value} · ${row.provenance}. ${row.detail}${row.evidence ? ` ${row.evidence}` : ''}`]) };
}

function garageLearningRows(garage, policy) {
  const learning = garage.learning ?? {}, validation = learning.validation, plan = garage.plan ?? {};
  const planReason = plan.reason ?? plan.reasons?.[0] ?? garage.reason;
  const reference = learning.normalReference;
  const thermal = learning.thermalReady, electrical = learning.electricalReady;
  const duration = finite(learning.validatedOffHours) && learning.validatedOffHours > 0 ? number(learning.validatedOffHours, 'h')
    : finite(learning.validatedOffHours) ? 'Not yet established' : 'Unavailable';
  const outcomes = [
    learningRow('temperature-prediction', 'Cooling prediction', thermal === true ? 'Validated' : thermal === false ? 'Awaiting validation' : 'Unavailable',
      'Pause readiness', 'Calculated', 'Complete cooling and recovery episodes test the two local cooling forecasts. The pipe reserve and fresh measurements still limit each actual pause.'),
    learningRow('thermal-pause-duration', 'Validated OFF evidence', duration, 'Forecast evidence', 'Episode checks',
      'OFF duration covered by retained clean cooling and recovery checks. Longer forecasts receive larger uncertainty margins; this evidence does not impose a maximum pause.'),
    learningRow('electricity-prediction', 'Savings estimate basis', electrical === true ? 'Qualified electricity' : learning.electricity ?
      learning.electricity.basis === 'observed-normal-power' ? 'Recorded average + recovery allowance' : 'Assumed electricity + recovery allowance' : 'Unavailable',
      'Savings estimate', electrical === true ? 'Recorded & modeled' : 'Estimated',
      'Forecast savings price the avoided normal-heating electricity and the recovery allowance. Assumed pump input is shown explicitly; forecast savings are not measured savings.'),
  ];
  for (const location of ['rear', 'front']) if (reference) outcomes.push(learningRow(`normal-${location}-warmth`,
    `Normal ${location} warmth`, number(reference[`${location}C`], '°C'), 'Observed references',
    reference.initialized === true ? 'Learned' : reference.initialized === false ? 'Initial estimate' : 'Unknown basis',
    'Air temperature observed during settled normal heating, separate from the pump thermostat setting.',
    `${number(reference.qualifiedHours, 'h')} qualified normal-heating observations.`));
  const reconstruction = ({ current: 'Up to date', snapshot: 'Recorded primary snapshot', rebuilding: 'Rebuilding from recorded history', failed: 'Reconstruction unavailable' })[learning.reconstruction] ?? 'Unavailable';
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
      validation.active.phase === 'off' ? 'Cooling' : 'Recovery', 'Current episode', 'In progress', 'The current episode contributes to validation only after it has ended and passed the required checks.'));
  }
  evidenceDetails.push(learningRow('recorded-history-reconstruction', 'Recorded history reconstruction', reconstruction, 'Model record', 'Recorded history',
    'The current model is rebuilt from its recorded inputs and selected corrections. A primary snapshot is historical evidence, not live pause eligibility.'));
  const version = learning.algorithm?.match(/^committed-garage-v(\d+)-/);
  if (version) evidenceDetails.push(learningRow('model-version', 'Model version', `Garage ${version[1]}`, 'Model record', 'Algorithm',
    'Version of the garage algorithm used for learning and replay.'));
  const observations = garage.observations ?? {};
  const inputDetails = ['rear', 'front'].map(location => learningRow(`${location}-air-temperature`, `${location === 'rear' ? 'Rear' : 'Front'} air temperature`,
    temperature(observations[location]), 'Temperatures', 'Recorded',
    'External air reading beside the local pipe. Both locations need fresh readings for every automatic pause; pump indoor temperature is separate diagnostic context.'));
  inputDetails.push(
    learningRow('outdoor-temperature', 'Outdoor temperature', temperature(observations.outdoor), 'Temperatures',
      observations.outdoor?.source === 'openmeteo' ? 'Modeled' : ['husdata-h66', 'fmi', 'mqtt-temperature', 'shelly-mqtt'].includes(observations.outdoor?.source) ? 'Recorded' : 'Source varies',
      `${outdoorSourceLabel(observations.outdoor?.source) ?? 'Source unavailable'}. Learning uses the recorded outdoor input; planning uses the forecast available when deciding.`),
    learningRow('heating-availability', 'Heat-pump state', text(native(garage.adapter?.native?.power) ?? 'Unavailable'), 'Heating inputs', 'Recorded',
      'Fresh native OFF identifies cooling intervals. Native ON makes normal heating available; it does not prove useful heat at the pipes. Compressor activity is diagnostic context, not thermal kW.'),
    learningRow('heat-pump-input', 'Heat-pump electricity', learning.electricity?.basis === 'observed-normal-power' ? number(learning.electricity.normalPowerKw, 'kW average') : 'No qualified meter',
      'Heating inputs', learning.electricity?.basis === 'observed-normal-power' ? 'Recorded' : 'Unavailable',
      'Only qualified dedicated electrical measurements establish pump electricity. An unscaled native counter or compressor frequency supplies no measured watts, heat output or COP.'),
    ...[1, 2].map(id => {
      const charging = observations.charging?.[`ev${id}`];
      return learningRow(`charger-${id}-input`, `Charger ${id} heat contribution`,
        charging?.known === true ? number(charging.heatKw, 'kW estimated heat') : 'Unavailable', 'Heating inputs', 'Recorded × assumption',
        `Recorded charger ${id} electricity is multiplied by 0.075 for estimated garage heat. Charging intervals do not fit the cooling rates. Future charging warmth is excluded from protection.`,
        charging?.known === true ? `${number(charging.powerKw, 'kW')} recorded electrical input.` : 'No qualified current electrical input. Unknown is not treated as zero heat.');
    }),
    learningRow('doors-and-local-cooling', 'Garage doors', 'Opening events + local temperatures', 'Operating context', 'Recorded',
      'Door size and indoor/outdoor temperatures do not fully determine air exchange. The model excludes disturbed cooling intervals; fresh local readings and the reference-pipe reserve capture actual cooling. Door events trigger a protection reassessment.'),
    learningRow('local-allowance-recovery', 'Pipe reference reserve', finite(policy.marginC) ? 'Rear and front independently' : 'Unavailable', 'Protection context', 'Calculated',
      'A water-filled copper reference follows each local air temperature continuously. It estimates pipe warmth rather than measuring it; cooling and warming use fixed conservative heat-transfer assumptions.'));
  const settings = garage.settings ?? {};
  const planningDetails = [
    learningRow('current-opportunity', 'Current decision', opportunitySummary(planReason), 'Decision', 'Current plan', opportunity(planReason)),
    learningRow('pause-window', 'Planned OFF window', finite(plan.pauseFrom) && finite(plan.plannedPauseUntil ?? plan.pauseUntil) ? `${clock(plan.pauseFrom)} – ${clock(plan.plannedPauseUntil ?? plan.pauseUntil)}` : 'None',
      'Decision', 'Current plan', 'One worthwhile price period is selected. Heating stays at its existing setting beforehand and returns to normal afterward; no preheating is requested.'),
    learningRow('door-policy', 'Door opening', 'Reassess local pipe reserve', 'Pause limits', 'Fixed policy',
      'An opening rechecks protection using the local readings. Unknown configured doors or outdoor temperature block a new pause, as does an open door below 2°C outdoors.'),
    learningRow('minimum-savings', 'Minimum estimated benefit', finite(settings.minSavingsEur) ? `€${number(settings.minSavingsEur)}` : 'Unavailable',
      'Pause limits', 'Configured', 'A pause must exceed this saving estimate after recovery electricity and prediction uncertainty allowances. Small price differences are left to normal heating.'),
    learningRow('pause-duration-limits', 'Minimum planned OFF time', number(finite(settings.minOffMs) ? settings.minOffMs / 3_600_000 : null, 'h'),
      'Pause limits', 'Configured', 'There is no fixed maximum pause. Temperatures, forecast pipe reserve, uncertainty, available price and weather data, and remaining savings determine the endpoint. Protection can always end a pause before the planned minimum.'),
    learningRow('daily-pause-limit', 'Maximum pauses per day', number(settings.maxPausesPerDay), 'Pause limits', 'Configured',
      'Only the larger opportunities are selected, keeping additional pump starts infrequent.',
      finite(garage.planningLimits?.pausesToday) ? `${number(garage.planningLimits.pausesToday)} starts recorded today, including unconfirmed attempts.` : undefined),
    learningRow('minimum-normal-heating', 'Normal heating between pauses', number(finite(settings.minOnMs) ? settings.minOnMs / 3_600_000 : null, 'h minimum'),
      'Pause limits', 'Configured', 'Fresh normal-heating evidence is required for at least this long, including after startup or a reading gap. After a pause, both local temperatures and pipe reserves must also recover.',
      finite(garage.planningLimits?.normalHeatingReadyAt) ? `Current continuous normal-heating interval reaches its minimum at ${clock(garage.planningLimits.normalHeatingReadyAt)}. All other checks still apply.` : 'Waiting for a fresh continuous normal-heating interval.'),
    learningRow('charging-policy', 'Charging', 'Wait before a new pause', 'Pause limits', 'Fixed policy',
      'A new savings pause waits until charging has stopped because charging heat can reduce the pump’s own demand. Future charging heat receives no credit when predicting how long a pause is safe.'),
    learningRow('protection-policy', 'Freezing protection', policy.approved === true ? 'Owner-approved' : policy.approved === false ? 'Not approved' : 'Approval unknown',
      'Safeguards', 'Configured', 'The rear and front reference pipes must retain their configured margin through the remaining permission and useful-heating delay. Missing fresh evidence requests normal heating.'),
    learningRow('restore-policy', 'Return to normal heat', 'Short local lease + recovery check', 'Safeguards', 'Device + observed temperatures',
      'The adapter restores native ON when its short renewable OFF permission expires. Renewals can maintain one continuous pause of any thermally permitted duration; this communication safeguard does not cap its total length. ON readback and useful warmth are separate checks. A failed adapter or serial path can prevent restoration.'),
  ];
  return { outcomeRows: outcomes.map(row => [row.title, `${row.value}. ${row.detail}`]), inputRows: inputDetails.map(row => [row.title, row.detail]),
    outcomeDetails: outcomes, evidenceDetails, inputDetails, planningDetails,
    outcomeContext: 'Two cooling rates describe how the garage cools with heating off. Complete cooling and recovery checks measure forecast accuracy. Temperatures and the pipe reserve limit each pause, with extra margins beyond observed evidence.',
    inputContext: 'Recorded temperatures, door events and pump state support the model. Charging heat and unmetered electricity remain explicit assumptions. Missing readings remain unknown.',
    coefficientContext: 'Only the rear and front cooling rates are fitted. The electricity and recovery estimates below stay visible as separate assumptions.' };
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
  const rows = [];
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
    ['Normal heating setting basis', settings.assumeISave10C === true ? '10 °C · Assumed i-save' : adapter.baselineVerified === true ? 'Verified native baseline' : 'Native baseline not verified'],
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
  const settingGroups = {
    heating: [
      ['Normal Mitsubishi setting', settings.assumeISave10C === true ? '10 °C · Assumed i-save' : number(settings.baselineC, '°C'), 'Existing pump setting. Change the i-save assumption in Mitsubishi Heat-pump settings.'],
      ['Savings selection', finite(settings.aggressiveness) ? settings.aggressiveness === 0 ? 'Normal heating' : 'Larger opportunities' : 'Unavailable', 'Normal heating stays available when savings are disabled. Otherwise only pauses meeting the minimum benefit and planned OFF time, with current pipe protection and recovery checks are considered.'],
    ],
    protection: [
      ['Protection margin', number(policy.marginC, '°C'), 'Heat reserve is calculated above this temperature. Heating is requested early to allow time for warming.'],
      ['Reference pipe diameter', number(policy.pipeOutsideDiameterMm, 'mm'), 'Outside diameter of the bare, water-filled copper pipe used as the protection reference.'],
      ['Assumed wall thickness', number(policy.pipeWallMm, 'mm'), 'The copper wall thickness used to calculate the reference’s capacity to store warmth.'],
      ['Heat transfer', number(policy.heatTransferWPerM2K, 'W/m²K'), 'Initial estimate of how readily the reference exchanges heat with the surrounding air.'],
      ['Safety factor', `${GARAGE_HEAT_TRANSFER_SAFETY_FACTOR}×`, 'Counts cooling twice as quickly and warming half as quickly.'],
    ],
    recovery: [
      ['Cold allowance', 'Calculated · kJ/m', 'The reference’s stored warmth determines each location’s allowance. A warmer starting point provides more reserve.'],
      ['Recovery', 'Continuous', 'Local air warms the reference and restores allowance gradually. A greater temperature difference restores it faster.'],
    ],
  };
  const coefficients = garageCoefficientRows(learning);
  const learningRows = garageLearningRows(garage, policy);
  return { status: text(garage.status ?? (settings.enabled ? 'commissioning' : 'monitoring')),
    reason: text(garage.reason ?? 'Automatic control awaits the implemented adapter contract and installed commissioning')
      .trim().replace(/^./, value => value.toUpperCase()),
    rows, settingGroups, coefficients: coefficients.rows, coefficientDetails: coefficients.details, ...learningRows, limitations: learning.limitations ?? [] };
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
    control.textContent = garage.temporary?.pauseActive ? 'Paused'
      : garage.settings?.enabled === true ? 'Active' : garage.settings?.enabled === false ? 'Disabled' : '—';
    control.parentElement.dataset.state = garage.temporary?.pauseActive ? 'paused'
      : garage.settings?.enabled === true ? 'active' : 'muted';
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
  const doors = devices.filter(device => device.enabled !== false && device.kind === 'door' && ((device.area ?? 'garage') === 'garage'
    || Object.keys(device.readings ?? {}).some(signal => /^garage_door/.test(signal)))).flatMap(device => {
    const rows = equipmentReadingRows(device).filter(row => /_open$/.test(row.signal));
    return rows.length ? rows.map(row => ({ ...row, name: device.label ?? row.label }))
      : [{ name: device.label ?? 'Door', value: 'Unknown', stale: true, detail: 'No usable reading received' }];
  });
  const openDoors = doors.filter(row => row.value === 'Open'), closedDoors = doors.filter(row => row.value === 'Closed');
  const unknownDoors = doors.filter(row => !['Open', 'Closed'].includes(row.value));
  const doorName = row => /^garage_door(\d+)_open$/.test(row.signal)
    ? `Door ${row.signal.match(/^garage_door(\d+)_open$/)[1]}` : row.name.replace(/^Garage\s+/i, '');
  let doorSummary = 'Unknown';
  if (doors.length === 1) doorSummary = doors[0].value;
  else if (doors.length === 2) {
    if (openDoors.length === 2) doorSummary = 'Both open';
    else if (closedDoors.length === 2) doorSummary = 'Both closed';
    else if (openDoors.length === 1) doorSummary = `${doorName(openDoors[0])} open${unknownDoors.length ? ' · other unknown' : ''}`;
    else if (unknownDoors.length === 2) doorSummary = 'Both unknown';
    else doorSummary = `${doorName(unknownDoors[0])} unknown`;
  } else if (doors.length > 2) {
    doorSummary = [[openDoors.length, 'open'], [closedDoors.length, 'closed'], [unknownDoors.length, 'unknown']]
      .filter(([count]) => count).map(([count, state]) => `${count} ${state}`).join(' · ');
  }
  detail('garage-door-summary', doorSummary,
    'Garage doors', doors.length ? doors.map(row => `${row.name}: ${row.value}. ${row.detail}`).join('\n')
      : 'No garage door reports are available.', !doors.length || doors.some(row => row.stale));
  const doorStatus = document.getElementById('garage-door-summary');
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
    set(id, available ? last : '—');
    const node = document.getElementById(id); node?.classList.toggle('stale', !available); node?.classList.toggle('muted', !available);
    return { value, fresh, detail: `${title}: ${last === 'Unknown' ? 'No usable native reading received.'
      : `Last reported ${last} · ${finite(at) ? clock(at) : 'freshness unknown'}${fresh ? '' : ' · current reading unavailable'}`}` };
  };
  const power = nativeReading('power', 'Mitsubishi power', text);
  const mode = nativeReading('mode', 'Mitsubishi mode', text);
  const target = nativeReading('targetC', 'Native Mitsubishi target', value => number(value, '°C'));
  const assumed = garage.settings?.assumeISave10C === true;
  if (assumed) {
    set('garage-native-target', '10 °C');
    const node = document.getElementById('garage-native-target');
    node?.classList.toggle('stale', false); node?.classList.toggle('muted', false);
    target.detail = `Assumed i-save setting: 10 °C. Assumes this remains active across OFF/ON; native readings cannot confirm it.\n\n${target.detail}`;
  }
  set('garage-native-target-basis', assumed ? 'Assumed i-save' : '');
  const targetBasis = document.getElementById('garage-native-target-basis');
  if (targetBasis) targetBasis.hidden = !assumed;
  detail('garage-pump-reading-info', 'Reading details', 'Mitsubishi heat-pump readings', [power, mode, target].map(reading => reading.detail).join('\n\n'));
  const controls = garage.heatingControls ?? {}, action = garage.plan?.nextAction;
  const held = controls.paused && controls.holdUntil > now;
  const requested = controls.requestedMode === 'off' ? 'Off'
    : controls.requestedMode === 'normal' ? 'Normal'
      : adapter.phase === 'paused' ? 'Reduction'
        : adapter.restorePending || garage.episode?.restorationPending || adapter.phase === 'restoring' ? 'Restoring'
          : ['pause', 'renew'].includes(action) ? 'Reduction'
            : ['available', 'release'].includes(action) || garage.temporary?.pauseActive ? 'Normal' : 'No request';
  set('garage-requested-label', 'HEATING REQUEST');
  setHeatingStatusDetail(document.getElementById('garage-requested'), { key: 'garage-requested',
    label: `${requested}${held ? ' · held' : ''}`, title: 'Garage heating request',
    confirmation: garageHeatingConfirmation(status, requested),
    detail: `${display.reason}.${held ? ` Manual heating selection is held until ${clock(controls.holdUntil)} or Resume now.` : ''} The request describes the heating plan.` });
  renderCurrentPrice(document, status, 'garage-');
  set('garage-pause-overview', garage.temporary?.pauseActive
    ? `Price control paused until ${clock(garage.temporary.pauseUntil)}` : 'Pause automatic price control');
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
  set('garage-controller-state', connected ? 'Connected' : adapter.connected ? 'Awaiting readings' : 'Not connected');
  const connection = document.getElementById('garage-controller-state');
  if (connection) connection.dataset.state = connected ? 'available' : 'attention';
  set('garage-controller-reason', display.reason);
  renderMitsubishiReadings(document, status);
  list('garage-controller-readings', display.rows);
  const approved = garage.settings?.protection?.approved;
  set('garage-protection-approval', approved === true ? 'Owner-approved' : approved === false ? 'Not approved' : 'Approval unknown');
  for (const [group, rows] of Object.entries(display.settingGroups)) {
    const root = document.getElementById(`garage-${group}-settings`); if (!root) continue;
    const fragment = document.createDocumentFragment();
    for (const [label, value, description] of rows) {
      const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
      const help = document.createElement('small');
      row.className = 'garage-setting';
      dt.textContent = label; help.textContent = description; dt.append(help);
      dd.textContent = value; row.append(dt, dd); fragment.append(row);
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
    if ($('garage-heating-help')) $('garage-heating-help').textContent = controls.available
      ? 'If price control is not paused, manual changes revert on the next update, normally within 1 minute. During Pause, they stay until it ends. Freeze protection can restore heating sooner.'
      : controls.reason ?? 'Waiting for the garage heating connection.';
    const off = $('garage-mode-off');
    if (off) off.title = controls.offAvailable ? '' : controls.offReason ?? controls.reason ?? 'Heating off is unavailable.';
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
    if (status.garage.temporary?.pauseActive && !await confirmPausedHeating({ document,
      title: mode === 'off' ? 'Turn garage heating off during Pause?' : 'Change garage heating during Pause?',
      message: `${mode === 'off' ? 'Heating will stay off' : 'Normal heating will stay selected'} until ${clock(status.garage.temporary.pauseUntil)} or Resume now. ${mode === 'off'
        ? 'A cold garage can freeze pipes and stored equipment. Freeze protection may restore heating sooner.'
        : 'Automatic price control stays paused until then.'} Normal heating returns when the pause ends.`,
      action: mode === 'off' ? 'Turn heating off' : 'Apply normal heating' })) return;
    if (!status?.garage?.heatingControls?.[`${mode}Available`]) return;
    const heatingMessage = result => {
      const next = result.garage?.heatingControls, held = next?.paused && next.holdUntil > result.now;
      return `${mode === 'off' ? 'Heating off' : 'Normal heating'} requested. ${held
        ? `Held until ${clock(next.holdUntil)} or Resume now.` : 'Automatic control takes over on its next update, normally within 1 minute.'} ${next?.confirmed ? 'Device confirmed.' : 'Check the reported pump state for confirmation.'}`;
    };
    await send('/api/garage/heating', { mode }, $('garage-heating-message'), 'Applying garage heating…', heatingMessage, (next, requested) => {
      const controls = next.garage?.heatingControls;
      if (controls?.requestedMode === mode && controls.holdUntil === requested.garage?.heatingControls?.holdUntil
        && controls.holdUntil > next.now) return heatingMessage(next);
      if (controls?.requestedMode && controls.holdUntil > next.now) return '';
      return restorationPending(next) ? 'Temporary heating request ended. Waiting for normal heating confirmation.' : '';
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
