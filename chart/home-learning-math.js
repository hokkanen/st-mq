import { HEATING_STRATEGIES } from '../src/domain/heating-strategy.js';

// Presentation of implemented calculations. Symbols are defined beside each
// equation; these descriptions do not participate in prediction or control.
// Keep these disclosures aligned with adaptive-learning.js (thermal balance,
// fitting, duty and calibration), planner.js (cost/admission), learning.js
// (comfort reference), cycles.js (outcomes), heat-pump-performance.js and
// fireplace.js (fixed source conversions).
const equation = (label, expression, legend) => ({ label, expression, legend });
const calculation = (equations, paragraphs = [], summary = 'Calculation') => ({ summary, equations, paragraphs });

export function coefficientCalculation(key, model = {}) {
  const definitions = {
    lossPerHour: calculation([equation('Cooling contribution', 'L = k × (T_in − T_out)',
      'k is this coefficient (1/h); temperatures are in °C. L is the cooling contribution in °C/h, before heating and stored-heat release.')],
    ['For a 10 °C indoor–outdoor difference, multiply the coefficient by 10. With explicit ground exchange, the heat balance adjusts this term to avoid counting baseline ground loss twice.']),
    hydronicCPerKwh: calculation([
      equation('Heat supplied to space heating', 'H = d × Q(T_water) + A',
        'H is thermal power (kW); d is space-heating compressor duty (0–1); Q is estimated compressor heat output; A is space-heating AUX power, approximately equal to its electrical input.'),
      equation('Heating contribution', 'h = g × H',
        'g is this coefficient (°C/kWh thermal); h is the temperature-model input in °C/h. Over Δt hours, the input is g × H × Δt.'),
    ], ['This input first charges the slow reserve and, when configured, the selected slab. Their later release determines room warming. The source-map equations and electrical accounting are under Installed heat-pump model.']),
    solarCPerHourPerKwM2: calculation([equation('Solar contribution', 'J = s × I / 1000',
      's is this coefficient (°C/h per kW/m²); I is forecast radiation in W/m². J is the room-warming contribution in °C/h.')],
    ['The fitted response summarizes the house’s exposure, glazing and other effects. Forecast radiation is not a measurement of solar heat entering the rooms.']),
    fireplaceCPerKg: calculation([equation('Fireplace contribution', 'F = f × r(t)',
      'f is this coefficient (°C/kg); r(t) is delayed fuel-equivalent release in kg/h. F is the room-warming contribution in °C/h.')],
    ['The fixed release curve spreads logged fuel over time and adds overlapping loads. The Fireplace release input calculation explains that curve; this coefficient does not measure efficiency or delivered kWh.']),
    memoryExchangePerHour: calculation([equation('Reserve-to-room exchange', 'X = a × (T_res − T_in)',
      'a is this fixed coefficient (1/h); T_res is the modeled reserve temperature and T_in is indoor temperature. Positive X warms the room; negative X charges the reserve.')]),
    reserveTimeHours: calculation([equation('Default effective reserve capacity', 'C_seed = a × τ / g_seed',
      'τ is this fixed time scale (h); a is reserve exchange (1/h); g_seed is the configured initial hydronic response (°C/kWh thermal). C_seed is an effective capacity in kWh/K, not a measured building capacity.')],
    [model.floor?.enabled ? 'The selected slab is allocated from the seeded reserve budget unless a separate remaining capacity is configured. Those capacities stay fixed when the response coefficient is refitted.'
      : 'Without an explicit slab, a × τ sets the reserve-to-room capacity ratio. It controls modeled temperature memory; it does not establish usable tariff-period storage.']),
  };
  return definitions[key];
}

