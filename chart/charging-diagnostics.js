import { projectChargingReportHistory } from './charging-report-history.js';

const OUTCOMES = { 'in-progress': 'Outcome not yet confirmed', 'target-confirmed': 'Target confirmed by vehicle',
  'target-estimated': 'Target estimated · awaiting vehicle evidence', 'deadline-missed': 'Target not reached by ready-by',
  'completion-unknown': 'Unplugged · completion unconfirmed', interrupted: 'Observation interrupted' };
const BEHAVIOR = { observing: 'Observing', expected: 'Observed checks passed', explained: 'Changes explained below',
  attention: 'Needs attention', 'insufficient-evidence': 'Evidence incomplete' };
const COVERAGE = { identification: 'Vehicle identification', initialRelease: 'Draw observed while charging allowed', pause: 'Intermediate pause',
  resume: 'Draw resumed after pause', lateReplan: 'Inputs reassessed after identification', targetAttainment: 'Requested target reached',
  completion: 'Native vehicle limit reached and stopped', energy: 'Recorded energy coverage' };
const FINDINGS = {
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
  inconclusive: 'Identification inconclusive', complete: 'Identification completed', cancelled: 'Identification cancelled',
  'initial-plan': 'Initial planning snapshot', 'target-changed': 'Requested target changed',
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
const CONTROL_CAUSES = {
  'read-failed': 'Charger read failed', 'command-failed': 'Charger instruction failed',
  'readback-failed': 'Charger confirmation could not be read', 'readback-mismatch': 'Charger readback did not match the instruction',
  'access-denied': 'Charger access denied', 'control-revoked': 'Control permission was withdrawn',
  'state-changed': 'Charger state changed during the instruction', 'unsupported-schedule': 'Schedule unsupported by the charger',
  'invalid-plan': 'Charging plan could not be applied', 'missing-current-limit': 'Charging current limit unavailable',
  'start-passed': 'Requested start had already passed', 'ambiguous-start': 'Requested start time was ambiguous',
  'start-out-of-range': 'Requested start time was outside the supported range', 'charger-fault': 'Charger reported a fault',
  ['charging-authorization']: 'Charging authorization required', 'incomplete-state': 'Charger state incomplete',
  'charger-stopped': 'Charger reported stopped', 'pause-unconfirmed': 'Pause not confirmed',
  offline: 'Charger offline', 'provider-offline': 'Charger provider offline',
  'transaction-unconfirmed': 'Charging transaction not confirmed', 'composite-unavailable': 'Charger schedule readback unavailable',
  'profile-rejected': 'Charger rejected the charging profile', 'retry-limit': 'Instruction retry limit reached',
  'storage-failed': 'Control state could not be saved', 'evse-control-unavailable': 'Charger control unavailable',
  'evse-command-revoked': 'Charger instruction permission withdrawn', 'evse-command-unconfirmed': 'Charger instruction unconfirmed',
  'evse-publish-unconfirmed': 'Instruction delivery unconfirmed', 'evse-rpc-rejected': 'Charger rejected the instruction',
  'evse-commissioning-required': 'Charger commissioning required', 'evse-read-unavailable': 'Charger read unavailable',
  'evse-native-restriction': 'A charger restriction has priority', 'evse-native-schedule-unavailable': 'Charger timer unavailable',
  'evse-event-overflow': 'Charger event buffer exceeded', 'evse-component-mapping-unverified': 'Charger component mapping unverified',
  'identification-resume-required': 'Identification release still requires confirmation', 'command-unconfirmed': 'Charger instruction unconfirmed',
  'control-error': 'Charger control error; detailed cause unavailable',
  'manual-stop': 'Manual stop has priority', 'manual-release': 'Manual release has priority', 'native-schedule': 'Charger timer has priority',
  'vehicle-not-before': 'Vehicle start restriction', 'identification-pause': 'Identification pause',
  'identification-waiting': 'Identification waiting', 'identification-charging': 'Identification observing charge',
  'economic-wait': 'Waiting for a planned charging period', 'charge-now': 'Charge now requested',
  'economic-window': 'Within a planned charging period', 'no-headroom': 'No electrical headroom available',
  'supply-unavailable': 'Supply information unavailable', 'within-limit': 'Within the available current limit',
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
  const identification = value.identificationActive === true ? ' · Identification check in progress' : '';
  const uncertain = value.pending === true ? ' · Charger instruction unconfirmed'
    : value.error === true && value.controlAvailability !== 'unavailable' ? ' · Charger control error' : '';
  const availability = !snapshot && value.controlAvailability === 'unavailable' ? ' · Charger control unavailable'
    : !snapshot && value.controlAvailability === 'unknown' ? ' · Charger control availability unknown' : '';
  return `${permission}${extra} · ${schedule}${priority}${identification}${availability}${uncertain}`;
}

export function chargingReportFacts(report, timezone = 'Europe/Helsinki') {
  if (!report) return [];
  const current = report.current ?? {};
  const opening = report.timeline?.find(row => row.kind === 'session' && ['connected', 'observation-started'].includes(row.code));
  const observedFrom = opening?.at;
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
    ['Vehicle', `${vehicleName(current.vehicleId)} · ${actual}`],
    ['Battery input', inputText(current.soc)],
    ['Measured draw / status', `${physical}${chargerStatus}`],
    ['Observation coverage', observation],
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
    provisional: ['Provisional release', value => value === true ? 'Requested' : value === false ? 'Not requested' : 'Unknown'] };
  return (Array.isArray(changes) ? changes : []).flatMap(change => {
    const definition = fields[change?.field];
    if (!definition || JSON.stringify(change.before) === JSON.stringify(change.after)) return [];
    const [label, format] = definition, before = format(change.before), after = format(change.after);
    return before === after ? [] : [{ field: change.field, label, before, after, complex: ['periods', 'prices', 'priceAvailability'].includes(change.field),
      ...(Number.isSafeInteger(change.omitted) && change.omitted > 0 ? { omitted: change.omitted } : {}) }];
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
    periodLabel: plan?.scheduleState === 'installed' ? 'Periods adopted by the controller · physical execution is checked separately'
      : plan?.scheduleState === 'proposed' ? 'Proposed periods · execution not confirmed by this snapshot'
        : plan?.scheduleState === 'none' ? 'No controller charging schedule' : 'Schedule state unknown',
  };
}

export function chargingReportSummary(report, available = true) {
  if (!available) return { label: 'Report unavailable', state: 'unknown', outcome: 'Session diagnostics could not be saved.', behavior: 'Evidence incomplete' };
  if (!report) return { label: 'Session report', state: 'quiet', outcome: 'No session observed yet', behavior: 'Observation starts with a confirmed connection.' };
  const label = report.attentionCount ? `${report.attentionCount} ${report.attentionCount === 1 ? 'issue' : 'issues'}`
    : report.evidenceStale || report.behavior === 'insufficient-evidence' ? 'Evidence incomplete'
      : report.recoveredCount ? report.findings?.some(row => row.resolvedAt !== null && row.resolution === 'request-changed') ? 'Past issue' : 'Recovered issue'
        : report.behavior === 'expected' ? 'Checks passed' : 'Session report';
  return { label, state: report.attentionCount ? 'attention' : report.evidenceStale || report.behavior === 'insufficient-evidence' ? 'unknown'
    : report.behavior === 'expected' ? 'good' : 'quiet', outcome: OUTCOMES[report.outcome?.state] ?? 'Completion unknown',
    behavior: report.evidenceStale ? 'Observation is no longer current' : BEHAVIOR[report.behavior] ?? 'Evidence incomplete' };
}

/** Read-only report UI. Opening it does not identify, poll a vehicle, change a
 * schedule or issue a request. Updates come from the normal dashboard status. */
export function createChargingDiagnosticsPanel({ document, onOpenTest = () => {} }) {
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
  const context = make('p', '', 'muted charging-report-context'), findings = make('ul', '', 'charging-report-findings');
  const facts = make('dl', '', 'charging-report-facts');
  const guided = make('div', '', 'charging-report-guided'), guidedNote = make('span'), guidedButton = make('button', 'View guided test', 'secondary-button');
  guidedButton.type = 'button'; guided.append(guidedNote, guidedButton); guided.hidden = true;
  const coverageTitle = make('h3', 'What was observed'), coverage = make('dl', '', 'charging-report-coverage');
  const timelineDetails = make('details', '', 'charging-report-fold'), timeline = make('ol', '', 'charging-report-timeline');
  timelineDetails.append(make('summary', 'Session timeline'),
    make('p', 'Brief status changes are grouped. Expand an entry for the original events and evidence times.', 'muted'), timeline);
  const plansDetails = make('details', '', 'charging-report-fold'), plans = make('ol', '', 'charging-report-plans');
  plansDetails.append(make('summary', 'Plan & input changes'), plans);
  const routineDetails = make('details', '', 'charging-report-routine'), routineSummary = make('summary'), routinePlans = make('ol', '', 'charging-report-plans');
  routineDetails.append(routineSummary, make('p', 'These records have no documented meaningful change. They are retained for inspection, not shown as new charging instructions.', 'muted'), routinePlans);
  plansDetails.append(routineDetails);
  const limits = make('p', '', 'muted charging-report-limits');
  dialog.append(heading, help, selectorLabel, result, context, facts, guided, findings, coverageTitle, coverage, timelineDetails, plansDetails, limits);
  document.body.append(dialog);
  const buttons = new Map();
  let status = null, selectedCharger = null, selectedReport = null, opener = null, guidedVehicle = null, guidedRunId = null, switchingDialog = false, renderedScope = null;
  const chargerLabel = () => status?.charging?.chargers?.find(row => row.id === selectedCharger)?.label
    ?? ({ charger1: 'Charger 1', charger2: 'Charger 2' })[selectedCharger] ?? 'Charger';
  const reports = () => {
    const slot = status?.charging?.diagnostics?.chargers?.find(row => row.id === selectedCharger);
    return [slot?.current, ...(slot?.recent ?? [])].filter(Boolean);
  };
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
        const detail = make('details'), summary = make('summary'), before = make('p'), after = make('p'), omitted = make('p', '', 'muted'), simple = make('p', '', 'charging-report-change-value');
        detail.append(summary, before, after, omitted); node.append(simple, detail); parts.set(node, { detail, summary, before, after, omitted, simple });
      }
      const p = parts.get(node); p.detail.hidden = !change.complex; p.simple.hidden = change.complex;
      setText(p.simple, `${change.label}: ${change.before} → ${change.after}`); setText(p.summary, `${change.label} changed`);
      setText(p.before, `Before\n${change.before}`); setText(p.after, `After\n${change.after}`);
      p.omitted.hidden = !change.omitted; setText(p.omitted, change.omitted ? `${change.omitted} additional changed intervals omitted from this bounded record.` : '');
      return node;
    });
  }
  function rawEvent(node, row, timezone) {
    if (!node) { node = make('li'); const label = make('p'), evidence = make('p', '', 'muted'); node.append(label, evidence); parts.set(node, { label, evidence }); }
    const p = parts.get(node), details = [];
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
    if (typeof row.automaticEnabled === 'boolean') details.push(`Automatic charging ${row.automaticEnabled ? 'on' : 'off'}`);
    if (row.chargeNow === true) details.push('Charge now on');
    if (['available', 'unavailable', 'unknown'].includes(row.availability)) details.push(`Control evidence ${row.availability}`);
    for (const code of new Set([row.errorCode, row.reasonCode].filter(Boolean))) details.push(CONTROL_CAUSES[code] ?? 'Detailed cause unavailable');
    if (row.handoverConfirmed === true) details.push('Control handover confirmed');
    if (row.handoverConfirmed === false) details.push('Control handover unconfirmed');
    if (row.confirmed === false && row.kind === 'control') details.push('No physical confirmation recorded');
    setText(p.evidence, details.join(' · ')); p.evidence.hidden = !details.length; return node;
  }
  function historyItem(node, group, key, timezone) {
    if (!node) {
      node = make('li'); node.dataset.historyKey = key;
      const stamp = make('time'), label = make('strong'), detail = make('p', '', 'muted');
      const evidence = make('details', '', 'charging-report-entry charging-report-evidence'), summary = make('summary'), raw = make('ol', '', 'charging-report-raw');
      const body = make('div', '', 'charging-report-entry-body'), evidenceCount = make('p', '', 'muted');
      const changes = make('ul', '', 'charging-report-changes'), unchanged = make('small', 'Charging periods unchanged', 'muted');
      summary.append(stamp, label); body.append(detail, changes, unchanged, evidenceCount, raw);
      evidence.dataset.historyKey = key; evidence.append(summary, body); node.append(evidence);
      parts.set(node, { stamp, label, detail, changes, unchanged, evidenceCount, raw });
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
    } else if (first.code === 'observation-gap') detail = 'Behavior during the missing interval is unverified.';
    else if (Number.isFinite(first.powerKw)) detail = first.powerKw === 0 ? 'No draw measured · 0 kW' : `Measured draw ${number(first.powerKw)} kW`;
    if (first.vehicleId) label += ` · ${vehicleName(first.vehicleId)}`;
    setText(p.label, label); setText(p.detail, detail); p.detail.hidden = !detail;
    changesInto(p.changes, changeRows); p.changes.hidden = !changeRows.length;
    p.unchanged.hidden = first.kind !== 'plan' || !changeRows.length || changeRows.some(change => change.field === 'periods');
    setText(p.evidenceCount, `${rows.length} recorded events`); p.evidenceCount.hidden = rows.length === 1;
    sync(p.raw, rows, (row, index) => `${eventKey(row)}:${index}`, (old, row) => rawEvent(old, row, timezone));
    return node;
  }
  function planItem(node, plan, key, timezone) {
    if (!node) {
      node = make('li'); node.dataset.planKey = key;
      const stamp = make('time'), header = make('strong'), changes = make('ul', '', 'charging-report-changes'), unchanged = make('p', 'Charging periods unchanged', 'muted');
      const detail = make('details', '', 'charging-report-entry charging-report-plan-detail'), summary = make('summary'), body = make('div', '', 'charging-report-entry-body');
      const control = make('p'), vehicle = make('p', '', 'muted'), inputs = make('p'), deadline = make('p', '', 'muted'), periodLabel = make('p', '', 'charging-report-period-label'), periods = make('p', '', 'charging-report-period'), notes = make('p', '', 'muted');
      summary.append(stamp, header); body.append(changes, unchanged, control, vehicle, inputs, deadline, periodLabel, periods, notes);
      detail.append(summary, body); node.append(detail);
      parts.set(node, { stamp, header, changes, unchanged, control, vehicle, inputs, deadline, periodLabel, periods, notes });
    }
    const p = parts.get(node), view = chargingPlanPresentation(plan, timezone);
    setText(p.stamp, `${time(plan.at, timezone)} · `); p.stamp.dateTime = validTime(plan.at) ? new Date(plan.at).toISOString() : '';
    setText(p.header, changeTitle(view.changes, view.title));
    changesInto(p.changes, view.changes); p.unchanged.hidden = !view.periodsUnchanged;
    for (const key of ['control', 'vehicle', 'inputs', 'deadline', 'periodLabel', 'periods']) setText(p[key], view[key]);
    p.periods.hidden = plan.scheduleState === 'none';
    const notes = [plan.provisional === true ? 'Provisional release with incomplete planning inputs.' : '', plan.feasible === false ? 'The forecast could not meet the requested target by ready-by.' : '',
      plan.priceCoverageTruncated === true ? 'The stored electricity-rate horizon is bounded.' : ''].filter(Boolean).join(' ');
    setText(p.notes, notes); p.notes.hidden = !notes; return node;
  }
  function render() {
    const all = reports();
    if (selectedReport === null && all.length) selectedReport = all[0].id;
    const report = all.find(row => row.id === selectedReport), timezone = status?.charging?.timezone ?? 'Europe/Helsinki';
    setText(title, `${chargerLabel()} · Session report`);
    const choices = all.map(row => ({ id: row.id, label: `${time(row.startedAt, timezone)} · ${row.endedAt === null ? row.recorded ? 'Connected at snapshot' : 'Connected' : 'Ended'}${row.vehicleId ? ` · ${vehicleName(row.vehicleId)}` : ''}` }));
    if (selectedReport !== null && !report) choices.unshift({ id: selectedReport, label: 'Selected report is no longer retained' });
    sync(selector, choices, row => row.id, (node, row) => { node ??= make('option'); node.value = row.id; setText(node, row.label); return node; });
    selector.value = selectedReport ?? ''; selector.disabled = !all.length; selectorLabel.hidden = !choices.length;
    const summary = chargingReportSummary(report, status?.charging?.diagnostics?.available !== false);
    if (!report && selectedReport !== null && status?.charging?.diagnostics?.available !== false) { summary.outcome = 'This session report is no longer retained'; summary.behavior = 'Select another recorded session for this charger.'; }
    else if (!report && status?.charging?.diagnostics?.available !== false) { summary.outcome = `No session report for ${chargerLabel()}`; summary.behavior = 'A report begins when a connection is observed.'; }
    setText(outcome, summary.outcome); setText(behavior, summary.behavior); result.dataset.state = summary.state;
    setText(context, report ? `${report.recorded ? 'Recorded master report · ' : ''}${report.vehicleId ? vehicleName(report.vehicleId) : 'Vehicle unconfirmed'} · ${report.endedAt === null ? report.recorded ? 'Connected at snapshot' : 'Connected' : `Ended ${time(report.endedAt, timezone)}`} · Last assessed ${time(report.evaluatedAt, timezone)}`
      : 'This charger retains its current report and four completed sessions.');
    const run = status?.charging?.physicalTests?.runs?.find(row => row.chargerId === selectedCharger && report && row.report?.id === report.id);
    guided.hidden = !run; guidedVehicle = run?.vehicleId ?? null; guidedRunId = run?.id ?? null;
    setText(guidedNote, run ? `${run.program === 'vehicle-schedule' ? 'Vehicle schedule test' : 'Immediate charging test'} · ${run.phase.replaceAll('-', ' ')}` : '');
    const scope = `${selectedCharger}:${selectedReport}`;
    if (renderedScope !== scope) { timelineDetails.open = false; plansDetails.open = false; routineDetails.open = false; dialog.scrollTop = 0; renderedScope = scope; }
    const factRows = chargingReportFacts(report, timezone).flatMap(([label, value]) => [{ key: `${label}:label`, tag: 'dt', text: label }, { key: `${label}:value`, tag: 'dd', text: value }]);
    sync(facts, factRows, row => row.key, (node, row) => { node ??= make(row.tag); setText(node, row.text); return node; }); facts.hidden = !report;
    sync(findings, report?.findings ?? [], row => `${row.code}:${row.firstAt}`, (node, row) => {
      if (!node) {
        node = make('li'); const entry = make('details', '', 'charging-report-entry'), summary = make('summary'), body = make('div', '', 'charging-report-entry-body');
        const stamp = make('time'), label = make('strong'), detail = make('p'), when = make('small', '', 'muted');
        summary.append(stamp, label); body.append(detail, when); entry.append(summary, body); node.append(entry); parts.set(node, { stamp, label, detail, when });
      }
      const p = parts.get(node), [label, detail] = FINDINGS[row.code] ?? ['Observation', 'See the timeline for this event.'];
      node.dataset.state = row.resolvedAt !== null ? 'recovered' : row.severity;
      setText(p.stamp, `${time(row.firstAt, timezone)} · `); p.stamp.dateTime = validTime(row.firstAt) ? new Date(row.firstAt).toISOString() : '';
      setText(p.label, `${label}${row.resolvedAt !== null ? row.resolution === 'request-changed' ? ' · request changed' : ' · recovered' : ''}`); setText(p.detail, detail);
      setText(p.when, `${time(row.firstAt, timezone)}${row.resolvedAt !== null ? ` · ${row.resolution === 'request-changed' ? 'Request changed' : 'Recovered'} ${time(row.resolvedAt, timezone)}` : report.endedAt !== null ? ' · Unresolved when the session ended' : ' · Current'}`); return node;
    }); findings.hidden = !report?.findings?.length;
    sync(coverage, Object.entries(COVERAGE).flatMap(([key, label]) => {
      const check = report?.coverage?.[key]; return [{ key: `${key}:label`, tag: 'dt', text: label }, { key: `${key}:value`, tag: 'dd', text: check?.state === 'verified' ? 'Observed' : check?.state === 'insufficient-evidence' ? 'Insufficient evidence' : 'Not exercised', state: check?.state ?? 'not-exercised' }];
    }), row => row.key, (node, row) => { node ??= make(row.tag); setText(node, row.text); if (row.state) node.dataset.state = row.state; return node; });
    coverageTitle.hidden = coverage.hidden = !report;
    const history = projectChargingReportHistory(report ?? {}, { order: 'newest-first' });
    sync(timeline, history.timeline, row => row.id, (node, row, key) => historyItem(node, row, key, timezone));
    const planRows = history.plans.length ? history.plans : report ? [{ empty: true }] : [];
    sync(plans, planRows, row => row.empty ? 'empty' : `plan:${row.at}`, (node, row, key) => {
      if (row.empty) { node ??= make('li'); setText(node, report.current?.scheduleState === 'none' ? 'No controller charging schedule was recorded.' : 'No meaningful planning changes recorded.'); return node; }
      return planItem(node, row, key, timezone);
    });
    routineDetails.hidden = !history.hiddenPlans.length;
    setText(routineSummary, `${history.hiddenPlans.length} routine planning ${history.hiddenPlans.length === 1 ? 'record' : 'records'}`);
    sync(routinePlans, history.hiddenPlans, row => `routine:${row.at}`, (node, row, key) => planItem(node, row, key, timezone));
    timelineDetails.hidden = plansDetails.hidden = !report;
    const dropped = report ? Object.values(report.truncated ?? {}).reduce((total, count) => total + count, 0) : 0;
    setText(limits, report ? `Draw checks require measured power above 0.1 kW. Power may supply vehicle auxiliaries; it does not prove battery charging. Unobserved intervals remain unverified.${dropped ? ` ${dropped} older detail entries were omitted by bounded retention.` : ''}` : '');
  }
  function close() { if (dialog.open) dialog.close(); }
  function open(chargerId, reportId = null) {
    if (!['charger1', 'charger2'].includes(chargerId)) return;
    selectedCharger = chargerId; selectedReport = reportId; renderedScope = null;
    opener = buttons.get(chargerId) ?? document.activeElement;
    render(); if (!dialog.open) dialog.showModal();
    for (const [id, button] of buttons) button.setAttribute('aria-expanded', String(id === chargerId));
    closeButton.focus();
  }
  closeButton.addEventListener('click', close);
  guidedButton.addEventListener('click', () => { switchingDialog = true; close(); onOpenTest(guidedVehicle, guidedRunId); });
  selector.addEventListener('change', () => { selectedReport = selector.value; render(); });
  dialog.addEventListener('close', () => {
    for (const button of buttons.values()) button.setAttribute('aria-expanded', 'false');
    if (switchingDialog) { switchingDialog = false; return; }
    if (!document.querySelector('dialog[open]') && opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
  });
  return { open, close, update(next) {
    status = next;
    for (const charger of status?.charging?.chargers ?? []) {
      const footer = document.getElementById(`${charger.id}-device-summary`)?.querySelector('.charging-disclosure');
      if (!footer) continue;
      let button = buttons.get(charger.id);
      if (!button) {
        button = make('button', 'Session report', 'charging-session-report secondary-button'); button.id = `${charger.id}-session-report`; button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', dialog.id); button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(charger.id); });
        buttons.set(charger.id, button); footer.append(button);
      }
      const slot = status.charging.diagnostics?.chargers?.find(row => row.id === charger.id), report = slot?.current ?? slot?.recent?.[0];
      const summary = chargingReportSummary(report, status.charging.diagnostics?.available !== false);
      setText(button, summary.label === 'Session report' ? 'Session report' : `Report · ${summary.label}`);
      button.dataset.state = summary.state; button.setAttribute('aria-label', `${charger.label ?? charger.id} session report · ${summary.label}`);
    }
    if (dialog.open) render();
  } };
}
