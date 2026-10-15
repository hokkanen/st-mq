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
  'save-failed': 'The save was not confirmed.',
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
  return { title: incidentCategories[value.category], context: incidentContexts[value.context],
    date: dates.format(new Date(value.at)), dateTime: new Date(value.at).toISOString(),
    reason: incidentReasons[value.reason], outcome, recovery };
}

export function storagePerformanceView(health, period = 'day', { unavailable = false, now = Date.now() } = {}) {
  const live = health?.version === 2 && ['live', 'simulated'].includes(health.scope);
  const history = live && health.recording?.history?.version === 2
    ? health.recording.history : null;
  const window = history?.windows?.[period];
  const monitored = finite(window?.coveredMs) && window.coveredMs > 0;
  const partialRun = finite(window?.monitoredMs) && finite(window?.requestedMs) && window.monitoredMs < window.requestedMs;
  const stale = unavailable || !finite(health?.checkedAt) || Math.abs(now - health.checkedAt) > 180_000;
  const label = period === 'week' ? 'Past week' : 'Past day';
  const valid = Boolean(history && window);
  const observed = value => monitored ? observedCount(value) : 'Not monitored';
  const pending = history?.current ?? {};
  const writer = live ? health.recording?.writer?.state : null;
  const queueKnown = count(pending.pending) && count(pending.activeJobs);
  const queued = pending.pending === 0 ? 'No queued operations'
    : `${observedCount(pending.pending)} queued · ${finite(pending.oldestPendingMs) ? `oldest ${storageDuration(pending.oldestPendingMs)}` : 'age unknown'}`;
  const running = count(pending.activeJobs) && pending.activeJobs > 0 ? ` · ${integer.format(pending.activeJobs)} running` : '';
  const current = history && queueKnown ? `${stale ? 'Last known: ' : ''}${queued}${running}` : live ? 'Queue activity is not available' : '';
  let notice = !health ? 'Waiting for storage health information.'
    : health.scope === 'snapshot' ? 'These measurements are held only in the live controller’s memory. They are not included in a recorded snapshot.'
      : health.scope === 'history' ? 'Storage health is not monitored by the history viewer.'
        : !live ? 'Storage health is unavailable for this recording scope.' : '';
  if (live && stale) notice = unavailable ? 'Refresh failed. These are the last known measurements.'
    : health.checkedAt > now ? 'The server and browser clocks differ. These are the last known measurements.'
      : 'These are the last known measurements; the health check is out of date.';
  const contention = window?.contention;
  const historicProblems = [window?.failedWrites, window?.queueRejected, window?.commandsNotSent, window?.postCommitFailures];
  const knownOutcomes = monitored && historicProblems.every(count);
  const problemsObserved = monitored && historicProblems.some(value => count(value) && value > 0);
  let state = 'Storage status unknown', stateTone = 'neutral';
  let detail = 'Writer availability is not known.';
  if (live) {
    if (writer === 'unavailable' || writer === 'stopped') {
      state = writer === 'stopped' ? 'Writer stopped' : 'Writer unavailable'; stateTone = 'critical';
      detail = 'New changes cannot be saved. Check storage and restart the application.';
    } else if (writer === 'confirming') {
      state = 'Confirming last save'; stateTone = 'warning';
      detail = 'The save result is being checked. Changes and commands that depend on it are waiting for confirmation.';
    } else if (health.recording.state === 'write-failed') {
      state = 'Save failed'; stateTone = 'critical';
      detail = 'A save was not confirmed. Review the observed outcomes below; earlier confirmed saves remain recorded.';
    }
    else if (finite(pending.waitingMs)) { state = 'Waiting for storage'; stateTone = 'warning'; }
    else if (['ready', 'saving'].includes(writer)) {
      if (count(pending.pending) && pending.pending > 0) state = `${integer.format(pending.pending)} operation${pending.pending === 1 ? '' : 's'} queued`;
      else if (writer === 'saving' || count(pending.activeJobs) && pending.activeJobs > 0) state = 'Writing';
      else if (pending.pending === 0 && pending.activeJobs === 0) state = 'Caught up';
      else state = 'Writer ready';
    }
    if (state === 'Waiting for storage') detail = 'Queued work is waiting for the database writer lock. A lock wait does not establish a failed save.';
    else if (state === 'Writing' || / operations? queued$/.test(state)) detail = 'Saving is in progress. The dashboard keeps the last confirmed values until the save completes.';
    else if (state === 'Caught up') detail = '';
    else if (state === 'Writer ready') detail = 'The writer is available. Queue activity is not known.';
    if (stale) state = `Last known: ${state}`;
    if (stale && detail) detail = `Last known status. ${detail}`;
  } else if (['snapshot', 'history'].includes(health?.scope)) { state = 'Not monitored here'; detail = ''; }
  const historyState = valid ? problemsObserved ? 'Problems observed' : knownOutcomes ? 'No failures observed' : 'Outcomes not monitored yet' : '';
  const evidence = valid ? `${label} · ${coverageDuration(window.monitoredMs)} monitored`
    : ['snapshot', 'history'].includes(health?.scope) ? 'Check the active live controller for its memory-only history.' : 'Waiting for monitored storage evidence.';
  const runtime = live ? health.recording?.runtimeTiming : null;
  const runtimeValid = runtime?.basis === 'observed-event-loop-delay' && runtime.hardRealtime === false
    && count(runtime.samples) && (runtime.samples === 0 || finite(runtime.maxObservedDelayMs) && finite(runtime.p99ObservedDelayMs));
  return {
    available: valid,
    notice,
    stale,
    activityTitle: live ? stale ? 'Last known activity' : 'Current activity' : 'Storage write evidence',
    detail,
    currentVisible: live,
    state, stateTone, evidence, historyState, historyTone: problemsObserved ? 'warning' : 'neutral',
    outcome: valid ? problemsObserved ? 'Problems observed during this period.'
      : knownOutcomes ? 'No failures observed during this period.' : 'Outcomes are not monitored yet.' : '',
    coverage: valid ? `${label} · ${coverageDuration(window.monitoredMs)} monitored${partialRun ? ' · partial run' : ''}` : label,
    scope: valid && validDate(history.startedAt) ? `This storage run started ${dates.format(new Date(history.startedAt))}.${partialRun ? ' Earlier time is not monitored.' : ''}` : 'The start of this storage run is unknown.',
    precision: valid && finite(window?.coveredMs) && finite(window?.monitoredMs) && window.coveredMs < window.monitoredMs
      ? `${coverageDuration(window.coveredMs)} summarized. The oldest partial five-minute interval is excluded.` : '',
    clock: valid && history.clockChanged ? 'The server clock changed during this run. Durations use elapsed time; dates may differ.' : '',
    current,
    runtimeVisible: live,
    runtimeTitle: stale ? 'Last known application responsiveness' : 'Application responsiveness',
    runtimeMax: runtimeValid && runtime.samples > 0 ? storageDuration(runtime.maxObservedDelayMs) : runtimeValid ? 'No samples' : 'Unknown',
    runtimeP99: runtimeValid && runtime.samples > 0 ? storageDuration(runtime.p99ObservedDelayMs) : runtimeValid ? 'No samples' : 'Unknown',
    runtimeSamples: runtimeValid ? `${integer.format(runtime.samples)} timer samples since application start` : 'Application timing is not available.',
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
    set('detail', view.detail);
    $('recording-performance-detail').hidden = !view.detail;
    $('recording-performance-live').hidden = !view.currentVisible;
    $('recording-performance-activity').hidden = !view.currentVisible;
    set('live-title', view.activityTitle);
    set('waiting', view.waiting);
    set('state', view.state);
    set('evidence', view.evidence);
    set('history-state', view.historyState);
    set('outcome', view.outcome);
    root.dataset.tone = view.stateTone;
    $('recording-performance-history-state').dataset.tone = view.historyTone;
    $('recording-performance-history-state').hidden = !view.historyState;
    $('recording-performance-outcome').dataset.tone = view.historyTone;
    for (const name of ['notice', 'clock', 'precision', 'waiting']) $(`recording-performance-${name}`).hidden = !view[name];
    $('recording-performance-notice').dataset.tone = view.available && view.stale ? 'warning' : 'neutral';
    const data = $('recording-performance-data');
    if (!view.available && data.contains(document.activeElement)) root.querySelector(':scope > summary')?.focus({ preventScroll: true });
    data.hidden = !view.available;
    for (const id of ['recording-performance-responsiveness', 'recording-performance-method']) {
      const section = $(id);
      if (!view.runtimeVisible && section.contains(document.activeElement)) root.querySelector(':scope > summary')?.focus({ preventScroll: true });
      section.hidden = !view.runtimeVisible;
    }
    set('runtime-title', view.runtimeTitle);
    set('runtime-max', view.runtimeMax);
    set('runtime-p99', view.runtimeP99);
    set('runtime-samples', view.runtimeSamples);
    for (const key of ['mean', 'worst', 'samples']) set(`write-${key}`, view.transaction[key]);
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
        const heading = document.createElement('div');
        heading.className = 'recording-performance-incident-heading';
        heading.append(document.createElement('strong'), document.createElement('time'));
        node.append(heading);
        for (const name of ['context', 'detail', 'recovery']) {
          const paragraph = document.createElement('p');
          paragraph.className = `recording-performance-incident-${name}`;
          node.append(paragraph);
        }
        incidents.append(node);
      }
      const [heading, context, detail, recovery] = node.children;
      const [title, date] = heading.children;
      if (title.textContent !== item.title) title.textContent = item.title;
      if (date.textContent !== item.date) date.textContent = item.date;
      if (date.dateTime !== item.dateTime) date.dateTime = item.dateTime;
      if (context.textContent !== item.context) context.textContent = item.context;
      const explanation = `${item.reason} ${item.outcome}`;
      if (detail.textContent !== explanation) detail.textContent = explanation;
      if (recovery.textContent !== item.recovery) recovery.textContent = item.recovery;
      recovery.hidden = !item.recovery;
    });
    $('recording-performance-incidents').hidden = view.incidents.length === 0;
  }
  for (const key of ['day', 'week']) $(`recording-performance-${key}`).addEventListener('click', () => { period = key; draw(); });
  return {
    update(value, failed = false) { health = value; unavailable = failed; draw(); },
    clear() { period = 'day'; health = undefined; unavailable = false; draw(); },
  };
}