export function floorCalculation(key) {
  return {
    capacityKwhPerC: calculation([equation('Material sensible heat', 'ΔE_slab = C_slab × ΔT_slab',
      'C_slab is the configured capacity in kWh/K. Uniform warming by ΔT_slab degrees stores ΔE_slab thermal kWh.')],
    ['Only part of that energy may be charged, retained and usefully released within a tariff window. It is not an estimate of electricity saved.']),
    nativeCapacityKwhPerC: calculation([equation('Remaining reserve', 'C_res = max(0.5, a × τ / g_seed − C_slab)',
      'This is the default allocation in kWh/K at initialization. An explicitly configured remaining reserve capacity replaces this default.')]),
    exchangeKwPerC: calculation([equation('Slab-to-room transfer', 'F_slab = K_slab × (T_slab − T_in)',
      'K_slab is the configured exchange in kW/K. Positive F_slab is thermal kW released to the room; negative values warm the slab.')]),
    groundLossKwPerC: calculation([equation('Slab-to-ground transfer', 'F_ground = K_ground × (T_slab − T_ground)',
      'K_ground is the configured exchange in kW/K. Positive F_ground is heat leaving the slab in thermal kW.')]),
    groundC: calculation([equation('Fixed ground boundary', 'T_ground(t) = configured ground temperature',
      'The boundary is constant in this model. It is neither the outdoor-air temperature nor a live sensor measurement.')]),
    openAllocationFraction: calculation([equation('Heat allocation', 'H_slab = α_on × H;  H_res = (1 − α_on) × H',
      'α_on is the configured fraction when all override outputs are confirmed ON. H is the same total hydronic input in thermal kW.')]),
    closedAllocationFraction: calculation([equation('Heat allocation', 'H_slab = α_normal × H;  H_res = (1 − α_normal) × H',
      'α_normal is the configured fraction under normal thermostat authority. Override OFF does not mean that every heating circuit is closed.')]),
  }[key];
}

export function sourceCalculation() {
  return { ...calculation([
    equation('Compressor heat output', 'Q(T_water) = 9.40 − 0.016 × (T_water − 35)',
      'Q is thermal kW while the compressor runs; T_water is supply temperature in °C.'),
    equation('Compressor electrical input', 'P(T_water) = 9.40 / 4.24 + [(9.24 / 3.51 − 9.40 / 4.24) / 10] × (T_water − 35)',
      'P is electrical kW at the manufacturer’s test boundary, including its circulation pumps.'),
    equation('Coefficient of performance', 'COP(T_water) = Q(T_water) / P(T_water)',
      'COP relates the source’s heat output to electrical input. It is separate from the learned house response g.'),
    equation('Space-heating electricity', 'P_space = d × P(T_water) + A',
      'd is routed compressor duty (0–1); A is space-heating AUX electrical kW. The manufacturer boundary already includes circulation pumps, so they are not added again.'),
  ], [
    'Published reference points: incoming brine 0 °C; at 35 °C water, 9.40 kW heat and COP 4.24; at 45 °C water, 9.24 kW heat and COP 3.51.',
    'The map interpolates from 35–45 °C. Only 30–35 and 45–50 °C use provisional extrapolation. Automatic preheat requires known supply temperature and a projected supply within 30–50 °C.',
    'For degraded observations, missing supply uses 35 °C; out-of-range supply retains its actual value but evaluates the nearest 30/50 °C boundary with extra uncertainty. Both source points have the same brine temperature, so they cannot identify a brine correction. Missing brine stays unknown.',
    'Example: at 40 °C supply, 50% compressor duty and 3 kW AUX produce an estimated 7.66 kW thermal. The shared response applies to that heat; compressor and AUX electrical use remain separate.',
    'The default house-response prior is 0.75 / 9.40 ≈ 0.0798 °C/kWh thermal. Neither this prior nor the source map is a heat-meter reading. DHW routing and independently scheduled recirculation remain outside this space-heating calculation.',
  ], 'Performance map & electrical input'), reference: {
    label: 'Danfoss technical data · DHP-H 10, pages 107–108',
    href: 'https://assets.danfoss.com/documents/latest/29671/AN000086466221en-010701.pdf',
  } };
}

