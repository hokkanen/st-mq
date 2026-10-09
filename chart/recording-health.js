const finite = value => Number.isFinite(value) && value >= 0;
const validTime = value => Number.isFinite(value) && value >= 0;
const healthFreshnessMs = 3 * 60_000;
const dates = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki',
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const decimal = value => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(value);

export function storageBytes(value) {
  if (!finite(value)) return 'Unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= 1000; index++; }
  return `${decimal(value)} ${units[index]}`;
}

export function recordingEvidenceTime(value, now = Date.now()) {
  if (!validTime(value)) return 'Not known';
  const minutes = Math.max(0, Math.floor((now - value) / 60_000));
  const age = value - now > healthFreshnessMs ? 'ahead of browser clock'
    : minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
  return `${dates.format(new Date(value))} · ${age}`;
}

const recordingLabels = { ok: 'Monitoring active', starting: 'Starting recording', stalled: 'Recording needs attention',
  'write-waiting': 'Waiting for storage', 'write-failed': 'Recording write failed', 'source-unavailable': 'Sources unavailable', 'read-only': 'Read-only history', unknown: 'Recording unknown' };
const backupLabels = { available: 'Copy available', 'none-known': 'No known copy', running: 'Creating a copy',
  failed: 'Last backup failed', interrupted: 'Backup interrupted', unknown: 'Backup status unknown' };
const diskLabels = { ok: 'Space available', low: 'Low disk space', critical: 'Critically low space', unknown: 'Disk space unknown' };
const tone = state => ['write-failed', 'critical', 'failed', 'stalled'].includes(state) ? 'critical'
  : ['low', 'interrupted', 'source-unavailable', 'write-waiting'].includes(state) ? 'warning' : 'neutral';
const issueTarget = id => ['disk-space', 'disk-check'].includes(id) ? 'recording-disk-card'
  : id === 'backup' ? 'recording-backup-card' : 'recording-recording-card';

export function recordingHealthView(health, recording, now = Date.now()) {
  const current = health?.version === 2 ? health : {};
  const disk = current.disk ?? {}, recorder = current.recording ?? {}, backup = current.backup ?? {};
  const hasSpace = ['ok', 'low', 'critical'].includes(disk.state)
    && finite(disk.freeBytes) && finite(disk.totalBytes) && disk.totalBytes > 0 && disk.freeBytes <= disk.totalBytes;
  const diskFraction = hasSpace ? disk.freeBytes / disk.totalBytes : null;
  const kind = { 'saved-copy': 'Saved copy', 'reset-archive': 'Reset archive', download: 'Download completed' }[backup.latestKind];
  const backupEvidence = validTime(backup.latestAt) ? `${kind ?? 'Latest known copy'} · ${recordingEvidenceTime(backup.latestAt, now)}` : 'No completed copy is known to this computer.';
  const backupVerification = backup.latestKind === 'download' ? 'Download completed; retention on the receiving device is unknown.'
    : validTime(backup.latestVerifiedAt) ? `Checked ${recordingEvidenceTime(backup.latestVerifiedAt, now)}. A past check does not verify the copy today.`
      : validTime(backup.latestAt) ? 'Listed on this computer; not verified by this status check.' : '';
  const budget = recording ?? {};
  const adaptiveMeasured = budget.adaptiveMeasurementHours > 0 && finite(budget.adaptiveProjectedAnnualBytes);
  const totalMeasured = finite(budget.totalDatabaseMeasurementHours) && budget.totalDatabaseMeasurementHours > 0
    && finite(budget.totalDatabaseProjectedAnnualBytes);
  return {
    known: health?.version === 2,
    outdated: !validTime(current.checkedAt) || now - current.checkedAt > healthFreshnessMs,
    // The server dates the check; the browser renders it with a separate clock.
    // Tolerate skew within the freshness window without changing source times.
    clockMismatch: validTime(current.checkedAt) && current.checkedAt - now > healthFreshnessMs,
    settled: ['ok', 'read-only'].includes(recorder.state) && hasSpace && disk.state === 'ok',
    recordingScope: current.scope === 'snapshot' ? 'Recorded snapshot' : current.scope === 'history' ? 'History viewer' : 'Recording',
    scope: current.scope === 'snapshot' ? 'Recorded snapshot · disk space belongs to this computer'
      : current.scope === 'history' ? 'History viewer · disk space belongs to this computer' : 'This computer',
    checked: validTime(current.checkedAt) ? `Checked ${recordingEvidenceTime(current.checkedAt, now)}` : 'Health has not been checked yet.',
    attention: Array.isArray(current.attention) ? current.attention.filter(item => ['warning', 'critical'].includes(item?.severity))
      .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical')) : [],
    disk: { label: diskLabels[disk.state] ?? diskLabels.unknown, tone: tone(disk.state), fraction: diskFraction,
      free: hasSpace ? storageBytes(disk.freeBytes) : 'Unknown',
      total: hasSpace ? storageBytes(disk.totalBytes) : 'Unknown',
      capacity: hasSpace ? `${decimal(diskFraction * 100)}% free of ${storageBytes(disk.totalBytes)}` : 'Capacity is not available',
      detail: disk.detail || 'Free space on the filesystem that holds this computer’s database.' },
    recording: { label: recordingLabels[recorder.state] ?? recordingLabels.unknown, tone: tone(recorder.state),
      detail: recorder.detail || 'Waiting for recording health information.',
      evidence: validTime(recorder.lastSourceCheckAt) ? `Last source check · ${recordingEvidenceTime(recorder.lastSourceCheckAt, now)}` : 'Last source check is not known.' },
    backup: { label: backupLabels[backup.state] ?? backupLabels.unknown, tone: tone(backup.state),
      detail: backup.detail || 'Only copies known to this computer can be listed here.', evidence: backupEvidence,
      verification: backupVerification,
      activity: backup.state === 'running' && validTime(backup.startedAt) ? `Started ${recordingEvidenceTime(backup.startedAt, now)}`
        : ['failed', 'interrupted'].includes(backup.state) && validTime(backup.lastFailureAt) ? `Last failure ${recordingEvidenceTime(backup.lastFailureAt, now)}` : '' },
    growth: {
      database: storageBytes(budget.measuredDatabaseBytes),
      adaptiveStored: finite(budget.adaptiveEstimatedBytes) && validTime(budget.adaptiveAccountingStartedAt) ? storageBytes(budget.adaptiveEstimatedBytes) : 'Not measured yet',
      adaptiveSince: validTime(budget.adaptiveAccountingStartedAt) ? `Estimated adaptive payload recorded since ${dates.format(new Date(budget.adaptiveAccountingStartedAt))}` : 'Adaptive size accounting starts with new recordings',
      adaptive: adaptiveMeasured ? `${storageBytes(budget.adaptiveProjectedAnnualBytes)}/year` : 'Collecting evidence',
      target: finite(budget.annualBudgetBytes) ? `${storageBytes(budget.annualBudgetBytes)}/year` : 'Not available',
      total: totalMeasured ? `${storageBytes(budget.totalDatabaseProjectedAnnualBytes)}/year` : 'Collecting evidence',
      adaptiveWindow: adaptiveMeasured ? `Estimated from ${decimal(budget.adaptiveMeasurementHours)} h of adaptive additions` : 'Waiting for measured adaptive additions',
      totalWindow: totalMeasured ? `${budget.totalDatabaseMeasurementHours < 168 ? 'Still settling' : '7-day smoothing'} · ${decimal(budget.totalDatabaseMeasurementHours)} h of SQLite allocation measurements` : 'Waiting for measured database growth',
    },
  };
}

