import { recordedSignalInfo } from '../src/domain/recording-policy.js';
import { SIGNAL_INFO } from '../src/domain/history-series.js';

const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sourceTables = { imports: 'CSV imports', import_rows: 'CSV rows', observations: 'Observations',
  recorder_coverage: 'Recording coverage', provider_snapshot_contents: 'Provider snapshots', provider_snapshot_fetches: 'Provider fetches',
  annotations: 'Annotations', counters: 'Counter readings', fireplace_events: 'Firewood events', learning_cycles: 'Learning cycles',
  events: 'Events', energy_audits: 'Energy audits', learning_journal: 'Learning journal',
  recorder_pending_energy: 'Open energy intervals', charging_session_keys: 'Charging session references' };
const coverageCategories = { ...sourceTables, energy: 'Recorded energy', temperatures: 'Temperatures', other_observations: 'Other measurements and states',
  charging_reports: 'Saved charging reports',charging_report_events: 'Charging report events' };
const signalLabel = signal => Object.hasOwn(SIGNAL_INFO,signal) || ['charger1_current_allowance', 'charger2_current_allowance'].includes(signal)
  ? recordedSignalInfo(signal).label : 'Recorded measurement';
const energyLabel = prefix => ({ ev1: 'Charger 1 energy',ev2: 'Charger 2 energy',property: 'Property energy',caravan: 'Caravan energy' })[prefix];
const evidenceRecords = item => count(item.records) > 0 ? item.records : 1;
const recordCount = value => `${value} ${value === 1 ? 'record' : 'records'}`;

function renderEvidence(document, section, evidence, { formatTime, expanded }) {
  if (count(evidence?.total) === null) return;
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  const energy = items.filter(item => item.basis === 'energy-interval' && stamp(item.from) && stamp(item.to) > item.from);
  const diagnostics = items.filter(item => !energy.includes(item));
  const energyTotal = count(evidence.counts?.energyIntervals);
  const periodTotal = count(evidence.counts?.reportPeriods), pointTotal = count(evidence.counts?.pointEvents);
  const diagnosticTotal = periodTotal !== null && pointTotal !== null ? periodTotal + pointTotal : null;
  const disclosure = (parent, key, title) => {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.dataset.recoverySection = key; details.open = expanded.has(key);
    summary.textContent = title; details.append(summary); parent.append(details); return details;
  };
  const paragraph = (parent, value) => {
    const note = document.createElement('p'); note.className = 'muted'; note.textContent = value; parent.append(note);
  };
  const shown = rows => rows.reduce((sum,item) => sum + evidenceRecords(item),0);
  const titleCount = (total, rows) => total === null ? `${shown(rows)} shown` : String(total);
  const limited = (parent, total, rows, noun) => {
    if (total !== null && total > shown(rows)) paragraph(parent, `Showing ${shown(rows)} of ${total} ${noun}; older records are not shown.`);
  };
  const gaps = disclosure(section,'energy-gaps',`Recorded energy gaps · ${titleCount(energyTotal,energy)}`);
  paragraph(gaps,'Explicit unavailable energy intervals. Relevant source records are potential coverage; device identity, phase completeness and import acceptance are assessed during recovery.');
  limited(gaps,energyTotal,energy,'energy intervals');
  if (!energy.length) paragraph(gaps,energyTotal === 0 ? 'No recorded energy gaps.' : 'No energy intervals in the displayed evidence.');
  const list = document.createElement('ul'); list.className = 'history-recovery-outages';
  for (const gap of energy) {
    const item = document.createElement('li'), label = document.createElement('strong'), period = document.createElement('span'), match = document.createElement('small');
    label.textContent = energyLabel(gap.energyPrefix) ?? signalLabel(gap.signal);
    period.textContent = `${formatTime(gap.from)} – ${formatTime(gap.to)}`;
    match.textContent = gap.potentialCoverage === true ? 'Relevant source records present · potential coverage'
      : 'No relevant usable source records found in this interval';
    item.append(label,period,match); list.append(item);
  }
  gaps.append(list);
  const details = disclosure(section,'availability-diagnostics',`Availability diagnostics · ${diagnosticTotal === null ? `${recordCount(shown(diagnostics))} shown` : recordCount(diagnosticTotal)}`);
  paragraph(details,`${pointTotal !== null && periodTotal !== null ? `${pointTotal} point ${pointTotal === 1 ? 'record' : 'records'} · ${periodTotal} report-period ${periodTotal === 1 ? 'record' : 'records'}. ` : ''}These are availability reports, not computer outages.`);
  paragraph(details,'Grouped signals share source, evidence times and reason. Periods end at the last report, not a confirmed recovery time.');
  limited(details,diagnosticTotal,diagnostics,'diagnostic records');
  const events = document.createElement('ul'); events.className = 'history-recovery-diagnostics';
  for (const [index, entry] of diagnostics.entries()) {
    const item = document.createElement('li'), from = stamp(entry.from), to = stamp(entry.to), point = from === to || !to;
    const reason = ({ retained: 'Retained message',stale: 'Stale report',failed: 'Failed report',unavailable: 'Unavailable report' })[entry.reason]
      ?? ({ stale: 'Stale report',failed: 'Failed report' })[entry.status] ?? 'Unavailable report';
    const records = evidenceRecords(entry);
    const group = disclosure(item,`diagnostic-${index}`,`${reason}${records === 1 ? '' : 's'} · ${recordCount(records)}`);
    const period = document.createElement('span'); period.className = 'history-recovery-diagnostic-time';
    period.textContent = !from ? 'Evidence time unavailable' : point ? `${formatTime(from)} · duration unknown`
      : `${formatTime(from)} – ${formatTime(to)} · first and last evidence${to - from < 1000 ? ` (${to - from} ms apart)` : ''}`;
    group.children[0].append(period);
    const signals = document.createElement('ul'); signals.className = 'history-recovery-diagnostic-signals';
    for (const label of new Set((Array.isArray(entry.signals) && entry.signals.length ? entry.signals : [entry.signal]).map(signalLabel))) {
      const signal = document.createElement('li'); signal.textContent = label; signals.append(signal);
    }
    group.append(signals); events.append(item);
  }
  details.append(events);
  if (energyTotal === null && count(evidence.omitted) > 0) paragraph(section,`${evidence.omitted} older evidence records are not shown. Category totals are unavailable for this check.`);
}

