const OUTCOMES = { 'in-progress': 'Session in progress', 'target-confirmed': 'Target confirmed by vehicle',
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
  unplugged: 'Vehicle unplugged', 'connection-replaced': 'Connection changed', 'observation-gap': 'Observation gap · no physical conclusion for the missing interval',
  'charging-observed': 'Draw above 0.1 kW observed', 'not-charging-observed': 'No draw above 0.1 kW observed',
  'charging-started': 'Draw rose above 0.1 kW', 'charging-stopped': 'Draw at 0.1 kW or below observed', 'physical-unknown': 'Measured draw unavailable',
  'charger-reports-charging': 'Charger status reports charging', 'charger-reports-not-charging': 'Charger status reports not charging',
  'charger-status-unknown': 'Charger status unavailable',
  identified: 'Vehicle identified', waiting: 'Waiting', charging: 'Identification observing charge', pausing: 'Identification pause requested',
  inconclusive: 'Identification inconclusive', complete: 'Identification completed', cancelled: 'Identification cancelled',
  'initial-plan': 'Initial planning snapshot', 'target-changed': 'Requested target changed',
  ...OUTCOMES, ...COVERAGE };
const time = (value, timezone = 'Europe/Helsinki', seconds = false) => Number.isFinite(value)
  ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(value) : 'Unknown';
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
  const uncertain = value.pending === true || value.error === true ? ' · Charger instruction unconfirmed' : '';
  return `${permission}${extra} · ${schedule}${priority}${identification}${uncertain}`;
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
      : report.recoveredCount ? 'Recovered issue' : report.behavior === 'expected' ? 'Checks passed' : 'Session report';
  return { label, state: report.attentionCount ? 'attention' : report.evidenceStale || report.behavior === 'insufficient-evidence' ? 'unknown'
    : report.behavior === 'expected' ? 'good' : 'quiet', outcome: OUTCOMES[report.outcome?.state] ?? 'Completion unknown',
    behavior: report.evidenceStale ? 'Observation is no longer current' : BEHAVIOR[report.behavior] ?? 'Evidence incomplete' };
}

/** Read-only report UI. Opening it does not identify, poll a vehicle, change a
 * schedule or issue a request. Updates come from the normal dashboard status. */
