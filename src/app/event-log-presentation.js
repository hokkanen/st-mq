import { chargingFindingLabel, chargingPhysicalLabel } from '../charging/report-presentation.js';
import { GARAGE_NATIVE_SETTINGS } from '../garage/native-settings.js';
import { heatingErrorCode, heatingErrorMessage } from '../domain/heating-errors.js';

const numberFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const number = value => Number.isFinite(value) ? numberFormat.format(value) : null;
const reading = (value, unit) => number(value) === null ? null : `${number(value)}${unit ? ` ${unit}` : ''}`;
const detail = (label, value) => value === null || value === undefined ? [] : [{ label, value: String(value) }];
const lookup = (map, value) => typeof value === 'string' && Object.hasOwn(map, value) ? map[value] : undefined;
const phase = value => lookup({ normal: 'Normal heating', preheat: 'Preheating', reduction: 'Reduced heating', recovery: 'Recovery heating', circulation: 'Hot-water circulation' }, value) ?? 'Heating';
const register = value => lookup({ '0203': 'ROOM temperature', '0208': 'Hot-water stop temperature', '0212': 'Hot-water start temperature', '2201': 'Operating mode' }, value) ?? 'Native setting';
const reason = value => lookup({ 'automatic-control-disabled': 'Automatic heating was paused.', 'restart-with-automation-disabled': 'Restoration was checked after restart with Automatic paused.',
  'model-rebuilding': 'The learning model was being rebuilt.', 'execution-not-established': 'Command execution was not established.',
  'insufficient-cycle-energy-coverage': 'Recorded energy coverage was incomplete.', 'sensor-measurement-changed': 'A sensor change interrupted this cycle.',
  'native-room-setting-changed': 'A native ROOM setting change invalidated the applicable response evidence.', 'source-expired': 'Source evidence expired.',
  'missing-report': 'An expected source report was missing.', 'command-failed': 'Command confirmation was unavailable.',
  'heating-paused': 'Automatic heating was paused.', 'manual-heating-override': 'An explicit manual heating choice was active.',
  'recent-cycle-incomplete': 'The previous cycle had an incomplete outcome.', 'native-settings-changed': 'A separately observed native setting changed.',
  'missing-or-stale-observations': 'Fresh temperature observations were unavailable.', 'missing-or-stale-indoor': 'A fresh indoor temperature was unavailable.',
  'estimated-indoor-thermal-state-unavailable': 'The indoor estimate lacked continuous evidence for planning.',
  'trial-needs-measured-indoor-temperature': 'A learning trial required measured indoor temperatures.',
  'hard-comfort-limit': 'The occupied comfort protection limit was reached.', 'indoor-comfort-limit': 'The indoor average reached its permitted comfort limit.',
  'heat-pump-alarm': 'The heat pump reported an alarm.', 'native-mode-not-space-heating': 'The native mode did not permit space heating.',
  'complete-cycle-in-progress': 'The complete heating cycle was still in progress.', 'preheat-readback-unavailable': 'Preheat device readback was unavailable.',
  'control-or-forecast-coverage-lost': 'Required control or forecast coverage was lost.', 'predicted-comfort-limit': 'The continued cycle was predicted to cross a comfort limit.',
  'trial-exposure-now-exceeds-allowance': 'The learning trial would exceed its cost allowance.', 'recovery-cost-now-favours-ending': 'The current recovery assessment favoured ending the cycle.',
  'awaiting-normal-temperature-reference': 'The normal occupied temperature reference was not established.',
  'awaiting-fireplace-response-evidence': 'The model was waiting for firewood response evidence.',
  'missing-or-incomplete-price-weather-horizon': 'The price or weather horizon was incomplete.', 'awaiting-tariff-response-evidence': 'The model was learning the heat-pump response to tariff control.',
  'normal-operation-preferred': 'Continuous normal operation was preferred.', 'continuous-normal-preferred': 'Continuous normal operation was preferred.',
  'bounded-learning-trial': 'A bounded learning trial was selected.', 'predicted-full-cycle-benefit': 'The forecast assessment supported a complete-cycle benefit.',
}, value) ?? null;
const fixed = (area, title, summary, { severity = 'info', evidence = 'Recorded application event', important = true } = {}) => ({ area, title, summary, severity, evidence, important, details: [] });
const DEFINITIONS = {
  'settings-reloaded': ['system', 'Configuration applied', 'The application applied the current configuration.'],
  'settings-reload-failed': ['system', 'Configuration could not be applied', 'Review the current configuration status. This event records the result at that time.', { severity: 'error' }],
  'settings-changed': ['system', 'Controller settings changed', 'Controller settings changed at this time.'],
  'configured-rates-applied': ['system', 'Configured prices applied', 'The configured tariff period was applied.'],
  'contract-period-added': ['system', 'Tariff period added', 'A dated tariff period was recorded.'],
  'controller-error': ['system', 'Controller update failed', 'A controller update failed. Current readiness and restoration are shown on the dashboard.', { severity: 'error' }],
  'provider-cache-rebuild': ['system', 'Source cache rebuilt', 'The replaceable source cache was rebuilt.', { important: false }],
  'learning-error': ['home', 'Learning could not finish', 'The learning worker failed. The committed journal remains the reconstruction source.', { severity: 'warning' }],
  'checkpoint-rebuild': ['home', 'Learning checkpoint rebuilt', 'A replaceable learning checkpoint was reconstructed from retained inputs.'],
  'equipment-response-reset': ['home', 'Heat-pump response evidence reset', 'A native ROOM setting change invalidated applicable response evidence.'],
  'restoration-pending': ['home', 'Heating restoration was unconfirmed', 'Restoration was pending at this time. This historical event does not establish its current state.', { severity: 'warning', evidence: 'Recorded restoration obligation' }],
  'control-execution-failed': ['home', 'Heating command was unconfirmed', 'The command or native readback could not be established. Check current restoration status.', { severity: 'error', evidence: 'Recorded command failure' }],
  'heating-test-requested': ['home', 'Heating action requested', 'A heating action was requested.', { evidence: 'Saved request' }],
  'heating-test-sent': ['home', 'Heating action dispatched', 'A heating action was dispatched. Dispatch alone does not establish a physical outcome.', { evidence: 'Command dispatch' }],
  'heating-test-failed': ['home', 'Heating action failed', 'The requested heating action could not be confirmed.', { severity: 'error', evidence: 'Recorded command failure' }],
  'h66-settings-confirmed': ['home', 'Heat-pump settings confirmed', 'The heat-pump controller reported the requested native settings.', { evidence: 'Device readback' }],
  'h66-native-setting-confirmed': ['home', 'Heat-pump setting confirmed', 'The heat-pump controller reported the requested native value.', { evidence: 'Device readback' }],
  'h66-external-setting-preserved': ['home', 'Native heat-pump setting preserved', 'A separately observed native setting was preserved. Its actor is not established by this event.', { evidence: 'Native setting observation' }],
  'cycle-started': ['home', 'Heating cycle started', 'A planned heating cycle began. Its final outcome is assessed separately.', { evidence: 'Recorded controller cycle' }],
  'cycle-completed': ['home', 'Heating cycle ended', 'The cycle ended. Any saving is an assessment, not a separate measured physical outcome.', { evidence: 'Recorded cycle assessment' }],
  'cycle-incomplete': ['home', 'Heating cycle interrupted', 'The cycle ended without a complete outcome assessment.', { severity: 'warning' }],
  'scheduled-cycle-rejected': ['home', 'Heating cycle was not admitted', 'The scheduled cycle did not pass the current admission checks.', { important: false }],
  'heating-scenario-approved': ['home', 'One-cycle heating scenario approved', 'A bounded heating scenario was approved. Approval is separate from execution.', { evidence: 'Saved instruction' }],
  'heating-scenario-cancelled': ['home', 'Heating scenario cancelled', 'The one-cycle scenario was cancelled.'],
  'heating-scenario-expired': ['home', 'Heating scenario expired', 'The one-cycle scenario reached its scope deadline.'],
  'heating-scenario-completed': ['home', 'Heating scenario ended', 'The one-cycle scenario ended.'],
  'garage-intent': ['garage', 'Garage heating selection recorded', 'A durable Garage heating selection was recorded. It is not a new native observation.', { important: false, evidence: 'Saved instruction' }],
  'garage-mode-changed': ['garage', 'Garage heating selection changed', 'The Garage heating selection changed.', { evidence: 'Saved instruction and command receipt' }],
  'garage-native-setting-requested': ['garage', 'Garage setting requested', 'A native Garage setting change was requested.', { evidence: 'Recorded command receipt' }],
  'garage-external-temperature-diagnostic': ['garage', 'Garage temperature-feed status changed', 'The Garage controller recorded a change in external-temperature evidence.', { severity: 'warning', evidence: 'Native diagnostic observation' }],
  'garage-pump-diagnostic': ['garage', 'Garage native diagnostic changed', 'Native diagnostic bytes changed. This is not an interpreted equipment fault.', { evidence: 'Native diagnostic observation', important: false }],
  'charging-session-check': ['charging', 'Charging energy comparison recorded', 'A finalized energy comparison was recorded separately from charging permission.', { evidence: 'Recorded energy assessment', important: false }],
  'charging-session-check-conflict': ['charging', 'Charging energy comparison conflicted', 'A finalized energy comparison conflicted with an existing record.', { severity: 'warning' }],
  'charging-energy-unallocated': ['charging', 'Charger energy could not be allocated', 'A measured meter increment lacked usable phase shares. Its phase energy remains unavailable.', { severity: 'warning', evidence: 'Measured meter increment' }],
  'history.imported': ['system', 'CSV history imported', 'Supported CSV source history was imported.'],
  'history-recovery-completed': ['system', 'History recovery completed', 'A verified history recovery was published.'],
  'history-recovery-reverted': ['system', 'Recovered history contribution excluded', 'A recovered contribution was excluded from the selected history. Original source records remain retained.'],
  'history-recovery-restored': ['system', 'Recovered history contribution restored', 'A recovered contribution returned to the selected history.'],
  'heat-pump-power-config': ['home', 'Heat-pump power assumptions recorded', 'Dated nominal power assumptions were recorded for historical interpretation.', { important: false, evidence: 'Configured assumptions' }],
  'simulated-command-readback': ['home', 'Simulated command outcome', 'The simulation produced a command outcome. This is not device evidence.', { important: false, evidence: 'Simulation' }],
};
for (const [type, area, subject] of [
  ['caravan-shutdown-restoration-pending', 'caravan', 'Caravan'], ['floor-shutdown-restoration-pending', 'home', 'Floor-heating'],
  ['h66-shutdown-restoration-pending', 'home', 'Heat-pump'],
]) DEFINITIONS[type] = [area, `${subject} restoration was unconfirmed at shutdown`, 'Restoration remained unconfirmed when the application stopped. Check current equipment status for its present state.', { severity: 'warning', evidence: 'Recorded restoration obligation' }];
for (const type of ['mqtt-error', 'mqtt-ha-error', 'mqtt-offline', 'mqtt-ha-offline', 'mqtt-observation-rejected', 'mqtt-subscribe-error', 'mqtt-shelly-subscribe-error', 'mqtt-garage-subscribe-error', 'mqtt-garage-sender-subscribe-error', 'mqtt-teslamate-subscribe-error', 'mqtt-snapshot-request-failed', 'mqtt-temperature-recovery-failed', 'mqtt-floor-unavailable']) {
  DEFINITIONS[type] = ['system', type.includes('offline') ? 'MQTT connection lost' : type.includes('subscribe') ? 'MQTT subscription unavailable' : 'MQTT acquisition needs attention',
    'The application recorded an acquisition problem. Current source health is shown on the dashboard.', { severity: 'warning', evidence: 'Recorded acquisition diagnostic' }];
}
DEFINITIONS['mqtt-connected'] = ['system', 'MQTT connection established', 'The MQTT transport connected. Individual subscriptions and device readiness are checked separately.', { evidence: 'Transport connection' }];
export const GENERAL_EVENT_TYPES = Object.freeze([...Object.keys(DEFINITIONS), 'decision', 'heating-phase-changed', 'heating-automation-changed', 'heating-pause-changed', 'heating-pause-ended', 'occupancy-changed', 'occupancy-expired', 'charging-control-changed', 'caravan-control-changed']);