function renderCoverage(document, root, data, { formatTime, source, expanded }) {
  if (!Array.isArray(data?.categories)) return;
  const section = document.createElement('section'); section.className = 'history-recovery-coverage';
  const heading = document.createElement('h4'); heading.textContent = 'History date ranges'; section.append(heading);
  const explanation = document.createElement('p'); explanation.className = 'muted';
  explanation.textContent = 'First and last recorded dates are not continuous coverage. Sparse measurements do not establish outages. Dates use saved measurement or interval times, receipt times when missing, and fetch times for provider data. Times are shown in Finnish time.';
  section.append(explanation);
  const table = document.createElement('table'); table.className = 'history-recovery-ranges';
  const head = document.createElement('thead'), headings = document.createElement('tr');
  for (const label of ['Category', source === 'backup' ? 'This computer' : 'Master', source === 'backup' ? 'Backup' : 'Other computer']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headings.append(cell);
  }
  head.append(headings); table.append(head);
  const body = document.createElement('tbody');
  const dates = range => {
    const from = stamp(range?.from), to = stamp(range?.to);
    return from && to ? `${formatTime(from)} – ${formatTime(to)}` : count(range?.count) > 0 ? 'Dates unavailable' : 'No records';
  };
  for (const row of data.categories) {
    if (!Object.hasOwn(coverageCategories,row.name) || !count(row.master?.count) && !count(row.source?.count)) continue;
    const tr = document.createElement('tr'), label = document.createElement('th'); label.scope = 'row';
    label.textContent = coverageCategories[row.name]; tr.append(label);
    for (const side of ['master','source']) {
      const cell = document.createElement('td'), range = row[side]; cell.textContent = dates(range);
      if (count(range?.count) > 0) {
        const detail = document.createElement('small'); detail.textContent = `${range.count} records${count(range.undated) > 0 ? ` · ${range.undated} without dates` : ''}`; cell.append(detail);
      }
      const outside = range?.outsideMaster;
      const messages = [];
      if (count(outside?.withoutMasterRange?.count) > 0) messages.push('No matching local date range');
      if (count(outside?.before?.count) > 0) messages.push(`${outside.before.count} entries extend earlier`);
      if (count(outside?.after?.count) > 0) messages.push(`${outside.after.count} entries extend later`);
      if (messages.length) {
        const potential = document.createElement('small'); potential.className = 'history-recovery-potential';
        potential.textContent = `${['charging_reports','charging_report_events'].includes(row.name) ? 'Additional retained history' : 'Potential coverage'}: ${messages.join('; ')}.`; cell.append(potential);
      }
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(body); section.append(table);
  if (data.categories.some(row => ['charging_reports','charging_report_events'].includes(row.name) && (count(row.master?.count) > 0 || count(row.source?.count) > 0))) {
    const note = document.createElement('p'); note.className = 'muted';
    note.textContent = 'Saved charging reports and their events are not merged by recovery. They remain in the original source database. An unfinished report contributes its start date only.'; section.append(note);
  }
  renderEvidence(document,section,data.outages,{ formatTime,expanded });
  const limits = document.createElement('p'); limits.className = 'muted';
  limits.textContent = 'Potential coverage is not a count of missing or recoverable records. Existing records, conflicts, source quality and learning effects are decided during recovery. An entry spanning both date boundaries can appear in both extension counts.';
  section.append(limits); root.append(section);
}

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false, comparison = false, comparisonStale = false, source = 'peer' } = {}) {
  const reportKey = data?.previewId ?? '';
  const focused = root.dataset.recoveryReportId === reportKey && root.contains?.(document.activeElement)
    ? document.activeElement?.closest?.('details[data-recovery-section]')?.dataset.recoverySection : null;
  const expanded = new Set(root.dataset.recoveryReportId === reportKey
    ? [...(root.querySelectorAll?.('details[data-recovery-section][open]') ?? [])].map(node => node.dataset.recoverySection) : []);
  root.dataset.recoveryReportId = reportKey;
  root.replaceChildren(); root.hidden = !data;
  if (!data) return;
  const checked = data.status === 'checked';
  const heading = document.createElement('h3'); heading.textContent = data.recoverySkipped ? 'Mirroring resumed without recovery'
    : checked && comparison ? comparisonStale ? 'Review the current pairing problem' : 'No recovery needed'
      : checked ? 'History source checked' : report ? 'Recovery result' : 'Recovery preview';
  if (checked && comparison) {
    const outcome = document.createElement('div'), icon = document.createElement('span'), detail = document.createElement('p');
    outcome.className = 'history-recovery-outcome'; outcome.dataset.tone = comparisonStale ? 'attention' : 'success';
    icon.className = 'history-recovery-outcome-icon'; icon.textContent = comparisonStale ? '!' : '✓'; icon.setAttribute('aria-hidden', 'true');
    detail.textContent = comparisonStale ? 'This earlier slave snapshot needed no recovery. The current pairing problem requires attention; check again after resolving it.'
      : 'Valid slave snapshot. Mirroring applies the master’s changes automatically. This does not prove that the latest changes have arrived.';
    outcome.append(icon, heading, detail); root.append(outcome);
  } else root.append(heading);
  const software = data.sourceSoftware;
  if (software?.format === 1 && typeof software.applicationVersion === 'string' && software.applicationVersion.length <= 80
    && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(software.applicationVersion)
    && Number.isSafeInteger(software.exportedAt) && software.exportedAt > 0 && software.exportedAt <= 8640000000000000) {
    const provenance = document.createElement('p'); provenance.className = 'muted history-recovery-provenance';
    provenance.textContent = `Backup exported by application version ${software.applicationVersion}${stamp(software.exportedAt) ? ` · ${formatTime(software.exportedAt)}` : ''}. This identifies the export software, not the original recording version.`;
    root.append(provenance);
  }
  const fields = [...(!report || data.recoverySkipped ? [['missing', comparison ? 'Only in the other snapshot' : data.recoverySkipped ? 'Missing entries not recovered' : 'Missing entries']] : []), ['conflicts', comparison ? 'Different entries' : 'Conflicting entries'], ['duplicates', 'Already present'], ['skipped', 'Skipped entries']];
  const totals = data.counts ?? {};
  const counts = document.createElement('dl'); counts.className = 'history-recovery-counts';
  function appendCount(title, value, attention = false) {
    if (count(value) === null) return;
    const item = document.createElement('div'), label = document.createElement('dt'), number = document.createElement('dd');
    label.textContent = `${title}:`; number.textContent = String(value);
    if (attention) item.dataset.tone = 'attention';
    item.append(label, number); counts.append(item);
  }
  appendCount('Recovered entries', data.imported);
  if (data.incremental) {
    const scope = document.createElement('p'); scope.className = 'muted';
    scope.textContent = 'Changed source records since the shared checkpoint, including required references. These counts do not include unchanged earlier history.';
    root.append(scope);
  }
  if (checked) renderCoverage(document, root, data.coverage, { formatTime, source, expanded });
  if (checked) {
    for (const row of data.tables ?? []) if (Object.hasOwn(sourceTables, row.name)) appendCount(sourceTables[row.name], row.count);
  } else for (const [key, title] of fields) appendCount(title, totals[key], !comparison && key !== 'duplicates' && totals[key] > 0);
  if (counts.children.length) {
    if (checked && data.coverage) {
      const details = document.createElement('details'), summary = document.createElement('summary');
      details.dataset.recoverySection = 'inventory'; details.open = expanded.has('inventory');
      summary.textContent = 'Source record inventory'; details.append(summary,counts); root.append(details);
    } else root.append(counts);
  }
  if (checked) {
    const line = document.createElement('p');
    line.textContent = `${data.incremental ? 'These are changed source record counts.' : 'These are source record counts.'} Missing entries, conflicts and model changes have not yet been assessed.`
      + (comparison ? '' : ' Recovery compares and imports history once, then rebuilds the model only if needed.');
    root.append(line);
  }
  const from = stamp(data.period?.from), to = stamp(data.period?.to);
  if (from || to) { const line = document.createElement('p'); line.textContent = `${comparison ? 'Entries only in the other snapshot span' : data.recoverySkipped ? 'Unrecovered entries span' : report ? 'Recovered entries span' : 'Missing entries span'}: ${from ? formatTime(from) : 'unknown'} – ${to ? formatTime(to) : 'unknown'}.`; root.append(line); }
  if (data.model?.status === 'rebuild-required' && !data.recoverySkipped && !comparison) {
    const line = document.createElement('p');
    line.textContent = report ? 'The recovered learning history is used to rebuild the model. Check the recovery status above for completion.' : 'Recovery includes rebuilding the learned model.';
    root.append(line);
  }
  if (data.model?.status === 'rebuilt') {
    const line = document.createElement('p'); line.textContent = 'The rebuilt model has caught up and is published.'; root.append(line);
  }
  if (count(data.model?.unsupported) > 0) {
    const line = document.createElement('p'); line.textContent = `Unsupported learning entries skipped: ${data.model.unsupported}.`; root.append(line);
  }
  if (count(data.sourceAssessment?.skippedLearningRecords) > 0) {
    const line = document.createElement('p');
    line.textContent = `${data.sourceAssessment.skippedLearningRecords} learning records use another input and are skipped. Their original history remains separate.`;
    root.append(line);
  }
  const policy = document.createElement('p'); policy.className = 'muted';
  policy.textContent = comparison ? 'This source check used a normal slave snapshot. Mirroring applies the master’s history automatically; this check does not authorize importing entries.'
    : data.recoverySkipped ? 'Gap recovery was deliberately skipped. The master history and model were kept. The other computer’s previous database is retained inactive while mirroring uses the master history; it is never reused automatically.'
    : source === 'backup' ? 'Existing history takes precedence. The source backup stays unchanged. Conflicting or unsupported entries are skipped; recorded gaps remain unknown where no usable evidence exists.'
      : 'Existing master history wins overlaps. After verified mirroring, the other computer’s previous database is retained inactive, including skipped history. It is never reused automatically.';
  root.append(policy);
  if (focused) [...(root.querySelectorAll?.('details[data-recovery-section]') ?? [])]
    .find(node => node.dataset.recoverySection === focused)?.querySelector('summary')?.focus({ preventScroll: true });
}
