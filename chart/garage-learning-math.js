/** Explanations follow the current Garage cooling, validation and planner equations. */
const calculation = (equations, paragraphs, summary = 'Calculation & limits') => ({
  summary, equations: equations.map(([expression, legend]) => ({ expression, legend })), paragraphs,
});
const cooling = calculation([
  ['T_next = T_out + (T_now − T_out) × exp(−k × hours)', 'Local air temperatures in °C; k is the independently learned rear or front cooling rate in 1/h.'],
], ['Only clean OFF observations fit k. Door disturbances, charging and missing reports exclude intervals. Reusing a still-fresh reading does not create new temperature evidence.',
  'The displayed rates are used in cooling forecasts, including initial estimates before fitting. A learned rate is not yet a validated forecast: separate complete cooling and recovery episodes test it.',
  'Planning subtracts an uncertainty margin from each temperature forecast before projecting pipe warmth. When episode errors are available, the margin uses at least twice the episode forecast error, grows beyond the supported OFF duration and adds a penalty for forecast bias. Without episode errors, it grows by 0.2 °C per forecast hour at the rear and 0.3 °C at the front, with minimum margins of 0.2 °C and 0.3 °C respectively.',
  'Validation freezes the model before an OFF episode, follows cooling and recovery, and checks the measured temperatures. It uses observed ambient conditions, so this tests the cooling response, not future weather-forecast accuracy.']);
const electricity = calculation([
  ['avoided energy = normal electrical power × OFF hours', 'kW × hours gives kWh; normal power is a qualified observed average when available, otherwise an explicit assumption.'],
  ['extra recovery energy = avoided energy × 1.25', 'An assumed electricity allowance in addition to normal heating after the pause. This is not a learned efficiency or measured heat output.'],
  ['net benefit = avoided cost − recovery cost − uncertainty allowance', 'Each energy interval uses its dated electricity price. Recovery includes accumulated heat debt on a continuing pause.'],
], ['A prospective saving must exceed the configured minimum. Missing electrical metering leaves the euro result provisional even when cooling predictions validate.',
  'Recovery hours beyond published prices use the highest known price, with no negative-price credit. On a continuing pause, the planner compares continuing with restoring now and includes the recovery electricity already owed.',
  'Compressor activity, frequency and room temperature do not establish electrical power or delivered thermal output.']);
const recovery = calculation([
  ['T_next = T_normal + (T_now − T_normal) × exp(−hours / recovery time)', 'A fixed illustrative air-temperature envelope after native heating becomes available.'],
  ['recovery pricing hours = max(3, 1.25 × OFF hours, minimum normal-heating hours)', 'The electricity allowance is accounted for over the full pricing period; the three-hour temperature time scale cannot declare recovery complete.'],
], ['Another pause requires observed recovery at both sensors and in both independent pipe reserves. Native ON only permits heating; it does not prove useful warmth. The illustrative warming curve cannot refill a real-time reserve.',
  'Normal references start from the configured baseline and adapt using clean settled heating observations. Until enough observations qualify, these are starting estimates rather than established normal temperatures. They are distinct from the current thermostat setting.']);
const references = calculation([], ['Normal rear and front warmth are the temperatures achieved during clean, settled normal heating. The configured baseline supplies initial estimates; observations gradually replace them.',
  'Learning waits for at least eight hours of uninterrupted eligible normal-heating context and a settled rear temperature. Two qualified observation hours establish the references; later updates adapt slowly.',
  'The planner uses these references to judge heating demand and recovery. They also supply the target of the illustrative three-hour recovery curve. They are not requested room settings.'], 'How the reference is learned');
const pipe = calculation([
  ['C = water mass × 4180 + copper mass × 385', 'Heat capacity per metre in J/(m·K), calculated from the configured pipe diameter and wall thickness.'],
  ['heat transfer = surface area × coefficient × (air − pipe temperature)', 'Cooling uses twice the nominal conductance; warming uses half. The reserve follows the local temperature trajectory.'],
], ['Rear and front pipe estimates have separate histories. This is a conservative reference pipe, not a measurement of plumbing temperature.',
  'The configured margin, current reserve, local OFF lease and useful-heating delay all constrain permission. Latent heat represents freezing debt, not extra available warmth. Missing fresh evidence requests normal heat.']);
const evidence = calculation([
  ['episode RMSE = √(Σ(error² × interval hours) / Σ(interval hours))', 'Temperature error in °C, weighted by each source interval’s duration. The displayed error is the root mean square of these errors across clean validation episodes.'],
  ['supported OFF hours = min(second-longest training duration, longest supported passing validation duration)', 'Validation duration is also limited by the training support available when that episode began.'],
], ['Complete clean training and validation episodes are separate. A failed clean validation resets the usable passing-validation sequence. Larger uncertainty applies beyond observed durations; evidence is not an arbitrary maximum pause.',
  'Cooling passes require OFF RMSE no higher than 0.6 °C rear and 0.9 °C front, maximum errors no higher than 1.5 °C and 2 °C respectively, and observed recovery. Ongoing or disturbed episodes cannot establish readiness.']);
const measurements = calculation([], ['The value retains its source timestamp and quality. Fresh receipt alone does not turn an old measurement into a new observation.',
  'A missing, unsupported or stale input remains unknown. The planner must satisfy the relevant freshness and device checks again before starting or renewing an OFF permission.'], 'Sources & eligibility');
const decisions = calculation([], ['A pause is admitted only after price, weather, pump state, door state, local temperature and pipe-reserve checks agree. The decision is recalculated as fresh evidence arrives.',
  'The planned window is conditional, not a guaranteed duration. Protection can restore normal heating early, while a local expiring permission bounds communication failures.'], 'Decision & limits');
const record = calculation([], ['The committed Garage journal preserves ordered learning inputs, configuration and its initial seed. Matching current software applies the same update function during live learning and replay.',
  'A complete consistent database and matching algorithm are required to reconstruct the model. This does not recreate missing telemetry or prove physical delivery of attempted commands.'], 'Reconstruction & limits');
export function garageLearningCalculation(key) {
  if (/cooling-rate/.test(key)) return cooling;
  if (/temperature-prediction|cooling-error|complete-clean|thermal-pause-duration|active-episode/.test(key)) return evidence;
  if (/electricity-prediction|normal-pump-power|heat-pump-input|minimum-savings/.test(key)) return electricity;
  if (/^normal-.*-warmth$/.test(key)) return references;
  if (/recovery-time|normal-heating/.test(key)) return recovery;
  if (/recovery-energy-factor/.test(key)) return electricity;
  if (/protection-policy/.test(key)) return pipe;
  if (/charger-\d-input|charger-heat-fraction/.test(key)) return calculation([
    ['estimated charger heat = recorded electrical power × 0.075', 'Each charger is assessed separately in kW. This fixed assumption is not measured vehicle heat.'],
  ], ['This estimate describes a possible heat contribution in recorded inputs. It is not added to the cooling or recovery temperature equations, and is not a learned coefficient.',
    'Charging-disturbed intervals cannot fit clean cooling rates, but charging does not block savings pauses. Charging status and power do not change the planned window or add forecast warmth; actual warmth is reflected in measured temperatures. Missing charger power remains unknown in recorded learning inputs.']);
  if (/reconstruction|model-version/.test(key)) return record;
  if (/temperature|heating-availability|doors-and-local/.test(key)) return measurements;
  return decisions;
}
