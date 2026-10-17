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
  'command-not-sent': 'Device command not sent', 'follow-up-failed': 'Saved; follow-up failed',
  'control-request-blocked': 'Control request blocked by storage',
};
const incidentContexts = {
  storage: 'Storage', 'mqtt-input': 'Received MQTT update', 'provider-input': 'Provider update',
  'charging-input': 'Charging update', 'heat-pump-command': 'Heat-pump command',
  'switch-command': 'Switch command', 'cover-command': 'Cover command', 'garage-command': 'Garage command',
  'floor-control': 'Floor control', 'caravan-command': 'Caravan command', 'garage-protection': 'Garage protection configuration',
  'charger1-command': 'Charger 1 command', 'charger2-command': 'Charger 2 command', 'control-request': 'Dashboard control request',
};
const incidentReasons = {
  'write-queue-full': 'The queue was full.', 'disk-full': 'The disk was full.',
  'database-busy': 'The database remained busy.', 'database-read-only': 'The database was read-only.',
  'database-io': 'Storage reported an input/output error.', 'database-corrupt': 'The database reported corruption.',
  'database-unavailable': 'The database was unavailable.',
  'recording-failed': 'Recording failed before dispatch.',
  'recording-pending': 'Required recording was still pending when dispatch was refused.',
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
  'control-request-blocked': 'A control request was refused by storage; this does not establish a device command.',
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
  return { at: value.at, title: incidentCategories[value.category], context: incidentContexts[value.context],
    date: dates.format(new Date(value.at)), dateTime: new Date(value.at).toISOString(),
    reason: incidentReasons[value.reason], outcome, recovery };
}

const operationGroups = [
  { id: 'backups', label: 'Backups & checks', kinds: ['backup-save', 'backup-download', 'backup', 'verification', 'backup-catalog', 'backup-inspection'] },
  { id: 'learning', label: 'Learning & recovery', kinds: ['learning-rebuild', 'learning-publication', 'checkpoint-cache', 'recovery', 'csv-import'] },
  { id: 'maintenance', label: 'Synchronization & maintenance', kinds: ['replication', 'replication-worker', 'peer-transfer', 'pairing-snapshot', 'local-publication', 'journal-maintenance', 'reset-archive'] },
  { id: 'queries', label: 'Queries & inventory', kinds: ['history-query', 'storage-inventory', 'csv-export'] },
];
const operationLabels = {
  'backup-save': 'Save database copy', 'backup-download': 'Database download', backup: 'Database copy creation',
  verification: 'Database verification', 'backup-catalog': 'Saved-copy listing', 'backup-inspection': 'Saved-copy inspection',
  'learning-rebuild': 'Learning & rebuilding', 'learning-publication': 'Model publication',
  'checkpoint-cache': 'Learning checkpoint cache', recovery: 'History recovery',
  'journal-maintenance': 'Journal maintenance', replication: 'Local synchronization',
  'replication-worker': 'Synchronization workers', 'peer-transfer': 'Peer transfer tasks',
  'pairing-snapshot': 'Pairing snapshots & chunks', 'local-publication': 'Database files & publication',
  'reset-archive': 'Reset archive', 'history-query': 'History queries', 'storage-inventory': 'Storage inventory',
  'csv-import': 'CSV import', 'csv-export': 'CSV export',
};
const operationOutcomes = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', superseded: 'Superseded',
  unconfirmed: 'Unconfirmed', refused: 'Refused' };
const operationReasons = { 'operation-failed': 'The cause is not established here.',
  'durability-unconfirmed': 'Publication durability is unconfirmed.', 'committed-followup-failed': 'The save committed; follow-up work failed.',
  'worker-lost': 'The worker became unavailable.', 'cleanup-failed': 'Cleanup failed.', cancelled: 'The task was cancelled.',
  superseded: 'Newer work superseded this task.', stale: 'The task no longer matched its original context.',
  capacity: 'Capacity was unavailable; the task did not start.' };
const operationScopes = { runtime: 'Recording context', history: 'History or saved copy', standby: 'Local standby', shared: 'Local application' };
const operationStages = { queued: 'Queued', starting: 'Starting', reading: 'Reading', copying: 'Copying', verifying: 'Verifying',
  rebuilding: 'Rebuilding', publishing: 'Publishing', cleanup: 'Cleaning up', running: 'Running' };
const outcomeKeys = Object.keys(operationOutcomes);
const datedResult = result => result && Object.hasOwn(operationOutcomes, result.outcome) && validDate(result.finishedAt)
  ? `${operationOutcomes[result.outcome]} · ${dates.format(new Date(result.finishedAt))} · ${operationScopes[result.scope] ?? 'Local application'}` : '';

