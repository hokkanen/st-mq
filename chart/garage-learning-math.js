/** Explanations follow the current Garage cooling, validation and planner equations. */
const calculation = (equations, paragraphs, summary = 'Calculation & limits') => ({
  summary, equations: equations.map(([expression, legend]) => ({ expression, legend })), paragraphs,
});
const cooling = calculation([
  ['T_next = T_out + (T_now − T_out) × exp(−k × hours)', 'Local air temperatures in °C; k is the independently learned rear or front cooling rate in 1/h.'],
  ['uncertainty = max(error floor, observed OFF RMSE) × √hours', 'Rear floor 0.2 °C, front floor 0.3 °C. Missing validation uses wider initial assumptions.'],
], ['Only clean OFF observations fit k. Door disturbances, charging heat and missing reports exclude intervals. A changed reading is never counted repeatedly as independent temperature evidence.',
  'Validation freezes the model before an OFF episode, follows cooling and recovery, and checks the measured temperatures. It uses observed ambient conditions, so this is conditional model validation, not proof that a future weather forecast is correct.']);
const electricity = calculation([
  ['avoided energy = normal electrical power × OFF hours', 'kW × hours gives kWh; normal power is a qualified observed average when available, otherwise an explicit assumption.'],
  ['net benefit = avoided cost − recovery cost − uncertainty allowance', 'Each energy interval uses its dated electricity price. Recovery includes accumulated heat debt on a continuing pause.'],
], ['A prospective saving must exceed the configured minimum. Missing electrical metering leaves the euro result provisional even when cooling predictions validate.',
  'Compressor activity, frequency and room temperature do not establish electrical power or delivered thermal output.']);
const recovery = calculation([
  ['T_next = T_normal + (T_now − T_normal) × exp(−hours / recovery time)', 'A fixed illustrative air-temperature envelope after native heating becomes available.'],
  ['recovery pricing hours = max(3, 1.25 × OFF hours, minimum normal-heating hours)', 'The electricity allowance is accounted for over the full pricing period; the three-hour temperature time scale cannot declare recovery complete.'],
], ['Readiness requires observed recovery at both sensors and in both independent pipe reserves. Native ON only permits heating; it does not prove useful warmth.',
  'Normal references come from clean settled heating observations and adapt gradually; they are distinct from the thermostat setting.']);
const pipe = calculation([
  ['C = water mass × 4180 + copper mass × 385', 'Heat capacity per metre in J/(m·K), calculated from the configured pipe diameter and wall thickness.'],
  ['heat transfer = surface area × coefficient × (air − pipe temperature)', 'Cooling uses twice the nominal conductance; warming uses half. The reserve follows the local temperature trajectory.'],
], ['Rear and front pipe estimates have separate histories. This is a conservative reference pipe, not a measurement of plumbing temperature.',
  'The configured margin, current reserve, local OFF lease and useful-heating delay all constrain permission. Latent heat represents freezing debt, not extra available warmth. Missing fresh evidence requests normal heat.']);
const evidence = calculation([
  ['RMSE = √mean(prediction error²)', 'Reported episode errors summarize clean validation episodes; temperature error is in °C.'],
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
  if (/cooling-rate|temperature-prediction/.test(key)) return cooling;
  if (/cooling-error|complete-clean|thermal-pause-duration|active-episode/.test(key)) return evidence;
  if (/electricity-prediction|normal-pump-power|heat-pump-input|minimum-savings/.test(key)) return electricity;
  if (/^normal-.*-warmth$|recovery-time|recovery-energy-factor|normal-heating/.test(key)) return recovery;
  if (/local-allowance|protection-policy/.test(key)) return pipe;
  if (/charger-\d-input|charger-heat-fraction/.test(key)) return calculation([
    ['estimated charger heat = recorded electrical power × 0.075', 'Each charger is assessed separately in kW. This fixed assumption is not measured vehicle heat.'],
  ], ['Charging excludes cooling fitting and new savings pauses. Future charging contributes no warmth to the safe-pause forecast; missing charger power is unknown rather than zero.']);
  if (/reconstruction|model-version/.test(key)) return record;
  if (/temperature|heating-availability|doors-and-local/.test(key)) return measurements;
  return decisions;
}