export function createRecordingHealth({ document, request, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  const $ = id => document.getElementById(id);
  let health, recording, inventory, inventoryPhase = 'idle', revision = 0, pending = false, unavailable = false;
  let introStarted = false, introVisible = false, introTimer;
  const issueNodes = new Map();
  const set = (id, value) => { const element = $(id); if (element && element.textContent !== String(value)) element.textContent = value; };
  const open = id => {
    const target = $(id);
    for (let fold = target; fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    target?.querySelector(':scope > summary')?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  };
  function bindLink(link) {
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); open(link.dataset.recordingOpen);
    });
  }
  for (const link of document.querySelectorAll('[data-recording-open]')) bindLink(link);
  function renderIssues(items) {
    const list = $('recording-status-issues');
    const ids = new Set(items.map(item => item.id));
    const retainFocus = (id, node) => {
      if (node.contains(document.activeElement)) {
        const target = issueTarget(id);
        $(target === 'recording-disk-card' ? 'recording-status-disk'
          : target === 'recording-backup-card' ? 'recording-status-details' : 'recording-status-recording').focus({ preventScroll: true });
      }
    };
    for (const [id, node] of issueNodes) if (!ids.has(id)) {
      retainFocus(id, node); node.remove(); issueNodes.delete(id);
    }
    items.forEach((item, index) => {
      let node = issueNodes.get(item.id);
      if (!node) {
        node = document.createElement('li'); node.className = 'recording-status-issue';
        const link = document.createElement('a');
        link.dataset.recordingOpen = issueTarget(item.id); link.href = `#${link.dataset.recordingOpen}`;
        link.append(document.createElement('strong'), document.createElement('span'));
        bindLink(link); node.append(link); issueNodes.set(item.id, node);
      }
      node.dataset.tone = item.severity;
      const [title, detail] = node.firstElementChild.children;
      // The recording state is already the summary heading. Keep its guidance
      // below without repeating the same fault a second time.
      const heading = item.id === 'recording' && item.detail ? '' : item.title;
      if (title.textContent !== heading) title.textContent = heading;
      const copy = item.detail ? `${heading ? ' · ' : ''}${item.detail}` : '';
      if (detail.textContent !== copy) detail.textContent = copy;
      if (list.children[index] !== node) {
        retainFocus(item.id, node); list.insertBefore(node, list.children[index] ?? null);
      }
    });
    list.hidden = items.length === 0;
  }
  function draw() {
    const view = recordingHealthView(health, recording, now());
    const strip = $('recording-status'), dated = view.known && (view.outdated || view.clockMismatch || unavailable);
    const needsAttention = view.attention.length > 0 || dated;
    strip.hidden = !view.known || !(introVisible || needsAttention || !view.settled || strip.contains(document.activeElement));
    strip.dataset.tone = view.attention.some(item => item.severity === 'critical') ? 'critical' : needsAttention ? 'warning' : 'neutral';
    set('recording-status-label', view.recordingScope);
    set('recording-status-state', `${dated ? 'Last known: ' : ''}${view.recording.label}`);
    $('recording-status-recording').dataset.tone = view.recording.tone;
    set('recording-status-free', `${dated ? 'Last known: ' : ''}${view.disk.fraction === null ? 'Space unknown' : `${view.disk.free} free`}`);
    set('recording-status-capacity', view.disk.fraction === null ? 'Open details to check storage' : `of ${view.disk.total}${view.disk.tone === 'neutral' ? '' : ` · ${view.disk.label}`}`);
    $('recording-status-disk').dataset.tone = view.disk.tone;
    renderIssues(view.attention);
    const freshness = unavailable ? `Refresh failed. ${view.checked} The last known status may be out of date.`
      : view.clockMismatch ? `The server and browser clocks differ. Check this device’s date and time and the server clock. ${view.checked}`
      : view.outdated ? `Status is out of date. ${view.checked}` : '';
    set('recording-status-freshness', freshness);
    $('recording-status-freshness').hidden = !dated;
    for (const id of ['recording-disk-meter', 'recording-status-meter']) {
      const meter = $(id); meter.hidden = view.disk.fraction === null;
      meter.setAttribute('aria-valuenow', String(Math.round((view.disk.fraction ?? 0) * 100)));
      meter.setAttribute('aria-valuetext', `${view.disk.free} free · ${view.disk.capacity}`);
      meter.style.setProperty('--free-space', `${(view.disk.fraction ?? 0) * 100}%`);
      meter.dataset.tone = view.disk.tone;
    }
    set('recording-health-scope', view.scope);
    set('recording-health-checked', unavailable ? health ? `Refresh failed. ${view.checked}. The last known health may be out of date.` : 'Health could not be loaded. Try refreshing again.' : view.clockMismatch ? freshness : view.checked);
    $('recording-health-checked').dataset.tone = unavailable || view.clockMismatch ? 'warning' : 'neutral';
    $('recording-health-refresh').disabled = pending;
    set('recording-health-refresh', pending ? 'Checking…' : 'Refresh health');
    set('recording-health-badge', view.attention.length ? 'Needs attention' : '');
    $('recording-health-badge').hidden = view.attention.length === 0;
    for (const section of ['disk', 'recording', 'backup']) {
      set(`recording-${section}-state`, view[section].label);
      $(`recording-${section}-card`).dataset.tone = view[section].tone;
      set(`recording-${section}-detail`, view[section].detail);
    }
    set('recording-disk-free', view.disk.free);
    set('recording-disk-capacity', view.disk.capacity);
    set('recording-recording-evidence', view.recording.evidence);
    set('recording-backup-evidence', view.backup.evidence);
    set('recording-backup-verification', view.backup.verification);
    set('recording-backup-activity', view.backup.activity);
    $('recording-backup-activity').hidden = !view.backup.activity;
    for (const [field, value] of Object.entries(view.growth)) set(`recording-growth-${field}`, value);
    const retained = finite(inventory?.database?.adaptiveEstimatedBytes);
    const checked = validTime(inventory?.generatedAt) ? `Retained adaptive payload estimate · checked ${recordingEvidenceTime(inventory.generatedAt, now())}` : '';
    set('recording-growth-retained', retained ? storageBytes(inventory.database.adaptiveEstimatedBytes)
      : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    set('recording-growth-inventoryAt', inventoryPhase === 'loading' ? `Measuring retained adaptive data… ${checked}`.trim()
      : inventoryPhase === 'failed' ? `Could not measure retained adaptive data. ${checked || 'Use Refresh inventory to retry.'}`
        : checked || 'Retained adaptive size has not been measured.');
    for (const [field, key] of [['file', 'fileBytes'], ['wal', 'walBytes'], ['files', 'totalFileBytes'], ['reusable', 'reusableBytes']]) {
      set(`recording-growth-${field}`, inventory ? storageBytes(inventory.database?.[key])
        : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    }
    for (const [field, key] of [['observationPages', 'observationBytes'], ['historyPages', 'historyBytes'],
      ['currentPages', 'currentBytes'], ['journalPages', 'journalBytes'], ['peerBacklogPages', 'peerBacklogBytes'], ['branchPages', 'branchBytes'],
      ['indexPages', 'indexBytes'], ['internalPages', 'internalBytes']]) {
      set(`recording-growth-${field}`, inventory ? storageBytes(inventory.database?.physical?.available ? inventory.database.physical[key] : null)
        : inventoryPhase === 'loading' ? 'Measuring…' : inventoryPhase === 'failed' ? 'Unavailable' : 'Not checked');
    }
    const journal = inventory?.database?.journalRetention;
    set('recording-growth-journalRetention', journal
      ? `Recent suffix: ${decimal(journal.commits)} transactions · ${storageBytes(journal.payloadBytes)} of change payload after transaction ${journal.baseSequence}. Retention targets ${decimal(journal.maxCommits)} transactions or ${storageBytes(journal.maxBytes)}; one complete transaction can exceed the byte target. Peer catch-up adds one entry per changed record and its original value, including deletions, until acknowledged. The suffix target does not cap this backlog or protected branches.`
      : 'Transaction retention has not been checked.');
    const inventoryTime = validTime(inventory?.generatedAt) ? `Inventory checked ${recordingEvidenceTime(inventory.generatedAt, now())}.` : 'Inventory has not been checked yet.';
    set('recording-growth-fileEvidence', `${inventoryPhase === 'failed' ? 'Refresh failed; previous sizes may be out of date. ' : ''}${inventoryTime}`);
    set('recording-growth-observations', Number.isSafeInteger(inventory?.database?.adaptiveObservationCount)
      && inventory.database.adaptiveObservationCount >= 0
      ? `${new Intl.NumberFormat('en-GB').format(inventory.database.adaptiveObservationCount)} retained observations.` : 'Retained observation count is unknown.');
    const notice = $('recording-overview-notice');
    notice.hidden = inventoryPhase === 'ready';
    notice.classList?.toggle('form-error', inventoryPhase === 'failed');
    set('recording-overview-notice', inventoryPhase === 'failed'
      ? `The inventory could not be refreshed.${inventory ? ' The last successful inventory is still shown.' : ''} Open Storage & growth and use Refresh inventory to retry.`
      : inventoryPhase === 'loading' ? 'Refreshing the recorded-data inventory…' : 'The recorded-data inventory has not been checked yet.');
  }
  function acceptHealth(result) {
    if (health?.scope !== result?.scope) { inventory = undefined; inventoryPhase = 'idle'; }
    health = result; unavailable = false;
    document.body.dataset.recordingHealth = health?.version === 2 ? 'true' : 'false';
    if (health?.version === 2 && !introStarted) {
      introStarted = introVisible = true;
      introTimer = setTimer(() => { introVisible = false; introTimer = undefined; draw(); }, 15_000);
      introTimer?.unref?.();
    }
  }
  async function refresh() {
    if (pending) return;
    const version = ++revision; pending = true; draw();
    try {
      const result = await request('/api/recording-health');
      if (version !== revision) return;
      if (result?.version !== 2) throw new Error('Recording health is unavailable.');
      acceptHealth(result);
    } catch {
      if (version !== revision) return;
      unavailable = true;
    } finally {
      if (version === revision) { pending = false; draw(); }
    }
  }
  $('recording-health-refresh').addEventListener('click', () => { void refresh(); });
  // Let keyboard users finish with the summary before it disappears. No polling
  // update or warning recovery should remove a focused navigation target.
  $('recording-status').addEventListener('focusout', () => { queueMicrotask(draw); });
  draw();
  return {
    refresh,
    inventory(overview) { inventory = overview; inventoryPhase = 'ready'; draw(); },
    inventoryStatus(state) { inventoryPhase = state; draw(); },
    update(status) {
      // Control responses contain the ordinary engine status but do not run the
      // separate health check. They cannot renew or erase its dated evidence,
      // dismiss a refresh failure, or supersede an in-flight health request.
      if (Object.hasOwn(status ?? {}, 'recordingHealth')) {
        ++revision; pending = false;
        if (status.recordingHealth?.version === 2) acceptHealth(status.recordingHealth);
        else unavailable = true;
      }
      if (Object.hasOwn(status ?? {}, 'recording')) recording = status.recording;
      draw();
    },
    clear() {
      ++revision; pending = false; unavailable = false; health = recording = inventory = undefined; inventoryPhase = 'idle';
      clearTimer(introTimer); introTimer = undefined; introStarted = introVisible = false;
      document.body.dataset.recordingHealth = 'false'; draw();
    },
  };
}