export function storageOperationsView(health, period = 'day', { unavailable = false, now = Date.now() } = {}) {
  const operations = health?.version === 3 && health.operations?.version === 2
    && health.operations.scope === 'local-node' && health.operations.period === 'application-run' ? health.operations : null;
  const valid = Boolean(operations && validDate(operations.startedAt) && validDate(operations.observedAt) && Array.isArray(operations.coverage));
  const stale = unavailable || !valid || Math.abs(now - operations.observedAt) > 180_000;
  const rows = valid ? Object.entries(operationLabels).map(([kind, label]) => {
    const row = operations.coverage.find(value => value?.kind === kind), window = row?.[period];
    const registered = row?.monitored === true && validDate(row.monitoredSince);
    const known = registered && finite(window?.coveredMs) && finite(window.monitoredMs);
    const outcomesKnown = known && outcomeKeys.every(key => count(window[key]));
    // A known problem is still evidence when another counter is unavailable.
    const problems = known && ['failed', 'unconfirmed', 'refused'].some(key => count(window[key]) && window[key] > 0);
    const activityKnown = registered && count(row.queued) && count(row.running);
    const active = activityKnown && row.queued + row.running > 0;
    const activity = activityKnown ? [row.running > 0 ? `${integer.format(row.running)} running` : '',
      row.queued > 0 ? `${integer.format(row.queued)} queued` : ''].filter(Boolean).join(' · ') || 'No active tasks' : 'Activity unknown';
    const result = row?.lastResult, resultText = known ? datedResult(result) : '';
    const latest = resultText ? `${resultText}. ${operationReasons[result.reason] ?? ''}${result.committed === true ? ' A commit was confirmed.' : ''}`.trim()
      : 'No finished task observed in retained history.';
    const problem = known && ['failed', 'unconfirmed', 'refused'].includes(window.lastProblem?.outcome)
      && datedResult(window.lastProblem) ? window.lastProblem : null;
    const samples = known && count(window.durationSamples) ? window.durationSamples : null;
    const outcomes = outcomeKeys.filter(key => count(window?.[key]) && window[key] > 0)
      .map(key => `${integer.format(window[key])} ${operationOutcomes[key].toLowerCase()}`).join(' · ');
    const duration = samples > 0 && finite(window.elapsedMs) && finite(window.maxElapsedMs)
      ? `Average ${storageDuration(window.elapsedMs / samples)} · worst ${storageDuration(window.maxElapsedMs)} · ${integer.format(samples)} finished task${samples === 1 ? '' : 's'}`
      : samples === 0 ? 'No duration samples' : 'Duration unknown';
    const coverage = known ? `${coverageDuration(window.monitoredMs)} monitored · ${coverageDuration(window.coveredMs)} summarized · since ${dates.format(new Date(row.monitoredSince))}`
      : registered ? 'Monitoring is registered; period coverage is unknown.' : 'Not monitored in this application run.';
    const moreActive = active && Array.isArray(row.active) ? Math.max(0, row.active.length - 3)
      + (count(row.activeDetailsOmitted) ? row.activeDetailsOmitted : 0) : 0;
    const activeDetails = active && Array.isArray(row.active) ? row.active.slice(0, 3)
      .filter(item => Object.hasOwn(operationStages, item?.stage) && finite(item.elapsedMs))
      .map(item => `${operationStages[item.stage]} · ${storageDuration(item.elapsedMs)} elapsed · ${operationScopes[item.scope] ?? 'Local application'}`)
      .concat(moreActive ? [`${integer.format(moreActive)} more active task${moreActive === 1 ? '' : 's'}`] : []).join('; ') : '';
    const problemDetail = problem ? `${datedResult(problem)}. ${operationReasons[problem.reason] ?? ''}${problem.committed === true ? ' A commit was confirmed.' : ''}`.trim()
      : problems ? 'Problem counts were observed; dated detail is unavailable.' : '';
    return { kind, label, registered, known, outcomesKnown, activityKnown, problems, active,
      visible: active || registered && (Boolean(outcomes) || !outcomesKnown || !activityKnown),
      summary: active ? `${activity}${stale ? ' · last known' : ''}` : problems ? 'Earlier problems'
        : outcomes || (outcomesKnown ? 'No observed work' : 'Outcomes unknown'),
      activity: `${stale ? 'Last known: ' : ''}${activity}`, activeDetails,
      outcomes: `${outcomes || (outcomesKnown ? 'No finished or refused tasks' : 'Outcomes unknown')}${outcomes && !outcomesKnown ? ' · some counts unknown' : ''}`,
      duration, coverage, latest, problemDetail,
      incident: problem ? { title: `${label} · ${operationOutcomes[problem.outcome].toLowerCase()}`,
        context: `Local task · ${operationScopes[problem.scope] ?? 'Local application'}`, at: problem.finishedAt,
        date: dates.format(new Date(problem.finishedAt)), dateTime: new Date(problem.finishedAt).toISOString(),
        reason: operationReasons[problem.reason] ?? 'The cause is not established here.',
        outcome: problem.committed === true ? 'A commit was confirmed.' : '',
        recovery: resultText && (result.finishedAt !== problem.finishedAt || result.outcome !== problem.outcome)
          ? `Latest finished task: ${resultText}. This does not establish recovery of the earlier work.` : '' } : null,
      omitted: count(row?.activeDetailsOmitted) && row.activeDetailsOmitted > 0 ? 'Some active details are omitted; counts include all observed tasks.' : '',
    };
  }) : [];
  const monitored = rows.filter(row => row.registered), visible = rows.filter(row => row.visible);
  const activeRows = rows.filter(row => row.active), problemsObserved = rows.some(row => row.problems);
  const registered = rows.filter(row => row.known || !['csv-import', 'csv-export'].includes(row.kind));
  return { available: valid, stale, observedAt: valid ? operations.observedAt : null, rows: visible, activeRows, coverage: registered,
    groups: operationGroups.map(group => ({ ...group, rows: visible.filter(row => group.kinds.includes(row.kind)) })).filter(group => group.rows.length),
    problemsObserved, outcomesKnown: monitored.length > 0 && monitored.every(row => row.outcomesKnown),
    incidents: rows.map(row => row.incident).filter(Boolean),
    summary: !valid ? 'Evidence unavailable' : !monitored.length ? 'No monitoring registered' : visible.length ? `${visible.length} task types with activity or outcomes` : 'No tasks observed in this period',
    activity: !valid ? 'Local task activity unavailable' : activeRows.length ? `${stale ? 'Last known: ' : ''}${activeRows.length} active task type${activeRows.length === 1 ? '' : 's'}`
      : monitored.length && monitored.every(row => row.activityKnown)
        ? `${stale ? 'Last known: ' : ''}No observed local tasks active` : 'Local task activity unknown',
    evidence: !valid ? 'Local task evidence is unavailable.'
      : `${stale ? 'Last known · ' : ''}On this computer · application started ${dates.format(new Date(operations.startedAt))}.`,
    empty: !valid ? 'Waiting for local task evidence.' : !monitored.length ? 'No local monitoring has been registered in this application run.'
      : 'No local tasks have activity or outcomes in the selected monitored period. Monitoring coverage is listed below.',
  };
}

