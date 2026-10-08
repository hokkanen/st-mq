import { CHARGING_CONTROL_CAUSES as CONTROL_CAUSES } from './charging-status.js';
import { isReadOnlyReplica } from './replica-status.js';
import { projectChargingReportHistory, CHARGING_EVENT_FILTERS, chargingFindingCounts } from './charging-report-history.js';
import { chargingSharedText, chargingSharedSummary } from './charging-shared.js';

const OUTCOMES = { 'in-progress': 'Outcome not yet confirmed', 'target-confirmed': 'Target confirmed by vehicle',
  'target-estimated': 'Target estimated · awaiting vehicle evidence', 'deadline-missed': 'Target not reached by ready-by',
  'completion-unknown': 'Unplugged · completion unconfirmed', interrupted: 'Observation interrupted' };
const BEHAVIOR = { observing: 'Observing', expected: 'Observed checks passed', explained: 'Changes explained below',
  attention: 'Needs attention', 'insufficient-evidence': 'Evidence incomplete' };
const COVERAGE = { identification: 'Vehicle identification', initialRelease: 'Draw observed while charging allowed', pause: 'Intermediate pause',
  resume: 'Draw resumed after pause', lateReplan: 'Inputs reassessed after identification', targetAttainment: 'Requested target reached',
  completion: 'Native vehicle limit reached and stopped', energy: 'Recorded energy coverage' };
const FINDINGS = {
  'shared-priority-mismatch': ['Shared priority mismatch', 'A joint model did not reflect the selected shared priority. The shared charging event retains the proposed and adopted assessments.'],
  'shared-allocation-inconsistent': ['Shared allocation evidence inconsistent', 'A joint allocation or reported cost bound did not agree with its recorded inputs. This checks the model, not physical delivery.'],
  'shared-current-mismatch': ['Shared current limit not respected', 'Fresh Charger 2 current readback exceeded its active current ceiling after settling. Review the recorded shared context and charger evidence.'],
  'charging-during-hold': ['Charging during a planned pause', 'The charger continued drawing power after the pause settling period. Check the recorded plan and charger confirmation.'],
  'control-unconfirmed': ['Control remained unconfirmed', 'A command, readback or charger error remained unresolved beyond the settling period. An acknowledgement alone does not prove a physical response.'],
  'telemetry-unavailable': ['Physical evidence unavailable', 'Fresh charger readings were missing. Charging and stopping could not be assessed during this interval.'],
  'permitted-without-draw': ['Charging allowed, no draw observed', 'Charging permission was confirmed but the vehicle did not draw power for ten minutes. A vehicle timer, limit or another restriction is possible; its cause is unconfirmed.'],
  'vehicle-timer': ['Known vehicle start time', 'The reported vehicle start was still in the future while charger permission was open.'],
  'supply-unavailable': ['No reported supply allowance', 'The charger reported zero available current. This is separate from an economic pause.'],
  'manual-priority': ['Manual instruction has priority', 'The automatic plan was suspended while a manual charger instruction had priority.'],
  'target-conflict': ['Vehicle target readings disagree', 'The production target filter retained a stable target while conflicting vehicle readings were observed.'],
  'identification-inconclusive': ['Identification inconclusive', 'The identification attempt ended without a confirmed vehicle. Ordinary charging continued with the available inputs.'],
  'identity-unavailable': ['Vehicle identity no longer confirmed', 'The current connection lost its confirmed assignment. Previous readings do not establish a new match.'],
  'deadline-unverified': ['Ready-by outcome unconfirmed', 'The deadline passed without an applicable vehicle reading proving whether the requested target had been reached.'],
  'deadline-missed': ['Target missed at ready-by', 'An applicable vehicle reading after ready-by was below the requested target. Reaching the target later does not remove this event.'] };
const EVENTS = { connected: 'Connection observed', 'observation-started': 'Monitoring began during this connection',
  unplugged: 'Vehicle unplugged', 'connection-replaced': 'Connection changed', 'observation-gap': 'Observation gap',
  'physical-evidence-lost': 'Measured draw became unavailable', 'physical-evidence-restored': 'Measured draw available again',
  'charging-observed': 'Draw above 0.1 kW observed', 'not-charging-observed': 'No draw above 0.1 kW observed',
  'charging-started': 'Draw rose above 0.1 kW', 'charging-stopped': 'Draw at 0.1 kW or below observed', 'physical-unknown': 'Measured draw unavailable',
  'charger-reports-charging': 'Charger status reports charging', 'charger-reports-not-charging': 'Charger status reports not charging',
  'charger-status-unknown': 'Charger status unavailable',
  identified: 'Vehicle identified', waiting: 'Waiting', charging: 'Identification observing charge', pausing: 'Identification pause requested',
  observing: 'Identification awaiting matching reports', inconclusive: 'Identification inconclusive', completed: 'Identification completed',
  'initial-plan': 'Initial planning snapshot', 'target-changed': 'Requested target changed',
  'shared-charging-context': 'Both chargers and shared priority',
  ...OUTCOMES, ...COVERAGE };
const validTime = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15;
const timeFormatter = (timezone, seconds = false) => new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
const time = (value, timezone = 'Europe/Helsinki', seconds = false) => validTime(value)
  ? timeFormatter(timezone, seconds).format(value) : 'Unknown';
const number = value => Number.isFinite(value) ? Number(value.toFixed(4)) : null;
const percent = value => Number.isFinite(value) ? `${number(value)}%` : 'Unknown';
const vehicleName = value => ({ bmw: 'BMW', tesla: 'Tesla' })[value] ?? 'Unidentified';
const sourceName = value => ({ 'bmw-cardata': 'BMW', teslamate: 'TeslaMate', 'bmw-target-filter': 'BMW target filter',
  mqtt: 'Vehicle', vehicle: 'Vehicle', easee: 'Easee', 'easee-ocpp': 'Local OCPP', 'shelly-evse': 'Shelly EVSE' })[value] ?? null;
const STATE_LABELS = { disabled: 'Automatic off', unknown: 'Unknown', none: 'No charging periods',
  unavailable: 'Unavailable', release: 'Release requested', waiting: 'Waiting for a period', planned: 'Periods proposed',
  complete: 'Requested charge estimated complete', disconnected: 'Disconnected', manual: 'Manual instruction',
  observing: 'Observing only', observed: 'Observing only', released: 'Restriction released',
  'charge-now': 'Charge now', provisional: 'Provisional release' };
const SCHEDULE_LABELS = { none: 'No controller charging schedule', proposed: 'Proposed charging periods',
  installed: 'Controller execution plan', unknown: 'Schedule state unknown' };
const PLAN_CAUSES = { 'control-unsupported': 'Scheduling control is unsupported', disabled: 'Automatic charging is off',
  observing: 'Observing only', manual: 'Manual instructions have priority', released: 'Charging permission released',
  disconnected: 'Vehicle disconnected', unavailable: 'Planning reason unavailable', 'charge-now': 'Charge now requested',
  'cheapest-feasible-periods': 'Cheapest feasible charging periods', 'cheapest-feasible-start': 'Cheapest feasible charging start',
  'minimum-already-satisfied': 'Requested charge is already satisfied', 'vehicle-start-after-deadline': 'Vehicle start is after ready-by',
  'multiple-external-load-balancers': 'Multiple external load balancers cannot be allocated together',
  'connection-unavailable': 'Connection information is unavailable', 'electrical-telemetry-unavailable': 'Charging electrical inputs are unavailable',
  'equalizer-allowance-unavailable': 'Property current allowance is unavailable', 'insufficient-time': 'Forecast capacity cannot meet ready-by',
  'price-coverage-unavailable': 'Applicable electricity prices are unavailable', 'household-history-loading': 'Household forecast is being prepared',
  'household-history-unavailable': 'Household forecast is unavailable' };