export function heatBalanceCalculation(model = {}) {
  const floor = model.floor?.enabled;
  const equations = [equation('Indoor temperature', floor
    ? 'dT_in/dt = −L_net + J + F + X + g × F_slab' : 'dT_in/dt = −L + J + F + X',
  'Temperature rates are in °C/h. L is envelope cooling, J is solar warming, F is fireplace warming and X is release from the reserve. Their coefficient calculations define each term.')];
  if (floor) equations.push(
    equation('Remaining building reserve', 'dT_res/dt = [(1 − α) × H − X / g] / C_res',
      'H is hydronic thermal kW; α selects the confirmed-override or normal allocation; C_res is the fixed remaining capacity in kWh/K.'),
    equation('Selected slab', 'dT_slab/dt = [α × H − F_slab − F_ground] / C_slab',
      'The configured slab exchanges heat with the room and ground. Its state persists when the override ends.'),
    equation('Above-ground envelope', 'L_net = k × (T_in − T_out)',
      'The current coefficient describes the above-ground envelope. The configured ground path is separate; no loss is subtracted or converted from an older fit.'),
  );
  else equations.push(equation('Building reserve', 'dT_res/dt = (g × H − X) / (a × τ)',
    'H is hydronic thermal kW. a × τ is the fixed reserve-to-room capacity ratio; all hydronic heat enters this slow reserve before reaching the room.'));
  equations.push(equation('Hot-water heat reaching rooms', 'H_DHW→rooms = 0',
    'Tank, hot-water use and recirculation losses contribute no room heat in this model. This fixed simplification does not mean those physical losses are zero.'));
  return calculation(equations, ['The implementation advances these rates in small time steps. Reserve and slab temperatures are latent model states, not direct sensor readings. Opening circuits changes heat allocation; it does not add material capacity or reset stored energy.']);
}

export function preheatCalculation() {
  return calculation([
    equation('Bounded ROOM increase', 'b = min(b_configured, max(0, ROOM_max − ROOM_baseline)); ROOM_request = ROOM_baseline + b',
      'The default configured increase is 5 °C. ROOM_baseline is the saved normal native setting; ROOM_max is the verified writable upper bound. Repeated preheat commands do not accumulate increases.'),
    equation('Forecast supply temperature', 'T_water,preheat = T_water,normal + 3 × b',
      'Temperatures are in °C. This fixed forecast prior changes the source-map operating point and predicted demand; it is not a measured heating curve or a direct heat input.'),
  ], ['ROOM is a heating-demand setting. Room-air limits remain separate, with default maximum occupied drop and rise both 1.5 °C. Normal DHWR scheduling continues during preheat; the ROOM and valve deadlines do not depend on the circulation pulse timer.']);
}

export function recoveryHoldCalculation() {
  return calculation([
    equation('One recovery deadline', 't_release = t_reduction_end + hold_minutes',
      'Use consistent time units. The default hold is 60 minutes after tariff reduction ends. The deadline remains fixed while the controller refreshes its decisions.'),
    equation('Reduced hot-water settings', 'start_hold = min(start_normal, 40 °C); stop_hold = 50 °C',
      'These native settings remain reduced during tariff reduction and the recovery hold. The stop register may govern AUX operation only; 50 °C is not an established compressor hot-water cutoff.'),
  ], ['During the hold, normal ROOM and tariff operation allow compressor recovery and automatic DHWR starts are suppressed. The AUX restriction applies when enabled; cold-room protection can release AUX permission early while reduced DHW settings and DHWR suppression retain their original deadline.',
    'At the deadline, captured normal DHW and operating-mode settings are restored and normal DHWR eligibility resumes. This does not force an immediate circulation pulse or end the thermal recovery assessment. Native AUX permission applies to the heat pump as a whole; it is not a space-heating-only command.',
    'For hot water before the deadline, pause price control: this selects Normal heating and restores the captured native DHW settings. Start a timed circulation run if needed. A setting changed directly on the heat pump is respected; app parameter edits are available after pausing. The hold is an engineering setting, not a learned recovery time.']);
}

export function hotWaterCalculation() {
  return calculation([equation('DHW contribution to the house model', 'H_DHW→rooms = 0',
    'Thermal power in kW. Compressor and AUX activity routed to hot water is excluded from space-heating input. Tank and recirculation losses receive no room-heating credit.')],
  ['This fixed simplification keeps the room/slab model focused on space heating. It does not assert that physical hot-water heat losses vanish. Hot-water demand, delivered service and tank recovery are not matched between the action and its reference.']);
}

