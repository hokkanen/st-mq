const OUTCOMES = { 'in-progress': 'Session in progress', 'target-confirmed': 'Target confirmed by vehicle',
  'target-estimated': 'Target estimated · awaiting vehicle evidence', 'deadline-missed': 'Target not reached by ready-by',
  'completion-unknown': 'Unplugged · completion unconfirmed', interrupted: 'Observation interrupted' };
const BEHAVIOR = { observing: 'Observing', expected: 'Observed checks passed', explained: 'Changes explained below',
  attention: 'Needs attention', 'insufficient-evidence': 'Evidence incomplete' };
const COVERAGE = { identification: 'Vehicle identification', initialRelease: 'Allowed charging observed', pause: 'Intermediate pause',
  resume: 'Resume after pause', lateReplan: 'Inputs reassessed after identification', targetAttainment: 'Requested target reached',
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
const EVENTS = { connected: 'Vehicle connected', 'observation-started': 'Observation began during this connection',
  unplugged: 'Vehicle unplugged', 'connection-replaced': 'Connection changed', 'observation-gap': 'Observation gap · no physical conclusion for the missing interval',
  'charging-started': 'Physical charging observed', 'charging-stopped': 'Physical charging stopped', 'physical-unknown': 'Physical charging evidence unavailable',
  identified: 'Vehicle identified', waiting: 'Waiting', charging: 'Identification observing charge', pausing: 'Identification pause requested',
  inconclusive: 'Identification inconclusive', complete: 'Identification completed', cancelled: 'Identification cancelled',
  'initial-plan': 'Initial charging plan recorded', 'vehicle-identification': 'Plan inputs updated after identification',
  'session-settings': 'Plan updated after session settings changed', 'target-update': 'Plan updated after target reading',
  'vehicle-start-update': 'Plan updated after vehicle start reading', 'price-update': 'Plan updated after prices changed',
  'planner-reassessment': 'Production planner reassessed the remaining session', 'target-changed': 'Requested target changed',
  ...OUTCOMES, ...COVERAGE };
const time = (value, timezone = 'Europe/Helsinki') => Number.isFinite(value)
  ? new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(value) : 'Unknown';
const percent = value => Number.isFinite(value) ? `${Math.round(value)}%` : 'Unknown';

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
  const guided = make('div', '', 'charging-report-guided'), guidedNote = make('span'), guidedButton = make('button', 'View guided test', 'secondary-button');
  guidedButton.type = 'button'; guided.append(guidedNote, guidedButton); guided.hidden = true;
  const coverageTitle = make('h3', 'What was observed'), coverage = make('dl', '', 'charging-report-coverage');
  const timelineDetails = make('details', '', 'charging-report-fold'), timeline = make('ol', '', 'charging-report-timeline');
  timelineDetails.append(make('summary', 'Session timeline'), timeline);
  const plansDetails = make('details', '', 'charging-report-fold'), plans = make('ol', '', 'charging-report-plans');
  plansDetails.append(make('summary', 'Recorded plans & inputs'), plans);
  const limits = make('p', '', 'muted');
  dialog.append(heading, help, selectorLabel, result, context, guided, findings, coverageTitle, coverage, timelineDetails, plansDetails, limits);
  document.body.append(dialog);
  const buttons = new Map();
  let status = null, selectedCharger = null, selectedReport = null, opener = null, signature = null, guidedVehicle = null, switchingDialog = false;
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
      const label = row.kind === 'finding' ? FINDINGS[row.code]?.[0] : row.kind === 'recovery' ? `${FINDINGS[row.code]?.[0] ?? 'Issue'} · recovered` : EVENTS[row.code] ?? `Controller: ${row.code.replaceAll('-', ' ')}`;
      item.append(stamp, make('span', `${label}${row.vehicleId ? ` · ${row.vehicleId === 'bmw' ? 'BMW' : 'Tesla'}` : ''}`));
      if (Number.isFinite(row.measuredAt) || Number.isFinite(row.receivedAt)) item.append(make('small', `Source ${time(row.measuredAt, timezone)} · received ${time(row.receivedAt, timezone)}`, 'muted'));
      return item;
    }));
    plans.replaceChildren(...(report?.plans ?? []).slice().reverse().map(plan => {
      const item = make('li');
      item.append(make('strong', `${time(plan.at, timezone)} · ${EVENTS[plan.reason] ?? 'Plan reassessed'}`),
        make('p', `${percent(plan.inputs?.soc?.value)} → ${percent(plan.inputs?.target?.value)} · ${Number.isFinite(plan.inputs?.capacity?.value) ? `${plan.inputs.capacity.value} kWh ${plan.inputs.capacity.assumed ? 'assumed' : 'reported'} capacity` : 'Capacity unknown'} · Ready by ${time(plan.deadlineAt, timezone)}`),
        make('p', `Charge input: ${plan.inputs?.soc?.source === 'manual-fallback' ? 'configured assumption' : ['session-anchor', 'session-request'].includes(plan.inputs?.soc?.source) ? 'session entry' : plan.inputs?.soc?.source === 'unavailable' ? 'unknown' : 'vehicle reading'}${plan.provisional ? ' · Provisional release' : ''}${plan.feasible === false ? ' · Forecast shortfall' : ''}`, 'muted'));
      for (const period of plan.periods ?? []) item.append(make('p', `${time(period.startAt, timezone)} → ${period.endAt === null ? 'open release' : time(period.endAt, timezone)}`, 'charging-report-period'));
      return item;
    }));
    timelineDetails.hidden = plansDetails.hidden = !report;
    const dropped = report ? Object.values(report.truncated ?? {}).reduce((total, count) => total + count, 0) : 0;
    limits.textContent = report ? `Coverage describes witnessed checks, not a guarantee for unobserved intervals. The final release remains open; the vehicle decides when to stop.${dropped ? ` ${dropped} older detail entries were omitted by bounded retention; opening evidence and recent changes remain.` : ''}` : '';
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