// The overview always uses the past day. Selecting a diagnostic period must not
// change current health or hide a recent problem in the outer Health summary.
export function storageProblemSummary(health, options = {}) {
  return historySummary(storagePerformanceView(health, 'day', options), storageOperationsView(health, 'day', options));
}

function historySummary(writer, operations) {
  const incidents = [...writer.incidents, ...operations.incidents].sort((a, b) => b.at - a.at);
  const problems = writer.problemsObserved || operations.problemsObserved;
  const known = (!writer.currentVisible || writer.outcomesKnown) && operations.outcomesKnown;
  return { problems, incidents,
    label: problems ? `Earlier problems${incidents.length ? ` · ${incidents[0].date}` : ' · date unavailable'}` : '',
    outcome: problems ? 'Problems were observed in this period. Current activity is shown separately.'
      : known ? 'No problems observed in the monitored period.' : 'No problems reported in the available evidence; coverage is incomplete.',
  };
}

const storageKinds = { checkpoint: 'WAL checkpoint', mirror: 'Mirroring or recovery', history: 'History read',
  'live-learning': 'Learning input read', 'learning-cache': 'Learning cache', other: 'Background storage' };
const storagePhases = { acquiring: 'Acquiring the writer', building: 'Building the transaction',
  sealing: 'Sealing the journal', committing: 'Committing and confirming the save',
  confirming: 'Checking an uncertain save', 'follow-up': 'Finishing saved work' };