export function outcomeCalculation(key) {
  const cost = 'Costs are in cents. The displayed mean is in €/cycle and uses only qualifying assessments among the latest 30 completed cycles; n is that assessment count.';
  return {
    indoorTemperature: comfortReferenceCalculation(),
    profit: calculation([equation('Mean assessed benefit', 'benefit = Σ(C_reference − C_executed) / (100 × n)', cost)],
      ['Both sides include space-heating recovery. Executed electricity uses recorded equipment states and estimated power unless metered; the unexecuted reference remains modeled. Incomplete attempts do not enter this mean.']),
    auxProfit: calculation([equation('Mean for AUX-recovery cycles', 'benefit_AUX = Σ(C_reference − C_executed) / (100 × n_AUX)', cost)],
      ['The subset requires observed space-heating AUX during recovery. This is each qualifying cycle’s total space-heating benefit, not the saving attributable to AUX alone. No qualifying cycles means unavailable.']),
    recoveryError: calculation([equation('Mean absolute recovery error', 'error = Σ|C_predicted,recovery − C_executed,recovery| / (100 × n)', cost)],
      ['The prediction was saved before execution. An altered schedule or inadequate coverage cannot qualify as an unchanged advance prediction. Lower error indicates closer cost prediction; it does not establish savings.']),
  }[key];
}

export function dutyCalculation() {
  return calculation([
    equation('Native-demand prior', 'd_native = clamp([k × (T_in − T_out) + 0.25 × (T_ref + b − T_in)] / [g × Q(T_water)], 0, 1)',
      'Temperatures are in °C; b is the requested ROOM increase during preheat. The 0.25/h feedback term is fixed. The prior balances modeled loss and comfort demand against estimated compressor heat. clamp(x, 0, 1) limits x to the 0–1 duty range.'),
    equation('Requested-mode response', 'd = clamp(r_phase × d_native, 0, 1)',
      'r_phase is the episode-weighted response ratio for the matching treatment. Without an available matching ratio the prior is 1; requested reduction alone does not prove that heating stopped.'),
  ], ['Fresh native demand can replace this estimate for a short step of at most one hour. Current-state thermal fitting instead uses observed routed duty whenever available.']);
}

export function economicCalculation(strategyId) {
  const strategy = HEATING_STRATEGIES.find(option => option.id === strategyId);
  return calculation([
    equation('Electrical energy and cost', 'E = Σ(P_space × Δt);  C = Σ(P_space × Δt × price) + C_tail',
      'P_space is electrical kW; Δt is hours; price is cents/kWh. E is kWh and C is cents. C_tail prices any remaining thermal deficit against the normal reference.'),
    equation('Conservative benefit', 'B_low = B_nominal − max(5, B_nominal − min(B_nominal, B_stress−, B_stress+))',
      'Benefits are reference cost minus action cost in cents. The same two physical stress directions are applied to both paths; a residual 5-cent allowance remains.'),
    equation('Starting hurdle', 'hurdle = minimum_benefit + discomfort_weight × D + 2 × extra_hours + 2 × start',
      `${strategy ? `${strategy.label}: minimum_benefit = ${strategy.minimumHomeBenefitCents} ct and discomfort_weight = ${strategy.homeDiscomfortCentsPerDegreeSquaredHour} ct/(°C²·h). ` : ''}D is the positive additional weighted hot/cold discomfort in °C²·h, summed separately by room and direction. start is 1 for a new intervention against normal operation. These are decision allowances, not actual electricity charges.`),
    equation('Admission and preference', 'admit if B_low > hurdle;  retain B_low ≥ best_B_low × retained_fraction',
      `Physical limits and evidence checks must also pass. From a bounded shortlist, prefer the mildest admitted plan retaining ${strategy ? `${strategy.retainedBenefitFraction * 100}%` : 'the strategy’s required share'} of the best positive conservative benefit. Temperature variation is compared first, then active duration.`),
  ], ['During continuation the starting minimum and start allowance are omitted; remaining discomfort and duration still count. Gentle is not an off switch. Pause or operating mode controls whether optimization runs.',
    'The stress directions vary heat response and loss by 15%, initial reserve/slab by 0.5 °C, duty by 0.08, source electricity by its operating-point allowance, and AUX exposure by 50%. These cases are engineering allowances, not calibrated probabilities or a guarantee of annual savings.']);
}

