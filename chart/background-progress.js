const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = new Intl.NumberFormat('en');

export function elapsedTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

/** A fraction describes this phase only. Missing or inconsistent totals stay indeterminate. */
export function backgroundProgress(progress, { startedAt, finishedAt, now = Date.now() } = {}) {
  const processed = count(progress?.processed), total = count(progress?.total);
  const determinate = processed !== null && total !== null && total > 0 && processed <= total;
  const unit = ['records', 'entries', 'pages', 'bytes'].includes(progress?.unit) ? progress.unit
    : progress?.phase === 'checking' ? 'source groups' : 'records';
  const work = processed === null || processed === 0 && total === null && progress?.unit === undefined ? ''
    : determinate ? `${number.format(processed)} of ${number.format(total)} ${unit}`
    : `${number.format(processed)} ${unit} processed`;
  const time = [];
  if (Number.isFinite(startedAt) && startedAt > 0) time.push(`Elapsed ${elapsedTime((finishedAt ?? now) - startedAt)}`);
  if (!finishedAt && Number.isFinite(progress?.updatedAt) && progress.updatedAt > 0) {
    time.push(now - progress.updatedAt < 2000 ? 'Progress just updated' : `Last progress ${elapsedTime(now - progress.updatedAt)} ago`);
  }
  return { processed, total, determinate, work, timing: time.join(' · ') };
}

export function renderProgressBar(element, progress) {
  if (progress.determinate) {
    element.max = progress.total; element.value = progress.processed;
  } else element.removeAttribute('value');
  element.setAttribute('aria-valuetext', progress.work || 'Working; total not yet known');
}