export function storageSchedulingView(health, { unavailable = false, now = Date.now() } = {}) {
  const storage = health?.version === 3 && health.recording?.storage?.version === 1
    && health.recording.storage.scope === 'local-store' ? health.recording.storage : null;
  const stale = unavailable || !validDate(health?.checkedAt) || Math.abs(now - health.checkedAt) > 180_000;
  const config = storage?.configuration, checkpoint = config?.checkpoint, queue = storage?.queue;
  const lanes = ['control', 'normal', 'background'];
  const queueKnown = lanes.every(key => count(queue?.lanes?.[key]?.queued) && count(queue.lanes[key].running));
  const active = queue?.active;
  const activeKnown = active === null || lanes.includes(active?.priority) && finite(active.elapsedMs);
  const activeLabel = !queueKnown || !activeKnown ? 'Storage activity unknown' : !active ? 'No storage turn active'
    : active.priority === 'background' ? storageKinds[active.kind] ?? 'Background storage'
      : storagePhases[storage.transactionPhase] ?? (active.phase === 'admitting' ? 'Acquiring the writer' : active.phase === 'exclusive' ? 'Publishing saved state' : 'Building and saving');
  const laneText = key => {
    const value = queue?.lanes?.[key];
    return !queueKnown ? 'Unknown' : `${integer.format(value.queued)} waiting${value.running ? ` · ${integer.format(value.running)} running` : ''}`
      + (value.queued > 0 ? ` · oldest ${storageDuration(value.oldestPendingMs)}` : '');
  };
  const policy = queue?.policy;
  const policyKnown = ['limit', 'byteLimit', 'controlBurst', 'foregroundBurst'].every(key => count(policy?.[key]) && policy[key] > 0);
  const modes = { 'queued-passive': 'Separate background checkpoints', 'periodic-passive': 'Separate background checkpoints',
    automatic: 'Checkpoints within commits', managed: 'Checkpoints managed by the owning process',
    'not-owned': 'Read-only connection', 'not-applicable': 'No WAL checkpoints' };
  let checkpointPolicy = 'Checkpoint policy is unavailable.';
  if (checkpoint?.mode === 'queued-passive' && [checkpoint.triggerFrames, checkpoint.maxDirtyMs, checkpoint.pollMs].every(value => finite(value) && value > 0))
    checkpointPolicy = `Request PASSIVE work at ${integer.format(checkpoint.triggerFrames)} outstanding frames, or after ${storageDuration(checkpoint.maxDirtyMs)} with work remaining. Check every ${storageDuration(checkpoint.pollMs)}. These are scheduling triggers, not a frame cap or completion deadline.`;
  else if (checkpoint?.mode === 'periodic-passive' && finite(checkpoint.fallbackPollMs) && checkpoint.fallbackPollMs > 0)
    checkpointPolicy = `This SQLite build cannot inspect outstanding frames without checkpoint work. Request PASSIVE work no more often than every ${storageDuration(checkpoint.fallbackPollMs)}; no frame-count trigger is used.`;
  else if (checkpoint?.mode === 'automatic' && count(checkpoint.autoCheckpointFrames))
    checkpointPolicy = checkpoint.autoCheckpointFrames > 0 ? `SQLite may checkpoint within a commit at ${integer.format(checkpoint.autoCheckpointFrames)} WAL frames.` : 'Automatic checkpoints are disabled on this connection.';
  else if (checkpoint?.mode === 'not-owned') checkpointPolicy = 'This connection reads recorded history and does not own checkpoint scheduling.';
  else if (checkpoint?.mode === 'not-applicable') checkpointPolicy = 'The current journal mode does not use a WAL.';
  else if (checkpoint?.mode === 'managed') checkpointPolicy = 'Automatic checkpoints are disabled; the owning process schedules maintenance.';
  const separate = ['queued-passive', 'periodic-passive'].includes(checkpoint?.mode);
  const maintenance = storage?.checkpoint;
  const checkpointStates = { idle: 'Waiting for the next check', queued: 'Waiting for a storage turn', running: 'Checkpoint running',
    failed: 'Last checkpoint request failed', unavailable: 'Checkpoint worker unavailable', stopped: 'Checkpoint scheduler stopped' };
  const frames = maintenance?.frames;
  const framesKnown = validDate(frames?.at) && [frames.logFrames, frames.copiedFrames, frames.remainingFrames].every(count)
    && frames.copiedFrames <= frames.logFrames && frames.remainingFrames === frames.logFrames - frames.copiedFrames;
  const last = maintenance?.lastRun;
  const writerStates = { unavailable: 'Writer unavailable', stopped: 'Writer stopped', confirming: 'Confirming last save',
    saving: 'Writing', ready: 'Storage idle', 'read-only': 'Read-only storage' };
  const writerState = storage?.writer?.state;
  const localProblem = ['unavailable', 'stopped', 'confirming'].includes(writerState);
  const localState = localProblem ? writerStates[writerState]
    : separate && ['failed', 'stopped'].includes(maintenance?.state) ? 'Checkpoint needs attention'
      : active && queueKnown ? activeLabel
        : queueKnown && lanes.some(key => queue.lanes[key].queued > 0) ? 'Storage work queued'
          : writerStates[writerState] ?? 'Storage status unknown';
  return { available: Boolean(storage), stale, separate, queueKnown,
    localState: `${stale && storage ? 'Last known: ' : ''}${localState}`,
    localTone: localProblem || maintenance?.state === 'failed' ? 'warning' : 'neutral',
    queuedSaves: queueKnown ? queue.lanes.control.queued + queue.lanes.normal.queued : null,
    queuedBackground: queueKnown ? queue.lanes.background.queued : null,
    activeBackground: queueKnown && active?.priority === 'background', activeLabel,
    active: `${stale && storage ? 'Last known: ' : ''}${activeLabel}${active && finite(active.elapsedMs) ? ` · ${storageDuration(active.elapsedMs)} elapsed` : ''}`,
    lanes: Object.fromEntries(lanes.map(key => [key, laneText(key)])),
    execution: ({ worker: 'Dedicated worker', direct: 'Calling thread', 'read-only': 'Read-only connection' })[config?.execution] ?? 'Unknown',
    durability: config?.execution === 'read-only' ? 'Read-only; this connection does not confirm saves'
      : ['wal', 'memory', 'delete', 'truncate', 'persist', 'off'].includes(config?.journalMode)
        && ['off', 'normal', 'full', 'extra'].includes(config?.synchronous)
        ? `${config.journalMode.toUpperCase()} · synchronous ${config.synchronous.toUpperCase()}` : 'Unknown',
    policy: policyKnown ? `Control runs first, yielding to waiting ordinary saves after ${integer.format(policy.controlBurst)} consecutive turns. Background runs when no saves are waiting, or after ${integer.format(policy.foregroundBurst)} foreground turns if no control request is waiting. Active turns cannot be interrupted.` : 'Queue scheduling policy is unavailable.',
    capacity: policyKnown && count(queue.bytes) ? `${integer.format(policy.limit)} admitted operations · ${number.format(policy.byteLimit / 1048576)} MiB of declared queued payload; ${number.format(queue.bytes / 1048576)} MiB currently declared. This is not total process memory.` : 'Queue capacity is unavailable.',
    checkpointMode: modes[checkpoint?.mode] ?? 'Checkpoint mode unknown', checkpointPolicy,
    checkpointState: separate ? checkpointStates[maintenance?.state] ?? 'Checkpoint activity unknown' : modes[checkpoint?.mode] ?? 'Unknown',
    checkpointFrames: separate ? framesKnown ? `${integer.format(frames.remainingFrames)} outstanding of ${integer.format(frames.logFrames)} WAL frames · observed ${dates.format(new Date(frames.at))}` : 'WAL frame count is unavailable.' : '',
    checkpointLast: separate && validDate(last?.at) && finite(last.elapsedMs) ? `${storageDuration(last.elapsedMs)} · ${dates.format(new Date(last.at))}` : separate ? 'No completed checkpoint observed' : 'Not separately measured',
    checkpointFailure: separate && validDate(maintenance?.lastFailureAt) ? `Last failed request ${dates.format(new Date(maintenance.lastFailureAt))}. This does not undo a confirmed save.` : '',
  };
}

