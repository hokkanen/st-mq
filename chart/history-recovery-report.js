const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const sourceTables = { imports: 'CSV imports', import_rows: 'CSV rows', observations: 'Observations',
  recorder_coverage: 'Recording coverage', provider_snapshot_contents: 'Provider snapshots', provider_snapshot_fetches: 'Provider fetches',
  annotations: 'Annotations', counters: 'Counter readings', fireplace_events: 'Firewood events', learning_cycles: 'Learning cycles',
  events: 'Events', energy_audits: 'Energy audits', learning_journal: 'Learning journal',
  recorder_pending_energy: 'Open energy intervals', charging_session_keys: 'Charging session references' };

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false, comparison = false, source = 'peer' } = {}) {
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
  if (checked) {
    for (const row of data.tables ?? []) if (Object.hasOwn(sourceTables, row.name)) appendCount(sourceTables[row.name], row.count);
  } else for (const [key, title] of fields) appendCount(title, totals[key], !comparison && key !== 'duplicates' && totals[key] > 0);
  if (counts.children.length) root.append(counts);
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
    : data.recoverySkipped ? 'Gap recovery was deliberately skipped. The master history and model were kept; the other computer’s unmatched history was discarded, without a separate archive.'
    : source === 'backup' ? 'Existing history takes precedence. The source backup stays unchanged. Conflicting or unsupported entries are skipped; recorded gaps remain unknown where no usable evidence exists.'
      : 'Existing master history wins overlaps. Skipped donor entries are not kept as a separate archive after successful recovery and verified mirroring.';
  root.append(policy);
}