const planningAssumptions = rows => (Array.isArray(rows) ? rows : []).filter(row => row?.code === 'maximum-available-current'
  && Number.isFinite(row.maximumCurrentA)).map(row =>
  `Assumes up to ${number(row.maximumCurrentA)} A per phase within known limits and forecast shared property capacity. Uses the ${row.source === 'configured-maximum' ? 'configured' : 'reported'} maximum when current is unknown. Completion is estimated.`).join(' ');

const IDENTIFICATION_CAUSES = {
  identified: 'Vehicle identified', 'manual-stop': 'Manual Stop has priority', unsupported: 'Only passive matching is available',
  interrupted: 'Active identification test ended; passive matching continues',
  'telemetry-unavailable': 'Vehicle evidence unavailable', 'vehicle-feed-stale': 'Vehicle feed is not current',
  'charger-unavailable': 'Fresh charger readiness unavailable', 'another-identification-active': 'The other charger is testing a vehicle',
  'bmw-home-unknown': 'BMW has no valid last known home location', 'bmw-away': 'BMW last valid location is away',
  'bmw-not-plugged': 'BMW plug evidence unavailable', 'economic-plan-pending': 'Waiting for the current charging plan',
  'evidence-capacity': 'Identification history reached its capacity; further automatic tests are stopped',
  'current-control-unavailable': 'Temporary identification current control is unavailable',
  'peer-transition-pending': 'Waiting for the other charger to settle before a brief identification pause',
  'vehicle-charging-evidence-pending': 'Charging continues while matching vehicle readings are unavailable',
  'current-evidence-pending': 'Waiting for fresh measured current and Tesla readings',
  'current-ambiguous': 'Charger currents do not yet distinguish the Tesla connection',
  'awaiting-evidence': 'Waiting for matching vehicle evidence',
  'awaiting-stop-confirmation': 'Waiting for physical stop confirmation',
  'observing-charge': 'Observing charging for a usable BMW baseline',
  'waiting-for-charging': 'Waiting for the vehicle to begin charging',
  'probe-energy-limit': 'Extra charging ended at the probe energy limit; passive matching continues',
  'probe-time-limit': 'Extra charging ended at the safety time limit; passive matching continues',
  'telemetry-lost': 'Charging test ended after loss of current measurements; passive matching continues',
  'pause-timeout': 'The vehicle was not identified within the brief pause deadline',
};

function inputText(input, kind = 'soc') {
  if (!Number.isFinite(input?.value)) return 'Unavailable';
  const value = kind === 'capacity' ? `${number(input.value)} kWh` : percent(input.value);
  if (input.assumed || input.source === 'manual-fallback') return `${value} · configured assumption`;
  if (['session-anchor', 'session-request'].includes(input.source)) return `${value} · session entry`;
  const provider = sourceName(input.source);
  return `${value} · ${provider ? `${provider} reading` : 'source unconfirmed'}`;
}

function controlText(value = {}, snapshot = false) {
  const automatic = snapshot ? value.automatic : value.automaticEnabled;
  const permission = automatic === true ? 'Automatic charging on' : automatic === false ? 'Automatic charging off' : 'Automatic charging state unknown';
  const extra = value.chargeNow === true ? ' · Charge now on' : '';
  const schedule = SCHEDULE_LABELS[value.scheduleState] ?? 'Schedule state unknown';
  const priority = value.manual === true ? ' · Manual charger instruction has priority' : '';
  const identification = value.identificationActive === true ? ' · Identification check in progress'
    : value.identification === 'observing' ? ' · Identification awaiting matching reports' : '';
  const uncertain = value.pending === true ? ' · Charger instruction unconfirmed'
    : value.error === true && value.controlAvailability !== 'unavailable' ? ' · Charger control error' : '';
  const availability = !snapshot && value.controlAvailability === 'unavailable' ? ' · Charger control unavailable'
    : !snapshot && value.controlAvailability === 'unknown' ? ' · Charger control availability unknown' : '';
  return `${permission}${extra} · ${schedule}${priority}${identification}${availability}${uncertain}`;
}

export function chargingReportFacts(report, timezone = 'Europe/Helsinki') {
  if (!report) return [];
  const current = report.current ?? {};
  const observedFrom = report.observedFrom;
  const partial = Number.isFinite(observedFrom) && observedFrom > report.startedAt;
  const observation = partial
    ? `Connection recorded ${time(report.startedAt, timezone)}; monitoring began ${time(observedFrom, timezone)}. Earlier charging is not covered by this report.`
    : Number.isFinite(observedFrom) ? `Monitoring began ${time(observedFrom, timezone)}. Events before that time are not covered.`
      : 'The beginning of monitoring was not recorded; earlier charging cannot be verified.';
  const actual = current.vehicleSoc === true ? 'Applicable vehicle battery reading available.' : 'Actual vehicle battery charge is unconfirmed.';
  const draw = current.powerKw, lastDraw = current.power?.value;
  const measured = Number.isFinite(current.power?.measuredAt) ? ` at ${time(current.power.measuredAt, timezone, true)}` : '';
  const physical = current.physicalFresh === true && Number.isFinite(draw) ? `${number(draw)} kW measured${measured}`
    : Number.isFinite(lastDraw) ? `Last reading ${number(lastDraw)} kW${measured} · current draw unavailable`
      : 'Measured draw unavailable';
  const chargerStatus = current.reportedCharging === true ? ' · Charger status reports charging'
    : current.reportedCharging === false ? ' · Charger status reports not charging' : ' · Charger status unknown';
  return [
    ['Control at last assessment', controlText(current)],
    ...(report.planning?.plannerReason ? [['Planning reason', PLAN_CAUSES[report.planning.plannerReason] ?? 'Planning reason unavailable']] : []),
    ...(report.planning?.assumptions?.length ? [['Planning assumptions', planningAssumptions(report.planning.assumptions)]] : []),
    ['Vehicle', `${vehicleName(current.vehicleId)} · ${actual}`],
    ...(current.identification ? [['Identification', [EVENTS[current.identification] ?? 'Identification state unknown',
      IDENTIFICATION_CAUSES[current.identificationReason]].filter(Boolean).join(' · ')]] : []),
    ['Battery input', inputText(current.soc)],
    ['Requested target', inputText(current.target)],
    ['Ready by', Number.isFinite(current.deadlineAt) ? time(current.deadlineAt, timezone) : 'Unavailable'],
    ['Measured draw / status', `${physical}${chargerStatus}`],
    ['Observation coverage', observation],
    ['Both chargers and shared priority', chargingSharedSummary(report.shared)],
  ];
}

const periodText = (rows, timezone) => Array.isArray(rows) && rows.length
  ? rows.map(row => `${time(row.startAt, timezone)} → ${row.endAt === null ? 'open release' : time(row.endAt, timezone)}`).join('\n')
  : 'No charging periods';
const priceText = (rows, timezone) => Array.isArray(rows) && rows.length
  ? rows.map(row => `${time(row.startAt, timezone)} → ${time(row.endAt, timezone)}: ${Number.isFinite(row.priceCtPerKwh) ? `${number(row.priceCtPerKwh)} c/kWh` : 'unavailable'}`).join('\n')
  : 'No comparable price intervals';

/** Only declared semantic deltas describe a change. Clock refreshes, request
 * counters and opaque price hashes cannot establish what changed or why. */