export function storagePerformanceView(health, period = 'day', { unavailable = false, now = Date.now() } = {}) {
  const live = health?.version === 3 && ['live', 'simulated'].includes(health.scope);
  const history = live && health.recording?.history?.version === 3
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
  const scheduling = storageSchedulingView(health, { unavailable, now });
  const queueKnown = count(pending.pending) && count(pending.activeJobs);
  const queued = pending.pending === 0 ? 'No queued operations'
    : `${observedCount(pending.pending)} queued · ${finite(pending.oldestPendingMs) ? `oldest ${storageDuration(pending.oldestPendingMs)}` : 'age unknown'}`;
  const running = count(pending.activeJobs) && pending.activeJobs > 0 ? ` · ${integer.format(pending.activeJobs)} running` : '';
  const current = history && queueKnown ? `${stale ? 'Last known: ' : ''}${queued}${running}` : live ? 'Queue activity is not available' : '';
  let notice = !health ? 'Waiting for storage health information.'
    : health.scope === 'snapshot' ? 'Runtime writer measurements are held only in the live controller’s memory. They are not included in a recorded snapshot. Local tasks belong to this computer.'
      : health.scope === 'history' ? 'Runtime writer health is not monitored by the history viewer. Local tasks belong to this computer.'
        : !live ? 'Storage health is unavailable for this recording scope.' : '';
  if (live && stale) notice = unavailable ? 'Refresh failed. These are the last known measurements.'
    : health.checkedAt > now ? 'The server and browser clocks differ. These are the last known measurements.'
      : 'These are the last known measurements; the health check is out of date.';
  const contention = window?.contention;
  const historicProblems = [window?.failedWrites, window?.queueRejected, window?.commandsNotSent,
    window?.postCommitFailures, window?.failedJobs, window?.controlRequestsBlocked,
    window?.backgroundFailedJobs, window?.backgroundQueueRejected, window?.checkpointFailures];
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
    else if (scheduling.separate && ['failed', 'stopped'].includes(health.recording.storage.checkpoint?.state)) {
      state = 'Checkpoint needs attention'; stateTone = 'warning';
      detail = `${scheduling.checkpointState}. Confirmed saves remain recorded; outstanding WAL work may grow.`;
    }
    else if (finite(pending.waitingMs)) { state = 'Waiting for storage'; stateTone = 'warning'; }
    else if (['ready', 'saving'].includes(writer)) {
      if (scheduling.activeBackground) {
        state = scheduling.queuedSaves > 0 ? `${integer.format(scheduling.queuedSaves)} save${scheduling.queuedSaves === 1 ? '' : 's'} waiting` : scheduling.activeLabel;
        detail = 'Background work holds the current storage turn. Queued saves can proceed when it finishes.';
      }
      else if (scheduling.queuedSaves === 0 && scheduling.queuedBackground > 0 && writer === 'ready') {
        state = 'Background storage queued';
        detail = 'Background work is waiting for its next storage turn. No control or ordinary save is queued.';
      }
      else if (count(pending.pending) && pending.pending > 0) state = `${integer.format(pending.pending)} operation${pending.pending === 1 ? '' : 's'} queued`;
      else if (writer === 'saving' || count(pending.activeJobs) && pending.activeJobs > 0) state = 'Writing';
      else if (pending.pending === 0 && pending.activeJobs === 0) state = 'Caught up';
      else state = 'Writer ready';
    }
    if (state === 'Waiting for storage') detail = 'Queued work is waiting for the database writer lock. A lock wait does not establish a failed save.';
    else if (state === 'Writing') detail = 'Saving is in progress. The dashboard keeps the last confirmed values until the save completes.';
    else if (/ operations? queued$/.test(state)) detail = 'Storage work is queued. The dashboard keeps the last confirmed values until saves complete.';
    else if (state === 'Caught up') detail = '';
    else if (state === 'Writer ready') detail = 'The writer is available. Queue activity is not known.';
    if (stale) state = `Last known: ${state}`;
    if (stale && detail) detail = `Last known status. ${detail}`;
  } else if (['snapshot', 'history'].includes(health?.scope)) { state = 'Not monitored here'; detail = ''; }
  const historyState = valid ? problemsObserved ? 'Problems observed' : knownOutcomes ? 'No monitored failures observed' : 'Outcomes not monitored yet' : '';
  const evidence = valid ? `${label} · ${coverageDuration(window.monitoredMs)} monitored`
    : ['snapshot', 'history'].includes(health?.scope) ? 'Check the active live controller for its memory-only history.' : 'Waiting for monitored storage evidence.';
  const runtime = live ? health.recording?.runtimeTiming : null;
  const runtimeValid = runtime?.basis === 'observed-event-loop-delay' && runtime.hardRealtime === false
    && count(runtime.samples) && (runtime.samples === 0 || finite(runtime.maxObservedDelayMs) && finite(runtime.p99ObservedDelayMs));
  const checkpointFailureAt = scheduling.available ? health.recording.storage.checkpoint?.lastFailureAt : null;
  const checkpointIncidents = valid && window.checkpointFailures > 0 && validDate(checkpointFailureAt) ? [{
    at: checkpointFailureAt, title: 'Checkpoint request failed', context: 'Background storage',
    date: dates.format(new Date(checkpointFailureAt)), dateTime: new Date(checkpointFailureAt).toISOString(),
    reason: 'The background checkpoint request did not complete.',
    outcome: 'Earlier confirmed saves remain recorded.', recovery: '',
  }] : [];
  return {
    available: valid,
    problemsObserved, outcomesKnown: knownOutcomes,
    notice,
    stale,
    activityTitle: live ? stale ? 'Last known activity' : 'Current activity' : 'Local activity',
    detail,
    currentVisible: live,
    state, stateTone, evidence, historyState, historyTone: problemsObserved ? 'warning' : 'neutral',
    outcome: valid ? problemsObserved ? 'Problems observed during this period.'
      : knownOutcomes ? 'No monitored failures observed during this period.' : 'Outcomes are not monitored yet.' : '',
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
    begin: timing(window?.beginDuration, 'committed transactions'),
    body: timing(window?.bodyDuration, 'committed transactions'),
    checkpoint: timing(window?.checkpointDuration, 'completed checkpoint calls'),
    checkpointVisible: scheduling.separate,
    backgroundQueue: timing(window?.backgroundQueueDelay, 'completed background turns'),
    backgroundRun: timing(window?.backgroundRunDuration, 'finished background turns'),
    controlQueue: timing(window?.controlQueueDelay, 'completed priority operations'),
    normalQueue: timing(window?.normalQueueDelay, 'completed normal operations'),
    contention: observed(contention?.episodes),
    contentionDetail: monitored ? `${storageDuration(contention?.totalMs)} total · ${storageDuration(contention?.maxMs)} worst${contention?.active ? ' · includes an active wait' : ''}` : 'No monitored coverage yet',
    peak: observed(window?.peakPending),
    failed: observed(window?.failedWrites),
    rejected: observed(window?.queueRejected),
    commandsNotSent: observed(window?.commandsNotSent),
    controlRequestsBlocked: observed(window?.controlRequestsBlocked),
    commandCoverage: Array.isArray(history?.commandCoverage) ? history.commandCoverage.slice(0, 9)
      .filter(row => Object.hasOwn(incidentContexts, row?.context)).map(row => ({
        context: incidentContexts[row.context],
        state: row.state === 'monitored' && validDate(row.startedAt) && finite(row.monitoredMs)
          ? `Monitoring enabled · ${coverageDuration(window?.commandCoverageMs?.[row.context])} covered in this period`
          : row.state === 'disabled' ? 'Currently not enabled in this recording context' : 'Coverage unknown',
        count: monitored && (window?.commandCoverageMs?.[row.context] > 0 || window?.commandsByContext?.[row.context] > 0)
          ? observedCount(window?.commandsByContext?.[row.context]) : 'Not monitored',
      })) : [],
    committed: observed(window?.committedTransactions),
    attempts: observed(window?.transactionAttempts),
    failedJobs: observed(window?.failedJobs),
    cancelled: observed(window?.cancelledJobs),
    postCommit: observed(window?.postCommitFailures),
    backgroundFailed: observed(window?.backgroundFailedJobs),
    backgroundRejected: observed(window?.backgroundQueueRejected),
    backgroundCancelled: observed(window?.backgroundCancelledJobs),
    checkpointFailures: observed(window?.checkpointFailures),
    incidents: [...(valid && Array.isArray(window.incidents) ? window.incidents.slice(0, 5)
      .map(value => incidentView(value, health.recording.lastWriteAt)).filter(Boolean) : []), ...checkpointIncidents],
  };
}