export function comfortReferenceCalculation() {
  return calculation([
    equation('Stable-temperature candidate', 'T_candidate = round₀.₁(T_sorted[floor(0.75 × (n − 1))])',
      'Sort the n qualifying plateau temperatures from lowest to highest, using zero-based indexing. The selected upper-quartile reading is rounded to 0.1 °C.'),
    equation('Gradual later adjustment', 'ΔT_ref = sign(T_candidate − T_ref) × min(|T_candidate − T_ref|, 0.2 × min(24, h_new) / 24)',
      'h_new is newly earned plateau evidence in hours. Each qualifying update can move the retained reference by at most 0.2 °C; reused observations earn no further movement.'),
  ], ['The initial reference needs 24 hours of uninterrupted occupied normal heating, with a stable plateau over the latest 12 hours. Later candidates use 8 hours of normal operation and a 6-hour plateau. The plateau spans at most 0.4 °C, and its two halves differ in mean temperature by at most 0.15 °C.',
    'Later adjustment requires at least 24 hours of newly covered plateau evidence spread over at least 48 hours, with candidate temperatures within 0.3 °C. Preheat, recovery and material logged fireplace influence are excluded. Verified space-heating activity supports the reference; sustained cool weather can provide a provisional substitute when telemetry is insufficient.']);
}

export function inputCalculation(key) {
  if (key === 'model_hydronic_heat') return coefficientCalculation('hydronicCPerKwh');
  if (key === 'model_fireplace_release') return calculation([
    equation('Cumulative release from one load', 'C_raw(t) = 1 − [18 × exp(−t/18) − 2 × exp(−t/2)] / 16',
      't is elapsed time in hours. C(t) is 0 before ignition, C_raw(t) / C_raw(120) between 0 and 120 hours, and 1 thereafter.'),
    equation('Average release during an interval', 'r̄ = Σ m_i × [C(t_end − t_i) − C(t_start − t_i)] / Δt',
      'm_i is logged fuel in kg, t_i is its ignition time and Δt is interval duration in hours. r̄ is the pooled fuel-equivalent release in kg/h; overlapping loads add together.'),
  ], ['The fixed curve uses a 2-hour burn scale and an 18-hour release scale, normalized over a 120-hour horizon. The learned fireplace coefficient converts this release to a temperature-model input. These are logged kilograms and a delayed response, not measured delivered heat.']);
  return {
    model_indoor_temperature: calculation([equation('Configured indoor average', 'T_in = Σ(w_i × T_i) / Σw_i',
      'T_i is each contributing sensor temperature in °C; w_i is its configured positive weight. Zero-weight sensors do not contribute.')],
    ['Membership is fixed by configuration. A missing required sensor does not transfer its weight to the others: the learning average becomes unavailable. Held readings retain their original observation times; required report coverage must remain complete.']),
    model_solar_radiation: calculation([equation('Interval radiation', 'Ī = Σ(I_j × Δt_j) / Δt',
      'I_j is forecast global radiation in W/m² during covered segment j. Δt is the complete interval duration; incomplete forecast coverage remains unavailable.')]),
    model_compressor_duty: calculation([equation('Routed compressor duty', 'd = space-heating compressor runtime / interval duration',
      'd ranges from 0 to 1; the chart displays 100 × d percent. Runtime and interval duration use the same units.')],
    ['Recorded compressor activity is intersected with recorded hot-water routing. Known non-space-heating activity contributes zero; missing routing while the compressor runs remains unknown.']),
    model_auxiliary_power: calculation([equation('AUX electrical estimate', 'A = P_rated × output / 100',
      'P_rated is configured heater capacity in kW; output is recorded percent. Values within 2 percentage points of a third-stage boundary are snapped to 0, ⅓, ⅔ or full rated output.')],
    ['Space-heating routing selects the part used by the house model. This is an estimate from recorded output and nominal capacity; it is not a heat-meter measurement.']),
    model_room_boost: calculation([equation('Recorded ROOM increase', 'b = ROOM_requested − ROOM_baseline',
      'b is the temporary change in the heat pump’s ROOM demand setting, in °C. It is separate from measured room-air temperature.')],
    ['Preheat requests the configured increase above the saved normal ROOM setting, default +5 °C, within verified native bounds. ROOM changes affect predicted equipment demand and supply temperature; they do not add a direct temperature-model heat term.']),
  }[key];
}