export function chargingPlanChanges(changes, timezone = 'Europe/Helsinki') {
  const fields = { automatic: ['Automatic charging', value => value === true ? 'On' : value === false ? 'Off' : 'Unknown'],
    chargeNow: ['Charge now', value => value === true ? 'On' : value === false ? 'Off' : 'Unknown'],
    state: ['Planner state', value => STATE_LABELS[value] ?? 'Unknown'],
    schedule: ['Controller schedule', value => SCHEDULE_LABELS[value] ?? 'Unknown'],
    readyBy: ['Ready by', value => time(value, timezone)],
    flexibility: ['One-day flexibility', value => !value ? 'No active allowance'
      : `${({ allow: 'One extra day approved', cancel: 'Allowance canceled', consume: 'Approved deadline is now normal' })[value.action] ?? 'Deadline permission recorded'} · ready by ${time(value.effectiveReadyByAt, timezone)}`
        + (value.action === 'allow' && Number.isFinite(value.checkpointAt) ? ` · +1 day marker until ${time(value.checkpointAt, timezone)}` : '')],
    startingSoc: ['Starting-charge input', percent],
    soc: ['Battery input', percent],
    target: ['Requested target', percent],
    capacity: ['Usable capacity', value => Number.isFinite(value) ? `${number(value)} kWh` : 'Unknown'],
    vehicle: ['Vehicle identification', vehicleName],
    nativeStart: ['Vehicle start constraint', value => value === null ? 'Not reported' : time(value, timezone)],
    periods: ['Charging periods', value => periodText(value, timezone)],
    prices: ['Planning electricity rates', value => priceText(value, timezone)],
    priceAvailability: ['Price availability', value => priceText(value, timezone)],
    feasible: ['Ready-by forecast', value => value === true ? 'Target feasible' : value === false ? 'Shortfall forecast' : 'Unknown'],
    provisional: ['Provisional release', value => value === true ? 'Requested' : value === false ? 'Not requested' : 'Unknown'],
    plannerReason: ['Planning reason', value => PLAN_CAUSES[value] ?? 'Planning reason unavailable'],
    warnings: ['Planning warnings', value => Array.isArray(value) && value.length ? value.join(' ') : 'None recorded'],
    assumptions: ['Planning assumptions', value => planningAssumptions(value) || 'No current assumption recorded'] };
  return (Array.isArray(changes) ? changes : []).flatMap(change => {
    const definition = fields[change?.field];
    if (!definition || JSON.stringify(change.before) === JSON.stringify(change.after)) return [];
    const [label, format] = definition, before = format(change.before), after = format(change.after);
    return before === after ? [] : [{ field: change.field, label, before, after, complex: ['periods', 'prices', 'priceAvailability'].includes(change.field) }];
  });
}

export function chargingPlanPresentation(plan, timezone = 'Europe/Helsinki') {
  const changes = chargingPlanChanges(plan?.changes, timezone);
  return { title: plan?.reason === 'initial-plan' ? 'Initial planning snapshot' : changes.length ? 'Recorded changes' : 'Planning snapshot recorded',
    control: controlText(plan, true), changes, periodsUnchanged: changes.length > 0 && !changes.some(change => change.field === 'periods'),
    inputs: `Charge input ${inputText(plan?.inputs?.soc)}; target ${inputText(plan?.inputs?.target)}; capacity ${inputText(plan?.inputs?.capacity, 'capacity')}.`,
    vehicle: `${vehicleName(plan?.vehicleId)}${plan?.vehicleId ? '' : ' · these inputs do not establish the vehicle’s actual battery charge'}`,
    deadline: Number.isFinite(plan?.deadlineAt) ? `Ready by ${time(plan.deadlineAt, timezone)}` : 'Ready-by occurrence unavailable',
    periods: periodText(plan?.periods, timezone),
    plannerReason: plan?.plannerReason ? `Planning reason: ${PLAN_CAUSES[plan.plannerReason] ?? 'Unavailable'}` : 'Planning reason was not recorded.',
    assumptions: planningAssumptions(plan?.assumptions),
    warnings: Array.isArray(plan?.warnings) ? plan.warnings.join(' ') : '',
    periodLabel: plan?.scheduleState === 'installed' ? 'Periods adopted by the controller · physical execution is checked separately'
      : plan?.scheduleState === 'proposed' ? 'Proposed periods · execution not confirmed by this snapshot'
        : plan?.scheduleState === 'none' ? 'No controller charging schedule' : 'Schedule state unknown',
  };
}

export function chargingReportSummary(report, available = true) {
  if (!available) return { label: 'Report unavailable', state: 'unknown', outcome: 'Session diagnostics could not be saved.', behavior: 'Evidence incomplete' };
  if (!report) return { label: 'Session report', state: 'quiet', outcome: 'No session observed yet', behavior: 'Observation starts with a confirmed connection.' };
  const degraded = report.planning?.state === 'degraded';
  const label = report.attentionCount ? `${report.attentionCount} ${report.attentionCount === 1 ? 'issue' : 'issues'}`
    : report.evidenceStale || report.behavior === 'insufficient-evidence' ? 'Evidence incomplete'
      : degraded ? 'Scheduling limited'
      : report.recoveredCount ? report.findings?.some(row => row.resolvedAt !== null && row.resolution === 'request-changed') ? 'Past issue' : 'Recovered issue'
        : report.behavior === 'expected' ? 'Checks passed' : 'Session report';
  return { label, state: report.attentionCount ? 'attention' : report.evidenceStale || report.behavior === 'insufficient-evidence' ? 'unknown'
    : degraded ? 'unknown'
    : report.behavior === 'expected' ? 'good' : 'quiet', outcome: OUTCOMES[report.outcome?.state] ?? 'Completion unknown',
    behavior: report.evidenceStale ? 'Observation is no longer current' : degraded
      ? 'Price scheduling is limited. Observed draw checks do not establish that the schedule met the request.'
      : BEHAVIOR[report.behavior] ?? 'Evidence incomplete' };
}

/** Observational report UI. Reading a report never identifies a vehicle or
 * changes charging. Save/delete actions manage only the report's retention. */
