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
  const outages = data.outages;
  if (count(outages?.total) !== null) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.dataset.recoverySection = 'outages'; details.open = expanded.has('outages');
    summary.textContent = `Explicitly recorded ${source === 'backup' ? 'local' : 'master'} outages · ${outages.total}`; details.append(summary);
    const note = document.createElement('p'); note.className = 'muted';
    note.textContent = 'Each entry is an explicit unavailable energy interval or a period with recorded unavailable, stale or failed reports. Report periods end at the last saved outage evidence, not a claimed recovery time. Relevant source records are potential coverage only; matching measurement names do not prove device identity, complete phase groups or recoverability.';
    details.append(note);
    if (count(outages.omitted) > 0) {
      const limit = document.createElement('p'); limit.textContent = `Showing the latest ${outages.items.length} outage records; ${outages.omitted} older records are not shown.`; details.append(limit);
    }
    const list = document.createElement('ul'); list.className = 'history-recovery-outages';
    for (const outage of outages.items ?? []) {
      const item = document.createElement('li'), label = document.createElement('strong'), period = document.createElement('span'), match = document.createElement('small');
      label.textContent = ({ ev1: 'Charger 1 energy',ev2: 'Charger 2 energy',property: 'Property energy',caravan: 'Caravan energy' })[outage.energyPrefix]
        ?? (Object.hasOwn(SIGNAL_INFO,outage.signal) || outage.signal === 'shelly_limiter_mode'
        ? recordedSignalInfo(outage.signal).label : 'Recorded measurement');
      period.textContent = `${dates(outage)} · ${outage.basis === 'energy-interval' ? 'Unavailable energy interval' : 'Recorded report period'}`;
      match.textContent = outage.potentialCoverage === true ? 'Relevant source records present · potential coverage'
        : 'No relevant usable source records found in this recorded period';
      item.append(label,period,match); list.append(item);
    }
    details.append(list); section.append(details);
  }
  const limits = document.createElement('p'); limits.className = 'muted';
  limits.textContent = 'Potential coverage is not a count of missing or recoverable records. Existing records, conflicts, source quality and learning effects are decided during recovery. An entry spanning both date boundaries can appear in both extension counts.';
  section.append(limits); root.append(section);
}

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false, comparison = false, source = 'peer' } = {}) {
  const reportKey = data?.previewId ?? '';
  const expanded = new Set(root.dataset.recoveryReportId === reportKey
    ? [...(root.querySelectorAll?.('details[data-recovery-section][open]') ?? [])].map(node => node.dataset.recoverySection) : []);
  root.dataset.recoveryReportId = reportKey;
  root.replaceChildren(); root.hidden = !data;
  if (!data) return;
  const checked = data.status === 'checked';
  const heading = document.createElement('h3'); heading.textContent = data.recoverySkipped ? 'Mirroring resumed without recovery'
    : checked ? 'History source checked' : report ? 'Recovery result' : 'Recovery preview'; root.append(heading);
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
    line.textContent = 'These are source record counts. Missing entries, conflicts and model changes have not yet been assessed.'
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
}