export function validationCalculation(key) {
  if (key === 'thermal' || key === 'Temperature prediction') return calculation([
    equation('Temperature trajectory error', 'MAE_T = Σ(|T_predicted,i − T_observed,i| × Δt_i) / ΣΔt_i',
      'The result is in °C. Each genuine observed endpoint is weighted by its preceding covered duration; held copies do not create new temperature observations.'),
    equation('Largest observed error', 'error_max = max_i |T_predicted,i − T_observed,i|',
      'This maximum is over eligible later trajectory blocks. The comparison baseline holds each block’s initial indoor temperature constant.'),
  ], ['Each checked trajectory starts once and advances with recorded heat input. Eligible blocks need continuous coverage and sufficient earlier thermal warmup. This checks temperature response conditional on observed equipment use, separately from a forecast of future equipment use or cost.']);
  if (key === 'equipment' || / equipment response$/.test(key)) return calculation([
    equation('Learned treatment response', 'r = [3 + Σ clamp(D_j / N_j, 0, 2)] / (3 + n_train)',
      'D_j is observed compressor duty-hours and N_j is the native-demand prior’s duty-hours for training episode j. The three prior-equivalent episodes favor unchanged demand, r = 1.'),
    equation('Mean episode duty error', 'MAE_d = mean_j |Σ_i(d_predicted,i − d_observed,i) × Δt_i / h_j|',
      'h_j is episode duration. Later episodes receive equal weight; intervals within each episode are duration-weighted. Multiply by 100 for percentage points.'),
    equation('Within-episode timing error', 'MAE_interval = mean_j [Σ_i |d_predicted,i − d_observed,i| × Δt_i / h_j]',
      'Taking the absolute error before summing also exposes opposing timing errors that cancel in mean episode duty.'),
  ], ['Training and later checks use completed episodes with the matching hydraulic treatment. Supported duration must be demonstrated by at least three training and three later episodes. The check conditions on recorded temperatures and requested mode; it does not validate a forecast made before the cycle.']);
  if (key === 'advance' || key === 'Forecast saved before the cycle') return calculation([
    equation('Frozen temperature prediction', 'MAE_T = mean_cycles [Σ_i |T_frozen,i − T_observed,i| × Δt_i / ΣΔt_i]',
      'The result is in °C. Each eligible cycle is equally weighted; its temperature error is weighted by observation duration.'),
    equation('Frozen energy prediction', 'error_E = mean_cycles |E_frozen − E_executed| / E_executed',
      'E is space-heating electrical energy in kWh. Cycles need at least 0.1 kWh executed energy for this comparison; multiply by 100 for percent.'),
    equation('Frozen cost prediction', 'error_C = mean_cycles |C_frozen − C_executed| / max(5, |C_executed|)',
      'C is space-heating cost in cents. The 5-cent denominator floor avoids unstable percentages around zero cost.'),
  ], ['These summaries use at most 30 eligible completed episodes, with the original model, forecast and unchanged schedule. The largest cycle error in minimum indoor temperature is also checked. Recorded electricity may still be estimated from equipment states and nominal powers; forecast accuracy does not establish counterfactual savings.']);
  if (key === 'uncertainty' || key === 'Forward uncertainty') return calculation([
    equation('Forward temperature allowance', 'U(h) = U_observed(h) + g × Q × ε_source × √h / 4 + U_floor + U_action + U_solar + r̄ × h × δf',
      'U is in °C and h is hours. g is hydronic response, Q is compressor thermal kW, ε_source is the source-map allowance, r̄ is fireplace release in kg/h and δf is its gain allowance in °C/kg. The square-root terms are fixed engineering growth rules.'),
  ], ['The observed component uses the largest checked trajectory error plus 0.1 °C, with at least three supporting blocks and a 0.15 °C floor. Beyond supported horizons it grows by at least 0.05 °C/h. Without checked horizons it starts at 0.25 + 0.15√h °C.',
    'When an explicit slab is configured, its allowance is 0.15√h °C in every valve mode: switching the override off does not remove stored heat or its uncertainty. An unsupported non-normal action without observed duty adds 0.10√h °C; missing solar adds 0.08√h °C. These allowances and the separate paired economic stress cases are engineering safeguards, not calibrated probabilities.']);
  return undefined;
}