export function createChargingDiagnosticsPanel({ document, onOpenTest = () => {} }) {
  const make = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
  const dialog = make('dialog', '', 'control-dialog charging-report-dialog'); dialog.id = 'charging-report-dialog';
  dialog.setAttribute('aria-labelledby', 'charging-report-title'); dialog.setAttribute('aria-describedby', 'charging-report-help');
  const heading = make('div', '', 'charging-report-heading'), title = make('h2', 'Charging session'); title.id = 'charging-report-title';
  const closeButton = make('button', 'Close', 'secondary-button'); closeButton.type = 'button';
  heading.append(title, closeButton);
  const help = make('p', 'Checks follow actual charger and vehicle evidence. Unobserved behavior stays unverified.', 'muted'); help.id = 'charging-report-help';
  const selectorLabel = make('label', 'Session', 'charging-report-selector'), selector = make('select'); selector.id = 'charging-report-session'; selectorLabel.htmlFor = selector.id; selectorLabel.append(selector);
  const result = make('div', '', 'charging-report-result'), outcome = make('strong'), behavior = make('span'); result.append(outcome, behavior); result.setAttribute('role', 'status');
  const context = make('p', '', 'muted'), findings = make('ul', '', 'charging-report-findings');
  const facts = make('dl', '', 'charging-report-facts');
  const guided = make('div', '', 'charging-report-guided'), guidedNote = make('span'), guidedButton = make('button', 'View guided test', 'secondary-button');
  guidedButton.type = 'button'; guided.append(guidedNote, guidedButton); guided.hidden = true;
  const coverageTitle = make('h3', 'What was observed'), coverage = make('dl', '', 'charging-report-coverage');
  const timelineDetails = make('details', '', 'charging-report-fold'), timeline = make('ol', '', 'charging-report-timeline');
  timelineDetails.append(make('summary', 'Session timeline'),
    make('p', 'Times below show when the controller recorded each event. Original measurement and receipt times are shown separately where available.', 'muted'), timeline);
  const plansDetails = make('details', '', 'charging-report-fold'), plans = make('ol', '', 'charging-report-plans');
  plansDetails.append(make('summary', 'Recorded plans & inputs'), plans);
  const limits = make('p', '', 'muted');
  dialog.append(heading, help, selectorLabel, result, context, facts, guided, findings, coverageTitle, coverage, timelineDetails, plansDetails, limits);
  document.body.append(dialog);
  const buttons = new Map();
  let status = null, selectedCharger = null, selectedReport = null, opener = null, signature = null, guidedVehicle = null, switchingDialog = false;
  function appendChanges(container, changes, compact = false) {
    for (const change of changes) {
      if (change.complex) {
        const detail = make('details', '', 'charging-report-change');
        detail.append(make('summary', `${change.label} changed`), make('p', `Before\n${change.before}`), make('p', `After\n${change.after}`));
        if (change.omitted) detail.append(make('p', `${change.omitted} additional changed intervals were omitted from this bounded record.`, 'muted'));
        container.append(detail);
      } else container.append(make(compact ? 'small' : 'p', `${change.label}: ${change.before} → ${change.after}`, 'charging-report-change-value'));
    }
  }
  function reports() { return (status?.charging?.diagnostics?.chargers ?? []).flatMap(slot => [slot.current, ...(slot.recent ?? [])].filter(Boolean).map(report => ({ ...report, chargerId: slot.id }))); }
  function selectDefault() {
    if (selectedReport !== null) return;
    const all = reports(), preferred = all.find(report => report.chargerId === selectedCharger);
    selectedReport = preferred?.id ?? all[0]?.id ?? null;
  }
  function render() {
    selectDefault();
    const all = reports(), report = all.find(row => row.id === selectedReport), timezone = status?.charging?.timezone ?? 'Europe/Helsinki';
    const choices = all.map(row => [row.id, `${row.chargerId === 'charger1' ? 'Charger 1' : 'Charger 2'} · ${time(row.startedAt, timezone)}${row.endedAt === null ? row.recorded ? ' · Connected at snapshot' : ' · Connected' : ''}`]);
    const choiceSignature = JSON.stringify(choices);
    if (choiceSignature !== selector.dataset.choices) {
      selector.replaceChildren(...choices.map(([value, label]) => { const option = make('option', label); option.value = value; return option; }));
      selector.dataset.choices = choiceSignature;
    }
    selector.value = selectedReport ?? ''; selector.disabled = !all.length;
    const summary = chargingReportSummary(report, status?.charging?.diagnostics?.available !== false);
    if (!report && selectedReport !== null) { summary.outcome = 'This session report is no longer retained'; summary.behavior = 'Select another recorded session above.'; }
    outcome.textContent = summary.outcome; behavior.textContent = summary.behavior; result.dataset.state = summary.state;
    context.textContent = report ? `${report.recorded ? 'Recorded master report · ' : ''}${report.chargerId === 'charger1' ? 'Charger 1' : 'Charger 2'} · ${report.vehicleId === 'bmw' ? 'BMW' : report.vehicleId === 'tesla' ? 'Tesla' : 'Vehicle unconfirmed'} · ${report.endedAt === null ? report.recorded ? 'Connected at snapshot' : 'Connected' : `Ended ${time(report.endedAt, timezone)}`} · Last assessed ${time(report.evaluatedAt, timezone)}` : 'Reports continue while the browser is closed and retain four completed sessions per charger.';
    const run = status?.charging?.physicalTests?.runs?.find(row => row.chargerId === (report?.chargerId ?? selectedCharger)
      && (row.report?.id === report?.id && report?.id || ['armed', 'awaiting-vehicle-schedule', 'observing'].includes(row.phase) && report?.endedAt === null));
    guided.hidden = !run; guidedVehicle = run?.vehicleId ?? null;
    guidedNote.textContent = run ? `${run.program === 'vehicle-schedule' ? 'Vehicle schedule test' : 'Immediate charging test'} · ${run.phase.replaceAll('-', ' ')}` : '';
    const nextSignature = JSON.stringify(report);
    if (signature === nextSignature) return;
    signature = nextSignature;
    facts.replaceChildren(...chargingReportFacts(report, timezone).flatMap(([label, value]) => [make('dt', label), make('dd', value)]));
    facts.hidden = !report;
    findings.replaceChildren(...(report?.findings ?? []).map(row => {
      const item = make('li'), [label, detail] = FINDINGS[row.code] ?? ['Observation', 'See the timeline for this event.'];
      item.dataset.state = row.resolvedAt !== null ? 'recovered' : row.severity;
      item.append(make('strong', label), make('p', detail), make('small', `${time(row.firstAt, timezone)}${row.resolvedAt !== null ? ` · Recovered ${time(row.resolvedAt, timezone)}` : report.endedAt !== null ? ' · Unresolved at unplugging' : ' · Current'}`, 'muted'));
      return item;
    }));
    findings.hidden = !report?.findings?.length;
    coverage.replaceChildren(...Object.entries(COVERAGE).flatMap(([key, label]) => {
      const check = report?.coverage?.[key], value = check?.state === 'verified' ? 'Observed' : check?.state === 'insufficient-evidence' ? 'Insufficient evidence' : 'Not exercised';
      const term = make('dt', label), description = make('dd', value); description.dataset.state = check?.state ?? 'not-exercised'; return [term, description];
    }));
    coverageTitle.hidden = coverage.hidden = !report;
    timeline.replaceChildren(...(report?.timeline ?? []).slice().reverse().map(row => {
      const item = make('li'), stamp = make('time', time(row.at, timezone)); stamp.dateTime = new Date(row.at).toISOString();
      const changes = chargingPlanChanges(row.changes, timezone);
      const controlLabels = { off: 'Charging control off', waiting: 'Controller waiting', paused: 'Controller pause', active: 'Controller charging permission active',
        released: 'Controller restriction released', provisional: 'Provisional charging permission', identifying: 'Identification permission active',
        unconfirmed: 'Charger instruction unconfirmed', 'pause-unconfirmed': 'Pause unconfirmed', uncertain: 'Charger instruction uncertain',
        'ownership-uncertain': 'Instruction ownership uncertain', unavailable: 'Charging control unavailable', yielded: 'Charger instruction has priority', manual: 'Manual charger instruction', disconnected: 'Charger disconnected' };
      const contradictedDraw = row.kind === 'physical' && ['charging-started', 'charging-observed'].includes(row.code)
        && Number.isFinite(row.powerKw) && row.powerKw <= 0.1;
      const label = contradictedDraw ? 'Charging was recorded; saved power does not confirm draw'
        : row.kind === 'finding' ? FINDINGS[row.code]?.[0] ?? 'Finding recorded'
        : row.kind === 'recovery' ? `${FINDINGS[row.code]?.[0] ?? 'Issue'} · recovered`
          : row.kind === 'plan' ? row.code === 'initial-plan' ? 'Initial planning snapshot' : changes.length ? 'Planning changes recorded' : 'Planning snapshot recorded'
            : row.kind === 'control' ? controlLabels[row.code] ?? 'Control state recorded' : EVENTS[row.code] ?? 'Event recorded';
      item.append(stamp, make('span', `${label}${row.vehicleId ? ` · ${row.vehicleId === 'bmw' ? 'BMW' : 'Tesla'}` : ''}`));
      if (Number.isFinite(row.powerKw)) item.append(make('small', `Measured draw ${number(row.powerKw)} kW`, 'muted'));
      if (Number.isFinite(row.measuredAt) || Number.isFinite(row.receivedAt)) item.append(make('small',
        `${sourceName(row.source) ? `${sourceName(row.source)} · ` : ''}Measured ${time(row.measuredAt, timezone, true)} · Received ${time(row.receivedAt, timezone, true)}`, 'muted'));
      if (row.kind === 'charger-status' && (Number.isFinite(row.powerMeasuredAt) || Number.isFinite(row.powerReceivedAt))) item.append(make('small',
        `Power measured ${time(row.powerMeasuredAt, timezone, true)} · Received ${time(row.powerReceivedAt, timezone, true)}`, 'muted'));
      appendChanges(item, changes, true);
      if (row.kind === 'plan' && changes.length && !changes.some(change => change.field === 'periods'))
        item.append(make('small', 'Charging periods unchanged', 'muted'));
      return item;
    }));
    plans.replaceChildren(...(report?.plans ?? []).slice().reverse().map(plan => {
      const item = make('li'), view = chargingPlanPresentation(plan, timezone);
      item.append(make('strong', `${time(plan.at, timezone)} · ${view.title}`), make('p', view.control),
        make('p', view.vehicle, 'muted'), make('p', view.inputs), make('p', view.deadline, 'muted'));
      appendChanges(item, view.changes);
      if (view.periodsUnchanged) item.append(make('p', 'Charging periods unchanged', 'muted'));
      item.append(make('p', view.periodLabel, 'charging-report-period-label'));
      if (plan.scheduleState !== 'none') item.append(make('p', view.periods, 'charging-report-period'));
      if (plan.provisional === true) item.append(make('p', 'The controller proposed a provisional release with incomplete planning inputs.', 'muted'));
      if (plan.feasible === false) item.append(make('p', 'The recorded forecast could not meet the requested target by ready-by.', 'muted'));
      if (plan.priceCoverageTruncated === true) item.append(make('p', 'The stored electricity-rate horizon is bounded; it does not contain every planning interval.', 'muted'));
      return item;
    }));
    if (report && !report.plans?.length) plans.append(make('li', report.current?.scheduleState === 'none'
      ? 'No controller charging schedule was recorded.' : 'No planning snapshots were recorded. Schedule execution cannot be established from this report.'));
    timelineDetails.hidden = plansDetails.hidden = !report;
    const dropped = report ? Object.values(report.truncated ?? {}).reduce((total, count) => total + count, 0) : 0;
    limits.textContent = report ? `Draw checks use measured power above 0.1 kW. Power can include vehicle auxiliaries; it does not prove energy entering the battery. Charger status alone does not confirm draw. Unobserved intervals remain unverified.${dropped ? ` ${dropped} older detail entries were omitted by bounded retention; opening evidence and recent changes remain.` : ''}` : '';
  }
  function close() { if (dialog.open) dialog.close(); }
  function open(chargerId, reportId = null) {
    selectedCharger = chargerId ?? selectedCharger; selectedReport = reportId; signature = null;
    opener = buttons.get(chargerId) ?? document.activeElement;
    render(); if (!dialog.open) dialog.showModal();
    opener?.setAttribute?.('aria-expanded', 'true'); closeButton.focus();
  }
  closeButton.addEventListener('click', close);
  guidedButton.addEventListener('click', () => { switchingDialog = true; close(); onOpenTest(guidedVehicle); });
  selector.addEventListener('change', () => { selectedReport = selector.value; signature = null; render(); });
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
      button.textContent = summary.label === 'Session report' ? 'Session report' : `Report · ${summary.label}`;
      button.dataset.state = summary.state;
      button.setAttribute('aria-label', `${charger.label ?? charger.id} session report · ${summary.label}`);
    }
    if (dialog.open) render();
  } };
}