export function presentGeneral(type, payload = {}) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  let out = Object.hasOwn(DEFINITIONS, type) ? fixed(...DEFINITIONS[type]) : fixed('system', 'Other recorded event', 'An event without a supported public explanation was recorded. Private payload details are omitted.', { important: false });
  if (type === 'decision') out = fixed('home', `${phase(p.phase)} assessed`, 'A routine controller decision was recorded. It is not independent device readback.', { important: false, evidence: 'Controller decision' });
  if (type === 'heating-phase-changed') {
    out = fixed('home', p.previousPhase === null ? `${phase(p.phase)} first recorded` : `${phase(p.phase)} requested`,
      'The controller recorded its heating phase. This is separate from native confirmation and physical heat delivery.', { evidence: 'Recorded controller phase' });
    if (validTime(p.expiresAt)) out.details.push(...detail('Scope ends', new Date(p.expiresAt).toISOString()));
  }
  if (type === 'heating-automation-changed') out = fixed('home', p.enabled === true ? 'Automatic heating enabled' : p.enabled === false ? 'Automatic heating paused' : 'Heating permission recorded', 'A durable dashboard choice was recorded. Its current scope is shown on the dashboard.', { evidence: 'Saved instruction' });
  if (type === 'heating-pause-changed') { out = fixed('home', 'Heating Pause changed', 'The dashboard Pause scope was recorded.', { evidence: 'Saved instruction' }); out.details.push(...detail('Resume at', validTime(p.pause?.expiresAt) ? new Date(p.pause.expiresAt).toISOString() : p.pause?.expiresAt === null ? 'No scheduled end' : 'Not recorded')); }
  if (type === 'heating-pause-ended') out = fixed('home', 'Scheduled heating Pause ended', 'The saved Pause deadline resumed Automatic heating for the same equipment. This does not establish heat delivery.', { evidence: 'Saved instruction expiry' });
  if (type === 'occupancy-changed') { out = fixed('home', p.occupancy?.mode === 'away' ? 'Away saved' : p.occupancy?.mode === 'occupied' ? 'Home saved' : 'Occupancy selection recorded', '', { evidence: 'Saved instruction' }); const at = typeof p.occupancy?.returnAt === 'string' ? Date.parse(p.occupancy.returnAt) : NaN; if (validTime(at)) out.details.push(...detail('Return at', new Date(at).toISOString())); }
  if (type === 'occupancy-expired') out = fixed('home', 'Scheduled Away ended', 'The saved return time restored the occupied selection.', { evidence: 'Saved instruction expiry' });
  if (type === 'garage-mode-changed') { out.title = p.mode === 'away' ? 'Garage Away selected' : p.mode === 'normal' ? 'Garage Normal selected' : out.title; out.details.push(...detail('Requested target', reading(p.targetC, '°C'))); }
  if (type === 'garage-native-setting-requested' && typeof p.setting === 'string' && Object.hasOwn(GARAGE_NATIVE_SETTINGS, p.setting)) {
    const labels = { power: 'Power', mode: 'Operating mode', targetC: 'Temperature target', fan: 'Fan speed', vane: 'Vertical vane', wideVane: 'Horizontal vane' };
    const values = { on: 'On', off: 'Off', heat: 'Heating', cool: 'Cooling', auto: 'Automatic', dry: 'Dry', fan: 'Fan only', quiet: 'Quiet', swing: 'Swing',
      'far-left': 'Far left', left: 'Left', center: 'Centre', right: 'Right', 'far-right': 'Far right', split: 'Split' };
    const definition = GARAGE_NATIVE_SETTINGS[p.setting];
    const valid = definition.values ? definition.values.includes(p.value) : Number.isFinite(p.value) && p.value >= definition.min && p.value <= definition.max;
    out.title = `Garage · ${labels[p.setting]} requested`;
    if (valid) out.details.push(...detail('Requested value', p.setting === 'targetC' ? reading(p.value, '°C')
      : typeof p.value === 'number' ? `${p.setting === 'fan' ? 'Speed' : 'Position'} ${p.value}` : values[p.value]));
  }
  if (type === 'garage-intent' && p.selection) out.details.push(...detail('Selection', lookup({ normal: 'Normal', away: 'Away' }, p.selection.mode)));
  if (type.startsWith('h66-')) out.details.push(...detail('Setting', p.register ? register(p.register) : null), ...detail('Confirmed value', reading(p.value, ['0203', '0208', '0212'].includes(p.register) ? '°C' : '')));
  if (type === 'h66-native-setting-confirmed') {
    out.details.push(...detail('Previous value', reading(p.previousValue, ['0203', '0208', '0212'].includes(p.register) ? '°C' : '')),
      ...detail('Original dispatch', validTime(p.dispatchedAt) ? new Date(p.dispatchedAt).toISOString() : null),
      ...detail('Native report received', validTime(p.receivedAt) ? new Date(p.receivedAt).toISOString() : null),
      ...detail('Source measurement clock', 'Not recorded'));
  }
  if (type === 'h66-settings-confirmed' && Array.isArray(p.registers)) {
    const fields = [...new Set(p.registers.filter(index => ['0203', '0208', '0212', '2201'].includes(index)).map(register))];
    if (fields.length) out.details.push(...detail('Confirmed settings', fields.join(', ')));
  }
  if (type.startsWith('heating-test-')) out.details.push(...detail('Action', phase(p.command)));
  if (type === 'heating-test-sent' && p.sent !== true) {
    out.title = p.status === 'waiting' ? 'Heating action waiting' : 'Heating action receipt recorded';
    out.summary = 'The recorded receipt did not establish a new command dispatch. Check its current control receipt for confirmation.';
    out.evidence = 'Recorded command receipt';
  }
  if (type === 'garage-external-temperature-diagnostic') {
    out.title = p.status === 'normal' ? 'Garage temperature feed recovered' : 'Garage temperature-feed diagnostic recorded';
    out.summary = p.status === 'normal' ? 'The native diagnostic reported normal temperature-feed status at this time.'
      : 'A native temperature-feed diagnostic was recorded. Its current state is shown on the Garage card.';
    out.severity = 'info';
  }
  if (type === 'cycle-completed') {
    const a = p.assessment;
    if (a && typeof a === 'object') {
      const cents = Number.isFinite(a.profitCents) ? `${number(a.profitCents / 100)} €` : 'Unavailable';
      out.details.push(...detail('Estimated space-heating saving', cents), ...detail('Uncertainty allowance', Number.isFinite(a.uncertaintyCents) ? `${number(a.uncertaintyCents / 100)} €` : null));
      if (a.profitCents === null) out.summary = 'The cycle ended, but retained evidence did not support a saving assessment.';
    }
  }
  if (type === 'charging-control-changed') {
    const label = p.chargerId === 'charger1' ? 'Charger 1' : p.chargerId === 'charger2' ? 'Charger 2' : 'Charging';
    const actions = { automatic: p.enabled === true ? 'Automatic enabled' : p.enabled === false ? 'Automatic disabled' : 'Automatic preference recorded', priority: 'Shared priority changed', pause: 'Pause requested',
      'charge-now': 'Charge now requested', resume: 'Charge now ended', 'use-automatic': 'Use automatic requested',
      'session-settings': 'Session planning values changed', 'extra-day': p.operation === 'cancel' ? 'Extra day cancelled' : p.operation === 'allow' ? 'Extra day allowed' : 'Extra-day instruction recorded' };
    out = fixed('charging', `${label} · ${lookup(actions, p.action) ?? 'Instruction saved'}`, 'A dashboard instruction or planning choice was saved. Native confirmation and physical response remain separate.', { evidence: 'Saved instruction' });
    const scopes = { automatic: 'Equipment-bound preference; persists across unplugging and restart.', priority: 'Shared equipment-bound preference; persists across unplugging and restart.',
      pause: 'Current physical connection; until unplugging or a superseding instruction.', 'charge-now': 'Current physical connection; immediate charging requested subject to readiness and limits.',
      resume: 'Current physical connection; Automatic scheduling is reassessed. Immediate charging is not implied.',
      'use-automatic': 'Current physical connection returns to scheduling, and the equipment-bound Automatic preference is enabled.',
      'session-settings': 'Current physical connection; configured defaults remain unchanged.', 'extra-day': 'Current physical connection and its selected deadline allowance.' };
    out.details.push(...detail('Scope', lookup(scopes, p.action)), ...detail('Original connection', validTime(p.connectedAt) ? new Date(p.connectedAt).toISOString() : null));
    out.details.push(...detail('Shared priority', lookup({ balanced: 'Balanced', charger1: 'Charger 1', charger2: 'Charger 2' }, p.priority)));
    for (const [key, label, unit] of [['manualSoc', 'Starting charge', '%'], ['minimumSoc', 'Target charge', '%'], ['capacityKwh', 'Usable capacity', 'kWh']]) out.details.push(...detail(label, reading(p.changes?.[key], unit)));
    // readyBy is a current clock string, not arbitrary native or source text.
    if (typeof p.changes?.readyBy === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(p.changes.readyBy)) out.details.push(...detail('Ready by', p.changes.readyBy));
  }
  if (type === 'caravan-control-changed') {
    const thresholdOnly = typeof p.enabled === 'boolean' && p.previous?.enabled === p.enabled;
    out = fixed('caravan', thresholdOnly ? 'Caravan power thresholds changed' : p.enabled === true ? 'Caravan Automatic power enabled' : p.enabled === false ? 'Caravan Automatic power disabled' : 'Caravan control choice recorded', 'The durable Caravan dashboard choice was recorded. This is separate from appliance state and recording readiness.', { evidence: 'Saved instruction' });
    out.details.push(...detail('Switch off at', reading(p.offAtC, '°C')), ...detail('Switch on at', reading(p.onAtC, '°C')));
  }
  const why = reason(p.reason); if (why) out.details.push(...detail('Reason', why));
  const cause = heatingErrorCode(p.code); if (cause) out.details.push(...detail('Recorded cause', heatingErrorMessage(cause)));
  if (Array.isArray(p.reasons)) for (const text of [...new Set(p.reasons.slice(0, 10).map(reason).filter(Boolean))]) out.details.push(...detail('Why', text));
  out.details.push(...detail('Data context', p.input === 'simulated' ? 'Simulation'
    : ['mqtt', 'providers'].includes(p.input) ? 'Physical-source input' : 'Not recorded for this event'));
  return out;
}
export const validTime = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;