export function calibrationCalculation(key) {
  const weighting = 'α = 1 / min(20, n + 2), where n counts prior useful completed-episode updates, including episodes contributing other energy diagnostics. It is not just the number of AUX or metered episodes. clamp(x, lo, hi) keeps x within the stated bounds.';
  if (['auxiliary', 'Auxiliary exposure calibration'].includes(key)) return calculation([
    equation('Episode AUX correction', 'x_episode = clamp(x_frozen × E_AUX,executed / max(0.05, E_AUX,predicted), 0.2, 4)',
      'E is space-heating AUX electricity in kWh. x_frozen is the exposure scale saved with the cycle; recorded AUX output and known routing are required.'),
    equation('Updated AUX exposure scale', 'x_new = clamp(x_old + α × (x_episode − x_old), 0.2, 4)', weighting),
    equation('Forecast AUX power', 'A_predicted = min(P_rated, P_rated × risk × x_new)',
      'A_predicted and P_rated are electrical kW. risk combines native threshold, shortfall and recovery-demand assumptions; an applicable AUX restriction sets risk to zero.'),
  ], ['This adjusts predicted AUX exposure, not the shared response per thermal kWh. Episode electricity remains estimated from observed stages unless separately metered. Paired stress scenarios also vary AUX exposure.']);
  if (['recovery', 'Recovery electricity multiplier', 'Recovery diagnostic calibration'].includes(key)) return calculation([
    equation('Recovery correction excluding AUX', 'm_episode = clamp(m_frozen × (E_executed − E_AUX,executed) / (E_predicted − E_AUX,predicted), 0.75, 4)',
      'All energies are recovery electricity in kWh; the predicted non-AUX component must be at least 0.25 kWh. Subtracting AUX prevents attributing the same extra energy to both calibrations.'),
    equation('Updated recovery diagnostic', 'm_new = clamp(m_old + w × (m_episode − m_old), 0.75, 4)',
      `w is α for metered energy and min(α, 0.2) for estimates. ${weighting}`),
  ], ['The retained multiplier summarizes recovery-energy mismatch. It is a reporting diagnostic and is not applied as an extra heat gain or multiplier in the current trajectory predictor.']);
  if (['electricity', 'Electricity uncertainty allowance'].includes(key)) return calculation([
    equation('Measured-episode discrepancy', 'e = |E_executed − E_predicted| / E_predicted',
      'E is space-heating electricity in kWh. This update requires explicitly metered executed energy and predicted energy above 0.1 kWh.'),
    equation('Updated relative allowance', 'u_new = clamp(max(1.5e, u_old + α × (1.5e − u_old)), u_floor, 1.5)',
      `u_floor is 0.4 until six measured episodes, then 0.2. ${weighting}`),
    equation('Reported path cost allowance', 'U_cost = max(5, u × [Σ|C_interval| + |C_tail|] + U_unobserved_AUX)',
      'All costs are in cents. Without H66 availability, U_unobserved_AUX adds 0.5 × predicted AUX kWh × the nonnegative peak tariff; otherwise that term is zero.'),
  ], ['The initial relative allowance is 0.6. Unexpected observed AUX after a near-zero AUX prediction raises it to at least 0.6. It supports reported path and cycle-assessment uncertainty; automatic economic admission uses its separate paired physical stress cases and residual 5-cent floor. It is neither meter accuracy nor a confidence level.']);
  return undefined;
}

export function fittingCalculation() {
  return calculation([
    equation('Parameter-fitting objective', 'J = mean_i {[(T_predicted,i − T_observed,i) / Δt_i]²} + 0.0001 × Σ_p [(p − p_seed) / max(0.02, p_seed)]²',
      'Temperatures are in °C and Δt_i is interval duration in hours. The first term averages squared error rates across eligible observation intervals; the small second term discourages unsupported movement from the configured seeds.'),
  ], ['Only independently supported heat-loss, combined hydronic, solar and fireplace coefficients can change, within fixed bounds. The fitting objective starts each interval from its observed indoor temperature while carrying the slow states forward; later trajectory validation uses full rollouts instead.',
    'The chronological split begins near 70% training and 30% later data, then respects day and episode boundaries, preserves independent completed episodes and leaves 12 hours between training and scored validation. An accepted update must also pass later error checks. Fixed source and storage assumptions are not fitted, and acceptance alone does not establish action readiness.']);
}
