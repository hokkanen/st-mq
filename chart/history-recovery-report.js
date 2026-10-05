const stamp = value => Number.isFinite(value) && value > 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Render only whitelisted aggregates, never a donor record or serialized error. */
export function renderRecoveryReport(document, root, data, { formatTime = at => new Date(at).toISOString(), report = false, comparison = false, source = 'peer' } = {}) {
  root.replaceChildren(); root.hidden = !data;
  if (!data) return;
  const heading = document.createElement('h3'); heading.textContent = comparison ? 'History comparison' : data.recoverySkipped ? 'Mirroring resumed without recovery' : report ? 'Recovery result' : 'Recovery preview'; root.append(heading);
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
  for (const [key, title] of fields) appendCount(title, totals[key], !comparison && key !== 'duplicates' && totals[key] > 0);
  if (counts.children.length) root.append(counts);
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
  policy.textContent = comparison ? 'This is a comparison with a normal slave snapshot. Differences can reflect snapshot age or master deletions. Mirroring applies the master’s history automatically; these entries are not imported.'
    : data.recoverySkipped ? 'Gap recovery was deliberately skipped. The master history and model were kept; the other computer’s unmatched history was discarded, without a separate archive.'
    : source === 'backup' ? 'Existing history takes precedence. The source backup stays unchanged. Conflicting or unsupported entries are skipped; recorded gaps remain unknown where no usable evidence exists.'
      : 'Existing master history wins overlaps. Skipped donor entries are not kept as a separate archive after successful recovery and verified mirroring.';
  root.append(policy);
}