const CHARGING_CODES = {
  connected: 'Connection observed', 'observation-started': 'Session observation began', unplugged: 'Unplug observed', interrupted: 'Session observation interrupted',
  'charging-started': 'Charging draw began', 'charging-observed': 'Charging draw observed', 'charging-stopped': 'Charging draw stopped', 'not-charging-observed': 'No charging draw observed',
  'physical-unknown': 'Charging draw unavailable', 'physical-evidence-lost': 'Charging evidence lost', 'physical-evidence-restored': 'Charging evidence returned',
  'target-confirmed': 'Charge target confirmed by vehicle', 'target-estimated': 'Charge target estimated', 'target-changed': 'Charge target changed',
  'deadline-missed': 'Ready-by target was missed', 'completion-unknown': 'Completion was unconfirmed',
  'sys-permission-interruption': 'Native system permission Stop observed', 'sys-pause-interruption': 'Native permission interrupted an owned pause',
  'sys-startup-recovery': 'Bounded startup recovery recorded', 'control-unconfirmed': 'Charger command was unconfirmed', 'charging-during-hold': 'Charging draw observed during a hold',
  'no-draw-while-allowed': 'No charging draw while permission allowed', 'vehicle-feed-stale': 'Vehicle evidence was unavailable', 'charger-feed-stale': 'Charger evidence was unavailable',
  'energy-coverage-gap': 'Charging energy coverage was incomplete', 'shared-current-mismatch': 'Reported current exceeded the active ceiling',
  'shared-priority-mismatch': 'Shared priority assessment did not match', 'shared-allocation-inconsistent': 'Shared allocation evidence was inconsistent',
  identified: 'Vehicle identified', completed: 'Identification completed', failed: 'Identification could not finish',
  'observation-gap': 'Session observation gap recorded',
  'shared-charging-evidence': 'Shared current evidence changed', 'shared-charging-context': 'Shared charging plan changed',
};
// Presentation only: every source event keeps its report-owned lifetime. Routine
// readback/allocation changes and repeated observations belong in All events.
const IMPORTANT_CHARGING_CODES = {
  session: ['connected', 'observation-started', 'unplugged', 'interrupted'],
  physical: ['charging-started', 'charging-stopped'],
  evidence: ['physical-evidence-lost', 'physical-evidence-restored', 'observation-gap'],
  vehicle: ['identified'], identification: ['failed', 'inconclusive'],
};
function importantCharging(p) {
  return ['finding', 'finding-update', 'recovery', 'outcome'].includes(p.kind)
    || Object.hasOwn(IMPORTANT_CHARGING_CODES, p.kind) && IMPORTANT_CHARGING_CODES[p.kind].includes(p.code);
}
export function presentCharging(row, p) {
  const charger = row.charger_id === 'charger1' ? 'Charger 1' : 'Charger 2';
  const label = chargingFindingLabel(p) ?? chargingPhysicalLabel(p) ?? lookup(CHARGING_CODES, p.code) ?? (p.kind === 'finding' || p.kind === 'finding-update' ? 'Finding recorded' : p.kind === 'recovery' ? 'Finding no longer active in this assessment' : 'Session event recorded');
  const finding = ['finding', 'finding-update'].includes(p.kind), physical = p.kind === 'physical';
  const simulated = row.namespace === 'charging:simulated:session-diagnostics';
  const physicalKnown = physical && ['charging-started', 'charging-observed', 'charging-stopped', 'not-charging-observed'].includes(p.code) && Number.isFinite(p.powerKw) && p.powerKw >= 0;
  const out = fixed('charging', `${charger} · ${label}`, simulated ? 'This charging-session entry was produced by the simulation. It is not physical device evidence.' : physicalKnown ? 'This entry records source evidence of draw at the time shown.'
    : physical ? 'Physical charging evidence was unavailable. Missing evidence does not establish that charging stopped.'
    : p.kind === 'recovery' ? 'A recorded finding ceased to apply. This does not establish the charger’s current condition.'
      : p.kind === 'outcome' ? 'The session report preserves the evidence and assumptions behind this outcome.'
        : finding ? 'Review the session report for the recorded circumstances and outcome. Native system provenance does not identify an actor.'
          : 'A charging-session milestone was recorded. Review its report for complete context.',
    { severity: finding ? 'warning' : 'info', evidence: simulated ? 'Simulation' : physicalKnown ? 'Measured power evidence' : physical ? 'Physical evidence unavailable' : p.kind === 'outcome' && p.code === 'target-confirmed' ? 'Vehicle observation' : 'Recorded session assessment', important: importantCharging(p) });
  out.details.push(...detail('Data context', simulated ? 'Simulation' : ['charging:mqtt:session-diagnostics', 'charging:providers:session-diagnostics'].includes(row.namespace) ? 'Physical-source input' : 'Not recorded for this event'));
  const source = lookup({ easee: 'Charger 1 telemetry', 'easee-ocpp': 'Charger 1 local OCPP', 'easee-equalizer': 'Equalizer-derived evidence',
    'shelly-evse': 'Native Charger 2 telemetry', 'bmw-cardata': 'Vehicle telemetry via BMW', teslamate: 'Vehicle telemetry via TeslaMate', simulation: 'Simulation' }, p.source);
  out.details.push(...detail('Evidence source', source ?? 'Not recorded or not recognized'));
  out.details.push(...detail('Measured power', physical ? reading(p.powerKw, 'kW') : null));
  if (['shared-charging-evidence', 'shared-charging-context'].includes(p.code)) {
    const execution = p.shared?.execution;
    out.details.push(...detail('Assessed current allowance', reading(execution?.expectedCurrentA, 'A')),
      ...detail('Reported current setting', reading(execution?.reportedCurrentA, 'A')),
      ...detail('Adjustment readiness', execution?.commandReady === true ? 'Ready' : execution?.commandReady === false ? 'Not ready' : 'Unknown'));
  }
  for (const [key, label] of [['measuredAt', 'Source observation'], ['receivedAt', 'Received']]) if (validTime(p[key])) out.details.push(...detail(label, new Date(p[key]).toISOString()));
  if (/^[a-f0-9]{64}$/.test(row.report_id)) out.related = { kind: 'charging-report', chargerId: row.charger_id, reportId: row.report_id };
  return out;
}