export function createChargingDiagnosticsPanel({ document, request, onOpenTest = () => {}, afterMutation = () => {} }) {
  const make = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const parts = new WeakMap(), lists = new WeakMap();
  // Retain the actual focused/expanded nodes. A status poll must not rebuild
  // a history that somebody is reading or move keyboard focus to the document.
  function sync(container, rows, keyFor, render) {
    const previous = lists.get(container) ?? new Map(), next = new Map(), occurrences = new Map();
    rows.forEach((row, index) => {
      // Several distinct records can legitimately share a recording timestamp.
      const base = String(keyFor(row, index)), occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const key = JSON.stringify([base, occurrence]), node = render(previous.get(key), row, key);
      next.set(key, node);
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);
    });
    for (const [key, node] of previous) if (!next.has(key)) {
      if (node.contains?.(document.activeElement)) container.closest?.('details')?.querySelector('summary')?.focus({ preventScroll: true });
      node.remove();
    }
    lists.set(container, next);
  }
  const dialog = make('dialog', '', 'control-dialog charging-report-dialog'); dialog.id = 'charging-report-dialog';
  dialog.setAttribute('aria-labelledby', 'charging-report-title'); dialog.setAttribute('aria-describedby', 'charging-report-help');
  const heading = make('div', '', 'charging-report-heading'), title = make('h2'); title.id = 'charging-report-title';
  const closeButton = make('button', 'Close', 'secondary-button'); closeButton.type = 'button'; heading.append(title, closeButton);
  const help = make('p', 'Observed charging, important changes and gaps in the evidence for this charger.', 'muted'); help.id = 'charging-report-help';
  const selectorLabel = make('label', 'Session', 'charging-report-selector'), selector = make('select'); selector.id = 'charging-report-session'; selectorLabel.htmlFor = selector.id; selectorLabel.append(selector);
  const result = make('div', '', 'charging-report-result'), outcome = make('strong'), behavior = make('span'); result.append(outcome, behavior); result.setAttribute('role', 'status'); result.setAttribute('aria-atomic', 'true');
  const context = make('p', '', 'muted charging-report-context');
  const facts = make('dl', '', 'charging-report-facts');
  const guided = make('div', '', 'charging-report-guided'), guidedNote = make('span'), guidedButton = make('button', 'View guided test', 'secondary-button');
  guidedButton.type = 'button'; guided.append(guidedNote, guidedButton); guided.hidden = true;
  const coverageTitle = make('h3', 'What was observed'), coverage = make('dl', '', 'charging-report-coverage');
  const currentFindings = make('button', '', 'secondary-button charging-report-current-findings'); currentFindings.type = 'button';
  const collectionLabel = make('label', 'Show sessions', 'charging-report-selector'), collection = make('select');
  collection.id = 'charging-report-collection'; collectionLabel.htmlFor = collection.id; collectionLabel.append(collection);
  for (const [value, label] of [['recent', 'Recent sessions'], ['saved', 'Saved reports']]) { const option = make('option', label); option.value = value; collection.append(option); }
  collection.value = 'recent';
  const moreReports = make('button', 'Load older sessions', 'secondary-button'); moreReports.type = 'button'; moreReports.id = 'charging-report-more-sessions';
  const actions = make('div', '', 'charging-report-actions'), save = make('button', 'Save report', 'secondary-button'), remove = make('button', 'Delete report', 'secondary-button');
  save.type = remove.type = 'button'; save.id = 'charging-report-save'; remove.id = 'charging-report-delete';
  save.setAttribute('data-admin-only', ''); remove.setAttribute('data-admin-only', ''); actions.append(save, remove);
  const retention = make('p', '', 'muted charging-report-retention');
  const confirmation = make('div', '', 'charging-report-confirm'), confirmationText = make('p'), confirm = make('button', 'Delete report'), cancel = make('button', 'Cancel', 'secondary-button');
  confirm.type = cancel.type = 'button'; confirmation.append(confirmationText, confirm, cancel); confirmation.hidden = true;
  const message = make('p', '', 'charging-report-message'); message.setAttribute('role', 'status');
  const timelineDetails = make('section', '', 'charging-report-events'), timeline = make('ol', '', 'charging-report-timeline');
  const eventHeading = make('h3', 'Events'), filterLabel = make('label', 'Event type', 'charging-report-selector'), filter = make('select');
  filter.id = 'charging-report-filter'; filterLabel.htmlFor = filter.id; filterLabel.append(filter);
  for (const [value, label] of Object.entries(CHARGING_EVENT_FILTERS)) { const option = make('option', label); option.value = value; filter.append(option); }
  filter.value = 'all';
  const refreshEvents = make('button', 'New events available · Refresh events', 'secondary-button'); refreshEvents.type = 'button'; refreshEvents.id = 'charging-report-refresh-events'; refreshEvents.hidden = true;
  const eventScope = make('p', '', 'muted charging-report-event-scope'), moreEvents = make('button', 'Load older events', 'secondary-button');
  moreEvents.type = 'button'; moreEvents.id = 'charging-report-more-events';
  timelineDetails.append(eventHeading, filterLabel, make('p', 'Related repetitions are grouped. Expand an entry for each occurrence, original evidence and planning inputs.', 'muted'), eventScope, refreshEvents, timeline, moreEvents);
  const limits = make('p', '', 'muted charging-report-limits');
  dialog.append(heading, help, collectionLabel, selectorLabel, moreReports, actions, retention, confirmation, message, result, context, facts, guided, currentFindings, coverageTitle, coverage, timelineDetails, limits);
  document.body.append(dialog);
  const buttons = new Map(), receipts = new Map();
  let status = null, selectedCharger = null, selectedReport = null, opener = null, guidedVehicle = null, guidedRunId = null, switchingDialog = false, renderedScope = null;
  let remoteReports = [], remoteReport = null, events = [], reportsBefore = null, eventsBefore = null, loaded = false, missing = false;
  let listSequence = 0, detailSequence = 0, eventsSequence = 0, loadingList = false, loadingEvents = false, mutating = false, pendingAction = null;
  let newEventsPending = false;
  let apiReadOnly = false, error = '', refreshToken = null, selectionEpoch = 0, loadingDetail = false;
  const chargerLabel = () => status?.charging?.chargers?.find(row => row.id === selectedCharger)?.label
    ?? ({ charger1: 'Charger 1', charger2: 'Charger 2' })[selectedCharger] ?? 'Charger';
  const slot = () => status?.charging?.diagnostics?.chargers?.find(row => row.id === selectedCharger);
  const reports = () => {
    const local = collection.value === 'saved' ? [] : [slot()?.current, ...(slot()?.recent ?? [])].filter(Boolean);
    return [...new Map([...local, ...remoteReports].map(row => [row.id, row])).values()];
  };
  const canManage = () => status?.webAccess?.role === 'admin' && typeof request === 'function' && !apiReadOnly && status?.readOnly !== true && status?.charging?.readOnly !== true
    && !isReadOnlyReplica(status) && status?.charging?.diagnostics?.readOnly !== true && status?.charging?.diagnostics?.canManage !== false;
  const query = values => new URLSearchParams(Object.entries({ chargerId: selectedCharger, ...values }).filter(([, value]) => value !== null && value !== undefined)).toString();
  const reportPath = suffix => `/api/charging/reports/${encodeURIComponent(selectedReport)}${suffix}?${query()}`;
  const controlLabels = { off: 'Automatic control inactive', waiting: 'Controller waiting', paused: 'Controller pause', active: 'Charging permission active',
    released: 'Controller restriction released', provisional: 'Provisional charging permission', identifying: 'Identification check',
    unconfirmed: 'Charger instruction unconfirmed', 'pause-unconfirmed': 'Pause unconfirmed', uncertain: 'Charger instruction uncertain',
    'ownership-uncertain': 'Instruction ownership uncertain', unavailable: 'Charger control information unavailable', yielded: 'Charger instruction has priority', manual: 'Manual charger instruction', disconnected: 'Charger disconnected' };
  const changeTitle = (changes, fallback) => changes.length === 1 ? `${changes[0].label} changed`
    : changes.length > 1 ? `${changes.length} plan & input changes` : fallback;
  const eventLabel = row => {
    const changes = chargingPlanChanges(row.changes);
    if (row.kind === 'physical' && ['charging-started', 'charging-observed'].includes(row.code) && Number.isFinite(row.powerKw) && row.powerKw <= .1)
      return 'Charging status recorded; draw unconfirmed';
    if (row.kind === 'physical' && Number.isFinite(row.powerKw) && row.powerKw === 0) return 'No draw measured';
    if (row.kind === 'finding-update') return `${FINDINGS[row.code]?.[0] ?? 'Finding'} · Evidence changed`;
    if (row.kind === 'finding') return FINDINGS[row.code]?.[0] ?? 'Finding recorded';
    if (row.kind === 'recovery') return `${FINDINGS[row.code]?.[0] ?? 'Issue'} · ${row.resolution === 'request-changed' ? 'request changed' : 'recovered'}`;
    if (row.kind === 'plan') return row.code === 'initial-plan' ? 'Initial planning state' : changeTitle(changes, 'Planning record');
    if (row.kind === 'control') return `${controlLabels[row.code] ?? 'Control state recorded'}${row.code !== 'unavailable' && row.availability === 'unavailable' ? ' · control unavailable' : ''}`;
    return EVENTS[row.code] ?? 'Observation recorded';
  };
  const eventKey = row => `${row.at}:${row.kind}:${row.code}`;
  function changesInto(container, changes) {
    sync(container, changes, row => row.field, (node, change) => {
      if (!node) {
        node = make('li', '', 'charging-report-change');
        const detail = make('details'), summary = make('summary'), before = make('p'), after = make('p'), simple = make('p', '', 'charging-report-change-value');
        detail.append(summary, before, after); node.append(simple, detail); parts.set(node, { detail, summary, before, after, simple });
      }
      const p = parts.get(node); p.detail.hidden = !change.complex; p.simple.hidden = change.complex;
      setText(p.simple, `${change.label}: ${change.before} → ${change.after}`); setText(p.summary, `${change.label} changed`);
      setText(p.before, `Before\n${change.before}`); setText(p.after, `After\n${change.after}`);
      return node;
    });
  }
  function rawEvent(node, row, timezone) {
    if (!node) { node = make('li'); const label = make('p'), evidence = make('p', '', 'muted'); node.append(label, evidence); parts.set(node, { label, evidence }); }
    const p = parts.get(node), details = [], evidenceRow = row.context ? { ...row.context, ...row } : row;
    if (['finding', 'finding-update', 'recovery'].includes(row.kind)) details.push(FINDINGS[row.code]?.[1] ?? 'Finding recorded.');
    if (row.kind === 'finding-update') details.push('The same episode remains active; its recorded evidence changed.');
    if (row.kind === 'shared') details.push(chargingSharedText(row.shared, selectedCharger));
    setText(p.label, `${time(row.at, timezone, true)} · ${eventLabel(row)}`);
    if (Number.isFinite(row.powerKw)) details.push(`Measured draw ${number(row.powerKw)} kW`);
    const source = sourceName(row.source);
    if (source) details.push(source);
    // A timestamp without source attribution cannot prove a meter measurement.
    if (Number.isFinite(row.measuredAt)) details.push(`${row.code === 'physical-evidence-lost' ? 'Last power sample' : source ? 'Measured' : 'Saved time'} ${time(row.measuredAt, timezone, true)}`);
    if (Number.isFinite(row.receivedAt)) details.push(`Received ${time(row.receivedAt, timezone, true)}`);
    if (row.kind === 'physical' || row.kind === 'charger-status') {
      if (!source) details.push('Source attribution not recorded');
      if (!Number.isFinite(row.receivedAt)) details.push('Receipt time not recorded');
    }
    if (Number.isFinite(row.powerMeasuredAt)) details.push(`Power measured ${time(row.powerMeasuredAt, timezone, true)}`);
    if (Number.isFinite(row.powerReceivedAt)) details.push(`Power received ${time(row.powerReceivedAt, timezone, true)}`);
    if (typeof evidenceRow.automaticEnabled === 'boolean') details.push(`Automatic charging ${evidenceRow.automaticEnabled ? 'on' : 'off'}`);
    if (evidenceRow.chargeNow === true) details.push('Charge now on');
    if (['available', 'unavailable', 'unknown'].includes(evidenceRow.availability)) details.push(`Control evidence ${evidenceRow.availability}`);
    for (const code of new Set([evidenceRow.errorCode, evidenceRow.reasonCode].filter(Boolean)))
      details.push((row.kind === 'identification' ? IDENTIFICATION_CAUSES : CONTROL_CAUSES)[code] ?? 'Detailed cause unavailable');
    if (evidenceRow.handoverConfirmed === true) details.push('Control handover confirmed');
    if (evidenceRow.handoverConfirmed === false) details.push('Control handover unconfirmed');
    if (evidenceRow.basis === 'installed-execution') details.push('Instruction basis: adopted controller plan');
    else if (evidenceRow.basis === 'proposed-plan') details.push('Instruction basis: proposed plan');
    if (evidenceRow.confirmed === false && row.kind === 'control') details.push('No physical confirmation recorded');
    setText(p.evidence, details.join(' · ')); p.evidence.hidden = !details.length; return node;
  }
  function historyItem(node, group, key, timezone) {
    if (!node) {
      node = make('li'); node.dataset.historyKey = key;
      const stamp = make('time'), label = make('strong'), detail = make('p', '', 'muted');
      const evidence = make('details', '', 'charging-report-entry charging-report-evidence'), summary = make('summary'), raw = make('ol', '', 'charging-report-raw');
      const body = make('div', '', 'charging-report-entry-body'), evidenceCount = make('p', '', 'muted'), snapshots = make('ol', '', 'charging-report-snapshots');
      const changes = make('ul', '', 'charging-report-changes'), unchanged = make('small', 'Charging periods unchanged', 'muted');
      summary.append(stamp, label); body.append(detail, changes, unchanged, snapshots, evidenceCount, raw);
      evidence.dataset.historyKey = key; evidence.append(summary, body); node.append(evidence);
      parts.set(node, { stamp, label, detail, changes, unchanged, evidenceCount, snapshots, raw });
    }
    const p = parts.get(node), rows = group.events, first = rows[0] ?? {}, changeRows = chargingPlanChanges(first.changes, timezone);
    const range = validTime(group.startAt) && validTime(group.endAt) && group.endAt > group.startAt
      ? timeFormatter(timezone).formatRange(group.startAt, group.endAt) : time(group.startAt, timezone);
    setText(p.stamp, `${range} · `); p.stamp.dateTime = validTime(group.startAt) ? new Date(group.startAt).toISOString() : '';
    let label = eventLabel(first), detail = '';
    if (group.type === 'low-draw-pulse') {
      label = group.pulseCount > 1 ? `${group.pulseCount} brief charger-status changes` : 'Brief charger-status change';
      const max = group.maxPowerKw;
      detail = max === 0 ? 'No draw measured · 0 kW' : Number.isFinite(max) ? `Recorded readings up to ${number(max)} kW` : 'Draw unconfirmed';
      if (group.pulseCount === 1 && group.endAt > group.startAt) detail += ` · ${Math.round((group.endAt - group.startAt) / 1000)} seconds between status events`;
    } else if (group.type === 'unavailable') {
      label = Number.isFinite(group.recoveredAt) ? 'Charger information temporarily unavailable' : 'Charger information unavailable';
      detail = Number.isFinite(group.recoveredAt) ? 'Evidence became available again.' : 'Recovery has not been observed in these records.';
    } else if (group.type === 'finding-series' || group.type === 'confirmation-series') {
      const finding = rows.find(row => row.kind === 'finding') ?? first;
      label = `${group.type === 'confirmation-series' ? 'Control confirmation changed repeatedly' : FINDINGS[finding.code]?.[0] ?? 'Finding'} · ${group.episodeCount || group.count} ${group.episodeCount ? group.episodeCount === 1 ? 'episode' : 'episodes' : 'control changes'}`;
      if (first.kind === 'finding-update') label += ' · Evidence changed';
      const cause = first.context?.errorCode; if (cause) label += ` · ${CONTROL_CAUSES[cause] ?? cause}`;
      detail = 'Separate recorded occurrences in the loaded events; this does not mean the condition was continuous. Expand for each detection and clearing.' + (group.startsMissing ? ' Episode starts may be in older events.' : '');
    } else if (group.type === 'repeated-control') { label += ` · ${group.count} occurrences`; detail = 'Equivalent recorded control evidence; individual timestamps are preserved below.';
    } else if (first.code === 'observation-gap') detail = 'Behavior during the missing interval is unverified.';
    else if (Number.isFinite(first.powerKw)) detail = first.powerKw === 0 ? 'No draw measured · 0 kW' : `Measured draw ${number(first.powerKw)} kW`;
    if (first.vehicleId) label += ` · ${vehicleName(first.vehicleId)}`;
    setText(p.label, label); setText(p.detail, detail); p.detail.hidden = !detail;
    changesInto(p.changes, first.plan ? [] : changeRows); p.changes.hidden = Boolean(first.plan) || !changeRows.length;
    sync(p.snapshots, rows.filter(row => row.plan), row => row.id ?? row.at, (node, row, key) => planItem(node, row.plan, key, timezone));
    p.snapshots.hidden = !rows.some(row => row.plan);
    p.unchanged.hidden = Boolean(first.plan) || first.kind !== 'plan' || !changeRows.length || changeRows.some(change => change.field === 'periods');
    setText(p.evidenceCount, `${rows.length} recorded events`); p.evidenceCount.hidden = rows.length === 1;
    sync(p.raw, rows, (row, index) => `${eventKey(row)}:${index}`, (old, row) => rawEvent(old, row, timezone));
    return node;
  }
  function planItem(node, plan, key, timezone) {
    if (!node) {
      node = make('li'); node.dataset.planKey = key;
      const stamp = make('time'), header = make('strong'), changes = make('ul', '', 'charging-report-changes'), unchanged = make('p', 'Charging periods unchanged', 'muted');
      const detail = make('div', '', 'charging-report-plan-detail'), summary = make('p', '', 'muted'), body = make('div');
      const clocks = make('p', '', 'muted charging-report-period'), settings = make('p'), state = make('p'), vehicleStart = make('p'), energy = make('p');
      const plannerReason = make('p'), assumptions = make('p'), warnings = make('p');
      const rates = make('details', '', 'charging-report-rates'), rateSummary = make('summary', 'Recorded planning electricity rates'), rateRows = make('p', '', 'charging-report-period'); rates.append(rateSummary, rateRows);
      const control = make('p'), vehicle = make('p', '', 'muted'), inputs = make('p'), deadline = make('p', '', 'muted'), periodLabel = make('p', '', 'charging-report-period-label'), periods = make('p', '', 'charging-report-period'), notes = make('p', '', 'muted');
      summary.hidden = true; summary.append(stamp, header); body.append(changes, unchanged, control, state, plannerReason, assumptions, warnings, vehicle, inputs, clocks, settings, deadline, vehicleStart, energy, periodLabel, periods, rates, notes);
      detail.append(summary, body); node.append(detail);
      parts.set(node, { stamp, header, changes, unchanged, control, state, plannerReason, assumptions, warnings, vehicle, inputs, clocks, settings, deadline, vehicleStart, energy, periodLabel, periods, rates, rateRows, notes });
    }
    const p = parts.get(node), view = chargingPlanPresentation(plan, timezone);
    setText(p.stamp, `${time(plan.at, timezone)} · `); p.stamp.dateTime = validTime(plan.at) ? new Date(plan.at).toISOString() : '';
    setText(p.header, changeTitle(view.changes, view.title));
    changesInto(p.changes, view.changes); p.unchanged.hidden = !view.periodsUnchanged;
    for (const key of ['control', 'vehicle', 'inputs', 'deadline', 'periodLabel', 'periods', 'plannerReason', 'assumptions', 'warnings']) setText(p[key], view[key]);
    p.assumptions.hidden = !view.assumptions; p.warnings.hidden = !view.warnings;
    p.periods.hidden = plan.scheduleState === 'none';
    setText(p.state, `Planner state: ${STATE_LABELS[plan.state] ?? 'Unknown'} · Planning inputs ${plan.inputStatus ?? 'unknown'}`);
    setText(p.clocks, [['soc', 'Charge input'], ['target', 'Target'], ['capacity', 'Capacity']].map(([key, label]) => {
      const input = plan.inputs?.[key];
      return `${label}: measured ${time(input?.measuredAt, timezone, true)} · received ${time(input?.receivedAt, timezone, true)}`;
    }).join('\n'));
    setText(p.settings, `Session settings: ready by ${plan.settings?.readyBy ?? 'Unknown'} · starting charge ${percent(plan.settings?.manualSoc)} · target ${percent(plan.settings?.minimumSoc)} · capacity ${Number.isFinite(plan.settings?.capacityKwh) ? `${number(plan.settings.capacityKwh)} kWh` : 'Unknown'}`);
    setText(p.vehicleStart, plan.nativeStartKnown === true ? Number.isFinite(plan.nativeStartAt) ? `Reported vehicle start constraint: ${time(plan.nativeStartAt, timezone)}` : 'Vehicle reports no start constraint.' : 'Vehicle start constraint unknown.');
    setText(p.energy, `Required grid energy estimate: ${Number.isFinite(plan.requiredGridKwh) ? `${number(plan.requiredGridKwh)} kWh` : 'Unavailable'}`);
    setText(p.rateRows, Array.isArray(plan.priceIntervals) ? priceText(plan.priceIntervals, timezone) : 'Planning electricity rates unavailable.');
    const notes = [plan.provisional === true ? 'Provisional release; price scheduling could not be maintained.' : '', plan.feasible === false ? 'Requested readiness is not established by this forecast.' : ''].filter(Boolean).join(' ');
    setText(p.notes, notes); p.notes.hidden = !notes; return node;
  }
  function render() {
    const scroll = dialog.scrollTop;
    const all = reports();
    if (selectedReport === null && all.length) selectedReport = all[0].id;
    const report = missing ? null : remoteReport?.id === selectedReport ? remoteReport : all.find(row => row.id === selectedReport);
    const timezone = status?.charging?.timezone ?? 'Europe/Helsinki';
    setText(title, `${chargerLabel()} · Session report`);
    const choices = all.map(row => ({ id: row.id, label: `${time(row.startedAt, timezone)} · ${row.endedAt === null ? row.recorded ? 'Connected at snapshot' : 'Connected' : 'Ended'}${row.vehicleId ? ` · ${vehicleName(row.vehicleId)}` : ''}${row.saved ? ' · Saved' : ''}` }));
    if (selectedReport !== null && !choices.some(row => row.id === selectedReport)) choices.unshift({ id: selectedReport, label: missing ? 'Selected report is no longer retained' : collection.value === 'saved' && report?.saved === false ? 'Selected report · no longer saved' : 'Selected session' });
    sync(selector, choices, row => row.id, (node, row) => { node ??= make('option'); node.value = row.id; setText(node, missing && row.id === selectedReport ? 'Selected report is no longer retained' : row.label); return node; });
    selector.value = selectedReport ?? ''; selector.disabled = !choices.length || mutating; selectorLabel.hidden = !choices.length;
    moreReports.hidden = !reportsBefore; moreReports.disabled = loadingList; collection.disabled = loadingList || mutating;
    const summary = chargingReportSummary(report, status?.charging?.diagnostics?.available !== false);
    if (!report && selectedReport !== null && status?.charging?.diagnostics?.available !== false) { summary.outcome = missing ? 'This session report is no longer retained' : 'Loading session report'; summary.behavior = missing ? 'Select another recorded session for this charger.' : 'Fetching the selected report.'; }
    else if (!report && status?.charging?.diagnostics?.available !== false) { summary.outcome = `No session report for ${chargerLabel()}`; summary.behavior = 'A report begins when a connection is observed.'; }
    setText(outcome, summary.outcome); setText(behavior, summary.behavior); result.dataset.state = summary.state;
    setText(context, report ? `${report.recorded ? 'Recorded master report · ' : ''}${report.previousEquipment ? 'Previous charger equipment · ' : ''}${report.vehicleId ? vehicleName(report.vehicleId) : 'Vehicle unconfirmed'} · ${report.endedAt === null ? report.recorded ? 'Connected at snapshot' : 'Connected' : `Ended ${time(report.endedAt, timezone)}`} · Last assessed ${time(report.evaluatedAt, timezone)}` : '');
    const run = status?.charging?.physicalTests?.runs?.find(row => row.chargerId === selectedCharger && report && row.report?.id === report.id);
    guided.hidden = !run; guidedVehicle = run?.vehicleId ?? null; guidedRunId = run?.id ?? null;
    setText(guidedNote, run ? `${run.program === 'vehicle-schedule' ? 'Vehicle schedule test' : 'Immediate charging test'} · ${run.phase.replaceAll('-', ' ')}` : '');
    const scope = `${selectedCharger}:${selectedReport}`;
    if (renderedScope !== scope) { dialog.scrollTop = 0; renderedScope = scope; } else dialog.scrollTop = scroll;
    const factRows = chargingReportFacts(report, timezone).flatMap(([label, value]) => [{ key: `${label}:label`, tag: 'dt', text: label }, { key: `${label}:value`, tag: 'dd', text: value }]);
    sync(facts, factRows, row => row.key, (node, row) => { node ??= make(row.tag); setText(node, row.text); return node; }); facts.hidden = !report;
    const findingCounts = chargingFindingCounts(report);
    currentFindings.hidden = !findingCounts.issues;
    setText(currentFindings, `${findingCounts.active} unresolved ${findingCounts.active === 1 ? 'finding' : 'findings'} · ${findingCounts.issues} ${findingCounts.issues === 1 ? 'issue' : 'issues'}, ${findingCounts.episodes} recorded ${findingCounts.episodes === 1 ? 'episode' : 'episodes'} · View findings`);
    sync(coverage, Object.entries(COVERAGE).flatMap(([key, label]) => {
      const check = report?.coverage?.[key]; return [{ key: `${key}:label`, tag: 'dt', text: label }, { key: `${key}:value`, tag: 'dd', text: check?.state === 'verified' ? 'Observed' : check?.state === 'insufficient-evidence' ? 'Insufficient evidence' : 'Not exercised', state: check?.state ?? 'not-exercised' }];
    }), row => row.key, (node, row) => { node ??= make(row.tag); setText(node, row.text); if (row.state) node.dataset.state = row.state; return node; });
    coverageTitle.hidden = coverage.hidden = !report;
    const history = projectChargingReportHistory({ events }, { filter: filter.value });
    sync(timeline, history.timeline, row => row.id, (node, row, key) => historyItem(node, row, key, timezone));
    timelineDetails.hidden = !report;
    setText(eventScope, loadingEvents && !events.length ? 'Loading events…' : !events.length ? 'No events of this type recorded.'
      : `${events.length} ${newEventsPending ? 'previously loaded ' : eventsBefore ? 'latest ' : ''}recorded events loaded · ${history.timeline.length} displayed ${history.timeline.length === 1 ? 'entry' : 'entries'}${filter.value === 'findings' ? ' · Episode groups describe the loaded history' : ''}`);
    refreshEvents.hidden = !newEventsPending;
    moreEvents.hidden = !eventsBefore; moreEvents.disabled = loadingEvents; filter.disabled = !report || mutating;
    const days = report?.retention?.days ?? status?.charging?.diagnostics?.retention?.days ?? 30;
    const expiresAt = report?.endedAt === null ? null : report?.endedAt + days * 86_400_000;
    setText(retention, !report ? '' : report.saved ? 'Saved permanently in this database. Saving protects this report and its future events from automatic expiry.'
      : report.endedAt === null ? `Active reports are retained. Completed reports expire after ${days} days unless saved.` : `Automatically expires ${time(expiresAt, timezone)} unless saved.`);
    actions.hidden = !report; save.disabled = remove.disabled = !canManage() || mutating;
    remove.disabled ||= report?.endedAt === null; remove.title = report?.endedAt === null ? 'Active reports cannot be deleted' : '';
    setText(save, report?.saved ? 'Remove from saved' : 'Save report');
    const receipt = receipts.get(scope);
    const feedback = receipt && Date.now() - receipt.at < 86_400_000 ? receipt.text : '';
    message.dataset.state = feedback && !receipt.failed ? 'saved' : 'error';
    setText(message, [feedback, error].filter(Boolean).join(' ') || (!canManage() && report ? 'View only · report management is unavailable here.' : ''));
    message.hidden = !message.textContent;
    setText(limits, report ? 'Draw checks require measured power above 0.1 kW. Power may supply vehicle auxiliaries; it does not prove battery charging. Unobserved intervals remain unverified. Events stay with retained reports; loading fewer events does not discard them.' : '');
  }
  const isMissing = failure => failure?.status === 404 || failure?.statusCode === 404 || /not found|no longer retained/i.test(failure?.message ?? '');
  function invalidateSelection() {
    newEventsPending = false; selectionEpoch++; detailSequence++; eventsSequence++; loadingDetail = false; remoteReport = null; events = []; eventsBefore = null; loaded = false; missing = false;
    loadingEvents = false; pendingAction = null; confirmation.hidden = true; error = ''; refreshToken = null;
  }
  async function loadReports(append = false) {
    if (typeof request !== 'function') return;
    const ticket = ++listSequence, charger = selectedCharger, view = collection.value;
    loadingList = true; render();
    try {
      const response = await request(`/api/charging/reports?${query({ savedOnly: view === 'saved', before: append ? reportsBefore : null, limit: 20 })}`);
      if (ticket !== listSequence || charger !== selectedCharger || view !== collection.value) return;
      apiReadOnly = response.readOnly === true;
      remoteReports = [...new Map([...(append ? remoteReports : []), ...response.reports].map(row => [row.id, row])).values()];
      reportsBefore = response.nextBefore; loadingList = false; render();
      if (!loaded && selectedReport) await loadDetail();
    } catch (failure) { if (ticket === listSequence) { loadingList = false; error = failure.message; render(); } }
  }
  async function loadEvents(append = false, refresh = false) {
    if (typeof request !== 'function' || !selectedReport || missing) return;
    const ticket = ++eventsSequence, scope = `${selectedCharger}:${selectedReport}:${filter.value}`;
    loadingEvents = true; render();
    try {
      const path = `/api/charging/reports/${encodeURIComponent(selectedReport)}/events`;
      const response = await request(`${path}?${query({ filter: filter.value, before: append ? eventsBefore : null, limit: 50 })}`);
      if (ticket !== eventsSequence || scope !== `${selectedCharger}:${selectedReport}:${filter.value}`) return;
      if (refresh && events.length) {
        if (events.length >= 1000 && response.events[0]?.id > events[0].id) { newEventsPending = true; loadingEvents = false; render(); return; }
        let pages = 1;
        const newestLoaded = events[0].id; let cursor = response.nextBefore;
        while (cursor && response.events.length && response.events.at(-1).id > newestLoaded) {
          if (ticket !== eventsSequence || scope !== `${selectedCharger}:${selectedReport}:${filter.value}`) return;
          if (pages >= 5) { newEventsPending = true; loadingEvents = false; render(); return; }
          pages++;
          const page = await request(`${path}?${query({ filter: filter.value, before: cursor, limit: 50 })}`);
          response.events.push(...page.events); cursor = page.nextBefore;
        }
      }
      if (ticket !== eventsSequence || scope !== `${selectedCharger}:${selectedReport}:${filter.value}`) return;
      apiReadOnly = response.readOnly === true;
      const existing = append || refresh ? events : [];
      events = [...new Map([...existing, ...response.events].map(row => [row.id, row])).values()].sort((a, b) => b.id - a.id);
      if (!refresh || !loaded) eventsBefore = response.nextBefore;
      loaded = true; loadingEvents = false; error = ''; render();
    } catch (failure) { if (ticket === eventsSequence) { loadingEvents = false; if (isMissing(failure)) { missing = true; remoteReport = null; events = []; } error = failure.message; render(); } }
  }
  async function loadDetail({ refresh = false } = {}) {
    if (typeof request !== 'function' || !selectedReport) return;
    const ticket = ++detailSequence, scope = `${selectedCharger}:${selectedReport}`; loadingDetail = true;
    try {
      const response = await request(reportPath(''));
      if (ticket !== detailSequence || scope !== `${selectedCharger}:${selectedReport}`) return;
      loadingDetail = false; remoteReport = response; apiReadOnly = response.readOnly === true; missing = false;
      render(); if (!newEventsPending) await loadEvents(false, refresh);
    } catch (failure) { if (ticket === detailSequence) { loadingDetail = false; if (isMissing(failure)) { missing = true; remoteReport = null; events = []; } error = failure.message; render(); } }
  }
  async function mutate(action) {
    if (!canManage() || mutating || !selectedReport) return;
    const report = remoteReport ?? reports().find(row => row.id === selectedReport);
    if (!report || action === 'delete' && report.endedAt === null) return;
    const epoch = selectionEpoch, scope = `${selectedCharger}:${selectedReport}`, path = reportPath(action === 'delete' ? '/delete' : '/save');
    listSequence++; detailSequence++; eventsSequence++; loadingList = loadingDetail = loadingEvents = false;
    mutating = true; confirmation.hidden = true; pendingAction = null; error = ''; render();
    try {
      const response = await request(path, action === 'delete' ? {} : { saved: action === 'save' });
      if (epoch !== selectionEpoch || scope !== `${selectedCharger}:${selectedReport}`) return;
      if (response.deleted) { missing = true; remoteReport = null; events = []; remoteReports = remoteReports.filter(row => row.id !== selectedReport); }
      else { remoteReport = response; remoteReports = remoteReports.map(row => row.id === response.id ? response : row).filter(row => collection.value !== 'saved' || row.saved); }
      receipts.set(scope, { at: Date.now(), text: response.deleted ? 'Session report and its events deleted.' : action === 'save' ? 'Report saved permanently in this database, including future events for this session.' : 'Report removed from saved. Ordinary retention applies.', failed: false });
      await afterMutation();
    } catch (failure) { if (epoch === selectionEpoch && scope === `${selectedCharger}:${selectedReport}`) receipts.set(scope, { at: Date.now(), text: failure.message, failed: true }); }
    finally {
      mutating = false; render();
      if (epoch === selectionEpoch && dialog.open && !missing && !loaded) void loadDetail();
    }
  }
  function ask(action, text) {
    pendingAction = action; setText(confirmationText, text); setText(confirm, action === 'delete' ? 'Delete report' : 'Remove from saved');
    confirmation.hidden = false; confirm.focus();
  }
  function close() { if (dialog.open) dialog.close(); }
  function open(chargerId, reportId = null) {
    if (!['charger1', 'charger2'].includes(chargerId)) return;
    selectedCharger = chargerId; selectedReport = reportId; renderedScope = null;
    invalidateSelection(); listSequence++; remoteReports = []; reportsBefore = null; collection.value = 'recent'; filter.value = 'all';
    opener = buttons.get(chargerId) ?? document.activeElement;
    render(); if (!dialog.open) dialog.showModal();
    for (const [id, button] of buttons) button.setAttribute('aria-expanded', String(id === chargerId));
    closeButton.focus();
    void loadReports();
  }
  closeButton.addEventListener('click', close);
  guidedButton.addEventListener('click', () => { switchingDialog = true; close(); onOpenTest(guidedVehicle, guidedRunId); });
  selector.addEventListener('change', () => { selectedReport = selector.value; invalidateSelection(); render(); void loadDetail(); });
  collection.addEventListener('change', () => { selectedReport = null; remoteReports = []; invalidateSelection(); render(); void loadReports(); });
  filter.addEventListener('change', () => { eventsSequence++; events = []; eventsBefore = null; loaded = false; newEventsPending = false; void loadEvents(); });
  currentFindings.addEventListener('click', () => { filter.value = 'findings'; events = []; eventsBefore = null; loaded = false; newEventsPending = false; void loadEvents(); filter.focus(); });
  moreReports.addEventListener('click', () => { void loadReports(true); });
  refreshEvents.addEventListener('click', () => { eventsSequence++; events = []; eventsBefore = null; loaded = false; newEventsPending = false; void loadEvents(); });
  moreEvents.addEventListener('click', () => { void loadEvents(true); });
  save.addEventListener('click', () => {
    const report = remoteReport ?? reports().find(row => row.id === selectedReport); if (!report || !canManage()) return;
    const expires = report.endedAt !== null && report.endedAt + (report.retention?.days ?? status?.charging?.diagnostics?.retention?.days ?? 30) * 86_400_000 <= (status?.now ?? Date.now());
    if (report.saved && expires) ask('unsave', 'This report is past the retention period. Removing it from saved will delete it and its events immediately.');
    else void mutate(report.saved ? 'unsave' : 'save');
  });
  remove.addEventListener('click', () => { if (!canManage() || (remoteReport ?? reports().find(row => row.id === selectedReport))?.endedAt === null) return; ask('delete', 'Delete this completed session report and all its events permanently? Energy history is kept.'); });
  confirm.addEventListener('click', () => { if (pendingAction) void mutate(pendingAction); });
  cancel.addEventListener('click', () => { confirmation.hidden = true; pendingAction = null; save.focus(); });
  dialog.addEventListener('close', () => {
    selectionEpoch++; listSequence++; detailSequence++; eventsSequence++; loadingList = loadingEvents = loadingDetail = false;
    for (const button of buttons.values()) button.setAttribute('aria-expanded', 'false');
    if (switchingDialog) { switchingDialog = false; return; }
    if (!document.querySelector('dialog[open]') && opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  });
  return { open, close, update(next) {
    status = next;
    for (const charger of status?.charging?.chargers ?? []) {
      const footer = document.getElementById(`${charger.id}-device-summary`)?.querySelector('.charging-footer');
      if (!footer) continue;
      let button = buttons.get(charger.id);
      if (!button) {
        button = make('button', '', 'charging-session-report secondary-button'); button.id = `${charger.id}-session-report`; button.type = 'button';
        const copy = make('span', '', 'charging-session-report-copy'), label = make('span', 'Session report', 'charging-session-report-label');
        const statusText = make('span', '', 'charging-session-report-status'), openLabel = make('span', 'Open ↗', 'charging-session-report-open');
        openLabel.setAttribute('aria-hidden', 'true');
        copy.append(label, statusText); button.append(copy, openLabel); parts.set(button, { statusText });
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', dialog.id); button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(charger.id); });
        buttons.set(charger.id, button); footer.append(button);
      }
      const slot = status.charging.diagnostics?.chargers?.find(row => row.id === charger.id), report = slot?.current ?? slot?.recent?.[0];
      const summary = chargingReportSummary(report, status.charging.diagnostics?.available !== false);
      const statusLabel = summary.label === 'Session report' ? '' : summary.label;
      const { statusText } = parts.get(button); setText(statusText, statusLabel); statusText.hidden = !statusLabel;
      button.dataset.state = summary.state; button.setAttribute('aria-label', `Open ${charger.label ?? charger.id} session report${statusLabel ? ` · ${statusLabel}` : ''}`);
    }
    if (dialog.open) {
      render();
      const summary = [slot()?.current, ...(slot()?.recent ?? [])].find(row => row?.id === selectedReport);
      const token = JSON.stringify([status.now, summary ?? null, slot()?.recent?.map(row => row.id)]);
      if (!mutating && token !== refreshToken && !loadingEvents && !loadingDetail) { refreshToken = token; void loadDetail({ refresh: loaded }); }
    }
  } };
}
