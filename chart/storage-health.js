const finite = value => Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const validDate = value => finite(value) && value <= 8_640_000_000_000_000;
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en-GB');
const dates = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function storageDuration(value) {
  if (!finite(value)) return 'Unknown';
  if (value < 1000) return `${number.format(value)} ms`;
  if (value < 60_000) return `${number.format(value / 1000)} s`;
  if (value < 3600_000) return `${number.format(value / 60_000)} min`;
  if (value < 86400_000) return `${number.format(value / 3600_000)} h`;
  return `${number.format(value / 86400_000)} d`;
}

const coverageDuration = value => {
  if (!finite(value) || value < 60_000) return storageDuration(value);
  const minutes = Math.floor(value / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (hours === 0) return `${minutes} min`;
  if (hours <= 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ''}${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
};

const observedCount = value => count(value) ? integer.format(value) : 'Unknown';
const timing = (value, label) => {
  const samples = count(value?.count) ? value.count : null;
  const missing = samples === 0 ? 'No samples' : 'Unknown';
  return { mean: samples > 0 ? storageDuration(value.meanMs) : missing,
    p95: samples > 0 ? storageDuration(value.p95Ms) : missing,
    worst: samples > 0 ? storageDuration(value.maxMs) : missing,
    samples: samples === null ? 'Sample count unknown' : `${integer.format(samples)} ${label}` };
};

const incidentCategories = {
  'save-failed': 'Save failed', 'queue-refused': 'Queue-full refusal',
  'command-not-sent': 'MQTT command not sent', 'follow-up-failed': 'Saved; follow-up failed',
};
const incidentContexts = {
  storage: 'Storage', 'mqtt-input': 'Received MQTT update', 'provider-input': 'Provider update',
  'charging-input': 'Charging update', 'heat-pump-command': 'Heat-pump command',
  'switch-command': 'Switch command', 'cover-command': 'Cover command', 'garage-command': 'Garage command',
};
const incidentReasons = {
  'write-queue-full': 'The queue was full.', 'disk-full': 'The disk was full.',
  'database-busy': 'The database remained busy.', 'database-read-only': 'The database was read-only.',
  'database-io': 'Storage reported an input/output error.', 'database-corrupt': 'The database reported corruption.',
  'database-unavailable': 'The database was unavailable.',
  'recording-failed': 'Recording failed before dispatch.',
  'recording-wait-expired': 'The command deadline expired while waiting for recording.',
  'follow-up-failed': 'The save completed, but subsequent work failed.',
};
const incidentOutcomes = {
  'save-failed': 'The save did not commit.',
  'not-retained-for-retry': 'The update was not retained for retry.',
  'retained-for-retry': 'The update was retained for retry.',
  'original-update-saved': 'The original update was saved on retry.',
  'queue-refused': 'The operation was refused before it entered the queue.',
  'command-not-sent': 'This command was not sent.',
  'saved-follow-up-failed': 'The committed save was not undone.',
};

function incidentView(value, lastWriteAt) {
  if (!Object.hasOwn(incidentCategories, value?.category) || !Object.hasOwn(incidentContexts, value?.context)
    || !Object.hasOwn(incidentReasons, value?.reason) || !Object.hasOwn(incidentOutcomes, value?.outcome) || !validDate(value.at)) return null;
  const originalRecovered = value.outcome === 'original-update-saved' && validDate(value.recoveredAt);
  const resumed = ['save-failed', 'queue-refused'].includes(value.category)
    && validDate(lastWriteAt) && lastWriteAt > value.at;
  const outcome = originalRecovered ? `The original update was saved on retry ${dates.format(new Date(value.recoveredAt))}.`
    : incidentOutcomes[value.outcome];
  const recovery = !originalRecovered && resumed ? `Saving resumed ${dates.format(new Date(lastWriteAt))}; this does not establish recovery of missing history.` : '';
  return { title: `${incidentCategories[value.category]} · ${incidentContexts[value.context]}`,
    detail: `${dates.format(new Date(value.at))} · ${incidentReasons[value.reason]} ${outcome}${recovery ? ` ${recovery}` : ''}` };
}

export function storagePerformanceView(health, period = 'day', { unavailable = false, now = Date.now() } = {}) {
  const history = health?.version === 2 && ['live', 'simulated'].includes(health.scope) && health.recording?.history?.version === 2
    ? health.recording.history : null;
  const window = history?.windows?.[period];
  const monitored = finite(window?.coveredMs) && window.coveredMs > 0;
  const partialRun = finite(window?.monitoredMs) && finite(window?.requestedMs) && window.monitoredMs < window.requestedMs;
  const stale = unavailable || !finite(health?.checkedAt) || Math.abs(now - health.checkedAt) > 180_000;
  const label = period === 'week' ? 'Past week' : 'Past day';
  const valid = Boolean(history && window);
  const observed = value => monitored ? observedCount(value) : 'Not monitored';
  const pending = history?.current ?? {};
  const queued = pending.pending === 0 ? 'No queued operations'
    : `${observedCount(pending.pending)} queued · oldest ${storageDuration(pending.oldestPendingMs)}`;
  const running = count(pending.activeJobs) && pending.activeJobs > 0 ? ` · ${integer.format(pending.activeJobs)} running` : '';
  const current = valid ? `${stale ? 'Last known: ' : ''}${queued}${running}` : '';
  let notice = !health ? 'Waiting for storage health information.'
    : health.scope === 'snapshot' ? 'These measurements are held only in the live controller’s memory. They are not included in a recorded snapshot.'
      : health.scope === 'history' ? 'Storage health is not monitored by the history viewer.'
        : !valid ? 'Storage health is unavailable for this recording scope.' : '';
  if (valid && stale) notice = unavailable ? 'Refresh failed. These are the last known measurements.'
    : health.checkedAt > now ? 'The server and browser clocks differ. These are the last known measurements.'
      : 'These are the last known measurements; the health check is out of date.';
  const contention = window?.contention;
  const historicProblems = [window?.failedWrites, window?.queueRejected, window?.commandsNotSent, window?.postCommitFailures];
  const knownOutcomes = monitored && historicProblems.every(count);
  const problemsObserved = monitored && historicProblems.some(value => count(value) && value > 0);
  let state = 'Storage status unknown', stateTone = 'neutral';
  if (valid) {
    if (health.recording.state === 'write-failed') { state = 'Save failed'; stateTone = 'critical'; }
    else if (finite(pending.waitingMs)) { state = 'Waiting for storage'; stateTone = 'warning'; }
    else if (count(pending.pending) && pending.pending > 0) state = `${integer.format(pending.pending)} operation${pending.pending === 1 ? '' : 's'} queued`;
    else if (count(pending.activeJobs) && pending.activeJobs > 0) state = 'Writing';
    else if (pending.pending === 0 && pending.activeJobs === 0) state = 'Caught up';
    if (stale) state = `Last known: ${state}`;
  } else if (['snapshot', 'history'].includes(health?.scope)) state = 'Not monitored here';
  const evidence = valid ? `${label} · ${problemsObserved ? 'problems observed' : knownOutcomes ? 'no failures observed' : 'outcomes not monitored yet'} · ${coverageDuration(window.monitoredMs)} monitored`
    : ['snapshot', 'history'].includes(health?.scope) ? 'Check the active live controller for its memory-only history.' : 'Waiting for monitored storage evidence.';
  return {
    available: valid,
    notice,
    stale,
    state, stateTone, evidence, evidenceTone: problemsObserved ? 'warning' : 'neutral',
    coverage: valid ? `${label} · ${coverageDuration(window.monitoredMs)} monitored${partialRun ? ' · partial run' : ''}` : label,
    scope: valid && validDate(history.startedAt) ? `This storage run started ${dates.format(new Date(history.startedAt))}.${partialRun ? ' Earlier time is not monitored.' : ''}` : 'The start of this storage run is unknown.',
    precision: valid && finite(window?.coveredMs) && finite(window?.monitoredMs) && window.coveredMs < window.monitoredMs
      ? `${coverageDuration(window.coveredMs)} summarized. The oldest partial five-minute interval is excluded.` : '',
    clock: valid && history.clockChanged ? 'The server clock changed during this run. Durations use elapsed time; dates may differ.' : '',
    current,
    waiting: valid && finite(pending.waitingMs) ? `Waiting for the writer lock · ${storageDuration(pending.waitingMs)} so far` : '',
    queue: timing(window?.queueDelay, 'completed queued operations'),
    transaction: timing(window?.transactionDuration, 'committed transactions'),
    commit: timing(window?.commitDuration, 'commits'),
    journalSeal: timing(window?.journalSealDuration, 'measured seals'),
    nativeCommit: timing(window?.nativeCommitDuration, 'measured SQLite commits'),
    controlQueue: timing(window?.controlQueueDelay, 'completed priority operations'),
    normalQueue: timing(window?.normalQueueDelay, 'completed normal operations'),
    contention: observed(contention?.episodes),
    contentionDetail: monitored ? `${storageDuration(contention?.totalMs)} total · ${storageDuration(contention?.maxMs)} worst${contention?.active ? ' · includes an active wait' : ''}` : 'No monitored coverage yet',
    peak: observed(window?.peakPending),
    failed: observed(window?.failedWrites),
    rejected: observed(window?.queueRejected),
    commandsNotSent: observed(window?.commandsNotSent),
    committed: observed(window?.committedTransactions),
    attempts: observed(window?.transactionAttempts),
    failedJobs: observed(window?.failedJobs),
    cancelled: observed(window?.cancelledJobs),
    postCommit: observed(window?.postCommitFailures),
    incidents: valid && Array.isArray(window.incidents) ? window.incidents.slice(0, 4)
      .map(value => incidentView(value, health.recording.lastWriteAt)).filter(Boolean) : [],
  };
}

export function createStoragePerformance({ document, now = () => Date.now() }) {
  const $ = id => document.getElementById(id);
  const root = $('recording-performance-details');
  let period = 'day', health, unavailable = false;
  const set = (suffix, value) => {
    const element = $(`recording-performance-${suffix}`);
    if (element && element.textContent !== String(value)) element.textContent = value;
  };
  function draw() {
    const view = storagePerformanceView(health, period, { unavailable, now: now() });
    set('coverage', view.coverage);
    set('scope', view.scope);
    set('notice', view.notice);
    set('clock', view.clock);
    set('precision', view.precision);
    set('current', view.current);
    set('waiting', view.waiting);
    set('state', view.state);
    set('evidence', view.evidence);
    root.dataset.tone = view.stateTone;
    $('recording-performance-evidence').dataset.tone = view.evidenceTone;
    for (const name of ['notice', 'clock', 'precision', 'waiting']) $(`recording-performance-${name}`).hidden = !view[name];
    $('recording-performance-notice').dataset.tone = view.available && view.stale ? 'warning' : 'neutral';
    const data = $('recording-performance-data');
    if (!view.available && data.contains(document.activeElement)) root.querySelector(':scope > summary')?.focus({ preventScroll: true });
    data.hidden = !view.available;
    for (const name of ['queue', 'transaction', 'commit', 'journalSeal', 'nativeCommit', 'controlQueue', 'normalQueue']) {
      for (const [key, value] of Object.entries(view[name])) set(`${name}-${key}`, value);
    }
    for (const name of ['contention', 'contentionDetail', 'peak', 'failed', 'rejected', 'commandsNotSent', 'committed', 'attempts', 'failedJobs', 'cancelled', 'postCommit']) set(name, view[name]);
    for (const key of ['day', 'week']) $(`recording-performance-${key}`).setAttribute('aria-pressed', String(period === key));
    for (const name of ['failed', 'rejected', 'commandsNotSent', 'postCommit']) $(`recording-performance-${name}`).dataset.tone = view[name] !== '0' && /^\d/.test(view[name]) ? 'warning' : 'neutral';
    const incidents = $('recording-performance-incident-list');
    while (incidents.children.length > view.incidents.length) incidents.children[incidents.children.length - 1].remove();
    view.incidents.forEach((item, index) => {
      let node = incidents.children[index];
      if (!node) {
        node = document.createElement('li');
        node.append(document.createElement('strong'), document.createElement('p')); incidents.append(node);
      }
      const [title, detail] = node.children;
      if (title.textContent !== item.title) title.textContent = item.title;
      if (detail.textContent !== item.detail) detail.textContent = item.detail;
    });
    $('recording-performance-incidents').hidden = view.incidents.length === 0;
  }
  for (const key of ['day', 'week']) $(`recording-performance-${key}`).addEventListener('click', () => { period = key; draw(); });
  return {
    update(value, failed = false) { health = value; unavailable = failed; draw(); },
    clear() { period = 'day'; health = undefined; unavailable = false; draw(); },
  };
}