export function presentFirewood(row) {
  const out = fixed('home', row.kind === 'remove' ? 'Firewood entry removed' : 'Firewood added', row.kind === 'remove'
    ? 'A recorded firewood load was excluded from the selected corrected learning history. Original source evidence remains retained.'
    : 'A manual firewood load was recorded. Its heat contribution is an estimate.', { evidence: 'Manual source event' });
  out.details.push(...detail('Firewood', reading(row.kg, 'kg')), ...detail('Data context', row.input === 'simulated' ? 'Simulation'
    : ['mqtt', 'providers'].includes(row.input) ? 'Physical-source input' : 'Not recorded for this event')); return out;
}
export function presentSensor(p, input) {
  const change = p?.value?.sensorChange, reverted = p?.value?.sensorRevert;
  const labels = { indoor_temperature: 'Upstairs temperature', downstairs_temperature: 'Downstairs temperature', bedroom_temperature: 'Bedroom temperature', outdoor_temperature: 'Outdoor temperature' };
  const reasons = { replacement: 'Sensor replaced', moved: 'Sensor moved', calibration: 'Sensor calibration changed', other: 'Sensor measurement changed' };
  const out = fixed('home', reverted ? 'Sensor change reverted' : 'Sensor change recorded', reverted
    ? 'A sensor-change boundary was excluded from corrected learning. Original measurements and source events remain retained.'
    : 'A sensor measurement boundary was recorded for learning and its settling period.', { evidence: 'Manual source correction' });
  if (change) out.details.push(...detail('Sensor', lookup(labels, change.signal)), ...detail('Reason', lookup(reasons, change.reason)));
  out.details.push(...detail('Data context', input === 'simulated' ? 'Simulation' : ['mqtt', 'providers'].includes(input) ? 'Physical-source input' : 'Not recorded for this event'));
  return out;
}