export function createStoragePerformance({ document, now = () => Date.now() }) {
  const $ = id => document.getElementById(id);
  const root = $('recording-performance-details');
  const groupNodes = new Map(), operationNodes = new Map();
  let period = 'day', health, unavailable = false;
  const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = value; };
  const set = (suffix, value) => { const node = $(`recording-performance-${suffix}`); if (node) text(node, value); };
  const hide = (suffix, hidden) => {
    const node = $(`recording-performance-${suffix}`);
    if (hidden && node.contains(document.activeElement)) root.querySelector(':scope > summary')?.focus({ preventScroll: true });
    node.hidden = hidden;
  };
  function resize(list, length, create) {
    while (list.children.length > length) list.children[list.children.length - 1].remove();
    while (list.children.length < length) list.append(create());
  }
  function renderOperations(operations) {
    const list = $('recording-performance-operation-list');
    const visible = new Set(operations.rows.map(row => row.kind));
    // Remove expired rows first. Moving a surviving focused disclosure around
    // an obsolete sibling can blur it even though its own evidence is unchanged.
    for (const [kind, node] of operationNodes) if (!visible.has(kind)) {
      if (node.contains(document.activeElement)) $('recording-performance-operations').querySelector('summary')?.focus({ preventScroll: true });
      node.remove(); operationNodes.delete(kind);
    }
    for (const [id, node] of groupNodes) if (!operations.groups.some(group => group.id === id)) { node.remove(); groupNodes.delete(id); }
    operations.groups.forEach((group, groupIndex) => {
      let section = groupNodes.get(group.id);
      if (!section) {
        section = document.createElement('section'); section.className = 'recording-operation-group'; section.dataset.group = group.id;
        const heading = document.createElement('h5'); heading.id = `recording-task-group-${group.id}`; text(heading, group.label);
        section.setAttribute('aria-labelledby', heading.id);
        section.append(heading, document.createElement('div')); groupNodes.set(group.id, section);
      }
      if (list.children[groupIndex] !== section) list.insertBefore(section, list.children[groupIndex] ?? null);
      const rows = section.children[1];
      group.rows.forEach((row, index) => {
        let node = operationNodes.get(row.kind);
        if (!node) {
          node = document.createElement('details'); node.dataset.kind = row.kind; node.className = 'recording-operation';
          const summary = document.createElement('summary'); summary.append(document.createElement('span'), document.createElement('strong'));
          const body = document.createElement('dl'); body.className = 'recording-operation-facts';
          node.append(summary, body); operationNodes.set(row.kind, node);
        }
        if (rows.children[index] !== node) rows.insertBefore(node, rows.children[index] ?? null);
        const [summary, body] = node.children;
        text(summary.children[0], row.label); text(summary.children[1], row.summary);
        // Historical problems have their own dated field, independent of active work.
        node.dataset.history = row.problems ? 'problem' : 'none';
        const facts = [['Activity', row.activity], ['Outcomes in period', row.outcomes], ['Elapsed time', row.duration],
          ['Latest finished task', row.latest], ['Earlier problem', row.problemDetail], ['Monitoring', row.coverage], ['Detail limit', row.omitted]]
          .filter(([, value]) => value);
        resize(body, facts.length, () => {
          const item = document.createElement('div'); item.append(document.createElement('dt'), document.createElement('dd')); return item;
        });
        facts.forEach(([label, value], i) => { text(body.children[i].children[0], label); text(body.children[i].children[1], value); });
      });
    });
    set('operations-summary', operations.summary); set('operations-evidence', operations.evidence);
    set('monitoring-evidence', operations.evidence);
    set('operations-empty', operations.empty); hide('operations-empty', operations.rows.length > 0);
    set('local-activity', operations.activity);
    const active = $('recording-performance-active-tasks');
    resize(active, operations.activeRows.length, () => {
      const node = document.createElement('li'); node.append(document.createElement('strong'), document.createElement('span'), document.createElement('small')); return node;
    });
    operations.activeRows.forEach((row, index) => {
      const [label, activity, detail] = active.children[index].children;
      text(label, row.label); text(activity, row.activity); text(detail, row.activeDetails); detail.hidden = !row.activeDetails;
    });
    hide('active-tasks', operations.activeRows.length === 0);
    const coverage = $('recording-performance-operation-coverage');
    resize(coverage, operations.coverage.length, () => {
      const node = document.createElement('div'); node.append(document.createElement('dt'), document.createElement('dd')); return node;
    });
    operations.coverage.forEach((row, index) => {
      text(coverage.children[index].children[0], row.label); text(coverage.children[index].children[1], row.coverage);
    });
  }
  function renderIncidents(list, items) {
    resize(list, items.length, () => {
      const node = document.createElement('li'), heading = document.createElement('div');
      heading.className = 'recording-performance-incident-heading';
      heading.append(document.createElement('strong'), document.createElement('time')); node.append(heading);
      for (const name of ['context', 'detail', 'recovery']) {
        const paragraph = document.createElement('p'); paragraph.className = `recording-performance-incident-${name}`; node.append(paragraph);
      }
      return node;
    });
    items.forEach((item, index) => {
      const [heading, context, detail, recovery] = list.children[index].children;
      text(heading.children[0], item.title); text(heading.children[1], item.date); heading.children[1].dateTime = item.dateTime;
      text(context, item.context); text(detail, `${item.reason} ${item.outcome}`.trim()); text(recovery, item.recovery); recovery.hidden = !item.recovery;
    });
  }
  function draw() {
    const options = { unavailable, now: now() };
    const view = storagePerformanceView(health, period, options);
    const operations = storageOperationsView(health, period, options);
    const scheduling = storageSchedulingView(health, options);
    const history = historySummary(view, operations);
    const overview = period === 'day' ? history : storageProblemSummary(health, options);
    renderOperations(operations);
    set('coverage', view.available ? `Writer · ${view.coverage}` : 'Local task coverage varies by owner');
    set('scope', view.scope);
    set('notice', view.notice); set('clock', view.clock); set('precision', view.precision);
    set('current', view.current); set('detail', view.detail);
    hide('storage-current', !scheduling.available);
    for (const name of ['active', 'execution', 'durability', 'policy', 'capacity', 'checkpointMode',
      'checkpointPolicy', 'checkpointState', 'checkpointFrames', 'checkpointLast', 'checkpointFailure']) set(name, scheduling[name]);
    for (const [name, value] of Object.entries(scheduling.lanes)) set(`lane-${name}`, value);
    set('scheduling-summary', scheduling.available ? `${scheduling.stale ? 'Last known · ' : ''}${scheduling.execution}` : 'Configuration unknown');
    set('scheduling-scope', `${scheduling.stale ? 'Last known configuration and activity' : 'Configuration and activity'} on this computer. Save history below belongs to the active recording context.`);
    hide('checkpointFailure', !scheduling.checkpointFailure);
    hide('checkpoint-run-evidence', !scheduling.separate);
    hide('checkpoint-process-note', !scheduling.separate);
    hide('checkpoint-period-p95', !view.available);
    hide('checkpoint-period-failures', !view.available);
    hide('checkpoint-history', !view.available || !view.checkpointVisible);
    hide('background-history', !view.available);
    hide('queue-history', !view.available);
    $('recording-performance-measures').dataset.checkpoints = String(view.checkpointVisible);
    set('checkpoint-note', scheduling.separate ? 'Separate PASSIVE calls after WAL saves. Queue wait is excluded; these timings are not part of transaction duration.' : 'Not separately measured. See the current checkpoint policy.');
    hide('detail', !view.detail); hide('live', !view.currentVisible); hide('activity', !view.currentVisible);
    set('live-title', view.activityTitle); set('waiting', view.waiting);
    set('state', !view.currentVisible && scheduling.available ? scheduling.localState
      : !view.currentVisible && operations.available ? operations.activity : view.state);
    const localStorage = view.currentVisible || scheduling.available;
    const checkedAt = localStorage ? health?.checkedAt : operations.observedAt;
    set('evidence', validDate(checkedAt) ? `${(localStorage ? view.stale : operations.stale) ? 'Last known · ' : ''}${localStorage ? 'Checked' : 'Local tasks checked'} ${dates.format(new Date(checkedAt))}` : 'Check time unknown');
    set('history-state', overview.problems ? `${overview.label} · past day` : '');
    hide('history-state', !overview.problems);
    set('outcome', history.outcome);
    root.dataset.tone = !view.currentVisible && scheduling.available ? scheduling.localTone : view.stateTone;
    // Dated history is not an active warning. Current writer/feature owners retain
    // responsibility for faults that are still unresolved.
    $('recording-performance-history-state').dataset.tone = 'historical';
    for (const name of ['notice', 'clock', 'precision', 'waiting']) hide(name, !view[name]);
    $('recording-performance-notice').dataset.tone = view.available && view.stale ? 'warning' : 'neutral';
    for (const name of ['data', 'technical', 'diagnostics']) hide(name, !view.available);
    for (const name of ['responsiveness', 'command-monitoring']) hide(name, !view.runtimeVisible);
    set('runtime-title', view.runtimeTitle); set('runtime-max', view.runtimeMax); set('runtime-p99', view.runtimeP99); set('runtime-samples', view.runtimeSamples);
    for (const key of ['mean', 'worst', 'samples']) set(`write-${key}`, view.transaction[key]);
    for (const name of ['queue', 'transaction', 'begin', 'body', 'commit', 'journalSeal', 'nativeCommit', 'controlQueue', 'normalQueue', 'backgroundQueue', 'backgroundRun', 'checkpoint']) {
      for (const [key, value] of Object.entries(view[name])) set(`${name}-${key}`, value);
    }
    for (const name of ['contention', 'contentionDetail', 'peak', 'failed', 'rejected', 'commandsNotSent', 'controlRequestsBlocked', 'committed', 'attempts', 'failedJobs', 'cancelled', 'postCommit', 'backgroundFailed', 'backgroundRejected', 'backgroundCancelled', 'checkpointFailures']) set(name, view[name]);
    for (const key of ['day', 'week']) $(`recording-performance-${key}`).setAttribute('aria-pressed', String(period === key));
    for (const name of ['failed', 'rejected', 'commandsNotSent', 'controlRequestsBlocked', 'postCommit', 'failedJobs']) $(`recording-performance-${name}`).dataset.tone = view[name] !== '0' && /^\d/.test(view[name]) ? 'historical' : 'neutral';
    const commandList = $('recording-performance-command-coverage');
    resize(commandList, view.commandCoverage.length, () => document.createElement('li'));
    view.commandCoverage.forEach((row, index) => text(commandList.children[index], `${row.context} · ${row.state} · ${row.count === 'Not monitored' ? 'No monitored period evidence' : `${row.count} known unsent in this period`}`));
    set('command-coverage-empty', view.commandCoverage.length ? '' : 'Command monitoring coverage is unknown.');
    renderIncidents($('recording-performance-incident-list'), history.incidents.slice(0, 3));
    renderIncidents($('recording-performance-more-problem-list'), history.incidents.slice(3));
    hide('more-problems', history.incidents.length <= 3);
    set('more-problems-summary', `${Math.max(0, history.incidents.length - 3)} more dated problem${history.incidents.length === 4 ? '' : 's'}`);
    hide('incidents', history.incidents.length === 0);
  }
  for (const key of ['day', 'week']) $(`recording-performance-${key}`).addEventListener('click', () => { period = key; draw(); });
  return {
    update(value, failed = false) { health = value; unavailable = failed; draw(); },
    clear() { period = 'day'; health = undefined; unavailable = false; draw(); },
  };
}
